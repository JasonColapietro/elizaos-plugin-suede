import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { ContentType } from "@elizaos/core";
import { randomUUID } from "node:crypto";
import { SuedeClient } from "../x402-client.js";

function settingAsString(value: string | boolean | number | null): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export const generateMusicAction: Action = {
  name: "GENERATE_MUSIC_SUEDE",
  similes: [
    "MAKE_MUSIC",
    "CREATE_SONG",
    "COMPOSE_TRACK",
    "GENERATE_TRACK",
    "GENERATE_BACKGROUND_MUSIC",
  ],
  description:
    "Generate an original music track via Suede AI. Pays 0.50 USDC on Base per call via x402.",
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Make me a 30-second ambient lofi beat with vinyl crackle" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Generating your track via Suede AI — paying 0.50 USDC on Base...",
          action: "GENERATE_MUSIC_SUEDE",
        },
      },
    ],
  ] as ActionExample[][],
  validate: async (runtime: IAgentRuntime) => {
    const key = settingAsString(runtime.getSetting("SUEDE_WALLET_PRIVATE_KEY"));
    return typeof key === "string" && key.startsWith("0x");
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const privateKey = settingAsString(runtime.getSetting("SUEDE_WALLET_PRIVATE_KEY"));
    const serviceUrl =
      settingAsString(runtime.getSetting("SUEDE_SERVICE_URL")) ?? "https://app.suedeai.ai";
    const network =
      settingAsString(runtime.getSetting("SUEDE_NETWORK")) ?? "base-mainnet";

    if (!privateKey || !privateKey.startsWith("0x")) {
      throw new Error("SUEDE_WALLET_PRIVATE_KEY env not configured (must be 0x-prefixed hex).");
    }

    const client = new SuedeClient({
      privateKey: privateKey as `0x${string}`,
      serviceUrl,
      network: network as "base-mainnet" | "base-sepolia",
    });

    const prompt = (message.content as { text?: string })?.text ?? "ambient electronic";
    const result = await client.generateMusic({ prompt, durationSeconds: 30 });
    const assetUrl = (result as { assetUrl?: string })?.assetUrl;

    if (callback) {
      callback({
        text: `Generated via Suede AI — music, paid 0.50 USDC on Base. ${
          assetUrl ?? ""
        }`.trim(),
        action: "GENERATE_MUSIC_SUEDE",
        attachments: assetUrl
          ? [
              {
                id: randomUUID(),
                url: assetUrl,
                contentType: ContentType.AUDIO,
                title: "Suede AI music",
                source: "suede",
              },
            ]
          : undefined,
      });
    }

    return {
      success: true,
      text: assetUrl ? `Music ready: ${assetUrl}` : "Music generated",
      data: { assetUrl, provenance: (result as { provenance?: unknown })?.provenance },
    };
  },
};
