import { describe, test, expect } from "bun:test";
import { buildAskPayload, buildSpawnPayload, buildWrapUpPayload, workerEnv } from "../../commands/herd.ts";

describe("rt herd payload builders", () => {
  test("workerEnv reads HERD_ID, HERD_JOB, CLAUDE_CODE_SESSION_ID, HERDR_PANE_ID", () => {
    expect(workerEnv({ HERD_ID: "h", HERD_JOB: "j", CLAUDE_CODE_SESSION_ID: "s", HERDR_PANE_ID: "p" })).toEqual({ herd: "h", job: "j", session: "s", pane: "p" });
    expect(() => workerEnv({})).toThrow(/HERD_ID/);
  });

  test("buildAskPayload parses --questions JSON and carries --context", () => {
    const p = buildAskPayload(["--questions", '[{"id":"q","label":"?","multi":false,"options":["a"]}]', "--context", "why"], { HERD_ID: "h", HERD_JOB: "j", CLAUDE_CODE_SESSION_ID: "s" });
    expect(p).toMatchObject({ herd: "h", job: "j", session: "s", context: "why" });
    expect(p.questions).toHaveLength(1);
    expect(() => buildAskPayload(["--questions", "nope"], { HERD_ID: "h", HERD_JOB: "j", CLAUDE_CODE_SESSION_ID: "s" })).toThrow(/JSON/);
  });

  test("buildSpawnPayload reads the brief file", () => {
    const dir = require("os").tmpdir();
    const file = require("path").join(dir, `brief-${process.pid}.md`);
    require("fs").writeFileSync(file, "# brief");
    const p = buildSpawnPayload(["--herd", "h", "--job", "cv-1", "--brief", file, "--model", "opus"]);
    expect(p).toMatchObject({ herd: "h", job: "cv-1", brief: "# brief", model: "opus" });
  });

  test("buildWrapUpPayload collects repeated --dispose values and booleans", () => {
    expect(buildWrapUpPayload(["h-1", "--close-panes", "--dispose", "a", "--dispose", "b", "--archive-room"])).toEqual({ herd: "h-1", closePanes: true, dispose: ["a", "b"], deleteJobDirs: false, archiveRoom: true });
  });
});
