/**
 * STOP is honored only for an actual disengage request; a STOP verdict on a
 * direct request routes on with its plan (live 2026-09-11/12 misfires).
 */
import { describe, expect, it } from "vitest";
import { routeMessageHandlerOutput } from "../message-handler";

function output(processMessage: "RESPOND" | "IGNORE" | "STOP") {
	return {
		processMessage,
		thought: "",
		plan: {
			contexts: ["calendar"],
			intents: ["add calendar event"],
			reply: "",
			replyEffectStatus: "none",
			simple: false,
			requiresTool: true,
			candidateActions: ["CALENDAR_CREATE_EVENT"],
		},
		extract: { facts: [], relationships: [], addressedTo: [], topics: [] },
	} as never;
}

describe("routeMessageHandlerOutput STOP lexicon", () => {
	it("stops when the user actually asked to stop", () => {
		expect(
			routeMessageHandlerOutput(output("STOP"), {
				messageText: "ok stop, leave me alone for a bit",
			}).type,
		).toBe("stopped");
		expect(routeMessageHandlerOutput(output("STOP"), {}).type).toBe("stopped");
	});

	it("routes a STOP verdict on a direct request onward with its plan", () => {
		const route = routeMessageHandlerOutput(output("STOP"), {
			messageText:
				"add a chiropractor appointment friday at 3pm to my calendar",
		});
		expect(route.type).not.toBe("stopped");
		expect(route.type).not.toBe("ignored");
	});
});
