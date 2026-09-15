/** Real PGlite tests for destination review races, durable pause state and pending-event preservation. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { CalendarService } from "./CalendarService.js";
import type { CalendarHostGate } from "./gate.js";
import { LinkedCalendarControlRepository } from "./linked-calendar-control.js";
import { LinkedCalendarRepository } from "./linked-calendar-sync.js";
import {
  ensureLinkedCalendarControlTable,
  ensureLinkedCalendarEventTable,
} from "./migration.js";

const databases: PGlite[] = [];
const directories: string[] = [];
const destination = {
  connectorAccountId: "test-account",
  providerCalendarId: "disposable-calendar",
};

async function harness(dataDir?: string) {
  const pg = new PGlite(dataDir);
  databases.push(pg);
  await pg.exec("CREATE SCHEMA IF NOT EXISTS app_calendar");
  const execute = async (statement: string) =>
    (await pg.query<Record<string, unknown>>(statement)).rows;
  await ensureLinkedCalendarControlTable(execute);
  await ensureLinkedCalendarEventTable(execute);
  const runtime = (agentId = "owner-a") =>
    ({ agentId, adapter: { db: drizzle(pg) } }) as unknown as IAgentRuntime;
  return {
    pg,
    runtime,
    controls: () => new LinkedCalendarControlRepository(runtime()),
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((pg) => pg.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("durable linked calendar review", { timeout: 30_000 }, () => {
  async function mappingFixture() {
    const h = await harness();
    const links = new LinkedCalendarRepository(h.runtime());
    const created = await links.create({
      agentId: h.runtime().agentId,
      localEventId: "reviewed-local-event",
      connectorAccountId: "old-account",
      providerCalendarId: "old-calendar",
      localRevision: 3,
    });
    const previous = await links.save(created, {
      state: "clean",
      pendingOperation: null,
      providerEventId: "original-provider-event",
      providerEtag: "old-etag",
      lastCommonSemanticHash: "old-common",
    });
    const initial = await h.controls().read();
    const control = await h
      .controls()
      .selectDestination(initial.revision, destination);
    const request = {
      linkId: previous.id,
      expectedUpdatedAt: previous.updatedAt,
      expectedLocalRevision: previous.localRevision,
      expectedControlRevision: control.revision,
      ...destination,
      operationKey: "reviewed-rebind",
    };
    return { h, links, previous, control, request };
  }

  it("requires retention confirmation and a connected writable destination through the service", async () => {
    const { h, links, previous, control, request } = await mappingFixture();
    const service = new CalendarService(h.runtime());
    service.setGate({
      getGoogleConnectorAccounts: async () => [],
    } as unknown as CalendarHostGate);
    const input = {
      ...request,
      idempotencyKey: request.operationKey,
      retainPreviousProviderEvent: true as const,
    };
    const unconfirmed = { ...input };
    Reflect.deleteProperty(unconfirmed, "retainPreviousProviderEvent");
    await expect(
      service.executeLinkedCalendarRebind(
        new URL("http://localhost"),
        previous.id,
        unconfirmed,
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "LINKED_CALENDAR_RETENTION_REQUIRED",
    });
    await expect(
      service.executeLinkedCalendarRebind(
        new URL("http://localhost"),
        previous.id,
        input,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "LINKED_CALENDAR_DESTINATION_UNAVAILABLE",
    });
    expect(await links.getById(h.runtime().agentId, previous.id)).toEqual(
      previous,
    );
    expect(await h.controls().read()).toEqual(control);
  });

  it("retains the local event and provider identity without scheduling another provider write", async () => {
    const { h, links, previous, control, request } = await mappingFixture();
    const result = await links.retainLocalWhilePaused(request);
    expect(result.previous).toEqual(previous);
    expect(result.link).toMatchObject({
      localEventId: previous.localEventId,
      localRevision: previous.localRevision,
      connectorAccountId: previous.connectorAccountId,
      providerCalendarId: previous.providerCalendarId,
      providerEventId: previous.providerEventId,
      providerEtag: previous.providerEtag,
      state: "local_only",
      pendingOperation: null,
    });
    expect(result.controlRevision).toBe(control.revision + 1);
    const reopened = new LinkedCalendarRepository(h.runtime());
    expect(await reopened.retainLocalWhilePaused(request)).toEqual({
      ...result,
      replayed: true,
    });
    await expect(reopened.rebindWhilePaused(request)).rejects.toMatchObject({
      code: "LINKED_CALENDAR_REBIND_CONFLICT",
    });
    expect(await reopened.getById(h.runtime().agentId, previous.id)).toEqual(
      result.link,
    );
    await h.controls().pause(result.controlRevision);
    await expect(
      reopened.retainLocalWhilePaused(request),
    ).rejects.toMatchObject({ code: "LINKED_CALENDAR_REBIND_CONFLICT" });
  });

  it("keeps retained items local after edits, deletion intent and account disconnect, but permits explicit relinking", async () => {
    const { h, links, request } = await mappingFixture();
    const retained = await links.retainLocalWhilePaused(request);
    for (const operation of ["update", "delete"] as const) {
      const changed = await links.markLocalDirty({
        agentId: h.runtime().agentId,
        localEventId: retained.link.localEventId,
        localRevision: retained.link.localRevision + 1,
        operation,
      });
      expect(changed).toMatchObject({
        state: "local_only",
        pendingOperation: null,
      });
    }
    await links.pauseAccount(
      h.runtime().agentId,
      retained.link.connectorAccountId,
    );
    const reopened = new LinkedCalendarRepository(h.runtime());
    expect(
      await reopened.getById(h.runtime().agentId, retained.link.id),
    ).toMatchObject({ state: "local_only", pendingOperation: null });
    await h.controls().resume(retained.controlRevision);
    const service = new CalendarService(h.runtime());
    const current = await reopened.getById(
      h.runtime().agentId,
      retained.link.id,
    );
    if (!current) throw new Error("Retained link disappeared");
    expect(
      await service.executeLinkedCalendarReconciliation(current.id, {
        expectedUpdatedAt: current.updatedAt,
        idempotencyKey: "retained-service-reconcile",
      }),
    ).toMatchObject({
      outcome: "paused",
      link: { state: "local_only", pendingOperation: null },
    });
    const relinked = await reopened.create({
      agentId: h.runtime().agentId,
      localEventId: retained.link.localEventId,
      connectorAccountId: retained.link.connectorAccountId,
      providerCalendarId: retained.link.providerCalendarId,
      localRevision: retained.link.localRevision + 2,
    });
    expect(relinked).toMatchObject({
      state: "dirty",
      pendingOperation: "update",
      providerEventId: retained.link.providerEventId,
    });
  });

  it("upgrades the existing state constraint without losing links and rejects invalid states", async () => {
    const { h, links, previous, request } = await mappingFixture();
    await h.pg.exec(
      "ALTER TABLE app_calendar.linked_calendar_events DROP CONSTRAINT linked_calendar_events_state_valid, ADD CONSTRAINT linked_calendar_events_state_valid CHECK (state IN ('clean', 'dirty', 'conflicted', 'quarantined', 'paused'))",
    );
    const execute = async (statement: string) =>
      (await h.pg.query<Record<string, unknown>>(statement)).rows;
    await ensureLinkedCalendarEventTable(execute);
    await ensureLinkedCalendarEventTable(execute);
    expect(await links.getById(h.runtime().agentId, previous.id)).toEqual(
      previous,
    );
    expect((await links.retainLocalWhilePaused(request)).link.state).toBe(
      "local_only",
    );
    await expect(
      h.pg.exec(
        "UPDATE app_calendar.linked_calendar_events SET state = 'invalid_state'",
      ),
    ).rejects.toThrow();
  });

  it("rolls back a retain-local decision when its receipt cannot commit", async () => {
    const { h, links, previous, control, request } = await mappingFixture();
    await h.pg.exec(
      "ALTER TABLE app_calendar.linked_calendar_control_mutations ADD CONSTRAINT reject_retain CHECK (operation_key <> 'reviewed-rebind')",
    );
    await expect(links.retainLocalWhilePaused(request)).rejects.toThrow();
    expect(await links.getById(h.runtime().agentId, previous.id)).toEqual(
      previous,
    );
    expect(await h.controls().read()).toEqual(control);
    await h.pg.exec(
      "ALTER TABLE app_calendar.linked_calendar_control_mutations DROP CONSTRAINT reject_retain",
    );
    expect((await links.retainLocalWhilePaused(request)).link.state).toBe(
      "local_only",
    );
  });

  it("refuses retain-local with an unresolved provider dispatch or stale event review", async () => {
    const { h, links, previous, control, request } = await mappingFixture();
    await expect(
      links.retainLocalWhilePaused({
        ...request,
        expectedLocalRevision: previous.localRevision + 1,
      }),
    ).rejects.toMatchObject({ code: "LINKED_CALENDAR_REBIND_CONFLICT" });
    const active = await h.controls().resume(control.revision);
    await h
      .controls()
      .acquireDispatch(active.revision, previous.id, destination);
    const paused = await h.controls().pause(active.revision);
    await expect(
      links.retainLocalWhilePaused({
        ...request,
        expectedControlRevision: paused.revision,
      }),
    ).rejects.toMatchObject({ code: "LINKED_CALENDAR_REBIND_CONFLICT" });
    expect(await links.getById(h.runtime().agentId, previous.id)).toEqual(
      previous,
    );
    expect(await h.controls().read()).toEqual(paused);
  });

  it("rebinds under pause and preserves the old mapping in a durable replay receipt", async () => {
    const { h, links, previous, control, request } = await mappingFixture();
    const result = await links.rebindWhilePaused(request);
    expect(result.previous).toEqual(previous);
    expect(result.link).toMatchObject({
      localEventId: previous.localEventId,
      localRevision: previous.localRevision,
      ...destination,
      providerEventId: null,
      providerEtag: null,
      lastCommonSemanticHash: null,
      state: "dirty",
      pendingOperation: "create",
    });
    expect(result.link.idempotencyKey).not.toBe(previous.idempotencyKey);
    expect(result.controlRevision).toBe(control.revision + 1);
    expect((await h.controls().read()).paused).toBe(true);
    const reopened = new LinkedCalendarRepository(h.runtime());
    expect(await reopened.rebindWhilePaused(request)).toEqual({
      ...result,
      replayed: true,
    });
    expect(await reopened.getById(h.runtime().agentId, previous.id)).toEqual(
      result.link,
    );
    await expect(
      reopened.rebindWhilePaused({
        ...request,
        providerCalendarId: "unreviewed-calendar",
      }),
    ).rejects.toMatchObject({ code: "LINKED_CALENDAR_REBIND_CONFLICT" });
    await h.controls().pause(result.controlRevision);
    await expect(reopened.rebindWhilePaused(request)).rejects.toMatchObject({
      code: "LINKED_CALENDAR_REBIND_CONFLICT",
    });
  });

  it("does not replace a link while a provider dispatch is unresolved", async () => {
    const { h, links, previous, control, request } = await mappingFixture();
    const active = await h.controls().resume(control.revision);
    await h
      .controls()
      .acquireDispatch(active.revision, "pending-link", destination);
    const paused = await h.controls().pause(active.revision);
    await expect(
      links.rebindWhilePaused({
        ...request,
        expectedControlRevision: paused.revision,
      }),
    ).rejects.toMatchObject({ code: "LINKED_CALENDAR_REBIND_CONFLICT" });
    expect(await links.getById(h.runtime().agentId, previous.id)).toEqual(
      previous,
    );
    expect(await h.controls().read()).toEqual(paused);
  });

  it("rolls back both mapping and control revision if receipt persistence fails, then retries", async () => {
    const { h, links, previous, control, request } = await mappingFixture();
    await h.pg.exec(
      "ALTER TABLE app_calendar.linked_calendar_control_mutations ADD CONSTRAINT reject_rebind_receipt CHECK (operation_key <> 'reviewed-rebind')",
    );
    await expect(links.rebindWhilePaused(request)).rejects.toThrow();
    expect(await links.getById(h.runtime().agentId, previous.id)).toEqual(
      previous,
    );
    expect(await h.controls().read()).toEqual(control);
    await h.pg.exec(
      "ALTER TABLE app_calendar.linked_calendar_control_mutations DROP CONSTRAINT reject_rebind_receipt",
    );
    expect(
      (await links.rebindWhilePaused(request)).link.providerCalendarId,
    ).toBe(destination.providerCalendarId);
  });

  it.each(["rebindWhilePaused", "retainLocalWhilePaused"] as const)(
    "%s rejects another agent's link and unknown delivery without rewriting either",
    async (operation) => {
      const { h, links, previous, request } = await mappingFixture();
      const otherRuntime = h.runtime("owner-b");
      const otherControls = new LinkedCalendarControlRepository(otherRuntime);
      const otherInitial = await otherControls.read();
      const otherControl = await otherControls.selectDestination(
        otherInitial.revision,
        destination,
      );
      await expect(
        new LinkedCalendarRepository(otherRuntime)[operation]({
          ...request,
          expectedControlRevision: otherControl.revision,
        }),
      ).rejects.toMatchObject({ code: "LINKED_CALENDAR_REBIND_CONFLICT" });
      expect(await otherControls.read()).toEqual(otherControl);
      const quarantined = await links.save(previous, {
        state: "quarantined",
        lastErrorCode: "UNKNOWN_DELIVERY",
        lastErrorMessage: "Synthetic unknown provider result",
      });
      await expect(
        links[operation]({
          ...request,
          expectedUpdatedAt: quarantined.updatedAt,
        }),
      ).rejects.toMatchObject({ code: "LINKED_CALENDAR_REBIND_CONFLICT" });
      expect(await links.getById(h.runtime().agentId, previous.id)).toEqual(
        quarantined,
      );
    },
  );

  it("returns one durable receipt for concurrent retries and rejects changed request reuse", async () => {
    const h = await harness();
    const first = new CalendarService(h.runtime());
    const second = new CalendarService(h.runtime());
    const request = {
      operation: "pause" as const,
      expectedRevision: 0,
      idempotencyKey: "review-pause",
    };
    const [a, b] = await Promise.all([
      first.executeLinkedCalendarControl(new URL("http://localhost"), request),
      second.executeLinkedCalendarControl(new URL("http://localhost"), request),
    ]);
    expect(a.receipt.id).toBe(b.receipt.id);
    expect(a.receipt.committedAt).toBe(b.receipt.committedAt);
    expect([a.receipt.replayed, b.receipt.replayed].sort()).toEqual([
      false,
      true,
    ]);
    expect((await h.controls().read()).revision).toBe(1);
    const saved = await h.pg.query<{ id: string; committed_at: string }>(
      "SELECT id, committed_at FROM app_calendar.linked_calendar_control_mutations",
    );
    expect(saved.rows).toEqual([
      { id: a.receipt.id, committed_at: a.receipt.committedAt },
    ]);
    await expect(
      first.executeLinkedCalendarControl(new URL("http://localhost"), {
        ...request,
        operation: "select",
        destination: null,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "LINKED_CALENDAR_OPERATION_KEY_CONFLICT",
    });
    expect((await h.controls().read()).revision).toBe(1);
  });

  it("rolls back the control change if its receipt cannot be persisted", async () => {
    const h = await harness();
    await h.controls().read();
    await h.pg.exec(
      "ALTER TABLE app_calendar.linked_calendar_control_mutations ADD CONSTRAINT reject_test_receipt CHECK (operation_key <> 'reject-receipt')",
    );
    const service = new CalendarService(h.runtime());
    await expect(
      service.executeLinkedCalendarControl(new URL("http://localhost"), {
        operation: "pause",
        expectedRevision: 0,
        idempotencyKey: "reject-receipt",
      }),
    ).rejects.toThrow();
    expect((await h.controls().read()).revision).toBe(0);
    expect(
      (
        await h.pg.query(
          "SELECT id FROM app_calendar.linked_calendar_control_mutations",
        )
      ).rows,
    ).toEqual([]);
  });

  it("replays after restart but refuses to describe a superseded review as current", async () => {
    const directory = await mkdtemp(join(tmpdir(), "calendar-receipt-"));
    directories.push(directory);
    const h = await harness(directory);
    const request = {
      operation: "pause" as const,
      expectedRevision: 0,
      idempotencyKey: "durable-pause",
    };
    const original = await new CalendarService(
      h.runtime(),
    ).executeLinkedCalendarControl(new URL("http://localhost"), request);
    await h.pg.close();
    databases.splice(databases.indexOf(h.pg), 1);
    const reopened = await harness(directory);
    const service = new CalendarService(reopened.runtime());
    const replay = await service.executeLinkedCalendarControl(
      new URL("http://localhost"),
      request,
    );
    expect(replay.receipt).toEqual({ ...original.receipt, replayed: true });
    await service.executeLinkedCalendarControl(new URL("http://localhost"), {
      operation: "select",
      destination: null,
      expectedRevision: replay.revision,
      idempotencyKey: "new-review",
    });
    await expect(
      service.executeLinkedCalendarControl(
        new URL("http://localhost"),
        request,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "LINKED_CALENDAR_OPERATION_SUPERSEDED",
    });
  });

  it("exposes pending work without its receipt and returns a conflict for a blocked owner change", async () => {
    const h = await harness();
    const initial = await h.controls().read();
    const selected = await h
      .controls()
      .selectDestination(initial.revision, destination);
    const active = await h.controls().resume(selected.revision);
    const token = await h
      .controls()
      .acquireDispatch(active.revision, "owner-review-event", destination);
    const service = new CalendarService(h.runtime());
    const paused = await service.executeLinkedCalendarControl(
      new URL("http://localhost"),
      {
        operation: "pause",
        expectedRevision: active.revision,
        idempotencyKey: "pause-owner-review",
      },
    );
    expect(paused.paused).toBe(true);
    expect(paused.pendingDispatch?.linkId).toBe("owner-review-event");
    expect(JSON.stringify(paused)).not.toContain(token);
    await expect(
      service.executeLinkedCalendarControl(new URL("http://localhost"), {
        operation: "select",
        destination: null,
        expectedRevision: paused.revision,
        idempotencyKey: "replace-while-busy",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
    });
    expect((await h.controls().read()).destination).toEqual(destination);
  });

  it("keeps the public reconciliation path paused without initializing a provider", async () => {
    const h = await harness();
    const runtime = {
      ...h.runtime(),
      getService: () => {
        throw new Error("Provider must not be initialized while paused");
      },
    } as unknown as IAgentRuntime;
    const link = await new LinkedCalendarRepository(runtime).create({
      agentId: runtime.agentId,
      localEventId: "paused-event",
      ...destination,
      localRevision: 1,
    });
    const service = new CalendarService(runtime);
    const result = await service.executeLinkedCalendarReconciliation(link.id, {
      expectedUpdatedAt: link.updatedAt,
      idempotencyKey: "paused-review",
    });
    expect(result.outcome).toBe("paused");
    expect(result.link.pendingOperation).toBe("create");
  });

  it("refuses a configured but disconnected destination through the public service path", async () => {
    const h = await harness();
    let observeBootstrap!: (error: unknown) => void;
    const bootstrapFailure = new Promise<unknown>((resolve) => {
      observeBootstrap = resolve;
    });
    const runtime = {
      ...h.runtime(),
      reportError: (_scope: string, error: unknown) => observeBootstrap(error),
    } as unknown as IAgentRuntime;
    const link = await new LinkedCalendarRepository(runtime).create({
      agentId: runtime.agentId,
      localEventId: "disconnected-event",
      ...destination,
      localRevision: 1,
    });
    const initial = await h.controls().read();
    const selected = await h
      .controls()
      .selectDestination(initial.revision, destination);
    await h.controls().resume(selected.revision);
    const service = new CalendarService(runtime);
    service.setGate({
      getGoogleConnectorAccounts: async () => [],
    } as unknown as CalendarHostGate);
    await expect(
      service.executeLinkedCalendarReconciliation(link.id, {
        expectedUpdatedAt: link.updatedAt,
        idempotencyKey: "disconnected-review",
      }),
    ).rejects.toMatchObject({
      code: "LINKED_CALENDAR_DESTINATION_UNAVAILABLE",
    });
    expect(await bootstrapFailure).toMatchObject({
      code: "LINKED_CALENDAR_DESTINATION_UNAVAILABLE",
    });
    expect((await h.controls().read()).dispatch).toBeNull();
    expect(
      (
        await new LinkedCalendarRepository(runtime).getById(
          runtime.agentId,
          link.id,
        )
      )?.pendingOperation,
    ).toBe("create");
  });

  it("rejects resume until a destination is selected and rejects replacement while active", async () => {
    const h = await harness();
    const controls = h.controls();
    const initial = await controls.read();
    expect(initial.destination).toBeNull();
    expect(initial.paused).toBe(true);
    await expect(controls.resume(initial.revision)).rejects.toMatchObject({
      code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
    });
    const reviewed = await controls.selectDestination(
      initial.revision,
      destination,
    );
    expect(reviewed.paused).toBe(true);
    const active = await controls.resume(reviewed.revision);
    expect(active.paused).toBe(false);
    expect((await h.controls().read()).destination).toEqual(destination);
    await expect(
      controls.selectDestination(active.revision, {
        ...destination,
        connectorAccountId: "replacement",
      }),
    ).rejects.toMatchObject({
      code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
    });
  });

  it("retains the paused destination and revision after closing and reopening the database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "calendar-control-"));
    directories.push(directory);
    const h = await harness(directory);
    const initial = await h.controls().read();
    const selected = await h
      .controls()
      .selectDestination(initial.revision, destination);
    const active = await h.controls().resume(selected.revision);
    const token = await h
      .controls()
      .acquireDispatch(active.revision, "pending-event", destination);
    const paused = await h.controls().pause(active.revision);
    await h.pg.close();
    databases.splice(databases.indexOf(h.pg), 1);
    const reopened = await harness(directory);
    expect(await reopened.controls().read()).toEqual(paused);
    await expect(
      reopened.controls().resume(paused.revision),
    ).rejects.toMatchObject({
      code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
    });
    await reopened.controls().settleDispatch(token);
    expect((await reopened.controls().resume(paused.revision)).paused).toBe(
      false,
    );
    await expect(
      reopened.controls().resume(selected.revision),
    ).rejects.toMatchObject({
      code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
    });
  });

  it("blocks new dispatch, destination change and resume until an admitted operation settles", async () => {
    const h = await harness();
    const initial = await h.controls().read();
    const selected = await h
      .controls()
      .selectDestination(initial.revision, destination);
    const active = await h.controls().resume(selected.revision);
    const token = await h
      .controls()
      .acquireDispatch(active.revision, "event-a", destination);
    await expect(
      h.controls().acquireDispatch(active.revision, "event-b", destination),
    ).rejects.toMatchObject({ code: "LINKED_CALENDAR_DISPATCH_REJECTED" });
    const paused = await h.controls().pause(active.revision);
    await expect(
      h.controls().selectDestination(paused.revision, null),
    ).rejects.toMatchObject({
      code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
    });
    await expect(h.controls().resume(paused.revision)).rejects.toMatchObject({
      code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
    });
    await expect(
      h.controls().settleDispatch("unrelated-receipt"),
    ).rejects.toMatchObject({
      code: "LINKED_CALENDAR_DISPATCH_RECEIPT_REJECTED",
    });
    await h.controls().settleDispatch(token);
    await expect(
      h.controls().acquireDispatch(paused.revision, "event-b", destination),
    ).rejects.toMatchObject({ code: "LINKED_CALENDAR_DISPATCH_REJECTED" });
    const resumed = await h.controls().resume(paused.revision);
    await expect(
      h.controls().acquireDispatch(resumed.revision, "event-b", {
        ...destination,
        providerCalendarId: "unselected-calendar",
      }),
    ).rejects.toMatchObject({ code: "LINKED_CALENDAR_DISPATCH_REJECTED" });
    const second = await h
      .controls()
      .acquireDispatch(resumed.revision, "event-b", destination);
    await h.controls().settleDispatch(second);
  });

  it("settles recovery only against the paused revision and invalidates old resume reviews", async () => {
    const h = await harness();
    const initial = await h.controls().read();
    const selected = await h
      .controls()
      .selectDestination(initial.revision, destination);
    const active = await h.controls().resume(selected.revision);
    const token = await h
      .controls()
      .acquireDispatch(active.revision, "recover-event", destination);
    await expect(
      h.controls().settleDispatch(token, active.revision),
    ).rejects.toMatchObject({
      code: "LINKED_CALENDAR_DISPATCH_RECEIPT_REJECTED",
    });
    const paused = await h.controls().pause(active.revision);
    await expect(
      h.controls().settleDispatch(token, active.revision),
    ).rejects.toMatchObject({
      code: "LINKED_CALENDAR_DISPATCH_RECEIPT_REJECTED",
    });
    expect((await h.controls().read()).dispatch?.token).toBe(token);
    await h.controls().settleDispatch(token, paused.revision);
    const recovered = await h.controls().read();
    expect(recovered.paused).toBe(true);
    expect(recovered.dispatch).toBeNull();
    await expect(h.controls().resume(paused.revision)).rejects.toMatchObject({
      code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
    });
    expect((await h.controls().resume(recovered.revision)).paused).toBe(false);
  });

  it("serializes a pause racing admission across independent repository instances", async () => {
    const h = await harness();
    const initial = await h.controls().read();
    const selected = await h
      .controls()
      .selectDestination(initial.revision, destination);
    const active = await h.controls().resume(selected.revision);
    const [admission, pause] = await Promise.allSettled([
      h
        .controls()
        .acquireDispatch(active.revision, "racing-event", destination),
      h.controls().pause(active.revision),
    ]);
    expect(pause.status).toBe("fulfilled");
    const current = await h.controls().read();
    expect(current.paused).toBe(true);
    if (admission.status === "fulfilled") {
      expect(current.dispatch?.token).toBe(admission.value);
      await expect(h.controls().resume(current.revision)).rejects.toMatchObject(
        { code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED" },
      );
      await h.controls().settleDispatch(admission.value);
    } else {
      expect(current.dispatch).toBeNull();
    }
    await expect(
      h
        .controls()
        .acquireDispatch(current.revision, "later-event", destination),
    ).rejects.toMatchObject({ code: "LINKED_CALENDAR_DISPATCH_REJECTED" });
  });

  it("allows only one concurrent review and rejects a stale resume", async () => {
    const h = await harness();
    const initial = await h.controls().read();
    const results = await Promise.allSettled([
      h.controls().selectDestination(initial.revision, destination),
      h.controls().selectDestination(initial.revision, {
        ...destination,
        providerCalendarId: "another-calendar",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    await expect(h.controls().resume(initial.revision)).rejects.toMatchObject({
      code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
    });
    expect((await h.controls().read()).paused).toBe(true);
  });

  it("preserves pending create, update and delete records when pausing and reviewing a replacement", async () => {
    const h = await harness();
    const runtime = h.runtime();
    const links = new LinkedCalendarRepository(runtime);
    for (const operation of ["create", "update", "delete"] as const) {
      const link = await links.create({
        agentId: runtime.agentId,
        localEventId: operation,
        ...destination,
        localRevision: 1,
      });
      await links.save(link, { pendingOperation: operation });
    }
    const before = await links.listForAgent(runtime.agentId);
    const initial = await h.controls().read();
    const selected = await h
      .controls()
      .selectDestination(initial.revision, destination);
    const active = await h.controls().resume(selected.revision);
    const paused = await h.controls().pause(active.revision);
    await h.controls().selectDestination(paused.revision, {
      ...destination,
      connectorAccountId: "real-account",
    });
    expect(await links.listForAgent(runtime.agentId)).toEqual(before);
    expect((await h.controls().read()).paused).toBe(true);
    const anotherOwner = new LinkedCalendarControlRepository(
      h.runtime("owner-b"),
    );
    expect((await anotherOwner.read()).destination).toBeNull();
  });

  it("rejects an incomplete destination without changing the reviewed state", async () => {
    const h = await harness();
    const initial = await h.controls().read();
    await expect(
      h.controls().selectDestination(initial.revision, {
        ...destination,
        providerCalendarId: " ",
      }),
    ).rejects.toMatchObject({ code: "LINKED_CALENDAR_DESTINATION_REQUIRED" });
    expect(await h.controls().read()).toEqual(initial);
  });
});
