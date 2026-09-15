/** Verifies sanitizePatchValue (prototype-pollution guard) through the package's configured test harness. */
// Unit coverage for the load-bearing chat parser helpers (#9304). `parseSegments`
// and the JSONL-patch → UiSpec compiler are the single source of truth both chat
// surfaces (ChatView `MessageContent` + overlay `InlineWidgetText`) now share, so
// these pure functions — especially the prototype-pollution guards on
// agent-emitted patch data — are worth pinning directly.

import { describe, expect, it } from "vitest";
import {
  BLOCKED_IDS,
  compilePatches,
  findPatchRegions,
  isSafeNormalizedPluginId,
  isUiSpec,
  looksLikePatch,
  normalizeDisplayText,
  parseFormSubmitDisplay,
  parseSegments,
  sanitizePatchValue,
  tryParsePatch,
} from "./message-parser-helpers";
// Side-effect import: registers the built-in inline widgets (choice/followups/
// form/workflow/background/checklist) the pre-gate tests below parse through.
import "./widgets/inline-builtins";

describe("sanitizePatchValue (prototype-pollution guard)", () => {
  it("drops __proto__/constructor/prototype keys at every nesting level", () => {
    // JSON.parse gives real OWN enumerable "__proto__" keys (DefineProperty
    // semantics), which is exactly the attack shape an agent reply can carry.
    const dirty = JSON.parse(
      '{"a":1,"__proto__":{"polluted":true},"nested":{"constructor":2,"b":3}}',
    );
    const safe = sanitizePatchValue(dirty) as Record<string, unknown>;
    expect(safe.a).toBe(1);
    expect(Object.hasOwn(safe, "__proto__")).toBe(false);
    const nested = safe.nested as Record<string, unknown>;
    expect(nested.b).toBe(3);
    expect(Object.hasOwn(nested, "constructor")).toBe(false);
    // Returned containers have a null prototype — nothing to pollute.
    expect(Object.getPrototypeOf(safe)).toBeNull();
    // The global Object prototype must be untouched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("passes through primitives and recurses into arrays", () => {
    expect(sanitizePatchValue(42)).toBe(42);
    expect(sanitizePatchValue("x")).toBe("x");
    expect(sanitizePatchValue(null)).toBeNull();
    const arr = sanitizePatchValue(
      JSON.parse('[{"__proto__":{"x":1},"keep":1}]'),
    ) as Array<Record<string, unknown>>;
    expect(arr[0].keep).toBe(1);
    expect(Object.hasOwn(arr[0], "__proto__")).toBe(false);
  });
});

describe("isSafeNormalizedPluginId", () => {
  it("accepts word/dash ids and rejects blocked or special-char ids", () => {
    expect(isSafeNormalizedPluginId("plugin-foo_bar")).toBe(true);
    expect(isSafeNormalizedPluginId("__proto__")).toBe(false);
    expect(isSafeNormalizedPluginId("a/b")).toBe(false);
    expect(isSafeNormalizedPluginId("")).toBe(false);
    for (const blocked of BLOCKED_IDS) {
      expect(isSafeNormalizedPluginId(blocked)).toBe(false);
    }
  });
});

describe("isUiSpec", () => {
  it("requires a string root and an object elements map", () => {
    expect(isUiSpec({ root: "n1", elements: {} })).toBe(true);
    expect(isUiSpec({ root: 1, elements: {} })).toBe(false);
    expect(isUiSpec({ root: "n1", elements: null })).toBe(false);
    expect(isUiSpec({ elements: {} })).toBe(false);
    expect(isUiSpec(null)).toBe(false);
    expect(isUiSpec("nope")).toBe(false);
  });
});

describe("looksLikePatch + tryParsePatch", () => {
  it("recovers only surplus closing braces while preserving literal string data", () => {
    const patch = {
      op: "add",
      path: "/elements/example",
      value: {
        type: "Text",
        props: { text: 'Braces } { and a quoted "value" with a slash \\' },
      },
    };
    const line = JSON.stringify(patch);
    expect(tryParsePatch(line + "} }")).toEqual(patch);
    for (const tail of [
      " trailing prose",
      ',"extra":true}',
      ' {"op":"remove","path":"/root"}',
      "]",
    ]) {
      expect(tryParsePatch(line + tail)).toBeNull();
    }
    expect(tryParsePatch(line.slice(0, -1))).toBeNull();
    expect(tryParsePatch('{"op":"add","path":"/root","value":}')).toBeNull();
  });

  it("detects RFC-6902-shaped JSON lines and rejects the rest", () => {
    expect(looksLikePatch('{"op":"add","path":"/root","value":"n1"}')).toBe(
      true,
    );
    expect(looksLikePatch("just prose")).toBe(false);
    expect(looksLikePatch('{"foo":1}')).toBe(false);

    expect(tryParsePatch('{"op":"add","path":"/root","value":"n1"}')).toEqual({
      op: "add",
      path: "/root",
      value: "n1",
    });
    expect(tryParsePatch("not json")).toBeNull();
    // Looks like a patch but missing required string fields → rejected.
    expect(tryParsePatch('{"op":5,"path":"/x"}')).toBeNull();
  });
});

describe("parseFormSubmitDisplay", () => {
  it("humanizes submitted form commands without exposing values", () => {
    expect(
      parseFormSubmitDisplay(
        '[form:submit reminder-details] {"title":"Draft report"}',
      ),
    ).toEqual({ formId: "reminder-details", label: "reminder details" });
    expect(parseFormSubmitDisplay("[form:submit reminder_details] {}")).toEqual(
      { formId: "reminder_details", label: "reminder details" },
    );
  });

  it("ignores ordinary prose and assistant form widgets", () => {
    expect(
      parseFormSubmitDisplay("hello [form:submit reminder] {}"),
    ).toBeNull();
    expect(parseFormSubmitDisplay("[FORM]\n{}")).toBeNull();
  });
});

describe("compilePatches", () => {
  it("builds a UiSpec from root/elements/state add+replace ops", () => {
    const spec = compilePatches([
      { op: "add", path: "/root", value: "n1" },
      { op: "add", path: "/elements/n1", value: { type: "Text", text: "hi" } },
      { op: "add", path: "/state/count", value: 1 },
    ] as never);
    expect(spec).not.toBeNull();
    if (!spec) {
      throw new Error("Expected the compiled UI specification");
    }
    expect(spec.root).toBe("n1");
    expect((spec.elements as Record<string, unknown>).n1).toEqual({
      type: "Text",
      text: "hi",
    });
    expect((spec.state as Record<string, unknown>).count).toBe(1);
  });

  it("returns null when no string root is set (not a valid UiSpec)", () => {
    expect(
      compilePatches([
        { op: "add", path: "/elements/n1", value: { type: "Text" } },
      ] as never),
    ).toBeNull();
  });

  it("ignores non-add/replace ops", () => {
    const spec = compilePatches([
      { op: "add", path: "/root", value: "n1" },
      { op: "add", path: "/elements/n1", value: { type: "Text" } },
      { op: "remove", path: "/elements/n1" },
    ] as never);
    expect(spec).not.toBeNull();
    if (!spec) {
      throw new Error("Expected a UI specification after ignored remove ops");
    }
    expect((spec.elements as Record<string, unknown>).n1).toEqual({
      type: "Text",
    });
  });

  it("refuses to write prototype-pollution state paths", () => {
    const spec = compilePatches([
      { op: "add", path: "/root", value: "n1" },
      { op: "add", path: "/elements/n1", value: { type: "Text" } },
      { op: "add", path: "/state/__proto__/polluted", value: true },
      { op: "add", path: "/state/constructor", value: "boom" },
    ] as never);
    expect(spec).not.toBeNull();
    const state = spec?.state as Record<string, unknown>;
    expect(Object.hasOwn(state, "constructor")).toBe(false);
    // No global prototype pollution leaked out.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("findPatchRegions", () => {
  it("finds a contiguous JSONL patch block and compiles it", () => {
    const text = [
      '{"op":"add","path":"/root","value":"n1"}',
      '{"op":"add","path":"/elements/n1","value":{"type":"Text"}}',
    ].join("\n");
    const regions = findPatchRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0].start).toBe(0);
    expect(regions[0].end).toBe(text.length);
    expect(regions[0].spec.root).toBe("n1");
  });

  it("tolerates a single blank line between patch lines", () => {
    const text = [
      '{"op":"add","path":"/root","value":"n1"}',
      "",
      '{"op":"add","path":"/elements/n1","value":{"type":"Text"}}',
    ].join("\n");
    expect(findPatchRegions(text)).toHaveLength(1);
  });

  it("stops the block at non-patch prose and reports the region offset", () => {
    const prose = "Here is the UI:\n";
    const text = `${prose}{"op":"add","path":"/root","value":"n1"}\n{"op":"add","path":"/elements/n1","value":{"type":"Text"}}\nDone.`;
    const regions = findPatchRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0].start).toBe(prose.length);
    expect(text.slice(regions[0].start, regions[0].end)).toContain(
      '"op":"add"',
    );
    expect(text.slice(regions[0].start, regions[0].end)).not.toContain("Done.");
  });

  it("returns nothing for plain prose", () => {
    expect(findPatchRegions("just a normal reply, no patches here")).toEqual(
      [],
    );
  });
});

describe("normalizeDisplayText", () => {
  it("strips hidden reasoning blocks, trailing partial tags, and trims", () => {
    expect(normalizeDisplayText("A<think>secret</think>B").trim()).toBe("A B");
    // A chunk that ends mid-tag during streaming must not leak the fragment.
    expect(normalizeDisplayText("Hello<thi")).toBe("Hello");
    expect(normalizeDisplayText("  spaced  ")).toBe("spaced");
  });
});

describe("parseSegments trigger-character pre-gate", () => {
  it("returns one text segment for plain streamed prose (no trigger chars)", () => {
    // The common streaming shape: growing prose with none of ` [ { < — the
    // pre-gate must short-circuit to a single text segment whose content is
    // exactly the normalized text (identical to the full-scan result).
    const prose =
      "Sure — I checked the calendar and you have three meetings tomorrow. " +
      "The first starts at 9am, then a design review after lunch.";
    expect(parseSegments(prose, false)).toEqual([
      { kind: "text", text: prose },
    ]);
  });

  it("still returns a single text segment when trigger chars appear in plain prose", () => {
    // The gate only skips work; text that CONTAINS a trigger char but no real
    // region must come out identical to before (one text segment).
    const prose = "Set the value to {something} in [brackets] with a < sign.";
    expect(parseSegments(prose, false)).toEqual([
      { kind: "text", text: prose },
    ]);
  });

  it("parses a [CONFIG:…] marker (gated on '[')", () => {
    const segments = parseSegments("Set it up: [CONFIG:openai]", false);
    expect(segments).toEqual([
      { kind: "text", text: "Set it up: " },
      { kind: "config", pluginId: "openai" },
    ]);
  });

  it("parses an inline widget marker (gated on '[')", () => {
    const segments = parseSegments(
      "[CHOICE:pick]\none=One\ntwo=Two\n[/CHOICE]",
      false,
    );
    expect(segments.some((s) => s.kind === "widget")).toBe(true);
  });

  it("parses a fenced UiSpec (gated on '`')", () => {
    const spec = '{"root":"a","elements":{"a":{"type":"text"}}}';
    const segments = parseSegments(`\`\`\`json\n${spec}\n\`\`\``, false);
    expect(segments.some((s) => s.kind === "ui-spec")).toBe(true);
  });

  it("parses a JSONL patch block (gated on '{')", () => {
    const patches = [
      '{"op":"add","path":"/root","value":"a"}',
      '{"op":"add","path":"/elements/a","value":{"type":"text"}}',
    ].join("\n");
    const segments = parseSegments(patches, false);
    expect(segments.some((s) => s.kind === "ui-spec")).toBe(true);
  });

  it("parses a fenced code block (gated on '`')", () => {
    const segments = parseSegments("```ts\nconst x = 1;\n```", false);
    expect(segments).toEqual([
      { kind: "code", code: "const x = 1;", inline: false, lang: "ts" },
    ]);
  });

  it("parses a permission request card (gated on '{' / '`')", () => {
    const payload =
      '{"action":"permission_request","permission":"camera",' +
      '"reason":"to scan the QR code","feature":"QR scan"}';
    const segments = parseSegments(`May I use the camera?\n${payload}`, false);
    expect(segments.some((s) => s.kind === "permission")).toBe(true);
  });

  it("parses analysis-mode XML blocks (gated on '<')", () => {
    const segments = parseSegments("<thought>weighing options</thought>", true);
    expect(segments.some((s) => s.kind === "analysis-xml")).toBe(true);
  });
});
