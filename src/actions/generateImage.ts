import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { SuedeClient } from "../x402-client.js";

function settingAsString(value: string | boolean | number | null): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export const generateImageAction: Action = {
  name: "GENERATE_IMAGE_SUEDE",
  similes: ["MAKE_IMAGE", "CREATE_IMAGE", "GENERATE_ART", "CREATE_COVER_ART"],
  description:
    "Generate a still image via Suede AI. Pays 0.15 USDC on Base per call via x402.",
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Create square neon cover art for an ambient single" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Generating your image via Suede AI — paying 0.15 USDC on Base...",
          action: "GENERATE_IMAGE_SUEDE",
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

    const prompt = (message.content as { text?: string })?.text ?? "square abstract cover art";
    const result = await client.generateImage({ prompt, aspectRatio: "1:1", outputFormat: "png" });
    const imageUrl = result.imageUrl;
    const statusText = imageUrl
      ? `Image ready: ${imageUrl}`
      : `Image generation started.${result.pollUrl ? ` Poll: ${result.pollUrl}` : ""}`;

    if (callback) {
      callback({
        text: `Generated via Suede AI — image, paid 0.15 USDC on Base. ${statusText}`,
        action: "GENERATE_IMAGE_SUEDE",
      });
    }

    return {
      success: true,
      text: statusText,
      data: {
        imageUrl,
        pollUrl: result.pollUrl,
        jobId: result.jobId,
        status: result.status,
      },
    };
  },
};
