import { defineSandbox } from "eve/sandbox";
import { AliyunSandbox } from "@jinshuju/eve-sandbox-aliyun";

// Reads E2B_API_KEY / E2B_API_URL / E2B_DOMAIN. Sandboxes idle out after 10 minutes.
export const environment = AliyunSandbox.environment({
  timeoutMs: 10 * 60_000,
  // Runs once at build time; the result becomes the template every session starts from.
  async prepare(sandbox) {
    const result = await sandbox.run({
      command: "sudo apt-get update -qq && sudo apt-get install -y -qq jq >/dev/null",
    });
    if (result.exitCode !== 0) {
      throw new Error(`Sandbox setup failed (exit ${result.exitCode}): ${result.stderr}`);
    }
  },
});

// Runs once per session. What open() is given lasts as long as the session does.
export default defineSandbox(({ session }) =>
  environment.open({ env: { EVE_SESSION_ID: session.id } }),
);
