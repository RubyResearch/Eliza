/**
 * Element lookup, selector parsing, and DOM inspection helpers for browser workspace.
 */

import type { JSDOM } from "jsdom";
import {
  buildBrowserWorkspaceCssStringLiteral,
  isBrowserWorkspacePrivateControl,
  normalizeBrowserWorkspaceText,
  readBrowserWorkspaceElementText,
} from "./browser-workspace-helpers.js";
import { getJSDOMClass } from "./browser-workspace-jsdom.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceDomElementSummary,
  BrowserWorkspaceRuntimeState,
} from "./browser-workspace-types.js";

export function buildBrowserWorkspaceElementSelector(element: Element): string {
  const escapeFn = (
    globalThis as { CSS?: { escape?: (value: string) => string } }
  ).CSS?.escape;
  const escapedId =
    typeof escapeFn === "function"
      ? escapeFn(element.id)
      : element.id.replace(/[^a-zA-Z0-9_-]/g, "\\$&");

  if (element.id) {
    return `#${escapedId}`;
  }

  const testId = element.getAttribute("data-testid")?.trim();
  if (testId) {
    return `[data-testid=${buildBrowserWorkspaceCssStringLiteral(testId)}]`;
  }

  const name = element.getAttribute("name")?.trim();
  if (name) {
    return `${element.tagName.toLowerCase()}[name=${buildBrowserWorkspaceCssStringLiteral(name)}]`;
  }

  const type = element.getAttribute("type")?.trim();
  if (type) {
    return `${element.tagName.toLowerCase()}[type=${buildBrowserWorkspaceCssStringLiteral(type)}]`;
  }

  const parent = element.parentElement;
  if (!parent) {
    return element.tagName.toLowerCase();
  }

  const siblings = parent.children;
  let index = 1;
  for (let cursor = 0; cursor < siblings.length; cursor += 1) {
    const sibling = siblings.item(cursor);
    if (!sibling || sibling.tagName !== element.tagName) {
      continue;
    }
    if (sibling === element) {
      break;
    }
    index += 1;
  }

  return `${element.tagName.toLowerCase()}:nth-of-type(${index})`;
}

export function createBrowserWorkspaceElementSummary(
  element: Element,
): BrowserWorkspaceDomElementSummary {
  const inputLike =
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT";

  const elementValue =
    inputLike && !isBrowserWorkspacePrivateControl(element)
      ? ((element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)
          .value ?? null)
      : null;

  return {
    selector: buildBrowserWorkspaceElementSelector(element),
    tag: element.tagName.toLowerCase(),
    text: inputLike
      ? normalizeBrowserWorkspaceText(elementValue)
      : readBrowserWorkspaceElementText(element),
    type: element.getAttribute("type"),
    name: element.getAttribute("name"),
    href: element.getAttribute("href"),
    value: typeof elementValue === "string" ? elementValue : null,
  };
}

export function collectBrowserWorkspaceInspectElements(
  document: Document,
): BrowserWorkspaceDomElementSummary[] {
  const elements = Array.from(
    document.querySelectorAll(
      "a, button, input, textarea, select, form, [role='button'], [data-testid]",
    ),
  );
  const summaries: BrowserWorkspaceDomElementSummary[] = [];
  const seenSelectors = new Set<string>();

  for (const element of elements) {
    const summary = createBrowserWorkspaceElementSummary(element);
    if (seenSelectors.has(summary.selector)) {
      continue;
    }
    seenSelectors.add(summary.selector);
    summaries.push(summary);
    if (summaries.length >= 40) {
      break;
    }
  }

  return summaries;
}

export function resolveBrowserWorkspaceIframeDocument(
  runtime: BrowserWorkspaceRuntimeState,
  frameElement: Element | null,
  baseUrl: string,
): Document | null {
  if (frameElement?.tagName !== "IFRAME") {
    return null;
  }

  const iframe = frameElement as HTMLIFrameElement;
  const srcdoc = iframe.getAttribute("srcdoc");
  if (srcdoc?.trim()) {
    const selector = buildBrowserWorkspaceElementSelector(frameElement);
    const cached = runtime.frameDoms.get(selector);
    if (cached) {
      return cached.window.document;
    }
    if (
      iframe.contentDocument &&
      normalizeBrowserWorkspaceText(iframe.contentDocument.body?.textContent)
        .length > 0
    ) {
      return iframe.contentDocument;
    }
    const parsed = new (getJSDOMClass())(srcdoc, {
      pretendToBeVisual: true,
      url: baseUrl,
    });
    runtime.frameDoms.set(selector, parsed);
    return parsed.window.document;
  }

  if (iframe.contentDocument) {
    return iframe.contentDocument;
  }

  return null;
}

export function resolveWebBrowserWorkspaceCommandDocument(
  tab: { id: string; url: string },
  dom: JSDOM,
  runtimeState: import("./browser-workspace-types.js").BrowserWorkspaceRuntimeState,
): { document: Document; frameSelector: string | null } {
  const state = runtimeState;
  const frameSelector = state.currentFrame?.trim() || null;
  if (!frameSelector) {
    return { document: dom.window.document, frameSelector: null };
  }

  const frameElement = resolveBrowserWorkspaceElement(
    dom.window.document,
    frameSelector,
  );
  const frameDocument = resolveBrowserWorkspaceIframeDocument(
    state,
    frameElement,
    tab.url,
  );
  if (!frameDocument) {
    return { document: dom.window.document, frameSelector: null };
  }

  return { document: frameDocument, frameSelector };
}

export function getBrowserWorkspaceElementSearchTexts(
  element: Element,
): string[] {
  const labelText =
    element.id && element.ownerDocument
      ? Array.from(
          element.ownerDocument.querySelectorAll(`label[for="${element.id}"]`),
        )
          .map((label) => label.textContent)
          .join(" ")
      : "";
  return [
    element.textContent,
    element.getAttribute("aria-label"),
    element.getAttribute("placeholder"),
    element.getAttribute("title"),
    element.getAttribute("name"),
    element.getAttribute("alt"),
    element.getAttribute("data-testid"),
    labelText,
    (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)
      .value,
  ]
    .map((value) => normalizeBrowserWorkspaceText(value))
    .filter(Boolean);
}

export function browserWorkspaceTextMatches(
  candidate: string,
  wanted: string,
  exact = false,
): boolean {
  const normalizedCandidate =
    normalizeBrowserWorkspaceText(candidate).toLowerCase();
  const normalizedWanted = normalizeBrowserWorkspaceText(wanted).toLowerCase();
  if (!normalizedCandidate || !normalizedWanted) {
    return false;
  }
  return exact
    ? normalizedCandidate === normalizedWanted
    : normalizedCandidate.includes(normalizedWanted);
}

export function isBrowserWorkspaceElementVisible(element: Element): boolean {
  if (
    element.hasAttribute("hidden") ||
    element.getAttribute("aria-hidden") === "true"
  ) {
    return false;
  }

  const htmlElement = element as HTMLElement;
  const inlineDisplay = htmlElement.style?.display?.trim().toLowerCase();
  const inlineVisibility = htmlElement.style?.visibility?.trim().toLowerCase();
  if (inlineDisplay === "none" || inlineVisibility === "hidden") {
    return false;
  }

  return true;
}

export function findBrowserWorkspaceElementByLabel(
  document: Document,
  labelText: string,
  exact = false,
): Element | null {
  const labels = Array.from(document.querySelectorAll("label"));
  for (const label of labels) {
    if (
      !browserWorkspaceTextMatches(label.textContent ?? "", labelText, exact)
    ) {
      continue;
    }

    const forId = label.getAttribute("for")?.trim();
    if (forId) {
      const explicit = document.getElementById(forId);
      if (explicit) {
        return explicit;
      }
    }

    const nested = label.querySelector("input, textarea, select, button");
    if (nested) {
      return nested;
    }
  }
  return null;
}

export function getBrowserWorkspaceNativeRole(element: Element): string | null {
  const explicitRole = element.getAttribute("role")?.trim().toLowerCase();
  if (explicitRole) {
    return explicitRole;
  }

  const tag = element.tagName.toLowerCase();
  if (tag === "a" && element.getAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "option") return "option";
  if (tag === "textarea") return "textbox";
  if (tag === "form") return "form";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "input") {
    const input = element as HTMLInputElement;
    const type = (input.type || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (["button", "submit", "reset", "image"].includes(type)) {
      return "button";
    }
    return "textbox";
  }
  return null;
}

export function findBrowserWorkspaceElementByRole(
  document: Document,
  role: string,
  name?: string,
  exact = false,
): Element | null {
  const wantedRole = role.trim().toLowerCase();
  if (!wantedRole) {
    return null;
  }

  const candidates = Array.from(
    document.querySelectorAll(
      "a, button, input, textarea, select, option, form, h1, h2, h3, h4, h5, h6, [role], [data-testid]",
    ),
  );
  for (const candidate of candidates) {
    if (getBrowserWorkspaceNativeRole(candidate) !== wantedRole) {
      continue;
    }
    if (!name?.trim()) {
      return candidate;
    }
    const haystacks = getBrowserWorkspaceElementSearchTexts(candidate);
    if (
      haystacks.some((value) => browserWorkspaceTextMatches(value, name, exact))
    ) {
      return candidate;
    }
  }
  return null;
}

export function trimBrowserWorkspaceQuotedValue(value: string): string {
  const trimmed = value.trim();
  const hasTextMatch = trimmed.match(/^has-text\((['"])([\s\S]*?)\1\)$/i);
  if (hasTextMatch?.[2]) {
    return hasTextMatch[2].trim();
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function normalizeBrowserWorkspaceSelectorSyntax(
  selector: string,
): string {
  let normalized = selector.trim();
  normalized = normalized.replace(
    /^role\s*[:=]\s*([a-z0-9_-]+)\s+name\s*[:=]\s*(.+)$/i,
    "role=$1[name=$2]",
  );
  normalized = normalized.replace(
    /^((?:label|text|placeholder|alt|title|testid|data-testid)\s*[:=]\s*(?:has-text\((['"])[\s\S]*?\2\)|"[^"]+"|'[^']+'|[^>]+?))\s+((?:input|textarea|select)[\s\S]*)$/i,
    "$1 >> $3",
  );
  return normalized;
}

export function parseBrowserWorkspaceSemanticSelector(
  selector: string,
): Pick<
  BrowserWorkspaceCommand,
  "findBy" | "name" | "role" | "selector" | "text"
> | null {
  const trimmed = normalizeBrowserWorkspaceSelectorSyntax(selector);
  const match = trimmed.match(/^([a-z-]+)\s*[:=]\s*(.+)$/i);
  if (!match) {
    return null;
  }

  const kind = match[1]?.trim().toLowerCase();
  const rawValue = match[2]?.trim() ?? "";
  if (!kind || !rawValue) {
    return null;
  }

  switch (kind) {
    case "alt":
      return { findBy: "alt", text: trimBrowserWorkspaceQuotedValue(rawValue) };
    case "css":
      return { selector: trimBrowserWorkspaceQuotedValue(rawValue) };
    case "data-testid":
    case "testid":
      return {
        findBy: "testid",
        text: trimBrowserWorkspaceQuotedValue(rawValue),
      };
    case "label":
      return {
        findBy: "label",
        text: trimBrowserWorkspaceQuotedValue(rawValue),
      };
    case "placeholder":
      return {
        findBy: "placeholder",
        text: trimBrowserWorkspaceQuotedValue(rawValue),
      };
    case "role": {
      const roleMatch = rawValue.match(
        /^([a-z0-9_-]+)(?:\s*\[\s*name\s*[:=]\s*(.+?)\s*\])?$/i,
      );
      if (!roleMatch?.[1]) {
        return null;
      }
      return {
        findBy: "role",
        name: roleMatch[2]
          ? trimBrowserWorkspaceQuotedValue(roleMatch[2])
          : undefined,
        role: roleMatch[1].trim().toLowerCase(),
      };
    }
    case "text":
      return {
        findBy: "text",
        text: trimBrowserWorkspaceQuotedValue(rawValue),
      };
    case "title":
      return {
        findBy: "title",
        text: trimBrowserWorkspaceQuotedValue(rawValue),
      };
    default:
      return null;
  }
}

export function mergeBrowserWorkspaceSelectorCommand(
  command: BrowserWorkspaceCommand | undefined,
  selector: string,
): BrowserWorkspaceCommand | null {
  const parsed = parseBrowserWorkspaceSemanticSelector(selector);
  if (!parsed) {
    return null;
  }

  return {
    ...command,
    ...parsed,
    selector: parsed.selector,
  } as BrowserWorkspaceCommand;
}

export function queryBrowserWorkspaceSelector(
  root: Document | Element,
  selector: string,
): Element | null {
  try {
    return root.querySelector(selector);
  } catch {
    throw new Error(`Invalid selector ${selector}`);
  }
}

export function queryAllBrowserWorkspaceSelector(
  root: Document | Element,
  selector: string,
): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    throw new Error(`Invalid selector ${selector}`);
  }
}

export function findBrowserWorkspaceElementByText(
  document: Document,
  needle: string,
): Element | null {
  const wanted = normalizeBrowserWorkspaceText(needle).toLowerCase();
  if (!wanted) {
    return null;
  }

  const candidates = Array.from(
    document.querySelectorAll(
      "a, button, input, textarea, select, option, label, h1, h2, h3, [role='button'], [data-testid]",
    ),
  );

  for (const element of candidates) {
    const haystacks = [
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.getAttribute("title"),
      element.getAttribute("name"),
      (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)
        .value,
    ]
      .map((value) => normalizeBrowserWorkspaceText(value))
      .filter(Boolean)
      .map((value) => value.toLowerCase());

    if (haystacks.some((value) => value.includes(wanted))) {
      return element;
    }
  }

  return null;
}

export function resolveBrowserWorkspaceFindElement(
  document: Document,
  command: BrowserWorkspaceCommand,
): Element | null {
  switch (command.findBy) {
    case "alt":
      return (
        Array.from(document.querySelectorAll("[alt]")).find((element) =>
          browserWorkspaceTextMatches(
            element.getAttribute("alt") ?? "",
            command.text ?? "",
            command.exact,
          ),
        ) ?? null
      );
    case "first":
      return command.selector?.trim()
        ? queryBrowserWorkspaceSelector(document, command.selector)
        : null;
    case "label":
      return command.text?.trim()
        ? findBrowserWorkspaceElementByLabel(
            document,
            command.text,
            command.exact,
          )
        : null;
    case "last":
      return command.selector?.trim()
        ? (queryAllBrowserWorkspaceSelector(document, command.selector).at(
            -1,
          ) ?? null)
        : null;
    case "nth":
      if (!command.selector?.trim()) {
        return null;
      }
      if (
        typeof command.index !== "number" ||
        !Number.isInteger(command.index)
      ) {
        return null;
      }
      return (
        queryAllBrowserWorkspaceSelector(document, command.selector).at(
          command.index,
        ) ?? null
      );
    case "placeholder":
      return (
        Array.from(document.querySelectorAll("[placeholder]")).find((element) =>
          browserWorkspaceTextMatches(
            element.getAttribute("placeholder") ?? "",
            command.text ?? "",
            command.exact,
          ),
        ) ?? null
      );
    case "role":
      return command.role?.trim()
        ? findBrowserWorkspaceElementByRole(
            document,
            command.role,
            command.name,
            command.exact,
          )
        : null;
    case "testid":
      return command.text?.trim()
        ? document.querySelector(
            `[data-testid=${buildBrowserWorkspaceCssStringLiteral(command.text)}]`,
          )
        : null;
    case "text":
      return command.text?.trim()
        ? findBrowserWorkspaceElementByText(document, command.text)
        : null;
    case "title":
      return (
        Array.from(document.querySelectorAll("[title]")).find((element) =>
          browserWorkspaceTextMatches(
            element.getAttribute("title") ?? "",
            command.text ?? "",
            command.exact,
          ),
        ) ?? null
      );
    default:
      return null;
  }
}

export function resolveBrowserWorkspaceElement(
  document: Document,
  selector?: string,
  text?: string,
  command?: BrowserWorkspaceCommand,
): Element | null {
  const normalizedSelector = selector
    ? normalizeBrowserWorkspaceSelectorSyntax(selector)
    : undefined;
  if (normalizedSelector) {
    const selectorChain = normalizedSelector
      .split(/\s*>>\s*/)
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (selectorChain.length > 1) {
      let current = resolveBrowserWorkspaceElement(
        document,
        selectorChain[0],
        undefined,
        command,
      );
      for (let index = 1; current && index < selectorChain.length; index += 1) {
        const segment = selectorChain[index];
        if (!segment) {
          continue;
        }
        if (
          typeof (current as Element).matches === "function" &&
          (current as Element).matches(segment)
        ) {
          continue;
        }
        if (
          /^(input|textarea|select)(?:\[[^\]]+\])?$/i.test(segment) &&
          (current.tagName === "INPUT" ||
            current.tagName === "TEXTAREA" ||
            current.tagName === "SELECT")
        ) {
          continue;
        }
        current = queryBrowserWorkspaceSelector(current, segment);
      }
      return current;
    }
    const semanticCommand = mergeBrowserWorkspaceSelectorCommand(
      command,
      normalizedSelector,
    );
    if (semanticCommand) {
      return resolveBrowserWorkspaceFindElement(document, semanticCommand);
    }
    return queryBrowserWorkspaceSelector(document, normalizedSelector);
  }

  if (command?.findBy) {
    return resolveBrowserWorkspaceFindElement(document, command);
  }

  const normalizedText = text?.trim();
  if (normalizedText) {
    return findBrowserWorkspaceElementByText(document, normalizedText);
  }

  return null;
}

export function getBrowserWorkspaceElementBox(element: Element): {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
  x: number;
  y: number;
} {
  const box =
    typeof (element as HTMLElement).getBoundingClientRect === "function"
      ? (element as HTMLElement).getBoundingClientRect()
      : {
          bottom: 0,
          height: 0,
          left: 0,
          right: 0,
          top: 0,
          width: 0,
          x: 0,
          y: 0,
        };
  return {
    bottom: box.bottom,
    height: box.height,
    left: box.left,
    right: box.right,
    top: box.top,
    width: box.width,
    x: box.x,
    y: box.y,
  };
}

export function getBrowserWorkspaceElementValue(
  element: Element,
): string | boolean | null {
  if (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT"
  ) {
    const control = element as
      | HTMLInputElement
      | HTMLTextAreaElement
      | HTMLSelectElement;
    if (element.tagName === "INPUT") {
      const input = control as HTMLInputElement;
      const type = input.type.trim().toLowerCase();
      if (type === "checkbox" || type === "radio") {
        return input.checked;
      }
    }
    return control.value;
  }
  return null;
}

export function getBrowserWorkspaceElementStyles(
  element: Element,
  window: Pick<Window, "getComputedStyle">,
): Record<string, string | null> {
  const computed = window.getComputedStyle(element);
  return {
    display: computed.display || null,
    visibility: computed.visibility || null,
    opacity: computed.opacity || null,
  };
}

export function findClosestBrowserWorkspaceForm(
  element: Element | null,
): HTMLFormElement | null {
  if (!element) {
    return null;
  }
  return (
    element.tagName === "FORM" ? element : element.closest("form")
  ) as HTMLFormElement | null;
}
