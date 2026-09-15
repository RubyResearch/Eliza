/**
 * Behavioral coverage for wallet EVM balance/NFT fetching: provider-key
 * resolution, wei formatting, Alchemy/Ankr/RPC fallbacks, zero-balance
 * filtering, complete metadata retrieval, and NFT field defaults.
 */
import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EVM_CHAINS,
  type EvmChainConfig,
  fetchEvmBalances,
  fetchEvmNativeBalanceViaRpc,
  fetchEvmNfts,
  resolveEvmProviderKeys,
} from "./wallet-evm-balance.ts";

const WALLET = "0x1111111111111111111111111111111111111111";
const ONE_ETH_HEX = "0xde0b6b3a7640000"; // 10^18
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const ZERO = "0x0000000000000000000000000000000000000000";

const ENV_KEYS = [
  "NODEREAL_BSC_RPC_URL",
  "QUICKNODE_BSC_RPC_URL",
  "BSC_RPC_URL",
  "ETHEREUM_RPC_URL",
  "BASE_RPC_URL",
  "AVALANCHE_RPC_URL",
  "BSC_TESTNET_RPC_URL",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZA_WALLET_NETWORK",
] as const;

const envSnapshot: Record<string, string | undefined> = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function encodeAbiString(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  const offset = 32n.toString(16).padStart(64, "0");
  const length = BigInt(bytes.length).toString(16).padStart(64, "0");
  const data = bytes.toString("hex").padEnd(64, "0");
  return `0x${offset}${length}${data}`;
}

function restoreDefaultChains(original: typeof DEFAULT_EVM_CHAINS): void {
  const mutable = DEFAULT_EVM_CHAINS as unknown as EvmChainConfig[];
  mutable.splice(0, mutable.length, ...original);
}

function installFetch(
  handler: (
    url: string,
    body: Record<string, unknown> | null,
  ) => Response | Promise<Response>,
) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      let body: Record<string, unknown> | null = null;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body) as Record<string, unknown>;
        } catch {
          body = null;
        }
      }
      return handler(url, body);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = envSnapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DEFAULT_EVM_CHAINS", () => {
  it("lists the seven default Alchemy-backed chains with unique ids", () => {
    expect(DEFAULT_EVM_CHAINS).toHaveLength(7);
    expect(DEFAULT_EVM_CHAINS.every((c) => c.provider === "alchemy")).toBe(
      true,
    );
    const ids = DEFAULT_EVM_CHAINS.map((c) => c.chainId);
    expect(new Set(ids).size).toBe(7);
    expect(
      DEFAULT_EVM_CHAINS.map((c) => [c.name, c.chainId, c.nativeSymbol]),
    ).toEqual([
      ["Ethereum", 1, "ETH"],
      ["Base", 8453, "ETH"],
      ["Arbitrum", 42161, "ETH"],
      ["Optimism", 10, "ETH"],
      ["Polygon", 137, "POL"],
      ["BSC", 56, "BNB"],
      ["Avalanche", 43114, "AVAX"],
    ]);
  });
});

describe("resolveEvmProviderKeys", () => {
  it("treats null, undefined, and blank strings as missing keys", () => {
    for (const input of [null, undefined, "", "   "]) {
      const keys = resolveEvmProviderKeys(input);
      expect(keys.alchemyKey).toBeNull();
      expect(keys.ankrKey).toBeNull();
      expect(keys.cloudManagedAccess).toBe(false);
      expect(keys.bscRpcUrls).toEqual([]);
      expect(keys.ethereumRpcUrls).toEqual([]);
      expect(keys.baseRpcUrls).toEqual([]);
      expect(keys.avaxRpcUrls).toEqual([]);
    }
  });

  it("trims a string Alchemy key and an optional Ankr key", () => {
    const keys = resolveEvmProviderKeys("  alk_live  ", "  ankr_live  ");
    expect(keys.alchemyKey).toBe("alk_live");
    expect(keys.ankrKey).toBe("ankr_live");
    expect(keys.cloudManagedAccess).toBe(false);
  });

  it("reads RPC env fallbacks on the string-key path", () => {
    process.env.NODEREAL_BSC_RPC_URL = " https://nodereal.example ";
    process.env.QUICKNODE_BSC_RPC_URL = "https://quicknode.example";
    process.env.BSC_RPC_URL = "https://bsc.example";
    process.env.ETHEREUM_RPC_URL = "https://eth.example";
    process.env.BASE_RPC_URL = "https://base.example";
    process.env.AVALANCHE_RPC_URL = "https://avax.example";
    const keys = resolveEvmProviderKeys(null);
    expect(keys.nodeRealBscRpcUrl).toBe("https://nodereal.example");
    expect(keys.quickNodeBscRpcUrl).toBe("https://quicknode.example");
    expect(keys.bscRpcUrl).toBe("https://bsc.example");
    expect(keys.ethereumRpcUrl).toBe("https://eth.example");
    expect(keys.baseRpcUrl).toBe("https://base.example");
    expect(keys.avaxRpcUrl).toBe("https://avax.example");
    expect(keys.bscRpcUrls).toEqual([
      "https://nodereal.example/",
      "https://quicknode.example/",
      "https://bsc.example/",
    ]);
    expect(keys.ethereumRpcUrls).toEqual(["https://eth.example/"]);
  });

  it("dedupes, trims, and drops empty RPC entries on the object path", () => {
    const keys = resolveEvmProviderKeys({
      alchemyKey: "  alk  ",
      ankrKey: "ankr",
      cloudManagedAccess: false,
      bscRpcUrls: [
        "https://bsc.example",
        " https://bsc.example ",
        "",
        "https://bsc-2.example",
      ],
      ethereumRpcUrls: ["https://eth.example"],
      baseRpcUrls: undefined,
      avaxRpcUrls: [],
    });
    expect(keys.alchemyKey).toBe("alk");
    expect(keys.ankrKey).toBe("ankr");
    expect(keys.bscRpcUrls).toEqual([
      "https://bsc.example",
      "https://bsc-2.example",
    ]);
    expect(keys.ethereumRpcUrls).toEqual(["https://eth.example"]);
    expect(keys.baseRpcUrls).toEqual([]);
    expect(keys.avaxRpcUrls).toEqual([]);
  });

  it("does not fall through to maybeAnkrKey when ankrKey is an empty string", () => {
    const keys = resolveEvmProviderKeys({ ankrKey: "" }, "fallback-ankr");
    expect(keys.ankrKey).toBeNull();
  });

  it("uses maybeAnkrKey when the object omits ankrKey", () => {
    const keys = resolveEvmProviderKeys({}, "  fallback-ankr  ");
    expect(keys.ankrKey).toBe("fallback-ankr");
  });

  it("coerces cloudManagedAccess and appends public RPC defaults", () => {
    const off = resolveEvmProviderKeys({ cloudManagedAccess: null });
    expect(off.cloudManagedAccess).toBe(false);
    expect(off.ethereumRpcUrls).toEqual([]);

    const on = resolveEvmProviderKeys({ cloudManagedAccess: true });
    expect(on.cloudManagedAccess).toBe(true);
    expect(on.ethereumRpcUrls.length).toBeGreaterThan(0);
    expect(on.bscRpcUrls.length).toBeGreaterThan(0);
    expect(on.baseRpcUrls.length).toBeGreaterThan(0);
    expect(on.avaxRpcUrls.length).toBeGreaterThan(0);
    expect(on.ethereumRpcUrls.every((u) => u.startsWith("http"))).toBe(true);
  });
});

describe("fetchEvmNativeBalanceViaRpc", () => {
  it("formats 1 ether and strips trailing fractional zeros", async () => {
    installFetch((url) => {
      expect(url).toBe("https://eth.example/rpc");
      return jsonResponse({ result: ONE_ETH_HEX });
    });
    await expect(
      fetchEvmNativeBalanceViaRpc("https://eth.example/rpc", WALLET),
    ).resolves.toBe("1");

    vi.unstubAllGlobals();
    installFetch(() =>
      jsonResponse({ result: `0x${(15n * 10n ** 17n).toString(16)}` }),
    );
    await expect(
      fetchEvmNativeBalanceViaRpc("https://eth.example/rpc", WALLET),
    ).resolves.toBe("1.5");
  });

  it("treats missing, non-string, and zero results as 0", async () => {
    installFetch(() => jsonResponse({ result: "0x0" }));
    await expect(
      fetchEvmNativeBalanceViaRpc("https://eth.example/rpc", WALLET),
    ).resolves.toBe("0");

    vi.unstubAllGlobals();
    installFetch(() => jsonResponse({}));
    await expect(
      fetchEvmNativeBalanceViaRpc("https://eth.example/rpc", WALLET),
    ).resolves.toBe("0");

    vi.unstubAllGlobals();
    installFetch(() => jsonResponse({ result: 1 }));
    await expect(
      fetchEvmNativeBalanceViaRpc("https://eth.example/rpc", WALLET),
    ).resolves.toBe("0");
  });

  it("formats a decimal-string wei result without 0x", async () => {
    installFetch(() => jsonResponse({ result: "1000000000000000000" }));
    await expect(
      fetchEvmNativeBalanceViaRpc("https://eth.example/rpc", WALLET),
    ).resolves.toBe("1");
  });

  it("formats 1 wei to 18 decimal places", async () => {
    installFetch(() => jsonResponse({ result: "0x1" }));
    await expect(
      fetchEvmNativeBalanceViaRpc("https://eth.example/rpc", WALLET),
    ).resolves.toBe("0.000000000000000001");
  });

  it("throws the RPC error.message on HTTP 200 error payloads", async () => {
    installFetch(() =>
      jsonResponse({ error: { message: "execution reverted" } }),
    );
    await expect(
      fetchEvmNativeBalanceViaRpc("https://eth.example/rpc", WALLET),
    ).rejects.toThrow("execution reverted");
  });

  it("preserves complete HTTP error text, or HTTP status when the body is empty", async () => {
    installFetch(() => new Response("e".repeat(300), { status: 502 }));
    await expect(
      fetchEvmNativeBalanceViaRpc("https://eth.example/rpc", WALLET),
    ).rejects.toThrow("e".repeat(300));

    vi.unstubAllGlobals();
    installFetch(() => new Response("", { status: 503 }));
    await expect(
      fetchEvmNativeBalanceViaRpc("https://eth.example/rpc", WALLET),
    ).rejects.toThrow("HTTP 503");
  });

  it("throws complete body text when HTTP 200 is not JSON", async () => {
    installFetch(() => new Response("not-json", { status: 200 }));
    await expect(
      fetchEvmNativeBalanceViaRpc("https://eth.example/rpc", WALLET),
    ).rejects.toThrow("not-json");
  });
});

describe("fetchEvmBalances", () => {
  it("returns an empty list when no provider keys or RPC URLs are configured", async () => {
    const fetchMock = installFetch(() => {
      throw new Error("network should not be called");
    });
    await expect(fetchEvmBalances(WALLET, null)).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses Alchemy for every default chain and drops zero token balances", async () => {
    const metadataCalls: string[] = [];
    installFetch((url, body) => {
      if (url.includes("api.dexscreener.com")) {
        return jsonResponse([
          {
            baseToken: { address: WETH },
            priceUsd: "2000",
            liquidity: { usd: 1_000_000 },
            info: { imageUrl: "https://logo.example/weth.png" },
          },
          {
            baseToken: { address: USDC },
            priceUsd: "1",
            liquidity: { usd: 1_000_000 },
            info: { imageUrl: "https://logo.example/usdc.png" },
          },
        ]);
      }
      if (url.includes("api.dexpaprika.com")) {
        return jsonResponse({ summary: { price_usd: 0 } });
      }
      const method = typeof body?.method === "string" ? body.method : "";
      if (method === "eth_getBalance") {
        return jsonResponse({ result: ONE_ETH_HEX });
      }
      if (method === "alchemy_getTokenBalances") {
        return jsonResponse({
          result: {
            tokenBalances: [
              { contractAddress: USDC, tokenBalance: ONE_ETH_HEX },
              { contractAddress: WETH, tokenBalance: "0x0" },
              { contractAddress: "0xdead", tokenBalance: "0x" },
              { contractAddress: "0xempty" },
            ],
          },
        });
      }
      if (method === "alchemy_getTokenMetadata") {
        const params = Array.isArray(body?.params) ? body.params : [];
        const contract = String(params[0] ?? "");
        metadataCalls.push(contract);
        return jsonResponse({
          result: {
            name: "USD Coin",
            symbol: "USDC",
            decimals: 6,
            logo: "",
          },
        });
      }
      return jsonResponse({ result: "0x0" });
    });

    const chains = await fetchEvmBalances(WALLET, "alk_live");
    expect(chains).toHaveLength(7);
    expect(chains.every((c) => c.error === null)).toBe(true);
    const eth = chains.find((c) => c.chainId === 1);
    expect(eth?.nativeBalance).toBe("1");
    expect(eth?.nativeSymbol).toBe("ETH");
    expect(eth?.nativeValueUsd).toBe("2000.00");
    expect(eth?.tokens).toHaveLength(1);
    expect(eth?.tokens[0]?.symbol).toBe("USDC");
    expect(eth?.tokens[0]?.contractAddress).toBe(USDC);
    expect(eth?.tokens[0]?.logoUrl).toBe("https://logo.example/usdc.png");
    expect(metadataCalls.every((addr) => addr === USDC)).toBe(true);
  });

  it("omits tokens whose metadata fetch rejects and defaults missing meta", async () => {
    installFetch((_url, body) => {
      if (String(_url).includes("api.dexscreener.com")) {
        return jsonResponse([]);
      }
      if (String(_url).includes("api.dexpaprika.com")) {
        return jsonResponse({ summary: { price_usd: 0 } });
      }
      const method = typeof body?.method === "string" ? body.method : "";
      if (method === "eth_getBalance") {
        return jsonResponse({ result: "0x0" });
      }
      if (method === "alchemy_getTokenBalances") {
        return jsonResponse({
          result: {
            tokenBalances: [
              { contractAddress: USDC, tokenBalance: "0x1" },
              { contractAddress: WETH, tokenBalance: "0x2" },
            ],
          },
        });
      }
      if (method === "alchemy_getTokenMetadata") {
        const params = Array.isArray(body?.params) ? body.params : [];
        if (params[0] === WETH) {
          return new Response("metadata exploded", { status: 500 });
        }
        return jsonResponse({ result: {} });
      }
      return jsonResponse({ result: "0x0" });
    });

    const chains = await fetchEvmBalances(WALLET, {
      alchemyKey: "alk",
      ethereumRpcUrls: [],
      bscRpcUrls: [],
      baseRpcUrls: [],
      avaxRpcUrls: [],
    });
    const eth = chains.find((c) => c.chainId === 1);
    expect(eth?.tokens).toHaveLength(1);
    expect(eth?.tokens[0]?.symbol).toBe("???");
    expect(eth?.tokens[0]?.name).toBe("Unknown Token");
    expect(eth?.tokens[0]?.decimals).toBe(18);
    expect(eth?.nativeValueUsd).toBe("0");
  });

  it("fetches Alchemy metadata for every non-zero token", async () => {
    const metadataCalls: string[] = [];
    const tokenBalances = Array.from({ length: 51 }, (_, i) => ({
      contractAddress: `0x${(i + 1).toString(16).padStart(40, "0")}`,
      tokenBalance: "0x1",
    }));
    installFetch((_url, body) => {
      if (String(_url).includes("api.dexscreener.com")) {
        return jsonResponse([]);
      }
      if (String(_url).includes("api.dexpaprika.com")) {
        return jsonResponse({ summary: { price_usd: 0 } });
      }
      const method = typeof body?.method === "string" ? body.method : "";
      if (method === "eth_getBalance") {
        return jsonResponse({ result: "0x0" });
      }
      if (method === "alchemy_getTokenBalances") {
        return jsonResponse({ result: { tokenBalances } });
      }
      if (method === "alchemy_getTokenMetadata") {
        const params = Array.isArray(body?.params) ? body.params : [];
        metadataCalls.push(String(params[0] ?? ""));
        return jsonResponse({
          result: {
            name: "T",
            symbol: "T",
            decimals: 18,
            logo: null,
          },
        });
      }
      return jsonResponse({ result: "0x0" });
    });

    const chains = await fetchEvmBalances(WALLET, "alk");
    const eth = chains.find((c) => c.chainId === 1);
    expect(eth?.tokens).toHaveLength(51);
    expect(metadataCalls).toHaveLength(51 * 7);
  });

  it("records a chain error when the Alchemy native call throws", async () => {
    installFetch((url) => {
      if (url.includes("eth-mainnet.g.alchemy.com")) {
        throw new Error("socket hang up");
      }
      if (url.includes("api.dexscreener.com") || url.includes("dexpaprika")) {
        return jsonResponse([]);
      }
      return jsonResponse({ result: "0x0" });
    });
    const chains = await fetchEvmBalances(WALLET, "alk");
    const eth = chains.find((c) => c.chainId === 1);
    expect(eth?.error).toBe("socket hang up");
    expect(eth?.nativeBalance).toBe("0");
    expect(eth?.tokens).toEqual([]);
    expect(chains.find((c) => c.chainId === 8453)?.error).toBeNull();
  });

  it("falls back to explicit RPCs and retries the next URL after a failure", async () => {
    const attempted: string[] = [];
    installFetch((url, body) => {
      if (url.includes("api.dexscreener.com")) {
        return jsonResponse([
          {
            baseToken: {
              address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            },
            priceUsd: "10",
            liquidity: { usd: 10 },
          },
        ]);
      }
      if (url.includes("api.dexpaprika.com")) {
        return jsonResponse({ summary: { price_usd: 0 } });
      }
      const method = typeof body?.method === "string" ? body.method : "";
      if (method === "eth_getBalance") {
        attempted.push(url);
        if (url.includes("eth-fail.example")) {
          return new Response("nope", { status: 500 });
        }
        return jsonResponse({ result: ONE_ETH_HEX });
      }
      return jsonResponse({ result: "0x0" });
    });

    const chains = await fetchEvmBalances(WALLET, {
      ethereumRpcUrls: [
        "https://eth-fail.example/rpc",
        "https://eth-ok.example/rpc",
      ],
      baseRpcUrls: ["https://base-ok.example/rpc"],
      bscRpcUrls: ["https://bsc-ok.example/rpc"],
      avaxRpcUrls: ["https://avax-ok.example/rpc"],
    });
    const ids = chains.map((c) => c.chainId).sort((a, b) => a - b);
    expect(ids).toEqual([1, 56, 8453, 43114]);
    expect(chains.every((c) => c.error === null)).toBe(true);
    expect(attempted).toContain("https://eth-fail.example/rpc");
    expect(attempted).toContain("https://eth-ok.example/rpc");
    const eth = chains.find((c) => c.chainId === 1);
    expect(eth?.nativeBalance).toBe("1");
    expect(eth?.nativeValueUsd).toBe("10.00");
  });

  it("surfaces joined RPC host errors when every endpoint fails", async () => {
    installFetch((url) => {
      if (url.includes("not-a-host")) {
        throw new Error("failed to parse URL");
      }
      return new Response("down", { status: 500 });
    });
    const chains = await fetchEvmBalances(WALLET, {
      ethereumRpcUrls: [":::not-a-host", "https://eth-down.example/rpc"],
    });
    expect(chains).toHaveLength(1);
    expect(chains[0]?.chainId).toBe(1);
    expect(chains[0]?.error).toMatch(/rpc: /);
    expect(chains[0]?.error).toMatch(/eth-down\.example/);
    expect(chains[0]?.error).toContain("eth-down.example");
  });

  it("queries every known ERC-20 via RPC and skips zero balances", async () => {
    const balanceOfCalls: string[] = [];
    const known = Array.from(
      { length: 31 },
      (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`,
    );
    installFetch((url, body) => {
      if (url.includes("api.dexscreener.com")) return jsonResponse([]);
      if (url.includes("api.dexpaprika.com")) {
        return jsonResponse({ summary: { price_usd: 0 } });
      }
      const method = typeof body?.method === "string" ? body.method : "";
      if (method === "eth_getBalance") {
        return jsonResponse({ result: "0x0" });
      }
      if (method === "eth_call") {
        const params = Array.isArray(body?.params) ? body.params : [];
        const call = params[0] as { to?: string; data?: string } | undefined;
        const data = call?.data ?? "";
        const to = call?.to ?? "";
        if (data.startsWith("0x70a08231")) {
          balanceOfCalls.push(to);
          if (to === known[0]) {
            return jsonResponse({ result: "0xf4240" }); // 1_000_000
          }
          return jsonResponse({ result: "0x0" });
        }
        if (data === "0x95d89b41") {
          return jsonResponse({ result: encodeAbiString("USDC") });
        }
        if (data === "0x313ce567") {
          return jsonResponse({
            result: `0x${6n.toString(16).padStart(64, "0")}`,
          });
        }
      }
      return jsonResponse({ result: "0x0" });
    });

    const chains = await fetchEvmBalances(
      WALLET,
      { ethereumRpcUrls: ["https://eth-ok.example/rpc"] },
      null,
      known,
    );
    const eth = chains.find((c) => c.chainId === 1);
    expect(balanceOfCalls).toHaveLength(31);
    expect(eth?.tokens).toHaveLength(1);
    expect(eth?.tokens[0]?.symbol).toBe("USDC");
    expect(eth?.tokens[0]?.name).toBe("USDC");
    expect(eth?.tokens[0]?.decimals).toBe(6);
    expect(eth?.tokens[0]?.balance).toBe("1");
    expect(eth?.tokens[0]?.contractAddress).toBe(known[0]);
  });

  it("keeps the default ERC-20 symbol when ABI decoding is impossible", async () => {
    installFetch((_url, body) => {
      if (
        String(_url).includes("dexscreener") ||
        String(_url).includes("dexpaprika")
      ) {
        return jsonResponse([]);
      }
      const method = typeof body?.method === "string" ? body.method : "";
      if (method === "eth_getBalance") {
        return jsonResponse({ result: "0x0" });
      }
      if (method === "eth_call") {
        const params = Array.isArray(body?.params) ? body.params : [];
        const call = params[0] as { data?: string } | undefined;
        const data = call?.data ?? "";
        if (data.startsWith("0x70a08231")) {
          return jsonResponse({ result: "0x1" });
        }
        if (data === "0x95d89b41") {
          return jsonResponse({ result: "0x" });
        }
        if (data === "0x313ce567") {
          return jsonResponse({ result: "0xff" }); // 255 > 36 → stay 18
        }
      }
      return jsonResponse({ result: "0x0" });
    });
    const chains = await fetchEvmBalances(
      WALLET,
      { ethereumRpcUrls: ["https://eth-ok.example/rpc"] },
      null,
      [USDC],
    );
    expect(chains[0]?.tokens[0]?.symbol).toBe("TOKEN");
    expect(chains[0]?.tokens[0]?.decimals).toBe(18);
  });
});

describe("fetchEvmNfts", () => {
  it("returns nothing when no Alchemy key and no managed BSC RPC exist", async () => {
    const fetchMock = installFetch(() => jsonResponse({}));
    await expect(fetchEvmNfts(WALLET, null)).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns empty NFTs for BSC-only managed RPC without Alchemy", async () => {
    const fetchMock = installFetch(() => {
      throw new Error("NFT indexing is not on the RPC path");
    });
    const result = await fetchEvmNfts(WALLET, {
      bscRpcUrls: ["https://bsc-ok.example/rpc"],
    });
    expect(result).toEqual([{ chain: "BSC", nfts: [] }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps Alchemy NFT fields, image fallbacks, and 200-char descriptions", async () => {
    installFetch((url) => {
      if (!url.includes("/nft/v3/")) {
        return jsonResponse({ ownedNfts: [] });
      }
      if (!url.includes("eth-mainnet")) {
        return jsonResponse({ ownedNfts: [] });
      }
      return jsonResponse({
        ownedNfts: [
          {
            contract: {
              address: "0xnft",
              name: "ContractName",
              openSeaMetadata: { collectionName: "Cool Cats" },
            },
            tokenId: "42",
            name: "Cat #42",
            description: `${"a".repeat(199)}🦊 extra`,
            image: {
              thumbnailUrl: "https://img.example/thumb.png",
              originalUrl: "https://img.example/orig.png",
            },
            tokenType: "ERC1155",
          },
          {
            contract: { address: "0xbare" },
            image: { originalUrl: "https://img.example/orig.png" },
          },
        ],
      });
    });
    const result = await fetchEvmNfts(WALLET, "alk");
    expect(result).toHaveLength(7);
    const eth = result.find((r) => r.chain === "Ethereum");
    expect(eth?.nfts).toHaveLength(2);
    expect(eth?.nfts[0]?.collectionName).toBe("Cool Cats");
    expect(eth?.nfts[0]?.tokenType).toBe("ERC1155");
    expect(eth?.nfts[0]?.imageUrl).toBe("https://img.example/thumb.png");
    expect(eth?.nfts[0]?.description).toBe(`${"a".repeat(199)}🦊 extra`);
    expect(eth?.nfts[1]?.name).toBe("Untitled");
    expect(eth?.nfts[1]?.tokenId).toBe("");
    expect(eth?.nfts[1]?.collectionName).toBe("");
    expect(eth?.nfts[1]?.tokenType).toBe("ERC721");
    expect(eth?.nfts[1]?.imageUrl).toBe("https://img.example/orig.png");
    expect(eth?.nfts[1]?.description).toBe("");
  });

  it("returns an empty NFT list when the Alchemy NFT request fails", async () => {
    installFetch((url) => {
      if (url.includes("eth-mainnet") && url.includes("/nft/v3/")) {
        throw new Error("nft timeout");
      }
      return jsonResponse({ ownedNfts: [] });
    });
    const result = await fetchEvmNfts(WALLET, "alk");
    expect(result.find((r) => r.chain === "Ethereum")?.nfts).toEqual([]);
    expect(result.find((r) => r.chain === "Base")?.nfts).toEqual([]);
  });
});

describe("Ankr provider path", () => {
  const ankrOnly: EvmChainConfig = {
    name: "Fantom",
    subdomain: "fantom-mainnet",
    chainId: 250,
    nativeSymbol: "FTM",
    provider: "ankr",
    ankrChain: "fantom",
  };
  const ankrBsc: EvmChainConfig = {
    name: "BSC-Ankr",
    subdomain: "bnb-mainnet",
    chainId: 56,
    nativeSymbol: "BNB",
    provider: "ankr",
    ankrChain: "bsc",
  };

  it("drops an Ankr-only non-BSC chain when no Ankr key is configured", async () => {
    const original = DEFAULT_EVM_CHAINS.slice();
    (DEFAULT_EVM_CHAINS as unknown as EvmChainConfig[]).splice(
      0,
      DEFAULT_EVM_CHAINS.length,
      ankrOnly,
    );
    try {
      const fetchMock = installFetch(() => {
        throw new Error("network should not be called");
      });
      // Filter requires ankrKey or (BSC + managed RPC). Fantom is neither, so
      // the queue is empty — the inner "Missing ANKR_API_KEY" path is not taken.
      await expect(
        fetchEvmBalances(WALLET, {
          ethereumRpcUrls: ["https://unused.example"],
        }),
      ).resolves.toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restoreDefaultChains(original);
    }
  });

  it("parses Ankr native/token balances, skips zeros, and prices via DEX", async () => {
    const original = DEFAULT_EVM_CHAINS.slice();
    (DEFAULT_EVM_CHAINS as unknown as EvmChainConfig[]).splice(
      0,
      DEFAULT_EVM_CHAINS.length,
      ankrBsc,
    );
    installFetch((url, body) => {
      if (url.includes("api.dexscreener.com")) {
        return jsonResponse([
          {
            baseToken: {
              address: "0xabc0000000000000000000000000000000000001",
            },
            priceUsd: "2",
            liquidity: { usd: 50 },
            info: { imageUrl: "https://logo.example/cake.png" },
          },
        ]);
      }
      if (url.includes("api.dexpaprika.com")) {
        return jsonResponse({ summary: { price_usd: 0 } });
      }
      const method = typeof body?.method === "string" ? body.method : "";
      if (method === "ankr_getAccountBalance") {
        expect(body?.params).toMatchObject({
          walletAddress: WALLET,
          blockchain: ["bsc"],
        });
        return jsonResponse({
          result: {
            assets: [
              {
                tokenType: "NATIVE",
                tokenSymbol: "BNB",
                tokenBalance: "1.25",
                tokenDecimals: 18,
              },
              {
                tokenSymbol: "BNB",
                contractAddress: ZERO,
                tokenBalance: "9",
              },
              {
                tokenName: "Pancake",
                tokenSymbol: "CAKE",
                contractAddress: "0xabc0000000000000000000000000000000000001",
                tokenBalance: "1000000000000000000",
                tokenDecimals: "18",
                thumbnail: "",
              },
              {
                tokenSymbol: "ZERO",
                contractAddress: "0xzero",
                tokenBalance: "0.0",
              },
              {
                tokenSymbol: "RAW",
                contractAddress: "0xraw0000000000000000000000000000000000001",
                balanceRawInteger: 500,
                tokenDecimals: -1,
              },
              {
                tokenSymbol: "NUM",
                contractAddress: "0xnum0000000000000000000000000000000000001",
                tokenBalance: 2,
                tokenDecimals: 0,
              },
            ],
          },
        });
      }
      return jsonResponse({ result: { assets: [] } });
    });
    try {
      const chains = await fetchEvmBalances(WALLET, { ankrKey: "ankr_live" });
      expect(chains).toHaveLength(1);
      expect(chains[0]?.error).toBeNull();
      expect(chains[0]?.nativeBalance).toBe("1.25");
      const symbols = chains[0]?.tokens.map((t) => t.symbol).sort();
      expect(symbols).toEqual(["CAKE", "NUM", "RAW"]);
      const cake = chains[0]?.tokens.find((t) => t.symbol === "CAKE");
      expect(cake?.balance).toBe("1");
      expect(cake?.valueUsd).toBe("2.00");
      expect(cake?.logoUrl).toBe("https://logo.example/cake.png");
      const raw = chains[0]?.tokens.find((t) => t.symbol === "RAW");
      expect(raw?.decimals).toBe(18);
      expect(raw?.balance).toBe("0.0000000000000005");
      const num = chains[0]?.tokens.find((t) => t.symbol === "NUM");
      expect(num?.decimals).toBe(0);
      expect(num?.balance).toBe("2");
    } finally {
      restoreDefaultChains(original);
    }
  });

  it("uses display balance when tokenBalance is absent, else 0", async () => {
    const original = DEFAULT_EVM_CHAINS.slice();
    (DEFAULT_EVM_CHAINS as unknown as EvmChainConfig[]).splice(
      0,
      DEFAULT_EVM_CHAINS.length,
      ankrBsc,
    );
    installFetch((url, body) => {
      if (url.includes("dexscreener") || url.includes("dexpaprika")) {
        return jsonResponse([]);
      }
      const method = typeof body?.method === "string" ? body.method : "";
      if (method === "ankr_getAccountBalance") {
        return jsonResponse({
          result: {
            assets: [
              {
                tokenType: "NATIVE",
                balance: "3.5",
              },
              {
                tokenSymbol: "X",
                contractAddress: "0xabc0000000000000000000000000000000000001",
              },
            ],
          },
        });
      }
      return jsonResponse({ result: { assets: [] } });
    });
    try {
      const chains = await fetchEvmBalances(WALLET, { ankrKey: "ankr_live" });
      expect(chains[0]?.nativeBalance).toBe("3.5");
      // empty tokenBalance/balance/raw → "0" → filtered as zero
      expect(chains[0]?.tokens).toEqual([]);
    } finally {
      restoreDefaultChains(original);
    }
  });

  it("maps Ankr NFTs and returns [] when the request fails", async () => {
    const original = DEFAULT_EVM_CHAINS.slice();
    (DEFAULT_EVM_CHAINS as unknown as EvmChainConfig[]).splice(
      0,
      DEFAULT_EVM_CHAINS.length,
      ankrBsc,
    );
    try {
      installFetch((_url, body) => {
        const method = typeof body?.method === "string" ? body.method : "";
        if (method === "ankr_getNFTsByOwner") {
          return jsonResponse({
            result: {
              assets: [
                {
                  contractAddress: "0xnft",
                  tokenId: 7,
                  description: "d".repeat(250),
                  imagePreviewUrl: "https://img.example/preview.png",
                  contractName: "FromContract",
                },
              ],
            },
          });
        }
        return jsonResponse({ result: { assets: [] } });
      });
      const ok = await fetchEvmNfts(WALLET, { ankrKey: "ankr_live" });
      expect(ok).toHaveLength(1);
      expect(ok[0]?.nfts[0]?.tokenId).toBe("7");
      expect(ok[0]?.nfts[0]?.name).toBe("Untitled");
      expect(ok[0]?.nfts[0]?.collectionName).toBe("FromContract");
      expect(ok[0]?.nfts[0]?.imageUrl).toBe("https://img.example/preview.png");
      expect(ok[0]?.nfts[0]?.description).toBe("d".repeat(250));

      vi.unstubAllGlobals();
      installFetch(() => {
        throw new Error("ankr nft down");
      });
      const failed = await fetchEvmNfts(WALLET, { ankrKey: "ankr_live" });
      expect(failed).toEqual([{ chain: "BSC-Ankr", nfts: [] }]);
    } finally {
      restoreDefaultChains(original);
    }
  });
});

describe("JSON-RPC error envelopes on keyed provider paths", () => {
  const THROTTLE_MESSAGE =
    "Your app has exceeded its compute units per second capacity.";
  const ankrBsc: EvmChainConfig = {
    name: "BSC-Ankr",
    subdomain: "bnb-mainnet",
    chainId: 56,
    nativeSymbol: "BNB",
    provider: "ankr",
    ankrChain: "bsc",
  };

  function rpcErrorEnvelope(message = THROTTLE_MESSAGE): Response {
    return jsonResponse({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message },
    });
  }

  it("reports an Alchemy native-balance error envelope as a chain failure", async () => {
    installFetch((url, body) => {
      if (url.includes("api.dexscreener.com") || url.includes("dexpaprika")) {
        return jsonResponse([]);
      }
      if (body?.method === "eth_getBalance") return rpcErrorEnvelope();
      return jsonResponse({ result: { tokenBalances: [] } });
    });

    const chains = await fetchEvmBalances(WALLET, "alk");
    expect(chains).toHaveLength(7);
    for (const chain of chains) {
      expect(chain.error).not.toBeNull();
      expect(chain.error).toContain(THROTTLE_MESSAGE);
      expect(chain.tokens).toEqual([]);
    }
  });

  it("reports an Alchemy token-balance error envelope even when the native call succeeded", async () => {
    installFetch((url, body) => {
      if (url.includes("api.dexscreener.com") || url.includes("dexpaprika")) {
        return jsonResponse([]);
      }
      if (body?.method === "eth_getBalance") {
        return jsonResponse({ result: ONE_ETH_HEX });
      }
      if (body?.method === "alchemy_getTokenBalances") {
        return rpcErrorEnvelope("invalid api key");
      }
      return jsonResponse({ result: {} });
    });

    const chains = await fetchEvmBalances(WALLET, "alk");
    const eth = chains.find((c) => c.chainId === 1);
    expect(eth?.error).toContain("invalid api key");
    expect(eth?.nativeBalance).toBe("0");
    expect(eth?.tokens).toEqual([]);
  });

  it("reports an Ankr account-balance error envelope as a chain failure", async () => {
    const original = DEFAULT_EVM_CHAINS.slice();
    (DEFAULT_EVM_CHAINS as unknown as EvmChainConfig[]).splice(
      0,
      DEFAULT_EVM_CHAINS.length,
      ankrBsc,
    );
    try {
      installFetch((url, body) => {
        if (url.includes("api.dexscreener.com") || url.includes("dexpaprika")) {
          return jsonResponse([]);
        }
        if (body?.method === "ankr_getAccountBalance") {
          return rpcErrorEnvelope("blockchain is not supported");
        }
        return jsonResponse({ result: { assets: [] } });
      });

      const chains = await fetchEvmBalances(WALLET, { ankrKey: "ankr_live" });
      expect(chains).toHaveLength(1);
      expect(chains[0]?.error).toContain("blockchain is not supported");
      expect(chains[0]?.nativeBalance).toBe("0");
      expect(chains[0]?.tokens).toEqual([]);
    } finally {
      restoreDefaultChains(original);
    }
  });

  it("rejects an Alchemy NFT error envelope instead of reading it as an empty collection", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      installFetch((url) => {
        if (url.includes("eth-mainnet") && url.includes("/nft/v3/")) {
          return rpcErrorEnvelope();
        }
        return jsonResponse({ ownedNfts: [] });
      });

      const result = await fetchEvmNfts(WALLET, "alk");
      expect(result.find((r) => r.chain === "Ethereum")?.nfts).toEqual([]);
      expect(
        warn.mock.calls.some(
          ([message]) =>
            typeof message === "string" &&
            message.includes("Ethereum") &&
            message.includes(THROTTLE_MESSAGE),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects an Ankr NFT error envelope instead of reading it as an empty collection", async () => {
    const original = DEFAULT_EVM_CHAINS.slice();
    (DEFAULT_EVM_CHAINS as unknown as EvmChainConfig[]).splice(
      0,
      DEFAULT_EVM_CHAINS.length,
      ankrBsc,
    );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      installFetch((_url, body) => {
        if (body?.method === "ankr_getNFTsByOwner") {
          return rpcErrorEnvelope("rate limit exceeded");
        }
        return jsonResponse({ result: { assets: [] } });
      });

      const result = await fetchEvmNfts(WALLET, { ankrKey: "ankr_live" });
      expect(result).toEqual([{ chain: "BSC-Ankr", nfts: [] }]);
      expect(
        warn.mock.calls.some(
          ([message]) =>
            typeof message === "string" &&
            message.includes("BSC-Ankr") &&
            message.includes("rate limit exceeded"),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
      restoreDefaultChains(original);
    }
  });
});
