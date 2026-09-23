import type {
  SandboxProviderPrepareContext,
  SandboxProviderResources,
  SandboxProviderResourceTree,
  SandboxProviderSessionContext,
} from "eve/sandbox/provider";

export interface SeedFile {
  readonly path: string;
  readonly content: string | Uint8Array;
}

export const STORAGE_PATH = "/srv/app/.eve/sandbox-cache";

const SKILL_PREFIX = "$HOME/.agents/skills/";
const WORKSPACE_PREFIX = "/workspace/";

function tree(
  files: readonly SeedFile[],
  key: string,
  prefix: string,
  targetPath: string,
  mountPath: string,
): SandboxProviderResourceTree {
  return {
    files: files.map((file) => ({
      content: file.content,
      relativePath: file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path,
    })),
    key,
    mountPath,
    targetPath,
  };
}

/** The shape eve's (unexported) `createSandboxProviderResources` builds from seed files. */
export function seedResources(
  seedFiles: readonly SeedFile[] = [],
  key = "test-resources",
): SandboxProviderResources {
  if (seedFiles.length === 0) return { source: { kind: "none" } };
  const skills = seedFiles.filter((file) => file.path.startsWith(SKILL_PREFIX));
  const workspace = seedFiles.filter((file) => !file.path.startsWith(SKILL_PREFIX));
  return {
    source: { key, kind: "inline" },
    skills: tree(
      skills,
      `${key}:skills`,
      SKILL_PREFIX,
      "$HOME/.agents/skills",
      "/eve/resources/skills",
    ),
    workspace: tree(
      workspace,
      `${key}:workspace`,
      WORKSPACE_PREFIX,
      "/workspace",
      "/eve/resources/workspace",
    ),
  };
}

const host: SandboxProviderPrepareContext["host"] = {
  async loadOptionalPackage() {
    throw new Error("no optional packages in tests");
  },
  resolveProjectPath: (path) => path,
};

export function prepareContext(
  input: {
    readonly seedFiles?: readonly SeedFile[];
    readonly resourcesKey?: string;
    readonly sourceRevision?: string;
    readonly log?: (message: string) => void;
  } = {},
): SandboxProviderPrepareContext {
  return {
    files: {
      list: async () => [],
      read: async (path) => Promise.reject(new Error(`no authored file ${path}`)),
      readText: async (path) => Promise.reject(new Error(`no authored file ${path}`)),
    },
    host,
    log: input.log,
    resources: seedResources(input.seedFiles, input.resourcesKey),
    sourceRevision: input.sourceRevision ?? "rev-1",
    storagePath: STORAGE_PATH,
  };
}

export function sessionContext(sessionId = "session-1"): SandboxProviderSessionContext {
  return {
    host,
    session: {
      auth: { current: null, initiator: null },
      id: sessionId,
      turn: { id: "turn-1", sequence: 1 },
    },
    storagePath: STORAGE_PATH,
  };
}
