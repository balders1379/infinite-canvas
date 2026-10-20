import { Button, Input, InputNumber, Modal, Select, Space } from "antd";
import { RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { readRunningHubWorkflow } from "@/services/api/runninghub";
import type { ChannelModel, ModelChannel } from "@/stores/use-config-store";
import type { RunningHubMapping, RunningHubMappingKind, RunningHubNode } from "@/types/runninghub";

const MAPPING_KINDS: RunningHubMappingKind[] = ["prompt", "image", "video", "audio", "value"];

export function RunningHubWorkflowEditor({ open, channel, model, onSave, onClose }: { open: boolean; channel: ModelChannel; model: ChannelModel | null; onSave: (model: ChannelModel) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const [name, setName] = useState("");
    const [workflowId, setWorkflowId] = useState("");
    const [mappings, setMappings] = useState<RunningHubMapping[]>([]);
    const [nodes, setNodes] = useState<RunningHubNode[]>([]);
    const [reading, setReading] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!open || !model) return;
        setName(model.name);
        setWorkflowId(model.runningHub?.workflowId || "");
        setMappings(model.runningHub?.mappings || []);
        setNodes([]);
        setError("");
        // Re-read an existing workflow so the mapping selects have their node options.
        const id = model.runningHub?.workflowId?.trim();
        if (!id || !channel.baseUrl.trim() || !channel.apiKey.trim()) return;
        let canceled = false;
        setReading(true);
        readRunningHubWorkflow(channel, id)
            .then((result) => !canceled && applyNodes(result))
            .catch((readError) => !canceled && setError(readError instanceof Error ? readError.message : t("config.channelEditor.workflowReadFailed")))
            .finally(() => !canceled && setReading(false));
        return () => {
            canceled = true;
            setReading(false);
        };
    }, [open, model]);

    if (!model) return null;

    function applyNodes(result: RunningHubNode[]) {
        setNodes(result);
        const valid = new Set(result.flatMap((node) => node.fields.map((field) => `${node.nodeId}::${field.name}`)));
        setMappings((current) => current.filter((mapping) => valid.has(`${mapping.nodeId}::${mapping.fieldName}`)));
    }

    const readNodes = async (id = workflowId) => {
        if (!id.trim()) {
            setError(t("config.channelEditor.workflowRequired"));
            return;
        }
        setReading(true);
        setError("");
        try {
            applyNodes(await readRunningHubWorkflow(channel, id));
        } catch (readError) {
            setNodes([]);
            setError(readError instanceof Error ? readError.message : t("config.channelEditor.workflowReadFailed"));
        } finally {
            setReading(false);
        }
    };

    const patchMapping = (index: number, value: Partial<RunningHubMapping>) => setMappings((current) => current.map((mapping, itemIndex) => (itemIndex === index ? { ...mapping, ...value } : mapping)));
    const addMapping = () => {
        const node = nodes[0];
        if (!node) {
            setError(t("config.channelEditor.readWorkflowFirst"));
            return;
        }
        const field = node.fields[0];
        setMappings((current) => [...current, { nodeId: node.nodeId, fieldName: field.name, kind: field.kind, index: 1, value: "" }]);
    };
    const save = () => {
        if (!workflowId.trim()) {
            setError(t("config.channelEditor.workflowRequired"));
            return;
        }
        if (!mappings.length) {
            setError(t("config.channelEditor.mappingRequired"));
            return;
        }
        onSave({ ...model, name: name.trim() || workflowId.trim(), runningHub: { workflowId: workflowId.trim(), mappings } });
        onClose();
    };

    return (
        <Modal open={open} title={t("config.channelEditor.workflowTitle")} width={720} onCancel={onClose} footer={null} destroyOnHidden>
            <div className="space-y-4 pt-2">
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.workflowName")}</span>
                    <Input value={name} onChange={(event) => setName(event.target.value)} />
                </label>
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.workflowId")}</span>
                    <Space.Compact className="w-full">
                        <Input value={workflowId} onChange={(event) => setWorkflowId(event.target.value)} onBlur={() => workflowId.trim() && void readNodes()} placeholder={t("config.channelEditor.workflowIdPlaceholder")} />
                        <Button icon={<RefreshCw className="size-3.5" />} loading={reading} onClick={() => void readNodes()}>
                            {t("config.channelEditor.readWorkflow")}
                        </Button>
                    </Space.Compact>
                </label>
                {error ? <div className="text-sm text-red-500">{error}</div> : null}
                {nodes.length ? <div className="text-xs text-stone-500">{t("config.channelEditor.workflowNodes", { count: nodes.length })}</div> : null}

                <div className="space-y-2 rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                    {mappings.map((mapping, index) => {
                        const node = nodes.find((item) => item.nodeId === mapping.nodeId);
                        return (
                            <div key={`${index}-${mapping.nodeId}`} className="flex flex-wrap items-center gap-2 rounded-md px-1 py-1">
                                <Select
                                    className="w-40"
                                    size="small"
                                    value={mapping.nodeId}
                                    placeholder={t("config.channelEditor.mappingNode")}
                                    options={nodes.map((item) => ({ value: item.nodeId, label: `#${item.nodeId} · ${item.title}` }))}
                                    onChange={(nodeId) => {
                                        const nextNode = nodes.find((item) => item.nodeId === nodeId);
                                        const field = nextNode?.fields[0];
                                        patchMapping(index, { nodeId, fieldName: field?.name || "", kind: field?.kind || "value" });
                                    }}
                                />
                                <Select
                                    className="w-40"
                                    size="small"
                                    value={mapping.fieldName}
                                    placeholder={t("config.channelEditor.mappingField")}
                                    options={(node?.fields || []).map((field) => ({ value: field.name, label: `${field.name}（${String(field.value).slice(0, 24)}）` }))}
                                    onChange={(fieldName) => {
                                        const field = node?.fields.find((item) => item.name === fieldName);
                                        patchMapping(index, { fieldName, kind: field?.kind || mapping.kind });
                                    }}
                                />
                                <Select
                                    className="w-28"
                                    size="small"
                                    value={mapping.kind}
                                    options={MAPPING_KINDS.map((kind) => ({ value: kind, label: t(`config.channelEditor.mappingKinds.${kind}`) }))}
                                    onChange={(kind) => patchMapping(index, { kind })}
                                />
                                {mapping.kind === "value" ? (
                                    <Input className="w-40" size="small" value={mapping.value || ""} placeholder={t("config.channelEditor.mappingValue")} onChange={(event) => patchMapping(index, { value: event.target.value })} />
                                ) : mapping.kind === "prompt" ? null : (
                                    <InputNumber className="w-24" size="small" min={1} value={mapping.index || 1} onChange={(value) => patchMapping(index, { index: Number(value) || 1 })} aria-label={t("config.channelEditor.mappingIndex")} />
                                )}
                                <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} onClick={() => setMappings((current) => current.filter((_, itemIndex) => itemIndex !== index))} />
                            </div>
                        );
                    })}
                    {mappings.length ? null : <div className="px-2 py-6 text-center text-sm text-stone-500">{t("config.channelEditor.mappingEmpty")}</div>}
                </div>

                <div className="flex items-center justify-between">
                    <Button type="dashed" disabled={!nodes.length} onClick={addMapping}>
                        {t("config.channelEditor.addMapping")}
                    </Button>
                    <Space>
                        <Button onClick={onClose}>{t("common.cancel")}</Button>
                        <Button type="primary" onClick={save}>
                            {t("common.save")}
                        </Button>
                    </Space>
                </div>
            </div>
        </Modal>
    );
}
