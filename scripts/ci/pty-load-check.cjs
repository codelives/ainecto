// CI 전용(windows.yml) — 지금 폴더(cwd)의 node_modules 에서 node-pty 를 불러, ★실제로 로드된 네이티브 폴더와 PTY 한 번을 본다.
// 판정 = 로드된 폴더가 prebuilds/<platform>-<arch> 인가(build/Release 는 설치 스크립트가 만들 수 있어 «있음»으로 판정하지 않는다).
// 인자 1 = 표지(어떤 설치인지 — 증적용).
const { createRequire } = require("node:module");
const path = require("node:path");

const load = createRequire(path.join(process.cwd(), "pty-load-check.js"));
const { loadNativeModule } = load("node-pty/lib/utils");
const pty = load("node-pty");
const windows = process.platform === "win32";
const native = loadNativeModule(windows ? "conpty" : "pty").dir.replace(/\\/g, "/");
const want = `prebuilds/${process.platform}-${process.arch}`;
const child = windows
  ? pty.spawn(process.env.ComSpec, '/d /s /c "echo ainecto-pty-ok"', {})
  : pty.spawn("/bin/sh", ["-c", "echo ainecto-pty-ok"], {});
let out = "";
child.onData((data) => {
  out += data;
});
child.onExit(({ exitCode }) => {
  console.log(JSON.stringify({ label: process.argv[2] ?? "", node: process.version, arch: process.arch, native, exitCode }));
  if (!out.includes("ainecto-pty-ok")) {
    console.error(out);
    process.exit(1);
  }
  if (!native.endsWith(want)) {
    console.error(`loaded ${native}, expected …/${want}`);
    process.exit(1);
  }
});
