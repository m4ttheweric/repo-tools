// RT-50: the settings store readers moved to @mattstack/rt-client. Every
// existing rt importer of lib/settings/stores.ts keeps working unchanged
// through this re-export barrel; the implementation lives at the path below.
export * from "../../packages/rt-client/src/settings/stores.ts";
