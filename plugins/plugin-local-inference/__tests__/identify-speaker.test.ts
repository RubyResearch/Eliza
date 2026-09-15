/**
 * Tests for the IDENTIFY_SPEAKER action (issue #8234, shape #2).
 *
 * The action selects the most-recent unidentified speaker profile and
 * drives the merge engine via `VOICE_TURN_OBSERVED`. Here the merge-engine
 * round-trip is simulated by a fake runtime whose `emitEvent` mints an
 * entity id and invokes the real `handleVoiceEntityBound` consumer — so the
 * test exercises the full producer → bind path without loading lifeops.
 * The planner-path cases run the real core `validateToolArgs` over the
 * action's declared parameters and deliver the validated bag under
 * `options.parameters`, as the runtime does.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  IAgentRuntime,
  Memory,
  VoiceSpeakerNameInferencePayload,
} from "@elizaos/core";
import { EventType } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateToolArgs } from "../../../packages/core/src/actions/validate-tool-args";
import {
  extractSpeakerName,
  identifySpeakerAction,
} from "../src/actions/identify-speaker";
import {
  handleVoiceEntityBound,
  setVoiceEntityBindingStore,
} from "../src/runtime/voice-entity-binding";
import { VoiceProfileStore } from "../src/services/voice/profile-store";
import { WESPEAKER_RESNET34_LM_INT8_MODEL_ID } from "../src/services/voice/speaker/encoder";

const MODEL = WESPEAKER_RESNET34_LM_INT8_MODEL_ID;

let tmpRoot: string;
let store: VoiceProfileStore;

function unit(values: number[]): Float32Array {
  let sumSq = 0;
  for (const v of values) sumSq += v * v;
  const inv = sumSq > 0 ? 1 / Math.sqrt(sumSq) : 1;
  return new Float32Array(values.map((v) => v * inv));
}

function makeMessage(text: string): Memory {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    entityId: "22222222-2222-2222-2222-222222222222",
    roomId: "33333333-3333-3333-3333-333333333333",
    content: { text },
  } as unknown as Memory;
}

/**
 * Fake runtime whose `emitEvent` plays the merge-engine consumer: on a
 * VOICE_TURN_OBSERVED it mints an entity id and runs the real round-trip
 * binding handler.
 */
function makeRuntime(entityId: string): {
  runtime: IAgentRuntime;
  emitEvent: ReturnType<typeof vi.fn>;
} {
  const emitEvent = vi.fn(
    async (
      type: string,
      payload: {
        imprintClusterId: string;
        text: string;
        speakerNameInference?: VoiceSpeakerNameInferencePayload;
      },
    ) => {
      if (type === EventType.VOICE_TURN_OBSERVED) {
        await handleVoiceEntityBound({
          runtime: {} as IAgentRuntime,
          imprintClusterId: payload.imprintClusterId,
          entityId,
          displayName: payload.text.replace(/^This is\s+/, "").replace(/\.$/, ""),
          ...(payload.speakerNameInference
            ? { speakerNameInference: payload.speakerNameInference }
            : {}),
        });
      }
    },
  );
  return { runtime: { emitEvent } as unknown as IAgentRuntime, emitEvent };
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "identify-speaker-"));
  store = new VoiceProfileStore({ rootDir: tmpRoot });
  await store.init();
  setVoiceEntityBindingStore(store);
});

afterEach(() => {
  setVoiceEntityBindingStore(null);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("extractSpeakerName", () => {
  it.each([
    ["that was Jill", "Jill"],
    ["this is my friend Sam", "Sam"],
    ["call her Alex", "Alex"],
    ["his name is Bob Smith", "Bob Smith"],
    ["the speaker was Dana", "Dana"],
  ])("extracts %s → %s", (input, expected) => {
    expect(extractSpeakerName(input)).toBe(expected);
  });

  it.each(["hello there", "what time is it", ""])(
    "returns null for non-claim %s",
    (input) => {
      expect(extractSpeakerName(input)).toBeNull();
    },
  );
});

describe("identifySpeakerAction", () => {
  it("binds the most-recent unidentified speaker to the named entity", async () => {
    // An already-identified profile must be skipped.
    await store.createProfile({
      centroid: unit([1, 0, 0, 0]),
      embeddingModel: MODEL,
      imprintClusterId: "cluster_known",
      entityId: "ent_known",
      confidence: 0.9,
      durationMs: 1500,
    });
    const unknown = await store.createProfile({
      centroid: unit([0, 1, 0, 0]),
      embeddingModel: MODEL,
      imprintClusterId: "cluster_unknown",
      confidence: 0.5,
      durationMs: 1500,
    });

    const { runtime, emitEvent } = makeRuntime("ent_jill");
    const result = await identifySpeakerAction.handler!(
      runtime,
      makeMessage("that was Jill"),
      undefined,
      undefined,
      undefined,
    );

    expect(emitEvent).toHaveBeenCalledTimes(1);
    const [eventType, payload] = emitEvent.mock.calls[0] as [
      string,
      {
        imprintClusterId: string;
        text: string;
        matchedEntityId: string | null;
        speakerNameInference: VoiceSpeakerNameInferencePayload;
      },
    ];
    expect(eventType).toBe(EventType.VOICE_TURN_OBSERVED);
    expect(payload.imprintClusterId).toBe("cluster_unknown");
    expect(payload.text).toBe("This is Jill.");
    expect(payload.matchedEntityId).toBeNull();
    expect(payload.speakerNameInference).toMatchObject({
      resolution: "confirmed",
      displayName: "Jill",
      confidence: 1,
      requiresReview: false,
    });
    expect(payload.speakerNameInference.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "user_correction",
          profileId: unknown.profileId,
        }),
      ]),
    );

    expect(result).toMatchObject({ success: true });
    expect((result as { data?: Record<string, unknown> }).data).toMatchObject({
      profileId: unknown.profileId,
      entityId: "ent_jill",
      name: "Jill",
    });
    // The profile is now bound.
    const bound = await store.get(unknown.profileId);
    expect(bound?.entityId).toBe("ent_jill");
    expect(bound?.metadata?.label).toBe("Jill");
    expect(bound?.metadata?.speakerNameInference).toMatchObject({
      resolution: "confirmed",
      displayName: "Jill",
    });
  });

  it("fails cleanly when no name can be resolved", async () => {
    const { runtime, emitEvent } = makeRuntime("ent_x");
    const result = await identifySpeakerAction.handler!(
      runtime,
      makeMessage("who was that"),
      undefined,
      undefined,
      undefined,
    );
    expect(result).toMatchObject({ success: false });
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("fails cleanly when there is no unidentified recent voice", async () => {
    await store.createProfile({
      centroid: unit([1, 0, 0, 0]),
      embeddingModel: MODEL,
      imprintClusterId: "cluster_known",
      entityId: "ent_known",
      confidence: 0.9,
      durationMs: 1500,
    });
    const { runtime, emitEvent } = makeRuntime("ent_x");
    const result = await identifySpeakerAction.handler!(
      runtime,
      makeMessage("that was Jill"),
      undefined,
      undefined,
      undefined,
    );
    expect(result).toMatchObject({ success: false });
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("fails visibly when no entity consumer persists the correction", async () => {
    const profile = await store.createProfile({
      centroid: unit([0, 1, 0, 0]),
      embeddingModel: MODEL,
      imprintClusterId: "cluster_no_consumer",
      confidence: 0.5,
      durationMs: 1500,
    });
    const emitEvent = vi.fn(async () => undefined);
    const result = await identifySpeakerAction.handler!(
      { emitEvent } as unknown as IAgentRuntime,
      makeMessage("that was Jill"),
      undefined,
      undefined,
      undefined,
    );

    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("identity sync is unavailable"),
    });
    expect((await store.get(profile.profileId))?.entityId).toBeNull();
  });

  it("honors an explicit profileId option", async () => {
    const a = await store.createProfile({
      centroid: unit([0, 1, 0, 0]),
      embeddingModel: MODEL,
      imprintClusterId: "cluster_a",
      confidence: 0.5,
      durationMs: 1500,
    });
    await store.createProfile({
      centroid: unit([0, 0, 1, 0]),
      embeddingModel: MODEL,
      imprintClusterId: "cluster_b",
      confidence: 0.5,
      durationMs: 1500,
    });

    const { runtime, emitEvent } = makeRuntime("ent_target");
    await identifySpeakerAction.handler!(
      runtime,
      makeMessage("name this voice"),
      undefined,
      { name: "Dana", profileId: a.profileId },
      undefined,
    );
    const [, payload] = emitEvent.mock.calls[0] as [
      string,
      { imprintClusterId: string },
    ];
    expect(payload.imprintClusterId).toBe("cluster_a");
    expect((await store.get(a.profileId))?.entityId).toBe("ent_target");
  });
});

describe("identifySpeakerAction planner parameters", () => {
  it("declares name and profileId so the real validator accepts them", () => {
    const validation = validateToolArgs(identifySpeakerAction, {
      name: "Dana",
      profileId: "vp_123",
    });
    expect(validation).toMatchObject({ valid: true, errors: [] });
    expect(validation.args).toEqual({ name: "Dana", profileId: "vp_123" });
  });

  it("still rejects an undeclared argument", () => {
    const validation = validateToolArgs(identifySpeakerAction, {
      name: "Dana",
      entityId: "ent_x",
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(["Unexpected argument 'entityId'"]);
  });

  it("reads name and an explicit profileId from the validated planner bag, and the explicit id wins", async () => {
    const older = await store.createProfile({
      centroid: unit([0, 1, 0, 0]),
      embeddingModel: MODEL,
      imprintClusterId: "cluster_older",
      confidence: 0.5,
      durationMs: 1500,
    });
    // A more recently observed unbound profile is what the fallback would
    // pick; the explicit profileId must override it.
    await store.createProfile({
      centroid: unit([0, 0, 1, 0]),
      embeddingModel: MODEL,
      imprintClusterId: "cluster_newer",
      confidence: 0.5,
      durationMs: 1500,
    });
    const validation = validateToolArgs(identifySpeakerAction, {
      name: "Dana",
      profileId: older.profileId,
    });
    expect(validation.valid).toBe(true);

    const { runtime, emitEvent } = makeRuntime("ent_dana");
    // No name claim in the text: the name can only come from the planner bag.
    const result = await identifySpeakerAction.handler!(
      runtime,
      makeMessage("attach a name to that voice"),
      undefined,
      { parameters: validation.args },
      undefined,
    );

    expect(emitEvent).toHaveBeenCalledTimes(1);
    const [, payload] = emitEvent.mock.calls[0] as [
      string,
      { imprintClusterId: string; text: string },
    ];
    expect(payload.imprintClusterId).toBe("cluster_older");
    expect(payload.text).toBe("This is Dana.");
    expect(result).toMatchObject({
      success: true,
      data: { profileId: older.profileId, entityId: "ent_dana", name: "Dana" },
    });
    expect((await store.get(older.profileId))?.entityId).toBe("ent_dana");
  });
});
