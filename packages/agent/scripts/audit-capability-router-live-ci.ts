// Drives repo automation audit capability router live ci with explicit CLI and CI behavior.
import { readFileSync } from "node:fs";

const workflowPath = ".github/workflows/test.yml";
const rootPackagePath = "package.json";
const agentPackagePath = "packages/agent/package.json";
const coreCapabilitiesPath = "packages/core/src/capabilities/index.ts";
const endpointConformancePath =
  "packages/agent/src/services/remote-capability-endpoint-conformance.ts";
const remoteCapabilityRoutesPath =
  "packages/agent/src/api/remote-capability-routes.ts";
const remotePluginAdapterTestPath =
  "packages/agent/src/services/remote-plugin-adapter.test.ts";
const liveReportWriterPath =
  "packages/agent/src/services/remote-capability-live-report.ts";
const providerSmokePath =
  "packages/agent/src/services/remote-capability-url-endpoint-providers.provider-smoke.test.ts";
const liveReportValidatorPath =
  "packages/agent/scripts/validate-capability-router-live-reports.ts";
const liveReportValidatorSelfTestPath =
  "packages/agent/scripts/validate-capability-router-live-reports.self-test.ts";
const githubLiveArtifactValidatorPath =
  "packages/agent/scripts/validate-capability-router-github-live-artifacts.ts";
const githubLiveArtifactValidatorSelfTestPath =
  "packages/agent/scripts/validate-capability-router-github-live-artifacts.self-test.ts";

type Check = {
  name: string;
  pattern: RegExp;
  source?:
    | "agent-package"
    | "core-capabilities"
    | "endpoint-conformance"
    | "github-live-artifact-validator"
    | "github-live-artifact-validator-self-test"
    | "live-report-validator"
    | "live-report-validator-self-test"
    | "live-report-writer"
    | "provider-smoke"
    | "remote-capability-routes"
    | "remote-plugin-adapter-test"
    | "root-package"
    | "workflow";
  message: string;
};

type CheckSource = NonNullable<Check["source"]>;

type CheckContentOptions = {
  agentPackageJson?: string;
  coreCapabilitiesSource?: string;
  endpointConformanceSource?: string;
  githubLiveArtifactValidatorSource?: string;
  githubLiveArtifactValidatorSelfTestSource?: string;
  liveReportValidatorSelfTestSource?: string;
  providerSmokeSource?: string;
  remoteCapabilityRoutesSource?: string;
  remotePluginAdapterTestSource?: string;
  rootPackageJson?: string;
  liveReportValidatorSource?: string;
  liveReportWriterSource?: string;
  onlyCheckNames?: Iterable<string>;
};

const checkContentReaders: Record<
  CheckSource,
  (options: CheckContentOptions, workflow: string) => string
> = {
  "agent-package": (options) => options.agentPackageJson ?? "",
  "core-capabilities": (options) => options.coreCapabilitiesSource ?? "",
  "endpoint-conformance": (options) => options.endpointConformanceSource ?? "",
  "github-live-artifact-validator": (options) =>
    options.githubLiveArtifactValidatorSource ?? "",
  "github-live-artifact-validator-self-test": (options) =>
    options.githubLiveArtifactValidatorSelfTestSource ?? "",
  "live-report-validator": (options) => options.liveReportValidatorSource ?? "",
  "live-report-validator-self-test": (options) =>
    options.liveReportValidatorSelfTestSource ?? "",
  "live-report-writer": (options) => options.liveReportWriterSource ?? "",
  "provider-smoke": (options) => options.providerSmokeSource ?? "",
  "remote-capability-routes": (options) =>
    options.remoteCapabilityRoutesSource ?? "",
  "remote-plugin-adapter-test": (options) =>
    options.remotePluginAdapterTestSource ?? "",
  "root-package": (options) => options.rootPackageJson ?? "",
  workflow: (_options, workflow) => workflow,
};

const checkSourcePaths: Record<CheckSource, string | undefined> = {
  "agent-package": agentPackagePath,
  "core-capabilities": coreCapabilitiesPath,
  "endpoint-conformance": endpointConformancePath,
  "github-live-artifact-validator": githubLiveArtifactValidatorPath,
  "github-live-artifact-validator-self-test":
    githubLiveArtifactValidatorSelfTestPath,
  "live-report-validator": liveReportValidatorPath,
  "live-report-validator-self-test": liveReportValidatorSelfTestPath,
  "live-report-writer": liveReportWriterPath,
  "provider-smoke": providerSmokePath,
  "remote-capability-routes": remoteCapabilityRoutesPath,
  "remote-plugin-adapter-test": remotePluginAdapterTestPath,
  "root-package": rootPackagePath,
  workflow: undefined,
};

export type LiveCiAuditFailure = {
  sourcePath: string;
  workflowPath: string;
  name: string;
  message: string;
};

export const checks: Check[] = [
  {
    name: "cloud live job is required by ci-ok",
    pattern:
      /ci-ok:\s+name:[\s\S]*?needs:[\s\S]*?-\s*cloud-live-e2e[\s\S]*?-\s*provider-live-e2e/,
    message: "ci-ok must depend on cloud-live-e2e and provider-live-e2e.",
  },
  {
    name: "live CI audit self-test is a CI gate",
    pattern:
      /Remote capability live CI audit self-test[\s\S]*test:remote-capabilities:live-ci-audit:self-test/,
    message: "server CI must run the live CI audit self-test.",
  },
  {
    name: "live report validator self-test is a CI gate",
    pattern:
      /Remote capability live report validator self-test[\s\S]*test:remote-capabilities:validate-live-reports:self-test/,
    message: "server CI must run the live report validator self-test.",
  },
  {
    name: "GitHub live evidence validator self-test is a CI gate",
    pattern:
      /Remote capability GitHub live evidence self-test[\s\S]*test:remote-capabilities:github-live-evidence:self-test/,
    message: "server CI must run the GitHub live evidence validator self-test.",
  },
  {
    name: "GitHub live artifact validator self-test is a CI gate",
    pattern:
      /Remote capability GitHub live artifact self-test[\s\S]*test:remote-capabilities:github-live-artifacts:self-test/,
    message: "server CI must run the GitHub live artifact validator self-test.",
  },
  {
    name: "live report validator self-test script exists",
    pattern:
      /"test:remote-capabilities:validate-live-reports:self-test"\s*:\s*"bun packages\/agent\/scripts\/validate-capability-router-live-reports\.self-test\.ts"/,
    source: "root-package",
    message:
      "root package scripts must expose the live report validator self-test.",
  },
  {
    name: "live report validator script exists",
    pattern:
      /"test:remote-capabilities:validate-live-reports"\s*:\s*"bun packages\/agent\/scripts\/validate-capability-router-live-reports\.ts"/,
    source: "root-package",
    message: "root package scripts must expose the live report validator.",
  },
  {
    name: "live CI audit script exists",
    pattern:
      /"test:remote-capabilities:live-ci-audit"\s*:\s*"bun packages\/agent\/scripts\/audit-capability-router-live-ci\.ts"/,
    source: "root-package",
    message: "root package scripts must expose the live CI audit.",
  },
  {
    name: "live CI audit self-test script exists",
    pattern:
      /"test:remote-capabilities:live-ci-audit:self-test"\s*:\s*"bun packages\/agent\/scripts\/audit-capability-router-live-ci\.self-test\.ts"/,
    source: "root-package",
    message: "root package scripts must expose the live CI audit self-test.",
  },
  {
    name: "GitHub live evidence validator script exists",
    pattern:
      /"test:remote-capabilities:github-live-evidence"\s*:\s*"bun packages\/agent\/scripts\/validate-capability-router-github-live-evidence\.ts"/,
    source: "root-package",
    message:
      "root package scripts must expose the GitHub live evidence validator.",
  },
  {
    name: "GitHub live artifact validator script exists",
    pattern:
      /"test:remote-capabilities:github-live-artifacts"\s*:\s*"bun packages\/agent\/scripts\/validate-capability-router-github-live-artifacts\.ts"/,
    source: "root-package",
    message:
      "root package scripts must expose the GitHub live artifact validator.",
  },
  {
    name: "GitHub live evidence validator self-test script exists",
    pattern:
      /"test:remote-capabilities:github-live-evidence:self-test"\s*:\s*"bun packages\/agent\/scripts\/validate-capability-router-github-live-evidence\.self-test\.ts"/,
    source: "root-package",
    message:
      "root package scripts must expose the GitHub live evidence validator self-test.",
  },
  {
    name: "GitHub live artifact validator self-test script exists",
    pattern:
      /"test:remote-capabilities:github-live-artifacts:self-test"\s*:\s*"bun packages\/agent\/scripts\/validate-capability-router-github-live-artifacts\.self-test\.ts"/,
    source: "root-package",
    message:
      "root package scripts must expose the GitHub live artifact validator self-test.",
  },
  {
    name: "GitHub live artifact validator downloads and validates reports",
    pattern:
      /(?=[\s\S]*remote-capability-cloud-live-report)(?=[\s\S]*remote-capability-provider-live-report)(?=[\s\S]*"gh"[\s\S]*"run"[\s\S]*"download")(?=[\s\S]*test:remote-capabilities:validate-live-reports[\s\S]*"--kind"[\s\S]*"cloud")(?=[\s\S]*test:remote-capabilities:validate-live-reports[\s\S]*"--kind"[\s\S]*"provider")(?=[\s\S]*"--require-providers"[\s\S]*"home-machine,mobile-companion")/,
    source: "github-live-artifact-validator",
    message:
      "GitHub live artifact validation must download both artifacts and validate Cloud plus required provider report contents.",
  },
  {
    name: "GitHub live artifact validator self-test covers downloaded reports",
    pattern:
      /(?=[\s\S]*assertCommand\("downloads both named artifacts")(?=[\s\S]*remote-capability-cloud-live-report)(?=[\s\S]*remote-capability-provider-live-report)(?=[\s\S]*assertCommandIncludes\("validates cloud report artifact")(?=[\s\S]*assertCommandIncludes\("validates provider report artifact")/,
    source: "github-live-artifact-validator-self-test",
    message:
      "GitHub live artifact validator self-test must cover both downloaded artifact validators.",
  },
  {
    name: "GitHub live artifact validator self-test covers provider requirements",
    pattern:
      /(?=[\s\S]*"--allowed-providers")(?=[\s\S]*"home-machine,mobile-companion,desktop-companion")(?=[\s\S]*"--require-providers")(?=[\s\S]*"home-machine,mobile-companion")/,
    source: "github-live-artifact-validator-self-test",
    message:
      "GitHub live artifact validator self-test must cover the canonical provider allow/require lists.",
  },
  {
    name: "GitHub live artifact validator self-test rejects push runs before download",
    pattern:
      /(?=[\s\S]*assertFailsBeforeDownload)(?=[\s\S]*push run is rejected before artifact download)(?=[\s\S]*run event must be workflow_dispatch or schedule)(?=[\s\S]*downloaded artifacts after rejected run metadata)/,
    source: "github-live-artifact-validator-self-test",
    message:
      "GitHub live artifact validator self-test must reject unobserved push runs before downloading artifacts.",
  },
  {
    name: "canonical remote capability suite covers live report writer",
    pattern:
      /"test:remote-capabilities"[\s\S]*packages\/agent\/src\/services\/remote-capability-live-report\.test\.ts/,
    source: "agent-package",
    message:
      "test:remote-capabilities must include the live report writer safety test.",
  },
  {
    name: "core capability protocol includes signed module provenance",
    pattern:
      /export type RemotePluginModuleProvenance[\s\S]{0,400}issuer:\s*string[\s\S]{0,400}digestSha256:\s*string[\s\S]{0,400}signatureAlgorithm:\s*string[\s\S]{0,400}signature:\s*string[\s\S]*provenance\?:\s*RemotePluginModuleProvenance[\s\S]*requireRemotePluginModuleProvenance[\s\S]*digestSha256 must be a SHA-256 hex digest/,
    source: "core-capabilities",
    message:
      "core capability protocol must include typed signed module provenance with SHA-256 digest validation.",
  },
  {
    name: "remote adapter test covers endpoint-scoped stale unload",
    pattern:
      /scopes stale unloads to the selected endpoint so another device remains loaded[\s\S]*capabilityEndpointId:\s*"device-a"[\s\S]*capabilityEndpointId:\s*"device-b"[\s\S]*unloadMissingEndpointIds:\s*\["device-a"\][\s\S]*unloaded:\s*\["@remote\/device-a"\][\s\S]*"@remote\/device-b"[\s\S]*device-a\.view[\s\S]*toBeUndefined[\s\S]*device-b\.view[\s\S]*toMatchObject/,
    source: "remote-plugin-adapter-test",
    message:
      "remote adapter tests must prove endpoint-scoped stale unload preserves another connected device.",
  },
  {
    name: "product connect persists redacted trust audit records",
    pattern:
      /readTrustAuditRecords\([\s\S]{0,200}ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT[\s\S]*ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT = JSON\.stringify\([\s\S]{0,200}appendTrustAuditRecord\([\s\S]*redactEndpoint\(audit\.endpoint\)[\s\S]{0,800}trustDecisions:\s*audit\.sync\.trustDecisions/,
    source: "remote-capability-routes",
    message:
      "product connect persistence must record redacted capability-router trust-audit records.",
  },
  {
    name: "remote adapter test covers redacted product trust audit records",
    pattern:
      /ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT[\s\S]{0,6000}provider:\s*"direct"[\s\S]{0,6000}allowedModuleIds:\s*\["remote-demo"\][\s\S]{0,6000}trustDecisions:[\s\S]{0,6000}trusted:\s*true[\s\S]{0,6000}JSON\.stringify\(trustAudit\)\)\.not\.toContain\("product-token"\)/,
    source: "remote-plugin-adapter-test",
    message:
      "remote adapter tests must prove product connect persists trust audit records without bearer tokens.",
  },
  {
    name: "remote adapter test covers Cloud provision restart reopened view",
    pattern:
      /reopens a persisted Cloud-provisioned remote view after restart[\s\S]{0,16000}connectCloudSandbox:[\s\S]{0,16000}mockResolvedValue[\s\S]{0,16000}cloud-product-token[\s\S]{0,16000}plugin\.asset\.get[\s\S]{0,16000}bootstrapRemoteCapabilityPlugins\(restartRuntime\)[\s\S]{0,16000}getView\("cloud\.restart\.view"\)[\s\S]{0,16000}\/api\/capability-router\/assets\/cloud-product\/cloud-product-plugin\/assets\/cloud-view\.js[\s\S]{0,16000}Bearer cloud-product-token/,
    source: "remote-plugin-adapter-test",
    message:
      "remote adapter tests must prove Cloud provision persistence can restart, reopen the remote view, and fetch its bundle with the persisted token.",
  },
  {
    name: "remote adapter test covers signed provenance trust policy",
    pattern:
      /allowedProvenanceIssuers:\s*\["eliza-cloud-build"\][\s\S]{0,20000}requireSignedProvenance:\s*true[\s\S]{0,20000}provenanceIssuer:\s*"eliza-cloud-build"[\s\S]{0,20000}reason:\s*"missing-provenance"[\s\S]{0,20000}reason:\s*"provenance-issuer-not-allowed"[\s\S]{0,20000}trustedProvenancePublicKeys[\s\S]{0,20000}requireVerifiedProvenance:\s*true[\s\S]{0,20000}requireProvenanceDigestMatch:\s*true[\s\S]{0,20000}reason:\s*"invalid-provenance-signature"[\s\S]{0,20000}reason:\s*"invalid-provenance-digest"[\s\S]{0,20000}reason:\s*"missing-provenance-public-key"/,
    source: "remote-plugin-adapter-test",
    message:
      "remote adapter tests must prove trust policy can require signed provenance, allowlist provenance issuers, verify provenance signatures, and bind provenance digests to module contents.",
  },
  {
    name: "product connect persists provenance trust policy",
    pattern:
      /parseOptionalEndpointTrustPolicy[\s\S]*trustPolicy[\s\S]*persistEndpoint[\s\S]*ELIZA_CAPABILITY_ROUTER_TRUST_POLICY[\s\S]*mergePersistedTrustPolicies[\s\S]*normalizeEndpointTrustPolicyOptions/,
    source: "remote-capability-routes",
    message:
      "product connect persistence must carry provenance trust policy so restart bootstrap can keep verified remote-module trust requirements.",
  },
  {
    name: "live report writer records runtime module surface counts",
    pattern:
      /remotePlugins:[\s\S]*\.map\(\(plugin\) => \(\{[\s\S]*pluginName:\s*plugin\.name,[\s\S]*moduleId:\s*plugin\.config\?\.remoteCapabilityModuleId,[\s\S]*endpointId:\s*plugin\.config\?\.remoteCapabilityEndpointId,[\s\S]*\.\.\.summarizeRemoteCapabilityPluginSurfaces\(plugin\),/,
    source: "live-report-writer",
    message:
      "runtime.remotePlugins live summaries must record per-module surface counts.",
  },
  {
    name: "live report validator compares runtime module surface counts",
    pattern:
      /registeredModuleCountsByKey[\s\S]*validateRuntimeRemotePlugins\([\s\S]*registeredModuleCountsByKey[\s\S]*runtime\.remotePlugins\[\$\{index\}\]\.\$\{field\} must match sync\.registeredModules/,
    source: "live-report-validator",
    message:
      "live report validation must compare runtime.remotePlugins counts with sync.registeredModules.",
  },
  {
    name: "provider live reports include endpoint runtime evidence",
    pattern:
      /providerEvidence:[\s\S]*provider:\s*target\.label[\s\S]*endpointRuntime:\s*target\.endpointRuntime[\s\S]*agentRuntime:\s*"github-actions"[\s\S]*connection:\s*"url-backed-provider"/,
    source: "provider-smoke",
    message:
      "provider live reports must record the provider family, endpoint runtime, agent runtime, and URL-backed adapter path.",
  },
  {
    name: "live report validator requires provider runtime evidence",
    pattern:
      /function validateProviderEvidence[\s\S]*providerEvidence\.provider must match provider[\s\S]*CANONICAL_PROVIDER_ENDPOINT_RUNTIMES[\s\S]*providerEvidence\.agentRuntime must be "github-actions"[\s\S]*providerEvidence\.connection must be "url-backed-provider"/,
    source: "live-report-validator",
    message:
      "live report validation must require provider runtime evidence for provider reports.",
  },
  {
    name: "live report validator self-test covers provider runtime evidence",
    pattern:
      /missingProviderEvidenceDir[\s\S]*mismatchedProviderEvidenceDir[\s\S]*makeMissingProviderEvidenceReport\(\)[\s\S]*makeMismatchedProviderEvidenceReport\(\)[\s\S]*providerEvidence must be an object[\s\S]*providerEvidence\.endpointRuntime must be/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover missing and mismatched provider runtime evidence.",
  },
  {
    name: "endpoint conformance requires non-empty route bodies",
    pattern:
      /function assertRouteResult[\s\S]*hasMeaningfulRouteBody\(result\.body\)[\s\S]*function hasMeaningfulRouteBody[\s\S]*value === undefined \|\| value === null[\s\S]*Array\.isArray\(value\)[\s\S]*Object\.keys\(value\)\.length > 0/,
    source: "endpoint-conformance",
    message:
      "endpoint conformance must reject route calls without non-empty JSON body evidence.",
  },
  {
    name: "endpoint conformance verifies view asset bytes",
    pattern:
      /const assetBytes = Buffer\.from\(assetResult\.bodyBase64, "base64"\)[\s\S]*const byteLength = assetBytes\.byteLength[\s\S]*byteLength === 0[\s\S]*returned an empty view asset[\s\S]*createHash\("sha256"\)\.update\(assetBytes\)\.digest\("hex"\)/,
    source: "endpoint-conformance",
    message:
      "endpoint conformance must fetch non-empty view asset bytes and record their SHA-256 digest.",
  },
  {
    name: "endpoint conformance verifies view asset integrity against bytes",
    pattern:
      /function assertAssetIntegrity\([\s\S]*bytes: Buffer[\s\S]*createHash\(algorithm\)\.update\(bytes\)\.digest\("base64"\)[\s\S]*token\.startsWith\("sha256-"\)[\s\S]*digest && digest === expectedDigests\.get\(algorithm\)[\s\S]*view asset integrity value that does not match its bytes/,
    source: "endpoint-conformance",
    message:
      "endpoint conformance must compare returned view asset integrity values with fetched bytes.",
  },
  {
    name: "live report validator requires non-empty route bodies",
    pattern:
      /isMeaningfulJsonEvidence\(routeResult\.body\)[\s\S]*conformance\.routeResult\.body must be a non-empty JSON value[\s\S]*function isMeaningfulJsonEvidence[\s\S]*value === undefined \|\| value === null[\s\S]*Array\.isArray\(value\)[\s\S]*Object\.keys\(value\)\.length > 0/,
    source: "live-report-validator",
    message:
      "live report validation must reject route results without non-empty JSON body evidence.",
  },
  {
    name: "live report validator verifies view asset metadata",
    pattern:
      /conformance\.assetResult\.path[\s\S]*\.\(\?:js\|mjs\)\$[\s\S]*conformance\.assetResult\.contentType must be JavaScript[\s\S]*manifestContentType !== undefined &&[\s\S]*manifestContentType !== assetContentType[\s\S]*manifestIntegrity !== undefined &&[\s\S]*manifestIntegrity !== assetIntegrity/,
    source: "live-report-validator",
    message:
      "live report validation must reject non-JavaScript and manifest-mismatched view asset evidence.",
  },
  {
    name: "live report validator verifies view asset digest evidence",
    pattern:
      /conformance\.assetResult\.byteLength[\s\S]*byteLength <= 0[\s\S]*conformance\.assetResult\.sha256[\s\S]*\^\[0-9a-f\]\{64\}\$[\s\S]*assetSha256\.toLowerCase\(\) === EMPTY_SHA256[\s\S]*validateAssetIntegritySha256\(assetIntegrity, assetSha256\.toLowerCase\(\)\)/,
    source: "live-report-validator",
    message:
      "live report validation must reject empty, malformed, and integrity-mismatched view asset digests.",
  },
  {
    name: "live report validator compares view asset integrity to digest",
    pattern:
      /function validateAssetIntegritySha256[\s\S]*filter\(\(token\) => token\.startsWith\("sha256-"\)\)[\s\S]*Buffer\.from\(assetSha256, "hex"\)\.toString\("base64"\)[\s\S]*sha256Tokens\.includes\(`sha256-\$\{expectedDigest\}`\)[\s\S]*conformance\.assetResult\.integrity must match conformance\.assetResult\.sha256/,
    source: "live-report-validator",
    message:
      "live report validation must compare view asset integrity tokens with the recorded SHA-256 digest.",
  },
  {
    name: "live report validator self-test covers non-JavaScript asset failures",
    pattern:
      /nonJavascriptAssetDir[\s\S]*makeNonJavascriptAssetReport\(\)[\s\S]*conformance\.assetResult\.path must be a JavaScript asset/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover non-JavaScript asset evidence.",
  },
  {
    name: "live report validator self-test covers missing route body failures",
    pattern:
      /missingRouteBodyDir[\s\S]*makeMissingRouteBodyReport\(\)[\s\S]*conformance\.routeResult\.body must be a non-empty JSON value/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover missing route body evidence.",
  },
  {
    name: "live report validator self-test covers empty route body failures",
    pattern:
      /emptyRouteBodyDir[\s\S]*makeEmptyRouteBodyReport\(\)[\s\S]*conformance\.routeResult\.body must be a non-empty JSON value/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover empty route body evidence.",
  },
  {
    name: "live report validator self-test covers manifest-mismatched asset failures",
    pattern:
      /mismatchedAssetManifestDir[\s\S]*makeMismatchedAssetManifestReport\(\)[\s\S]*conformance\.assetResult\.manifestContentType must match/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover manifest-mismatched asset evidence.",
  },
  {
    name: "live report validator self-test covers missing asset digest failures",
    pattern:
      /missingAssetDigestDir[\s\S]*makeMissingAssetDigestReport\(\)[\s\S]*conformance\.assetResult\.sha256 must be a non-empty string/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover missing view asset digests.",
  },
  {
    name: "live report validator self-test covers malformed asset digest failures",
    pattern:
      /malformedAssetDigestDir[\s\S]*makeMalformedAssetDigestReport\(\)[\s\S]*conformance\.assetResult\.sha256 has invalid format/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover malformed view asset digests.",
  },
  {
    name: "live report validator self-test covers empty asset digest failures",
    pattern:
      /emptyAssetDigestDir[\s\S]*makeEmptyAssetDigestReport\(\)[\s\S]*conformance\.assetResult\.sha256 must not be the empty SHA-256 digest/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover empty view asset digests.",
  },
  {
    name: "live report validator self-test covers mismatched asset integrity failures",
    pattern:
      /mismatchedAssetIntegrityDir[\s\S]*makeMismatchedAssetIntegrityReport\(\)[\s\S]*conformance\.assetResult\.integrity must match conformance\.assetResult\.sha256/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover mismatched view asset integrity evidence.",
  },
  {
    name: "live report validator self-test covers missing sha256 asset integrity failures",
    pattern:
      /missingSha256AssetIntegrityDir[\s\S]*makeMissingSha256AssetIntegrityReport\(\)[\s\S]*conformance\.assetResult\.integrity must include a sha256 digest/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover missing-sha256 view asset integrity evidence.",
  },
  {
    name: "provider live job is required by ci-ok",
    // strict_results may enumerate additional strict events (push, merge_group)
    // ahead of workflow_dispatch/schedule; require both dispatch and schedule are
    // present, and that the aggregate for-loop observes both live job results.
    pattern:
      /strict_results="\$\{\{[\s\S]*?github\.event_name == 'workflow_dispatch'[\s\S]*?github\.event_name == 'schedule'[\s\S]*?\}\}"[\s\S]*for pair in\s*\\[\s\S]*"cloud-live-e2e:\$\{\{\s*needs\.cloud-live-e2e\.result\s*\}\}"\s*\\[\s\S]*"provider-live-e2e:\$\{\{\s*needs\.provider-live-e2e\.result\s*\}\}"/,
    message:
      "ci-ok must fail when cloud-live-e2e or provider-live-e2e are not successful on workflow_dispatch or schedule.",
  },
  {
    name: "manual remote capability live observation is explicit",
    pattern:
      /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*remote_capability_live:[\s\S]{0,300}default:\s*false[\s\S]{0,100}type:\s*boolean/,
    message:
      "manual Tests runs must require an explicit remote_capability_live input before observing external capability providers.",
  },
  {
    name: "cloud live smoke is observed only on manual or scheduled runs",
    pattern:
      /Remote capability cloud sandbox live smoke[\s\S]{0,300}steps\.cloud\.outputs\.capability_skip != 'true'[\s\S]{0,300}github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'schedule'[\s\S]{0,300}test:remote-capabilities:cloud-live/,
    message:
      "cloud live smoke must run on workflow_dispatch or schedule events when capability live config is present.",
  },
  {
    name: "cloud live credentials skip cleanly when absent",
    // The skip warning composes a `message=` variable, so the "configured"
    // phrase and the "skipping optional cloud live E2E" warning land on separate
    // lines with the strict-context fail branch between them.
    pattern:
      /No Eliza Cloud API key configured[\s\S]{0,400}skipping optional cloud live E2E[\s\S]{0,200}skip=true[\s\S]{0,200}capability_skip=true[\s\S]{0,200}exit 0/,
    message:
      "cloud live runs must skip cleanly when Cloud credentials are absent.",
  },
  {
    name: "cloud capability live smoke is explicitly configured",
    pattern:
      /CAPABILITY_LIVE_REQUIRED:.*github\.event_name == 'schedule'.*inputs\.remote_capability_live[\s\S]{0,2500}CAPABILITY_LIVE_REQUIRED.*!= "true"[\s\S]{0,300}capability_skip=true[\s\S]{0,300}ELIZA_REMOTE_CAPABILITY_CLOUD_LIVE_ENABLED.*= "1"[\s\S]{0,200}capability_skip=false/,
    message:
      "cloud capability live smoke must be mandatory on schedules or explicit manual requests and skipped on ordinary manual runs.",
  },
  {
    name: "cloud live report validation is strict",
    pattern:
      /test:remote-capabilities:validate-live-reports --kind cloud --expect-count 1 --max-age-minutes 90 --max-future-minutes 5 --require-ci --require-file-identity --match-github-env reports\/remote-capabilities\/cloud/,
    message:
      "cloud live validation must require count, freshness, CI identity, file identity, and GitHub env matching.",
  },
  {
    name: "cloud live smoke writes reports to the validated directory",
    pattern:
      /Remote capability cloud sandbox live smoke[\s\S]*ELIZA_REMOTE_CAPABILITY_LIVE_REPORT_DIR: reports\/remote-capabilities\/cloud\s*\n[\s\S]*Validate remote capability cloud live report[\s\S]*reports\/remote-capabilities\/cloud/,
    message:
      "cloud live smoke must write reports to the same directory that validation consumes.",
  },
  {
    name: "cloud live report prune only runs after checkout-backed live runs",
    pattern:
      /Prune remote capability cloud report\s*\n\s*if: always\(\) && steps\.checkout\.outcome == 'success' && steps\.cloud\.outputs\.capability_skip != 'true' && \(github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'schedule'\)\s*\n\s*run: node packages\/scripts\/rm-path-recursive\.mjs reports\/remote-capabilities\/cloud/,
    message:
      "cloud live report pruning must not run on no-checkout skip paths.",
  },
  {
    name: "provider live smoke requires the three primary endpoint secrets",
    pattern:
      /missing_required=\(\)[\s\S]*missing_required\+=\("ELIZA_REMOTE_CAPABILITY_HOME_MACHINE_URL"\)[\s\S]*missing_required\+=\("ELIZA_REMOTE_CAPABILITY_MOBILE_COMPANION_URL"\)/,
    message:
      "provider live smoke must require home-machine and mobile-companion endpoints for observed runs.",
  },
  {
    name: "provider live smoke skips when manual observation was not requested",
    pattern:
      /LIVE_REQUIRED:.*github\.event_name == 'schedule'.*inputs\.remote_capability_live[\s\S]{0,500}LIVE_REQUIRED.*!= "true"[\s\S]{0,300}Remote capability provider live smoke was not requested[\s\S]{0,200}skip=true[\s\S]{0,100}exit 0/,
    message:
      "provider live runs must skip ordinary manual dispatches before endpoint availability is evaluated.",
  },
  {
    name: "provider live endpoints fail observed runs when absent",
    pattern:
      /No remote capability provider endpoints configured[\s\S]{0,300}strict \$\{EVENT_NAME\} live lanes must fail instead of greening by skip[\s\S]{0,100}exit 1/,
    message:
      "observed provider live runs must fail when all endpoint secrets are absent.",
  },
  {
    name: "provider live primary endpoint gaps fail observed runs",
    pattern:
      /Missing required remote capability provider endpoint secrets[\s\S]{0,300}strict \$\{EVENT_NAME\} live lanes must fail instead of greening by skip[\s\S]{0,100}exit 1/,
    message:
      "observed provider live runs must fail when any primary endpoint secret is absent.",
  },
  {
    name: "provider live smoke is observed only on manual or scheduled runs",
    pattern:
      /Remote capability URL-backed provider live smoke[\s\S]{0,300}github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'schedule'[\s\S]{0,300}test:remote-capabilities:provider-live/,
    message:
      "provider live smoke must run on workflow_dispatch or schedule events.",
  },
  {
    name: "provider live report validation requires all primary providers",
    pattern:
      /test:remote-capabilities:validate-live-reports --kind provider --expect-count 2\.\.3 --max-age-minutes 90 --max-future-minutes 5 --allowed-providers home-machine,mobile-companion,desktop-companion --require-providers home-machine,mobile-companion --require-ci --require-file-identity --match-github-env reports\/remote-capabilities\/providers/,
    message:
      "provider live validation must require home-machine, mobile-companion, freshness, CI identity, file identity, and GitHub env matching.",
  },
  {
    name: "provider live smoke writes reports to the validated directory",
    pattern:
      /Remote capability URL-backed provider live smoke[\s\S]*ELIZA_REMOTE_CAPABILITY_LIVE_REPORT_DIR: reports\/remote-capabilities\/providers\s*\n[\s\S]*Validate remote capability provider live reports[\s\S]*reports\/remote-capabilities\/providers/,
    message:
      "provider live smoke must write reports to the same directory that validation consumes.",
  },
  {
    name: "provider live report prune only runs after checkout-backed live runs",
    pattern:
      /Prune remote capability provider reports\s*\n\s*if: always\(\) && steps\.checkout\.outcome == 'success' && steps\.providers\.outputs\.skip != 'true' && \(github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'schedule'\)\s*\n\s*run: node packages\/scripts\/rm-path-recursive\.mjs reports\/remote-capabilities\/providers/,
    message:
      "provider live report pruning must not run on no-checkout skip paths.",
  },
  {
    name: "provider live reports include providerId evidence",
    pattern:
      /writeRemoteCapabilityLiveReport\(target\.label,[\s\S]*provider:\s*target\.label,[\s\S]*providerId:\s*result\.providerId,/,
    source: "provider-smoke",
    message:
      "provider live reports must record the endpoint providerId returned by the provider.",
  },
  {
    name: "cloud live reports are uploaded as required artifacts",
    pattern:
      /remote-capability-cloud-live-report[\s\S]*path: reports\/remote-capabilities\/cloud\/\*\.json[\s\S]*if-no-files-found: error/,
    message:
      "cloud live report artifact upload must fail when reports are absent.",
  },
  {
    name: "provider live reports are uploaded as required artifacts",
    pattern:
      /remote-capability-provider-live-report[\s\S]*path: reports\/remote-capabilities\/providers\/\*\.json[\s\S]*if-no-files-found: error/,
    message:
      "provider live report artifact upload must fail when reports are absent.",
  },
  {
    name: "GitHub live artifact validation skips absent live config",
    pattern:
      /github-live-artifact-validate:[\s\S]*needs\.cloud-live-e2e\.outputs\.capability_skip != 'true' \|\| needs\.provider-live-e2e\.outputs\.skip != 'true'[\s\S]*Re-validate cloud live report from downloaded artifact[\s\S]*needs\.cloud-live-e2e\.outputs\.capability_skip != 'true'[\s\S]*Re-validate provider live reports from downloaded artifacts[\s\S]*needs\.provider-live-e2e\.outputs\.skip != 'true'[\s\S]*Live artifact validation skipped because no live report producers were configured/,
    message:
      "GitHub live artifact validation must not require artifacts for live suites skipped due to absent config.",
  },
];

export function validateCapabilityRouterLiveCi(
  workflow: string,
  options: CheckContentOptions & { workflowPath?: string } = {},
): LiveCiAuditFailure[] {
  const path = options.workflowPath ?? workflowPath;
  const onlyCheckNames =
    options.onlyCheckNames === undefined
      ? undefined
      : new Set(options.onlyCheckNames);
  return checks
    .filter((check) => !onlyCheckNames || onlyCheckNames.has(check.name))
    .filter((check) => {
      const content = getCheckContent(check, workflow, options);
      return !check.pattern.test(content);
    })
    .map((check) => ({
      sourcePath: getCheckSourcePath(check, path),
      workflowPath: path,
      name: check.name,
      message: check.message,
    }));
}

function getCheckContent(
  check: Check,
  workflow: string,
  options: CheckContentOptions,
): string {
  return checkContentReaders[check.source ?? "workflow"](options, workflow);
}

function getCheckSourcePath(check: Check, workflowPath: string): string {
  return checkSourcePaths[check.source ?? "workflow"] ?? workflowPath;
}

if (import.meta.main) {
  const workflow = readFileSync(workflowPath, "utf8");
  const rootPackageJson = readFileSync(rootPackagePath, "utf8");
  const agentPackageJson = readFileSync(agentPackagePath, "utf8");
  const coreCapabilitiesSource = readFileSync(coreCapabilitiesPath, "utf8");
  const endpointConformanceSource = readFileSync(
    endpointConformancePath,
    "utf8",
  );
  const liveReportValidatorSource = readFileSync(
    liveReportValidatorPath,
    "utf8",
  );
  const liveReportValidatorSelfTestSource = readFileSync(
    liveReportValidatorSelfTestPath,
    "utf8",
  );
  const githubLiveArtifactValidatorSource = readFileSync(
    githubLiveArtifactValidatorPath,
    "utf8",
  );
  const githubLiveArtifactValidatorSelfTestSource = readFileSync(
    githubLiveArtifactValidatorSelfTestPath,
    "utf8",
  );
  const liveReportWriterSource = readFileSync(liveReportWriterPath, "utf8");
  const providerSmokeSource = readFileSync(providerSmokePath, "utf8");
  const remoteCapabilityRoutesSource = readFileSync(
    remoteCapabilityRoutesPath,
    "utf8",
  );
  const remotePluginAdapterTestSource = readFileSync(
    remotePluginAdapterTestPath,
    "utf8",
  );
  const failures = validateCapabilityRouterLiveCi(workflow, {
    agentPackageJson,
    coreCapabilitiesSource,
    endpointConformanceSource,
    githubLiveArtifactValidatorSource,
    githubLiveArtifactValidatorSelfTestSource,
    liveReportValidatorSelfTestSource,
    liveReportValidatorSource,
    liveReportWriterSource,
    providerSmokeSource,
    remoteCapabilityRoutesSource,
    remotePluginAdapterTestSource,
    rootPackageJson,
    workflowPath,
  });

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(
        `${failure.sourcePath}: ${failure.name}: ${failure.message}`,
      );
    }
    process.exit(1);
  }

  console.log(
    `Capability-router live CI audit passed (${checks.length} checks).`,
  );
}
