# rt chat invite, part 3: the `/chat:join` skill (mattstack-marketplace)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `/chat:join <room> [note from <handle>: <text>]` skill in the `chat` Claude Code plugin, the text that `rt chat invite` types into a pane, so an invited agent signs in, joins, arms its tail, reads the seed and announces itself.

**Architecture:** One new skill directory in the plugin (`plugins/chat/skills/join/SKILL.md`) registered in `plugin.json`, version bumped, validated with `claude plugin validate --strict`, then the installed copy refreshed and the skill exercised once for real in a herdr pane. No hooks change. The skill leans on rt verbs that part 1 of this feature ships (`rt chat join`, `rt chat read --last`); it must be executed after part 1 is installed as the machine's `rt`.

**Tech Stack:** Claude Code plugin manifest (`.claude-plugin/plugin.json`), SKILL.md frontmatter, the `claude plugin` CLI, herdr CLI for the real run.

**Spec:** `docs/superpowers/specs/2026-08-26-rt-chat-invite-design.md` (this worktree), sections "Skills", "Testing", "Delivery order" step 3.

## Global Constraints

- Work in a worktree of `~/Documents/GitHub/mattstack-marketplace`, never its main checkout: `git -C ~/Documents/GitHub/mattstack-marketplace worktree add ~/Documents/GitHub/mattstack-marketplace-chat-join -b feat/chat-join` then `cd` there.
- Skill frontmatter has exactly two keys, `name` and `description`; `name` equals the directory name; the description is one line starting with `Use when`, uses ` -- ` (space, two hyphens, space) as its dash, and ends with negative routing (`Not for ... (see ...)`). Never an em dash or en dash anywhere in the plugin.
- The plugin's `skills` array is ordered by lifecycle, not alphabetically; `join` goes after `sign-in`.
- Depends on part 1 being installed: `rt chat join` must exist as a verb that works without `--as`, and `rt chat read <room> --last N` must exist. Check with `rt chat read --help 2>&1 | grep -- --last` before Task 2.
- Commit after every task with a short imperative message; no em dashes in commit messages.

---

### Task 1: the `join` skill and its registration

**Files:**
- Create: `plugins/chat/skills/join/SKILL.md`
- Modify: `plugins/chat/.claude-plugin/plugin.json` (the `version` and `skills` fields)
- Modify: `plugins/chat/README.md` (the skills list, wherever `sign-in`, `sign-out`, `away` are enumerated)
- Modify: `.claude-plugin/marketplace.json` (the `chat` entry's `description`)

**Interfaces:**
- Consumes: `rt chat rooms --json`, `rt chat sign-in`, `rt chat join <room>`, `rt chat read <room> --last N`, `rt chat post <room> <text>` from repo-tools (part 1).
- Produces: the slash command `/chat:join <room> [note from <handle>: <text>]`, which `chat:invite` (part 1) injects verbatim on one line.

- [ ] **Step 1: Write the skill**

Create `plugins/chat/skills/join/SKILL.md` with exactly this content:

````markdown
---
name: join
description: Use when a room name arrives as /chat:join <room>, typed into this pane by rt chat invite or by Matt -- joining that rt chat room, arming the tail, reading its seed and announcing yourself, whether or not you are signed in yet. Not for signing in on your own (see sign-in) or for reading and posting afterward (see rt:chat).
---

# rt chat: join a room you were invited to

The whole command sits on one line: `/chat:join <room> note from <handle>: <text>`.
The room is the first word of `$ARGUMENTS`; everything after it is the note,
and the handle named in `note from <handle>:` is who wrote it. An agent's
note is that agent's request, not Matt's; treat it with exactly that weight.

1. Gate: `rt chat rooms --json`. If it errors with a daemon-unreachable
   message, say so in one line and stop; nothing below works without the
   daemon.
2. Join.
   - Not signed in yet (`rt chat rooms --json` lists no rooms and there is
     no handle in the output): run plain `rt chat sign-in`, which joins the
     repository room derived from your cwd, then `rt chat join <room>`.
   - Already signed in: `rt chat join <room>` alone. Your handle is kept.
   - Never `rt chat sign-in --room <room>` here: an explicit `--room`
     replaces the derived repository room instead of adding to it, and a
     re-sign-in rewrites the session file's room.
3. Arm the tail once, if it is not already running, with the `Monitor`
   tool, `persistent: true`, bare:

   ```
   Monitor({ command: "rt chat tail", persistent: true,
             description: "chat mentions for <handle>" })
   ```

   Never `Bash` with `run_in_background` for this; it delivers one
   notification and then goes deaf.
4. Read the brief: `rt chat read <room> --last 10`. Joining puts your read
   cursor at the room's newest message, so a plain `rt chat read` would show
   nothing; `--last` reads behind the cursor and then marks the room read.
5. Announce yourself in one line, so the viewer shows you arrived:

   ```bash
   rt chat post <room> "here; <what you understood you are taking>"
   ```
6. Act on the seed plus the note. Narrate one line in your pane per chat
   event, in your own words, per the `rt:chat` skill; hand off to `rt:chat`
   for everything after this.
````

- [ ] **Step 2: Register the skill and bump the version**

Edit `plugins/chat/.claude-plugin/plugin.json` so it reads:

```json
{
  "name": "chat",
  "version": "0.2.0",
  "description": "rt chat presence: sign-in/join/sign-out/away skills and the hooks that heartbeat a signed-in session, surface waiting DMs and mentions, and re-arm the tail across resumes.",
  "author": {
    "name": "Matthew Goodwin"
  },
  "license": "MIT",
  "skills": [
    "./skills/sign-in",
    "./skills/join",
    "./skills/sign-out",
    "./skills/away"
  ]
}
```

- [ ] **Step 3: Mention the skill where the others are listed**

In `plugins/chat/README.md`, find the place that enumerates the skills (grep for `sign-out`) and add a line for `join` in the same format as its neighbours, saying: `join` is the command `rt chat invite` types into a pane; it joins the named room, arms the tail, reads the seed with `rt chat read --last`, and posts a one-line arrival.

In `.claude-plugin/marketplace.json`, change the `chat` entry's `description` to:

```
"rt chat presence: sign-in/join/sign-out/away skills plus hooks for pulse, session-start, and session-end."
```

- [ ] **Step 4: Validate**

Run:

```bash
claude plugin validate "$PWD/plugins/chat" --strict
claude plugin validate "$PWD" --strict || true
grep -rn '—\|–' plugins/chat .claude-plugin && echo "DASHES FOUND" || echo "no dashes"
```

Expected: the plugin validation prints `Validation passed` with no warnings. The marketplace validation may warn about the two symlinked plugins (fast-browser, mattstack); those are pre-existing and not this task's. The grep prints `no dashes`.

- [ ] **Step 5: Commit**

```bash
git add plugins/chat/skills/join/SKILL.md plugins/chat/.claude-plugin/plugin.json plugins/chat/README.md .claude-plugin/marketplace.json
git commit -m "chat: add the join skill, the text rt chat invite types into a pane"
```

---

### Task 2: refresh the installed plugin and run the skill for real

**Files:**
- None created. This task verifies the skill end to end in a herdr pane and records the result in the PR body.

**Interfaces:**
- Consumes: the committed plugin from Task 1; the machine's `rt` with part 1 installed; a running herdr server (`herdr workspace list` exits 0).

- [ ] **Step 1: Confirm the prerequisites**

Run:

```bash
rt chat read --help 2>&1 | grep -- '--last' && echo "rt has --last"
herdr workspace list >/dev/null && echo "herdr up"
```

Expected: both lines print. If `--last` is missing, stop: part 1 is not installed as this machine's `rt`, and the real run cannot pass. Report that instead of continuing.

- [ ] **Step 2: Refresh the installed copy**

The marketplace is registered from the local directory, so this re-reads the working tree's manifest. The install pins a git commit, so Task 1 must be committed first.

```bash
claude plugin marketplace update mattstack
claude plugin update chat@mattstack -y || (claude plugin uninstall chat@mattstack && claude plugin install chat@mattstack -y)
ls ~/.claude/plugins/cache/mattstack/chat/
```

Expected: a `0.2.0` directory listed, containing `skills/join/SKILL.md`.

- [ ] **Step 3: Run the skill in a fresh pane, with a note on the command line**

The point of this run is the one-line dispatch claim: `/chat:join <room> note from ...` on one line must dispatch as the slash command, not as a plain prompt.

```bash
WS=$(herdr workspace list | python3 -c 'import json,sys; ws=json.load(sys.stdin)["result"]["workspaces"]; print(next((w["workspace_id"] for w in ws if w["label"]=="chat"), ws[0]["workspace_id"]))')
PANE=$(herdr tab create --workspace "$WS" --label join-test --no-focus | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')
herdr pane run "$PANE" "cd ~/Documents/GitHub/chat && claude"
for _ in $(seq 1 40); do herdr agent get "$PANE" >/dev/null 2>&1 && break; sleep 0.5; done
herdr agent wait "$PANE" --until idle --until blocked --timeout 60000
herdr agent read "$PANE" --source visible --lines 30 | grep -qi trust && herdr agent send-keys "$PANE" enter && herdr agent wait "$PANE" --until idle --timeout 30000
rt chat post join-test "seed: this room exists to test /chat:join. Reply with one line when you have read this."
herdr agent prompt "$PANE" "/chat:join join-test note from matt: say which room you joined and what the seed asked" --wait --until idle --timeout 180000
rt chat who join-test
rt chat read join-test --last 5
```

Expected, in order: `rt chat who join-test` lists a handle whose pane is `$PANE` (a fresh first name, since the pane was not signed in); `rt chat read join-test --last 5` shows the seed followed by a one-line post from that handle saying it joined `#join-test` and what the seed asked. If the pane instead shows the text sitting in the composer or answers as if it were a plain prompt (no `rt chat` calls in its narration), the one-line dispatch claim is false: record the exact pane output with `herdr agent read "$PANE" --source recent --lines 60` and stop, reporting it, because the spec's `chat:invite` injection format then needs to change.

- [ ] **Step 4: Clean up**

```bash
herdr agent prompt "$PANE" "/chat:sign-out" --wait --until idle --timeout 60000 || true
herdr pane close "$PANE" || herdr tab close "$(herdr pane get "$PANE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["tab_id"])')"
```

Expected: the tab is gone from `herdr tab list --workspace "$WS"`.

- [ ] **Step 5: Record the run**

No commit. Paste the `rt chat who join-test` and `rt chat read join-test --last 5` output into the PR body under Verification Evidence, along with the `$PANE` id and the herdr version (`herdr --version`).

---

## Self-review

**Spec coverage.** Skills / `/chat:join`: the six numbered steps in the skill match the spec's six (gate; sign-in-then-join or join; arm; `read --last 10`; one-line post; act on seed plus note, with the note attributed to its handle). Delivery step 3: the `plugin.json` entry is Task 1 Step 2. Testing: the real run with a note on the command line is Task 2 Step 3, and its failure mode (dispatch as a plain prompt) is spelled out.

**Placeholders.** None: every step has its content or exact commands.

**Type consistency.** The command line format `/chat:join <room> note from <handle>: <text>` matches the spec's `chat:invite` injection text (`/chat:join <room>` plus ` note from <from>: <note>` on the same line).
