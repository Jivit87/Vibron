import { nanoid } from "nanoid";
import { after } from "next/server";
import { parseGitHubUrl, toRepoRef } from "@/lib/github";
import { repoKey as makeRepoKey } from "@/lib/ids";
import { ingest, IngestionTimeoutError, RepoTooLargeError } from "@/lib/ingest";
import type { Job } from "@/lib/graph";
import { getGraph, putFileInfo, putGraph, putJob, putRawFiles, setRepoToJob } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;

async function markJobFailed(job: Job, error: unknown): Promise<void> {
  const message =
    error instanceof RepoTooLargeError ||
    error instanceof IngestionTimeoutError ||
    error instanceof Error
      ? error.message
      : String(error);

  await putJob({
    ...job,
    status: "failed",
    progress: Math.max(job.progress, 1),
    error: message,
    finishedAt: Date.now(),
  });
}

async function runIngestionJob(job: Job): Promise<void> {
  let currentJob: Job = {
    ...job,
    status: "running",
    progress: 5,
  };
  await putJob(currentJob);

  try {
    const result = await ingest(job.repoRef, {
      startedAt: job.startedAt,
      onProgress: async (progress) => {
        currentJob = {
          ...currentJob,
          status: "running",
          progress,
        };
        await putJob(currentJob);
      },
    });

    await putGraph(job.repoKey, result.graph);
    await putFileInfo(job.repoKey, result.files);
    await putRawFiles(job.repoKey, result.rawFiles);
    await putJob({
      ...currentJob,
      repoRef: result.repoRef,
      status: "succeeded",
      progress: 100,
      errors: result.errors,
      finishedAt: Date.now(),
    });
  } catch (error) {
    await markJobFailed(currentJob, error);
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const url = typeof (body as { url?: unknown }).url === "string" ? (body as { url: string }).url.trim() : "";
  const parsed = url ? parseGitHubUrl(url) : null;
  if (!url || !parsed) {
    return Response.json({ error: `Invalid GitHub URL: ${url || "<empty>"}` }, { status: 400 });
  }

  const repoRef = toRepoRef(parsed);
  const repoKey = makeRepoKey(repoRef);
  const jobId = nanoid(12);
  const cachedGraph = await getGraph(repoKey);
  const now = Date.now();
  const job: Job = {
    jobId,
    repoKey,
    repoRef,
    status: cachedGraph ? "succeeded" : "queued",
    progress: cachedGraph ? 100 : 0,
    startedAt: now,
    finishedAt: cachedGraph ? now : undefined,
  };

  await putJob(job);
  await setRepoToJob(repoKey, jobId);

  if (!cachedGraph) {
    after(async () => {
      await runIngestionJob(job);
    });
  }

  return Response.json({ jobId, repoKey }, { status: 202 });
}
