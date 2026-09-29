import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Program } from "../src/program.ts";
import type { SourceFile } from "../src/ast.ts";

const fixturesDir = new URL("./fixtures", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function loadProgram(dir: string): Program {
  const program = new Program();
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".mm")) continue;
    const full = join(dir, entry);
    const text = readFileSync(full, "utf8");
    const module = entry.replace(/\.mm$/, "").replace(/\//g, "::");
    program.addFile({ module, text, bytes: new TextEncoder().encode(text) } satisfies SourceFile);
  }
  return program;
}

describe("program loading", () => {
  const program = loadProgram(fixturesDir);

  test("loads without diagnostics", () => {
    expect(program.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  });

  test("indexes every definition kind", () => {
    expect(program.allFns().length).toBeGreaterThanOrEqual(6);
    expect(program.allTypes().map((t) => t.name)).toEqual(
      expect.arrayContaining(["Point", "Shape", "Route", "Node", "File", "Job", "ApiToken"]),
    );
    expect(program.tests.size).toBe(1);
    expect(program.traits.size).toBe(1);
    expect(program.impls.size).toBe(1);
    expect(program.consts.size).toBeGreaterThanOrEqual(1);
  });

  test("records Type->System attributes on type info", () => {
    const file = program.typeInfo.get(
      program.resolveType("File", "smoke") ?? 0,
    );
    expect(file?.isResource).toBe(true);
    const token = program.typeInfo.get(program.resolveType("ApiToken", "smoke") ?? 0);
    expect(token?.isSecret).toBe(true);
    const job = program.typeInfo.get(program.resolveType("Job", "smoke") ?? 0);
    expect(job?.isWire).toBe(true);
  });

  test("resolves builtins without a prelude module", () => {
    expect(program.resolveType("Result", "smoke")).toBe(-1);
    expect(program.resolveType("Decision", "smoke")).toBe(-5);
    expect(program.resolveType("Untrusted", "smoke")).toBe(-6);
    expect(program.resolveType("Cap", "smoke")).toBe(-8);
  });

  test("assigns unique ids to every definition", () => {
    const ids = [
      ...program.allFns().map((f) => f.id),
      ...program.allTypes().map((t) => t.id),
      ...program.tests.keys(),
      ...program.traits.keys(),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("parameter ownership is extracted from the declared type", () => {
    const dist2 = program.allFns().find((f) => f.name === "dist2");
    expect(dist2?.fn.params.map((p) => p.ownership)).toEqual(["view", "view"]);
    const walk = program.allFns().find((f) => f.name === "walk");
    expect(walk?.fn.params.map((p) => p.ownership)).toEqual(["shared", "owned"]);
  });

  test("effect rows survive lowering", () => {
    const load = program.allFns().find((f) => f.name === "load");
    expect(load?.declaredEffects).toEqual(["fs.read"]);
    const dist2 = program.allFns().find((f) => f.name === "dist2");
    expect(dist2?.declaredEffects).toBeNull();
  });
});
