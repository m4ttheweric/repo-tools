# mcp-servers

MCP servers for AI agents. Each server is a standalone Bun-executable TypeScript module using `@modelcontextprotocol/sdk`.

## link-repo-tools-mcp

Manages `link-specs.json` config files — add, remove, and list symlink specs via AI.

Registered globally in `~/.cursor/mcp.json` as `link-repo-tools`.

**Tools:** `list_repos`, `list_specs`, `add_spec`, `remove_spec`, `list_source_files`

**Start:** `bun run server.ts`

## local-db-mcp

Queries the local Postgres development database. Registered in the workspace `.cursor/mcp.json` as `local-db`. Runs via `doppler run` to inject database credentials.

**Tools:** `query`, `list_tables`, `describe_table`

**Start:** `bun run server.ts`

## assured-gitlab-ci-mcp

Inspects GitLab CI pipelines for the assured/assured-dev repo. Knows the two-pipeline structure (branch pipeline + MR pipeline with a dynamic-tests child pipeline) so agents go straight to the right place without fumbling through `glab` flags.

Registered globally in `~/.cursor/mcp.json` as `assured-gitlab-ci`. Requires `glab` on PATH (authenticated).

**Tools:** `find_pipelines`, `get_mr_pipelines`, `get_pipeline_jobs`, `get_job_log`

**Start:** `bun run server.ts`

## phased-plan-mcp

Manages phased execution plans for complex multi-session work. Breaks large tasks into phases with structured docs (setup, steps, wiring checks, teardown, next-agent prompt) that different agent sessions can execute independently.

Plans are stored in the user's project directory so they appear in the IDE file tree. A global index at `~/.phased-plans/index.json` tracks all plans across repos.

**Tools:** `create_plan`, `list_plans`, `get_plan_status`, `get_phase`, `start_phase`, `complete_phase`, `reset_phase`, `get_next_prompt`, `add_phase`, `update_phase_doc`, `delete_plan`

**Start:** `bun run server.ts`

**Setup:** run `bun install` once in `mcp-servers/phased-plan-mcp/` after cloning.

## MCP Configuration

Each server is registered in the IDE's MCP config as:

```json
{
  "command": "bun",
  "args": ["run", "/absolute/path/to/mcp-servers/<server>/server.ts"]
}
```
