import { describe, test, expect } from "bun:test";
import { fzfWidthArgs } from "../fzf-select.ts";
import { CARD_WIDTH } from "../tui/palette.ts";

describe("fzfWidthArgs", () => {
  test("a wide terminal gets a right margin that brings the box down to the card width", () => {
    expect(fzfWidthArgs(200)).toEqual([`--margin=0,${200 - CARD_WIDTH},0,0`]);
    expect(fzfWidthArgs(CARD_WIDTH + 1)).toEqual(["--margin=0,1,0,0"]);
  });
  test("a terminal at or under the card width gets no margin", () => {
    expect(fzfWidthArgs(CARD_WIDTH)).toEqual([]);
    expect(fzfWidthArgs(60)).toEqual([]);
  });
  test("an unknown width (no tty columns) gets no margin", () => {
    expect(fzfWidthArgs(undefined)).toEqual([]);
    expect(fzfWidthArgs(0)).toEqual([]);
  });
  test("the cap is the same number the Go prompt card uses", () => {
    expect(CARD_WIDTH).toBe(88);
  });
});
