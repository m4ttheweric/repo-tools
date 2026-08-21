#!/usr/bin/env bun
// Stub rt for app tests: canned contract-v1 answers per RT_STUB_SCENARIO.
// State that must change between invocations (a permission granted, a step
// retried) lives in RT_STUB_STATE_DIR so every call is a fresh process like
// the real rt.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const scenario = process.env.RT_STUB_SCENARIO ?? "join-happy";
const stateDir = process.env.RT_STUB_STATE_DIR ?? join(import.meta.dir, ".state", scenario);
mkdirSync(stateDir, { recursive: true });
const at = new Date().toISOString();
const args = process.argv.slice(2).filter((a) => a !== "--json");

function stateGet(key: string, fallback = 0): number {
  const p = join(stateDir, key);
  return existsSync(p) ? Number(readFileSync(p, "utf8")) : fallback;
}
function stateBump(key: string): number {
  const n = stateGet(key) + 1;
  writeFileSync(join(stateDir, key), String(n));
  return n;
}
function emit(obj: unknown) { process.stdout.write(JSON.stringify({ contract: 1, at, ...(obj as object) }) + "\n"); }
function fail(code: string, message: string): never { emit({ error: { code, message } }); process.exit(2); }
async function readStdinJSON(): Promise<Record<string, unknown>> {
  const text = await new Response(Bun.stdin.stream()).text();
  try { return text.trim() ? JSON.parse(text) : {}; } catch { return {}; }
}

const row = (id: string, kind: string, title: string, why: string, required: boolean, status: string,
             detail: string | null, action: unknown, recheck = "on-change", optionalNote: string | null = null) =>
  ({ id, kind, title, why, required, optionalNote, status, detail, action, recheck });

function plan(): unknown {
  const fdaCalls = stateBump("plan-calls");
  const fdaGranted = scenario !== "perm-denied-then-granted" || fdaCalls >= 2;
  const mode = scenario === "create-happy" ? "create" : scenario === "restore" ? "restore" : "join";
  const mac = [
    row("perm.fda", "permission", "Full Disk Access",
        "Reads your repositories' git state so the daemon can show branch and MR status.", true,
        fdaGranted ? "ready" : "needs-you", fdaGranted ? "Granted" : "Not granted",
        fdaGranted ? null : { type: "open-settings", label: "Open Full Disk Access Settings…", target: "fda" }, "on-activate"),
    row("perm.login-items", "permission", "Background services",
        "rt daemon and deck run in the background as login items.", true, "ready", "Enabled", null, "on-activate"),
    row("perm.notifications", "permission", "Notifications", "Pipeline and review alerts.", false, "skipped", "Not decided",
        { type: "request-permission", label: "Allow", which: "notifications" }, "on-activate",
        "Works without this; you'll see menu-bar badges instead."),
    row("tool.clt", "tool", "Apple command line tools", "git and python3 come from here.", true, "ready", "git 2.50.1", null),
    row("tool.path", "info", "~/.local/bin first on PATH", "Install adds one PATH line to your shell rc.", true, "ready", "Fixed by Install", null),
  ];
  const accounts = [
    row("account.gitlab", "account", "GitLab", "The team's merge requests live on gitlab.assured.com.", true,
        stateGet("gitlab-connected") ? "ready" : "missing", stateGet("gitlab-connected") ? "token can see group assured" : null,
        { type: "connect", label: "Connect", integration: "gitlab",
          fields: [{ name: "token", label: "Personal access token", secret: true, hint: "scopes: read_api, read_user" }],
          alternatives: [] }),
  ];
  const access = [row("access.team-repo", "access", "Team repo reachable", "github.com/assured/mattstack-team-assured", true, "ready", "ls-remote ok", null)];
  const tools = [
    row("tool.herdr", "tool", "herdr", "Runs the agents that do the work.", true, "ready", "0.9.2", null),
    row("tool.fast-browser", "tool", "Fast Browser", "Browser automation for evidence.", true, "needs-you", "extension not loaded",
        { type: "steps", label: "Show steps…", steps: ["Open chrome://extensions", "Turn on Developer mode", "Load unpacked → ~/.fast-browser/extension/current/unpacked"] }),
    row("tool.chrome", "tool", "Google Chrome", "Evidence capture.", false, "skipped", null,
        { type: "open-url", label: "Download", url: "https://www.google.com/chrome/" }, "manual", "Works without this."),
  ];
  // Scenarios other than perm-denied-then-granted are installable out of the box so
  // flows can reach Install without connecting anything; perm-denied-then-granted
  // gates only on perm.fda so the second plan() call can flip canInstall to true.
  const installableScenario = ["join-happy", "create-happy", "apply-fail-retry", "restore", "uninstall", "perm-denied-then-granted"].includes(scenario);
  // accounts[0] and tools[1] are the fixed literal elements built above — non-null
  // is safe, not a runtime guess.
  if (installableScenario) { accounts[0]!.status = "ready"; accounts[0]!.detail = "token can see group assured"; tools[1]!.status = "ready"; tools[1]!.detail = "extension loaded"; }
  const requiredMissing = [...mac, ...accounts, ...access, ...tools].filter((r) => r.required && r.status !== "ready").map((r) => r.id);
  return {
    team: { slug: "assured", name: "Assured", mode },
    groups: [
      { id: "mac", title: "Your Mac", rows: mac },
      { id: "accounts", title: "Accounts", rows: accounts },
      { id: "access", title: "Access", rows: access },
      { id: "tools", title: "Tools", rows: tools },
    ],
    canInstall: requiredMissing.length === 0,
    requiredMissing,
  };
}

const STEPS = [
  ["home.init", "Create your settings home repo", "rt"], ["team.join", "Join the team", "rt"],
  ["secrets.write", "Store the tokens you entered", "rt"], ["path.link", "Link rt, fast-browser, gitq, deck into ~/.local/bin", "rt"],
  ["settings.seed", "Write machine settings", "rt"], ["repos.clone", "Clone the team's repositories", "rt"],
  ["services.register", "Register the rt daemon and deck", "app"], ["proxy.install", "Install the local HTTPS proxy", "privileged"],
  ["plugins.install", "Install the mattstack skills into Claude Code", "rt"], ["services.start", "Start services", "rt"],
  ["verify", "Verify everything", "rt"],
] as const;

async function apply() {
  const fromIdx = Math.max(0, args.indexOf("--from"));
  const fromId = fromIdx > 0 ? args[fromIdx + 1] : null;
  const start = fromId ? STEPS.findIndex((s) => s[0] === fromId) : 0;
  const steps = STEPS.slice(start < 0 ? 0 : start);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const line = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
  line({ event: "plan", steps: steps.map(([id, title, kind]) => ({ id, title, kind })) });
  for (const [id, , kind] of steps) {
    line({ event: "step", id, state: "running" });
    await sleep(120);
    if (kind === "app") {
      line({ event: "need", id, request: { type: "app-register-services", plists: ["com.mattstack.daemon.plist", "com.mattstack.deck.plist"] } });
    } else if (kind === "privileged") {
      line({ event: "need", id, request: { type: "app-privileged", op: "proxy-install" } });
    } else {
      line({ event: "log", id, line: `${id}: working…` });
    }
    if (scenario === "apply-fail-retry" && id === "plugins.install" && stateBump("plugins-attempts") === 1) {
      line({ event: "step", id, state: "failed", detail: "claude plugin install exited 1",
             remedy: "Open Claude Code once so it finishes first-run, then Retry." });
      line({ event: "done", ok: false, failedStep: id });
      return;
    }
    line({ event: "step", id, state: "done", detail: kind === "rt" ? "ok" : "done by the app" });
  }
  line({ event: "done", ok: true, failedStep: null });
}

const [a0, a1, a2] = args;
if (a0 === "setup" && (a1 === "plan" || a1 === "status")) emit(plan());
else if (a0 === "setup" && a1 === "apply") await apply();
else if (a0 === "setup" && a1 === "github" && a2 === "status") emit({ integration: "github", status: "ready", detail: "gh authenticated as matt", scopesSeen: ["repo", "read:org"], handle: "matt", owners: ["matt", "assured"] });
else if (a0 === "setup" && a1 === "intent" && a2 === "restore") emit({ ok: true, intent: "restore", repo: args[3] });
else if (a0 === "setup" && a2 === "status") emit({ integration: a1, status: stateGet(`${a1}-connected`) ? "ready" : "missing", detail: null });
else if (a0 === "setup" && a2 === "connect") {
  const body = await readStdinJSON();
  if (!body.token && !body.useGh) fail("no-token", "Paste a token or use gh.");
  stateBump(`${a1}-connected`);
  emit({ integration: a1, status: "ready", detail: "token can see group assured", scopesSeen: ["read_api"] });
}
else if (a0 === "team" && a1 === "create") emit({ team: { slug: "my-team", name: args[2] ?? "My team" }, remote: "ok" });
else if (a0 === "team" && a1 === "join") {
  const body = await readStdinJSON();
  if (!body.code) fail("invite-malformed", "Paste an invite code.");
  if (scenario === "join-no-access") emit({ team: { slug: "assured", name: "Assured", owner: "matt" }, access: "denied", peering: "idle", message: "You don't have access yet: ask matt to grant you access to Assured." });
  else emit({ team: { slug: "assured", name: "Assured", owner: "matt" }, access: "ok", peering: "idle", message: "Joining Assured (owner matt)" });
}
else if (a0 === "team" && a1 === "status") emit({ slug: "assured", name: "Assured", remote: "git@github.com:assured/mattstack-team-assured.git", lastPush: "2026-08-21T03:00:00Z", members: [{ username: "matt" }, { username: "bob" }] });
else if (a0 === "team" && a1 === "invite") emit({ code: "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567", expiresAt: "2026-08-28T00:00:00Z",
  pasteBlock: "Install mattstack from https://github.com/m4ttstack/rt/releases, then open mattstack://join/ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567 or paste the code into Setup → Join a team.",
  forgeAccess: "granted", manualSteps: [] });
else if (a0 === "uninstall" && args.includes("--dry-run")) emit({ actions: [
  { id: "services.unregister", title: "Stop and remove the rt daemon and deck services" },
  { id: "deck.managed-remove", title: "Remove board and gitq from deck" },
  { id: "proxy.remove", title: "Remove the local HTTPS proxy (admin prompt)" },
  { id: "path.unlink", title: "Remove ~/.local/bin links" },
  { id: "shell.remove", title: "Remove the shell rc block" },
  { id: "extension.uninstall", title: "Uninstall the rt-context editor extension" },
  { id: "plugins.uninstall", title: "Uninstall the mattstack plugins from Claude Code" },
  ...(args.includes("--delete-data") ? [{ id: "data", title: "Delete ~/.mattstack (settings, state, logs)" }] : []),
  { id: "app.trash", title: "Move mattstack.app to the Trash" } ] });
else if (a0 === "uninstall") {
  if (args.includes("--delete-data") && !args.includes("--yes")) fail("confirm-required", "--delete-data needs --yes when not on a TTY.");
  for (const id of ["services.unregister", "path.unlink", "app.trash"]) {
  process.stdout.write(JSON.stringify({ event: "step", id, state: "running" }) + "\n");
  process.stdout.write(JSON.stringify({ event: "step", id, state: "done" }) + "\n"); }
  process.stdout.write(JSON.stringify({ event: "done", ok: true }) + "\n"); }
else if (a0 === "settings" && a1 === "set") emit({ ok: true, key: a2 });
else if (a0 === "restore") emit({ ok: true, repo: a1 });
else if (a0 === "home" && a1 === "init") emit({ ok: true });
else if (a0 === "version" || a0 === "--version") emit({ version: "2.8.0-stub", build: 0 });
else fail("unknown-verb", `stub has no answer for: ${args.join(" ")}`);
