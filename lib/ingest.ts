import type { Graph, StoredFileInfo, StoredRawFile } from "@/lib/graph";
import { fetchTarball, type RepoFile } from "@/lib/github";
import { parseRepo } from "@/lib/parser";
import { countTokens } from "@/lib/tokens";

const MAX_FILES = 500;
const DEFAULT_TIMEOUT_MS = 45_000;

export class RepoTooLargeError extends Error {
  constructor(fileCount: number) {
    super(`Repository has ${fileCount} source files, over the ${MAX_FILES} file limit.`);
    this.name = "RepoTooLargeError";
  }
}

export class IngestionTimeoutError extends Error {
  constructor() {
    super("Ingestion timed out.");
    this.name = "IngestionTimeoutError";
  }
}

export interface IngestOptions {
  startedAt?: number;
  timeoutMs?: number;
  onProgress?: (progress: number) => void | Promise<void>;
}

export interface IngestResult {
  repoRef: string;
  graph: Graph;
  files: StoredFileInfo[];
  rawFiles: StoredRawFile[];
  errors: string[];
}

function toRawFiles(files: RepoFile[]): StoredRawFile[] {
  return files.map((file) => ({ path: file.path, source: file.source }));
}

function toFileInfo(files: RepoFile[]): StoredFileInfo[] {
  return files.map((file) => ({ path: file.path, tokenCount: countTokens(file.source) }));
}

export async function ingest(repoRef: string, options: IngestOptions = {}): Promise<IngestResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new IngestionTimeoutError()), timeoutMs);
  });

  const run = async (): Promise<IngestResult> => {
    await options.onProgress?.(20);
    const tarball = await fetchTarball(repoRef);

    if (tarball.files.length > MAX_FILES) {
      throw new RepoTooLargeError(tarball.files.length);
    }

    await options.onProgress?.(60);
    const parsed = parseRepo(tarball.files, tarball.repoRef);
    await options.onProgress?.(90);

    return {
      repoRef: tarball.repoRef,
      graph: parsed.graph,
      files: toFileInfo(tarball.files),
      rawFiles: toRawFiles(tarball.files),
      errors: parsed.errors,
    };
  };

  return Promise.race([run(), timeout]);
}
