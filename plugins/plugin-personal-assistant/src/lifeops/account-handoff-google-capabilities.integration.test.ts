/** Real canonical connector storage and Google grant projection verify handoff permissions; provider reads are deterministic and no message is sent. */
import { getConnectorAccountManager } from "@elizaos/core";
import {
  CalendarService,
  createDefaultCalendarHostGate,
} from "@elizaos/plugin-calendar";
import { expect, it } from "vitest";
import { googleHandoffFixture } from "../../test/helpers/handoff-google.js";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { AccountHandoffAdmission } from "./account-handoff-admission.js";
import { AccountHandoffCalendarMappings } from "./account-handoff-calendar-mappings.js";
import { verifyAccountHandoffGoogle } from "./account-handoff-google-verification.js";
import { verifyAccountHandoffReadSources } from "./account-handoff-read-sources.js";
import { AccountHandoffReviewService } from "./account-handoff-review.js";
import { AccountHandoffSourceSelection } from "./account-handoff-source-selection.js";
import { googleGrantIdForAccount } from "./google-plugin-delegates.js";
import { LifeOpsService } from "./service.js";

it("verifies a canonical Gmail read/send grant, then rejects lost send permission before another provider probe", async () => {
  const host = await createLifeOpsTestRuntime();
  try {
    const manager = getConnectorAccountManager(host.runtime);
    manager.registerProvider({ provider: "google" });
    const saved = await manager.upsertAccount("google", {
      provider: "google",
      id: "canonical-mail",
      role: "OWNER",
      purpose: ["reading", "messaging"],
      accessGate: "owner_binding",
      status: "connected",
      displayHandle: "canonical@example.test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        grantedScopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.send",
        ],
      },
    });
    const previous = await manager.upsertAccount("google", {
      ...saved,
      id: "previous-mail",
      accountKey: "previous-mail",
      displayHandle: "previous@example.test",
    });
    const service = new LifeOpsService(host.runtime);
    const url = new URL("http://localhost");
    const f = googleHandoffFixture();
    const grantId = googleGrantIdForAccount(saved.id);
    f.review.replacement = {
      grantId,
      connectorAccountId: saved.id,
      email: "canonical@example.test",
    };
    f.review.readCalendars = [];
    f.review.writeCalendar = null;
    f.review.messageDestinations = [
      {
        channel: "email",
        connectorAccountId: saved.id,
        recipientId: "recipient@example.test",
      },
    ];
    // The real calendar service has no Google provider installed: Gmail-only
    // review and source application must not require a calendar API call.
    const calendar = new CalendarService(host.runtime);
    calendar.setGate({
      ...createDefaultCalendarHostGate(host.runtime),
      getGoogleConnectorAccounts:
        service.getGoogleConnectorAccounts.bind(service),
    });
    const owner = "gmail-only-owner";
    let state = await new AccountHandoffReviewService(
      host.runtime,
      owner,
      service,
      calendar,
      url,
    ).create({
      operationId: "gmail-only-switch",
      previousGrantId: googleGrantIdForAccount(previous.id),
      replacementGrantId: grantId,
      readCalendarIds: [],
      writeCalendarId: null,
      calendarLinks: [],
      messageDestinations: [],
      importedData: "retain",
      retireApprovalIds: [],
    });
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
    const applied = await new AccountHandoffSourceSelection(
      host.runtime,
      owner,
      calendar,
      url,
    ).applyNext(state.operationId, state.revision);
    expect(applied.complete).toBe(true);
    await verifyAccountHandoffReadSources(
      calendar,
      url,
      applied.handoff.review,
    );
    expect(await calendar.getLinkedCalendarControl()).toMatchObject({
      paused: true,
    });
    const run = () =>
      verifyAccountHandoffGoogle(
        host.runtime.agentId,
        url,
        f.review,
        service,
        f.google,
      );
    const verified = await run();
    expect(verified).toMatchObject({
      connectorAccountId: saved.id,
      grantId,
      gmailHistoryId: "12345",
      writableCalendarId: null,
    });
    expect(f.calls).toEqual([`gmail:${saved.id}`]);
    await manager.upsertAccount("google", {
      ...saved,
      metadata: {
        grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      },
    });
    await expect(run()).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_REPLACEMENT_UNAVAILABLE",
    });
    expect(f.calls).toEqual([`gmail:${saved.id}`]);
  } finally {
    await host.cleanup();
  }
});
