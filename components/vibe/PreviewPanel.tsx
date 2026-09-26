"use client";

/**
 * Live app preview.
 *
 * When a dev server starts — whether the agent started it or the user did —
 * its URL is detected from the terminal output and rendered here. Closing
 * the loop from "describe it" to "see it running" in one window is the whole
 * point of a vibe-coding tool.
 */

import { useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  Monitor,
  RotateCw,
  Smartphone,
  Tablet,
  X,
} from "lucide-react";

import { useViberon } from "@/store/viberon";
import { cx, EmptyState, IconButton, PanelHeader } from "@/components/vibe/primitives";

type Viewport = "desktop" | "tablet" | "mobile";

const VIEWPORTS: Record<Viewport, { width: number | null; label: string }> = {
  desktop: { width: null, label: "Fill" },
  tablet: { width: 768, label: "768" },
  mobile: { width: 390, label: "390" },
};

export function PreviewPanel() {
  const previewUrl = useViberon((s) => s.previewUrl);
  const setPreviewOpen = useViberon((s) => s.setPreviewOpen);

  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [nonce, setNonce] = useState(0);
  const [address, setAddress] = useState(previewUrl ?? "");
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (previewUrl) setAddress(previewUrl);
  }, [previewUrl]);

  if (!previewUrl) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader title="Preview" icon={<Monitor className="size-3" />} />
        <EmptyState
          icon={<Monitor className="size-4" />}
          title="Nothing running yet"
          body="Start a dev server from the terminal — or ask the agent to — and the running app appears here automatically."
        />
      </div>
    );
  }

  const width = VIEWPORTS[viewport].width;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Preview"
        icon={<Monitor className="size-3" />}
        actions={
          <div className="flex items-center gap-0.5">
            {(Object.keys(VIEWPORTS) as Viewport[]).map((key) => {
              const Icon =
                key === "desktop" ? Monitor : key === "tablet" ? Tablet : Smartphone;
              return (
                <IconButton
                  key={key}
                  title={`${key} (${VIEWPORTS[key].label})`}
                  active={viewport === key}
                  onClick={() => setViewport(key)}
                >
                  <Icon className="size-3" />
                </IconButton>
              );
            })}
            <IconButton title="Reload" onClick={() => setNonce((n) => n + 1)}>
              <RotateCw className="size-3" />
            </IconButton>
            <IconButton
              title="Open in browser"
              onClick={() => window.open(address, "_blank", "noopener")}
            >
              <ExternalLink className="size-3" />
            </IconButton>
            <IconButton title="Close preview" onClick={() => setPreviewOpen(false)}>
              <X className="size-3" />
            </IconButton>
          </div>
        }
      />

      <div
        className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5"
        style={{ borderColor: "var(--vb-line-faint)" }}
      >
        <form
          className="flex flex-1 items-center gap-1.5 rounded-[4px] border px-2 py-1"
          style={{
            borderColor: "var(--vb-line-faint)",
            background: "var(--vb-bg-input)",
          }}
          onSubmit={(event) => {
            event.preventDefault();
            setNonce((n) => n + 1);
          }}
        >
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            aria-label="Preview URL"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] outline-none"
            style={{ color: "var(--vb-text)" }}
          />
        </form>
      </div>

      <div
        className="flex min-h-0 flex-1 justify-center overflow-auto p-2"
        style={{ background: "var(--vb-bg-void)" }}
      >
        <iframe
          ref={iframeRef}
          key={`${address}-${nonce}`}
          src={address}
          title="App preview"
          className={cx(
            "h-full rounded-[4px] border bg-white",
            width ? "" : "w-full",
          )}
          style={{
            borderColor: "var(--vb-line-faint)",
            width: width ?? undefined,
            maxWidth: "100%",
          }}
          // The preview runs the user's own local app; give it a normal
          // browsing sandbox rather than a locked-down one that would break
          // routing, storage, and auth flows in the app being previewed.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        />
      </div>
    </div>
  );
}

export default PreviewPanel;
