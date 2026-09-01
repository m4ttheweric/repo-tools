/**
 * The wire identity form (remote:host%2Forg%2Frepo) is a KEY and must never
 * reach human-rendered output; anything a person reads goes through
 * lib/repo-label.ts. This file is the ratchet: every formatter that turns
 * repo identities into display text gets a case here, asserted wire-free.
 * Adding a new human surface that touches identities? Add it below.
 * (Payloads deliberately carry the wire form; this test covers RENDERED
 * text only.)
 */
import { describe, expect, test } from "bun:test";
import { repoLabel, repoLabelQualified } from "../repo-label.ts";
import { formatFreshnessParts } from "../../commands/daemon.ts";

const WIRES = [
  "remote:github.com%2Fm4ttstack%2Frt",
  "remote:gitlab.com%2Facme%2Facme-dev",
  "remote:gitlab.example.com%3A8443%2Fteam%2Fsub%2Frepo",
  "path:%2FUsers%2Fdev%2Fscratch",
];

function expectWireFree(rendered: string): void {
  expect(rendered).not.toMatch(/%2F|%3A|remote:|path:%/);
}

describe("repo labels are wire-free for every identity kind", () => {
  for (const wire of WIRES) {
    test(`repoLabel + repoLabelQualified: ${wire.slice(0, 24)}...`, () => {
      expectWireFree(repoLabel(wire));
      expectWireFree(repoLabelQualified(wire));
    });
  }
});

describe("daemon status events line", () => {
  test("renders labels, never wire identities", () => {
    const freshness = Object.fromEntries(
      WIRES.map((w, i) => [w, { state: "live", lastSyncedAt: i % 2 ? null : new Date().toISOString() }]),
    );
    for (const part of formatFreshnessParts(freshness, Date.now())) expectWireFree(part);
  });
});
