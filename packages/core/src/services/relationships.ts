/**
 * RelationshipsService: the runtime's long-lived contact and relationship store.
 * Owns per-agent contacts (CRUD, platform handles, interaction history,
 * relationship goals and followup cadence, cross-platform import), relationship
 * analytics and strength scoring, strengthened identity records
 * (`entity_identities`) with confidence-based auto-merge candidates
 * (`entity_merge_candidates`), and identity-cluster resolution via union-find.
 * Graph snapshot and person-detail assembly are delegated to the graph builder.
 * Consumed by relationships providers/actions, LifeOps, and the dashboard.
 */
import { sql } from "drizzle-orm";
import { ElizaError } from "../errors";
import { logger } from "../logger";
import type { Component, Entity, Relationship } from "../types/environment";
import type {
	ChannelType,
	JsonValue,
	Metadata,
	MetadataValue,
	UUID,
} from "../types/primitives";
import { asUUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import { Service } from "../types/service";
import { stringToUuid } from "../utils";
import { UnionFind } from "../utils/union-find";
import {
	createNativeRelationshipsGraphService,
	type GraphResolvers,
	type RelationshipsGraphQuery,
	type RelationshipsGraphService,
	type RelationshipsGraphSnapshot,
	type RelationshipsPersonDetail,
} from "./relationships-graph-builder";

/**
 * Handles on these platforms are enrichment (phone/email/website) — they
 * identify *contact methods* a person has shared with us, not a separate
 * identity we'd confuse with another person. Keep in sync with the runtime-
 * level CONTACT_PLATFORM_SET in agent/src/services/relationships-graph.ts.
 */
const CONTACT_HANDLE_PLATFORMS = new Set(["email", "phone", "website"]);
const RELATIONSHIP_MESSAGE_PAGE_SIZE = 200;

async function getAllRelationshipMessages(
	runtime: IAgentRuntime,
	roomIds: UUID[],
): Promise<Awaited<ReturnType<IAgentRuntime["getMemoriesByRoomIds"]>>> {
	const messages: Awaited<ReturnType<IAgentRuntime["getMemoriesByRoomIds"]>> =
		[];
	const seenMemoryIds = new Set<UUID>();
	for (let offset = 0; ; offset += RELATIONSHIP_MESSAGE_PAGE_SIZE) {
		const page = await runtime.getMemoriesByRoomIds({
			tableName: "messages",
			roomIds,
			limit: RELATIONSHIP_MESSAGE_PAGE_SIZE,
			offset,
		});
		const pageIds = page.flatMap((memory) => (memory.id ? [memory.id] : []));
		if (
			page.length === RELATIONSHIP_MESSAGE_PAGE_SIZE &&
			pageIds.length === page.length &&
			pageIds.every((id) => seenMemoryIds.has(id))
		) {
			throw new ElizaError("Relationship message pagination made no progress", {
				code: "RELATIONSHIP_MESSAGE_PAGINATION_STALLED",
				context: { offset, pageSize: RELATIONSHIP_MESSAGE_PAGE_SIZE },
				severity: "fatal",
			});
		}
		for (const id of pageIds) seenMemoryIds.add(id);
		messages.push(...page);
		if (page.length < RELATIONSHIP_MESSAGE_PAGE_SIZE) return messages;
	}
}

function isConfirmedIdentityLinkLike(relationship: Relationship): boolean {
	const tags = relationship.tags;
	if (!Array.isArray(tags) || !tags.includes("identity_link")) {
		return false;
	}
	const metadata = relationship.metadata;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return false;
	}
	const status = (metadata as Record<string, unknown>).status;
	return typeof status === "string" && status === "confirmed";
}

interface ExtendedRelationship extends Relationship {
	relationshipType?: string;
	strength?: number;
	lastInteractionAt?: string;
	nextFollowUpAt?: string;
}

export interface ContactCategory {
	id: string;
	name: string;
	description?: string;
	color?: string;
}

export interface ContactPreferences {
	preferredCommunicationChannel?: string;
	timezone?: string;
	language?: string;
	contactFrequency?: "daily" | "weekly" | "monthly" | "quarterly";
	doNotDisturb?: boolean;
	notes?: string;
	/** Index signature for metadata compatibility */
	[key: string]: string | boolean | undefined;
}

export interface ContactHandle {
	id: UUID;
	platform: string;
	identifier: string;
	displayLabel?: string;
	isPrimary?: boolean;
	addedAt: string;
}

export type InteractionDirection = "inbound" | "outbound";

export interface ContactInteraction {
	id: UUID;
	platform: string;
	direction: InteractionDirection;
	summary?: string;
	externalRef?: string;
	occurredAt: string;
}

export interface RelationshipGoal {
	goalText: string;
	targetCadenceDays?: number;
	setAt: string;
}

export type RelationshipStatus =
	| "active"
	| "dormant"
	| "archived"
	| "blocked"
	| "unknown";

export interface ContactInfo {
	entityId: UUID;
	categories: string[];
	tags: string[];
	preferences: ContactPreferences;
	customFields: Record<string, JsonValue>;
	privacyLevel: "public" | "private" | "restricted";
	lastModified: string;
	handles: ContactHandle[];
	interactions: ContactInteraction[];
	followupThresholdDays?: number;
	lastInteractionAt?: string;
	relationshipGoal?: RelationshipGoal;
	relationshipStatus: RelationshipStatus;
}

interface RecordInteractionInput {
	contactId: UUID;
	platform: string;
	direction: InteractionDirection;
	summary?: string;
	externalRef?: string;
	occurredAt?: string;
}

interface ListOverdueOptions {
	asOfMs?: number;
	defaultThresholdDays?: number;
}

export interface OverdueFollowup {
	contact: ContactInfo;
	daysSinceInteraction: number;
	thresholdDays: number;
}

export interface RelationshipProgress {
	contactId: UUID;
	goal: RelationshipGoal | null;
	lastInteractionAt: string | null;
	cadenceHealth: "on-track" | "due" | "overdue" | "never-contacted" | "no-goal";
	daysSinceInteraction: number | null;
	targetCadenceDays: number | null;
}

export interface PlatformContactSeed {
	platform: string;
	identifier: string;
	displayName?: string;
	displayLabel?: string;
	categories?: string[];
	tags?: string[];
	notes?: string;
}

export interface PlatformImportResult {
	imported: ContactInfo[];
	linkedToExisting: ContactInfo[];
	skipped: Array<{ seed: PlatformContactSeed; reason: string }>;
}

function getContactDisplayName(contactInfo: ContactInfo): string | null {
	const displayName = contactInfo.customFields.displayName;
	return typeof displayName === "string" && displayName.trim().length > 0
		? displayName.trim()
		: null;
}

/** Helper to convert ContactInfo to Metadata for storage */
function contactInfoToMetadata(contactInfo: ContactInfo): Metadata {
	return {
		entityId: contactInfo.entityId,
		categories: contactInfo.categories,
		tags: contactInfo.tags,
		preferences: contactInfo.preferences as MetadataValue,
		customFields: contactInfo.customFields,
		privacyLevel: contactInfo.privacyLevel,
		lastModified: contactInfo.lastModified,
		handles: contactInfo.handles.map((handle) => ({ ...handle })),
		interactions: contactInfo.interactions.map((interaction) => ({
			...interaction,
		})),
		followupThresholdDays: contactInfo.followupThresholdDays,
		lastInteractionAt: contactInfo.lastInteractionAt,
		relationshipGoal: contactInfo.relationshipGoal
			? { ...contactInfo.relationshipGoal }
			: undefined,
		relationshipStatus: contactInfo.relationshipStatus,
	};
}

function parseHandles(value: MetadataValue | undefined): ContactHandle[] {
	if (!Array.isArray(value)) return [];
	const out: ContactHandle[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const record = item as { [key: string]: MetadataValue | undefined };
		const id = record.id;
		const platform = record.platform;
		const identifier = record.identifier;
		const addedAt = record.addedAt;
		if (
			typeof id !== "string" ||
			typeof platform !== "string" ||
			typeof identifier !== "string" ||
			typeof addedAt !== "string"
		) {
			continue;
		}
		const displayLabel =
			typeof record.displayLabel === "string" ? record.displayLabel : undefined;
		const isPrimary =
			typeof record.isPrimary === "boolean" ? record.isPrimary : undefined;
		out.push({
			id: id as UUID,
			platform,
			identifier,
			displayLabel,
			isPrimary,
			addedAt,
		});
	}
	return out;
}

function parseInteractions(
	value: MetadataValue | undefined,
): ContactInteraction[] {
	if (!Array.isArray(value)) return [];
	const out: ContactInteraction[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const record = item as { [key: string]: MetadataValue | undefined };
		const id = record.id;
		const platform = record.platform;
		const direction = record.direction;
		const occurredAt = record.occurredAt;
		if (
			typeof id !== "string" ||
			typeof platform !== "string" ||
			(direction !== "inbound" && direction !== "outbound") ||
			typeof occurredAt !== "string"
		) {
			continue;
		}
		const summary =
			typeof record.summary === "string" ? record.summary : undefined;
		const externalRef =
			typeof record.externalRef === "string" ? record.externalRef : undefined;
		out.push({
			id: id as UUID,
			platform,
			direction,
			summary,
			externalRef,
			occurredAt,
		});
	}
	return out;
}

function parseRelationshipGoal(
	value: MetadataValue | undefined,
): RelationshipGoal | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as { [key: string]: MetadataValue | undefined };
	const goalText = record.goalText;
	const setAt = record.setAt;
	if (typeof goalText !== "string" || typeof setAt !== "string") {
		return undefined;
	}
	const targetCadenceDays =
		typeof record.targetCadenceDays === "number"
			? record.targetCadenceDays
			: undefined;
	return { goalText, setAt, targetCadenceDays };
}

function parseRelationshipStatus(
	value: MetadataValue | undefined,
): RelationshipStatus {
	if (
		value === "active" ||
		value === "dormant" ||
		value === "archived" ||
		value === "blocked" ||
		value === "unknown"
	) {
		return value;
	}
	return "active";
}

/** Helper to convert Metadata back to ContactInfo */
function metadataToContactInfo(data: Metadata): ContactInfo {
	return {
		entityId: data.entityId as UUID,
		categories: (data.categories as string[]) ?? [],
		tags: (data.tags as string[]) ?? [],
		preferences: (data.preferences as ContactPreferences) ?? {},
		customFields: (data.customFields as Record<string, JsonValue>) ?? {},
		privacyLevel: data.privacyLevel as "public" | "private" | "restricted",
		lastModified: data.lastModified as string,
		handles: parseHandles(data.handles),
		interactions: parseInteractions(data.interactions),
		followupThresholdDays:
			typeof data.followupThresholdDays === "number"
				? data.followupThresholdDays
				: undefined,
		lastInteractionAt:
			typeof data.lastInteractionAt === "string"
				? data.lastInteractionAt
				: undefined,
		relationshipGoal: parseRelationshipGoal(data.relationshipGoal),
		relationshipStatus: parseRelationshipStatus(data.relationshipStatus),
	};
}

export interface RelationshipAnalytics {
	strength: number;
	interactionCount: number;
	sharedConversationWindows?: number;
	lastInteractionAt?: string;
	averageResponseTime?: number;
	sentimentScore?: number;
	topicsDiscussed: string[];
}

/**
 * Strengthened identity record persisted in `entity_identities`. The legacy
 * `metadata.platformIdentities` array on the entity row is still kept in sync
 * for backwards compatibility with existing UI code paths, but this typed
 * record is the source of truth going forward.
 */
export interface EntityIdentityRecord {
	id: UUID;
	entityId: UUID;
	platform: string;
	handle: string;
	verified: boolean;
	confidence: number;
	source?: string;
	firstSeen: string;
	lastSeen: string;
	evidenceMessageIds: UUID[];
}

/**
 * Lightweight payload accepted by `upsertIdentity`. Mirrors the
 * `PlatformIdentity` shape emitted by the relationship-extraction evaluator.
 */
export interface PlatformIdentityInput {
	platform: string;
	handle: string;
	verified?: boolean;
	confidence: number;
	source?: string;
}

export type MergeCandidateStatus = "pending" | "accepted" | "rejected";

export interface MergeCandidateEvidence {
	platform?: string;
	handle?: string;
	identityIds?: UUID[];
	notes?: string;
	[extra: string]: JsonValue | UUID[] | undefined;
}

export interface MergeCandidateRecord {
	id: UUID;
	entityA: UUID;
	entityB: UUID;
	confidence: number;
	evidence: MergeCandidateEvidence;
	status: MergeCandidateStatus;
	proposedAt: string;
	resolvedAt?: string;
}

const AUTO_MERGE_CONFIDENCE_THRESHOLD = 0.85;
const AUTO_MERGE_MIN_EVIDENCE = 2;

export interface FollowUpSchedule {
	entityId: UUID;
	scheduledAt: string;
	reason: string;
	priority: "high" | "medium" | "low";
	completed: boolean;
	taskId?: UUID;
}

// Entity lifecycle event types
export enum EntityLifecycleEvent {
	CREATED = "entity:created",
	UPDATED = "entity:updated",
	MERGED = "entity:merged",
	RESOLVED = "entity:resolved",
}

export interface EntityEventData {
	entity: Entity;
	previousEntity?: Entity;
	mergedEntities?: Entity[];
	source?: string;
	confidence?: number;
}

/**
 * Sort key for comparators over numbers that may be corrupted upstream. `NaN`
 * (an unparseable timestamp, a missing metric) collapses to 0 so a comparator
 * never returns `NaN` and leaves the array in an arbitrary engine-defined
 * order; `Infinity` is preserved because callers use it as a real "never
 * contacted" extreme.
 */
export function safeSortNumber(value: unknown): number {
	const numeric = typeof value === "number" ? value : Number(value);
	return Number.isNaN(numeric) ? 0 : numeric;
}

/**
 * Calculate relationship strength based on interaction patterns
 */
export function calculateRelationshipStrength({
	interactionCount,
	lastInteractionAt,
	messageQuality = 5,
	relationshipType = "acquaintance",
	sharedConversationWindows = 0,
}: {
	interactionCount: number;
	lastInteractionAt?: string;
	messageQuality?: number;
	relationshipType?: string;
	sharedConversationWindows?: number;
}): number {
	// Base score from interaction count (max 40 points)
	const interactionScore = Math.min(interactionCount * 2, 40);

	// Shared conversation windows in the same room within an hour are a
	// stronger social signal than isolated messages. Cap to avoid swamping
	// explicit relationship/context signals.
	const sharedConversationScore = Math.min(sharedConversationWindows * 4, 16);

	// Recency score (max 30 points)
	let recencyScore = 0;
	if (lastInteractionAt) {
		const daysSinceLastInteraction =
			(Date.now() - new Date(lastInteractionAt).getTime()) /
			(1000 * 60 * 60 * 24);
		if (daysSinceLastInteraction < 1) recencyScore = 30;
		else if (daysSinceLastInteraction < 7) recencyScore = 25;
		else if (daysSinceLastInteraction < 30) recencyScore = 20;
		else if (daysSinceLastInteraction < 90) recencyScore = 10;
		else recencyScore = 5;
	}

	// Quality score (max 20 points)
	const qualityScore = (messageQuality / 10) * 20;

	// Relationship type bonus (max 10 points)
	const relationshipBonus: Record<string, number> = {
		family: 10,
		friend: 8,
		colleague: 6,
		acquaintance: 4,
		unknown: 0,
	};

	// Calculate total strength
	const totalStrength =
		interactionScore +
		recencyScore +
		qualityScore +
		sharedConversationScore +
		(relationshipBonus[relationshipType] ?? 0);

	// Return clamped value between 0 and 100
	return Math.max(0, Math.min(100, Math.round(totalStrength)));
}

type RelationshipMessageLike = {
	entityId?: UUID;
	roomId?: UUID;
	createdAt?: number | string | null;
};

function toMessageTimestamp(
	value: RelationshipMessageLike["createdAt"],
): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
		const dateParsed = Date.parse(value);
		if (Number.isFinite(dateParsed)) {
			return dateParsed;
		}
	}
	return null;
}

export function countSharedConversationWindows(
	messages: RelationshipMessageLike[],
	leftEntityId: UUID,
	rightEntityId: UUID,
	windowMs = 1000 * 60 * 60,
): number {
	const relevantMessages = messages
		.filter(
			(message) =>
				(message.entityId === leftEntityId ||
					message.entityId === rightEntityId) &&
				toMessageTimestamp(message.createdAt) !== null,
		)
		.sort(
			(left, right) =>
				(toMessageTimestamp(left.createdAt) ?? 0) -
				(toMessageTimestamp(right.createdAt) ?? 0),
		);

	if (relevantMessages.length < 2) {
		return 0;
	}

	const rooms = new Map<string, RelationshipMessageLike[]>();
	for (const message of relevantMessages) {
		const roomKey =
			typeof message.roomId === "string" ? message.roomId : "__shared__";
		if (!rooms.has(roomKey)) {
			rooms.set(roomKey, []);
		}
		rooms.get(roomKey)?.push(message);
	}

	let windowCount = 0;
	for (const roomMessages of rooms.values()) {
		let currentWindowStart: number | null = null;
		let seenLeft = false;
		let seenRight = false;

		const flushWindow = () => {
			if (seenLeft && seenRight) {
				windowCount += 1;
			}
			currentWindowStart = null;
			seenLeft = false;
			seenRight = false;
		};

		for (const message of roomMessages) {
			const createdAt = toMessageTimestamp(message.createdAt);
			if (createdAt === null) {
				continue;
			}
			if (
				currentWindowStart === null ||
				createdAt - currentWindowStart > windowMs
			) {
				if (currentWindowStart !== null) {
					flushWindow();
				}
				currentWindowStart = createdAt;
			}

			if (message.entityId === leftEntityId) {
				seenLeft = true;
			}
			if (message.entityId === rightEntityId) {
				seenRight = true;
			}
		}

		if (currentWindowStart !== null) {
			flushWindow();
		}
	}

	return windowCount;
}

export class RelationshipsService extends Service {
	static serviceType = "relationships" as const;

	capabilityDescription =
		"Comprehensive contact and relationship management service";

	// In-memory caches for performance
	private contactInfoCache: Map<UUID, ContactInfo> = new Map();
	private analyticsCache: Map<
		string,
		{ analytics: RelationshipAnalytics; cachedAt: number }
	> = new Map();
	private categoriesCache: ContactCategory[] = [];
	private static readonly CONTACT_CACHE_LIMIT = 2000;
	private static readonly ANALYTICS_CACHE_LIMIT = 2000;

	private graphResolvers: GraphResolvers = {
		resolveOwnerEntityId: async () => null,
		fetchConfiguredOwnerName: async () => null,
	};
	private graphServiceInstance: RelationshipsGraphService | null = null;

	private setCacheWithLimit<K, V>(
		cache: Map<K, V>,
		key: K,
		value: V,
		limit: number,
	): void {
		if (cache.has(key)) {
			cache.delete(key);
		}
		cache.set(key, value);
		if (cache.size > limit) {
			const firstKey = cache.keys().next().value;
			if (firstKey !== undefined) {
				cache.delete(firstKey);
			}
		}
	}

	private getRelationshipsWorldId(): UUID {
		return stringToUuid(`relationships-world-${this.runtime.agentId}`);
	}

	private getRelationshipsRoomId(): UUID {
		return stringToUuid(`relationships-${this.runtime.agentId}`);
	}

	private isRelationshipsContactComponent(component: Component): boolean {
		return (
			component.type === "contact_info" &&
			component.agentId === this.runtime.agentId &&
			component.worldId === this.getRelationshipsWorldId() &&
			component.sourceEntityId === this.runtime.agentId
		);
	}

	private async getStoredContactComponent(
		entityId: UUID,
	): Promise<Component | null> {
		if (typeof this.runtime.getComponent === "function") {
			return this.runtime.getComponent(
				entityId,
				"contact_info",
				this.getRelationshipsWorldId(),
				this.runtime.agentId,
			);
		}

		const components = await this.runtime.getComponents(entityId);
		return (
			components.find((component) =>
				this.isRelationshipsContactComponent(component),
			) ?? null
		);
	}

	private cacheContactInfoFromEntities(entities: Entity[]): void {
		for (const entity of entities) {
			if (!entity.id || !entity.components) {
				continue;
			}

			const contactComponent = entity.components.find((component) =>
				this.isRelationshipsContactComponent(component),
			);

			if (!contactComponent?.data) {
				continue;
			}

			const contactInfo = metadataToContactInfo(
				contactComponent.data as Metadata,
			);
			this.setCacheWithLimit(
				this.contactInfoCache,
				entity.id as UUID,
				contactInfo,
				RelationshipsService.CONTACT_CACHE_LIMIT,
			);
		}
	}

	async initialize(runtime: IAgentRuntime): Promise<void> {
		this.runtime = runtime;
		const relationshipsWorldId = this.getRelationshipsWorldId();
		const relationshipsRoomId = this.getRelationshipsRoomId();

		// Ensure the synthetic relationships world exists so component FK constraints pass
		if (typeof this.runtime.ensureWorldExists === "function") {
			try {
				await this.runtime.ensureWorldExists({
					id: relationshipsWorldId,
					name: "Relationships World",
					agentId: this.runtime.agentId,
				} as Parameters<typeof this.runtime.ensureWorldExists>[0]);
			} catch (err) {
				// error-policy:J2 The synthetic world is required for component
				// foreign keys; preserve its provisioning cause.
				logger.warn(
					`[RelationshipsService] Failed to ensure relationships world: ${err}`,
				);
				throw new Error("Failed to provision relationships world", {
					cause: err,
				});
			}
		}

		// Components are stored in a synthetic room inside the relationships world.
		if (typeof this.runtime.ensureRoomExists === "function") {
			try {
				await this.runtime.ensureRoomExists({
					id: relationshipsRoomId,
					name: "Relationships",
					source: "relationships",
					type: "API" as ChannelType,
					channelId: `relationships-${this.runtime.agentId}`,
					worldId: relationshipsWorldId,
				} as Parameters<typeof this.runtime.ensureRoomExists>[0]);
			} catch (err) {
				// error-policy:J2 The synthetic room is required for component
				// foreign keys; preserve its provisioning cause.
				logger.warn(
					`[RelationshipsService] Failed to ensure relationships room: ${err}`,
				);
				throw new Error("Failed to provision relationships room", {
					cause: err,
				});
			}
		}

		// Initialize default categories
		this.categoriesCache = [
			{ id: "friend", name: "Friend", color: "#4CAF50" },
			{ id: "family", name: "Family", color: "#2196F3" },
			{ id: "colleague", name: "Colleague", color: "#FF9800" },
			{ id: "acquaintance", name: "Acquaintance", color: "#9E9E9E" },
			{ id: "vip", name: "VIP", color: "#9C27B0" },
			{ id: "business", name: "Business", color: "#795548" },
		];

		// Load existing contact info from components
		await this.loadContactInfoFromComponents();

		// Best-effort cold-start prewarm with default resolvers. Agent code that
		// later calls setGraphResolvers will re-prewarm with owner wiring (#17932).
		this.prewarmGraphModel();

		logger.info("[RelationshipsService] Initialized successfully");
	}

	async stop(): Promise<void> {
		// Clean up caches
		this.contactInfoCache.clear();
		this.analyticsCache.clear();
		this.categoriesCache = [];
		logger.info("[RelationshipsService] Stopped successfully");
	}

	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new RelationshipsService();
		await service.initialize(runtime);
		return service;
	}

	private async loadContactInfoFromComponents(): Promise<void> {
		this.contactInfoCache.clear();
		const relationshipsWorldId = this.getRelationshipsWorldId();

		// Load contacts from the synthetic relationships world where they are stored.
		if (typeof this.runtime.queryEntities === "function") {
			try {
				const entities = await this.runtime.queryEntities({
					componentType: "contact_info",
					worldId: relationshipsWorldId,
					includeAllComponents: true,
				});
				if (entities.length > 0) {
					this.cacheContactInfoFromEntities(entities);
				}
				logger.info(
					`[RelationshipsService] Loaded ${this.contactInfoCache.size} contacts from components`,
				);
				return;
			} catch (err) {
				// error-policy:J2 Contact cache loading is a required data path;
				// never present a query failure as an empty address book.
				logger.warn(
					`[RelationshipsService] Failed to query contact components: ${err}`,
				);
				throw new Error("Failed to load relationship contact components", {
					cause: err,
				});
			}
		} else {
			throw new Error(
				"RelationshipsService requires runtime.queryEntities to load contacts",
			);
		}
	}

	private newContactInfo(
		entityId: UUID,
		fields: Pick<
			ContactInfo,
			"categories" | "tags" | "preferences" | "customFields"
		>,
	): ContactInfo {
		return {
			entityId,
			...fields,
			privacyLevel: "private",
			lastModified: new Date().toISOString(),
			handles: [],
			interactions: [],
			relationshipStatus: "active",
		};
	}

	/** Creates an entity and its complete contact record in one adapter transaction. */
	async createContact(
		entity: Entity,
		fields: Pick<
			ContactInfo,
			"categories" | "tags" | "preferences" | "customFields"
		>,
	): Promise<{ entity: Entity; contact: ContactInfo }> {
		if (!entity.id || entity.agentId !== this.runtime.agentId) {
			throw new ElizaError("Contact entity must belong to the current agent.", {
				code: "CONTACT_ENTITY_INVALID",
				context: { entityId: entity.id },
			});
		}
		const entityId = entity.id;
		const contact = this.newContactInfo(entityId, fields);
		const component: Component = {
			id: stringToUuid(`contact-${entityId}-${this.runtime.agentId}`),
			type: "contact_info",
			agentId: this.runtime.agentId,
			entityId,
			roomId: this.getRelationshipsRoomId(),
			worldId: this.getRelationshipsWorldId(),
			sourceEntityId: this.runtime.agentId,
			data: contactInfoToMetadata(contact),
			createdAt: Date.now(),
		};
		const receipt = await this.runtime.transaction(async (tx) => {
			const existing = (await tx.getEntitiesByIds([entityId]))[0];
			if (existing && existing.agentId !== this.runtime.agentId) {
				throw new ElizaError("Contact entity belongs to a different agent.", {
					code: "CONTACT_ENTITY_INVALID",
					context: { entityId },
				});
			}
			if ((await tx.getComponentsByIds([component.id])).length > 0) {
				throw new ElizaError(
					"Contact already exists; use CONTACT update to change its fields.",
					{
						code: "CONTACT_ALREADY_EXISTS",
						context: { entityId },
					},
				);
			}
			if (
				!existing &&
				!(await tx.createEntities([entity])).includes(entityId)
			) {
				throw new ElizaError(
					"The database did not create the contact entity.",
					{
						code: "CONTACT_ENTITY_CREATE_FAILED",
						context: { entityId },
					},
				);
			}
			if (!(await tx.createComponents([component])).includes(component.id)) {
				throw new ElizaError(
					"The database did not persist the contact fields.",
					{
						code: "CONTACT_FIELDS_CREATE_FAILED",
						context: { entityId },
					},
				);
			}
			const persisted = (await tx.getEntitiesByIds([entityId]))[0];
			if (!persisted)
				throw new ElizaError("Contact entity readback failed.", {
					code: "CONTACT_ENTITY_READBACK_FAILED",
					context: { entityId },
				});
			return { entity: persisted, contact };
		});
		this.setCacheWithLimit(
			this.contactInfoCache,
			entityId,
			contact,
			RelationshipsService.CONTACT_CACHE_LIMIT,
		);
		try {
			const payload = {
				runtime: this.runtime,
				entityId,
				source: "relationships",
			};
			await this.runtime.emitEvent(EntityLifecycleEvent.UPDATED, payload);
		} catch (error) {
			// error-policy:J7 The committed contact receipt stays authoritative if lifecycle diagnostics fail.
			this.runtime.reportError("relationships:contact-created", error, {
				entityId,
			});
		}
		return receipt;
	}

	// Contact Management Methods
	async addContact(
		entityId: UUID,
		categories: string[] = ["acquaintance"],
		preferences?: ContactPreferences,
		customFields?: Record<string, JsonValue>,
	): Promise<ContactInfo> {
		const contactInfo = this.newContactInfo(entityId, {
			categories,
			preferences: preferences ?? {},
			customFields: customFields ?? {},
			tags: [],
		});

		// Save as component
		await this.runtime.createComponent({
			id: stringToUuid(`contact-${entityId}-${this.runtime.agentId}`),
			type: "contact_info",
			agentId: this.runtime.agentId,
			entityId,
			roomId: this.getRelationshipsRoomId(),
			worldId: this.getRelationshipsWorldId(),
			sourceEntityId: this.runtime.agentId,
			data: contactInfoToMetadata(contactInfo),
			createdAt: Date.now(),
		});

		this.setCacheWithLimit(
			this.contactInfoCache,
			entityId,
			contactInfo,
			RelationshipsService.CONTACT_CACHE_LIMIT,
		);

		// Emit entity lifecycle event
		const entity = await this.runtime.getEntityById(entityId);
		if (entity) {
			await (
				this.runtime as {
					emitEvent: (
						event: string,
						payload: Record<string, JsonValue | object>,
					) => Promise<void>;
				}
			).emitEvent(EntityLifecycleEvent.UPDATED, {
				entityId: entity.id ?? "",
				source: "relationships",
			});
		}

		logger.info(
			`[RelationshipsService] Added contact ${entityId} with categories: ${categories.join(", ")}`,
		);
		return contactInfo;
	}

	async updateContact(
		entityId: UUID,
		updates: Partial<ContactInfo>,
	): Promise<ContactInfo | null> {
		const existing = await this.getContact(entityId);
		if (!existing) {
			logger.warn(`[RelationshipsService] Contact ${entityId} not found`);
			return null;
		}

		const updated: ContactInfo = {
			...existing,
			...updates,
			entityId, // Ensure entityId cannot be changed
			lastModified: new Date().toISOString(),
		};

		// Update component
		const contactComponent = await this.getStoredContactComponent(entityId);

		if (contactComponent) {
			await this.runtime.updateComponent({
				...contactComponent,
				data: contactInfoToMetadata(updated),
			});
		}

		this.setCacheWithLimit(
			this.contactInfoCache,
			entityId,
			updated,
			RelationshipsService.CONTACT_CACHE_LIMIT,
		);

		logger.info(`[RelationshipsService] Updated contact ${entityId}`);
		return updated;
	}

	async getContact(entityId: UUID): Promise<ContactInfo | null> {
		// Check cache first
		if (this.contactInfoCache.has(entityId)) {
			const cached = this.contactInfoCache.get(entityId);
			if (cached) {
				return cached;
			}
		}

		// Load from component if not in cache
		const contactComponent = await this.getStoredContactComponent(entityId);

		if (contactComponent?.data) {
			const contactInfo = metadataToContactInfo(
				contactComponent.data as Metadata,
			);
			this.setCacheWithLimit(
				this.contactInfoCache,
				entityId,
				contactInfo,
				RelationshipsService.CONTACT_CACHE_LIMIT,
			);
			return contactInfo;
		}

		return null;
	}

	async removeContact(entityId: UUID): Promise<boolean> {
		const existing = await this.getContact(entityId);
		if (!existing) {
			logger.warn(`[RelationshipsService] Contact ${entityId} not found`);
			return false;
		}

		// Remove component
		const contactComponent = await this.getStoredContactComponent(entityId);

		if (contactComponent) {
			await this.runtime.deleteComponent(contactComponent.id);
		}

		// Remove from cache
		this.contactInfoCache.delete(entityId);

		logger.info(`[RelationshipsService] Removed contact ${entityId}`);
		return true;
	}

	async searchContacts(criteria: {
		categories?: string[];
		tags?: string[];
		searchTerm?: string;
		privacyLevel?: string;
	}): Promise<ContactInfo[]> {
		const results: ContactInfo[] = [];

		for (const [, contactInfo] of this.contactInfoCache) {
			let matches = true;

			// Check categories
			if (criteria.categories && criteria.categories.length > 0) {
				const categorySet = new Set(contactInfo.categories);
				matches =
					matches && criteria.categories.some((cat) => categorySet.has(cat));
			}

			// Check tags
			if (criteria.tags && criteria.tags.length > 0) {
				const tagSet = new Set(contactInfo.tags);
				matches = matches && criteria.tags.some((tag) => tagSet.has(tag));
			}

			// Check privacy level
			if (criteria.privacyLevel) {
				matches = matches && contactInfo.privacyLevel === criteria.privacyLevel;
			}

			if (matches) {
				results.push(contactInfo);
			}
		}

		// If searchTerm is provided, further filter by entity names
		if (criteria.searchTerm) {
			const searchTermLower = criteria.searchTerm.toLowerCase();
			const entities = await Promise.all(
				results.map((contact) => this.runtime.getEntityById(contact.entityId)),
			);
			const filteredResults: ContactInfo[] = [];
			for (let i = 0; i < results.length; i++) {
				const entity = entities[i];
				const entityNames = entity?.names ?? [];
				const displayName = getContactDisplayName(results[i])?.toLowerCase();
				if (
					entityNames.some((name) =>
						name.toLowerCase().includes(searchTermLower),
					) ||
					displayName?.includes(searchTermLower) ||
					String(results[i].entityId).toLowerCase().includes(searchTermLower)
				) {
					filteredResults.push(results[i]);
				}
			}
			return filteredResults;
		}

		return results;
	}

	// Relationship Analytics Methods
	async analyzeRelationship(
		sourceEntityId: UUID,
		targetEntityId: UUID,
	): Promise<RelationshipAnalytics | null> {
		const [firstEntityId, secondEntityId] =
			sourceEntityId < targetEntityId
				? [sourceEntityId, targetEntityId]
				: [targetEntityId, sourceEntityId];
		const cacheKey = `${firstEntityId}-${secondEntityId}`;

		// Check cache first (valid for 1 hour from computation)
		const cached = this.analyticsCache.get(cacheKey);
		if (cached && Date.now() - cached.cachedAt < 3600000) {
			return cached.analytics;
		}

		// Get relationship
		const relationships = await this.runtime.getRelationships({
			entityIds: [sourceEntityId],
		});

		const relationship = relationships.find(
			(r) =>
				(r.sourceEntityId === sourceEntityId &&
					r.targetEntityId === targetEntityId) ||
				(r.sourceEntityId === targetEntityId &&
					r.targetEntityId === sourceEntityId),
		) as ExtendedRelationship | undefined;

		// Get recent messages from rooms both entities share. `inReplyTo` stores a
		// parent message id, not an entity id, so direct reply matching here is incorrect.
		const [sourceRoomIds, targetRoomIds] = await Promise.all([
			this.runtime.getRoomsForParticipant(sourceEntityId),
			this.runtime.getRoomsForParticipant(targetEntityId),
		]);
		const targetRoomIdSet = new Set(
			targetRoomIds.map((roomId) => String(roomId)),
		);
		const sharedRoomIds = sourceRoomIds.filter((roomId) =>
			targetRoomIdSet.has(String(roomId)),
		);
		const sharedMessages =
			sharedRoomIds.length > 0
				? await getAllRelationshipMessages(this.runtime, sharedRoomIds)
				: [];

		const interactions = sharedMessages
			.filter(
				(message) =>
					message.entityId === sourceEntityId ||
					message.entityId === targetEntityId,
			)
			.sort((a, b) => {
				const aSafe = safeSortNumber(a.createdAt ?? 0);
				const bSafe = safeSortNumber(b.createdAt ?? 0);
				if (aSafe !== bSafe) return aSafe < bSafe ? -1 : 1;
				return String(a.id ?? "").localeCompare(String(b.id ?? ""));
			});

		if (!relationship && interactions.length === 0) {
			return null;
		}

		// Calculate metrics
		const interactionCount = interactions.length;
		const sharedConversationWindows = countSharedConversationWindows(
			interactions,
			sourceEntityId,
			targetEntityId,
		);
		const lastInteraction = interactions[interactions.length - 1];
		const lastInteractionAt = lastInteraction?.createdAt
			? new Date(Number(lastInteraction.createdAt)).toISOString()
			: relationship?.lastInteractionAt;

		// Calculate average response time
		let totalResponseTime = 0;
		let responseCount = 0;

		for (let i = 0; i < interactions.length - 1; i++) {
			const current = interactions[i];
			const next = interactions[i + 1];

			if (
				current.entityId !== next.entityId &&
				current.createdAt &&
				next.createdAt
			) {
				const timeDiff = Number(next.createdAt) - Number(current.createdAt);
				totalResponseTime += timeDiff;
				responseCount++;
			}
		}

		const averageResponseTime =
			responseCount > 0 ? totalResponseTime / responseCount : undefined;

		// Extract topics (simplified - could use NLP)
		const topicsSet = new Set<string>();
		for (const msg of interactions) {
			const text = msg.content.text || "";
			// Simple keyword extraction - could be enhanced with NLP
			const keywords = text.match(/\b[A-Z][a-z]+\b/g) || [];
			for (const k of keywords) {
				topicsSet.add(k);
			}
		}

		// Calculate relationship strength
		const strength = calculateRelationshipStrength({
			interactionCount,
			lastInteractionAt,
			relationshipType: relationship?.relationshipType,
			sharedConversationWindows,
		});

		const analytics: RelationshipAnalytics = {
			strength,
			interactionCount,
			sharedConversationWindows,
			lastInteractionAt,
			averageResponseTime,
			sentimentScore: 0.7, // Default neutral-positive score until sentiment is observed
			topicsDiscussed: Array.from(topicsSet),
		};

		// Update relationship with calculated strength
		if (
			relationship &&
			(relationship.strength !== strength ||
				relationship.lastInteractionAt !== lastInteractionAt)
		) {
			// Update relationship using components
			const relationshipComponent = {
				id: stringToUuid(`relationship-${relationship.id}`),
				type: "relationship_update",
				agentId: this.runtime.agentId,
				entityId: relationship.sourceEntityId,
				roomId: this.getRelationshipsRoomId(),
				worldId: this.getRelationshipsWorldId(),
				sourceEntityId: relationship.sourceEntityId,
				data: {
					targetEntityId: relationship.targetEntityId,
					strength,
					lastInteractionAt,
					metadata: relationship.metadata,
				} as Metadata,
				createdAt: Date.now(),
			};
			await this.runtime.createComponent(relationshipComponent);
		}

		// Cache the result
		this.setCacheWithLimit(
			this.analyticsCache,
			cacheKey,
			{ analytics, cachedAt: Date.now() },
			RelationshipsService.ANALYTICS_CACHE_LIMIT,
		);

		return analytics;
	}

	async getRelationshipInsights(entityId: UUID): Promise<{
		strongestRelationships: Array<{
			entity: Entity;
			analytics: RelationshipAnalytics;
		}>;
		needsAttention: Array<{ entity: Entity; daysSinceContact: number }>;
		recentInteractions: Array<{ entity: Entity; lastInteraction: string }>;
	}> {
		const relationships = await this.runtime.getRelationships({
			entityIds: [entityId],
		});
		const insights = {
			strongestRelationships: [] as Array<{
				entity: Entity;
				analytics: RelationshipAnalytics;
			}>,
			needsAttention: [] as Array<{
				entity: Entity;
				daysSinceContact: number;
			}>,
			recentInteractions: [] as Array<{
				entity: Entity;
				lastInteraction: string;
			}>,
		};

		const targets = relationships.map((rel) =>
			rel.sourceEntityId === entityId ? rel.targetEntityId : rel.sourceEntityId,
		);
		const entities = await Promise.all(
			targets.map((target) => this.runtime.getEntityById(target)),
		);
		const analyticsResults = await Promise.all(
			targets.map((target, index) =>
				entities[index] ? this.analyzeRelationship(entityId, target) : null,
			),
		);

		for (let i = 0; i < relationships.length; i++) {
			const entity = entities[i];
			const analytics = analyticsResults[i];
			if (!entity || !analytics) continue;

			// Strongest relationships
			if (analytics.strength > 70) {
				insights.strongestRelationships.push({ entity, analytics });
			}

			// Needs attention (no contact in 30+ days)
			if (analytics.lastInteractionAt) {
				const daysSince =
					(Date.now() - new Date(analytics.lastInteractionAt).getTime()) /
					(1000 * 60 * 60 * 24);

				if (daysSince > 30) {
					insights.needsAttention.push({
						entity,
						daysSinceContact: Math.round(daysSince),
					});
				}

				// Recent interactions (last 7 days)
				if (daysSince < 7) {
					insights.recentInteractions.push({
						entity,
						lastInteraction: analytics.lastInteractionAt,
					});
				}
			}
		}

		// Sort by relevance
		insights.strongestRelationships.sort((a, b) => {
			const aSafe = safeSortNumber(a.analytics.strength);
			const bSafe = safeSortNumber(b.analytics.strength);
			if (aSafe !== bSafe) return bSafe > aSafe ? 1 : -1;
			return String(a.entity.id ?? "").localeCompare(String(b.entity.id ?? ""));
		});
		insights.needsAttention.sort((a, b) => {
			const aSafe = safeSortNumber(a.daysSinceContact);
			const bSafe = safeSortNumber(b.daysSinceContact);
			if (aSafe !== bSafe) return bSafe > aSafe ? 1 : -1;
			return String(a.entity.id ?? "").localeCompare(String(b.entity.id ?? ""));
		});
		insights.recentInteractions.sort((a, b) => {
			const aSafe = safeSortNumber(new Date(a.lastInteraction).getTime());
			const bSafe = safeSortNumber(new Date(b.lastInteraction).getTime());
			if (aSafe !== bSafe) return bSafe > aSafe ? 1 : -1;
			return String(a.entity.id ?? "").localeCompare(String(b.entity.id ?? ""));
		});

		return insights;
	}

	// Category Management
	async getCategories(): Promise<ContactCategory[]> {
		return this.categoriesCache;
	}

	async addCategory(category: ContactCategory): Promise<void> {
		if (this.categoriesCache.find((c) => c.id === category.id)) {
			throw new Error(`Category ${category.id} already exists`);
		}

		this.categoriesCache.push(category);
		logger.info(`[RelationshipsService] Added category: ${category.name}`);
	}

	// Privacy Management
	async setContactPrivacy(
		entityId: UUID,
		privacyLevel: "public" | "private" | "restricted",
	): Promise<boolean> {
		const contact = await this.getContact(entityId);
		if (!contact) return false;

		contact.privacyLevel = privacyLevel;
		await this.updateContact(entityId, { privacyLevel });

		logger.info(
			`[RelationshipsService] Set privacy level for ${entityId} to ${privacyLevel}`,
		);
		return true;
	}

	async canAccessContact(
		requestingEntityId: UUID,
		targetEntityId: UUID,
	): Promise<boolean> {
		const contact = await this.getContact(targetEntityId);
		if (!contact) return false;

		// Agent always has access
		if (requestingEntityId === this.runtime.agentId) return true;

		// Check privacy level
		switch (contact.privacyLevel) {
			case "public":
				return true;
			case "private":
				// Only agent and the entity itself
				return requestingEntityId === targetEntityId;
			case "restricted":
				// Only agent
				return false;
			default:
				return false;
		}
	}

	// ───────────────────────────────────────────────────────────────────────
	// Rolodex extensions (T7b)
	// ───────────────────────────────────────────────────────────────────────

	/** Persist a ContactInfo back to its component + cache. */
	private async persistContactInfo(contactInfo: ContactInfo): Promise<void> {
		const stored = await this.getStoredContactComponent(contactInfo.entityId);
		if (!stored) {
			throw new Error(
				`[RelationshipsService] Contact component missing for ${contactInfo.entityId}`,
			);
		}
		const next: ContactInfo = {
			...contactInfo,
			lastModified: new Date().toISOString(),
		};
		await this.runtime.updateComponent({
			...stored,
			data: contactInfoToMetadata(next),
		});
		this.setCacheWithLimit(
			this.contactInfoCache,
			next.entityId,
			next,
			RelationshipsService.CONTACT_CACHE_LIMIT,
		);
	}

	/**
	 * Add a platform handle to a contact. Enforces uniqueness on
	 * (platform, identifier) pairs across the contact.
	 */
	async addHandle(
		contactId: UUID,
		handle: {
			platform: string;
			identifier: string;
			displayLabel?: string;
			isPrimary?: boolean;
		},
	): Promise<ContactHandle> {
		const platform = handle.platform.trim().toLowerCase();
		const identifier = handle.identifier.trim();
		if (platform.length === 0 || identifier.length === 0) {
			throw new Error("Handle platform and identifier are required");
		}

		const contact = await this.getContact(contactId);
		if (!contact) {
			throw new Error(`Contact ${contactId} not found`);
		}

		const normalizedIdentifier = identifier.toLowerCase();
		const duplicate = contact.handles.find(
			(h) =>
				h.platform === platform &&
				h.identifier.toLowerCase() === normalizedIdentifier,
		);
		if (duplicate) {
			return duplicate;
		}

		const newHandle: ContactHandle = {
			id: stringToUuid(
				`handle-${contactId}-${platform}-${identifier}-${Date.now()}`,
			),
			platform,
			identifier,
			displayLabel: handle.displayLabel,
			isPrimary: handle.isPrimary,
			addedAt: new Date().toISOString(),
		};

		let handles = [...contact.handles, newHandle];
		if (newHandle.isPrimary === true) {
			handles = handles.map((h) =>
				h.platform === platform && h.id !== newHandle.id
					? { ...h, isPrimary: false }
					: h,
			);
		}

		await this.persistContactInfo({ ...contact, handles });
		logger.info(
			`[RelationshipsService] Added handle ${platform}:${identifier} to ${contactId}`,
		);
		return newHandle;
	}

	async removeHandle(contactId: UUID, handleId: UUID): Promise<boolean> {
		const contact = await this.getContact(contactId);
		if (!contact) return false;

		const filtered = contact.handles.filter((h) => h.id !== handleId);
		if (filtered.length === contact.handles.length) {
			return false;
		}
		await this.persistContactInfo({ ...contact, handles: filtered });
		logger.info(
			`[RelationshipsService] Removed handle ${handleId} from ${contactId}`,
		);
		return true;
	}

	/**
	 * Record an interaction with a contact while preserving the complete
	 * interaction history. Updates lastInteractionAt so followup thresholds
	 * stay accurate.
	 */
	async recordInteraction(
		input: RecordInteractionInput,
	): Promise<ContactInteraction> {
		const contact = await this.getContact(input.contactId);
		if (!contact) {
			throw new Error(`Contact ${input.contactId} not found`);
		}

		const platform = input.platform.trim().toLowerCase();
		if (platform.length === 0) {
			throw new Error("Interaction platform is required");
		}

		const occurredAt = input.occurredAt ?? new Date().toISOString();

		const interaction: ContactInteraction = {
			id: stringToUuid(
				`interaction-${input.contactId}-${platform}-${occurredAt}-${Math.random()}`,
			),
			platform,
			direction: input.direction,
			summary: input.summary,
			externalRef: input.externalRef,
			occurredAt,
		};

		const appended = [...contact.interactions, interaction].sort((a, b) => {
			const aSafe = safeSortNumber(new Date(a.occurredAt).getTime());
			const bSafe = safeSortNumber(new Date(b.occurredAt).getTime());
			if (aSafe !== bSafe) return aSafe < bSafe ? -1 : 1;
			return String(a.id ?? "").localeCompare(String(b.id ?? ""));
		});
		const latestAt = appended[appended.length - 1]?.occurredAt;
		const currentLatest = contact.lastInteractionAt
			? new Date(contact.lastInteractionAt).getTime()
			: 0;
		const nextLastInteractionAt =
			latestAt && new Date(latestAt).getTime() >= currentLatest
				? latestAt
				: contact.lastInteractionAt;

		await this.persistContactInfo({
			...contact,
			interactions: appended,
			lastInteractionAt: nextLastInteractionAt,
		});

		return interaction;
	}

	/**
	 * Find a contact by one of its platform handles. Match is case-insensitive
	 * on identifier; platform is normalized to lowercase.
	 */
	async findByHandle(
		platform: string,
		identifier: string,
	): Promise<ContactInfo | null> {
		const normalizedPlatform = platform.trim().toLowerCase();
		const normalizedIdentifier = identifier.trim().toLowerCase();
		if (normalizedPlatform.length === 0 || normalizedIdentifier.length === 0) {
			return null;
		}

		for (const contact of this.contactInfoCache.values()) {
			const match = contact.handles.find(
				(h) =>
					h.platform === normalizedPlatform &&
					h.identifier.toLowerCase() === normalizedIdentifier,
			);
			if (match) return contact;
		}
		return null;
	}

	/**
	 * Merge two contacts. Handles, interactions, tags, and categories from the
	 * secondary are folded into the primary. The secondary contact is removed.
	 */
	async mergeContacts(
		primaryId: UUID,
		secondaryId: UUID,
	): Promise<ContactInfo> {
		if (primaryId === secondaryId) {
			throw new Error("Cannot merge a contact with itself");
		}
		const primary = await this.getContact(primaryId);
		const secondary = await this.getContact(secondaryId);
		if (!primary) {
			throw new Error(`Primary contact ${primaryId} not found`);
		}
		if (!secondary) {
			throw new Error(`Secondary contact ${secondaryId} not found`);
		}

		// Merge handles, dedupe on (platform, identifier)
		const handleKey = (h: ContactHandle) =>
			`${h.platform}:${h.identifier.toLowerCase()}`;
		const mergedHandlesMap = new Map<string, ContactHandle>();
		for (const h of [...primary.handles, ...secondary.handles]) {
			if (!mergedHandlesMap.has(handleKey(h))) {
				mergedHandlesMap.set(handleKey(h), h);
			}
		}

		// Merge interactions (dedupe by id) and keep sorted
		const interactionMap = new Map<UUID, ContactInteraction>();
		for (const i of [...primary.interactions, ...secondary.interactions]) {
			interactionMap.set(i.id, i);
		}
		const mergedInteractions = Array.from(interactionMap.values()).sort(
			(a, b) => {
				const aSafe = safeSortNumber(new Date(a.occurredAt).getTime());
				const bSafe = safeSortNumber(new Date(b.occurredAt).getTime());
				if (aSafe !== bSafe) return aSafe < bSafe ? -1 : 1;
				return String(a.id ?? "").localeCompare(String(b.id ?? ""));
			},
		);
		const mergedCategories = Array.from(
			new Set([...primary.categories, ...secondary.categories]),
		);
		const mergedTags = Array.from(
			new Set([...primary.tags, ...secondary.tags]),
		);

		const primaryLast = primary.lastInteractionAt
			? new Date(primary.lastInteractionAt).getTime()
			: 0;
		const secondaryLast = secondary.lastInteractionAt
			? new Date(secondary.lastInteractionAt).getTime()
			: 0;
		const latestInteractionAt =
			primaryLast >= secondaryLast
				? primary.lastInteractionAt
				: secondary.lastInteractionAt;

		const merged: ContactInfo = {
			...primary,
			categories: mergedCategories,
			tags: mergedTags,
			handles: Array.from(mergedHandlesMap.values()),
			interactions: mergedInteractions,
			lastInteractionAt: latestInteractionAt,
			relationshipGoal: primary.relationshipGoal ?? secondary.relationshipGoal,
			followupThresholdDays:
				primary.followupThresholdDays ?? secondary.followupThresholdDays,
			customFields: { ...secondary.customFields, ...primary.customFields },
			preferences: { ...secondary.preferences, ...primary.preferences },
		};

		await this.persistContactInfo(merged);
		await this.removeContact(secondaryId);

		logger.info(
			`[RelationshipsService] Merged ${secondaryId} into ${primaryId}`,
		);
		return merged;
	}

	async setRelationshipGoal(
		contactId: UUID,
		goal: { goalText: string; targetCadenceDays?: number },
	): Promise<RelationshipGoal> {
		const contact = await this.getContact(contactId);
		if (!contact) {
			throw new Error(`Contact ${contactId} not found`);
		}
		const goalText = goal.goalText.trim();
		if (goalText.length === 0) {
			throw new Error("Goal text is required");
		}

		const relationshipGoal: RelationshipGoal = {
			goalText,
			targetCadenceDays: goal.targetCadenceDays,
			setAt: new Date().toISOString(),
		};

		await this.persistContactInfo({
			...contact,
			relationshipGoal,
			followupThresholdDays:
				goal.targetCadenceDays ?? contact.followupThresholdDays,
		});
		logger.info(
			`[RelationshipsService] Set relationship goal for ${contactId}`,
		);
		return relationshipGoal;
	}

	async getRelationshipProgress(
		contactId: UUID,
	): Promise<RelationshipProgress | null> {
		const contact = await this.getContact(contactId);
		if (!contact) return null;

		const goal = contact.relationshipGoal ?? null;
		const last = contact.lastInteractionAt ?? null;
		const targetCadence =
			goal?.targetCadenceDays ?? contact.followupThresholdDays ?? null;

		let daysSinceInteraction: number | null = null;
		if (last) {
			daysSinceInteraction =
				(Date.now() - new Date(last).getTime()) / (1000 * 60 * 60 * 24);
		}

		let cadenceHealth: RelationshipProgress["cadenceHealth"];
		if (targetCadence === null) {
			cadenceHealth = "no-goal";
		} else if (daysSinceInteraction === null) {
			cadenceHealth = "never-contacted";
		} else if (daysSinceInteraction < targetCadence * 0.8) {
			cadenceHealth = "on-track";
		} else if (daysSinceInteraction <= targetCadence) {
			cadenceHealth = "due";
		} else {
			cadenceHealth = "overdue";
		}

		return {
			contactId,
			goal,
			lastInteractionAt: last,
			cadenceHealth,
			daysSinceInteraction,
			targetCadenceDays: targetCadence,
		};
	}

	/**
	 * List all contacts whose followup threshold has lapsed. A contact is
	 * considered overdue when:
	 *   - followupThresholdDays is set (or defaultThresholdDays is provided), AND
	 *   - (now - lastInteractionAt) > thresholdDays, OR lastInteractionAt is null.
	 */
	async listOverdueFollowups(
		options?: ListOverdueOptions,
	): Promise<OverdueFollowup[]> {
		const asOf = options?.asOfMs ?? Date.now();
		const defaultThreshold = options?.defaultThresholdDays;
		const results: OverdueFollowup[] = [];

		for (const contact of this.contactInfoCache.values()) {
			if (contact.relationshipStatus === "archived") continue;
			if (contact.relationshipStatus === "blocked") continue;

			const threshold =
				contact.followupThresholdDays ??
				contact.relationshipGoal?.targetCadenceDays ??
				defaultThreshold;
			if (threshold === undefined) continue;

			if (!contact.lastInteractionAt) {
				results.push({
					contact,
					daysSinceInteraction: Number.POSITIVE_INFINITY,
					thresholdDays: threshold,
				});
				continue;
			}

			const daysSince =
				(asOf - new Date(contact.lastInteractionAt).getTime()) /
				(1000 * 60 * 60 * 24);
			if (daysSince > threshold) {
				results.push({
					contact,
					daysSinceInteraction: daysSince,
					thresholdDays: threshold,
				});
			}
		}

		results.sort((a, b) => {
			const aSafe = safeSortNumber(a.daysSinceInteraction);
			const bSafe = safeSortNumber(b.daysSinceInteraction);
			if (aSafe !== bSafe) return bSafe > aSafe ? 1 : -1;
			return String(a.contact.entityId).localeCompare(
				String(b.contact.entityId),
			);
		});
		return results;
	}

	/**
	 * Import contacts from an external platform. For each seed:
	 *   - if an existing contact has a matching (platform, identifier) handle,
	 *     link any new metadata and return it as linkedToExisting;
	 *   - otherwise create a new entity + contact.
	 */
	async importContactsFromPlatform(
		platform: string,
		contacts: PlatformContactSeed[],
	): Promise<PlatformImportResult> {
		const normalizedPlatform = platform.trim().toLowerCase();
		if (normalizedPlatform.length === 0) {
			throw new Error("Platform is required for import");
		}

		const imported: ContactInfo[] = [];
		const linkedToExisting: ContactInfo[] = [];
		const skipped: Array<{ seed: PlatformContactSeed; reason: string }> = [];

		for (const seed of contacts) {
			const seedPlatform = seed.platform.trim().toLowerCase();
			const identifier = seed.identifier.trim();
			if (!identifier) {
				skipped.push({ seed, reason: "missing identifier" });
				continue;
			}

			const existing = await this.findByHandle(seedPlatform, identifier);
			if (existing) {
				const refreshed = await this.getContact(existing.entityId);
				if (refreshed) linkedToExisting.push(refreshed);
				continue;
			}

			const displayName = seed.displayName?.trim() || identifier;
			const entityId = stringToUuid(
				`contact-import-${seedPlatform}-${identifier}-${this.runtime.agentId}`,
			);

			const existingEntity = await this.runtime.getEntityById(entityId);
			if (!existingEntity) {
				await this.runtime.createEntity({
					id: entityId,
					names: [displayName],
					agentId: this.runtime.agentId,
				});
			}

			const preferences: ContactPreferences = {};
			if (seed.notes) preferences.notes = seed.notes;

			const newContact = await this.addContact(
				entityId,
				seed.categories ?? ["acquaintance"],
				preferences,
				{ displayName },
			);

			if (seed.tags && seed.tags.length > 0) {
				await this.persistContactInfo({
					...newContact,
					tags: Array.from(new Set([...newContact.tags, ...seed.tags])),
				});
			}

			await this.addHandle(entityId, {
				platform: seedPlatform,
				identifier,
				displayLabel: seed.displayLabel,
				isPrimary: true,
			});

			const finalContact = await this.getContact(entityId);
			if (finalContact) imported.push(finalContact);
		}

		logger.info(
			`[RelationshipsService] Imported ${imported.length}, linked ${linkedToExisting.length}, skipped ${skipped.length} from ${normalizedPlatform}`,
		);
		return { imported, linkedToExisting, skipped };
	}

	// ───────────────────────────────────────────────────────────────────────
	// Identity strengthening (entity_identities + entity_merge_candidates)
	// ───────────────────────────────────────────────────────────────────────

	private getRuntimeDb(): RuntimeDbExecutor | null {
		const adapter = (
			this.runtime as IAgentRuntime & { adapter?: { db?: unknown } }
		).adapter;
		const db = adapter.db as RuntimeDbExecutor | undefined;
		if (!db || typeof db.execute !== "function") {
			return null;
		}
		return db;
	}

	private async execSql(
		sqlText: string,
	): Promise<{ rows: Record<string, unknown>[] }> {
		const db = this.getRuntimeDb();
		if (!db) {
			throw new Error(
				"[RelationshipsService] runtime database adapter unavailable",
			);
		}
		const result = (await db.execute(sql.raw(sqlText))) as {
			rows?: Record<string, unknown>[];
		};
		return { rows: Array.isArray(result.rows) ? result.rows : [] };
	}

	/**
	 * Insert or strengthen an `entity_identities` row. Re-observations of the
	 * same (entity, platform, handle) triple bump confidence to the max,
	 * append (deduped) evidence message ids, and update last_seen.
	 *
	 * When the same (platform, handle) pair has already been observed for a
	 * different entity AND this observation is high-confidence with
	 * sufficient evidence, an auto-merge candidate is proposed and accepted.
	 */
	async upsertIdentity(
		entityId: UUID,
		identity: PlatformIdentityInput,
		evidenceMessageIds: UUID[] = [],
	): Promise<void> {
		const platform = identity.platform.trim().toLowerCase();
		const handle = identity.handle.trim();
		if (platform.length === 0 || handle.length === 0) {
			throw new Error(
				"[RelationshipsService] upsertIdentity requires non-empty platform and handle",
			);
		}
		const confidence = clampConfidence(identity.confidence);
		const verified = identity.verified === true;
		const dedupedEvidence = Array.from(new Set(evidenceMessageIds));
		const evidenceLiteral = sqlJsonbLiteral(dedupedEvidence);
		const sourceLiteral =
			typeof identity.source === "string" && identity.source.trim().length > 0
				? sqlQuote(identity.source.trim())
				: "NULL";
		const verifiedLiteral = verified ? "TRUE" : "FALSE";
		const platformLiteral = sqlQuote(platform);
		const handleLiteral = sqlQuote(handle);
		const entityLiteral = sqlQuote(entityId);
		const agentLiteral = sqlQuote(this.runtime.agentId);

		const upsertSql = `INSERT INTO entity_identities (
				entity_id, agent_id, platform, handle, verified, confidence, source,
				first_seen, last_seen, evidence_message_ids
			) VALUES (
				${entityLiteral}, ${agentLiteral}, ${platformLiteral}, ${handleLiteral},
				${verifiedLiteral}, ${confidence}, ${sourceLiteral},
				now(), now(), ${evidenceLiteral}
			)
			ON CONFLICT ON CONSTRAINT unique_entity_identity DO UPDATE SET
				confidence = GREATEST(entity_identities.confidence, EXCLUDED.confidence),
				verified = entity_identities.verified OR EXCLUDED.verified,
				last_seen = now(),
				source = CASE
					WHEN EXCLUDED.source = 'reflection' THEN entity_identities.source
					ELSE COALESCE(EXCLUDED.source, entity_identities.source)
				END,
				evidence_message_ids = (
					SELECT to_jsonb(array_agg(DISTINCT element))
					FROM jsonb_array_elements_text(
						COALESCE(entity_identities.evidence_message_ids, '[]'::jsonb)
						|| COALESCE(EXCLUDED.evidence_message_ids, '[]'::jsonb)
					) AS element
				)`;

		await this.execSql(upsertSql);

		// Auto-merge: if this (platform, handle) is already pinned to another
		// entity, surface — and possibly accept — a merge candidate.
		if (
			confidence >= AUTO_MERGE_CONFIDENCE_THRESHOLD &&
			dedupedEvidence.length >= AUTO_MERGE_MIN_EVIDENCE
		) {
			const collisions = await this.findEntitiesByIdentity(platform, handle);
			for (const otherEntityId of collisions) {
				if (otherEntityId === entityId) continue;
				const candidate = await this.proposeMerge(entityId, otherEntityId, {
					platform,
					handle,
					notes: "auto-detected high-confidence identity collision",
				});
				await this.acceptMerge(candidate);
			}
		}
	}

	async getEntityIdentities(entityId: UUID): Promise<EntityIdentityRecord[]> {
		const result = await this.execSql(
			`SELECT id, entity_id, platform, handle, verified, confidence, source,
				first_seen, last_seen, evidence_message_ids
			 FROM entity_identities
			 WHERE entity_id = ${sqlQuote(entityId)}
				AND agent_id = ${sqlQuote(this.runtime.agentId)}
			 ORDER BY confidence DESC, last_seen DESC`,
		);
		return result.rows.map(parseEntityIdentityRow);
	}

	private async findEntitiesByIdentity(
		platform: string,
		handle: string,
	): Promise<UUID[]> {
		const result = await this.execSql(
			`SELECT DISTINCT entity_id
			 FROM entity_identities
			 WHERE platform = ${sqlQuote(platform)}
				AND handle = ${sqlQuote(handle)}
				AND agent_id = ${sqlQuote(this.runtime.agentId)}`,
		);
		const ids: UUID[] = [];
		for (const row of result.rows) {
			const value = row.entity_id;
			if (typeof value === "string" && value.length > 0) {
				ids.push(asUUID(value));
			}
		}
		return ids;
	}

	async proposeMerge(
		entityA: UUID,
		entityB: UUID,
		evidence: MergeCandidateEvidence,
	): Promise<UUID> {
		if (entityA === entityB) {
			throw new Error(
				"[RelationshipsService] proposeMerge requires two distinct entities",
			);
		}
		// entity_a is the *surviving* entity. Order is intentional and not
		// normalized — the caller picks the canonical side, and acceptMerge
		// folds entity_b into entity_a.
		const evidenceLiteral = sqlJsonbLiteral(evidence);
		const confidence = clampConfidence(
			typeof evidence.confidence === "number" ? evidence.confidence : 1,
		);
		const result = await this.execSql(
			`INSERT INTO entity_merge_candidates (
				agent_id, entity_a, entity_b, confidence, evidence, status
			) VALUES (
				${sqlQuote(this.runtime.agentId)},
				${sqlQuote(entityA)},
				${sqlQuote(entityB)},
				${confidence},
				${evidenceLiteral},
				'pending'
			) RETURNING id`,
		);
		const row = result.rows[0];
		const id = row?.id;
		if (typeof id !== "string") {
			throw new Error(
				"[RelationshipsService] proposeMerge: insert did not return an id",
			);
		}
		logger.info(
			`[RelationshipsService] Proposed merge candidate ${id} (${entityA} <-> ${entityB})`,
		);
		this.graphServiceInstance = null;
		return asUUID(id);
	}

	async getCandidateMerges(): Promise<MergeCandidateRecord[]> {
		const result = await this.execSql(
			`SELECT id, entity_a, entity_b, confidence, evidence, status,
				proposed_at, resolved_at
			 FROM entity_merge_candidates
			 WHERE agent_id = ${sqlQuote(this.runtime.agentId)}
				AND status = 'pending'
			 ORDER BY proposed_at DESC`,
		);
		return result.rows.map(parseMergeCandidateRow);
	}

	async acceptMerge(candidateId: UUID): Promise<void> {
		const result = await this.execSql(
			`SELECT id, entity_a, entity_b, confidence, evidence, status,
				proposed_at, resolved_at
			 FROM entity_merge_candidates
			 WHERE id = ${sqlQuote(candidateId)}
				AND agent_id = ${sqlQuote(this.runtime.agentId)}
			 LIMIT 1`,
		);
		const row = result.rows[0];
		if (!row) {
			throw new Error(
				`[RelationshipsService] merge candidate ${candidateId} not found`,
			);
		}
		const candidate = parseMergeCandidateRow(row);
		if (candidate.status !== "pending") {
			logger.info(
				`[RelationshipsService] Merge candidate ${candidateId} already ${candidate.status}`,
			);
			return;
		}

		// Move identities + relationships from B into A, dedupe via the unique
		// constraint, then collapse the secondary contact (if any). PGlite's
		// prepared-statement protocol disallows multi-statement queries, so we
		// issue each step as its own execute() inside an explicit transaction.
		const a = sqlQuote(candidate.entityA);
		const b = sqlQuote(candidate.entityB);
		const agent = sqlQuote(this.runtime.agentId);
		const candidateLiteral = sqlQuote(candidateId);

		await this.execSql("BEGIN");
		try {
			await this.execSql(
				`INSERT INTO entity_identities (
					entity_id, agent_id, platform, handle, verified, confidence, source,
					first_seen, last_seen, evidence_message_ids
				)
				SELECT ${a}, agent_id, platform, handle, verified, confidence, source,
					first_seen, last_seen, evidence_message_ids
				FROM entity_identities
				WHERE entity_id = ${b} AND agent_id = ${agent}
				ON CONFLICT ON CONSTRAINT unique_entity_identity DO UPDATE SET
					confidence = GREATEST(entity_identities.confidence, EXCLUDED.confidence),
					verified = entity_identities.verified OR EXCLUDED.verified,
					first_seen = LEAST(entity_identities.first_seen, EXCLUDED.first_seen),
					last_seen = GREATEST(entity_identities.last_seen, EXCLUDED.last_seen),
					source = CASE
						WHEN entity_identities.source IS NOT NULL AND entity_identities.source <> 'reflection'
							THEN entity_identities.source
						WHEN EXCLUDED.source IS NOT NULL AND EXCLUDED.source <> 'reflection'
							THEN EXCLUDED.source
						WHEN entity_identities.source IS NULL OR EXCLUDED.source IS NULL THEN NULL
						ELSE 'reflection'
					END,
					evidence_message_ids = (
						SELECT COALESCE(to_jsonb(array_agg(DISTINCT element)), '[]'::jsonb)
						FROM jsonb_array_elements_text(
							COALESCE(entity_identities.evidence_message_ids, '[]'::jsonb)
							|| COALESCE(EXCLUDED.evidence_message_ids, '[]'::jsonb)
						) AS element
					)`,
			);
			await this.execSql(
				`DELETE FROM entity_identities
				 WHERE entity_id = ${b} AND agent_id = ${agent}`,
			);
			await this.execSql(
				`UPDATE entity_merge_candidates
				 SET status = 'accepted', resolved_at = now()
				 WHERE id = ${candidateLiteral}`,
			);
			await this.execSql("COMMIT");
		} catch (err) {
			try {
				await this.execSql("ROLLBACK");
			} catch (rollbackError) {
				// error-policy:J6 rollback failure must not mask the original transaction error
				this.runtime.logger.warn(
					{
						src: "service:relationships",
						error: rollbackError,
						candidateId,
					},
					"Failed to roll back identity merge transaction",
				);
			}
			throw err;
		}

		// Fold the contact rows. mergeContacts requires both sides to have a
		// contact; if only the secondary has one we drop it so the secondary
		// entity does not retain stale relationship rows after the merge.
		const [contactA, contactB] = await Promise.all([
			this.getContact(candidate.entityA),
			this.getContact(candidate.entityB),
		]);
		if (contactA && contactB) {
			await this.mergeContacts(candidate.entityA, candidate.entityB);
		} else if (contactB) {
			await this.removeContact(candidate.entityB);
		}

		const existingIdentityLink = (
			await this.runtime.getRelationships({
				entityIds: [candidate.entityA, candidate.entityB],
			})
		).find((relationship) => {
			const samePair =
				(relationship.sourceEntityId === candidate.entityA &&
					relationship.targetEntityId === candidate.entityB) ||
				(relationship.sourceEntityId === candidate.entityB &&
					relationship.targetEntityId === candidate.entityA);
			return samePair && Array.isArray(relationship.tags);
		});
		const identityMetadata: Metadata = {
			...((existingIdentityLink?.metadata as Metadata | undefined) ?? {}),
			...(candidate.evidence as Metadata),
			status: "confirmed",
			mergeCandidateId: candidateId,
			mergeSurvivorEntityId: candidate.entityA,
			mergeFoldedEntityId: candidate.entityB,
			source: "relationships.acceptMerge",
		};
		const identityTags = Array.from(
			new Set([...(existingIdentityLink?.tags ?? []), "identity_link"]),
		);
		if (existingIdentityLink) {
			await this.runtime.updateRelationship({
				...existingIdentityLink,
				tags: identityTags,
				metadata: identityMetadata,
			});
		} else {
			await this.runtime.createRelationship({
				sourceEntityId: candidate.entityA,
				targetEntityId: candidate.entityB,
				tags: identityTags,
				metadata: identityMetadata,
			});
		}

		logger.info(
			`[RelationshipsService] Accepted merge ${candidateId}; folded ${candidate.entityB} into ${candidate.entityA}`,
		);
		this.graphServiceInstance = null;
	}

	async rejectMerge(candidateId: UUID): Promise<void> {
		await this.execSql(
			`UPDATE entity_merge_candidates
			 SET status = 'rejected', resolved_at = now()
			 WHERE id = ${sqlQuote(candidateId)}
				AND agent_id = ${sqlQuote(this.runtime.agentId)}`,
		);
		logger.info(`[RelationshipsService] Rejected merge ${candidateId}`);
		this.graphServiceInstance = null;
	}

	/**
	 * Return every entity that belongs to the same identity cluster as
	 * `primaryEntityId`. An identity cluster is the connected component
	 * formed by:
	 *   - confirmed identity-link relationships (tag `identity_link`,
	 *     metadata.status === "confirmed"), and
	 *   - shared entity_identities rows (same (platform, handle) on two
	 *     different entities).
	 *
	 * The returned array always includes `primaryEntityId` itself.
	 * Semantics match the runtime-level clusterer in
	 * `@elizaos/agent/src/services/relationships-graph.ts` (buildClusters),
	 * including contact-platform suppression (email/phone/website handles
	 * are *not* treated as cluster-forming — they're enrichment, not
	 * identity evidence).
	 */
	async getMemberEntityIds(primaryEntityId: UUID): Promise<UUID[]> {
		const uf = await this.buildIdentityUnionFind(primaryEntityId);
		const members = uf.componentOf(primaryEntityId);
		if (members.length === 0) {
			return [primaryEntityId];
		}
		return members;
	}

	/**
	 * Return the connected component formed only by explicitly confirmed
	 * `identity_link` relationships. Sensitive disclosure paths use this legacy
	 * fallback when the canonical identity-resolution authority is unavailable;
	 * inferred same-handle matches are deliberately excluded.
	 */
	async getVerifiedMemberEntityIds(primaryEntityId: UUID): Promise<UUID[]> {
		const uf = new UnionFind<UUID>([primaryEntityId]);
		const visited = new Set<UUID>();
		let frontier: UUID[] = [primaryEntityId];
		while (frontier.length > 0) {
			const pending = frontier.filter((id) => !visited.has(id));
			if (pending.length === 0) break;
			for (const id of pending) visited.add(id);
			const nextFrontier = new Set<UUID>();
			const relationships = await this.runtime.getRelationships({
				entityIds: pending,
			});
			for (const relationship of relationships) {
				if (!isConfirmedIdentityLinkLike(relationship)) continue;
				uf.union(relationship.sourceEntityId, relationship.targetEntityId);
				if (!visited.has(relationship.sourceEntityId)) {
					nextFrontier.add(relationship.sourceEntityId);
				}
				if (!visited.has(relationship.targetEntityId)) {
					nextFrontier.add(relationship.targetEntityId);
				}
			}
			frontier = Array.from(nextFrontier);
		}
		const members = uf.componentOf(primaryEntityId);
		return members.length > 0 ? members : [primaryEntityId];
	}

	/**
	 * Resolve an entity to its cluster's primary entity.
	 *
	 * The primary is the member with a contact_info component if one
	 * exists; otherwise the lexicographically-smallest UUID. This matches
	 * the runtime-level clusterer's tiebreaker semantics when no scoring
	 * data (EntityContext) is available at the service layer.
	 *
	 * If the entity is not part of a multi-member cluster, returns the
	 * entity id itself.
	 */
	async resolvePrimaryEntityId(entityId: UUID): Promise<UUID> {
		const members = await this.getMemberEntityIds(entityId);
		if (members.length <= 1) {
			return entityId;
		}
		const contactEntries = await Promise.all(
			members.map(async (memberId) => {
				const contact = await this.getContact(memberId);
				return contact ? memberId : null;
			}),
		);
		for (const candidate of contactEntries) {
			if (candidate) {
				return candidate;
			}
		}
		const sorted = [...members].sort();
		return sorted[0];
	}

	/**
	 * Build a UnionFind keyed by UUID containing every entity reachable
	 * from `seedEntityId` via confirmed identity-link relationships or
	 * shared entity_identities rows.
	 *
	 * We expand iteratively so we don't have to materialise the full
	 * graph: at each step, we query relationships/identities for the
	 * newly-discovered frontier and union in any new neighbours.
	 */
	private async buildIdentityUnionFind(
		seedEntityId: UUID,
	): Promise<UnionFind<UUID>> {
		const uf = new UnionFind<UUID>([seedEntityId]);
		const visited = new Set<UUID>();
		let frontier: UUID[] = [seedEntityId];

		while (frontier.length > 0) {
			const nextFrontier = new Set<UUID>();
			const pending = frontier.filter((id) => !visited.has(id));
			for (const id of pending) {
				visited.add(id);
			}
			if (pending.length === 0) {
				break;
			}

			const relationships = await this.runtime.getRelationships({
				entityIds: pending,
			});
			for (const relationship of relationships) {
				if (!isConfirmedIdentityLinkLike(relationship)) continue;
				uf.union(relationship.sourceEntityId, relationship.targetEntityId);
				if (!visited.has(relationship.sourceEntityId)) {
					nextFrontier.add(relationship.sourceEntityId);
				}
				if (!visited.has(relationship.targetEntityId)) {
					nextFrontier.add(relationship.targetEntityId);
				}
			}

			const identityRows = await this.getIdentityRowsForEntities(pending);
			const entitiesByHandleKey = new Map<string, Set<UUID>>();
			for (const row of identityRows) {
				if (CONTACT_HANDLE_PLATFORMS.has(row.platform.toLowerCase())) {
					continue;
				}
				const key = `${row.platform.toLowerCase()}:${row.handle.toLowerCase()}`;
				const bucket = entitiesByHandleKey.get(key) ?? new Set<UUID>();
				bucket.add(row.entityId);
				entitiesByHandleKey.set(key, bucket);
			}
			for (const key of entitiesByHandleKey.keys()) {
				const matches = await this.findEntitiesSharingHandleKey(key);
				const combined = entitiesByHandleKey.get(key) ?? new Set<UUID>();
				for (const m of matches) combined.add(m);
				if (combined.size < 2) continue;
				const members = Array.from(combined);
				const anchor = members[0];
				for (const other of members.slice(1)) {
					uf.union(anchor, other);
					if (!visited.has(other)) {
						nextFrontier.add(other);
					}
				}
			}

			frontier = Array.from(nextFrontier);
		}

		return uf;
	}

	private async getIdentityRowsForEntities(
		entityIds: UUID[],
	): Promise<Array<{ entityId: UUID; platform: string; handle: string }>> {
		if (entityIds.length === 0) return [];
		if (!this.getRuntimeDb()) return [];
		const quoted = entityIds.map(sqlQuote).join(", ");
		const result = await this.execSql(
			`SELECT entity_id, platform, handle
			 FROM entity_identities
			 WHERE agent_id = ${sqlQuote(this.runtime.agentId)}
				AND entity_id IN (${quoted})`,
		);
		const rows: Array<{ entityId: UUID; platform: string; handle: string }> =
			[];
		for (const row of result.rows) {
			const e = row.entity_id;
			const p = row.platform;
			const h = row.handle;
			if (
				typeof e !== "string" ||
				typeof p !== "string" ||
				typeof h !== "string"
			) {
				continue;
			}
			rows.push({ entityId: asUUID(e), platform: p, handle: h });
		}
		return rows;
	}

	private async findEntitiesSharingHandleKey(
		handleKey: string,
	): Promise<UUID[]> {
		const [platform, handle] = handleKey.split(":", 2);
		if (!platform || handle === undefined) return [];
		if (!this.getRuntimeDb()) return [];
		const result = await this.execSql(
			`SELECT DISTINCT entity_id
			 FROM entity_identities
			 WHERE agent_id = ${sqlQuote(this.runtime.agentId)}
				AND LOWER(platform) = ${sqlQuote(platform)}
				AND LOWER(handle) = ${sqlQuote(handle)}`,
		);
		const ids: UUID[] = [];
		for (const row of result.rows) {
			const e = row.entity_id;
			if (typeof e === "string" && e.length > 0) {
				ids.push(asUUID(e));
			}
		}
		return ids;
	}

	// ───────────────────────────────────────────────────────────────────────
	// Graph snapshot / person detail
	// ───────────────────────────────────────────────────────────────────────

	/**
	 * Inject runtime resolvers used while building graph snapshots. Owner
	 * resolution and configured-owner-name lookup live outside core (they
	 * depend on agent-level config), so the agent package wires them in.
	 */
	setGraphResolvers(resolvers: GraphResolvers): void {
		this.graphResolvers = resolvers;
		this.graphServiceInstance = null;
		// Resolvers are agent-wired after service start; prewarm only once they
		// are set so the first-build owner/name path matches live turns (#17932).
		this.prewarmGraphModel();
	}

	/**
	 * Kick a background relationships-graph build so cold rolodex turns after
	 * restart hit the stale-while-revalidate cache instead of blocking provider
	 * composition on the first graph build (#17932).
	 */
	prewarmGraphModel(): void {
		if (!this.runtime) return;
		try {
			this.getGraphServiceInstance().prewarmGraphModel();
		} catch (err) {
			// error-policy:J5 Prewarm is best-effort; live turns still cold-build.
			logger.warn(
				`[RelationshipsService] Graph prewarm failed to start: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	private getGraphServiceInstance(): RelationshipsGraphService {
		if (!this.graphServiceInstance) {
			this.graphServiceInstance = createNativeRelationshipsGraphService(
				this.runtime,
				this,
				this.graphResolvers,
			);
		}
		return this.graphServiceInstance;
	}

	async getGraphSnapshot(
		query: RelationshipsGraphQuery = {},
	): Promise<RelationshipsGraphSnapshot> {
		return this.getGraphServiceInstance().getGraphSnapshot(query);
	}

	async getPersonDetail(
		primaryEntityId: UUID,
	): Promise<RelationshipsPersonDetail | null> {
		return this.getGraphServiceInstance().getPersonDetail(primaryEntityId);
	}
}

// ───────────────────────────────────────────────────────────────────────
// Identity helpers (kept module-private)
// ───────────────────────────────────────────────────────────────────────

interface RuntimeDbExecutor {
	execute: (query: ReturnType<typeof sql.raw>) => Promise<unknown>;
}

function clampConfidence(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function sqlQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function sqlJsonbLiteral(value: unknown): string {
	return `${sqlQuote(JSON.stringify(value ?? null))}::jsonb`;
}

function parseEntityIdentityRow(
	row: Record<string, unknown>,
): EntityIdentityRecord {
	const id = row.id;
	const entityId = row.entity_id;
	const platform = row.platform;
	const handle = row.handle;
	if (
		typeof id !== "string" ||
		typeof entityId !== "string" ||
		typeof platform !== "string" ||
		typeof handle !== "string"
	) {
		throw new Error(
			"[RelationshipsService] entity_identities row missing required fields",
		);
	}
	const evidenceRaw = row.evidence_message_ids;
	const evidenceArray =
		typeof evidenceRaw === "string"
			? safeJsonArray(evidenceRaw)
			: Array.isArray(evidenceRaw)
				? evidenceRaw
				: [];
	const evidence: UUID[] = [];
	for (const entry of evidenceArray) {
		if (typeof entry === "string" && entry.length > 0) {
			evidence.push(asUUID(entry));
		}
	}
	return {
		id: asUUID(id),
		entityId: asUUID(entityId),
		platform,
		handle,
		verified: row.verified === true,
		confidence:
			typeof row.confidence === "number" && Number.isFinite(row.confidence)
				? row.confidence
				: 0,
		source: typeof row.source === "string" ? row.source : undefined,
		firstSeen: toIsoString(row.first_seen),
		lastSeen: toIsoString(row.last_seen),
		evidenceMessageIds: evidence,
	};
}

function parseMergeCandidateRow(
	row: Record<string, unknown>,
): MergeCandidateRecord {
	const id = row.id;
	const entityA = row.entity_a;
	const entityB = row.entity_b;
	if (
		typeof id !== "string" ||
		typeof entityA !== "string" ||
		typeof entityB !== "string"
	) {
		throw new Error(
			"[RelationshipsService] entity_merge_candidates row missing required fields",
		);
	}
	const status = row.status;
	const normalizedStatus: MergeCandidateStatus =
		status === "accepted" || status === "rejected" ? status : "pending";
	const evidenceRaw = row.evidence;
	let evidence: MergeCandidateEvidence = {};
	if (typeof evidenceRaw === "string") {
		const parsed = safeJsonObject(evidenceRaw);
		if (parsed) evidence = parsed as MergeCandidateEvidence;
	} else if (
		evidenceRaw &&
		typeof evidenceRaw === "object" &&
		!Array.isArray(evidenceRaw)
	) {
		evidence = evidenceRaw as MergeCandidateEvidence;
	}
	return {
		id: asUUID(id),
		entityA: asUUID(entityA),
		entityB: asUUID(entityB),
		confidence:
			typeof row.confidence === "number" && Number.isFinite(row.confidence)
				? row.confidence
				: 0,
		evidence,
		status: normalizedStatus,
		proposedAt: toIsoString(row.proposed_at),
		resolvedAt:
			row.resolved_at != null ? toIsoString(row.resolved_at) : undefined,
	};
}

function safeJsonArray(value: string): unknown[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	const parsed = JSON.parse(trimmed) as unknown;
	return Array.isArray(parsed) ? parsed : [];
}

function safeJsonObject(value: string): Record<string, unknown> | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const parsed = JSON.parse(trimmed) as unknown;
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		return parsed as Record<string, unknown>;
	}
	return null;
}

function toIsoString(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string") {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return new Date(value).toISOString();
	}
	return new Date().toISOString();
}
