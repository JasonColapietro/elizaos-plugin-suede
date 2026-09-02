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

export const generateVideoAction: Action = {
  name: "GENERATE_VIDEO_SUEDE",
  similes: ["MAKE_VIDEO", "CREATE_CLIP", "GENERATE_CLIP", "GENERATE_SHORT_VIDEO"],
  description:
    "Generate an 8-second 720p video clip with native audio via Suede AI. Pays 4.99 USDC on Base per call via x402, then waits for the render.",
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Generate an 8-second cinematic clip of a rainy Tokyo street, tyres hissing on wet asphalt",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Generating your clip via Suede AI — paying 4.99 USDC on Base and waiting for the render...",
          action: "GENERATE_VIDEO_SUEDE",
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
    const prompt = promptFrom(message, "cinematic establishing shot with ambient sound");
    const result = await client.generateVideo({ prompt, durationSeconds: 8 });
    const assetUrl = result.status === "completed" ? result.assetUrl : undefined;

    let text: string;
    if (assetUrl) {
      text = `Video ready: ${assetUrl}`;
    } else if (result.status === "failed") {
      text = `Video render failed${result.jobId ? ` (job ${result.jobId})` : ""}.`;
    } else {
      text = `Video ${result.status}${result.pollUrl ? `. Poll: ${result.pollUrl}` : "."}`;
    }

    if (callback) {
      callback({
        text: `Generated via Suede AI — video clip, paid 4.99 USDC on Base. ${text}`,
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
      success: result.status !== "failed",
      text,
      data: {
        status: result.status,
        jobId: result.jobId,
        pollUrl: result.pollUrl,
        videoUrl: assetUrl,
        assetUrl,
      },
    };
  },
};
