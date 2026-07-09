import type { McpRpcClient } from "../../core/mcp/rpcClient";
import {
  uploadAttachments,
  type AttachmentUploadProgress,
  type UploadAttachmentsResult,
} from "../../core/upload/attachmentUpload";
import { renderSuccess } from "../../core/output/render";
import { CliCommandError } from "./errors";
import { ATTACHMENTS_UPLOAD_COMMAND_PATH } from "./bespokeCommands";

export interface AttachmentsUploadCommandOptions {
  argv: string[];
  client: McpRpcClient;
  json: boolean;
  io: {
    stdout: NodeJS.WriteStream;
    stderr: NodeJS.WriteStream;
  };
}

export function isAttachmentsUploadCommand(domain: string | undefined, action: string | undefined): boolean {
  return domain === ATTACHMENTS_UPLOAD_COMMAND_PATH[0] && action === ATTACHMENTS_UPLOAD_COMMAND_PATH[1];
}

export async function executeAttachmentsUploadCommand(options: AttachmentsUploadCommandOptions): Promise<number> {
  const parsed = parseAttachmentsUploadArgs(options.argv);
  const result = await uploadAttachments(options.client, {
    documentUuid: parsed.documentUuid,
    files: parsed.files.map((path) => ({
      path,
      filename: parsed.filename,
      contentType: parsed.contentType,
    })),
    maxBytes: parsed.maxBytes,
    ttlSeconds: parsed.ttlSeconds,
    onProgress: options.json ? undefined : (progress) => {
      renderProgress(progress, options.io.stderr);
    },
  });

  options.io.stdout.write(renderAttachmentUploadResult(result, options.json));
  return 0;
}

interface ParsedAttachmentsUploadArgs {
  documentUuid: string;
  files: string[];
  filename?: string;
  contentType?: string;
  maxBytes?: number;
  ttlSeconds?: number;
}

function parseAttachmentsUploadArgs(argv: string[]): ParsedAttachmentsUploadArgs {
  const files: string[] = [];
  let documentUuid: string | undefined;
  let filename: string | undefined;
  let contentType: string | undefined;
  let maxBytes: number | undefined;
  let ttlSeconds: number | undefined;
  let readFilesOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (readFilesOnly) {
      files.push(arg);
      continue;
    }
    if (arg === "--") {
      readFilesOnly = true;
      continue;
    }
    if (arg === "--document-uuid" || arg === "--documentUuid") {
      documentUuid = requireValue(arg, argv[++index]);
      continue;
    }
    if (arg === "--filename" || arg === "--name") {
      filename = requireValue(arg, argv[++index]);
      continue;
    }
    if (arg === "--content-type" || arg === "--contentType") {
      contentType = requireValue(arg, argv[++index]);
      continue;
    }
    if (arg === "--max-bytes" || arg === "--maxBytes") {
      maxBytes = parsePositiveInteger(arg, requireValue(arg, argv[++index]));
      continue;
    }
    if (arg === "--ttl-seconds" || arg === "--ttlSeconds") {
      ttlSeconds = parsePositiveInteger(arg, requireValue(arg, argv[++index]));
      continue;
    }
    if (arg.startsWith("--")) {
      throw new CliCommandError("UNKNOWN_FLAG", `Unknown flag ${arg} for attachments upload.`, { flag: arg });
    }
    files.push(arg);
  }

  if (!documentUuid) {
    throw new CliCommandError("MISSING_REQUIRED_FLAG", "Missing required argument \"documentUuid\" for attachments upload.", {
      flag: "--document-uuid",
    });
  }
  if (files.length === 0) {
    throw new CliCommandError("MISSING_FILE", "Expected at least one file to upload.");
  }
  if (filename && files.length !== 1) {
    throw new CliCommandError("INVALID_FLAG_VALUE", "--filename/--name can only be used with exactly one file.", {
      flag: "--filename",
      files: files.length,
    });
  }

  return {
    documentUuid,
    files,
    filename,
    contentType,
    maxBytes,
    ttlSeconds,
  };
}

function parsePositiveInteger(flag: string, value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new CliCommandError("INVALID_FLAG_VALUE", `${flag} must be a positive integer.`, { flag, value });
  }
  return Number.parseInt(value, 10);
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new CliCommandError("FLAG_REQUIRES_VALUE", `${flag} requires a value.`, { flag });
  }
  return value;
}

function renderProgress(progress: AttachmentUploadProgress, stderr: NodeJS.WriteStream): void {
  if (progress.stage === "token") {
    stderr.write(`Uploading ${progress.filename} (${progress.index + 1}/${progress.total})...\n`);
  }
}

function renderAttachmentUploadResult(result: UploadAttachmentsResult, json: boolean): string {
  if (json) {
    return renderSuccess(result, { json });
  }
  const lines = [
    `Uploaded ${result.count} attachment${result.count === 1 ? "" : "s"}.`,
    ...result.uploaded.map((file) => `- ${file.filename} (${file.sizeBytes} bytes)`),
  ];
  return renderSuccess(lines.join("\n"), { json: false });
}
