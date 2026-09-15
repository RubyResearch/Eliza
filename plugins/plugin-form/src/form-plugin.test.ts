/**
 * Tests plugin-form registration and the FORM_CONTEXT provider against a stub
 * runtime whose `useModel` is a mock returning canned extraction responses — no
 * live model.
 */
import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { formAction } from "./actions/form";
import { formEvaluator } from "./evaluators/extractor";
import formPlugin, { FormService } from "./index";
import { formContextProvider } from "./providers/context";
import type { FormControl, FormDefinition, FormSession } from "./types";

const entityId = "00000000-0000-4000-8000-000000000001" as UUID;
const roomId = "00000000-0000-4000-8000-000000000002" as UUID;
const agentId = "00000000-0000-4000-8000-000000000003" as UUID;
const messageId = "00000000-0000-4000-8000-000000000004" as UUID;

function makeMessage(text: string): Memory {
  return {
    id: messageId,
    entityId,
    roomId,
    content: { text },
  } as Memory;
}

function makeSession(overrides: Partial<FormSession> = {}): FormSession {
  const now = Date.now();
  return {
    id: "session-1",
    formId: "signup",
    formVersion: 1,
    entityId,
    roomId,
    status: "active",
    fields: {
      name: {
        status: "filled",
        value: "Jane",
        source: "manual",
        updatedAt: now,
      },
      email: { status: "empty" },
      phone: { status: "empty" },
    },
    history: [],
    effort: {
      interactionCount: 1,
      timeSpentMs: 1000,
      firstInteractionAt: now,
      lastInteractionAt: now,
    },
    expiresAt: now + 86_400_000,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const signupForm: FormDefinition = {
  id: "signup",
  name: "Signup",
  description: "Collect signup details",
  controls: [
    {
      key: "name",
      label: "Name",
      type: "text",
      required: true,
    },
    {
      key: "email",
      label: "Email",
      type: "email",
      required: true,
      askPrompt: "What email should I use?",
    },
    {
      key: "phone",
      label: "Phone",
      type: "text",
      required: false,
    },
  ],
};

function makeRuntime(formService: unknown, modelResponse?: string) {
  const useModel = vi.fn(async () => modelResponse ?? "");
  return {
    agentId,
    getService: vi.fn((serviceType: string) =>
      serviceType === "FORM" ? formService : null,
    ),
    getRoom: vi.fn(async () => ({ id: roomId, worldId: agentId })),
    useModel,
    emitEvent: vi.fn(async () => undefined),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    },
  } as IAgentRuntime & { useModel: typeof useModel };
}

const EMPTY_STATE: State = { values: {}, data: {}, text: "" };

describe("plugin-form registration", () => {
  it("registers the FORM service, context provider, and form evaluator", async () => {
    expect(formPlugin.name).toBe("form");
    expect(formPlugin.services?.map((service) => service.serviceType)).toEqual([
      "FORM",
    ]);
    expect(formPlugin.providers?.map((provider) => provider.name)).toContain(
      "FORM_CONTEXT",
    );
    expect(formPlugin.actions?.map((action) => action.name)).not.toContain(
      "FORM_RESTORE",
    );
    expect(formPlugin.actions?.map((action) => action.name)).not.toContain(
      "FORM",
    );
    expect(formPlugin.actions?.map((action) => action.name)).not.toContain(
      "form_extractor",
    );
    expect(formPlugin.evaluators?.map((ev) => ev.name)).toContain(
      "form_extractor",
    );

    const runtime = makeRuntime(null);
    const service = (await FormService.start(runtime)) as FormService;
    expect(service.listControlTypes().map((type) => type.id)).toContain(
      "email",
    );
    await service.stop();
  });
});

describe("FORM_CONTEXT provider", () => {
  it("emits JSON form context for active and stashed forms", async () => {
    const active = makeSession();
    const stashed = makeSession({
      id: "session-stashed",
      status: "stashed",
      updatedAt: active.updatedAt - 1000,
    });
    const formService = {
      getActiveSession: vi.fn(async () => active),
      getStashedSessions: vi.fn(async () => [stashed]),
      getForm: vi.fn(() => signupForm),
      getSessionContext: vi.fn((session: FormSession) => ({
        hasActiveForm: session.status !== "stashed",
        formId: session.formId,
        formName: signupForm.name,
        progress: session.status === "stashed" ? 33 : 50,
        filledFields: [
          {
            key: "name",
            label: "Name",
            displayValue: "Jane",
          },
        ],
        missingRequired: [
          {
            key: "email",
            label: "Email",
            askPrompt: "What email should I use?",
          },
        ],
        uncertainFields: [],
        nextField: signupForm.controls[1],
        status: session.status,
        stashedCount: 1,
        pendingExternalFields: [],
      })),
    };

    const result = await formContextProvider.get(
      makeRuntime(formService),
      makeMessage("hello"),
      {},
    );

    expect(result.text).toContain("form_context_json:");
    expect(result.text).toContain('"required_missing": [');
    expect(result.text).toContain("stashed_forms_json:");
    expect(result.text).not.toContain("# Active Form");
    expect(result.text).not.toContain("- Email");
    expect(result.values?.formContext).toBe(result.text);
  });

  it("returns an explicit error state for a cyclic next-field graph", async () => {
    const cyclic = {
      key: "cyclic",
      label: "Cyclic",
      type: "text",
      fields: [],
    } as FormControl;
    cyclic.fields?.push(cyclic);
    const formService = {
      getActiveSession: vi.fn(async () => makeSession()),
      getStashedSessions: vi.fn(async () => []),
      getForm: vi.fn(() => signupForm),
      getSessionContext: vi.fn(() => ({
        hasActiveForm: true,
        formId: signupForm.id,
        formName: signupForm.name,
        progress: 50,
        filledFields: [],
        missingRequired: [],
        uncertainFields: [],
        nextField: cyclic,
        status: "active",
        stashedCount: 0,
        pendingExternalFields: [],
      })),
    };

    const result = await formContextProvider.get(
      makeRuntime(formService),
      makeMessage("hello"),
      EMPTY_STATE,
    );

    expect(result.data).toMatchObject({ hasActiveForm: false, error: true });
    expect(result.text).toBe('form_context_json:\n{"error":true}');
  });
});

describe("FORM action", () => {
  it("validates only when stashed sessions exist and no active session", async () => {
    const stashed = makeSession({ id: "stashed", status: "stashed" });
    const formService = {
      getActiveSession: vi.fn(async () => null),
      getStashedSessions: vi.fn(async () => [stashed]),
    };
    const runtime = makeRuntime(formService);

    await expect(
      formAction.validate(runtime, makeMessage("anything"), {}),
    ).resolves.toBe(true);

    formService.getStashedSessions = vi.fn(async () => []);
    await expect(
      formAction.validate(runtime, makeMessage("anything"), {}),
    ).resolves.toBe(false);
  });

  it("restores the newest stashed form and invokes the callback", async () => {
    const stashed = makeSession({ id: "stashed", status: "stashed" });
    const restored = makeSession({ id: "restored", status: "active" });
    const formService = {
      getActiveSession: vi.fn(async () => null),
      getStashedSessions: vi.fn(async () => [stashed]),
      restore: vi.fn(async () => restored),
      getForm: vi.fn(() => signupForm),
      getSessionContext: vi.fn(() => ({
        hasActiveForm: true,
        formId: signupForm.id,
        formName: signupForm.name,
        progress: 50,
        filledFields: [
          {
            key: "name",
            label: "Name",
            displayValue: "Jane",
          },
        ],
        missingRequired: [],
        uncertainFields: [],
        nextField: signupForm.controls[1],
        status: "active",
        pendingExternalFields: [],
      })),
    };
    const runtime = makeRuntime(formService);
    const message = makeMessage("resume my form");
    const callback = vi.fn();

    await expect(formAction.validate(runtime, message, {})).resolves.toBe(true);
    const result = await formAction.handler(runtime, message, {}, {}, callback);

    expect(result.success).toBe(true);
    expect(formService.restore).toHaveBeenCalledWith("stashed", entityId);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('I\'ve restored your "Signup" form.'),
      }),
    );
  });
});

describe("form_extractor evaluator", () => {
  it("shouldRun returns true with active session", async () => {
    const session = makeSession();
    const formService = {
      getActiveSession: vi.fn(async () => session),
      getStashedSessions: vi.fn(async () => []),
    };
    const runtime = makeRuntime(formService);
    const message = makeMessage("my email is jane@example.com");
    await expect(
      formEvaluator.shouldRun({ runtime, message, options: {} }),
    ).resolves.toBe(true);
  });

  it("shouldRun returns false with no active or stashed sessions", async () => {
    const formService = {
      getActiveSession: vi.fn(async () => null),
      getStashedSessions: vi.fn(async () => []),
    };
    const runtime = makeRuntime(formService);
    const message = makeMessage("hi there");
    await expect(
      formEvaluator.shouldRun({ runtime, message, options: {} }),
    ).resolves.toBe(false);
  });

  it("prompt section emits intent_options and field descriptions", async () => {
    const session = makeSession();
    const formService = {
      getActiveSession: vi.fn(async () => session),
      getStashedSessions: vi.fn(async () => []),
      getForm: vi.fn(() => signupForm),
      getControlType: vi.fn(() => undefined),
    };
    const runtime = makeRuntime(formService);
    const message = makeMessage("my email is jane@example.com");
    const prepared = await formEvaluator.prepare?.({
      runtime,
      message,
      state: EMPTY_STATE,
      options: {},
    });
    const promptText = formEvaluator.prompt({
      runtime,
      message,
      state: EMPTY_STATE,
      options: {},
      prepared,
    });
    expect(promptText).toContain('"intent_options"');
    expect(promptText).toContain('"key": "email"');
    expect(promptText).toContain('"formIntent"');
    expect(promptText).toContain('"formExtractions"');
  });

  it("formExtractions processor updates simple fields", async () => {
    const session = makeSession();
    const refreshed = makeSession();
    const formService = {
      getActiveSession: vi.fn(async () => refreshed),
      getStashedSessions: vi.fn(async () => []),
      getForm: vi.fn(() => signupForm),
      getControlType: vi.fn(() => undefined),
      updateField: vi.fn(async () => undefined),
      saveSession: vi.fn(async () => undefined),
      isExternalType: vi.fn(() => false),
    };
    const runtime = makeRuntime(formService);
    const message = makeMessage("my email is jane@example.com");
    const prepared = {
      formService: formService as FormService,
      session,
      form: signupForm,
      templateValues: {},
      entityId,
    };

    const extractionsProcessor = formEvaluator.processors?.find(
      (p) => p.name === "formExtractions",
    );
    if (!extractionsProcessor)
      throw new Error("formExtractions processor missing");
    const result = await extractionsProcessor.process({
      runtime,
      message,
      state: EMPTY_STATE,
      options: {},
      prepared,
      output: {
        formIntent: "fill_form",
        formExtractions: [
          {
            field: "email",
            value: "jane@example.com",
            confidence: 0.95,
            isCorrection: false,
          },
        ],
      },
      evaluatorName: "form_extractor",
    });

    expect(result?.success).toBe(true);
    expect(formService.updateField).toHaveBeenCalledWith(
      "session-1",
      entityId,
      "email",
      "jane@example.com",
      0.95,
      "extraction",
      message.id,
    );
    expect(formService.saveSession).toHaveBeenCalled();
  });

  it("formIntent processor routes to FormService.submit on submit intent", async () => {
    const session = makeSession();
    const formService = {
      getActiveSession: vi.fn(async () => session),
      getStashedSessions: vi.fn(async () => []),
      getForm: vi.fn(() => signupForm),
      submit: vi.fn(async () => undefined),
      saveSession: vi.fn(async () => undefined),
    };
    const runtime = makeRuntime(formService);
    const message = makeMessage("submit");
    const prepared = {
      formService: formService as FormService,
      session,
      form: signupForm,
      templateValues: {},
      entityId,
    };

    const intentProcessor = formEvaluator.processors?.find(
      (p) => p.name === "formIntent",
    );
    if (!intentProcessor) throw new Error("formIntent processor missing");
    const result = await intentProcessor.process({
      runtime,
      message,
      state: EMPTY_STATE,
      options: {},
      prepared,
      output: { formIntent: "submit", formExtractions: [] },
      evaluatorName: "form_extractor",
    });

    expect(result?.success).toBe(true);
    expect(formService.submit).toHaveBeenCalledWith("session-1", entityId);
  });
});
