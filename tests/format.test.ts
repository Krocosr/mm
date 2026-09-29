import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compactSource, fingerprint, formatFile } from "../src/format.ts";
import { parseFile } from "../src/parser.ts";
import type { SourceFile } from "../src/ast.ts";

const fixturePath = new URL("./fixtures/smoke.mm", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const smokeText = readFileSync(fixturePath, "utf8");

function source(text: string, module = "tests.format"): SourceFile {
  return { module, text, bytes: new TextEncoder().encode(text) };
}

function roundTrip(text: string): { out: string; before: string; after: string } {
  const out = formatFile(source(text));
  return {
    out,
    before: fingerprint(parseFile(source(text), 0).items),
    after: fingerprint(parseFile(source(out), 0).items),
  };
}

describe("format", () => {
  test("round-trips the smoke fixture without introducing diagnostics", () => {
    const out = formatFile(source(smokeText));
    expect(parseFile(source(smokeText), 0).diagnostics).toEqual([]);
    expect(parseFile(source(out), 0).diagnostics).toEqual([]);
  });

  test("is idempotent: formatting the output changes nothing", () => {
    const once = formatFile(source(smokeText));
    const twice = formatFile(source(once));
    expect(twice).toBe(once);
  });

  test("preserves the program structurally across format + reparse", () => {
    const { before, after } = roundTrip(smokeText);
    expect(after).toBe(before);
  });

  test("is byte-identical across runs and across equal inputs", () => {
    // Two independent `SourceFile` values with the same text, formatted separately:
    // the output cannot depend on object identity, map order, or anything else
    // that differs between two evaluations of the same input.
    expect(formatFile(source(smokeText))).toBe(formatFile(source(smokeText)));
    expect(formatFile(source(smokeText, "a"))).toBe(formatFile(source(smokeText, "b")));
  });

  test("emits a trailing newline and no trailing whitespace", () => {
    const out = formatFile(source(smokeText));
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
    for (const line of out.split("\n")) {
      expect(line).toBe(line.replace(/\s+$/, ""));
    }
  });

  test("separates top-level items with exactly one blank line", () => {
    const out = formatFile(source("fn a() {}\nfn b() {}\n\n\n\nfn c() {}\n"));
    expect(out).toBe("fn a() {}\n\nfn b() {}\n\nfn c() {}\n");
  });

  test("keeps the surface syntax the language is judged on", () => {
    const out = formatFile(source(smokeText));
    expect(out).toContain("fn load(path: Path) -> Result<Bytes, IoErr> !{fs.read} {");
    expect(out).toContain("@resource(close = fs.close)");
    expect(out).toContain("unsafe[ffi, rawptr] fn map_page(p: *mut u8, n: usize) -> view mut [u8] {");
    expect(out).toContain('extern "C" unsafe fn fopen(path: *const c8, mode: *const c8) -> *mut CFile {');
    expect(out).toContain("fn normalize(xs: view mut [f32]) {");
    expect(out).toContain("-> Decision<Q.Output> !{agent, nondet}");
  });

  test("keeps the [T; N] array form and other type surface syntax", () => {
    const src = [
      "type Buf = { bytes: [u8; 4096], tag: ?Text, raw: *const u8, owned: arena Node }",
      "type Fp = fn(u8) -> bool !{agent}",
      "type Show = dyn Display + Clone",
      "",
    ].join("\n");
    const { out, before, after } = roundTrip(src);
    expect(out).toContain("[u8; 4096]");
    expect(out).toContain("fn(u8) -> bool !{agent}");
    expect(out).toContain("dyn Display + Clone");
    expect(after).toBe(before);
  });

  test("keeps the augmented assignment the author wrote", () => {
    const augmented = roundTrip("fn f() {\n    x /= s;\n}\n");
    expect(augmented.out).toContain("x /= s;");
    expect(augmented.after).toBe(augmented.before);

    // An explicit `x = x / s` is a different surface form with the same tree, and
    // must not be rewritten into the compound one.
    const explicit = roundTrip("fn f() {\n    x = x / s;\n}\n");
    expect(explicit.out).toContain("x = x / s;");
    expect(explicit.after).toBe(explicit.before);
  });

  test("keeps qualified paths the parser does not retain", () => {
    const { out, before, after } = roundTrip("fn f() {\n    let b = fs.open(path)?;\n}\n");
    expect(out).toContain("fs.open(path)?");
    expect(after).toBe(before);
  });

  test("keeps float literals float", () => {
    const { out, before, after } = roundTrip("fn f() {\n    let a = 25.0;\n    let b = 0.5;\n}\n");
    expect(out).toContain("25.0");
    expect(out).toContain("0.5");
    expect(after).toBe(before);
  });

  test("never deletes a comment", () => {
    const src = [
      "// file header",
      "/* block",
      "   comment */",
      "@wire",
      "type Job = { id: u64 }",
      "",
      "fn run() {",
      "    // leading statement comment",
      "    let a = 1; // trailing statement comment",
      "    let b = 2;",
      "}",
      "// end of file",
      "",
    ].join("\n");
    const out = formatFile(source(src));
    expect(out).toContain("// file header");
    expect(out).toContain("/* block");
    // The continuation line is re-indented to the current depth rather than
    // keeping the column the author happened to put it in.
    expect(out).toContain("comment */");
    expect(out).toContain("// leading statement comment");
    expect(out).toContain("let a = 1; // trailing statement comment");
    expect(out).toContain("// end of file");
    expect(formatFile(source(out))).toBe(out);
  });

  test("keeps a comment that cannot be attached, rather than dropping it", () => {
    // The comment sits between the arguments of a call: a syntax-only formatter
    // has no node to hang it on, so it is emitted on its own line in order.
    const src = "fn f() {\n    let v = g(1, /* keep me */ 2);\n}\n";
    const out = formatFile(source(src));
    expect(out).toContain("/* keep me */");
    expect(formatFile(source(out))).toBe(out);
  });

  test("preserves a blank line the author left between statements", () => {
    const src = "fn f() {\n    let a = 1;\n\n    let b = 2;\n}\n";
    expect(formatFile(source(src))).toBe(src);
  });

  test("is stable on an empty file and on a file that is only comments", () => {
    expect(formatFile(source(""))).toBe("");
    expect(formatFile(source("\n\n"))).toBe("");
    const onlyComments = formatFile(source("// just a note\n"));
    expect(onlyComments).toBe("// just a note\n");
    expect(formatFile(source(onlyComments))).toBe(onlyComments);
  });
});

describe("compactSource", () => {
  test("removes comments and collapses inter-token whitespace", () => {
    const compacted = compactSource(source(smokeText));
    expect(compacted).not.toContain("//");
    expect(compacted).not.toContain("\n");
    expect(compacted).toContain("use std.fs.{read, write}");
    expect(compacted.length).toBeLessThan(smokeText.length);
  });

  test("leaves string and byte literals untouched", () => {
    const compacted = compactSource(source('fn f() {\n    let s = "a  b"; // gone\n    let t = b"x  y";\n}\n'));
    expect(compacted).toContain('"a  b"');
    expect(compacted).toContain('b"x  y"');
  });

  test("agrees with the token stream, not with a regex", () => {
    // The `//` is inside a string, so a naive comment stripper would eat the rest
    // of the line; the lexer knows it is not a comment.
    const compacted = compactSource(source('fn f() {\n    let s = "http://x";\n}\n'));
    expect(compacted).toContain('"http://x"');
  });
});
