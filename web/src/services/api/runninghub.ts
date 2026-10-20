import axios from "axios";

import i18n from "@/i18n";
import { dataUrlToFile } from "@/lib/image-utils";
import { getMediaBlob, resolveMediaUrl } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { withLocalProxy, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import type { RunningHubMappingKind, RunningHubNode, RunningHubOutputFile, RunningHubWorkflow } from "@/types/runninghub";

type RequestOptions = { signal?: AbortSignal };
type RunningHubConfig = Pick<AiConfig, "baseUrl" | "apiKey">;
type RunningHubEnvelope<T> = { code?: number; msg?: string; message?: string; data?: T | null };
type RunningHubNodeInfo = { nodeId: string; fieldName: string; fieldValue: string | number | boolean };
type RunningHubInput = { prompt: string; images?: ReferenceImage[]; videos?: ReferenceVideo[]; audios?: ReferenceAudio[] };

export type RunningHubPhase = "queued" | "running";
export type RunningHubVideoState = { status: "pending"; phase: RunningHubPhase } | { status: "completed"; url: string } | { status: "failed"; error: string };

const POLL_INTERVAL_MS = 2500;
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

function runningHubBaseUrl(config: RunningHubConfig) {
    return config.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function runningHubUrl(config: RunningHubConfig, path: string) {
    return withLocalProxy(`${runningHubBaseUrl(config)}${path}`);
}

function runningHubHeaders(config: RunningHubConfig, contentType?: string) {
    return { Authorization: `Bearer ${config.apiKey}`, ...(contentType ? { "Content-Type": contentType } : {}) };
}

type RunningHubFailedReason = {
    node_name?: string;
    node_id?: string;
    exception_type?: string;
    exception_message?: string;
    traceback?: string;
};

// V2 run/query responses are flat: no code/data envelope.
type RunningHubV2Result = { url?: string; nodeId?: string; outputType?: string; text?: string | null };
type RunningHubV2Response = {
    taskId?: string;
    status?: string;
    errorCode?: string;
    errorMessage?: string;
    failedReason?: RunningHubFailedReason | string | null;
    results?: RunningHubV2Result[] | null;
    promptTips?: string;
};

/** Failed tasks return a structured reason; other calls only carry msg/message. */
function readRunningHubFailedReason(payload: RunningHubEnvelope<unknown>) {
    const data = payload.data as { failedReason?: RunningHubFailedReason | string } | null | undefined;
    return readRunningHubReason(data?.failedReason);
}

function readRunningHubReason(reason: RunningHubFailedReason | string | null | undefined) {
    if (!reason) return "";
    if (typeof reason === "string") return reason;
    // The UI shows one readable line; keep the full details in the console for debugging.
    if (reason.traceback) console.warn("[RunningHub] task failed", reason);
    const { node_name: nodeName = "", node_id: nodeId = "", exception_type: exceptionType = "", exception_message: exceptionMessage = "" } = reason;
    if (exceptionMessage) {
        const params = { node: nodeName || "-", nodeId: nodeId || "-", message: exceptionMessage };
        return exceptionType ? apiText("runningHubFailure", { ...params, type: exceptionType }) : apiText("runningHubNodeMessage", params);
    }
    if (nodeName || nodeId) return apiText("runningHubNodeFailed", { node: nodeName || "-", nodeId: nodeId || "-" });
    return exceptionType;
}

function runningHubErrorMessage(payload: RunningHubEnvelope<unknown>) {
    const prompts = readRunningHubPromptTips((payload.data as { promptTips?: unknown } | null | undefined)?.promptTips);
    return readRunningHubFailedReason(payload) || prompts || payload.msg || payload.message || apiText("runningHubRequestFailed");
}

function readRunningHubV2Error(payload: Partial<RunningHubV2Response> & RunningHubEnvelope<unknown>) {
    return readRunningHubReason(payload.failedReason) || readRunningHubPromptTips(payload.promptTips) || payload.errorMessage || payload.errorCode || runningHubErrorMessage(payload);
}

async function runningHubV2Post<T extends RunningHubV2Response>(config: RunningHubConfig, path: string, body: Record<string, unknown>, options?: RequestOptions): Promise<T> {
    if (!runningHubBaseUrl(config)) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    try {
        const response = await axios.post<T>(runningHubUrl(config, path), body, { headers: runningHubHeaders(config, "application/json"), signal: options?.signal });
        return response.data;
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        if (!axios.isAxiosError(error)) throw error;
        if (error.response) throw new Error(readRunningHubV2Error(error.response.data as Partial<RunningHubV2Response> & RunningHubEnvelope<unknown>));
        throw new Error(apiText("runningHubNetworkFailed"));
    }
}

async function runningHubPost<T>(config: RunningHubConfig, path: string, body: Record<string, unknown>, options?: RequestOptions): Promise<T> {
    if (!runningHubBaseUrl(config)) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    try {
        const response = await axios.post<RunningHubEnvelope<T>>(runningHubUrl(config, path), { apiKey: config.apiKey, ...body }, { headers: runningHubHeaders(config, "application/json"), signal: options?.signal });
        if (response.data?.code !== 0) throw new Error(runningHubErrorMessage(response.data));
        return response.data.data as T;
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        if (!axios.isAxiosError(error)) throw error;
        if (error.response) throw new Error(runningHubErrorMessage(error.response.data as RunningHubEnvelope<unknown>));
        throw new Error(apiText("runningHubNetworkFailed"));
    }
}

function inferFieldKind(classType: string, fieldName: string): RunningHubMappingKind {
    if (/LoadImage/i.test(classType)) return "image";
    if (/LoadVideo/i.test(classType)) return "video";
    if (/LoadAudio/i.test(classType)) return "audio";
    if (/CLIPTextEncode/i.test(classType) || /^(text|prompt|positive|negative)$/i.test(fieldName)) return "prompt";
    return "value";
}

/** Read the published workflow and expose its basic input fields for the mapping editor. */
export async function readRunningHubWorkflow(config: RunningHubConfig, workflowId: string, options?: RequestOptions): Promise<RunningHubNode[]> {
    const id = workflowId.trim();
    if (!id) throw new Error(apiText("runningHubWorkflowRequired"));
    const data = await runningHubPost<{ prompt?: string | Record<string, unknown> }>(config, "/api/openapi/getJsonApiFormat", { workflowId: id }, options);
    let prompt = data?.prompt;
    if (typeof prompt === "string") {
        try {
            prompt = JSON.parse(prompt) as Record<string, unknown>;
        } catch {
            throw new Error(apiText("runningHubWorkflowInvalid"));
        }
    }
    const nodes: RunningHubNode[] = [];
    for (const [nodeId, raw] of Object.entries(prompt || {})) {
        if (!raw || typeof raw !== "object") continue;
        const node = raw as { class_type?: string; inputs?: Record<string, unknown>; _meta?: { title?: string } };
        const classType = node.class_type || "";
        const fields = Object.entries(node.inputs || {})
            .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
            .map(([name, value]) => ({ name, value: value as string | number | boolean, kind: inferFieldKind(classType, name) }));
        if (fields.length) nodes.push({ nodeId, classType, title: node._meta?.title || classType || nodeId, fields });
    }
    if (!nodes.length) throw new Error(apiText("runningHubWorkflowEmpty"));
    return nodes;
}

async function referenceFile(item: ReferenceImage | ReferenceVideo | ReferenceAudio, fallbackName: string, options?: RequestOptions) {
    if ("dataUrl" in item) {
        const dataUrl = await imageToDataUrl(item, options);
        return dataUrlToFile({ ...item, dataUrl });
    }
    let blob = item.storageKey ? await getMediaBlob(item.storageKey) : null;
    if (!blob) {
        const url = item.storageKey ? await resolveMediaUrl(item.storageKey, item.url || "") : item.url || "";
        if (!url) throw new Error(apiText("runningHubReferenceMissing"));
        try {
            blob = await (await fetch(url, { signal: options?.signal })).blob();
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") throw error;
            throw new Error(apiText("runningHubReferenceMissing"));
        }
    }
    if (!blob.size) throw new Error(apiText("runningHubReferenceMissing"));
    return new File([blob], item.name || fallbackName, { type: item.type || blob.type || "application/octet-stream" });
}

async function uploadRunningHubFile(config: RunningHubConfig, file: File, options?: RequestOptions) {
    const form = new FormData();
    form.append("file", file);
    try {
        const response = await axios.post<RunningHubEnvelope<{ fileName?: string }>>(runningHubUrl(config, "/openapi/v2/media/upload/binary"), form, { headers: runningHubHeaders(config), signal: options?.signal });
        if (response.data?.code !== 0 || !response.data.data?.fileName) throw new Error(runningHubErrorMessage(response.data));
        return response.data.data.fileName;
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        if (!axios.isAxiosError(error)) throw error;
        if (error.response) throw new Error(runningHubErrorMessage(error.response.data as RunningHubEnvelope<unknown>));
        throw new Error(apiText("runningHubNetworkFailed"));
    }
}

function sourceForKind(input: RunningHubInput, kind: RunningHubMappingKind) {
    if (kind === "image") return input.images || [];
    if (kind === "video") return input.videos || [];
    if (kind === "audio") return input.audios || [];
    return [];
}

function fixedValue(value: string) {
    if (value === "true") return true;
    if (value === "false") return false;
    const number = Number(value);
    return value.trim() !== "" && Number.isFinite(number) ? number : value;
}

async function buildNodeInfoList(config: RunningHubConfig, workflow: RunningHubWorkflow, input: RunningHubInput, options?: RequestOptions): Promise<RunningHubNodeInfo[]> {
    const mappings = workflow.mappings || [];
    if (!mappings.length) throw new Error(apiText("runningHubMappingEmpty"));
    const uploaded = new Map<string, string>();
    const list: RunningHubNodeInfo[] = [];
    for (const mapping of mappings) {
        if (mapping.kind === "prompt") {
            list.push({ nodeId: mapping.nodeId, fieldName: mapping.fieldName, fieldValue: input.prompt });
            continue;
        }
        if (mapping.kind === "value") {
            list.push({ nodeId: mapping.nodeId, fieldName: mapping.fieldName, fieldValue: fixedValue(mapping.value || "") });
            continue;
        }
        const items = sourceForKind(input, mapping.kind);
        // No reference media of this type: leave the workflow's own default in place.
        if (!items.length) continue;
        const index = Math.max(1, Math.floor(Number(mapping.index) || 1));
        const item = items[index - 1];
        if (!item) throw new Error(apiText("runningHubReferenceIndex", { index, count: items.length, kind: i18n.t(`config.channelEditor.mappingKinds.${mapping.kind}`) }));
        const key = `${mapping.kind}:${index}`;
        let fileName = uploaded.get(key);
        if (!fileName) {
            const file = await referenceFile(item, `reference-${index}`, options);
            fileName = await uploadRunningHubFile(config, file, options);
            uploaded.set(key, fileName);
        }
        list.push({ nodeId: mapping.nodeId, fieldName: mapping.fieldName, fieldValue: fileName });
    }
    return list;
}

export async function createRunningHubTask(config: RunningHubConfig, workflow: RunningHubWorkflow | undefined, input: RunningHubInput, options?: RequestOptions) {
    if (!workflow?.workflowId) throw new Error(apiText("runningHubWorkflowRequired"));
    const nodeInfoList = await buildNodeInfoList(config, workflow, input, options);
    const created = await runningHubV2Post<RunningHubV2Response>(config, `/openapi/v2/run/workflow/${encodeURIComponent(workflow.workflowId)}`, { addMetadata: false, nodeInfoList }, options);
    if (!created.taskId) throw new Error(readRunningHubPromptTips(created.promptTips) || created.errorMessage || apiText("runningHubTaskCreateFailed"));
    if (isFailedStatus((created.status || "").toUpperCase())) throw new Error(readRunningHubV2Error(created) || apiText("runningHubTaskFailed"));
    return created.taskId;
}

/** Workflow validation errors arrive as a serialized promptTips string. */
function readRunningHubPromptTips(raw: unknown) {
    if (typeof raw !== "string" || !raw.trim()) return "";
    try {
        const parsed = JSON.parse(raw) as { result?: boolean; node_errors?: Record<string, { errors?: Array<{ message?: string; details?: string }> }>; error?: { message?: string } | string | null; message?: string };
        const nodeErrors = Object.entries(parsed.node_errors || {}).flatMap(([nodeId, value]) => (value.errors || []).map((item) => `节点 ${nodeId}：${item.message || item.details || ""}`));
        if (nodeErrors.length) return nodeErrors.join("；");
        if (parsed.result !== false) return "";
        const error = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
        return error || parsed.message || raw;
    } catch {
        return raw;
    }
}

/** V2 query returns status, results, and the failure reason in one call. */
export async function queryRunningHubTask(config: RunningHubConfig, taskId: string, options?: RequestOptions) {
    const data = await runningHubV2Post<RunningHubV2Response>(config, "/openapi/v2/query", { taskId }, options);
    const status = (data.status || "").toUpperCase();
    assertKnownStatus(status);
    const outputs: RunningHubOutputFile[] = (data.results || [])
        .filter((item) => item?.url)
        .map((item) => ({ fileUrl: item.url as string, fileType: item.outputType || "", nodeId: item.nodeId }));
    return { status, outputs, error: readRunningHubV2Error(data) || apiText("runningHubTaskFailed") };
}

export async function cancelRunningHubTask(config: RunningHubConfig, taskId: string) {
    try {
        await runningHubPost(config, "/task/openapi/cancel", { taskId });
    } catch {
        // Best effort: local cancellation must not depend on the remote cancel call.
    }
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function isAbortError(error: unknown) {
    return (error instanceof DOMException && error.name === "AbortError") || axios.isCancel(error);
}

/** Poll a RunningHub task until it finishes. No overall timeout: stop via signal, which also cancels the remote task. */
export async function waitForRunningHubTask(config: RunningHubConfig, taskId: string, options?: RequestOptions & { onPhase?: (phase: RunningHubPhase) => void }): Promise<RunningHubOutputFile[]> {
    try {
        for (;;) {
            const { status, outputs, error } = await queryRunningHubTask(config, taskId, options);
            if (status === "SUCCESS") {
                // A successful task with no outputs means the workflow has no output node.
                if (!outputs.length) throw new Error(apiText("runningHubNoOutput"));
                return outputs;
            }
            if (isFailedStatus(status)) throw new Error(error);
            options?.onPhase?.(isQueuedStatus(status) ? "queued" : "running");
            await delay(POLL_INTERVAL_MS, options?.signal);
        }
    } catch (error) {
        if (isAbortError(error)) await cancelRunningHubTask(config, taskId);
        throw error;
    }
}

function isOutputType(item: RunningHubOutputFile, type: "image" | "video" | "audio") {
    const fileType = (item.fileType || "").toLowerCase();
    const url = (item.fileUrl || "").toLowerCase();
    if (type === "image") return /^(png|jpe?g|webp|gif|bmp)$/.test(fileType) || /\.(png|jpe?g|webp|gif|bmp)(\?|$)/.test(url);
    if (type === "video") return /^(mp4|webm|mov|mkv)$/.test(fileType) || /\.(mp4|webm|mov|mkv)(\?|$)/.test(url);
    return /^(mp3|wav|ogg|m4a|flac|aac)$/.test(fileType) || /\.(mp3|wav|ogg|m4a|flac|aac)(\?|$)/.test(url);
}

export async function generateRunningHubImages(config: RunningHubConfig, workflow: RunningHubWorkflow | undefined, prompt: string, images: ReferenceImage[], options?: RequestOptions & { onPhase?: (phase: RunningHubPhase) => void }) {
    const taskId = await createRunningHubTask(config, workflow, { prompt, images }, options);
    const outputs = await waitForRunningHubTask(config, taskId, options);
    const urls = outputs.filter((item) => isOutputType(item, "image")).map((item) => item.fileUrl);
    if (!urls.length) throw new Error(apiText("runningHubNoImage"));
    return urls;
}

export async function generateRunningHubAudio(config: RunningHubConfig, workflow: RunningHubWorkflow | undefined, input: RunningHubInput, options?: RequestOptions) {
    const taskId = await createRunningHubTask(config, workflow, input, options);
    const outputs = await waitForRunningHubTask(config, taskId, options);
    const item = outputs.find((output) => isOutputType(output, "audio"));
    if (!item) throw new Error(apiText("runningHubNoAudio"));
    try {
        const response = await fetch(withLocalProxy(item.fileUrl), { signal: options?.signal });
        if (!response.ok) throw new Error();
        return await response.blob();
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new Error(apiText("runningHubDownloadFailed"));
    }
}

export async function pollRunningHubVideoTask(config: RunningHubConfig, taskId: string, options?: RequestOptions): Promise<RunningHubVideoState> {
    try {
        const { status, outputs, error } = await queryRunningHubTask(config, taskId, options);
        if (status === "SUCCESS") {
            const output = outputs.find((item) => isOutputType(item, "video"));
            return output ? { status: "completed", url: output.fileUrl } : { status: "failed", error: apiText("runningHubNoVideo") };
        }
        if (isFailedStatus(status)) return { status: "failed", error };
        return { status: "pending", phase: isQueuedStatus(status) ? "queued" : "running" };
    } catch (error) {
        // The caller stopped the job: cancel it remotely so it does not keep consuming credits.
        if (options?.signal?.aborted) await cancelRunningHubTask(config, taskId);
        throw error;
    }
}

function isQueuedStatus(status: string) {
    return status === "QUEUED" || status === "CREATE";
}

function isFailedStatus(status: string) {
    return status === "FAILED" || status === "ERROR" || status === "CANCELLED";
}

/** Never wait forever on a status the API does not document. */
function assertKnownStatus(status: string) {
    if (isQueuedStatus(status) || status === "RUNNING" || status === "SUCCESS" || isFailedStatus(status)) return;
    throw new Error(apiText("runningHubUnknownStatus", { status: status || "-" }));
}
