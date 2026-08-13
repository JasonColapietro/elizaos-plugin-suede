import {
  createWalletClient,
  http,
  type Account,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

export interface SuedeClientConfig {
  serviceUrl?: string;
  privateKey: Hex;
  network?: "base-mainnet" | "base-sepolia";
  rpcUrl?: string;
}

interface PaymentRequirement {
  scheme: string;
  network: string;
  amount: string;
  asset: Hex;
  payTo: Hex;
  maxTimeoutSeconds?: number;
  resource?: string;
  extra?: {
    name?: string;
    version?: string;
  };
}

interface X402Challenge {
  x402Version?: number;
  error?: string;
  accepts?: PaymentRequirement[];
}

export interface MediaJobResult {
  assetUrl?: string;
  imageUrl?: string;
  videoUrl?: string;
  jobId?: string;
  pollUrl?: string;
  status?: string;
  provenance?: unknown;
}

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64");
}

function randomNonce(): Hex {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return `0x${Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

function resolveChain(network: string) {
  if (network === "base" || network === "eip155:8453" || network === "base-mainnet") return base;
  if (network === "eip155:84532" || network === "base-sepolia") return baseSepolia;
  throw new Error(`Unsupported x402 network: ${network}`);
}

/**
 * Sign an EIP-3009 transferWithAuthorization message for the given x402 challenge.
 * Returns the X-PAYMENT header value (base64-encoded JSON) per the x402 spec.
 */
async function signPaymentHeader(
  account: Account,
  walletClient: WalletClient,
  requirement: PaymentRequirement,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const validAfter = BigInt(now - 60);
  const validBefore = BigInt(now + (requirement.maxTimeoutSeconds ?? 300));
  const nonce = randomNonce();

  const chain = resolveChain(requirement.network);

  const signature = await walletClient.signTypedData({
    account,
    domain: {
      name: requirement.extra?.name ?? "USD Coin",
      version: requirement.extra?.version ?? "2",
      chainId: chain.id,
      verifyingContract: requirement.asset,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: account.address,
      to: requirement.payTo,
      value: BigInt(requirement.amount),
      validAfter,
      validBefore,
      nonce,
    },
  });

  return encodeBase64Json({
    x402Version: 2,
    scheme: requirement.scheme,
    network: requirement.network,
    ...(requirement.resource ? { resource: requirement.resource } : {}),
    payload: {
      authorization: {
        from: account.address,
        to: requirement.payTo,
        value: requirement.amount,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
      signature,
    },
  });
}

export class SuedeClient {
  private readonly serviceUrl: string;
  private readonly account: Account;
  private readonly walletClient: WalletClient;

  constructor(config: SuedeClientConfig) {
    this.serviceUrl = (config.serviceUrl ?? "https://app.suedeai.ai").replace(/\/+$/, "");
    this.account = privateKeyToAccount(config.privateKey);
    const chain = config.network === "base-sepolia" ? baseSepolia : base;
    this.walletClient = createWalletClient({
      account: this.account,
      chain,
      transport: http(config.rpcUrl),
    });
  }

  get walletAddress(): Hex {
    return this.account.address;
  }

  /**
   * Call any priced Suede endpoint with automatic x402 settlement.
   */
  async paidPost<T = unknown>(path: string, body: unknown): Promise<T> {
    const url = `${this.serviceUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };

    const challengeRes = await fetch(url, init);
    if (challengeRes.status === 200) {
      return (await challengeRes.json()) as T;
    }
    if (challengeRes.status !== 402) {
      throw new Error(`Suede call failed (status ${challengeRes.status}): ${await challengeRes.text()}`);
    }

    const challenge = (await challengeRes.json()) as X402Challenge;
    const requirement = challenge.accepts?.[0];
    if (!requirement) {
      throw new Error("x402 challenge missing payment requirements");
    }

    const paymentHeader = await signPaymentHeader(this.account, this.walletClient, requirement);

    const paidRes = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        "X-PAYMENT": paymentHeader,
      },
    });
    if (!paidRes.ok) {
      throw new Error(`Suede paid call failed (status ${paidRes.status}): ${await paidRes.text()}`);
    }
    return (await paidRes.json()) as T;
  }

  generateMusic(opts: { prompt: string; durationSeconds?: number }) {
    return this.paidPost<{ assetUrl: string; provenance: unknown }>("/create-music", opts);
  }

  generateVideo(opts: { prompt: string; durationSeconds?: number }) {
    return this.paidPost<MediaJobResult>("/agent/video?async=true", opts);
  }

  generateImage(opts: { prompt: string; aspectRatio?: string; outputFormat?: "png" | "jpeg" }) {
    return this.paidPost<MediaJobResult>("/agent/image?async=true", opts);
  }
}
