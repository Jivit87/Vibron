import { getGraph, getJob } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const job = await getJob(jobId);
  if (!job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  const graph = job.status === "succeeded" ? await getGraph(job.repoKey) : null;

  return Response.json({
    status: job.status,
    progress: job.progress,
    error: job.error,
    errors: job.errors,
    graph: graph ?? undefined,
  });
}
