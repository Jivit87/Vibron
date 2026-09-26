"use client";

/**
 * Start page: open something, go back to something, or learn the keys.
 * Plain lists, no hero.
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { loadFile } from "@/lib/file-loader";
import { loadRecentClones, type RecentClone } from "@/lib/client/clone";
import { isMockMode } from "@/lib/client/mock-run";
import {
  loadRecentWorkspaces,
  openFolderDialog,
  type RecentWorkspace,
} from "@/lib/client/recent-workspaces";
import { useViberon } from "@/store/viberon";
import { formatAgo, Kbd } from "@/components/vibe/primitives";

interface Action {
  label: string;
  keys?: string[];
  run: () => void;
}

export function WelcomeTab() {
  const repoLabel = useViberon((s) => s.repoLabel);
  const rootPath = useViberon((s) => s.rootPath);
  const repoKey = useViberon((s) => s.repoKey);
  const memory = useViberon((s) => s.memory);
  const fileList = useViberon((s) => s.fileList);
  const [recent, setRecent] = useState<RecentWorkspace[]>([]);
  const [clones, setClones] = useState<RecentClone[]>([]);
  const cloneOpen = useViberon((s) => s.cloneOpen);

  useEffect(() => {
    setRecent(loadRecentWorkspaces());
    setClones(loadRecentClones());
  }, [repoKey, cloneOpen]);

  const store = () => useViberon.getState();
  const actions: Action[] = [
    {
      label: "Open folder…",
      run: () =>
        void openFolderDialog().then((r) => {
          if (!r.ok && r.error) toast.error(r.error);
        }),
    },
    { label: "Clone repository…", run: () => store().setCloneOpen(true) },
    {
      label: "New chat",
      keys: ["⌘", "I"],
      run: () => {
        store().newConversation();
        store().setAppMode("chat");
      },
    },
    { label: "Go to file", keys: ["⌘", "P"], run: () => store().setPaletteOpen(true) },
    {
      label: "Search in files",
      keys: ["⌘", "⇧", "F"],
      run: () => {
        store().setSidebarView("search");
        requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("viberon:focusSearch")));
      },
    },
    { label: "Source control", keys: ["⌘", "⇧", "G"], run: () => store().setSidebarView("scm") },
    { label: "Problems", keys: ["⌘", "⇧", "U"], run: () => store().setBottomPanel("problems") },
    { label: "Terminal", keys: ["⌘", "`"], run: () => store().setBottomPanel("terminal") },
    { label: "Code graph", keys: ["⌘", "G"], run: () => store().openGraphTab() },
    { label: "Settings", keys: ["⌘", ","], run: () => store().openSettingsTab() },
    { label: "Switch Chat / IDE", keys: ["⌘", "⇧", "M"], run: () => store().toggleAppMode() },
  ];

  const others = recent.filter((w) => w.repoKey !== repoKey);
  const entryPoints = memory?.entryPoints ?? [];

  return (
    <div className="@container h-full overflow-y-auto" style={{ background: "var(--vb-bg-base)" }}>
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-8 px-6 py-8 @2xl:px-10 @2xl:py-10">
        <header>
          <h1 className="text-[18px] font-semibold" style={{ color: "var(--vb-text-hi)" }}>
            {repoLabel}
          </h1>
          <p className="mt-1 font-mono text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
            {rootPath ?? "In-memory workspace"} · {fileList.length} files
          </p>
          {memory?.overview && (
            <p className="mt-3 max-w-[640px] text-[12.5px] leading-relaxed" style={{ color: "var(--vb-text-mid)" }}>
              {memory.overview}
            </p>
          )}
        </header>

        <div className="grid gap-8 @2xl:grid-cols-2 @2xl:gap-10">
          <List title="Start">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={action.run}
                className="flex h-[26px] w-full items-center justify-between gap-3 rounded-[3px] px-2 text-left text-[12.5px] hover:bg-[var(--vb-hover)]"
                style={{ color: "var(--vb-text)" }}
              >
                <span className="truncate whitespace-nowrap">{action.label}</span>
                {action.keys && (
                  <span className="flex shrink-0 gap-0.5">
                    {action.keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                )}
              </button>
            ))}
          </List>

          <div className="flex flex-col gap-8">
            <List title="Recent">
              {others.length === 0 ? (
                <p className="px-2 text-[12.5px]" style={{ color: "var(--vb-text-dim)" }}>
                  Folders you open appear here.
                </p>
              ) : (
                others.slice(0, 8).map((w) => (
                  <a
                    key={w.repoKey}
                    href={`/workspace/${w.repoKey}`}
                    className="flex h-[26px] items-center gap-3 rounded-[3px] px-2 text-[12.5px] hover:bg-[var(--vb-hover)]"
                    title={w.rootPath}
                  >
                    <span className="shrink-0" style={{ color: "var(--vb-text)" }}>
                      {w.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                      {w.rootPath ?? ""}
                    </span>
                    <span className="shrink-0 text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                      {formatAgo(w.openedAt)}
                    </span>
                  </a>
                ))
              )}
            </List>

            {clones.length > 0 && (
              <List title="Cloned">
                {clones.slice(0, 6).map((c) => (
                  <a
                    key={c.repoKey}
                    href={`/workspace/${encodeURIComponent(c.repoKey)}${isMockMode() ? "?mock=1" : ""}`}
                    className="flex h-[26px] items-center gap-3 rounded-[3px] px-2 text-[12.5px] hover:bg-[var(--vb-hover)]"
                    title={c.url}
                  >
                    <span className="shrink-0" style={{ color: "var(--vb-text)" }}>
                      {c.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                      {c.rootPath ?? c.url}
                    </span>
                    <span className="shrink-0 text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                      {formatAgo(c.clonedAt)}
                    </span>
                  </a>
                ))}
              </List>
            )}

            {entryPoints.length > 0 && (
              <List title="Entry points">
                {entryPoints.slice(0, 8).map((path) => (
                  <button
                    key={path}
                    type="button"
                    onClick={() => void loadFile(repoKey, path)}
                    className="flex h-[26px] w-full items-center rounded-[3px] px-2 text-left font-mono text-[12px] hover:bg-[var(--vb-hover)]"
                    style={{ color: "var(--vb-text)" }}
                  >
                    <span className="truncate">{path}</span>
                  </button>
                ))}
              </List>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function List({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col">
      <h2 className="vb-label mb-1 border-b px-2 pb-1.5" style={{ borderColor: "var(--vb-line)" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}
