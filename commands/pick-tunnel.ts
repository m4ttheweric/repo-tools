/**
 * Interactive setup picker for the global Cloudflare tunnel config.
 *
 * Launched as a tmux popup from inside `rt runner` via the tunnel-scope
 * [s] hotkey (Task 8). Writes the chosen config to ~/.rt/tunnels/config.json
 * via saveTunnelConfig; emits nothing to stdout so the caller doesn't need
 * to parse output.
 *
 * Failure modes:
 *   - cloudflared not on PATH → print install hint, exit 1
 *   - `cloudflared tunnel list` empty → print "rt assumes you have an
 *     existing tunnel — run `cloudflared tunnel create <name>` first",
 *     exit 1
 *   - user aborts (Ctrl-C / EOF) → exit 130, do not write config
 */

import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadTunnelConfig, saveTunnelConfig, type TunnelConfig } from "../lib/tunnel-config.ts";

interface CFTunnel {
  id:   string;
  name: string;
}

async function listTunnels(): Promise<CFTunnel[]> {
  const proc = Bun.spawn(["cloudflared", "tunnel", "list", "--output", "json"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error("cloudflared tunnel list failed — are you logged in? Run: cloudflared tunnel login");
  const raw = JSON.parse(stdout) as Array<Record<string, any>>;
  return raw.map((t) => ({ id: String(t.id), name: String(t.name) }));
}

/** Resolve the credentials file cloudflared installs at `tunnel create` time. */
function defaultCredsPath(tunnelId: string): string {
  return join(homedir(), ".cloudflared", `${tunnelId}.json`);
}

export async function showPickTunnel(): Promise<void> {
  console.log("\n  rt tunnel setup\n");

  let tunnels: CFTunnel[];
  try {
    tunnels = await listTunnels();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      console.error("  ✗  cloudflared not found on PATH — install it: brew install cloudflared");
    } else {
      console.error(`  ✗  ${(err as Error).message}`);
    }
    process.exit(1);
  }
  if (tunnels.length === 0) {
    console.error("  ✗  No Cloudflare tunnels found. Create one first:\n      cloudflared tunnel create <my-tunnel>");
    process.exit(1);
  }

  const existing = loadTunnelConfig();

  console.log("  Cloudflare tunnels:");
  tunnels.forEach((t, i) => {
    const marker = existing?.tunnelId === t.id ? " ← currently selected" : "";
    console.log(`    ${i + 1}. ${t.name} (${t.id})${marker}`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const idxRaw = await rl.question(`\n  pick tunnel [1-${tunnels.length}]: `);
  const idx = Number(idxRaw) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= tunnels.length) {
    console.error("  ✗  invalid choice");
    rl.close();
    process.exit(1);
  }
  const chosen = tunnels[idx]!;

  const domainDefault = existing?.baseDomain ?? "";
  const domain = (await rl.question(`  base domain${domainDefault ? ` [${domainDefault}]` : ""}: `)).trim() || domainDefault;
  if (!domain) {
    console.error("  ✗  base domain required");
    rl.close();
    process.exit(1);
  }

  const prefixDefault = existing?.hostnamePrefix ?? "p";
  const prefix = await rl.question(`  hostname prefix [${prefixDefault}] (empty for pure-numeric): `);
  // Empty input keeps default; user typing whitespace means "no prefix".
  const finalPrefix = prefix === "" ? prefixDefault : prefix.trim();

  const credsPath = defaultCredsPath(chosen.id);
  if (!existsSync(credsPath)) {
    console.error(`\n  ✗  credentials file not found at ${credsPath}`);
    console.error(`     Re-create the tunnel or copy the credentials JSON to that path.`);
    rl.close();
    process.exit(1);
  }

  const cfg: TunnelConfig = {
    tunnelId:        chosen.id,
    tunnelName:      chosen.name,
    credentialsFile: credsPath,
    baseDomain:      domain,
    hostnamePrefix:  finalPrefix,
  };
  saveTunnelConfig(cfg);

  console.log(`\n  ✓ saved to ~/.rt/tunnels/config.json`);
  console.log(`\n  Next: ensure DNS routes *.${domain} → this tunnel:`);
  console.log(`      cloudflared tunnel route dns ${chosen.name} "*.${domain}"`);
  console.log(`  (run that once if you haven't already.)\n`);

  rl.close();
}
