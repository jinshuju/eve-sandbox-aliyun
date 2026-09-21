import { describe, expect, test } from "vitest";
import { buildCaptureScript, MARKER_PATH } from "./archive.js";

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
});
