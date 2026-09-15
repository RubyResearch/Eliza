/** Real PGlite handoff checkpoints with deterministic external Google reads, including retry and pause-ownership races. */
import { CalendarService } from "@elizaos/plugin-calendar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { googleHandoffFixture } from "../../test/helpers/handoff-google.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { AccountHandoffAdmission } from "./account-handoff-admission.js";
import { AccountHandoffCalendarMappings } from "./account-handoff-calendar-mappings.js";
import { AccountHandoffStore } from "./account-handoff-store.js";
import { AccountHandoffVerification } from "./account-handoff-verification.js";

let result: RealTestRuntimeResult;
beforeAll(async () => {
  result = await createLifeOpsTestRuntime();
}, 60_000);
afterAll(async () => {
  await result.cleanup();
});

async function prepared(owner: string) {
  const f = googleHandoffFixture();
  f.grant.agentId = result.runtime.agentId;
  f.review.readCalendars = [];
  f.review.writeCalendar = null;
  const calendar = new CalendarService(result.runtime);
  const store = new AccountHandoffStore(result.runtime, owner);
  const url = new URL("http://localhost");
  let state = await store.review(owner, f.review);
  const admission = new AccountHandoffAdmission(
    result.runtime,
    owner,
    calendar,
    url,
  );
  state = await admission.begin(state.operationId, state.revision);
  state = await admission.pause(state.operationId, state.revision);
  state = await admission.drain(state.operationId, state.revision);
  state = await admission.retireApprovals(state.operationId, state.revision);
  const mappings = new AccountHandoffCalendarMappings(
    result.runtime,
    owner,
    calendar,
    url,
  );
  state = await mappings.applyNext(state.operationId, state.revision);
  state = await mappings.applyNext(state.operationId, state.revision);
  const verifier = () =>
    new AccountHandoffVerification(
      result.runtime,
      owner,
      calendar,
      f.accounts,
      f.google,
      url,
    );
  return { f, calendar, store, state, verifier };
}

describe("durable Google verification", () => {
  it("persists scoped evidence without advancing or resuming, and reopens without repeating the probe", async () => {
    const { f, calendar, store, state, verifier } =
      await prepared("verify-owner");
    const control = await calendar.getLinkedCalendarControl();
    const saved = await verifier().verifyGoogle(
      state.operationId,
      state.revision,
    );
    expect(saved.phase).toBe("verifying_replacement");
    expect(saved.receipt.googleVerification).toMatchObject({
      connectorAccountId: "replacement",
      gmailHistoryId: "12345",
      calendarIds: [],
    });
    expect(await store.read(state.operationId)).toEqual(saved);
    expect(await calendar.getLinkedCalendarControl()).toEqual(control);
    const calls = [...f.calls];
    const unrelated = new AccountHandoffVerification(
      result.runtime,
      "unrelated-owner",
      calendar,
      f.accounts,
      f.google,
      new URL("http://localhost"),
    );
    await expect(
      unrelated.verifyGoogle(saved.operationId, saved.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    expect(f.calls).toEqual(calls);
    expect(
      await verifier().verifyGoogle(saved.operationId, saved.revision),
    ).toEqual(saved);
    expect(f.calls).toEqual(calls);
    await expect(
      verifier().verifyGoogle(state.operationId, state.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
  });

  it("does not checkpoint when pause ownership changes during a provider read", async () => {
    const { f, calendar, store, state, verifier } =
      await prepared("verify-race-owner");
    const original = f.google.getGmailHistoryId;
    f.google.getGmailHistoryId = async (input) => {
      const value = await original(input);
      const control = await calendar.getLinkedCalendarControl();
      await calendar.executeLinkedCalendarControl(new URL("http://localhost"), {
        operation: "pause",
        expectedRevision: control.revision,
        idempotencyKey: "intervening-owner-pause",
      });
      return value;
    };
    await expect(
      verifier().verifyGoogle(state.operationId, state.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    expect(await store.read(state.operationId)).toEqual(state);
  });

  it("rejects an unavailable replacement without storing healthy-looking evidence", async () => {
    const { f, store, state, verifier } = await prepared(
      "verify-unavailable-owner",
    );
    f.status.connected = false;
    await expect(
      verifier().verifyGoogle(state.operationId, state.revision),
    ).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_REPLACEMENT_UNAVAILABLE",
    });
    expect(await store.read(state.operationId)).toEqual(state);
  });
});
