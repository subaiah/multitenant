import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

// The web app only (src/). The API has its own type check and tests.
export default tseslint.config(
  { ignores: ["dist/**", "backend/**", "clients/**", "e2e/**", "deploy/**", "public/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // A leading underscore marks a parameter kept for its position
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // The React Compiler's rules. The existing pages predate them (state set
      // in effects, Date.now() while rendering): shown as warnings to work
      // down, not errors. New code should not add to them.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
    },
  },
);
