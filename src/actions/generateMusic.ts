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
    "Generate an original full-length song via Suede AI. Pays 0.50 USDC on Base per call via x402, then waits for the render.",
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Make me an ambient lofi track with vinyl crackle and soft piano" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Generating your track via Suede AI — paying 0.50 USDC on Base and waiting for the render...",
          action: "GENERATE_MUSIC_SUEDE",
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
    const prompt = promptFrom(message, "ambient electronic");
    const result = await client.generateMusic({ prompt });
    const audioUrl = result.status === "completed" ? result.audioUrl : undefined;

    let text: string;
    if (audioUrl) {
      text = `Music ready: ${audioUrl}`;
    } else if (result.status === "failed") {
      text = `Music render failed${result.songId ? ` (song ${result.songId})` : ""}.`;
    } else {
      text = `Music queued${result.pollUrl ? `. Poll: ${result.pollUrl}` : "."}`;
    }

    if (callback) {
      callback({
        text: `Generated via Suede AI — music, paid 0.50 USDC on Base. ${text}`,
        action: "GENERATE_MUSIC_SUEDE",
        attachments: audioUrl
          ? [
              {
                id: randomUUID(),
                url: audioUrl,
                contentType: ContentType.AUDIO,
                title: "Suede AI music",
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
        songId: result.songId,
        shareUrl: result.shareUrl,
        pollUrl: result.pollUrl,
        audioUrl,
        assetUrl: audioUrl,
        modelVersion: result.modelVersion,
      },
    };
  },
};
