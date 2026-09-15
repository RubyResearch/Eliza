/**
 * Exercises real promise scheduling for tracked post-delivery work, including
 * tasks spawned by tasks and failure reporting at the detached boundary.
 */
import { describe, expect, it, vi } from "vitest";
import { RoomHandlerQueue } from "../runtime/room-handler-queue.ts";
import type { Memory, UUID } from "../types/index.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import { MessageRunTerminalOwner } from "./message/turn-session.ts";
import {
	drainPostDeliveryTasks,
	drainRoomPostDeliveryTasks,
	pendingPostDeliveryTaskCount,
	pendingRoomPostDeliveryTaskCount,
	postDeliveryTaskQuarantineReason,
	roomDeliverySettlement,
	trackPostDeliveryTask,
	withRoomDeliverySettlement,
} from "./post-delivery-task-tracker.ts";

function runtimeStub(roomHandlerQueue?: RoomHandlerQueue) {
	return {
		agentId: "00000000-0000-4000-8000-000000000001",
		reportError: vi.fn(),
		roomHandlerQueue,
	} as unknown as Pick<IAgentRuntime, "agentId" | "reportError">;
}

describe("post-delivery task tracker", () => {
	it("waits for settled connector evidence before extraction and terminal drain", async () => {
		const queue = new RoomHandlerQueue();
		const runtime = {
			...runtimeStub(queue),
			emitEvent: vi.fn(async () => undefined),
		} as unknown as IAgentRuntime;
		const roomId = "00000000-0000-4000-8000-000000000002" as UUID;
		const message = {
			id: "trigger",
			roomId,
			entityId: runtime.agentId,
			content: { text: "Remember this" },
		} as Memory;
		const order: string[] = [];
		await queue.withLease(roomId, async (lease) => {
			await withRoomDeliverySettlement(runtime, roomId, lease, async () => {
				const owner = new MessageRunTerminalOwner(
					runtime,
					"run" as UUID,
					message,
					Date.now(),
					lease,
				);
				owner.trackAfterDelivery("post_turn", async () => {
					order.push("extraction");
				});
				owner.request("completed");
				await Promise.resolve();
				await Promise.resolve();
				expect(order).toEqual([]);
				expect(runtime.emitEvent).not.toHaveBeenCalled();
				order.push("persist-final-reply", "persist-callback-evidence");
			});
			expect(order).toEqual([
				"persist-final-reply",
				"persist-callback-evidence",
				"extraction",
			]);
			expect(runtime.emitEvent).toHaveBeenCalledTimes(1);
			expect(pendingRoomPostDeliveryTaskCount(runtime, roomId)).toBe(0);
			expect(queue.ownsLease(roomId, lease)).toBe(true);
		});
	});

	it("cancels extraction without deadlocking terminal drain when connector persistence fails", async () => {
		const queue = new RoomHandlerQueue();
		const runtime = {
			...runtimeStub(queue),
			emitEvent: vi.fn(async () => undefined),
		} as unknown as IAgentRuntime;
		const roomId = "00000000-0000-4000-8000-000000000002" as UUID;
		const message = {
			id: "trigger",
			roomId,
			entityId: runtime.agentId,
			content: { text: "Remember this" },
		} as Memory;
		const extract = vi.fn(async () => undefined);
		await queue.withLease(roomId, async (lease) => {
			await expect(
				withRoomDeliverySettlement(runtime, roomId, lease, async () => {
					const owner = new MessageRunTerminalOwner(
						runtime,
						"run" as UUID,
						message,
						Date.now(),
						lease,
					);
					owner.trackAfterDelivery("post_turn", extract);
					owner.request("completed");
					throw new Error("delivery persistence failed");
				}),
			).rejects.toThrow("delivery persistence failed");
			expect(extract).not.toHaveBeenCalled();
			expect(runtime.emitEvent).toHaveBeenCalledTimes(1);
			expect(pendingRoomPostDeliveryTaskCount(runtime, roomId)).toBe(0);
			expect(runtime.reportError).toHaveBeenCalledWith(
				"PostDeliveryTask",
				expect.objectContaining({ code: "POST_DELIVERY_NOT_SETTLED" }),
				expect.anything(),
			);
			await expect(
				roomDeliverySettlement(runtime, roomId, lease),
			).resolves.toBe(true);
		});
	});

	it("scopes settlement to runtime/room/live lease and preserves hosts without a gate", async () => {
		const queue = new RoomHandlerQueue();
		const runtime = runtimeStub(queue);
		const otherRuntime = runtimeStub(queue);
		const roomId = "room-one";
		const otherRoom = "room-two";
		const lease = await queue.acquire(roomId);
		const otherLease = await queue.acquire(otherRoom);
		await expect(
			withRoomDeliverySettlement(
				runtime,
				roomId,
				otherLease,
				async () => undefined,
			),
		).rejects.toMatchObject({
			code: "POST_DELIVERY_SETTLEMENT_LEASE_MISMATCH",
		});
		await withRoomDeliverySettlement(runtime, roomId, lease, async () => {
			expect(() =>
				roomDeliverySettlement(runtime, roomId, otherLease),
			).toThrowError(
				expect.objectContaining({
					code: "POST_DELIVERY_SETTLEMENT_LEASE_MISMATCH",
				}),
			);
			await expect(
				roomDeliverySettlement(otherRuntime, roomId, lease),
			).resolves.toBe(true);
			await expect(
				roomDeliverySettlement(runtime, otherRoom, otherLease),
			).resolves.toBe(true);
			await expect(
				withRoomDeliverySettlement(
					runtime,
					roomId,
					lease,
					async () => undefined,
				),
			).rejects.toMatchObject({
				code: "POST_DELIVERY_SETTLEMENT_ALREADY_ACTIVE",
			});
		});
		await lease.release();
		await otherLease.release();
	});

	it("drains nested work before reporting quiescence", async () => {
		const runtime = runtimeStub();
		const order: string[] = [];
		trackPostDeliveryTask(runtime, "outer", async () => {
			order.push("outer");
			trackPostDeliveryTask(runtime, "inner", async () => {
				await Promise.resolve();
				order.push("inner");
			});
		});

		expect(pendingPostDeliveryTaskCount(runtime)).toBe(1);
		const drained = await drainPostDeliveryTasks(runtime);

		expect(drained).toBe(1);
		expect(order).toEqual(["outer", "inner"]);
		expect(pendingPostDeliveryTaskCount(runtime)).toBe(0);
	});

	it("reports failures and still drains", async () => {
		const runtime = runtimeStub();
		trackPostDeliveryTask(runtime, "broken", async () => {
			throw new Error("post-turn failed");
		});

		await drainPostDeliveryTasks(runtime);

		expect(runtime.reportError).toHaveBeenCalledWith(
			"PostDeliveryTask",
			expect.objectContaining({ message: "post-turn failed" }),
			expect.objectContaining({ label: "broken" }),
		);
		expect(pendingPostDeliveryTaskCount(runtime)).toBe(0);
	});

	it("does not quarantine an idle runtime for a pre-aborted drain", async () => {
		const runtime = runtimeStub();
		const controller = new AbortController();
		controller.abort(new Error("owner no longer needs to wait"));

		await expect(
			drainPostDeliveryTasks(runtime, { signal: controller.signal }),
		).resolves.toBe(0);
		expect(postDeliveryTaskQuarantineReason(runtime)).toBeUndefined();

		const reused = trackPostDeliveryTask(
			runtime,
			"reuse-after-idle-abort",
			async () => undefined,
		);
		await expect(drainPostDeliveryTasks(runtime)).resolves.toBe(1);
		await reused;
		expect(pendingPostDeliveryTaskCount(runtime)).toBe(0);
	});

	it("cancels cooperative work and quarantines uncooperative work", async () => {
		const runtime = runtimeStub();
		const privateAbortReason = "private abort reason must not escape";
		let cooperativeAborted = false;
		let releaseUncooperative!: () => void;
		const cooperative = trackPostDeliveryTask(
			runtime,
			"cooperative",
			async (signal) => {
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							cooperativeAborted = true;
							reject(signal.reason);
						},
						{ once: true },
					);
				});
			},
		);
		const uncooperative = trackPostDeliveryTask(
			runtime,
			"uncooperative",
			async () => {
				await new Promise<void>((resolve) => {
					releaseUncooperative = resolve;
				});
			},
		);
		const controller = new AbortController();
		const draining = drainPostDeliveryTasks(runtime, {
			signal: controller.signal,
		});
		await Promise.resolve();
		controller.abort(new Error(privateAbortReason));

		let drainError: unknown;
		try {
			await draining;
		} catch (error) {
			drainError = error;
		}
		expect(drainError).toMatchObject({
			code: "POST_DELIVERY_DRAIN_CANCELLED",
			context: { reason: "post-delivery drain was cancelled" },
		});
		expect(cooperativeAborted).toBe(true);
		await cooperative;
		expect(postDeliveryTaskQuarantineReason(runtime)).toBe(
			"post-delivery drain was cancelled",
		);
		expect(String(drainError)).not.toContain(privateAbortReason);
		expect(
			runtime.reportError.mock.calls.some((call) =>
				call.some((value) => String(value).includes(privateAbortReason)),
			),
		).toBe(false);
		expect(pendingPostDeliveryTaskCount(runtime)).toBe(1);
		await expect(drainPostDeliveryTasks(runtime)).rejects.toMatchObject({
			code: "POST_DELIVERY_DRAIN_CANCELLED",
		});
		expect(() =>
			trackPostDeliveryTask(runtime, "late", async () => undefined),
		).toThrowError(
			expect.objectContaining({ code: "POST_DELIVERY_RUNTIME_QUARANTINED" }),
		);
		releaseUncooperative();
		await uncooperative;
		expect(pendingPostDeliveryTaskCount(runtime)).toBe(0);
	});

	it("retains quarantine membership when cancellation has an empty message", async () => {
		const runtime = runtimeStub();
		let releaseUncooperative!: () => void;
		const uncooperative = trackPostDeliveryTask(
			runtime,
			"empty-message-uncooperative",
			async () =>
				new Promise<void>((resolve) => {
					releaseUncooperative = resolve;
				}),
		);
		const controller = new AbortController();
		const draining = drainPostDeliveryTasks(runtime, {
			signal: controller.signal,
		});
		await Promise.resolve();
		controller.abort(new Error());

		await expect(draining).rejects.toMatchObject({
			code: "POST_DELIVERY_DRAIN_CANCELLED",
			context: { reason: "post-delivery drain was cancelled" },
		});
		expect(postDeliveryTaskQuarantineReason(runtime)).toBe(
			"post-delivery drain was cancelled",
		);
		expect(() =>
			trackPostDeliveryTask(runtime, "late", async () => undefined),
		).toThrowError(
			expect.objectContaining({ code: "POST_DELIVERY_RUNTIME_QUARANTINED" }),
		);

		releaseUncooperative();
		await uncooperative;
	});

	it("treats unclassified room work as state-bearing and drains it before ownership ends", async () => {
		const roomId = "00000000-0000-4000-8000-000000000002";
		const queue = new RoomHandlerQueue();
		const runtime = runtimeStub(queue);
		const lease = await queue.acquire(roomId);
		let releaseTask!: () => void;
		const taskGate = new Promise<void>((resolve) => {
			releaseTask = resolve;
		});

		queue.runInLease(roomId, lease, () => {
			trackPostDeliveryTask(runtime, "new-room-task", async () => taskGate);
		});
		expect(pendingRoomPostDeliveryTaskCount(runtime, roomId)).toBe(1);

		releaseTask();
		await drainRoomPostDeliveryTasks(runtime, roomId);
		expect(pendingRoomPostDeliveryTaskCount(runtime, roomId)).toBe(0);
		await lease.release();
	});

	it("requires and drains explicit room ownership without async-local context", async () => {
		const roomId = "00000000-0000-4000-8000-000000000003";
		const queue = new RoomHandlerQueue({ asyncContext: "explicit" });
		const runtime = runtimeStub(queue);
		expect(() =>
			trackPostDeliveryTask(
				runtime,
				"unowned-room-task",
				async () => undefined,
			),
		).toThrowError(
			expect.objectContaining({
				code: "POST_DELIVERY_ROOM_OWNERSHIP_REQUIRED",
			}),
		);

		const lease = await queue.acquire(roomId);
		let releaseTask!: () => void;
		const taskGate = new Promise<void>((resolve) => {
			releaseTask = resolve;
		});
		trackPostDeliveryTask(runtime, "explicit-room-task", async () => taskGate, {
			kind: "room-state",
			roomId,
			roomHandlerLease: lease,
		});
		expect(pendingRoomPostDeliveryTaskCount(runtime, roomId)).toBe(1);

		releaseTask();
		await drainRoomPostDeliveryTasks(runtime, roomId);
		await lease.release();
		expect(pendingRoomPostDeliveryTaskCount(runtime, roomId)).toBe(0);
	});
});
