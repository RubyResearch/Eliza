/**
 * Vitest setup that mocks react and react-dom (client and server) from the real installed
 * packages so component-touching LifeOps tests render without a bundler.
 */
import Module from "node:module";
import { vi } from "vitest";

const requireFromHere = Module.createRequire(import.meta.url);
const react = requireFromHere("react") as typeof import("react");
const reactDom = requireFromHere("react-dom") as typeof import("react-dom");
const reactDomClient = requireFromHere(
  "react-dom/client",
) as typeof import("react-dom/client");
const reactDomServer = requireFromHere(
  "react-dom/server",
) as typeof import("react-dom/server");

vi.mock("react", () => ({ ...react, default: react }));
vi.mock("react-dom", () => ({ ...reactDom, default: reactDom }));
vi.mock("react-dom/client", () => ({
  ...reactDomClient,
  default: reactDomClient,
}));
vi.mock("react-dom/server", () => ({
  ...reactDomServer,
  default: reactDomServer,
}));

vi.mock("@elizaos/agent", async () => import("./stubs/agent.ts"));
vi.mock("@elizaos/ui", async () => import("./stubs/ui.ts"));
// jsdom has no layout observer. Radio behavior is exercised here; real geometry
// and resize behavior are validated in Chromium, not by this inert shim.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
vi.mock(
  "@elizaos/plugin-google-workspace",
  async () => import("./stubs/plugin-google-workspace.ts"),
);
