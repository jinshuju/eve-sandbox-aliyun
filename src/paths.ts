/** Live working directory of every eve sandbox, with every provider. */
export const WORKSPACE_ROOT = "/workspace";

const MODEL_HOME_ROOT = "$HOME";
const MODEL_SKILL_ROOT = `${MODEL_HOME_ROOT}/.agents/skills`;
const FALLBACK_SKILL_ROOT = `${WORKSPACE_ROOT}/skills`;

/** Relative paths resolve from `/workspace`; absolute paths pass through. */
export function resolveWorkspacePath(path: string): string {
  return path.startsWith("/") ? path : `${WORKSPACE_ROOT}/${path}`;
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * eve addresses skill seeds as `$HOME/.agents/skills/**`. Mirrors eve's own
 * `resolveSandboxModelPath`: substitute the probed sandbox home, and when the
 * home could not be probed fall back to `/workspace/skills` for skill seeds.
 */
export function resolveSeedPath(path: string, home: string | null): string {
  if (!isUnder(path, MODEL_HOME_ROOT)) return path;
  if (home !== null) {
    return `${home === "/" ? "" : home}${path.slice(MODEL_HOME_ROOT.length)}` || home;
  }
  return isUnder(path, MODEL_SKILL_ROOT)
    ? `${FALLBACK_SKILL_ROOT}${path.slice(MODEL_SKILL_ROOT.length)}`
    : path;
}
