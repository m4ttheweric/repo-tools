// RT-50: the settings write path moved to @mattstack/rt-client. Every
// existing rt importer of lib/settings/write.ts keeps working unchanged
// through this re-export barrel; the implementation lives at the path below.
export * from "../../packages/rt-client/src/settings/write.ts";
