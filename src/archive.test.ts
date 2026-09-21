import { describe, expect, test } from "vitest";
import { ARCHIVE_PATH, buildCaptureScript, MARKER_PATH } from "./archive.js";

describe("buildCaptureScript", () => {
  // Custom templates are often BusyBox-based (Alpine, Wolfi): their find has no
  // -cnewer and their tar has no --null. Both failed silently there once.
  test("uses only what BusyBox and GNU userlands share", () => {
    const script = buildCaptureScript();

    expect(script).not.toMatch(/-cnewer|--null|-print0/);
    expect(script).toContain(`stat -c %z ${MARKER_PATH}`);
    expect(script).toContain("--no-recursion");
  });

  test("fails loudly when the marker cannot be read, instead of archiving nothing", () => {
    expect(buildCaptureScript()).toMatch(/\[ -n "\$marker" \] \|\| \{[^}]*exit 1/);
  });

  // GNU tar exits 1 for "file changed as we read it"; BusyBox tar exits 1 for
  // real errors. The archive itself is the only signal both agree on.
  test("never reports success without a fresh, non-empty archive", () => {
    const lines = buildCaptureScript().split("\n");
    const tar = lines.findIndex((line) => line.startsWith("tar "));

    expect(lines.slice(0, tar).join("\n")).toContain(`rm -f ${ARCHIVE_PATH}`);
    expect(lines.slice(tar).join("\n")).toMatch(
      new RegExp(`\\[ "\\$status" -gt 1 \\] \\|\\| \\[ ! -s ${ARCHIVE_PATH} \\]`),
    );
  });
});
