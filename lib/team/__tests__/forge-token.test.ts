import { describe, test, expect } from "bun:test";
import { NoAgeKeyError } from "../../secrets/store.ts";
import { forgeTokenLookup, tokenOrNull, forgeTokenLookupFromPresence } from "../forge-token.ts";
import type { SecretPresence } from "../../setup/validators/accounts.ts";

const REMOTE = "https://github.com/acme/team.git";
const seams = (stored: () => Promise<string | null>, staged: string | null = null) => ({
  readStored: async (_domain: string, _key: string) => stored(),
  readStaged: (_domain: string, _key: string) => staged,
});

describe("forgeTokenLookup", () => {
  test("the store answers", async () => {
    expect(await forgeTokenLookup(REMOTE, seams(async () => "gho_stored"))).toEqual({ kind: "token", token: "gho_stored" });
  });

  test("no age key yet falls through to the stage", async () => {
    const lookup = await forgeTokenLookup(REMOTE, seams(async () => { throw new NoAgeKeyError(); }, "gho_staged"));
    expect(lookup).toEqual({ kind: "token", token: "gho_staged" });
  });

  test("store and stage both empty is absent, which is what licenses no-account", async () => {
    expect(await forgeTokenLookup(REMOTE, seams(async () => null))).toEqual({ kind: "absent" });
  });

  test("a store failure that is not a missing key is unreadable, never absent", async () => {
    const lookup = await forgeTokenLookup(REMOTE, seams(async () => { throw new Error("sops exited 2"); }));
    expect(lookup.kind).toBe("unreadable");
    expect(tokenOrNull(lookup)).toBeNull();
  });

  test("a remote on no known forge is absent", async () => {
    expect(await forgeTokenLookup("https://example.com/x.git", seams(async () => "gho_stored"))).toEqual({ kind: "absent" });
  });
});

describe("forgeTokenLookupFromPresence", () => {
  test("presence-backed returns token", async () => {
    const presence: SecretPresence = {
      has: async () => "gho_token",
    };
    const result = await forgeTokenLookupFromPresence(REMOTE, presence);
    expect(result).toEqual({ kind: "token", token: "gho_token" });
  });

  test("undefined secrets case returns absent without calling anything", async () => {
    const result = await forgeTokenLookupFromPresence(REMOTE, undefined);
    expect(result).toEqual({ kind: "absent" });
  });
});
