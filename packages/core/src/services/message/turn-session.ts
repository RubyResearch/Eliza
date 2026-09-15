/** Owns message response identity and terminal-event settlement across awaited and detached turn work. */

import { ElizaError } from "../../errors";
import type { RoomHandlerLease } from "../../runtime/room-handler-queue";
import type { RunEventPayload } from "../../types/events";
import { EventType } from "../../types/events";
import type { Memory } from "../../types/memory";
import type { UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import {
	roomDeliverySettlement,
	trackPostDeliveryTask,
} from "../post-delivery-task-tracker.ts";

/**
 * Tracks the latest response ID per agent+room to handle message superseding
 */
export const latestResponseIds = new Map<string, Map<string, string[]>>();

export function clearLatestResponseId(
	agentId: UUID,
	roomId: UUID,
	responseId: UUID,
): void {
	const agentMap = latestResponseIds.get(agentId);
	if (!agentMap) {
		return;
	}

	const roomResponses = agentMap.get(roomId);
	if (!roomResponses) {
		return;
	}
	const responseIndex = roomResponses.lastIndexOf(responseId);
	if (responseIndex < 0) return;
	roomResponses.splice(responseIndex, 1);
	if (roomResponses.length === 0) agentMap.delete(roomId);
	if (agentMap.size === 0) {
		latestResponseIds.delete(agentId);
	}
}

export function getLatestResponseId(
	agentId: UUID,
	roomId: UUID,
): string | undefined {
	const roomResponses = latestResponseIds.get(agentId)?.get(roomId);
	return roomResponses?.[roomResponses.length - 1];
}

export function detachPostDeliverySideEffect(
	runtime: Pick<IAgentRuntime, "agentId" | "reportError">,
	label: string,
	task: () => Promise<unknown>,
	kind: "room-state" | "diagnostic" = "room-state",
	roomId?: string,
	roomHandlerLease?: RoomHandlerLease,
): Promise<void> {
	return trackPostDeliveryTask(
		runtime,
		label,
		task,
		kind === "diagnostic"
			? { kind }
			: roomId && roomHandlerLease
				? { kind, roomId, roomHandlerLease }
				: { kind },
	);
}

/**
 * Owns asynchronous continuations whose provider, model, or database-trajectory
 * captures belong to one message-service run. Delivery returns as soon as the
 * visible result is ready; the detached terminal waits for this set to quiesce,
 * then emits exactly one `RUN_ENDED` event. File-recorder finalization and
 * bounded inference-timing persistence are diagnostic-only and intentionally
 * drain independently. A run-owned task may not join after terminalization is
 * requested.
 */
export class MessageRunTerminalOwner {
	private readonly pending = new Set<Promise<void>>();
	private terminalRequest:
		| {
				status: RunEventPayload["status"];
				error?: unknown;
		  }
		| undefined;
	private terminalTask: Promise<void> | undefined;

	constructor(
		private readonly runtime: IAgentRuntime,
		private readonly runId: UUID,
		private readonly message: Memory,
		private readonly startTime: number,
		private readonly roomHandlerLease?: RoomHandlerLease,
	) {}

	track(label: string, task: () => Promise<unknown>): Promise<void> {
		if (this.terminalRequest) {
			const error = new ElizaError(
				"Run-owned work cannot start after terminalization was requested",
				{
					code: "RUN_TASK_AFTER_TERMINAL",
					context: {
						label,
						runId: this.runId,
						messageId: this.message.id,
					},
				},
			);
			this.runtime.reportError("MessageRunTerminalOwner.track", error, {
				label,
				runId: this.runId,
				messageId: this.message.id,
			});
			return Promise.resolve();
		}

		let tracked!: Promise<void>;
		tracked = Promise.resolve()
			.then(task)
			.then(() => undefined)
			.catch((error) => {
				// error-policy:J1 User delivery is already committed. Preserve the exact
				// child failure while allowing the terminal barrier to release the run.
				this.runtime.reportError("PostDeliveryTask", error, {
					agentId: this.runtime.agentId,
					label,
					runId: this.runId,
				});
			})
			.finally(() => {
				this.pending.delete(tracked);
			});
		this.pending.add(tracked);
		return tracked;
	}

	adopt(label: string, task: Promise<unknown>): Promise<void> {
		return this.track(label, () => task);
	}

	/** Evidence extraction must observe the connector's settled persisted reply,
	 * including delivery receipts/callback history, not its provisional row. */
	trackAfterDelivery(
		label: string,
		task: () => Promise<unknown>,
	): Promise<void> {
		const delivered = roomDeliverySettlement(
			this.runtime,
			this.message.roomId,
			this.roomHandlerLease,
		);
		return this.track(label, async () => {
			if (!(await delivered))
				throw new ElizaError(
					"Post-turn work skipped because delivery did not settle",
					{
						code: "POST_DELIVERY_NOT_SETTLED",
					},
				);
			return task();
		});
	}

	request(status: RunEventPayload["status"], error?: unknown): Promise<void> {
		if (this.terminalRequest) return this.terminalTask ?? Promise.resolve();
		this.terminalRequest = {
			status,
			...(error === undefined ? {} : { error }),
		};
		try {
			this.terminalTask = detachPostDeliverySideEffect(
				this.runtime,
				"RUN_ENDED",
				async () => {
					while (this.pending.size > 0) {
						await Promise.allSettled([...this.pending]);
					}
					const terminal = this.terminalRequest;
					if (!terminal) {
						throw new ElizaError("Run terminal request disappeared", {
							code: "RUN_TERMINAL_REQUEST_MISSING",
							context: { runId: this.runId, messageId: this.message.id },
						});
					}
					await this.runtime.emitEvent(EventType.RUN_ENDED, {
						runtime: this.runtime,
						source: "messageHandler",
						runId: this.runId,
						messageId: this.message.id,
						roomId: this.message.roomId,
						entityId: this.message.entityId,
						startTime: this.startTime,
						status: terminal.status,
						endTime: Date.now(),
						duration: Date.now() - this.startTime,
						...(terminal.error === undefined
							? {}
							: {
									error:
										terminal.error instanceof Error
											? terminal.error
											: String(terminal.error),
								}),
					} as RunEventPayload);
				},
				"room-state",
				this.message.roomId,
				this.roomHandlerLease,
			);
		} catch (terminalScheduleError) {
			this.terminalRequest = undefined;
			throw terminalScheduleError;
		}
		return this.terminalTask;
	}
}
