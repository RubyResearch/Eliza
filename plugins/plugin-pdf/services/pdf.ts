/**
 * Implements local PDF input validation, text extraction, metadata parsing,
 * and content cleanup for the runtime PDF service.
 *
 * Complete extraction accounts for every parser-declared page. Every page is
 * rendered for strict vision transcription and reconciliation with native text,
 * positioned parser evidence, and optional OCR; one failed page rejects the
 * complete-document result.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { ElizaError, ModelType, Service, ServiceType } from "@elizaos/core";
import { getDocumentProxy, getResolvedPDFJS, renderPageAsImage } from "unpdf";
import type {
  PdfCompleteDocument,
  PdfCompleteExtractionOptions,
  PdfCompletePage,
  PdfConversionResult,
  PdfDocumentInfo,
  PdfExtractionOptions,
  PdfMetadata,
  PdfPageInfo,
  PdfPositionedTextDocument,
  PdfPositionedTextItem,
} from "../types";
import { parsePdfSpecDate } from "./pdf-date.js";

type PdfTextItem = {
  str: string;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
};

function requirePdfPageCount(numPages: unknown): number {
  if (typeof numPages !== "number" || !Number.isSafeInteger(numPages) || numPages < 1) {
    throw new RangeError("PDF page count must be a positive safe integer");
  }
  return numPages;
}

const PDF_HEADER_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
const PDF_HEADER_SCAN_BYTES = 1024;

function isTextItem(item: unknown): item is PdfTextItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "str" in item &&
    typeof (item as { str?: unknown }).str === "string"
  );
}

function collectTextStrings(items: unknown): string[] {
  if (!Array.isArray(items)) {
    throw new TypeError("PDF text content items must be an array");
  }

  const textItems: string[] = [];
  for (const item of items) {
    if (isTextItem(item)) {
      textItems.push(item.str);
    }
  }
  return textItems;
}

function collectPositionedTextItems(items: unknown, page: number): PdfPositionedTextItem[] {
  if (!Array.isArray(items)) {
    throw new TypeError("PDF text content items must be an array");
  }

  const positioned: PdfPositionedTextItem[] = [];
  for (const item of items) {
    if (!isTextItem(item) || item.str.trim().length === 0) continue;
    const transform = item.transform;
    if (
      !Array.isArray(transform) ||
      transform.length < 6 ||
      !transform.every((value) => typeof value === "number" && Number.isFinite(value)) ||
      typeof item.width !== "number" ||
      !Number.isFinite(item.width) ||
      typeof item.height !== "number" ||
      !Number.isFinite(item.height)
    ) {
      continue;
    }
    positioned.push({
      page,
      text: item.str,
      x: transform[4] as number,
      y: transform[5] as number,
      width: item.width,
      height: item.height,
    });
  }
  return positioned;
}

function hasPdfHeader(input: Uint8Array): boolean {
  const scanLength = Math.min(input.length, PDF_HEADER_SCAN_BYTES);
  for (let offset = 0; offset <= scanLength - PDF_HEADER_BYTES.length; offset++) {
    let matches = true;
    for (let index = 0; index < PDF_HEADER_BYTES.length; index++) {
      if (input[offset + index] !== PDF_HEADER_BYTES[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return true;
    }
  }
  return false;
}

function validatePdfInput(input: unknown): Uint8Array {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError("PDF input must be a Buffer or Uint8Array");
  }

  if (input.length === 0) {
    throw new RangeError("PDF input is empty");
  }

  if (!hasPdfHeader(input)) {
    throw new TypeError("PDF input is not a supported PDF document");
  }

  // PDF.js may transfer its input ArrayBuffer to a worker, which detaches that
  // buffer. Keep the service boundary ownership-safe so callers can still hash,
  // persist, or otherwise reuse the bytes after extraction completes.
  return Uint8Array.from(input);
}

function validatePageOption(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1
  ) {
    throw new RangeError(`${name} must be a positive finite integer`);
  }
  return value;
}

function normalizeExtractionOptions(
  options: PdfExtractionOptions,
  numPages: number
): {
  startPage: number;
  endPage: number;
} {
  const requestedStartPage = validatePageOption(options.startPage, "startPage") ?? 1;
  const requestedEndPage = validatePageOption(options.endPage, "endPage") ?? numPages;
  // Reject a range that begins past the document rather than clamping startPage
  // down to the last page, which would return a different page's text as a
  // success and hide the mismatch behind the full-document pageCount.
  if (requestedStartPage > numPages) {
    throw new RangeError(`startPage ${requestedStartPage} exceeds document page count ${numPages}`);
  }
  if (requestedEndPage < requestedStartPage) {
    throw new RangeError("endPage must be greater than or equal to startPage");
  }
  // startPage is now known in-range; only endPage needs the benign "up to end"
  // clamp so an oversized endPage still extracts through the final page.
  return {
    startPage: requestedStartPage,
    endPage: Math.min(requestedEndPage, numPages),
  };
}

/**
 * PDF spec (ISO 32000-1, 7.9.4) date string: `D:YYYYMMDDHHmmSSOHH'mm'` where
 * every component after the year is optional and `O` is the UT relation
 * (`+`, `-`, or `Z`). This is what `pdf.js`/`unpdf` actually surface in
 * `info.CreationDate`/`info.ModDate`, not an ISO-8601 string. The groups mirror
 * `PDFDateString.toDateObject` in pdf.js so real-world documents round-trip.
 */
export { parsePdfSpecDate } from "./pdf-date.js";

function parseMetadataDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  // Real unpdf/pdf.js output is the PDF-spec `D:` format; only fall back to the
  // permissive `new Date()` path for actual ISO-8601 / RFC strings.
  if (value.startsWith("D:")) {
    return parsePdfSpecDate(value);
  }

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export class PdfService extends Service {
  static serviceType = ServiceType.PDF;
  capabilityDescription = "The agent is able to convert PDF files to text";

  static async start(runtime: IAgentRuntime): Promise<PdfService> {
    const service = new PdfService(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(ServiceType.PDF);
    if (service) {
      await service.stop();
    }
  }

  async stop(): Promise<void> {}

  /**
   * Extract every declared page by rendering and vision-transcribing each page,
   * then reconciling that transcription with native text, positioned parser
   * evidence, and optional OCR. Any failed required stage rejects the whole
   * document; partial success is never returned under the complete contract.
   */
  async extractCompleteDocument(
    pdfBuffer: Buffer | Uint8Array,
    options: PdfCompleteExtractionOptions = {}
  ): Promise<PdfCompleteDocument> {
    const uint8Array = validatePdfInput(pdfBuffer);
    const pdf = await getDocumentProxy(uint8Array);
    const pageCount = requirePdfPageCount(pdf.numPages);
    const pdfjs = await getResolvedPDFJS();
    const ops = pdfjs.OPS as Record<string, number>;
    const visualOps = new Set(
      [
        ops.paintImageXObject,
        ops.paintInlineImageXObject,
        ops.paintImageMaskXObject,
        ops.paintSolidColorImageMask,
      ].filter((value): value is number => typeof value === "number")
    );
    const pages: PdfCompletePage[] = [];
    const renderScale = options.renderScale ?? 2;
    if (!Number.isFinite(renderScale) || renderScale <= 0) {
      throw new RangeError("renderScale must be a positive finite number");
    }

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      try {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const textContent = await page.getTextContent();
        const nativeText = this.cleanUpContent(collectTextStrings(textContent.items).join(" "));
        const nativePositionedText = collectPositionedTextItems(textContent.items, pageNumber);
        const operatorList = await page.getOperatorList();
        if (!Array.isArray(operatorList.fnArray)) {
          throw new TypeError("PDF page operator list must contain fnArray");
        }
        const hasVisualContent = operatorList.fnArray.some(
          (operator: unknown) => typeof operator === "number" && visualOps.has(operator)
        );
        const isParserBlank = nativeText.length === 0 && operatorList.fnArray.length === 0;
        let ocrText: string | null = null;
        const rendered = await renderPageAsImage(pdf, pageNumber, {
          canvasImport: () => import("@napi-rs/canvas"),
          scale: renderScale,
          toDataURL: true,
        });
        if (typeof rendered !== "string" || !rendered.startsWith("data:image/")) {
          throw new TypeError("Rendered PDF page did not produce an image data URL");
        }
        const encoded = rendered.slice(rendered.indexOf(",") + 1);
        const binary = atob(encoded);
        const pngBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        if (options.ocrPage) {
          ocrText = this.cleanUpContent(await options.ocrPage({ pageNumber, pngBytes }));
          if (!ocrText) ocrText = null;
        }
        const response = await this.runtime
          .useModel(ModelType.IMAGE_DESCRIPTION, {
            imageUrl: rendered,
            stream: false,
            prompt: [
              `Transcribe every visible word on PDF page ${pageNumber} exactly and in reading order.`,
              "Preserve headings, labels, table cells, dates, handwriting, and meaningful layout relationships.",
              "Do not summarize, omit repeated text, or infer text that is not visible.",
              "Reconcile the rendered page against all parser and OCR evidence below; resolve disagreements from the image and explicitly note any unresolved ambiguity.",
              "After the exact transcription, describe non-text visual information needed to understand the page.",
              "If and only if the rendered page is completely blank, return exactly [BLANK PAGE].",
              `Native flattened text evidence: ${JSON.stringify(nativeText)}`,
              `Native positioned text evidence: ${JSON.stringify(nativePositionedText)}`,
              `OCR evidence: ${JSON.stringify(ocrText)}`,
              options.visionPrompt?.trim() ?? "",
            ]
              .filter(Boolean)
              .join("\n"),
          })
          .catch((cause) => {
            // error-policy:J2 identify a failed transcription dependency without blaming the PDF.
            throw new ElizaError(
              "PDF page transcription is unavailable. Check the model service and retry the upload.",
              {
                code: "PDF_PAGE_TRANSCRIPTION_UNAVAILABLE",
                context: { pageNumber, pageCount },
                cause,
                severity: "ephemeral",
              }
            );
          });
        const visionText = response.description.trim();
        if (!visionText) {
          throw new Error("IMAGE_DESCRIPTION returned an empty page transcription");
        }
        const visionReportsBlank = visionText === "[BLANK PAGE]";
        if (visionReportsBlank && (!isParserBlank || ocrText)) {
          throw new Error(
            "IMAGE_DESCRIPTION reported a blank page that conflicts with native or OCR evidence"
          );
        }
        const isVerifiedBlank = isParserBlank && !ocrText && visionReportsBlank;

        const text = [
          nativeText,
          ocrText ? `[Rendered-page OCR]\n${ocrText}` : null,
          visionText ? `[Rendered-page transcription and visual context]\n${visionText}` : null,
        ]
          .filter((value): value is string => Boolean(value))
          .join("\n\n");
        const result: PdfCompletePage = {
          pageNumber,
          width: viewport.width,
          height: viewport.height,
          method: isVerifiedBlank ? "blank" : nativeText ? "native+vision" : "vision",
          nativeText,
          nativePositionedText,
          ocrText,
          visionText,
          text,
          hasVisualContent,
        };
        pages.push(result);
        await options.onPageComplete?.(result);
      } catch (error) {
        // error-policy:J2 preserve typed dependency failures; add provenance to parser failures.
        if (error instanceof ElizaError && error.code === "PDF_PAGE_TRANSCRIPTION_UNAVAILABLE")
          throw error;
        throw new Error(
          `Complete PDF extraction failed on page ${pageNumber} of ${pageCount}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }

    return {
      complete: true,
      pageCount,
      pages,
      text: pages.map((page) => `--- Page ${page.pageNumber} ---\n${page.text}`).join("\n\n"),
    };
  }

  async convertPdfToText(pdfBuffer: Buffer | Uint8Array): Promise<string> {
    const uint8Array = validatePdfInput(pdfBuffer);
    const pdf = await getDocumentProxy(uint8Array);
    const numPages = requirePdfPageCount(pdf.numPages);

    const textPages: string[] = [];

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = collectTextStrings(textContent.items).join(" ");
      textPages.push(pageText);
    }

    const rawText = textPages.join("\n");
    return this.cleanUpContent(rawText);
  }

  async convertPdfToPositionedText(
    pdfBuffer: Buffer | Uint8Array
  ): Promise<PdfPositionedTextDocument> {
    const uint8Array = validatePdfInput(pdfBuffer);
    const pdf = await getDocumentProxy(uint8Array);
    const pageCount = requirePdfPageCount(pdf.numPages);
    const items: PdfPositionedTextDocument["items"] = [];
    for (let page = 1; page <= pageCount; page += 1) {
      const source = await (await pdf.getPage(page)).getTextContent();
      if (!Array.isArray(source.items))
        throw new TypeError("PDF text content items must be an array");
      for (const candidate of source.items) {
        if (!isTextItem(candidate) || candidate.str.trim().length === 0) continue;
        const transform = candidate.transform;
        if (
          !Array.isArray(transform) ||
          transform.length < 6 ||
          !transform.every((value) => typeof value === "number" && Number.isFinite(value))
        ) {
          throw new TypeError("PDF positioned text item has an invalid transform");
        }
        const width = candidate.width;
        const height = candidate.height;
        if (
          typeof width !== "number" ||
          !Number.isFinite(width) ||
          typeof height !== "number" ||
          !Number.isFinite(height)
        ) {
          throw new TypeError("PDF positioned text item has invalid dimensions");
        }
        items.push({
          page,
          text: candidate.str,
          x: transform[4] as number,
          y: transform[5] as number,
          width,
          height,
        });
      }
    }
    return { pageCount, items };
  }

  async convertPdfToTextWithOptions(
    pdfBuffer: Buffer | Uint8Array,
    options: PdfExtractionOptions = {}
  ): Promise<PdfConversionResult> {
    try {
      const uint8Array = validatePdfInput(pdfBuffer);
      const pdf = await getDocumentProxy(uint8Array);
      const numPages = requirePdfPageCount(pdf.numPages);

      const { startPage, endPage } = normalizeExtractionOptions(options, numPages);

      const textPages: string[] = [];

      for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const pageText = collectTextStrings(textContent.items).join(
          options.preserveWhitespace ? "" : " "
        );
        textPages.push(pageText);
      }

      let text = textPages.join("\n");

      if (options.cleanContent !== false) {
        text = this.cleanUpContent(text);
      }

      return {
        success: true,
        text,
        pageCount: numPages,
      };
    } catch (error) {
      // error-policy:J1 PdfConversionResult is this public method's structured failure boundary.
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getDocumentInfo(pdfBuffer: Buffer | Uint8Array): Promise<PdfDocumentInfo> {
    const uint8Array = validatePdfInput(pdfBuffer);
    const pdf = await getDocumentProxy(uint8Array);
    const numPages = requirePdfPageCount(pdf.numPages);

    const metadataResult = await pdf.getMetadata();
    const info =
      typeof metadataResult.info === "object" && metadataResult.info !== null
        ? (metadataResult.info as Record<string, unknown>)
        : {};

    const metadata: PdfMetadata = {
      title: typeof info.Title === "string" ? info.Title : undefined,
      author: typeof info.Author === "string" ? info.Author : undefined,
      subject: typeof info.Subject === "string" ? info.Subject : undefined,
      keywords: typeof info.Keywords === "string" ? info.Keywords : undefined,
      creator: typeof info.Creator === "string" ? info.Creator : undefined,
      producer: typeof info.Producer === "string" ? info.Producer : undefined,
      creationDate: parseMetadataDate(info.CreationDate),
      modificationDate: parseMetadataDate(info.ModDate),
    };

    const pages: PdfPageInfo[] = [];
    const allText: string[] = [];

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.0 });
      const textContent = await page.getTextContent();

      const pageText = collectTextStrings(textContent.items).join(" ");

      pages.push({
        pageNumber: pageNum,
        width: viewport.width,
        height: viewport.height,
        text: this.cleanUpContent(pageText),
      });

      allText.push(pageText);
    }

    return {
      pageCount: numPages,
      metadata,
      text: this.cleanUpContent(allText.join("\n")),
      pages,
    };
  }

  cleanUpContent(content: string): string {
    const filtered = content
      .split("")
      .filter((char) => {
        const charCode = char.charCodeAt(0);
        return !(
          charCode === 0 ||
          (charCode >= 1 && charCode <= 8) ||
          (charCode >= 11 && charCode <= 12) ||
          (charCode >= 14 && charCode <= 31) ||
          charCode === 127
        );
      })
      .join("");

    return filtered
      .replace(/[^\S\r\n]+/g, " ")
      .replaceAll(" \r\n", "\r\n")
      .replaceAll(" \n", "\n")
      .trim();
  }
}

export default PdfService;
