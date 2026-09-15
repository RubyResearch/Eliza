/** Connector degradation lines group identical statuses without dropping a connector. */
import { describe, expect, it } from "vitest";
import { formatConnectorDegradationLines } from "./lifeops-connector-lines";

const WAVE1 =
  "plugin-health Wave-1 connector is unavailable until W1-F's runtime context shape is finalised.";

describe("formatConnectorDegradationLines", () => {
  it("groups connectors that share a state and message into one line", () => {
    const lines = formatConnectorDegradationLines([
      {
        label: "Google (Gmail + Calendar)",
        state: "disconnected",
        message: "disconnected",
      },
      {
        label: "Telegram",
        state: "disconnected",
        message: "managed by plugin-telegram",
      },
      { label: "Discord", state: "disconnected", message: "disconnected" },
      { label: "WhatsApp", state: "disconnected" },
      { label: "iMessage", state: "disconnected" },
      {
        label: "Apple Health (HealthKit)",
        state: "disconnected",
        message: WAVE1,
      },
      { label: "Google Fit", state: "disconnected", message: WAVE1 },
      { label: "Oura", state: "disconnected", message: WAVE1 },
    ]);
    expect(lines).toEqual([
      "Connectors Google (Gmail + Calendar), Discord disconnected: disconnected",
      "Connector Telegram disconnected: managed by plugin-telegram",
      "Connectors WhatsApp, iMessage disconnected",
      `Connectors Apple Health (HealthKit), Google Fit, Oura disconnected: ${WAVE1}`,
    ]);
  });

  it("omits healthy connectors and keeps a lone degraded one on its own line", () => {
    expect(
      formatConnectorDegradationLines([
        { label: "Discord", state: "ok" },
        { label: "Strava", state: "degraded", message: "token expiring" },
      ]),
    ).toEqual(["Connector Strava degraded: token expiring"]);
  });

  it("returns nothing when every connector is healthy", () => {
    expect(
      formatConnectorDegradationLines([{ label: "Discord", state: "ok" }]),
    ).toEqual([]);
  });
});
