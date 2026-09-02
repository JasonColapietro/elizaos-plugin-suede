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
import { clientFromRuntime, hasWalletKey, promptFrom } from "./shared.js";

export const generateImageAction: Action = {
  name: "GENERATE_IMAGE_SUEDE",
  similes: ["MAKE_IMAGE", "CREATE_IMAGE", "GENERATE_ART", "CREATE_COVER_ART"],
  description:
    "Generate a still image via Suede AI. Pays 0.15 USDC on Base per call via x402, then waits for the render.",
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Create square neon cover art for an ambient single" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Generating your image via Suede AI — paying 0.15 USDC on Base and waiting for the render...",
          action: "GENERATE_IMAGE_SUEDE",
        },
      },
    ],
  ] as ActionExample[][],
  validate: async (runtime: IAgentRuntime) => hasWalletKey(runtime),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = clientFromRuntime(runtime);
    const prompt = promptFrom(message, "square abstract cover art");
    const result = await client.generateImage({ prompt, aspectRatio: "1:1", outputFormat: "png" });
    const assetUrl = result.status === "completed" ? result.assetUrl : undefined;

    let text: string;
    if (assetUrl) {
      text = `Image ready: ${assetUrl}`;
    } else if (result.status === "failed") {
      text = `Image render failed${result.jobId ? ` (job ${result.jobId})` : ""}.`;
    } else {
      text = `Image ${result.status}${result.pollUrl ? `. Poll: ${result.pollUrl}` : "."}`;
    }

    if (callback) {
      callback({
        text: `Generated via Suede AI — image, paid 0.15 USDC on Base. ${text}`,
        action: "GENERATE_IMAGE_SUEDE",
        attachments: assetUrl
          ? [
              {
                id: randomUUID(),
                url: assetUrl,
                contentType: ContentType.IMAGE,
                title: "Suede AI image",
                source: "suede",
              },
            ]
          : undefined,
      });
    }

    return {
      success: result.status !== "failed",
      text,
      data: {
        status: result.status,
        jobId: result.jobId,
        pollUrl: result.pollUrl,
        imageUrl: assetUrl,
        assetUrl,
      },
    };
  },
};
