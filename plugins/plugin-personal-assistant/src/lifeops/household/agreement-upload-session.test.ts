/** Tests resumable agreement chunk integrity with deterministic cache and private storage doubles. */

import crypto from "node:crypto";
import type { IAgentRuntime, IFileStorageService } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { AgreementKnowledgeError } from "./agreement-knowledge.js";
import { AGREEMENT_UPLOAD_CHUNK_BYTES } from "./agreement-upload-limits.js";
import {
  acceptAgreementChunk,
  agreementUploadView,
  beginAgreementUpload,
  commitAgreementUpload,
  readAgreementUpload,
} from "./agreement-upload-session.js";

// Admission is a collaborator here; the PGlite suite exercises the real deletion fence.
vi.mock("../family-workflows/workspace-operation-store.js", () => ({
  beginFamilyWorkspaceOperation: vi.fn(async () => crypto.randomUUID()),
  settleFamilyWorkspaceOperation: vi.fn(async () => undefined),
}));

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function contentIdentity(input: {
  sizeBytes: number;
  chunkSizeBytes: number;
  chunks: Array<{ index: number; size: number; sha256: string }>;
}): string {
  const canonical = [
    "agreement-upload-content-v1",
    String(input.sizeBytes),
    String(input.chunkSizeBytes),
    ...[...input.chunks]
      .sort((a, b) => a.index - b.index)
      .map((chunk) => `${chunk.index}:${chunk.size}:${chunk.sha256}`),
  ].join("\n");
  return sha256(Buffer.from(canonical, "utf8"));
}

function harness() {
  const cache = new Map<string, unknown>();
  const privateFiles = new Map<string, Buffer>();
  const fileStorage = {
    storePrivate: vi.fn(async (bytes: Buffer | Uint8Array) => {
      const value = Buffer.from(bytes);
      const hash = sha256(value);
      const fileName = `${hash}.bin`;
      privateFiles.set(fileName, value);
      return {
        hash,
        fileName,
        mimeType: "application/octet-stream",
        size: value.length,
      };
    }),
    readPrivate: vi.fn(
      async (fileName: string) => privateFiles.get(fileName) ?? null,
    ),
    deletePrivate: vi.fn(async (fileName: string) =>
      privateFiles.delete(fileName),
    ),
  } as unknown as IFileStorageService;
  const runtime = {
    getCache: vi.fn(async (key: string) => cache.get(key)),
    setCache: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, structuredClone(value));
      return true;
    }),
    getService: vi.fn(() => fileStorage),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  return { runtime, fileStorage };
}

describe("agreement upload session", () => {
  it("resumes out of order, accepts exact replay, and losslessly reassembles every byte", async () => {
    const { runtime, fileStorage } = harness();
    const first = Buffer.alloc(AGREEMENT_UPLOAD_CHUNK_BYTES, 0x61);
    first.write("%PDF-", 0, "ascii");
    const second = Buffer.from("tail");
    const complete = Buffer.concat([first, second]);
    const manifest = await beginAgreementUpload(runtime, {
      agreementKey: "parenting-plan",
      title: "Parenting agreement",
      originalFilename: "agreement.pdf",
      mimeType: "application/pdf",
      sizeBytes: complete.length,
    });

    await acceptAgreementChunk({
      runtime,
      uploadId: manifest.uploadId,
      index: 1,
      bytes: second,
      sha256: sha256(second),
    });
    await acceptAgreementChunk({
      runtime,
      uploadId: manifest.uploadId,
      index: 0,
      bytes: first,
      sha256: sha256(first),
    });
    await acceptAgreementChunk({
      runtime,
      uploadId: manifest.uploadId,
      index: 0,
      bytes: first,
      sha256: sha256(first),
    });

    const resumed = await readAgreementUpload(runtime, manifest.uploadId);
    expect(resumed.chunks.map((chunk) => chunk.index).sort()).toEqual([0, 1]);
    expect(fileStorage.storePrivate).toHaveBeenCalledTimes(2);
    const identity = contentIdentity({
      sizeBytes: complete.length,
      chunkSizeBytes: manifest.chunkSizeBytes,
      chunks: [
        { index: 0, size: first.length, sha256: sha256(first) },
        { index: 1, size: second.length, sha256: sha256(second) },
      ],
    });
    const createArtifact = vi.fn(async ({ bytes }: { bytes: Buffer }) => {
      expect(bytes).toEqual(complete);
      return { id: "artifact-1" };
    });
    const readArtifact = vi.fn(async (id: string) => ({ id }));
    const committed = await commitAgreementUpload({
      runtime,
      uploadId: manifest.uploadId,
      contentIdentity: identity,
      expectedSha256: sha256(complete),
      createArtifact,
      readArtifact,
    });
    expect(committed).toEqual({
      artifact: { id: "artifact-1" },
      created: true,
    });
    expect(fileStorage.deletePrivate).toHaveBeenCalledTimes(2);
    await expect(
      readAgreementUpload(runtime, manifest.uploadId),
    ).resolves.toMatchObject({
      status: "complete",
      artifactId: "artifact-1",
      chunks: [{ index: 1 }, { index: 0 }],
    });
    expect(agreementUploadView(resumed).receivedChunks).toEqual([
      { index: 0, size: first.length, sha256: sha256(first) },
      { index: 1, size: second.length, sha256: sha256(second) },
    ]);
  });

  it("rejects missing, wrong-size, and hash-mismatched chunks without partial success", async () => {
    const { runtime } = harness();
    const manifest = await beginAgreementUpload(runtime, {
      agreementKey: "parenting-plan",
      title: "Parenting agreement",
      originalFilename: "agreement.pdf",
      mimeType: "application/pdf",
      sizeBytes: AGREEMENT_UPLOAD_CHUNK_BYTES + 1,
    });
    const wrong = Buffer.from("wrong");
    await expect(
      acceptAgreementChunk({
        runtime,
        uploadId: manifest.uploadId,
        index: 0,
        bytes: wrong,
        sha256: sha256(wrong),
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_INVALID_CONTRACT" });
    const first = Buffer.alloc(AGREEMENT_UPLOAD_CHUNK_BYTES, 0x61);
    await expect(
      acceptAgreementChunk({
        runtime,
        uploadId: manifest.uploadId,
        index: 0,
        bytes: first,
        sha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_INVALID_CONTRACT" });
    await expect(
      commitAgreementUpload({
        runtime,
        uploadId: manifest.uploadId,
        contentIdentity: "0".repeat(64),
        createArtifact: vi.fn(),
        readArtifact: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_INVALID_CONTRACT" });
  });

  it("serializes concurrent chunk mutations without losing either verified range", async () => {
    const { runtime } = harness();
    const first = Buffer.alloc(AGREEMENT_UPLOAD_CHUNK_BYTES, 0x61);
    const second = Buffer.from("tail");
    const manifest = await beginAgreementUpload(runtime, {
      agreementKey: "parenting-plan",
      title: "Parenting agreement",
      originalFilename: "agreement.pdf",
      mimeType: "application/pdf",
      sizeBytes: first.length + second.length,
    });

    await Promise.all([
      acceptAgreementChunk({
        runtime,
        uploadId: manifest.uploadId,
        index: 0,
        bytes: first,
        sha256: sha256(first),
      }),
      acceptAgreementChunk({
        runtime,
        uploadId: manifest.uploadId,
        index: 1,
        bytes: second,
        sha256: sha256(second),
      }),
    ]);

    const resumed = await readAgreementUpload(runtime, manifest.uploadId);
    expect(agreementUploadView(resumed).receivedChunks).toEqual([
      { index: 0, size: first.length, sha256: sha256(first) },
      { index: 1, size: second.length, sha256: sha256(second) },
    ]);
  });

  it("serializes concurrent commits and returns the completed artifact on retries", async () => {
    const { runtime } = harness();
    const bytes = Buffer.from("%PDF-complete");
    const manifest = await beginAgreementUpload(runtime, {
      agreementKey: "parenting-plan",
      title: "Parenting agreement",
      originalFilename: "agreement.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.length,
    });
    await acceptAgreementChunk({
      runtime,
      uploadId: manifest.uploadId,
      index: 0,
      bytes,
      sha256: sha256(bytes),
    });
    const identity = contentIdentity({
      sizeBytes: bytes.length,
      chunkSizeBytes: manifest.chunkSizeBytes,
      chunks: [{ index: 0, size: bytes.length, sha256: sha256(bytes) }],
    });
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const createArtifact = vi.fn(async () => {
      await createGate;
      return { id: "artifact-concurrent" };
    });
    const readArtifact = vi.fn(async (id: string) => ({ id }));
    const commit = () =>
      commitAgreementUpload({
        runtime,
        uploadId: manifest.uploadId,
        contentIdentity: identity,
        createArtifact,
        readArtifact,
      });

    const first = commit();
    const second = commit();
    releaseCreate();
    await expect(first).resolves.toEqual({
      artifact: { id: "artifact-concurrent" },
      created: true,
    });
    await expect(second).resolves.toEqual({
      artifact: { id: "artifact-concurrent" },
      created: false,
    });
    await expect(commit()).resolves.toEqual({
      artifact: { id: "artifact-concurrent" },
      created: false,
    });
    expect(createArtifact).toHaveBeenCalledTimes(1);
    expect(readArtifact).toHaveBeenCalledTimes(2);
  });

  it("returns an existing artifact when identical agreement content is already committed", async () => {
    const { runtime } = harness();
    const bytes = Buffer.from("%PDF-recovered");
    const manifest = await beginAgreementUpload(runtime, {
      agreementKey: "parenting-plan",
      title: "Parenting agreement",
      originalFilename: "agreement.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.length,
    });
    await acceptAgreementChunk({
      runtime,
      uploadId: manifest.uploadId,
      index: 0,
      bytes,
      sha256: sha256(bytes),
    });
    const identity = contentIdentity({
      sizeBytes: bytes.length,
      chunkSizeBytes: manifest.chunkSizeBytes,
      chunks: [{ index: 0, size: bytes.length, sha256: sha256(bytes) }],
    });
    const createArtifact = vi.fn(async () => {
      throw new AgreementKnowledgeError(
        "Already created",
        "AGREEMENT_DUPLICATE_CONTENT",
        { artifactId: "artifact-recovered" },
      );
    });
    const readArtifact = vi.fn(async (id: string) => ({ id }));

    await expect(
      commitAgreementUpload({
        runtime,
        uploadId: manifest.uploadId,
        contentIdentity: identity,
        createArtifact,
        readArtifact,
      }),
    ).resolves.toEqual({
      artifact: { id: "artifact-recovered" },
      created: false,
    });
    await expect(
      readAgreementUpload(runtime, manifest.uploadId),
    ).resolves.toMatchObject({
      status: "complete",
      artifactId: "artifact-recovered",
    });
  });

  it("requires the exact ordered chunk content identity before committing", async () => {
    const { runtime } = harness();
    const bytes = Buffer.from("%PDF-content-identity");
    const manifest = await beginAgreementUpload(runtime, {
      agreementKey: "parenting-plan",
      title: "Parenting agreement",
      originalFilename: "agreement.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.length,
    });
    await acceptAgreementChunk({
      runtime,
      uploadId: manifest.uploadId,
      index: 0,
      bytes,
      sha256: sha256(bytes),
    });

    await expect(
      commitAgreementUpload({
        runtime,
        uploadId: manifest.uploadId,
        contentIdentity: sha256(Buffer.from("wrong")),
        createArtifact: vi.fn(),
        readArtifact: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_INVALID_CONTRACT" });
    await expect(
      readAgreementUpload(runtime, manifest.uploadId),
    ).resolves.toMatchObject({ status: "uploading", artifactId: null });
  });
});
