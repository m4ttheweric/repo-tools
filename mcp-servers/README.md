# mcp-servers

MCP servers registered in Cursor. Each server is a standalone Node.js ESM module using `@modelcontextprotocol/sdk`.

## link-repo-tools-mcp

Manages `link-specs.json` config files — add, remove, and list symlink specs via AI.

Registered globally in `~/.cursor/mcp.json` as `link-repo-tools`.

**Tools:** `list_repos`, `list_specs`, `add_spec`, `remove_spec`, `list_source_files`

## local-db-mcp

Queries the local Postgres development database. Registered in the workspace `.cursor/mcp.json` as `local-db`. Runs via `doppler run` to inject database credentials.

**Tools:** `query`, `list_tables`, `describe_table`
