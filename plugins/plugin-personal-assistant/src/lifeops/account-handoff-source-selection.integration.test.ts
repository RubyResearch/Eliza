/** Real PGlite source preference CAS and interrupted handoff checkpoints with a deterministic Google discovery port. */
import {
  CalendarService,
  createDefaultCalendarHostGate,
} from "@elizaos/plugin-calendar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { googleHandoffFixture } from "../../test/helpers/handoff-google.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { GoogleWorkspaceTestService } from "../../test/stubs/plugin-google-workspace.js";
import { AccountHandoffAdmission } from "./account-handoff-admission.js";
import { AccountHandoffCalendarMappings } from "./account-handoff-calendar-mappings.js";
import { AccountHandoffReviewService } from "./account-handoff-review.js";
import { AccountHandoffSourceSelection } from "./account-handoff-source-selection.js";
import { AccountHandoffStore } from "./account-handoff-store.js";
import { executeRawSql } from "./sql.js";

let host: RealTestRuntimeResult;
beforeAll(async () => {
  host = await createLifeOpsTestRuntime();
  await host.runtime.registerService(GoogleWorkspaceTestService);
}, 60_000);
afterAll(async () => {
  await host.cleanup();
});

async function prepared(owner: string) {
  const f = googleHandoffFixture();
  f.grant.agentId = host.runtime.agentId;
  f.grant.id = `${owner}-grant`;
  f.grant.connectorAccountId = `${owner}-account`;
  f.review.replacement = {
    grantId: f.grant.id,
    connectorAccountId: f.grant.connectorAccountId,
    email: f.review.replacement.email,
  };
  f.review.readCalendars = [
    {
      grantId: f.grant.id,
      connectorAccountId: f.grant.connectorAccountId,
      calendarId: "selected",
    },
  ];
  f.review.writeCalendar = null;
  f.review.messageDestinations = [];
  const entries = [
    { ...f.entry, calendarId: "selected" },
    { ...f.entry, calendarId: "excluded" },
  ];
  const provider = await host.runtime.getServiceLoadPromise("google");
  Object.assign(provider, { listCalendars: async () => entries });
  const calendar = new CalendarService(host.runtime);
  const accounts = {
    getGoogleConnectorAccounts: async () => [
      f.status,
      {
        ...f.status,
        grant: {
          ...f.grant,
          id: f.review.previous.grantId,
          connectorAccountId: f.review.previous.connectorAccountId,
          identityEmail: f.review.previous.email,
        },
      },
    ],
  };
  calendar.setGate({
    ...createDefaultCalendarHostGate(host.runtime),
    ...accounts,
  });
  const url = new URL("http://localhost");
  const list = () =>
    calendar.listCalendars(url, {
      mode: "local",
      side: "owner",
      grantId: f.grant.id,
    });
  const set = async (calendarId: string, included: boolean) => {
    const source = (await list()).find(
      (entry) => entry.calendarId === calendarId,
    );
    if (!source) throw new Error("Fixture source missing");
    return calendar.setCalendarIncluded(url, {
      provider: "google",
      mode: "local",
      side: "owner",
      grantId: f.grant.id,
      connectorAccountId: f.grant.connectorAccountId,
      calendarId,
      includeInFeed: included,
      expectedVersion: source.selectionVersion,
    });
  };
  await set("excluded", true);
  const store = new AccountHandoffStore(host.runtime, owner);
  const service = () =>
    new AccountHandoffSourceSelection(host.runtime, owner, calendar, url);
  let state = await new AccountHandoffReviewService(
    host.runtime,
    owner,
    accounts,
    calendar,
    url,
  ).create({
    operationId: owner,
    previousGrantId: f.review.previous.grantId,
    replacementGrantId: f.grant.id,
    readCalendarIds: ["selected"],
    writeCalendarId: null,
    calendarLinks: [],
    messageDestinations: [],
    importedData: "retain",
    retireApprovalIds: [],
  });
  const reviewed = state;
  const admission = new AccountHandoffAdmission(
    host.runtime,
    owner,
    calendar,
    url,
  );
  state = await admission.begin(state.operationId, state.revision);
  state = await admission.pause(state.operationId, state.revision);
  state = await admission.drain(state.operationId, state.revision);
  state = await admission.retireApprovals(state.operationId, state.revision);
  const mappings = new AccountHandoffCalendarMappings(
    host.runtime,
    owner,
    calendar,
    url,
  );
  state = await mappings.applyNext(state.operationId, state.revision);
  state = await mappings.applyNext(state.operationId, state.revision);
  return { service, state, reviewed, store, calendar, list, set, entries, url };
}

describe("reviewed calendar source application", () => {
  it("recovers a preference write before its checkpoint, then excludes the other source without repeating the first write", async () => {
    const p = await prepared("source-recovery");
    const pause = await p.calendar.getLinkedCalendarControl();
    await executeRawSql(
      host.runtime,
      "ALTER TABLE app_lifeops.life_account_handoffs ADD CONSTRAINT reject_source_checkpoint CHECK (NOT (receipt_json::jsonb ? 'readSource:selected')) NOT VALID",
    );
    try {
      await expect(
        p.service().applyNext(p.state.operationId, p.state.revision),
      ).rejects.toThrow();
    } finally {
      await executeRawSql(
        host.runtime,
        "ALTER TABLE app_lifeops.life_account_handoffs DROP CONSTRAINT reject_source_checkpoint",
      );
    }
    const afterWrite = await p.list();
    expect(
      afterWrite.find((source) => source.calendarId === "selected")
        ?.includeInFeed,
    ).toBe(true);
    expect(await p.store.read(p.state.operationId)).toEqual(p.state);
    const recovered = await p
      .service()
      .applyNext(p.state.operationId, p.state.revision);
    expect(await p.list()).toEqual(afterWrite);
    const excluded = await p
      .service()
      .applyNext(recovered.handoff.operationId, recovered.handoff.revision);
    const complete = await p
      .service()
      .applyNext(excluded.handoff.operationId, excluded.handoff.revision);
    expect(complete.complete).toBe(true);
    expect(
      (await p.list())
        .filter((source) => source.includeInFeed)
        .map((source) => source.calendarId),
    ).toEqual(["selected"]);
    expect(await p.calendar.getLinkedCalendarControl()).toEqual(pause);
    expect(complete.handoff.phase).toBe("verifying_replacement");
  });

  it("preserves later owner choices instead of refreshing the review's source versions", async () => {
    const p = await prepared("source-changed");
    await p.set("selected", true);
    await p.set("selected", false);
    const changed = await p.list();
    await expect(
      p.service().applyNext(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_SOURCE_SELECTION_CONFLICT",
    });
    expect(await p.list()).toEqual(changed);
    expect(await p.store.read(p.state.operationId)).toEqual(p.state);
  });

  it("rejects a removed source and another owner before applying any selection", async () => {
    const p = await prepared("source-missing");
    const unrelated = new AccountHandoffSourceSelection(
      host.runtime,
      "another-owner",
      p.calendar,
      p.url,
    );
    await expect(
      unrelated.applyNext(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_SOURCE_SELECTION_CONFLICT",
    });
    const removed = p.entries.pop();
    await expect(
      p.service().applyNext(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_SOURCE_SELECTION_CONFLICT",
    });
    if (!removed) throw new Error("Fixture source already removed");
    p.entries.push(removed);
    expect(
      (await p.list()).find((source) => source.calendarId === "selected")
        ?.includeInFeed,
    ).toBe(false);
    expect(await p.store.read(p.state.operationId)).toEqual(p.state);
  });
  it("does not apply source choices after calendar pause ownership changes", async () => {
    const p = await prepared("source-pause-changed");
    const before = await p.list();
    const control = await p.calendar.getLinkedCalendarControl();
    await p.calendar.executeLinkedCalendarControl(p.url, {
      operation: "pause",
      expectedRevision: control.revision,
      idempotencyKey: "source-selection-later-manual-pause",
    });
    const manual = await p.calendar.getLinkedCalendarControl();
    await expect(
      p.service().applyNext(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_SOURCE_SELECTION_CONFLICT",
    });
    expect(await p.list()).toEqual(before);
    expect(await p.calendar.getLinkedCalendarControl()).toEqual(manual);
    expect(await p.store.read(p.state.operationId)).toEqual(p.state);
  });
});
