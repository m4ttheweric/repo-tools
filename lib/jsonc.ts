/**
 * JSONC → JSON: strip comments and trailing commas so the result parses
 * with JSON.parse. String-aware (a real scanner, not regexes), so `//`
 * inside a string value — e.g. an origin URL like "https://gitlab.com/…" —
 * is content, never a comment. Single definition for every .jsonc rt reads
 * (sdm enrichment, ~/.rt/repos overlay files).
 */

export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;

  while (i < text.length) {
    const ch = text[i]!;

    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // Trailing comma: the last significant char emitted before a closer is
    // dropped here rather than by a regex pass, which a comma inside a
    // string would fool.
    if (ch === "}" || ch === "]") {
      let j = out.length - 1;
      while (j >= 0 && /\s/.test(out[j]!)) j--;
      if (j >= 0 && out[j] === ",") out = out.slice(0, j) + out.slice(j + 1);
    }

    out += ch;
    i++;
  }

  return out;
}
