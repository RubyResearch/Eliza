/** Runs the real Docker expiry contract on a Linux host using only disposable, network-isolated test containers. */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ElizaError } from "@elizaos/core";
import { DOCKER_COMPUTE_GUARD_PROGRAM } from "../src/lib/services/docker-compute-lease";

const { values } = parseArgs({ options: { image: { type: "string" } }, strict: true });
if (process.platform !== "linux" || process.geteuid?.() !== 0 || !values.image) {
  throw new ElizaError("Run as Linux root with --image=<existing-local-image-id>", {
    code: "COMPUTE_GUARD_TEST_HOST_REQUIRED",
    severity: "fatal",
  });
}
const directory = await mkdtemp(join(tmpdir(), "eliza-compute-guard-source-"));
try {
  const program = join(directory, "guard.py");
  await writeFile(program, DOCKER_COMPUTE_GUARD_PROGRAM, { mode: 0o600 });
  const child = Bun.spawn(
    ["python3", join(import.meta.dir, "test-docker-compute-lease.py"), program, values.image],
    { stdout: "inherit", stderr: "inherit" },
  );
  process.exitCode = await child.exited;
} finally {
  await rm(directory, { recursive: true, force: true });
}
