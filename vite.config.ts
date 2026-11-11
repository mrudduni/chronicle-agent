import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI is served by Vite on :5173 and talks to the API server on :8787.
// Proxying /api keeps the browser on one origin, so there is no CORS setup.
const apiPort = process.env.API_PORT ?? "8787";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: `http://localhost:${apiPort}`, changeOrigin: true },
    },
  },
});
