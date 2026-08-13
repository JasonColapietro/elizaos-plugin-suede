# @suedeai/plugin-suede

> ElizaOS plugin for Suede AI **music, video, and image generation**, payable by autonomous agents over **x402 on Base**. No API keys. Wallet signature only.

`@suedeai/plugin-suede` wraps Suede AI's three public x402 offerings so an agent can pay USDC on Base per call without a service API key.

## Why use Suede inside ElizaOS

- **No signup, no API key.** Your agent has a wallet; that's the auth.
- **One HTTP call.** ElizaOS Action → 402 challenge → EIP-3009 signed authorization → settle → asset. ~30 seconds end-to-end for music.
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
  durationSeconds: 30,
});

console.log(track.assetUrl);
```

## How payment works

1. The plugin POSTs to one of the three canonical offering routes.
2. Suede returns `402 Payment Required` with an x402 challenge — network `base` or `eip155:8453`, USDC on Base, recipient `0x10FF…9E4F`.
3. Plugin signs an EIP-3009 `TransferWithAuthorization` for the exact amount.
4. Plugin retries with `X-PAYMENT: <base64 signed authorization>`.
5. Coinbase x402 facilitator verifies + settles on-chain.
6. Suede returns the asset (URL + provenance metadata).

No facilitator key needed on the agent side — Suede operates the facilitator path.

## Settings reference

| Key | Required | Default | Notes |
|---|---|---|---|
| `SUEDE_WALLET_PRIVATE_KEY` | yes | — | 0x-prefixed hex. Use a dedicated agent wallet, not a treasury wallet. |
| `SUEDE_SERVICE_URL` | no | `https://app.suedeai.ai` | Override for staging/preview deployments. |
| `SUEDE_NETWORK` | no | `base-mainnet` | Set to `base-sepolia` for testing without spending real USDC. |

## Security

`SUEDE_WALLET_PRIVATE_KEY` is a raw EVM private key. Any process that can read it
can spend every asset in that wallet — this plugin included. Treat it the way you
would treat the wallet itself.

**What this plugin does with the key.** It is passed to viem's
`privateKeyToAccount` in [`src/x402-client.ts`](src/x402-client.ts) and used for
exactly one thing: signing an EIP-3009 `TransferWithAuthorization` typed-data
message for the amount quoted in the server's 402 challenge. The signature — not
the key — travels in the `X-PAYMENT` header. The key is never written to disk,
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
- Audit settlement out of band via the tx hashes returned in `X-PAYMENT-RESPONSE`.

## Production checklist

- [ ] Wallet has USDC on the configured network
- [ ] Wallet is dedicated to the agent (limit blast radius)
- [ ] Daily spending caps enforced in ElizaOS character config
- [ ] Telemetry on tx hashes from `X-PAYMENT-RESPONSE` for audit

## License

MIT © Suede Labs · https://suedeai.ai

## Links

- Service: https://app.suedeai.ai
- x402 discovery: https://app.suedeai.ai/.well-known/x402.json
- Agent card: https://app.suedeai.ai/.well-known/agent-card.json
- IP Registry: https://ip.suedeai.ai
- X: https://x.com/AISUEDE
