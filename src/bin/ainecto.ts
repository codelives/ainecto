#!/usr/bin/env node
import { runAinectoCli } from "../adapters/cli/ainectoCli";

const exitCode = await runAinectoCli(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});

process.exitCode = exitCode;
