// @eliza-live-audit allow-route-fixtures
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type TriggerSummary = {
  id: string;
  taskId: string;
  displayName: string;
  instructions: string;
  triggerType: "interval" | "once" | "cron" | "event";
  enabled: boolean;
  wakeMode: "inject_now" | "next_autonomy_cycle";
  createdBy: string;
  eventKind?: string;
  intervalMs?: number;
  runCount: number;
  nextRunAtMs?: number;
  updatedAt?: number;
  kind?: "text" | "workflow";
  workflowId?: string;
  workflowName?: string;
};

type Workflow = {
  id: string;
  name: string;
  active: boolean;
  description: string;
  source: string;
  language: "tsx";
  steps: Array<{ id: string; label: string; kind: "task"; agent: string }>;
  widgets: Array<{
    id: string;
    title: string;
    surface: "both";
    component: "status";
  }>;
  versionId: string;
  createdAt: string;
  updatedAt: string;
};

type WorkbenchTask = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  isCompleted: boolean;
  updatedAt?: number;
};

type AutomationItem = {
  id: string;
  type: "coordinator_text" | "workflow" | "automation_draft";
  source:
    | "workbench_task"
    | "trigger"
    | "workflow"
    | "workflow_draft"
    | "workflow_shadow"
    | "automation_draft";
  title: string;
  description: string;
  status: "active" | "paused" | "draft";
  enabled: boolean;
  system: boolean;
  isDraft: boolean;
  hasBackingWorkflow: boolean;
  updatedAt: string | null;
  taskId?: string;
  triggerId?: string;
  workflowId?: string;
  draftId?: string;
  task?: WorkbenchTask;
  trigger?: TriggerSummary;
  workflow?: Workflow;
  schedules: TriggerSummary[];
  room?: {
    conversationId: string | null;
    roomId: string;
    scope: string;
    sourceConversationId?: string;
    terminalBridgeConversationId?: string;
  };
};

type Conversation = {
  id: string;
  title: string;
  roomId: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type AutomationsMockApi = {
  getCreatedTask: () => Record<string, unknown> | null;
  getCreatedTrigger: () => Record<string, unknown> | null;
  getCreatedWorkflow: () => Record<string, unknown> | null;
  getGeneratedWorkflow: () => Record<string, unknown> | null;
  getDeletedConversationIds: () => string[];
};

const NOW_ISO = "2026-04-23T20:00:00.000Z";
const HOUR_MS = 60 * 60 * 1000;

function workflowFixture(id: string, name: string, active = true): Workflow {
  return {
    id,
    name,
    active,
    description: "Receives a message and creates a concise digest.",
    language: "tsx",
    source: `/** @jsxImportSource smthrs */\nimport { createSmithers } from "smthrs/create";\nexport default createSmithers({}).smithers(() => null);`,
    steps: [
      {
        id: `${id}-summarize`,
        label: "Summarize",
        kind: "task",
        agent: "elizaOS",
      },
      {
        id: `${id}-send`,
        label: "Send digest",
        kind: "task",
        agent: "elizaOS",
      },
    ],
    widgets: [
      {
        id: "status",
        title: "Digest status",
        surface: "both",
        component: "status",
      },
    ],
    versionId: `${id}-v1`,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
}

function eventTaskItem(): AutomationItem {
  const task: WorkbenchTask = {
    id: "task-event-message",
    name: "Message triage",
    description: "Summarize each inbound message.",
    tags: ["event:message.received"],
    isCompleted: false,
    updatedAt: Date.parse(NOW_ISO),
  };
  const trigger: TriggerSummary = {
    id: "trigger-event-message",
    taskId: task.id,
    displayName: "Message triage",
    instructions: "Summarize each inbound message.",
    triggerType: "event",
    eventKind: "message.received",
    enabled: true,
    wakeMode: "inject_now",
    createdBy: "playwright",
    runCount: 0,
    updatedAt: Date.parse(NOW_ISO),
    kind: "text",
  };
  return {
    id: "trigger:trigger-event-message",
    type: "coordinator_text",
    source: "trigger",
    title: "Message triage",
    description: "Summarize each inbound message.",
    status: "active",
    enabled: true,
    system: false,
    isDraft: false,
    hasBackingWorkflow: false,
    updatedAt: NOW_ISO,
    taskId: task.id,
    triggerId: trigger.id,
    task,
    trigger,
    schedules: [trigger],
  };
}

function workflowItem(workflow: Workflow): AutomationItem {
  const schedule: TriggerSummary = {
    id: `trigger-${workflow.id}`,
    taskId: `task-${workflow.id}`,
    displayName: `Run ${workflow.name}`,
    instructions: `Run workflow ${workflow.name}`,
    triggerType: "interval",
    intervalMs: HOUR_MS,
    enabled: true,
    wakeMode: "inject_now",
    createdBy: "playwright",
    runCount: 1,
    nextRunAtMs: Date.parse(NOW_ISO) + HOUR_MS,
    updatedAt: Date.parse(NOW_ISO),
    kind: "workflow",
    workflowId: workflow.id,
    workflowName: workflow.name,
  };
  return {
    id: `workflow:${workflow.id}`,
    type: "workflow",
    source: "workflow",
    title: workflow.name,
    description: "",
    status: workflow.active ? "active" : "paused",
    enabled: workflow.active,
    system: false,
    isDraft: false,
    hasBackingWorkflow: true,
    updatedAt: NOW_ISO,
    workflowId: workflow.id,
    workflow,
    schedules: [schedule],
    room: {
      conversationId: `conversation-${workflow.id}`,
      roomId: `room-${workflow.id}`,
      scope: "automation-workflow",
    },
  };
}

function draftWorkflowItem(
  draftId = "draft-existing",
  conversationId = "conversation-draft-existing",
): AutomationItem {
  return {
    id: `workflow-draft:${draftId}`,
    type: "automation_draft",
    source: "workflow_draft",
    title: "Draft",
    description: "",
    status: "draft",
    enabled: false,
    system: false,
    isDraft: true,
    hasBackingWorkflow: false,
    updatedAt: NOW_ISO,
    workflowId: draftId,
    draftId,
    schedules: [],
    room: {
      conversationId,
      roomId: `room-${draftId}`,
      scope: "automation-workflow-draft",
    },
  };
}

function automationSummary(automations: AutomationItem[]) {
  return {
    total: automations.length,
    coordinatorCount: automations.filter(
      (item) => item.type !== "workflow_service",
    ).length,
    workflowCount: automations.filter((item) => item.type === "workflow")
      .length,
    scheduledCount: automations.reduce(
      (count, item) => count + item.schedules.length,
      0,
    ),
    draftCount: automations.filter((item) => item.isDraft).length,
  };
}

async function installAutomationsApi(
  page: Page,
  initialAutomations: AutomationItem[],
): Promise<AutomationsMockApi> {
  let automations = [...initialAutomations];
  const workflows = new Map<string, Workflow>();
  const conversations = new Map<string, Conversation>();
  let createdTask: Record<string, unknown> | null = null;
  let createdTrigger: Record<string, unknown> | null = null;
  let createdWorkflow: Record<string, unknown> | null = null;
  let generatedWorkflow: Record<string, unknown> | null = null;
  const deletedConversationIds: string[] = [];

  for (const item of automations) {
    if (item.workflowId && item.workflow) {
      workflows.set(item.workflowId, item.workflow);
    }
    if (item.room?.conversationId) {
      conversations.set(item.room.conversationId, {
        id: item.room.conversationId,
        title: item.title,
        roomId: item.room.roomId,
        metadata: {
          scope: item.room.scope,
          workflowId: item.hasBackingWorkflow ? item.workflowId : undefined,
          draftId: item.draftId,
        },
        createdAt: item.updatedAt ?? NOW_ISO,
        updatedAt: item.updatedAt ?? NOW_ISO,
      });
    }
  }

  const fulfillJson = async (
    route: Parameters<Page["route"]>[1] extends (route: infer R) => unknown
      ? R
      : never,
    body: unknown,
    status = 200,
  ) => {
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  };

  await page.route("**/api/workbench/tasks**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (request.method() === "GET" && path === "/api/workbench/tasks") {
      await fulfillJson(route, {
        tasks: automations.map((item) => item.task).filter(Boolean),
      });
      return;
    }

    if (request.method() === "POST" && path === "/api/workbench/tasks") {
      createdTask = request.postDataJSON() as Record<string, unknown>;
      const task: WorkbenchTask = {
        id: "task-created",
        name: String(createdTask.name ?? "Created task"),
        description: String(createdTask.description ?? ""),
        tags: Array.isArray(createdTask.tags)
          ? createdTask.tags.map(String)
          : [],
        isCompleted: false,
        updatedAt: Date.parse(NOW_ISO),
      };
      automations = [
        ...automations,
        {
          id: `task:${task.id}`,
          type: "coordinator_text",
          source: "workbench_task",
          title: task.name,
          description: task.description,
          status: "active",
          enabled: true,
          system: false,
          isDraft: false,
          hasBackingWorkflow: false,
          updatedAt: NOW_ISO,
          taskId: task.id,
          task,
          schedules: [],
        },
      ];
      await fulfillJson(route, { task });
      return;
    }

    if (request.method() === "PUT") {
      const taskId = decodeURIComponent(path.split("/").pop() ?? "");
      const body = request.postDataJSON() as Record<string, unknown>;
      let updatedTask: WorkbenchTask | null = null;
      automations = automations.map((item) => {
        if (item.task?.id !== taskId) return item;
        const nextTask = {
          ...item.task,
          name: String(body.name ?? item.task.name),
          description: String(body.description ?? item.task.description),
          tags: Array.isArray(body.tags)
            ? body.tags.map(String)
            : item.task.tags,
          updatedAt: Date.parse(NOW_ISO),
        };
        updatedTask = nextTask;
        return {
          ...item,
          title: nextTask.name,
          description: nextTask.description,
          updatedAt: NOW_ISO,
          task: nextTask,
        };
      });
      if (updatedTask) {
        await fulfillJson(route, { task: updatedTask });
        return;
      }
      await fulfillJson(route, { error: "not found" }, 404);
      return;
    }

    await fulfillJson(route, { ok: true });
  });

  await page.route("**/api/automations", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      automations,
      summary: automationSummary(automations),
      workflowStatus: {
        mode: "cloud",
        host: "eliza-cloud",
        status: "ready",
        cloudConnected: false,
        localEnabled: false,
        platform: "cloud",
        cloudHealth: "healthy",
        engine: "smthrs",
      },
      workflowFetchError: null,
    });
  });

  await page.route("**/api/triggers**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/triggers") {
      await fulfillJson(route, {
        triggers: automations
          .map((item) => item.trigger ?? item.schedules[0])
          .filter(Boolean),
      });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/runs")) {
      await fulfillJson(route, { runs: [] });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/triggers/health") {
      await fulfillJson(route, {
        triggersEnabled: true,
        activeTriggers: 0,
        disabledTriggers: 0,
        totalExecutions: 0,
        totalFailures: 0,
        totalSkipped: 0,
      });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/triggers") {
      createdTrigger = request.postDataJSON() as Record<string, unknown>;
      const trigger: TriggerSummary = {
        id: "trigger-created-event",
        taskId: "task-created-event",
        displayName: String(createdTrigger.displayName ?? "Created task"),
        instructions: String(createdTrigger.instructions ?? ""),
        triggerType:
          createdTrigger.triggerType as TriggerSummary["triggerType"],
        eventKind:
          typeof createdTrigger.eventKind === "string"
            ? createdTrigger.eventKind
            : undefined,
        enabled: true,
        wakeMode: "inject_now",
        createdBy: "playwright",
        runCount: 0,
        updatedAt: Date.parse(NOW_ISO),
        kind: "text",
      };
      automations = [
        ...automations,
        {
          id: `trigger:${trigger.id}`,
          type: "coordinator_text",
          source: "trigger",
          title: trigger.displayName,
          description: trigger.instructions,
          status: "active",
          enabled: true,
          system: false,
          isDraft: false,
          hasBackingWorkflow: false,
          updatedAt: NOW_ISO,
          triggerId: trigger.id,
          trigger,
          schedules: [trigger],
        },
      ];
      await fulfillJson(route, trigger);
      return;
    }
    await fulfillJson(route, { ok: true });
  });

  await page.route("**/api/workflow/workflows**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (request.method() === "GET" && path === "/api/workflow/workflows") {
      await fulfillJson(route, {
        workflows: [...workflows.values()],
      });
      return;
    }

    if (request.method() === "POST" && path === "/api/workflow/workflows") {
      createdWorkflow = request.postDataJSON() as Record<string, unknown>;
      const copy = workflowFixture(
        "workflow-copy",
        String(createdWorkflow.name ?? "Workflow Copy"),
      );
      workflows.set(copy.id, copy);
      automations = [...automations, workflowItem(copy)];
      await fulfillJson(route, copy);
      return;
    }

    if (
      request.method() === "POST" &&
      path === "/api/workflow/workflows/generate"
    ) {
      generatedWorkflow = request.postDataJSON() as Record<string, unknown>;
      const workflow = workflowFixture(
        "workflow-generated",
        "Generated workflow",
      );
      workflows.set(workflow.id, workflow);
      automations = [
        ...automations.filter((item) => !item.isDraft),
        workflowItem(workflow),
      ];
      await fulfillJson(route, { workflow });
      return;
    }

    const workflowId = decodeURIComponent(path.split("/").pop() ?? "");
    const workflow = workflows.get(workflowId);
    if (!workflow) {
      await fulfillJson(route, { error: "not found" }, 404);
      return;
    }
    await fulfillJson(route, workflow);
  });

  await page.route("**/api/conversations**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (request.method() === "GET" && path === "/api/conversations") {
      await fulfillJson(route, { conversations: [...conversations.values()] });
      return;
    }

    if (request.method() === "POST" && path === "/api/conversations") {
      const body = request.postDataJSON() as {
        title?: string;
        metadata?: Record<string, unknown>;
      };
      const conversation: Conversation = {
        id: `conversation-${conversations.size + 1}`,
        title: body.title ?? "Automation",
        roomId: `room-${conversations.size + 1}`,
        metadata: body.metadata,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      };
      conversations.set(conversation.id, conversation);
      // Only a workflow-draft conversation materializes an automation row.
      // The chat shell also POSTs /api/conversations (greeting bootstrap when
      // hydration finds zero conversations); on the real backend that plain
      // chat conversation never surfaces in /api/automations, so the mock
      // must not fabricate a draft for it.
      const isWorkflowDraft =
        body.metadata?.scope === "automation-workflow-draft" ||
        typeof body.metadata?.draftId === "string";
      if (isWorkflowDraft) {
        const draftId =
          typeof body.metadata?.draftId === "string"
            ? body.metadata.draftId
            : `draft-${conversations.size}`;
        automations = [
          ...automations,
          draftWorkflowItem(draftId, conversation.id),
        ];
      }
      await fulfillJson(route, { conversation });
      return;
    }

    const conversationId = decodeURIComponent(path.split("/").pop() ?? "");
    if (request.method() === "PATCH") {
      const existing = conversations.get(conversationId);
      const body = request.postDataJSON() as Partial<Conversation>;
      const conversation: Conversation = {
        ...(existing ?? {
          id: conversationId,
          roomId: `room-${conversationId}`,
          createdAt: NOW_ISO,
        }),
        title: body.title ?? existing?.title ?? "Automation",
        metadata: body.metadata ?? existing?.metadata,
        updatedAt: NOW_ISO,
      };
      conversations.set(conversation.id, conversation);
      await fulfillJson(route, { conversation });
      return;
    }

    if (request.method() === "DELETE") {
      deletedConversationIds.push(conversationId);
      conversations.delete(conversationId);
      automations = automations.filter(
        (item) => item.room?.conversationId !== conversationId,
      );
      await fulfillJson(route, { ok: true });
      return;
    }

    await fulfillJson(route, { error: "not found" }, 404);
  });

  return {
    getCreatedTask: () => createdTask,
    getCreatedTrigger: () => createdTrigger,
    getCreatedWorkflow: () => createdWorkflow,
    getGeneratedWorkflow: () => generatedWorkflow,
    getDeletedConversationIds: () => [...deletedConversationIds],
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const origin = window.location.origin;
    const host = window as unknown as Record<string, unknown>;
    host.__ELIZA_APP_API_BASE__ = origin;
    host.__ELIZAOS_APP_BOOT_CONFIG__ = { apiBase: origin };
    host.__ELIZAOS_API_BASE__ = origin;
  });
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("automations overview empty state encourages creating tasks and workflows", async ({
  page,
}) => {
  await installAutomationsApi(page, []);

  await openAppPath(page, "/automations");

  await expect(page.getByTestId("automations-shell")).toBeVisible();
  const filterMenu = page.getByRole("button", {
    name: "Filter automations, All selected",
  });
  await expect(filterMenu).toBeVisible();
  await expect(page.getByText("Nothing scheduled yet")).toBeVisible();

  await filterMenu.click();
  await page.getByRole("menuitemradio", { name: /Workflows/ }).click();
  await expect(page.getByTestId("automations-empty-state")).toHaveAttribute(
    "aria-label",
    "No workflows",
  );
  await expect(page.getByText("No workflows")).toHaveClass(/sr-only/);

  await expect(
    page.getByRole("button", { name: "New automation" }),
  ).toBeVisible();
  await expect(page.getByTestId("automations-shell")).toBeVisible();
});

test("automations empty state remains reachable beside chat in short landscape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await installAutomationsApi(page, []);

  await openAppPath(page, "/automations");

  const scrollRegion = page.getByTestId("automations-scroll-region");
  const headline = page.getByText("Nothing scheduled yet");
  await expect(scrollRegion).toBeVisible();
  await expect(headline).toBeAttached();
  await page.waitForFunction(
    () =>
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--eliza-chat-clearance",
        ),
      ) > 0,
  );

  await expect(headline).toBeVisible();
  await expect(
    page.getByText("Ask in chat to set up a workflow and it will run here."),
  ).toHaveCount(0);

  const geometry = await page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>(
      '[data-testid="automations-scroll-region"]',
    );
    const title = Array.from(document.querySelectorAll<HTMLElement>("p")).find(
      (element) => element.textContent?.trim() === "Nothing scheduled yet",
    );
    const empty = document.querySelector<HTMLElement>(
      '[data-testid="automations-empty-state"]',
    );
    const chat = document.querySelector<HTMLElement>(
      '[data-testid="chat-sheet"]',
    );
    if (!scroll || !title || !empty || !chat) return null;
    const titleRect = title.getBoundingClientRect();
    const emptyRect = empty.getBoundingClientRect();
    const chatRect = chat.getBoundingClientRect();
    const overlapWidth = Math.max(
      0,
      Math.min(emptyRect.right, chatRect.right) -
        Math.max(emptyRect.left, chatRect.left),
    );
    const overlapHeight = Math.max(
      0,
      Math.min(emptyRect.bottom, chatRect.bottom) -
        Math.max(emptyRect.top, chatRect.top),
    );
    return {
      scrollTop: scroll.scrollTop,
      emptyBottom: emptyRect.bottom,
      titleTop: titleRect.top,
      titleBottom: titleRect.bottom,
      viewportHeight: window.innerHeight,
      overlapArea: overlapWidth * overlapHeight,
      sidePadding: Number.parseFloat(getComputedStyle(scroll).paddingInlineEnd),
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry?.scrollTop).toBe(0);
  expect(geometry?.emptyBottom).toBeLessThanOrEqual(
    geometry?.viewportHeight ?? 0,
  );
  expect(geometry?.titleTop).toBeGreaterThanOrEqual(0);
  expect(geometry?.titleBottom).toBeLessThanOrEqual(
    geometry?.viewportHeight ?? 0,
  );
  expect(geometry?.overlapArea).toBe(0);
  expect(geometry?.sidePadding).toBeGreaterThan(0);
});

test("populated automations remain readable beside chat in short landscape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  const workflow = workflowFixture(
    "workflow-message-pipeline",
    "Message pipeline",
  );
  await installAutomationsApi(page, [eventTaskItem(), workflowItem(workflow)]);

  await openAppPath(page, "/automations");

  const title = page.getByText("Message pipeline");
  await expect(title).toBeVisible();
  await expect(page.getByText("Every hour")).toBeVisible();
  const geometry = await page.evaluate(() => {
    const body = document.querySelector("[data-framed-page-body]");
    const row = document.querySelector(
      "[data-agent-label='Open Message pipeline']",
    );
    if (!(body instanceof HTMLElement) || !(row instanceof HTMLElement)) {
      return null;
    }
    const bodyRect = body.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return {
      bodyWidth: bodyRect.width,
      rowWidth: rowRect.width,
      rowRight: rowRect.right,
      viewportWidth: window.innerWidth,
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry?.bodyWidth).toBeGreaterThanOrEqual(400);
  expect(geometry?.rowWidth).toBeGreaterThanOrEqual(300);
  expect(geometry?.rowRight).toBeLessThan(geometry?.viewportWidth ?? 0);
});

test("automations can list tasks, create a task, and inspect Smithers source", async ({
  page,
}) => {
  const workflow = workflowFixture(
    "workflow-message-pipeline",
    "Message pipeline",
  );
  const api = await installAutomationsApi(page, [
    eventTaskItem(),
    workflowItem(workflow),
  ]);

  await openAppPath(page, "/automations");

  await expect(page.getByTestId("automations-shell")).toBeVisible();
  await expect(page.getByText("Message pipeline")).toBeVisible();
  const filterMenu = page.getByRole("button", {
    name: "Filter automations, All selected",
  });
  await expect(filterMenu).toContainText("2");
  await filterMenu.click();
  await expect(
    page.getByRole("menuitemradio", { name: /Prompts/ }),
  ).toContainText("1");
  await expect(
    page.getByRole("menuitemradio", { name: /Workflows/ }),
  ).toContainText("1");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Message triage" }),
  ).toBeVisible();
  // The row's accessible name is its full text ("Message pipeline Active …"),
  // which collides with the sibling "Run …" button under a bare-title role query.
  // Target the open control by its stable agent-surface label instead
  // (useAgentElement stamps data-agent-label="Open <title>").
  const openMessagePipeline = page.locator(
    '[data-agent-label="Open Message pipeline"]',
  );
  await expect(openMessagePipeline).toBeVisible();

  await openMessagePipeline.click();
  await expect(page.getByTestId("workflow-studio")).toBeVisible();
  await expect(page.getByTestId("smithers-canvas")).toBeVisible();
  await page.getByRole("button", { name: "Source" }).click();
  await expect(page.getByTestId("smithers-source-editor")).toHaveValue(
    /smthrs\/create/,
  );
  await page.getByRole("button", { name: "Close workflow" }).click();

  // The chooser was removed; open the New TaskEditor directly via the automations
  // hash deep-link (#automations/task/__new__, parsed by useAutomationDeepLink).
  await page.evaluate(() => {
    window.location.hash = "#automations/task/__new__";
  });
  await page.getByTestId("task-editor-name").fill("Escalate inbound messages");
  await page
    .getByTestId("task-editor-prompt")
    .fill("Summarize inbound messages and flag urgent ones.");
  await page.getByTestId("task-editor-save").click();
  await expect
    .poll(() => api.getCreatedTask())
    .toMatchObject({
      name: "Escalate inbound messages",
      description: "Summarize inbound messages and flag urgent ones.",
    });
  await expect(page.getByText("Escalate inbound messages")).toBeVisible();
});

// NOTE: the in-app "generate a workflow from a prompt" surface was removed from
// the WorkflowEditor (workflow generation is backend-only now; the UI no longer
// exposes a "Generate from prompt" affordance — see WorkflowEditor.test.tsx
// asserting its absence). The former Playwright case for it is intentionally
// gone; its mock seam (`getGeneratedWorkflow` / the `/generate` route) is left in
// `installAutomationsApi` as a harmless no-op for any future re-introduction.

// Event-triggered automation coverage.
//
// Wiring note: the automations surface creates simple automations through the
// TaskEditor, which POSTs to `/api/workbench/tasks` and encodes the trigger in
// the WorkbenchTask `tags` (`event:<kind>`). The `/api/triggers` POST mock
// (whose captured body is now exposed via `api.getCreatedTrigger()`) is the
// trigger-CRUD seam used by other surfaces; the automations page itself does
// not call it, so `getCreatedTrigger()` stays null here. This test asserts the
// real automations contract: an event trigger renders in the list, and a newly
// created automation is persisted with the expected POST body.
test("automations renders an event trigger and creates a new event automation", async ({
  page,
}) => {
  const api = await installAutomationsApi(page, [eventTaskItem()]);

  await openAppPath(page, "/automations");

  // The seeded event task renders with its event-kind schedule label.
  await expect(
    page.getByRole("button", { name: "Message triage" }),
  ).toBeVisible();
  await expect(page.getByText("On message.received")).toBeVisible();

  // Create a fresh event-triage automation through the real editor flow. The
  // chooser was removed; open the New TaskEditor directly via the hash deep-link.
  await page.evaluate(() => {
    window.location.hash = "#automations/task/__new__";
  });
  await page.getByTestId("task-editor-name").fill("Triage new chat events");
  await page
    .getByTestId("task-editor-prompt")
    .fill("When a chat message arrives, summarize and route it.");
  await page.getByTestId("task-editor-save").click();

  await expect
    .poll(() => api.getCreatedTask())
    .toMatchObject({
      name: "Triage new chat events",
      description: "When a chat message arrives, summarize and route it.",
    });
  // The automations editor never reaches the trigger-CRUD endpoint.
  expect(api.getCreatedTrigger()).toBeNull();

  await expect(page.getByText("Triage new chat events")).toBeVisible();
});
