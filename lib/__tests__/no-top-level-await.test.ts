import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import ts from "typescript";

/**
 * Regression guard for RT's `bun build --compile --bytecode` blocker: a real
 * top-level await anywhere in the bundled module graph makes the module
 * async-initializing. Grepping the bundle text for `await init_<module>()`
 * would false-positive on the (legitimate, out-of-scope) ink/rt-render
 * component chain, which is reached only via dynamic `import()` deep inside
 * already-async command handlers — those calls sit inside a function, so
 * they are not top-level await. The correct check is scope-aware: does any
 * `await` expression have no enclosing function-like ancestor at all.
 */
function findTopLevelAwaits(sourceText: string, fileName: string): { line: number; text: string }[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const isFunctionLike = (node: ts.Node): boolean =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node);

  const found: { line: number; text: string }[] = [];
  const visit = (node: ts.Node, insideFunction: boolean) => {
    if (ts.isAwaitExpression(node) && !insideFunction) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      found.push({ line: line + 1, text: node.getText(sourceFile).slice(0, 160) });
    }
    const nextInsideFunction = insideFunction || isFunctionLike(node);
    ts.forEachChild(node, (child) => visit(child, nextInsideFunction));
  };
  visit(sourceFile, false);
  return found;
}

describe("bun-compile TLA regression guard", () => {
  test("the bundled cli.ts entrypoint contains no genuine top-level await", async () => {
    const outdir = mkdtempSync(join(tmpdir(), "rt-tla-check-"));
    try {
      const entry = join(import.meta.dir, "..", "..", "cli.ts");
      const result = await Bun.build({ entrypoints: [entry], outdir, target: "bun" });
      expect(result.success).toBe(true);

      const output = result.outputs.find((o) => o.kind === "entry-point");
      expect(output).toBeDefined();
      const bundled = await output!.text();

      const topLevelAwaits = findTopLevelAwaits(bundled, "cli.bundle.js");
      if (topLevelAwaits.length > 0) {
        const detail = topLevelAwaits.map((a) => `  line ${a.line}: ${a.text}`).join("\n");
        throw new Error(
          `Found ${topLevelAwaits.length} genuine top-level await(s) in the bundled cli.ts — ` +
          `this blocks \`bun build --compile --bytecode\` and makes cli.ts async-initializing:\n${detail}`,
        );
      }
      expect(topLevelAwaits).toEqual([]);
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  }, 10_000);
});
