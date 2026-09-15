/**
 * Resolves Google account and calendar choices into review facts from current
 * owner-scoped services. Clients select identities and dispositions; account
 * emails, connector IDs, and event revisions come from server reads.
 */
import { ElizaError } from "@elizaos/core";
import type { CalendarService } from "@elizaos/plugin-calendar";
import { z } from "zod";
import type { AccountHandoffReview } from "./account-handoff-store.js";
import type { LifeOpsGoogleService } from "./service-mixin-google.js";

const id = z
  .string()
  .min(1)
  .refine((value) => value === value.trim() && !value.includes("\0"));
export const accountHandoffGoogleChoicesSchema = z
  .object({
    previousGrantId: id,
    replacementGrantId: id,
    readCalendarIds: z
      .array(id)
      .refine((ids) => new Set(ids).size === ids.length),
    writeCalendarId: id.nullable(),
    calendarLinks: z
      .array(
        z
          .object({
            linkId: id,
            expectedUpdatedAt: z.iso.datetime({ offset: true }),
            expectedLocalRevision: z.number().int().nonnegative(),
            disposition: z.enum(["retain_local", "copy_to_replacement"]),
          })
          .strict(),
      )
      .refine(
        (links) =>
          new Set(links.map((link) => link.linkId)).size === links.length,
      ),
  })
  .strict();

export async function deriveAccountHandoffGoogleReview(
  agentId: string,
  requestUrl: URL,
  input: z.infer<typeof accountHandoffGoogleChoicesSchema>,
  accounts: Pick<LifeOpsGoogleService, "getGoogleConnectorAccounts">,
  calendar: Pick<CalendarService, "listCalendars" | "listLinkedCalendarEvents">,
): Promise<
  Pick<
    AccountHandoffReview,
    | "previous"
    | "replacement"
    | "readCalendars"
    | "writeCalendar"
    | "calendarLinks"
  >
> {
  const parsed = accountHandoffGoogleChoicesSchema.safeParse(input);
  if (!parsed.success) throw changed();
  const choices = parsed.data;
  if (choices.previousGrantId === choices.replacementGrantId) throw changed();
  const connected = await accounts.getGoogleConnectorAccounts(
    requestUrl,
    "owner",
  );
  const resolve = (grantId: string) => {
    const matching = connected.filter(
      (account) => account.grant?.id === grantId,
    );
    const account = matching[0];
    if (
      matching.length !== 1 ||
      !account?.connected ||
      account.side !== "owner" ||
      account.mode !== "local"
    )
      throw changed();
    const grant = account.grant;
    if (
      !grant ||
      grant.agentId !== agentId ||
      grant.provider !== "google" ||
      grant.side !== "owner" ||
      grant.mode !== "local" ||
      !grant.connectorAccountId ||
      !grant.identityEmail ||
      !z.email().safeParse(grant.identityEmail).success
    )
      throw changed();
    if (grantId === choices.replacementGrantId) {
      const required = [
        ...(choices.readCalendarIds.length || choices.writeCalendarId !== null
          ? ["google.calendar.read"]
          : []),
        ...(choices.writeCalendarId !== null ? ["google.calendar.write"] : []),
      ];
      if (
        required.some((capability) => !grant.capabilities.includes(capability))
      )
        throw changed();
    }
    return {
      grantId: grant.id,
      connectorAccountId: grant.connectorAccountId,
      email: grant.identityEmail,
    };
  };
  const previous = resolve(choices.previousGrantId);
  const replacement = resolve(choices.replacementGrantId);
  if (
    previous.connectorAccountId === replacement.connectorAccountId ||
    previous.email.toLowerCase() === replacement.email.toLowerCase()
  )
    throw changed();
  const [available, links] = await Promise.all([
    calendar.listCalendars(requestUrl, {
      mode: "local",
      side: "owner",
      grantId: replacement.grantId,
    }),
    calendar.listLinkedCalendarEvents(),
  ]);
  const resolveCalendar = (calendarId: string, write: boolean) => {
    const matching = available.filter(
      (source) => source.calendarId === calendarId,
    );
    const source = matching[0];
    if (
      matching.length !== 1 ||
      !source ||
      source.provider !== "google" ||
      source.side !== "owner" ||
      source.grantId !== replacement.grantId ||
      source.connectorAccountId !== replacement.connectorAccountId ||
      !(write ? ["writer", "owner"] : ["reader", "writer", "owner"]).includes(
        source.accessRole,
      )
    )
      throw changed();
    return {
      grantId: replacement.grantId,
      connectorAccountId: replacement.connectorAccountId,
      calendarId: source.calendarId,
    };
  };
  const ownedLinks = links.filter(
    (link) => link.connectorAccountId === previous.connectorAccountId,
  );
  if (
    ownedLinks.length !== choices.calendarLinks.length ||
    new Set(ownedLinks.map((link) => link.id)).size !== ownedLinks.length
  )
    throw changed();
  const calendarLinks = choices.calendarLinks.map((choice) => {
    const link = ownedLinks.find((candidate) => candidate.id === choice.linkId);
    if (
      !link ||
      link.updatedAt !== choice.expectedUpdatedAt ||
      link.localRevision !== choice.expectedLocalRevision ||
      (choice.disposition === "copy_to_replacement" &&
        choices.writeCalendarId === null)
    )
      throw changed();
    return {
      linkId: link.id,
      expectedUpdatedAt: link.updatedAt,
      expectedLocalRevision: link.localRevision,
      disposition: choice.disposition,
    };
  });
  return {
    previous,
    replacement,
    readCalendars: choices.readCalendarIds.map((calendarId) =>
      resolveCalendar(calendarId, false),
    ),
    writeCalendar:
      choices.writeCalendarId === null
        ? null
        : resolveCalendar(choices.writeCalendarId, true),
    calendarLinks,
  };
}

function changed(): ElizaError {
  return new ElizaError(
    "Account or calendar choices no longer match the available owner connections. Refresh the handoff review.",
    {
      code: "ACCOUNT_HANDOFF_GOOGLE_REVIEW_CHANGED",
    },
  );
}
