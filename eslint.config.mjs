import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "dist/**",
      ".viberon-workspace/**",
      "next-env.d.ts",
      // Agent worktrees are full copies of the repo; they are linted on their own branch.
      ".claude/**",
      // Fixture repositories the harness is evaluated on, written in their own style.
      "eval/tasks/**",
    ],
  },
];

export default eslintConfig;
