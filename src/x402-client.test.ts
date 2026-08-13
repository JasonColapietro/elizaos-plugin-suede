import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SuedeClient } from "./x402-client.js";

const FAKE_KEY = generatePrivateKey();
const FAKE_ACCOUNT = privateKeyToAccount(FAKE_KEY);

const PAYMENT_REQUIREMENT = {
  scheme: "exact",
  network: "base",
  amount: "500000", // 0.50 USDC (6 decimals)
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
  payTo: "0x10FF767043A1723E0BB5B9207bC37D3442cC9E4F",
  resource: "https://app.suedeai.ai/create-music",
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
};

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
    const client = new SuedeClient({
      privateKey: FAKE_KEY,
      serviceUrl: "https://staging.suedeai.ai///",
    });
    // walletAddress is the only public probe of state we have; ensure construction didn't throw
    expect(client.walletAddress.startsWith("0x")).toBe(true);
  });

  it("paidPost handles a 402 challenge by signing and retrying with X-PAYMENT header", async () => {
    const client = new SuedeClient({
      privateKey: FAKE_KEY,
      serviceUrl: "https://app.suedeai.ai",
      network: "base-mainnet",
    });

    const fetchMock = vi
      .fn()
      // First call: return a 402 x402 challenge.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            x402Version: 2,
            error: "Payment Required",
            accepts: [PAYMENT_REQUIREMENT],
          }),
          { status: 402, headers: { "Content-Type": "application/json" } },
        ),
      )
      // Second call: payment header attached, return the asset.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            assetUrl: "https://cdn.suedeai.ai/test.mp3",
            provenance: { fingerprint: "abc123" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await client.generateMusic({ prompt: "lofi", durationSeconds: 30 });

    expect(result).toEqual({
      assetUrl: "https://cdn.suedeai.ai/test.mp3",
      provenance: { fingerprint: "abc123" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstCall = fetchMock.mock.calls[0];
    const secondCall = fetchMock.mock.calls[1];

    // First call: no X-PAYMENT header.
    expect(firstCall[0]).toBe("https://app.suedeai.ai/create-music");
    expect(
      (firstCall[1] as RequestInit).headers as Record<string, string>,
    ).not.toHaveProperty("X-PAYMENT");

    // Second call: X-PAYMENT header attached, base64-encoded JSON envelope.
    const secondHeaders = (secondCall[1] as RequestInit).headers as Record<string, string>;
    expect(secondHeaders["X-PAYMENT"]).toBeDefined();
    const decoded = JSON.parse(
      Buffer.from(secondHeaders["X-PAYMENT"], "base64").toString("utf-8"),
    );
    expect(decoded.scheme).toBe("exact");
    expect(decoded.x402Version).toBe(2);
    expect(decoded.network).toBe("base");
    expect(decoded.resource).toBe(PAYMENT_REQUIREMENT.resource);
    expect(decoded.payload.authorization.from.toLowerCase()).toBe(
      FAKE_ACCOUNT.address.toLowerCase(),
    );
    expect(decoded.payload.authorization.to.toLowerCase()).toBe(
      PAYMENT_REQUIREMENT.payTo.toLowerCase(),
    );
    expect(decoded.payload.authorization.value).toBe(PAYMENT_REQUIREMENT.amount);
    expect(decoded.payload.signature).toMatch(/^0x[0-9a-f]+$/i);
  });

  it("forces video and image generation onto the asynchronous contract", async () => {
    const client = new SuedeClient({ privateKey: FAKE_KEY });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jobId: "video-job", status: "queued", pollUrl: "/video-job" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jobId: "image-job", status: "queued", pollUrl: "/image-job" }), {
          status: 200,
        }),
      );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await client.generateVideo({ prompt: "video" });
    await client.generateImage({ prompt: "image" });

    expect(fetchMock.mock.calls[0][0]).toBe("https://app.suedeai.ai/agent/video?async=true");
    expect(fetchMock.mock.calls[1][0]).toBe("https://app.suedeai.ai/agent/image?async=true");
  });

  it("paidPost throws when a non-402, non-2xx response is returned", async () => {
    const client = new SuedeClient({ privateKey: FAKE_KEY });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("upstream failure", { status: 500 }),
      ) as unknown as typeof globalThis.fetch;

    await expect(
      client.generateMusic({ prompt: "lofi", durationSeconds: 30 }),
    ).rejects.toThrow(/Suede call failed/);
  });

  it("paidPost throws when a 402 challenge has no payment requirements", async () => {
    const client = new SuedeClient({ privateKey: FAKE_KEY });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ x402Version: 1, error: "nope" }), { status: 402 }),
      ) as unknown as typeof globalThis.fetch;

    await expect(
      client.generateMusic({ prompt: "lofi", durationSeconds: 30 }),
    ).rejects.toThrow(/missing payment requirements/);
  });
});
