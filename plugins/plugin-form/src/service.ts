/**
 * @module service
 * @description Central service for managing agent-guided user journeys
 *
 * ## The Core Role
 *
 * The FormService is the **journey controller**. It ensures agents stay on
 * the path defined by form definitions, guiding users reliably to outcomes.
 *
 * Without this service, agents would:
 * - Forget what information they've collected
 * - Miss required fields
 * - Lose progress when users switch topics
 * - Have no way to resume interrupted journeys
 *
 * ## What It Does
 *
 * 1. **Defines Journeys**: Register form definitions (the maps)
 * 2. **Tracks Progress**: Manage sessions (where users are)
 * 3. **Validates Stops**: Ensure collected data meets requirements
 * 4. **Enables Pausing**: Stash journeys for later resumption
 * 5. **Records Completions**: Store submissions (outcomes achieved)
 * 6. **Guides Agents**: Provide context about what to do next
 * 7. **Manages Control Types**: Widget registry for simple, composite, external types
 *
 * ## Widget Registry (ControlType System)
 *
 * The FormService manages a registry of control types:
 *
 * - **Simple types** (text, number, email): Just validate/parse/format
 * - **Composite types** (address, payment setup): Have subcontrols
 * - **External types** (payment, signature): Require async confirmation
 *
 * Built-in types are registered at startup. Plugins can register custom types.
 *
 * WHY a registry:
 * - Decouples type definitions from form definitions
 * - Plugins can add domain-specific types (blockchain addresses, etc.)
 * - Override protection prevents accidental shadowing of built-ins
 *
 * ## Service Lifecycle
 *
 * ```
 * Plugin Init → FormService.start() → Register Builtins → Register Forms → Ready
 *
 * User Message → form evaluator → FormService.updateField() → Session Updated
 *             → FormService.updateSubField() → Subfield Updated
 *             → FormService.activateExternalField() → External Process Started
 *                         → FormService.submit() → Submission Created
 *                         → FormService.stash() → Session Stashed
 *
 * External Event → PaymentService → FormService.confirmExternalField() → Field Filled
 * ```
 *
 * ## State Management
 *
 * The service maintains two types of state:
 *
 * 1. **In-Memory**: Form definitions, control types (loaded at startup)
 * 2. **Persistent**: Sessions, submissions, autofill (via storage.ts)
 *
 * ## Consuming Plugin Pattern
 *
 * Plugins that use forms typically:
 *
 * ```typescript
 * // 1. Register form at plugin init
 * const formService = runtime.getService('FORM') as FormService;
 * formService.registerForm(myFormDefinition);
 *
 * // 2. Optionally register custom control types
 * formService.registerControlType({
 *   id: 'payment',
 *   getSubControls: () => [...],
 *   activate: async (ctx) => {...},
 * });
 *
 * // 3. Start session when needed
 * await formService.startSession('my-form', entityId, roomId);
 *
 * // 4. Register hook workers for submission handling
 * runtime.registerTaskWorker({
 *   name: 'handle_my_form_submission',
 *   execute: async (runtime, options) => {
 *     const { submission } = options;
 *     // Process the submitted data
 *   }
 * });
 * ```
 *
 * ## Error Handling
 *
 * Most methods throw on invalid state (e.g., session not found).
 * Callers should handle errors appropriately.
 */

import {
  type EventPayload,
  type IAgentRuntime,
  type JsonValue,
  logger,
  Service,
  type Task,
  type UUID,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { registerBuiltinTypes } from "./builtins";
import { assertFormControlGraphs } from "./form-control-graph";
import {
  getAutofillData,
  getSessionById,
  saveAutofillData,
  saveSubmission,
  getActiveSession as storageGetActiveSession,
  getAllActiveSessions as storageGetAllActiveSessions,
  getStashedSessions as storageGetStashedSessions,
  getSubmissions as storageGetSubmissions,
  saveSession as storageSaveSession,
} from "./storage";
import type {
  ActivationContext,
  ControlType,
  ExternalActivation,
  FieldHistoryEntry,
  FieldState,
  FilledFieldSummary,
  FormContextState,
  FormControl,
  FormDefinition,
  FormSession,
  FormSubmission,
  MissingFieldSummary,
  PendingExternalFieldSummary,
  UncertainFieldSummary,
} from "./types";
import { FORM_CONTROL_DEFAULTS, FORM_DEFINITION_DEFAULTS } from "./types";
import { formatValue, validateField } from "./validation";

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function assertSafeObjectKey(
  kind: string,
  key: unknown,
): asserts key is string {
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error(`${kind} must be a non-empty string`);
  }
  if (UNSAFE_OBJECT_KEYS.has(key)) {
    throw new Error(`${kind} uses unsafe object key: ${key}`);
  }
}

function createValueMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

// ============================================================================
// FORM SERVICE
// ============================================================================

/**
 * FormService - Central service for managing conversational forms.
 *
 * WHY a service:
 * - Services are singletons, one per agent
 * - Persist across conversations
 * - Accessible from actions, evaluators, providers
 *
 * WHY static `start` method:
 * - elizaOS service lifecycle pattern
 * - Async initialization support
 * - Returns Service interface
 */
export class FormService extends Service {
  /** Service type identifier for runtime.getService() */
  static serviceType = "FORM";

  /** Description shown in agent capabilities */
  capabilityDescription = "Manages conversational forms for data collection";

  /**
   * In-memory storage of form definitions.
   *
   * WHY Map:
   * - O(1) lookup by ID
   * - Forms are static after registration
   * - No persistence needed (re-registered on startup)
   */
  private forms: Map<string, FormDefinition> = new Map();

  /**
   * Control type registry.
   *
   * Built-in types are registered on start.
   * Plugins can register custom types.
   */
  private controlTypes: Map<string, ControlType> = new Map();

  /**
   * Start the FormService
   */
  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new FormService(runtime);

    // Register built-in control types
    registerBuiltinTypes((type, options) =>
      service.registerControlType(type, options),
    );

    logger.info("[FormService] Started with built-in types");
    return service;
  }

  /**
   * Stop the FormService
   */
  async stop(): Promise<void> {
    logger.info("[FormService] Stopped");
  }

  // ============================================================================
  // FORM DEFINITION MANAGEMENT
  // ============================================================================

  /**
   * Register a form definition
   */
  registerForm(definition: FormDefinition): void {
    assertSafeObjectKey("Form id", definition?.id);
    if (!Array.isArray(definition.controls)) {
      throw new Error("Form controls must be an array");
    }
    assertFormControlGraphs(definition.controls);

    const controlKeys = new Set<string>();
    for (const control of definition.controls) {
      assertSafeObjectKey("Control key", control?.key);
      if (controlKeys.has(control.key)) {
        throw new Error(`Duplicate control key: ${control.key}`);
      }
      controlKeys.add(control.key);

      if (control.dbbind !== undefined) {
        assertSafeObjectKey("Control dbbind", control.dbbind);
      }
    }

    // Apply defaults
    const form: FormDefinition = {
      ...definition,
      version: definition.version ?? FORM_DEFINITION_DEFAULTS.version,
      status: definition.status ?? FORM_DEFINITION_DEFAULTS.status,
      ux: { ...FORM_DEFINITION_DEFAULTS.ux, ...definition.ux },
      ttl: { ...FORM_DEFINITION_DEFAULTS.ttl, ...definition.ttl },
      nudge: { ...FORM_DEFINITION_DEFAULTS.nudge, ...definition.nudge },
      debug: definition.debug ?? FORM_DEFINITION_DEFAULTS.debug,
      controls: definition.controls.map((control) => ({
        ...control,
        type: control.type || FORM_CONTROL_DEFAULTS.type,
        required: control.required ?? FORM_CONTROL_DEFAULTS.required,
        confirmThreshold:
          control.confirmThreshold ?? FORM_CONTROL_DEFAULTS.confirmThreshold,
        label: control.label || prettify(control.key),
      })),
    };

    this.forms.set(form.id, form);
    logger.debug(`[FormService] Registered form: ${form.id}`);
  }

  /**
   * Get a form definition by ID
   */
  getForm(formId: string): FormDefinition | undefined {
    return this.forms.get(formId);
  }

  /**
   * Get all registered forms
   */
  listForms(): FormDefinition[] {
    return Array.from(this.forms.values());
  }

  // ============================================================================
  // CONTROL TYPE REGISTRY
  // ============================================================================

  /**
   * Register a control type.
   *
   * Control types define how a field type behaves:
   * - Simple types: validate/parse/format
   * - Composite types: have subcontrols
   * - External types: have activate/deactivate for async processes
   *
   * Built-in types (text, number, email, etc.) are registered at startup
   * and protected from override unless explicitly allowed.
   *
   * @param type - The ControlType definition
   * @param options - Registration options
   * @param options.allowOverride - Allow overriding built-in types (default: false)
   *
   * @example
   * ```typescript
   * formService.registerControlType({
   *   id: 'payment',
   *   getSubControls: () => [
   *     { key: 'amount', type: 'number', label: 'Amount', required: true },
   *     { key: 'currency', type: 'select', label: 'Currency', required: true },
   *   ],
   *   activate: async (ctx) => {
   *     const paymentService = ctx.runtime.getService('PAYMENT');
   *     return paymentService.createPending(ctx.subValues);
   *   },
   * });
   * ```
   */
  registerControlType(
    type: ControlType,
    options?: { allowOverride?: boolean },
  ): void {
    const existing = this.controlTypes.get(type.id);

    if (existing) {
      if (existing.builtin && !options?.allowOverride) {
        logger.warn(
          `[FormService] Cannot override builtin type '${type.id}' without allowOverride: true`,
        );
        return;
      }
      logger.warn(`[FormService] Overriding control type: ${type.id}`);
    }

    this.controlTypes.set(type.id, type);
    logger.debug(`[FormService] Registered control type: ${type.id}`);
  }

  /**
   * Get a control type by ID.
   *
   * @param typeId - The type ID to look up
   * @returns The ControlType or undefined if not found
   */
  getControlType(typeId: string): ControlType | undefined {
    return this.controlTypes.get(typeId);
  }

  /**
   * List all registered control types.
   *
   * @returns Array of all registered ControlTypes
   */
  listControlTypes(): ControlType[] {
    return Array.from(this.controlTypes.values());
  }

  /**
   * Check if a control type has subcontrols.
   *
   * @param typeId - The type ID to check
   * @returns true if the type has getSubControls method
   */
  isCompositeType(typeId: string): boolean {
    const type = this.controlTypes.get(typeId);
    return !!type?.getSubControls;
  }

  /**
   * Check if a control type is an external type.
   *
   * @param typeId - The type ID to check
   * @returns true if the type has activate method
   */
  isExternalType(typeId: string): boolean {
    const type = this.controlTypes.get(typeId);
    return !!type?.activate;
  }

  /**
   * Get subcontrols for a composite type.
   *
   * @param control - The parent control
   * @returns Array of subcontrols or empty array if not composite
   */
  getSubControls(control: FormControl): FormControl[] {
    const type = this.controlTypes.get(control.type);
    if (!type?.getSubControls) {
      return [];
    }
    return type.getSubControls(control, this.runtime);
  }

  // ============================================================================
  // SESSION MANAGEMENT
  // ============================================================================

  /**
   * Start a new form session
   */
  async startSession(
    formId: string,
    entityId: UUID,
    roomId: UUID,
    options?: {
      context?: Record<string, JsonValue>;
      initialValues?: Record<string, JsonValue>;
      locale?: string;
    },
  ): Promise<FormSession> {
    const form = this.getForm(formId);
    if (!form) {
      throw new Error(`Form not found: ${formId}`);
    }

    // Check for existing active session
    const existing = await storageGetActiveSession(
      this.runtime,
      entityId,
      roomId,
    );
    if (existing) {
      throw new Error(
        `Active session already exists for this user/room: ${existing.id}`,
      );
    }

    const now = Date.now();

    // Initialize field states
    const fields = createValueMap<FieldState>();
    for (const control of form.controls) {
      if (options?.initialValues?.[control.key] !== undefined) {
        const validation = validateField(
          options.initialValues[control.key],
          control,
          this.getControlType(control.type),
        );
        fields[control.key] = {
          status: validation.valid ? "filled" : "invalid",
          value: options.initialValues[control.key],
          source: "manual",
          updatedAt: now,
          error: validation.error,
        };
      } else if (control.defaultValue !== undefined) {
        const validation = validateField(
          control.defaultValue,
          control,
          this.getControlType(control.type),
        );
        fields[control.key] = {
          status: validation.valid ? "filled" : "invalid",
          value: control.defaultValue,
          source: "default",
          updatedAt: now,
          error: validation.error,
        };
      } else {
        fields[control.key] = { status: "empty" };
      }
    }

    // Calculate initial TTL
    const ttlDays = form.ttl?.minDays ?? 14;
    const expiresAt = now + ttlDays * 24 * 60 * 60 * 1000;

    const session: FormSession = {
      id: uuidv4(),
      formId,
      formVersion: form.version,
      entityId,
      roomId,
      status: "active",
      fields,
      history: [],
      context: options?.context,
      locale: options?.locale,
      effort: {
        interactionCount: 0,
        timeSpentMs: 0,
        firstInteractionAt: now,
        lastInteractionAt: now,
      },
      expiresAt,
      createdAt: now,
      updatedAt: now,
    };

    await storageSaveSession(this.runtime, session);

    // Execute onStart hook
    if (form.hooks?.onStart) {
      await this.executeHook(session, "onStart");
    }

    logger.debug(
      `[FormService] Started session ${session.id} for form ${formId}`,
    );

    return session;
  }

  /**
   * Get active session for entity in room
   */
  async getActiveSession(
    entityId: UUID,
    roomId: UUID,
  ): Promise<FormSession | null> {
    return storageGetActiveSession(this.runtime, entityId, roomId);
  }

  /**
   * Get all active sessions for entity (across all rooms)
   */
  async getAllActiveSessions(entityId: UUID): Promise<FormSession[]> {
    return storageGetAllActiveSessions(this.runtime, entityId);
  }

  /**
   * Get stashed sessions for entity
   */
  async getStashedSessions(entityId: UUID): Promise<FormSession[]> {
    return storageGetStashedSessions(this.runtime, entityId);
  }

  /**
   * Save a session
   */
  async saveSession(session: FormSession): Promise<void> {
    await storageSaveSession(this.runtime, session, true);
  }

  // ============================================================================
  // FIELD UPDATES
  // ============================================================================

  /**
   * Update a field value
   */
  async updateField(
    sessionId: string,
    entityId: UUID,
    field: string,
    value: JsonValue,
    confidence: number,
    source: FieldState["source"],
    messageId?: string,
  ): Promise<void> {
    const session = await getSessionById(this.runtime, entityId, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const form = this.getForm(session.formId);
    if (!form) {
      throw new Error(`Form not found: ${session.formId}`);
    }

    const control = form.controls.find((c) => c.key === field);
    if (!control) {
      throw new Error(`Field not found: ${field}`);
    }

    // Get old value for history
    const oldValue = session.fields[field]?.value;

    // Validate the value
    const validation = validateField(
      value,
      control,
      this.getControlType(control.type),
    );

    // Determine status based on confidence and validation
    let status: FieldState["status"];
    if (!validation.valid) {
      status = "invalid";
    } else if (confidence < (control.confirmThreshold ?? 0.8)) {
      status = "uncertain";
    } else {
      status = "filled";
    }

    const now = Date.now();

    // Add to history for undo
    if (oldValue !== undefined) {
      const historyEntry: FieldHistoryEntry = {
        field,
        oldValue,
        newValue: value,
        timestamp: now,
      };
      session.history.push(historyEntry);

      // Limit history size
      const maxUndo = form.ux?.maxUndoSteps ?? 5;
      if (session.history.length > maxUndo) {
        session.history = session.history.slice(-maxUndo);
      }
    }

    // Update field state
    session.fields[field] = {
      status,
      value,
      confidence,
      source,
      messageId,
      updatedAt: now,
      error: !validation.valid ? validation.error : undefined,
    };

    // Update effort tracking
    session.effort.interactionCount++;
    session.effort.lastInteractionAt = now;
    session.effort.timeSpentMs = now - session.effort.firstInteractionAt;

    // Recalculate TTL
    session.expiresAt = this.calculateTTL(session);

    // Check if all required fields are filled
    const allRequiredFilled = this.checkAllRequiredFilled(session, form);
    if (allRequiredFilled && session.status === "active") {
      session.status = "ready";
      if (form.hooks?.onReady) {
        await this.executeHook(session, "onReady");
      }
    }

    session.updatedAt = now;
    await storageSaveSession(this.runtime, session);

    // Execute onFieldChange hook
    if (form.hooks?.onFieldChange) {
      const hookPayload: Record<string, JsonValue> = { field, value };
      if (oldValue !== undefined) {
        hookPayload.oldValue = oldValue;
      }
      await this.executeHook(session, "onFieldChange", hookPayload);
    }
  }

  /**
   * Undo the last field change
   */
  async undoLastChange(
    sessionId: string,
    entityId: UUID,
  ): Promise<{ field: string; restoredValue: JsonValue } | null> {
    const session = await getSessionById(this.runtime, entityId, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const form = this.getForm(session.formId);
    if (!form?.ux?.allowUndo) {
      return null;
    }

    const lastChange = session.history.pop();
    if (!lastChange) {
      return null;
    }

    // Restore the old value
    if (lastChange.oldValue !== undefined) {
      session.fields[lastChange.field] = {
        status: "filled",
        value: lastChange.oldValue,
        source: "correction",
        updatedAt: Date.now(),
      };
    } else {
      session.fields[lastChange.field] = { status: "empty" };
    }

    session.updatedAt = Date.now();
    await storageSaveSession(this.runtime, session);

    return { field: lastChange.field, restoredValue: lastChange.oldValue };
  }

  /**
   * Skip an optional field
   */
  async skipField(
    sessionId: string,
    entityId: UUID,
    field: string,
  ): Promise<boolean> {
    const session = await getSessionById(this.runtime, entityId, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const form = this.getForm(session.formId);
    if (!form?.ux?.allowSkip) {
      return false;
    }

    const control = form.controls.find((c) => c.key === field);
    if (!control) {
      return false;
    }

    // Can't skip required fields
    if (control.required) {
      return false;
    }

    session.fields[field] = {
      status: "skipped",
      updatedAt: Date.now(),
    };

    session.updatedAt = Date.now();
    await storageSaveSession(this.runtime, session);

    return true;
  }

  /**
   * Confirm an uncertain field value
   */
  async confirmField(
    sessionId: string,
    entityId: UUID,
    field: string,
    accepted: boolean,
  ): Promise<void> {
    const session = await getSessionById(this.runtime, entityId, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const fieldState = session.fields[field];
    if (fieldState?.status !== "uncertain") {
      return;
    }

    const now = Date.now();

    if (accepted) {
      fieldState.status = "filled";
      fieldState.confirmedAt = now;
    } else {
      // Reset the field
      fieldState.status = "empty";
      fieldState.value = undefined;
      fieldState.confidence = undefined;
    }

    fieldState.updatedAt = now;
    session.updatedAt = now;
    await storageSaveSession(this.runtime, session);
  }

  // ============================================================================
  // SUBFIELD UPDATES (for composite types)
  // ============================================================================

  /**
   * Update a subfield value for a composite control type.
   *
   * Composite types (like payment, address) have subcontrols that must
   * all be filled before the parent field is complete.
   *
   * WHY separate from updateField:
   * - Subfields are stored in fieldState.subFields, not session.fields
   * - Parent field status depends on all subfields being filled
   * - Allows tracking subfield confidence/status independently
   *
   * @param sessionId - The session ID
   * @param entityId - The entity/user ID
   * @param parentField - The parent control key (e.g., "payment")
   * @param subField - The subcontrol key (e.g., "amount")
   * @param value - The extracted value
   * @param confidence - LLM confidence (0-1)
   * @param messageId - Optional message ID for audit
   */
  async updateSubField(
    sessionId: string,
    entityId: UUID,
    parentField: string,
    subField: string,
    value: JsonValue,
    confidence: number,
    messageId?: string,
  ): Promise<void> {
    const session = await getSessionById(this.runtime, entityId, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const form = this.getForm(session.formId);
    if (!form) {
      throw new Error(`Form not found: ${session.formId}`);
    }

    const parentControl = form.controls.find((c) => c.key === parentField);
    if (!parentControl) {
      throw new Error(`Parent field not found: ${parentField}`);
    }

    const controlType = this.getControlType(parentControl.type);
    if (!controlType?.getSubControls) {
      throw new Error(
        `Control type '${parentControl.type}' is not a composite type`,
      );
    }

    // Get subcontrols to find the subcontrol definition
    const subControls = controlType.getSubControls(parentControl, this.runtime);
    const subControl = subControls.find((c) => c.key === subField);
    if (!subControl) {
      throw new Error(`Subfield not found: ${subField} in ${parentField}`);
    }

    const now = Date.now();

    // Initialize parent field state if needed
    if (!session.fields[parentField]) {
      session.fields[parentField] = { status: "empty" };
    }
    if (!session.fields[parentField].subFields) {
      session.fields[parentField].subFields = {};
    }

    // Validate the subfield value
    let subFieldStatus: FieldState["status"];
    let error: string | undefined;

    // Use control type's validate if available
    if (controlType.validate) {
      const result = controlType.validate(value, subControl);
      if (!result.valid) {
        subFieldStatus = "invalid";
        error = result.error;
      } else if (confidence < (subControl.confirmThreshold ?? 0.8)) {
        subFieldStatus = "uncertain";
      } else {
        subFieldStatus = "filled";
      }
    } else {
      // Fallback to basic validation
      const validation = validateField(
        value,
        subControl,
        this.getControlType(subControl.type),
      );
      if (!validation.valid) {
        subFieldStatus = "invalid";
        error = validation.error;
      } else if (confidence < (subControl.confirmThreshold ?? 0.8)) {
        subFieldStatus = "uncertain";
      } else {
        subFieldStatus = "filled";
      }
    }

    // Update the subfield state
    session.fields[parentField].subFields[subField] = {
      status: subFieldStatus,
      value,
      confidence,
      source: "extraction",
      messageId,
      updatedAt: now,
      error,
    };

    // Update effort tracking
    session.effort.interactionCount++;
    session.effort.lastInteractionAt = now;
    session.effort.timeSpentMs = now - session.effort.firstInteractionAt;

    session.updatedAt = now;
    await storageSaveSession(this.runtime, session);

    logger.debug(`[FormService] Updated subfield ${parentField}.${subField}`);
  }

  /**
   * Check if all subfields of a composite field are filled.
   *
   * @param session - The form session
   * @param parentField - The parent control key
   * @returns true if all required subfields are filled
   */
  areSubFieldsFilled(session: FormSession, parentField: string): boolean {
    const form = this.getForm(session.formId);
    if (!form) return false;

    const parentControl = form.controls.find((c) => c.key === parentField);
    if (!parentControl) return false;

    const controlType = this.getControlType(parentControl.type);
    if (!controlType?.getSubControls) return false;

    const subControls = controlType.getSubControls(parentControl, this.runtime);
    const subFields = session.fields[parentField]?.subFields || {};

    // Check if all required subfields are filled
    for (const subControl of subControls) {
      if (!subControl.required) continue;
      const subField = subFields[subControl.key];
      if (subField?.status !== "filled") {
        return false;
      }
    }

    return true;
  }

  /**
   * Get the current subfield values for a composite field.
   *
   * @param session - The form session
   * @param parentField - The parent control key
   * @returns Record of subfield key to value
   */
  getSubFieldValues(
    session: FormSession,
    parentField: string,
  ): Record<string, JsonValue> {
    const subFields = session.fields[parentField]?.subFields || {};
    const values: Record<string, JsonValue> = {};
    for (const [key, state] of Object.entries(subFields)) {
      if (state.value !== undefined) {
        values[key] = state.value;
      }
    }
    return values;
  }

  // ============================================================================
  // EXTERNAL FIELD ACTIVATION
  // ============================================================================

  /**
   * Activate an external field.
   *
   * External types (payment, signature) require an async activation process.
   * This is called when all subcontrols are filled and the external process
   * should begin (e.g., generate payment address, show signing instructions).
   *
   * WHY this method:
   * - Decouples activation trigger from the widget itself
   * - Stores activation state in the session
   * - Provides a clear API for the evaluator to call
   *
   * @param sessionId - The session ID
   * @param entityId - The entity/user ID
   * @param field - The field key
   * @returns The activation details (instructions, reference, etc.)
   */
  async activateExternalField(
    sessionId: string,
    entityId: UUID,
    field: string,
  ): Promise<ExternalActivation> {
    const session = await getSessionById(this.runtime, entityId, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const form = this.getForm(session.formId);
    if (!form) {
      throw new Error(`Form not found: ${session.formId}`);
    }

    const control = form.controls.find((c) => c.key === field);
    if (!control) {
      throw new Error(`Field not found: ${field}`);
    }

    const controlType = this.getControlType(control.type);
    if (!controlType?.activate) {
      throw new Error(
        `Control type '${control.type}' does not support activation`,
      );
    }

    // Gather subfield values
    const subValues = this.getSubFieldValues(session, field);

    // Create activation context
    const context: ActivationContext = {
      runtime: this.runtime,
      session,
      control,
      subValues,
    };

    // Call widget's activate method
    const activation = await controlType.activate(context);

    const now = Date.now();

    // Store activation state in the field
    if (!session.fields[field]) {
      session.fields[field] = { status: "empty" };
    }

    session.fields[field].status = "pending";
    session.fields[field].externalState = {
      status: "pending",
      reference: activation.reference,
      instructions: activation.instructions,
      address: activation.address,
      activatedAt: now,
    };

    session.updatedAt = now;
    await storageSaveSession(this.runtime, session);

    logger.info(
      `[FormService] Activated external field ${field} with reference ${activation.reference}`,
    );

    return activation;
  }

  /**
   * Confirm an external field.
   *
   * Called by external services (payment, blockchain, etc.) when the
   * external process is complete (e.g., payment received, signature verified).
   *
   * WHY separate from confirmField:
   * - External confirmation includes external data (txId, etc.)
   * - Updates externalState, not just field status
   * - Emits events for other systems to react
   *
   * @param sessionId - The session ID
   * @param entityId - The entity/user ID
   * @param field - The field key
   * @param value - The final value to store (usually the confirmed data)
   * @param externalData - Additional data from the external source (txId, etc.)
   */
  async confirmExternalField(
    sessionId: string,
    entityId: UUID,
    field: string,
    value: JsonValue,
    externalData?: Record<string, JsonValue>,
  ): Promise<void> {
    const session = await getSessionById(this.runtime, entityId, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const fieldState = session.fields[field];
    if (fieldState?.status !== "pending") {
      logger.warn(
        `[FormService] Cannot confirm field ${field}: not in pending state`,
      );
      return;
    }

    const now = Date.now();

    // Update field state
    fieldState.status = "filled";
    fieldState.value = value;
    fieldState.source = "external";
    fieldState.updatedAt = now;

    // Update external state
    if (fieldState.externalState) {
      fieldState.externalState.status = "confirmed";
      fieldState.externalState.confirmedAt = now;
      fieldState.externalState.externalData = externalData;
    }

    // Check if form is now ready
    const form = this.getForm(session.formId);
    if (form && this.checkAllRequiredFilled(session, form)) {
      if (session.status === "active") {
        session.status = "ready";
        if (form.hooks?.onReady) {
          await this.executeHook(session, "onReady");
        }
      }
    }

    session.updatedAt = now;
    await storageSaveSession(this.runtime, session);

    // Emit event for listeners
    try {
      await this.runtime.emitEvent("FORM_FIELD_CONFIRMED", {
        runtime: this.runtime,
        sessionId,
        entityId,
        field,
        value,
        externalData,
      } as EventPayload);
    } catch (_error) {
      logger.debug(`[FormService] No event handler for FORM_FIELD_CONFIRMED`);
    }

    logger.info(`[FormService] Confirmed external field ${field}`);
  }

  /**
   * Cancel an external field activation.
   *
   * Called when the external process fails, times out, or user cancels.
   *
   * @param sessionId - The session ID
   * @param entityId - The entity/user ID
   * @param field - The field key
   * @param reason - Reason for cancellation
   */
  async cancelExternalField(
    sessionId: string,
    entityId: UUID,
    field: string,
    reason: string,
  ): Promise<void> {
    const session = await getSessionById(this.runtime, entityId, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const form = this.getForm(session.formId);
    const control = form?.controls.find((c) => c.key === field);
    const controlType = control ? this.getControlType(control.type) : undefined;

    // Call widget's deactivate if exists
    if (controlType?.deactivate && control) {
      try {
        await controlType.deactivate({
          runtime: this.runtime,
          session,
          control,
          subValues: this.getSubFieldValues(session, field),
        });
      } catch (error) {
        logger.error(
          `[FormService] Deactivate failed for ${field}: ${String(error)}`,
        );
      }
    }

    const fieldState = session.fields[field];
    if (fieldState) {
      // Keep subfields but reset external state
      fieldState.status = "empty";
      fieldState.error = reason;
      if (fieldState.externalState) {
        fieldState.externalState.status = "failed";
      }
    }

    session.updatedAt = Date.now();
    await storageSaveSession(this.runtime, session);

    // Emit event for listeners
    try {
      await this.runtime.emitEvent("FORM_FIELD_CANCELLED", {
        runtime: this.runtime,
        sessionId,
        entityId,
        field,
        reason,
      } as EventPayload);
    } catch (_error) {
      logger.debug(`[FormService] No event handler for FORM_FIELD_CANCELLED`);
    }

    logger.info(`[FormService] Cancelled external field ${field}: ${reason}`);
  }

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  /**
   * Submit a form session
   */
  async submit(sessionId: string, entityId: UUID): Promise<FormSubmission> {
    const session = await getSessionById(this.runtime, entityId, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const form = this.getForm(session.formId);
    if (!form) {
      throw new Error(`Form not found: ${session.formId}`);
    }

    // Check all required fields are filled
    if (!this.checkAllRequiredFilled(session, form)) {
      throw new Error("Not all required fields are filled");
    }

    const now = Date.now();

    // Build submission values
    const values = createValueMap<JsonValue>();
    const mappedValues = createValueMap<JsonValue>();
    const files = createValueMap<NonNullable<FieldState["files"]>>();

    for (const control of form.controls) {
      const fieldState = session.fields[control.key];
      if (fieldState?.value !== undefined) {
        const validation = validateField(
          fieldState.value,
          control,
          this.getControlType(control.type),
        );
        if (!validation.valid) {
          const error = validation.error ?? "validation failed";
          throw new Error(`Field ${control.key} is invalid: ${error}`);
        }

        values[control.key] = fieldState.value;
        const dbKey = control.dbbind || control.key;
        mappedValues[dbKey] = fieldState.value;
      }
      if (fieldState?.files) {
        files[control.key] = fieldState.files;
      }
    }

    const submission: FormSubmission = {
      id: uuidv4(),
      formId: session.formId,
      formVersion: session.formVersion,
      sessionId: session.id,
      entityId: session.entityId,
      values,
      mappedValues,
      files: Object.keys(files).length > 0 ? files : undefined,
      submittedAt: now,
      meta: session.meta,
    };

    // Save submission
    await saveSubmission(this.runtime, submission);

    // Update autofill data
    await saveAutofillData(this.runtime, entityId, session.formId, values);

    // Update session status
    session.status = "submitted";
    session.submittedAt = now;
    session.updatedAt = now;
    await storageSaveSession(this.runtime, session);

    // Execute onSubmit hook
    if (form.hooks?.onSubmit) {
      const submissionPayload = JSON.parse(
        JSON.stringify(submission),
      ) as JsonValue;
      await this.executeHook(session, "onSubmit", {
        submission: submissionPayload,
      });
    }

    logger.debug(`[FormService] Submitted session ${sessionId}`);

    return submission;
  }

  /**
   * Stash a session for later
   */
  async stash(sessionId: string, entityId: UUID): Promise<void> {
    const session = await getSessionById(this.runtime, entityId, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const form = this.getForm(session.formId);

    session.status = "stashed";
    session.updatedAt = Date.now();
    await storageSaveSession(this.runtime, session);

    // Execute onStash hook
    if (form?.hooks?.onCancel) {
      // Using onCancel for stash as well, could add separate hook
    }

    logger.debug(`[FormService] Stashed session ${sessionId}`);
  }

  /**
   * Restore a stashed session
   */
  async restore(sessionId: string, entityId: UUID): Promise<FormSession> {
    const session = await getSessionById(this.runtime, entityId, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.status !== "stashed") {
      throw new Error(`Session is not stashed: ${session.status}`);
    }

    // Check for existing active session in the same room
    const existing = await storageGetActiveSession(
      this.runtime,
      entityId,
      session.roomId,
    );
    if (existing && existing.id !== sessionId) {
      throw new Error(`Active session already exists in room: ${existing.id}`);
    }

    session.status = "active";
    session.updatedAt = Date.now();

    // Recalculate TTL on restore
    session.expiresAt = this.calculateTTL(session);

    await storageSaveSession(this.runtime, session);

    logger.debug(`[FormService] Restored session ${sessionId}`);

    return session;
  }

  /**
   * Cancel a session
   */
  async cancel(
    sessionId: string,
    entityId: UUID,
    force = false,
  ): Promise<boolean> {
    const session = await getSessionById(this.runtime, entityId, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Check if we should confirm cancellation
    if (
      !force &&
      this.shouldConfirmCancel(session) &&
      !session.cancelConfirmationAsked
    ) {
      session.cancelConfirmationAsked = true;
      session.updatedAt = Date.now();
      await storageSaveSession(this.runtime, session);
      return false; // Needs confirmation
    }

    const form = this.getForm(session.formId);

    session.status = "cancelled";
    session.updatedAt = Date.now();
    await storageSaveSession(this.runtime, session);

    // Execute onCancel hook
    if (form?.hooks?.onCancel) {
      await this.executeHook(session, "onCancel");
    }

    logger.debug(`[FormService] Cancelled session ${sessionId}`);

    return true;
  }

  // ============================================================================
  // SUBMISSIONS
  // ============================================================================

  /**
   * Get submissions for entity, optionally filtered by form ID
   */
  async getSubmissions(
    entityId: UUID,
    formId?: string,
  ): Promise<FormSubmission[]> {
    return storageGetSubmissions(this.runtime, entityId, formId);
  }

  // ============================================================================
  // AUTOFILL
  // ============================================================================

  /**
   * Get autofill data for a form
   */
  async getAutofill(
    entityId: UUID,
    formId: string,
  ): Promise<Record<string, JsonValue> | null> {
    const data = await getAutofillData(this.runtime, entityId, formId);
    return data?.values || null;
  }

  /**
   * Apply autofill to a session
   */
  async applyAutofill(session: FormSession): Promise<string[]> {
    const form = this.getForm(session.formId);
    if (!form?.ux?.allowAutofill) {
      return [];
    }

    const autofill = await getAutofillData(
      this.runtime,
      session.entityId,
      session.formId,
    );
    if (!autofill) {
      return [];
    }

    const appliedFields: string[] = [];
    const now = Date.now();

    for (const control of form.controls) {
      // Only autofill empty fields
      if (session.fields[control.key]?.status !== "empty") {
        continue;
      }

      const value = autofill.values[control.key];
      if (value !== undefined) {
        session.fields[control.key] = {
          status: "filled",
          value,
          source: "autofill",
          updatedAt: now,
        };
        appliedFields.push(control.key);
      }
    }

    if (appliedFields.length > 0) {
      session.updatedAt = now;
      await storageSaveSession(this.runtime, session);
    }

    return appliedFields;
  }

  // ============================================================================
  // CONTEXT HELPERS
  // ============================================================================

  /**
   * Get session context for provider
   */
  getSessionContext(session: FormSession): FormContextState {
    const form = this.getForm(session.formId);
    if (!form) {
      return {
        hasActiveForm: false,
        progress: 0,
        filledFields: [],
        missingRequired: [],
        uncertainFields: [],
        nextField: null,
        pendingExternalFields: [],
      };
    }

    const filledFields: FilledFieldSummary[] = [];
    const missingRequired: MissingFieldSummary[] = [];
    const uncertainFields: UncertainFieldSummary[] = [];
    const pendingExternalFields: PendingExternalFieldSummary[] = [];
    let nextField: FormControl | null = null;

    let filledCount = 0;
    let totalRequired = 0;

    for (const control of form.controls) {
      if (control.hidden) continue;

      const fieldState = session.fields[control.key];

      if (control.required) {
        totalRequired++;
      }

      if (fieldState?.status === "filled") {
        filledCount++;
        filledFields.push({
          key: control.key,
          label: control.label,
          displayValue: formatValue(
            fieldState.value ?? null,
            control,
            this.getControlType(control.type),
          ),
        });
      } else if (fieldState?.status === "pending") {
        // External field waiting for confirmation
        if (fieldState.externalState) {
          pendingExternalFields.push({
            key: control.key,
            label: control.label,
            instructions:
              fieldState.externalState.instructions ||
              "Waiting for confirmation...",
            reference: fieldState.externalState.reference || "",
            activatedAt: fieldState.externalState.activatedAt || Date.now(),
            address: fieldState.externalState.address,
          });
        }
        // Don't set as nextField - we're waiting for external confirmation
      } else if (fieldState?.status === "uncertain") {
        uncertainFields.push({
          key: control.key,
          label: control.label,
          value: fieldState.value ?? null,
          confidence: fieldState.confidence ?? 0,
        });
      } else if (fieldState?.status === "invalid") {
        missingRequired.push({
          key: control.key,
          label: control.label,
          description: control.description,
          askPrompt: control.askPrompt,
        });
        if (!nextField) nextField = control;
      } else if (control.required && fieldState?.status !== "skipped") {
        missingRequired.push({
          key: control.key,
          label: control.label,
          description: control.description,
          askPrompt: control.askPrompt,
        });
        if (!nextField) nextField = control;
      } else if (!nextField && fieldState?.status === "empty") {
        nextField = control;
      }
    }

    const progress =
      totalRequired > 0 ? Math.round((filledCount / totalRequired) * 100) : 100;

    return {
      hasActiveForm: true,
      formId: session.formId,
      formName: form.name,
      progress,
      filledFields,
      missingRequired,
      uncertainFields,
      nextField,
      status: session.status,
      pendingCancelConfirmation:
        session.cancelConfirmationAsked &&
        (session.status === "active" || session.status === "ready"),
      pendingExternalFields,
    };
  }

  /**
   * Get current values from session
   */
  getValues(session: FormSession): Record<string, JsonValue> {
    const values = createValueMap<JsonValue>();
    for (const [key, state] of Object.entries(session.fields)) {
      if (state.value !== undefined) {
        values[key] = state.value;
      }
    }
    return values;
  }

  /**
   * Get mapped values (using dbbind)
   */
  getMappedValues(session: FormSession): Record<string, JsonValue> {
    const form = this.getForm(session.formId);
    if (!form) return {};

    const values = createValueMap<JsonValue>();
    for (const control of form.controls) {
      const state = session.fields[control.key];
      if (state?.value !== undefined) {
        const key = control.dbbind || control.key;
        values[key] = state.value;
      }
    }
    return values;
  }

  // ============================================================================
  // TTL & EFFORT
  // ============================================================================

  /**
   * Calculate TTL based on effort
   */
  calculateTTL(session: FormSession): number {
    const form = this.getForm(session.formId);
    const config = form?.ttl || {};

    const minDays = config.minDays ?? 14;
    const maxDays = config.maxDays ?? 90;
    const multiplier = config.effortMultiplier ?? 0.5;

    const minutesSpent = session.effort.timeSpentMs / 60000;
    const effortDays = minutesSpent * multiplier;

    const ttlDays = Math.min(maxDays, Math.max(minDays, effortDays));
    return Date.now() + ttlDays * 24 * 60 * 60 * 1000;
  }

  /**
   * Check if cancel should require confirmation
   */
  shouldConfirmCancel(session: FormSession): boolean {
    const minEffortMs = 5 * 60 * 1000; // 5 minutes
    return session.effort.timeSpentMs > minEffortMs;
  }

  // ============================================================================
  // HOOKS
  // ============================================================================

  /**
   * Execute a form hook
   */
  private async executeHook(
    session: FormSession,
    hookName: keyof NonNullable<FormDefinition["hooks"]>,
    options?: Record<string, JsonValue>,
  ): Promise<void> {
    const form = this.getForm(session.formId);
    const workerName = form?.hooks?.[hookName];

    if (!workerName) return;

    const worker = this.runtime.getTaskWorker(workerName);
    if (!worker) {
      logger.warn(`[FormService] Hook worker not found: ${workerName}`);
      return;
    }

    try {
      // Create a minimal task object for hook execution
      const task: Task = {
        id: session.id as UUID,
        name: workerName,
        roomId: session.roomId,
        entityId: session.entityId,
        tags: [],
      };
      await worker.execute(
        this.runtime,
        {
          session,
          form,
          ...options,
        },
        task,
      );
    } catch (error) {
      logger.error(
        `[FormService] Hook execution failed: ${hookName}`,
        String(error),
      );
    }
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  /**
   * Check if all required fields are filled
   */
  private checkAllRequiredFilled(
    session: FormSession,
    form: FormDefinition,
  ): boolean {
    for (const control of form.controls) {
      if (!control.required) continue;

      const fieldState = session.fields[control.key];
      if (
        !fieldState ||
        fieldState.status === "empty" ||
        fieldState.status === "invalid"
      ) {
        return false;
      }
    }
    return true;
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Convert snake_case or kebab-case to Title Case
 */
function prettify(key: string): string {
  return key.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
