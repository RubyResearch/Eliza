/**
 * Safety gates around interaction delivery negotiation that the existing
 * profile suites leave unpinned: the signed-hosted URL checks, the guarantee
 * that a `secret` block never leaves the sensitive path, and the registry's
 * copy-on-read.
 *
 * The signed-hosted URL is what a connector is told to send a user to, so
 * "https only, no embedded credentials, no fragment, parses at all" is a
 * security boundary rather than tidiness. Each condition is asserted on its
 * own — a single "rejects a bad URL" case would let four of the five be
 * deleted silently.
 */

import { describe, expect, it } from "vitest";
import type {
	ChoiceInteraction,
	FormInteraction,
	SecretInteraction,
} from "../../types/interactions";
import {
	BUTTON_INTERACTION_PROFILE,
	RICH_INTERACTION_PROFILE,
} from "./profile-catalog";
import {
	ConnectorInteractionProfileRegistry,
	createConnectorInteractionCapabilityProfile,
	negotiateInteractionDelivery,
} from "./profiles";

function profile(template = RICH_INTERACTION_PROFILE) {
	return createConnectorInteractionCapabilityProfile({
		template,
		source: "connector",
		accountId: "account-a",
		targetKind: "room",
		targetId: "room-a",
	});
}

/** A choice too wide for any native surface, so negotiation must fall back. */
const wideChoice: ChoiceInteraction = {
	kind: "choice",
	id: "wide-1",
	scope: "approval",
	// Past the RICH profile's 100-item list and 100-button ceilings, so the
	// native mode always carries a limitation and negotiation must fall back.
	options: Array.from({ length: 150 }, (_, index) => ({
		value: `option-${index}`,
		label: `Option ${index}`,
	})),
};

function negotiateWith(signedHostedUrl: string | undefined, verified = true) {
	return negotiateInteractionDelivery(wideChoice, profile(), {
		signedHostedUrl,
		signedHostedUrlVerified: verified,
	});
}

/** The signed-hosted mode is unusable, so negotiation lands elsewhere or throws. */
function hostedWasRejected(url: string | undefined, verified = true): boolean {
	try {
		return negotiateWith(url, verified).mode !== "signed-hosted";
	} catch {
		return true;
	}
}

describe("signed-hosted URL safety gate", () => {
	it("accepts a well-formed https URL as the fallback", () => {
		const result = negotiateWith("https://example.test/interaction/abc");
		expect(result.mode).toBe("signed-hosted");
		expect(result.reason).toBe("native-limit");
	});

	it("rejects a non-https scheme", () => {
		// http is the one that matters; the others confirm it is a scheme
		// allowlist and not a "not javascript:" denylist.
		for (const url of [
			"http://example.test/interaction/abc",
			"ftp://example.test/interaction/abc",
			"data:text/html,hi",
		]) {
			expect(hostedWasRejected(url)).toBe(true);
		}
	});

	it("rejects credentials embedded in the URL", () => {
		expect(hostedWasRejected("https://user@example.test/abc")).toBe(true);
		expect(hostedWasRejected("https://user:pass@example.test/abc")).toBe(true);
		expect(hostedWasRejected("https://:pass@example.test/abc")).toBe(true);
	});

	it("rejects a fragment", () => {
		// A fragment never reaches the server, so anything relying on it is
		// either a client-side redirect trick or a signature that is not covered.
		expect(hostedWasRejected("https://example.test/abc#token")).toBe(true);
		expect(hostedWasRejected("https://example.test/abc#")).toBe(false);
	});

	it("rejects a URL that does not parse at all", () => {
		expect(hostedWasRejected("not a url")).toBe(true);
		expect(hostedWasRejected("https://")).toBe(true);
	});

	it("requires the host to have verified the URL", () => {
		expect(hostedWasRejected("https://example.test/abc", false)).toBe(true);
	});

	it("rejects an absent URL", () => {
		expect(hostedWasRejected(undefined)).toBe(true);
	});

	it("is unavailable when the profile does not support links at all", () => {
		// Every catalog template supports links, so this one is built: with link
		// support withdrawn, signed-hosted can never apply no matter how good
		// the URL is.
		const noLinks = profile({
			...RICH_INTERACTION_PROFILE,
			templateId: "rich-no-links-v1",
			limits: {
				...RICH_INTERACTION_PROFILE.limits,
				links: { supported: false, maxUrlBytes: 0 },
			},
		});
		const result = negotiateInteractionDelivery(wideChoice, noLinks, {
			signedHostedUrl: "https://example.test/interaction/abc",
			signedHostedUrlVerified: true,
		});
		expect(result.mode).not.toBe("signed-hosted");
	});

	it("forbids a link byte cap that disagrees with link support", () => {
		// This invariant is why the `links.supported` early return cannot be
		// isolated by a test: a profile with links unsupported is *required* to
		// carry maxUrlBytes 0, so the byte cap already rejects every URL.
		expect(() =>
			profile({
				...RICH_INTERACTION_PROFILE,
				templateId: "rich-bad-links-v1",
				limits: {
					...RICH_INTERACTION_PROFILE.limits,
					links: { supported: false, maxUrlBytes: 2_048 },
				},
			}),
		).toThrow(/must be zero when unsupported/i);
	});
});

describe("secret blocks never leave the sensitive path", () => {
	const secret: SecretInteraction = {
		kind: "secret",
		id: "secret-1",
		secretKind: "secret",
		fields: [{ name: "token", label: "Token", type: "secret" }],
	};

	it("routes to sensitive-request regardless of what the profile supports", () => {
		for (const template of [
			RICH_INTERACTION_PROFILE,
			BUTTON_INTERACTION_PROFILE,
		]) {
			const result = negotiateInteractionDelivery(secret, profile(template), {
				signedHostedUrl: "https://example.test/interaction/abc",
				signedHostedUrlVerified: true,
			});
			expect(result).toEqual({
				mode: "sensitive-request",
				reason: "sensitive",
				limitations: [],
			});
		}
	});

	it("refuses to carry a secret field on an ordinary form", () => {
		const form: FormInteraction = {
			kind: "form",
			id: "form-1",
			title: "Credentials",
			fields: [
				{ name: "name", label: "Name", type: "text" },
				{ name: "token", label: "Token", type: "secret" },
			],
		};
		expect(() => negotiateInteractionDelivery(form, profile())).toThrow(
			/Secret fields cannot use an ordinary interaction form/i,
		);
	});
});

describe("ConnectorInteractionProfileRegistry copies on read and write", () => {
	it("does not hand out a reference a caller can mutate", () => {
		const registry = new ConnectorInteractionProfileRegistry();
		const registered = registry.register(profile());

		const first = registry.get(registered.profileId);
		expect(first).not.toBeNull();
		(first as { profileId: string }).profileId = "tampered";
		(
			first as { limits: { links: { maxUrlBytes: number } } }
		).limits.links.maxUrlBytes = 1;

		const second = registry.get(registered.profileId);
		expect(second?.profileId).toBe(registered.profileId);
		expect(second?.limits.links.maxUrlBytes).toBe(
			registered.limits.links.maxUrlBytes,
		);
	});

	it("returns null for an unknown profile id", () => {
		expect(
			new ConnectorInteractionProfileRegistry().get("ip1:missing"),
		).toBeNull();
	});
});
