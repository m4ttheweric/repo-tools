import { describe, test, expect } from "bun:test";
import { slugify } from "../slug.ts";
import { UserActionableError } from "../../setup/errors.ts";

describe("slugify", () => {
  test("lowercases and dashes punctuation/spaces", () => {
    expect(slugify("Acme Claims!")).toBe("acme-claims");
  });

  test("collapses runs of non-alphanumerics into one dash", () => {
    expect(slugify("Foo   Bar--Baz")).toBe("foo-bar-baz");
  });

  test("trims leading/trailing dashes", () => {
    expect(slugify("--Hello--")).toBe("hello");
  });

  test("caps at 40 characters", () => {
    const long = "a".repeat(50);
    expect(slugify(long)).toBe("a".repeat(40));
  });

  test("cap does not leave a trailing dash", () => {
    const name = "a".repeat(39) + " " + "b".repeat(10);
    const result = slugify(name);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result.endsWith("-")).toBe(false);
  });

  test("throws bad-team-name for a name with no alphanumerics", () => {
    let caught: unknown;
    try {
      slugify("!!!");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UserActionableError);
    expect((caught as UserActionableError).code).toBe("bad-team-name");
  });

  test("throws bad-team-name for an empty string", () => {
    expect(() => slugify("")).toThrow(UserActionableError);
  });
});
