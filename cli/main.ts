/**
 * Process entry for `bin/viberon`. Sets headless defaults *before* any
 * module that reads them at load time (the store) is imported.
 */

process.env.VIBERON_STORE ??= "memory";

void (async () => {
  const { main } = await import("./viberon");
  const code = await main(process.argv.slice(2));
  process.exit(code);
})().catch((error: unknown) => {
  process.stderr.write(`[viberon] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(2);
});
