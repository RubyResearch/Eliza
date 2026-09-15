import { describe, expect, it } from "vitest";
import type { ContextObject } from "../../types/context-object";
import {
	applyHistoryRetentionReview,
	prepareHistoryRetention,
	validateHistoryRetention,
	visibleHistoryEventIds,
} from "../history-retention";

function fixture() {
	const scope = {
		agentId: "agent",
		roomId: "room",
		entityId: "user",
		roles: ["OWNER"],
	};
	const context: ContextObject = {
		id: "retention",
		metadata: { roomId: scope.roomId },
		events: [
			"Require a full preview before saving.",
			"Yes, retain that rule.",
			"hi",
			"Current question",
		].map((content, index) => ({
			id: `history:${index}`,
			type: "segment",
			source: "prior-dialogue",
			segment: {
				id: `history:${index}`,
				label: "prior_message:user",
				content,
				stable: false,
			},
		})),
	};
	const prepared = prepareHistoryRetention(context, scope, null, "evidence", 3);
	const review = {
		sourceSetId: prepared.sourceSetId,
		complete: true,
		retainSourceIds: ["h1"],
		deferSourceIds: ["h2", "h3"],
		uncertainSourceIds: [],
		dependencyGroups: [["h1", "h2"]],
	};
	return { context, scope, prepared, review };
}

describe("history retention dependency closure", () => {
	it("keeps a declared dependency despite a conflicting deferral without changing originals", () => {
		const { context, scope, prepared, review } = fixture();
		const before = structuredClone({ context, review });
		const checkpoint = applyHistoryRetentionReview(prepared, review);
		expect(checkpoint.retainedEventIds).toEqual(["history:0", "history:1"]);
		expect(visibleHistoryEventIds(context, scope, checkpoint)).toContain(
			"history:1",
		);
		expect(validateHistoryRetention(context, scope, checkpoint)).toEqual(
			checkpoint,
		);
		expect({ context, review }).toEqual(before);
		const changed = structuredClone(context);
		changed.events[0] = { ...changed.events[0], createdAt: 99 };
		expect(validateHistoryRetention(changed, scope, checkpoint)).toBeNull();
	});

	it.each([
		{ dependencyGroups: [["h1", "h99"]] },
		{ dependencyGroups: [[]] },
		{ dependencyGroups: [["h1", "h1"]] },
	])(
		"rejects invalid dependency groups $dependencyGroups",
		({ dependencyGroups }) => {
			const { prepared, review } = fixture();
			expect(() =>
				applyHistoryRetentionReview(prepared, { ...review, dependencyGroups }),
			).toThrow();
		},
	);

	it("still rejects stale and incomplete classifications", () => {
		const { prepared, review } = fixture();
		expect(() =>
			applyHistoryRetentionReview(prepared, {
				...review,
				sourceSetId: "stale",
			}),
		).toThrow();
		expect(() =>
			applyHistoryRetentionReview(prepared, {
				...review,
				deferSourceIds: ["h2"],
			}),
		).toThrow();
	});
});
