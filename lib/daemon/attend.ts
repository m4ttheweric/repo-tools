/**
 * attendPane: resolve a bg/hidden pane's herdr terminal id, then open a
 * visible tab running `herdr terminal attach --takeover` against it.
 * Extracted verbatim from herd:attend (lib/daemon/handlers/herd.ts) so a
 * second caller (pane:focus's `bg:` fork, Task 7) can share it.
 */
import type { HerdrRunner } from "../agent-herdr.ts";

export async function attendPane(opts: {
  /** The bg/hidden server the pane lives on. */
  socket: string;
  /** Bare pane id on that server. */
  paneId: string;
  /** herdr session name for HERDR_SESSION in the attach command. */
  session: string;
  /** Visible tab label. */
  label: string;
  /** The visible workspace the attend tab is created in. */
  callerWorkspace: string;
  herdrRunnerFor: (socket: string | null) => HerdrRunner;
}): Promise<{ ok: true; tab: string; pane: string } | { ok: false; error: string }> {
  const { socket, paneId, session, label, callerWorkspace, herdrRunnerFor } = opts;
  const hiddenRunner = herdrRunnerFor(socket);
  const got = await hiddenRunner(["pane", "get", paneId]);
  if (got.exitCode !== 0) return { ok: false, error: `herdr pane get failed: ${got.stdout.slice(0, 200)}` };
  let termId: string | undefined;
  try {
    const parsed = JSON.parse(got.stdout)?.result;
    const raw = parsed?.pane?.terminal_id ?? parsed?.terminal_id;
    // termId rides into a shell command unquoted (the `attach` line below),
    // so it must be shell-inert on top of being a string.
    if (typeof raw === "string" && /^[A-Za-z0-9_.:-]+$/.test(raw)) termId = raw;
  } catch { /* handled below */ }
  if (!termId) return { ok: false, error: "hidden pane reported no terminal id" };
  const visible = herdrRunnerFor(null);
  const tab = await visible(["tab", "create", "--workspace", callerWorkspace, "--label", label, "--focus"]);
  if (tab.exitCode !== 0) return { ok: false, error: `herdr tab create failed: ${tab.stdout.slice(0, 200)}` };
  let root: { pane_id?: unknown; tab_id?: unknown } | undefined;
  try {
    root = JSON.parse(tab.stdout)?.result?.root_pane;
  } catch { return { ok: false, error: "herdr tab create returned invalid JSON" }; }
  const rootPane = typeof root?.pane_id === "string" ? root.pane_id : null;
  const tabId = typeof root?.tab_id === "string" ? root.tab_id : null;
  if (!rootPane) return { ok: false, error: "herdr tab create returned no root pane" };
  if (!tabId) return { ok: false, error: "herdr tab create returned no tab id" };
  const attach = `env -u HERDR_SOCKET_PATH HERDR_SESSION=${session} herdr terminal attach ${termId} --takeover`;
  const ran = await visible(["pane", "run", rootPane, attach]);
  if (ran.exitCode !== 0) return { ok: false, error: `herdr pane run failed: ${ran.stdout.slice(0, 200)}` };
  return { ok: true, tab: tabId, pane: paneId };
}
