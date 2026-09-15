/**
 * Barrel re-exporting every Drizzle table schema in this plugin, assembled
 * into the plugin's `schema` export so `DatabaseMigrationService` can
 * auto-migrate all of them at startup.
 */
export { agentTable } from "./agent";
export { approvalDispatchControlTable } from "./approvalDispatchControl";
export { approvalRequestTable } from "./approvalRequests";
export type { AuthAuditOutcome } from "./authAuditEvent";
export { authAuditEventTable } from "./authAuditEvent";
export { authBootstrapJtiSeenTable } from "./authBootstrapJti";
export type { AuthIdentityKind } from "./authIdentity";
export {
  authIdentityCreatedAtDefault,
  authIdentityTable,
} from "./authIdentity";
export { authOwnerBindingTable } from "./authOwnerBinding";
export { authOwnerLoginTokenTable } from "./authOwnerLoginToken";
export type { AuthSessionKind } from "./authSession";
export { authSessionTable } from "./authSession";
export { cacheTable } from "./cache";
export { channelTable } from "./channel";
export { channelParticipantsTable } from "./channelParticipant";
export { componentTable } from "./component";
export {
  connectorAccountAuditEventsTable,
  connectorAccountCredentialsTable,
  connectorAccountsTable,
  oauthFlowsTable,
} from "./connectorAccounts";
export { embeddingTable } from "./embedding";
export { entityTable } from "./entity";
export {
  entityIdentityTable,
  entityMergeCandidateTable,
  factCandidateTable,
} from "./entityIdentity";
export {
  identityAuthorityStateTable,
  identityCanonicalRedirectTable,
  identityClaimTable,
  identityMergeConfirmationTable,
  identityMergeJournalTable,
  identityPersonLinkAttestationTable,
} from "./identityAuthority";
export { logTable } from "./log";
export { longTermMemories } from "./longTermMemories";
export {
  membershipAuthorityJournalTable,
  membershipAuthorityScopeTable,
  membershipAuthorityTable,
} from "./membershipAuthority";
export { memoryTable } from "./memory";
export { memoryAccessLogs } from "./memoryAccessLogs";
export { messageTable } from "./message";
export { messageServerTable } from "./messageServer";
export { messageServerAgentsTable } from "./messageServerAgent";
export { pairingAllowlistTable } from "./pairingAllowlist";
export { pairingRequestTable } from "./pairingRequest";
export { participantTable } from "./participant";
export { relationshipTable } from "./relationship";
export { roomTable } from "./room";
export { serverTable } from "./server";
export { sessionSummaries } from "./sessionSummaries";
export { taskTable } from "./tasks";
export { worldTable } from "./world";
export { worldRoleAuditTable } from "./worldRoleAudit";
