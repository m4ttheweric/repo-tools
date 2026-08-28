/**
 * The pool `rt chat sign-in` draws an agent's handle from when nothing names
 * it explicitly. Short, common first names, so a human can say "ask fred"
 * and an agent can call itself fred. Every entry is a valid chat name
 * (`[a-z0-9._-]+`) with no suffix, so `-2` style collisions stay legible.
 *
 * The pool is deliberately large and the draw is least-recently-used: chat
 * history is keyed on the handle alone, so a name that comes back within a
 * few days reads as one agent when it was two. A name recurs only after
 * every other name has been drawn once.
 */
export const AGENT_NAMES: readonly string[] = [
  "ada", "abe", "alan", "alex", "alma", "amos", "amy", "andy", "ann", "anya",
  "aria", "arlo", "ava", "axel", "bart", "bea", "beck", "ben", "beth", "bill",
  "blair", "bob", "bram", "bree", "bruno", "bryn", "cal", "cam", "carl", "cass",
  "chad", "chip", "chloe", "clay", "cleo", "clem", "cody", "cole", "cora", "cruz",
  "cyrus", "dale", "dan", "dario", "dave", "dawn", "dean", "dee", "del", "desi",
  "dex", "dina", "dirk", "don", "dot", "doug", "drew", "duke", "earl", "edie",
  "eli", "ella", "elmo", "elsa", "emma", "enzo", "erin", "esme", "ethan", "eva",
  "eve", "ezra", "fay", "felix", "fern", "fin", "fiona", "flo", "fox", "fred",
  "gabe", "gail", "gary", "gene", "gil", "gina", "glen", "greg", "greta", "gus",
  "gwen", "hal", "hana", "hank", "hart", "hattie", "hazel", "heidi", "holly", "hope",
  "hugo", "ida", "ike", "ines", "iris", "isla", "ivy", "jack", "jane", "jasper",
  "jax", "jay", "jed", "jen", "jess", "jill", "jim", "jodi", "joe", "jon",
  "josh", "joy", "jude", "jules", "june", "kai", "kara", "kat", "kay", "kent",
  "kim", "kit", "kurt", "kyle", "lana", "lara", "lars", "lee", "len", "leo",
  "levi", "lex", "lil", "liz", "lola", "lorna", "lou", "lucy", "luke", "lyle",
  "mae", "mark", "mary", "max", "maya", "meg", "mel", "mia", "mike", "milo",
  "moe", "mona", "nadia", "nat", "ned", "nell", "nia", "nick", "noah", "noel",
  "nora", "odin", "olga", "oli", "omar", "opal", "oscar", "otis", "otto", "owen",
  "pam", "pat", "paul", "pearl", "penny", "pete", "phil", "pia", "pip", "quin",
  "rafa", "ray", "reg", "remy", "rene", "rex", "rhea", "rico", "rita", "rob",
  "ron", "rosa", "ross", "roy", "ruby", "russ", "ruth", "ryan", "sage", "sal",
  "sam", "sara", "sean", "seth", "shay", "sid", "sky", "sofia", "stan", "sue",
  "tad", "tamsin", "tara", "tess", "theo", "thora", "tim", "tina", "toby", "todd",
  "tom", "toni", "tyra", "ulla", "uma", "val", "vera", "vic", "viola", "wade",
  "walt", "wanda", "wes", "will", "wren", "xavi", "yuki", "yusuf", "zara", "zed",
  "zelda", "zia", "zoe",
];

/** `fred-2` → `fred`; a bare name is its own base. */
export function baseOfHandle(handle: string): string {
  return handle.replace(/-\d+$/, "");
}

/**
 * The least recently used name no live session holds. `taken` may contain
 * suffixed handles; they exclude their base. `lastUsed` maps a name to when
 * it was last assigned; a name absent from it has never been used and wins
 * outright. Ties are broken uniformly at random. When the whole pool is
 * held, any name is returned and the daemon's suffixing takes over.
 */
export function pickAgentName(
  taken: Iterable<string>,
  lastUsed: Readonly<Record<string, number>>,
  random: () => number = Math.random,
): string {
  const held = new Set<string>();
  for (const h of taken) held.add(baseOfHandle(h));
  const free = AGENT_NAMES.filter((n) => !held.has(n));
  const pool = free.length > 0 ? free : AGENT_NAMES;

  let oldest = Infinity;
  let candidates: string[] = [];
  for (const n of pool) {
    const at = lastUsed[n] ?? -Infinity;
    if (at < oldest) {
      oldest = at;
      candidates = [n];
    } else if (at === oldest) {
      candidates.push(n);
    }
  }
  return candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]!;
}
