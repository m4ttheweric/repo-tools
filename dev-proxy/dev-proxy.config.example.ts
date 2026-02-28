import type { DevConfig } from "./lib";

const config: DevConfig = {
  repoDir: "/path/to/your/repo",
  // Optional: glob patterns to exclude worktrees by path
  // ignore: ["**/.cursor/worktrees/**"],

  // Define your apps — each gets a PORT_<NAME> env var in the Tiltfile
  apps: [
    { name: "api" },
    { name: "web", proxied: true, proxyPort: 4001 },
  ],

  // Define Tilt resources — use {repo} and {port_<name>} placeholders
  resources: [
    {
      name: "install",
      cmd: "cd {repo} && npm install",
      labels: ["setup"],
    },
    {
      name: "api",
      cmd: "cd {repo}/apps/api && PORT={port_api} npm start",
      cmdType: "serve",
      labels: ["apps"],
      deps: ["install"],
      links: ["http://localhost:{port_api}"],
    },
    {
      name: "web",
      cmd: "cd {repo}/apps/web && PORT={port_web} npm start",
      cmdType: "serve",
      labels: ["apps"],
      deps: ["install"],
      links: ["http://localhost:{port_web}"],
    },
    {
      name: "lint",
      cmd: "cd {repo} && npm run lint",
      labels: ["tools"],
      autoInit: false,
    },
  ],
};

export default config;
