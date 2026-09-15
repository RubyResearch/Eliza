// @vitest-environment jsdom
//
// Verifies the web fallback rejects every method: a web host has no native child
// surface, so an accidental call must fail loudly rather than return a surface
// that isolates nothing. Real WebPlugin instance, no mocks.

import { describe, expect, it } from "vitest";
import { BrowserSurfaceWeb } from "./web";

describe("BrowserSurfaceWeb", () => {
  const web = new BrowserSurfaceWeb();
  const identity = {
    owner: "browser",
    session: "test-realm",
    epoch: 1,
  } as const;

  it("rejects createSurface even with a full explicit policy", async () => {
    await expect(
      web.createSurface({
        ...identity,
        id: "browser-tab:a",
        url: "https://example.com",
        process: "isolated",
        storage: "isolated",
      }),
    ).rejects.toThrow(/native-only/i);
  });

  it("rejects every surface method as unavailable", async () => {
    await expect(
      web.setBounds({
        ...identity,
        id: "a",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        outerClip: {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          cornerRadii: {
            topLeft: 0,
            topRight: 0,
            bottomRight: 0,
            bottomLeft: 0,
          },
        },
      }),
    ).rejects.toThrow(/native-only/i);
    await expect(
      web.setOcclusionRects({
        ...identity,
        id: "a",
        rects: [{ x: 0, y: 0, width: 1, height: 1, cornerRadius: 0 }],
      }),
    ).rejects.toThrow(/native-only/i);
    await expect(
      web.navigate({ ...identity, id: "a", url: "https://example.com" }),
    ).rejects.toThrow(/native-only/i);
    await expect(web.reloadSurface({ ...identity, id: "a" })).rejects.toThrow(
      /native-only/i,
    );
    await expect(web.goBack({ ...identity, id: "a" })).rejects.toThrow(
      /native-only/i,
    );
    await expect(web.readPage({ ...identity, id: "a" })).rejects.toThrow(
      /native-only/i,
    );
    await expect(web.presentSurface({ ...identity, id: "a" })).rejects.toThrow(
      /native-only/i,
    );
    await expect(web.destroySurface({ ...identity, id: "a" })).rejects.toThrow(
      /native-only/i,
    );
    await expect(web.getSurfaceState({ ...identity, id: "a" })).rejects.toThrow(
      /native-only/i,
    );
    await expect(web.listSurfaceStates(identity)).rejects.toThrow(
      /native-only/i,
    );
    await expect(
      web.reconcileOwner({ ...identity, desiredIds: ["a"] }),
    ).rejects.toThrow(/native-only/i);
  });
});
