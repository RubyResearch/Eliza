/**
 * Shared voice contracts and voice-selection data consumed across runtime,
 * cloud, plugins, and UI surfaces.
 */

/**
 * Client-transport marker for turns owned by a realtime voice WebSocket
 * session. It travels in message metadata so normal client-chat role and
 * response policy remain unchanged while side effects can return through the
 * originating session.
 */
export const REALTIME_VOICE_CLIENT_TRANSPORT = "realtime_voice" as const;

import { parseViewInteractionClientId } from "./views/view-interact-protocol.js";

/** Renderer observations only; the runtime registry owns capabilities and authority. */
export interface VoiceUiContext {
  uiViewPath?: string;
  uiViewSubview?: string;
  uiTimeZone?: string;
  uiBrowserSurface?: "native";
  /** Same renderer routing ID used by its authenticated HTTP/WS client. */
  uiClientId?: string;
}

/** Small allowlist shared by the wire and loopback boundaries. */
export function parseVoiceUiContext(value: unknown): VoiceUiContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const result: VoiceUiContext = {};
  if (source.uiClientId !== undefined) {
    const clientId = parseViewInteractionClientId(source.uiClientId);
    if (!clientId) return null;
    result.uiClientId = clientId;
  }
  if (source.uiBrowserSurface !== undefined) {
    if (source.uiBrowserSurface !== "native") return null;
    result.uiBrowserSurface = "native";
  }
  for (const key of ["uiViewPath", "uiViewSubview", "uiTimeZone"] as const) {
    const field = source[key];
    if (field === undefined) continue;
    if (
      typeof field !== "string" ||
      field.length > (key === "uiViewPath" ? 2048 : 128)
    )
      return null;
    result[key] = field;
  }
  if (
    result.uiViewPath &&
    (!result.uiViewPath.startsWith("/") || result.uiViewPath.startsWith("//"))
  )
    return null;
  return result;
}

/**
 * Loopback-only identity fence stamped by the local voice bridge. The agent
 * host uses this pair to reject turns after an in-process runtime or
 * conversation replacement instead of delivering them to stale state.
 */
export const LOCAL_VOICE_RUNTIME_AGENT_HEADER =
  "X-Eliza-Local-Voice-Agent-Id" as const;
export const LOCAL_VOICE_RUNTIME_CONVERSATION_HEADER =
  "X-Eliza-Local-Voice-Conversation-Id" as const;

export interface VoicePreset {
  id: string;
  name: string;
  nameKey?: string;
  voiceId: string;
  gender: "female" | "male" | "character";
  hint: string;
  hintKey?: string;
  previewUrl: string;
}

/**
 * Sanitize API keys: mask strings that look like real keys, pass through
 * empty/redacted values.
 */
export function sanitizeApiKey(apiKey: string | undefined): string | undefined {
  if (!apiKey) return apiKey;
  if (apiKey === "[REDACTED]") return apiKey;
  // If the key is long enough to be real, mask the middle
  if (apiKey.length > 8) {
    return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
  }
  return apiKey;
}

/**
 * Treat only non-redacted, non-masked values as usable API keys. Persisted
 * redacted or masked values like "[REDACTED]" or "abcd...wxyz" are display-only.
 */
export function hasConfiguredApiKey(
  apiKey: string | null | undefined,
): boolean {
  const trimmed = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!trimmed) return false;
  if (
    trimmed === "REDACTED" ||
    trimmed === "[REDACTED]" ||
    /^\*+$/.test(trimmed)
  ) {
    return false;
  }
  if (/^.{4}\.\.\..{4}$/.test(trimmed)) {
    return false;
  }
  return true;
}

export const PREMADE_VOICES: VoicePreset[] = [
  // Female
  {
    id: "rachel",
    name: "Rachel",
    voiceId: "21m00Tcm4TlvDq8ikWAM",
    gender: "female",
    hint: "Calm, clear",
    hintKey: "voice.hint.calm_clear",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/21m00Tcm4TlvDq8ikWAM/df6788f9-5c96-470d-8312-aab3b3d8f50a.mp3",
  },
  {
    id: "sarah",
    name: "Sarah",
    voiceId: "EXAVITQu4vr4xnSDxMaL",
    gender: "female",
    hint: "Soft, warm",
    hintKey: "voice.hint.soft_warm",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/EXAVITQu4vr4xnSDxMaL/6851ec91-9950-471f-8586-357c52539069.mp3",
  },
  {
    id: "matilda",
    name: "Matilda",
    voiceId: "XrExE9yKIg1WjnnlVkGX",
    gender: "female",
    hint: "Warm, friendly",
    hintKey: "voice.hint.warm_friendly",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/XrExE9yKIg1WjnnlVkGX/b930e18d-6b4d-466e-bab2-0ae97c6d8535.mp3",
  },
  {
    id: "lily",
    name: "Lily",
    voiceId: "pFZP5JQG7iQjIQuC4Bku",
    gender: "female",
    hint: "British, raspy",
    hintKey: "voice.hint.british_raspy",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/pFZP5JQG7iQjIQuC4Bku/0ab8bd74-fcd2-489d-b70a-3e1bcde8c999.mp3",
  },
  {
    id: "alice",
    name: "Alice",
    voiceId: "Xb7hH8MSUJpSbSDYk0k2",
    gender: "female",
    hint: "British, confident",
    hintKey: "voice.hint.british_confident",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/Xb7hH8MSUJpSbSDYk0k2/f5409e2f-d9c3-4ac9-9e7d-916a5dbd1ef1.mp3",
  },
  // Male
  {
    id: "brian",
    name: "Brian",
    voiceId: "nPczCjzI2devNBz1zQrb",
    gender: "male",
    hint: "Deep, smooth",
    hintKey: "voice.hint.deep_smooth",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/nPczCjzI2devNBz1zQrb/f4dbda0c-aff0-45c0-93fa-f5d5ec95a2eb.mp3",
  },
  {
    id: "adam",
    name: "Adam",
    voiceId: "pNInz6obpgDQGcFmaJgB",
    gender: "male",
    hint: "Deep, authoritative",
    hintKey: "voice.hint.deep_authoritative",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/pNInz6obpgDQGcFmaJgB/38a69695-2ca9-4b9e-b9ec-f07ced494a58.mp3",
  },
  {
    id: "josh",
    name: "Josh",
    voiceId: "TxGEqnHWrfWFTfGW9XjX",
    gender: "male",
    hint: "Young, deep",
    hintKey: "voice.hint.young_deep",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/TxGEqnHWrfWFTfGW9XjX/3ae2fc71-d5f9-4769-bb71-2a43633cd186.mp3",
  },
  {
    id: "daniel",
    name: "Daniel",
    voiceId: "onwK4e9ZLuTAKqWW03F9",
    gender: "male",
    hint: "British, presenter",
    hintKey: "voice.hint.british_presenter",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/onwK4e9ZLuTAKqWW03F9/7eee0236-1a72-4b86-b303-5dcadc007ba9.mp3",
  },
  {
    id: "liam",
    name: "Liam",
    voiceId: "TX3LPaxmHKxFdv7VOQHJ",
    gender: "male",
    hint: "Young, natural",
    hintKey: "voice.hint.young_natural",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/TX3LPaxmHKxFdv7VOQHJ/63148076-6363-42db-aea8-31424308b92c.mp3",
  },
  // Character / Cutesy / Game
  {
    id: "gigi",
    name: "Gigi",
    voiceId: "jBpfuIE2acCO8z3wKNLl",
    gender: "character",
    hint: "Childish, cute",
    hintKey: "voice.hint.childish_cute",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/jBpfuIE2acCO8z3wKNLl/3a7e4339-78fa-404e-8d10-c3ef5587935b.mp3",
  },
  {
    id: "mimi",
    name: "Mimi",
    voiceId: "zrHiDhphv9ZnVXBqCLjz",
    gender: "character",
    hint: "Cute, animated",
    hintKey: "voice.hint.cute_animated",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/zrHiDhphv9ZnVXBqCLjz/decbf20b-0f57-4fac-985b-a4f0290ebfc4.mp3",
  },
  {
    id: "dorothy",
    name: "Dorothy",
    voiceId: "ThT5KcBeYPX3keUQqHPh",
    gender: "character",
    hint: "Sweet, storybook",
    hintKey: "voice.hint.sweet_storybook",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/ThT5KcBeYPX3keUQqHPh/981f0855-6598-48d2-9f8f-b6d92fbbe3fc.mp3",
  },
  {
    id: "glinda",
    name: "Glinda",
    voiceId: "z9fAnlkpzviPz146aGWa",
    gender: "character",
    hint: "Magical, whimsical",
    hintKey: "voice.hint.magical_whimsical",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/z9fAnlkpzviPz146aGWa/cbc60443-7b61-4ebb-b8e1-5c03237ea01d.mp3",
  },
  {
    id: "charlotte",
    name: "Charlotte",
    voiceId: "XB0fDUnXU5powFXDhCwa",
    gender: "character",
    hint: "Alluring, game NPC",
    hintKey: "voice.hint.alluring_game_npc",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/XB0fDUnXU5powFXDhCwa/942356dc-f10d-4d89-bda5-4f8505ee038b.mp3",
  },
  {
    id: "callum",
    name: "Callum",
    voiceId: "N2lVS1w4EtoT3dr4eOWO",
    gender: "character",
    hint: "Gruff, game hero",
    hintKey: "voice.hint.gruff_game_hero",
    previewUrl:
      "https://storage.googleapis.com/eleven-public-prod/premade/voices/N2lVS1w4EtoT3dr4eOWO/ac833bd8-ffda-4938-9ebc-b0f99ca25481.mp3",
  },
  // Custom Character Voices
  {
    id: "momo",
    name: "Momo",
    voiceId: "n7Wi4g1bhpw4Bs8HK5ph",
    gender: "female",
    hint: "Custom Voice",
    hintKey: "voice.hint.custom_voice",
    previewUrl: "",
  },
  {
    id: "yuki",
    name: "Yuki",
    voiceId: "4tRn1lSkEn13EVTuqb0g",
    gender: "female",
    hint: "Custom Voice",
    hintKey: "voice.hint.custom_voice",
    previewUrl: "",
  },
  {
    id: "rin",
    name: "Rin",
    voiceId: "cNYrMw9glwJZXR8RwbuR",
    gender: "female",
    hint: "Custom Voice",
    hintKey: "voice.hint.custom_voice",
    previewUrl: "",
  },
  {
    id: "kei",
    name: "Kei",
    voiceId: "eadgjmk4R4uojdsheG9t",
    gender: "male",
    hint: "Custom Voice",
    hintKey: "voice.hint.custom_voice",
    previewUrl: "",
  },
  {
    id: "jin",
    name: "Jin",
    voiceId: "6IwYbsNENZgAB1dtBZDp",
    gender: "male",
    hint: "Custom Voice",
    hintKey: "voice.hint.custom_voice",
    previewUrl: "",
  },
  {
    id: "satoshi",
    name: "Satoshi",
    voiceId: "7cOBG34AiHrAzs842Rdi",
    gender: "male",
    hint: "Custom Voice",
    hintKey: "voice.hint.custom_voice",
    previewUrl: "",
  },
  {
    id: "ryu",
    name: "Ryu",
    voiceId: "QzTKubutNn9TjrB7Xb2Q",
    gender: "male",
    hint: "Custom Voice",
    hintKey: "voice.hint.custom_voice",
    previewUrl: "",
  },
];

export const VOICE_PROVIDERS: Array<{
  id: "eliza-cloud" | "elevenlabs" | "edge" | "local-inference";
  label: string;
  labelKey: string;
  hint: string;
  hintKey: string;
  needsKey: boolean;
  requiresCloud?: boolean;
}> = [
  {
    id: "eliza-cloud",
    label: "Eliza Cloud",
    labelKey: "voice.provider.elizaCloud",
    hint: "Free Kokoro voice through Eliza Cloud",
    hintKey: "voice.provider.elizaCloud.hint",
    needsKey: false,
    requiresCloud: true,
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    labelKey: "provider.elevenlabs",
    hint: "High quality, realistic voices",
    hintKey: "voice.provider.elevenlabs.hint",
    needsKey: true,
  },
  {
    id: "local-inference",
    label: "Local inference",
    labelKey: "voice.provider.localInference",
    hint: "On-device Kokoro",
    hintKey: "voice.provider.localInference.hint",
    needsKey: false,
  },
  {
    id: "edge",
    label: "Microsoft Edge",
    labelKey: "voice.provider.edge",
    hint: "Free, Microsoft voices",
    hintKey: "voice.provider.edge.hint",
    needsKey: false,
  },
];

/**
 * ASR (automatic speech recognition) provider catalogue. Mirrors
 * `VOICE_PROVIDERS` so the settings UI can render a provider picker for
 * speech-to-text. The legacy whisper.cpp pipeline has been retired —
 * on-device transcription now runs through the local-inference ASR bundle.
 * Release catalog checks gate the bundle lineage before it can be selected.
 */
export const ASR_PROVIDERS: Array<{
  id: "local-inference" | "eliza-cloud" | "openai";
  label: string;
  labelKey: string;
  hint: string;
  hintKey: string;
  needsKey: boolean;
}> = [
  {
    id: "local-inference",
    label: "Local inference",
    labelKey: "asr.provider.localInference",
    hint: "On-device local ASR",
    hintKey: "asr.provider.localInference.hint",
    needsKey: false,
  },
  {
    id: "eliza-cloud",
    label: "Eliza Cloud",
    labelKey: "asr.provider.elizaCloud",
    hint: "Routed through your Eliza Cloud login",
    hintKey: "asr.provider.elizaCloud.hint",
    needsKey: false,
  },
  {
    id: "openai",
    label: "OpenAI",
    labelKey: "asr.provider.openai",
    hint: "Whisper hosted by OpenAI",
    hintKey: "asr.provider.openai.hint",
    needsKey: true,
  },
];

/**
 * Minimal backup voices for non-ElevenLabs providers (Edge TTS / OpenAI).
 * Only a male and female option — keeps the UI uncluttered when premium
 * voices aren't available.
 */
export const EDGE_BACKUP_VOICES: VoicePreset[] = [
  {
    id: "edge-female",
    name: "Female",
    nameKey: "voice.gender.female",
    voiceId: "en-US-AriaNeural",
    gender: "female",
    hint: "Clear, natural",
    hintKey: "voice.hint.clear_natural",
    previewUrl: "",
  },
  {
    id: "edge-male",
    name: "Male",
    nameKey: "voice.gender.male",
    voiceId: "en-US-GuyNeural",
    gender: "male",
    hint: "Deep, natural",
    hintKey: "voice.hint.deep_natural",
    previewUrl: "",
  },
];
