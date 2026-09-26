import { Workspace } from "@/app/workspace/[repoKey]/Workspace";
import { ensureLocalWorkspace, PRODUCT_NAME } from "@/lib/local-workspace";
import { getGraph } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Page() {
  const repoKey = await ensureLocalWorkspace();
  const graph = await getGraph(repoKey);
  return <Workspace graph={graph} repoKey={repoKey} repoLabel={PRODUCT_NAME} />;
}
