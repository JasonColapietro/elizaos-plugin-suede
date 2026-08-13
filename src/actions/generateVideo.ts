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

export const generateVideoAction: Action = {
  name: "GENERATE_VIDEO_SUEDE",
  similes: ["MAKE_VIDEO", "CREATE_CLIP", "GENERATE_CLIP", "GENERATE_SHORT_VIDEO"],
  description:
    "Generate a short video clip via Suede AI. Pays 4.99 USDC on Base per call via x402.",
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Generate a 10-second cinematic clip of a rainy Tokyo street" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Generating your clip via Suede AI — paying 4.99 USDC on Base...",
          action: "GENERATE_VIDEO_SUEDE",
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

    const prompt = (message.content as { text?: string })?.text ?? "cinematic establishing shot";
    const result = await client.generateVideo({ prompt, durationSeconds: 10 });
    const assetUrl = result.assetUrl ?? result.videoUrl;
    const statusText = assetUrl
      ? `Video ready: ${assetUrl}`
      : `Video generation ${result.status ?? "started"}.${result.pollUrl ? ` Poll: ${result.pollUrl}` : ""}`;

    if (callback) {
      callback({
        text: `Generated via Suede AI — video clip, paid 4.99 USDC on Base. ${statusText}`,
        action: "GENERATE_VIDEO_SUEDE",
        attachments: assetUrl
          ? [
              {
                id: randomUUID(),
                url: assetUrl,
                contentType: ContentType.VIDEO,
                title: "Suede AI video",
                source: "suede",
              },
            ]
          : undefined,
      });
    }

    return {
      success: true,
      text: statusText,
      data: {
        assetUrl,
        videoUrl: result.videoUrl,
        jobId: result.jobId,
        status: result.status,
        pollUrl: result.pollUrl,
        provenance: result.provenance,
      },
    };
  },
};
