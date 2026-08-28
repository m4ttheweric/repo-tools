/**
 * mac-group validators — macOS floor, Apple command line tools, and PATH
 * precedence. perm.* rows (Full Disk Access, Login Items, Notifications)
 * live in permissions.ts instead: plan.ts concatenates both into the "mac"
 * group.
 */

import type { Action, Row } from "../contract.ts";
import { row } from "../contract.ts";
import type { Probes } from "../probes.ts";

const CLT_INSTALL_ACTION: Action = { type: "install", label: "Install…", tool: "apple-clt", via: "apple-clt" };
/** Byte-for-byte the marker T24's installZshenvPrecedence step writes into ~/.zshenv. */
const PATH_PRECEDENCE_MARKER = "# mattstack — PATH precedence";
const RC_FILE_DISPLAY = "~/.zshenv";

async function macosVersionRow(p: Probes): Promise<Row> {
  const base = { id: "tool.macos", kind: "tool" as const, title: "macOS version", why: "rt and mattstack.app require macOS 14 or newer.", required: true };
  const res = await p.exec(["sw_vers", "-productVersion"]);
  const version = res.stdout.trim();
  const major = version ? Number.parseInt(version.split(".")[0]!, 10) : NaN;

  // A failed/unreachable sw_vers means "couldn't determine", not "determined
  // to be too old" — RULING (honesty): never report "invalid" for a probe
  // that couldn't run.
  if (res.code !== 0 || Number.isNaN(major)) {
    return row({ ...base, status: "error", detail: "Could not determine your macOS version" });
  }
  if (major >= 14) return row({ ...base, status: "ready", detail: `macOS ${version}` });
  return row({ ...base, status: "invalid", detail: "macOS 14 or newer required" });
}

async function cltRow(p: Probes): Promise<Row> {
  const base = { id: "tool.clt", kind: "tool" as const, title: "Command Line Tools", why: "Provides git and the other command-line build tools rt depends on.", required: true };
  const [xcodeSelect, gitVersion] = await Promise.all([p.exec(["xcode-select", "-p"]), p.exec(["git", "--version"])]);
  if (xcodeSelect.code === 0 && gitVersion.code === 0) {
    return row({ ...base, status: "ready", detail: gitVersion.stdout.trim() || "git installed" });
  }
  return row({ ...base, status: "missing", detail: "Apple command line tools not installed", action: CLT_INSTALL_ACTION });
}

async function archRow(p: Probes): Promise<Row> {
  const base = {
    id: "tool.arch",
    kind: "tool" as const,
    title: "Processor",
    why: "mattstack ships an Apple-silicon (arm64) build; Intel Macs are not supported.",
    required: true,
  };
  const res = await p.exec(["uname", "-m"]);
  const arch = res.stdout.trim();

  // Same honesty ruling as macosVersionRow: a probe that couldn't run reports
  // "error", not "invalid" — only a definite non-arm64 result is invalid.
  if (res.code !== 0 || !arch) {
    return row({ ...base, status: "error", detail: "Could not determine your processor" });
  }
  if (arch === "arm64") return row({ ...base, status: "ready", detail: "Apple silicon (arm64)" });
  return row({ ...base, status: "invalid", detail: `${arch}: Apple silicon (arm64) required` });
}

function pathRow(p: Probes): Row {
  const base = { id: "tool.path", kind: "info" as const, title: "PATH precedence", why: "Makes sure your shell finds rt's shims and team intercepts before any conflicting binary.", required: false };
  const localBin = `${p.home}/.local/bin`;
  const entries = (p.env.PATH ?? "").split(":").filter(Boolean);
  const firstExisting = entries.find((entry) => p.exists(entry));
  const rc = p.readFile(`${p.home}/.zshenv`) ?? "";
  const hasMarker = rc.includes(PATH_PRECEDENCE_MARKER);

  if (firstExisting === localBin && hasMarker) {
    return row({ ...base, status: "ready", detail: `~/.local/bin is first on PATH (${RC_FILE_DISPLAY})` });
  }
  if (hasMarker) {
    return row({ ...base, status: "needs-you", detail: `~/.local/bin is on PATH but not first — team intercept shims may not fire (${RC_FILE_DISPLAY})` });
  }
  return row({ ...base, status: "missing", detail: `Install adds ~/.local/bin to PATH (${RC_FILE_DISPLAY})` });
}

export async function macRows(p: Probes): Promise<Row[]> {
  const [macos, clt, arch] = await Promise.all([macosVersionRow(p), cltRow(p), archRow(p)]);
  return [macos, clt, arch, pathRow(p)];
}
