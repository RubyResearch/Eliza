/**
 * Capacitor driver for isolated Browser WebViews. One process-scoped owner
 * reconciles durable per-tab lifecycle intent against native state, while one
 * global presentation transaction selects either the host or exactly one tab.
 * Owner/session fencing survives React remounts and prevents an older JS realm
 * from mutating surfaces adopted by a newer renderer.
 */

import { logger } from "@elizaos/logger";
import { getNativePlugin } from "../bridge/native-plugins";
import type {
  NativePageRead,
  NativeSurfaceCreateRequest,
  NativeSurfaceShell,
  SurfaceBounds,
  SurfaceOcclusionRect,
} from "./native-surface-shell";

export interface ElizaSurfaceManagerState {
  exists: boolean;
  foregrounded: boolean;
  currentUrl: string | null;
  process: "isolated" | "shared" | null;
  storage: "isolated" | "shared" | null;
  owner: string | null;
  session: string | null;
  epoch: number | null;
}

interface SurfaceIdentityOptions {
  owner: string;
  session: string;
  epoch: number;
}

export interface ElizaSurfaceManagerPlugin {
  [key: string]: unknown;
  createSurface(
    options: SurfaceIdentityOptions & {
      id: string;
      url?: string;
      process: "isolated" | "shared";
      storage: "isolated" | "shared";
    },
  ): Promise<void>;
  setBounds(
    options: SurfaceIdentityOptions & {
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      outerClip: SurfaceBounds["outerClip"];
    },
  ): Promise<void>;
  setOcclusionRects(
    options: SurfaceIdentityOptions & {
      id: string;
      rects: readonly SurfaceOcclusionRect[];
    },
  ): Promise<void>;
  navigate(
    options: SurfaceIdentityOptions & { id: string; url: string },
  ): Promise<void>;
  reloadSurface(
    options: SurfaceIdentityOptions & { id: string },
  ): Promise<void>;
  goBack(options: SurfaceIdentityOptions & { id: string }): Promise<void>;
  readPage(
    options: SurfaceIdentityOptions & { id: string; selector?: string },
  ): Promise<unknown>;
  addListener(
    eventName: "navigationChanged",
    listener: (event: unknown) => void,
  ): Promise<{ remove(): Promise<void> }>;
  destroySurface(
    options: SurfaceIdentityOptions & { id: string },
  ): Promise<void>;
  presentSurface(
    options: SurfaceIdentityOptions & { id: string | null },
  ): Promise<void>;
  getSurfaceState(
    options: SurfaceIdentityOptions & { id: string },
  ): Promise<unknown>;
  listSurfaceStates(options: SurfaceIdentityOptions): Promise<unknown>;
  reconcileOwner(
    options: SurfaceIdentityOptions & { desiredIds: readonly string[] },
  ): Promise<void>;
}

export interface NativeSurfaceOwnerIdentity {
  readonly owner: string;
  readonly session: string;
  readonly epoch: number;
}

function plugin(): ElizaSurfaceManagerPlugin {
  return getNativePlugin<ElizaSurfaceManagerPlugin>("ElizaSurfaceManager");
}

function createRealmSession(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `browser-realm-${globalThis.crypto.randomUUID()}`;
  }
  return `browser-realm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const OWNER_EPOCH_STORAGE_KEY = "eliza:native-browser-owner-epoch";

function createRealmEpoch(): number {
  const timeOrigin =
    typeof globalThis.performance?.timeOrigin === "number"
      ? globalThis.performance.timeOrigin
      : Date.now();
  let prior = 0;
  try {
    const stored = globalThis.sessionStorage?.getItem(OWNER_EPOCH_STORAGE_KEY);
    if (stored !== null && stored !== undefined) {
      const parsed = Number.parseInt(stored, 10);
      if (Number.isSafeInteger(parsed) && parsed > 0) prior = parsed;
    }
  } catch {
    // error-policy:J4 a restricted host may disable sessionStorage; the realm's
    // monotonic navigation time still fences ordinary renderer reloads.
  }
  const epoch = Math.max(Math.floor(timeOrigin * 1_000), prior + 1);
  try {
    globalThis.sessionStorage?.setItem(OWNER_EPOCH_STORAGE_KEY, String(epoch));
  } catch {
    // error-policy:J4 epoch persistence is optional when host storage is
    // unavailable; native still enforces the realm's time-ordered epoch.
  }
  return epoch;
}

const DEFAULT_IDENTITY: NativeSurfaceOwnerIdentity = {
  owner: "eliza-browser-workspace",
  session: createRealmSession(),
  epoch: createRealmEpoch(),
};

function report(op: string, error: unknown): void {
  // error-policy:J1 native transport boundary — a terminal acknowledged
  // failure is reported once per owner/generation/operation, then rendered as
  // a retryable Browser-unavailable state by the hook.
  logger.error({ error }, `[CapacitorNativeSurfaceShell] ${op} failed`);
}

export class NativeSurfaceUnavailableError extends Error {
  readonly surfaceId: string | null;
  readonly generation: number;
  readonly operation: string;
  readonly revision: number;

  constructor(options: {
    surfaceId: string | null;
    generation: number;
    operation: string;
    revision: number;
    cause: unknown;
  }) {
    super(
      `${options.operation} failed after ${MAX_COMMAND_ATTEMPTS} attempts`,
      {
        cause: options.cause,
      },
    );
    this.name = "NativeSurfaceUnavailableError";
    this.surfaceId = options.surfaceId;
    this.generation = options.generation;
    this.operation = options.operation;
    this.revision = options.revision;
  }
}

/** Reconciles Browser surface lifecycle and atomic native presentation. */
export class CapacitorNativeSurfaceShell implements NativeSurfaceShell {
  private readonly surfaces = new Map<string, SurfaceCommandState>();
  private readonly reportedFailures = new Set<string>();
  private ownerReady: Promise<void> | null = null;
  private presentationTail: Promise<void> = Promise.resolve();
  private presentationRevision = 0;
  private desiredPresentedId: string | null = null;

  constructor(
    private readonly getNativeManager: () => ElizaSurfaceManagerPlugin = plugin,
    private readonly identity: NativeSurfaceOwnerIdentity = DEFAULT_IDENTITY,
  ) {}

  createSurface(req: NativeSurfaceCreateRequest): Promise<void> {
    const entry = this.getOrCreateEntry(req.id);
    const previous = entry.desired;
    const policyChanged =
      previous !== null &&
      (previous.request.policy.process !== req.policy.process ||
        previous.request.policy.storage !== req.policy.storage);
    const beginsGeneration = previous === null || policyChanged;
    if (beginsGeneration) {
      entry.nextGeneration += 1;
      entry.lastBoundsKey = null;
      entry.lastOcclusionKey = null;
    }
    entry.desired = {
      request: req,
      bounds: previous?.bounds ?? null,
      occlusions: previous?.occlusions ?? [],
      generation: beginsGeneration ? entry.nextGeneration : previous.generation,
    };
    return this.requestReconcile(entry);
  }

  setBounds(id: string, bounds: SurfaceBounds): Promise<void> {
    const entry = this.surfaces.get(id);
    if (!entry?.desired) return missingDesiredState(id, "setBounds");
    entry.desired = { ...entry.desired, bounds };
    return this.requestReconcile(entry);
  }

  setOcclusionRects(
    id: string,
    rects: readonly SurfaceOcclusionRect[],
  ): Promise<void> {
    const entry = this.surfaces.get(id);
    if (!entry?.desired) return missingDesiredState(id, "setOcclusionRects");
    entry.desired = { ...entry.desired, occlusions: [...rects] };
    return this.requestReconcile(entry);
  }

  navigate(id: string, url: string): Promise<void> {
    const entry = this.surfaces.get(id);
    if (!entry?.desired) return missingDesiredState(id, "navigate");
    entry.desired = {
      ...entry.desired,
      request: { ...entry.desired.request, url },
    };
    return this.requestReconcile(entry);
  }

  async reload(id: string): Promise<void> {
    const entry = this.surfaces.get(id);
    if (!entry?.desired) return missingDesiredState(id, "reloadSurface");
    await this.requestReconcile(entry);
    const revision = entry.revision;
    await this.runEntryCommand(
      entry,
      revision,
      `reloadSurface(${id})`,
      () =>
        this.getNativeManager()
          .reloadSurface({ ...this.identity, id })
          .then(() => true),
      () => false,
    );
  }

  async back(id: string): Promise<void> {
    const entry = this.surfaces.get(id);
    if (!entry?.desired) return missingDesiredState(id, "goBack");
    const generation = entry.desired.generation;
    await this.requestReconcile(entry);
    if (entry.desired?.generation !== generation)
      return missingDesiredState(id, "goBack");
    // A history step is not idempotent: a lost acknowledgement must not cause
    // the reconciler to navigate a second page back automatically.
    await this.getNativeManager().goBack({ ...this.identity, id });
  }

  async readPage(id: string, selector?: string): Promise<NativePageRead> {
    const entry = this.surfaces.get(id);
    if (!entry?.desired) return missingDesiredState(id, "readPage");
    const generation = entry.desired.generation;
    await this.requestReconcile(entry);
    if (entry.desired?.generation !== generation)
      return missingDesiredState(id, "readPage");
    const result = await this.getNativeManager().readPage({
      ...this.identity,
      id,
      ...(selector === undefined ? {} : { selector }),
    });
    if (entry.desired?.generation !== generation)
      return missingDesiredState(id, "readPage");
    if (
      !isRecord(result) ||
      typeof result.url !== "string" ||
      typeof result.title !== "string" ||
      typeof result.text !== "string" ||
      result.truncated !== false
    ) {
      throw new Error("Native Browser returned an invalid page read.");
    }
    return {
      url: result.url,
      title: result.title,
      text: result.text,
      truncated: result.truncated,
    };
  }

  async subscribeNavigation(
    listener: (event: {
      id: string;
      url: string;
      previousUrl: string | undefined;
    }) => void,
    onError: (error: unknown) => void,
  ): Promise<() => Promise<void>> {
    let active = true;
    const observations = new WeakMap<SurfaceCommandState, number>();
    const observe = async (value: unknown): Promise<void> => {
      if (!active || !isRecord(value) || typeof value.id !== "string") return;
      if (
        value.owner !== this.identity.owner ||
        value.session !== this.identity.session ||
        value.epoch !== this.identity.epoch
      )
        return;
      const entry = this.surfaces.get(value.id);
      if (!entry?.desired) return;
      const observation = (observations.get(entry) ?? 0) + 1;
      observations.set(entry, observation);
      if (entry.running) {
        await new Promise<void>((resolve, reject) => {
          entry.waiters.push({ revision: entry.revision, resolve, reject });
        });
      }
      const revision = entry.revision;
      const previousUrl = entry.desired?.request.url;
      // The event is only an invalidation, not a trusted URL snapshot. Read
      // after queued native commands and discard results superseded locally.
      const observed = await this.readStateOnce(entry.id);
      if (
        !active ||
        !entry.desired ||
        entry.revision !== revision ||
        observations.get(entry) !== observation
      )
        return;
      if (!observed.ok) throw observed.error;
      if (
        !observed.state.exists ||
        !ownerMatches(observed.state, this.identity)
      )
        return;
      const url = observed.state.currentUrl;
      if (!url) return;
      entry.desired = {
        ...entry.desired,
        request: { ...entry.desired.request, url },
      };
      this.recordActual(entry, observed.state);
      listener({ id: entry.id, url, previousUrl });
    };
    const handle = await this.getNativeManager().addListener(
      "navigationChanged",
      (value) => {
        // error-policy:J1 the owning React hook renders native observation errors.
        void observe(value).catch(onError);
      },
    );
    try {
      await Promise.all(
        [...this.surfaces.keys()].map((id) =>
          observe({ ...this.identity, id }),
        ),
      );
    } catch (error) {
      // error-policy:J2 failed subscription setup releases its listener before
      // propagating the state-read failure to the caller's retry boundary.
      active = false;
      await handle.remove();
      throw error;
    }
    return async () => {
      active = false;
      await handle.remove();
    };
  }

  presentSurface(id: string | null): Promise<void> {
    const target = id === null ? null : this.surfaces.get(id);
    if (id !== null && !target?.desired) {
      return missingDesiredState(id, "presentSurface");
    }
    this.desiredPresentedId = id;
    const revision = ++this.presentationRevision;
    const targetReady = target
      ? this.requestReconcile(target)
      : Promise.resolve();
    const result = this.enqueuePresentation(async () => {
      await targetReady;
      if (
        revision !== this.presentationRevision ||
        id !== this.desiredPresentedId
      ) {
        return;
      }
      await this.ensureOwnerReady();
      await this.reconcilePresentation(id, revision);
    });
    // error-policy:J1 native presentation boundary translates the terminal
    // transport failure into the hook's typed, user-retryable unavailable state.
    return result.then(
      () => this.clearReportedFailures(id),
      (error: unknown) => {
        const generation = target?.desired?.generation ?? 0;
        const failure = asUnavailableError(error, {
          surfaceId: id,
          generation,
          operation: `presentSurface(${id ?? "host"})`,
          revision,
        });
        this.reportOnce(failure);
        return Promise.reject(failure);
      },
    );
  }

  destroySurface(id: string): Promise<void> {
    const entry = this.getOrCreateEntry(id);
    const hide =
      this.desiredPresentedId === id
        ? this.presentSurface(null)
        : Promise.resolve();
    entry.retiredGeneration = entry.desired?.generation ?? entry.nextGeneration;
    entry.desired = null;
    entry.nextGeneration += 1;
    const destroy = this.requestReconcile(entry);
    return Promise.all([hide, destroy]).then(() => undefined);
  }

  hasSurface(id: string): boolean {
    return this.surfaces.get(id)?.actual?.exists === true;
  }

  private getOrCreateEntry(id: string): SurfaceCommandState {
    const existing = this.surfaces.get(id);
    if (existing) return existing;
    const entry: SurfaceCommandState = {
      id,
      desired: null,
      actual: null,
      nextGeneration: 0,
      retiredGeneration: null,
      revision: 0,
      running: false,
      waiters: [],
      lastBoundsKey: null,
      lastOcclusionKey: null,
    };
    this.surfaces.set(id, entry);
    return entry;
  }

  private requestReconcile(entry: SurfaceCommandState): Promise<void> {
    entry.revision += 1;
    const revision = entry.revision;
    const request = new Promise<void>((resolve, reject) => {
      entry.waiters.push({ revision, resolve, reject });
    });
    this.schedule(entry);
    return request;
  }

  private schedule(entry: SurfaceCommandState): void {
    if (entry.running) return;
    entry.running = true;
    Promise.resolve()
      .then(() => this.reconcile(entry))
      .then(
        (revision) => this.resolveWaiters(entry, revision),
        (error) => {
          const generation = entry.desired?.generation ?? entry.nextGeneration;
          const failure = asUnavailableError(error, {
            surfaceId: entry.id,
            generation,
            operation: "native surface reconciliation",
            revision: entry.revision,
          });
          this.reportOnce(failure);
          this.rejectWaiters(entry, failure.revision, failure);
        },
      )
      .then(() => {
        entry.running = false;
        if (entry.waiters.length > 0) {
          this.schedule(entry);
          return;
        }
        if (
          entry.desired === null &&
          entry.actual?.exists === false &&
          this.surfaces.get(entry.id) === entry
        ) {
          this.surfaces.delete(entry.id);
        }
      });
  }

  private async reconcile(entry: SurfaceCommandState): Promise<number> {
    while (true) {
      const revision = entry.revision;
      const desired = entry.desired;
      try {
        await this.ensureOwnerReady();
        if (entry.actual === null) {
          const observed = await this.readActual(entry, revision);
          if (!observed) continue;
        }
        if (desired === null) {
          if (entry.actual?.exists) {
            await this.ensureDestroyed(entry, revision);
            continue;
          }
        } else {
          if (
            entry.actual?.exists &&
            !ownerMatches(entry.actual, this.identity)
          ) {
            this.ownerReady = null;
            await this.ensureOwnerReady();
            entry.actual = null;
            continue;
          }
          if (
            entry.actual?.exists &&
            entry.retiredGeneration !== null &&
            desired.generation > entry.retiredGeneration
          ) {
            await this.ensureDestroyed(entry, revision);
            continue;
          }
          if (
            entry.actual?.exists &&
            !policyMatches(entry.actual, desired.request)
          ) {
            await this.ensureDestroyed(entry, revision);
            continue;
          }
          if (!entry.actual?.exists) {
            await this.ensureCreated(entry, desired, revision);
            continue;
          }
          const desiredUrl = desired.request.url;
          if (
            desiredUrl &&
            !urlsEquivalent(entry.actual.currentUrl, desiredUrl)
          ) {
            await this.ensureNavigated(entry, desiredUrl, revision);
            continue;
          }
          if (desired.bounds) {
            const key = JSON.stringify(desired.bounds);
            if (entry.lastBoundsKey !== key) {
              await this.ensureBounds(entry, desired.bounds, key, revision);
              continue;
            }
          }
          const occlusionKey = JSON.stringify(desired.occlusions);
          if (entry.lastOcclusionKey !== occlusionKey) {
            await this.ensureOcclusions(
              entry,
              desired.occlusions,
              occlusionKey,
              revision,
            );
            continue;
          }
        }
      } catch (error) {
        // error-policy:J2 preserve the command-specific typed cause while
        // attaching the surface generation/revision reconciliation context.
        if (entry.revision !== revision) continue;
        throw asUnavailableError(error, {
          surfaceId: entry.id,
          generation: desired?.generation ?? entry.nextGeneration,
          operation: "native surface reconciliation",
          revision,
        });
      }
      if (entry.revision !== revision) continue;
      return revision;
    }
  }

  private async ensureOwnerReady(): Promise<void> {
    if (this.ownerReady) return this.ownerReady;
    const desiredIds = [...this.surfaces.values()]
      .filter((entry) => entry.desired !== null)
      .map((entry) => entry.id);
    const request = retryCommand(() =>
      this.getNativeManager().reconcileOwner({
        ...this.identity,
        desiredIds,
      }),
    );
    // error-policy:J2 reset the rejected owner handshake before rethrowing so
    // an explicit user Retry can establish a fresh native renderer session.
    this.ownerReady = request.catch((error: unknown) => {
      this.ownerReady = null;
      throw error;
    });
    return this.ownerReady;
  }

  private async readActual(
    entry: SurfaceCommandState,
    revision: number,
  ): Promise<boolean> {
    let lastError: unknown = new Error("native state unavailable");
    for (let attempt = 0; attempt < MAX_COMMAND_ATTEMPTS; attempt += 1) {
      if (entry.revision !== revision) return false;
      const observed = await this.readStateOnce(entry.id);
      if (observed.ok) {
        this.recordActual(entry, observed.state);
        return true;
      }
      lastError = observed.error;
    }
    throw new NativeSurfaceUnavailableError({
      surfaceId: entry.id,
      generation: entry.desired?.generation ?? entry.nextGeneration,
      operation: `getSurfaceState(${entry.id})`,
      revision,
      cause: lastError,
    });
  }

  private async ensureCreated(
    entry: SurfaceCommandState,
    desired: DesiredSurfaceState,
    revision: number,
  ): Promise<void> {
    const outcome = await this.runEntryCommand(
      entry,
      revision,
      `createSurface(${entry.id})`,
      () =>
        this.getNativeManager()
          .createSurface({
            ...this.identity,
            id: entry.id,
            url: desired.request.url,
            process: desired.request.policy.process,
            storage: desired.request.policy.storage,
          })
          .then(() => true),
      (state) => state.exists && ownerMatches(state, this.identity),
    );
    if (outcome.kind === "acknowledged") {
      this.recordActual(
        entry,
        {
          exists: true,
          foregrounded: false,
          currentUrl: desired.request.url ?? null,
          process: desired.request.policy.process,
          storage: desired.request.policy.storage,
          owner: this.identity.owner,
          session: this.identity.session,
          epoch: this.identity.epoch,
        },
        true,
      );
    }
  }

  private async ensureDestroyed(
    entry: SurfaceCommandState,
    revision: number,
  ): Promise<void> {
    const outcome = await this.runEntryCommand(
      entry,
      revision,
      `destroySurface(${entry.id})`,
      () =>
        this.getNativeManager()
          .destroySurface({ ...this.identity, id: entry.id })
          .then(() => true),
      (state) => !state.exists,
    );
    if (outcome.kind === "acknowledged") {
      this.recordActual(entry, ABSENT_SURFACE_STATE, true);
    }
  }

  private async ensureNavigated(
    entry: SurfaceCommandState,
    url: string,
    revision: number,
  ): Promise<void> {
    const outcome = await this.runEntryCommand(
      entry,
      revision,
      `navigate(${entry.id})`,
      () =>
        this.getNativeManager()
          .navigate({ ...this.identity, id: entry.id, url })
          .then(() => true),
      (state) => !state.exists || urlsEquivalent(state.currentUrl, url),
    );
    if (outcome.kind === "acknowledged" && entry.actual?.exists) {
      entry.actual = { ...entry.actual, currentUrl: url };
    }
  }

  private async ensureBounds(
    entry: SurfaceCommandState,
    bounds: SurfaceBounds,
    key: string,
    revision: number,
  ): Promise<void> {
    const outcome = await this.runEntryCommand(
      entry,
      revision,
      `setBounds(${entry.id})`,
      () =>
        this.getNativeManager()
          .setBounds({ ...this.identity, id: entry.id, ...bounds })
          .then(() => true),
      (state) => !state.exists,
    );
    if (outcome.kind === "acknowledged") entry.lastBoundsKey = key;
  }

  private async ensureOcclusions(
    entry: SurfaceCommandState,
    rects: readonly SurfaceOcclusionRect[],
    key: string,
    revision: number,
  ): Promise<void> {
    const outcome = await this.runEntryCommand(
      entry,
      revision,
      `setOcclusionRects(${entry.id})`,
      () =>
        this.getNativeManager()
          .setOcclusionRects({ ...this.identity, id: entry.id, rects })
          .then(() => true),
      (state) => !state.exists,
    );
    if (outcome.kind === "acknowledged") entry.lastOcclusionKey = key;
  }

  private async runEntryCommand(
    entry: SurfaceCommandState,
    revision: number,
    operation: string,
    invoke: () => Promise<boolean>,
    acceptObserved: (state: ElizaSurfaceManagerState) => boolean,
  ): Promise<CommandOutcome> {
    let lastError: unknown = new Error(`${operation} did not settle`);
    for (let attempt = 0; attempt < MAX_COMMAND_ATTEMPTS; attempt += 1) {
      if (entry.revision !== revision) return SUPERSEDED_OUTCOME;
      const result = await Promise.resolve()
        .then(invoke)
        .then(
          (executed) => ({ ok: true as const, executed }),
          (error) => ({ ok: false as const, error }),
        );
      if (result.ok) {
        return result.executed ? ACKNOWLEDGED_OUTCOME : SUPERSEDED_OUTCOME;
      }
      lastError = result.error;
      if (entry.revision !== revision) return SUPERSEDED_OUTCOME;
      const observed = await this.readStateOnce(entry.id);
      if (observed.ok) {
        this.recordActual(entry, observed.state);
        if (acceptObserved(observed.state)) return OBSERVED_OUTCOME;
      } else {
        lastError = observed.error;
      }
    }
    throw new NativeSurfaceUnavailableError({
      surfaceId: entry.id,
      generation: entry.desired?.generation ?? entry.nextGeneration,
      operation,
      revision,
      cause: lastError,
    });
  }

  private async reconcilePresentation(
    id: string | null,
    revision: number,
  ): Promise<void> {
    let lastError: unknown = new Error("native presentation did not settle");
    for (let attempt = 0; attempt < MAX_COMMAND_ATTEMPTS; attempt += 1) {
      if (
        revision !== this.presentationRevision ||
        id !== this.desiredPresentedId
      ) {
        return;
      }
      const result = await this.getNativeManager()
        .presentSurface({ ...this.identity, id })
        .then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, error }),
        );
      if (result.ok) {
        this.recordPresentation(id);
        return;
      }
      lastError = result.error;
      const observed = await this.readAllStates();
      if (observed.ok) {
        this.recordAllActual(observed.states);
        if (presentationMatches(observed.states, id)) return;
        if (id !== null) {
          const target = this.surfaces.get(id);
          if (target?.desired && !target.actual?.exists) {
            await this.requestReconcile(target);
          }
        }
      } else {
        lastError = observed.error;
      }
    }
    const target = id === null ? null : this.surfaces.get(id);
    throw new NativeSurfaceUnavailableError({
      surfaceId: id,
      generation: target?.desired?.generation ?? 0,
      operation: `presentSurface(${id ?? "host"})`,
      revision,
      cause: lastError,
    });
  }

  private readStateOnce(id: string): Promise<StateReadResult> {
    return Promise.resolve()
      .then(() =>
        this.getNativeManager().getSurfaceState({ ...this.identity, id }),
      )
      .then((value) => validateSurfaceState(value))
      .then(
        (state) => ({ ok: true, state }) as const,
        (error) => ({ ok: false, error }) as const,
      );
  }

  private readAllStates(): Promise<StateListReadResult> {
    return Promise.resolve()
      .then(() => this.getNativeManager().listSurfaceStates(this.identity))
      .then((value) => validateSurfaceStates(value))
      .then(
        (states) => ({ ok: true, states }) as const,
        (error) => ({ ok: false, error }) as const,
      );
  }

  private recordActual(
    entry: SurfaceCommandState,
    state: ElizaSurfaceManagerState,
    forceIdentityReset = false,
  ): void {
    const previous = entry.actual;
    if (
      forceIdentityReset ||
      previous === null ||
      previous.exists !== state.exists ||
      previous.process !== state.process ||
      previous.storage !== state.storage ||
      previous.owner !== state.owner ||
      previous.session !== state.session ||
      previous.epoch !== state.epoch
    ) {
      entry.lastBoundsKey = null;
      entry.lastOcclusionKey = null;
    }
    entry.actual = state;
    if (!state.exists) entry.retiredGeneration = null;
  }

  private recordAllActual(states: readonly SurfaceStateWithId[]): void {
    const byId = new Map(states.map((state) => [state.id, state]));
    for (const entry of this.surfaces.values()) {
      this.recordActual(entry, byId.get(entry.id) ?? ABSENT_SURFACE_STATE);
    }
  }

  private recordPresentation(id: string | null): void {
    for (const entry of this.surfaces.values()) {
      if (entry.actual?.exists) {
        entry.actual = { ...entry.actual, foregrounded: entry.id === id };
      }
    }
  }

  private resolveWaiters(entry: SurfaceCommandState, revision: number): void {
    this.clearReportedFailures(entry.id);
    const settled = entry.waiters.filter(
      (waiter) => waiter.revision <= revision,
    );
    entry.waiters = entry.waiters.filter(
      (waiter) => waiter.revision > revision,
    );
    for (const waiter of settled) waiter.resolve();
  }

  private rejectWaiters(
    entry: SurfaceCommandState,
    revision: number,
    error: unknown,
  ): void {
    const settled = entry.waiters.filter(
      (waiter) => waiter.revision <= revision,
    );
    entry.waiters = entry.waiters.filter(
      (waiter) => waiter.revision > revision,
    );
    for (const waiter of settled) waiter.reject(error);
  }

  private enqueuePresentation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.presentationTail.then(operation);
    this.presentationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private reportOnce(error: NativeSurfaceUnavailableError): void {
    const key = `${error.surfaceId ?? "host"}:${error.generation}:${error.operation}`;
    if (this.reportedFailures.has(key)) return;
    this.reportedFailures.add(key);
    report(error.operation, error);
  }

  private clearReportedFailures(surfaceId: string | null): void {
    const prefix = `${surfaceId ?? "host"}:`;
    for (const key of this.reportedFailures) {
      if (key.startsWith(prefix)) this.reportedFailures.delete(key);
    }
  }
}

const MAX_COMMAND_ATTEMPTS = 3;

interface DesiredSurfaceState {
  readonly request: NativeSurfaceCreateRequest;
  readonly bounds: SurfaceBounds | null;
  readonly occlusions: readonly SurfaceOcclusionRect[];
  readonly generation: number;
}

interface SurfaceCommandState {
  readonly id: string;
  desired: DesiredSurfaceState | null;
  actual: ElizaSurfaceManagerState | null;
  nextGeneration: number;
  retiredGeneration: number | null;
  revision: number;
  running: boolean;
  waiters: SurfaceWaiter[];
  lastBoundsKey: string | null;
  lastOcclusionKey: string | null;
}

interface SurfaceWaiter {
  readonly revision: number;
  resolve(): void;
  reject(error: unknown): void;
}

type CommandOutcome =
  | typeof ACKNOWLEDGED_OUTCOME
  | typeof OBSERVED_OUTCOME
  | typeof SUPERSEDED_OUTCOME;

type StateReadResult =
  | { readonly ok: true; readonly state: ElizaSurfaceManagerState }
  | { readonly ok: false; readonly error: unknown };

type StateListReadResult =
  | { readonly ok: true; readonly states: readonly SurfaceStateWithId[] }
  | { readonly ok: false; readonly error: unknown };

interface SurfaceStateWithId extends ElizaSurfaceManagerState {
  readonly id: string;
}

const ACKNOWLEDGED_OUTCOME = { kind: "acknowledged" } as const;
const OBSERVED_OUTCOME = { kind: "observed" } as const;
const SUPERSEDED_OUTCOME = { kind: "superseded" } as const;
const ABSENT_SURFACE_STATE: ElizaSurfaceManagerState = {
  exists: false,
  foregrounded: false,
  currentUrl: null,
  process: null,
  storage: null,
  owner: null,
  session: null,
  epoch: null,
};

function asUnavailableError(
  error: unknown,
  context: Omit<
    ConstructorParameters<typeof NativeSurfaceUnavailableError>[0],
    "cause"
  >,
): NativeSurfaceUnavailableError {
  return error instanceof NativeSurfaceUnavailableError
    ? error
    : new NativeSurfaceUnavailableError({ ...context, cause: error });
}

function missingDesiredState(id: string, operation: string): Promise<never> {
  return Promise.reject(
    new NativeSurfaceUnavailableError({
      surfaceId: id,
      generation: 0,
      operation,
      revision: 0,
      cause: new Error(`${operation} requires desired native surface ${id}`),
    }),
  );
}

function ownerMatches(
  state: ElizaSurfaceManagerState,
  identity: NativeSurfaceOwnerIdentity,
): boolean {
  return (
    state.owner === identity.owner &&
    state.session === identity.session &&
    state.epoch === identity.epoch
  );
}

function policyMatches(
  state: ElizaSurfaceManagerState,
  request: NativeSurfaceCreateRequest,
): boolean {
  return (
    state.process === request.policy.process &&
    state.storage === request.policy.storage
  );
}

function urlsEquivalent(left: string | null, right: string): boolean {
  if (left === null) return false;
  if (left === right) return true;
  try {
    // Android WebView 113 (LP3) predates URL.canParse(). Constructing the URLs
    // supplies the same validation + normalization without requiring a newer
    // JavaScript runtime.
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}

function retryCommand(invoke: () => Promise<void>): Promise<void> {
  const attempt = (attemptNumber: number): Promise<void> =>
    Promise.resolve()
      .then(invoke)
      // error-policy:J2 bounded native transport retry rethrows the final cause
      // to the typed outer reconciliation boundary.
      .catch((error: unknown) => {
        if (attemptNumber < MAX_COMMAND_ATTEMPTS) {
          return attempt(attemptNumber + 1);
        }
        throw error;
      });
  return attempt(1);
}

function validateSurfaceState(value: unknown): ElizaSurfaceManagerState {
  if (!isRecord(value))
    throw new Error("native surface state must be an object");
  if (typeof value.exists !== "boolean") {
    throw new Error("native surface state exists must be boolean");
  }
  if (typeof value.foregrounded !== "boolean") {
    throw new Error("native surface state foregrounded must be boolean");
  }
  const state: ElizaSurfaceManagerState = {
    exists: value.exists,
    foregrounded: value.foregrounded,
    currentUrl: nullableString(value.currentUrl, "currentUrl"),
    process: sharingValue(value.process, "process"),
    storage: sharingValue(value.storage, "storage"),
    owner: nullableString(value.owner, "owner"),
    session: nullableString(value.session, "session"),
    epoch: nullableSafeInteger(value.epoch, "epoch"),
  };
  if (
    state.exists &&
    (state.process === null ||
      state.storage === null ||
      state.owner === null ||
      state.session === null ||
      state.epoch === null)
  ) {
    throw new Error(
      "existing native surface state requires identity and policy",
    );
  }
  return state;
}

function validateSurfaceStates(value: unknown): readonly SurfaceStateWithId[] {
  if (!isRecord(value) || !Array.isArray(value.surfaces)) {
    throw new Error("native surface state list requires a surfaces array");
  }
  return value.surfaces.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string") {
      throw new Error("native surface list item requires an id");
    }
    return { id: item.id, ...validateSurfaceState(item) };
  });
}

function presentationMatches(
  states: readonly SurfaceStateWithId[],
  id: string | null,
): boolean {
  if (id === null) return states.every((state) => !state.foregrounded);
  const target = states.find((state) => state.id === id);
  return (
    target?.exists === true &&
    target.foregrounded &&
    states.every((state) => state.id === id || !state.foregrounded)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new Error(`native surface state ${field} must be string|null`);
}

function sharingValue(
  value: unknown,
  field: string,
): "isolated" | "shared" | null {
  if (value === null || value === "isolated" || value === "shared")
    return value;
  throw new Error(`native surface state ${field} must be isolated|shared|null`);
}

function nullableSafeInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  throw new Error(
    `native surface state ${field} must be a positive safe integer|null`,
  );
}
