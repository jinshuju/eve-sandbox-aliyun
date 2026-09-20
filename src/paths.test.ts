import { describe, expect, test } from "vitest";
import { resolveSeedPath, resolveWorkspacePath, WORKSPACE_ROOT } from "./paths.js";

describe("resolveWorkspacePath", () => {
  test("anchors a relative path to /workspace", () => {
    expect(resolveWorkspacePath("repo/build.py")).toBe("/workspace/repo/build.py");
  });

  test("passes an absolute path through unchanged", () => {
    expect(resolveWorkspacePath("/etc/hosts")).toBe("/etc/hosts");
  });

  test("exposes /workspace as the root", () => {
    expect(WORKSPACE_ROOT).toBe("/workspace");
  });
});

describe("resolveSeedPath", () => {
  test("rewrites eve's $HOME skill root onto the sandbox home", () => {
    expect(resolveSeedPath("$HOME/.agents/skills/pdf/SKILL.md", "/home/user")).toBe(
      "/home/user/.agents/skills/pdf/SKILL.md",
    );
  });

  test("rewrites a bare $HOME", () => {
    expect(resolveSeedPath("$HOME", "/home/user")).toBe("/home/user");
  });

  test("does not double the slash when home is the filesystem root", () => {
    expect(resolveSeedPath("$HOME/.agents/skills/a", "/")).toBe("/.agents/skills/a");
  });

  test("leaves a path that merely starts with the text $HOME alone", () => {
    expect(resolveSeedPath("$HOMER/x", "/home/user")).toBe("$HOMER/x");
  });

  test("falls back to /workspace/skills for skill seeds when home is unknown", () => {
    expect(resolveSeedPath("$HOME/.agents/skills/pdf/SKILL.md", null)).toBe(
      "/workspace/skills/pdf/SKILL.md",
    );
  });

  test("leaves ordinary workspace seed paths alone", () => {
    expect(resolveSeedPath("schema.sql", "/home/user")).toBe("schema.sql");
  });
});
