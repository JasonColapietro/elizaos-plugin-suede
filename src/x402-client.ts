import { randomBytes, randomUUID } from "node:crypto";
import {
  createWalletClient,
  http,
  type Account,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

/**
 * Suede x402 client.
 *
 * Speaks the published Suede x402 v2 contract
 * (https://github.com/JasonColapietro/suede-x402):
 *
 * - A paid `POST` answers `202 Accepted` with a `pollUrl`. The render is charged
 *   when the job is created; polling never costs a second payment. This client
 *   follows `pollUrl` until the render finishes unless `wait: false` is passed.
 * - The canonical payment header is `PAYMENT-SIGNATURE` carrying an x402 v2
 *   payload (`accepted` echoes the chosen requirement). A legacy v1 challenge
 *   (`x402Version` 1, `maxAmountRequired`) is still answered with `X-PAYMENT`.
 * - Every paid `POST` carries `X-Idempotency-Key`, one key per intended
 *   purchase, so a timed-out retry replays the original response instead of
 *   buying a second render.
 */

export type SuedeNetwork = "base-mainnet" | "base-sepolia";

export interface SuedeClientConfig {
  serviceUrl?: string;
  privateKey: Hex;
  network?: SuedeNetwork;
  rpcUrl?: string;
  /** Delay between polls of a queued render. Default 5000 ms. */
  pollIntervalMs?: number;
  /** Give up waiting (but never the purchase) after this long. Default 600000 ms. */
  pollTimeoutMs?: number;
  /** Test seam: replaces the timer used between polls. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PaymentRequirement {
  scheme: string;
  network: string;
  /** x402 v2 atomic amount. */
  amount?: string;
  /** Legacy x402 v1 atomic amount. */
  maxAmountRequired?: string;
  asset: Hex;
  payTo: Hex;
  maxTimeoutSeconds?: number;
  resource?: string;
  description?: string;
  mimeType?: string;
  extra?: {
    name?: string;
    version?: string;
    decimals?: number;
    priceUsd?: string;
  };
}

export interface X402Challenge {
  x402Version?: number;
  error?: string;
  resource?: unknown;
  accepts?: PaymentRequirement[];
  extensions?: unknown;
}

export interface PaidCallOptions {
  /**
   * One key per intended purchase, reused on every retry of that purchase.
   * Generated automatically when omitted.
   */
  idempotencyKey?: string;
}

export interface WaitOptions {
  /** Follow `pollUrl` until the render finishes. Default true. */
  wait?: boolean;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export type RenderStatus = "queued" | "processing" | "completed" | "failed";

export interface GenerateMusicOptions {
  prompt: string;
  style?: string;
  lyrics?: string;
  customMode?: boolean;
  makeInstrumental?: boolean;
  vocalGender?: "m" | "f";
  tags?: string;
  /** @deprecated Not part of the published /create-music schema; ignored. */
  durationSeconds?: number;
}

export interface GenerateVideoOptions {
  prompt: string;
  /** The product returns an 8-second clip. Default 8. */
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
}

export interface GenerateImageOptions {
  prompt: string;
  aspectRatio?: string;
  outputFormat?: "png" | "jpeg";
}

export interface MusicResult {
  status: RenderStatus;
  songId: string | null;
  shareUrl?: string;
  pollUrl?: string;
  /** Finished MP3 once `status` is "completed". */
  audioUrl?: string;
  /** Same as `audioUrl`; kept for callers written against 1.0. */
  assetUrl?: string;
  modelVersion?: string;
  /** Raw song row after polling, or the raw paid response otherwise. */
  raw: Record<string, unknown>;
}

export interface MediaJobResult {
  status: RenderStatus;
  jobId?: string;
  provider?: string;
  pollUrl?: string | null;
  videoUrl?: string | null;
  imageUrl?: string | null;
  /** `videoUrl` or `imageUrl` once `status` is "completed". */
  assetUrl?: string;
  /** Raw job envelope after polling, or the raw paid response otherwise. */
  raw: Record<string, unknown>;
}

export class SuedeRenderTimeoutError extends Error {
  constructor(
    readonly pollUrl: string,
    readonly lastStatus: string | undefined,
    timeoutMs: number,
  ) {
    super(
      `Suede render still ${lastStatus ?? "pending"} after ${timeoutMs} ms; ` +
        `the purchase settled, keep polling ${pollUrl}`,
    );
    this.name = "SuedeRenderTimeoutError";
  }
}

const USDC_BY_NETWORK: Record<SuedeNetwork, Hex> = {
  "base-mainnet": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

const CAIP2_BY_NETWORK: Record<SuedeNetwork, string> = {
  "base-mainnet": "eip155:8453",
  "base-sepolia": "eip155:84532",
};

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

type JsonObject = Record<string, unknown>;

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64");
}

function randomNonce(): Hex {
  return `0x${randomBytes(32).toString("hex")}` as Hex;
}

function networkMatches(configured: SuedeNetwork, advertised: string): boolean {
  return configured === "base-mainnet"
    ? advertised === "base" || advertised === "base-mainnet" || advertised === "eip155:8453"
    : advertised === "base-sepolia" || advertised === "eip155:84532";
}

function resolveChain(network: string) {
  if (network === "base" || network === "eip155:8453" || network === "base-mainnet") return base;
  if (network === "eip155:84532" || network === "base-sepolia") return baseSepolia;
  throw new Error(`Unsupported x402 network: ${network}`);
}

function amountOf(requirement: PaymentRequirement): string | undefined {
  return requirement.amount ?? requirement.maxAmountRequired;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Choose the requirement to pay: `exact` scheme, USDC on the configured network.
 * The live challenge advertises both `base` and `eip155:8453`; the CAIP-2 entry
 * is preferred when present, the alias is accepted when it is not.
 */
export function selectRequirement(
  challenge: X402Challenge,
  network: SuedeNetwork,
): PaymentRequirement {
  const usdc = USDC_BY_NETWORK[network].toLowerCase();
  const candidates = (challenge.accepts ?? []).filter(
    (entry) =>
      entry.scheme === "exact" &&
      typeof entry.network === "string" &&
      networkMatches(network, entry.network) &&
      typeof entry.asset === "string" &&
      entry.asset.toLowerCase() === usdc &&
      /^(0|[1-9][0-9]*)$/.test(amountOf(entry) ?? ""),
  );
  if (candidates.length === 0) {
    throw new Error(
      `x402 challenge missing payment requirements: no "exact" USDC requirement on ${network}`,
    );
  }
  return candidates.find((entry) => entry.network === CAIP2_BY_NETWORK[network]) ?? candidates[0];
}

/** Read the challenge from the `PAYMENT-REQUIRED` header first, then the JSON body. */
async function parseChallenge(response: Response): Promise<X402Challenge> {
  const encoded = response.headers.get("PAYMENT-REQUIRED");
  if (encoded) {
    try {
      const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
      if (isObject(decoded)) return decoded as X402Challenge;
    } catch {
      // fall through to the body
    }
  }
  const text = await response.text();
  try {
    const body = JSON.parse(text);
    if (isObject(body)) return body as X402Challenge;
  } catch {
    // handled below
  }
  throw new Error(`Suede returned 402 without a readable x402 challenge: ${text.slice(0, 200)}`);
}

/**
 * Sign an EIP-3009 transferWithAuthorization for the selected requirement and
 * return the payment header to replay with. v2 challenges get
 * `PAYMENT-SIGNATURE` + a v2 payload; v1 challenges get `X-PAYMENT` + a v1 payload.
 */
async function signPayment(
  account: Account,
  walletClient: WalletClient,
  challenge: X402Challenge,
  requirement: PaymentRequirement,
): Promise<{ headerName: string; headerValue: string }> {
  const amount = amountOf(requirement);
  if (!amount) throw new Error("x402 challenge missing atomic amount");

  const now = Math.floor(Date.now() / 1000);
  const validAfter = BigInt(now - 60);
  const validBefore = BigInt(now + (requirement.maxTimeoutSeconds ?? 300) + 60);
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
      value: BigInt(amount),
      validAfter,
      validBefore,
      nonce,
    },
  });

  const payload = {
    signature,
    authorization: {
      from: account.address,
      to: requirement.payTo,
      value: amount,
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    },
  };

  if (challenge.x402Version === 2) {
    const accepted: JsonObject = {
      scheme: requirement.scheme,
      network: requirement.network,
      amount,
      asset: requirement.asset,
      payTo: requirement.payTo,
      maxTimeoutSeconds: requirement.maxTimeoutSeconds ?? 300,
    };
    if (requirement.extra) accepted.extra = requirement.extra;
    return {
      headerName: "PAYMENT-SIGNATURE",
      headerValue: encodeBase64Json({
        x402Version: 2,
        ...(isObject(challenge.resource) ? { resource: challenge.resource } : {}),
        accepted,
        ...(isObject(challenge.extensions) ? { extensions: challenge.extensions } : {}),
        payload,
      }),
    };
  }

  return {
    headerName: "X-PAYMENT",
    headerValue: encodeBase64Json({
      x402Version: 1,
      scheme: requirement.scheme,
      network: requirement.network,
      ...(requirement.resource ? { resource: requirement.resource } : {}),
      payload,
    }),
  };
}

function normalizeStatus(value: unknown): RenderStatus {
  if (value === "completed" || value === "failed" || value === "processing") return value;
  return "queued";
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class SuedeClient {
  private readonly serviceUrl: string;
  private readonly account: Account;
  private readonly walletClient: WalletClient;
  private readonly network: SuedeNetwork;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: SuedeClientConfig) {
    this.serviceUrl = (config.serviceUrl ?? "https://app.suedeai.ai").replace(/\/+$/, "");
    this.account = privateKeyToAccount(config.privateKey);
    this.network = config.network ?? "base-mainnet";
    const chain = this.network === "base-sepolia" ? baseSepolia : base;
    this.walletClient = createWalletClient({
      account: this.account,
      chain,
      transport: http(config.rpcUrl),
    });
    this.pollIntervalMs = config.pollIntervalMs ?? 5_000;
    this.pollTimeoutMs = config.pollTimeoutMs ?? 600_000;
    this.sleep = config.sleep ?? defaultSleep;
  }

  get walletAddress(): Hex {
    return this.account.address;
  }

  /**
   * Call any priced Suede endpoint with automatic x402 settlement.
   * Returns the response body as-is: for a paid call that is normally the
   * `202` job envelope, not the finished asset.
   */
  async paidPost<T extends JsonObject = JsonObject>(
    path: string,
    body: unknown,
    options: PaidCallOptions = {},
  ): Promise<T> {
    const url = `${this.serviceUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const idempotencyKey = options.idempotencyKey ?? randomUUID();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Idempotency-Key": idempotencyKey,
    };
    const init: RequestInit = { method: "POST", body: JSON.stringify(body) };

    const challengeRes = await fetch(url, { ...init, headers });
    if (challengeRes.status !== 402) {
      if (!challengeRes.ok) {
        throw new Error(
          `Suede call failed (status ${challengeRes.status}): ${await challengeRes.text()}`,
        );
      }
      return (await challengeRes.json()) as T;
    }

    const challenge = await parseChallenge(challengeRes);
    const requirement = selectRequirement(challenge, this.network);
    const { headerName, headerValue } = await signPayment(
      this.account,
      this.walletClient,
      challenge,
      requirement,
    );

    const paidRes = await fetch(url, {
      ...init,
      headers: { ...headers, [headerName]: headerValue },
    });
    if (!paidRes.ok) {
      throw new Error(`Suede paid call failed (status ${paidRes.status}): ${await paidRes.text()}`);
    }
    return (await paidRes.json()) as T;
  }

  /** Poll `GET /api/songs/{songId}` until `model_version` leaves `pending`. Free. */
  async waitForSong(pollUrl: string, options: WaitOptions = {}): Promise<JsonObject> {
    return this.pollUntil(
      pollUrl,
      (row) => typeof row.model_version === "string" && row.model_version !== "pending",
      (row) => stringOrUndefined(row.model_version),
      options,
    );
  }

  /** Poll a video or image job until `status` is `completed` or `failed`. Free. */
  async waitForJob(pollUrl: string, options: WaitOptions = {}): Promise<JsonObject> {
    return this.pollUntil(
      pollUrl,
      (job) => job.status === "completed" || job.status === "failed",
      (job) => stringOrUndefined(job.status),
      options,
    );
  }

  private async pollUntil(
    pollUrl: string,
    isDone: (body: JsonObject) => boolean,
    statusOf: (body: JsonObject) => string | undefined,
    options: WaitOptions,
  ): Promise<JsonObject> {
    const url = new URL(pollUrl, `${this.serviceUrl}/`).toString();
    const interval = options.pollIntervalMs ?? this.pollIntervalMs;
    const timeout = options.pollTimeoutMs ?? this.pollTimeoutMs;
    const started = Date.now();
    for (;;) {
      const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
      if (!res.ok) {
        throw new Error(`Suede poll failed (status ${res.status}) for ${url}: ${await res.text()}`);
      }
      const body = (await res.json()) as JsonObject;
      if (isDone(body)) return body;
      if (Date.now() - started + interval >= timeout) {
        throw new SuedeRenderTimeoutError(url, statusOf(body), timeout);
      }
      await this.sleep(interval);
    }
  }

  /**
   * `POST /create-music` (0.50 USDC). Waits for the render by default and
   * returns the finished MP3 as `audioUrl`.
   */
  async generateMusic(
    opts: GenerateMusicOptions & WaitOptions & PaidCallOptions,
  ): Promise<MusicResult> {
    const body: JsonObject = { prompt: opts.prompt };
    if (opts.style !== undefined) body.style = opts.style;
    if (opts.lyrics !== undefined) body.lyrics = opts.lyrics;
    if (opts.customMode !== undefined) body.custom_mode = opts.customMode;
    if (opts.makeInstrumental !== undefined) body.make_instrumental = opts.makeInstrumental;
    if (opts.vocalGender !== undefined) body.vocal_gender = opts.vocalGender;
    if (opts.tags !== undefined) body.tags = opts.tags;

    const raw = await this.paidPost("/create-music", body, { idempotencyKey: opts.idempotencyKey });
    const pollUrl = stringOrUndefined(raw.pollUrl);
    const shareUrl = stringOrUndefined(raw.shareUrl);
    const songId =
      stringOrUndefined(raw.songId) ??
      (pollUrl ? pollUrl.replace(/\/+$/, "").split("/").pop() ?? null : null);

    if (!pollUrl) {
      // Blocking result (?async=false or an unpaid caller): the body is the track itself.
      const audioUrl = stringOrUndefined(raw.audio_url) ?? stringOrUndefined(raw.assetUrl);
      return {
        status: "completed",
        songId,
        shareUrl,
        audioUrl,
        assetUrl: audioUrl,
        modelVersion: stringOrUndefined(raw.model_version),
        raw,
      };
    }

    if (opts.wait === false) {
      return { status: "processing", songId, shareUrl, pollUrl, raw };
    }

    const row = await this.waitForSong(pollUrl, opts);
    const modelVersion = stringOrUndefined(row.model_version);
    const failed = modelVersion === "failed";
    const audioUrl = failed ? undefined : stringOrUndefined(row.audio_url);
    return {
      status: failed ? "failed" : "completed",
      songId,
      shareUrl: shareUrl ?? stringOrUndefined(row.share_url),
      pollUrl,
      audioUrl,
      assetUrl: audioUrl,
      modelVersion,
      raw: row,
    };
  }

  /** `POST /agent/video` (4.99 USDC). Waits by default; `videoUrl` is set on completion. */
  async generateVideo(
    opts: GenerateVideoOptions & WaitOptions & PaidCallOptions,
  ): Promise<MediaJobResult> {
    const body: JsonObject = { prompt: opts.prompt, durationSeconds: opts.durationSeconds ?? 8 };
    if (opts.aspectRatio !== undefined) body.aspectRatio = opts.aspectRatio;
    if (opts.resolution !== undefined) body.resolution = opts.resolution;
    const raw = await this.paidPost("/agent/video?async=true", body, {
      idempotencyKey: opts.idempotencyKey,
    });
    return this.finishJob(raw, "videoUrl", opts);
  }

  /** `POST /agent/image` (0.15 USDC). Waits by default; `imageUrl` is set on completion. */
  async generateImage(
    opts: GenerateImageOptions & WaitOptions & PaidCallOptions,
  ): Promise<MediaJobResult> {
    const body: JsonObject = { prompt: opts.prompt };
    if (opts.aspectRatio !== undefined) body.aspectRatio = opts.aspectRatio;
    if (opts.outputFormat !== undefined) body.outputFormat = opts.outputFormat;
    const raw = await this.paidPost("/agent/image?async=true", body, {
      idempotencyKey: opts.idempotencyKey,
    });
    return this.finishJob(raw, "imageUrl", opts);
  }

  private async finishJob(
    raw: JsonObject,
    assetField: "videoUrl" | "imageUrl",
    opts: WaitOptions,
  ): Promise<MediaJobResult> {
    const pollUrl = stringOrUndefined(raw.pollUrl);
    let job = raw;
    let status = normalizeStatus(raw.status);
    if (opts.wait !== false && pollUrl && status !== "completed" && status !== "failed") {
      job = await this.waitForJob(pollUrl, opts);
      status = normalizeStatus(job.status);
    }
    const assetUrl = status === "completed" ? stringOrUndefined(job[assetField]) : undefined;
    return {
      status,
      jobId: stringOrUndefined(job.jobId) ?? stringOrUndefined(raw.jobId),
      provider: stringOrUndefined(job.provider),
      pollUrl: pollUrl ?? null,
      videoUrl: assetField === "videoUrl" ? assetUrl ?? null : undefined,
      imageUrl: assetField === "imageUrl" ? assetUrl ?? null : undefined,
      assetUrl,
      raw: job,
    };
  }
}
