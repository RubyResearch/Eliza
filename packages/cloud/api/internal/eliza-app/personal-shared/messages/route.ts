/** Runs a trusted messaging delivery through one rowless personal Shared turn. */

import {
  ELIZA_FAILURE_CAUSE_NAME_HEADER,
  ELIZA_FAILURE_NAME_HEADER,
  ELIZA_FAILURE_STAGE_HEADER,
  ELIZA_RETRYABLE_HEADER,
} from "@elizaos/cloud-services-common/personal-shared-failure";
import { ChannelType } from "@elizaos/core/edge";
import type { SharedGroupReminderDelivery } from "@elizaos/plugin-scheduling/edge";
import { Hono } from "hono";
import { z } from "zod";
import {
  PersonalDeliveryAccountResolutionError,
  resolvePersonalDeliveryProjection,
} from "@/api-app/personal-delivery-projection";
import {
  type PersonalSharedGroupConsentStatus,
  personalSharedGroupConsentRepository,
} from "@/db/repositories/personal-shared-group-consent";
import {
  type GroupParticipantIdentity,
  personalSharedGroupParticipantsRepository,
} from "@/db/repositories/personal-shared-group-participants";
import { personalSharedGroupsRepository } from "@/db/repositories/personal-shared-groups";
import type { AgentSandbox } from "@/db/schemas/agent-sandboxes";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { resolveElizaTraceId } from "@/lib/observability/http-telemetry";
import { sha256Hex } from "@/lib/oidc/crypto";
import { findActivePersonalDedicatedTarget } from "@/lib/services/agent-tier-upgrade-target";
import { elizaAppUserService } from "@/lib/services/eliza-app";
import { isAllowedBlooioMediaUrl } from "@/lib/services/eliza-app/blooio-media-allowlist";
import { MAX_INBOUND_MEDIA_IMAGES } from "@/lib/services/eliza-app/describe-inbound-media";
import { enrichInboundImageMedia } from "@/lib/services/eliza-app/inbound-media-enrichment";
import { runOnboardingChat } from "@/lib/services/eliza-app/onboarding-chat";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { preparePersonalDedicatedDelivery } from "@/lib/services/personal-dedicated-delivery";
import { coordinateSharedHistory } from "@/lib/services/shared-runtime/conversation-coordinator";
import {
  GROUP_OWNER_FALLBACK_LABEL,
  groupParticipantLabel,
  redactGroupParticipantHandles,
} from "@/lib/services/shared-runtime/group-participant-labels";
import { personalSharedAgent } from "@/lib/services/shared-runtime/personal-shared-agent";
import { prewarmPersonalSharedAgentTurnCaches } from "@/lib/services/shared-runtime/prewarm-shared-agent";
import { resolveSharedRuntimeWorkerRequestContext } from "@/lib/services/shared-runtime/resolve-shared-agent";
import {
  sharedRestMessageSend,
  sharedTurnServerTiming,
} from "@/lib/services/shared-runtime/shared-rest-adapter";
import {
  SharedRuntimeCacheWarmingError,
  SharedRuntimeTurnError,
} from "@/lib/services/shared-runtime/shared-runtime-errors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../_auth";
import { consumePreverifiedPersonalSharedRequest } from "../preverified-auth";

// Telegram's hosted Bot API download ceiling is 20 MiB. This stricter product
// ceiling keeps the base64 JSON body (~10.7 MiB) and decoded copies bounded in
// a 128 MiB Worker isolate while covering ordinary conversational voice notes.
const MAX_TELEGRAM_VOICE_BYTES = 8 * 1024 * 1024;
const MAX_TELEGRAM_VOICE_BASE64_LENGTH =
  Math.ceil(MAX_TELEGRAM_VOICE_BYTES / 3) * 4;
const DEFAULT_WHISPER_MODEL = "Systran/faster-whisper-small";
const GROUP_CLAIM_TTL_MS = 10 * 60_000;
const GROUP_JOIN_CHALLENGE_TTL_MS = 10 * 60_000;
const GROUP_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const GROUP_CLAIM_CODE_LENGTH = 8;
const GROUP_JOIN_CODE_LENGTH = 12;
const GROUP_SOURCE_MESSAGE_ID_MAX_LENGTH = 240;
const GENERATED_MEDIA_ONLY_MESSAGE = /^\[media: https?:\/\/[^\r\n]+\]$/u;
const GROUP_RELAY_DISCLOSURE =
  "Privacy note: plaintext messages and attachments transit the configured relay provider; Eliza does not make that relay end-to-end encrypted.";

type DeliveryStage =
  | "authentication"
  | "validation"
  | "worker_context"
  | "account_resolution"
  | "consent"
  | "voice_transcription"
  | "media_description"
  | "account_claim"
  | "dedicated_runtime"
  | "shared_runtime";

const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "ApiError",
  "Error",
  "HTTPException",
  "InsufficientCreditsError",
  "PersonalDeliveryAccountResolutionError",
  "RangeError",
  "RateLimitError",
  "SharedRuntimeCacheWarmingError",
  "SharedRuntimeTurnError",
  "SharedTurnConflictError",
  "TimeoutError",
  "TypeError",
]);

function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return SAFE_ERROR_NAMES.has(name) ? name : "OtherError";
}

function retryableDeliveryError(error: unknown): boolean {
  if (error instanceof SharedRuntimeTurnError) return error.retryable;
  const name = error instanceof Error ? error.name : "";
  return (
    error instanceof PersonalDeliveryAccountResolutionError ||
    error instanceof SharedRuntimeCacheWarmingError ||
    name === "AbortError" ||
    name === "RateLimitError" ||
    name === "TimeoutError" ||
    isGroupDeliveryPendingError(error)
  );
}

function isGroupDeliveryPendingError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code ===
      "PERSONAL_SHARED_GROUP_DELIVERY_PENDING"
  );
}

function isIndependentGroupOwnerAuthenticationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code ===
      "PERSONAL_SHARED_GROUP_OWNER_INDEPENDENT_AUTHENTICATION_REQUIRED"
  );
}

const telegramVoiceNoteSchema = z.object({
  bytesBase64: z.string().min(1).max(MAX_TELEGRAM_VOICE_BASE64_LENGTH),
  mimeType: z.literal("audio/ogg"),
  filename: z
    .string()
    .trim()
    .regex(/^telegram-[A-Za-z0-9:._-]+\.ogg$/),
  sizeBytes: z.number().int().positive().max(MAX_TELEGRAM_VOICE_BYTES),
  durationSeconds: z
    .number()
    .int()
    .min(0)
    .max(15 * 60),
});

const projectSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i);
const connectorAccountIdSchema = z.string().trim().min(3).max(160);
const groupActorSchema = z.object({
  platformUserId: z.string().trim().min(1).max(160),
  displayName: z.string().trim().min(1).max(128).optional(),
  role: z.enum(["creator", "administrator", "member", "unknown", "possessor"]),
});
const groupDeliveryAuthoritySchema = z.object({
  bindingId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  personalAgentId: z.string().trim().min(1).max(160),
  version: z.number().int().positive(),
  requiresAllAdultsConsent: z.boolean().optional(),
});
const groupFields = {
  project: projectSchema,
  connectorAccountId: connectorAccountIdSchema,
  chatId: z.string().trim().min(1).max(160),
  actor: groupActorSchema,
  messageId: z.string().trim().min(1).max(160),
  message: z.string().trim().min(1).max(4000),
  invocation: z.enum(["mention", "command", "reply", "ambient"]),
  replyToMessageId: z.string().trim().min(1).max(160).optional(),
};
const blooioGroupMediaUrls = z
  .array(z.string().url().refine(isAllowedBlooioMediaUrl))
  .min(1)
  .max(MAX_INBOUND_MEDIA_IMAGES)
  .optional();

const sharedMessageSchema = z.union([
  z.object({
    eventType: z.literal("membership"),
    platform: z.literal("telegram"),
    project: projectSchema,
    connectorAccountId: connectorAccountIdSchema,
    chatId: z.string().trim().min(1).max(160),
    messageId: z.string().trim().min(1).max(160),
    membershipChange: z.enum(["joined", "removed"]),
  }),
  z.object({
    eventType: z.literal("delivery_authorization"),
    platform: z.enum(["telegram", "blooio"]),
    project: projectSchema,
    connectorAccountId: connectorAccountIdSchema,
    chatId: z.string().trim().min(1).max(160),
    sourceMessageId: z
      .string()
      .trim()
      .min(1)
      .max(GROUP_SOURCE_MESSAGE_ID_MAX_LENGTH),
    leaseToken: z.string().uuid(),
    invocation: z.enum(["mention", "command", "reply", "ambient"]),
    authority: groupDeliveryAuthoritySchema,
  }),
  z.object({
    eventType: z.literal("delivery_commit"),
    platform: z.enum(["telegram", "blooio"]),
    project: projectSchema,
    connectorAccountId: connectorAccountIdSchema,
    chatId: z.string().trim().min(1).max(160),
    sourceMessageId: z
      .string()
      .trim()
      .min(1)
      .max(GROUP_SOURCE_MESSAGE_ID_MAX_LENGTH),
    leaseToken: z.string().uuid(),
    authority: groupDeliveryAuthoritySchema,
  }),
  z.object({
    eventType: z.literal("delivery_receipt"),
    platform: z.enum(["telegram", "blooio"]),
    project: projectSchema,
    connectorAccountId: connectorAccountIdSchema,
    chatId: z.string().trim().min(1).max(160),
    sourceMessageId: z
      .string()
      .trim()
      .min(1)
      .max(GROUP_SOURCE_MESSAGE_ID_MAX_LENGTH),
    providerMessageIds: z.array(z.string().trim().min(1).max(160)).min(1),
    leaseToken: z.string().uuid(),
    authority: groupDeliveryAuthoritySchema,
  }),
  z
    .object({
      platform: z.literal("telegram"),
      project: projectSchema,
      connectorAccountId: connectorAccountIdSchema,
      chatId: z
        .string()
        .trim()
        .regex(/^-?\d{1,20}$/),
      telegramUserId: z
        .string()
        .trim()
        .regex(/^\d{1,20}$/),
      telegramUsername: z.string().trim().min(1).max(64).optional(),
      displayName: z.string().trim().min(1).max(128).optional(),
      messageId: z.string().trim().min(1).max(160),
      message: z.string().trim().min(1).max(4000).optional(),
      voiceNote: telegramVoiceNoteSchema.optional(),
    })
    .refine(
      (input) => input.message !== undefined || input.voiceNote !== undefined,
    ),
  z.object({
    platform: z.literal("telegram"),
    chatType: z.enum(["group", "supergroup"]),
    ...groupFields,
    providerThreadId: z
      .string()
      .trim()
      .regex(/^[1-9]\d{0,15}$/)
      .refine((value) => Number.isSafeInteger(Number(value)))
      .optional(),
  }),
  z.object({
    platform: z.literal("discord"),
    discordUserId: z
      .string()
      .trim()
      .regex(/^\d{1,32}$/),
    discordUsername: z.string().trim().min(1).max(80),
    displayName: z.string().trim().min(1).max(128).optional(),
    avatarUrl: z.string().url().nullable().optional(),
    messageId: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(4000),
  }),
  z
    .object({
      platform: z.enum(["twilio", "blooio"]),
      project: projectSchema,
      connectorAccountId: connectorAccountIdSchema,
      phoneNumber: z
        .string()
        .trim()
        .regex(/^\+[1-9]\d{6,14}$/),
      messageId: z.string().trim().min(1).max(160),
      message: z.string().trim().min(1).max(4000),
      mediaUrls: z
        .array(z.string().url().refine(isAllowedBlooioMediaUrl))
        .min(1)
        .max(MAX_INBOUND_MEDIA_IMAGES)
        .optional(),
    })
    .refine(
      (input) => input.platform === "blooio" || input.mediaUrls === undefined,
    ),
  z.object({
    platform: z.literal("blooio"),
    chatType: z.literal("group"),
    ...groupFields,
    mediaUrls: blooioGroupMediaUrls,
  }),
]);

type SharedMessage = z.infer<typeof sharedMessageSchema>;
type GroupMessage = Extract<
  SharedMessage,
  { chatType: "group" | "supergroup" }
>;

interface GroupDeliveryAuthority {
  bindingId: string;
  ownerUserId: string;
  personalAgentId: string;
  version: number;
  requiresAllAdultsConsent?: boolean;
}

const GROUP_CONTROL_DELIVERY = { kind: "control" as const };
type GroupBindingDeliveryPurpose = "control" | "capability";

function groupBindingDelivery(
  binding: {
    id: string;
    owner_user_id: string;
    personal_agent_id: string;
    authority_version: number;
    consent_mode?: "single_owner" | "all_adults";
  },
  purpose: GroupBindingDeliveryPurpose,
): {
  kind: "binding";
  authority: GroupDeliveryAuthority;
} {
  return {
    kind: "binding",
    authority: {
      bindingId: binding.id,
      ownerUserId: binding.owner_user_id,
      personalAgentId: binding.personal_agent_id,
      version: binding.authority_version,
      ...(binding.consent_mode === "all_adults"
        ? { requiresAllAdultsConsent: purpose === "capability" }
        : {}),
    },
  };
}

/**
 * Last stop before a group reply leaves for the provider. The model is never
 * shown a participant's raw connector handle, so this normally returns the
 * text unchanged; it exists because the one thing worse than a group turn
 * mis-attributing a person is one broadcasting their phone number. Direct
 * turns keep no roster and are passed through.
 */
function guardGroupReply(
  text: string,
  roster: readonly GroupParticipantIdentity[] | undefined,
): string {
  return roster ? redactGroupParticipantHandles(text, roster) : text;
}

function isGroupMessage(message: SharedMessage): message is GroupMessage {
  return "chatType" in message;
}

function providerThreadIdForGroup(message: GroupMessage): string | null {
  return message.platform === "telegram"
    ? (message.providerThreadId ?? null)
    : null;
}

function groupClaimCommand(message: string): string | null {
  const match = message.match(
    /^(?:\/eliza_link(?:@[a-z0-9_]{5,32})?|eliza\s+link)\s+([2-9A-HJ-NP-Z]{8})$/i,
  );
  return match?.[1]?.toUpperCase() ?? null;
}

function groupJoinCodeCommand(message: string): string | null {
  const match = message.match(
    /^(?:\/eliza_join(?:@[a-z0-9_]{5,32})?|eliza\s+join)\s+((?:[2-9A-HJ-NP-Z]{8}|[2-9A-HJ-NP-Z]{12}))$/i,
  );
  return match?.[1]?.toUpperCase() ?? null;
}

function isGroupJoinRequest(message: string): boolean {
  return /^(?:\/eliza_join(?:@[a-z0-9_]{5,32})?|eliza\s+join)$/i.test(message);
}

function isGroupConsentStatusCommand(message: string): boolean {
  return /^(?:\/eliza_consent_status(?:@[a-z0-9_]{5,32})?|eliza\s+consent\s+status)$/i.test(
    message,
  );
}

function groupPolicyCommand(
  message: string,
): "mention_only" | "ambient" | null {
  const match = message.match(
    /^(?:\/eliza_ambient(?:@[a-z0-9_]{5,32})?|eliza\s+ambient)\s+(on|off)$/i,
  );
  if (!match) return null;
  return match[1].toLowerCase() === "on" ? "ambient" : "mention_only";
}

function isGroupLeaveCommand(message: string): boolean {
  return /^(?:\/eliza_leave(?:@[a-z0-9_]{5,32})?|eliza\s+leave)$/i.test(
    message,
  );
}

interface GroupClaimRequest {
  consentMode: "single_owner" | "all_adults";
  requiredPrincipalCount: number;
}

function groupClaimRequest(message: string): GroupClaimRequest | null {
  if (/^(?:\/group(?:@[a-z0-9_]{5,32})?|eliza\s+group)$/i.test(message)) {
    return { consentMode: "single_owner", requiredPrincipalCount: 1 };
  }
  const match = message.match(
    /^(?:\/group(?:@[a-z0-9_]{5,32})?\s+all-adults|eliza\s+group\s+all\s+adults)(?:\s+([0-9]{1,2}))?$/i,
  );
  if (!match) return null;
  const requiredPrincipalCount = match[1] ? Number(match[1]) : 2;
  if (
    !Number.isInteger(requiredPrincipalCount) ||
    requiredPrincipalCount < 2 ||
    requiredPrincipalCount > 32
  ) {
    return null;
  }
  return { consentMode: "all_adults", requiredPrincipalCount };
}

function isInvalidAllAdultsGroupClaimRequest(message: string): boolean {
  return /^(?:\/group(?:@[a-z0-9_]{5,32})?\s+all-adults|eliza\s+group\s+all\s+adults)\s+\d+$/i.test(
    message,
  );
}

function createGroupCode(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(
    bytes,
    (byte) => GROUP_CODE_ALPHABET[byte % GROUP_CODE_ALPHABET.length],
  ).join("");
}

function createGroupClaimCode(): string {
  return createGroupCode(GROUP_CLAIM_CODE_LENGTH);
}

function personalSharedJoinCodeSecret(env: AppEnv["Bindings"]): string | null {
  const secret = env.ELIZA_APP_PERSONAL_SHARED_JOIN_CODE_SECRET;
  return typeof secret === "string" &&
    new TextEncoder().encode(secret).byteLength >= 32
    ? secret
    : null;
}

async function deriveGroupJoinCode(
  secret: string,
  stage: "authenticate" | "confirm",
  source: readonly string[],
  avoid?: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const canonical = JSON.stringify([
    "personal-shared-group-join/v1",
    stage,
    ...source,
    avoid === undefined ? 0 : 1,
  ]);
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)),
  );
  const code = Array.from(
    digest.subarray(0, GROUP_JOIN_CODE_LENGTH),
    (byte) => GROUP_CODE_ALPHABET[byte & 31],
  ).join("");
  return code === avoid
    ? deriveGroupJoinCode(secret, stage, [...source, "collision"], avoid)
    : code;
}

function groupConsentSummary(status: PersonalSharedGroupConsentStatus): string {
  if (status.gate === "enabled") {
    return `Consent is enabled: ${status.consentedParticipantCount} of ${status.requiredPrincipalCount} required participants have independently linked and consented.`;
  }
  return `Consent is restricted: ${status.consentedParticipantCount} of ${status.requiredPrincipalCount} required participants have independently linked and consented.`;
}

function groupJoinFailureReply(
  status:
    | "invalid"
    | "expired"
    | "already_used"
    | "wrong_sender"
    | "wrong_scope"
    | "stale"
    | "actor_not_registered"
    | "account_not_authenticated"
    | "already_linked",
): string {
  switch (status) {
    case "expired":
      return "That join code expired. In the original group, have the same participant say `Eliza join` for a fresh code.";
    case "already_used":
      return "That join code was already used. In the original group, say `Eliza join` to restart the consent flow.";
    case "wrong_sender":
      return "That join code belongs to a different participant. The exact participant who requested it must use the code from their own direct chat with Eliza.";
    case "wrong_scope":
      return "That join code was used in the wrong chat. Authenticate codes belong in the requesting participant's direct chat with Eliza; confirm codes belong in the original group.";
    case "stale":
      return "This group's consent state changed before that join completed. In the original group, say `Eliza join` to restart.";
    case "actor_not_registered":
      return "Eliza has not registered this participant in the group yet. In the original group, have that participant say `Eliza join`.";
    case "account_not_authenticated":
      return "This direct chat is not connected to a mature, independently authenticated Eliza account. Sign in to that account first, then restart with `Eliza join` in the original group.";
    case "already_linked":
      return "This participant is already linked to the group. Say `Eliza consent status` in the group for the redacted status.";
    default:
      return "That join code is invalid. In the original group, have the same participant say `Eliza join` for a fresh code.";
  }
}

function decodeTelegramVoiceNote(
  input: z.infer<typeof telegramVoiceNoteSchema>,
): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.bytesBase64)) {
    throw new Error("Telegram voice note is not canonical base64");
  }
  const bytes = Buffer.from(input.bytesBase64, "base64");
  if (
    bytes.byteLength !== input.sizeBytes ||
    bytes.byteLength > MAX_TELEGRAM_VOICE_BYTES ||
    bytes.toString("base64") !== input.bytesBase64
  ) {
    throw new Error("Telegram voice note byte length is invalid");
  }
  if (bytes.subarray(0, 4).toString("ascii") !== "OggS") {
    throw new Error("Telegram voice note is not an Ogg stream");
  }
  return bytes;
}

async function transcribeTelegramVoiceNote(
  env: AppEnv["Bindings"],
  bytes: Uint8Array,
  filename: string,
): Promise<string> {
  const whisperBaseUrl = env.WHISPER_STT_URL?.trim();
  if (!whisperBaseUrl) {
    throw new Error("Telegram voice transcription is not configured");
  }
  const audio = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(audio).set(bytes);
  const form = new FormData();
  form.append("file", new File([audio], filename, { type: "audio/ogg" }));
  form.append("model", env.WHISPER_STT_MODEL?.trim() || DEFAULT_WHISPER_MODEL);
  const response = await fetch(
    `${whisperBaseUrl.replace(/\/+$/, "")}/v1/audio/transcriptions`,
    {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Telegram voice transcription failed (${response.status})`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    // error-policy:J3 the transcription provider response is untrusted input.
    throw new Error("Telegram voice transcription returned invalid JSON", {
      cause: error,
    });
  }
  const transcript =
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof (payload as Record<string, unknown>).text === "string"
      ? ((payload as Record<string, unknown>).text as string).trim()
      : "";
  if (!transcript) {
    throw new Error("Telegram voice transcription returned no speech");
  }
  return transcript;
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  let stage: DeliveryStage = "authentication";
  try {
    const auth =
      consumePreverifiedPersonalSharedRequest(c.req.raw) ??
      (await requireInternalAuth(c));
    if (auth instanceof Response) return auth;
    if (
      auth.service !== "webhook-gateway" &&
      auth.service !== "discord-gateway" &&
      auth.service !== "shared-secret"
    ) {
      return jsonError(c, 403, "Forbidden", "access_denied");
    }

    stage = "validation";
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      // error-policy:J3 malformed provider input is explicitly invalid.
      return jsonError(
        c,
        400,
        "Invalid messaging delivery",
        "validation_error",
      );
    }
    const parsed = sharedMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonError(
        c,
        400,
        "Invalid messaging delivery",
        "validation_error",
      );
    }
    if ("eventType" in parsed.data) {
      if (parsed.data.eventType === "membership") {
        const binding =
          await personalSharedGroupsRepository.applyMembershipChange({
            platform: "telegram",
            project: parsed.data.project,
            connectorAccountId: parsed.data.connectorAccountId,
            providerChatId: parsed.data.chatId,
            membershipChange: parsed.data.membershipChange,
          });
        return c.json({
          success: true,
          data: {
            code: binding
              ? `group_membership_${parsed.data.membershipChange}`
              : "group_membership_unchanged",
            reply: "",
          },
        });
      }
      if (parsed.data.eventType === "delivery_authorization") {
        const lease = await personalSharedGroupsRepository.authorizeDelivery({
          platform: parsed.data.platform,
          project: parsed.data.project,
          connectorAccountId: parsed.data.connectorAccountId,
          providerChatId: parsed.data.chatId,
          sourceMessageId: parsed.data.sourceMessageId,
          leaseToken: parsed.data.leaseToken,
          invocation: parsed.data.invocation,
          authority: parsed.data.authority,
        });
        return c.json({
          success: true,
          data: { code: "group_delivery_authorization", ...lease },
        });
      }
      if (parsed.data.eventType === "delivery_commit") {
        const committed = await personalSharedGroupsRepository.commitDelivery({
          platform: parsed.data.platform,
          project: parsed.data.project,
          connectorAccountId: parsed.data.connectorAccountId,
          providerChatId: parsed.data.chatId,
          sourceMessageId: parsed.data.sourceMessageId,
          authority: parsed.data.authority,
          leaseToken: parsed.data.leaseToken,
        });
        return c.json({
          success: true,
          data: { code: "group_delivery_committed", committed },
        });
      }
      const receipt =
        await personalSharedGroupsRepository.recordDeliveryReceipts({
          platform: parsed.data.platform,
          project: parsed.data.project,
          connectorAccountId: parsed.data.connectorAccountId,
          providerChatId: parsed.data.chatId,
          sourceMessageId: parsed.data.sourceMessageId,
          providerMessageIds: parsed.data.providerMessageIds,
          authority: parsed.data.authority,
          leaseToken: parsed.data.leaseToken,
        });
      return c.json({
        success: true,
        data: { code: "group_delivery_receipt_recorded", ...receipt },
      });
    }
    let telegramVoiceBytes: Uint8Array | undefined;
    if (
      parsed.data.platform === "telegram" &&
      !isGroupMessage(parsed.data) &&
      parsed.data.voiceNote
    ) {
      try {
        telegramVoiceBytes = decodeTelegramVoiceNote(parsed.data.voiceNote);
      } catch {
        // error-policy:J3 decoded media bytes are untrusted transport input.
        return jsonError(
          c,
          400,
          "Invalid Telegram voice note",
          "validation_error",
        );
      }
    }

    stage = "worker_context";
    const worker = resolveSharedRuntimeWorkerRequestContext(c);
    if ("error" in worker) {
      return c.json(
        {
          success: false,
          error: worker.error,
          code: worker.code,
          retryable: worker.retryable,
        },
        worker.status,
        { "Retry-After": "1" },
      );
    }

    stage = "account_resolution";
    const accountStartedAt = performance.now();
    let account: { userId: string; organizationId: string };
    let accountResolution = "phone-query";
    let groupConversationId: string | undefined;
    let groupActorLabel: string | undefined;
    let groupParticipantRoster: GroupParticipantIdentity[] | undefined;
    let groupPersonalAgentId: string | undefined;
    let groupDeliveryAuthority: GroupDeliveryAuthority | undefined;
    let groupTrustedDelivery: SharedGroupReminderDelivery | undefined;
    let dedicated:
      | Pick<AgentSandbox, "id" | "status" | "bridge_url" | "agent_config">
      | null
      | undefined;
    let isNewPersonalAccount = false;
    if (isGroupMessage(parsed.data)) {
      // In all-adults mode a join confirmation must be consumed before the
      // owner-link parser. Single-owner groups retain their existing handling
      // for the same ordinary text shape.
      const joinConfirmCode = groupJoinCodeCommand(parsed.data.message);
      if (joinConfirmCode) {
        const binding = await personalSharedGroupsRepository.resolveBinding({
          platform: parsed.data.platform,
          project: parsed.data.project,
          connectorAccountId: parsed.data.connectorAccountId,
          providerChatId: parsed.data.chatId,
        });
        if (binding?.consent_mode === "all_adults") {
          if (binding.state !== "active") {
            return c.json({
              success: true,
              data: {
                code: "group_binding_suspended",
                reply:
                  "This group link is inactive. The owner can DM Eliza `/group` to reconnect it.",
                groupDelivery: GROUP_CONTROL_DELIVERY,
              },
            });
          }
          await personalSharedGroupParticipantsRepository.recordTurn({
            bindingId: binding.id,
            platformUserId: parsed.data.actor.platformUserId,
            displayName: parsed.data.actor.displayName,
          });
          stage = "consent";
          const joined =
            await personalSharedGroupConsentRepository.consumeJoinConfirmChallenge(
              {
                codeHash: await sha256Hex(joinConfirmCode),
                sourceMessageId: parsed.data.messageId,
                bindingId: binding.id,
                platform: parsed.data.platform,
                project: parsed.data.project,
                connectorAccountId: parsed.data.connectorAccountId,
                providerChatId: parsed.data.chatId,
                providerThreadId: providerThreadIdForGroup(parsed.data),
                actorPlatformUserId: parsed.data.actor.platformUserId,
              },
            );
          if (joined.status !== "consented") {
            const consentStatus =
              await personalSharedGroupConsentRepository.deriveConsentStatus({
                bindingId: binding.id,
              });
            return c.json({
              success: true,
              data: {
                code: `group_join_${joined.status}`,
                reply: `${groupJoinFailureReply(joined.status)} ${GROUP_RELAY_DISCLOSURE}`,
                ...(consentStatus ? { consentStatus } : {}),
                groupDelivery: groupBindingDelivery(binding, "control"),
              },
            });
          }
          const currentBinding =
            await personalSharedGroupsRepository.resolveBinding({
              platform: parsed.data.platform,
              project: parsed.data.project,
              connectorAccountId: parsed.data.connectorAccountId,
              providerChatId: parsed.data.chatId,
            });
          return c.json({
            success: true,
            data: {
              code: "group_join_consented",
              reply: `${groupConsentSummary(joined.consent)} ${GROUP_RELAY_DISCLOSURE}`,
              consentStatus: joined.consent,
              groupDelivery:
                currentBinding?.state === "active"
                  ? groupBindingDelivery(currentBinding, "control")
                  : GROUP_CONTROL_DELIVERY,
            },
          });
        }
      }

      const claimCode = groupClaimCommand(parsed.data.message);
      if (claimCode) {
        if (
          parsed.data.platform === "telegram" &&
          parsed.data.actor.role !== "creator" &&
          parsed.data.actor.role !== "administrator"
        ) {
          return c.json({
            success: true,
            data: {
              code: "group_admin_required",
              reply:
                "Only a Telegram group creator or administrator can link Eliza. Make Eliza an admin, then have the same owner retry the link command.",
              groupDelivery: GROUP_CONTROL_DELIVERY,
            },
          });
        }
        let claimed: Awaited<
          ReturnType<typeof personalSharedGroupsRepository.consumeClaimAndBind>
        >;
        try {
          claimed = await personalSharedGroupsRepository.consumeClaimAndBind({
            codeHash: await sha256Hex(claimCode),
            platform: parsed.data.platform,
            project: parsed.data.project,
            connectorAccountId: parsed.data.connectorAccountId,
            providerChatId: parsed.data.chatId,
            actorPlatformUserId: parsed.data.actor.platformUserId,
          });
        } catch (error) {
          if (!isIndependentGroupOwnerAuthenticationError(error)) throw error;
          return c.json({
            success: true,
            data: {
              code: "group_claim_authentication_required",
              reply:
                "All-adults groups require the owner to finish signing in to their own Eliza account, then retry this exact unexpired link command.",
              groupDelivery: GROUP_CONTROL_DELIVERY,
            },
          });
        }
        if (claimed.status !== "bound") {
          return c.json({
            success: true,
            data: {
              code: `group_claim_${claimed.status}`,
              reply:
                claimed.status === "expired"
                  ? "That group link expired. DM Eliza `/group` for a fresh code, then paste the new link command here."
                  : claimed.status === "already_used"
                    ? "That group link was already used. DM Eliza `/group` for a new one if you are reconnecting."
                    : claimed.status === "already_bound"
                      ? "This group is already linked to another Eliza owner. That owner must disconnect it before a different owner can link it."
                      : "That group link is not valid for this account or sender. DM Eliza `/group` yourself and paste the exact command here.",
              groupDelivery: GROUP_CONTROL_DELIVERY,
            },
          });
        }
        if (claimed.binding.consent_mode === "all_adults") {
          stage = "consent";
          const consentStatus =
            await personalSharedGroupConsentRepository.deriveConsentStatus({
              bindingId: claimed.binding.id,
            });
          return c.json({
            success: true,
            data: {
              code: "group_bound",
              identity: {
                id: claimed.binding.personal_agent_id,
                runtime: "shared" as const,
              },
              account: {
                userId: claimed.binding.owner_user_id,
                organizationId: claimed.binding.organization_id,
              },
              reply: `Eliza is linked to this group in all-adults consent mode. The configured ${claimed.binding.required_principal_count} adult principals must each say \`Eliza join\` here, authenticate from their own direct chat, then confirm here before Eliza capabilities are enabled. ${consentStatus ? groupConsentSummary(consentStatus) : "Consent remains restricted until the required participants join."} ${GROUP_RELAY_DISCLOSURE}`,
              ...(consentStatus ? { consentStatus } : {}),
              groupDelivery: groupBindingDelivery(claimed.binding, "control"),
            },
          });
        }
        return c.json({
          success: true,
          data: {
            code: "group_bound",
            identity: {
              id: claimed.binding.personal_agent_id,
              runtime: "shared" as const,
            },
            account: {
              userId: claimed.binding.owner_user_id,
              organizationId: claimed.binding.organization_id,
            },
            reply:
              "Eliza is linked to this group. I respond to explicit mentions, commands, and replies by default. The owner can say `Eliza ambient on`, `Eliza ambient off`, or `Eliza leave`.",
            groupDelivery: groupBindingDelivery(claimed.binding, "control"),
          },
        });
      }

      const binding = await personalSharedGroupsRepository.resolveBinding({
        platform: parsed.data.platform,
        project: parsed.data.project,
        connectorAccountId: parsed.data.connectorAccountId,
        providerChatId: parsed.data.chatId,
      });
      if (binding?.state !== "active") {
        return c.json({
          success: true,
          data: {
            code: binding ? "group_binding_suspended" : "group_not_bound",
            reply:
              parsed.data.invocation === "ambient"
                ? ""
                : binding
                  ? "This group link is inactive. The owner can DM Eliza `/group` to reconnect it."
                  : "This group is not linked yet. DM your Eliza `/group`, then paste the one-time link command here.",
            groupDelivery: GROUP_CONTROL_DELIVERY,
          },
        });
      }

      const isAllAdultsBinding = binding.consent_mode === "all_adults";
      const groupActor = parsed.data.actor;
      let recordedParticipants:
        | Awaited<
            ReturnType<
              typeof personalSharedGroupParticipantsRepository.recordTurn
            >
          >
        | undefined;
      const recordActor = async () => {
        recordedParticipants ??=
          await personalSharedGroupParticipantsRepository.recordTurn({
            bindingId: binding.id,
            platformUserId: groupActor.platformUserId,
            displayName: groupActor.displayName,
          });
        return recordedParticipants;
      };

      if (isAllAdultsBinding && isGroupJoinRequest(parsed.data.message)) {
        await recordActor();
        stage = "consent";
        const joinCodeSecret = personalSharedJoinCodeSecret(c.env);
        if (!joinCodeSecret) {
          return c.json({
            success: true,
            data: {
              code: "group_join_unavailable",
              reply:
                "Multi-principal group joining is temporarily unavailable. No join challenge was created.",
              groupDelivery: groupBindingDelivery(binding, "control"),
            },
          });
        }
        // A source webhook can be reopened after provider egress when only the
        // receipt response is lost. Deriving from a secret and the immutable
        // source scope makes that replay return the same high-entropy code,
        // while the database still stores only its hash.
        const authenticateCode = await deriveGroupJoinCode(
          joinCodeSecret,
          "authenticate",
          [
            parsed.data.platform,
            parsed.data.project,
            parsed.data.connectorAccountId,
            parsed.data.chatId,
            providerThreadIdForGroup(parsed.data) ?? "",
            parsed.data.actor.platformUserId,
            parsed.data.messageId,
          ],
        );
        const issued =
          await personalSharedGroupConsentRepository.issueJoinAuthenticateChallenge(
            {
              codeHash: await sha256Hex(authenticateCode),
              sourceMessageId: parsed.data.messageId,
              bindingId: binding.id,
              platform: parsed.data.platform,
              project: parsed.data.project,
              connectorAccountId: parsed.data.connectorAccountId,
              providerChatId: parsed.data.chatId,
              providerThreadId: providerThreadIdForGroup(parsed.data),
              actorPlatformUserId: parsed.data.actor.platformUserId,
              expiresAt: new Date(Date.now() + GROUP_JOIN_CHALLENGE_TTL_MS),
            },
          );
        const consentStatus =
          await personalSharedGroupConsentRepository.deriveConsentStatus({
            bindingId: binding.id,
          });
        if (issued.status !== "issued") {
          return c.json({
            success: true,
            data: {
              code: `group_join_${issued.status}`,
              reply: `${groupJoinFailureReply(issued.status)} ${GROUP_RELAY_DISCLOSURE}`,
              ...(consentStatus ? { consentStatus } : {}),
              groupDelivery: groupBindingDelivery(binding, "control"),
            },
          });
        }
        return c.json({
          success: true,
          data: {
            code: "group_join_authenticate_issued",
            reply: `For the exact participant who requested this join: open that participant's direct chat with Eliza and send \`Eliza join ${authenticateCode}\` within 10 minutes. Do not share the code. ${GROUP_RELAY_DISCLOSURE}`,
            ...(consentStatus ? { consentStatus } : {}),
            groupDelivery: groupBindingDelivery(binding, "control"),
          },
        });
      }

      if (
        isAllAdultsBinding &&
        isGroupConsentStatusCommand(parsed.data.message)
      ) {
        await recordActor();
        stage = "consent";
        const consentStatus =
          await personalSharedGroupConsentRepository.deriveConsentStatus({
            bindingId: binding.id,
          });
        return c.json({
          success: true,
          data: {
            code: "group_consent_status",
            reply: consentStatus
              ? groupConsentSummary(consentStatus)
              : "Consent status is temporarily unavailable, so this group remains restricted.",
            ...(consentStatus ? { consentStatus } : {}),
            groupDelivery: groupBindingDelivery(binding, "control"),
          },
        });
      }

      const requestedPolicy = groupPolicyCommand(parsed.data.message);
      const requestedLeave = isGroupLeaveCommand(parsed.data.message);
      const actorIsOwner =
        parsed.data.actor.platformUserId ===
        binding.created_by_platform_user_id;
      const ownerControl =
        requestedPolicy !== null ||
        (requestedLeave && (!isAllAdultsBinding || actorIsOwner));
      if (ownerControl && !actorIsOwner) {
        return c.json({
          success: true,
          data: {
            code: "group_owner_required",
            reply:
              "Only the owner who linked Eliza can change this group's response policy.",
            groupDelivery: groupBindingDelivery(binding, "control"),
          },
        });
      }

      if (requestedPolicy) {
        const updated = await personalSharedGroupsRepository.setResponsePolicy({
          bindingId: binding.id,
          ownerUserId: binding.owner_user_id,
          policy: requestedPolicy,
        });
        if (!updated) {
          return c.json({
            success: true,
            data: {
              code: "group_binding_changed",
              reply:
                "This group link changed before the policy update. Reconnect it and try again.",
              groupDelivery: GROUP_CONTROL_DELIVERY,
            },
          });
        }
        return c.json({
          success: true,
          data: {
            code: "group_policy_updated",
            reply:
              requestedPolicy === "ambient"
                ? "Ambient replies are on. I may respond without a mention when I have something useful to add. Say `Eliza ambient off` to return to mention-only."
                : "Mention-only is on. I will answer explicit mentions, commands, and replies to me.",
            groupDelivery: groupBindingDelivery(updated, "control"),
          },
        });
      }
      if (requestedLeave && actorIsOwner) {
        const revoked = await personalSharedGroupsRepository.revokeBinding({
          bindingId: binding.id,
          ownerUserId: binding.owner_user_id,
        });
        if (!revoked) {
          return c.json({
            success: true,
            data: {
              code: "group_binding_changed",
              reply: "This group link changed before it could be disconnected.",
              groupDelivery: GROUP_CONTROL_DELIVERY,
            },
          });
        }
        return c.json({
          success: true,
          data: {
            code: "group_binding_revoked",
            reply:
              "This group is disconnected from your Eliza. Remove the bot/account here, or DM Eliza `/group` later to reconnect.",
            groupDelivery: GROUP_CONTROL_DELIVERY,
          },
        });
      }
      if (requestedLeave && isAllAdultsBinding) {
        await recordActor();
        stage = "consent";
        const selfRevoked =
          await personalSharedGroupConsentRepository.selfRevoke({
            bindingId: binding.id,
            actorPlatformUserId: parsed.data.actor.platformUserId,
          });
        if (selfRevoked.status !== "revoked") {
          return c.json({
            success: true,
            data: {
              code: `group_participant_leave_${selfRevoked.status}`,
              reply:
                selfRevoked.status === "not_linked"
                  ? "This participant is not actively linked and consented, so there is nothing to revoke."
                  : selfRevoked.status === "owner_forbidden"
                    ? "The owner cannot self-revoke only their row. The owner may say `Eliza leave` to disconnect the whole group."
                    : "Eliza could not verify this participant's exact linked group identity, so no consent was revoked.",
              groupDelivery: groupBindingDelivery(binding, "control"),
            },
          });
        }
        const currentBinding =
          await personalSharedGroupsRepository.resolveBinding({
            platform: parsed.data.platform,
            project: parsed.data.project,
            connectorAccountId: parsed.data.connectorAccountId,
            providerChatId: parsed.data.chatId,
          });
        return c.json({
          success: true,
          data: {
            code: "group_participant_revoked",
            reply: `This participant's link and consent are revoked; the group binding remains owned and active. ${groupConsentSummary(selfRevoked.consent)}`,
            consentStatus: selfRevoked.consent,
            groupDelivery:
              currentBinding?.state === "active"
                ? groupBindingDelivery(currentBinding, "control")
                : GROUP_CONTROL_DELIVERY,
          },
        });
      }

      const verifiedInvocation =
        parsed.data.platform === "blooio" &&
        parsed.data.invocation === "reply" &&
        (!parsed.data.replyToMessageId ||
          !(await personalSharedGroupsRepository.hasDeliveryReceipt({
            bindingId: binding.id,
            providerMessageId: parsed.data.replyToMessageId,
          })))
          ? "ambient"
          : parsed.data.invocation;

      if (isAllAdultsBinding) {
        await recordActor();
        stage = "consent";
        const consentStatus =
          await personalSharedGroupConsentRepository.deriveConsentStatus({
            bindingId: binding.id,
          });
        if (
          consentStatus?.mode !== "all_adults" ||
          consentStatus.gate === "restricted"
        ) {
          if (verifiedInvocation === "ambient") {
            return c.json({
              success: true,
              data: {
                code: "group_silent",
                reply: "",
                ...(consentStatus ? { consentStatus } : {}),
              },
            });
          }
          return c.json({
            success: true,
            data: {
              code: "group_consent_restricted",
              reply: consentStatus
                ? `${groupConsentSummary(consentStatus)} Each participant who still needs to link should say \`Eliza join\` here. ${GROUP_RELAY_DISCLOSURE}`
                : `Consent status is unavailable, so Eliza capabilities remain restricted. Try \`Eliza consent status\` before continuing. ${GROUP_RELAY_DISCLOSURE}`,
              ...(consentStatus ? { consentStatus } : {}),
              groupDelivery: groupBindingDelivery(binding, "control"),
            },
          });
        }
      }

      if (
        binding.response_policy === "mention_only" &&
        verifiedInvocation === "ambient"
      ) {
        return c.json({
          success: true,
          data: { code: "group_silent", reply: "" },
        });
      }

      account = {
        userId: binding.owner_user_id,
        organizationId: binding.organization_id,
      };
      accountResolution = "group-binding";
      groupConversationId = binding.conversation_id;
      groupPersonalAgentId = binding.personal_agent_id;
      groupDeliveryAuthority = groupBindingDelivery(
        binding,
        "capability",
      ).authority;
      // Only the owner who linked Eliza may schedule proactive sends into the
      // group; other participants have no account or billing authority here.
      // The stored destination pins the binding generation of this turn so a
      // later rebind, revocation, or chat cutover fails the fire closed.
      if (
        parsed.data.actor.platformUserId === binding.created_by_platform_user_id
      ) {
        groupTrustedDelivery = {
          platform: parsed.data.platform,
          kind: "group",
          project: parsed.data.project,
          connectorAccountId: parsed.data.connectorAccountId,
          chatId: parsed.data.chatId,
          ...(parsed.data.platform === "telegram" &&
          parsed.data.providerThreadId
            ? { providerThreadId: parsed.data.providerThreadId }
            : {}),
          ownerLabel:
            parsed.data.actor.displayName ?? GROUP_OWNER_FALLBACK_LABEL,
          authority: groupDeliveryAuthority,
        };
      }
      // The speaker's identity is registry-resolved, never taken from the
      // payload as-is. A connector that sends a name (Telegram, Discord) gets
      // that name once the registry has checked it cannot forge a label, an
      // owner destination, a handle, or another member's identity; a connector
      // that sends none (Blooio sends none at all) gets its stable ordinal.
      // Either way the label is enumerable, which is what lets
      // `guardGroupReply` redact a handle back to it.
      const participants = await recordActor();
      groupParticipantRoster = participants.roster;
      groupActorLabel = groupParticipantLabel(participants.actor);
    } else if (parsed.data.platform === "telegram") {
      const delivery = await resolvePersonalDeliveryProjection(
        c.env,
        {
          platform: "telegram",
          telegramId: parsed.data.telegramUserId,
          username: parsed.data.telegramUsername,
          displayName: parsed.data.displayName,
        },
        elizaAppUserService,
      );
      account = {
        userId: delivery.userId,
        organizationId: delivery.organizationId,
      };
      accountResolution = delivery.resolution;
      dedicated = delivery.dedicatedTarget;
      isNewPersonalAccount = delivery.isNew;
    } else if (parsed.data.platform === "discord") {
      const delivery = await resolvePersonalDeliveryProjection(
        c.env,
        {
          platform: "discord",
          discordId: parsed.data.discordUserId,
          username: parsed.data.discordUsername,
          globalName: parsed.data.displayName,
          avatarUrl: parsed.data.avatarUrl,
        },
        elizaAppUserService,
      );
      account = {
        userId: delivery.userId,
        organizationId: delivery.organizationId,
      };
      accountResolution = delivery.resolution;
      dedicated = delivery.dedicatedTarget;
      isNewPersonalAccount = delivery.isNew;
    } else {
      const delivery = await resolvePersonalDeliveryProjection(
        c.env,
        {
          platform: "phone",
          phoneNumber: parsed.data.phoneNumber,
        },
        elizaAppUserService,
      );
      account = {
        userId: delivery.userId,
        organizationId: delivery.organizationId,
      };
      accountResolution = delivery.resolution;
      dedicated = delivery.dedicatedTarget;
      isNewPersonalAccount = delivery.isNew;
    }
    const agent = personalSharedAgent({
      userId: account.userId,
      organizationId: account.organizationId,
    });
    if (groupConversationId && !groupConversationId.startsWith("group:")) {
      throw new Error("Invalid Personal Shared group conversation authority");
    }
    if (groupConversationId && groupPersonalAgentId !== agent.id) {
      throw new Error(
        "Personal Shared group binding does not match its canonical owner",
      );
    }

    const directJoinCode =
      !isGroupMessage(parsed.data) &&
      (parsed.data.platform === "telegram" || parsed.data.platform === "blooio")
        ? groupJoinCodeCommand(parsed.data.message ?? "")
        : null;
    if (
      directJoinCode &&
      !isGroupMessage(parsed.data) &&
      (parsed.data.platform === "telegram" || parsed.data.platform === "blooio")
    ) {
      const joinCodeSecret = personalSharedJoinCodeSecret(c.env);
      if (!joinCodeSecret) {
        return c.json({
          success: true,
          data: {
            code: "group_join_unavailable",
            reply:
              "Multi-principal group joining is temporarily unavailable. The existing group remains restricted.",
          },
        });
      }
      const directActorPlatformUserId =
        parsed.data.platform === "telegram"
          ? parsed.data.telegramUserId
          : parsed.data.phoneNumber;
      const confirmCode = await deriveGroupJoinCode(
        joinCodeSecret,
        "confirm",
        [
          parsed.data.platform,
          parsed.data.project,
          parsed.data.connectorAccountId,
          directActorPlatformUserId,
          parsed.data.messageId,
          directJoinCode,
        ],
        directJoinCode,
      );
      stage = "consent";
      const authenticated =
        await personalSharedGroupConsentRepository.consumeJoinAuthenticateChallenge(
          {
            codeHash: await sha256Hex(directJoinCode),
            confirmCodeHash: await sha256Hex(confirmCode),
            sourceMessageId: parsed.data.messageId,
            platform: parsed.data.platform,
            project: parsed.data.project,
            connectorAccountId: parsed.data.connectorAccountId,
            actorPlatformUserId: directActorPlatformUserId,
            linkedUserId: account.userId,
            linkedOrganizationId: account.organizationId,
            expiresAt: new Date(Date.now() + GROUP_JOIN_CHALLENGE_TTL_MS),
          },
        );
      if (authenticated.status !== "confirm_issued") {
        return c.json({
          success: true,
          data: {
            code: `group_join_authenticate_${authenticated.status}`,
            reply: `${groupJoinFailureReply(authenticated.status)} ${GROUP_RELAY_DISCLOSURE}`,
          },
        });
      }
      const consentStatus =
        await personalSharedGroupConsentRepository.deriveConsentStatus({
          bindingId: authenticated.bindingId,
        });
      return c.json({
        success: true,
        data: {
          code: "group_join_confirm_issued",
          reply: `Authentication succeeded. Return to the original group as this exact participant and send \`Eliza join ${confirmCode}\` within 10 minutes. Do not share the code. ${GROUP_RELAY_DISCLOSURE}`,
          ...(consentStatus ? { consentStatus } : {}),
        },
      });
    }

    const requestedGroupClaim =
      !isGroupMessage(parsed.data) &&
      (parsed.data.platform === "telegram" || parsed.data.platform === "blooio")
        ? groupClaimRequest(parsed.data.message ?? "")
        : null;
    if (
      requestedGroupClaim &&
      !isGroupMessage(parsed.data) &&
      (parsed.data.platform === "telegram" || parsed.data.platform === "blooio")
    ) {
      // Two-phase rollout fence: schema and every provider egress enforcer must
      // be deployed before any all-adults binding can be issued. Unset and all
      // non-exact values fail closed while single-owner behavior stays intact.
      if (
        requestedGroupClaim.consentMode === "all_adults" &&
        (c.env.ELIZA_APP_PERSONAL_SHARED_ALL_ADULTS_ENABLED !== "true" ||
          !personalSharedJoinCodeSecret(c.env))
      ) {
        return c.json({
          success: true,
          data: {
            code: "group_all_adults_unavailable",
            reply:
              "Multi-principal group consent is not enabled on this deployment yet. No group link was created.",
          },
        });
      }
      const code = createGroupClaimCode();
      try {
        await personalSharedGroupsRepository.issueClaim({
          codeHash: await sha256Hex(code),
          organizationId: account.organizationId,
          ownerUserId: account.userId,
          personalAgentId: agent.id,
          platform: parsed.data.platform,
          project: parsed.data.project,
          connectorAccountId: parsed.data.connectorAccountId,
          issuedToPlatformUserId:
            parsed.data.platform === "telegram"
              ? parsed.data.telegramUserId
              : parsed.data.phoneNumber,
          ...(requestedGroupClaim.consentMode === "all_adults"
            ? {
                consentMode: requestedGroupClaim.consentMode,
                requiredPrincipalCount:
                  requestedGroupClaim.requiredPrincipalCount,
              }
            : {}),
          expiresAt: new Date(Date.now() + GROUP_CLAIM_TTL_MS),
        });
      } catch (error) {
        if (!isIndependentGroupOwnerAuthenticationError(error)) throw error;
        return c.json({
          success: true,
          data: {
            code: "group_claim_authentication_required",
            reply:
              "All-adults groups require you to finish signing in to your own Eliza account, then retry this command.",
          },
        });
      }
      const linkCommand =
        parsed.data.platform === "telegram"
          ? `/eliza_link ${code}`
          : `Eliza link ${code}`;
      return c.json({
        success: true,
        data: {
          code: "group_claim_issued",
          identity: { id: agent.id, runtime: "shared" as const },
          account: {
            userId: account.userId,
            organizationId: account.organizationId,
          },
          reply:
            requestedGroupClaim.consentMode === "all_adults"
              ? `Add Eliza to the group, then send this there within 10 minutes:\n\n${linkCommand}\n\nUse the same ${parsed.data.platform === "telegram" ? "Telegram account" : "iMessage identity"} that requested this code. This starts all-adults consent for ${requestedGroupClaim.requiredPrincipalCount} independently authenticated participants; Eliza capabilities stay restricted until they join and consent. ${GROUP_RELAY_DISCLOSURE}`
              : `Add Eliza to the group, then send this there within 10 minutes:\n\n${linkCommand}\n\nUse the same ${parsed.data.platform === "telegram" ? "Telegram account" : "iMessage identity"} that requested this code.`,
        },
      });
    }
    if (
      !requestedGroupClaim &&
      !isGroupMessage(parsed.data) &&
      (parsed.data.platform === "telegram" ||
        parsed.data.platform === "blooio") &&
      isInvalidAllAdultsGroupClaimRequest(parsed.data.message ?? "")
    ) {
      return c.json({
        success: true,
        data: {
          code: "group_claim_invalid_principal_count",
          reply:
            "Choose an all-adults participant count from 2 through 32, for example `/group all-adults 2` or `Eliza group all adults 2`.",
        },
      });
    }
    if (dedicated === undefined) {
      dedicated = await findActivePersonalDedicatedTarget(
        account.organizationId,
        account.userId,
        agent.id,
      );
    }
    const accountMs = performance.now() - accountStartedAt;
    const accountTiming = `account;dur=${accountMs.toFixed(1)};desc="${accountResolution}"`;
    c.header("Server-Timing", accountTiming);
    const personalPrewarm = dedicated
      ? null
      : (() => {
          const startedAt = performance.now();
          const timing = prewarmPersonalSharedAgentTurnCaches(
            agent,
            worker.namespace,
            {
              warmConversation:
                isNewPersonalAccount || Boolean(groupConversationId),
              ...(groupConversationId
                ? { conversationId: groupConversationId }
                : {}),
            },
          ).then(() => performance.now() - startedAt);
          worker.executionCtx.waitUntil(timing);
          return timing;
        })();
    let deliveryMessage = parsed.data.message;
    // Public-data capability checks may inspect only authenticated user content,
    // never the actor labels, media descriptions, or other server context that
    // this route appends to the model-facing delivery message below.
    let capabilityText =
      (parsed.data.platform === "blooio" ||
        parsed.data.platform === "twilio") &&
      GENERATED_MEDIA_ONLY_MESSAGE.test(parsed.data.message)
        ? undefined
        : parsed.data.message;
    if (
      parsed.data.platform === "telegram" &&
      !isGroupMessage(parsed.data) &&
      parsed.data.voiceNote &&
      telegramVoiceBytes
    ) {
      stage = "voice_transcription";
      // Shared has no authenticated writer into the agent-owned canonical
      // `/api/media/<sha>.<ext>` store. Keep only the transcript in durable
      // conversation history; do not create a parallel R2 media namespace.
      const transcript = await transcribeTelegramVoiceNote(
        c.env,
        telegramVoiceBytes,
        parsed.data.voiceNote.filename,
      );
      deliveryMessage = parsed.data.message
        ? `${parsed.data.message}\n\n[Voice note transcript]\n${transcript}`
        : transcript;
      capabilityText = parsed.data.message
        ? `${parsed.data.message}\n${transcript}`
        : transcript;
      logger.info(
        "[personal-shared-messaging] Telegram voice note transcribed",
        {
          durationSeconds: parsed.data.voiceNote.durationSeconds,
          sizeBytes: parsed.data.voiceNote.sizeBytes,
          userId: account.userId,
        },
      );
    }
    // A dedicated runtime describes images itself through its own metered
    // IMAGE_DESCRIPTION model, so pooled-key vision runs only for turns the
    // shared runtime (text-only) will answer.
    if (
      parsed.data.platform === "blooio" &&
      parsed.data.mediaUrls &&
      !dedicated
    ) {
      stage = "media_description";
      // Pooled-key spend is reachable by any inbound sender, so it sits behind
      // the durable admission ledger: one idempotency claim per connector
      // message id (a redelivery reuses the stored description instead of
      // re-spending) and atomic per-sender/per-connector daily image
      // ceilings. Every skip, including a missing admission decision, keeps
      // the raw media-URL text the adapter synthesized; only an untyped bug
      // fails the delivery.
      const enrichment = await enrichInboundImageMedia({
        env: c.env,
        platform: "blooio",
        project: parsed.data.project,
        connectorAccountId: parsed.data.connectorAccountId,
        sourceMessageId: parsed.data.messageId,
        organizationId: account.organizationId,
        userId: account.userId,
        mediaUrls: parsed.data.mediaUrls,
        executionCtx: worker.executionCtx,
      });
      if (enrichment.kind === "described") {
        deliveryMessage = `${deliveryMessage}\n\n[Attached image description]\n${enrichment.description}\n\n[Attached image URL]\n${parsed.data.mediaUrls.join("\n")}`;
      }
    }
    if (deliveryMessage && groupActorLabel) {
      deliveryMessage = `${groupActorLabel}: ${deliveryMessage}`;
    }
    if (!deliveryMessage) {
      return jsonError(
        c,
        400,
        "Messaging delivery has no content",
        "validation_error",
      );
    }
    if (
      parsed.data.platform === "telegram" &&
      !isGroupMessage(parsed.data) &&
      /^\/connect(?:@[a-z0-9_]{5,32})?$/i.test(deliveryMessage)
    ) {
      stage = "account_claim";
      // A new command gets independent expiry while a webhook retry reaches
      // the same session. Reusing the sender's permanent session would make
      // refreshing one claim link revive every expired link for that sender.
      const claimSessionId = `platform:telegram-claim:${await sha256Hex(
        `${parsed.data.telegramUserId}\n${parsed.data.messageId}`,
      )}`;
      const claim = await runOnboardingChat({
        sessionId: claimSessionId,
        platform: "telegram",
        platformUserId: parsed.data.telegramUserId,
        platformDisplayName:
          parsed.data.displayName ??
          parsed.data.telegramUsername ??
          parsed.data.telegramUserId,
        authenticatedUser: {
          userId: account.userId,
          organizationId: account.organizationId,
          telegramId: parsed.data.telegramUserId,
        },
        trustedPlatformIdentity: true,
        statusOnly: true,
        idempotencyKey: `telegram-account-claim:${parsed.data.messageId}`,
      });
      const loginUrl = new URL(claim.loginUrl);
      loginUrl.searchParams.set("accountClaim", "telegram");
      return c.json({
        success: true,
        data: {
          identity: { id: agent.id, runtime: "shared" as const },
          account: {
            userId: account.userId,
            organizationId: account.organizationId,
          },
          reply: `Sign in to connect this Telegram chat to your Eliza account: ${loginUrl.toString()}`,
        },
      });
    }
    if (dedicated) {
      stage = "dedicated_runtime";
      const dedicatedStartedAt = performance.now();
      const preparation = await preparePersonalDedicatedDelivery(dedicated);
      if (preparation.state === "unavailable") {
        return c.json(
          {
            success: false,
            code: preparation.code,
            error: preparation.error,
            retryable: preparation.retryable,
          },
          preparation.status,
          preparation.retryAfterSeconds
            ? { "Retry-After": String(preparation.retryAfterSeconds) }
            : undefined,
        );
      }
      const bridgeRequest = {
        jsonrpc: "2.0" as const,
        id: parsed.data.messageId,
        method: "message.send",
        params: {
          text: deliveryMessage,
          roomId: groupConversationId ?? agent.id,
          conversationId: groupConversationId ?? agent.id,
          canonicalBridgeBase: dedicated.bridge_url,
          userId: account.userId,
          clientMessageId: parsed.data.messageId,
          platformName: parsed.data.platform,
          source: parsed.data.platform,
          ...(isGroupMessage(parsed.data)
            ? { senderName: groupActorLabel }
            : parsed.data.platform === "telegram" ||
                parsed.data.platform === "discord"
              ? {
                  senderName:
                    parsed.data.displayName ??
                    (parsed.data.platform === "telegram"
                      ? parsed.data.telegramUsername
                      : parsed.data.discordUsername),
                }
              : {}),
        },
      };
      let response = await elizaSandboxService.bridge(
        dedicated.id,
        account.organizationId,
        bridgeRequest,
      );
      if (response.error?.message === "Bridge returned HTTP 404") {
        const conversationId = groupConversationId ?? agent.id;
        const history = await coordinateSharedHistory(
          agent.id,
          conversationId,
          {
            namespace: worker.namespace,
          },
        );
        const importableHistory = history.filter(
          (
            message,
          ): message is typeof message & {
            role: "user" | "assistant";
          } => message.role === "user" || message.role === "assistant",
        );
        const importMessages = importableHistory.flatMap((message) =>
          message.id
            ? [
                {
                  sourceId: message.id,
                  role: message.role,
                  text: message.content,
                  ...(typeof message.createdAt === "number"
                    ? { timestamp: message.createdAt }
                    : {}),
                },
              ]
            : [],
        );
        let receipt =
          importMessages.length === importableHistory.length
            ? await elizaSandboxService.importCanonicalConversation(
                dedicated.id,
                account.organizationId,
                conversationId,
                importMessages,
              )
            : null;
        if (!receipt && importMessages.length > 0) {
          receipt = await elizaSandboxService.importCanonicalConversation(
            dedicated.id,
            account.organizationId,
            conversationId,
            [],
          );
        }
        if (receipt) {
          response = await elizaSandboxService.bridge(
            dedicated.id,
            account.organizationId,
            bridgeRequest,
          );
        }
      }
      if (response.error) {
        return jsonError(
          c,
          503,
          "Dedicated Eliza is temporarily unavailable.",
          "service_unavailable",
        );
      }
      const result = response.result as { text?: unknown } | undefined;
      if (typeof result?.text !== "string") {
        return jsonError(
          c,
          503,
          "Dedicated Eliza returned an invalid reply.",
          "service_unavailable",
        );
      }
      c.header(
        "Server-Timing",
        `${accountTiming}, dedicated;dur=${(
          performance.now() - dedicatedStartedAt
        ).toFixed(1)}`,
      );
      return c.json({
        success: true,
        data: {
          identity: {
            id: agent.id,
            runtime: "dedicated" as const,
            activeAgentId: dedicated.id,
          },
          account: {
            userId: account.userId,
            organizationId: account.organizationId,
          },
          reply: guardGroupReply(result.text, groupParticipantRoster),
          ...(groupDeliveryAuthority
            ? {
                groupDelivery: {
                  kind: "binding" as const,
                  authority: groupDeliveryAuthority,
                },
              }
            : {}),
        },
      });
    }
    stage = "shared_runtime";
    if (!personalPrewarm) {
      throw new Error("Shared turn reached inference with a Dedicated target");
    }
    const prewarmMs = await personalPrewarm;
    const sharedStartedAt = performance.now();
    const trustedDelivery = isGroupMessage(parsed.data)
      ? undefined
      : parsed.data.platform === "telegram"
        ? {
            platform: "telegram" as const,
            project: parsed.data.project,
            connectorAccountId: parsed.data.connectorAccountId,
            chatId: parsed.data.chatId,
          }
        : parsed.data.platform === "blooio"
          ? {
              platform: "blooio" as const,
              project: parsed.data.project,
              phoneNumber: parsed.data.phoneNumber,
            }
          : parsed.data.platform === "discord"
            ? {
                platform: "discord" as const,
                discordUserId: parsed.data.discordUserId,
              }
            : undefined;
    const result = groupConversationId
      ? await sharedRestMessageSend(
          agent,
          groupConversationId,
          deliveryMessage,
          agent.agent_name ?? "Eliza",
          worker.executionCtx,
          worker.namespace,
          parsed.data.messageId,
          "platform",
          groupTrustedDelivery,
          capabilityText,
          { type: ChannelType.GROUP, source: parsed.data.platform },
        )
      : await sharedRestMessageSend(
          agent,
          agent.id,
          deliveryMessage,
          agent.agent_name ?? "Eliza",
          worker.executionCtx,
          worker.namespace,
          parsed.data.messageId,
          "platform",
          trustedDelivery,
          capabilityText,
        );
    // The same values ship on `Server-Timing` below; a second uncorrelated
    // per-turn log on the hot path would only duplicate them.
    const providerTiming = sharedTurnServerTiming(result.timing);
    c.header(
      "Server-Timing",
      [
        accountTiming,
        `prewarm;dur=${prewarmMs.toFixed(1)}`,
        `shared;dur=${(performance.now() - sharedStartedAt).toFixed(1)}`,
        providerTiming,
      ]
        .filter(Boolean)
        .join(", "),
    );

    return c.json({
      success: true,
      data: {
        identity: { id: agent.id, runtime: "shared" as const },
        account: {
          userId: account.userId,
          organizationId: account.organizationId,
        },
        reply: guardGroupReply(result.text, groupParticipantRoster),
        ...(result.mediaUrls ? { mediaUrls: result.mediaUrls } : {}),
        ...(groupDeliveryAuthority
          ? {
              groupDelivery: {
                kind: "binding" as const,
                authority: groupDeliveryAuthority,
              },
            }
          : {}),
      },
    });
  } catch (error) {
    // error-policy:J1 the internal HTTP boundary emits one structured failure.
    const errorName = safeErrorName(error);
    const retryable = retryableDeliveryError(error);
    const failureCauseName =
      error instanceof SharedRuntimeTurnError ? error.failureName : null;
    const traceId = c.get("traceId") ?? resolveElizaTraceId(c.req.raw.headers);
    logger.error("[personal-shared-messaging] delivery failed", {
      traceId,
      stage,
      errorName,
      ...(failureCauseName ? { failureCauseName } : {}),
      retryable,
      ...(error instanceof PersonalDeliveryAccountResolutionError
        ? { projectionFailure: error.projectionFailure }
        : {}),
      ...(isGroupDeliveryPendingError(error)
        ? {
            deliveryState: "live_reservation_pending",
            operatorAction:
              "retry after the active uncommitted delivery lease expires",
          }
        : {}),
    });
    // This route is internal-authenticated. Safe classification headers let
    // the connector correlate a retry without exposing exception messages or
    // provider/SQL payloads in its logs.
    c.header(ELIZA_FAILURE_STAGE_HEADER, stage);
    c.header(ELIZA_FAILURE_NAME_HEADER, errorName);
    c.header(ELIZA_RETRYABLE_HEADER, retryable ? "true" : "false");
    if (failureCauseName) {
      c.header(ELIZA_FAILURE_CAUSE_NAME_HEADER, failureCauseName);
    }
    if (error instanceof PersonalDeliveryAccountResolutionError) {
      // Account resolution only fails here after both the projection and the
      // canonical resolver failed — a transient storage condition the
      // connector should retry, not an opaque terminal 500.
      return c.json(
        {
          success: false,
          error:
            "Account resolution is temporarily unavailable. Retry this turn shortly.",
          code: "service_unavailable",
          retryable: true,
        },
        503,
        { "Retry-After": "1" },
      );
    }
    if (error instanceof SharedRuntimeCacheWarmingError) {
      return c.json(
        {
          success: false,
          error: "Shared Eliza is warming. Retry this turn shortly.",
          code: "service_unavailable",
          retryable: true,
        },
        503,
        { "Retry-After": "1" },
      );
    }
    if (error instanceof SharedRuntimeTurnError && error.retryable) {
      return c.json(
        {
          success: false,
          error: "Shared Eliza is temporarily unavailable. Retry shortly.",
          code: "service_unavailable",
          retryable: true,
        },
        503,
        { "Retry-After": "1" },
      );
    }
    if (isGroupDeliveryPendingError(error)) {
      return c.json(
        {
          success: false,
          error:
            "A provider delivery reservation is still active. Group authority was not changed; retry shortly.",
          code: "group_delivery_pending",
          retryable: true,
        },
        409,
        { "Retry-After": "5" },
      );
    }
    return failureResponse(c, error);
  }
});

export default app;
