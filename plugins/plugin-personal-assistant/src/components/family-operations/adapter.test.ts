/** HTTP contract tests for Family Operations calendar conflict mutations. */

import { client } from "@elizaos/ui/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultFamilyOperationsAdapter } from "./adapter.js";

// The package aliases UI imports to an empty client. Exercise the production
// transport here so bearer, origin and binary-body regressions remain visible.
vi.mock("@elizaos/ui/api", async () => {
  const { ElizaClient } = await import(
    "../../../../../packages/ui/src/api/client-base.ts"
  );
  return { client: new ElizaClient() };
});

const testApiBase = "https://family-api.example";

function requestPath(input: string | URL | Request): string {
  return new URL(String(input), testApiBase).pathname;
}

beforeEach(() => {
  client.setBaseUrl(testApiBase, { persist: false });
  client.setToken("family-adapter-test-session");
});

afterEach(() => {
  vi.useRealTimers();
  client.setToken(null);
  client.setBaseUrl(null, { persist: false });
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("defaultFamilyOperationsAdapter", () => {
  it("updates only the selected task timing through authenticated transport and surfaces rejection", async () => {
    let rejected = false;
    let saved: unknown;
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const req = new Request(input, init);
        if (
          req.headers.get("authorization") !==
          "Bearer family-adapter-test-session"
        )
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        if (
          requestPath(input) !==
            "/api/lifeops/scheduled-tasks/family%2Fmonthly/edit" ||
          req.method !== "POST"
        )
          return Response.json(
            { error: "Wrong scheduled task" },
            { status: 404 },
          );
        if (rejected)
          return Response.json(
            { error: "Task no longer available" },
            { status: 409 },
          );
        saved = await req.json();
        return Response.json({ task: saved });
      },
    );
    const input = {
      taskId: "family/monthly",
      day: 15,
      time: "14:35",
      timezone: "America/New_York",
    };
    await defaultFamilyOperationsAdapter.updateMonthlySchedule(input);
    expect(saved).toEqual({
      trigger: {
        kind: "cron",
        expression: "35 14 15 * *",
        tz: "America/New_York",
      },
    });
    rejected = true;
    await expect(
      defaultFamilyOperationsAdapter.updateMonthlySchedule(input),
    ).rejects.toThrow("Task no longer available");
    await expect(
      defaultFamilyOperationsAdapter.updateMonthlySchedule({
        ...input,
        day: 32,
      }),
    ).rejects.toThrow("Choose a day");
    await expect(
      defaultFamilyOperationsAdapter.updateMonthlySchedule({
        ...input,
        time: "25:00",
      }),
    ).rejects.toThrow("Choose a day");
  });
  it("recovers a prepared agreement review through the authenticated selected API and preserves validation failures", async () => {
    const review = {
      artifactId: "artifact/one",
      outcome: "no_proposals",
      generatedAt: "2026-09-13T00:00:00Z",
      explanation: "Synthetic review",
      obligations: [],
    };
    let prepared = false;
    let unavailable = false;
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        if (
          new URL(request.url).origin !== testApiBase ||
          request.headers.get("authorization") !==
            "Bearer family-adapter-test-session"
        )
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        if (
          requestPath(input) !== "/api/lifeops/agreements/artifact%2Fone/review"
        )
          return Response.json(
            { error: "Wrong artifact route" },
            { status: 404 },
          );
        if (unavailable)
          return Response.json(
            {
              error: {
                message: "Citation does not match source pages",
                code: "AGREEMENT_REVIEW_CITATION_INVALID",
              },
            },
            { status: 422 },
          );
        if (request.method === "POST") prepared = true;
        return Response.json({ review: prepared ? review : null });
      },
    );
    await expect(
      defaultFamilyOperationsAdapter.readAgreementReview("artifact/one"),
    ).resolves.toBeNull();
    await expect(
      defaultFamilyOperationsAdapter.prepareAgreementReview("artifact/one"),
    ).resolves.toEqual(review);
    await expect(
      defaultFamilyOperationsAdapter.readAgreementReview("artifact/one"),
    ).resolves.toEqual(review);
    unavailable = true;
    await expect(
      defaultFamilyOperationsAdapter.prepareAgreementReview("artifact/one"),
    ).rejects.toThrow("Citation does not match source pages");
  });

  it("sends the owner's selected month instead of letting the server choose next month", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
      const request = new Request(new URL(path, "http://localhost"), init);
      requests.push(request);
      return Response.json({});
    });
    await defaultFamilyOperationsAdapter.generatePacket("2028-02");
    expect(requests[0].method).toBe("POST");
    expect(await requests[0].json()).toEqual({ periodKey: "2028-02" });
  });
  it("downloads binary exports through authenticated transport and surfaces integrity failures", async () => {
    const bytes = new Uint8Array([80, 75, 3, 4, 0, 255]);
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        if (
          new URL(String(input)).origin !== testApiBase ||
          new Headers(init?.headers).get("authorization") !==
            "Bearer family-adapter-test-session"
        )
          return new Response("Unauthorized", { status: 401 });
        if (requestPath(input).endsWith("/export") && init?.method === "POST")
          return new Response(bytes, {
            headers: { "content-type": "application/zip" },
          });
        return new Response(
          JSON.stringify({
            error: { message: "Original failed integrity verification" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      },
    );
    const archive = await defaultFamilyOperationsAdapter.downloadAgreement(
      "artifact-one",
      "export",
    );
    expect(new Uint8Array(await archive.arrayBuffer())).toEqual(bytes);
    const workspace = await defaultFamilyOperationsAdapter.downloadWorkspace();
    expect(new Uint8Array(await workspace.arrayBuffer())).toEqual(bytes);
    await expect(
      defaultFamilyOperationsAdapter.downloadAgreement(
        "artifact-one",
        "original",
      ),
    ).rejects.toThrow("Original failed integrity verification");
  });

  it("rejects a successful HTTP response that is not a workspace archive", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("{}", { headers: { "content-type": "application/json" } }),
    );
    await expect(
      defaultFamilyOperationsAdapter.downloadWorkspace(),
    ).rejects.toThrow("The server did not return a workspace archive.");
  });

  it.each([
    ["text/html", "<html>Bad gateway</html>", 502],
    ["text/plain", "Payload too large", 413],
    ["application/json", "{invalid", 502],
  ])(
    "preserves HTTP failures for %s error responses",
    async (contentType, body, status) => {
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(body, {
            status,
            headers: { "content-type": contentType },
          }),
      );
      await expect(
        defaultFamilyOperationsAdapter.downloadAgreement(
          "artifact-one",
          "export",
        ),
      ).rejects.toThrow(`Download failed (${status})`);
    },
  );

  it("allows provider-backed mutations to complete beyond the ordinary read timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(new Response("{}", { status: 202 })),
            11_000,
          );
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("Request aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const result = defaultFamilyOperationsAdapter.runSchoolWorkflow().then(
      () => "accepted",
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await result).toBe("accepted");
  });

  it("uses the active remote bearer for reads and returns accepted mutations once", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input), "https://renderer.example");
        if (
          url.origin !== testApiBase ||
          new Headers(init?.headers).get("authorization") !==
            "Bearer family-adapter-test-session"
        ) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
          });
        }
        calls.push(url.pathname);
        const payload = url.pathname.endsWith("/agreements")
          ? { agreements: [] }
          : url.pathname.endsWith("/calendar/links")
            ? { links: [] }
            : url.pathname.endsWith("/school/status")
              ? { sourceId: "concord", config: null, lastRun: null }
              : url.pathname.endsWith("/packets")
                ? { packets: [], packetStates: [] }
                : { accepted: true };
        return new Response(JSON.stringify(payload), {
          status: init?.method === "POST" ? 202 : 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    const snapshot = await defaultFamilyOperationsAdapter.load();
    expect(snapshot.agreements).toEqual({ status: "ready", data: [] });
    await defaultFamilyOperationsAdapter.runSchoolWorkflow();
    expect(calls.filter((path) => path.endsWith("/school/run"))).toHaveLength(
      1,
    );
    client.setToken(null);
    expect((await defaultFamilyOperationsAdapter.load()).agreements).toEqual({
      status: "unavailable",
      message: "Unauthorized",
    });
  });

  it("loads and mutates the mounted family workflow contracts", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = requestPath(input);
      calls.push(path);
      const payload = path.endsWith("/agreements")
        ? { agreements: [] }
        : path.endsWith("/calendar/links")
          ? { links: [] }
          : path.endsWith("/school/status")
            ? { sourceId: "concord", config: null, lastRun: null }
            : path.endsWith("/packets")
              ? { packets: [], packetStates: [] }
              : {};
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await defaultFamilyOperationsAdapter.load();
    expect(snapshot.school).toMatchObject({
      status: "ready",
      data: { state: "never_run", monthlySchedule: { status: "unavailable" } },
    });
    expect(snapshot.packets).toEqual({ status: "ready", data: [] });

    await defaultFamilyOperationsAdapter.runSchoolWorkflow();
    await defaultFamilyOperationsAdapter.approveSchoolDiff("run/1");
    await defaultFamilyOperationsAdapter.generatePacket("2026-08");

    expect(calls).toContain("/api/lifeops/family-workflows/school/status");
    expect(calls).toContain("/api/lifeops/family-workflows/school/run");
    expect(calls).toContain("/api/lifeops/family-workflows/school/apply");
    expect(
      calls.filter((path) => path === "/api/lifeops/family-workflows/packets"),
    ).toHaveLength(2);
  });

  it("uploads PDF bytes and drives immutable draft and approval routes", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push([requestPath(input), init]);
        const path = requestPath(input);
        const payload =
          path === "/api/lifeops/agreement-uploads"
            ? {
                upload: {
                  uploadId: "upload-1",
                  sizeBytes: 8,
                  chunkSizeBytes: 4,
                  chunkCount: 2,
                  receivedChunks: [],
                  receivedBytes: 0,
                  status: "uploading",
                },
              }
            : { upload: {} };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const file = new File(["%PDF-1.7"], "agreement.pdf", {
      type: "application/pdf",
      lastModified: 1,
    });

    await defaultFamilyOperationsAdapter.uploadAgreement({
      agreementKey: "parenting-plan",
      title: "Parenting agreement",
      file,
    });
    await defaultFamilyOperationsAdapter.createPacketDraft({
      packetId: "packet/1",
      expectedPacketVersion: 1,
      recipient: "+15551234567",
      recipientEntityId: "guest-1",
      calendarPrivacyMode: "times_only",
    });
    await defaultFamilyOperationsAdapter.requestPacketApproval("packet/1", 3);

    expect(calls.map(([path]) => path)).toEqual([
      "/api/lifeops/agreement-uploads",
      "/api/lifeops/agreement-uploads/upload-1/chunks/0",
      "/api/lifeops/agreement-uploads/upload-1/chunks/1",
      "/api/lifeops/agreement-uploads/upload-1/commit",
      "/api/lifeops/family-workflows/packets/packet%2F1/drafts",
      "/api/lifeops/family-workflows/packets/packet%2F1/drafts/3/approval",
    ]);
    expect(JSON.parse(calls[0]?.[1]?.body as string)).toMatchObject({
      originalFilename: "agreement.pdf",
      mimeType: "application/pdf",
      sizeBytes: 8,
    });
    expect(calls[1]?.[1]?.body).toBeInstanceOf(ArrayBuffer);
    expect(calls[2]?.[1]?.body).toBeInstanceOf(ArrayBuffer);
    for (const [, init] of calls.slice(1, 3)) {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(
        "Bearer family-adapter-test-session",
      );
      expect(headers.get("content-type")).toBe("application/octet-stream");
      const hash = await crypto.subtle.digest(
        "SHA-256",
        init?.body as ArrayBuffer,
      );
      expect(headers.get("x-chunk-sha256")).toBe(
        [...new Uint8Array(hash)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
      );
    }
    expect(JSON.parse(calls[3]?.[1]?.body as string)).toEqual({
      contentIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.parse(calls[4]?.[1]?.body as string)).toEqual({
      expectedPacketVersion: 1,
      recipient: "+15551234567",
      recipientEntityId: "guest-1",
      calendarPrivacyMode: "times_only",
    });
  });

  it("uploads a PDF above the former 20 MiB ceiling in bounded chunks", async () => {
    const size = 20 * 1024 * 1024 + 1;
    const chunkSizeBytes = 4 * 1024 * 1024;
    const chunkCount = Math.ceil(size / chunkSizeBytes);
    const fetchMock = vi.fn(async (_input: string | URL | Request) => {
      return new Response(
        JSON.stringify({
          upload: {
            uploadId: "large-upload",
            sizeBytes: size,
            chunkSizeBytes,
            chunkCount,
            receivedChunks: [],
            receivedBytes: 0,
            status: "uploading",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const file = {
      name: "oversized.pdf",
      type: "application/pdf",
      size,
      lastModified: 1,
      slice: (start: number, end: number) => ({
        arrayBuffer: async () => {
          const bytes = new Uint8Array(end - start);
          if (start === 0) bytes.set(new TextEncoder().encode("%PDF-"));
          return bytes.buffer;
        },
      }),
    } as unknown as File;

    await defaultFamilyOperationsAdapter.uploadAgreement({
      agreementKey: "parenting-plan",
      title: "Parenting agreement",
      file,
    });
    expect(
      fetchMock.mock.calls.filter(([path]) =>
        String(path).includes("/chunks/"),
      ),
    ).toHaveLength(chunkCount);
  });

  it("rehashes skipped chunks and rejects a stale resumable upload", async () => {
    const staleBytes = new TextEncoder().encode("old!").buffer;
    const staleHash = await crypto.subtle.digest("SHA-256", staleBytes);
    const staleHashHex = [...new Uint8Array(staleHash)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const file = new File(["%PDF-new"], "agreement.pdf", {
      type: "application/pdf",
      lastModified: 1,
    });
    const resumeKey = `lifeops:agreement-upload:${file.name}:${file.size}:${file.lastModified}:parenting-plan:Parenting agreement`;
    sessionStorage.setItem(resumeKey, "stale-upload");
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            upload: {
              uploadId: "stale-upload",
              sizeBytes: file.size,
              chunkSizeBytes: 4,
              chunkCount: Math.ceil(file.size / 4),
              receivedChunks: [{ index: 0, size: 4, sha256: staleHashHex }],
              receivedBytes: 4,
              status: "uploading",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      defaultFamilyOperationsAdapter.uploadAgreement({
        agreementKey: "parenting-plan",
        title: "Parenting agreement",
        file,
      }),
    ).rejects.toThrow("no longer matches the resumable upload");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(resumeKey)).toBeNull();
  });

  it("rehashes a matching resumed chunk and commits the complete content identity", async () => {
    const file = new File(["%PDF-1.7"], "agreement.pdf", {
      type: "application/pdf",
      lastModified: 1,
    });
    const first = await file.slice(0, 4).arrayBuffer();
    const firstDigest = await crypto.subtle.digest("SHA-256", first);
    const firstSha256 = [...new Uint8Array(firstDigest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const resumeKey = `lifeops:agreement-upload:${file.name}:${file.size}:${file.lastModified}:parenting-plan:Parenting agreement`;
    sessionStorage.setItem(resumeKey, "upload-1");
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = requestPath(input);
        calls.push([path, init]);
        const payload =
          path === "/api/lifeops/agreement-uploads/upload-1"
            ? {
                upload: {
                  uploadId: "upload-1",
                  sizeBytes: file.size,
                  chunkSizeBytes: 4,
                  chunkCount: 2,
                  receivedChunks: [{ index: 0, size: 4, sha256: firstSha256 }],
                  receivedBytes: 4,
                  status: "uploading",
                },
              }
            : { upload: {} };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await defaultFamilyOperationsAdapter.uploadAgreement({
      agreementKey: "parenting-plan",
      title: "Parenting agreement",
      file,
    });

    expect(calls.map(([path]) => path)).toEqual([
      "/api/lifeops/agreement-uploads/upload-1",
      "/api/lifeops/agreement-uploads/upload-1/chunks/1",
      "/api/lifeops/agreement-uploads/upload-1/commit",
    ]);
    expect(JSON.parse(calls[2]?.[1]?.body as string)).toEqual({
      contentIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(sessionStorage.getItem(resumeKey)).toBeNull();
  });

  it("associates drafts and approvals only with their source packet version", async () => {
    const packet = {
      packetId: "packet-1",
      period: {
        key: "2026-08",
        startsOn: "2026-08-01",
        endsOnExclusive: "2026-09-01",
        timeZone: "America/New_York",
      },
      version: 1,
      createdAt: "2026-08-30T12:00:00.000Z",
      sections: [
        {
          section: "school",
          state: "contradictory",
          claimIds: ["a", "b"],
          contradictoryKeys: ["pickup"],
        },
      ],
      claims: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = requestPath(input);
        const payload = path.endsWith("/agreements")
          ? { agreements: [] }
          : path.endsWith("/calendar/links")
            ? { links: [] }
            : path.endsWith("/school/status")
              ? { sourceId: "concord", config: null, lastRun: null }
              : {
                  packets: [{ ...packet, version: 2 }, packet],
                  packetStates: [
                    {
                      packetId: "packet-1",
                      internalVersion: 1,
                      draft: {
                        packetId: "packet-1",
                        internalVersion: 1,
                        draftVersion: 2,
                        recipient: "+15551234567",
                        recipientEntityId: "guest-1",
                        calendarPrivacyMode: "busy_only",
                        includedClaimIds: [],
                        body: "Busy",
                        bodySha256: "hash",
                        transformations: [],
                        createdAt: "2026-08-30T12:01:00.000Z",
                      },
                      approval: null,
                      approvalId: "approval-1",
                    },
                  ],
                };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const loaded = await defaultFamilyOperationsAdapter.load();
    expect(loaded.packets).toMatchObject({
      status: "ready",
      data: [
        { packetId: "packet-1", version: 2, draft: null },
        {
          packetId: "packet-1",
          version: 1,
          sections: packet.sections,
          status: "contradictory",
          draft: {
            draftVersion: 2,
            recipientEntityId: "guest-1",
            approvalId: "approval-1",
          },
        },
      ],
    });
  });

  it("sends the canonical conflict strategy and optimistic-lock timestamp", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ outcome: "clean" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await defaultFamilyOperationsAdapter.resolveCalendarConflict(
      "link/1",
      "keep_eliza",
      "2026-08-30T12:00:00.000Z",
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0];
    expect(requestPath(path)).toBe(
      "/api/lifeops/calendar/links/link%2F1/resolve",
    );
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      strategy: "keep_eliza",
      expectedUpdatedAt: "2026-08-30T12:00:00.000Z",
    });
  });

  it("retains events and supplies the optimistic-lock timestamp on disconnect", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ outcome: "disconnected" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await defaultFamilyOperationsAdapter.disconnectCalendar(
      "link-1",
      "2026-08-30T13:00:00.000Z",
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      retainEvents: true,
      expectedUpdatedAt: "2026-08-30T13:00:00.000Z",
    });
  });
});
