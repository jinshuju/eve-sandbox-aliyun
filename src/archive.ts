import { shellQuote } from "./session.js";

/** Backend-owned scratch directory inside the sandbox; excluded from archives. */
export const STATE_DIR = "/var/tmp/.eve-aliyun";
export const MARKER_PATH = `${STATE_DIR}/base-marker`;
export const ARCHIVE_PATH = `${STATE_DIR}/state.tgz`;

/** Prints the default user's home and name, one per line. */
export const PROBE_USER_SCRIPT = `printf '%s\\n%s\\n' "$HOME" "$(id -un)"`;

/**
 * Root-run setup every fresh sandbox gets before anything else touches it.
 * Mirrors eve's base setup (a user-owned `/workspace`, `/dev/fd`), then drops
 * the marker that later archives are measured against. The marker is only
 * created once, so re-running this on a reattached sandbox changes nothing.
 */
export function buildBaseSetupScript(user: string): string {
  return [
    "set -e",
    "mkdir -p /workspace",
    `chown ${shellQuote(user)}: /workspace`,
    "if [ ! /dev/fd -ef /proc/self/fd ]; then ln -s /proc/self/fd /dev/fd 2>/dev/null || true; fi",
    `mkdir -p ${STATE_DIR}`,
    `[ -e ${MARKER_PATH} ] || touch ${MARKER_PATH}`,
  ].join("\n");
}

const PRUNED_PATHS = [
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/tmp",
  "/var/tmp",
  "/var/cache",
  "/var/log",
  "/var/lib/apt/lists",
];

/**
 * Archives every filesystem entry whose inode changed after base setup — the
 * provider offers no snapshots, so this delta *is* the template or the session
 * checkpoint. `-cnewer` (ctime) is deliberate: package managers restore old
 * mtimes on the files they install, but ctime always moves. tar exits 1 when
 * a file changed while being read, which is not a failure for a live system.
 */
export function buildCaptureScript(): string {
  const prune = PRUNED_PATHS.map((path) => `-path ${path}`).join(" -o ");
  return [
    "cd /",
    `find / -xdev \\( ${prune} \\) -prune -o -cnewer ${MARKER_PATH} -print0 \\`,
    `  | tar --null --no-recursion -T - -czpf ${ARCHIVE_PATH} 2>${STATE_DIR}/tar.err`,
    "status=$?",
    `if [ "$status" -gt 1 ]; then cat ${STATE_DIR}/tar.err >&2; exit "$status"; fi`,
  ].join("\n");
}

export function buildRestoreScript(): string {
  return `set -e\ntar -xzpf ${ARCHIVE_PATH} -C /\nrm -f ${ARCHIVE_PATH}`;
}
