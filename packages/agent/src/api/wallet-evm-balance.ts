/**
 * EVM balance fetching — Alchemy, Ankr, and direct-RPC fallback paths.
 *
 * Handles multi-chain EVM balance + NFT retrieval with provider-key resolution
 * and automatic fallback to public RPC endpoints when premium APIs are unavailable.
 */

import { ElizaError, logger, toWellFormedUnicode } from "@elizaos/core";
import type { EvmChainBalance, EvmNft, EvmTokenBalance } from "@elizaos/shared";
import {
  computeValueUsd,
  type DexTokenMeta,
  fetchDexPrices,
  WRAPPED_NATIVE,
} from "./wallet-dex-prices.ts";
import {
  resolveAvalancheRpcUrls,
  resolveBaseRpcUrls,
  resolveBscRpcUrls,
  resolveEthereumRpcUrls,
} from "./wallet-rpc.ts";

// ── Constants ─────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 15_000;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ── Types ─────────────────────────────────────────────────────────────

type EvmChainProvider = "alchemy" | "ankr";

export interface EvmChainConfig {
  name: string;
  subdomain: string;
  chainId: number;
  nativeSymbol: string;
  provider: EvmChainProvider;
  ankrChain?: string;
}

export interface EvmProviderKeys {
  alchemyKey?: string | null;
  ankrKey?: string | null;
  cloudManagedAccess?: boolean | null;
  bscRpcUrls?: string[] | null;
  ethereumRpcUrls?: string[] | null;
  baseRpcUrls?: string[] | null;
  avaxRpcUrls?: string[] | null;
  nodeRealBscRpcUrl?: string | null;
  quickNodeBscRpcUrl?: string | null;
  /** Standard elizaOS EVM plugin env key for BSC. */
  bscRpcUrl?: string | null;
  /** Standard elizaOS EVM plugin env key for Ethereum mainnet. */
  ethereumRpcUrl?: string | null;
  /** Standard elizaOS EVM plugin env key for Base. */
  baseRpcUrl?: string | null;
  /** Standard elizaOS EVM plugin env key for Avalanche C-Chain. */
  avaxRpcUrl?: string | null;
}

interface EvmProviderKeyset {
  alchemyKey: string | null;
  ankrKey: string | null;
  cloudManagedAccess: boolean;
  bscRpcUrls: string[];
  ethereumRpcUrls: string[];
  baseRpcUrls: string[];
  avaxRpcUrls: string[];
  nodeRealBscRpcUrl: string | null;
  quickNodeBscRpcUrl: string | null;
  bscRpcUrl: string | null;
  ethereumRpcUrl: string | null;
  baseRpcUrl: string | null;
  avaxRpcUrl: string | null;
}

interface AlchemyTokenBalance {
  contractAddress: string;
  tokenBalance: string;
}

interface AlchemyTokenMeta {
  name: string;
  symbol: string;
  decimals: number;
  logo: string | null;
}

export interface AnkrTokenAsset {
  contractAddress?: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenDecimals?: number | string;
  tokenType?: string;
  tokenBalance?: string | number;
  balance?: string | number;
  balanceRawInteger?: string | number;
  balanceUsd?: string | number;
  thumbnail?: string;
}

interface AnkrNftAsset {
  contractAddress?: string;
  tokenId?: string | number;
  name?: string;
  description?: string;
  imageUrl?: string;
  imagePreviewUrl?: string;
  imageOriginalUrl?: string;
  collectionName?: string;
  contractName?: string;
  tokenType?: string;
}

// ── Default chain configuration ───────────────────────────────────────

export const DEFAULT_EVM_CHAINS: readonly EvmChainConfig[] = [
  {
    name: "Ethereum",
    subdomain: "eth-mainnet",
    chainId: 1,
    nativeSymbol: "ETH",
    provider: "alchemy",
  },
  {
    name: "Base",
    subdomain: "base-mainnet",
    chainId: 8453,
    nativeSymbol: "ETH",
    provider: "alchemy",
  },
  {
    name: "Arbitrum",
    subdomain: "arb-mainnet",
    chainId: 42161,
    nativeSymbol: "ETH",
    provider: "alchemy",
  },
  {
    name: "Optimism",
    subdomain: "opt-mainnet",
    chainId: 10,
    nativeSymbol: "ETH",
    provider: "alchemy",
  },
  {
    name: "Polygon",
    subdomain: "polygon-mainnet",
    chainId: 137,
    nativeSymbol: "POL",
    provider: "alchemy",
  },
  {
    name: "BSC",
    subdomain: "bnb-mainnet",
    chainId: 56,
    nativeSymbol: "BNB",
    provider: "alchemy",
  },
  {
    name: "Avalanche",
    subdomain: "avax-mainnet",
    chainId: 43114,
    nativeSymbol: "AVAX",
    provider: "alchemy",
  },
] as const;

// ── Internal helpers ──────────────────────────────────────────────────

/** Parse JSON from a fetch response. If the body isn't JSON, throw with the raw text. */
async function jsonOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok)
    throw new Error(toWellFormedUnicode(text) || `HTTP ${res.status}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(toWellFormedUnicode(text) || "Invalid JSON");
  }
}

type JsonRpcErrorEnvelope = {
  error?: unknown;
};

const PROVIDER_LABEL: Record<EvmChainProvider, string> = {
  alchemy: "Alchemy",
  ankr: "Ankr",
};

/**
 * Reject a keyed-provider body that carries an `error` member. Alchemy and
 * Ankr answer HTTP 200 with a JSON-RPC error object (Alchemy's NFT REST API
 * may use a bare string) for throttling, invalid keys, and unsupported chains,
 * so `jsonOrThrow` alone would let the caller read a missing `result` as a
 * healthy zero balance. The thrown error reaches the per-chain boundary in
 * `fetchEvmBalances` / `fetchEvmNfts`, which report it with the provider text.
 */
function requireJsonRpcResult<T extends JsonRpcErrorEnvelope>(
  data: T,
  chain: EvmChainConfig,
): T {
  const envelopeError = data.error;
  if (envelopeError === undefined || envelopeError === null) return data;
  let rawMessage = "";
  let rpcCode: number | null = null;
  if (typeof envelopeError === "string") {
    rawMessage = envelopeError;
  } else if (typeof envelopeError === "object") {
    const record = envelopeError as { code?: unknown; message?: unknown };
    if (typeof record.message === "string") rawMessage = record.message;
    if (typeof record.code === "number") rpcCode = record.code;
  }
  const providerLabel = PROVIDER_LABEL[chain.provider];
  const message =
    toWellFormedUnicode(rawMessage).trim() ||
    `${providerLabel} JSON-RPC error${rpcCode === null ? "" : ` ${rpcCode}`}`;
  throw new ElizaError(message, {
    code: "EVM_PROVIDER_RPC_ERROR",
    context: {
      provider: chain.provider,
      chain: chain.name,
      chainId: chain.chainId,
      rpcCode,
    },
  });
}

function normalizeApiKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringArray(
  values: ReadonlyArray<string | null | undefined> | null | undefined,
): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => normalizeApiKey(value))
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

export function resolveEvmProviderKeys(
  alchemyOrKeys: string | EvmProviderKeys | null | undefined,
  maybeAnkrKey?: string | null,
): EvmProviderKeyset {
  if (typeof alchemyOrKeys === "string" || alchemyOrKeys == null) {
    const alchemyKey = typeof alchemyOrKeys === "string" ? alchemyOrKeys : null;
    return {
      alchemyKey: normalizeApiKey(alchemyKey),
      ankrKey: normalizeApiKey(maybeAnkrKey),
      cloudManagedAccess: false,
      bscRpcUrls: resolveBscRpcUrls({ cloudManagedAccess: false }),
      ethereumRpcUrls: resolveEthereumRpcUrls({ cloudManagedAccess: false }),
      baseRpcUrls: resolveBaseRpcUrls({ cloudManagedAccess: false }),
      avaxRpcUrls: resolveAvalancheRpcUrls({ cloudManagedAccess: false }),
      nodeRealBscRpcUrl: normalizeApiKey(
        process.env.NODEREAL_BSC_RPC_URL ?? null,
      ),
      quickNodeBscRpcUrl: normalizeApiKey(
        process.env.QUICKNODE_BSC_RPC_URL ?? null,
      ),
      bscRpcUrl: normalizeApiKey(process.env.BSC_RPC_URL ?? null),
      ethereumRpcUrl: normalizeApiKey(process.env.ETHEREUM_RPC_URL ?? null),
      baseRpcUrl: normalizeApiKey(process.env.BASE_RPC_URL ?? null),
      avaxRpcUrl: normalizeApiKey(process.env.AVALANCHE_RPC_URL ?? null),
    };
  }
  const cloudManagedAccess = Boolean(alchemyOrKeys.cloudManagedAccess);
  return {
    alchemyKey: normalizeApiKey(alchemyOrKeys.alchemyKey),
    ankrKey: normalizeApiKey(alchemyOrKeys.ankrKey ?? maybeAnkrKey),
    cloudManagedAccess,
    bscRpcUrls: normalizeStringArray([
      ...(alchemyOrKeys.bscRpcUrls ?? []),
      alchemyOrKeys.nodeRealBscRpcUrl ?? process.env.NODEREAL_BSC_RPC_URL,
      alchemyOrKeys.quickNodeBscRpcUrl ?? process.env.QUICKNODE_BSC_RPC_URL,
      alchemyOrKeys.bscRpcUrl ?? process.env.BSC_RPC_URL,
      ...resolveBscRpcUrls({ cloudManagedAccess }),
    ]),
    ethereumRpcUrls: normalizeStringArray([
      ...(alchemyOrKeys.ethereumRpcUrls ?? []),
      alchemyOrKeys.ethereumRpcUrl ?? process.env.ETHEREUM_RPC_URL,
      ...resolveEthereumRpcUrls({ cloudManagedAccess }),
    ]),
    baseRpcUrls: normalizeStringArray([
      ...(alchemyOrKeys.baseRpcUrls ?? []),
      alchemyOrKeys.baseRpcUrl ?? process.env.BASE_RPC_URL,
      ...resolveBaseRpcUrls({ cloudManagedAccess }),
    ]),
    avaxRpcUrls: normalizeStringArray([
      ...(alchemyOrKeys.avaxRpcUrls ?? []),
      alchemyOrKeys.avaxRpcUrl ?? process.env.AVALANCHE_RPC_URL,
      ...resolveAvalancheRpcUrls({ cloudManagedAccess }),
    ]),
    nodeRealBscRpcUrl: normalizeApiKey(
      alchemyOrKeys.nodeRealBscRpcUrl ?? process.env.NODEREAL_BSC_RPC_URL,
    ),
    quickNodeBscRpcUrl: normalizeApiKey(
      alchemyOrKeys.quickNodeBscRpcUrl ?? process.env.QUICKNODE_BSC_RPC_URL,
    ),
    bscRpcUrl: normalizeApiKey(
      alchemyOrKeys.bscRpcUrl ?? process.env.BSC_RPC_URL,
    ),
    ethereumRpcUrl: normalizeApiKey(
      alchemyOrKeys.ethereumRpcUrl ?? process.env.ETHEREUM_RPC_URL,
    ),
    baseRpcUrl: normalizeApiKey(
      alchemyOrKeys.baseRpcUrl ?? process.env.BASE_RPC_URL,
    ),
    avaxRpcUrl: normalizeApiKey(
      alchemyOrKeys.avaxRpcUrl ?? process.env.AVALANCHE_RPC_URL,
    ),
  };
}

function isBscChain(chain: EvmChainConfig): boolean {
  return (
    chain.chainId === 56 || (chain.ankrChain ?? "").toLowerCase() === "bsc"
  );
}

function describeRpcEndpoint(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "rpc";
  }
}

function makeEvmChainFailure(
  chain: EvmChainConfig,
  message: string,
): EvmChainBalance {
  return {
    chain: chain.name,
    chainId: chain.chainId,
    nativeBalance: "0",
    nativeSymbol: chain.nativeSymbol,
    nativeValueUsd: "0",
    tokens: [],
    error: message,
  };
}

function rpcJsonRequest(body: string): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body,
  };
}

function asString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function parseTokenDecimals(value: unknown, fallback = 18): number {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(num) || num < 0) return fallback;
  return Math.trunc(num);
}

function parseAnkrBalance(asset: AnkrTokenAsset, decimals: number): string {
  const tokenBalance = asString(asset.tokenBalance);
  if (tokenBalance) {
    if (/^\d+$/.test(tokenBalance))
      return formatWei(BigInt(tokenBalance), decimals);
    return tokenBalance;
  }

  const displayBalance = asString(asset.balance);
  if (displayBalance) {
    if (/^\d+$/.test(displayBalance))
      return formatWei(BigInt(displayBalance), decimals);
    return displayBalance;
  }

  const rawBalance = asString(asset.balanceRawInteger);
  if (rawBalance && /^\d+$/.test(rawBalance))
    return formatWei(BigInt(rawBalance), decimals);

  return "0";
}

function isZeroBalance(balance: string): boolean {
  if (!balance) return true;
  if (/^0+(\.0+)?$/.test(balance)) return true;
  const parsed = Number.parseFloat(balance);
  return Number.isFinite(parsed) ? parsed <= 0 : false;
}

function isAnkrNativeAsset(asset: AnkrTokenAsset): boolean {
  const tokenType = (asset.tokenType ?? "").toUpperCase();
  const symbol = (asset.tokenSymbol ?? "").toUpperCase();
  const contract = (asset.contractAddress ?? "").toLowerCase();
  if (tokenType === "NATIVE") return true;
  return symbol === "BNB" && (!contract || contract === ZERO_ADDRESS);
}

function formatWei(wei: bigint, decimals: number): string {
  if (wei <= 0n || decimals <= 0) return wei <= 0n ? "0" : wei.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = wei / divisor;
  const rem = wei % divisor;
  if (rem === 0n) return whole.toString();
  return `${whole}.${rem.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

// ── Alchemy balance fetching ──────────────────────────────────────────

async function fetchAlchemyChainBalances(
  chain: EvmChainConfig,
  address: string,
  alchemyKey: string,
): Promise<EvmChainBalance> {
  const url = `https://${chain.subdomain}.g.alchemy.com/v2/${alchemyKey}`;

  const nativeData = requireJsonRpcResult(
    await jsonOrThrow<{ result?: string } & JsonRpcErrorEnvelope>(
      await fetch(
        url,
        rpcJsonRequest(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_getBalance",
            params: [address, "latest"],
          }),
        ),
      ),
    ),
    chain,
  );
  const nativeBalance = formatWei(
    nativeData.result ? BigInt(nativeData.result) : 0n,
    18,
  );

  const tokenData = requireJsonRpcResult(
    await jsonOrThrow<
      {
        result?: { tokenBalances?: AlchemyTokenBalance[] };
      } & JsonRpcErrorEnvelope
    >(
      await fetch(
        url,
        rpcJsonRequest(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "alchemy_getTokenBalances",
            params: [address, "DEFAULT_TOKENS"],
          }),
        ),
      ),
    ),
    chain,
  );
  const nonZero = (tokenData.result?.tokenBalances ?? []).filter(
    (t) =>
      t.tokenBalance && t.tokenBalance !== "0x0" && t.tokenBalance !== "0x",
  );

  const metaResults = await Promise.allSettled(
    nonZero.map(async (tok): Promise<EvmTokenBalance> => {
      const meta = (
        await jsonOrThrow<{ result?: AlchemyTokenMeta }>(
          await fetch(
            url,
            rpcJsonRequest(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "alchemy_getTokenMetadata",
                params: [tok.contractAddress],
              }),
            ),
          ),
        )
      ).result;
      const decimals = meta?.decimals ?? 18;
      return {
        symbol: meta?.symbol ?? "???",
        name: meta?.name ?? "Unknown Token",
        contractAddress: tok.contractAddress,
        balance: formatWei(BigInt(tok.tokenBalance), decimals),
        decimals,
        valueUsd: "0",
        logoUrl: meta?.logo || "",
      };
    }),
  );
  const tokens = metaResults
    .filter(
      (r): r is PromiseFulfilledResult<EvmTokenBalance> =>
        r.status === "fulfilled",
    )
    .map((r) => r.value);

  // Fetch DEX prices for all tokens + native token.
  const allAddresses = tokens.map((t) => t.contractAddress);
  const wrappedNative = WRAPPED_NATIVE[chain.chainId];
  if (wrappedNative) allAddresses.push(wrappedNative);
  const dexPrices = await fetchDexPrices(chain.chainId, allAddresses);

  for (const tok of tokens) {
    const meta = dexPrices.get(tok.contractAddress.toLowerCase());
    if (meta) {
      tok.valueUsd = computeValueUsd(tok.balance, meta.price);
      if (meta.logoUrl && !tok.logoUrl) tok.logoUrl = meta.logoUrl;
    }
  }
  const nativeMeta = wrappedNative
    ? dexPrices.get(wrappedNative.toLowerCase())
    : undefined;
  const nativeValueUsd = nativeMeta
    ? computeValueUsd(nativeBalance, nativeMeta.price)
    : "0";

  return {
    chain: chain.name,
    chainId: chain.chainId,
    nativeBalance,
    nativeSymbol: chain.nativeSymbol,
    nativeValueUsd,
    tokens,
    error: null,
  };
}

// ── Ankr balance fetching ─────────────────────────────────────────────

async function fetchAnkrChainBalances(
  chain: EvmChainConfig,
  address: string,
  ankrKey: string,
): Promise<EvmChainBalance> {
  const res = await fetch(
    `https://rpc.ankr.com/multichain/${ankrKey}`,
    rpcJsonRequest(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "ankr_getAccountBalance",
        params: {
          walletAddress: address,
          blockchain: [chain.ankrChain ?? "bsc"],
          onlyWhitelisted: false,
        },
      }),
    ),
  );
  const data = requireJsonRpcResult(
    await jsonOrThrow<
      { result?: { assets?: AnkrTokenAsset[] } } & JsonRpcErrorEnvelope
    >(res),
    chain,
  );
  const assets = data.result?.assets ?? [];
  const nativeAsset = assets.find(isAnkrNativeAsset);
  const nativeBalance = nativeAsset
    ? parseAnkrBalance(
        nativeAsset,
        parseTokenDecimals(nativeAsset.tokenDecimals),
      )
    : "0";
  const tokens: EvmTokenBalance[] = [];
  for (const asset of assets) {
    if (isAnkrNativeAsset(asset)) continue;
    const decimals = parseTokenDecimals(asset.tokenDecimals);
    const balance = parseAnkrBalance(asset, decimals);
    if (isZeroBalance(balance)) continue;
    tokens.push({
      symbol: asset.tokenSymbol ?? "???",
      name: asset.tokenName ?? "Unknown Token",
      contractAddress: asset.contractAddress ?? "",
      balance,
      decimals,
      valueUsd: "0",
      logoUrl: asset.thumbnail ?? "",
    });
  }

  // All pricing via DexScreener/DexPaprika (Ankr only provides balances).
  const allAddresses = tokens
    .filter((t) => t.contractAddress)
    .map((t) => t.contractAddress);
  const wrappedNative = WRAPPED_NATIVE[chain.chainId];
  if (wrappedNative) allAddresses.push(wrappedNative);
  logger.info(
    `[wallet] Fetching DEX prices for ${chain.name}: ${allAddresses.length} addresses (native=${nativeBalance})`,
  );
  const dexPrices = await fetchDexPrices(chain.chainId, allAddresses);
  logger.info(
    `[wallet] DEX prices result for ${chain.name}: ${dexPrices.size} prices found`,
  );

  for (const tok of tokens) {
    const meta = dexPrices.get(tok.contractAddress.toLowerCase());
    if (meta) {
      tok.valueUsd = computeValueUsd(tok.balance, meta.price);
      if (meta.logoUrl && !tok.logoUrl) tok.logoUrl = meta.logoUrl;
    }
  }
  const nativeMeta = wrappedNative
    ? dexPrices.get(wrappedNative.toLowerCase())
    : undefined;
  const nativeValueUsd = nativeMeta
    ? computeValueUsd(nativeBalance, nativeMeta.price)
    : "0";

  return {
    chain: chain.name,
    chainId: chain.chainId,
    nativeBalance,
    nativeSymbol: chain.nativeSymbol,
    nativeValueUsd,
    tokens,
    error: null,
  };
}

// ── Direct RPC balance fetching ───────────────────────────────────────

export async function fetchEvmNativeBalanceViaRpc(
  rpcUrl: string,
  address: string,
): Promise<string> {
  const data = await jsonOrThrow<{
    result?: string;
    error?: { message?: string };
  }>(
    await fetch(
      rpcUrl,
      rpcJsonRequest(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBalance",
          params: [address, "latest"],
        }),
      ),
    ),
  );

  if (data.error?.message) {
    throw new Error(data.error.message);
  }

  const raw = typeof data.result === "string" ? data.result : "0x0";
  const wei = raw.startsWith("0x") ? BigInt(raw) : BigInt(raw || "0");
  return formatWei(wei, 18);
}

/**
 * Query ERC-20 balanceOf, symbol, and decimals for a single token via RPC.
 * Returns null if the token has zero balance or the call fails.
 */
async function fetchErc20BalanceViaRpc(
  rpcUrl: string,
  walletAddress: string,
  contractAddress: string,
): Promise<EvmTokenBalance | null> {
  const paddedWallet = walletAddress
    .toLowerCase()
    .replace("0x", "")
    .padStart(64, "0");
  // balanceOf(address) — paddedWallet is already 64 hex chars (24 zero prefix + 40 addr)
  const balanceOfData = `0x70a08231${paddedWallet}`;
  // symbol()
  const symbolData = "0x95d89b41";
  // decimals()
  const decimalsData = "0x313ce567";

  const makeCall = (to: string, data: string) =>
    fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to, data }, "latest"],
      }),
      signal: AbortSignal.timeout(8_000),
    }).then((r) => r.json() as Promise<{ result?: string }>);

  try {
    const [balRes, symRes, decRes] = await Promise.all([
      makeCall(contractAddress, balanceOfData),
      makeCall(contractAddress, symbolData),
      makeCall(contractAddress, decimalsData),
    ]);

    const rawBal = balRes.result;
    if (!rawBal || rawBal === "0x" || rawBal === "0x0" || BigInt(rawBal) === 0n)
      return null;

    let decimals = 18;
    if (decRes.result && decRes.result !== "0x") {
      const d = Number(BigInt(decRes.result));
      if (Number.isFinite(d) && d >= 0 && d <= 36) decimals = d;
    }

    let symbol = "TOKEN";
    if (symRes.result && symRes.result.length > 2) {
      try {
        // ABI-encoded string: offset (32 bytes) + length (32 bytes) + data
        const hex = symRes.result.slice(2);
        if (hex.length >= 128) {
          const len = Number(BigInt(`0x${hex.slice(64, 128)}`));
          const bytes = Buffer.from(hex.slice(128, 128 + len * 2), "hex");
          const decoded = bytes.toString("utf-8").replace(/\0/g, "").trim();
          if (decoded) symbol = decoded;
        }
      } catch {
        // Fall through with default symbol.
      }
    }

    const balance = formatWei(BigInt(rawBal), decimals);
    return {
      symbol,
      name: symbol,
      contractAddress,
      balance,
      decimals,
      valueUsd: "0",
      logoUrl: "",
    };
  } catch {
    return null;
  }
}

async function fetchEvmChainBalancesViaRpc(
  chain: EvmChainConfig,
  address: string,
  rpcUrls: string[],
  knownTokenAddresses?: string[],
): Promise<EvmChainBalance> {
  const errors: string[] = [];
  for (const rpcUrl of rpcUrls) {
    try {
      const nativeBalance = await fetchEvmNativeBalanceViaRpc(rpcUrl, address);

      // Query known ERC-20 tokens (e.g. from trade ledger).
      const tokens: EvmTokenBalance[] = [];
      if (knownTokenAddresses && knownTokenAddresses.length > 0) {
        const results = await Promise.allSettled(
          knownTokenAddresses.map((addr) =>
            fetchErc20BalanceViaRpc(rpcUrl, address, addr),
          ),
        );
        for (const r of results) {
          if (r.status === "fulfilled" && r.value) tokens.push(r.value);
        }
      }

      // Price native + tokens via DEX.
      const wrappedNative = WRAPPED_NATIVE[chain.chainId];
      const priceAddresses = tokens.map((t) => t.contractAddress);
      if (wrappedNative) priceAddresses.push(wrappedNative);

      const dexPrices =
        priceAddresses.length > 0
          ? await fetchDexPrices(chain.chainId, priceAddresses)
          : new Map<string, DexTokenMeta>();

      let nativeValueUsd = "0";
      if (wrappedNative) {
        const nativeMeta = dexPrices.get(wrappedNative.toLowerCase());
        if (nativeMeta)
          nativeValueUsd = computeValueUsd(nativeBalance, nativeMeta.price);
        logger.info(
          `[wallet] RPC path: ${chain.name} native=${nativeBalance} price=${nativeMeta?.price ?? "none"} value=$${nativeValueUsd}`,
        );
      }

      for (const tok of tokens) {
        const meta = dexPrices.get(tok.contractAddress.toLowerCase());
        if (meta) {
          tok.valueUsd = computeValueUsd(tok.balance, meta.price);
          if (meta.logoUrl) tok.logoUrl = meta.logoUrl;
        }
      }

      if (tokens.length > 0) {
        logger.info(
          `[wallet] RPC path: ${chain.name} found ${tokens.length} tokens with balance`,
        );
      }

      return {
        chain: chain.name,
        chainId: chain.chainId,
        nativeBalance,
        nativeSymbol: chain.nativeSymbol,
        nativeValueUsd,
        tokens,
        error: null,
      };
    } catch (err) {
      const msg = String(err);
      errors.push(`${describeRpcEndpoint(rpcUrl)}: ${msg}`);
    }
  }

  throw new Error(
    toWellFormedUnicode(errors.join(" | ")) || `${chain.name} RPC unavailable`,
  );
}

// ── Alchemy NFT fetching ──────────────────────────────────────────────

async function fetchAlchemyChainNfts(
  chain: EvmChainConfig,
  address: string,
  alchemyKey: string,
): Promise<{ chain: string; nfts: EvmNft[] }> {
  const res = await fetch(
    `https://${chain.subdomain}.g.alchemy.com/nft/v3/${alchemyKey}/getNFTsForOwner?owner=${address}&withMetadata=true&pageSize=50`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  const data = requireJsonRpcResult(
    await jsonOrThrow<
      {
        ownedNfts?: Array<{
          contract?: {
            address?: string;
            name?: string;
            openSeaMetadata?: { collectionName?: string };
          };
          tokenId?: string;
          name?: string;
          description?: string;
          image?: {
            cachedUrl?: string;
            thumbnailUrl?: string;
            originalUrl?: string;
          };
          tokenType?: string;
        }>;
      } & JsonRpcErrorEnvelope
    >(res),
    chain,
  );
  return {
    chain: chain.name,
    nfts: (data.ownedNfts ?? []).map((nft) => ({
      contractAddress: nft.contract?.address ?? "",
      tokenId: nft.tokenId ?? "",
      name: nft.name ?? "Untitled",
      description: toWellFormedUnicode(nft.description ?? ""),
      imageUrl:
        nft.image?.cachedUrl ??
        nft.image?.thumbnailUrl ??
        nft.image?.originalUrl ??
        "",
      collectionName:
        nft.contract?.openSeaMetadata?.collectionName ??
        nft.contract?.name ??
        "",
      tokenType: nft.tokenType ?? "ERC721",
    })),
  };
}

// ── Ankr NFT fetching ─────────────────────────────────────────────────

async function fetchAnkrChainNfts(
  chain: EvmChainConfig,
  address: string,
  ankrKey: string,
): Promise<{ chain: string; nfts: EvmNft[] }> {
  const res = await fetch(
    `https://rpc.ankr.com/multichain/${ankrKey}`,
    rpcJsonRequest(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "ankr_getNFTsByOwner",
        params: {
          walletAddress: address,
          blockchain: [chain.ankrChain ?? "bsc"],
          pageSize: 50,
        },
      }),
    ),
  );
  const data = requireJsonRpcResult(
    await jsonOrThrow<
      { result?: { assets?: AnkrNftAsset[] } } & JsonRpcErrorEnvelope
    >(res),
    chain,
  );
  return {
    chain: chain.name,
    nfts: (data.result?.assets ?? []).map((nft) => ({
      contractAddress: nft.contractAddress ?? "",
      tokenId: String(nft.tokenId ?? ""),
      name: nft.name ?? "Untitled",
      description: toWellFormedUnicode(nft.description ?? ""),
      imageUrl:
        nft.imageUrl ?? nft.imagePreviewUrl ?? nft.imageOriginalUrl ?? "",
      collectionName: nft.collectionName ?? nft.contractName ?? "",
      tokenType: nft.tokenType ?? "ERC721",
    })),
  };
}

// ── Public API ────────────────────────────────────────────────────────

export async function fetchEvmBalances(
  address: string,
  alchemyOrKeys: string | EvmProviderKeys | null | undefined,
  maybeAnkrKey?: string | null,
  knownTokenAddresses?: string[],
): Promise<EvmChainBalance[]> {
  const keys = resolveEvmProviderKeys(alchemyOrKeys, maybeAnkrKey);
  const bscRpcUrls = keys.bscRpcUrls;
  const ethRpcUrls = keys.ethereumRpcUrls;
  const baseRpcUrls = keys.baseRpcUrls;
  const avaxRpcUrls = keys.avaxRpcUrls;

  const hasManagedBscRpc = bscRpcUrls.length > 0;
  const activeChains = DEFAULT_EVM_CHAINS.filter((chain) => {
    if (chain.provider === "ankr") {
      return Boolean(keys.ankrKey) || (isBscChain(chain) && hasManagedBscRpc);
    }

    // Prefer Alchemy when available (tokens + USD value). Otherwise, fall back to
    // public RPC for native balances on the chains we support out-of-box.
    if (keys.alchemyKey) return true;
    if (chain.chainId === 1) return ethRpcUrls.length > 0;
    if (chain.chainId === 8453) return baseRpcUrls.length > 0;
    if (chain.chainId === 56) return hasManagedBscRpc;
    if (chain.chainId === 43114) return avaxRpcUrls.length > 0;
    return false;
  });

  return Promise.all(
    activeChains.map(async (chain): Promise<EvmChainBalance> => {
      try {
        if (chain.provider === "ankr") {
          if (keys.ankrKey) {
            return await fetchAnkrChainBalances(chain, address, keys.ankrKey);
          }
          if (isBscChain(chain) && hasManagedBscRpc) {
            return await fetchEvmChainBalancesViaRpc(
              chain,
              address,
              bscRpcUrls,
              knownTokenAddresses,
            );
          }
          return makeEvmChainFailure(chain, "Missing ANKR_API_KEY");
        }
        if (!keys.alchemyKey) {
          if (chain.chainId === 1 && ethRpcUrls.length > 0) {
            return await fetchEvmChainBalancesViaRpc(
              chain,
              address,
              ethRpcUrls,
              knownTokenAddresses,
            );
          }
          if (chain.chainId === 8453 && baseRpcUrls.length > 0) {
            return await fetchEvmChainBalancesViaRpc(
              chain,
              address,
              baseRpcUrls,
              knownTokenAddresses,
            );
          }
          if (chain.chainId === 56 && hasManagedBscRpc) {
            return await fetchEvmChainBalancesViaRpc(
              chain,
              address,
              bscRpcUrls,
              knownTokenAddresses,
            );
          }
          if (chain.chainId === 43114 && avaxRpcUrls.length > 0) {
            return await fetchEvmChainBalancesViaRpc(
              chain,
              address,
              avaxRpcUrls,
              knownTokenAddresses,
            );
          }
          return makeEvmChainFailure(chain, "Missing ALCHEMY_API_KEY");
        }
        return await fetchAlchemyChainBalances(chain, address, keys.alchemyKey);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`EVM balance fetch failed for ${chain.name}: ${msg}`);
        return makeEvmChainFailure(chain, msg);
      }
    }),
  );
}

export async function fetchEvmNfts(
  address: string,
  alchemyOrKeys: string | EvmProviderKeys | null | undefined,
  maybeAnkrKey?: string | null,
): Promise<Array<{ chain: string; nfts: EvmNft[] }>> {
  const keys = resolveEvmProviderKeys(alchemyOrKeys, maybeAnkrKey);
  const hasManagedBscRpc = keys.bscRpcUrls.length > 0;
  const activeChains = DEFAULT_EVM_CHAINS.filter((chain) => {
    if (chain.provider === "ankr") {
      return (isBscChain(chain) && hasManagedBscRpc) || Boolean(keys.ankrKey);
    }
    if (keys.alchemyKey) return true;
    // BSC without Alchemy: include if managed RPC exists (NFTs will be empty)
    if (chain.chainId === 56) return hasManagedBscRpc;
    return false;
  });

  return Promise.all(
    activeChains.map(
      async (chain): Promise<{ chain: string; nfts: EvmNft[] }> => {
        try {
          if (chain.provider === "ankr") {
            if (!keys.ankrKey) {
              // Managed NodeReal/QuickNode mode currently provides native-balance
              // readiness only; token/NFT indexing is added in later phases.
              return { chain: chain.name, nfts: [] };
            }
            return await fetchAnkrChainNfts(chain, address, keys.ankrKey);
          }
          if (!keys.alchemyKey) return { chain: chain.name, nfts: [] };
          return await fetchAlchemyChainNfts(chain, address, keys.alchemyKey);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`EVM NFT fetch failed for ${chain.name}: ${msg}`);
          return { chain: chain.name, nfts: [] };
        }
      },
    ),
  );
}
