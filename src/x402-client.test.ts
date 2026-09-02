import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SuedeClient, SuedeRenderTimeoutError, selectRequirement } from "./x402-client.js";

// Fixtures mirror the published contract at
// https://github.com/JasonColapietro/suede-x402 (index.md), not a remembered shape.

const FAKE_KEY = generatePrivateKey();
const FAKE_ACCOUNT = privateKeyToAccount(FAKE_KEY);
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x10FF767043A1723E0BB5B9207bC37D3442cC9E4F";
const SONG_ID = "0f5c9e2a-1d33-4c77-9a10-2b8e6d4f1c05";
const SONG_POLL = `https://app.suedeai.ai/api/songs/${SONG_ID}`;
const SHARE_URL = "https://app.suedeai.ai/share/example-track";

function accept(network: string, amount: string, priceUsd: string, resource: string) {
  return {
    scheme: "exact",
    network,
    maxAmountRequired: amount,
    amount,
    asset: USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    docs: "https://app.suedeai.ai/developers",
    extra: { name: "USD Coin", version: "2", decimals: 6, priceUsd },
    resource,
    mimeType: "application/json",
  };
}

function challenge(resourceUrl: string, amount: string, priceUsd: string) {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: resourceUrl,
      description: "Paid media generation for agents.",
      mimeType: "application/json",
      serviceName: "Suede AI",
    },
    accepts: [
      accept("base", amount, priceUsd, resourceUrl),
      accept("eip155:8453", amount, priceUsd, resourceUrl),
    ],
    extensions: { skyfire: { header: "PAYMENT-SIGNATURE", tokenTypes: ["pay+jwt"] } },
  };
}

const MUSIC_CHALLENGE = challenge("https://app.suedeai.ai/create-music", "500000", "$0.50");
const VIDEO_CHALLENGE = challenge("https://app.suedeai.ai/agent/video", "4990000", "$4.99");
const IMAGE_CHALLENGE = challenge("https://app.suedeai.ai/agent/image", "150000", "$0.15");
const MUSIC_ENVELOPE = { status: "processing", shareUrl: SHARE_URL, songId: SONG_ID, pollUrl: SONG_POLL };
const PENDING_ROW = { id: SONG_ID, model_version: "pending", audio_url: "https://app.suedeai.ai/placeholder.png" };
const FINISHED_ROW = { id: SONG_ID, model_version: "v4.5", audio_url: "https://cdn.suedeai.ai/audio/song.mp3" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function installFetch(route: (call: Call, index: number) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return route(call, calls.length - 1);
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

const noSleep = async (): Promise<void> => {};

function makeClient(extra: Partial<ConstructorParameters<typeof SuedeClient>[0]> = {}): SuedeClient {
  return new SuedeClient({
    privateKey: FAKE_KEY,
    serviceUrl: "https://app.suedeai.ai",
    network: "base-mainnet",
    pollIntervalMs: 1,
    sleep: noSleep,
    ...extra,
  });
}

function decode(header: string): Record<string, any> {
  return JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
}

describe("SuedeClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("constructor accepts a hex private key and exposes the derived wallet address", () => {
    const client = new SuedeClient({ privateKey: FAKE_KEY });
    expect(client.walletAddress.toLowerCase()).toBe(FAKE_ACCOUNT.address.toLowerCase());
  });

  it("constructor respects custom serviceUrl and strips trailing slashes", () => {
    const client = new SuedeClient({ privateKey: FAKE_KEY, serviceUrl: "https://staging.suedeai.ai///" });
    expect(client.walletAddress.startsWith("0x")).toBe(true);
  });

  it("music: pays with PAYMENT-SIGNATURE (v2 payload), then follows pollUrl until model_version leaves pending", async () => {
    const calls = installFetch((call, i) => {
      if (i === 0) return json(MUSIC_CHALLENGE, 402);
      if (i === 1) return json(MUSIC_ENVELOPE, 202);
      if (i === 2) return json(PENDING_ROW);
      return json(FINISHED_ROW);
    });

    const result = await makeClient().generateMusic({ prompt: "lofi", durationSeconds: 30 });

    expect(result).toMatchObject({
      status: "completed",
      songId: SONG_ID,
      shareUrl: SHARE_URL,
      pollUrl: SONG_POLL,
      audioUrl: FINISHED_ROW.audio_url,
      assetUrl: FINISHED_ROW.audio_url,
      modelVersion: "v4.5",
    });
    expect(result.raw).toEqual(FINISHED_ROW);
    expect(calls).toHaveLength(4);

    // Unpaid challenge request: idempotency key, no payment header, documented body only.
    expect(calls[0].url).toBe("https://app.suedeai.ai/create-music");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ prompt: "lofi" });
    expect(calls[0].headers["X-Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0].headers).not.toHaveProperty("PAYMENT-SIGNATURE");
    expect(calls[0].headers).not.toHaveProperty("X-PAYMENT");

    // Paid replay: same key, canonical header, v2 payload echoing the CAIP-2 requirement.
    expect(calls[1].headers["X-Idempotency-Key"]).toBe(calls[0].headers["X-Idempotency-Key"]);
    expect(calls[1].headers).not.toHaveProperty("X-PAYMENT");
    const payload = decode(calls[1].headers["PAYMENT-SIGNATURE"]);
    expect(Object.keys(payload).sort()).toEqual(
      ["accepted", "extensions", "payload", "resource", "x402Version"].sort(),
    );
    expect(payload.x402Version).toBe(2);
    expect(payload.resource).toEqual(MUSIC_CHALLENGE.resource);
    expect(payload.extensions).toEqual(MUSIC_CHALLENGE.extensions);
    expect(payload.accepted).toEqual({
      scheme: "exact",
      network: "eip155:8453",
      amount: "500000",
      asset: USDC,
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2", decimals: 6, priceUsd: "$0.50" },
    });
    expect(payload.payload.authorization.from.toLowerCase()).toBe(FAKE_ACCOUNT.address.toLowerCase());
    expect(payload.payload.authorization.to.toLowerCase()).toBe(PAY_TO.toLowerCase());
    expect(payload.payload.authorization.value).toBe("500000");
    expect(payload.payload.signature).toMatch(/^0x[0-9a-f]{130}$/i);

    // Polls are free GETs against the exact pollUrl.
    for (const poll of calls.slice(2)) {
      expect(poll.method).toBe("GET");
      expect(poll.url).toBe(SONG_POLL);
      expect(poll.headers).not.toHaveProperty("PAYMENT-SIGNATURE");
      expect(poll.headers).not.toHaveProperty("X-Idempotency-Key");
    }
  });

  it("music: sends only the documented request fields and reads a blocking result", async () => {
    const calls = installFetch(() => json({ shareUrl: SHARE_URL }));

    const result = await makeClient().generateMusic({
      prompt: "desert rock",
      style: "baritone vocal",
      lyrics: "wind and thunder",
      customMode: true,
      makeInstrumental: false,
      vocalGender: "m",
      tags: "rock",
      durationSeconds: 30,
    });

    expect(calls[0].body).toEqual({
      prompt: "desert rock",
      style: "baritone vocal",
      lyrics: "wind and thunder",
      custom_mode: true,
      make_instrumental: false,
      vocal_gender: "m",
      tags: "rock",
    });
    expect(result.status).toBe("completed");
    expect(result.shareUrl).toBe(SHARE_URL);
    expect(result.audioUrl).toBeUndefined();
  });

  it("music: wait:false returns the queued envelope without polling", async () => {
    const calls = installFetch((_call, i) => (i === 0 ? json(MUSIC_CHALLENGE, 402) : json(MUSIC_ENVELOPE, 202)));

    const result = await makeClient().generateMusic({ prompt: "lofi", wait: false });

    expect(result).toMatchObject({ status: "processing", songId: SONG_ID, pollUrl: SONG_POLL, shareUrl: SHARE_URL });
    expect(result.audioUrl).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("music: a failed render is reported as status failed, not thrown", async () => {
    installFetch((_call, i) => {
      if (i === 0) return json(MUSIC_CHALLENGE, 402);
      if (i === 1) return json(MUSIC_ENVELOPE, 202);
      return json({ ...PENDING_ROW, model_version: "failed" });
    });

    const result = await makeClient().generateMusic({ prompt: "lofi" });

    expect(result.status).toBe("failed");
    expect(result.modelVersion).toBe("failed");
    expect(result.audioUrl).toBeUndefined();
    expect(result.assetUrl).toBeUndefined();
  });

  it("music: reuses a caller-supplied idempotency key on both requests", async () => {
    const calls = installFetch((_call, i) => (i === 0 ? json(MUSIC_CHALLENGE, 402) : json(MUSIC_ENVELOPE, 202)));

    await makeClient().generateMusic({ prompt: "lofi", wait: false, idempotencyKey: "purchase-42" });

    expect(calls[0].headers["X-Idempotency-Key"]).toBe("purchase-42");
    expect(calls[1].headers["X-Idempotency-Key"]).toBe("purchase-42");
  });

  it("reads the challenge from the PAYMENT-REQUIRED header before the body", async () => {
    const encoded = Buffer.from(JSON.stringify(MUSIC_CHALLENGE), "utf-8").toString("base64");
    const calls = installFetch((_call, i) =>
      i === 0 ? json({ error: "unusable body" }, 402, { "PAYMENT-REQUIRED": encoded }) : json(MUSIC_ENVELOPE, 202),
    );

    const result = await makeClient().generateMusic({ prompt: "lofi", wait: false });

    expect(result.status).toBe("processing");
    expect(decode(calls[1].headers["PAYMENT-SIGNATURE"]).accepted.amount).toBe("500000");
  });

  it("answers a legacy v1 challenge with X-PAYMENT and a v1 payload", async () => {
    const calls = installFetch((_call, i) =>
      i === 0
        ? json(
            {
              x402Version: 1,
              accepts: [
                {
                  scheme: "exact",
                  network: "base",
                  maxAmountRequired: "500000",
                  asset: USDC,
                  payTo: PAY_TO,
                  resource: "https://app.suedeai.ai/create-music",
                },
              ],
            },
            402,
          )
        : json({ shareUrl: SHARE_URL }),
    );

    await makeClient().generateMusic({ prompt: "lofi" });

    expect(calls[1].headers).not.toHaveProperty("PAYMENT-SIGNATURE");
    const payload = decode(calls[1].headers["X-PAYMENT"]);
    expect(payload.x402Version).toBe(1);
    expect(payload.scheme).toBe("exact");
    expect(payload.network).toBe("base");
    expect(payload.resource).toBe("https://app.suedeai.ai/create-music");
    expect(payload.payload.authorization.value).toBe("500000");
  });

  it("video: forces the async contract, pays, and polls the job to completion (8-second default)", async () => {
    const pollUrl = "https://app.suedeai.ai/agent/video/video-job-example";
    const calls = installFetch((_call, i) => {
      if (i === 0) return json(VIDEO_CHALLENGE, 402);
      if (i === 1) return json({ jobId: "video-job-example", status: "queued", provider: "suede", pollUrl }, 202);
      if (i === 2) return json({ jobId: "video-job-example", status: "processing", provider: "suede", pollUrl: null, videoUrl: null });
      return json({ jobId: "video-job-example", status: "completed", provider: "suede", pollUrl: null, videoUrl: "https://cdn.suedeai.ai/video/clip.mp4" });
    });

    const result = await makeClient().generateVideo({ prompt: "rainy street, tyres hissing" });

    expect(calls[0].url).toBe("https://app.suedeai.ai/agent/video?async=true");
    expect(calls[0].body).toEqual({ prompt: "rainy street, tyres hissing", durationSeconds: 8 });
    expect(decode(calls[1].headers["PAYMENT-SIGNATURE"]).accepted.amount).toBe("4990000");
    expect(calls[2].url).toBe(pollUrl);
    expect(result).toMatchObject({
      status: "completed",
      jobId: "video-job-example",
      pollUrl,
      videoUrl: "https://cdn.suedeai.ai/video/clip.mp4",
      assetUrl: "https://cdn.suedeai.ai/video/clip.mp4",
    });
    expect(calls).toHaveLength(4);
  });

  it("image: polls the job to completion and exposes imageUrl", async () => {
    const pollUrl = "https://app.suedeai.ai/agent/image/image-job-example";
    const calls = installFetch((_call, i) => {
      if (i === 0) return json(IMAGE_CHALLENGE, 402);
      if (i === 1) return json({ jobId: "image-job-example", status: "queued", provider: "suede", pollUrl }, 202);
      return json({ jobId: "image-job-example", status: "completed", provider: "suede", pollUrl: null, imageUrl: "https://cdn.suedeai.ai/image/cover.png" });
    });

    const result = await makeClient().generateImage({ prompt: "neon cover", aspectRatio: "1:1", outputFormat: "png" });

    expect(calls[0].url).toBe("https://app.suedeai.ai/agent/image?async=true");
    expect(calls[0].body).toEqual({ prompt: "neon cover", aspectRatio: "1:1", outputFormat: "png" });
    expect(result.status).toBe("completed");
    expect(result.imageUrl).toBe("https://cdn.suedeai.ai/image/cover.png");
    expect(result.assetUrl).toBe("https://cdn.suedeai.ai/image/cover.png");
  });

  it("image: wait:false returns the queued envelope", async () => {
    const pollUrl = "https://app.suedeai.ai/agent/image/image-job-example";
    const calls = installFetch((_call, i) =>
      i === 0 ? json(IMAGE_CHALLENGE, 402) : json({ jobId: "image-job-example", status: "queued", provider: "suede", pollUrl }, 202),
    );

    const result = await makeClient().generateImage({ prompt: "neon cover", wait: false });

    expect(result).toMatchObject({ status: "queued", jobId: "image-job-example", pollUrl });
    expect(result.assetUrl).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("gives up waiting (never the purchase) with the poll URL when the render outlasts pollTimeoutMs", async () => {
    installFetch((_call, i) => {
      if (i === 0) return json(MUSIC_CHALLENGE, 402);
      if (i === 1) return json(MUSIC_ENVELOPE, 202);
      return json(PENDING_ROW);
    });

    const promise = makeClient({ pollTimeoutMs: 0 }).generateMusic({ prompt: "lofi" });

    await expect(promise).rejects.toBeInstanceOf(SuedeRenderTimeoutError);
    await promise.catch((error: SuedeRenderTimeoutError) => {
      expect(error.pollUrl).toBe(SONG_POLL);
      expect(error.lastStatus).toBe("pending");
    });
  });

  it("throws when a non-402, non-2xx response is returned", async () => {
    installFetch(() => new Response("upstream failure", { status: 500 }));
    await expect(makeClient().generateMusic({ prompt: "lofi" })).rejects.toThrow(/Suede call failed/);
  });

  it("throws when the 402 challenge has no usable payment requirement", async () => {
    installFetch(() => json({ x402Version: 2, error: "nope", accepts: [] }, 402));
    await expect(makeClient().generateMusic({ prompt: "lofi" })).rejects.toThrow(/missing payment requirements/);
  });
});

describe("selectRequirement", () => {
  it("prefers the CAIP-2 entry when the challenge carries both spellings", () => {
    expect(selectRequirement(MUSIC_CHALLENGE, "base-mainnet").network).toBe("eip155:8453");
  });

  it("accepts the `base` alias when it is the only entry", () => {
    const only = { ...MUSIC_CHALLENGE, accepts: [MUSIC_CHALLENGE.accepts[0]] };
    expect(selectRequirement(only, "base-mainnet").network).toBe("base");
  });

  it("rejects requirements for another asset or network", () => {
    const wrongAsset = { ...MUSIC_CHALLENGE.accepts[1], asset: "0x0000000000000000000000000000000000000001" as `0x${string}` };
    expect(() => selectRequirement({ x402Version: 2, accepts: [wrongAsset] }, "base-mainnet")).toThrow(/missing payment requirements/);
    expect(() => selectRequirement(MUSIC_CHALLENGE, "base-sepolia")).toThrow(/base-sepolia/);
  });
});
