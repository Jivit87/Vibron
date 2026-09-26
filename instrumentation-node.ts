/** Node-only server start hook (see instrumentation.ts). */
import { ensureIssueWatchers } from "@/lib/issues/watch";

ensureIssueWatchers();
