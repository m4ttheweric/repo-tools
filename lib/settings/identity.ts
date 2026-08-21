// RT-50: repo identity normalization/derivation moved to @mattstack/rt-client.
// Every existing rt importer of lib/settings/identity.ts keeps working
// unchanged through this re-export barrel; the implementation lives at the
// path below.
export * from "../../packages/rt-client/src/settings/identity.ts";
