/** Resolves independent agent and chat discovery pins without changing document read authority. */
import { ElizaError } from "../../errors";
import type { Memory, UUID } from "../../types";

export interface DocumentPinTargets {
	agent: boolean;
	roomIds: UUID[];
}

export function validateDocumentPinTargets(value: unknown): DocumentPinTargets {
	const invalid = (): never => {
		throw new ElizaError(
			"Choose an agent pin and valid, distinct chat identifiers",
			{ code: "DOCUMENT_PIN_TARGETS_INVALID" },
		);
	};
	if (value === null || typeof value !== "object") return invalid();
	const agent = Reflect.get(value, "agent");
	const ids = Reflect.get(value, "roomIds");
	if (typeof agent !== "boolean" || !Array.isArray(ids)) return invalid();
	const roomIds: UUID[] = [];
	for (const id of ids) {
		if (
			typeof id !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
				id,
			)
		)
			return invalid();
		const normalized = id.toLowerCase() as UUID;
		if (roomIds.includes(normalized)) return invalid();
		roomIds.push(normalized);
	}
	return { agent, roomIds: roomIds.sort() };
}

export function documentPinTargets(document: Memory): DocumentPinTargets {
	const metadata = document.metadata;
	if (metadata && "pinTargets" in metadata && metadata.pinTargets !== undefined)
		return validateDocumentPinTargets(metadata.pinTargets);
	return {
		agent:
			metadata !== undefined &&
			"pinned" in metadata &&
			metadata.pinned === true,
		roomIds: [],
	};
}

export function isDocumentPinnedForRoom(
	document: Memory,
	roomId?: UUID,
): boolean {
	const targets = documentPinTargets(document);
	return (
		targets.agent || (roomId !== undefined && targets.roomIds.includes(roomId))
	);
}
