/**
 * Per-request fetch timeout budgets. Local on-device TTS/ASR on mobile CPU run
 * far past the generic 10s bridge timeout, so those paths get minutes-long
 * budgets to avoid aborting valid, in-progress responses.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
// Local neural TTS on mobile CPU is slower than ordinary JSON API calls. Pixel
// APK validation with the bundled Kokoro path produced normal chat clips in the
// 15-30 s range, so the generic 10 s bridge timeout aborts valid responses
// before the WAV is ready.
const LOCAL_INFERENCE_TTS_FETCH_TIMEOUT_MS = 3 * 60_000;
// Local ASR on mobile loads a dedicated ~1.4 GB multimodal model (text GGUF +
// audio mmproj) on first use, then runs the audio encoder + decode on CPU.
// On the Pixel 9a a cold transcribe (model fault-in + encode + decode) runs
// well past the generic 10 s bridge timeout, which would abort a transcription
// that is actually progressing and surface a spurious `local_agent_unavailable`.
// Match the TTS budget so a cold on-device transcribe can complete.
const LOCAL_INFERENCE_ASR_FETCH_TIMEOUT_MS = 3 * 60_000;
// First-turn inference on Capacitor mobile (Moto G Play 2024, Snapdragon
// 4 Gen 1, CPU-only) lands at ~240 s for a 256-token Llama-3.2-1B reply.
// The bun-side `ELIZA_CHAT_GENERATION_TIMEOUT_MS` is 600 s on that build
// (set by `ElizaAgentService.java`); a tighter client-side budget would
// abort the SSE stream while bun is still emitting tokens, the row would
// still land in the conversation DB, but the renderer would stay frozen
// on the typing indicator with no response visible. Match the bun ceiling
// so the two layers fail/succeed together.
const CHAT_MESSAGE_FETCH_TIMEOUT_MS = 10 * 60_000;
// Creating a conversation is a quick DB insert, but on the single-threaded
// on-device mobile agent it queues behind whatever synchronous FFI work is in
// flight (a cold ASR/TTS model load, an in-progress generation, or a 1.4 GB
// model teardown can block the event loop for several seconds). The generic
// 10 s budget then aborts the create mid-wait and the voice turn fails before
// it can send. Give it room to wait out a model-bound operation.
const CONVERSATION_CREATE_FETCH_TIMEOUT_MS = 120_000;
// `POST /api/agent/reset` stops the in-process runtime to release the PGlite
// lock before deleting the data dir. On mobile CPU with many plugins loaded,
// the runtime stop alone can exceed the generic 10 s budget; the bridge would
// then abort a reset that is actually progressing, the catch path fires, and
// the UI stays stuck instead of wiping local state and returning to first-run
// setup.
const AGENT_RESET_FETCH_TIMEOUT_MS = 60_000;
// Snapshotting the database, media and vault and encrypting the archive can
// exceed the ordinary REST budget. Keep creation bounded while allowing the
// server to return its receipt before the owner can start another backup.
const LOCAL_BACKUP_CREATE_FETCH_TIMEOUT_MS = 120_000;
// Restore verifies and decrypts the archive, stops the runtime and replaces
// database files before returning the required-restart receipt.
const LOCAL_BACKUP_RESTORE_FETCH_TIMEOUT_MS = 120_000;

function requestPathname(path: string): string {
  try {
    return new URL(path, "http://eliza.local").pathname;
  } catch {
    return path.split(/[?#]/, 1)[0] ?? path;
  }
}

export function defaultFetchTimeoutMs(
  path: string,
  init?: RequestInit,
): number {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "POST") {
    return DEFAULT_FETCH_TIMEOUT_MS;
  }
  const pathname = requestPathname(path);
  // Reply-only recovery awaits text generation just like a new chat turn.
  if (
    pathname === "/api/inbox/messages" ||
    /^\/api\/conversations\/[^/]+\/messages(?:\/stream|\/[^/]+\/retry-reply)?$/.test(
      pathname,
    )
  ) {
    return CHAT_MESSAGE_FETCH_TIMEOUT_MS;
  }
  if (pathname === "/api/tts/local-inference") {
    return LOCAL_INFERENCE_TTS_FETCH_TIMEOUT_MS;
  }
  if (
    pathname === "/api/asr/local-inference" ||
    pathname === "/api/asr/cloud"
  ) {
    return LOCAL_INFERENCE_ASR_FETCH_TIMEOUT_MS;
  }
  if (pathname === "/api/agent/reset") {
    return AGENT_RESET_FETCH_TIMEOUT_MS;
  }
  if (pathname === "/api/backups") {
    return LOCAL_BACKUP_CREATE_FETCH_TIMEOUT_MS;
  }
  if (pathname === "/api/backups/restore") {
    return LOCAL_BACKUP_RESTORE_FETCH_TIMEOUT_MS;
  }
  if (pathname === "/api/conversations") {
    return CONVERSATION_CREATE_FETCH_TIMEOUT_MS;
  }
  return DEFAULT_FETCH_TIMEOUT_MS;
}
