/**
 * `JOIN_MEETING` — send the notetaker bot into a Google Meet / Teams / Zoom
 * meeting from a chat message ("join this call: https://meet.google.com/…").
 */

import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
} from "@elizaos/core";
import { MEETING_PLATFORM_LABELS } from "@elizaos/shared";
import { MeetingJoinError } from "../service.js";
import {
  MEETING_URL_PARAMETER,
  optionString,
  reply,
  requireMeetingService,
  resolveMeetingUrl,
} from "./shared.js";

async function handler(
  runtime: IAgentRuntime,
  message: Memory,
  _state?: unknown,
  options?: unknown,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const parsed = resolveMeetingUrl(message, options);
  if (!parsed) {
    return reply(
      callback,
      false,
      "I need a meeting link to join — paste a Google Meet, Microsoft Teams, or Zoom URL.",
    );
  }
  const svc = await requireMeetingService(
    runtime,
    callback,
    "The meetings service isn't running, so I can't join calls right now.",
  );
  if ("bail" in svc) return svc.bail;
  const service = svc.service;
  try {
    const session = await service.requestJoin({
      platform: parsed.platform,
      meetingUrl: parsed.meetingUrl,
      botName: optionString(options, "botName") ?? undefined,
      language: optionString(options, "language") ?? undefined,
    });
    return reply(
      callback,
      true,
      `Joining the ${MEETING_PLATFORM_LABELS[session.platform]} meeting ${session.nativeMeetingId} as "${session.botName}". I'll transcribe it live — watch it land in the Transcripts view (transcript ${session.transcriptId}).`,
      { sessionId: session.id, transcriptId: session.transcriptId },
    );
  } catch (err) {
    const out =
      err instanceof MeetingJoinError
        ? `I can't join that meeting: ${err.message}`
        : `Joining the meeting failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "[MeetingService] JOIN_MEETING failed",
    );
    return reply(callback, false, out);
  }
}

export const joinMeetingAction: Action = {
  name: "JOIN_MEETING",
  // Dispatching the notetaker bot is a privileged action: it launches a browser
  // that joins a live call under the agent's identity and records it. Without a
  // gate, any DM user on any connector who pastes a meeting URL could send the
  // bot into a meeting. Restrict to the agent owner (mirrors the OWNER gate on
  // other side-effecting actions — browser, calendar, computer-use).
  roleGate: { minRole: "OWNER" },
  similes: [
    "INVITE_TO_MEETING",
    "ATTEND_MEETING",
    "TAKE_MEETING_NOTES",
    "TRANSCRIBE_MEETING",
    "RECORD_MEETING",
    "SEND_NOTETAKER",
    "JOIN_CALL",
  ],
  description:
    "Send the agent's notetaker bot into a live Google Meet, Microsoft Teams, or Zoom meeting to attend and transcribe it in real time. Use this WHENEVER the message contains a Meet / Teams / Zoom meeting link (meet.google.com, teams.microsoft.com / teams.live.com, zoom.us / app.zoom.us) and the user wants the agent to join, attend, sit in on, cover, take notes on, record, or transcribe that meeting or call. Prefer this over calendar, reminder, scheduling, or plain reply actions when a joinable meeting URL is present — those only schedule or acknowledge, whereas this actually joins the call now. Requires a meeting URL in the message or a meetingUrl parameter.",
  parameters: [
    MEETING_URL_PARAMETER,
    {
      name: "botName",
      description:
        "Display name the notetaker bot joins with. Omit to use the configured default.",
      required: false,
      aliases: ["bot_name", "displayName"],
      schema: { type: "string" },
    },
    {
      name: "language",
      description:
        "Spoken language of the meeting as a BCP 47 tag (for example en, de, pt-BR) to steer transcription. Omit to auto-detect.",
      required: false,
      aliases: ["lang", "locale"],
      schema: { type: "string" },
    },
  ],
  validate: async (_runtime, message, _state, options) =>
    resolveMeetingUrl(message, options) !== null,
  handler,
  examples: [
    [
      {
        name: "{{user}}",
        content: {
          text: "Can you join this call and take notes? https://meet.google.com/abc-defg-hij",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Joining the Google Meet meeting abc-defg-hij as a notetaker — the live transcript will appear in the Transcripts view.",
          actions: ["JOIN_MEETING"],
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: {
          text: "sit in on my zoom and transcribe it: https://us02web.zoom.us/j/84512339087?pwd=abcd",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "On it — joining your Zoom meeting as a notetaker and transcribing live.",
          actions: ["JOIN_MEETING"],
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: {
          text: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc can you cover this one for me?",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Joining the Microsoft Teams meeting now — I'll capture the transcript for you.",
          actions: ["JOIN_MEETING"],
        },
      },
    ],
  ],
};
