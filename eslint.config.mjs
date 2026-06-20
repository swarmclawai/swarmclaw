import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent-generated workspace and runtime data
    "data/**",
    "artifacts/**",
    ".workbench/**",
    ".tmp-*/**",
    // Git worktrees (created by parallel agent workflows)
    ".worktrees/**",
    // Electron build output (compiled from electron/*.ts)
    "electron-dist/**",
    "release/**",
  ]),
  // Prevent console.* in server-side code — use `import { log } from '@/lib/server/logger'` instead.
  {
    files: ["src/lib/server/**/*.ts", "src/lib/providers/**/*.ts", "src/app/api/**/*.ts", "src/instrumentation.ts"],
    ignores: ["**/*.test.ts", "src/lib/server/logger.ts"],
    rules: {
      "no-console": "warn",
    },
  },
]);

export default eslintConfig;
