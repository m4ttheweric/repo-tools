# phased-plan-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server for managing phased execution plans across AI agent sessions.

Break large, multi-session tasks into structured phases — each with setup, steps, wiring checks, teardown, and a pre-built handoff prompt for the next agent.

## Features

- **Phased Plans** — Break complex work into ordered phases with dependency tracking
- **Structured Phase Docs** — Each phase generates a markdown document with setup, steps (with commit suggestions), wiring checks, teardown, and next-agent prompts
- **Cross-Session Handoff** — `get_next_prompt` generates a ready-to-paste prompt for the next agent session with full context from completed phases
- **Validation Gates** — `expected_counts`, `required_paths`, and `wiring_checks` prevent premature phase completion
- **Global Index** — Plans are tracked across repos via `~/.phased-plans/index.json`
- **IDE Integration** — Plans are stored in your project directory so they appear in your file tree

## Installation

### Using npx (recommended)

No installation needed — configure your MCP client to run it directly:

```json
{
  "mcpServers": {
    "phased-plan": {
      "command": "npx",
      "args": ["-y", "phased-plan-mcp"]
    }
  }
}
```

### Global install

```bash
npm install -g phased-plan-mcp
```

Then configure your MCP client:

```json
{
  "mcpServers": {
    "phased-plan": {
      "command": "phased-plan-mcp"
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `create_plan` | Create a new phased execution plan with STATUS.json and phase markdown docs |
| `list_plans` | List all plans across repos with progress summary |
| `get_plan_status` | Get detailed status of a specific plan |
| `get_phase` | Read the full markdown document for a phase |
| `start_phase` | Mark a phase as IN_PROGRESS (checks dependencies first) |
| `complete_phase` | Mark a phase as DONE (validates gates: expected_counts, required_paths, wiring_checks) |
| `reset_phase` | Reset a phase back to NOT_STARTED |
| `get_next_prompt` | Generate a handoff prompt for the next agent session |
| `add_phase` | Add a new phase to an existing plan |
| `update_phase_doc` | Replace the content of a phase document |
| `delete_plan` | Remove a plan from the index (optionally delete files) |
| `plan_from_doc` | Read an implementation plan doc and get guidance for decomposing it into phases |

## Typical Workflow

```
1. Agent writes implementation_plan.md
2. User approves the plan
3. Agent calls plan_from_doc → get decomposition guidance
4. Agent calls create_plan → generates phase docs
5. For each phase:
   a. start_phase → marks IN_PROGRESS
   b. Execute steps (with incremental commits)
   c. Run wiring checks
   d. complete_phase → marks DONE with context snapshot
6. get_next_prompt → generates handoff for next session
```

## Phase Document Structure

Each generated phase doc includes:

- **Setup** — Verify prerequisites, clean git state, mark phase started
- **Steps** — Ordered work items with commit suggestions after each
- **Wiring Check** — Verification items agents commonly forget
- **Teardown** — Context snapshot commands for state capture
- **Verification** — Final validation checklist
- **Next Agent Prompt** — Pre-built prompt for the next session

## Validation Gates

Phases can define guardrails that prevent premature completion:

- **`expected_counts`** — Numeric ranges for context_snapshot values (e.g., `{ key: "tests", min: 5 }`)
- **`required_paths`** — Files/directories that must exist on disk
- **`wiring_checks`** — Agent must attest all wiring checks passed (`wiring_checks_passed: true`)

## License

MIT
