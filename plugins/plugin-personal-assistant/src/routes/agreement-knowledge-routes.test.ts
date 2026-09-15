/**
 * Direct route-boundary tests for the agreement owner surface. The domain
 * service is replaced only to force typed failure/output cases; routing,
 * owner actor selection, and machine-readable HTTP translation are real.
 */

import { createHash, randomUUID } from "node:crypto";
import { ElizaError, type IAgentRuntime, ServiceType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { beginFamilyWorkspaceOperation } from "../lifeops/family-workflows/workspace-operation-store.js";
import { AgreementKnowledgeError } from "../lifeops/household/agreement-knowledge.js";
import { AGREEMENT_UPLOAD_METADATA_BYTES } from "../lifeops/household/agreement-upload-limits.js";
import {
  acceptAgreementChunk,
  beginAgreementUpload,
} from "../lifeops/household/agreement-upload-session.js";
import { handleAgreementKnowledgeRoutes } from "./agreement-knowledge-routes.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

vi.mock("../lifeops/family-workflows/workspace-operation-store.js", () => ({
  beginFamilyWorkspaceOperation: vi.fn(async () => randomUUID()),
  settleFamilyWorkspaceOperation: vi.fn(async () => undefined),
}));

function context(input: {
  method: string;
  pathname: string;
  body?: unknown;
  agreements: Record<string, unknown>;
  fileStorage?: Record<string, unknown>;
  requestEntityId?: string;
}) {
  const responses: Array<{ data: unknown; status: number }> = [];
  const cache = new Map<string, unknown>();
  const runtime = {
    getService: vi.fn((type: string) =>
      type === ServiceType.REMOTE_FILES && input.fileStorage
        ? input.fileStorage
        : { agreements: input.agreements },
    ),
    getCache: vi.fn(async (key: string) => cache.get(key)),
    setCache: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    }),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  const ctx = {
    req: {},
    res: { setHeader: vi.fn() },
    method: input.method,
    pathname: input.pathname,
    url: new URL(`http://localhost${input.pathname}`),
    state: {
      runtime,
      adminEntityId: "self",
      requestEntityId: input.requestEntityId,
    },
    json: (_res: unknown, data: unknown, status = 200) => {
      responses.push({ data, status });
    },
    error: vi.fn(),
    readJsonBody: vi.fn(async () => input.body),
    decodePathComponent: decodeURIComponent,
  } as unknown as LifeOpsRouteContext;
  return { ctx, responses, runtime };
}

describe("agreement knowledge routes", () => {
  it.each([true, false])(
    "returns an owner correction receipt with creation status %s",
    async (created) => {
      const proposal = {
        title: "School",
        obligationText: "Share notices",
        citationText: "Share notices",
        pageStart: 1,
        pageEnd: 1,
      };
      const addOwnerReviewProposal = vi.fn(async () => ({
        obligation: { id: "saved" },
        created,
      }));
      const harness = context({
        method: "POST",
        pathname: "/api/lifeops/agreements/source/obligations",
        body: { ...proposal, ownerEntityId: "untrusted" },
        agreements: { addOwnerReviewProposal },
      });
      await handleAgreementKnowledgeRoutes(harness.ctx);
      expect(addOwnerReviewProposal).toHaveBeenCalledWith({
        artifactId: "source",
        ownerEntityId: "self",
        proposal,
      });
      expect(harness.responses).toEqual([
        {
          status: created ? 201 : 200,
          data: { obligation: { id: "saved" }, created },
        },
      ]);
    },
  );

  it.each([
    ["AGREEMENT_REVIEW_UNAVAILABLE", 503],
    ["AGREEMENT_REVIEW_INVALID", 422],
    ["AGREEMENT_REVIEW_CITATION_INVALID", 422],
  ] as const)(
    "preserves %s as an actionable review failure",
    async (code, status) => {
      const harness = context({
        method: "POST",
        pathname: "/api/lifeops/agreements/document/review",
        agreements: {
          prepareOwnerReview: async () => {
            throw new ElizaError("Retry review", { code });
          },
        },
      });
      await handleAgreementKnowledgeRoutes(harness.ctx);
      expect(harness.responses).toMatchObject([
        { status, data: { error: { code, message: "Retry review" } } },
      ]);
    },
  );

  it.each(["FAMILY_WORKSPACE_FENCED", "FAMILY_OPERATION_UNSETTLED"])(
    "returns %s upload admission failures as conflicts",
    async (code) => {
      const bytes = Buffer.from("%PDF-synthetic route-boundary bytes");
      const sha = createHash("sha256").update(bytes).digest("hex");
      const body = { contentIdentity: "" };
      const harness = context({
        method: "POST",
        pathname: "/api/lifeops/agreement-uploads/pending/commit",
        body,
        fileStorage: {
          storePrivate: async () => ({
            hash: sha,
            fileName: `${sha}.private.bin`,
            size: bytes.length,
            mimeType: "application/octet-stream",
          }),
          readPrivate: async () => bytes,
        },
        agreements: {
          createAgreementVersion: async () => {
            throw new ElizaError("Workspace deletion has begun", {
              code,
            });
          },
        },
      });
      const manifest = await beginAgreementUpload(harness.runtime, {
        agreementKey: "fenced",
        title: "Fenced",
        originalFilename: "fenced.pdf",
        mimeType: "application/pdf",
        sizeBytes: bytes.length,
      });
      await acceptAgreementChunk({
        runtime: harness.runtime,
        uploadId: manifest.uploadId,
        index: 0,
        bytes,
        sha256: sha,
      });
      body.contentIdentity = createHash("sha256")
        .update(
          [
            "agreement-upload-content-v1",
            String(bytes.length),
            String(manifest.chunkSizeBytes),
            `0:${bytes.length}:${sha}`,
          ].join("\n"),
        )
        .digest("hex");
      harness.ctx.pathname = `/api/lifeops/agreement-uploads/${manifest.uploadId}/commit`;
      harness.ctx.url = new URL(`http://localhost${harness.ctx.pathname}`);
      vi.mocked(beginFamilyWorkspaceOperation).mockRejectedValueOnce(
        new ElizaError("Workspace deletion has begun", {
          code,
        }),
      );
      await handleAgreementKnowledgeRoutes(harness.ctx);
      expect(harness.responses).toEqual([
        {
          status: 409,
          data: {
            error: {
              code,
              message: "Workspace deletion has begun",
              context: undefined,
            },
          },
        },
      ]);
      expect(harness.runtime.reportError).not.toHaveBeenCalled();
    },
  );

  it("derives shared reads from the gated session rather than a supplied principal", async () => {
    const readFor = vi.fn(async () => ({ obligations: [] }));
    const harness = context({
      method: "GET",
      pathname:
        "/api/lifeops/agreements/document/shared?principalEntityId=self",
      requestEntityId: "bound-guest",
      agreements: { readFor },
    });
    harness.ctx.pathname = harness.ctx.url.pathname;
    await handleAgreementKnowledgeRoutes(harness.ctx);
    expect(readFor).toHaveBeenCalledWith({
      artifactId: "document",
      principalEntityId: "bound-guest",
    });
    expect(harness.responses[0]).toMatchObject({ status: 200 });
    expect(harness.ctx.res.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "private, no-store, max-age=0",
    );
  });

  it.each([undefined, "self"])(
    "rejects a shared read without a distinct guest principal (%s)",
    async (requestEntityId) => {
      const readFor = vi.fn();
      const harness = context({
        method: "GET",
        pathname: "/api/lifeops/agreements/document/shared",
        requestEntityId,
        agreements: { readFor },
      });
      await handleAgreementKnowledgeRoutes(harness.ctx);
      expect(readFor).not.toHaveBeenCalled();
      expect(harness.responses[0]).toMatchObject({
        status: 403,
        data: { error: { code: "AGREEMENT_ACCESS_DENIED" } },
      });
    },
  );

  it("preserves a revoked grant denial on the shared HTTP read", async () => {
    const harness = context({
      method: "GET",
      pathname: "/api/lifeops/agreements/document/shared",
      requestEntityId: "bound-guest",
      agreements: {
        readFor: async () => {
          throw new AgreementKnowledgeError(
            "Grant revoked",
            "AGREEMENT_ACCESS_DENIED",
          );
        },
      },
    });
    await handleAgreementKnowledgeRoutes(harness.ctx);
    expect(harness.responses[0]).toMatchObject({
      status: 403,
      data: { error: { code: "AGREEMENT_ACCESS_DENIED" } },
    });
  });

  it("creates a resumable owner upload without trusting a page count", async () => {
    const harness = context({
      method: "POST",
      pathname: "/api/lifeops/agreement-uploads",
      body: {
        agreementKey: "parenting-plan",
        title: "Parenting agreement",
        originalFilename: "agreement.pdf",
        mimeType: "application/pdf",
        sizeBytes: 8,
      },
      agreements: {},
    });

    await expect(handleAgreementKnowledgeRoutes(harness.ctx)).resolves.toBe(
      true,
    );
    expect(harness.responses[0]).toMatchObject({
      status: 201,
      data: {
        upload: {
          sizeBytes: 8,
          chunkCount: 1,
          receivedChunkIndexes: [],
          status: "uploading",
        },
      },
    });
  });

  it("does not impose the former 20 MiB document ceiling", async () => {
    const sizeBytes = 20 * 1024 * 1024 + 1;
    const harness = context({
      method: "POST",
      pathname: "/api/lifeops/agreement-uploads",
      body: {
        agreementKey: "parenting-plan",
        title: "Parenting agreement",
        originalFilename: "agreement.pdf",
        mimeType: "application/pdf",
        sizeBytes,
      },
      agreements: {},
    });

    await expect(handleAgreementKnowledgeRoutes(harness.ctx)).resolves.toBe(
      true,
    );
    expect(harness.ctx.readJsonBody).toHaveBeenCalledWith(
      harness.ctx.req,
      harness.ctx.res,
      { maxBytes: AGREEMENT_UPLOAD_METADATA_BYTES },
    );
    expect(harness.responses[0]?.status).toBe(201);
    expect(harness.responses[0]?.data).toMatchObject({
      upload: { sizeBytes, chunkCount: 6 },
    });
  });

  it("returns a stable forbidden error when the domain denies the read", async () => {
    const readFor = vi.fn(async () => {
      throw new AgreementKnowledgeError(
        "The principal has no active grant",
        "AGREEMENT_ACCESS_DENIED",
        { artifactId: "artifact-1" },
      );
    });
    const harness = context({
      method: "GET",
      pathname: "/api/lifeops/agreements/artifact-1",
      agreements: { readFor },
    });
    await expect(handleAgreementKnowledgeRoutes(harness.ctx)).resolves.toBe(
      true,
    );
    expect(harness.responses).toEqual([
      {
        status: 403,
        data: {
          error: {
            code: "AGREEMENT_ACCESS_DENIED",
            message: "The principal has no active grant",
            context: { artifactId: "artifact-1" },
          },
        },
      },
    ]);
  });

  it("returns explicit grant effects and exclusions without issuing a grant", async () => {
    const previewGuestRead = vi.fn(async () => ({
      allowed: false,
      artifactId: "artifact-1",
      principalEntityId: "guest-1",
      householdGrantId: "household-grant-1",
      effects: ["read_artifact_metadata", "read_approved_obligations"],
      exclusions: [
        "read_proposed_or_rejected_obligations",
        "mutate_agreement",
        "inherit_access_from_pin",
      ],
      denial: {
        code: "AGREEMENT_ACCESS_DENIED",
        message: "Guest requires a verified identity",
      },
    }));
    const harness = context({
      method: "POST",
      pathname: "/api/lifeops/agreements/grants/preview",
      body: {
        artifactId: "artifact-1",
        principalEntityId: "guest-1",
        householdGrantId: "household-grant-1",
      },
      agreements: { previewGuestRead },
    });
    await handleAgreementKnowledgeRoutes(harness.ctx);
    expect(previewGuestRead).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      principalEntityId: "guest-1",
      householdGrantId: "household-grant-1",
      ownerEntityId: "self",
    });
    expect(harness.responses[0]).toMatchObject({
      status: 200,
      data: {
        preview: {
          allowed: false,
          exclusions: [
            "read_proposed_or_rejected_obligations",
            "mutate_agreement",
            "inherit_access_from_pin",
          ],
        },
      },
    });
  });
});
