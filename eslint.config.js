import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["node_modules/**", ".data/**", ".cache/**", "coverage/**"] },
  {
    // Frontend files belong to the frontend owner; lint them only for syntax errors.
    files: ["checker.js"],
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
    files: ["server/scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
);
