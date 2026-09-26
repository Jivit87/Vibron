/**
 * An in-memory workspace for harness tests: files live in the memory store,
 * so tools read and write them for real without touching disk.
 */

import type { OrchestrationEvent } from "@/lib/agents/events";
import { ContextLedger, type EngineInput } from "@/lib/context/engine";
import type { ProjectMemory } from "@/lib/memory/types";
import { getFileInfo, getGraph, putRawFiles, resetMemoryStoreForTests } from "@/lib/store";
import { fullReindex, readFile, type WorkspaceHandle } from "@/lib/workspace";

export interface TestWorkspace {
  handle: WorkspaceHandle;
  memory: ProjectMemory;
  engine: EngineInput;
  ledger: ContextLedger;
}

export async function makeWorkspace(
  files: { path: string; source: string }[],
  repoKey = "harness-test",
): Promise<TestWorkspace> {
  resetMemoryStoreForTests();
  const handle: WorkspaceHandle = {
    repoKey,
    rootPath: null,
    repoRef: "test/repo@main",
    label: "test",
  };
  // Copy: the memory store keeps the array, and writes mutate it in place.
  await putRawFiles(repoKey, files.map((f) => ({ ...f })));
  const { memory } = await fullReindex(handle);
  const ledger = new ContextLedger();
  const engine: EngineInput = {
    graph: await getGraph(repoKey),
    memory,
    fileInfo: await getFileInfo(repoKey),
    readFile: (path) => readFile(handle, path),
    ledger,
  };
  return { handle, memory, engine, ledger };
}

/** Collects emitted events, with a typed filter. */
export function eventLog() {
  const events: OrchestrationEvent[] = [];
  return {
    events,
    emit: (event: OrchestrationEvent) => {
      events.push(event);
    },
    of<T extends OrchestrationEvent["type"]>(type: T) {
      return events.filter(
        (e): e is Extract<OrchestrationEvent, { type: T }> => e.type === type,
      );
    },
  };
}
