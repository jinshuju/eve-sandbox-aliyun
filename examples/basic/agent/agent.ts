import { deepSeek } from "@ai-sdk/deepseek";
import { defineAgent } from "eve";

export default defineAgent({
  model: deepSeek("deepseek-v4-flash"),
});
