/**
 * Runs once when the Next server starts. Starts the issue auto-fix poller so
 * a watched repo keeps being served after a restart, not only once someone
 * opens the Issues panel.
 *
 * The runtime check must wrap the import directly (Next's documented form):
 * this file is also compiled for the edge runtime, which cannot bundle the
 * Node-only store behind the poller.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
