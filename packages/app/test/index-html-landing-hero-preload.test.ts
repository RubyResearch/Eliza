/**
 * Route-aware contract for landing-hero image preloads injected by index.html.
 * Marketing desktop `/` starts the above-the-fold marks during HTML parse.
 * Signed-out `/login` must not high-priority-fetch those unused SVGs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

const appRoot = join(import.meta.dirname, "..");
const indexHtml = readFileSync(join(appRoot, "index.html"), "utf8");

const LANDING_HERO_MARKS = [
  "/brand/logos/logo_white_orangebg.svg",
  "/brand/logos/eliza_text_black.svg",
] as const;

const MARKETING_ORIGIN = "https://staging.eliza.app";

const openDocuments: JSDOM[] = [];

afterEach(() => {
  while (openDocuments.length > 0) {
    openDocuments.pop()?.window.close();
  }
});

function parseSurface(url: string, options?: { desktop?: boolean }): JSDOM {
  const desktop = options?.desktop ?? true;
  const dom = new JSDOM(indexHtml, {
    pretendToBeVisual: true,
    runScripts: "dangerously",
    url,
    beforeParse(window) {
      window.matchMedia = (query: string): MediaQueryList =>
        ({
          matches: desktop && /min-width:\s*641px/.test(query),
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() {
            return false;
          },
        }) as MediaQueryList;
    },
  });
  openDocuments.push(dom);
  return dom;
}

function landingHeroPreloads(document: Document): HTMLLinkElement[] {
  const allowed = new Set<string>(LANDING_HERO_MARKS);
  return [...document.querySelectorAll("link")].filter((link) => {
    const href = link.getAttribute("href") ?? "";
    const asImage =
      link.getAttribute("as") === "image" ||
      (link as HTMLLinkElement).as === "image";
    return link.rel === "preload" && asImage && allowed.has(href);
  });
}

describe("index.html landing-hero image preloads", () => {
  it("preloads both desktop landing marks on the marketing root", () => {
    const { document } = parseSurface(`${MARKETING_ORIGIN}/`).window;
    const preloads = landingHeroPreloads(document);

    expect(preloads.map((link) => link.getAttribute("href"))).toEqual([
      ...LANDING_HERO_MARKS,
    ]);
    for (const preload of preloads) {
      expect(preload.getAttribute("fetchpriority")).toBe("high");
    }
  });

  it.each(["/login", "/login/", "/login?returnTo=%2Fchat"])(
    "does not high-priority-preload unused landing marks on %s",
    (pathnameAndSearch) => {
      const { document } = parseSurface(
        `${MARKETING_ORIGIN}${pathnameAndSearch}`,
      ).window;

      expect(landingHeroPreloads(document)).toEqual([]);
    },
  );

  it("does not preload landing marks on other public marketing routes", () => {
    const { document } = parseSurface(`${MARKETING_ORIGIN}/downloads`).window;

    expect(landingHeroPreloads(document)).toEqual([]);
  });

  it("does not preload landing marks on a narrow marketing root", () => {
    const { document } = parseSurface(`${MARKETING_ORIGIN}/`, {
      desktop: false,
    }).window;

    expect(landingHeroPreloads(document)).toEqual([]);
  });

  it("does not preload landing marks on a non-marketing desktop host", () => {
    const { document } = parseSurface("https://localhost/").window;

    expect(landingHeroPreloads(document)).toEqual([]);
  });
});
