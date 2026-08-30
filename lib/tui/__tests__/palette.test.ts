import { test, expect } from "bun:test";
import { SPINNER_FRAMES, T, toHex } from "../palette.ts";

test("SPINNER_FRAMES is the ten-frame braille cycle the theme uses", () => {
  expect([...SPINNER_FRAMES].join("")).toBe("⠋⠙⠹⠸⠼⠴⠦⠧⠣⠏");
});

test("palette hexes match the rt-ui token sheet", () => {
  expect(toHex(T.pink)).toBe("#FF6B9D");
  expect(toHex(T.mint)).toBe("#62E6A8");
  expect(toHex(T.bgBase)).toBe("#161224");
});
