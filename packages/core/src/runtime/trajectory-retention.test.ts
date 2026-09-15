import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	resolveTrajectoryRetentionDays,
	sweepTrajectoryFiles,
} from "./trajectory-recorder";

const DAY = 24 * 60 * 60 * 1000;
let dir = "";

afterEach(async () => {
	if (dir) await fs.rm(dir, { recursive: true, force: true });
	dir = "";
	delete process.env.ELIZA_TRAJECTORY_RETENTION_DAYS;
});

async function touch(file: string, ageMs: number, now: number) {
	await fs.writeFile(file, "{}", "utf8");
	const t = new Date(now - ageMs);
	await fs.utimes(file, t, t);
}

describe("sweepTrajectoryFiles", () => {
	it("removes trajectory files past the window and stale tmp writes, keeps the rest", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "tj-retention-"));
		const agent = path.join(dir, "agent-1");
		await fs.mkdir(agent);
		const now = Date.now();
		await touch(path.join(agent, "tj-old.json"), 20 * DAY, now);
		await touch(path.join(agent, "tj-new.json"), 2 * DAY, now);
		await touch(path.join(agent, "tj-x.json.1.abc.tmp"), 2 * DAY, now);
		await touch(path.join(agent, "tj-y.json.1.def.tmp"), 60_000, now);
		await touch(path.join(agent, "notes.txt"), 40 * DAY, now);

		const outcome = await sweepTrajectoryFiles(dir, {
			maxAgeMs: 14 * DAY,
			now,
		});

		expect(outcome).toEqual({ removed: 1, tmpRemoved: 1, scanned: 4 });
		expect((await fs.readdir(agent)).sort()).toEqual([
			"notes.txt",
			"tj-new.json",
			"tj-y.json.1.def.tmp",
		]);
	});

	it("is a no-op on a missing directory", async () => {
		expect(
			await sweepTrajectoryFiles("/nonexistent/trajectories", {
				maxAgeMs: DAY,
			}),
		).toEqual({ removed: 0, tmpRemoved: 0, scanned: 0 });
	});
});

describe("resolveTrajectoryRetentionDays", () => {
	it("defaults to 14 and honours a non-negative override", () => {
		expect(resolveTrajectoryRetentionDays()).toBe(14);
		process.env.ELIZA_TRAJECTORY_RETENTION_DAYS = "3";
		expect(resolveTrajectoryRetentionDays()).toBe(3);
		process.env.ELIZA_TRAJECTORY_RETENTION_DAYS = "0";
		expect(resolveTrajectoryRetentionDays()).toBe(0);
		process.env.ELIZA_TRAJECTORY_RETENTION_DAYS = "nope";
		expect(resolveTrajectoryRetentionDays()).toBe(14);
	});
});
