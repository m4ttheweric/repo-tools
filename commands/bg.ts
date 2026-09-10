/**
 * rt bg: CLI over the daemon-owned background herdr server (see
 * docs/superpowers/specs/2026-09-09-background-server-design.md "The bg
 * service"). Thin over the rt-client bg* wrappers, same idiom as
 * commands/gate.ts.
 *
 *   rt bg status [--json]              server up/down + socket + live claims
 *   rt bg release [<owner>] [--json]   release one claim (TTY picker if omitted)
 *   rt bg stop [--json]                stop the server (refuses on live claims)
 */
import { bgRelease as clientRelease, bgStatus as clientStatus, bgStop as clientStop } from "../packages/rt-client/src/index.ts";
import type { Commands, RtResponse } from "../packages/rt-client/src/index.ts";

function fail(msg: string): never {
  console.error(`rt bg: ${msg}`);
  process.exit(1);
}

function positional(args: string[]): string | undefined {
  for (const a of args) {
    if (!a.startsWith("--")) return a;
  }
  return undefined;
}

function unwrap<T>(res: RtResponse<T>, label: string): T {
  if (!res.ok || res.data === undefined) fail(res.error ?? `${label} failed`);
  return res.data;
}

type ClaimRow = Commands["bg:status"]["data"]["claims"][number];

export function renderStatus(data: Commands["bg:status"]["data"]): string {
  const lines = [`server: ${data.up ? "up" : "down"}`, `socket: ${data.socket}`, ""];
  if (data.claims.length === 0) {
    lines.push("no live claims");
  } else {
    lines.push("claims:");
    const ownerWidth = Math.max(...data.claims.map((c) => c.owner.length));
    const now = Date.now();
    for (const c of data.claims) {
      const age = Math.max(0, Math.round((now - c.createdAt) / 1000));
      lines.push(`  ${c.owner.padEnd(ownerWidth)}  ${c.pane ?? "-"}  ${age}s`);
    }
  }
  return lines.join("\n");
}

export async function bgStatus(args: string[]): Promise<void> {
  const data = unwrap(await clientStatus(), "status");
  if (args.includes("--json")) return void console.log(JSON.stringify({ ok: true, ...data }));
  console.log(renderStatus(data));
}

const RELEASE_USAGE = "usage: rt bg release [<owner>] [--json]";

async function fetchClaimOwnersForPicker(): Promise<ClaimRow[]> {
  const res = await clientStatus();
  return res.ok && res.data ? res.data.claims : [];
}

async function pickClaimOwner(claims: ClaimRow[]): Promise<string | null> {
  const { filterableSelect } = await import("../lib/pick-wrappers.ts");
  const ownerWidth = Math.max(...claims.map((c) => c.owner.length));
  const options = claims.map((c) => ({
    value: c.owner,
    label: c.owner.padEnd(ownerWidth),
    hint: c.pane ?? "-",
  }));
  return filterableSelect({ message: "pick a claim to release", options, stderr: true });
}

export async function bgRelease(args: string[]): Promise<void> {
  let owner = positional(args);
  const json = args.includes("--json");
  if (!owner) {
    const claims = process.stdin.isTTY && !json && !process.env.RT_BATCH
      ? await fetchClaimOwnersForPicker()
      : [];
    if (claims.length === 0) fail(RELEASE_USAGE);
    const picked = await pickClaimOwner(claims);
    if (!picked) process.exit(0);
    owner = picked;
  }
  const data = unwrap(await clientRelease({ claim: owner }), "release");
  if (json) return void console.log(JSON.stringify({ ok: true, ...data }));
  console.log(data.released ? `released ${owner}` : `${owner} was not claimed`);
}

export async function bgStop(args: string[]): Promise<void> {
  const data = unwrap(await clientStop(), "stop");
  if (args.includes("--json")) return void console.log(JSON.stringify({ ok: true, ...data }));
  console.log(data.stopped ? "stopped" : "not stopped");
}
