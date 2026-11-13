import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Unit tests for the web app (npm test). Files named *.test.ts(x) next to
// what they test; a browser-like environment for the ones that render.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
