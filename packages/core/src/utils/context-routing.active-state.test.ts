/**
 * withActiveRoutingContexts: identity when nothing is added; a widened copy
 * whose routing state carries the admitted contexts otherwise.
 */
import { describe, expect, it } from "vitest";
import type { Memory } from "../types/memory";
import type { State } from "../types/state";
import {
	CONTEXT_ROUTING_STATE_KEY,
	getActiveRoutingContextsForTurn,
	withActiveRoutingContexts,
} from "./context-routing";

const message = { content: { text: "read #general" } } as Memory;

describe("withActiveRoutingContexts", () => {
	it("returns the same state when nothing is added", () => {
		const routed: State = {
			text: "",
			data: {},
			values: {
				[CONTEXT_ROUTING_STATE_KEY]: {
					primaryContext: "general",
					secondaryContexts: ["messaging"],
				},
			},
		};
		expect(withActiveRoutingContexts(routed, message, ["messaging"])).toBe(
			routed,
		);
		expect(withActiveRoutingContexts(routed, message, [])).toBe(routed);
		expect(withActiveRoutingContexts(undefined, message, ["messaging"])).toBe(
			undefined,
		);
	});

	it("adds the admitted contexts to the routing state without changing the primary context (live: MESSAGE on a general-routed turn)", () => {
		const routed: State = {
			text: "",
			data: {},
			values: {
				[CONTEXT_ROUTING_STATE_KEY]: { primaryContext: "general" },
			},
		};
		const widened = withActiveRoutingContexts(routed, message, [
			"general",
			"messaging",
		]);
		expect(widened).not.toBe(routed);
		expect(getActiveRoutingContextsForTurn(widened, message)).toEqual(
			expect.arrayContaining(["general", "messaging"]),
		);
		expect(widened?.values[CONTEXT_ROUTING_STATE_KEY]).toEqual({
			primaryContext: "general",
			secondaryContexts: ["messaging"],
		});
		// The caller's state is untouched.
		expect(getActiveRoutingContextsForTurn(routed, message)).toEqual([
			"general",
		]);
	});

	it("seeds routing from an empty state so hasActionContext can overlap (Stage-1 catalog time)", () => {
		const empty: State = { text: "", data: {}, values: {} };
		const widened = withActiveRoutingContexts(empty, message, ["messaging"]);
		expect(getActiveRoutingContextsForTurn(widened, message)).toEqual(
			expect.arrayContaining(["messaging", "general"]),
		);
	});
});
