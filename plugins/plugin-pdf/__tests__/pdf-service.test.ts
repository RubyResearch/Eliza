/**
 * Tests PdfService parsing and validation with deterministic unpdf boundary mocks.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "@elizaos/core";
import { PdfService } from "../services/pdf";

const getDocumentProxyMock = vi.hoisted(() => vi.fn());
const renderPageAsImageMock = vi.hoisted(() => vi.fn());

vi.mock("unpdf", () => ({
	getDocumentProxy: getDocumentProxyMock,
	getResolvedPDFJS: vi.fn(async () => ({
		OPS: {
			paintImageXObject: 85,
			paintInlineImageXObject: 86,
			paintImageMaskXObject: 83,
			paintSolidColorImageMask: 90,
		},
	})),
	renderPageAsImage: renderPageAsImageMock,
}));


interface MockPageInput {
	items: unknown;
	width?: number;
	height?: number;
	operators?: number[];
}

function makeDeclaredPdf(numPages: number) {
	return {
		numPages,
		getPage: vi.fn(async () => ({
			getTextContent: vi.fn(async () => ({ items: [{ str: "p" }] })),
			getViewport: vi.fn(() => ({ width: 612, height: 792 })),
			getOperatorList: vi.fn(async () => ({ fnArray: [] })),
		})),
		getMetadata: vi.fn(async () => ({ info: {} })),
	};
}

function makePdf(
	pages: MockPageInput[],
	info: Record<string, unknown> | null | undefined = {}
) {
	return {
		numPages: pages.length,
		getPage: vi.fn(async (pageNumber: number) => {
			const page = pages[pageNumber - 1];
			if (!page) throw new Error(`Missing page ${pageNumber}`);
			return {
				getTextContent: vi.fn(async () => ({ items: page.items })),
				getViewport: vi.fn(() => ({
					width: page.width ?? 612,
					height: page.height ?? 792,
				})),
				getOperatorList: vi.fn(async () => ({
					fnArray: page.operators ?? [],
				})),
			};
		}),
		getMetadata: vi.fn(async () => ({ info })),
	};
}

function service(runtime: Partial<IAgentRuntime> = {}): PdfService {
	return new PdfService(runtime as IAgentRuntime);
}

function validPdfBuffer(body = "body"): Buffer {
	return Buffer.from(`%PDF-1.7\n${body}`);
}

describe("PdfService", () => {
	beforeEach(() => {
		getDocumentProxyMock.mockReset();
		renderPageAsImageMock.mockReset();
		renderPageAsImageMock.mockResolvedValue("data:image/png;base64,cGFnZQ==");
	});

	it("extracts text from every page, ignores non-text items, and cleans control characters", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf([
				{ items: [{ str: "Hello" }, { str: "  world\u0000" }, { notText: true }] },
				{ items: [{ str: "Second\t\tpage" }] },
			])
		);

		await expect(service().convertPdfToText(validPdfBuffer())).resolves.toBe(
			"Hello world\nSecond page"
		);
		const parserInput = getDocumentProxyMock.mock.calls[0]?.[0];
		expect(parserInput).toBeInstanceOf(Uint8Array);
		expect(Buffer.isBuffer(parserInput)).toBe(false);
	});

	it("preserves caller-owned bytes when the parser transfers its input buffer", async () => {
		const input = Uint8Array.from(validPdfBuffer());
		const expected = Uint8Array.from(input);
		getDocumentProxyMock.mockImplementation(async (parserInput: Uint8Array) => {
			structuredClone(parserInput.buffer, {
				transfer: [parserInput.buffer as ArrayBuffer],
			});
			return makePdf([{ items: [{ str: "preserved" }] }]);
		});

		await expect(service().convertPdfToText(input)).resolves.toBe("preserved");
		expect(input).toEqual(expected);
		expect(input.byteLength).toBe(expected.byteLength);
	});

	it("retains page geometry for layout-sensitive consumers", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf([
				{
					items: [
						{ str: "Aug 31 First Day Students", transform: [1, 0, 0, 1, 172, 714], width: 120, height: 9 },
					],
				},
			]),
		);

		await expect(
			service().convertPdfToPositionedText(validPdfBuffer()),
		).resolves.toEqual({
			pageCount: 1,
			items: [
				{
					page: 1,
					text: "Aug 31 First Day Students",
					x: 172,
					y: 714,
					width: 120,
					height: 9,
				},
			],
		});
	});

	it("honors start/end page bounds and returns page count for ranged extraction", async () => {
		const pdf = makePdf([
			{ items: [{ str: "one" }] },
			{ items: [{ str: "two" }] },
			{ items: [{ str: "three" }] },
		]);
		getDocumentProxyMock.mockResolvedValue(pdf);

		await expect(
			service().convertPdfToTextWithOptions(validPdfBuffer(), {
				startPage: 2,
				endPage: 99,
			})
		).resolves.toEqual({
			success: true,
			text: "two\nthree",
			pageCount: 3,
		});
		expect(pdf.getPage).toHaveBeenCalledTimes(2);
		expect(pdf.getPage).toHaveBeenNthCalledWith(1, 2);
		expect(pdf.getPage).toHaveBeenNthCalledWith(2, 3);
	});

	it("rejects a range that begins entirely past the document instead of clamping to the last page", async () => {
		const pdf = makePdf([
			{ items: [{ str: "one" }] },
			{ items: [{ str: "two" }] },
			{ items: [{ str: "three" }] },
		]);
		getDocumentProxyMock.mockResolvedValue(pdf);

		const result = await service().convertPdfToTextWithOptions(validPdfBuffer(), {
			startPage: 5,
			endPage: 10,
		});

		expect(result.success).toBe(false);
		expect(result.text).toBeUndefined();
		expect(result.error).toBe("startPage 5 exceeds document page count 3");
		expect(pdf.getPage).not.toHaveBeenCalled();
	});

	it("names startPage as the cause when startPage exceeds page count and no endPage is supplied", async () => {
		const pdf = makePdf([
			{ items: [{ str: "one" }] },
			{ items: [{ str: "two" }] },
			{ items: [{ str: "three" }] },
		]);
		getDocumentProxyMock.mockResolvedValue(pdf);

		const result = await service().convertPdfToTextWithOptions(validPdfBuffer(), {
			startPage: 5,
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe("startPage 5 exceeds document page count 3");
		expect(result.error).not.toContain("endPage");
		expect(pdf.getPage).not.toHaveBeenCalled();
	});

	it("still clamps an oversized endPage down to the last page for an in-range startPage", async () => {
		const pdf = makePdf([
			{ items: [{ str: "one" }] },
			{ items: [{ str: "two" }] },
			{ items: [{ str: "three" }] },
		]);
		getDocumentProxyMock.mockResolvedValue(pdf);

		await expect(
			service().convertPdfToTextWithOptions(validPdfBuffer(), {
				startPage: 2,
				endPage: 99,
			})
		).resolves.toEqual({ success: true, text: "two\nthree", pageCount: 3 });
	});

	it("accepts an in-range start/end page range unchanged", async () => {
		const pdf = makePdf([
			{ items: [{ str: "one" }] },
			{ items: [{ str: "two" }] },
			{ items: [{ str: "three" }] },
		]);
		getDocumentProxyMock.mockResolvedValue(pdf);

		await expect(
			service().convertPdfToTextWithOptions(validPdfBuffer(), {
				startPage: 2,
				endPage: 3,
			})
		).resolves.toEqual({ success: true, text: "two\nthree", pageCount: 3 });
	});

	it("can preserve item whitespace and skip cleanup when requested", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf([{ items: [{ str: "A  " }, { str: "\u0000B" }] }])
		);

		await expect(
			service().convertPdfToTextWithOptions(validPdfBuffer(), {
				preserveWhitespace: true,
				cleanContent: false,
			})
		).resolves.toEqual({
			success: true,
			text: "A  \u0000B",
			pageCount: 1,
		});
	});

	it("returns structured errors for option-based extraction failures", async () => {
		getDocumentProxyMock.mockRejectedValue(new Error("bad pdf"));

		await expect(service().convertPdfToTextWithOptions(validPdfBuffer("bad"))).resolves.toEqual({
			success: false,
			error: "bad pdf",
		});
	});

	it("returns metadata, dimensions, per-page text, and aggregate text", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf(
				[
					{ items: [{ str: " First  page " }], width: 100, height: 200 },
					{ items: [{ str: "Second" }, { str: " page" }], width: 300, height: 400 },
				],
				{
					Title: "Spec",
					Author: "Ada",
					Subject: "Testing",
					Keywords: "pdf,unit",
					Creator: "suite",
					Producer: "vitest",
					// pdf.js/unpdf surface PDF-spec `D:` strings, not ISO-8601.
					CreationDate: "D:20240102030405Z",
					ModDate: "D:20240203040506Z",
				}
			)
		);

		const info = await service().getDocumentInfo(validPdfBuffer());

		expect(info).toEqual({
			pageCount: 2,
			metadata: {
				title: "Spec",
				author: "Ada",
				subject: "Testing",
				keywords: "pdf,unit",
				creator: "suite",
				producer: "vitest",
				creationDate: new Date("2024-01-02T03:04:05.000Z"),
				modificationDate: new Date("2024-02-03T04:05:06.000Z"),
			},
			text: "First page\nSecond page",
			pages: [
				{ pageNumber: 1, width: 100, height: 200, text: "First page" },
				{ pageNumber: 2, width: 300, height: 400, text: "Second page" },
			],
		});
	});

	it("normalizes whitespace without removing newlines", () => {
		expect(service().cleanUpContent(" a\t\tb \u0000\u0007\n c  \r\n\t")).toBe(
			"a b\n c"
		);
	});

	it("rejects empty and non-PDF binary inputs before extraction", async () => {
		await expect(service().convertPdfToText(Buffer.alloc(0))).rejects.toThrow(
			"PDF input is empty"
		);
		await expect(service().convertPdfToText(Buffer.from("not a pdf"))).rejects.toThrow(
			"PDF input is not a supported PDF document"
		);
		expect(getDocumentProxyMock).not.toHaveBeenCalled();
	});

	it("rejects path, URL, data URL, and MIME wrapper payloads before extraction", async () => {
		const hostilePayloads = [
			"/tmp/report.pdf",
			"file:///etc/passwd",
			"https://example.com/report.pdf",
			"data:application/pdf;base64,JVBERi0xLjcK",
			new URL("file:///tmp/report.pdf"),
			{ contentType: "application/pdf", data: validPdfBuffer() },
			{ mimeType: "application/json", buffer: Buffer.from("{}") },
		];

		for (const payload of hostilePayloads) {
			await expect(service().convertPdfToText(payload as never)).rejects.toThrow(
				"PDF input must be a Buffer or Uint8Array"
			);
		}
		expect(getDocumentProxyMock).not.toHaveBeenCalled();
	});

	it("does not impose a semantic page-count ceiling", async () => {
		const pageCount = 2_049;
		const pdf = makeDeclaredPdf(pageCount);
		getDocumentProxyMock.mockResolvedValue(pdf);

		await expect(service().convertPdfToText(validPdfBuffer())).resolves.toBe(
			Array.from({ length: pageCount }, () => "p").join("\n"),
		);
		expect(pdf.getPage).toHaveBeenCalledTimes(pageCount);
	});

	it.each([
		Number.POSITIVE_INFINITY,
		1e20,
		0,
		-1,
		1.5,
		Number.NaN,
	])("rejects a hostile declared page count before getPage: %s", async (numPages) => {
		const pdf = makeDeclaredPdf(1);
		pdf.numPages = numPages as number;
		getDocumentProxyMock.mockResolvedValue(pdf);

		await expect(service().convertPdfToText(validPdfBuffer())).rejects.toThrow(
			"PDF page count must be a positive safe integer",
		);
		expect(pdf.getPage).not.toHaveBeenCalled();
	});


	it("renders and vision-reconciles every page while accounting for blank pages", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf([
				{ items: [{ str: "Native one" }] },
				{ items: [{ str: "Native two" }], operators: [85] },
				{ items: [], operators: [42] },
				{ items: [] },
			]),
		);
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({ title: "page 1", description: "Vision one" })
			.mockResolvedValueOnce({ title: "page 2", description: "Vision two" })
			.mockResolvedValueOnce({ title: "page 3", description: "Vision three" })
			.mockResolvedValueOnce({ title: "page 4", description: "[BLANK PAGE]" });
		const completed: number[] = [];

		const result = await service({ useModel }).extractCompleteDocument(
			validPdfBuffer(),
			{ onPageComplete: (page) => completed.push(page.pageNumber) },
		);

		expect(result.complete).toBe(true);
		expect(result.pageCount).toBe(4);
		expect(result.pages.map((page) => page.method)).toEqual([
			"native+vision",
			"native+vision",
			"vision",
			"blank",
		]);
		expect(result.text).toContain(
			"--- Page 1 ---\nNative one\n\n[Rendered-page transcription and visual context]\nVision one",
		);
		expect(result.text).toContain(
			"Native two\n\n[Rendered-page transcription and visual context]\nVision two",
		);
		expect(result.text).toContain(
			"--- Page 3 ---\n[Rendered-page transcription and visual context]\nVision three",
		);
		expect(result.text).toContain(
			"--- Page 4 ---\n[Rendered-page transcription and visual context]\n[BLANK PAGE]",
		);
		expect(completed).toEqual([1, 2, 3, 4]);
		expect(renderPageAsImageMock).toHaveBeenCalledTimes(4);
		expect(useModel).toHaveBeenCalledTimes(4);
		expect(useModel).toHaveBeenNthCalledWith(
			1,
			"IMAGE_DESCRIPTION",
			expect.objectContaining({
				prompt: expect.stringContaining('Native flattened text evidence: "Native one"'),
			}),
		);
	});

	it("rejects the complete document when one required vision page fails", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf([
				{ items: [{ str: "first" }] },
				{ items: [], operators: [85] },
				{ items: [{ str: "never reached" }] },
			]),
		);
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({ title: "page 1", description: "first" })
			.mockRejectedValueOnce(new Error("vision unavailable"));

		await expect(
			service({ useModel }).extractCompleteDocument(validPdfBuffer()),
		).rejects.toMatchObject({
      code: "PDF_PAGE_TRANSCRIPTION_UNAVAILABLE",
      context: { pageNumber: 2, pageCount: 3 },
      cause: expect.objectContaining({ message: "vision unavailable" }),
    });
    expect(useModel).toHaveBeenCalledTimes(2);
	});

	it("preserves OCR text alongside native and vision page evidence", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf([
				{
					items: [
						{
							str: "Native label",
							transform: [1, 0, 0, 1, 72, 700],
							width: 80,
							height: 12,
						},
					],
					operators: [85],
				},
			]),
		);
		const ocrPage = vi.fn(async () => "OCR table cell");
		const useModel = vi.fn(async () => ({
			title: "page",
			description: "Vision layout",
		}));

		const result = await service({ useModel }).extractCompleteDocument(validPdfBuffer(), {
			ocrPage,
		});
		expect(result.pages[0]).toMatchObject({
			nativeText: "Native label",
			nativePositionedText: [
				{
					page: 1,
					text: "Native label",
					x: 72,
					y: 700,
					width: 80,
					height: 12,
				},
			],
			ocrText: "OCR table cell",
			visionText: "Vision layout",
		});
		expect(result.text).toContain("[Rendered-page OCR]\nOCR table cell");
		expect(result.text).toContain(
			"[Rendered-page transcription and visual context]\nVision layout",
		);
		expect(ocrPage).toHaveBeenCalledWith(
			expect.objectContaining({ pageNumber: 1 }),
		);
		expect(useModel).toHaveBeenCalledWith(
			"IMAGE_DESCRIPTION",
			expect.objectContaining({
				prompt: expect.stringContaining('OCR evidence: "OCR table cell"'),
			}),
		);
	});

	it("rejects a blank vision result that conflicts with native evidence", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf([{ items: [{ str: "Native content" }] }]),
		);
		const useModel = vi.fn(async () => ({
			title: "page",
			description: "[BLANK PAGE]",
		}));

		await expect(
			service({ useModel }).extractCompleteDocument(validPdfBuffer()),
		).rejects.toThrow(
			"Complete PDF extraction failed on page 1 of 1: IMAGE_DESCRIPTION reported a blank page that conflicts with native or OCR evidence",
		);
	});

	it("returns structured validation errors for malformed option-based inputs", async () => {
		await expect(service().convertPdfToTextWithOptions(Buffer.from("data"))).resolves.toEqual({
			success: false,
			error: "PDF input is not a supported PDF document",
		});
		expect(getDocumentProxyMock).not.toHaveBeenCalled();
	});

	it.each([
		[{ startPage: 0 }, "startPage must be a positive finite integer"],
		[{ startPage: 1.5 }, "startPage must be a positive finite integer"],
		[{ startPage: Number.NaN }, "startPage must be a positive finite integer"],
		[{ endPage: Number.POSITIVE_INFINITY }, "endPage must be a positive finite integer"],
	])("returns structured errors for hostile extraction options %#", async (options, error) => {
		getDocumentProxyMock.mockResolvedValue(makePdf([{ items: [{ str: "one" }] }]));

		await expect(
			service().convertPdfToTextWithOptions(validPdfBuffer(), options)
		).resolves.toEqual({
			success: false,
			error,
		});
	});

	it("rejects an in-range startPage with an explicit endPage below it", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf([
				{ items: [{ str: "one" }] },
				{ items: [{ str: "two" }] },
				{ items: [{ str: "three" }] },
			])
		);

		await expect(
			service().convertPdfToTextWithOptions(validPdfBuffer(), { startPage: 3, endPage: 2 })
		).resolves.toEqual({
			success: false,
			error: "endPage must be greater than or equal to startPage",
		});
	});

	it("omits invalid metadata dates instead of returning Invalid Date objects", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf([{ items: [{ str: "content" }] }], {
				CreationDate: "not-a-date",
				ModDate: "D:20240203040506Z",
			})
		);

		const info = await service().getDocumentInfo(validPdfBuffer());

		expect(info.metadata.creationDate).toBeUndefined();
		expect(info.metadata.modificationDate).toEqual(new Date("2024-02-03T04:05:06.000Z"));
	});

	it("parses PDF-spec `D:` dates and applies the declared UT offset", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf([{ items: [{ str: "content" }] }], {
				// Full UTC form and an offset form with the apostrophe separators.
				CreationDate: "D:20240102030405Z",
				ModDate: "D:20200610093121-05'00'",
			})
		);

		const info = await service().getDocumentInfo(validPdfBuffer());

		expect(info.metadata.creationDate).toBeInstanceOf(Date);
		expect(info.metadata.creationDate?.toISOString()).toBe("2024-01-02T03:04:05.000Z");
		// Local 09:31:21 at UTC-05:00 becomes 14:31:21Z.
		expect(info.metadata.modificationDate?.toISOString()).toBe("2020-06-10T14:31:21.000Z");
	});

	it("defaults omitted `D:` date components and clamps out-of-range parts", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf([{ items: [{ str: "content" }] }], {
				// Year only with an explicit UTC relation: month/day default to 1,
				// time to 00:00:00Z.
				CreationDate: "D:2024Z",
				// Out-of-range month (13) and day (40) clamp to defaults, not overflow.
				ModDate: "D:20241340Z",
			})
		);

		const info = await service().getDocumentInfo(validPdfBuffer());

		expect(info.metadata.creationDate?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
		expect(info.metadata.modificationDate?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
	});

	it("treats a `D:` date with an omitted UT relation as local time, not UTC", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf([{ items: [{ str: "content" }] }], {
				// No trailing UT relation: PDF Reference 3.8.3 leaves the zone unknown
				// and the components are local time. The parser must not fabricate a
				// `Z` UTC claim, so the wall-clock is read back through local getters
				// (time-zone independent) rather than asserting an absolute UTC instant.
				CreationDate: "D:20240102030405",
				ModDate: "D:20200610093121",
			})
		);

		const info = await service().getDocumentInfo(validPdfBuffer());

		const creation = info.metadata.creationDate;
		expect(creation).toBeInstanceOf(Date);
		expect(creation?.getFullYear()).toBe(2024);
		expect(creation?.getMonth()).toBe(0);
		expect(creation?.getDate()).toBe(2);
		expect(creation?.getHours()).toBe(3);
		expect(creation?.getMinutes()).toBe(4);
		expect(creation?.getSeconds()).toBe(5);
		// The wall-clock is preserved as local time; it is not silently pinned to
		// the same numbers in UTC unless the host itself runs in UTC.
		if (creation && creation.getTimezoneOffset() !== 0) {
			expect(creation.toISOString()).not.toBe("2024-01-02T03:04:05.000Z");
		}

		const modification = info.metadata.modificationDate;
		expect(modification?.getFullYear()).toBe(2020);
		expect(modification?.getMonth()).toBe(5);
		expect(modification?.getDate()).toBe(10);
		expect(modification?.getHours()).toBe(9);
		expect(modification?.getMinutes()).toBe(31);
		expect(modification?.getSeconds()).toBe(21);
	});

	it("omits an unparseable `D:` string rather than surfacing an Invalid Date", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf([{ items: [{ str: "content" }] }], {
				CreationDate: "D:notadate",
				ModDate: "D:",
			})
		);

		const info = await service().getDocumentInfo(validPdfBuffer());

		expect(info.metadata.creationDate).toBeUndefined();
		expect(info.metadata.modificationDate).toBeUndefined();
	});

	it("accepts PDF headers after leading transport bytes within the scan window", async () => {
		getDocumentProxyMock.mockResolvedValue(makePdf([{ items: [{ str: "offset header" }] }]));
		const prefixedPdf = Buffer.concat([Buffer.from([0, 1, 2]), validPdfBuffer()]);

		await expect(service().convertPdfToText(prefixedPdf)).resolves.toBe("offset header");
	});

	it("handles missing or null metadata info objects without throwing", async () => {
		getDocumentProxyMock.mockResolvedValue({
			numPages: 1,
			getPage: vi.fn(async () => ({
				getTextContent: vi.fn(async () => ({ items: [{ str: "hello" }] })),
				getViewport: vi.fn(() => ({ width: 100, height: 200 })),
			})),
			getMetadata: vi.fn(async () => ({ info: undefined })),
		});

		const info = await service().getDocumentInfo(validPdfBuffer());
		expect(info.pageCount).toBe(1);
		expect(info.metadata.title).toBeUndefined();
		expect(info.metadata.creationDate).toBeUndefined();
	});

	it("omits null metadata creationDate instead of returning epoch 1970 date", async () => {
		getDocumentProxyMock.mockResolvedValue({
			numPages: 1,
			getPage: vi.fn(async () => ({
				getTextContent: vi.fn(async () => ({ items: [{ str: "hello" }] })),
				getViewport: vi.fn(() => ({ width: 100, height: 200 })),
			})),
			getMetadata: vi.fn(async () => ({
				info: { CreationDate: null as unknown as string, Title: 123 as unknown as string },
			})),
		});

		const info = await service().getDocumentInfo(validPdfBuffer());
		expect(info.metadata.creationDate).toBeUndefined();
		expect(info.metadata.title).toBeUndefined();
	});

	it("omits non-string metadata dates instead of coercing fabricated epochs", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf([{ items: [{ str: "hello" }] }], {
				CreationDate: 0,
				ModDate: false,
				Title: 123,
				Author: { name: "Ada" },
			})
		);

		const info = await service().getDocumentInfo(validPdfBuffer());
		expect(info.metadata).toEqual({
			title: undefined,
			author: undefined,
			subject: undefined,
			keywords: undefined,
			creator: undefined,
			producer: undefined,
			creationDate: undefined,
			modificationDate: undefined,
		});
	});

	it("accepts finite Date metadata objects and omits invalid Date objects", async () => {
		const creationDate = new Date("2024-03-04T05:06:07.000Z");
		getDocumentProxyMock.mockResolvedValue(
			makePdf([{ items: [{ str: "hello" }] }], {
				CreationDate: creationDate,
				ModDate: new Date(Number.NaN),
			})
		);

		const info = await service().getDocumentInfo(validPdfBuffer());
		expect(info.metadata.creationDate).toBe(creationDate);
		expect(info.metadata.modificationDate).toBeUndefined();
	});

	it.each([null, undefined, {}, "not-an-array", 42])(
		"fails explicitly when unpdf returns non-array text items: %j",
		async (items) => {
			getDocumentProxyMock.mockResolvedValue(makePdf([{ items }]));
			await expect(service().convertPdfToText(validPdfBuffer())).rejects.toThrow(
				"PDF text content items must be an array"
			);

			getDocumentProxyMock.mockResolvedValue(makePdf([{ items }]));
			await expect(
				service().convertPdfToTextWithOptions(validPdfBuffer())
			).resolves.toEqual({
				success: false,
				error: "PDF text content items must be an array",
			});

			getDocumentProxyMock.mockResolvedValue(makePdf([{ items }]));
			await expect(service().getDocumentInfo(validPdfBuffer())).rejects.toThrow(
				"PDF text content items must be an array"
			);
		}
	);

	it("fails cleanup on malformed caller input instead of returning uncleaned content", () => {
		expect(() => service().cleanUpContent(null as never)).toThrow();
	});
});
