/**
 * BrowserService — single browser dispatcher with a pluggable target
 * registry.
 *
 * The agent uses what is available: targets register themselves at plugin
 * init (or later), and the BROWSER action calls into BrowserService which
 * picks the active target. Targets can be queried by id, listed, or
 * resolved by availability.
 *
 * Built-in targets:
 *   - `workspace` — Eliza's electrobun-embedded BrowserView (with a JSDOM
 *     web-mode fallback when the desktop bridge isn't configured). Always
 *     registered by this plugin's `start`. Always available.
 *
 * Optional targets registered by other plugins:
 *   - `bridge` — registered by this plugin when a `BrowserBridgeRouteService`
 *     is reachable via the runtime; routes commands to the user's real
 *     Chrome / Safari via the Agent Browser Bridge companion extension.
 *     Available iff at least one companion is paired.
 *   - `computeruse` — registered by `@elizaos/plugin-computeruse` on plugin
 *     init when its capabilities indicate the puppeteer-driven Chromium is
 *     ready.
 *   - `stagehand` — registered by this plugin when a Stagehand command
 *     endpoint is configured; used as a low-priority fallback.
 *
 * Anyone can add a new target later by calling `registerTarget` — that's
 * the whole point of the pattern. The BROWSER action stays one action.
 */

import {
  type AuthorizedInteractionAction,
  ElizaError,
  type IAgentRuntime,
  type InteractionCapabilitySet,
  type InteractionConfirmationGrant,
  type InteractionConfirmationGrantConsumer,
  type InteractionProfileGrantVerifier,
  type InteractionSession,
  logger,
  Service,
} from "@elizaos/core";
import {
  authorizeBrowserUpload,
  type BrowserAuthorizedUploadExecution,
  createBrowserUploadReceipt,
} from "./browser-command-authority.js";
import {
  browserDomainPolicyRequestForCommand,
  evaluateBrowserDomainPolicies,
} from "./browser-domain-policy.js";
import {
  BrowserDispatchFailure,
  isBrowserDispatchFailure,
  isIdempotentBrowserSubaction,
} from "./dispatch-types.js";
import {
  type NativeBrowserClientTransport,
  readNativeBrowserPage,
} from "./native-page-reader.js";
import {
  BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
  type BrowserBridgeRouteService,
} from "./service.js";
import { bridgeSupports } from "./targets/bridge-target.js";
import { maybeCreateStagehandTarget } from "./targets/stagehand-target.js";
import {
  ensureBrowserWorkspaceDefaultTabWithRetry,
  getBrowserWorkspaceSnapshot,
} from "./workspace/browser-workspace.js";
import {
  assertBrowserWorkspaceUrl,
  normalizeBrowserWorkspaceCommand,
} from "./workspace/browser-workspace-helpers.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
  BrowserWorkspaceSnapshot,
} from "./workspace/browser-workspace-types.js";

export const BROWSER_SERVICE_TYPE = "browser";

export type BrowserTargetKind = "app" | "companion" | "stagehand" | "external";

export interface BrowserTargetResolutionContext {
  command: BrowserWorkspaceCommand;
  env: NodeJS.ProcessEnv;
  mobile: boolean;
}

/**
 * Pluggable browser backend. Implementations translate the canonical
 * BrowserWorkspaceCommand surface into whatever native shape they speak
 * (electrobun bridge, Chrome companion HTTP, puppeteer CDP, etc.) and
 * return the canonical BrowserWorkspaceCommandResult.
 *
 * Capability-aware dispatch (issue #18258): targets SHOULD declare which
 * subactions they support via {@link BrowserTarget.supports} so the dispatcher
 * can skip an incapable target *before* dispatch (returning `UNSUPPORTED`)
 * instead of relying on a thrown error after the command may have begun.
 * Targets that omit `supports` are assumed to accept every subaction (legacy
 * behavior, e.g. the `workspace` target).
 *
 * When a target detects mid-execution that a side effect may have occurred
 * before an error was observed (e.g. a click fired but the page response
 * timed out), it SHOULD throw a {@link BrowserDispatchFailure} with kind
 * `UNCERTAIN_OUTCOME` so the dispatcher knows the command must not be
 * replayed against another target.
 */
export interface BrowserTarget {
  /** Stable identifier — `workspace`, `bridge`, `computeruse`, etc. */
  readonly id: string;
  /** Short human-readable name for diagnostics. */
  readonly name: string;
  /** One-line description of what this target controls. */
  readonly description: string;
  /** Broad target class used for automatic routing. */
  readonly kind?: BrowserTargetKind;
  /** Lower scores are fallback choices. */
  readonly priority?: number;
  /**
   * Optional command-aware score. Return `null` to opt out of automatic
   * routing for this command while still allowing explicit `target`.
   */
  score?(context: BrowserTargetResolutionContext): number | null;
  /**
   * Cheap availability check. Called when the BROWSER action wants to
   * route a command and the caller didn't pin a target. Should be fast
   * (no network round-trips) when possible.
   */
  available(): Promise<boolean>;
  /**
   * Capability check: return `true` if this target can execute `command`'s
   * subaction, `false` if it cannot (the dispatcher returns `UNSUPPORTED`
   * and tries the next target). When omitted, the target is treated as
   * supporting every subaction (legacy behavior).
   *
   * This is a pre-dispatch selection signal — it must NOT have side effects
   * and must be cheap. Implementations typically test a static `Set` of
   * supported subaction strings.
   */
  supports?(command: BrowserWorkspaceCommand): boolean;
  /**
   * Run the command. Throw on unsupported subactions (legacy behavior) or,
   * preferably, return a {@link BrowserDispatchFailure}. If a side effect may
   * have begun before the error, throw a `BrowserDispatchFailure` with kind
   * `UNCERTAIN_OUTCOME` so the command is never replayed.
   */
  execute(
    command: BrowserWorkspaceCommand,
  ): Promise<BrowserWorkspaceCommandResult>;
  /**
   * Optional proof-producing upload boundary. Generic `execute(upload)` is
   * never called; a target must opt in and return an exact effect receipt.
   */
  executeAuthorizedUpload?(action: AuthorizedInteractionAction): Promise<{
    result: BrowserWorkspaceCommandResult;
    effectReceipt: unknown;
  }>;
}

function findBlockedGenericCommand(
  command: BrowserWorkspaceCommand,
): "eval" | "upload" | "realistic-upload" | null {
  const pending = [command];
  const visited = new Set<BrowserWorkspaceCommand>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || visited.has(candidate)) continue;
    visited.add(candidate);
    for (const value of [candidate.subaction, candidate.operation]) {
      const normalized =
        typeof value === "string"
          ? value.trim().toLowerCase().replaceAll("_", "-")
          : "";
      if (
        normalized === "eval" ||
        normalized === "upload" ||
        normalized === "realistic-upload"
      ) {
        return normalized;
      }
    }
    if (candidate.subaction === "batch" && Array.isArray(candidate.steps)) {
      pending.push(...candidate.steps);
    }
  }
  return null;
}

/**
 * Flattens a command and its nested batch steps so every step is policy
 * checked individually — a blocked navigation cannot hide inside a batch.
 */
function flattenBrowserCommands(
  command: BrowserWorkspaceCommand,
): BrowserWorkspaceCommand[] {
  const flat: BrowserWorkspaceCommand[] = [];
  const pending = [command];
  const visited = new Set<BrowserWorkspaceCommand>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || visited.has(candidate)) continue;
    visited.add(candidate);
    flat.push(candidate);
    if (candidate.subaction === "batch" && Array.isArray(candidate.steps)) {
      pending.push(...candidate.steps);
    }
  }
  return flat;
}

export class BrowserService extends Service {
  static override readonly serviceType = BROWSER_SERVICE_TYPE;
  override capabilityDescription =
    "Single browser dispatcher with a pluggable target registry. Targets (workspace / bridge / computeruse / …) register themselves; the BROWSER action picks the active target or honors a pinned override.";

  private readonly targets = new Map<string, BrowserTarget>();
  /** Registration order — used as the default preference order. */
  private readonly targetOrder: string[] = [];
  private nativeClientTransport: NativeBrowserClientTransport | null = null;

  setNativeClientTransport(
    transport: NativeBrowserClientTransport | null,
  ): void {
    this.nativeClientTransport = transport;
  }

  async stop(): Promise<void> {
    this.nativeClientTransport = null;
    this.targets.clear();
    this.targetOrder.length = 0;
  }

  static override async start(runtime: IAgentRuntime): Promise<BrowserService> {
    const service = new BrowserService(runtime);
    service.registerTarget(createWorkspaceTarget());
    // Bridge target self-registers when its dependencies (BrowserBridgeRouteService
    // implementor) are reachable via the runtime. Missing dependencies keep the
    // agent in workspace-only mode.
    try {
      const bridgeTarget = await maybeCreateBridgeTarget(runtime);
      if (bridgeTarget) service.registerTarget(bridgeTarget);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(
        `[BrowserService] bridge target not registered at start: ${message}`,
      );
    }
    try {
      const stagehandTarget = await maybeCreateStagehandTarget();
      if (stagehandTarget) service.registerTarget(stagehandTarget);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(
        `[BrowserService] stagehand target not registered at start: ${message}`,
      );
    }
    // Seed the Safari-style default search tab so the browser never opens
    // empty-and-sad (#13596). Best-effort with a bounded desktop bridge
    // readiness window: failure must not prevent the service from starting.
    try {
      await ensureBrowserWorkspaceDefaultTabWithRetry();
    } catch (err) {
      // error-policy:J4 startup should expose the browser even when the optional default tab cannot be seeded.
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[BrowserService] default search tab not seeded at start: ${message}`,
      );
    }
    return service;
  }

  /**
   * Register a target. Idempotent on `id` — calling twice with the same id
   * replaces the previous registration without affecting registration
   * order. New ids are appended to the order list.
   */
  registerTarget(target: BrowserTarget): void {
    if (!this.targets.has(target.id)) {
      this.targetOrder.push(target.id);
    }
    this.targets.set(target.id, target);
    logger.debug(
      `[BrowserService] registered target "${target.id}" (${target.name})`,
    );
  }

  unregisterTarget(id: string): boolean {
    const removed = this.targets.delete(id);
    if (removed) {
      const idx = this.targetOrder.indexOf(id);
      if (idx >= 0) this.targetOrder.splice(idx, 1);
    }
    return removed;
  }

  listTargets(): BrowserTarget[] {
    return this.targetOrder
      .map((id) => this.targets.get(id))
      .filter((target): target is BrowserTarget => target !== undefined);
  }

  /**
   * Read-only live workspace snapshot (bridge mode + open tabs). Hosts query
   * this through the runtime service registry so no caller needs a static
   * import edge into this plugin.
   */
  getWorkspaceSnapshot(): Promise<BrowserWorkspaceSnapshot> {
    return getBrowserWorkspaceSnapshot();
  }

  /**
   * Resolve the active target for a command. If `preferredId` is given,
   * returns that target only if available; otherwise scores registered
   * targets and returns the best available one.
   * Returns `null` if nothing is available.
   */
  async resolveTarget(
    preferredId?: string,
    command: BrowserWorkspaceCommand = { subaction: "state" },
  ): Promise<BrowserTarget | null> {
    const targets = await this.resolveTargets(preferredId, command);
    return targets[0] ?? null;
  }

  async resolveTargets(
    preferredId?: string,
    command: BrowserWorkspaceCommand = { subaction: "state" },
  ): Promise<BrowserTarget[]> {
    if (preferredId) {
      const target = this.targets.get(preferredId);
      if (!target) return [];
      try {
        return (await target.available()) ? [target] : [];
      } catch (error) {
        throw new ElizaError(
          `Browser target "${preferredId}" availability check failed.`,
          {
            code: "BROWSER_TARGET_UNAVAILABLE",
            cause: error,
            context: {
              targetId: preferredId,
              subaction: command.subaction,
            },
            severity: "ephemeral",
          },
        );
      }
    }

    const context: BrowserTargetResolutionContext = {
      command,
      env: process.env,
      mobile: isMobileBrowserRuntime(process.env),
    };
    const available: Array<{
      score: number;
      order: number;
      target: BrowserTarget;
    }> = [];

    for (const id of this.targetOrder) {
      const target = this.targets.get(id);
      if (!target) continue;
      try {
        const score = target.score
          ? target.score(context)
          : (target.priority ?? 0);
        if (score === null) continue;
        if (await target.available()) {
          available.push({
            score,
            order: this.targetOrder.indexOf(id),
            target,
          });
        }
      } catch (err) {
        // error-policy:J4 failover scan — a candidate whose availability check
        // throws is excluded so the other registered targets can still be
        // selected (unlike the pinned-`preferredId` path, which throws). Log so
        // a systemically broken target is observable instead of silently gone.
        logger.debug(
          `[BrowserService] target "${id}" excluded from resolution; availability check failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return available
      .sort((a, b) => {
        const aScore = Number.isFinite(a.score) ? a.score : 0;
        const bScore = Number.isFinite(b.score) ? b.score : 0;
        const aOrder = Number.isFinite(a.order) ? a.order : 0;
        const bOrder = Number.isFinite(b.order) ? b.order : 0;
        return bScore - aScore || aOrder - bOrder;
      })
      .map(({ target }) => target);
  }

  /**
   * Dispatch a command with capability-aware selection and side-effect safety
   * (issue #18258).
   *
   * Selection phase (pre-dispatch): among available targets, the dispatcher
   * finds one whose {@link BrowserTarget.supports} declares it can handle the
   * command's subaction. Targets that omit `supports` are assumed capable.
   * Fallback across candidates is permitted **only** in this phase — for
   * `UNAVAILABLE` (no target available) and `UNSUPPORTED` (target can't handle
   * the subaction) failures.
   *
   * Execution phase (post-dispatch): once a target's `execute()` is invoked,
   * the command is committed to that target. If `execute()` throws, the command
   * is **never replayed** against another target, because a click / submit /
   * navigation / upload may have partially or fully completed before the error
   * was observed. The original failure is surfaced to the caller. If the target
   * throws a {@link BrowserDispatchFailure} with `UNCERTAIN_OUTCOME`, that kind
   * is preserved so callers can branch on it. Post-dispatch replay is
   * forbidden for read-only subactions too — targets are distinct browser
   * sessions, so a fallback read would answer from a different browser.
   * Idempotency only selects the error shape: reads rethrow the original
   * cause, opaque mutation failures become `UNCERTAIN_OUTCOME`.
   *
   * `targetId` pins the target: no fallback is attempted, and capability is
   * still checked (an `UNSUPPORTED` pin returns a typed failure rather than
   * throwing deep inside the target).
   */
  async execute(
    command: BrowserWorkspaceCommand,
    targetId?: string,
    nativeClientId?: string,
  ): Promise<BrowserWorkspaceCommandResult> {
    command = normalizeBrowserWorkspaceCommand(command);
    const blockedCommand = findBlockedGenericCommand(command);
    if (blockedCommand) {
      throw new BrowserDispatchFailure(
        "POLICY_BLOCKED",
        blockedCommand === "eval"
          ? "Generic browser eval is disabled. Use typed browser commands instead."
          : "Browser upload requires an exact consume-once interaction confirmation.",
        { targetId: targetId ?? null },
      );
    }
    // Per-domain policy hooks (issue #19882): every step — including nested
    // batch steps — is evaluated against the registered policies before any
    // target is selected. The first non-allow decision blocks the whole
    // dispatch; nothing has executed yet, so failing here is side-effect free.
    for (const step of flattenBrowserCommands(command)) {
      const decision = evaluateBrowserDomainPolicies(
        browserDomainPolicyRequestForCommand(step, targetId ?? null),
      );
      if (decision.verdict !== "allow") {
        throw new BrowserDispatchFailure(
          "POLICY_BLOCKED",
          decision.verdict === "require_confirmation"
            ? `Browser command "${step.subaction}" requires explicit confirmation by domain policy "${decision.policyId}": ${decision.reason}`
            : `Browser command "${step.subaction}" was blocked by domain policy "${decision.policyId}": ${decision.reason}`,
          { targetId: targetId ?? null },
        );
      }
    }
    if (
      nativeClientId &&
      (!targetId || targetId === "workspace" || targetId === "native-client")
    ) {
      if (["open", "navigate", "show"].includes(command.subaction)) {
        if (command.id)
          throw new BrowserDispatchFailure(
            "UNSUPPORTED",
            "Server tab IDs cannot address the requesting client's native tabs.",
            { targetId: "native-client" },
          );
        if (command.subaction !== "show" && !command.url)
          throw new Error("Native Browser navigation requires a URL.");
        if (!this.nativeClientTransport)
          throw new BrowserDispatchFailure(
            "UNAVAILABLE",
            "Native Browser client transport is unavailable.",
            { targetId: "native-client" },
          );
        const url = command.url
          ? assertBrowserWorkspaceUrl(command.url)
          : undefined;
        await this.nativeClientTransport.navigate(nativeClientId, url);
        return {
          targetId: "native-client",
          mode: "web",
          subaction: command.subaction,
          value: {
            dispatched: true,
            ...(command.url ? { url: command.url } : {}),
            note: "Navigation delivered to the requesting client; read the native page to verify loaded content.",
          },
        };
      }
      return readNativeBrowserPage(
        command,
        nativeClientId,
        this.nativeClientTransport?.readPage ?? null,
      );
    }
    return this.executeSelected(command, targetId);
  }

  /**
   * Executes one confirmed upload through the v2 interaction contract. The
   * confirmation is consumed before dispatch and the target is pinned to the
   * session adapter, preventing account or backend substitution.
   */
  async executeConfirmedUpload(
    command: BrowserWorkspaceCommand,
    authorization: {
      actionId: string;
      requestedAt: string;
      confirmationGrant: InteractionConfirmationGrant;
      confirmationGrantConsumer: InteractionConfirmationGrantConsumer;
      profileGrantVerifier?: InteractionProfileGrantVerifier;
      session: InteractionSession;
      capabilities: InteractionCapabilitySet;
    },
  ): Promise<BrowserAuthorizedUploadExecution> {
    // `execute()` hard-blocks upload before any target is reached, so this is
    // the only path a real authorized upload takes — and therefore the only
    // place the per-domain `upload` policy can apply. Evaluate before the
    // confirmation grant is consumed or any target work starts, so a blocked
    // upload burns nothing and leaves no side effect.
    for (const step of flattenBrowserCommands(command)) {
      const decision = evaluateBrowserDomainPolicies({
        ...browserDomainPolicyRequestForCommand(
          step,
          authorization.session.adapterId,
        ),
      });
      if (decision.verdict !== "allow") {
        throw new BrowserDispatchFailure(
          "POLICY_BLOCKED",
          decision.verdict === "require_confirmation"
            ? `Confirmed browser upload "${step.subaction}" requires explicit confirmation by domain policy "${decision.policyId}": ${decision.reason}`
            : `Confirmed browser upload "${step.subaction}" was blocked by domain policy "${decision.policyId}": ${decision.reason}`,
          { targetId: authorization.session.adapterId },
        );
      }
    }
    const [target] = await this.resolveTargets(
      authorization.session.adapterId,
      command,
    );
    if (target && target.id !== authorization.session.adapterId) {
      throw new BrowserDispatchFailure(
        "UNSUPPORTED",
        "Resolved browser target identity changed before authorization.",
        { targetId: authorization.session.adapterId },
      );
    }
    const executeAuthorizedUpload =
      target?.executeAuthorizedUpload?.bind(target);
    if (!target || !executeAuthorizedUpload) {
      throw new BrowserDispatchFailure(
        "UNSUPPORTED",
        `Browser target "${authorization.session.adapterId}" does not provide proof-producing upload execution.`,
        { targetId: authorization.session.adapterId },
      );
    }
    if (target.supports && !target.supports(command)) {
      throw new BrowserDispatchFailure(
        "UNSUPPORTED",
        `Browser target "${authorization.session.adapterId}" does not support confirmed upload execution.`,
        { targetId: authorization.session.adapterId },
      );
    }
    const authorized = await authorizeBrowserUpload({
      ...authorization,
      command,
    });
    try {
      const targetOutput = await executeAuthorizedUpload(authorized.action);
      return Object.freeze({
        result: targetOutput.result,
        receipt: createBrowserUploadReceipt(
          authorized,
          targetOutput.result,
          targetOutput.effectReceipt,
        ),
      });
    } catch (error) {
      // error-policy:J1 The dispatch boundary preserves uncertain mutation outcomes as a typed failure.
      if (
        isBrowserDispatchFailure(error) &&
        error.kind === "UNCERTAIN_OUTCOME"
      ) {
        throw error;
      }
      throw new BrowserDispatchFailure(
        "UNCERTAIN_OUTCOME",
        `Browser target "${target.id}" failed after confirmed upload dispatch; the outcome is uncertain and must not be replayed.`,
        { targetId: target.id, cause: error },
      );
    }
  }

  private async executeSelected(
    command: BrowserWorkspaceCommand,
    targetId?: string,
  ): Promise<BrowserWorkspaceCommandResult> {
    // --- Selection phase (pre-dispatch) -------------------------------------
    // Find an available target that supports this command. Targets without a
    // `supports` method are treated as supporting everything (legacy behavior).
    const candidates = await this.resolveTargets(targetId, command);
    if (candidates.length === 0) {
      throw this.unavailableFailure(command, targetId);
    }

    // For an unpinned dispatch, find the highest-scoring target that supports
    // the command. Unsupported targets are skipped here (pre-dispatch fallback).
    // For a pinned dispatch, honor the pin but still surface UNSUPPORTED as a
    // typed failure instead of letting execute() throw opaquely.
    let selected: BrowserTarget | null = null;
    if (targetId) {
      const pinned = candidates[0];
      if (pinned) {
        selected = pinned;
        if (selected.supports && !selected.supports(command)) {
          throw new BrowserDispatchFailure(
            "UNSUPPORTED",
            `Browser target "${selected.id}" does not support subaction "${command.subaction}".`,
            { targetId: selected.id },
          );
        }
      }
    } else {
      for (const candidate of candidates) {
        if (!candidate.supports || candidate.supports(command)) {
          selected = candidate;
          break;
        }
      }
      if (!selected) {
        // Every available target declined this subaction.
        throw new BrowserDispatchFailure(
          "UNSUPPORTED",
          `No available browser target supports subaction "${command.subaction}". Targets checked: ${candidates
            .map((t) => `"${t.id}"`)
            .join(", ")}.`,
        );
      }
    }

    if (!selected) {
      throw this.unavailableFailure(command, targetId);
    }

    // --- Execution phase (post-dispatch) ------------------------------------
    // The command is now committed to `selected`. NEVER replay it against
    // another target, even on error — a side effect may have already occurred.
    try {
      return {
        ...(await selected.execute(command)),
        targetId: selected.id,
      };
    } catch (err) {
      // Preserve a typed dispatch failure's kind so callers can branch on
      // UNCERTAIN_OUTCOME / STALE_REF / SESSION_GONE / AUTH_REQUIRED /
      // POLICY_BLOCKED. Wrap any other error as UNCERTAIN_OUTCOME for
      // side-effecting commands (we can't prove it didn't partially complete),
      // or rethrow as-is for idempotent reads where no side effect is possible.
      if (isBrowserDispatchFailure(err)) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      const idempotent = isIdempotentBrowserSubaction(command.subaction);
      logger.debug(
        `[BrowserService] target "${selected.id}" failed for ${command.subaction} (idempotent=${idempotent}): ${message}`,
      );
      if (idempotent) {
        // Read-only command — no side effect possible. Rethrow the original so
        // the caller sees the real cause; there's nothing to protect.
        throw err;
      }
      // Side-effecting command failed opaquely. We cannot prove it didn't
      // partially execute, so classify as UNCERTAIN_OUTCOME and never replay.
      throw new BrowserDispatchFailure(
        "UNCERTAIN_OUTCOME",
        `Browser command "${command.subaction}" against target "${selected.id}" failed after dispatch and may have partially completed: ${message}. It will not be replayed against another target.`,
        { targetId: selected.id, cause: err },
      );
    }
  }

  /**
   * Build the typed `UNAVAILABLE` failure with helpful diagnostics.
   */
  private unavailableFailure(
    command: BrowserWorkspaceCommand,
    targetId?: string,
  ): BrowserDispatchFailure {
    const availableIds = this.targetOrder.join(", ") || "(none)";
    return new BrowserDispatchFailure(
      "UNAVAILABLE",
      targetId
        ? `Browser target "${targetId}" is not available. Registered targets: ${availableIds}.`
        : `No browser target is available for subaction "${command.subaction}". Registered targets: ${availableIds}.`,
      { targetId: targetId ?? null },
    );
  }
}

function createWorkspaceTarget(): BrowserTarget {
  return {
    id: "workspace",
    name: "Browser Workspace",
    description:
      "Eliza's electrobun-embedded BrowserView (desktop) or JSDOM fallback (web). Always available.",
    kind: "app",
    priority: 100,
    score: ({ mobile }) => (mobile ? 120 : 100),
    available: async () => true,
    execute: async (command) => {
      const { executeBrowserWorkspaceCommand } = await import(
        "./workspace/browser-workspace.js"
      );
      return executeBrowserWorkspaceCommand(command);
    },
  };
}

async function maybeCreateBridgeTarget(
  runtime: IAgentRuntime,
): Promise<BrowserTarget | null> {
  const service = runtime.getService<BrowserBridgeRouteService>(
    BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
  );
  if (!service) return null;
  return {
    id: "bridge",
    name: "Browser Bridge (Chrome / Safari companion)",
    description:
      "Routes commands to the user's real Chrome or Safari via the Agent Browser Bridge companion extension. Subset of subactions supported (open / navigate / close / list / state / show / hide / tab / get).",
    kind: "companion",
    priority: 80,
    score: ({ mobile }) => (mobile ? null : 80),
    // Capability-aware pre-dispatch check (issue #18258): the bridge only
    // handles a read-mostly subset of subactions. Declaring it here lets the
    // dispatcher skip the bridge for unsupported commands *before* dispatch
    // instead of discovering it via a thrown error.
    supports: bridgeSupports,
    available: async () => {
      try {
        const companions = await service.listBrowserCompanions();
        return companions.length > 0;
      } catch {
        return false;
      }
    },
    execute: async (command) => {
      const { dispatchBridgeCommand } = await import(
        "./targets/bridge-target.js"
      );
      return dispatchBridgeCommand(service, command);
    },
  };
}

function isMobileBrowserRuntime(env: NodeJS.ProcessEnv): boolean {
  const platform = (
    env.ELIZA_MOBILE_PLATFORM ??
    env.ELIZA_PLATFORM ??
    env.CAPACITOR_PLATFORM ??
    ""
  ).toLowerCase();
  return platform === "ios" || platform === "android" || platform === "mobile";
}
