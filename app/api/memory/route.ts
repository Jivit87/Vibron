/**
 * Project-memory API.
 *
 *   GET    /api/memory?repoKey=…  → {memory, entries, vault: {path, notes}}
 *          entries are the graph-anchored notes ({id, kind, text, anchors, stale});
 *          reading imports any edits made in the Obsidian vault.
 *   PATCH  /api/memory            → user edits (overview, entries, tasks)
 *   DELETE /api/memory?repoKey=…&entryId=… → forget one entry
 *
 * Memory is the project's durable brain, so it is directly inspectable and
 * editable by the user — an agent that learned something wrong should be
 * correctable without clearing everything.
 */

import {
  getMemoryGraph,
  vaultPath,
  loadMemory,
  mutateMemory,
  recordEntry,
  renderMemoryMarkdown,
  upsertTask,
  type MemoryEntryKind,
} from "@/lib/memory";
import { openWorkspace, refreshMemory, writeMemoryMirror } from "@/lib/workspace";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const repoKey = url.searchParams.get("repoKey");
  if (!repoKey) {
    return Response.json({ error: "repoKey is required" }, { status: 400 });
  }

  const handle = await openWorkspace(repoKey);
  // `?view=graph`: the graph-anchored memory (entries, summaries, runs with staleness).
  if (url.searchParams.get("view") === "graph") {
    return Response.json({ graph: getMemoryGraph(handle.rootPath ?? `store:${repoKey}`) });
  }

  // Refresh the derived half so the panel never shows a stale file index.
  const memory = await refreshMemory(handle).catch(() => loadMemory(repoKey));
  return Response.json({ memory, ...anchoredNotes(handle.rootPath) });
}

function anchoredNotes(root: string | null) {
  if (!root) return { entries: [], vault: null };
  try {
    const entries = getMemoryGraph(root).entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      text: e.text,
      anchors: e.anchors.map((a) => a.ref),
      stale: e.stale,
    }));
    return { entries, vault: { path: vaultPath(root), notes: entries.length } };
  } catch {
    return { entries: [], vault: null };
  }
}

export async function PATCH(request: Request) {
  let body: {
    repoKey?: unknown;
    overview?: unknown;
    entry?: unknown;
    task?: unknown;
    resolveEntryId?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }

  const repoKey = typeof body.repoKey === "string" ? body.repoKey : "";
  if (!repoKey) {
    return Response.json({ error: "repoKey is required" }, { status: 400 });
  }

  const memory = await mutateMemory(repoKey, (draft) => {
    if (typeof body.overview === "string") {
      draft.overview = body.overview.trim();
    }

    if (body.entry && typeof body.entry === "object") {
      const entry = body.entry as {
        kind?: string;
        text?: string;
        why?: string;
        files?: string[];
      };
      const kinds: MemoryEntryKind[] = [
        "decision",
        "fact",
        "convention",
        "suggestion",
      ];
      if (
        entry.text?.trim() &&
        kinds.includes(entry.kind as MemoryEntryKind)
      ) {
        recordEntry(draft, entry.kind as MemoryEntryKind, {
          text: entry.text,
          why: entry.why,
          files: entry.files,
          author: "You",
        });
      }
    }

    if (typeof body.resolveEntryId === "string") {
      for (const bucket of [
        draft.suggestions,
        draft.decisions,
        draft.facts,
        draft.conventions,
      ]) {
        const match = bucket.find((e) => e.id === body.resolveEntryId);
        if (match) match.resolved = true;
      }
    }

    if (body.task && typeof body.task === "object") {
      const task = body.task as { title?: string };
      if (task.title?.trim()) {
        upsertTask(draft, task as never);
      }
    }
  });

  const handle = await openWorkspace(repoKey);
  await writeMemoryMirror(handle, renderMemoryMarkdown(memory));
  return Response.json({ memory });
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const repoKey = url.searchParams.get("repoKey");
  const entryId = url.searchParams.get("entryId");
  const taskId = url.searchParams.get("taskId");
  if (!repoKey) {
    return Response.json({ error: "repoKey is required" }, { status: 400 });
  }

  const memory = await mutateMemory(repoKey, (draft) => {
    if (entryId) {
      draft.decisions = draft.decisions.filter((e) => e.id !== entryId);
      draft.facts = draft.facts.filter((e) => e.id !== entryId);
      draft.conventions = draft.conventions.filter((e) => e.id !== entryId);
      draft.suggestions = draft.suggestions.filter((e) => e.id !== entryId);
    }
    if (taskId) {
      draft.tasks = draft.tasks.filter((t) => t.id !== taskId);
    }
  });

  return Response.json({ memory });
}
