import { describe, expect, test } from "vitest";
import { selectSweepable } from "./sweep-selection.js";

const now = Date.parse("2026-09-20T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000);

describe("selectSweepable", () => {
  test("takes smoke runs and template builds, and leaves sessions alone", () => {
    const verdicts = selectSweepable(
      [
        { sandboxId: "smoke", metadata: { smokeRun: "smoke-1", eveSessionKey: "k" } },
        { sandboxId: "build", metadata: { eveTemplateKey: "tpl" } },
        { sandboxId: "session", metadata: { eveSessionKey: "eve-sbx-ses-1", agent: "jiri" } },
        { sandboxId: "foreign", metadata: {} },
      ],
      { now },
    );

    expect(verdicts.map((verdict) => [verdict.sandboxId, verdict.action])).toEqual([
      ["smoke", "sweep"],
      ["build", "sweep"],
      ["session", "keep"],
      ["foreign", "keep"],
    ]);
  });

  test("--tag widens the set to sandboxes carrying that exact pair", () => {
    const verdicts = selectSweepable(
      [
        { sandboxId: "jiri", metadata: { agent: "jiri" } },
        { sandboxId: "other", metadata: { agent: "support" } },
      ],
      { now, tags: [["agent", "jiri"]] },
    );

    expect(verdicts.map((verdict) => verdict.action)).toEqual(["sweep", "keep"]);
  });

  test("--older-than spares sandboxes started since then, and ones with no start time", () => {
    const verdicts = selectSweepable(
      [
        { sandboxId: "old", metadata: { smokeRun: "a" }, startedAt: minutesAgo(90) },
        { sandboxId: "young", metadata: { smokeRun: "b" }, startedAt: minutesAgo(5) },
        { sandboxId: "unknown", metadata: { smokeRun: "c" } },
      ],
      { now, olderThanMs: 60 * 60_000 },
    );

    expect(verdicts.map((verdict) => verdict.action)).toEqual(["sweep", "young", "young"]);
  });
});
