// Adjectives for neutral name generator
const ADJECTIVES = [
  "amber",
  "brisk",
  "calm",
  "deft",
  "eager",
  "frank",
  "grand",
  "happy",
  "ideal",
  "joyful",
  "kind",
  "lively",
  "merry",
  "noble",
  "olive",
  "proud",
];

// Nouns for neutral name generator
const NOUNS = [
  "anvil",
  "beacon",
  "cedar",
  "daisy",
  "eagle",
  "feather",
  "garden",
  "harbor",
  "inlet",
  "jungle",
  "kettle",
  "lantern",
  "marble",
  "nectar",
  "oyster",
  "paddle",
];

/**
 * Pick a random unused name from pool, or generate neutral name if pool exhausted/absent.
 * Neutral names are generated in format "<adj>-<noun>" with numeric suffixes on collision.
 */
export function pickName(pool: string[] | undefined, used: Set<string>): string {
  // Filter pool to unused names
  if (pool && pool.length > 0) {
    const available = pool.filter((name) => !used.has(name));
    if (available.length > 0) {
      const randomIndex = Math.floor(Math.random() * available.length);
      return available[randomIndex];
    }
  }

  // Fall back to neutral generator
  return generateNeutralName(used);
}

/**
 * Generate a neutral name in format "<adj>-<noun>" with retry on collision.
 */
function generateNeutralName(used: Set<string>): string {
  let suffix = "";
  let attempt = 1;

  while (true) {
    const adjIndex = Math.floor(Math.random() * ADJECTIVES.length);
    const nounIndex = Math.floor(Math.random() * NOUNS.length);

    const adj = ADJECTIVES[adjIndex];
    const noun = NOUNS[nounIndex];

    const candidate = `${adj}-${noun}${suffix}`;

    if (!used.has(candidate)) {
      return candidate;
    }

    attempt++;
    suffix = `-${attempt}`;
  }
}
