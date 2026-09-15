/**
 * `LEAVE_MEETING` — pull the notetaker bot out of an active meeting. Targets
 * the meeting named by URL/sessionId when given, otherwise the single active
 * session; asks for disambiguation when several are active.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { MEETING_PLATFORM_LABELS } from "@elizaos/shared";
import type { MeetingService } from "../service.js";
import {
  MEETING_URL_PARAMETER,
  messageText,
  reply,
  requireMeetingService,
  resolveTargetSession,
  SESSION_ID_PARAMETER,
} from "./shared.js";

async function handler(
  runtime: IAgentRuntime,
  message: Memory,
  _state?: unknown,
  options?: unknown,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const svc = await requireMeetingService(
    runtime,
    callback,
    "The meetings service isn't running.",
  );
  if ("bail" in svc) return svc.bail;
  const active = svc.service.listSessions({ active: true });
  const target = resolveTargetSession(
    active,
    message,
    options,
    "single-or-ambiguous",
  );
  if (target === null) {
    return reply(
      callback,
      false,
      "I'm not in that meeting right now — nothing to leave.",
    );
  }
  if (target === "ambiguous") {
    const list = active
      .map((s) => `${MEETING_PLATFORM_LABELS[s.platform]} ${s.nativeMeetingId}`)
      .join(", ");
    return reply(
      callback,
      false,
      `I'm in ${active.length} meetings (${list}) — which one should I leave?`,
    );
  }
  svc.service.stopSession(target.id as UUID);
  return reply(
    callback,
    true,
    `Leaving the ${MEETING_PLATFORM_LABELS[target.platform]} meeting ${target.nativeMeetingId}. The transcript is saved in the Transcripts view.`,
    { sessionId: target.id, transcriptId: target.transcriptId },
  );
}

export const leaveMeetingAction: Action = {
  name: "LEAVE_MEETING",
  similes: ["EXIT_MEETING", "STOP_MEETING_TRANSCRIPTION"],
  description:
    "Leave a meeting the notetaker bot is currently attending and finalize its transcript.",
  validate: async (runtime, message) => {
    const service = runtime.getService<MeetingService>("meetings");
    if (!service) return false;
    if (service.listSessions({ active: true }).length === 0) return false;
    return /\b(leave|exit|stop|end|drop)\b/i.test(messageText(message));
  },
  parameters: [SESSION_ID_PARAMETER, MEETING_URL_PARAMETER],
  handler,
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "You can leave the meeting now, thanks" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Leaving the meeting — the transcript is saved in the Transcripts view.",
          actions: ["LEAVE_MEETING"],
        },
      },
    ],
  ],
};
