import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.next/**", "**/.next-redesign/**", "**/.next-landing/**", "**/.next-build/**", ".agents/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // A leading underscore marks a deliberately unused parameter.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
