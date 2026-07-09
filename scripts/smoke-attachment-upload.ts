import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runAinectoCli } from "../src/adapters/cli/ainectoCli";

interface Args {
  baseUrl: string;
  endpoint: string;
  apiRoot: string;
  keep: boolean;
}

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: unknown;
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  header(): string {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }

  store(setCookieHeaders: string | string[] | undefined): void {
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : setCookieHeaders ? [setCookieHeaders] : [];
    for (const header of headers) {
      const [first] = header.split(";");
      if (!first) {
        continue;
      }
      const eq = first.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (value) {
        this.cookies.set(name, value);
      } else {
        this.cookies.delete(name);
      }
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const marker = `attachment-smoke-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const password = `AttachmentSmoke!${randomBytes(8).toString("hex")}1`;
  const jar = new CookieJar();
  const tempDir = path.join(tmpdir(), `ainecto-cli-${marker}`);
  const localFile = path.join(tempDir, "live-attachment.txt");
  const fileBody = `ainecto-cli attachment live smoke\nmarker=${marker}\n`;
  let storedPath: string | undefined;

  try {
    await mkdir(tempDir, { recursive: true });
    await writeFile(localFile, fileBody);

    const user = await signupAndLogin(args.baseUrl, jar, marker, password);
    await setDevPlan(args.baseUrl, jar);
    const oauthClient = await registerClient(args.baseUrl, jar, marker);
    const mcpToken = await issueMcpToken(args.baseUrl, jar, oauthClient, marker, args.endpoint);
    const workspace = await createWorkspace(args.baseUrl, jar, marker);
    const project = await createProject(args.baseUrl, jar, workspace.uuid, marker);
    const document = await createDocument(args.baseUrl, jar, project.uuid, marker);

    const uploadCli = await runCli([
      "attachments",
      "upload",
      "--env",
      "dev",
      "--endpoint",
      args.endpoint,
      "--document-uuid",
      document.uuid,
      localFile,
      "--json",
    ], mcpToken);
    assert(uploadCli.exitCode === 0, "attachments upload CLI failed", uploadCli);
    const uploadOutput = parseCliJson(uploadCli.stdout);
    const uploadedFile = firstUploadFile(uploadOutput);
    const registerPayload = parseToolPayload(uploadedFile.registerResult);
    const registered = firstRegisteredAttachment(registerPayload);

    const listCli = await runCli([
      "attachments",
      "list",
      "--env",
      "dev",
      "--endpoint",
      args.endpoint,
      "--project-uuid",
      project.uuid,
      "--json",
    ], mcpToken);
    assert(listCli.exitCode === 0, "attachments list CLI failed", listCli);
    const listedPayload = parseToolPayload(parseCliJson(listCli.stdout).data);
    const listItems = extractAttachmentList(listedPayload);
    const listed = listItems.find((item) => item.uuid === registered.uuid || item.storageKey === uploadedFile.storageKey);
    assert(Boolean(listed), "uploaded attachment was not returned by list_attachments", { listedPayload, registered });

    storedPath = path.resolve(args.apiRoot, "uploads", uploadedFile.storageKey);
    const storedBytes = await readFile(storedPath);
    assert(storedBytes.toString("utf8") === fileBody, "stored file bytes did not match local upload", {
      storedPath,
      expectedBytes: Buffer.byteLength(fileBody),
      actualBytes: storedBytes.byteLength,
    });

    let cleanup = "skipped";
    if (!args.keep) {
      await cleanupRun(args.baseUrl, jar, tempDir, storedPath);
      cleanup = "removed-temp-user-and-upload-file";
    }

    console.log(JSON.stringify({
      ok: true,
      endpoint: args.endpoint,
      apiCommitTarget: "ef2f3a0",
      userId: user.id,
      workspaceUuid: workspace.uuid,
      projectUuid: project.uuid,
      documentUuid: document.uuid,
      attachmentUuid: registered.uuid,
      storageKey: uploadedFile.storageKey,
      contentType: uploadedFile.contentType,
      sizeBytes: uploadedFile.sizeBytes,
      checks: {
        requestUploadToken: true,
        rawPut: true,
        uploadAttachments: true,
        listAttachments: true,
        fsBytesMatch: true,
      },
      cleanup,
    }, null, 2));
  } catch (error) {
    await request(args.baseUrl, "DELETE", "/api/v1/auth/me", { jar }).catch(() => undefined);
    if (storedPath) {
      await rm(storedPath, { force: true }).catch(() => undefined);
      await rm(path.dirname(storedPath), { recursive: true, force: true }).catch(() => undefined);
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function signupAndLogin(baseUrl: string, jar: CookieJar, marker: string, password: string): Promise<{ id: string }> {
  const email = `${marker}@ainecto.test`;
  const signup = await jsonRequest(baseUrl, "POST", "/api/v1/auth/signup", {
    email,
    password,
    name: "Attachment Smoke",
  }, jar);
  assert(signup.status === 201, `signup HTTP ${signup.status}`, signup.text);
  const id = stringField(signup.json, "id");
  await jsonRequest(baseUrl, "POST", "/api/v1/auth/login", { email, password }, jar)
    .then((login) => assert(login.status === 200, `login HTTP ${login.status}`, login.text));
  return { id };
}

async function setDevPlan(baseUrl: string, jar: CookieJar): Promise<void> {
  const plan = await jsonRequest(baseUrl, "POST", "/api/v1/dev/plan", { planId: "pro" }, jar);
  assert(plan.status === 200, `dev plan HTTP ${plan.status}`, plan.text);
  assert(isRecord(plan.json) && plan.json.mcpEnabled === true, "dev plan did not enable MCP", plan.json);
}

async function registerClient(baseUrl: string, jar: CookieJar, marker: string): Promise<{ clientId: string; clientSecret: string }> {
  const response = await jsonRequest(baseUrl, "POST", "/oauth2/register", {
    client_name: `${marker} client`,
    redirect_uris: ["http://localhost/cb"],
    grant_types: ["authorization_code", "refresh_token"],
    scope: "openid profile mcp",
  }, jar);
  assert(response.status === 201, `oauth register HTTP ${response.status}`, response.text);
  return {
    clientId: stringField(response.json, "client_id"),
    clientSecret: stringField(response.json, "client_secret"),
  };
}

async function issueMcpToken(
  baseUrl: string,
  jar: CookieJar,
  client: { clientId: string; clientSecret: string },
  marker: string,
  resource: string,
): Promise<string> {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  const authUrl = new URL("/oauth2/authorize", baseUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client.clientId);
  authUrl.searchParams.set("redirect_uri", "http://localhost/cb");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("scope", "mcp");
  authUrl.searchParams.set("resource", resource);
  authUrl.searchParams.set("state", marker);

  const auth = await request(baseUrl, "GET", `${authUrl.pathname}${authUrl.search}`, { jar });
  let location = firstHeader(auth.headers.location);
  if (auth.status === 200) {
    const decision = await formRequest(baseUrl, "POST", "/oauth2/authorize/decision", {
      client_id: client.clientId,
      redirect_uri: "http://localhost/cb",
      scope: "mcp",
      resource,
      state: marker,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      decision: "allow",
    }, jar);
    assert(decision.status === 302 || decision.status === 303, `oauth decision HTTP ${decision.status}`, decision.text);
    location = firstHeader(decision.headers.location);
  } else {
    assert(auth.status === 302 || auth.status === 303, `oauth authorize HTTP ${auth.status}`, auth.text);
  }
  assert(Boolean(location), "oauth authorize missing Location header");
  const code = new URL(String(location)).searchParams.get("code");
  assert(Boolean(code), "oauth authorize redirect missing code");

  const token = await formRequest(baseUrl, "POST", "/oauth2/token", {
    grant_type: "authorization_code",
    code: String(code),
    code_verifier: codeVerifier,
    redirect_uri: "http://localhost/cb",
    client_id: client.clientId,
    client_secret: client.clientSecret,
    resource,
  });
  assert(token.status === 200, `oauth token HTTP ${token.status}`, token.text);
  return stringField(token.json, "access_token");
}

async function createWorkspace(baseUrl: string, jar: CookieJar, marker: string): Promise<{ uuid: string }> {
  const response = await jsonRequest(baseUrl, "POST", "/api/v1/workspaces", {
    name: `Attachment Smoke ${marker}`,
    description: "ainecto-cli attachment upload smoke",
  }, jar);
  assert(response.status === 200 || response.status === 201, `workspace HTTP ${response.status}`, response.text);
  return { uuid: stringField(response.json, "uuid") };
}

async function createProject(baseUrl: string, jar: CookieJar, workspaceUuid: string, marker: string): Promise<{ uuid: string }> {
  const response = await jsonRequest(baseUrl, "POST", `/api/v1/workspaces/${workspaceUuid}/projects`, {
    name: `Attachment Smoke Project ${marker}`,
    projectKey: marker.replace(/[^A-Za-z0-9]/g, "").slice(-10).toUpperCase(),
    description: "ainecto-cli attachment upload smoke",
  }, jar);
  assert(response.status === 200 || response.status === 201, `project HTTP ${response.status}`, response.text);
  return { uuid: stringField(response.json, "uuid") };
}

async function createDocument(baseUrl: string, jar: CookieJar, projectUuid: string, marker: string): Promise<{ uuid: string }> {
  const response = await jsonRequest(baseUrl, "POST", `/api/v1/projects/${projectUuid}/documents`, {
    type: "erd",
    title: `Attachment Smoke ${marker}`,
  }, jar);
  assert(response.status === 200 || response.status === 201, `document HTTP ${response.status}`, response.text);
  return { uuid: stringField(response.json, "uuid") };
}

async function cleanupRun(baseUrl: string, jar: CookieJar, tempDir: string, storedPath: string): Promise<void> {
  await rm(storedPath, { force: true });
  await rm(path.dirname(storedPath), { recursive: true, force: true });
  await rm(tempDir, { recursive: true, force: true });
  await request(baseUrl, "DELETE", "/api/v1/auth/me", { jar }).catch(() => undefined);
}

async function runCli(argv: string[], token: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const previousToken = process.env.AINECTO_TOKEN;
  process.env.AINECTO_TOKEN = token;
  try {
    const exitCode = await runAinectoCli(argv, {
      stdin: streamWith(""),
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
          return true;
        },
      } as NodeJS.WriteStream,
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
          return true;
        },
      } as NodeJS.WriteStream,
    });
    return { exitCode, stdout, stderr };
  } finally {
    if (previousToken === undefined) {
      delete process.env.AINECTO_TOKEN;
    } else {
      process.env.AINECTO_TOKEN = previousToken;
    }
  }
}

function streamWith(text: string): NodeJS.ReadStream {
  const stream = new PassThrough();
  stream.end(text);
  return stream as unknown as NodeJS.ReadStream;
}

function parseCliJson(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as unknown;
  assert(isRecord(parsed) && parsed.ok === true, "CLI JSON output was not ok", parsed);
  return parsed;
}

function firstUploadFile(output: Record<string, unknown>): {
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  registerResult: unknown;
} {
  const data = output.data;
  assert(isRecord(data), "upload output missing data", output);
  const uploaded = data.uploaded;
  assert(Array.isArray(uploaded) && uploaded.length === 1, "upload output expected one uploaded file", output);
  const item = uploaded[0];
  assert(isRecord(item), "upload output item was not an object", item);
  return {
    storageKey: stringField(item, "storageKey"),
    contentType: stringField(item, "contentType"),
    sizeBytes: numberField(item, "sizeBytes"),
    registerResult: item.registerResult,
  };
}

function parseToolPayload(result: unknown): unknown {
  if (isRecord(result) && Array.isArray(result.content)) {
    const text = result.content
      .map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "")
      .find((value) => value.trim().startsWith("{") || value.trim().startsWith("["));
    if (text) {
      return JSON.parse(text) as unknown;
    }
  }
  return result;
}

function firstRegisteredAttachment(value: unknown): { uuid: string; storageKey?: string } {
  assert(isRecord(value), "register payload was not an object", value);
  const uploaded = value.uploaded;
  assert(Array.isArray(uploaded) && uploaded.length === 1, "register payload expected one uploaded attachment", value);
  const item = uploaded[0];
  assert(isRecord(item), "registered attachment was not an object", item);
  return {
    uuid: stringField(item, "uuid"),
    storageKey: typeof item.storageKey === "string" ? item.storageKey : undefined,
  };
}

function extractAttachmentList(value: unknown): Array<{ uuid?: string; storageKey?: string }> {
  if (Array.isArray(value)) {
    return value.filter(isRecord).map((item) => ({
      uuid: typeof item.uuid === "string" ? item.uuid : undefined,
      storageKey: typeof item.storageKey === "string" ? item.storageKey : undefined,
    }));
  }
  if (isRecord(value)) {
    for (const key of ["attachments", "items", "data", "uploaded"]) {
      const child = value[key];
      if (Array.isArray(child)) {
        return extractAttachmentList(child);
      }
    }
  }
  return [];
}

async function jsonRequest(
  baseUrl: string,
  method: string,
  target: string,
  body: unknown,
  jar: CookieJar,
): Promise<HttpResponse> {
  return request(baseUrl, method, target, {
    jar,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function formRequest(
  baseUrl: string,
  method: string,
  target: string,
  form: Record<string, string>,
  jar?: CookieJar,
): Promise<HttpResponse> {
  return request(baseUrl, method, target, {
    jar,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

function request(
  baseUrl: string,
  method: string,
  target: string,
  options: { headers?: Record<string, string>; body?: string; jar?: CookieJar } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(target, baseUrl);
    const body = options.body === undefined ? undefined : Buffer.from(options.body);
    const headers: Record<string, string> = { ...options.headers };
    if (options.jar?.header()) {
      headers.Cookie = options.jar.header();
    }
    if (body && headers["Content-Length"] === undefined) {
      headers["Content-Length"] = String(body.byteLength);
    }
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        options.jar?.store(res.headers["set-cookie"]);
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text,
          json: parseJson(text),
        });
      });
    });
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function parseJson(text: string): unknown {
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parseArgs(argv: string[]): Args {
  const defaults = {
    baseUrl: "http://localhost:8080",
    endpoint: "http://localhost:8080/mcp",
    apiRoot: "/Users/ryan/project/workspace/codelive/ainecto-api",
  };
  const result: Args = { ...defaults, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") {
      result.baseUrl = requireValue(arg, argv[++index]).replace(/\/$/, "");
    } else if (arg === "--endpoint") {
      result.endpoint = requireValue(arg, argv[++index]);
    } else if (arg === "--api-root") {
      result.apiRoot = path.resolve(requireValue(arg, argv[++index]));
    } else if (arg === "--keep") {
      result.keep = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function assert(condition: unknown, message: string, details?: unknown): asserts condition {
  if (!condition) {
    const error = new Error(message);
    (error as Error & { details?: unknown }).details = redact(details);
    throw error;
  }
}

function stringField(value: unknown, field: string): string {
  assert(isRecord(value) && typeof value[field] === "string" && value[field].length > 0, `missing string field ${field}`, value);
  return value[field];
}

function numberField(value: unknown, field: string): number {
  assert(isRecord(value) && typeof value[field] === "number" && Number.isFinite(value[field]), `missing numeric field ${field}`, value);
  return value[field];
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (!isRecord(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const lower = key.toLowerCase();
    result[key] = lower.includes("token") || lower.includes("secret") || lower === "authorization"
      ? "[redacted]"
      : redact(child);
  }
  return result;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  const details = (error as Error & { details?: unknown }).details;
  if (details !== undefined) {
    console.error(JSON.stringify(details, null, 2));
  }
  process.exitCode = 1;
});
