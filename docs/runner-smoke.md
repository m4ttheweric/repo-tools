# rt runner smoke

Run from a herdr pane, on a source checkout with `bun run ui:build` done.

1. `bun run cli.ts runner` in a repo with package scripts. Expect the empty
   board (`Nothing running.`) on the alt screen, keybar at the bottom.
2. `a`: the board drops to the normal screen, the `rt run` picker appears;
   pick a dev server. Expect the board back within a blink with the row
   `starting`, flipping to `running` inside 2 s and the uptime ticking
   every second without skips.
3. `t`: the tail box opens and refreshes each second; `j`/`k` with it open
   re-targets the tail immediately. `t` again closes it.
4. `x`: the row spins `stopping`, then shows `stopped`; `s`: `starting`,
   then `running` with uptime reset. `f`: herdr focuses the pane; come back.
5. Add a second command with `a`; the header counts update.
6. `q`: the y/n layer; `n` keeps it; `q` then `y` closes the board and the
   whole `rt-runner-<id>` workspace disappears from herdr.
7. Reopen the board, add one, then `kill -TERM` the rt process from another
   pane: the terminal must come back cooked and the workspace must be gone.
