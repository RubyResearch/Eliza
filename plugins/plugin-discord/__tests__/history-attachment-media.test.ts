/** A history read lists attachments by identity and kind; it never runs the vision or transcription models. */
import { ContentType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { historyAttachmentMedia } from "../service";

describe("historyAttachmentMedia", () => {
	it("maps Discord attachments to unprocessed media records by mime kind", () => {
		const media = historyAttachmentMedia([
			{
				id: "1",
				url: "https://cdn/1.png",
				name: "shot.png",
				contentType: "image/png",
			},
			{
				id: "2",
				url: "https://cdn/2.mp4",
				name: "clip.mp4",
				contentType: "video/mp4",
			},
			{
				id: "3",
				url: "https://cdn/3.mp3",
				name: null,
				contentType: "audio/mpeg",
			},
			{ id: "4", url: "https://cdn/4.pdf", name: "doc.pdf", contentType: null },
		]);
		expect(media.map((entry) => entry.contentType)).toEqual([
			ContentType.IMAGE,
			ContentType.VIDEO,
			ContentType.AUDIO,
			ContentType.DOCUMENT,
		]);
		expect(media[2]?.title).toBe("attachment");
		expect(
			media.every((entry) => entry.description === "" && entry.text === ""),
		).toBe(true);
	});
});
