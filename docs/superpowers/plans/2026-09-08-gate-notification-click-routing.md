# Gate notification click routing (rt half)

Spec: the design agreed on 2026-09-08. A gate desktop notification's
default click focuses the herdr pane behind the gate; a notification button
opens the surface that owns the gate; `run:` gates notify as well as `mr:`
gates. This plan is the rt (repo-tools) half: the notify bridge and the
tray. The board and console halves live in the mattstack-apps plan of the
same name.

## Global Constraints

- `lib/notify-bridge.ts` keeps its `{field}` interpolation semantics: an
  unknown field renders as the literal `{field}`; `{question}` resolves to
  `payload.questions[0].label`.
- `paneId` precedence on an event: `payload.paneId` (non-empty string)
  wins; otherwise `payload.origin.paneId` (non-empty string) when
  `payload.origin` is an object; otherwise undefined. Focus suppression
  keys on the same value.
- A rule's optional `url` is interpolated exactly like `title` and
  `message`, and the event carries `url` only when the interpolated string
  is non-empty. A rule with no `url` produces an event with no `url` key.
- Rule parsing (today inline in `lib/daemon.ts`) accepts an optional
  string `url` and skips a rule whose `url` is present but not a string,
  with a warn, the same way it handles `subjectPrefix`.
- No change to gate event payloads in `lib/daemon/handlers/gate.ts`.
- Tray: one new category `gate` with one action `OPEN_SURFACE` titled
  "Open" (`.foreground`); its handler opens `userInfo["url"]` when
  present. The default-click path (paneId focus, else url) is unchanged.
- Every commit ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
  No em dashes anywhere in code, comments, or commit messages.

## Task 1: notify bridge: origin pane fallback, url template, testable rule parser

Files: `lib/notify-bridge.ts`, `lib/__tests__/notify-bridge.test.ts`,
`lib/daemon.ts`.

TDD. Write the failing tests first, run them, then implement.

1. `EventBridgeRule` gains `url?: string`.
2. In `handleMatch`, derive `paneId` per the Global Constraints precedence
   (payload.paneId, else payload.origin.paneId). Keep the focus
   suppression on that derived value.
3. When `rule.url` is a string, `interpolate(rule.url, payload)`; set
   `event.url` only when the result is non-empty.
4. Move the rule-array parsing out of `lib/daemon.ts` into an exported
   `parseEventBridgeRules(raw: unknown, warn: (o: unknown, msg: string) => void): EventBridgeRule[]`
   in `lib/notify-bridge.ts`, preserving today's behavior (non-array ->
   `[]` with a warn; entries missing pattern/category/title/message
   skipped with a warn; non-string `subjectPrefix` skipped with a warn)
   and adding: string `url` carried through; non-string `url` skipped with
   a warn. `lib/daemon.ts` calls it and keeps its `getSetting` try/catch.
5. Update the header comment of `lib/notify-bridge.ts` to mention `url`
   and the origin fallback in one sentence each.

Tests to add in `lib/__tests__/notify-bridge.test.ts`:

- an event whose payload has no `paneId` but `origin: { paneId: "w1:p9" }`
  enqueues with `paneId === "w1:p9"` and calls `paneFocused("w1:p9")`;
- an event with both `paneId: "w1:p1"` and `origin.paneId: "w1:p9"` uses
  `"w1:p1"`;
- a rule with `url: "https://board.local/?gate={id}"` and payload
  `{ id: "g7" }` enqueues `url === "https://board.local/?gate=g7"`;
- a rule without `url` enqueues an event with no `url` key
  (`expect("url" in e).toBe(false)`);
- `parseEventBridgeRules`: keeps a rule with string `url`; drops a rule
  with numeric `url` and warns; keeps subjectPrefix behavior (drops a
  rule with numeric `subjectPrefix`); returns `[]` for a non-array.

Run: `bun test lib/__tests__/notify-bridge.test.ts`, then the daemon
suite files that import notify-bridge if any (`grep -rl notify-bridge
lib --include='*.test.ts'`).

## Task 2: tray: `gate` category with an Open button

Files: `rt-tray/Sources/NotificationManager.swift`.

1. In `registerCategories`, add
   `UNNotificationAction(identifier: "OPEN_SURFACE", title: "Open", options: .foreground)`
   and `UNNotificationCategory(identifier: "gate", actions: [openSurface], intentIdentifiers: [])`.
2. In `userNotificationCenter(_:didReceive:withCompletionHandler:)`, add
   `case "OPEN_SURFACE":` that opens `userInfo["url"]` via
   `NSWorkspace.shared.open` when it parses as a URL. Leave
   `UNNotificationDefaultActionIdentifier` exactly as it is.
3. Verify it compiles: from `rt-tray/`, run `./build.sh debug` (swift
   build only, no bundle). Report the tail of its output.

No Swift unit tests exist for this file; the compile is the check.
