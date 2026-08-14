#!/usr/bin/env node
import { runAgentHost } from "../adapters/agent/nativeHost";

// Chrome launches this over stdin/stdout (native messaging). Stays alive until stdin closes.
runAgentHost({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
