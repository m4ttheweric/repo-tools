/**
 * Inline markdown renderer for MR comment bodies — headings, paragraphs,
 * fenced code (with syntax highlighting), GitLab suggestion blocks, quotes,
 * bullets, and inline bold/italic/code/link spans.
 */

import { Box, Text } from "ink";
import { highlight, supportsLanguage } from "cli-highlight";

/** Vibrant theme — terminal default colors are too muted to read at a glance. */
const HL_THEME = {
  keyword:    (s: string) => `\x1b[38;5;213m${s}\x1b[0m`, // pink
  built_in:   (s: string) => `\x1b[38;5;75m${s}\x1b[0m`,  // blue
  type:       (s: string) => `\x1b[38;5;117m${s}\x1b[0m`, // cyan
  class:      (s: string) => `\x1b[38;5;117m${s}\x1b[0m`, // cyan
  literal:    (s: string) => `\x1b[38;5;215m${s}\x1b[0m`, // orange
  number:     (s: string) => `\x1b[38;5;215m${s}\x1b[0m`, // orange
  string:     (s: string) => `\x1b[38;5;186m${s}\x1b[0m`, // yellow
  comment:    (s: string) => `\x1b[2m${s}\x1b[0m`,        // dim
  function:   (s: string) => `\x1b[38;5;121m${s}\x1b[0m`, // green
  title:      (s: string) => `\x1b[38;5;121m${s}\x1b[0m`, // green (function names)
  attr:       (s: string) => `\x1b[38;5;117m${s}\x1b[0m`, // cyan
  property:   (s: string) => `\x1b[38;5;117m${s}\x1b[0m`, // cyan
  symbol:     (s: string) => `\x1b[38;5;111m${s}\x1b[0m`, // light blue
  variable:   (s: string) => `\x1b[38;5;231m${s}\x1b[0m`, // bright white
  params:     (s: string) => `\x1b[38;5;229m${s}\x1b[0m`, // soft yellow
  // diff-specific
  addition:   (s: string) => `\x1b[38;5;120m${s}\x1b[0m`, // green
  deletion:   (s: string) => `\x1b[38;5;203m${s}\x1b[0m`, // red
} as any;

/** Restrict auto-detect to common languages — highlight.js default is too aggressive
 *  and frequently misclassifies short snippets as exotic langs. */
const HL_LANGS = [
  "typescript", "javascript", "tsx", "jsx", "json", "bash", "shell",
  "css", "scss", "html", "xml", "go", "python", "ruby", "sql",
  "yaml", "diff", "markdown", "rust", "java",
];

function highlightCode(code: string, lang: string): string {
  const l = lang.trim().toLowerCase();
  try {
    if (l && supportsLanguage(l)) {
      return highlight(code, { language: l, ignoreIllegals: true, theme: HL_THEME });
    }
    // No language or unsupported — auto-detect from the common subset.
    return highlight(code, { languageSubset: HL_LANGS, ignoreIllegals: true, theme: HL_THEME });
  } catch {
    return code;
  }
}

type InlineSpan =
  | { k: "text";   t: string }
  | { k: "bold";   t: string }
  | { k: "italic"; t: string }
  | { k: "code";   t: string }
  | { k: "link";   t: string };

function parseInline(s: string): InlineSpan[] {
  const out: InlineSpan[] = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\([^)]+\)/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ k: "text", t: s.slice(last, m.index) });
    if      (m[1] != null) out.push({ k: "bold",   t: m[1] });
    else if (m[2] != null) out.push({ k: "italic", t: m[2] });
    else if (m[3] != null) out.push({ k: "code",   t: m[3] });
    else if (m[4] != null) out.push({ k: "link",   t: m[4] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ k: "text", t: s.slice(last) });
  return out;
}

function InlineLine({ text, bold: boldAll }: { text: string; bold?: boolean }) {
  const spans = parseInline(text);
  return (
    <Text wrap="wrap">
      {spans.map((sp, i) => {
        if (sp.k === "bold")   return <Text key={i} bold>{sp.t}</Text>;
        if (sp.k === "italic") return <Text key={i} italic>{sp.t}</Text>;
        if (sp.k === "code")   return <Text key={i} color="cyan">{"`"}{sp.t}{"`"}</Text>;
        if (sp.k === "link")   return <Text key={i} underline>{sp.t}</Text>;
        return <Text key={i} bold={boldAll}>{sp.t}</Text>;
      })}
    </Text>
  );
}

type Block =
  | { type: "para";    lines: string[] }
  | { type: "code";    lang: string; lines: string[] }
  | { type: "suggest"; lines: string[] }
  | { type: "quote";   lines: string[] }
  | { type: "heading"; level: number; text: string }
  | { type: "bullet";  items: string[] }
  | { type: "hr" };

function parseBlocks(body: string): Block[] {
  const lines = body.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(/^```(.*)/);
    if (fence) {
      const lang = fence[1]?.trim() ?? "";
      const isSuggest = lang.startsWith("suggestion:");
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++;
      blocks.push(isSuggest
        ? { type: "suggest", lines: codeLines }
        : { type: "code", lang, lines: codeLines });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { blocks.push({ type: "heading", level: h[1]!.length, text: h[2]! }); i++; continue; }
    if (line.match(/^>[ \t]/)) {
      const qs: string[] = [];
      while (i < lines.length && lines[i]!.match(/^>[ \t]?/)) {
        qs.push(lines[i]!.replace(/^>[ \t]?/, ""));
        i++;
      }
      blocks.push({ type: "quote", lines: qs });
      continue;
    }
    if (line.match(/^[-*] /)) {
      const items: string[] = [];
      while (i < lines.length && lines[i]!.match(/^[-*] /)) {
        items.push(lines[i]!.slice(2));
        i++;
      }
      blocks.push({ type: "bullet", items });
      continue;
    }
    if (line.match(/^-{3,}$|^\*{3,}$/)) { blocks.push({ type: "hr" }); i++; continue; }
    if (line.trim() === "") { i++; continue; }
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.match(/^```|^#{1,6} |^>[ \t]|^[-*] |^-{3,}$|^\*{3,}$/)
    ) { paraLines.push(lines[i]!); i++; }
    if (paraLines.length) blocks.push({ type: "para", lines: paraLines });
  }
  return blocks;
}

export function Markdown({ children }: { children: string }) {
  const blocks = parseBlocks(children);
  return (
    <Box flexDirection="column">
      {blocks.map((b, bi) => {
        if (b.type === "heading") {
          return (
            <Box key={bi} marginTop={bi > 0 ? 1 : 0}>
              <InlineLine text={b.text} bold />
            </Box>
          );
        }
        if (b.type === "para") {
          return (
            <Box key={bi} marginTop={bi > 0 ? 1 : 0}>
              <InlineLine text={b.lines.join(" ")} />
            </Box>
          );
        }
        if (b.type === "code") {
          return (
            <Box key={bi} flexDirection="column" marginTop={1} paddingLeft={2}>
              <Text>{highlightCode(b.lines.join("\n"), b.lang)}</Text>
            </Box>
          );
        }
        if (b.type === "suggest") {
          return (
            <Box key={bi} flexDirection="column" marginTop={1}>
              <Text color="yellow" bold>Suggestion:</Text>
              <Box flexDirection="column" paddingLeft={2}>
                <Text>{highlightCode(b.lines.join("\n"), "diff")}</Text>
              </Box>
            </Box>
          );
        }
        if (b.type === "quote") {
          return (
            <Box key={bi} flexDirection="column" marginTop={bi > 0 ? 1 : 0}>
              {b.lines.map((l, li) => (
                <Box key={li} gap={1}>
                  <Text color="cyan">│</Text>
                  <InlineLine text={l} />
                </Box>
              ))}
            </Box>
          );
        }
        if (b.type === "bullet") {
          return (
            <Box key={bi} flexDirection="column" marginTop={bi > 0 ? 1 : 0}>
              {b.items.map((item, ii) => (
                <Box key={ii} gap={1}>
                  <Text dimColor>•</Text>
                  <InlineLine text={item} />
                </Box>
              ))}
            </Box>
          );
        }
        if (b.type === "hr") {
          return <Text key={bi} dimColor>────────────────────</Text>;
        }
        return null;
      })}
    </Box>
  );
}
