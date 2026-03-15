import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
} from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_TOOLS_DIR = resolve(__dirname, "../../");
const REPOS_DIR = join(REPO_TOOLS_DIR, "repos");

// ── Helpers ──────────────────────────────────────────────────────────────────

function specsPath(repo) {
  return join(REPOS_DIR, repo, "link-specs.json");
}

function readSpecs(repo) {
  try {
    return JSON.parse(readFileSync(specsPath(repo), "utf8"));
  } catch {
    return null;
  }
}

function writeSpecs(repo, specs) {
  writeFileSync(specsPath(repo), JSON.stringify(specs, null, 2) + "\n", "utf8");
}

function listRepos() {
  try {
    return readdirSync(REPOS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function listSourceFiles(repo) {
  const repoDir = join(REPOS_DIR, repo);
  try {
    return readdirSync(repoDir, { withFileTypes: true })
      .filter((d) => d.name !== "link-specs.json" && d.name !== ".DS_Store")
      .map((d) => ({
        name: d.name,
        type: d.isDirectory() ? "directory" : "file",
      }));
  } catch {
    return [];
  }
}

function symlinkedStatus(repo) {
  const specs = readSpecs(repo) ?? [];
  return specs.map((spec) => {
    const symlinkPath = join(REPOS_DIR, repo, spec.sourcePath);
    let sourceExists = false;
    try {
      sourceExists = existsSync(symlinkPath);
    } catch {}
    return { ...spec, sourceExists };
  });
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "link-repo-tools",
  version: "1.0.0",
  description:
    "Manages the link-repo-tools setup — the personal local tooling system that wires " +
    "scripts, hooks, configs, and other files into repos via symlinks without leaving " +
    "any git footprint. Use this server whenever the user wants to: add new local tooling " +
    "to a repo, wire something into a repo, hook something up to a repo, set up a new " +
    "local script or config in a repo, see what local tools are linked into a repo, " +
    "inspect or modify link-specs.json, or manage symlinks between repo-tools and a repo.",
});

// ── list_repos ────────────────────────────────────────────────────────────────

server.tool(
  "list_repos",
  "List all repos that have a link-repo-tools config. " +
    "Use when the user asks: what repos are set up, what repos are configured in repo-tools, " +
    "which repos have local tooling, show me all managed repos.",
  {},
  async () => {
    const repos = listRepos();
    const result = repos.map((repo) => {
      const hasSpecs = existsSync(specsPath(repo));
      const specs = hasSpecs ? (readSpecs(repo) ?? []) : [];
      return { repo, hasSpecs, specCount: specs.length };
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ── list_specs ────────────────────────────────────────────────────────────────

server.tool(
  "list_specs",
  "List all link specs for a repo — the symlinks currently wired into it from repo-tools. " +
    "Use when the user asks: what's linked into a repo, what local tools are set up, " +
    "what symlinks does repo-tools manage, show me what's wired in, what's in link-specs.json.",
  { repo: z.string().describe("Repo name, e.g. 'assured-dev'") },
  async ({ repo }) => {
    const specs = readSpecs(repo);
    if (specs === null) {
      return {
        content: [
          {
            type: "text",
            text: `No link-specs.json found for repo '${repo}'. Available repos: ${listRepos().join(", ")}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(specs, null, 2) }],
    };
  },
);

// ── add_spec ──────────────────────────────────────────────────────────────────

server.tool(
  "add_spec",
  "Add a new symlink spec to a repo's link-repos-tools config. " +
    "repoPath is where the symlink will appear in the repo (relative to repo root). " +
    "sourcePath is the source file or directory inside repos/<repo>/ (relative to that dir). " +
    "After adding, the user must run link-repo-tools.ts to apply the symlink. " +
    "Use when the user wants to: wire up a new file or script into a repo, add local tooling " +
    "to a repo, hook something up via repo-tools, add a new link, register a new local config " +
    "or script so it appears in the repo without being tracked by git.",
  {
    repo: z.string().describe("Repo name, e.g. 'assured-dev'"),
    repoPath: z
      .string()
      .describe(
        "Symlink destination path relative to repo root, e.g. 'apps/backend/.tsc-baseline.json'",
      ),
    sourcePath: z
      .string()
      .describe(
        "Source path relative to repos/<repo>/, e.g. 'tsgo-type-check/backend.tsc-baseline.json'",
      ),
    description: z
      .string()
      .optional()
      .describe("Human-readable description of what this link provides"),
  },
  async ({ repo, repoPath, sourcePath, description }) => {
    const specs = readSpecs(repo);
    if (specs === null) {
      return {
        content: [
          {
            type: "text",
            text: `No link-specs.json found for repo '${repo}'. Create repos/${repo}/link-specs.json first.`,
          },
        ],
        isError: true,
      };
    }

    if (specs.some((s) => s.repoPath === repoPath)) {
      return {
        content: [
          {
            type: "text",
            text: `A spec with repoPath '${repoPath}' already exists in ${repo}.`,
          },
        ],
        isError: true,
      };
    }

    const newSpec = { repoPath, sourcePath, ...(description ? { description } : {}) };
    specs.push(newSpec);
    writeSpecs(repo, specs);

    return {
      content: [
        {
          type: "text",
          text: `Added spec to repos/${repo}/link-specs.json:\n${JSON.stringify(newSpec, null, 2)}\n\nRun link-repo-tools.ts to apply.`,
        },
      ],
    };
  },
);

// ── remove_spec ───────────────────────────────────────────────────────────────

server.tool(
  "remove_spec",
  "Remove a symlink spec from a repo's link-repo-tools config by its repoPath. " +
    "Does not remove any already-created symlinks from the repo itself — the user must do that manually. " +
    "Use when the user wants to: remove a link, unwire something from a repo, delete a spec, " +
    "stop managing a file via repo-tools.",
  {
    repo: z.string().describe("Repo name, e.g. 'assured-dev'"),
    repoPath: z
      .string()
      .describe("The repoPath of the spec to remove, e.g. 'apps/backend/tsconfig.tsgo.json'"),
  },
  async ({ repo, repoPath }) => {
    const specs = readSpecs(repo);
    if (specs === null) {
      return {
        content: [{ type: "text", text: `No link-specs.json found for repo '${repo}'.` }],
        isError: true,
      };
    }

    const before = specs.length;
    const updated = specs.filter((s) => s.repoPath !== repoPath);

    if (updated.length === before) {
      return {
        content: [
          {
            type: "text",
            text: `No spec with repoPath '${repoPath}' found in ${repo}.`,
          },
        ],
        isError: true,
      };
    }

    writeSpecs(repo, updated);

    return {
      content: [
        {
          type: "text",
          text: `Removed spec '${repoPath}' from repos/${repo}/link-specs.json.\n\nNote: any existing symlink at that path in the repo was not removed.`,
        },
      ],
    };
  },
);

// ── list_source_files ─────────────────────────────────────────────────────────

server.tool(
  "list_source_files",
  "List the files and directories available inside repos/<repo>/ in repo-tools — " +
    "these are the source assets that can be linked into a repo as sourcePath values. " +
    "Use when the user asks: what can I link into a repo, what source files are available, " +
    "what's in the repo-tools config for this repo, show me what I can wire in.",
  { repo: z.string().describe("Repo name, e.g. 'assured-dev'") },
  async ({ repo }) => {
    const repoDir = join(REPOS_DIR, repo);
    if (!existsSync(repoDir)) {
      return {
        content: [{ type: "text", text: `No config directory found for repo '${repo}'.` }],
        isError: true,
      };
    }
    const files = listSourceFiles(repo);
    return {
      content: [{ type: "text", text: JSON.stringify(files, null, 2) }],
    };
  },
);

// ── Transport ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
