/**
 * Process entry for `bin/viberon`. Sets headless defaults *before* any
 * module that reads them at load time (the store) is imported.
 */

import path from "node:path";

if (process.argv[2] === "mcp") {
  // `viberon mcp` edits the user's MCP settings, so it must use the same
  // persistent store as the app: the repo root in a source checkout, or
  // VIBERON_STORE_DIR (the Electron user-data dir) when that is set.
  process.env.VIBERON_STORE_DIR ??= path.resolve(__dirname, "..");
} else {
  process.env.VIBERON_STORE ??= "memory";
}

void (async () => {
  if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
    try {
      const { spawnSync } = await import("node:child_process");
      const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
      if (gh.status === 0 && gh.stdout?.trim()) {
        process.env.GITHUB_TOKEN = gh.stdout.trim();
      }
    } catch {
      // gh not available
    }
  }
  const { main } = await import("./viberon");
  const code = await main(process.argv.slice(2));
  process.exit(code);
})().catch((error: unknown) => {
  process.stderr.write(`[viberon] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(2);
});
