"use client";

/**
 * File explorer with full CRUD.
 *
 * Beyond browsing, this is where a developer creates, renames, and deletes
 * files — the operations an IDE is expected to have and whose absence makes
 * a tool feel like a demo. Files the current run touched are marked, so the
 * tree doubles as a live diff overview.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  File as FileIcon,
  FilePlus2,
  FolderPlus,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { loadFile } from "@/lib/file-loader";
import { refreshWorkspace } from "@/lib/client/agent-stream";
import { useViberon } from "@/store/viberon";
import {
  cx,
  Dot,
  EmptyState,
  IconButton,
  PanelHeader,
} from "@/components/vibe/primitives";

interface TreeDir {
  name: string;
  path: string;
  dirs: Map<string, TreeDir>;
  files: string[];
}

function buildTree(paths: string[]): TreeDir {
  const root: TreeDir = { name: "", path: "", dirs: new Map(), files: [] };
  for (const path of paths) {
    const segments = path.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i];
      const childPath = node.path ? `${node.path}/${name}` : name;
      let child = node.dirs.get(name);
      if (!child) {
        child = { name, path: childPath, dirs: new Map(), files: [] };
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.push(path);
  }
  return root;
}

/** File icons are neutral; the name carries the type. */
function fileAccent(): string {
  return "var(--vb-text-dim)";
}

export function FileTree() {
  const repoKey = useViberon((s) => s.repoKey);
  const fileList = useViberon((s) => s.fileList);
  const activeTabPath = useViberon((s) => s.activeTabPath);
  const expanded = useViberon((s) => s.expandedFolders);
  const toggleFolder = useViberon((s) => s.toggleFolder);
  const run = useViberon((s) => s.run);

  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function focus() {
      filterRef.current?.focus();
      filterRef.current?.select();
    }
    window.addEventListener("viberon:focusFileFilter", focus);
    return () => window.removeEventListener("viberon:focusFileFilter", focus);
  }, []);

  // Paths the current run changed, for the live change markers.
  const changed = useMemo(() => {
    const map = new Map<string, "create" | "update" | "delete" | "rename">();
    for (const change of run?.changes ?? []) map.set(change.path, change.kind);
    return map;
  }, [run?.changes]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return fileList;
    return fileList.filter((p) => p.toLowerCase().includes(needle));
  }, [fileList, filter]);

  const tree = useMemo(() => buildTree(filtered), [filtered]);
  // A filtered view is useless collapsed — show everything that matched.
  const forceOpen = filter.trim().length > 0;

  async function fileOp(
    op: "create" | "mkdir" | "rename" | "delete",
    path: string,
    to?: string,
  ) {
    setBusy(true);
    try {
      const response = await fetch("/api/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoKey, op, path, to }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok) {
        toast.error(body?.error ?? "Operation failed.");
        return false;
      }
      await refreshWorkspace();
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Operation failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function newFile() {
    const path = window.prompt("New file path (relative to the workspace root)");
    if (!path?.trim()) return;
    if (await fileOp("create", path.trim())) {
      void loadFile(repoKey, path.trim());
      toast.success(`Created ${path.trim()}`);
    }
  }

  async function newFolder() {
    const path = window.prompt("New folder path");
    if (!path?.trim()) return;
    if (await fileOp("mkdir", path.trim())) toast.success(`Created ${path.trim()}/`);
  }

  async function rename(path: string) {
    const to = window.prompt("Rename to", path);
    if (!to?.trim() || to.trim() === path) return;
    if (await fileOp("rename", path, to.trim())) {
      useViberon.getState().closeTab(path);
      void loadFile(repoKey, to.trim());
      toast.success(`Renamed to ${to.trim()}`);
    }
  }

  async function remove(path: string) {
    if (!window.confirm(`Delete ${path}? This cannot be undone from here.`)) return;
    if (await fileOp("delete", path)) {
      useViberon.getState().closeTab(path);
      toast.success(`Deleted ${path}`);
    }
  }

  function renderDir(dir: TreeDir, depth: number): React.ReactNode {
    const dirs = [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const files = [...dir.files].sort((a, b) => a.localeCompare(b));

    return (
      <>
        {dirs.map((child) => {
          const open = forceOpen || expanded.has(child.path);
          return (
            <div key={child.path}>
              <button
                type="button"
                onClick={() => toggleFolder(child.path)}
                className="flex h-[22px] w-full items-center gap-1 px-1 text-left hover:bg-[var(--vb-hover)]"
                style={{ paddingLeft: `${depth * 12 + 4}px` }}
              >
                <ChevronRight
                  className={cx(
                    "size-3.5 shrink-0",
                    open && "rotate-90",
                  )}
                  style={{ color: "var(--vb-text-faint)" }}
                />
                <span className="truncate text-[12.5px]" style={{ color: "var(--vb-text)" }}>
                  {child.name}
                </span>
              </button>
              {open && renderDir(child, depth + 1)}
            </div>
          );
        })}

        {files.map((path) => {
          const name = path.split("/").pop() ?? path;
          const active = activeTabPath === path;
          const change = changed.get(path);
          return (
            <div
              key={path}
              className={cx(
                "group flex h-[22px] items-center gap-1 pr-1",
                active ? "bg-[var(--vb-accent-soft)]" : "hover:bg-[var(--vb-hover)]",
              )}
            >
              <button
                type="button"
                onClick={() => {
                  // Single click previews; double click (or editing) pins.
                  useViberon.getState().openTab(path, undefined, { preview: true });
                  void loadFile(repoKey, path);
                }}
                onDoubleClick={() => useViberon.getState().pinTab(path)}
                title={path}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
                style={{ paddingLeft: `${depth * 12 + 22}px` }}
              >
                <FileIcon
                  className="size-3.5 shrink-0"
                  style={{ color: fileAccent() }}
                />
                <span
                  className="truncate text-[12.5px]"
                  style={{ color: active ? "var(--vb-text-hi)" : "var(--vb-text)" }}
                >
                  {name}
                </span>
                {change && (
                  <Dot
                    size={5}
                    color={
                      change === "create"
                        ? "var(--vb-add)"
                        : change === "delete"
                          ? "var(--vb-del)"
                          : "var(--vb-amber)"
                    }
                  />
                )}
              </button>
              <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <IconButton title="Rename" onClick={() => void rename(path)}>
                  <Pencil className="size-3" />
                </IconButton>
                <IconButton title="Delete" tone="danger" onClick={() => void remove(path)}>
                  <Trash2 className="size-3" />
                </IconButton>
              </span>
            </div>
          );
        })}
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Explorer"
        actions={
          <div className="flex items-center gap-0.5">
            <IconButton title="New file" onClick={() => void newFile()} disabled={busy}>
              <FilePlus2 className="size-3.5" />
            </IconButton>
            <IconButton title="New folder" onClick={() => void newFolder()} disabled={busy}>
              <FolderPlus className="size-3.5" />
            </IconButton>
            <IconButton
              title="Refresh"
              onClick={() => void refreshWorkspace()}
              disabled={busy}
            >
              <RefreshCw className={cx("size-3.5", busy && "animate-spin")} />
            </IconButton>
          </div>
        }
      />

      <div className="shrink-0 px-2 py-1.5">
        <div
          className="flex h-[24px] items-center gap-1.5 rounded-[3px] border px-2"
          style={{ borderColor: "var(--vb-line)", background: "var(--vb-bg-input)" }}
        >
          <Search className="size-3 shrink-0" style={{ color: "var(--vb-text-faint)" }} />
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files"
            aria-label="Filter files"
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
            style={{ color: "var(--vb-text-hi)" }}
          />
          {filter && (
            <button
              type="button"
              onClick={() => setFilter("")}
              className="text-[11px]"
              style={{ color: "var(--vb-text-faint)" }}
            >
              clear
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {fileList.length === 0 ? (
          <EmptyState
            icon={<FileIcon className="size-4" />}
            title="No files yet"
            body="Ask the agent to build something, or create a file to get started."
          />
        ) : filtered.length === 0 ? (
          <EmptyState title="No matches" body={`Nothing matches "${filter}".`} />
        ) : (
          renderDir(tree, 0)
        )}
      </div>

      <div
        className="shrink-0 border-t px-3 py-1 text-[11px]"
        style={{ borderColor: "var(--vb-line-faint)", color: "var(--vb-text-faint)" }}
      >
        {filtered.length} of {fileList.length} files
      </div>
    </div>
  );
}

export default FileTree;
