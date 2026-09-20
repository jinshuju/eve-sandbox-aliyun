export interface SweepCandidate {
  readonly sandboxId: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly startedAt?: Date;
}

export interface SweepOptions {
  readonly now: number;
  /** Extra `key=value` metadata pairs that mark a sandbox as sweepable. */
  readonly tags?: ReadonlyArray<readonly [string, string]>;
  /** Only sweep sandboxes started at least this long ago. */
  readonly olderThanMs?: number;
}

export interface SweepVerdict extends SweepCandidate {
  readonly action: "sweep" | "young" | "keep";
}

/** Metadata keys only throwaway sandboxes carry: smoke runs and template builds. */
const DISPOSABLE_KEYS = ["smokeRun", "eveTemplateKey"];

/**
 * Decides what a sweep may destroy. Session sandboxes are someone's live work,
 * so nothing is sweepable unless it is provably disposable or explicitly named.
 */
export function selectSweepable(
  candidates: ReadonlyArray<SweepCandidate>,
  options: SweepOptions,
): SweepVerdict[] {
  const cutoff = options.now - (options.olderThanMs ?? 0);
  return candidates.map((candidate) => {
    const metadata = candidate.metadata ?? {};
    const disposable =
      DISPOSABLE_KEYS.some((key) => key in metadata) ||
      (options.tags ?? []).some(([key, value]) => metadata[key] === value);
    if (!disposable) return { ...candidate, action: "keep" };
    if (options.olderThanMs !== undefined) {
      const startedAt = candidate.startedAt?.getTime();
      if (startedAt === undefined || startedAt > cutoff) return { ...candidate, action: "young" };
    }
    return { ...candidate, action: "sweep" };
  });
}
