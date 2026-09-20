import { defineSandbox } from "eve/sandbox";
import { aliyun } from "@jinshuju/eve-sandbox-aliyun";

export default defineSandbox({
  // Reads E2B_API_KEY / E2B_API_URL / E2B_DOMAIN. Sandboxes idle out after 10 minutes.
  backend: aliyun({ timeoutMs: 10 * 60_000 }),
  revalidationKey: () => "example-v1",
  // Runs once at build time; the result becomes the template every session starts from.
  async bootstrap({ use }) {
    const sandbox = await use();
    const result = await sandbox.run({
      command: "sudo apt-get update -qq && sudo apt-get install -y -qq jq >/dev/null",
    });
    if (result.exitCode !== 0) {
      throw new Error(`Sandbox setup failed (exit ${result.exitCode}): ${result.stderr}`);
    }
  },
});
