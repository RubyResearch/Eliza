/**
 * Pins that the agent's `isTrustedLocalRequest` wrapper binds its exact policy
 * gates to the canonical `@elizaos/shared` parser: cloudCheck "container"
 * (flag AND a provisioning token), ELIZA_REQUIRE_LOCAL_AUTH honoured, and NO
 * dev-auth bypass. If the wrapper swaps cloudCheck to "env" or enables the dev
 * bypass, these assertions break. Also covers isWebSocketAuthorized /
 * resolveWebSocketUpgradeRejection loopback parity and resolveBoundaryRole
 * (OWNER for trusted loopback, GUEST fail-closed for remote tokenless callers).
 */
import http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isTrustedLocalRequest,
  isWebSocketAuthorized,
  resolveBoundaryRole,
  resolveWebSocketUpgradeRejection,
} from "./server-helpers-auth.ts";

function makeReq(
  headers: http.IncomingHttpHeaders,
  remoteAddress = "127.0.0.1",
): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.headers = { ...headers };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: remoteAddress,
    configurable: true,
  });
  return req;
}

const localReq = () => makeReq({ host: "localhost:2138" });

const ENV_KEYS = [
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_DEV_AUTH_BYPASS",
  "ELIZA_CLOUD_PROVISIONED",
  "STEWARD_AGENT_TOKEN",
  "ELIZA_API_TOKEN",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_API_KEY",
  "NODE_ENV",
] as const;

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("agent isTrustedLocalRequest wrapper (policy gates)", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("trusts a bare loopback request when no gate is set", () => {
    expect(isTrustedLocalRequest(localReq())).toBe(true);
  });

  it("ELIZA_REQUIRE_LOCAL_AUTH=1 denies trust", () => {
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    expect(isTrustedLocalRequest(localReq())).toBe(false);
  });

  it("the agent IGNORES ELIZA_DEV_AUTH_BYPASS even in development", () => {
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    process.env.ELIZA_DEV_AUTH_BYPASS = "1";
    process.env.NODE_ENV = "development";
    expect(isTrustedLocalRequest(localReq())).toBe(false);
  });

  it("cloudCheck=container: bare ELIZA_CLOUD_PROVISIONED=1 does NOT deny trust", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    expect(isTrustedLocalRequest(localReq())).toBe(true);
  });

  it("cloudCheck=container: flag + provisioning token denies trust", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.STEWARD_AGENT_TOKEN = "steward-token";
    expect(isTrustedLocalRequest(localReq())).toBe(false);
  });

  it("rejects a spoofed X-Forwarded-For", () => {
    expect(
      isTrustedLocalRequest(
        makeReq({ host: "localhost:2138", "x-forwarded-for": "203.0.113.9" }),
      ),
    ).toBe(false);
  });

  it("rejects a DNS-rebinding Host header (strict shared classifier)", () => {
    // The strict canonical parser rejects a rebinding host like
    // "127.0.0.1.evil.com" that a naive 127.*-prefix check would wrongly accept.
    expect(isTrustedLocalRequest(makeReq({ host: "127.0.0.1.evil.com" }))).toBe(
      false,
    );
  });
});

describe("WebSocket auth no-token trust parity", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("allows loopback WebSocket upgrades without a token in local mode", () => {
    const req = localReq();
    const url = new URL("http://localhost:2138/ws");

    expect(isWebSocketAuthorized(req, url)).toBe(true);
    expect(resolveWebSocketUpgradeRejection(req, url)).toBeNull();
  });

  it("rejects remote WebSocket upgrades without a token in local mode", () => {
    const req = makeReq({ host: "203.0.113.10:2138" }, "203.0.113.10");
    const url = new URL("http://203.0.113.10:2138/ws");

    expect(isWebSocketAuthorized(req, url)).toBe(false);
    expect(resolveWebSocketUpgradeRejection(req, url)).toEqual({
      status: 401,
      reason: "Unauthorized",
    });
  });

  it("keeps the same-origin local dashboard authorized when remote pairing has a token", () => {
    process.env.ELIZA_API_TOKEN = "remote-device-secret";
    const req = makeReq({
      host: "localhost:2138",
      origin: "http://localhost:2138",
    });
    const url = new URL("http://localhost:2138/ws");
    expect(resolveWebSocketUpgradeRejection(req, url)).toBeNull();
    expect(isWebSocketAuthorized(req, url)).toBe(true);
  });

  it.each([
    { host: "localhost:2138", origin: "https://localhost" },
    { host: "localhost:2138", origin: "http://localhost:9999" },
    { host: "localhost:2138", "x-forwarded-for": "203.0.113.9" },
  ])(
    "does not extend local WebSocket trust to mismatched or forwarded origins: %j",
    (headers) => {
      process.env.ELIZA_API_TOKEN = "remote-device-secret";
      expect(
        isWebSocketAuthorized(
          makeReq(headers),
          new URL("http://localhost:2138/ws"),
        ),
      ).toBe(false);
    },
  );

  it("still requires the configured token in strict local auth mode", () => {
    process.env.ELIZA_API_TOKEN = "remote-device-secret";
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    const req = localReq();
    const url = new URL("http://localhost:2138/ws");
    expect(isWebSocketAuthorized(req, url)).toBe(false);
    req.headers.authorization = "Bearer remote-device-secret";
    expect(isWebSocketAuthorized(req, url)).toBe(true);
  });

  it("does not bypass a supplied invalid token or a provisioned cloud boundary", () => {
    process.env.ELIZA_API_TOKEN = "remote-device-secret";
    const req = localReq();
    const url = new URL("http://localhost:2138/ws");
    req.headers.authorization = "Bearer wrong-secret";
    expect(isWebSocketAuthorized(req, url)).toBe(false);
    delete req.headers.authorization;
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.STEWARD_AGENT_TOKEN = "steward-token";
    expect(isWebSocketAuthorized(req, url)).toBe(false);
  });
});

describe("resolveBoundaryRole (#12087 Item 13)", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("classifies a trusted loopback caller as OWNER", () => {
    expect(resolveBoundaryRole(localReq())).toBe("OWNER");
  });

  it("classifies a remote, tokenless caller as GUEST (fail closed)", () => {
    const remote = new http.IncomingMessage(new Socket());
    remote.headers = { host: "agent.example.test" };
    Object.defineProperty(remote.socket, "remoteAddress", {
      value: "203.0.113.7",
      configurable: true,
    });
    expect(resolveBoundaryRole(remote)).toBe("GUEST");
  });
});
