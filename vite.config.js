import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
      // Disable console forwarding to avoid __SERVER_FORWARD_CONSOLE__ issue
      overlay: false,
    },
    // Disable server console forwarding
    watch: {
      usePolling: false,
    },
  },
  optimizeDeps: {
    exclude: ['vite'],
  },
  // Ensure proper module resolution
  resolve: {
    alias: {
      // Prevent any accidental imports of vite internals
    },
  },
});
