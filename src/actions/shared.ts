import type { IAgentRuntime } from "@elizaos/core";
import { SuedeClient, type SuedeNetwork } from "../x402-client.js";

export function settingAsString(value: string | boolean | number | null): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function settingAsMillis(value: string | boolean | number | null): number | undefined {
  const parsed = typeof value === "number" ? value : Number(settingAsString(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function hasWalletKey(runtime: IAgentRuntime): boolean {
  const key = settingAsString(runtime.getSetting("SUEDE_WALLET_PRIVATE_KEY"));
  return typeof key === "string" && key.startsWith("0x");
}

/** Build a client from the agent's SUEDE_* settings. */
export function clientFromRuntime(runtime: IAgentRuntime): SuedeClient {
  const privateKey = settingAsString(runtime.getSetting("SUEDE_WALLET_PRIVATE_KEY"));
  if (!privateKey || !privateKey.startsWith("0x")) {
    throw new Error("SUEDE_WALLET_PRIVATE_KEY env not configured (must be 0x-prefixed hex).");
  }
  const serviceUrl =
    settingAsString(runtime.getSetting("SUEDE_SERVICE_URL")) ?? "https://app.suedeai.ai";
  const network = settingAsString(runtime.getSetting("SUEDE_NETWORK")) ?? "base-mainnet";
  return new SuedeClient({
    privateKey: privateKey as `0x${string}`,
    serviceUrl,
    network: network as SuedeNetwork,
    pollIntervalMs: settingAsMillis(runtime.getSetting("SUEDE_POLL_INTERVAL_MS")),
    pollTimeoutMs: settingAsMillis(runtime.getSetting("SUEDE_POLL_TIMEOUT_MS")),
  });
}

export function promptFrom(message: { content?: unknown }, fallback: string): string {
  const text = (message.content as { text?: unknown } | undefined)?.text;
  return typeof text === "string" && text.trim() ? text : fallback;
}
