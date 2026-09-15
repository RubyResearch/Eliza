/** Verifies InlineWidgetText through the package's configured test harness. */
// @vitest-environment jsdom
//
// Verifies the chat-overlay inline-widget renderer (#8997, #9304): assistant
// text with inline-widget markers renders the real widgets (choice / form /
// followups / task) and never leaks the raw `[CHOICE]`/`[FORM]`/`[TASK]`/
// `[FOLLOWUPS]` marker syntax as text; plain replies pass through unchanged.
// Since #9304 the overlay shares the full ChatView's `parseSegments`, so it also
// renders fenced code blocks plus the structured cards (`[CONFIG:…]`, fenced
// UiSpec JSON, permission requests) instead of leaking their raw markers.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setAppValueForTests } from "../../state/app-store";
import { AppContext } from "../../state/useApp";

vi.mock("@elizaos/ui", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    getPermission: vi.fn(),
    getPlugins: vi.fn(),
    openPermissionSettings: vi.fn(),
    requestPermission: vi.fn(),
    updatePlugin: vi.fn(),
    // The task card hydrates its header once and subscribes to the WS activity
    // feed on mount; a never-resolving fetch + no-op unsubscribe keep it on its
    // fallback title without a backend (marker-leak assertion is all this needs).
    getCodingAgentTaskThread: vi.fn(() => new Promise(() => undefined)),
    onWsEvent: () => () => undefined,
  },
}));

vi.mock("../../api/client", () => ({ client: clientMock }));

import { InlineWidgetText } from "./InlineWidgetText";
// The task widget is plugin-owned (registered by plugin-task-coordinator at
// boot, not a built-in); register it here so this surface renders it too.
import { registerTaskWidget } from "./widgets/task-widget";

registerTaskWidget();

function withApp(node: React.ReactElement) {
  const sendActionMessage = vi.fn();
  const appValue = {
    t: (key: string, vars?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        "messagecontent.HideJson": "Hide JSON",
        "messagecontent.InteractiveUI": "Interactive UI",
        "messagecontent.ViewJson": "View JSON",
      };
      const template = String(vars?.defaultValue ?? translations[key] ?? key);
      return template.replace(/\{\{(\w+)\}\}/g, (whole, name) =>
        vars && name in vars ? String(vars[name]) : whole,
      );
    },
    loadPlugins: vi.fn(() => Promise.resolve()),
    sendActionMessage,
    setActionNotice: vi.fn(),
  } as never;
  __setAppValueForTests(appValue);
  const utils = render(
    <AppContext.Provider value={appValue}>{node}</AppContext.Provider>,
  );
  return { ...utils, sendActionMessage };
}

describe("InlineWidgetText", () => {
  beforeEach(() => {
    clientMock.getPermission.mockResolvedValue({
      id: "reminders",
      status: "not-determined",
      lastChecked: 0,
      canRequest: true,
      platform: "darwin",
    });
    clientMock.requestPermission.mockResolvedValue({
      id: "reminders",
      status: "granted",
      lastChecked: 0,
      canRequest: false,
      platform: "darwin",
    });
    clientMock.openPermissionSettings.mockResolvedValue(undefined);
    clientMock.getPlugins.mockReset();
    clientMock.updatePlugin.mockReset();
  });

  afterEach(() => {
    cleanup();
    __setAppValueForTests(null);
    vi.clearAllMocks();
  });

  it("renders plain text unchanged (fast path)", () => {
    const { container } = withApp(
      <InlineWidgetText content="just a normal reply" />,
    );
    expect(container.textContent).toContain("just a normal reply");
  });

  it("renders a choice picker and does not leak the [CHOICE] marker", () => {
    const { container } = withApp(
      <InlineWidgetText
        content={
          "Approve this?\n[CHOICE:approval id=c1]\nyes=Approve\nno=Reject\n[/CHOICE]"
        }
      />,
    );
    expect(container.textContent ?? "").toContain("Approve");
    expect(container.textContent ?? "").not.toContain("[CHOICE");
    expect(container.textContent ?? "").not.toContain("[/CHOICE]");
  });

  it("renders an inline form and does not leak the [FORM] marker", () => {
    const form = JSON.stringify({
      title: "Trip details",
      fields: [{ name: "destination", type: "text", label: "Destination" }],
    });
    const { container } = withApp(
      <InlineWidgetText content={`Fill this out:\n[FORM]\n${form}\n[/FORM]`} />,
    );
    expect(container.textContent ?? "").toContain("Destination");
    expect(container.textContent ?? "").not.toContain("[FORM]");
  });

  it("renders suggestion chips and does not leak the [FOLLOWUPS] marker", () => {
    const { container } = withApp(
      <InlineWidgetText
        content={"Done.\n[FOLLOWUPS]\nrerun=Run again\n[/FOLLOWUPS]"}
      />,
    );
    expect(container.textContent ?? "").toContain("Run again");
    expect(container.textContent ?? "").not.toContain("[FOLLOWUPS]");
  });

  it("renders a task card and does not leak the [TASK] marker", () => {
    const { container } = withApp(
      <InlineWidgetText
        content={`Created it.\n[TASK:${"a".repeat(12)}]Build the thing[/TASK]\nThe builders are running.`}
      />,
    );
    // The surrounding prose still renders, and the raw marker is gone (replaced
    // by the registered task widget).
    expect(container.textContent ?? "").toContain("Created it.");
    expect(container.textContent ?? "").toContain("The builders are running.");
    expect(container.textContent ?? "").not.toContain("[TASK:");
    expect(container.textContent ?? "").not.toContain("[/TASK]");
  });

  // #9304: the overlay previously re-implemented a partial parser that only knew
  // the inline-widget markers, so the structured/hidden markers below leaked as
  // raw text. Sharing the full ChatView `parseSegments` closes that drift.

  it("renders a [CONFIG:…] card instead of leaking the marker", () => {
    clientMock.getPlugins.mockReturnValue(new Promise(() => undefined));
    const { container } = withApp(
      <InlineWidgetText content={"Configure it:\n[CONFIG:weather]\nThanks."} />,
    );
    expect(container.textContent ?? "").toContain("Configure it:");
    expect(container.textContent ?? "").toContain("Thanks.");
    expect(container.textContent ?? "").toContain(
      "Loading weather configuration...",
    );
    expect(container.textContent ?? "").not.toContain("[CONFIG");
  });

  it("renders a fenced code block instead of leaking the raw fence", () => {
    const { container, queryByTestId } = withApp(
      <InlineWidgetText
        content={"Here is the snippet:\n```ts\nconst x = 1;\n```\nDone."}
      />,
    );
    expect(queryByTestId("code-block")).not.toBeNull();
    expect(container.textContent ?? "").toContain("const x = 1;");
    expect(container.textContent ?? "").toContain("Here is the snippet:");
    expect(container.textContent ?? "").not.toContain("```");
  });

  it("strips hidden <think> reasoning blocks (never shown to the user)", () => {
    const { container } = withApp(
      <InlineWidgetText
        content={"Visible answer.<think>secret chain of thought</think> More."}
      />,
    );
    expect(container.textContent ?? "").toContain("Visible answer.");
    expect(container.textContent ?? "").toContain("More.");
    expect(container.textContent ?? "").not.toContain(
      "secret chain of thought",
    );
    expect(container.textContent ?? "").not.toContain("<think>");
  });

  it("renders a complete model table with a surplus closing brace without another model call", () => {
    const patch = {
      op: "add",
      path: "/elements/comparison",
      value: {
        type: "Table",
        props: {
          columns: ["Project", "Tasks"],
          rows: [
            ["Amber", "3"],
            ["Birch", "7"],
            ["Cedar", "2"],
          ],
        },
        children: [],
      },
    };
    const { container } = withApp(
      <InlineWidgetText
        content={
          '{"op":"add","path":"/root","value":"comparison"}\n' +
          JSON.stringify(patch) +
          "}"
        }
      />,
    );
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Cedar" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "7" })).toBeTruthy();
    expect(container.textContent).not.toContain('"op"');
  });

  it("renders a fenced UiSpec JSON block as an interactive UI block", () => {
    // Valid UiSpec shape (root: string + elements: object) so parseSegments
    // classifies it as a ui-spec region, not code.
    const spec = JSON.stringify({
      root: "heading",
      state: {},
      elements: {
        heading: {
          type: "Heading",
          props: { text: "Weekly overview", level: "h2" },
          children: [],
        },
      },
    });
    const { container } = withApp(
      <InlineWidgetText
        content={`Rendering UI:\n\`\`\`json\n${spec}\n\`\`\`\nOk.`}
      />,
    );
    expect(container.textContent ?? "").toContain("Rendering UI:");
    expect(container.textContent ?? "").toContain("Ok.");
    expect(container.textContent ?? "").toContain("Interactive UI");
    expect(container.textContent ?? "").toContain("Weekly overview");
    // The raw JSON keys / fence must not leak as literal text.
    expect(container.textContent ?? "").not.toContain('"elements"');
    expect(container.textContent ?? "").not.toContain("```");
  });

  it("renders permission_request as a permission card with live callbacks", async () => {
    const request =
      "I need access before I can add that.\n```json\n" +
      JSON.stringify({
        action: "permission_request",
        permission: "reminders",
        reason: "I need access to Apple Reminders to add this reminder.",
        feature: "lifeops.reminders.create",
        fallback_offered: true,
      }) +
      "\n```";
    const { container, sendActionMessage } = withApp(
      <InlineWidgetText content={request} />,
    );

    expect(await screen.findByTestId("permission-card")).toBeTruthy();
    expect(container.textContent ?? "").toContain("Apple Reminders");
    expect(container.textContent ?? "").toContain(
      "I need access before I can add that.",
    );
    expect(container.textContent ?? "").not.toContain("permission_request");

    fireEvent.click(screen.getByTestId("permission-card-fallback"));
    expect(sendActionMessage).toHaveBeenCalledWith(
      "__permission_card__:use_fallback feature=lifeops.reminders.create permission=reminders",
    );

    cleanup();
    const rerendered = withApp(<InlineWidgetText content={request} />);
    fireEvent.click(await screen.findByTestId("permission-card-primary"));
    await waitFor(() =>
      expect(rerendered.sendActionMessage).toHaveBeenCalledWith(
        "__permission_card__:granted feature=lifeops.reminders.create permission=reminders",
      ),
    );
  });
});
