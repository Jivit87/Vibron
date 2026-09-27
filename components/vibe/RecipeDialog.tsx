"use client";

/**
 * Pick a recipe and fill in its parameters, then run it.
 *
 * Opened by `/recipe` in the composer and "Run recipe…" in the command
 * palette (both dispatch `viberon:recipe`). The run itself streams into the
 * normal run view: the recipe shows up as a plan, one lane per step.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BookOpen, Loader2, Play, X } from "lucide-react";

import { runRecipe } from "@/lib/client/agent-stream";
import {
  checkParams,
  fetchRecipes,
  formToParams,
  initialForm,
  missingRequired,
  OPEN_RECIPE_EVENT,
  type OpenRecipeDetail,
} from "@/lib/client/recipes";
import { fuzzyScore } from "@/lib/composer/parsing";
import { formatIssue, type RecipeEntry, type RecipeIssue, type RecipeParam } from "@/lib/recipes/types";
import { useViberon } from "@/store/viberon";
import { cx, Kbd } from "@/components/vibe/primitives";

const STEP_KIND_LABEL = { agent: "agent", shell: "shell", verify: "verify" } as const;

export function RecipeDialog() {
  const repoKey = useViberon((s) => s.repoKey);
  const streaming = useViberon((s) => s.streaming);
  const fileList = useViberon((s) => s.fileList);

  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<RecipeEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string | boolean>>({});
  const [prefill, setPrefill] = useState<Record<string, string>>({});
  const [issues, setIssues] = useState<RecipeIssue[]>([]);
  const [checking, setChecking] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onOpen(event: Event) {
      const detail = (event as CustomEvent<OpenRecipeDetail>).detail ?? {};
      setOpen(true);
      setQuery("");
      setIssues([]);
      setSelected(detail.name ?? null);
      setPrefill(detail.params ?? {});
      setEntries(null);
      setLoadError(null);
      requestAnimationFrame(() => searchRef.current?.focus());
    }
    window.addEventListener(OPEN_RECIPE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_RECIPE_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchRecipes(repoKey)
      .then((list) => {
        if (cancelled) return;
        setEntries(list);
        setSelected((current) => current ?? list.find((e) => e.recipe)?.name ?? null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open, repoKey]);

  const visible = useMemo(() => {
    if (!entries) return [];
    if (!query.trim()) return entries;
    return entries
      .map((e) => ({ e, score: Math.max(fuzzyScore(e.name, query), fuzzyScore(e.recipe?.description ?? "", query) - 300) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.e);
  }, [entries, query]);

  const entry = entries?.find((e) => e.name === selected) ?? null;
  const recipe = entry?.recipe ?? null;

  // A new selection starts from its defaults (plus what `/recipe name k=v` prefilled).
  useEffect(() => {
    if (!recipe) return;
    setForm(initialForm(recipe, prefill));
    setIssues([]);
  }, [recipe, prefill]);

  if (!open) return null;

  function close() {
    setOpen(false);
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!recipe || !entry || checking || streaming) return;
    const missing = missingRequired(recipe, form);
    if (missing.length) {
      setIssues(missing.map((name) => ({ path: `params.${name}`, message: "is required" })));
      return;
    }
    const params = formToParams(recipe, form);
    setChecking(true);
    const problems = await checkParams(repoKey, entry.name, params).catch((error: unknown) => [
      { path: "", message: error instanceof Error ? error.message : String(error) },
    ]);
    setChecking(false);
    if (problems.length) {
      setIssues(problems);
      return;
    }
    setOpen(false);
    void runRecipe(entry.name, params);
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[10vh]"
      style={{ background: "rgba(0,0,0,0.25)" }}
      onMouseDown={close}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Run a recipe"
        className="vb-pop vb-in flex max-h-[76vh] w-full max-w-[760px] flex-col overflow-hidden rounded-[4px]"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3" style={{ borderColor: "var(--vb-line-faint)" }}>
          <BookOpen className="size-3.5" style={{ color: "var(--vb-text-dim)" }} />
          <span className="text-[12.5px]" style={{ color: "var(--vb-text-hi)" }}>
            Run a recipe
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="inline-flex size-5 items-center justify-center rounded-[3px] hover:bg-[var(--vb-hover)]"
            style={{ color: "var(--vb-text-dim)" }}
          >
            <X className="size-3.5" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* list */}
          <div className="flex w-[240px] shrink-0 flex-col border-r" style={{ borderColor: "var(--vb-line-faint)" }}>
            <div className="p-2">
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && visible[0]) {
                    e.preventDefault();
                    setSelected(visible[0].name);
                  }
                }}
                placeholder="Filter recipes"
                aria-label="Filter recipes"
                spellCheck={false}
                className="vb-input h-[26px] w-full text-[12px]"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-1" role="listbox" aria-label="Recipes">
              {!entries && !loadError && (
                <p className="flex items-center gap-1.5 px-3 py-2 text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
                  <Loader2 className="size-3 animate-spin" /> Loading
                </p>
              )}
              {loadError && (
                <p className="px-3 py-2 text-[12px]" style={{ color: "var(--vb-rose)" }}>
                  {loadError}
                </p>
              )}
              {entries && visible.length === 0 && (
                <p className="px-3 py-2 text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
                  No recipes match.
                </p>
              )}
              {visible.map((e) => (
                <button
                  key={e.name}
                  type="button"
                  role="option"
                  aria-selected={e.name === selected}
                  onClick={() => {
                    setSelected(e.name);
                    setPrefill({});
                  }}
                  className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left"
                  style={{ background: e.name === selected ? "var(--vb-accent-soft)" : undefined }}
                >
                  <span className="flex w-full items-center gap-1.5 text-[12.5px]" style={{ color: "var(--vb-text-hi)" }}>
                    <span className="truncate font-mono">{e.name}</span>
                    <span className="flex-1" />
                    <span className="text-[10.5px]" style={{ color: e.recipe ? "var(--vb-text-faint)" : "var(--vb-rose)" }}>
                      {e.recipe ? e.source : "invalid"}
                    </span>
                  </span>
                  {e.recipe && (
                    <span className="line-clamp-2 text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
                      {e.recipe.description}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* detail */}
          <form onSubmit={submit} className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
              {!entry && entries && (
                <p className="text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
                  {selected ? `No recipe named "${selected}".` : "Pick a recipe."}
                </p>
              )}
              {entry && !recipe && (
                <>
                  <p className="mb-1.5 text-[12.5px]" style={{ color: "var(--vb-text-hi)" }}>
                    <span className="font-mono">{entry.name}</span> is invalid
                  </p>
                  <p className="mb-2 truncate font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }} title={entry.path}>
                    {entry.path}
                  </p>
                  <ul className="space-y-1 font-mono text-[11.5px]" style={{ color: "var(--vb-rose)" }}>
                    {(entry.errors ?? []).map((issue, i) => (
                      <li key={i}>{formatIssue(issue)}</li>
                    ))}
                  </ul>
                </>
              )}
              {recipe && (
                <>
                  <div className="mb-0.5 flex items-baseline gap-2">
                    <span className="font-mono text-[13px]" style={{ color: "var(--vb-text-hi)" }}>
                      {recipe.name}
                    </span>
                    <span className="text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                      v{recipe.version} · {entry!.source}
                      {recipe.author ? ` · ${recipe.author}` : ""}
                    </span>
                  </div>
                  <p className="mb-3 text-[12px]" style={{ color: "var(--vb-text-mid)" }}>
                    {recipe.description}
                  </p>

                  {recipe.params.length > 0 && (
                    <div className="mb-3 flex flex-col gap-2">
                      {recipe.params.map((p) => (
                        <ParamField
                          key={p.name}
                          param={p}
                          value={form[p.name] ?? ""}
                          files={fileList}
                          issue={issues.find((i) => i.path === `params.${p.name}`)}
                          onChange={(v) => setForm((prev) => ({ ...prev, [p.name]: v }))}
                        />
                      ))}
                    </div>
                  )}

                  <p className="vb-label mb-1">Steps</p>
                  <ol className="mb-1 space-y-0.5">
                    {recipe.steps.map((s, i) => (
                      <li key={s.id} className="flex items-baseline gap-2 text-[12px]" style={{ color: "var(--vb-text-mid)" }}>
                        <span className="w-4 shrink-0 text-right font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                          {i + 1}
                        </span>
                        <span className="w-[42px] shrink-0 font-mono text-[10.5px]" style={{ color: "var(--vb-text-dim)" }}>
                          {STEP_KIND_LABEL[s.kind]}
                        </span>
                        <span className="min-w-0 truncate" title={s.title}>
                          {s.title}
                        </span>
                        {s.when && (
                          <span className="shrink-0 font-mono text-[10.5px]" style={{ color: "var(--vb-text-faint)" }}>
                            when {s.when}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>

                  {issues.filter((i) => !recipe.params.some((p) => i.path === `params.${p.name}`)).map((issue, i) => (
                    <p key={i} className="mt-2 text-[12px]" style={{ color: "var(--vb-rose)" }}>
                      {formatIssue(issue)}
                    </p>
                  ))}
                </>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-3 border-t px-3 py-2 text-[11px]" style={{ borderColor: "var(--vb-line-faint)", color: "var(--vb-text-faint)" }}>
              <span className="truncate">
                Recipes live in <span className="font-mono">.viberon/recipes/</span> and <span className="font-mono">~/Viberon/recipes/</span>
              </span>
              <div className="flex-1" />
              <span className="flex shrink-0 items-center gap-1">
                <Kbd>esc</Kbd> close
              </span>
              <button
                type="submit"
                className="vb-btn vb-btn-primary h-[26px] shrink-0"
                disabled={!recipe || checking || streaming}
                title={streaming ? "A run is already in progress" : "Run this recipe"}
              >
                {checking ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                Run
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

function ParamField({
  param,
  value,
  files,
  issue,
  onChange,
}: {
  param: RecipeParam;
  value: string | boolean;
  files: string[];
  issue?: RecipeIssue;
  onChange: (value: string | boolean) => void;
}) {
  const id = `recipe-param-${param.name}`;
  const listId = `${id}-files`;
  const label = (
    <label htmlFor={id} className="flex items-baseline gap-1.5 text-[12px]" style={{ color: "var(--vb-text)" }}>
      <span className="font-mono">{param.name}</span>
      {param.required && <span style={{ color: "var(--vb-amber)" }}>required</span>}
      <span className="text-[10.5px]" style={{ color: "var(--vb-text-faint)" }}>
        {param.type}
      </span>
    </label>
  );
  return (
    <div className="flex flex-col gap-0.5">
      {param.type === "boolean" ? (
        <div className="flex items-center gap-2">
          <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          {label}
        </div>
      ) : (
        <>
          {label}
          {param.type === "enum" ? (
            <select
              id={id}
              value={String(value)}
              onChange={(e) => onChange(e.target.value)}
              className="vb-input h-[26px] text-[12px]"
            >
              {!param.required && param.default === undefined && <option value="">(none)</option>}
              {param.values?.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ) : (
            <>
              <input
                id={id}
                value={String(value)}
                onChange={(e) => onChange(e.target.value)}
                inputMode={param.type === "number" ? "decimal" : undefined}
                list={param.type === "path" ? listId : undefined}
                spellCheck={false}
                placeholder={param.default !== undefined ? String(param.default) : param.type === "path" ? "src/file.ts" : ""}
                className={cx("vb-input h-[26px] text-[12px]", param.type === "path" && "font-mono")}
              />
              {param.type === "path" && (
                <datalist id={listId}>
                  {files.slice(0, 2000).map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
              )}
            </>
          )}
        </>
      )}
      {param.description && (
        <p className="text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
          {param.description}
        </p>
      )}
      {issue && (
        <p className="text-[11px]" style={{ color: "var(--vb-rose)" }}>
          {param.name} {issue.message}
        </p>
      )}
    </div>
  );
}
