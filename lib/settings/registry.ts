// RT-50: the settings schema registry moved to @mattstack/rt-client, split
// into machinery (lookup + validation, re-exported here) and the def table
// (packages/rt-client/src/settings/registry-defs.ts). Every existing rt
// importer of lib/settings/registry.ts keeps working unchanged through this
// re-export barrel.
export * from "../../packages/rt-client/src/settings/registry-machinery.ts";
