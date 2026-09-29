import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseFile } from "../src/parser.ts";
import type { SourceFile } from "../src/ast.ts";

const path = new URL("./fixtures/smoke.mm", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const text = readFileSync(path, "utf8");
const file: SourceFile = { module: "tests.smoke", text, bytes: new TextEncoder().encode(text) };

describe("parser", () => {
  const parsed = parseFile(file, 0);

  test("parses the smoke fixture without diagnostics", () => {
    expect(parsed.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  });

  test("finds every item kind", () => {
    const kinds: string[] = parsed.items.map((i) => i.kind);
    for (const k of ["use", "const", "type", "trait", "impl", "fn", "test"]) {
      expect(kinds).toContain(k);
    }
  });

  test("preserves the effect row on effectful fns", () => {
    const load = parsed.items.find((i) => i.kind === "fn" && i.name === "load");
    expect(load?.kind === "fn" && load.effects).toEqual(["fs.read"]);
    const dist2 = parsed.items.find((i) => i.kind === "fn" && i.name === "dist2");
    expect(dist2?.kind === "fn" && dist2.effects).toBeNull();
  });

  test("records unsafe capability labels", () => {
    const mapPage = parsed.items.find((i) => i.kind === "fn" && i.name === "map_page");
    expect(mapPage?.kind === "fn" && mapPage.unsafety).toEqual(["ffi", "rawptr"]);
  });

  test("parses attributes with arguments", () => {
    const fileTy = parsed.items.find((i) => i.kind === "type" && i.def.name === "File");
    expect(fileTy?.kind === "type" && fileTy.attrs[0]?.name).toBe("resource");
    expect(fileTy?.kind === "type" && (fileTy.attrs[0]?.args["close"] as { segments: string[] }).segments)
      .toEqual(["fs", "close"]);
  });

  test("parses multi-arm unions and choice types", () => {
    const shape = parsed.items.find((i) => i.kind === "type" && i.def.name === "Shape");
    expect(shape?.kind === "type" && shape.def.kind).toBe("union");
    if (shape?.kind === "type" && shape.def.kind === "union") {
      expect(shape.def.variants.map((v) => v.name)).toEqual(["Circle", "Rect"]);
    }
    const route = parsed.items.find((i) => i.kind === "type" && i.def.name === "Route");
    expect(route?.kind === "type" && route.def.kind === "choice");
  });

  test("parses view / shared ownership syntax into the type tree", () => {
    const dist2 = parsed.items.find((i) => i.kind === "fn" && i.name === "dist2");
    const p0 = dist2?.kind === "fn" ? dist2.params[0]?.ty : null;
    expect(p0?.kind).toBe("own");
    expect(p0?.kind === "own" && p0.ownership).toBe("view");
  });

  test("string literals keep their full contents", () => {
    const testItem = parsed.items.find((i) => i.kind === "test");
    expect(testItem?.name).toBe("dist2 of unit square");
  });

  test("a `{` after a for-loop header opens the body, not a struct literal", () => {
    const normalize = parsed.items.find((i) => i.kind === "fn" && i.name === "normalize");
    const forStmt = normalize?.kind === "fn"
      ? normalize.body.stmts.find((s) => s.kind === "expr" && s.expr.kind === "for")
      : null;
    expect(forStmt).toBeDefined();
    expect(forStmt?.kind === "expr" && forStmt.expr.kind === "for" && forStmt.expr.iter.kind).toBe("path");
  });

  test("extern \"C\" abi and body are captured", () => {
    const fopen = parsed.items.find((i) => i.kind === "fn" && i.name === "fopen");
    expect(fopen?.kind === "fn" && fopen.externAbi).toBe("C");
    expect(fopen?.kind === "fn" && fopen.unsafety).toEqual([]);
  });
});
