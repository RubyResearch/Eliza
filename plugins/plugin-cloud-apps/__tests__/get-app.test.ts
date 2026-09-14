/**
 * GET_APP action tests: single-app detail resolved by name or id. The @elizaos/cloud-sdk client is faked (helpers.ts, SDK boundary only); the action runs for real.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeApp,
  makeMessage,
  requireDefined,
  resetSdk,
  setGetApp,
  setListApps,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { getAppAction } = await import("../src/actions/get-app.ts");

describe("GET_APP", () => {
  beforeEach(() => {
    resetSdk();
  });

  it("validates only when a Cloud API key is present", async () => {
    expect(await getAppAction.validate(keyedRuntime(), makeMessage("x"))).toBe(
      true,
    );
    expect(
      await getAppAction.validate(unkeyedRuntime(), makeMessage("x")),
    ).toBe(false);
  });

  it("resolves an app by name from free-text and formats its detail", async () => {
    setListApps(() =>
      Promise.resolve({
        success: true,
        apps: [
          makeApp({
            id: "id-acme",
            name: "Acme Bot",
            slug: "acme-bot",
            description: "Customer support bot",
            production_url: "https://acme.elizacloud.ai",
            deployment_status: "deployed",
            total_credits_used: "12.4",
            monetization_enabled: true,
            total_creator_earnings: "3.5",
          }),
          makeApp({ id: "id-other", name: "Other", slug: "other" }),
        ],
      }),
    );

    const cb = captureCallback();
    const result = await getAppAction.handler(
      keyedRuntime(),
      makeMessage("tell me about my Acme Bot app"),
      undefined,
      undefined,
      cb.fn,
    );

    expect(result?.success).toBe(true);
    const reply = cb.calls[0]?.text ?? "";
    expect(reply).toContain("Acme Bot");
    expect(reply).toContain("Customer support bot");
    expect(reply).toContain("https://acme.elizacloud.ai");
    expect(reply).toContain("deployed");
    expect(reply).toContain("$12.40");
    expect(reply).toContain("$3.50");
    expect(
      (requireDefined(result, "action result").data as { app: { id: string } })
        .app.id,
    ).toBe("id-acme");
  });

  it("resolves an app via an explicit planner option", async () => {
    setListApps(() =>
      Promise.resolve({
        success: true,
        apps: [makeApp({ id: "id-7", name: "Widget", slug: "widget" })],
      }),
    );
    const cb = captureCallback();
    const result = await getAppAction.handler(
      keyedRuntime(),
      makeMessage("show it"),
      undefined,
      { appName: "Widget" },
      cb.fn,
    );
    expect(result?.success).toBe(true);
    expect(cb.calls[0]?.text).toContain("Widget");
  });

  it("fetches by id directly when the reference is a UUID", async () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    let listCalled = false;
    setListApps(() => {
      listCalled = true;
      return Promise.resolve({ success: true, apps: [] });
    });
    setGetApp((id) =>
      Promise.resolve({
        success: true,
        app: makeApp({ id, name: "By Id App", slug: "by-id" }),
      }),
    );

    const cb = captureCallback();
    const result = await getAppAction.handler(
      keyedRuntime(),
      makeMessage(uuid),
      undefined,
      undefined,
      cb.fn,
    );

    expect(result?.success).toBe(true);
    expect(cb.calls[0]?.text).toContain("By Id App");
    // The id path must not fall back to listApps.
    expect(listCalled).toBe(false);
  });

  it("returns a graceful not-found when nothing matches", async () => {
    setListApps(() =>
      Promise.resolve({
        success: true,
        apps: [makeApp({ name: "Acme Bot", slug: "acme-bot" })],
      }),
    );

    const cb = captureCallback();
    const result = await getAppAction.handler(
      keyedRuntime(),
      makeMessage("tell me about Zephyr"),
      undefined,
      undefined,
      cb.fn,
    );

    expect(result?.success).toBe(false);
    expect(
      (requireDefined(result, "action result").data as { reason: string })
        .reason,
    ).toBe("not_found");
    const reply = cb.calls[0]?.text ?? "";
    expect(reply).toContain("couldn't find an app");
    expect(reply).toContain("Acme Bot");
  });

  it("degrades gracefully when no Cloud API key is configured", async () => {
    const cb = captureCallback();
    const result = await getAppAction.handler(
      unkeyedRuntime(),
      makeMessage("tell me about my app"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(result?.success).toBe(false);
    expect(
      (requireDefined(result, "action result").data as { reason: string })
        .reason,
    ).toBe("no_key");
    expect(cb.calls[0]?.text).toContain("no Cloud API key");
  });

  it("handles a Cloud API error without throwing", async () => {
    setListApps(() => Promise.reject(new Error("network")));
    const cb = captureCallback();
    const result = await getAppAction.handler(
      keyedRuntime(),
      makeMessage("tell me about something"),
      undefined,
      undefined,
      cb.fn,
    );
    expect(result?.success).toBe(false);
    expect(
      (requireDefined(result, "action result").data as { reason: string })
        .reason,
    ).toBe("error");
  });

  it("REGRESSION (#29916): a stale/foreign UUID option → not_found which-app reply, not the generic error", async () => {
    // The UUID must arrive as the planner-supplied option: inlined in the
    // message text it never reaches the id path (extractAppReference returns
    // the whole sentence and looksLikeAppId is false). A stale id makes
    // getApp reject (CloudApiError 404); before the guard that rejection
    // landed in the outer catch as a retry-never-helps "Cloud API returned
    // an error" reply. It must now fall through to list-based resolution.
    const STALE_UUID = "99999999-9999-4999-8999-999999999999";
    setGetApp((id) => {
      expect(id).toBe(STALE_UUID);
      return Promise.reject(
        Object.assign(new Error("HTTP 404"), {
          name: "CloudApiError",
          statusCode: 404,
          errorBody: { success: false, error: "HTTP 404" },
        }),
      );
    });
    setListApps(() =>
      Promise.resolve({
        success: true,
        apps: [makeApp({ name: "Acme Bot", slug: "acme-bot" })],
      }),
    );

    const cb = captureCallback();
    const result = await getAppAction.handler(
      keyedRuntime(),
      makeMessage("tell me about my app"),
      undefined,
      { app: STALE_UUID },
      cb.fn,
    );

    expect(result?.success).toBe(false);
    expect(
      (requireDefined(result, "action result").data as { reason: string })
        .reason,
    ).toBe("not_found");
    // The which-app reply lists the org's current app, never a retry hint.
    const reply = cb.calls[0]?.text ?? "";
    expect(reply).toContain("Acme Bot");
    expect(reply).not.toContain("Cloud API returned an error");
  });

  it("REGRESSION (#29917 review): an id-endpoint 5xx is an error, not app-not-found", async () => {
    // The degrade-to-list guard must be scoped to the benign 404/403 of a
    // stale/foreign id. A 500 from the id endpoint is an outage; if it fell
    // through to listApps the user would be told their app does not exist
    // (with the org's app names listed) when the truth is "try again in a
    // moment". The 500 must re-raise into the outer catch.
    const uuid = "11111111-2222-3333-4444-555555555555";
    let listCalled = false;
    setListApps(() => {
      listCalled = true;
      return Promise.resolve({
        success: true,
        apps: [makeApp({ name: "Acme Bot", slug: "acme-bot" })],
      });
    });
    setGetApp((id) => {
      expect(id).toBe(uuid);
      return Promise.reject(
        Object.assign(new Error("HTTP 500"), {
          name: "CloudApiError",
          statusCode: 500,
          errorBody: { success: false, error: "Internal Server Error" },
        }),
      );
    });

    const cb = captureCallback();
    const result = await getAppAction.handler(
      keyedRuntime(),
      makeMessage("tell me about my app"),
      undefined,
      { app: uuid },
      cb.fn,
    );

    expect(result?.success).toBe(false);
    expect(
      (requireDefined(result, "action result").data as { reason: string })
        .reason,
    ).toBe("error");
    // No list-based resolution: the outage must not be cross-checked against
    // the org's other apps.
    expect(listCalled).toBe(false);
    const errReply = cb.calls[0]?.text ?? "";
    expect(errReply).toContain("Cloud API returned an error");
    expect(errReply).not.toContain("Acme Bot");
  });

  it("REGRESSION (#29917 review): delivery failure on the happy id path reports error, not success", async () => {
    // The stale-UUID guard must cover ONLY the getApp fetch. If the try also
    // wrapped formatting/delivery/return, a rejecting callback after a
    // successful fetch would be swallowed and degrade to list resolution —
    // reporting success: true for a reply the user never received. The
    // delivery failure must reach the outer catch, as it does at develop.
    const uuid = "11111111-2222-3333-4444-555555555555";
    let listCalled = false;
    setListApps(() => {
      listCalled = true;
      return Promise.resolve({ success: true, apps: [] });
    });
    setGetApp((id) =>
      Promise.resolve({
        success: true,
        app: makeApp({ id, name: "By Id App", slug: "by-id" }),
      }),
    );

    let deliveries = 0;
    const result = await getAppAction.handler(
      keyedRuntime(),
      makeMessage(uuid),
      undefined,
      undefined,
      async () => {
        deliveries += 1;
        // Only the first delivery fails; the outer catch's ERROR_MESSAGE
        // retry must go through so the action can report its error result.
        if (deliveries === 1) throw new Error("delivery failed");
      },
    );

    expect(result?.success).toBe(false);
    expect(
      (requireDefined(result, "action result").data as { reason: string })
        .reason,
    ).toBe("error");
    // The happy id path must not degrade into list resolution; the failure
    // surfaces through the outer catch's error reply instead.
    expect(listCalled).toBe(false);
    expect(deliveries).toBe(2);
  });
});
