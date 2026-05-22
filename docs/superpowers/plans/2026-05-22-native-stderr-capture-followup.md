# Native-stderr Capture in rt-daemon-shim — Brief Plan

**Status:** Optional follow-up to the daemon-logging PR

**Why:** The pino logger captures everything bun-side, but native panics (segfaults, ASan output, bun runtime asserts) bypass the JS layer and vanish under launchd. The Swift exec-proxy is the only place that can `dup2`/`freopen` fd 2 before bun ever starts running.

**Scope:** One file. ~10 lines of Swift. Requires an rt-tray rebuild + install.

---

## The change

**File:** `rt-tray/Sources-daemon-shim/main.swift`

Before the `execv(bunPath, &cArgs)` call (currently line 55), add:

```swift
// Redirect fd 2 to ~/.rt/logs/daemon-stderr.log so bun's native panics
// (segfaults, ASan output, runtime asserts) land in a file instead of /dev/null.
// pino captures JS-side stderr separately — this only catches what bypasses JS.
let stderrPath = "\(home)/.rt/logs/daemon-stderr.log"
// Ensure the logs dir exists (pino-roll usually creates it, but the shim runs
// FIRST — before bun loads daemon-logger.ts).
try? FileManager.default.createDirectory(
    atPath: "\(home)/.rt/logs",
    withIntermediateDirectories: true
)
// "a" (append) — preserve prior crash output until the user clears it.
// freopen returns NULL on failure; ignore failure and keep stderr pointing at
// its inherited fd so we don't blackhole errors silently.
_ = freopen(stderrPath, "a", stderr)
```

That's it. No other code changes.

---

## Tasks

- [ ] **Step 1: Edit `rt-tray/Sources-daemon-shim/main.swift`**

  Insert the freopen block immediately before `execv(bunPath, &cArgs)`.

- [ ] **Step 2: Rebuild + install rt-tray**

  ```bash
  cd rt-tray && ./build.sh install
  ```

  Expected: clean build, signed, installed to `~/Applications/rt-tray.app`. The shim binary gets re-signed with id=`rt-daemon`.

- [ ] **Step 3: Activate the new bundle**

  Because SMAppService caches plist contents at registration, re-register so launchd picks up the new shim binary:

  ```bash
  curl --unix-socket ~/.rt/tray.sock -s -X POST http://localhost/daemon/stop
  sleep 2
  curl --unix-socket ~/.rt/tray.sock -s -X POST http://localhost/daemon/start
  ```

  (If dev-mode binary swap is active, the shim is at `rt-daemon` — already swapped from Task 11 work. No re-swap needed.)

- [ ] **Step 4: Verify the file is being written**

  ```bash
  ls -la ~/.rt/logs/daemon-stderr.log
  # Provoke a write to fd 2 from a native context — e.g. trigger anything
  # that uses Bun.spawn with stdio: "inherit" pointed at stderr. Or just
  # wait — bun emits warnings via fd 2 during normal operation.
  cat ~/.rt/logs/daemon-stderr.log | head -20
  ```

  Expected: the file exists and grows. Even if empty initially (no native errors yet), the file being present and writable proves the redirect worked. To prove the actual capture path:

  ```bash
  # Direct write to fd 2 from the daemon process:
  curl --unix-socket ~/.rt/rt.sock -s -X POST http://localhost/eval -d 'process.stderr.write("test-from-bun\n")' || echo "(no eval endpoint — alternative: provoke a real native warning)"
  ```

  Easier verification: when bun starts, it writes a banner or warning to stderr. Check after a fresh launch.

- [ ] **Step 5: Update `rt daemon logs` to surface the stderr file**

  In `commands/daemon.ts`'s `showLogs`, before launching logdy / pino-pretty, check if `~/.rt/logs/daemon-stderr.log` is non-empty and prepend its tail to the output:

  ```ts
  const stderrPath = join(LOG_DIR, "daemon-stderr.log");
  if (existsSync(stderrPath)) {
    const content = readFileSync(stderrPath, "utf8").trim();
    if (content) {
      console.log(`  ${red}${bold}native stderr${reset} ${dim}(~/.rt/logs/daemon-stderr.log)${reset}`);
      for (const line of content.split("\n").slice(-20)) {
        console.log(`  ${red}${line}${reset}`);
      }
      console.log("");
    }
  }
  ```

  This is the bit that makes captured native crashes user-visible.

- [ ] **Step 6: Commit + smoke test**

  ```bash
  git add rt-tray/Sources-daemon-shim/main.swift commands/daemon.ts
  git commit -m "feat(daemon-shim): redirect fd 2 to ~/.rt/logs/daemon-stderr.log

  Native bun panics (segfaults, ASan, runtime asserts) bypass the JS-side
  process.stderr.write interceptor. The shim runs before bun, so it's the
  only place fd 2 can be dup'd before any code that might crash.

  rt daemon logs now prepends recent stderr content so native crashes are
  visible at the top of the log viewer."
  ```

---

## Out of scope

- Rotation of `daemon-stderr.log` (native crashes are rare; file grows slowly. Add a `rt daemon logs --clear-stderr` later if it becomes an issue.)
- Surfacing stderr in the logdy web viewer (logdy only knows about one file; surfacing stderr there would require either a second logdy instance or a merge-and-pipe setup. Terminal mode covers it via Step 5.)
- Capturing stderr from rt-tray itself (separate process, separate concern).
