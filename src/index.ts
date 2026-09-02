import type { Plugin } from "@elizaos/core";
import { generateMusicAction } from "./actions/generateMusic.js";
import { generateVideoAction } from "./actions/generateVideo.js";
import { generateImageAction } from "./actions/generateImage.js";

export const suedePlugin: Plugin = {
  name: "suede",
  description:
    "Music, video, and image generation by Suede AI, agent-payable via x402 on Base.",
  actions: [generateMusicAction, generateVideoAction, generateImageAction],
  providers: [],
  evaluators: [],
  services: [],
};

export default suedePlugin;
export { SuedeClient } from "./x402-client.js";
export { SuedeRenderTimeoutError, selectRequirement } from "./x402-client.js";
export type {
  GenerateImageOptions,
  GenerateMusicOptions,
  GenerateVideoOptions,
  MediaJobResult,
  MusicResult,
  PaidCallOptions,
  PaymentRequirement,
  RenderStatus,
  SuedeClientConfig,
  SuedeNetwork,
  WaitOptions,
  X402Challenge,
} from "./x402-client.js";
