/**
 * Imports owner-selected correspondence into canonical private documents before
 * selecting it for a monthly packet. Retries bind to the same source text and
 * period; changing a request cannot silently replace an existing selection.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  DocumentService,
  ElizaError,
  type IAgentRuntime,
  resolveOwnerEntityIdOrDefault,
} from "@elizaos/core";
import { z } from "zod";
import {
  type FamilyIntakeReview,
  FamilyIntakeReviewStore,
  familyIntakeIdSchema,
} from "./intake-review.js";
import { getFamilyIntakeService } from "./intake-service.js";

export const familyIntakeImportSchema = z.strictObject({
  id: familyIntakeIdSchema,
  periodKey: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u),
  title: z.string().refine((value) => value.trim().length > 0),
  text: z.string().refine((value) => value.trim().length > 0),
});

export async function importFamilyCorrespondence(
  runtime: IAgentRuntime,
  input: z.infer<typeof familyIntakeImportSchema>,
): Promise<FamilyIntakeReview> {
  const owner = resolveOwnerEntityIdOrDefault(runtime);
  const existing = await new FamilyIntakeReviewStore(runtime).read(input.id);
  const digest = createHash("sha256").update(input.text).digest("hex");
  if (existing) {
    if (
      existing.selectedByEntityId !== owner ||
      existing.periodKey !== input.periodKey ||
      existing.source.contentSha256 !== digest
    )
      throw new ElizaError(
        "This import identity already belongs to another source or month",
        { code: "FAMILY_INTAKE_SELECTION_CONFLICT" },
      );
    return existing;
  }
  const documents = runtime.getService<DocumentService>(
    DocumentService.serviceType,
  );
  if (!documents)
    throw new ElizaError("The canonical document service is unavailable", {
      code: "FAMILY_INTAKE_SOURCE_UNAVAILABLE",
    });
  const added = await documents.addDocument({
    agentId: runtime.agentId,
    worldId: runtime.agentId,
    roomId: runtime.agentId,
    entityId: runtime.agentId,
    clientDocumentId: randomUUID(),
    contentType: "text/plain",
    originalFilename: `selected-correspondence-${input.id}.txt`,
    content: input.text,
    metadata: { title: input.title, source: "selected-correspondence" },
    scope: "owner-private",
    scopedToEntityId: owner,
    addedBy: owner,
    addedByRole: "OWNER",
    addedFrom: "lifeops",
  });
  const stored = await documents.getDocumentByIdWithAccessContext(
    added.storedDocumentMemoryId,
    {
      requesterEntityId: owner,
      role: "OWNER",
      isOwner: true,
    },
  );
  if (!stored || stored.content.text !== input.text)
    throw new ElizaError(
      "The document service did not preserve the complete source text",
      { code: "FAMILY_INTAKE_SOURCE_CHANGED" },
    );
  return getFamilyIntakeService(runtime).select({
    id: input.id,
    periodKey: input.periodKey,
    documentId: added.storedDocumentMemoryId,
  });
}
