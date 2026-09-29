import { describe, expect, test } from "bun:test";
import { Program } from "../src/program.ts";
import { Checker, checkDeclarations } from "../src/scope.ts";
import { BodyChecker, type ExprFacts } from "../src/typeexpr.ts";
import { checkEffects } from "../src/effects.ts";
import { checkOwnership } from "../src/ownership.ts";
import { lowerToSystem, verifySystem } from "../src/system.ts";

/**
 * Runs the analysis passes without the semantic graph, so a failure here is attributable
 * to a specific pass rather than to whatever the graph happens to be doing.
 */
function analyze(sources: ReadonlyArray<{ module: string; text: string }>) {
  const program = new Program();
  for (const s of sources) {
    program.addFile({ module: s.module, text: s.text, bytes: new TextEncoder().encode(s.text) });
  }
  const checker = new Checker(program);
  checkDeclarations(checker);

  const facts: ExprFacts = { types: new Map(), calls: new Map(), constructions: new Map(), views: new Map() };
  let bodyChecker: BodyChecker | null = null;
  if (!program.diagnostics.some((d) => d.severity === "error" && d.code.startsWith("E02"))) {
    bodyChecker = new BodyChecker(checker);
    bodyChecker.checkAllFns();
    for (const [k, v] of bodyChecker.facts.types) { facts.types.set(k, v); checker.facts.set(k, v); }
    for (const [k, v] of bodyChecker.facts.calls) facts.calls.set(k, v);
    for (const [k, v] of bodyChecker.facts.constructions) facts.constructions.set(k, v);
    for (const [k, v] of bodyChecker.facts.views) facts.views.set(k, v);
  }
  checkEffects(checker, facts);
  checkOwnership(checker, bodyChecker);
  const system = lowerToSystem(checker);
  verifySystem(checker, system);
  return { program, system, codes: program.errors().map((d) => d.code), diags: program.errors() };
}

const one = (text: string) => analyze([{ module: "t", text }]);

describe("type checking", () => {
  test("accepts a well-typed program", () => {
    const r = one(`
      type Point = { x: f32, y: f32 }
      fn dist2(a: view Point, b: view Point) -> f32 {
        let dx = a.x - b.x
        let dy = a.y - b.y
        dx * dx + dy * dy
      }
    `);
    expect(r.diags.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  });

  test("reports an unknown type", () => {
    const r = one(`fn f(a: Nope) -> i64 { 0 }`);
    expect(r.codes).toContain("E0203");
  });

  test("reports generic arity mismatch", () => {
    const r = one(`
      type Pair[A, B] = { a: A, b: B }
      fn f(p: Pair<i64>) -> i64 { 0 }
    `);
    expect(r.codes).toContain("E0201");
  });

  test("reports a wrong argument type", () => {
    const r = one(`
      fn takes_i64(x: i64) -> i64 { x }
      fn bad() -> i64 { takes_i64("hello") }
    `);
    expect(r.codes).toContain("E0205");
  });

  test("reports a call arity mismatch", () => {
    const r = one(`
      fn takes_i64(x: i64) -> i64 { x }
      fn bad() -> i64 { takes_i64(1, 2) }
    `);
    expect(r.codes).toContain("E0206");
  });

  test("reports `?` on a non-Result", () => {
    const r = one(`
      fn bad() -> Result<i64, IoErr> {
        let x = 5
        x?
      }
    `);
    expect(r.codes).toContain("E0205");
  });

  test("reports a missing struct field", () => {
    const r = one(`
      type P = { x: i64, y: i64 }
      fn bad() -> P { P { x: 1 } }
    `);
    expect(r.codes).toContain("E0206");
  });

  test("reports a non-exhaustive match as a warning, not an error", () => {
    const r = one(`
      type Shape = Circle { r: i64 } | Rect { w: i64, h: i64 }
      fn f(s: view Shape) -> i64 {
        match s {
          Circle { r } => r
        }
      }
    `);
    expect(r.codes).not.toContain("E0206");
  });

  test("accepts exhaustive match over a union", () => {
    const r = one(`
      type Shape = Circle { r: i64 } | Rect { w: i64, h: i64 }
      fn f(s: view Shape) -> i64 {
        match s {
          Circle { r } => r
          Rect { w, h } => w * h
        }
      }
    `);
    expect(r.diags.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  });
});

describe("trust and authority", () => {
  test("a Cap cannot be constructed from a value (E0602)", () => {
    const r = one(`
      fn forge(ok: bool) -> Cap<bank.transfer> {
        Cap { name: "bank.transfer" }
      }
    `);
    expect(r.codes).toContain("E0602");
  });

  test("a Cap may be received as a parameter", () => {
    const r = one(`
      fn deploy(image: Text, prod: Cap<deploy.production>) -> Text !{deploy.production} {
        image
      }
    `);
    expect(r.codes).not.toContain("E0602");
  });
});

describe("effects", () => {
  test("a pub fn without an effect row is rejected (E0501)", () => {
    const r = one(`
      pub fn f(x: i64) -> i64 { x + 1 }
    `);
    expect(r.codes).toContain("E0501");
  });

  test("a pure pub fn may declare an empty row", () => {
    const r = one(`pub fn f(x: i64) -> i64 !{} { x + 1 }`);
    expect(r.codes).not.toContain("E0501");
  });

  test("a declared row narrower than the body is rejected (E0502)", () => {
    const r = one(`
      pub fn f(p: Path) -> Result<Bytes, IoErr> !{} {
        let b = fs.read(p)?
        b
      }
    `);
    // The declared row omits `fs.read`, which the body genuinely uses. A narrower row
    // would let a host grant less authority than the program needs, so it is an error.
    expect(r.codes).toContain("E0502");
  });

  test("effects are inferred for a private fn through a call chain", () => {
    const r = one(`
      fn inner(p: Path) -> Result<Bytes, IoErr> { fs.read(p) }
      pub fn outer(p: Path) -> Result<Bytes, IoErr> !{fs.read} { inner(p) }
    `);
    expect(r.codes).not.toContain("E0502");
  });

  test("an @intent fn must include the agent effect (E0704)", () => {
    const r = one(`
      type Route = choice { fast, deep }
      @intent
      pub fn triage(q: Text) -> Decision<Route> !{fs.read} { Decision { value: Route.fast, confidence: 0.9 } }
    `);
    expect(r.codes).toContain("E0704");
  });

  test("an @intent fn must return a Decision (E0705)", () => {
    const r = one(`
      @intent
      pub fn triage(q: Text) -> Text !{agent, nondet} { "x" }
    `);
    expect(r.codes).toContain("E0705");
  });
});

describe("Type to System", () => {
  test("a resource must name a close function that accepts it (E0703)", () => {
    const r = one(`
      @resource(close = fs.close)
      type File = Handle<i32>
      fn fclose(x: i32) -> bool !{fs.close} { true }
    `);
    expect(r.codes).toContain("E0703");
  });

  test("a well-formed resource contract produces a resource entry", () => {
    const r = one(`
      @resource(close = close_file)
      type File = Handle<i32>
      fn close_file(f: File) -> bool !{fs.close} { true }
    `);
    expect(r.codes).not.toContain("E0703");
    expect(r.system?.entries.some((e) => e.kind === "resource")).toBe(true);
  });

  test("a @wire type containing a @secret field is rejected (E0701)", () => {
    const r = one(`
      @secret
      type Token = Bytes
      @wire
      type Job = { id: u64, token: Token }
    `);
    expect(r.codes).toContain("E0701");
  });

  test("@wire produces a schema version that is content-derived", () => {
    const r = one(`@wire type Job = { id: u64, input: Bytes }`);
    const wire = r.system?.entries.find((e) => e.kind === "wire");
    expect(wire).toBeDefined();
    expect(wire?.schemaVersion).toMatch(/^[0-9a-f]{8}$/);
  });

  test("@persist without @wire is rejected (E0702)", () => {
    const r = one(`@persist(ttl = 10m) type Cache = { k: u64 }`);
    expect(r.codes).toContain("E0702");
  });

  test("the system plan lists the program's requested authority", () => {
    const r = one(`
      pub fn f(p: Path) -> Result<Bytes, IoErr> !{fs.read, net} { fs.read(p) }
    `);
    expect(r.system?.requested).toContain("fs.read");
  });
});
