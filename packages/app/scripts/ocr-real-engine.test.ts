/**
 * Exercises packaged Tesseract and pixel diagnostics against a real launcher capture plus adversarial generated frames.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  evaluateOcrContent,
  type OcrResult,
} from "../test/ui-smoke/ocr-content-rules";
import {
  closeOcrEngines,
  ocrImage,
  resetTesseractProbe,
} from "./mvp-visual-verify/ocr.mjs";
import { runOcrTriage } from "./ocr-triage";

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCHER_CAPTURE = resolve(
  HERE,
  "mvp-visual-verify/baseline/mobile-portrait/builtin-rolodex.png",
);
const dir = mkdtempSync(join(tmpdir(), "ocr-real-engine-"));
const previousEngine = process.env.ELIZA_MVP_OCR_ENGINE;

function contentResult(
  result: Awaited<ReturnType<typeof ocrImage>>,
): OcrResult {
  if (!result.available) {
    return {
      ok: false,
      text: "",
      lines: [],
      words: 0,
      meanConfidence: 0,
      reason: result.reason,
    };
  }
  return {
    ok: true,
    text: result.text,
    lines: result.text.split("\n").filter(Boolean),
    words: result.words,
    meanConfidence: result.meanConfidence,
    pixelBlank: result.pixelBlank,
    pixelBlankReasons: result.pixelBlankReasons,
    selectedMode: result.selectedMode,
    attempts: result.attempts,
  };
}

beforeAll(() => {
  process.env.ELIZA_MVP_OCR_ENGINE = "packaged";
  resetTesseractProbe();
});

afterAll(async () => {
  await closeOcrEngines();
  resetTesseractProbe();
  if (previousEngine === undefined) delete process.env.ELIZA_MVP_OCR_ENGINE;
  else process.env.ELIZA_MVP_OCR_ENGINE = previousEngine;
  rmSync(dir, { recursive: true, force: true });
});

describe("real OCR blank-vs-unreadable classification", () => {
  it.each(["dark", "light"])(
    "preserves muted labels on a %s interface without inventing missing content",
    async (theme) => {
      const path = join(dir, `muted-labels-${theme}.png`);
      const background = theme === "dark" ? "#131313" : "#fafafa";
      const foreground = theme === "dark" ? "#858585" : "#777777";
      const strong = theme === "dark" ? "#eeeeee" : "#111111";
      await sharp(
        Buffer.from(`
        <svg width="390" height="400" xmlns="http://www.w3.org/2000/svg">
          <rect width="390" height="400" fill="${background}" />
          <text x="24" y="48" font-family="Arial, sans-serif" font-size="14" fill="${foreground}">LIBRARY</text>
          <text x="260" y="48" font-family="Arial, sans-serif" font-size="16" fill="${strong}">Add</text>
          <text x="24" y="116" font-family="Arial, sans-serif" font-size="16" fill="${strong}">Quarterly Plan</text>
          <text x="24" y="148" font-family="Arial, sans-serif" font-size="13" fill="${foreground}">Upload seven fragments</text>
        </svg>
      `),
      )
        .png()
        .toFile(path);
      const result = await ocrImage(path, {
        timeoutMs: 60_000,
        alwaysTryFallback: true,
      });
      if (!result.available) throw new Error(result.reason);
      const fallback = result.attempts?.find(
        (attempt) => attempt.mode === "sparse-grayscale",
      );
      expect(fallback?.text).toMatch(/LIBRARY/i);
      expect(fallback?.text).toMatch(/seven fragments/i);
      expect(fallback?.text).not.toMatch(/No documents yet/i);
      expect(result.pixelBlank).toBe(false);
    },
    90_000,
  );

  it("runs the sparse pass when a semantic gate rejects an otherwise confident transcript", async () => {
    const path = join(dir, "semantic-retry.png");
    const svg = Buffer.from(`
      <svg width="640" height="240" xmlns="http://www.w3.org/2000/svg">
        <rect width="640" height="240" fill="#f7f7f7" />
        <text x="36" y="92" font-family="Arial, sans-serif" font-size="44" fill="#111111">Misty Forest</text>
        <text x="36" y="174" font-family="Arial, sans-serif" font-size="44" fill="#111111">Desert Dusk</text>
      </svg>
    `);
    await sharp(svg).png().toFile(path);

    const primary = await ocrImage(path, { timeoutMs: 60_000 });
    if (!primary.available) throw new Error(primary.reason);
    expect(primary.meanConfidence).toBeGreaterThanOrEqual(0.45);
    expect(primary.attempts).toHaveLength(1);

    const retried = await ocrImage(path, {
      timeoutMs: 60_000,
      alwaysTryFallback: true,
    });
    if (!retried.available) throw new Error(retried.reason);
    expect(retried.attempts).toHaveLength(3);
    expect(retried.attempts?.map((attempt) => attempt.mode)).toEqual([
      "auto",
      "sparse-high-contrast",
      "sparse-grayscale",
    ]);
    expect(retried.text).toMatch(/Misty Forest/i);
    expect(retried.text).toMatch(/Desert Dusk/i);
  }, 90_000);

  it("rejects a launcher captured in place of the expected view without calling populated pixels blank", async () => {
    const auditDir = join(dir, "launcher-audit");
    const viewportDir = join(auditDir, "mobile-portrait");
    mkdirSync(viewportDir, { recursive: true });
    // The archive filename records its original route, but these pixels are
    // the launcher and must use the launcher semantic contract.
    copyFileSync(LAUNCHER_CAPTURE, join(viewportDir, "builtin-views.png"));
    writeFileSync(
      join(auditDir, "report.json"),
      JSON.stringify([
        {
          slug: "builtin-views",
          viewport: "mobile-portrait",
          viewType: "gui",
          verdict: "good",
        },
      ]),
    );

    const triage = await runOcrTriage([
      "--audit-dir",
      auditDir,
      "--out",
      join(auditDir, "ocr-triage.json"),
    ]);
    const entry = triage.entries[0];
    if (!entry) throw new Error("expected launcher triage entry");
    const attempts = entry.attempts;
    if (!attempts) throw new Error("expected retained OCR attempts");

    expect(attempts[0]).toMatchObject({
      mode: "auto",
      ok: true,
    });
    expect(attempts[0].meanConfidence).toBeLessThan(0.45);
    expect(attempts).toHaveLength(3);
    expect(attempts[1]).toMatchObject({
      mode: "sparse-high-contrast",
      ok: true,
    });
    expect(attempts.some((attempt) => /Ask Eliza/i.test(attempt.text))).toBe(
      true,
    );
    expect(entry.pixelBlank).toBe(false);
    // The historical capture contains launcher icons rather than the requested
    // view. A successful fallback must retain that semantic mismatch, not turn
    // a nonblank but wrong screen into accepted product evidence.
    expect(entry.ocrVerdict).toBe("broken");
    expect(entry.regression).toBe(true);
    expect(entry.reasons.join(" ")).toMatch(/missing expected content/i);
    expect(entry.reasons.join(" ")).not.toMatch(/pixels are blank/i);
  }, 90_000);

  it("still rejects a solid frame after all OCR passes", async () => {
    const path = join(dir, "solid.png");
    await sharp({
      create: {
        width: 390,
        height: 844,
        channels: 4,
        background: { r: 208, g: 216, b: 216, alpha: 1 },
      },
    })
      .png()
      .toFile(path);

    const result = await ocrImage(path, { timeoutMs: 60_000 });
    if (!result.available) throw new Error(result.reason);
    expect(result.pixelBlank).toBe(true);

    const finding = evaluateOcrContent({ ocr: contentResult(result) });
    expect(finding.blankPixels).toBe(true);
    expect(finding.ocrInconclusive).toBe(false);
    expect(finding.verdict).toBe("broken");
    expect(finding.reasons.join(" ")).toMatch(/one color/);
  }, 90_000);

  it("routes a nonblank textless gradient to review instead of fabricating blank pixels", async () => {
    const width = 390;
    const height = 844;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = 72 + Math.floor((156 * x) / (width - 1));
        const offset = (y * width + x) * 3;
        pixels[offset] = value;
        pixels[offset + 1] = value;
        pixels[offset + 2] = value;
      }
    }
    const path = join(dir, "gradient.png");
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toFile(path);

    const result = await ocrImage(path, { timeoutMs: 60_000 });
    if (!result.available) throw new Error(result.reason);
    expect(result.pixelBlank).toBe(false);

    const finding = evaluateOcrContent({ ocr: contentResult(result) });
    expect(finding.blankPixels).toBe(false);
    expect(finding.ocrInconclusive).toBe(true);
    expect(finding.verdict).toBe("needs-eyeball");
    expect(finding.reasons.join(" ")).toMatch(/OCR inconclusive/);
  }, 90_000);

  it("keeps near-solid quality warnings distinct from proof of a blank frame", async () => {
    const width = 120;
    const height = 120;
    const pixels = Buffer.alloc(width * height * 3, 255);
    pixels[0] = 16;
    pixels[1] = 16;
    pixels[2] = 16;
    const path = join(dir, "near-solid.png");
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toFile(path);

    const result = await ocrImage(path, { timeoutMs: 60_000 });
    if (!result.available) throw new Error(result.reason);
    expect(result.imageAnalysis.issues).toContain(
      "screenshot is effectively one color",
    );
    expect(result.imageAnalysis.issues).toContain(
      "screenshot is near-solid black/white",
    );
    expect(result.pixelBlank).toBe(false);

    const finding = evaluateOcrContent({ ocr: contentResult(result) });
    expect(finding.blankPixels).toBe(false);
    expect(finding.verdict).toBe("needs-eyeball");
  }, 90_000);
});
