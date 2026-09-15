#!/usr/bin/env node
// The SDK lacks these exec flags. Keep its protocol intact while preventing an
// inference request from inheriting the owner's interactive tools or rules.
import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (command !== "exec") throw new Error("Inference launcher only supports codex exec");
const { ELIZA_CODEX_INFERENCE_BIN: binary, ...env } = process.env;
if (!binary) throw new Error("Inference Codex binary is not configured");
const child = spawn(binary, [
  command, "--ignore-user-config", "--ignore-rules", "--ephemeral", ...args,
], { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(`Could not start Codex inference: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code) => { process.exitCode = code ?? 1; });
