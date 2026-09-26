"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface AssistantMessageProps {
  content: string;
}

/**
 * The assistant's reply as flowing prose with GitHub-flavored markdown.
 * Styling comes from `.vb-prose`; only fenced code gets a custom frame so it
 * can carry a language label and a copy action.
 */
const components: Components = {
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  code: ({ className, children, ...props }) => {
    const text = String(children).replace(/\n$/, "");
    const isBlock = (className && className.startsWith("language-")) || text.includes("\n");
    if (!isBlock) return <code {...props}>{children}</code>;

    const lang = className?.replace("language-", "") || "";
    return (
      <span
        className="my-2 block overflow-hidden rounded-[4px] border"
        style={{ borderColor: "var(--vb-line)", background: "var(--vb-bg-void)" }}
      >
        <span
          className="flex h-[24px] items-center justify-between border-b px-2.5"
          style={{ borderColor: "var(--vb-line)" }}
        >
          <span className="font-mono text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
            {lang || "text"}
          </span>
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(text).catch(() => {})}
            className="text-[11px] hover:underline"
            style={{ color: "var(--vb-text-dim)" }}
          >
            Copy
          </button>
        </span>
        <span
          className="block overflow-x-auto whitespace-pre px-3 py-2 font-mono text-[12px] leading-[1.55]"
          style={{ color: "var(--vb-text)" }}
        >
          {text}
        </span>
      </span>
    );
  },
  pre: ({ children }) => <>{children}</>,
};

export function AssistantMessage({ content }: AssistantMessageProps) {
  if (!content) {
    return (
      <span className="vb-pulse text-[12.5px]" style={{ color: "var(--vb-text-dim)" }}>
        Working…
      </span>
    );
  }
  return (
    <div className="vb-prose w-full break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default AssistantMessage;
