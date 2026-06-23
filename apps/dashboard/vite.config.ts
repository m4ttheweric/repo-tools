import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Read the daemon's local API token fresh each request (it may be regenerated). */
function apiToken(): string {
  try {
    return readFileSync(join(homedir(), ".rt", "api-token"), "utf8").trim();
  } catch {
    return "";
  }
}

// The browser app talks to same-origin /api and /ws; this proxy forwards to the
// daemon on 127.0.0.1:9401 and injects the X-RT-Token header so control routes
// work without the token ever reaching the browser. Sidesteps CORS too.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": resolve(__dirname, "./src") },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:9401",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            const t = apiToken();
            if (t) proxyReq.setHeader("x-rt-token", t);
          });
        },
      },
      "/ws": {
        target: "ws://127.0.0.1:9401",
        ws: true,
        changeOrigin: true,
        configure: (proxy) => {
          // Inject the token on the WS handshake — the interactive attach socket
          // is token-gated (input = code exec), and browsers can't set WS headers
          // themselves. Read-only log sockets ignore it.
          proxy.on("proxyReqWs", (proxyReq) => {
            const t = apiToken();
            if (t) proxyReq.setHeader("x-rt-token", t);
          });
        },
      },
    },
  },
});
