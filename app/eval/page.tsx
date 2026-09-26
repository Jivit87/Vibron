import type { Metadata } from "next";

import { EvalView } from "@/components/vibe/EvalView";

export const metadata: Metadata = { title: "Eval results · Viberon" };

export default function EvalPage() {
  return <EvalView />;
}
