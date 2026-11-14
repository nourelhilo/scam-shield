import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["node_modules/**", ".data/**", ".cache/**", "coverage/**", "ml/.venv/**", "ml/data/**"] },
  {
    files: ["checker.js", "reset-password.js"],
    languageOptions: { globals: globals.browser, sourceType: "script" },
    ...js.configs.recommended,
  },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // Test-only worker fixtures that simulate hangs/crashes.
    files: ["tests/fixtures/**/*.mjs"],
    languageOptions: { globals: globals.node, sourceType: "module" },
    ...js.configs.recommended,
  },
  {
    files: ["server/scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
);
