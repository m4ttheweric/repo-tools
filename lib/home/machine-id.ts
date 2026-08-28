import { readFileSync } from "fs";
import { join } from "path";
import { isSafeMachineKeySegment, machineKey } from "../rt-paths.ts";
import type { HomeProbes } from "../../commands/home.ts";

/** IOPlatformUUID via ioreg, slugged; null on any failure (non-mac, CI, no match). */
export async function stableMachineId(
  exec: (argv: string[]) => Promise<string | null> = defaultIoreg,
): Promise<string | null> {
  const out = await exec(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]);
  if (!out) return null;
  const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  if (!m) return null;
  const slug = m[1]!
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return isSafeMachineKeySegment(slug) ? slug : null;
}

const defaultIoreg = async (argv: string[]): Promise<string | null> => {
  try {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const term = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 3_000);
    try {
      const [out, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]);
      return code === 0 ? out : null;
    } finally {
      clearTimeout(term);
    }
  } catch {
    return null;
  }
};

interface InitKeyDeps {
  readPin?: () => string | null;
  hostnameSlug?: () => string;
  stableId?: () => Promise<string | null>;
}

/**
 * Establishes the machine key at `rt home init`. Data-preserving and idempotent:
 * an existing pin is kept as-is; a machine whose hostname-slug store already
 * carries settings freezes that slug (zero data movement); only a genuinely
 * fresh machine gets the stable id.
 */
export async function resolveInitialMachineKey(home: string, probes: HomeProbes, deps: InitKeyDeps = {}): Promise<string> {
  const readPin =
    deps.readPin ??
    (() => {
      try {
        const v = readFileSync(join(home, "machine-key"), "utf8").trim();
        return v || null;
      } catch {
        return null;
      }
    });
  const hostnameSlug = deps.hostnameSlug ?? (() => machineKey()); // machineKey() with no pin returns the hostname slug
  const stableId = deps.stableId ?? (() => stableMachineId());

  const pinned = readPin();
  if (pinned && isSafeMachineKeySegment(pinned)) return pinned;

  const slug = hostnameSlug();
  const profiles = probes.listProfiles(join(home, "user", "local")); // dirs carrying settings.local.jsonc
  if (profiles.includes(slug)) return slug; // freeze existing non-empty store

  return (await stableId()) ?? slug;
}
