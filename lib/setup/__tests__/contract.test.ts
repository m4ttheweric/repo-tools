import { describe, test, expect } from "bun:test";
import {
  STEP_IDS,
  envelope,
  finalizePlan,
  row,
  type Group,
  type Row,
  type TeamRef,
} from "../contract.ts";

function makeRow(overrides: Partial<Row> & Pick<Row, "id" | "required" | "status">): Row {
  return row({
    kind: "tool",
    title: overrides.id,
    why: "test",
    detail: "",
    ...overrides,
  });
}

describe("finalizePlan", () => {
  const team: TeamRef = { slug: "acme", name: "Acme", mode: "join" };

  test("mixed required/optional rows yields canInstall:false and the required-missing id", () => {
    const groups: Group[] = [
      {
        id: "tools",
        title: "Tools",
        rows: [
          makeRow({ id: "required-ready", required: true, status: "ready" }),
          makeRow({ id: "required-missing", required: true, status: "missing" }),
          makeRow({ id: "optional-missing", required: false, status: "missing" }),
        ],
      },
    ];
    const plan = finalizePlan(team, groups, new Date("2026-08-21T04:00:00Z"));
    expect(plan.canInstall).toBe(false);
    expect(plan.requiredMissing).toEqual(["required-missing"]);
  });

  test("all required rows ready yields canInstall:true and empty requiredMissing", () => {
    const groups: Group[] = [
      {
        id: "tools",
        title: "Tools",
        rows: [
          makeRow({ id: "required-ready", required: true, status: "ready" }),
          makeRow({ id: "optional-missing", required: false, status: "missing" }),
        ],
      },
    ];
    const plan = finalizePlan(team, groups, new Date("2026-08-21T04:00:00Z"));
    expect(plan.canInstall).toBe(true);
    expect(plan.requiredMissing).toEqual([]);
  });
});

describe("envelope", () => {
  test("wraps a body with contract version and ISO timestamp", () => {
    const result = envelope({ x: 1 }, new Date("2026-08-21T04:00:00Z"));
    expect(result).toEqual({ contract: 1, at: "2026-08-21T04:00:00.000Z", x: 1 });
  });
});

describe("row", () => {
  test("fills defaults for optionalNote, action, and recheck", () => {
    const r = row({
      id: "foo",
      kind: "tool",
      title: "Foo",
      why: "test",
      required: true,
      detail: "",
      status: "ready",
    });
    expect(r.optionalNote).toBeNull();
    expect(r.action).toBeNull();
    expect(r.recheck).toBe("on-change");
  });
});

describe("STEP_IDS", () => {
  test("matches the contract's 25 ids in order", () => {
    expect(STEP_IDS).toEqual([
      "home.init",
      "home.restore",
      "team.create",
      "team.join",
      "secrets.write",
      "git.identity",
      "path.link",
      "settings.seed",
      "repos.clone",
      "services.register",
      "proxy.install",
      "deck.managed",
      "skills.materialize",
      "skills.link",
      "board.keys",
      "cron.triage",
      "intercepts.install",
      "plugins.install",
      "linear.mcp",
      "fastbrowser.setup",
      "herdr.integration",
      "extension.install",
      "services.start",
      "snapshot.push",
      "verify",
    ]);
  });

  test("intercepts.install runs after repos.clone (which fills the index it reads) and after cron.triage (the last settings-store write staleIntercepts compares against)", () => {
    // installShims() builds its rules by iterating the repo index. Ahead of
    // repos.clone that index is empty on a fresh machine, so the step writes
    // an empty rules cache. staleIntercepts() then compares that cache's
    // generatedAt against the mtimes of the same settings-store files
    // board.keys and cron.triage write, so the step must also run after both
    // or the cache it just wrote reads back as stale.
    expect(STEP_IDS.indexOf("intercepts.install")).toBeGreaterThan(STEP_IDS.indexOf("repos.clone"));
    expect(STEP_IDS.indexOf("intercepts.install")).toBeGreaterThan(STEP_IDS.indexOf("cron.triage"));
  });
});
