import { describe, expect, test } from "bun:test";
import { skillMdDriftCauses } from "../drift.ts";

const compiled = [
  "---\nname: x\n---",
  "<!-- part: step source=mattstack:x version=1 path=a lines=1-2 -->\nstep body",
  "<!-- part: slot:domain binding=acme:d version=1 path=b lines=1-1 -->\nfill body",
  "<!-- part: include:note source=mattstack:note version=1 path=c lines=1-1 -->\nnote body",
].join("\n\n");

describe("skillMdDriftCauses", () => {
  test("identical artifacts have no cause", () => {
    expect(skillMdDriftCauses(compiled, compiled)).toEqual([]);
  });
  test("names each part whose text moved, once, in artifact order", () => {
    const moved = compiled.replace("step body", "step body v2").replace("note body", "note v2");
    expect(skillMdDriftCauses(compiled, moved)).toEqual(["source", "include"]);
  });
  test("a fill edit is a fill cause; its include sits in its own part", () => {
    expect(skillMdDriftCauses(compiled, compiled.replace("fill body", "fill v2"))).toEqual(["fill"]);
  });
  test("text before the first marker is frontmatter", () => {
    expect(skillMdDriftCauses(compiled, compiled.replace("name: x", "name: x\ndescription: d"))).toEqual(["frontmatter"]);
  });
  test("a rebound slot keeps its key and reads as a fill change", () => {
    const rebound = compiled.replace("slot:domain binding=acme:d", "slot:domain binding=acme:e");
    expect(skillMdDriftCauses(compiled, rebound)).toEqual(["fill"]);
  });
  test("a different part list is structure, whatever else differs", () => {
    const dropped = compiled.replace(/\n\n<!-- part: include:note[\s\S]*$/, "");
    expect(skillMdDriftCauses(compiled, dropped)).toEqual(["structure"]);
  });
});
