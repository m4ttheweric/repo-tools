# Gate Facility W1 — Manual Verification Checklist

Run live with Matt, two terminals against a running `rtd` daemon. One line per item; check off as done.

- [x] **CAS race**: open a gate (`rt gate open --subject run:t1 --kind clarify --questions '[{"id":"q","label":"Pick","multi":false,"options":["a","b"]}]'`), fire `rt gate answer <id> --answers '{"q":"a"}' --by console` and `rt gate answer <id> --answers '{"q":"b"}' --by board` from two terminals at once — the loser prints "answer lost" to stderr and its winning-row payload matches the winner's, both processes exit 0.
- [x] **wait/answer across panes**: `rt gate wait <id>` blocks in terminal A; `rt gate answer <id> --answers '{"q":"a"}' --by pane` in terminal B; terminal A returns the answered row immediately as its tool result.
- [x] **subscribe push**: `rt gate subscribe --subject-prefix run: --session <second-session-addr>` from a second rt session, then open/answer a gate under that prefix from the first — the second session receives an envelope-wrapped push notification for the event.
- [x] **daemon restart mid-wait**: start `rt gate wait <id>` in a pane, restart the daemon (`rtd` bounce), answer the gate after it comes back — the CLI's wait loop re-enters seamlessly and still resolves with the answered row (no manual retry needed).
- [x] **park an mr: gate then answer**: open a gate on an `mr:` subject, `rt gate park <id>` it, confirm it drops out of `rt gate list --open`, then `rt gate answer <id> --answers ... --by <surface>` — the park unparks (CAS allows answer from `parked`) and the gate shows `status: answered`.
- [x] **list --open reflects every step**: after each step above, `rt gate list --open` shows exactly the gates still open — the raced gate and the answered gates are absent, the parked-then-answered gate is absent, only genuinely open gates remain.

---
**Run record (2026-09-03 19:33-19:40 CDT, Matt + controller, live production daemon via canonical checkout detached at 77fab104):** 6/6 pass. Notables: the CAS loser carried the winner's exact row with `conflict:true` and exit 0; the controller session subscribed ITSELF and received both envelope doorbells in-context mid-turn; the blocked wait survived a daemon bounce with one stderr retry notice and resolved seamlessly; subscriptions persisted across the restart (post-bounce doorbells delivered); the final `gate list --open` was empty with every test gate terminal.
