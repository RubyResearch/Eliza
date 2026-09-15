/**
 * Snapshot, diff, screenshot, and PDF helpers for browser workspace documents.
 */

import {
  isBrowserWorkspacePrivateControl,
  normalizeBrowserWorkspaceText,
  readBrowserWorkspaceElementText,
} from "./browser-workspace-helpers.js";
import type { BrowserWorkspaceSnapshotRecord } from "./browser-workspace-types.js";

export function escapeBrowserWorkspacePdfText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

export function createBrowserWorkspacePdfBuffer(
  title: string,
  bodyText: string,
): Buffer {
  const lines = [
    title.trim() || "Eliza Browser Workspace",
    "",
    ...bodyText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 32),
  ];
  const contentLines = lines.map((line, index) => {
    const offset = index === 0 ? "50 750 Td" : "0 -18 Td";
    return `${offset} (${escapeBrowserWorkspacePdfText(line)}) Tj`;
  });
  const stream = `BT\n/F1 12 Tf\n${contentLines.join("\n")}\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

export function createBrowserWorkspaceSyntheticScreenshotData(
  title: string,
  url: string,
  bodyText: string,
  viewport?: { height: number; width: number },
): string {
  const width = viewport?.width ?? 1280;
  const height = viewport?.height ?? 720;
  const lines = [
    title || "Eliza Browser Workspace",
    url,
    "",
    ...bodyText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 18),
  ];
  const escapedLines = lines.map((line) =>
    line
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;"),
  );
  const svg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#faf7f1"/><rect x="24" y="24" width="${width - 48}" height="${height - 48}" rx="18" fill="#ffffff" stroke="#d8d1c4"/><text x="48" y="72" font-family="Menlo, Monaco, monospace" font-size="20" fill="#111111">${escapedLines.map((line, index) => `<tspan x="48" dy="${index === 0 ? 0 : 28}">${line}</tspan>`).join("")}</text></svg>`;
  return Buffer.from(svg, "utf8").toString("base64");
}

export function createBrowserWorkspaceSnapshotRecord(
  title: string,
  url: string,
  bodyText: string,
): BrowserWorkspaceSnapshotRecord {
  return {
    bodyText: normalizeBrowserWorkspaceText(bodyText),
    title: normalizeBrowserWorkspaceText(title),
    url: normalizeBrowserWorkspaceText(url),
  };
}

export function buildBrowserWorkspaceDocumentSnapshotText(
  document: Document,
): string {
  const bodyText = readBrowserWorkspaceElementText(document.body);
  const controlText = Array.from(
    document.querySelectorAll("input, textarea, select, option:checked"),
  )
    .map((element) => {
      const name =
        element.getAttribute("name") ||
        element.getAttribute("id") ||
        element.tagName.toLowerCase();
      if (isBrowserWorkspacePrivateControl(element)) return name;
      const value =
        element.tagName === "SELECT"
          ? (element as HTMLSelectElement).value
          : "value" in (element as HTMLInputElement | HTMLTextAreaElement)
            ? (element as HTMLInputElement | HTMLTextAreaElement).value
            : (element.textContent ?? "");
      return `${name}:${normalizeBrowserWorkspaceText(value)}`;
    })
    .filter(Boolean)
    .join(" ");
  return normalizeBrowserWorkspaceText(`${bodyText} ${controlText}`);
}

export function diffBrowserWorkspaceSnapshots(
  before: BrowserWorkspaceSnapshotRecord | null,
  after: BrowserWorkspaceSnapshotRecord,
): Record<string, unknown> {
  return {
    changed:
      !before ||
      before.bodyText !== after.bodyText ||
      before.title !== after.title ||
      before.url !== after.url,
    previous: before,
    current: after,
  };
}

export function readBrowserWorkspaceStorage(
  storage: Storage,
): Record<string, string> {
  const entries: Record<string, string> = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key) {
      continue;
    }
    entries[key] = storage.getItem(key) ?? "";
  }
  return entries;
}

export function readBrowserWorkspaceCookies(
  document: Document,
): Record<string, string> {
  const cookieString = document.cookie || "";
  if (!cookieString.trim()) {
    return {};
  }
  return Object.fromEntries(
    cookieString
      .split(/;\s*/)
      .map((entry) => {
        const [name, ...rest] = entry.split("=");
        return [name ?? "", rest.join("=")] as const;
      })
      .filter((entry) => entry[0].trim().length > 0),
  );
}

export function applyBrowserWorkspaceStateToWebDocument(
  document: Document,
  snapshot: Record<string, unknown>,
): void {
  const localEntries =
    snapshot.localStorage && typeof snapshot.localStorage === "object"
      ? (snapshot.localStorage as Record<string, unknown>)
      : {};
  const sessionEntries =
    snapshot.sessionStorage && typeof snapshot.sessionStorage === "object"
      ? (snapshot.sessionStorage as Record<string, unknown>)
      : {};
  const cookies =
    snapshot.cookies && typeof snapshot.cookies === "object"
      ? (snapshot.cookies as Record<string, unknown>)
      : {};

  document.defaultView?.localStorage.clear();
  for (const [key, value] of Object.entries(localEntries)) {
    document.defaultView?.localStorage.setItem(key, String(value ?? ""));
  }
  document.defaultView?.sessionStorage.clear();
  for (const [key, value] of Object.entries(sessionEntries)) {
    document.defaultView?.sessionStorage.setItem(key, String(value ?? ""));
  }
  for (const [key, value] of Object.entries(cookies)) {
    document.cookie = `${key}=${String(value ?? "")}; path=/`;
  }
}
