/**
 * Finds sandboxes left running in the account and, with `--kill`, destroys the
 * disposable ones. Sandboxes bill until their idle timeout, so run this after
 * live testing.
 *
 *   pnpm sweep                                list only
 *   pnpm sweep --kill                         destroy smoke runs and template builds
 *   pnpm sweep --kill --older-than 60         ...started at least 60 minutes ago
 *   pnpm sweep --kill --tag agent=my-agent    also sandboxes carrying that eve tag
 *
 * Session sandboxes are never touched unless a `--tag` names them.
 */
import { parseArgs } from "node:util";
import { Sandbox } from "e2b";
import { resolveAliyunConnection } from "../index.js";
import { selectSweepable, type SweepCandidate } from "./sweep-selection.js";

const { values } = parseArgs({
  options: {
    kill: { type: "boolean", default: false },
    tag: { type: "string", multiple: true },
    "older-than": { type: "string" },
  },
});

const tags = (values.tag ?? []).map((tag) => {
  const [key, ...rest] = tag.split("=");
  if (!key || rest.length === 0) throw new Error(`--tag takes key=value, got "${tag}"`);
  return [key, rest.join("=")] as const;
});
const olderThanMinutes =
  values["older-than"] === undefined ? undefined : Number(values["older-than"]);
if (olderThanMinutes !== undefined && !Number.isFinite(olderThanMinutes)) {
  throw new Error("--older-than takes a number of minutes");
}

const connection = { ...resolveAliyunConnection({}) };
const candidates: SweepCandidate[] = [];
const paginator = Sandbox.list(connection);
while (paginator.hasNext) candidates.push(...(await paginator.nextItems()));

const verdicts = selectSweepable(candidates, {
  now: Date.now(),
  tags,
  olderThanMs: olderThanMinutes === undefined ? undefined : olderThanMinutes * 60_000,
});

console.log(
  `${verdicts.length} sandbox(es) in the account${values.kill ? "" : " (dry run; pass --kill to destroy)"}`,
);
let swept = 0;
for (const verdict of verdicts) {
  const label = `${verdict.sandboxId}  started=${verdict.startedAt?.toISOString() ?? "-"}  ${JSON.stringify(verdict.metadata ?? {})}`;
  if (verdict.action !== "sweep") {
    console.log(`  ${verdict.action.padEnd(6)} ${label}`);
    continue;
  }
  if (!values.kill) {
    console.log(`  would  ${label}`);
    swept += 1;
    continue;
  }
  try {
    await Sandbox.kill(verdict.sandboxId, connection);
    console.log(`  swept  ${label}`);
    swept += 1;
  } catch (error) {
    console.log(`  failed ${label}  ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
console.log(`${swept} sandbox(es) ${values.kill ? "swept" : "would be swept"}`);
