/**
 * Pure formatting and aggregation helpers for the experience capability. Renders
 * an `Experience` for display, prompt injection, list, and RAG-storage text
 * (with per-type emoji), groups experiences by domain, and computes aggregate
 * stats (counts by type/outcome/domain, average confidence/importance, and
 * success rate). Keyword extraction falls back to deriving terms from
 * tags/learning/action/type/outcome/domain when none are stored. Consumed by the
 * experience providers/prompts and pinned by experienceFormatter.test.ts.
 */
import type { Experience } from "../types";
import { ExperienceType, OutcomeType } from "../types";

export function formatExperienceForDisplay(experience: Experience): string {
	const typeEmoji = getTypeEmoji(experience.type);
	const timestamp = new Date(experience.createdAt).toLocaleString();

	return `${typeEmoji} ${experience.type.toUpperCase()} - ${timestamp}
Action: ${experience.action}
Learning: ${experience.learning}
Confidence: ${Math.round(experience.confidence * 100)}%
Importance: ${Math.round(experience.importance * 100)}%
Domain: ${experience.domain}
Tags: ${experience.tags.join(", ")}`;
}

export function formatExperienceSummary(experience: Experience): string {
	const typeEmoji = getTypeEmoji(experience.type);
	return `${typeEmoji} ${experience.learning} (${Math.round(experience.confidence * 100)}% confidence)`;
}

export function formatExperienceForPrompt(
	experience: Experience,
	index?: number,
): string {
	const prefix = typeof index === "number" ? `${index + 1}. ` : "";
	const tags = experience.tags.length > 0 ? experience.tags.join(", ") : "none";
	const keywords =
		experience.keywords.length > 0 ? experience.keywords.join(", ") : tags;
	// Repeated extraction fields can be byte-identical. Use an explicit local
	// reference instead of sending the same learning twice; distinct reasons
	// and all other provenance remain complete.
	const reason =
		experience.result || experience.extractionReason || "past experience";
	return `${prefix}DO: ${experience.learning}
WHEN: ${experience.context || experience.action || "similar situation"}
WHY: ${reason === experience.learning ? "Same text as DO above." : reason}
META: id=${experience.id}; domain=${experience.domain}; confidence=${Math.round(
		experience.confidence * 100,
	)}%; importance=${Math.round(experience.importance * 100)}%; keywords=${keywords}`;
}

export function formatExperienceList(experiences: Experience[]): string {
	if (experiences.length === 0) {
		return "No experiences found.";
	}

	return experiences
		.map((exp, index) => `${index + 1}. ${formatExperienceSummary(exp)}`)
		.join("\n");
}

export function formatPatternSummary(pattern: {
	description: string;
	frequency: number;
	significance: string;
}): string {
	const significanceEmoji =
		{
			high: "🔴",
			medium: "🟡",
			low: "🟢",
		}[pattern.significance] || "⚪";

	return `${significanceEmoji} ${pattern.description} (observed ${pattern.frequency} times)`;
}

export function groupExperiencesByDomain(
	experiences: Experience[],
): Map<string, Experience[]> {
	const groups = new Map<string, Experience[]>();

	experiences.forEach((exp) => {
		const group = groups.get(exp.domain) || [];
		group.push(exp);
		groups.set(exp.domain, group);
	});

	return groups;
}

export function getExperienceStats(experiences: Experience[]): {
	total: number;
	byType: Record<ExperienceType, number>;
	byOutcome: Record<OutcomeType, number>;
	byDomain: Record<string, number>;
	averageConfidence: number;
	averageImportance: number;
	successRate: number;
} {
	const stats = {
		total: experiences.length,
		byType: {} as Record<ExperienceType, number>,
		byOutcome: {} as Record<OutcomeType, number>,
		byDomain: {} as Record<string, number>,
		averageConfidence: 0,
		averageImportance: 0,
		successRate: 0,
	};

	if (experiences.length === 0) return stats;

	// Count by type
	Object.values(ExperienceType).forEach((type) => {
		stats.byType[type] = experiences.filter((e) => e.type === type).length;
	});

	// Count by outcome
	Object.values(OutcomeType).forEach((outcome) => {
		stats.byOutcome[outcome] = experiences.filter(
			(e) => e.outcome === outcome,
		).length;
	});

	// Count by domain
	const domains = [...new Set(experiences.map((e) => e.domain))];
	domains.forEach((domain) => {
		stats.byDomain[domain] = experiences.filter(
			(e) => e.domain === domain,
		).length;
	});

	// Calculate averages
	const totalConfidence = experiences.reduce(
		(sum, exp) => sum + exp.confidence,
		0,
	);
	stats.averageConfidence = totalConfidence / experiences.length;

	const totalImportance = experiences.reduce(
		(sum, exp) => sum + exp.importance,
		0,
	);
	stats.averageImportance = totalImportance / experiences.length;

	// Calculate success rate
	const positiveCount = stats.byOutcome[OutcomeType.POSITIVE] || 0;
	const negativeCount = stats.byOutcome[OutcomeType.NEGATIVE] || 0;
	const totalAttempts = positiveCount + negativeCount;
	stats.successRate = totalAttempts > 0 ? positiveCount / totalAttempts : 0;

	return stats;
}

function getTypeEmoji(type: ExperienceType): string {
	const emojiMap = {
		[ExperienceType.SUCCESS]: "✅",
		[ExperienceType.FAILURE]: "❌",
		[ExperienceType.DISCOVERY]: "💡",
		[ExperienceType.CORRECTION]: "🔄",
		[ExperienceType.LEARNING]: "📚",
		[ExperienceType.HYPOTHESIS]: "🤔",
		[ExperienceType.VALIDATION]: "✔️",
		[ExperienceType.WARNING]: "⚠️",
	};

	return emojiMap[type] || "📝";
}

export function formatExperienceForRAG(experience: Experience): string {
	// Format for knowledge storage and retrieval
	const parts = [
		`Experience Type: ${experience.type}`,
		`Outcome: ${experience.outcome}`,
		`Domain: ${experience.domain}`,
		`Action: ${experience.action}`,
		`Context: ${experience.context}`,
		`Result: ${experience.result}`,
		`Learning: ${experience.learning}`,
		`Confidence: ${experience.confidence}`,
		`Importance: ${experience.importance}`,
		`Tags: ${experience.tags.join(", ")}`,
	];

	if (experience.previousBelief) {
		parts.push(`Previous Belief: ${experience.previousBelief}`);
	}

	if (experience.correctedBelief) {
		parts.push(`Corrected Belief: ${experience.correctedBelief}`);
	}

	return parts.join("\n");
}

export function extractKeywords(experience: Experience): string[] {
	if (experience.keywords.length > 0) {
		return [...experience.keywords];
	}

	const keywords = new Set<string>();

	// Add tags
	experience.tags.forEach((tag) => {
		keywords.add(tag.toLowerCase());
	});

	// Extract words from learning
	const learningWords = experience.learning
		.toLowerCase()
		.split(/\W+/)
		.filter((word) => word.length > 3);

	learningWords.forEach((word) => {
		keywords.add(word);
	});

	// Add action name parts
	const actionParts = experience.action
		.split(/[_\-\s]+/)
		.filter((part) => part.length > 2);

	actionParts.forEach((part) => {
		keywords.add(part.toLowerCase());
	});

	// Add type, outcome, and domain
	keywords.add(experience.type);
	keywords.add(experience.outcome);
	keywords.add(experience.domain);

	return Array.from(keywords);
}
