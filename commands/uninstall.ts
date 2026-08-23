/**
 * `rt uninstall [--keep-data|--delete-data] [--dry-run] [--yes] [--json]` —
 * the verb mattstack.app's Settings "Uninstall" sheet spawns, and a human can
 * run directly. Mirrors `rt setup apply`'s NDJSON discipline: `--json` mode
 * emits ONLY NDJSON on stdout, one object per line.
 */

import type { CommandContext } from "../lib/command-tree.ts";
import { createRealAgeKeySeam } from "../lib/home/age-key.ts";
import { confirm } from "../lib/rt-render.tsx";
import { createRealSecretsExecSeam, type SecretsSeams } from "../lib/secrets/store.ts";
import { createApplyContext, type ApplyContext, type CreateApplyContextDeps } from "../lib/setup/apply.ts";
import { envelope } from "../lib/setup/contract.ts";
import { createHumanEmitter, createNdjsonEmitter } from "../lib/setup/emit.ts";
import { UserActionableError, userErrorPayload } from "../lib/setup/errors.ts";
import { createRealProbes, type Probes } from "../lib/setup/probes.ts";
import { computeUninstallActions, runUninstall, type UninstallAction } from "../lib/setup/uninstall.ts";
import { createRelayClient, inviteRelayUrl, type RelayClient } from "../lib/team/relay-client.ts";
import type { SecretPresence } from "../lib/setup/validators/accounts.ts";

export interface UninstallDeps {
  probes: Probes;
  secrets: SecretsSeams;
  relay: RelayClient;
  /** Defaults to `realSecretPresence()` inside `createApplyContext` — override in tests. */
  secretPresence?: SecretPresence;
  needOpts?: CreateApplyContextDeps["needOpts"];
  /** Overrides `computeUninstallActions`'s own result — the seam every test drives instead of shaping a whole fake machine. */
  actions?: UninstallAction[];
  print: (s: string) => void;
  exit: (code: number) => never;
  isTTY: () => boolean;
  confirm: (message: string) => Promise<boolean>;
}

export function realUninstallDeps(): UninstallDeps {
  const probes = createRealProbes();
  return {
    probes,
    secrets: { ageKeySeam: createRealAgeKeySeam(), execSeam: createRealSecretsExecSeam() },
    relay: createRelayClient(probes.fetch, inviteRelayUrl(probes.env)),
    print: (s) => console.log(s),
    exit: process.exit,
    isTTY: () => process.stdin.isTTY === true,
    confirm: (message) => confirm({ message }),
  };
}

function dryRunPayload(actions: UninstallAction[], now: Date): { contract: 1; at: string; actions: { id: string; title: string }[] } {
  return envelope({ actions: actions.map((a) => ({ id: a.id, title: a.title })) }, now);
}

export async function runUninstallCommand(args: string[], _ctx: CommandContext = {}, deps: UninstallDeps = realUninstallDeps()): Promise<void> {
  const json = args.includes("--json");
  const verb = "uninstall";
  const deleteData = args.includes("--delete-data");
  const yes = args.includes("--yes");
  const dryRun = args.includes("--dry-run");

  try {
    const actions = deps.actions ?? computeUninstallActions(deps.probes, { keepData: !deleteData });

    if (dryRun) {
      const payload = dryRunPayload(actions, deps.probes.now());
      if (json) {
        deps.print(JSON.stringify(payload));
      } else {
        deps.print("This would remove:");
        for (const a of payload.actions) deps.print(`  - ${a.title}`);
      }
      return;
    }

    // The app's confirmation sheet IS the consent — it always passes --yes
    // with --delete-data. Nobody but a human at a real terminal reaches this
    // refusal: a non-TTY caller (the app, a script, CI) that asks to delete
    // data without saying --yes gets an honest exit-2, never an implicit go-ahead.
    if (deleteData && !yes && !deps.isTTY()) {
      throw new UserActionableError("confirm-required", "--delete-data needs --yes when not on a TTY");
    }

    if (!json && deps.isTTY() && !yes) {
      deps.print("This will:");
      for (const a of actions) deps.print(`  - ${a.title}`);
      const proceed = await deps.confirm(deleteData ? "Uninstall and delete ~/.mattstack? This cannot be undone." : "Uninstall now?");
      if (!proceed) return;
    }

    const emit = json
      ? createNdjsonEmitter((line) => deps.print(line.endsWith("\n") ? line.slice(0, -1) : line))
      : createHumanEmitter(deps.print);

    const ctx: ApplyContext = await createApplyContext({
      probes: deps.probes,
      emit,
      secrets: deps.secrets,
      relay: deps.relay,
      secretPresence: deps.secretPresence,
      flags: { nonInteractive: !deps.isTTY(), teamOfOne: true, ci: process.env.CI === "true" },
      needOpts: deps.needOpts,
    });

    const result = await runUninstall(ctx, actions);
    if (!result.ok) deps.exit(2);
  } catch (err) {
    if (err instanceof UserActionableError) {
      deps.print(json ? JSON.stringify(userErrorPayload(err, deps.probes.now())) : `rt ${verb}: ${err.message}`);
      return deps.exit(2);
    }
    throw err;
  }
}
