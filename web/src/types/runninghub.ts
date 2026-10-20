export type RunningHubMappingKind = "prompt" | "image" | "video" | "audio" | "value";

export type RunningHubMapping = {
    nodeId: string;
    fieldName: string;
    kind: RunningHubMappingKind;
    /** 1-based reference index for image/video/audio mappings. */
    index?: number;
    /** Fixed value for value mappings. */
    value?: string;
};

export type RunningHubWorkflow = {
    workflowId: string;
    mappings: RunningHubMapping[];
};

/** Workflow node read for the mapping editor; never persisted. */
export type RunningHubNode = {
    nodeId: string;
    classType: string;
    title: string;
    fields: Array<{ name: string; value: string | number | boolean; kind: RunningHubMappingKind }>;
};

export type RunningHubOutputFile = {
    fileUrl: string;
    fileType: string;
    nodeId?: string;
};
