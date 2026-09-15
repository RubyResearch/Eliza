/**
 * Exercises registered owner HTTP intake with real AgentRuntime, DocumentService
 * and PGlite storage. A deterministic extraction model makes no external calls;
 * its complete input, private proposal and owner review are verified separately.
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { AuthStore } from "@elizaos/app-core/services/auth-store";
import {
  DocumentService,
  ModelType,
  type Plugin,
  resolveOwnerEntityIdOrDefault,
  TrajectoriesService,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { tryHandleRuntimePluginRoute } from "../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";

it("selects a canonical source, extracts private proposals and preserves review/withdrawal across HTTP retries", async () => {
  let prompt = "";
  let modelOutput = "";
  let malformedOutput = false;
  let extractionCalls = 0;
  const quote = "Please confirm pickup at 3 PM.";
  const complete = `${"Earlier correspondence.\n".repeat(8000)}${quote}`;
  const model: Plugin = {
    name: "family-intake-deterministic-extraction",
    description:
      "Deterministic extraction collaborator for HTTP contract testing",
    models: {
      [ModelType.TEXT_LARGE]: async (_runtime, params) => {
        extractionCalls += 1;
        prompt = params.prompt;
        if (malformedOutput) return "invalid synthetic model JSON";
        modelOutput = JSON.stringify({
          facts: [
            {
              section: "unanswered",
              statement: quote,
              sourceQuote: quote,
              dates: [],
              requests: ["Confirm pickup"],
              commitments: [],
              accountability: [],
              urgency: null,
              unanswered: true,
            },
          ],
        });
        return modelOutput;
      },
    },
  };
  const host = await createLifeOpsTestRuntime({ plugins: [model] });
  const runtime = host.runtime;
  runtime.setSetting("ELIZA_TRAJECTORY_LOGGING", "1");
  if (!runtime.getService("trajectories"))
    await runtime.registerService(TrajectoriesService);
  await runtime.getServiceLoadPromise("trajectories");
  const trajectories = runtime.getService<TrajectoriesService>("trajectories");
  if (!trajectories) throw new Error("Trajectory service unavailable");
  const owner = resolveOwnerEntityIdOrDefault(runtime);
  const documents = runtime.getService<DocumentService>(
    DocumentService.serviceType,
  );
  if (!documents) throw new Error("Canonical documents failed to initialize");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      url,
      pathname: url.pathname,
      method: req.method ?? "GET",
      runtime,
      isAuthorized: () => req.headers.authorization === "Bearer owner-test",
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  try {
    const database = runtime.adapter.db;
    if (!database) throw new Error("Runtime auth database unavailable");
    const auth = new AuthStore(
      database as ConstructorParameters<typeof AuthStore>[0],
    );
    const now = Date.now();
    const identity = await auth.createIdentity({
      id: randomUUID(),
      kind: "owner",
      displayName: "Synthetic owner",
      createdAt: now,
      passwordHash: null,
      cloudUserId: null,
    });
    await auth.createSession({
      id: "owner-test",
      identityId: identity.id,
      kind: "browser",
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + 3600000,
      rememberDevice: false,
      csrfSecret: randomUUID(),
      ip: null,
      userAgent: null,
      scopes: [],
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No HTTP listener");
    const base = `http://127.0.0.1:${address.port}/api/lifeops/family-workflows/intake`;
    const headers = {
      authorization: "Bearer owner-test",
      "content-type": "application/json",
    };
    const post = (suffix: string, body: object, authorized = true) =>
      fetch(`${base}${suffix}`, {
        method: "POST",
        headers: authorized ? headers : { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const importInput = {
      id: randomUUID(),
      periodKey: "2026-10",
      title: "Selected pickup request",
      text: complete,
    };
    expect((await post("/import", importInput, false)).status).toBe(401);
    const importedResponse = await post("/import", importInput);
    expect(importedResponse.status, await importedResponse.clone().text()).toBe(
      201,
    );
    const { review: imported } = await importedResponse.json();
    const privateSource = await documents.getDocumentByIdWithAccessContext(
      imported.source.documentId,
      {
        requesterEntityId: owner,
        role: "OWNER",
        isOwner: true,
      },
    );
    expect(privateSource?.content.text).toBe(complete);
    const guestSource = await documents.getDocumentByIdWithAccessContext(
      imported.source.documentId,
      {
        requesterEntityId: randomUUID(),
        role: "GUEST",
        isOwner: false,
      },
    );
    expect(guestSource).toBeNull();
    expect((await (await post("/import", importInput)).json()).review).toEqual(
      imported,
    );
    expect(
      (
        await post("/import", {
          ...importInput,
          text: "Changed correspondence",
        })
      ).status,
    ).toBe(409);
    const selection = {
      id: imported.id,
      periodKey: imported.periodKey,
      documentId: imported.source.documentId,
    };
    expect((await post("", selection, false)).status).toBe(401);
    const spoofedActor = await post("", {
      ...selection,
      selectedByEntityId: randomUUID(),
    });
    expect(spoofedActor.status, await spoofedActor.clone().text()).toBe(400);
    const response = await post("", selection);
    expect(response.status, await response.clone().text()).toBe(201);
    const { review: selected } = await response.json();
    expect((await (await post("", selection)).json()).review).toEqual(selected);
    const extraction = await post(`/${selected.id}/extract`, {
      expectedRevision: selected.revision,
    });
    expect(extraction.status, await extraction.clone().text()).toBe(200);
    const { review: proposed } = await extraction.json();
    expect(prompt).toContain(JSON.stringify(complete));
    expect(proposed.facts[0].sourceQuote).toBe(quote);
    expect(proposed.facts[0].recipientEntityIds).toEqual([]);
    const recorded = (
      await trajectories.listTrajectories({ source: "lifeops.family-intake" })
    ).trajectories.filter((entry) => entry.metadata.intakeId === selected.id);
    expect(recorded).toHaveLength(1);
    const entry = recorded[0];
    if (!entry) throw new Error("Intake extraction was not recorded");
    expect(entry.status).toBe("completed");
    expect(entry.metadata).toMatchObject({
      intakeId: selected.id,
      reviewRevision: selected.revision,
      sourceSha256: selected.source.contentSha256,
    });
    const detail = await trajectories.getTrajectoryDetail(entry.id);
    if (!detail) throw new Error("Intake trajectory cannot be read");
    const calls = detail.steps.flatMap((step) => step.llmCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userPrompt).toBe(prompt);
    expect(calls[0]?.response).toBe(modelOutput);

    const recipientResponse = await fetch(
      `${base.replace(/\/intake$/u, "")}/email-recipients/confirm`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          entityId: null,
          name: "Synthetic recipient",
          address: "recipient@example.test",
          confirmed: true,
        }),
      },
    );
    expect(
      recipientResponse.status,
      await recipientResponse.clone().text(),
    ).toBe(200);
    const { recipient: confirmedRecipient } = await recipientResponse.json();
    const recipient = confirmedRecipient.entityId;
    for (const invalidRecipient of ["", "bad\nidentity", "x".repeat(513)]) {
      const invalidReview = await post(`/${selected.id}/review`, {
        expectedRevision: proposed.revision,
        facts: proposed.facts.map((fact: Record<string, unknown>) => ({
          ...fact,
          recipientEntityIds: [invalidRecipient],
        })),
      });
      expect(invalidReview.status).toBe(400);
    }
    const reviewedResponse = await post(`/${selected.id}/review`, {
      expectedRevision: proposed.revision,
      facts: proposed.facts.map((fact: Record<string, unknown>) => ({
        ...fact,
        recipientEntityIds: [recipient],
      })),
    });
    expect(reviewedResponse.status, await reviewedResponse.clone().text()).toBe(
      200,
    );
    const { review: reviewed } = await reviewedResponse.json();
    const excludedResponse = await post(`/${selected.id}/review`, {
      expectedRevision: reviewed.revision,
      facts: [],
    });
    expect(excludedResponse.status).toBe(200);
    const { review: excluded } = await excludedResponse.json();
    const detailsResponse = await fetch(`${base}?period=2026-10`, { headers });
    const { sources } = await detailsResponse.json();
    expect(sources[0]).toMatchObject({
      title: "Selected pickup request",
      sourceStatus: { state: "ready" },
      excludedFactIds: [proposed.facts[0].id],
    });
    expect(sources[0].factsForReview[0]).toMatchObject({
      sourceQuote: quote,
      recipientEntityIds: [],
    });
    const restoredResponse = await post(`/${selected.id}/review`, {
      expectedRevision: excluded.revision,
      facts: sources[0].factsForReview.map((fact: Record<string, unknown>) => ({
        ...fact,
        recipientEntityIds: [recipient],
      })),
    });
    expect(restoredResponse.status).toBe(200);
    const { review: restored } = await restoredResponse.json();
    const withdrawnResponse = await post(`/${selected.id}/withdraw`, {
      expectedRevision: restored.revision,
    });
    expect(withdrawnResponse.status).toBe(200);
    const { review: withdrawn } = await withdrawnResponse.json();
    const listed = await fetch(`${base}?period=2026-10`, { headers });
    expect((await listed.json()).reviews).toEqual([withdrawn]);
    const stale = await post(`/${selected.id}/review`, {
      expectedRevision: reviewed.revision,
      facts: [],
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe(
      "FAMILY_INTAKE_REVIEW_CONFLICT",
    );
    expect((await (await post("", selection)).json()).review).toEqual(
      withdrawn,
    );
    const priorExtractionCalls = extractionCalls;
    const noUpdates = {
      id: randomUUID(),
      periodKey: "2026-10",
      section: "school",
      answer: { kind: "no_additional_updates" },
      recipientEntityIds: [],
    };
    expect((await post("/interview", noUpdates, false)).status).toBe(401);
    expect(
      (await post("/interview", { ...noUpdates, actorEntityId: owner })).status,
    ).toBe(400);
    expect(
      (
        await post("/interview", {
          ...noUpdates,
          section: "approved_obligations",
        })
      ).status,
    ).toBe(400);
    const answeredResponse = await post("/interview", noUpdates);
    expect(answeredResponse.status, await answeredResponse.clone().text()).toBe(
      201,
    );
    const { review: answered } = await answeredResponse.json();
    expect(answered).toMatchObject({
      status: "reviewed",
      selectedByEntityId: owner,
      reviewedByEntityId: owner,
      facts: [{ section: "school", unanswered: false, recipientEntityIds: [] }],
    });
    const source = await documents.getDocumentByIdWithAccessContext(
      answered.source.documentId,
      { requesterEntityId: owner, role: "OWNER", isOwner: true },
    );
    expect(source?.content.text).toContain(answered.facts[0].sourceQuote);
    expect(source?.content.text).toContain('"kind":"no_additional_updates"');
    expect(
      await documents.getDocumentByIdWithAccessContext(
        answered.source.documentId,
        { requesterEntityId: randomUUID(), role: "GUEST", isOwner: false },
      ),
    ).toBeNull();
    const repeated = await post("/interview", noUpdates);
    expect(repeated.status).toBe(201);
    expect((await repeated.json()).review).toEqual(answered);
    expect(
      (await post("/interview", { ...noUpdates, recipientEntityIds: [owner] }))
        .status,
    ).toBe(409);
    expect(
      (
        await post("/interview", {
          ...noUpdates,
          answer: {
            kind: "update",
            text: "New school update",
            unanswered: false,
          },
        })
      ).status,
    ).toBe(409);
    const update = await post("/interview", {
      id: randomUUID(),
      periodKey: "2026-10",
      section: "unanswered",
      answer: {
        kind: "update",
        text: "Please confirm next month's pickup arrangement.",
        unanswered: true,
      },
      recipientEntityIds: [recipient],
    });
    expect(update.status, await update.clone().text()).toBe(201);
    const openRequest = (await update.json()).review;
    expect(openRequest).toMatchObject({
      status: "reviewed",
      facts: [
        {
          unanswered: true,
          recipientEntityIds: [recipient],
          statement: "Please confirm next month's pickup arrangement.",
        },
      ],
    });
    const decisionPath = `/${openRequest.id}/request-decision`;
    const resolution = {
      expectedRevision: openRequest.revision,
      decision: {
        operationId: randomUUID(),
        factId: openRequest.facts[0].id,
        state: "resolved",
        reason: "Pickup confirmation was received.",
      },
    };
    expect((await post(decisionPath, resolution, false)).status).toBe(401);
    expect(
      (await post(decisionPath, { ...resolution, reviewerEntityId: owner }))
        .status,
    ).toBe(400);
    const resolvedResponse = await post(decisionPath, resolution);
    expect(resolvedResponse.status, await resolvedResponse.clone().text()).toBe(
      200,
    );
    const resolved = (await resolvedResponse.json()).review;
    expect(resolved.facts[0].unanswered).toBe(false);
    expect(resolved.requestDecision).toEqual(resolution.decision);
    expect(
      (await (await post(decisionPath, resolution)).json()).review,
    ).toEqual(resolved);
    expect(
      (
        await post(decisionPath, {
          ...resolution,
          decision: {
            ...resolution.decision,
            reason: "Changed retry payload",
          },
        })
      ).status,
    ).toBe(409);
    const reopenedResponse = await post(decisionPath, {
      expectedRevision: resolved.revision,
      decision: {
        ...resolution.decision,
        operationId: randomUUID(),
        state: "open",
        reason: "The pickup plan changed again.",
      },
    });
    expect(reopenedResponse.status).toBe(200);
    const reopened = (await reopenedResponse.json()).review;
    expect(reopened.facts[0].unanswered).toBe(true);
    const laterEdit = await post(`/${openRequest.id}/review`, {
      expectedRevision: reopened.revision,
      facts: reopened.facts.map((fact: { statement: string }) => ({
        ...fact,
        statement: "Please confirm the revised pickup arrangement.",
      })),
    });
    expect(laterEdit.status).toBe(200);
    const packetUrl = new URL("../packets", `${base}/`);
    const generate = (body: object) =>
      fetch(packetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    expect((await generate({ periodKey: "2027-13" })).status).toBe(400);
    expect((await generate({ periodKey: "2027-03", period: {} })).status).toBe(
      400,
    );
    const futurePacketResponse = await generate({ periodKey: "2027-03" });
    expect(
      futurePacketResponse.status,
      await futurePacketResponse.clone().text(),
    ).toBe(200);
    const futurePacket = await futurePacketResponse.json();
    expect(futurePacket.period).toMatchObject({
      key: "2027-03",
      startsOn: "2027-03-01",
      endsOnExclusive: "2027-04-01",
    });
    expect(futurePacket.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          statement: "Please confirm the revised pickup arrangement.",
          unanswered: true,
        }),
      ]),
    );
    const storedPacketResponse = await fetch(
      new URL(
        `../packets/${encodeURIComponent(futurePacket.packetId)}`,
        `${base}/`,
      ),
      { headers },
    );
    expect(storedPacketResponse.status).toBe(200);
    expect(await storedPacketResponse.json()).toEqual(futurePacket);
    const futureInventoryResponse = await fetch(`${base}?period=2027-03`, {
      headers,
    });
    expect(futureInventoryResponse.status).toBe(200);
    const futureInventory = await futureInventoryResponse.json();
    const requestSource = futureInventory.sources.find(
      (source: { review: { id: string } }) =>
        source.review.id === openRequest.id,
    );
    expect(
      requestSource.requestHistory.map(
        (entry: { state: string; reason: string }) => ({
          state: entry.state,
          reason: entry.reason,
        }),
      ),
    ).toEqual([
      { state: "resolved", reason: "Pickup confirmation was received." },
      { state: "open", reason: "The pickup plan changed again." },
    ]);
    expect(
      futureInventory.sources.some(
        (source: { review: { id: string } }) =>
          source.review.id === openRequest.id,
      ),
    ).toBe(true);
    expect(
      futureInventory.sources.some(
        (source: { review: { id: string } }) =>
          source.review.id === answered.id,
      ),
    ).toBe(false);
    const previousInventoryResponse = await fetch(`${base}?period=2026-09`, {
      headers,
    });
    expect(previousInventoryResponse.status).toBe(200);
    expect((await previousInventoryResponse.json()).sources).toEqual([]);
    expect(extractionCalls).toBe(priorExtractionCalls);
    expect(
      (
        await post(`/${answered.id}/withdraw`, {
          expectedRevision: answered.revision,
        })
      ).status,
    ).toBe(200);
    expect((await post("/interview", noUpdates)).status).toBe(409);
    malformedOutput = true;
    const failedImport = await post("/import", {
      id: randomUUID(),
      periodKey: "2026-12",
      title: "Synthetic malformed extraction",
      text: "Please confirm the December pickup time.",
    });
    expect(failedImport.status).toBe(201);
    const failedSelection = (await failedImport.json()).review;
    const failedExtraction = await post(`/${failedSelection.id}/extract`, {
      expectedRevision: failedSelection.revision,
    });
    expect(failedExtraction.status).toBe(400);
    expect((await failedExtraction.json()).error.code).toBe(
      "FAMILY_INTAKE_EXTRACTION_INVALID",
    );
    const failedRecords = (
      await trajectories.listTrajectories({ source: "lifeops.family-intake" })
    ).trajectories.filter(
      (entry) => entry.metadata.intakeId === failedSelection.id,
    );
    expect(failedRecords).toHaveLength(1);
    const failedEntry = failedRecords[0];
    if (!failedEntry) throw new Error("Failed extraction has no trajectory");
    expect(failedEntry.status).toBe("error");
    const failedDetail = await trajectories.getTrajectoryDetail(failedEntry.id);
    if (!failedDetail) throw new Error("Failed extraction detail unavailable");
    expect(
      failedDetail.steps
        .flatMap((step) => step.llmCalls)
        .map((call) => call.response),
    ).toEqual(["invalid synthetic model JSON"]);
    const failedReadback = await fetch(`${base}?period=2026-12`, { headers });
    expect(
      (await failedReadback.json()).reviews.find(
        (review: { id: string }) => review.id === failedSelection.id,
      ),
    ).toEqual(failedSelection);
    for (const text of [
      "Concurrent synthetic audience decisions",
      "SGVsbG8gV29ybGQh",
      "  Literal source with surrounding whitespace.\n",
    ]) {
      const literalInput = {
        id: randomUUID(),
        periodKey: "2027-01",
        title: "Literal selected source",
        text,
      };
      const response = await post("/import", literalInput);
      expect(response.status, await response.clone().text()).toBe(201);
      const selectedLiteral = (await response.json()).review;
      const savedLiteral = await documents.getDocumentByIdWithAccessContext(
        selectedLiteral.source.documentId,
        { requesterEntityId: owner, role: "OWNER", isOwner: true },
      );
      expect(savedLiteral?.content.text).toBe(text);
      expect(
        (await (await post("/import", literalInput)).json()).review,
      ).toEqual(selectedLiteral);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await host.cleanup();
  }
}, 180_000);
