/**
 * Mounts the remote-capability router API behind the authenticated gate. POST
 * /api/capability-router/connect validates and connects a remote capability
 * endpoint (direct, or a home-machine / mobile- / desktop-companion
 * provider) or provisions a cloud sandbox, syncs the resulting remote plugins
 * into the runtime, and persists endpoint config, per-endpoint module
 * allowlists, trust policies, and a bounded trust-audit trail to the config env
 * — redacting tokens from responses and from sanitized vars. GET/HEAD
 * /api/capability-router/assets/... proxies remote UI assets, platform-gated for
 * dynamic-loading and path-traversal-guarded. Endpoint baseUrls are SSRF-guarded
 * against private/loopback/link-local/internal targets.
 *
 * Persisted router settings are read and validated before a persisting connect
 * touches the runtime; an unparseable stored value is a typed
 * `CAPABILITY_ROUTER_PERSISTED_SETTING_INVALID` failure answered as 500, never
 * an empty default that the subsequent write would overwrite.
 */
import type http from "node:http";
import net from "node:net";
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  CapabilityError,
  type ElizaCapabilityRouter,
  ElizaError,
  type IAgentRuntime,
  isLoopbackHost,
  isPrivateIpAddress,
  type JsonObject,
  normalizeHostLike,
  type RouteHelpers,
  type RouteRequestMeta,
} from "@elizaos/core";
import { decodeUrlPathComponent } from "@elizaos/shared";
import {
  type ConnectCloudCapabilitySandboxOptions,
  type ConnectCloudCapabilitySandboxResult,
  connectCloudCapabilitySandbox,
} from "../services/remote-capability-cloud-sandbox.ts";
import {
  type ConnectRemoteCapabilityEndpointProviderOptions,
  type ConnectRemoteCapabilityEndpointProviderResult,
  connectRemoteCapabilityEndpointProvider,
  directRemoteCapabilityEndpointProvider,
  normalizeEndpointTrustPolicyOptions,
  type RemoteCapabilityEndpointProvider,
  type RemoteCapabilityEndpointTrustPolicyOptions,
} from "../services/remote-capability-endpoint-provider.ts";
import type { RemoteCapabilityEndpointConfig } from "../services/remote-capability-router.ts";
import {
  desktopCompanionCapabilityEndpointProvider,
  homeMachineCapabilityEndpointProvider,
  mobileCompanionCapabilityEndpointProvider,
  type UrlRemoteCapabilityEndpointProviderOptions,
} from "../services/remote-capability-url-endpoint-providers.ts";
import type {
  RemotePluginSyncResult,
  RemotePluginTrustPolicy,
} from "../services/remote-plugin-adapter.ts";
import {
  detectClientPlatform,
  isDynamicLoadingAllowed,
} from "./platform-detect.ts";

type JsonBodyReader = <T = Record<string, unknown>>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options?: { requireObject?: boolean },
) => Promise<T | null>;

export interface RemoteCapabilityRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json" | "error"> {
  runtime: IAgentRuntime | null;
  config?: CapabilityRouterPersistConfig;
  readJsonBody: JsonBodyReader;
  saveConfig?: (config: CapabilityRouterPersistConfig) => void;
  persistConfigEnv?: (key: string, value: string) => Promise<void>;
  connectEndpointProvider?: <TOptions>(
    runtime: IAgentRuntime,
    options: ConnectRemoteCapabilityEndpointProviderOptions<TOptions>,
  ) => Promise<ConnectRemoteCapabilityEndpointProviderResult>;
  connectCloudSandbox?: (
    runtime: IAgentRuntime,
    options: ConnectCloudCapabilitySandboxOptions,
  ) => Promise<ConnectCloudCapabilitySandboxResult>;
}

type ConnectBody = {
  endpoint?: unknown;
  cloud?: unknown;
  provider?: unknown;
  unloadMissing?: unknown;
  persist?: unknown;
  requestTimeoutMs?: unknown;
  allowedModuleIds?: unknown;
  trustPolicy?: unknown;
};

type DirectEndpointBody = {
  id?: unknown;
  baseUrl?: unknown;
  token?: unknown;
};

type EndpointProviderMode =
  | "direct"
  | "home-machine"
  | "mobile-companion"
  | "desktop-companion";

type DirectEndpointProviderOptions = {
  endpoint: RemoteCapabilityEndpointConfig;
  allowedModuleIds?: string[];
  trustPolicy?: RemoteCapabilityEndpointTrustPolicyOptions;
};

type EndpointProviderOptions =
  | DirectEndpointProviderOptions
  | UrlRemoteCapabilityEndpointProviderOptions;

type CloudBody = {
  cloudApiBase?: unknown;
  authToken?: unknown;
  name?: unknown;
  bio?: unknown;
  endpointId?: unknown;
  token?: unknown;
  timeoutMs?: unknown;
  pollIntervalMs?: unknown;
  allowedModuleIds?: unknown;
  trustPolicy?: unknown;
};

export async function handleRemoteCapabilityRoutes(
  ctx: RemoteCapabilityRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, runtime, readJsonBody, json, error } =
    ctx;

  if (pathname.startsWith("/api/capability-router/assets/")) {
    if (!runtime) {
      error(res, "Agent runtime unavailable", 503);
      return true;
    }
    if (method !== "GET" && method !== "HEAD") {
      error(res, "Method not allowed", 405);
      return true;
    }
    if (!isDynamicLoadingAllowed(detectClientPlatform(req))) {
      error(
        res,
        "Dynamic capability asset loading is not permitted on this platform.",
        403,
      );
      return true;
    }
    try {
      await serveCapabilityRouterAssetProxy(ctx, runtime);
    } catch (err) {
      error(
        res,
        err instanceof Error ? err.message : "Failed to load remote asset.",
        err instanceof CapabilityError ? 502 : 400,
      );
    }
    return true;
  }

  if (pathname !== "/api/capability-router/connect") {
    return false;
  }

  if (method !== "POST") {
    error(res, "Method not allowed", 405);
    return true;
  }

  if (!runtime) {
    error(res, "Agent runtime unavailable", 503);
    return true;
  }

  const body = await readJsonBody<ConnectBody>(req, res, {
    requireObject: true,
  });
  if (body === null) {
    return true;
  }

  try {
    const unloadMissing =
      typeof body.unloadMissing === "boolean" ? body.unloadMissing : true;
    const persist = typeof body.persist === "boolean" ? body.persist : true;
    const allowedModuleIds = parseOptionalStringArray(
      body.allowedModuleIds,
      "allowedModuleIds",
    );
    const trustPolicy = parseOptionalEndpointTrustPolicy(
      body.trustPolicy,
      "trustPolicy",
    );
    const requestTimeoutMs = optionalPositiveInteger(
      body.requestTimeoutMs,
      "requestTimeoutMs",
    );
    if (requestTimeoutMs instanceof Error) {
      error(res, requestTimeoutMs.message, 400);
      return true;
    }
    if (body.endpoint !== undefined && body.cloud !== undefined) {
      error(
        res,
        "Request body must include only one of 'endpoint' or 'cloud'.",
        400,
      );
      return true;
    }

    if (body.endpoint !== undefined) {
      const providerMode = parseEndpointProviderMode(body.provider);
      const endpoint = parseDirectEndpoint(body.endpoint);
      // Validate the stored settings before the runtime is mutated so a
      // corrupt value fails the request without a half-applied connect.
      const persisted = persist
        ? loadPersistedCapabilityRouterState(ctx)
        : null;
      const connectEndpointProvider =
        ctx.connectEndpointProvider ?? connectRemoteCapabilityEndpointProvider;
      const provider = getEndpointProvider(providerMode);
      const result = await connectEndpointProvider(runtime, {
        provider,
        provisionOptions: buildEndpointProvisionOptions(
          providerMode,
          endpoint,
          allowedModuleIds,
        ),
        unloadMissing,
        requestTimeoutMs: requestTimeoutMs ?? 60_000,
        ...(allowedModuleIds === undefined ? {} : { allowedModuleIds }),
        ...(trustPolicy === undefined ? {} : { trustPolicy }),
      });
      const persistedEndpoint = result.endpoint ?? endpoint;
      if (persisted !== null) {
        await persistEndpoint(
          persisted,
          persistedEndpoint,
          allowedModuleIds,
          trustPolicy,
          {
            mode: providerMode === "direct" ? "endpoint" : providerMode,
            provider: result.providerId,
            endpoint: persistedEndpoint,
            allowedModuleIds,
            sync: result.sync,
          },
        );
      }
      json(res, {
        success: true,
        mode: providerMode === "direct" ? "endpoint" : providerMode,
        ...(providerMode === "direct" ? {} : { provider: providerMode }),
        endpoint: redactEndpoint(persistedEndpoint),
        persisted: persist,
        sync: serializeSyncResult(result.sync),
      });
      return true;
    }

    if (body.cloud !== undefined) {
      const cloud = parseCloudOptions(body.cloud);
      if (trustPolicy !== undefined && cloud.trustPolicy !== undefined) {
        error(
          res,
          "Cloud requests must set trustPolicy either at the top level or inside 'cloud', not both.",
          400,
        );
        return true;
      }
      if (
        allowedModuleIds !== undefined &&
        cloud.allowedModuleIds !== undefined
      ) {
        error(
          res,
          "Cloud requests must set allowedModuleIds either at the top level or inside 'cloud', not both.",
          400,
        );
        return true;
      }
      const cloudAllowedModuleIds = allowedModuleIds ?? cloud.allowedModuleIds;
      const cloudTrustPolicy = trustPolicy ?? cloud.trustPolicy;
      const persisted = persist
        ? loadPersistedCapabilityRouterState(ctx)
        : null;
      const connectCloudSandbox =
        ctx.connectCloudSandbox ?? connectCloudCapabilitySandbox;
      const result = await connectCloudSandbox(runtime, {
        ...cloud,
        unloadMissing,
        ...(cloudAllowedModuleIds === undefined
          ? {}
          : { allowedModuleIds: cloudAllowedModuleIds }),
        ...(cloudTrustPolicy === undefined
          ? {}
          : { trustPolicy: cloudTrustPolicy }),
        requestTimeoutMs: requestTimeoutMs ?? 60_000,
      });
      if (persisted !== null) {
        await persistEndpoint(
          persisted,
          result.endpoint,
          cloudAllowedModuleIds,
          cloudTrustPolicy,
          {
            mode: "cloud",
            provider: result.providerId,
            endpoint: result.endpoint,
            allowedModuleIds: cloudAllowedModuleIds,
            sync: result.sync,
          },
        );
      }
      json(res, {
        success: true,
        mode: "cloud",
        agentId: result.agentId,
        ...(result.jobId === undefined ? {} : { jobId: result.jobId }),
        endpoint: redactEndpoint(result.endpoint),
        persisted: persist,
        sync: serializeSyncResult(result.sync),
      });
      return true;
    }

    error(res, "Request body must include either 'endpoint' or 'cloud'.", 400);
    return true;
  } catch (err) {
    // error-policy:J1 boundary translation — request validation and provider
    // failures answer 400; a corrupt persisted setting is a server-side state
    // fault answered as 500 so the stored value is never repaired by overwrite.
    error(
      res,
      err instanceof Error
        ? err.message
        : "Failed to connect capability router endpoint.",
      isInvalidPersistedSettingError(err) ? 500 : 400,
    );
    return true;
  }
}

async function serveCapabilityRouterAssetProxy(
  ctx: RemoteCapabilityRouteContext,
  runtime: IAgentRuntime,
): Promise<void> {
  const { res, pathname, method } = ctx;
  const parsed = parseAssetProxyPath(pathname);
  const router = getRuntimeCapabilityRouter(runtime);
  const asset = await router.plugin.getAsset({
    endpointId: parsed.endpointId,
    moduleId: parsed.moduleId,
    path: parsed.assetPath,
  });
  const body = Buffer.from(asset.bodyBase64, "base64");
  const headers: Record<string, string | number> = {
    "Content-Type": asset.contentType,
    "Content-Length": body.byteLength,
    "Cache-Control": "no-cache",
    ...(asset.integrity === undefined
      ? {}
      : { "X-Eliza-Asset-Integrity": asset.integrity }),
  };
  const response = res as {
    writeHead?: (
      status: number,
      headers: Record<string, string | number>,
    ) => void;
    setHeader?: (name: string, value: string | number) => void;
    end?: (chunk?: unknown) => void;
  };
  if (typeof response.writeHead === "function") {
    response.writeHead(200, headers);
  } else if (typeof response.setHeader === "function") {
    for (const [key, value] of Object.entries(headers)) {
      response.setHeader(key, value);
    }
  }
  response.end?.(method === "HEAD" ? undefined : body);
}

function parseAssetProxyPath(pathname: string): {
  endpointId: string;
  moduleId: string;
  assetPath: string;
} {
  const prefix = "/api/capability-router/assets/";
  const remainder = pathname.slice(prefix.length);
  const [encodedEndpointId, encodedModuleId, ...assetParts] =
    remainder.split("/");
  if (!encodedEndpointId || !encodedModuleId || assetParts.length === 0) {
    throw new Error(
      "Capability asset URL must include endpoint id, module id, and path.",
    );
  }
  const decodeAssetComponent = (raw: string, fieldName: string): string => {
    const decoded = decodeUrlPathComponent(raw);
    if (!decoded.ok) {
      // error-policy:J3 malformed path encoding is explicit invalid input.
      throw new Error(`Invalid ${fieldName}: malformed URL encoding`);
    }
    return decoded.value;
  };
  const endpointId = decodeAssetComponent(encodedEndpointId, "endpoint id");
  const moduleId = decodeAssetComponent(encodedModuleId, "module id");
  const assetSegments = assetParts.map((part) =>
    decodeAssetComponent(part, "asset path"),
  );
  const hasUnsafeSegment = assetSegments.some(
    (part) => !part || part === "." || part === ".." || part.includes("\\"),
  );
  const assetPath = `/${assetSegments.join("/")}`;
  if (!endpointId.trim() || !moduleId.trim() || assetPath === "/") {
    throw new Error(
      "Capability asset URL must include endpoint id, module id, and path.",
    );
  }
  if (hasUnsafeSegment) {
    throw new Error("Capability asset URL path is not valid.");
  }
  return { endpointId, moduleId, assetPath };
}

function getRuntimeCapabilityRouter(
  runtime: IAgentRuntime,
): ElizaCapabilityRouter {
  const router = runtime.getService?.(
    CAPABILITY_ROUTER_SERVICE_TYPE,
  ) as ElizaCapabilityRouter | null;
  if (!router) {
    throw new Error("Capability router service is not available.");
  }
  return router;
}

type CapabilityRouterPersistConfig = {
  env?: {
    vars?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

const PERSISTED_SETTING_INVALID_CODE =
  "CAPABILITY_ROUTER_PERSISTED_SETTING_INVALID";

function invalidPersistedSetting(
  setting: string,
  reason: string,
  cause?: unknown,
): ElizaError {
  return new ElizaError(
    `Persisted capability router setting ${setting} is invalid (${reason}); fix or clear it before connecting.`,
    {
      code: PERSISTED_SETTING_INVALID_CODE,
      context: { setting, reason },
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

function isInvalidPersistedSettingError(value: unknown): boolean {
  return (
    value instanceof ElizaError && value.code === PERSISTED_SETTING_INVALID_CODE
  );
}

type PersistedCapabilityRouterState = {
  config: CapabilityRouterPersistConfig;
  saveConfig: (config: CapabilityRouterPersistConfig) => void;
  persistConfigEnv: (key: string, value: string) => Promise<void>;
  env: NonNullable<CapabilityRouterPersistConfig["env"]>;
  vars: Record<string, string>;
  endpoints: RemoteCapabilityEndpointConfig[];
  moduleAllowlists: Record<string, string[]>;
  trustPolicies: Record<string, RemoteCapabilityEndpointTrustPolicyOptions>;
  auditRecords: CapabilityRouterTrustAuditRecord[];
};

/**
 * Read every persisted router setting the connect route will rewrite. Each
 * reader throws `CAPABILITY_ROUTER_PERSISTED_SETTING_INVALID` for a value it
 * cannot parse, so a corrupt setting stops the request before the runtime is
 * mutated and before any write could replace the stored value.
 */
function loadPersistedCapabilityRouterState(
  ctx: Pick<
    RemoteCapabilityRouteContext,
    "config" | "saveConfig" | "persistConfigEnv"
  >,
): PersistedCapabilityRouterState {
  const config = ctx.config;
  const saveConfig = ctx.saveConfig;
  const persistConfigEnv = ctx.persistConfigEnv;
  if (!config || !saveConfig || !persistConfigEnv) {
    throw new Error(
      "Capability router endpoint persistence is unavailable in this runtime.",
    );
  }
  const env = config.env ?? {};
  const vars = { ...(env.vars ?? {}) };
  return {
    config,
    saveConfig,
    persistConfigEnv,
    env,
    vars,
    endpoints: readPersistedEndpoints(
      process.env.ELIZA_CAPABILITY_ROUTER_URLS ??
        vars.ELIZA_CAPABILITY_ROUTER_URLS,
    ),
    moduleAllowlists: readPersistedModuleAllowlists(
      process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES ??
        vars.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES,
    ),
    trustPolicies: readPersistedTrustPolicies(
      process.env.ELIZA_CAPABILITY_ROUTER_TRUST_POLICY ??
        vars.ELIZA_CAPABILITY_ROUTER_TRUST_POLICY,
    ),
    auditRecords: readTrustAuditRecords(
      process.env.ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT ??
        vars.ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT,
    ),
  };
}

async function persistEndpoint(
  persisted: PersistedCapabilityRouterState,
  endpoint: RemoteCapabilityEndpointConfig,
  allowedModuleIds?: string[],
  trustPolicy?: RemoteCapabilityEndpointTrustPolicyOptions,
  audit?: CapabilityRouterTrustAuditInput,
): Promise<void> {
  const { config, env, vars } = persisted;
  const endpoints = mergePersistedEndpoints(persisted.endpoints, endpoint);
  const moduleAllowlists = mergePersistedModuleAllowlists(
    persisted.moduleAllowlists,
    endpoint.id,
    allowedModuleIds,
  );
  const persistedTrustPolicy = mergePersistedTrustPolicies(
    persisted.trustPolicies,
    endpoint.id,
    trustPolicy,
  );
  const sanitizedEndpoints = endpoints.map(
    ({ token: _token, ...item }) => item,
  );
  await persisted.persistConfigEnv("ELIZA_CAPABILITY_ROUTER_ENABLED", "true");
  await persisted.persistConfigEnv(
    "ELIZA_CAPABILITY_ROUTER_URLS",
    JSON.stringify(endpoints),
  );
  vars.ELIZA_CAPABILITY_ROUTER_ENABLED = "true";
  vars.ELIZA_CAPABILITY_ROUTER_URLS = JSON.stringify(sanitizedEndpoints);
  if (Object.keys(moduleAllowlists).length > 0) {
    vars.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES =
      JSON.stringify(moduleAllowlists);
  } else {
    delete vars.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES;
  }
  if (Object.keys(persistedTrustPolicy).length > 0) {
    await persisted.persistConfigEnv(
      "ELIZA_CAPABILITY_ROUTER_TRUST_POLICY",
      JSON.stringify(persistedTrustPolicy),
    );
    vars.ELIZA_CAPABILITY_ROUTER_TRUST_POLICY =
      JSON.stringify(persistedTrustPolicy);
  } else {
    delete vars.ELIZA_CAPABILITY_ROUTER_TRUST_POLICY;
  }
  if (audit !== undefined) {
    vars.ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT = JSON.stringify(
      appendTrustAuditRecord(persisted.auditRecords, audit),
    );
  }
  config.env = {
    ...env,
    vars,
  };
  persisted.saveConfig(config);
}

type CapabilityRouterTrustAuditInput = {
  mode: string;
  provider: string;
  endpoint: RemoteCapabilityEndpointConfig;
  allowedModuleIds?: string[];
  sync: RemotePluginSyncResult;
};

type CapabilityRouterTrustAuditRecord = {
  recordedAt: string;
  mode: string;
  provider: string;
  endpoint: JsonObject;
  allowedModuleIds: string[];
  registered: string[];
  skipped: string[];
  unloaded: string[];
  trustDecisions: RemotePluginSyncResult["trustDecisions"];
};

function parsePersistedJson(setting: string, value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (err) {
    // error-policy:J3 untrusted-input sanitizing — an unparseable stored value
    // is an explicit invalid result, never an empty default.
    throw invalidPersistedSetting(setting, "not valid JSON", err);
  }
}

function readTrustAuditRecords(
  value: string | undefined,
): CapabilityRouterTrustAuditRecord[] {
  if (!value?.trim()) return [];
  const setting = "ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT";
  const parsed = parsePersistedJson(setting, value);
  if (!Array.isArray(parsed)) {
    throw invalidPersistedSetting(setting, "expected a JSON array");
  }
  return parsed.filter(isTrustAuditRecord);
}

function appendTrustAuditRecord(
  existing: CapabilityRouterTrustAuditRecord[],
  audit: CapabilityRouterTrustAuditInput,
): CapabilityRouterTrustAuditRecord[] {
  return [
    ...existing,
    {
      recordedAt: new Date().toISOString(),
      mode: audit.mode,
      provider: audit.provider,
      endpoint: redactEndpoint(audit.endpoint),
      allowedModuleIds: normalizeStringList(audit.allowedModuleIds ?? []),
      registered: audit.sync.registered.map((plugin) => plugin.name),
      skipped: [...audit.sync.skipped],
      unloaded: [...audit.sync.unloaded],
      trustDecisions: audit.sync.trustDecisions.map((decision) => ({
        ...decision,
      })),
    },
  ];
}

function isTrustAuditRecord(
  value: unknown,
): value is CapabilityRouterTrustAuditRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.recordedAt === "string" &&
    typeof record.mode === "string" &&
    typeof record.provider === "string" &&
    !!record.endpoint &&
    typeof record.endpoint === "object" &&
    Array.isArray(record.allowedModuleIds) &&
    Array.isArray(record.registered) &&
    Array.isArray(record.skipped) &&
    Array.isArray(record.unloaded) &&
    Array.isArray(record.trustDecisions)
  );
}

function readPersistedModuleAllowlists(
  value: string | undefined,
): Record<string, string[]> {
  if (!value?.trim()) return {};
  const setting = "ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES";
  const parsed = parsePersistedJson(setting, value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidPersistedSetting(setting, "expected a JSON object");
  }
  const result: Record<string, string[]> = {};
  for (const [endpointId, moduleIds] of Object.entries(parsed)) {
    if (!endpointId.trim() || !Array.isArray(moduleIds)) continue;
    const normalized = normalizeStringList(moduleIds);
    if (normalized.length > 0) {
      result[endpointId.trim()] = normalized;
    }
  }
  return result;
}

function mergePersistedModuleAllowlists(
  existing: Record<string, string[]>,
  endpointId: string,
  allowedModuleIds: string[] | undefined,
): Record<string, string[]> {
  const next = { ...existing };
  if (allowedModuleIds === undefined) {
    delete next[endpointId];
    return next;
  }
  const normalized = normalizeStringList(allowedModuleIds);
  if (normalized.length === 0) {
    delete next[endpointId];
  } else {
    next[endpointId] = normalized;
  }
  return next;
}

function readPersistedTrustPolicies(
  value: string | undefined,
): Record<string, RemoteCapabilityEndpointTrustPolicyOptions> {
  if (!value?.trim()) return {};
  const setting = "ELIZA_CAPABILITY_ROUTER_TRUST_POLICY";
  const parsed = parsePersistedJson(setting, value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidPersistedSetting(setting, "expected a JSON object");
  }
  const result: Record<string, RemoteCapabilityEndpointTrustPolicyOptions> = {};
  for (const [endpointId, candidate] of Object.entries(parsed)) {
    if (!endpointId.trim()) continue;
    let trustPolicy: RemoteCapabilityEndpointTrustPolicyOptions | undefined;
    try {
      trustPolicy = parseOptionalEndpointTrustPolicy(
        candidate,
        `${setting}.${endpointId}`,
      );
    } catch (err) {
      // error-policy:J2 context-adding rethrow — a malformed stored policy is
      // reported as the invalid setting it lives in, with the parser cause.
      throw invalidPersistedSetting(
        setting,
        err instanceof Error ? err.message : "malformed trust policy entry",
        err,
      );
    }
    if (trustPolicy && Object.keys(trustPolicy).length > 0) {
      result[endpointId.trim()] = trustPolicy;
    }
  }
  return result;
}

function mergePersistedTrustPolicies(
  existing: Record<string, RemoteCapabilityEndpointTrustPolicyOptions>,
  endpointId: string,
  trustPolicy: RemoteCapabilityEndpointTrustPolicyOptions | undefined,
): Record<string, RemoteCapabilityEndpointTrustPolicyOptions> {
  const next = { ...existing };
  const normalized = normalizeEndpointTrustPolicyOptions(trustPolicy);
  if (Object.keys(normalized).length === 0) {
    delete next[endpointId];
  } else {
    next[endpointId] = normalized;
  }
  return next;
}

function readPersistedEndpoints(
  value: string | undefined,
): RemoteCapabilityEndpointConfig[] {
  if (!value?.trim()) return [];
  const setting = "ELIZA_CAPABILITY_ROUTER_URLS";
  const parsed = parsePersistedJson(setting, value);
  if (!Array.isArray(parsed)) {
    throw invalidPersistedSetting(setting, "expected a JSON array");
  }
  return parsed
    .map((item, index): RemoteCapabilityEndpointConfig | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      if (typeof record.baseUrl !== "string" || !record.baseUrl.trim()) {
        return null;
      }
      return {
        id:
          typeof record.id === "string" && record.id.trim()
            ? record.id.trim()
            : `remote-${index + 1}`,
        baseUrl: record.baseUrl.trim().replace(/\/+$/, ""),
        ...(typeof record.token === "string" && record.token.trim()
          ? { token: record.token.trim() }
          : {}),
      };
    })
    .filter(
      (endpoint): endpoint is RemoteCapabilityEndpointConfig =>
        endpoint !== null,
    );
}

function mergePersistedEndpoints(
  existing: RemoteCapabilityEndpointConfig[],
  next: RemoteCapabilityEndpointConfig,
): RemoteCapabilityEndpointConfig[] {
  const normalizedNext = {
    ...next,
    baseUrl: next.baseUrl.replace(/\/+$/, ""),
  };
  const byKey = new Map<string, RemoteCapabilityEndpointConfig>();
  for (const endpoint of existing) {
    const key = endpoint.id || endpoint.baseUrl;
    byKey.set(key, {
      ...endpoint,
      baseUrl: endpoint.baseUrl.replace(/\/+$/, ""),
    });
  }
  byKey.set(normalizedNext.id || normalizedNext.baseUrl, normalizedNext);
  return [...byKey.values()];
}

function parseDirectEndpoint(value: unknown): RemoteCapabilityEndpointConfig {
  const body = requireObject(value, "endpoint") as DirectEndpointBody;
  return {
    id: optionalNonEmptyString(body.id, "endpoint.id") ?? "default",
    baseUrl: requireHttpUrl(body.baseUrl, "endpoint.baseUrl"),
    ...optionalToken(body.token, "endpoint.token"),
  };
}

function parseEndpointProviderMode(value: unknown): EndpointProviderMode {
  if (value === undefined || value === null || value === "") return "direct";
  const provider = requireNonEmptyString(value, "provider");
  if (
    provider === "direct" ||
    provider === "home-machine" ||
    provider === "mobile-companion" ||
    provider === "desktop-companion"
  ) {
    return provider;
  }
  throw new Error(
    `provider must be one of direct, home-machine, mobile-companion, or desktop-companion.`,
  );
}

function getEndpointProvider(
  providerMode: EndpointProviderMode,
): RemoteCapabilityEndpointProvider<EndpointProviderOptions> {
  switch (providerMode) {
    case "direct":
      return directRemoteCapabilityEndpointProvider() as RemoteCapabilityEndpointProvider<EndpointProviderOptions>;
    case "home-machine":
      return homeMachineCapabilityEndpointProvider as RemoteCapabilityEndpointProvider<EndpointProviderOptions>;
    case "mobile-companion":
      return mobileCompanionCapabilityEndpointProvider as RemoteCapabilityEndpointProvider<EndpointProviderOptions>;
    case "desktop-companion":
      return desktopCompanionCapabilityEndpointProvider as RemoteCapabilityEndpointProvider<EndpointProviderOptions>;
  }
}

function buildEndpointProvisionOptions(
  providerMode: EndpointProviderMode,
  endpoint: RemoteCapabilityEndpointConfig,
  allowedModuleIds: string[] | undefined,
): EndpointProviderOptions {
  if (providerMode === "direct") {
    return {
      endpoint,
      ...(allowedModuleIds === undefined ? {} : { allowedModuleIds }),
    };
  }
  return {
    baseUrl: endpoint.baseUrl,
    endpointId: endpoint.id,
    ...(endpoint.token === undefined ? {} : { token: endpoint.token }),
    ...(allowedModuleIds === undefined ? {} : { allowedModuleIds }),
  };
}

function parseCloudOptions(
  value: unknown,
): Omit<
  ConnectCloudCapabilitySandboxOptions,
  "unloadMissing" | "requestTimeoutMs" | "fetch" | "onProgress"
> {
  const body = requireObject(value, "cloud") as CloudBody;
  const bio = parseOptionalStringArray(body.bio, "cloud.bio");
  const allowedModuleIds = parseOptionalStringArray(
    body.allowedModuleIds,
    "cloud.allowedModuleIds",
  );
  const trustPolicy = parseOptionalEndpointTrustPolicy(
    body.trustPolicy,
    "cloud.trustPolicy",
  );
  const endpointId = optionalNonEmptyString(
    body.endpointId,
    "cloud.endpointId",
  );
  const timeoutMs = optionalPositiveInteger(body.timeoutMs, "cloud.timeoutMs");
  if (timeoutMs instanceof Error) throw timeoutMs;
  const pollIntervalMs = optionalPositiveInteger(
    body.pollIntervalMs,
    "cloud.pollIntervalMs",
  );
  if (pollIntervalMs instanceof Error) throw pollIntervalMs;

  return {
    cloudApiBase: requireHttpUrl(body.cloudApiBase, "cloud.cloudApiBase"),
    authToken: requireNonEmptyString(body.authToken, "cloud.authToken"),
    name: requireNonEmptyString(body.name, "cloud.name"),
    ...(bio === undefined ? {} : { bio }),
    ...(endpointId === undefined ? {} : { endpointId }),
    ...optionalToken(body.token, "cloud.token"),
    ...(allowedModuleIds === undefined ? {} : { allowedModuleIds }),
    ...(trustPolicy === undefined ? {} : { trustPolicy }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
  };
}

function serializeSyncResult(sync: RemotePluginSyncResult): JsonObject {
  return {
    registered: sync.registered.map((plugin) => plugin.name),
    unloaded: sync.unloaded,
    skipped: sync.skipped,
    trustDecisions: sync.trustDecisions,
  };
}

function redactEndpoint(endpoint: RemoteCapabilityEndpointConfig): JsonObject {
  return {
    id: endpoint.id,
    baseUrl: endpoint.baseUrl,
    hasToken: typeof endpoint.token === "string" && endpoint.token.length > 0,
  };
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalNonEmptyString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, field);
}

function requireHttpUrl(value: unknown, field: string): string {
  const text = requireNonEmptyString(value, field).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${field} must be a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field} must use http or https.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${field} must not include embedded credentials.`);
  }
  // SSRF guard: a remote-capability endpoint baseUrl is attacker-controlled by
  // any authenticated caller (dedicated agents are reachable from the internet
  // via the cloud proxy), and the router fetches it directly. Block literal
  // private/loopback/link-local IPs and internal hostnames so it can't be aimed
  // at cloud metadata (169.254.169.254) or internal services. Mirrors the host
  // blocklist in runtime/custom-actions.ts. (Does not resolve DNS, so a public
  // name pointing at a private address is not covered here.)
  const host = normalizeHostLike(parsed.hostname);
  if (
    !host ||
    host === "0.0.0.0" ||
    host === "metadata.google.internal" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isLoopbackHost(host) ||
    (net.isIP(host) !== 0 && isPrivateIpAddress(host))
  ) {
    throw new Error(
      `${field} must not target a private, loopback, link-local, or internal address.`,
    );
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/+$/, "");
}

function optionalToken(value: unknown, field: string): { token?: string } {
  const token = optionalNonEmptyString(value, field);
  return token === undefined ? {} : { token };
}

function optionalPositiveInteger(
  value: unknown,
  field: string,
): number | undefined | Error {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function parseOptionalStringArray(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return normalizeStringList(value);
}

function parseOptionalEndpointTrustPolicy(
  value: unknown,
  field: string,
): RemoteCapabilityEndpointTrustPolicyOptions | undefined {
  if (value === undefined) return undefined;
  const body = requireObject(value, field);
  const allowedProvenanceIssuers = parseOptionalStringArray(
    body.allowedProvenanceIssuers,
    `${field}.allowedProvenanceIssuers`,
  );
  const trustedProvenancePublicKeys = parseOptionalStringRecord(
    body.trustedProvenancePublicKeys,
    `${field}.trustedProvenancePublicKeys`,
  );
  const trustPolicy = normalizeEndpointTrustPolicyOptions({
    ...(allowedProvenanceIssuers === undefined
      ? {}
      : { allowedProvenanceIssuers }),
    ...(trustedProvenancePublicKeys === undefined
      ? {}
      : { trustedProvenancePublicKeys }),
    ...optionalBooleanField(
      body.requireSignedProvenance,
      `${field}.requireSignedProvenance`,
      "requireSignedProvenance",
    ),
    ...optionalBooleanField(
      body.requireVerifiedProvenance,
      `${field}.requireVerifiedProvenance`,
      "requireVerifiedProvenance",
    ),
    ...optionalBooleanField(
      body.requireProvenanceDigestMatch,
      `${field}.requireProvenanceDigestMatch`,
      "requireProvenanceDigestMatch",
    ),
  });
  return Object.keys(trustPolicy).length === 0 ? undefined : trustPolicy;
}

function optionalBooleanField<TKey extends keyof RemotePluginTrustPolicy>(
  value: unknown,
  field: string,
  key: TKey,
): Partial<Pick<RemotePluginTrustPolicy, TKey>> {
  if (value === undefined) return {};
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return value
    ? ({ [key]: true } as Partial<Pick<RemotePluginTrustPolicy, TKey>>)
    : {};
}

function parseOptionalStringRecord(
  value: unknown,
  field: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const body = requireObject(value, field);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(body)) {
    if (typeof entry !== "string") {
      throw new Error(`${field}.${key} must be a string.`);
    }
    const normalizedKey = key.trim();
    const normalizedValue = entry.trim();
    if (normalizedKey && normalizedValue) {
      result[normalizedKey] = normalizedValue;
    }
  }
  return result;
}

function normalizeStringList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
