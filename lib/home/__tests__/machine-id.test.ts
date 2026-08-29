import { expect, test } from "bun:test";
import { resolveInitialMachineKey, stableMachineId } from "../machine-id.ts";

const IOREG_FIXTURE = `  "IOPlatformUUID" = "D9E8F7A6-1234-5678-9ABC-DEF012345678"`;

test("stableMachineId parses IOPlatformUUID and slugs it", async () => {
  const id = await stableMachineId(async () => IOREG_FIXTURE);
  expect(id).toBe("d9e8f7a6-1234-5678-9abc-def012345678");
});

test("stableMachineId returns null when ioreg fails", async () => {
  expect(await stableMachineId(async () => null)).toBeNull();
  expect(await stableMachineId(async () => "no uuid here")).toBeNull();
});

test("resolveInitialMachineKey: existing pin file is returned unchanged", async () => {
  const probes = { exists: (p: string) => p.endsWith("machine-key"), listProfiles: () => [] } as any;
  const key = await resolveInitialMachineKey("/home", probes, { readPin: () => "pinned-key", stableId: async () => "uuid-x" });
  expect(key).toBe("pinned-key");
});

test("resolveInitialMachineKey: existing non-empty hostname-slug store freezes the slug", async () => {
  const probes = { exists: () => false, listProfiles: () => ["myhost"] } as any;
  const key = await resolveInitialMachineKey("/home", probes, { readPin: () => null, hostnameSlug: () => "myhost", stableId: async () => "uuid-x" });
  expect(key).toBe("myhost"); // frozen, data preserved, no move
});

test("resolveInitialMachineKey: fresh machine gets the stable id", async () => {
  const probes = { exists: () => false, listProfiles: () => [] } as any;
  const key = await resolveInitialMachineKey("/home", probes, { readPin: () => null, hostnameSlug: () => "myhost", stableId: async () => "uuid-x" });
  expect(key).toBe("uuid-x");
});

test("resolveInitialMachineKey: fresh machine, ioreg fails -> hostname slug", async () => {
  const probes = { exists: () => false, listProfiles: () => [] } as any;
  const key = await resolveInitialMachineKey("/home", probes, { readPin: () => null, hostnameSlug: () => "myhost", stableId: async () => null });
  expect(key).toBe("myhost");
});
