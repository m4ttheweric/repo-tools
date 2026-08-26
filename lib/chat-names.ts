/**
 * The pool `rt chat sign-in` draws an agent's handle from when nothing names
 * it explicitly. Short, common first names, so a human can say "ask fred"
 * and an agent can call itself fred. Every entry is a valid chat name
 * (`[a-z0-9._-]+`) with no suffix, so `-2` style collisions stay legible.
 */
export const AGENT_NAMES: readonly string[] = [
  "ada", "abe", "amy", "ann", "ava", "bea", "ben", "bob", "cal", "cam",
  "dan", "dee", "del", "don", "dot", "eli", "eva", "eve", "fay", "fin",
  "flo", "fred", "gil", "gus", "hal", "hank", "hugo", "ida", "ike", "ivy",
  "jack", "jane", "jay", "jed", "jen", "jill", "jim", "joe", "jon", "joy",
  "jude", "june", "kai", "kat", "kay", "kim", "kit", "lee", "len", "leo",
  "lex", "lil", "liz", "lou", "lucy", "mae", "max", "meg", "mel", "mia",
  "nat", "ned", "nell", "nia", "nick", "nora", "oli", "omar", "otis", "otto",
  "pam", "pat", "paul", "pete", "pip", "quin", "ray", "reg", "rex", "rob",
  "ron", "rosa", "ross", "roy", "ruby", "russ", "sal", "sam", "sid", "sue",
  "tad", "tess", "tim", "tom", "toni", "uma", "val", "vic", "walt", "wes",
  "will", "zed", "zoe",
];

/** `fred-2` → `fred`; a bare name is its own base. */
export function baseOfHandle(handle: string): string {
  return handle.replace(/-\d+$/, "");
}

/**
 * A name no live session holds, uniformly at random. `taken` may contain
 * suffixed handles; they exclude their base. When the whole pool is held,
 * any name is returned and the daemon's suffixing takes over.
 */
export function pickAgentName(taken: Iterable<string>, random: () => number = Math.random): string {
  const held = new Set<string>();
  for (const h of taken) held.add(baseOfHandle(h));
  const free = AGENT_NAMES.filter((n) => !held.has(n));
  const pool = free.length > 0 ? free : AGENT_NAMES;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!;
}
