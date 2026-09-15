/**
 * CloudAuthService — Eliza Cloud authentication entry points.
 *
 * Two distinct auth flows live here:
 *
 * 1. **Device auto-signup** (`authenticateWithDevice`) — convenience-only.
 *    Derives a hardware fingerprint and exchanges it for a free-tier API key
 *    against the cloud signup endpoint. The result is treated as opaque and
 *    is **never** trusted as inbound auth for the local Eliza dashboard.
 *    See `docs/security/remote-auth-hardening-plan.md` §7 for the explicit
 *    demotion rationale.
 *
 * 2. **Eliza Cloud SSO** (`getSsoRedirectUrl` / `exchangeCodeForSession`) —
 *    OAuth-style authorization-code flow against the cloud issuer. The
 *    callback handler in `app-core` (`api/auth/cloud-sso.ts`) consumes these
 *    methods to bind a verified cloud user to a local Identity. All error
 *    paths fail closed: the methods throw and the caller MUST refuse the
 *    request. There is no partial-claims fallback.
 */

import {
  CLOUD_AUTH_SERVICE_TYPE,
  type RuntimeEnvRecord,
  type IAgentRuntime,
  logger,
  Service,
  resolveApiSecurityConfig,
  resolveDesktopApiPort,
} from "@elizaos/core";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { CloudCredentials, DeviceAuthResponse, DevicePlatform } from "../types/cloud";
import { DEFAULT_CLOUD_CONFIG } from "../types/cloud";
import { CloudApiClient, CloudApiError } from "../utils/cloud-api";
import { getSetting, isTruthyCloudFlag } from "../utils/config";
import type { CloudBootstrapService } from "./cloud-bootstrap";

/** SHA-256 hash of hostname + platform + arch + cpu + memory. */
async function deriveDeviceId(): Promise<string> {
  const os = await import("node:os");
  const crypto = await import("node:crypto");
  const cpus = os.cpus();
  const raw = [
    os.hostname(),
    os.platform(),
    os.arch(),
    cpus[0]?.model ?? "?",
    cpus.length,
    os.totalmem(),
  ].join(":");
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function detectPlatform(): DevicePlatform {
  if (typeof process === "undefined") return "web";
  const map: Record<string, DevicePlatform> = {
    darwin: "macos",
    win32: "windows",
    linux: "linux",
  };
  return map[process.platform] ?? "linux";
}

// ─── Eliza Cloud SSO ───────────────────────────────────────────────────────

/**
 * Required ID-token claims for an Eliza Cloud SSO exchange.
 *
 * `sub` is the cloud user id (canonical identity key). `email` and `name`
 * are surfaced for UI display and identity provisioning. Anything else the
 * cloud issuer adds is preserved on `extra` for callers that need it but
 * is never required for auth decisions.
 */
export interface CloudSsoIdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  email: string;
  email_verified?: boolean;
  name: string;
  picture?: string;
  extra: Record<string, unknown>;
}

export interface CloudSsoSession {
  cloudUserId: string;
  email: string;
  displayName: string;
  claims: CloudSsoIdTokenClaims;
}

export interface SsoRedirectArgs {
  /**
   * Local URL the user should land on after the SSO round-trip
   * (e.g. `/first-run/setup`). The dashboard's callback route forwards
   * to this once the session cookie is set; it is NOT sent to the cloud
   * issuer.
   */
  returnTo?: string;
  /**
   * State nonce. The caller is responsible for generating this with
   * `crypto.randomBytes(32)` and storing it server-side keyed by the
   * issued cookie / pending exchange.
   */
  state: string;
  /**
   * Override for `ELIZA_CLOUD_CLIENT_ID`. Falls through to the env when
   * unset; explicitly throws when neither is provided.
   */
  clientId?: string;
  /** Allows tests to inject a synthetic env record. */
  env?: RuntimeEnvRecord;
}

export interface ExchangeCodeArgs {
  /** Authorization code returned on the SSO callback. */
  code: string;
  /** State value the cloud issuer echoed back on the callback. */
  state: string;
  /**
   * State value the caller originally issued. Compared with `state` and
   * mismatch causes a fail-closed throw before any network call is made.
   */
  expectedState: string;
  /**
   * Source for `getJwksUrl()`. The caller resolves this from the runtime
   * service registry (`runtime.getService("CLOUD_BOOTSTRAP")`) so this
   * file does not import from `app-core` directly.
   */
  bootstrap: CloudBootstrapService;
  /** Allows tests to inject a fake fetch for the token endpoint. */
  fetchImpl?: typeof fetch;
  /** Allows tests to inject a synthetic env record. */
  env?: RuntimeEnvRecord;
  /** Optional override for the redirect URI; defaults to the local callback. */
  redirectUri?: string;
}

interface RawTokenResponse {
  id_token?: unknown;
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

interface ApiKeyAuthInput {
  apiKey: string;
  organizationId?: string;
  userId?: string;
}

interface RawIdTokenPayload {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  picture?: unknown;
  [otherProperty: string]: unknown;
}

function readEnvKey(env: RuntimeEnvRecord, key: string): string | null {
  const value = env[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function processEnv(): RuntimeEnvRecord {
  if (typeof process === "undefined") return {};
  return process.env as RuntimeEnvRecord;
}

/**
 * Build the local SSO callback URL the cloud issuer will redirect back to.
 *
 * Reads `ELIZA_API_BIND` and the desktop API port from `@elizaos/core`'s
 * runtime-env helper so the redirect_uri matches whatever the dashboard
 * is actually serving on. Loopback binds default to `http://127.0.0.1:<port>`;
 * non-loopback binds (cloud-provisioned containers) use `https://`.
 */
function defaultRedirectUri(env: RuntimeEnvRecord): string {
  const security = resolveApiSecurityConfig(env);
  const port = resolveDesktopApiPort(env);
  const scheme = security.isLoopbackBind ? "http" : "https";
  // Strip any IPv6 brackets the bind host might already include.
  const host = security.bindHost.startsWith("[")
    ? security.bindHost
    : security.bindHost.includes(":") && !security.bindHost.startsWith("[")
      ? `[${security.bindHost}]`
      : security.bindHost;
  return `${scheme}://${host}:${port}/api/auth/login/sso/callback`;
}

/**
 * Returns the absolute URL the dashboard should redirect the user to in
 * order to start an Eliza Cloud SSO authorization-code flow.
 *
 * Throws when `ELIZA_CLOUD_CLIENT_ID` is unset and no `clientId` override
 * is provided — there is no built-in default. `ELIZA_CLOUD_ISSUER` is read
 * via the `CloudBootstrapService`'s service-port and must already be set;
 * if not, this method throws via the bootstrap's existing fail-closed
 * behaviour.
 *
 * The `state` argument MUST be generated by the caller with a cryptographic
 * RNG and stored server-side bound to the issued cookie. This method does
 * NOT generate or persist state.
 *
 * @param bootstrap - Service-port that exposes `getExpectedIssuer()`.
 * @param args - Required `state`, optional `clientId` / `returnTo` / `env`.
 */
export function getSsoRedirectUrl(bootstrap: CloudBootstrapService, args: SsoRedirectArgs): string {
  const env = args.env ?? processEnv();
  const clientId = args.clientId ?? readEnvKey(env, "ELIZA_CLOUD_CLIENT_ID");
  if (!clientId) {
    throw new Error("ELIZA_CLOUD_CLIENT_ID is not configured — cannot start Eliza Cloud SSO");
  }
  if (args.state.length === 0) {
    throw new Error("getSsoRedirectUrl requires a non-empty state nonce");
  }
  const issuer = bootstrap.getExpectedIssuer();
  const redirectUri = defaultRedirectUri(env);
  const params = new URLSearchParams();
  params.set("response_type", "code");
  params.set("client_id", clientId);
  params.set("redirect_uri", redirectUri);
  params.set("scope", "openid profile");
  params.set("state", args.state);
  if (args.returnTo) {
    // Forwarded through state on the cloud side is not safe (issuer-controlled);
    // we surface it as a separate hint that the local callback honours.
    params.set("eliza_return_to", args.returnTo);
  }
  return `${issuer}/oauth/authorize?${params.toString()}`;
}

function shapeIdTokenClaims(payload: RawIdTokenPayload): CloudSsoIdTokenClaims {
  if (typeof payload.iss !== "string" || payload.iss.length === 0) {
    throw new Error("id_token missing issuer claim");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("id_token missing sub claim");
  }
  if (
    typeof payload.aud !== "string" &&
    !(Array.isArray(payload.aud) && payload.aud.every((value) => typeof value === "string"))
  ) {
    throw new Error("id_token missing or malformed aud claim");
  }
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new Error("id_token missing exp claim");
  }
  if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) {
    throw new Error("id_token missing iat claim");
  }
  if (typeof payload.email !== "string" || payload.email.length === 0) {
    throw new Error("id_token missing email claim — Eliza Cloud SSO requires it");
  }
  if (typeof payload.name !== "string" || payload.name.length === 0) {
    throw new Error("id_token missing name claim — Eliza Cloud SSO requires it");
  }
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (
      key !== "iss" &&
      key !== "sub" &&
      key !== "aud" &&
      key !== "exp" &&
      key !== "iat" &&
      key !== "email" &&
      key !== "email_verified" &&
      key !== "name" &&
      key !== "picture"
    ) {
      extra[key] = value;
    }
  }
  return {
    iss: payload.iss,
    sub: payload.sub,
    aud: payload.aud as string | string[],
    exp: payload.exp,
    iat: payload.iat,
    email: payload.email,
    email_verified:
      typeof payload.email_verified === "boolean" ? payload.email_verified : undefined,
    name: payload.name,
    picture: typeof payload.picture === "string" ? payload.picture : undefined,
    extra,
  };
}

function shapeTokenResponse(payload: unknown): { idToken: string } {
  if (!payload || typeof payload !== "object") {
    throw new Error("Eliza Cloud token endpoint returned a non-object body");
  }
  const raw = payload as RawTokenResponse;
  if (typeof raw.id_token !== "string" || raw.id_token.length === 0) {
    throw new Error("Eliza Cloud token endpoint did not return an id_token");
  }
  return { idToken: raw.id_token };
}

/**
 * Exchange an authorization code for a verified Eliza Cloud session.
 *
 * Steps:
 *   1. Compare `state === expectedState`. Mismatch throws.
 *   2. POST to `${ELIZA_CLOUD_ISSUER}/oauth/token` with the code,
 *      `client_id`, and `client_secret` (the latter from
 *      `ELIZA_CLOUD_CLIENT_SECRET`).
 *   3. Verify the returned `id_token` against the JWKS exposed by
 *      `CloudBootstrapService.getJwksUrl()`. RS256 only.
 *   4. Project the claims onto a `CloudSsoSession`.
 *
 * Any error in fetch / signature verify / claim shape throws — this method
 * NEVER returns a partial or fallback session.
 */
export async function exchangeCodeForSession(args: ExchangeCodeArgs): Promise<CloudSsoSession> {
  if (args.code.length === 0) {
    throw new Error("exchangeCodeForSession requires a non-empty code");
  }
  if (!args.state || !args.expectedState || args.state !== args.expectedState) {
    throw new Error("Eliza Cloud SSO state mismatch — refusing to exchange code (possible CSRF)");
  }

  const env = args.env ?? processEnv();
  const clientId = readEnvKey(env, "ELIZA_CLOUD_CLIENT_ID");
  if (!clientId) {
    throw new Error("ELIZA_CLOUD_CLIENT_ID is not configured — cannot complete Eliza Cloud SSO");
  }
  const clientSecret = readEnvKey(env, "ELIZA_CLOUD_CLIENT_SECRET");
  if (!clientSecret) {
    throw new Error(
      "ELIZA_CLOUD_CLIENT_SECRET is not configured — cannot complete Eliza Cloud SSO"
    );
  }

  const issuer = args.bootstrap.getExpectedIssuer();
  const redirectUri = args.redirectUri ?? defaultRedirectUri(env);
  const tokenUrl = `${issuer}/oauth/token`;

  const fetchImpl = args.fetchImpl ?? fetch;
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", args.code);
  body.set("redirect_uri", redirectUri);
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);

  const response = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(
      `Eliza Cloud token endpoint returned HTTP ${response.status} for code exchange`
    );
  }
  const payload: unknown = await response.json();
  const { idToken } = shapeTokenResponse(payload);

  const jwksUrl = args.bootstrap.getJwksUrl();
  const remoteJwks = createRemoteJWKSet(new URL(jwksUrl));

  const verified = await jwtVerify(idToken, remoteJwks, {
    algorithms: ["RS256"],
    issuer,
    audience: clientId,
  });

  const claims = shapeIdTokenClaims(verified.payload as RawIdTokenPayload);

  return {
    cloudUserId: claims.sub,
    email: claims.email,
    displayName: claims.name,
    claims,
  };
}

// ─── Service ───────────────────────────────────────────────────────────────

/** Result of probing the saved API key against the cloud. */
export type ApiKeyProbe = "valid" | "unreachable" | "invalid";

export interface RevalidationState {
  /** `unknown` until a probe resolves; `invalid` once a revoked key is confirmed. */
  keyState: "unknown" | "valid" | "invalid";
  /** Consecutive reachable-but-rejected probes; debounces a transient 5xx. */
  consecutiveInvalid: number;
}

export interface RevalidationConfig {
  /** Re-probe delay while the key state is unresolved (unreachable / unconfirmed-invalid). */
  retryMs: number;
  /** Re-probe delay once the key state is resolved — catches a LATER revocation. */
  steadyMs: number;
  /** Reachable-but-rejected probes required before declaring the key revoked. */
  invalidThreshold: number;
}

export interface RevalidationDecision {
  state: RevalidationState;
  delayMs: number;
  log: { level: "info" | "error"; message: string } | null;
}

export const DEFAULT_REVALIDATION_CONFIG: RevalidationConfig = {
  retryMs: 60_000,
  steadyMs: 30 * 60_000,
  invalidThreshold: 2,
};

/**
 * Pure state machine for background API-key re-validation. Given the current
 * state and a fresh probe result, decide the next state, when to re-probe, and
 * whether to emit a one-shot state-change log. No I/O — fully unit-testable.
 *
 * Why this exists: at boot the key is trusted optimistically and validated once
 * in the background. If the cloud was unreachable at boot (or the key is revoked
 * AFTER boot), the one-shot check left the agent 401-blind on every turn with no
 * surfaced state. This loop retries transient unreachability, confirms a revoked
 * key with a loud actionable error (debounced so a single 5xx doesn't false-
 * alarm), and steady-re-checks so a post-boot revocation is still caught and a
 * later re-authorization self-heals.
 */
export function decideRevalidation(
  prev: RevalidationState,
  probe: ApiKeyProbe,
  cfg: RevalidationConfig = DEFAULT_REVALIDATION_CONFIG
): RevalidationDecision {
  if (probe === "valid") {
    const log =
      prev.keyState !== "valid"
        ? { level: "info" as const, message: "[CloudAuth] API key validated" }
        : null;
    return {
      state: { keyState: "valid", consecutiveInvalid: 0 },
      delayMs: cfg.steadyMs,
      log,
    };
  }

  if (probe === "invalid") {
    const consecutiveInvalid = prev.consecutiveInvalid + 1;
    const confirmed = consecutiveInvalid >= cfg.invalidThreshold;
    if (confirmed) {
      const log =
        prev.keyState !== "invalid"
          ? {
              level: "error" as const,
              message:
                "[CloudAuth] Eliza Cloud API key is REVOKED/INVALID (cloud reachable, key rejected). " +
                "Model calls will fail with 401 until the agent is re-provisioned or a valid ELIZAOS_CLOUD_API_KEY is set.",
            }
          : null;
      return {
        state: { keyState: "invalid", consecutiveInvalid },
        delayMs: cfg.steadyMs,
        log,
      };
    }
    // Not yet confirmed — re-probe soon (don't change the surfaced state yet).
    return {
      state: { keyState: prev.keyState, consecutiveInvalid },
      delayMs: cfg.retryMs,
      log: null,
    };
  }

  // unreachable — transient network state, not an auth signal: keep the prior
  // state and back off. (consecutiveInvalid is preserved, not reset, so a blip
  // between two real rejections doesn't restart the confirmation count.)
  return {
    state: { ...prev },
    delayMs: cfg.retryMs,
    log: null,
  };
}

export class CloudAuthService extends Service {
  static serviceType = CLOUD_AUTH_SERVICE_TYPE;
  capabilityDescription = "Eliza Cloud device authentication and SSO session helpers";

  private client: CloudApiClient;
  private credentials: CloudCredentials | null = null;
  private revalidationTimer: ReturnType<typeof setTimeout> | null = null;
  private revalidationState: RevalidationState = {
    keyState: "unknown",
    consecutiveInvalid: 0,
  };

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    this.client = new CloudApiClient(DEFAULT_CLOUD_CONFIG.baseUrl);
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new CloudAuthService(runtime);
    await service.initialize();
    return service;
  }

  async stop(): Promise<void> {
    if (this.revalidationTimer) {
      clearTimeout(this.revalidationTimer);
      this.revalidationTimer = null;
    }
    this.revalidationState = { keyState: "unknown", consecutiveInvalid: 0 };
    this.credentials = null;
  }

  private async initialize(): Promise<void> {
    const baseUrl = String(
      this.runtime.getSetting("ELIZAOS_CLOUD_BASE_URL") ?? DEFAULT_CLOUD_CONFIG.baseUrl
    );
    this.client.setBaseUrl(baseUrl);

    // Try existing API key first.  If the key is present in settings
    // (persisted via config file or character secrets in the DB), trust it
    // immediately so the agent is functional even when the cloud API is
    // temporarily unreachable.  A background validation fires to confirm
    // the key — if it turns out to be revoked the next model call will
    // surface the error, but the agent won't stall on startup.
    const existingKey = this.runtime.getSetting("ELIZAOS_CLOUD_API_KEY");
    if (existingKey) {
      const key = String(existingKey);
      this.client.setApiKey(key);

      // Accept the key optimistically — no blocking network call.
      this.credentials = {
        apiKey: key,
        userId: String(this.runtime.getSetting("ELIZAOS_CLOUD_USER_ID") ?? ""),
        organizationId: String(
          this.runtime.getSetting("ELIZAOS_CLOUD_ORG_ID") ??
            this.runtime.getSetting("ELIZA_CLOUD_ORGANIZATION_ID") ??
            ""
        ),
        authenticatedAt: Date.now(),
      };
      logger.info("[CloudAuth] Authenticated with saved API key");

      // Non-blocking, self-healing key re-validation. Boot stays instant; a
      // background loop confirms the key — retrying transient cloud-unreachable
      // so a boot-time outage doesn't leave it unvalidated forever, surfacing a
      // loud actionable error the moment the key is confirmed revoked, and
      // steady-re-checking so a revocation that happens AFTER boot is caught
      // instead of the agent silently 401ing every turn (see #8434 key-flag).
      this.scheduleRevalidation(0);
      return;
    }

    // Device-based auto-signup when explicitly enabled. The runtime hands the
    // flag back as boolean `true` for "true", so it is read through the
    // stringifying helper rather than compared against string literals.
    if (isTruthyCloudFlag(getSetting(this.runtime, "ELIZAOS_CLOUD_ENABLED"))) {
      try {
        await this.authenticateWithDevice();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[CloudAuth] Device auth failed (cloud may be unreachable): ${msg}`);
        logger.info(
          "[CloudAuth] Service will start unauthenticated — cloud features disabled until connectivity is restored"
        );
      }
    } else {
      logger.info("[CloudAuth] Cloud not enabled (set ELIZAOS_CLOUD_ENABLED=true)");
    }
  }

  /**
   * Probe the saved key: `valid` when an authenticated `/models` call succeeds,
   * `invalid` ONLY when the cloud is reachable and explicitly rejects the key
   * (401/403 — revoked/expired), `unreachable` for every other failure (5xx,
   * 429, timeout, network error). Only a `CloudApiError` carries a real HTTP
   * status; timeouts (`AbortSignal.timeout`) and connection failures reject with
   * a raw fetch/DOMException and so are correctly treated as `unreachable`. A
   * server-side 5xx/429 is NOT an auth signal — classifying it as `invalid`
   * would false-alarm a revoked-key error on a transient outage. The `invalid`
   * case is still debounced upstream so a single 401 blip can't flip the state.
   */
  private async probeApiKey(key: string): Promise<ApiKeyProbe> {
    try {
      const validationClient = new CloudApiClient(this.client.getBaseUrl(), key);
      await validationClient.requestData("GET", "/models", {
        timeoutMs: 2_500,
      });
      return "valid";
    } catch (err) {
      if (err instanceof CloudApiError && (err.statusCode === 401 || err.statusCode === 403)) {
        return "invalid";
      }
      return "unreachable";
    }
  }

  private scheduleRevalidation(delayMs: number): void {
    if (this.revalidationTimer) {
      clearTimeout(this.revalidationTimer);
    }
    // The timer is always cleared in stop(), so it can't outlive the service.
    const timer = setTimeout(() => {
      void this.runRevalidation();
    }, delayMs);
    // Don't let the background re-probe pin the Node event loop / block a clean
    // process exit. `unref` is Node-only; it's absent on the browser shim type.
    timer.unref?.();
    this.revalidationTimer = timer;
  }

  private async runRevalidation(): Promise<void> {
    const key = this.credentials?.apiKey;
    if (!key) {
      return; // logged out / stopped — let the loop die
    }
    const probe = await this.probeApiKey(key).catch(
      () => "unreachable" as ApiKeyProbe
    );
    // The active key may have changed during the await (re-auth) — drop stale.
    if (this.credentials?.apiKey !== key) {
      return;
    }
    const decision = decideRevalidation(this.revalidationState, probe);
    this.revalidationState = decision.state;
    if (decision.log) {
      if (decision.log.level === "error") {
        logger.error(decision.log.message);
      } else {
        logger.info(decision.log.message);
      }
    }
    this.scheduleRevalidation(decision.delayMs);
  }

  /**
   * True once a background probe has CONFIRMED the saved API key is
   * revoked/invalid (cloud reachable, key rejected). Status/health surfaces can
   * read this to report a degraded agent instead of letting it 401 blindly.
   */
  isApiKeyInvalid(): boolean {
    return this.revalidationState.keyState === "invalid";
  }

  /**
   * Free-tier device auto-signup. **Convenience only — not a security
   * primitive.** The hardware fingerprint is treated as opaque material the
   * cloud signup endpoint can use to mint a fresh API key + $5 free credit
   * for new installs. The result is usable for outbound LLM calls; it never
   * authorizes inbound dashboard access.
   *
   * See `docs/security/remote-auth-hardening-plan.md` §7.
   */
  async authenticateWithDevice(): Promise<CloudCredentials> {
    const deviceId = await deriveDeviceId();
    const platform = detectPlatform();
    const appVersion = process.env.ELIZAOS_CLOUD_APP_VERSION ?? "2.0.0-beta.0";
    const os = await import("node:os");

    logger.info(`[CloudAuth] Authenticating device (platform=${platform})`);

    const response = await this.client.requestData<DeviceAuthResponse>("POST", "/device-auth", {
      skipAuth: true,
      json: { deviceId, platform, appVersion, deviceName: os.hostname() },
    });

    this.credentials = {
      apiKey: response.data.apiKey,
      userId: response.data.userId,
      organizationId: response.data.organizationId,
      authenticatedAt: Date.now(),
    };
    this.client.setApiKey(response.data.apiKey);

    const action = response.data.isNew ? "New account created" : "Authenticated";
    logger.info(`[CloudAuth] ${action} (credits: $${response.data.credits.toFixed(2)})`);

    return this.credentials;
  }

  authenticateWithApiKey(input: ApiKeyAuthInput): CloudCredentials {
    const apiKey = input.apiKey.trim();
    if (!apiKey) {
      throw new Error("Eliza Cloud API key is required");
    }

    this.client.setApiKey(apiKey);
    this.credentials = {
      apiKey,
      userId: input.userId ?? "",
      organizationId: input.organizationId ?? "",
      authenticatedAt: Date.now(),
    };

    logger.info("[CloudAuth] Authenticated with API key");
    return this.credentials;
  }

  clearAuth(): void {
    this.credentials = null;
    this.client.setApiKey(undefined);
  }

  isAuthenticated(): boolean {
    return this.credentials !== null;
  }
  getCredentials(): CloudCredentials | null {
    return this.credentials;
  }
  getApiKey(): string | undefined {
    return this.credentials?.apiKey ?? this.client.getApiKey();
  }
  getClient(): CloudApiClient {
    return this.client;
  }
  getUserId(): string | undefined {
    return this.credentials?.userId;
  }
  getOrganizationId(): string | undefined {
    return this.credentials?.organizationId;
  }
}
