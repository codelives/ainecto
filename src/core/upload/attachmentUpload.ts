import { readFile } from "node:fs/promises";
import { McpRpcClient } from "../mcp/rpcClient";

export interface UploadAttachmentInput {
  path: string;
  fileName?: string;
  contentType?: string;
  requestToolName?: string;
  commitToolName?: string;
  requestArgs?: Record<string, unknown>;
}

export async function uploadAttachment(client: McpRpcClient, input: UploadAttachmentInput): Promise<unknown> {
  const bytes = await readFile(input.path);
  const request = await client.toolsCall(input.requestToolName ?? "mcp__ainecto__request_upload_token", {
    ...input.requestArgs,
    fileName: input.fileName ?? input.path.split("/").pop(),
    contentType: input.contentType ?? "application/octet-stream",
    size: bytes.length,
  });

  if (!isRecord(request) || typeof request.uploadUrl !== "string") {
    throw new Error("request_upload_token result did not include uploadUrl.");
  }

  const response = await fetch(request.uploadUrl, {
    method: "PUT",
    headers: { "content-type": input.contentType ?? "application/octet-stream" },
    body: new Uint8Array(bytes),
  });
  if (!response.ok) {
    throw new Error(`Attachment upload failed with HTTP ${response.status}.`);
  }

  return client.toolsCall(input.commitToolName ?? "mcp__ainecto__upload_attachments", {
    uploadId: request.uploadId,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
