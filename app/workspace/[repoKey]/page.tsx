import { Workspace } from "@/app/workspace/[repoKey]/Workspace";
import { getGraph, getJob, getLocalWorkspace, getRepoJob } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ repoKey: string }>;
}) {
  const { repoKey } = await params;

  const [graph, localMeta, jobId] = await Promise.all([
    getGraph(repoKey),
    getLocalWorkspace(repoKey),
    getRepoJob(repoKey),
  ]);

  const job = !graph && jobId ? await getJob(jobId) : null;
  const stillRunning = job && job.status !== "succeeded" && job.status !== "failed";

  return (
    <Workspace
      graph={graph}
      jobId={stillRunning ? job.jobId : undefined}
      repoKey={repoKey}
      repoLabel={localMeta?.label}
      repoRef={localMeta?.repoRef}
      rootPath={localMeta?.rootPath}
    />
  );
}
