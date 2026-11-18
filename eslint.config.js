import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "web/vite.config.ts",
      "core/vitest.config.ts",
    ],
  },
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.js", "core/scripts/*.mjs"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Motion correctness lives in core/: no silent any-casting through numeric bugs.
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/only-throw-error": "off",
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
  { files: ["**/*.test.ts"], rules: { "@typescript-eslint/no-unsafe-member-access": "off" } },
];
