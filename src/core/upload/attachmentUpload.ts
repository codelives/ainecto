import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { McpRpcClient } from "../mcp/rpcClient";

export interface AttachmentUploadFileInput {
  path: string;
  filename?: string;
  contentType?: string;
}

export interface UploadAttachmentsInput {
  documentUuid: string;
  files: AttachmentUploadFileInput[];
  maxBytes?: number;
  ttlSeconds?: number;
  requestToolName?: string;
  commitToolName?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: AttachmentUploadProgress) => void;
}

export type AttachmentUploadStage = "token" | "put" | "register" | "done";

export interface AttachmentUploadProgress {
  stage: AttachmentUploadStage;
  path: string;
  filename: string;
  index: number;
  total: number;
}

export interface RegisteredAttachmentFile {
  path: string;
  documentUuid: string;
  filename: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  registerResult: unknown;
}

export interface UploadAttachmentsResult {
  count: number;
  uploaded: RegisteredAttachmentFile[];
}

export class AttachmentUploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function uploadAttachments(
  client: McpRpcClient,
  input: UploadAttachmentsInput,
): Promise<UploadAttachmentsResult> {
  if (!input.documentUuid.trim()) {
    throw new AttachmentUploadError("MISSING_REQUIRED_FLAG", "Missing required argument \"documentUuid\".", {
      flag: "--document-uuid",
    });
  }
  if (input.files.length === 0) {
    throw new AttachmentUploadError("MISSING_FILE", "Expected at least one file to upload.");
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const uploaded: RegisteredAttachmentFile[] = [];

  for (let index = 0; index < input.files.length; index += 1) {
    const file = input.files[index];
    if (!file) {
      continue;
    }
    uploaded.push(await uploadSingleAttachment(client, file, {
      documentUuid: input.documentUuid,
      maxBytes: input.maxBytes,
      ttlSeconds: input.ttlSeconds,
      requestToolName: input.requestToolName ?? "mcp__ainecto__request_upload_token",
      commitToolName: input.commitToolName ?? "mcp__ainecto__upload_attachments",
      fetchImpl,
      onProgress: input.onProgress,
      index,
      total: input.files.length,
    }));
  }

  return { count: uploaded.length, uploaded };
}

interface SingleUploadContext {
  documentUuid: string;
  maxBytes?: number;
  ttlSeconds?: number;
  requestToolName: string;
  commitToolName: string;
  fetchImpl: typeof fetch;
  onProgress?: (progress: AttachmentUploadProgress) => void;
  index: number;
  total: number;
}

interface UploadTokenResponse {
  token: string;
  uploadUrl: string;
  storageKey: string;
}

interface UploadPutResponse {
  storageKey: string;
  sizeBytes: number;
  contentType: string;
}

async function uploadSingleAttachment(
  client: McpRpcClient,
  file: AttachmentUploadFileInput,
  context: SingleUploadContext,
): Promise<RegisteredAttachmentFile> {
  const metadata = await readFileMetadata(file);
  emitProgress(context, "token", file.path, metadata.filename);
  const uploadToken = await requestUploadToken(client, metadata, context);

  emitProgress(context, "put", file.path, metadata.filename);
  const putResult = await putAttachmentBytes(uploadToken, metadata, context.fetchImpl);
  validatePutResult(uploadToken, metadata, putResult);

  const item = {
    documentUuid: context.documentUuid,
    filename: metadata.filename,
    storageKey: uploadToken.storageKey,
    contentType: putResult.contentType,
    sizeBytes: putResult.sizeBytes,
  };

  emitProgress(context, "register", file.path, metadata.filename);
  const registerResult = await client.toolsCall(context.commitToolName, { items: [item] });

  emitProgress(context, "done", file.path, metadata.filename);
  return {
    path: file.path,
    documentUuid: context.documentUuid,
    filename: metadata.filename,
    storageKey: uploadToken.storageKey,
    contentType: putResult.contentType,
    sizeBytes: putResult.sizeBytes,
    registerResult,
  };
}

async function readFileMetadata(file: AttachmentUploadFileInput): Promise<{
  bytes: Buffer;
  filename: string;
  contentType: string;
  sizeBytes: number;
}> {
  const stats = await stat(file.path);
  if (!stats.isFile()) {
    throw new AttachmentUploadError("INVALID_FILE", `Attachment path is not a file: ${file.path}`, { path: file.path });
  }
  const bytes = await readFile(file.path);
  return {
    bytes,
    filename: file.filename ?? basename(file.path),
    contentType: file.contentType ?? detectContentType(file.path),
    sizeBytes: bytes.byteLength,
  };
}

async function requestUploadToken(
  client: McpRpcClient,
  metadata: { filename: string; contentType: string; sizeBytes: number },
  context: SingleUploadContext,
): Promise<UploadTokenResponse> {
  const scopeJson = JSON.stringify({
    documentUuid: context.documentUuid,
    filename: metadata.filename,
    contentType: metadata.contentType,
    sizeBytes: metadata.sizeBytes,
  });
  const requestArgs: Record<string, unknown> = {
    purpose: "attachment.upload",
    scopeJson,
  };
  if (context.maxBytes !== undefined) {
    requestArgs.maxBytes = context.maxBytes;
  }
  if (context.ttlSeconds !== undefined) {
    requestArgs.ttlSeconds = context.ttlSeconds;
  }

  const response = await client.toolsCall(context.requestToolName, requestArgs);
  if (!isRecord(response)) {
    throw new AttachmentUploadError("UPLOAD_TOKEN_PROTOCOL_ERROR", "request_upload_token response was not an object.");
  }
  const token = response.token;
  const uploadUrl = response.uploadUrl;
  const storageKey = response.storageKey;
  if (typeof token !== "string" || token.length === 0) {
    throw new AttachmentUploadError("UPLOAD_TOKEN_PROTOCOL_ERROR", "request_upload_token response did not include token.");
  }
  if (typeof uploadUrl !== "string" || uploadUrl.length === 0) {
    throw new AttachmentUploadError("UPLOAD_TOKEN_PROTOCOL_ERROR", "request_upload_token response did not include uploadUrl.");
  }
  if (typeof storageKey !== "string" || storageKey.length === 0) {
    throw new AttachmentUploadError("UPLOAD_TOKEN_PROTOCOL_ERROR", "request_upload_token response did not include storageKey.");
  }
  return { token, uploadUrl, storageKey };
}

async function putAttachmentBytes(
  token: UploadTokenResponse,
  metadata: { bytes: Buffer; contentType: string },
  fetchImpl: typeof fetch,
): Promise<UploadPutResponse> {
  const maxAttempts = 3;
  let lastRetryableError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(token.uploadUrl, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token.token}`,
          "content-type": metadata.contentType,
        },
        body: new Uint8Array(metadata.bytes),
      });
      if (shouldRetryResponse(response.status) && attempt < maxAttempts) {
        continue;
      }
      if (!response.ok) {
        throw uploadHttpError(response.status);
      }
      return parsePutResponse(await response.text());
    } catch (error) {
      if (error instanceof AttachmentUploadError || attempt === maxAttempts) {
        throw error;
      }
      lastRetryableError = error;
    }
  }
  throw new AttachmentUploadError("ATTACHMENT_UPLOAD_FAILED", "Attachment upload failed.", {
    cause: lastRetryableError instanceof Error ? lastRetryableError.message : String(lastRetryableError),
  });
}

function uploadHttpError(status: number): AttachmentUploadError {
  if (status === 409) {
    return new AttachmentUploadError("ATTACHMENT_UPLOAD_CONFLICT", "Attachment upload failed with HTTP 409 Conflict.", { status });
  }
  if (status === 401 || status === 403) {
    return new AttachmentUploadError("ATTACHMENT_UPLOAD_TOKEN_EXPIRED", `Attachment upload token was rejected with HTTP ${status}.`, { status });
  }
  return new AttachmentUploadError("ATTACHMENT_UPLOAD_HTTP_ERROR", `Attachment upload failed with HTTP ${status}.`, { status });
}

function shouldRetryResponse(status: number): boolean {
  return status === 429 || status >= 500;
}

function parsePutResponse(text: string): UploadPutResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AttachmentUploadError("ATTACHMENT_UPLOAD_PROTOCOL_ERROR", "Attachment PUT response was not valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new AttachmentUploadError("ATTACHMENT_UPLOAD_PROTOCOL_ERROR", "Attachment PUT response was not an object.");
  }
  if (typeof parsed.storageKey !== "string") {
    throw new AttachmentUploadError("ATTACHMENT_UPLOAD_PROTOCOL_ERROR", "Attachment PUT response did not include storageKey.");
  }
  if (typeof parsed.sizeBytes !== "number" || !Number.isFinite(parsed.sizeBytes)) {
    throw new AttachmentUploadError("ATTACHMENT_UPLOAD_PROTOCOL_ERROR", "Attachment PUT response did not include numeric sizeBytes.");
  }
  if (typeof parsed.contentType !== "string") {
    throw new AttachmentUploadError("ATTACHMENT_UPLOAD_PROTOCOL_ERROR", "Attachment PUT response did not include contentType.");
  }
  return {
    storageKey: parsed.storageKey,
    sizeBytes: parsed.sizeBytes,
    contentType: parsed.contentType,
  };
}

function validatePutResult(
  token: UploadTokenResponse,
  metadata: { sizeBytes: number },
  putResult: UploadPutResponse,
): void {
  if (putResult.storageKey !== token.storageKey) {
    throw new AttachmentUploadError("ATTACHMENT_UPLOAD_STORAGE_KEY_MISMATCH", "Attachment PUT response storageKey did not match the upload token.", {
      expected: token.storageKey,
      actual: putResult.storageKey,
    });
  }
  if (putResult.sizeBytes !== metadata.sizeBytes) {
    throw new AttachmentUploadError("ATTACHMENT_UPLOAD_SIZE_MISMATCH", "Attachment PUT response sizeBytes did not match the local file size.", {
      expected: metadata.sizeBytes,
      actual: putResult.sizeBytes,
    });
  }
}

function emitProgress(
  context: SingleUploadContext,
  stage: AttachmentUploadStage,
  path: string,
  filename: string,
): void {
  context.onProgress?.({
    stage,
    path,
    filename,
    index: context.index,
    total: context.total,
  });
}

function detectContentType(path: string): string {
  const extension = extname(path).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
