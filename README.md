# @suedeai/plugin-suede

> ElizaOS plugin for Suede AI **music, video, and image generation**, payable by autonomous agents over **x402 on Base**. No API keys. Wallet signature only.

`@suedeai/plugin-suede` wraps Suede AI's three public x402 offerings so an agent can pay USDC on Base per call without a service API key.

## Why use Suede inside ElizaOS

- **No signup, no API key.** Your agent has a wallet; that's the auth.
- **One action.** ElizaOS Action → 402 challenge → EIP-3009 signed authorization → settle → `202` job → poll → asset. Renders take minutes; the action waits for the finished asset by default.
- **Per-call pricing.** `$0.50 USDC` music, `$4.99 USDC` short video, `$0.15 USDC` image.

## Install

```bash
pnpm add @suedeai/plugin-suede
# or: npm install @suedeai/plugin-suede
```

## Configure

Set in your agent's environment (`.env` or character JSON `settings`):

```bash
SUEDE_WALLET_PRIVATE_KEY=0x...           # required; the wallet the agent pays from
SUEDE_SERVICE_URL=https://app.suedeai.ai # optional; default
SUEDE_NETWORK=base-mainnet               # optional; or base-sepolia for testing
```

Fund the wallet with USDC on Base before use.

## Use

Register in your ElizaOS character JSON:

```json
{
  "name": "Mira",
  "plugins": ["@suedeai/plugin-suede"],
  "settings": {
    "SUEDE_WALLET_PRIVATE_KEY": "0x..."
  }
}
```

The plugin exposes three actions: `GENERATE_MUSIC_SUEDE`, `GENERATE_VIDEO_SUEDE`, and `GENERATE_IMAGE_SUEDE`.

## Programmatic use

```ts
import { SuedeClient } from "@suedeai/plugin-suede";

const client = new SuedeClient({
  privateKey: process.env.SUEDE_WALLET_PRIVATE_KEY as `0x${string}`,
});

const track = await client.generateMusic({
  prompt: "ambient lofi beat with vinyl crackle",
});

console.log(track.status);   // "completed" | "failed"
console.log(track.audioUrl); // finished MP3 when completed (also exposed as assetUrl)

// Don't want to block? Take the poll URL and collect later — polling is free.
const queued = await client.generateMusic({ prompt: "ambient lofi", wait: false });
const row = await client.waitForSong(queued.pollUrl!);
```

Video and image work the same way: `generateVideo` / `generateImage` pay, then poll
`GET /agent/video/{jobId}` / `GET /agent/image/{jobId}` until `status` is `completed`
and return `videoUrl` / `imageUrl`.

## How payment works

1. The plugin POSTs to one of the three canonical offering routes with an `X-Idempotency-Key` (one per intended purchase, reused on the paid retry so a timeout can never buy a second render).
2. Suede returns `402 Payment Required` with an x402 v2 challenge — network `base` and `eip155:8453`, USDC on Base, recipient `0x10FF…9E4F`. The `PAYMENT-REQUIRED` header is read first, the JSON body second.
3. Plugin picks the `exact` USDC requirement (CAIP-2 entry preferred) and signs an EIP-3009 `TransferWithAuthorization` for the exact `amount`.
4. Plugin retries with `PAYMENT-SIGNATURE: <base64 x402 v2 payload>` (a legacy v1 challenge is answered with `X-PAYMENT`).
5. Suede's facilitator verifies + settles on-chain and answers `202 Accepted` with a `pollUrl`. The render is charged here.
6. Plugin polls that URL (free, unauthenticated) until the render finishes — `model_version` leaves `pending` for music, `status` is `completed` for video and image — and returns the asset URL.

The full contract is published at https://github.com/JasonColapietro/suede-x402.

No facilitator key needed on the agent side — Suede operates the facilitator path.

## Settings reference

| Key | Required | Default | Notes |
|---|---|---|---|
| `SUEDE_WALLET_PRIVATE_KEY` | yes | — | 0x-prefixed hex. Use a dedicated agent wallet, not a treasury wallet. |
| `SUEDE_SERVICE_URL` | no | `https://app.suedeai.ai` | Override for staging/preview deployments. |
| `SUEDE_NETWORK` | no | `base-mainnet` | Set to `base-sepolia` for testing without spending real USDC. |
| `SUEDE_POLL_INTERVAL_MS` | no | `5000` | Delay between polls of a queued render. |
| `SUEDE_POLL_TIMEOUT_MS` | no | `600000` | Give up *waiting* after this long. The purchase stands; the error carries the poll URL. |

## Security

`SUEDE_WALLET_PRIVATE_KEY` is a raw EVM private key. Any process that can read it
can spend every asset in that wallet — this plugin included. Treat it the way you
would treat the wallet itself.

**What this plugin does with the key.** It is passed to viem's
`privateKeyToAccount` in [`src/x402-client.ts`](src/x402-client.ts) and used for
exactly one thing: signing an EIP-3009 `TransferWithAuthorization` typed-data
message for the amount quoted in the server's 402 challenge. The signature — not
the key — travels in the `PAYMENT-SIGNATURE` header. The key is never written to disk,
never logged, and never sent over the network by this package.

**What that still authorizes.** Each call signs a transfer for whatever amount the
configured `SUEDE_SERVICE_URL` asks for. Pointing `SUEDE_SERVICE_URL` at a host you
do not trust means signing transfers that host chooses. The default
(`https://app.suedeai.ai`) is the only endpoint this plugin is tested against.

**Recommended handling.**

- Use a dedicated agent wallet funded with a working balance, never a treasury wallet.
- Start on `SUEDE_NETWORK=base-sepolia` to exercise the flow without real USDC.
- Keep the key in your process environment or secret manager, not in a committed
  character JSON.
- Audit settlement out of band from the agent wallet's USDC transfers on Base.

## Production checklist

- [ ] Wallet has USDC on the configured network
- [ ] Wallet is dedicated to the agent (limit blast radius)
- [ ] Daily spending caps enforced in ElizaOS character config
- [ ] Telemetry on `status`, `songId`/`jobId`, and `pollUrl` from each action result for audit

## License

MIT © Suede Labs · https://suedeai.ai

## Links

- Service: https://app.suedeai.ai
- x402 discovery: https://app.suedeai.ai/.well-known/x402.json
- Agent card: https://app.suedeai.ai/.well-known/agent-card.json
- IP Registry: https://ip.suedeai.ai
- X: https://x.com/AISUEDE
