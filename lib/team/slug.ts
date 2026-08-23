import { UserActionableError } from "../setup/errors.ts";

const MAX_LENGTH = 40;

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_LENGTH)
    .replace(/-+$/, "");
  if (!slug) {
    throw new UserActionableError("bad-team-name", `not a usable team name: ${JSON.stringify(name)}`);
  }
  return slug;
}
