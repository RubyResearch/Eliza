/**
 * OCR-provider registry (register/select/list/unregister) and the iOS Vision
 * provider factory. Deterministic unit test over the provider seam.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IosComputerUseBridge } from "./ios-bridge.js";
import {
  _resetOcrProvidersForTests,
  createIosVisionOcrProvider,
  listOcrProviders,
  type OcrProvider,
  registerOcrProvider,
  selectOcrProvider,
  unregisterOcrProvider,
} from "./ocr-provider.js";

/**
 * The OCR provider chain backs scene-text extraction for computer-use. Routing
 * must pick the highest-priority *available* provider, fail loudly when none
 * are available (never silently degrade), and the iOS provider must reflect
 * bridge presence and surface native failures as throws.
 */

const fakeProvider = (
  name: string,
  priority: number,
  available: boolean,
): OcrProvider => ({
  name,
  priority,
  available: () => available,
  recognize: async () => ({
    lines: [],
    fullText: "",
    elapsedMs: 0,
    providerName: name,
    languagesUsed: [],
  }),
});

beforeEach(() => {
  _resetOcrProvidersForTests();
});

describe("OCR provider registry", () => {
  it("lists providers highest-priority first", () => {
    registerOcrProvider(fakeProvider("low", 10, true));
    registerOcrProvider(fakeProvider("high", 100, true));
    expect(listOcrProviders().map((p) => p.name)).toEqual(["high", "low"]);
  });

  it("selects the highest-priority available provider", () => {
    registerOcrProvider(fakeProvider("high", 100, false)); // present but unavailable
    registerOcrProvider(fakeProvider("mid", 50, true));
    expect(selectOcrProvider().name).toBe("mid");
  });

  it("throws when no provider is available", () => {
    registerOcrProvider(fakeProvider("offline", 100, false));
    expect(() => selectOcrProvider()).toThrow(/No OCR provider available/);
    _resetOcrProvidersForTests();
    expect(() => selectOcrProvider()).toThrow(/No OCR provider available/);
  });

  it("unregisters by name", () => {
    registerOcrProvider(fakeProvider("temp", 1, true));
    unregisterOcrProvider("temp");
    expect(listOcrProviders()).toHaveLength(0);
  });
});

describe("createIosVisionOcrProvider", () => {
  const visionResult = {
    ok: true as const,
    data: {
      lines: [
        {
          text: "hello",
          confidence: 0.92,
          boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
        },
      ],
      fullText: "hello",
      elapsedMs: 7,
      languagesUsed: ["en-US"],
    },
  };

  it("is available only when the bridge resolves", () => {
    let bridge: IosComputerUseBridge | null = null;
    const provider = createIosVisionOcrProvider(() => bridge);
    expect(provider.available()).toBe(false);
    bridge = {
      visionOcr: async () => visionResult,
    } as unknown as IosComputerUseBridge;
    expect(provider.available()).toBe(true);
  });

  it("delegates to the bridge and maps the result", async () => {
    const bridge = {
      visionOcr: async () => visionResult,
    } as unknown as IosComputerUseBridge;
    const provider = createIosVisionOcrProvider(() => bridge);
    const out = await provider.recognize({ kind: "base64", data: "AAAA" });
    expect(out.providerName).toBe("ios-apple-vision");
    expect(out.fullText).toBe("hello");
    expect(out.lines[0]).toMatchObject({ text: "hello", confidence: 0.92 });
    expect(out.languagesUsed).toEqual(["en-US"]);
  });

  it("throws when invoked without a bridge or on a native failure", async () => {
    const noBridge = createIosVisionOcrProvider(() => null);
    await expect(
      noBridge.recognize({ kind: "base64", data: "AAAA" }),
    ).rejects.toThrow(/not registered/);

    const failing = createIosVisionOcrProvider(
      () =>
        ({
          visionOcr: async () => ({
            ok: false,
            code: "VISION_ERR",
            message: "no text",
          }),
        }) as unknown as IosComputerUseBridge,
    );
    await expect(
      failing.recognize({ kind: "base64", data: "AAAA" }),
    ).rejects.toThrow(/VISION_ERR — no text/);
  });
});

/**
 * The package ships this module in two bundles (`dist/index.js` and the
 * `mobile/ocr-provider` subpath plugin-vision imports). A registration made
 * through one module instance must be visible to a second, independently
 * evaluated instance, otherwise packaged builds never see plugin-vision's
 * providers. `vi.resetModules()` produces exactly that second instance.
 */
describe("registry is shared across module instances", () => {
  it("exposes providers and slots registered through another instance", async () => {
    const first = await import("./ocr-provider.js");
    first._resetOcrProvidersForTests();
    first.registerOcrProvider(fakeProvider("cross-bundle", 5, true));
    const coord = { name: "coord-probe", describe: async () => ({}) } as never;
    const som = { name: "som-probe", describe: async () => ({}) } as never;
    first.registerCoordOcrProvider(coord);
    first.registerSetOfMarksProvider(som);

    vi.resetModules();
    const second = await import("./ocr-provider.js");
    expect(second).not.toBe(first);
    expect(second.listOcrProviders().map((p) => p.name)).toEqual([
      "cross-bundle",
    ]);
    expect(second.getCoordOcrProvider()).toBe(coord);
    expect(second.getSetOfMarksProvider()).toBe(som);

    second.registerCoordOcrProvider(null);
    second.registerSetOfMarksProvider(null);
    expect(first.getCoordOcrProvider()).toBeNull();
    expect(first.getSetOfMarksProvider()).toBeNull();
    second._resetOcrProvidersForTests();
    expect(first.listOcrProviders()).toEqual([]);
  });
});
