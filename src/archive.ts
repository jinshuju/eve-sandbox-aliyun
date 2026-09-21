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

const LIST_PATH = `${STATE_DIR}/changed.list`;

/**
 * Archives every filesystem entry whose inode changed after base setup — the
 * provider offers no snapshots, so this delta *is* the template or the session
 * checkpoint. ctime is deliberate: package managers restore old mtimes on the
 * files they install, but ctime always moves.
 *
 * Written for the userland GNU and BusyBox share, since custom templates are
 * often Alpine or Wolfi: BusyBox find has no `-cnewer` and its tar no `--null`,
 * so ctimes come from `stat` (`%z` sorts as text, nanoseconds included) and the
 * list is newline-separated — a file name containing a newline is not captured.
 * find's own exit status is ignored because files vanish under a live system;
 * tar exits 1 when a file changed while being read, which is not a failure either.
 */
export function buildCaptureScript(): string {
  const prune = PRUNED_PATHS.map((path) => `-path ${path}`).join(" -o ");
  return [
    "cd /",
    `marker=$(stat -c %z ${MARKER_PATH})`,
    `[ -n "$marker" ] || { echo "cannot read the ctime of ${MARKER_PATH}" >&2; exit 1; }`,
    `find / -xdev \\( ${prune} \\) -prune -o -exec stat -c '%z|%n' {} + 2>/dev/null \\`,
    `  | awk -v marker="$marker" '{ bar = index($0, "|"); if (substr($0, 1, bar - 1) > marker) print substr($0, bar + 1) }' \\`,
    `  > ${LIST_PATH}`,
    `tar --no-recursion -T ${LIST_PATH} -czpf ${ARCHIVE_PATH} 2>${STATE_DIR}/tar.err`,
    "status=$?",
    `if [ "$status" -gt 1 ]; then cat ${STATE_DIR}/tar.err >&2; exit "$status"; fi`,
  ].join("\n");
}

export function buildRestoreScript(): string {
  return `set -e\ntar -xzpf ${ARCHIVE_PATH} -C /\nrm -f ${ARCHIVE_PATH}`;
}
