import { describe, expect, test } from "bun:test";
import { parseFile } from "../src/parser.ts";
import type { SourceFile } from "../src/ast.ts";

function parse(module: string, text: string) {
  const file: SourceFile = { module, text, bytes: new TextEncoder().encode(text) };
  return parseFile(file, 0);
}

describe("front end regressions", () => {
  test("non-ASCII text in a comment does not desynchronize spans", () => {
    // The lexer used to index a byte array while every consumer sliced the JS string.
    // Once a multi-byte character appeared, every later offset was wrong, which showed up
    // as a crash or a bogus diagnostic somewhere unrelated.
    const text = [
      "// rótate the façade by 45° — naïve, but ASCII-only code must still work",
      "const MAX: usize = 4096",
      "fn twice(x: i64) -> i64 { x * 2 }",
    ].join("\n");
    const parsed = parse("t", text);
    expect(parsed.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
    const fn = parsed.items.find((i) => i.kind === "fn" && i.name === "twice");
    expect(fn).toBeDefined();
    // The name span must point at `twice` in the *string*, not at some byte offset.
    expect(fn?.kind === "fn" ? text.slice(fn.nameSpan.start, fn.nameSpan.end) : "").toBe("twice");
  });

  test("non-ASCII inside a string literal round-trips", () => {
    const text = `fn greet() -> Text { "héllo wörld — ok" }`;
    const parsed = parse("t", text);
    expect(parsed.diagnostics).toEqual([]);
    const fn = parsed.items.find((i) => i.kind === "fn" && i.name === "greet");
    const ret = fn?.kind === "fn" ? fn.body.tail : null;
    expect(ret?.kind).toBe("string");
    expect(ret?.kind === "string" && ret.value).toBe("héllo wörld — ok");
  });

  test("a for loop is a statement, not the block's tail value", () => {
    // A trailing `for` used to be parsed as the block's value, which ended the block early
    // and silently discarded every statement after it.
    const text = [
      "fn total(xs: [i64]) -> i64 {",
      "    let s = 0",
      "    for x in xs { s += x }",
      "    let doubled = s * 2",
      "    doubled",
      "}",
    ].join("\n");
    const parsed = parse("t", text);
    expect(parsed.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
    const fn = parsed.items.find((i) => i.kind === "fn" && i.name === "total");
    // `let s`, the `for` loop, `let doubled` — then `doubled` as the tail, recorded once.
    expect(fn?.kind === "fn" ? fn.body.stmts.length : 0).toBe(3);
    expect(fn?.kind === "fn" ? fn.body.tail?.kind : null).toBe("path");
  });

  test("an if expression is not taken as a tail without a return type", () => {
    const text = [
      "fn pick(c: bool) {",
      "    if c { 1 } else { 2 }",
      "    let z = 0",
      "}",
    ].join("\n");
    const parsed = parse("t", text);
    expect(parsed.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
    const fn = parsed.items.find((i) => i.kind === "fn" && i.name === "pick");
    expect(fn?.kind === "fn" ? fn.body.stmts.length : 0).toBe(2);
  });

  test("a value-returning tail is still recognised", () => {
    const text = "fn one() -> i64 { 1 }";
    const parsed = parse("t", text);
    const fn = parsed.items.find((i) => i.kind === "fn" && i.name === "one");
    expect(fn?.kind === "fn" ? fn.body.tail?.kind : null).toBe("int");
  });
});
