# rt-dashboard — project conventions

A Vite + React + Tailwind v4 dashboard ("process mission control") that talks to
the rt daemon's REST+WS API (port 9401). These are standing decisions — follow
them without being re-asked.

## UI components: shadcn/ui, always

- **Use a shadcn/ui primitive whenever one exists.** Do not hand-roll buttons,
  badges, inputs, dialogs, command palettes, collapsibles, cards, scroll areas,
  etc. Reach for the primitive first.
- Add new primitives with `bunx shadcn@latest add <name>` (they land in
  `src/components/ui/`). Don't edit files under `src/components/ui/` by hand
  unless extending a primitive deliberately.
- Composite app components (e.g. `WorktreeCard`, `ProcessRow`, `CommandPalette`)
  live in `src/components/` and are built *out of* the ui primitives.
- The command launcher is a **`CommandDialog` spotlight** (per worktree, opened
  from the "Commands" button), not an inline palette. Results are grouped by
  package with `CommandGroup` headings — don't repeat the package name as a
  per-row column.
- shadcn is configured for the **radix** base, **vite** template, CSS variables.
  Import primitives via the `@/` alias, e.g. `import { Button } from "@/components/ui/button"`.
- The `@/` alias maps to `src/` (set in `tsconfig.json` paths + `vite.config.ts`
  resolve.alias). Use it for ui imports.
- **Icons: `lucide-react`** is the icon library (installed; shadcn uses it too).
  Import named icons, e.g. `import { Terminal } from "lucide-react"`. Prefer an
  icon over repeating a text label on dense, repeated controls; when a control
  is icon-only, add an `aria-label` + `title` for accessibility and discovery.
  Don't introduce another icon set.
- **Buttons use `cursor: pointer`.** shadcn v4 ships the default cursor; a base
  rule in `src/index.css` (`@layer base`) gives all non-disabled `button` /
  `[role="button"]` a pointer cursor. Don't remove it.

## Theme: Selenized — light chrome, dark consoles

Two surfaces, two palettes. The structural chrome is light; the interactive
"console" surfaces (command center, terminals) are dark. This split is
intentional — it keeps the UI from reading as one flat cream sheet. Keep it.

- **Dark is opt-in per subtree** via shadcn's `.dark` class. Add `className="dark"`
  to a container and every shadcn primitive inside flips to the Selenized dark
  tokens (defined in the `.dark` block in `src/index.css`). The command spotlight
  (the `CommandDialog` in `WorktreeCard`) and the terminal use this. Reach for a
  `.dark` subtree for any future console-like surface rather than hand-coding
  dark colors.
- **Never put `class="dark"` on `<html>` / `<body>`.** The app is light by
  default (`:root`). The Vite scaffold shipped `<html class="dark">` — that
  darkens the *entire* app once dark tokens exist. Dark is per-subtree only.
- **App chrome is Selenized LIGHT.** The shadcn design tokens in `src/index.css`
  (`:root`) are mapped to Selenized light (bg_0 `#fbf3db`, bg_1 `#ece3cc`,
  bg_2 `#d5cdb6`, fg_0 `#53676d`, fg_1 `#3a4d53`, blue `#0072d4`, etc.).
  Use the semantic tokens — `bg-background`, `bg-card`, `text-foreground`,
  `text-muted-foreground`, `border-border`, `bg-primary`, `text-destructive` —
  not raw hex.
- **Status/accent colors** use the Selenized accents exposed as Tailwind
  utilities with a `sel-` prefix: `text-sel-green`, `bg-sel-red`,
  `text-sel-violet`, `bg-sel-cyan`, etc. These are **context-aware** — backed by
  `--sel-*` CSS vars that hold the light accents in `:root` and the brighter dark
  accents in `.dark`, mapped via `@theme inline`. So the same `text-sel-violet`
  stays legible on both light chrome and inside a dark console. Use these for
  state dots and semantic highlights, not the neutral shadcn tokens.
- **Terminals (xterm.js) are Selenized DARK.** `LogPanel.tsx` renders process
  output through xterm.js with the official Selenized **dark** xterm palette
  (bg `#103c48`, fg `#adbcbc`, the 16 ANSI colors from
  jan-warchol/selenized `terminals/xterm/selenized-dark.xdefaults`). The padding
  frame around the terminal matches the dark bg so it reads as one panel inside
  the light app. Do not light-theme the terminal.

Palette source of truth: https://github.com/jan-warchol/selenized

## Process output rendering

- Process logs are **raw PTY output** and may be self-repainting TUIs (turbo,
  `start:lite`) that use cursor movement + erase-line to redraw in place. Render
  them through **xterm.js**, never a plain `<pre>` — only a real terminal
  emulator honors cursor control so a TUI shows as one updating panel instead of
  an ever-growing pile of frames. Stripping ANSI is NOT sufficient for TUIs.
- Shared xterm theme lives in `components/xterm-theme.ts` (`XTERM_SELENIZED_DARK`);
  both `LogPanel` (read-only) and `TerminalSession` (interactive) import it.

## Interactive terminals

- The `+`/`SquareTerminal` button opens an interactive shell session: `POST
  /api/terminals` → daemon `terminal:create` spawns `$SHELL -il` under a PTY,
  tagged `kind:"terminal"`. It's a real terminal — runs anything.
- `TerminalSession` attaches over **`/ws/processes/:id/attach`** (bidirectional):
  PTY output → xterm; keystrokes (`term.onData`) → **binary** WS frames →
  `terminal.write`; resize → **string** JSON control frame. Direction/type
  disambiguates input vs control — never sniff input bytes for `{`.
- **The attach socket is token-gated** (PTY input = arbitrary code execution).
  The Vite `/ws` proxy injects `x-rt-token` on the upgrade (`proxyReqWs`) because
  browsers can't set WS headers. The read-only `/logs` socket stays open.
- Sessions render as **tabs** per worktree (`SessionTabs` + `SessionControlBar` +
  `SessionTerminal`, hosted by `WorktreeCard`; one card expanded at a time).
  Collapsing a card unmounts the terminal (closes its attach socket) — never
  hide it with `display:none`. The active tab must read as clearly selected
  (top accent + merges into the terminal bg).
- A tab's **✕ closes it**: kill-then-remove via `POST /api/processes/:id/remove`
  (token-gated; maps to the daemon's `process:remove`). Command sessions also
  keep Start/Restart/Stop in the control bar. Don't reintroduce a top-right
  "Kill" — closing is a tab affordance.
- Don't force-reset the active-tab id in an effect off the polled session list —
  it races a just-launched id and bounces focus to the previous tab. Derive the
  active session (`find(activeId) ?? sessions[0]`) so a freshly-selected id sticks.

## Engineering

- **TDD** for logic modules: write the failing test first (`bun test`), watch it
  fail, then implement. Tests live next to source (`*.test.ts`) and under
  `lib/daemon/__tests__/` for the daemon.
- Don't leave dead code. If an approach is abandoned, delete it.
- `bun run build` must pass (tsc + vite). The >500kB chunk warning is expected
  (xterm + cmdk) and fine for a local dev tool.
