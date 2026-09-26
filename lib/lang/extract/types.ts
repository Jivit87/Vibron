/**
 * Per-file extraction results. A file is parsed once into a `FileExtract`
 * (symbols, unresolved imports, unresolved calls); linking those into graph
 * edges is a separate, cheap pass. That split is what makes the graph
 * incremental: a write re-extracts one file and re-links, never re-parses
 * the repo.
 */

import type { GraphNode } from "@/lib/graph";

export type SourceLanguage = "js" | "python" | "go" | "rust" | "java";

export interface ExtractedImport {
  /** Raw module request as written (`./util`, `pkg.mod`, `crate::a::b`, `a.b.C`). */
  request: string;
  /** local name → imported name. */
  specifiers: [string, string][];
  /** Local names that refer to the whole module (`import * as x`, `import pkg`). */
  namespaces: string[];
  /** Every name from the target is visible unqualified (`from x import *`, Go same package). */
  wildcard?: boolean;
}

export interface ExtractedCall {
  /** Node id of the enclosing symbol. */
  from: string;
  calleeName: string;
  namespace?: string;
}

export interface FileExtract {
  path: string;
  /** Content hash of the source this extract was built from. */
  hash: string;
  lang: SourceLanguage;
  nodes: GraphNode[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  error?: string;
}
