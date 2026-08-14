/*
 * AiNecto Agent — Chrome Native Messaging manifest registration (cross-OS).
 *
 * Writes a launcher + the native-messaging manifest so Chrome can find and run
 * `ainecto agent-host`. macOS/Linux write a manifest file into the Chrome
 * NativeMessagingHosts dir; Windows writes a manifest file + a registry key.
 *
 * Extension id source: AINECTO_EXTENSION_ID env -> argv[0] -> DEFAULT_EXT_ID.
 * When no id is available (e.g. postinstall before the extension is published),
 * registration is skipped WITHOUT failing (exit 0), so `npm i` never breaks.
 */
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const HOST_NAME = "com.ainecto.agent";
// Filled in once the extension is published to the Chrome Web Store (fixed id).
const DEFAULT_EXT_ID = "";
const SUBCOMMANDS = new Set(["register", "setup", "agent-host"]);

interface IO {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

function which(bin: string): string {
  try {
    const cmd = process.platform === "win32" ? `where ${bin}` : `command -v ${bin}`;
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split(/\r?\n/)[0] || "";
  } catch {
    return "";
  }
}

function resolveExtId(argv: string[]): string {
  const raw = process.env.AINECTO_EXTENSION_ID || argv[0] || DEFAULT_EXT_ID || "";
  return SUBCOMMANDS.has(raw) ? "" : raw;
}

// dist/bin/agent-host.js — resolved relative to this bundle (dist/bin/ainecto.js) at runtime.
function agentHostEntry(): string {
  return fileURLToPath(new URL("./agent-host.js", import.meta.url));
}

function manifest(launcher: string, id: string): string {
  return JSON.stringify(
    {
      name: HOST_NAME,
      description: "AiNecto Agent native host",
      path: launcher,
      type: "stdio",
      allowed_origins: [`chrome-extension://${id}/`],
    },
    null,
    2,
  );
}

function writeLauncherUnix(): string {
  const toolDirs: string[] = [];
  for (const b of ["claude", "codex", "node"]) {
    const p = which(b);
    if (p) {
      const d = path.dirname(p);
      if (!toolDirs.includes(d)) toolDirs.push(d);
    }
  }
  // Chrome launches native hosts with a minimal PATH — bake in detected tool dirs.
  const pathParts = [...new Set(toolDirs.concat(["$HOME/.npm-global/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "$PATH"]))];
  const launcher = path.join(os.homedir(), ".ainecto", "ainecto-agent-host");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(
    launcher,
    `#!/usr/bin/env bash\n` +
      `# Chrome minimal-PATH fix — tool dirs detected at registration time\n` +
      `export PATH="${pathParts.join(":")}"\n` +
      `exec "${process.execPath}" "${agentHostEntry()}"\n`,
  );
  fs.chmodSync(launcher, 0o755);
  return launcher;
}

function writeLauncherWin(): string {
  const launcher = path.join(os.homedir(), ".ainecto", "ainecto-agent-host.cmd");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${agentHostEntry()}" %*\r\n`);
  return launcher;
}

export function runRegister(argv: string[], io: IO): number {
  const id = resolveExtId(argv);
  if (!id) {
    io.stderr.write("⚠ No extension id — skipping native-messaging manifest registration.\n");
    io.stderr.write("  Later:  ainecto register <EXTENSION_ID>   (or AINECTO_EXTENSION_ID env)\n");
    return 0; // do not fail postinstall
  }

  if (process.platform === "win32") {
    const launcher = writeLauncherWin();
    const manifestPath = path.join(os.homedir(), ".ainecto", `${HOST_NAME}.json`);
    fs.writeFileSync(manifestPath, manifest(launcher, id));
    try {
      execSync(
        `reg add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}" /ve /t REG_SZ /d "${manifestPath}" /f`,
        { stdio: "ignore" },
      );
    } catch (e: any) {
      io.stderr.write(`registry write failed: ${e.message}\n`);
    }
    io.stdout.write(`✅ registered (Windows)\n   manifest: ${manifestPath}\n   ext id:   ${id}\n`);
    return 0;
  }

  const launcher = writeLauncherUnix();
  const targetDir =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts")
      : path.join(os.homedir(), ".config/google-chrome/NativeMessagingHosts");
  fs.mkdirSync(targetDir, { recursive: true });
  const manifestPath = path.join(targetDir, `${HOST_NAME}.json`);
  fs.writeFileSync(manifestPath, manifest(launcher, id));
  io.stdout.write(`✅ registered\n   manifest: ${manifestPath}\n   launcher: ${launcher}\n   ext id:   ${id}\n`);
  return 0;
}
