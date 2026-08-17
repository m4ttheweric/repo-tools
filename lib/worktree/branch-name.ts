/**
 * Convert ticket ID and title to slug format per the given format string.
 * Format: lowercase ticketId + "-" + title lowercased, with non-alphanumerics → "-",
 * collapsed, trimmed, and slug capped at 40 chars.
 *
 * Example: slugifyTicketTitle("RT-34", "Ephemeral Worktrees: rule!", "<ticket>-<slug>")
 *   → "rt-34-ephemeral-worktrees-rule"
 */
export function slugifyTicketTitle(
  ticketId: string,
  title: string,
  format: string
): string {
  const ticketLower = ticketId.toLowerCase();
  const titleLower = title.toLowerCase();

  // Replace non-alphanumeric characters with dashes
  const titleSlug = titleLower
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, ""); // Trim dashes from start/end

  // Build the result based on format
  let result = format
    .replace("<ticket>", ticketLower)
    .replace("<slug>", titleSlug);

  // Cap the overall slug portion at 40 characters
  // Find where the slug starts in the result
  const slashIndex = result.indexOf("-");
  if (slashIndex !== -1) {
    const prefix = result.substring(0, slashIndex + 1); // include the dash
    const slug = result.substring(slashIndex + 1);
    const cappedSlug = slug.substring(0, 40);
    result = prefix + cappedSlug;
  }

  return result;
}

/**
 * Find the first candidate (base, base-2, base-3...) where exists() returns false.
 */
export function disambiguate(base: string, exists: (candidate: string) => boolean): string {
  if (!exists(base)) {
    return base;
  }

  let counter = 2;
  while (true) {
    const candidate = `${base}-${counter}`;
    if (!exists(candidate)) {
      return candidate;
    }
    counter++;
  }
}
