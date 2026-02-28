import type { DevConfig } from "./lib";

const config: DevConfig = {
  repoDir: "/path/to/your/repo",
  // Optional: glob patterns to exclude worktrees by path
  // ignore: ["**/.cursor/worktrees/**"],
  // Optional: override default proxy ports (4001, 4002)
  // proxy: {
  //   adjuster: 4001,
  //   frontend: 4002,
  // },
};

export default config;
