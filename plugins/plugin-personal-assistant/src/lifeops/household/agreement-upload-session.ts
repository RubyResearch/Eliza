/**
 * Durable resumable agreement-upload manifests backed by the runtime cache and
 * canonical private file storage. Bounded chunks are verified independently,
 * then reassembled in order and full-hash verified before PDF ingestion.
 */

import crypto from "node:crypto";
import {
  type IAgentRuntime,
  type IFileStorageService,
  ServiceType,
} from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import {
  beginFamilyWorkspaceOperation,
  type FamilyWorkspaceOperationTarget,
  settleFamilyWorkspaceOperation,
} from "../family-workflows/workspace-operation-store.js";
import {
  AgreementKnowledgeError,
  AgreementSourceUnchangedError,
} from "./agreement-knowledge.js";
import { AGREEMENT_UPLOAD_CHUNK_BYTES } from "./agreement-upload-limits.js";

interface UploadChunk {
  index: number;
  size: number;
  sha256: string;
  fileName: string;
}

export interface AgreementUploadManifest {
  uploadId: string;
  ownerEntityId: string;
  agreementKey: string;
  title: string;
  originalFilename: string;
  mimeType: "application/pdf";
  sizeBytes: number;
  chunkSizeBytes: number;
  chunkCount: number;
  chunks: UploadChunk[];
  status: "uploading" | "committing" | "complete";
  artifactId: string | null;
}

const CACHE_PREFIX = "lifeops:agreement-upload:v1:";
const uploadMutationTails = new Map<string, Promise<void>>();

function key(uploadId: string): string {
  return `${CACHE_PREFIX}${uploadId}`;
}

async function withUploadMutationLock<T>(
  uploadId: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = uploadMutationTails.get(uploadId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  uploadMutationTails.set(uploadId, tail);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (uploadMutationTails.get(uploadId) === tail) {
      uploadMutationTails.delete(uploadId);
    }
  }
}

async function withStagedUploadMutation<T>(
  runtime: IAgentRuntime,
  target: Exclude<FamilyWorkspaceOperationTarget, { kind: "agreement-upload" }>,
  mutate: () => Promise<T>,
): Promise<T> {
  const operationId = await beginFamilyWorkspaceOperation(runtime, target);
  try {
    const result = await mutate();
    await settleFamilyWorkspaceOperation(runtime, operationId);
    return result;
  } catch (cause) {
    // error-policy:J2 Persistence may have committed before its acknowledgement failed; retain the claim.
    const failure = new AgreementKnowledgeError(
      "Upload persistence needs reconciliation before retrying or deleting its sources.",
      "AGREEMENT_INGESTION_RECONCILIATION_REQUIRED",
      { operationId, target },
      cause,
    );
    runtime.reportError("AgreementUpload.mutation", failure);
    throw failure;
  }
}

function files(runtime: IAgentRuntime): IFileStorageService {
  const service = runtime.getService<IFileStorageService>(
    ServiceType.REMOTE_FILES,
  );
  if (!service) {
    throw new AgreementKnowledgeError(
      "Private file storage is unavailable",
      "AGREEMENT_STORAGE_UNAVAILABLE",
    );
  }
  return service;
}

async function save(
  runtime: IAgentRuntime,
  manifest: AgreementUploadManifest,
): Promise<void> {
  if (!(await runtime.setCache(key(manifest.uploadId), manifest))) {
    throw new AgreementKnowledgeError(
      "Agreement upload manifest could not be persisted",
      "AGREEMENT_STORAGE_UNAVAILABLE",
    );
  }
}

export async function readAgreementUpload(
  runtime: IAgentRuntime,
  uploadId: string,
): Promise<AgreementUploadManifest> {
  const manifest = await runtime.getCache<AgreementUploadManifest>(
    key(uploadId),
  );
  if (!manifest) {
    throw new AgreementKnowledgeError(
      "Agreement upload was not found",
      "AGREEMENT_ARTIFACT_NOT_FOUND",
      { uploadId },
    );
  }
  if (manifest.ownerEntityId !== SELF_ENTITY_ID) {
    throw new AgreementKnowledgeError(
      "Agreement upload belongs to another principal",
      "AGREEMENT_ACCESS_DENIED",
      { uploadId },
    );
  }
  return manifest;
}

export function agreementUploadView(manifest: AgreementUploadManifest) {
  const chunks = [...manifest.chunks].sort((a, b) => a.index - b.index);
  return {
    uploadId: manifest.uploadId,
    sizeBytes: manifest.sizeBytes,
    chunkSizeBytes: manifest.chunkSizeBytes,
    chunkCount: manifest.chunkCount,
    receivedChunks: chunks.map(({ index, size, sha256 }) => ({
      index,
      size,
      sha256,
    })),
    receivedChunkIndexes: chunks.map((chunk) => chunk.index),
    receivedBytes: chunks.reduce((sum, chunk) => sum + chunk.size, 0),
    status: manifest.status,
    artifactId: manifest.artifactId,
  };
}

export async function beginAgreementUpload(
  runtime: IAgentRuntime,
  metadata: Omit<
    AgreementUploadManifest,
    | "uploadId"
    | "ownerEntityId"
    | "mimeType"
    | "chunkSizeBytes"
    | "chunkCount"
    | "chunks"
    | "status"
    | "artifactId"
  > & { mimeType: string },
): Promise<AgreementUploadManifest> {
  if (!Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 1) {
    throw new AgreementKnowledgeError(
      "sizeBytes must be a positive safe integer",
      "AGREEMENT_INVALID_CONTRACT",
    );
  }
  if (metadata.mimeType.trim().toLowerCase() !== "application/pdf") {
    throw new AgreementKnowledgeError(
      "Parenting agreements must be uploaded as PDF bytes",
      "AGREEMENT_INVALID_CONTRACT",
    );
  }
  const manifest: AgreementUploadManifest = {
    uploadId: `hagu_${crypto.randomUUID()}`,
    ownerEntityId: SELF_ENTITY_ID,
    agreementKey: metadata.agreementKey,
    title: metadata.title,
    originalFilename: metadata.originalFilename,
    mimeType: "application/pdf",
    sizeBytes: metadata.sizeBytes,
    chunkSizeBytes: AGREEMENT_UPLOAD_CHUNK_BYTES,
    chunkCount: Math.ceil(metadata.sizeBytes / AGREEMENT_UPLOAD_CHUNK_BYTES),
    chunks: [],
    status: "uploading",
    artifactId: null,
  };
  return withStagedUploadMutation(
    runtime,
    { kind: "agreement-upload-begin", uploadId: manifest.uploadId },
    async () => {
      await save(runtime, manifest);
      return manifest;
    },
  );
}

export async function acceptAgreementChunk(input: {
  runtime: IAgentRuntime;
  uploadId: string;
  index: number;
  bytes: Buffer;
  sha256: string;
}): Promise<AgreementUploadManifest> {
  return await withUploadMutationLock(input.uploadId, async () => {
    return await acceptAgreementChunkUnlocked(input);
  });
}

async function acceptAgreementChunkUnlocked(input: {
  runtime: IAgentRuntime;
  uploadId: string;
  index: number;
  bytes: Buffer;
  sha256: string;
}): Promise<AgreementUploadManifest> {
  const manifest = await readAgreementUpload(input.runtime, input.uploadId);
  if (manifest.status !== "uploading") {
    throw new AgreementKnowledgeError(
      "Agreement upload is not accepting chunks",
      "AGREEMENT_OBLIGATION_CONFLICT",
    );
  }
  if (
    !Number.isSafeInteger(input.index) ||
    input.index < 0 ||
    input.index >= manifest.chunkCount
  ) {
    throw new AgreementKnowledgeError(
      "Chunk index is outside the upload manifest",
      "AGREEMENT_INVALID_CONTRACT",
    );
  }
  const expectedSize = Math.min(
    manifest.chunkSizeBytes,
    manifest.sizeBytes - input.index * manifest.chunkSizeBytes,
  );
  if (input.bytes.length !== expectedSize) {
    throw new AgreementKnowledgeError(
      "Chunk size does not match its exact range",
      "AGREEMENT_INVALID_CONTRACT",
      { index: input.index, expectedSize, actualSize: input.bytes.length },
    );
  }
  const sha256 = crypto.createHash("sha256").update(input.bytes).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(input.sha256) || sha256 !== input.sha256) {
    throw new AgreementKnowledgeError(
      "Chunk SHA-256 does not match its bytes",
      "AGREEMENT_INVALID_CONTRACT",
      { index: input.index },
    );
  }
  const existing = manifest.chunks.find((chunk) => chunk.index === input.index);
  if (existing) {
    if (existing.sha256 !== sha256) {
      throw new AgreementKnowledgeError(
        "A different chunk already occupies this range",
        "AGREEMENT_OBLIGATION_CONFLICT",
        { index: input.index },
      );
    }
    return manifest;
  }
  return withStagedUploadMutation(
    input.runtime,
    {
      kind: "agreement-upload-chunk",
      uploadId: input.uploadId,
      index: input.index,
      contentSha256: sha256,
    },
    async () => {
      const stored = await files(input.runtime).storePrivate(
        input.bytes,
        "application/octet-stream",
      );
      if (
        stored.hash !== sha256 ||
        stored.size !== input.bytes.length ||
        !stored.fileName.startsWith(`${sha256}.`)
      ) {
        throw new AgreementKnowledgeError(
          "Private chunk storage returned metadata that does not match its bytes",
          "AGREEMENT_INVALID_CONTRACT",
          {
            uploadId: input.uploadId,
            index: input.index,
            expectedSha256: sha256,
          },
        );
      }
      manifest.chunks.push({
        index: input.index,
        size: input.bytes.length,
        sha256,
        fileName: stored.fileName,
      });
      await save(input.runtime, manifest);
      return manifest;
    },
  );
}

function agreementUploadContentIdentity(
  manifest: AgreementUploadManifest,
  chunks: UploadChunk[],
): string {
  const canonical = [
    "agreement-upload-content-v1",
    String(manifest.sizeBytes),
    String(manifest.chunkSizeBytes),
    ...chunks.map((chunk) => `${chunk.index}:${chunk.size}:${chunk.sha256}`),
  ].join("\n");
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

function requireAgreementUploadContentIdentity(
  manifest: AgreementUploadManifest,
  chunks: UploadChunk[],
  expected: string,
): void {
  const contentIdentity = agreementUploadContentIdentity(manifest, chunks);
  if (!/^[a-f0-9]{64}$/.test(expected) || expected !== contentIdentity) {
    throw new AgreementKnowledgeError(
      "Agreement upload content identity does not match its verified chunks",
      "AGREEMENT_INVALID_CONTRACT",
      { contentIdentity },
    );
  }
}

async function assembleAgreementUploadUnlocked(input: {
  runtime: IAgentRuntime;
  uploadId: string;
  contentIdentity: string;
  expectedSha256?: string;
}): Promise<{ manifest: AgreementUploadManifest; bytes: Buffer }> {
  const manifest = await readAgreementUpload(input.runtime, input.uploadId);
  const chunks = [...manifest.chunks].sort((a, b) => a.index - b.index);
  if (
    chunks.length !== manifest.chunkCount ||
    chunks.some((chunk, index) => chunk.index !== index)
  ) {
    throw new AgreementKnowledgeError(
      "Agreement upload is missing one or more chunks",
      "AGREEMENT_INVALID_CONTRACT",
      { received: chunks.length, required: manifest.chunkCount },
    );
  }
  requireAgreementUploadContentIdentity(
    manifest,
    chunks,
    input.contentIdentity,
  );
  const parts: Buffer[] = [];
  for (const chunk of chunks) {
    const bytes = await files(input.runtime).readPrivate(chunk.fileName);
    if (!bytes) {
      throw new AgreementKnowledgeError(
        "A persisted agreement chunk is unavailable",
        "AGREEMENT_STORAGE_UNAVAILABLE",
        { index: chunk.index },
      );
    }
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== chunk.size || hash !== chunk.sha256) {
      throw new AgreementKnowledgeError(
        "A persisted agreement chunk failed integrity verification",
        "AGREEMENT_INVALID_CONTRACT",
        { index: chunk.index },
      );
    }
    parts.push(bytes);
  }
  const bytes = Buffer.concat(parts);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (
    bytes.length !== manifest.sizeBytes ||
    (input.expectedSha256 && input.expectedSha256 !== sha256)
  ) {
    throw new AgreementKnowledgeError(
      "Reassembled agreement failed whole-file integrity verification",
      "AGREEMENT_INVALID_CONTRACT",
      { expectedSize: manifest.sizeBytes, actualSize: bytes.length },
    );
  }
  return { manifest, bytes };
}

async function finishAgreementUpload(
  runtime: IAgentRuntime,
  manifest: AgreementUploadManifest,
  artifactId: string,
): Promise<void> {
  manifest.status = "complete";
  manifest.artifactId = artifactId;
  await save(runtime, manifest);
  for (const chunk of manifest.chunks) {
    try {
      await files(runtime).deletePrivate(chunk.fileName);
    } catch (error) {
      // error-policy:J7 cleanup diagnostics must not turn an already-durable
      // agreement commit into a client-visible failure or duplicate retry.
      runtime.reportError("lifeops.agreementUploadChunkCleanup", error, {
        uploadId: manifest.uploadId,
        chunkIndex: chunk.index,
      });
    }
  }
}

function duplicateArtifactId(error: unknown): string | null {
  if (
    !(error instanceof AgreementKnowledgeError) ||
    error.code !== "AGREEMENT_DUPLICATE_CONTENT"
  ) {
    return null;
  }
  const artifactId = error.context?.artifactId;
  return typeof artifactId === "string" && artifactId ? artifactId : null;
}

export async function commitAgreementUpload<
  TArtifact extends { id: string },
>(input: {
  runtime: IAgentRuntime;
  uploadId: string;
  contentIdentity: string;
  expectedSha256?: string;
  createArtifact: (input: {
    manifest: AgreementUploadManifest;
    bytes: Buffer;
  }) => Promise<TArtifact>;
  readArtifact: (artifactId: string) => Promise<TArtifact>;
}): Promise<{ artifact: TArtifact; created: boolean }> {
  return await withUploadMutationLock(input.uploadId, async () => {
    const current = await readAgreementUpload(input.runtime, input.uploadId);
    if (current.status === "complete") {
      requireAgreementUploadContentIdentity(
        current,
        [...current.chunks].sort((a, b) => a.index - b.index),
        input.contentIdentity,
      );
      if (!current.artifactId) {
        throw new AgreementKnowledgeError(
          "Completed agreement upload is missing its artifact reference",
          "AGREEMENT_STORAGE_UNAVAILABLE",
          { uploadId: input.uploadId },
        );
      }
      return {
        artifact: await input.readArtifact(current.artifactId),
        created: false,
      };
    }

    const assembled = await assembleAgreementUploadUnlocked(input);
    const outcome = await withStagedUploadMutation(
      input.runtime,
      {
        kind: "agreement-upload-commit",
        uploadId: input.uploadId,
        contentIdentity: input.contentIdentity,
      },
      async () => {
        assembled.manifest.status = "committing";
        await save(input.runtime, assembled.manifest);
        let artifact: TArtifact;
        let created = true;
        try {
          artifact = await input.createArtifact(assembled);
        } catch (error) {
          // error-policy:J1 Only a settled, pre-persistence failure permits retry.
          if (error instanceof AgreementSourceUnchangedError) {
            assembled.manifest.status = "uploading";
            await save(input.runtime, assembled.manifest);
            return { ok: false as const, error };
          }
          const artifactId = duplicateArtifactId(error);
          if (!artifactId) throw error;
          artifact = await input.readArtifact(artifactId);
          created = false;
        }
        await finishAgreementUpload(
          input.runtime,
          assembled.manifest,
          artifact.id,
        );
        return { ok: true as const, artifact, created };
      },
    );
    if (!outcome.ok) throw outcome.error;
    return { artifact: outcome.artifact, created: outcome.created };
  });
}
