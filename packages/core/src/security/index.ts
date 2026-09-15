/** Public surface for redaction, untrusted-content handling, and runtime security primitives. */

export { userRequestFromAugmentedText } from "./augmented-request.js";
export { mnemonicValid } from "./bip39-wordlist.js";
export {
	applyCapabilityManifest,
	assertHostAllowed,
	assertPathAllowed,
	CapabilityDeadlineError,
	type CapabilityManifest,
	CapabilityViolationError,
	frozenEnv,
	isHostAllowed,
	isPathAllowed,
	withCapabilityGovernance,
} from "./capability-manifest.js";
export {
	CompositeEntityRecognizer,
	canonicalKind,
	type EntitySpan,
	GazetteerEntityRecognizer,
	PII_ENTITY_RECOGNIZER_SERVICE,
	type PiiEntityRecognizer,
	type PiiEntityRecognizerService,
	RegexEntityRecognizer,
	type RegexEntityRecognizerOptions,
} from "./entity-recognizer.js";
export {
	buildSafeExternalPrompt,
	containsExternalEnvelopeMarkers,
	containsExternalEnvelopeMaterial,
	detectSuspiciousPatterns,
	type ExternalContentSource,
	getHookType,
	isExternalHookSession,
	renderStoredEnvelopesForPrompt,
	type WrapExternalContentOptions,
	wrapExternalContent,
	wrapWebContent,
} from "./external-content.js";
export {
	type GuardedStreamOutput,
	GuardedStreamScanner,
	type GuardedStreamScannerOptions,
} from "./guarded-stream.js";
export {
	hardenIncomingUserMessage,
	type IncomingMessageSecurityMetadata,
	messageHasPromptInjectionFlag,
	registerCoreIncomingMessageSecurityHook,
	scrubIncomingMessageTextForStorage,
	unwrapUserMessageText,
	unwrapUserMessageTextForDetection,
} from "./incoming-message-security.js";
export {
	ENVELOPE_LEAK_NOTICE,
	guardOutboundEnvelopeText,
} from "./outbound-envelope-guard.js";
export {
	type AssembleContextPackRequest,
	assembleContextPack,
	buildScrubRequestDraft,
	entityResolverFromStore,
	type PiiContextFragment,
	type PiiContextPack,
	type PiiContextSources,
	type PiiEntityResolverStore,
	type PiiResolvedEntity,
	type PiiScrubCandidate,
	type RuntimeContextSourceOptions,
	sourcesFromRuntime,
} from "./pii-context-pack.js";
export {
	cardBrand,
	detectPii,
	ibanValid,
	ipv4Valid,
	luhnValid,
	PII_DETECTOR_BY_KIND,
	PII_DETECTORS,
	type PiiDetector,
	type PiiMatch,
	ssnValid,
	wifValid,
} from "./pii-detectors.js";
export {
	type AliasSubstitutionResult,
	type AssignClusterInput,
	assertValidSnapshot,
	CorpusPseudonymMap,
	type CorpusPseudonymMapOptions,
	type PseudonymClusterIdentity,
	type PseudonymClusterRecord,
	PseudonymMapIntegrityError,
	type PseudonymMapSnapshot,
} from "./pii-pseudonym-map.js";
export {
	EncryptedCachePseudonymMapStore,
	type EncryptedCachePseudonymMapStoreOptions,
	PII_PSEUDONYM_MAP_AAD,
	PII_PSEUDONYM_MAP_CACHE_KEY,
	type PseudonymMapStore,
	PseudonymMapStoreError,
} from "./pii-pseudonym-map-store.js";
export {
	collectPiiPromptText,
	DEFAULT_PSEUDONYM_BLOCKLIST,
	isPiiPseudonymUnbounded,
	MAX_PII_PSEUDONYM_KEY_BYTES,
	MAX_PII_PSEUDONYM_WALK_BYTES,
	MAX_PII_PSEUDONYM_WALK_DEPTH,
	MAX_PII_PSEUDONYM_WALK_NODES,
	PII_PSEUDONYM_UNBOUNDED,
	PII_SWAP_DISABLED_KINDS_SETTING,
	PII_SWAP_ENABLED_SETTING,
	PII_SWAP_EXEMPT_VALUES_SETTING,
	type PseudonymEntry,
	PseudonymSession,
	type PseudonymSessionOptions,
	parsePiiSwapList,
} from "./pii-pseudonymizer.js";
export {
	assertValidScrubResult,
	PiiScrubFabricationError,
	type ScrubEscalationRequest,
	type ScrubEscalationResult,
	type ScrubResultAssertionOptions,
	scrubWithEscalation,
	type Tier0Span,
} from "./pii-scrub-seam.js";
export {
	createSecretsRedactor,
	// Pattern-based redaction
	getDefaultRedactPatterns,
	// Name-based redaction (single source of truth for credential key names)
	isSensitiveKeyName,
	type RedactOptions,
	type RedactSensitiveMode,
	// Log-sink redaction (structural, not opt-in)
	redactLogArgs,
	redactObjectSecrets,
	redactSecrets,
	redactSensitiveText,
	redactToolDetail,
	redactWithSecrets,
	// Secrets-based redaction
	type SecretsRedactOptions,
} from "./redact.js";
export {
	parseSecretSwapExemptValues,
	SECRET_SWAP_ENABLED_SETTING,
	SECRET_SWAP_EXEMPT_VALUES_SETTING,
	type SecretSwapEntry,
	SecretSwapSession,
	SecretSwapUnresolvedPlaceholderError,
} from "./secret-swap.js";
export {
	BLOCKED_SPAWN_ENV_KEYS,
	BLOCKED_SPAWN_ENV_PREFIXES,
	isBlockedSpawnEnvKey,
	sanitizeSpawnEnv,
} from "./spawn-env-policy.js";
export {
	composeToolDiagnosticRedactor,
	projectCompleteToolValueForModel,
	projectModelCallDiagnosticValue,
	projectProtectedModelCallValue,
	projectToolDiagnosticArgs,
	projectToolDiagnosticValue,
	TOOL_DIAGNOSTIC_MASK,
	type ToolDiagnosticTextRedactor,
} from "./tool-diagnostics.js";
export {
	attestAuthenticatedApiDeliveryAudience,
	attestDeliveryAudienceFromCanonicalRoom,
	authorizeOwnerExclusiveDisclosure,
	disclosureGateFailure,
	evaluateOwnerExclusiveDisclosure,
	getTrustedDeliveryAudience,
	INTERNAL_AGENT_TURN_DISCLOSURE_BASIS,
	markOwnerExclusiveDisclosureUsed,
	OWNER_EXCLUSIVE_DISCLOSURE_GATE,
	OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS,
	type OwnerExclusiveDisclosureBasis,
	type OwnerExclusiveDisclosureDecision,
	type OwnerExclusiveDisclosureDenial,
	ownerExclusiveDisclosureWasUsed,
	ownerExclusiveSuppressionNote,
	PRIVACY_DENIED_TEXT,
	recordOwnerExclusiveSuppression,
	registerRuntimeManagedInternalActor,
	revalidateOwnerExclusiveDisclosure,
	type TrustedApiPrincipal,
	type TrustedDeliveryAudience,
	type TrustedDeliveryAudienceKind,
	type TrustedDeliveryAudienceProvenance,
	trustedDeliveryAudienceCacheKey,
	trustedDeliveryAudienceIsBoundToRuntime,
} from "./trusted-delivery-audience.js";
