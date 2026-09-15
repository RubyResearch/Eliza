/**
 * Parses the real Gmail client's outbound MIME with an independent mail reader.
 * Only the provider transport is captured; Unicode, folding and header injection
 * assertions protect the subject actually displayed to an email recipient.
 */
import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import type { GoogleApiClientFactory } from "./client-factory.js";
import { GoogleGmailClient } from "./gmail.js";

const subjects = [
  "Eliza family MVP — synthetic delivery acceptance test",
  "École — 家庭 📅 café e\u0301",
  "Planning 📅 école 家庭 ".repeat(90),
  "Unbroken".repeat(150),
  "Literal =?UTF-8?B?SGVsbG8=?= text",
  "École\r\nBcc: intruder@example.com",
];

describe("Gmail subject MIME round trip", () => {
  for (const operation of ["message", "reply", "draft", "basic"] as const) {
    it.each(subjects)(`${operation} preserves subject %s`, async (subject) => {
      let captured: string | undefined;
      const send = async (input: { requestBody: { raw: string } }) => {
        captured = input.requestBody.raw;
        return { data: { id: "message-1", threadId: "thread-1", labelIds: [] } };
      };
      const create = async (input: { requestBody: { message: { raw: string } } }) => {
        captured = input.requestBody.message.raw;
        return { data: { id: "draft-1", message: { id: "message-1" } } };
      };
      const client = new GoogleGmailClient({
        gmail: async () => ({ users: { messages: { send }, drafts: { create } } }),
      } as unknown as GoogleApiClientFactory);
      const common = { accountId: "test-account", subject };
      const body = "Complete synthetic body — no real family data.";
      if (operation === "basic") {
        await client.sendEmail({ ...common, to: [{ email: "self@example.com" }], text: body });
      } else {
        const input = { ...common, to: ["self@example.com"], bodyText: body };
        if (operation === "message") await client.sendGmailMessage(input);
        else if (operation === "reply") await client.sendGmailReply(input);
        else await client.createGmailDraft(input);
      }
      if (!captured) throw new Error("Provider received no MIME message");
      const bytes = Buffer.from(captured, "base64url");
      const parsed = await PostalMime.parse(bytes);
      const expected = subject.replace(/[\r\n]+/g, " ").trim();
      expect(parsed.subject).toBe(operation === "reply" ? `Re: ${expected}` : expected);
      expect(parsed.text?.trimEnd()).toBe(body);
      expect(parsed.to).toEqual([{ name: "", address: "self@example.com" }]);
      expect(parsed.bcc).toBeUndefined();
      const headers = bytes.toString("utf8").split("\r\n\r\n")[0];
      if (!headers) throw new Error("Missing MIME headers");
      for (const line of headers.split("\r\n")) {
        expect(Buffer.byteLength(line)).toBeLessThanOrEqual(76);
        expect(line).toMatch(/^[\x20-\x7e]*$/);
      }
    });
  }
});
