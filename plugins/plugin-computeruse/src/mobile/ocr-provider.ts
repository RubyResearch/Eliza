/**
 * OCR provider chain — used by WS6 (scene-builder) and any other consumer
 * that needs text-from-image extraction.
 *
 * Defined here in plugin-computeruse so the mobile bridge can publish the
 * iOS Apple Vision implementation alongside the rest of the iOS surface.
 * WS6 will register additional providers (cloud, Tesseract fallback) and
 * pick a provider per-call via `selectOcrProvider`.
 *
 * Contract:
 *   - `name`         : stable string id for routing/telemetry.
 *   - `priority`     : higher wins when multiple providers report `available`.
 *   - `available()`  : cheap synchronous availability probe; the registry
 *                      caches the result for the process lifetime.
 *   - `recognize()`  : async OCR call. Throws on hard failures so callers can
 *                      fall back to the next provider; never returns empty
 *                      lines silently.
 *
 * Registry state lives on a `globalThis` slot keyed by `Symbol.for`, not in
 * module scope: the package bundles this module into both `dist/index.js` and
 * the `mobile/ocr-provider` subpath, and plugin-vision registers through the
 * subpath while the scene builder and `detect_elements` read from the index
 * bundle. Module-scoped state would give each bundle its own empty registry.
 */

import type {
  IosComputerUseBridge,
  VisionOcrLine,
  VisionOcrOptions,
  VisionOcrResult,
} from "./ios-bridge.js";

export interface OcrLine {
  readonly text: string;
  readonly confidence: number;
  readonly boundingBox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface OcrResult {
  readonly lines: readonly OcrLine[];
  readonly fullText: string;
  readonly elapsedMs: number;
  readonly providerName: string;
  readonly languagesUsed: readonly string[];
}

export interface OcrRecognizeOptions {
  readonly languages?: readonly string[];
  readonly recognitionLevel?: "fast" | "accurate";
  readonly minimumTextHeight?: number;
}

export interface OcrProvider {
  readonly name: string;
  readonly priority: number;
  available(): boolean;
  recognize(input: OcrInput, options?: OcrRecognizeOptions): Promise<OcrResult>;
}

/**
 * Image input. Either a base64-encoded PNG/JPEG or raw bytes. The provider
 * is responsible for normalizing into whatever its native side expects.
 */
export type OcrInput =
  | { readonly kind: "base64"; readonly data: string }
  | { readonly kind: "bytes"; readonly data: Uint8Array };

// ── Registry ─────────────────────────────────────────────────────────────────

const REGISTRY_KEY = Symbol.for(
  "elizaos.plugin-computeruse.ocr-provider-registry",
);

interface OcrRegistryState {
  readonly providers: Map<string, OcrProvider>;
  coord: CoordOcrProvider | null;
  setOfMarks: SetOfMarksProvider | null;
}

/**
 * The process-wide registry. Read from `globalThis` on every access (no
 * module-local cache) so every bundled copy of this module observes the same
 * providers and the same coord-OCR / Set-of-Marks slots.
 */
function registryState(): OcrRegistryState {
  const slot = globalThis as Record<PropertyKey, unknown>;
  const existing = slot[REGISTRY_KEY];
  if (existing !== undefined) return existing as OcrRegistryState;
  const created: OcrRegistryState = {
    providers: new Map<string, OcrProvider>(),
    coord: null,
    setOfMarks: null,
  };
  slot[REGISTRY_KEY] = created;
  return created;
}

export function registerOcrProvider(provider: OcrProvider): void {
  registryState().providers.set(provider.name, provider);
}

export function unregisterOcrProvider(name: string): void {
  registryState().providers.delete(name);
}

export function listOcrProviders(): readonly OcrProvider[] {
  return [...registryState().providers.values()].sort((a, b) => {
    const aPriority =
      typeof a.priority === "number" && Number.isFinite(a.priority)
        ? a.priority
        : 0;
    const bPriority =
      typeof b.priority === "number" && Number.isFinite(b.priority)
        ? b.priority
        : 0;
    return bPriority - aPriority || a.name.localeCompare(b.name);
  });
}

/**
 * Returns the highest-priority provider that reports `available()`. Throws if
 * none are available — callers must handle that explicitly rather than
 * silently degrading. WS6's scene-builder catches and reports.
 */
export function selectOcrProvider(): OcrProvider {
  for (const provider of listOcrProviders()) {
    if (provider.available()) return provider;
  }
  throw new Error(
    "No OCR provider available. Register at least one provider before calling selectOcrProvider().",
  );
}

// ── iOS Apple Vision provider ────────────────────────────────────────────────

/**
 * Builds an OcrProvider that delegates to the Capacitor `ComputerUse` plugin's
 * `visionOcr` method. Pass in a getter that lazily resolves the bridge so this
 * module stays free of Capacitor imports (which would break Node test runs).
 */
export function createIosVisionOcrProvider(
  getBridge: () => IosComputerUseBridge | null,
  options: { readonly priority?: number } = {},
): OcrProvider {
  return {
    name: "ios-apple-vision",
    priority: options.priority ?? 100,
    available(): boolean {
      return getBridge() !== null;
    },
    async recognize(input, recognizeOptions): Promise<OcrResult> {
      const bridge = getBridge();
      if (!bridge) {
        throw new Error(
          "ios-apple-vision provider invoked but Capacitor ComputerUse plugin is not registered.",
        );
      }
      const imageBase64 = toBase64(input);
      const visionOptions: VisionOcrOptions = {
        ...(recognizeOptions?.languages
          ? { languages: recognizeOptions.languages }
          : {}),
        ...(recognizeOptions?.recognitionLevel
          ? { recognitionLevel: recognizeOptions.recognitionLevel }
          : {}),
        ...(recognizeOptions?.minimumTextHeight !== undefined
          ? { minimumTextHeight: recognizeOptions.minimumTextHeight }
          : {}),
      };
      const result = await bridge.visionOcr({
        imageBase64,
        options: visionOptions,
      });
      if (!result.ok) {
        // Narrow to the failure arm explicitly — some consumer tsconfigs
        // run with `strict: false`, which disables discriminated-union
        // narrowing on `!result.ok` and surfaces TS2339 on `result.code`
        // / `result.message`. The runtime invariant is unchanged.
        const failure = result as Extract<typeof result, { ok: false }>;
        throw new Error(
          `ios-apple-vision OCR failed: ${failure.code} — ${failure.message}`,
        );
      }
      return mapVisionResult(result.data);
    },
  };
}

function toBase64(input: OcrInput): string {
  if (input.kind === "base64") return input.data;
  return uint8ArrayToBase64(input.data);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  // btoa is the only universal browser/Capacitor path.
  // eslint-disable-next-line no-undef
  return btoa(binary);
}

function mapVisionResult(result: VisionOcrResult): OcrResult {
  return {
    lines: result.lines.map(mapLine),
    fullText: result.fullText,
    elapsedMs: result.elapsedMs,
    providerName: "ios-apple-vision",
    languagesUsed: result.languagesUsed,
  };
}

function mapLine(line: VisionOcrLine): OcrLine {
  return {
    text: line.text,
    confidence: line.confidence,
    boundingBox: line.boundingBox,
  };
}

/**
 * Test helper. Drops every provider from the registry; callers re-register
 * in `beforeEach`.
 */
export function _resetOcrProvidersForTests(): void {
  registryState().providers.clear();
}

// ── Coord-aware OCR provider slot ────────────────────────────────────────────

/**
 * Hierarchical (block / line / word) OCR with absolute source-display
 * coordinates and a coarse 3x3 semantic position label per element. This is
 * a *separate* slot from `OcrProvider` above — that one is line-only and
 * shaped around Apple Vision's API, while this one carries the structure
 * that plugin-computeruse needs to compute action targets without re-running
 * detection.
 *
 * The provider implementation lives in `@elizaos/plugin-vision`'s
 * `ocr-with-coords.ts`. plugin-computeruse intentionally does not take a
 * runtime dep on plugin-vision (computeruse is the higher-level seam), so
 * the runtime registers a provider here at boot.
 *
 * The current in-tree provider is the RapidOCR-backed adapter registered by
 * `@elizaos/plugin-vision`; native providers can register the same interface
 * when they are available.
 */
export interface CoordOcrSemantic {
  readonly position:
    | "upper-left"
    | "upper-center"
    | "upper-right"
    | "middle-left"
    | "center"
    | "middle-right"
    | "lower-left"
    | "lower-center"
    | "lower-right";
}

export interface CoordOcrWord {
  readonly text: string;
  readonly bbox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly semantic_position: CoordOcrSemantic["position"];
}

export interface CoordOcrBlock {
  readonly text: string;
  readonly bbox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly words: ReadonlyArray<CoordOcrWord>;
  readonly semantic_position: CoordOcrSemantic["position"];
}

export interface CoordOcrResult {
  readonly blocks: ReadonlyArray<CoordOcrBlock>;
}

export interface CoordOcrInput {
  readonly displayId: string;
  readonly sourceX: number;
  readonly sourceY: number;
  readonly pngBytes: Uint8Array;
}

export interface CoordOcrProvider {
  readonly name: string;
  describe(input: CoordOcrInput): Promise<CoordOcrResult>;
}

/**
 * Register the hierarchical / coord-aware OCR provider. Idempotent — last
 * call wins so a hot-reload of the bridge swaps cleanly. Pass `null` to
 * unregister.
 */
export function registerCoordOcrProvider(
  provider: CoordOcrProvider | null,
): void {
  registryState().coord = provider;
}

export function getCoordOcrProvider(): CoordOcrProvider | null {
  return registryState().coord;
}

// ── Set-of-Marks provider slot (#9170 M9) ────────────────────────────────────

/**
 * Set-of-Marks grounding (trycua/cua's OmniParser technique): fuse GGUF YOLO
 * icon detections + OCR text boxes into ONE deduplicated, 1-indexed set of
 * numbered targets, optionally with a numbered-overlay PNG. The VLM picks a
 * *number* instead of regressing raw pixels.
 *
 * The fusion + overlay implementation lives in `@elizaos/plugin-vision`
 * (`som.ts`) because that package owns the YOLO detector and OCR engines.
 * computeruse exposes this registration slot (same no-hard-dep pattern as the
 * CoordOcrProvider above); `detect_elements` consumes whatever is registered.
 */
export interface SetOfMarksMark {
  /** 1-indexed mark number shown in the overlay. */
  readonly index: number;
  /** Display-local box `[x, y, w, h]`. */
  readonly bbox: readonly [number, number, number, number];
  /** Box center `[x, y]` — the click target the number resolves to. */
  readonly center: readonly [number, number];
  readonly source: "icon" | "text";
  readonly label?: string;
  readonly score: number;
}

export interface SetOfMarksResult {
  readonly marks: ReadonlyArray<SetOfMarksMark>;
  /** Base64 PNG of the numbered overlay (present only when requested). */
  readonly overlayPngBase64?: string;
}

export interface SetOfMarksInput {
  readonly displayId: string;
  readonly sourceX: number;
  readonly sourceY: number;
  readonly pngBytes: Uint8Array;
  /** Render and return the numbered-overlay PNG. Default false (marks only). */
  readonly renderOverlay?: boolean;
}

export interface SetOfMarksProvider {
  readonly name: string;
  describe(input: SetOfMarksInput): Promise<SetOfMarksResult>;
}

/**
 * Register the Set-of-Marks provider. Idempotent — last call wins. Pass `null`
 * to unregister.
 */
export function registerSetOfMarksProvider(
  provider: SetOfMarksProvider | null,
): void {
  registryState().setOfMarks = provider;
}

export function getSetOfMarksProvider(): SetOfMarksProvider | null {
  return registryState().setOfMarks;
}
