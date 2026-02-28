import type { DevConfig } from "./lib";

const config: DevConfig = {
  repoDir: "/path/to/your/repo",
  // Optional: glob patterns to exclude worktrees by path
  // ignore: ["**/.cursor/worktrees/**"],

  // One-shot setup tasks (run once, then done)
  setup: [
    {
      name: "install",
      cmd: "cd {repo} && npm install",
    },
  ],

  // Long-running app servers — use {port} for own port, {port_<name>} to cross-reference
  apps: [
    {
      name: "api",
      cmd: "cd {repo}/apps/api && PORT={port} npm start",
      deps: ["install"],
      links: ["http://localhost:{port}"],
    },
    {
      name: "web",
      cmd: "cd {repo}/apps/web && PORT={port} npm start",
      proxy: { port: 4001 },
      deps: ["install"],
      links: ["http://localhost:{port}"],
    },
  ],

  // Manual-trigger tools (autoInit: false)
  tools: [
    {
      name: "lint",
      cmd: "cd {repo} && npm run lint",
    },
  ],
};

export default config;
