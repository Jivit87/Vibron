import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Server-only packages that must not be bundled into route handlers.
  serverExternalPackages: ["firebase-admin", "@babel/parser", "@babel/traverse", "tar"],
  // Electron loads the app from localhost; keep dev indicators out of the way.
  devIndicators: false,
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
