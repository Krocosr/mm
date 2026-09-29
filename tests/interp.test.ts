import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";
import type { Diagnostic, Expr } from "../src/ast.ts";
import { describe, expect, test } from "bun:test";
import type { SourceFile } from "../src/ast.ts";
import { Program } from "../src/program.ts";
import { evalConst, evalConstFn, evalConstLen } from "../src/interp/consteval.ts";
import { Interp, runFn, runTest, type RunResult } from "../src/interp/interp.ts";
import { createDecider, fixedProvider, readDecisionLog, DecisionLog } from "../src/interp/replay.ts";
import { intV, textV, UNIT, type Value } from "../src/interp/value.ts";

/** Load one MM source string as a one-module program. */
function load(text: string, module = "t"): Program {
  const program = new Program();
  program.addFile({
    module, text, bytes: new TextEncoder().encode(text),
  } satisfies SourceFile);
  return program;
}

function fnId(program: Program, name: string): number {
  const id = program.resolveFn(name, program.modules[0] ?? "t");
  if (id === null) throw new Error(`no function \`${name}\` in test source`);
  return id;
}

function call(program: Program, name: string, args: Value[] = [], fuel?: number): RunResult {
  return runFn(program, fnId(program, name), args, fuel === undefined ? {} : { fuel });
}

function errors(r: RunResult): string[] {
  return r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.kind}`);
}

/** Diagnostic codes of a run *or* a compile-time evaluation — both report the same way. */
function codes(r: { diagnostics: readonly Diagnostic[] }): string[] {
  return r.diagnostics.map((d) => d.code);
}

// ---------------------------------------------------------------------------

describe("evaluation", () => {
  const program = load(`
fn add(a: u32, b: u32) -> u32 { a + b }
fn wide(a: u64, b: u64) -> u64 { a * b }
fn mix(a: u32, b: f32) -> f32 { a * b + 1.0 }
fn divzero(a: u32, b: u32) -> u32 { a / b }
`);

  test("integers stay exact past 2^53", () => {
    const r = call(program, "wide", [intV(1n << 40n), intV(1n << 40n)]);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ k: "int", v: 1n << 80n });
  });

  test("a float operand promotes the whole expression", () => {
    const r = call(program, "mix", [intV(3), { k: "float", v: 1.5 }]);
    expect(r.value).toEqual({ k: "float", v: 5.5 });
  });

  test("division by zero is a diagnostic, not a crash", () => {
    const r = call(program, "divzero", [intV(1), intV(0)]);
    expect(errors(r)).toEqual(["E0122 division_by_zero"]);
  });
});

describe("records and unions", () => {
  const program = load(`
type Point = { x: f32, y: f32 }

type Shape =
    Circle { r: f32 }
  | Rect { w: f32, h: f32 }

fn mk() -> Point { Point { x: 1.0, y: 2.0 } }
fn field_sum(p: view Point) -> f32 { p.x + p.y }

fn area(s: view Shape) -> f32 {
    match s {
        Circle { r } => 3.0 * r * r
        Rect { w, h } => w * h
    }
}

fn circle(r: f32) -> Shape { Circle { r: r } }
fn rect(w: f32, h: f32) -> Shape { Rect { w: w, h: h } }
`);

  test("struct literal and field access", () => {
    expect(call(program, "mk").value).toEqual({
      k: "record", name: "Point", fields: { x: { k: "float", v: 1 }, y: { k: "float", v: 2 } },
    });
  });

  test("a record passed as `view` is readable through the view", () => {
    const p = call(program, "mk").value;
    const r = call(program, "field_sum", [p]);
    expect(errors(r)).toEqual([]);
    expect(r.value).toEqual({ k: "float", v: 3 });
  });

  test("a union variant matches on its record fields", () => {
    const c = call(program, "circle", [{ k: "float", v: 2 }]).value;
    const rc = call(program, "area", [c]);
    expect(errors(rc)).toEqual([]);
    expect(rc.value).toEqual({ k: "float", v: 12 });

    const box = call(program, "rect", [{ k: "float", v: 2 }, { k: "float", v: 5 }]).value;
    expect(call(program, "area", [box]).value).toEqual({ k: "float", v: 10 });
  });
});

describe("Result and `?` propagation", () => {
  const program = load(`
fn checked(x: u32) -> Result<u32, Text> {
    if x > 10 { Ok(x) } else { Err("too small") }
}

fn doubled(x: u32) -> Result<u32, Text> {
    let v = checked(x)?
    Ok(v * 2)
}

fn always_err() -> Result<u32, Text> { Err("boom") }
`);

  test("`?` unwraps Ok", () => {
    const r = call(program, "doubled", [intV(20)]);
    expect(errors(r)).toEqual([]);
    expect(r.value).toEqual({
      k: "variant", name: "Ok", type: "builtin", payload: { k: "int", v: 40n },
    });
  });

  test("`?` propagates Err to the function boundary", () => {
    const r = call(program, "doubled", [intV(1)]);
    expect(errors(r)).toEqual([]);
    expect(r.value).toEqual({
      k: "variant", name: "Err", type: "builtin", payload: { k: "text", v: "too small" },
    });
  });

  test("`?` on a non-Result is a diagnostic", () => {
    const bad = load(`
fn f() -> u32 {
    let v = 1?
    v
}
`);
    const r = call(bad, "f");
    expect(errors(r)).toEqual(["E0123 try_on_non_result"]);
  });
});

describe("slices, view mut, and for loops", () => {
  const program = load(`
fn double_all(xs: view mut [u32]) {
    for x in xs {
        x *= 2
    }
}

fn run() -> [u32] {
    let xs = [1, 2, 3]
    double_all(xs);
    xs
}

fn total(xs: view [u32]) -> u32 { sum(xs) }
`);

  test("`for x in xs` over `view mut` writes back into the caller's slice", () => {
    const r = call(program, "run");
    expect(errors(r)).toEqual([]);
    expect(r.value).toEqual({
      k: "slice", len: 3,
      elems: [{ k: "int", v: 2n }, { k: "int", v: 4n }, { k: "int", v: 6n }],
    });
  });

  test("a builtin sees through the view", () => {
    const slice: Value = { k: "slice", len: 3, elems: [intV(1), intV(2), intV(3)] };
    expect(call(program, "total", [slice]).value).toEqual({ k: "int", v: 6n });
  });
});

describe("shared reference counting (R-Own-6)", () => {
  const program = load(`
fn counted() -> u32 {
    let s = shared_new(7)
    let c = shared_clone(s)
    shared_rc(c)
}

fn leaked() -> u32 {
    let s = shared_new(9)
    shared_escape(s)
    shared_rc(s)
}
`);

  test("clone raises the count and scope exit releases both", () => {
    const r = call(program, "counted");
    expect(r.value).toEqual({ k: "int", v: 2n });
    expect(r.leaks).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test("a shared that escapes into a host container is reported, not silently dropped", () => {
    const r = call(program, "leaked");
    expect(r.leaks.length).toBe(1);
    expect(r.diagnostics.map((d) => d.kind)).toContain("shared_leak");
    expect(r.ok).toBe(false);
  });
});

describe("arena allocation and invalidation (R-Own-7)", () => {
  const program = load(`
fn store_then_read() -> u32 {
    let a = arena_new()
    let r = arena_alloc(a, 42)
    arena_load(r)
}

fn read_after_destroy() -> u32 {
    let a = arena_new()
    let r = arena_alloc(a, 42)
    arena_destroy(a);
    arena_load(r)
}
`);

  test("an arena reference reads back what was allocated", () => {
    const r = call(program, "store_then_read");
    expect(errors(r)).toEqual([]);
    expect(r.value).toEqual({ k: "int", v: 42n });
  });

  test("a reference into a destroyed arena is a run-time error", () => {
    const r = call(program, "read_after_destroy");
    expect(codes(r)).toContain("E0415");
    expect(r.ok).toBe(false);
  });
});

describe("generational handles (R-Own-8)", () => {
  const program = load(`
fn live() -> u32 {
    let s = handle_store()
    let h = handle_alloc(s, 11)
    handle_load(h);
}

fn stale() -> u32 {
    let s = handle_store()
    let h = handle_alloc(s, 11)
    handle_free(h);
    let h2 = handle_alloc(s, 22)
    handle_load(h)
}
`);

  test("a live handle dereferences", () => {
    const r = call(program, "live");
    expect(errors(r)).toEqual([]);
    expect(r.value).toEqual({ k: "int", v: 11n });
  });

  test("a freed-then-reused slot makes the old handle stale at run time (E0416)", () => {
    const r = call(program, "stale");
    expect(codes(r)).toContain("E0416");
    expect(r.diagnostics.find((d) => d.code === "E0416")?.kind).toBe("stale_handle");
  });
});

describe("drop elaboration on @resource (kernel.md §6.5)", () => {
  const program = load(`
@resource(close = fs.close)
type File = { id: u32 }

fn early_return() -> u32 {
    let f = resource_new("File", 1, "fs.close")
    let g = resource_new("File", 2, "fs.close")
    return 7
}

fn inner(x: u32) -> Result<u32, Text> {
    if x > 0 { Ok(x) } else { Err("no") }
}

fn propagating(x: u32) -> Result<u32, Text> {
    let f = resource_new("File", 3, "fs.close")
    let v = inner(x)?
    Ok(v)
}

fn scoped() -> u32 {
    let f = resource_new("File", 4, "fs.close")
    0
}
`);

  test("an early return still closes every initialized resource, in reverse order", () => {
    const r = call(program, "early_return");
    expect(errors(r)).toEqual([]);
    expect(r.value).toEqual({ k: "int", v: 7n });
    expect(r.closes).toEqual([
      { type: "File", closeFn: "fs.close", reason: "return" },
      { type: "File", closeFn: "fs.close", reason: "return" },
    ]);
  });

  test("`?`-propagation closes resources on the way out", () => {
    const r = call(program, "propagating", [intV(0)]);
    expect(errors(r)).toEqual([]);
    expect(r.value).toEqual({
      k: "variant", name: "Err", type: "builtin", payload: { k: "text", v: "no" },
    });
    expect(r.closes).toEqual([{ type: "File", closeFn: "fs.close", reason: "propagate" }]);
  });

  test("a normal scope exit closes exactly once", () => {
    const r = call(program, "scoped");
    expect(r.closes).toEqual([{ type: "File", closeFn: "fs.close", reason: "scope" }]);
  });

  test("a resource is closed exactly once even when closed explicitly first", () => {
    const once = load(`
fn f() -> u32 {
    let r = resource_new("F", 1, null as Text)
    resource_close(r)
    resource_close(r)
    0
}
`);
    const r = call(once, "f");
    expect(codes(r)).toContain("E0417");
    expect(r.closes.length).toBe(1);
  });
});

describe("fuel", () => {
  const program = load(`
fn spin() -> u32 {
    loop {
        let x = 1
    }
}
`);

  test("exhausting the step budget aborts instead of hanging", () => {
    const started = Date.now();
    const r = call(program, "spin", [], 500);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.map((d) => d.kind)).toContain("fuel_exhausted");
    expect(r.fuel).toBe(0);
  });

  test("an infinite recursion hits the depth limit rather than a stack overflow", () => {
    const rec = load(`
fn down(n: u32) -> u32 { down(n + 1) }
`);
    const r = call(rec, "down", [intV(0)]);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.map((d) => d.kind)).toContain("call_depth_exceeded");
  });
});

describe("test items", () => {
  const program = load(`
test "passes" {
    assert_eq(1 + 1, 2)
}

test "fails" {
    assert_eq(1, 2)
}
`);

  test("a passing test is ok", () => {
    const id = [...program.tests.keys()][0]!;
    expect(runTest(program, id).ok).toBe(true);
  });

  test("a failing assertion is a diagnostic with a span, not a crash", () => {
    const id = [...program.tests.keys()][1]!;
    const r = runTest(program, id);
    expect(r.ok).toBe(false);
    const d = r.diagnostics[0]!;
    expect(d.code).toBe("E0191");
    expect(d.kind).toBe("assertion_failed");
    expect(d.span.file).toBe(0);
  });
});

describe("capability gating", () => {
  const program = load(`
fn tries_to_read() -> Text { read_file("x") }
`);

  test("an effectful builtin names the missing capability instead of faking success", () => {
    const r = call(program, "tries_to_read");
    expect(codes(r)).toContain("E0503");
    expect(r.diagnostics.find((d) => d.kind === "missing_capability")?.data)
      .toEqual({ capability: "fs.read", builtin: "read_file" });
  });
});

// ---------------------------------------------------------------------------
// const evaluation (kernel.md §8)
// ---------------------------------------------------------------------------

describe("const evaluation", () => {
  test("a const item's expression evaluates at compile time", () => {
    const program = load(`
const N: usize = 4 * 2 + 1
fn use() -> usize { N }
`);
    const id = program.resolveConst("N", "t");
    expect(id).not.toBeNull();
    const item = program.consts.get(id!)!;
    const r = evalConst(program, item.value as never, 1_000_000, "t");
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ k: "int", v: 9n });
  });

  test("a `const` array length evaluates", () => {
    const program = load(`
const WIDTH: usize = 3
type Buf = [u8; WIDTH * WIDTH]
`);
    const typeId = program.resolveType("Buf", "t")!;
    const def = program.units[0]!.types.find((t) => t.id === typeId)!.def;
    // `[u8; N]` is an alias whose target is a sized slice. The layout query the const
    // evaluator needs is the length expression carried on that target.
    expect(def.form).toBe("alias");
    const target = def.form === "alias" ? def.target : null;
    expect(target?.kind).toBe("slice");
    const lenExpr = target?.kind === "slice" ? target.lenExpr : undefined;
    expect(lenExpr).toBeDefined();
    const r = evalConstLen(program, lenExpr!, "t");
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ k: "int", v: 9n });
  });

  test("fuel exhaustion in a const fn is a compile error, not a hang", () => {
    const program = load(`
const fn spin() -> u32 {
    loop {
        let x = 1
    }
}
`);
    const id = program.resolveConst("spin", "t")!;
    const started = Date.now();
    const r = evalConstFn(program, id, [], 400);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.map((d) => d.kind)).toContain("fuel_exhausted");
  });

  test("a `const fn` evaluates", () => {
    const program = load(`
const fn square(n: u32) -> u32 { n * n }
`);
    const id = program.resolveConst("square", "t")!;
    const r = evalConstFn(program, id, [intV(7)]);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ k: "int", v: 49n });
  });

  test("an effectful call inside a const fn is rejected before evaluation", () => {
    const program = load(`
fn read_config() -> u32 !{fs.read} { 1 }

const fn bad() -> u32 {
    read_config()
}
`);
    const id = program.resolveConst("bad", "t")!;
    const r = evalConstFn(program, id, []);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("E0503");
    expect(r.diagnostics[0]!.data).toEqual({ effects: ["fs.read"], fn: "read_config" });
  });

  test("a capability-gated builtin inside a const expression is rejected", () => {
    const program = load(`
fn grab() -> u32 { now() }
`);
    const id = program.resolveFn("grab", "t")!;
    const body = program.fnInfo.get(id)!.fn.body;
    const r = evalConst(program, body.tail!, 1_000_000, "t");
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("E0503");
  });

  test("a non-`const fn` call at compile time is rejected", () => {
    const program = load(`
fn plain(n: u32) -> u32 { n + 1 }
`);
    const id = program.resolveFn("plain", "t")!;
    const fnValue: Value = { k: "fn", id, name: "plain" };
    const callExpr: Expr = { kind: "call", callee: { kind: "path", value: "plain", span: { start: 0, end: 0, file: 0 } }, args: [], span: { start: 0, end: 0, file: 0 } };
    const r = evalConst(program, callExpr, 1_000_000, "t");
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// replay (kernel.md §8 determinism, decision recording)
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "mm-replay-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A provider whose answer depends on a counter, so live runs genuinely differ. */
function countingProvider() {
  let n = 0;
  const calls: string[] = [];
  const provider = fixedProvider("counting", "m1", (req) => {
    n += 1;
    calls.push(req.inputHash);
    return { value: textV(`answer-${n}`), confidence: 0.5 };
  });
  return { provider, calls };
}

function decideProgram() {
  return load(`
fn ask(x: Text) -> Text {
    let d = x.decide()
    decision_value(d)
}
`);
}

describe("decision replay", () => {
  test("record then replay returns the identical decision", () => {
    const { provider, calls } = countingProvider();
    const log = new DecisionLog();
    const recorder = createDecider({ mode: "record", provider, log });
    const program = decideProgram();
    const first = runFn(program, fnId(program, "ask"), [textV("q1")], { decider: recorder.request });
    expect(recorder.diagnostics).toEqual([]);
    expect(calls.length).toBe(1);

    const replay = createDecider({ mode: "replay", provider, log });
    const second = runFn(program, fnId(program, "ask"), [textV("q1")], { decider: replay.request });
    expect(replay.diagnostics).toEqual([]);
    // The provider was not consulted: the counter is still at one call.
    expect(calls.length).toBe(1);
    expect(second.value).toEqual(first.value);
    expect(second.value).toEqual({ k: "text", v: "answer-1" });
  });

  test("the same input replays the same output across separate programs", () => {
    const { provider } = countingProvider();
    const log = new DecisionLog();
    const recorder = createDecider({ mode: "record", provider, log });
    const a = runFn(decideProgram(), fnId(decideProgram(), "ask"), [textV("q")], { decider: recorder.request });
    const replay = createDecider({ mode: "replay", provider, log });
    const b = runFn(decideProgram(), fnId(decideProgram(), "ask"), [textV("q")], { decider: replay.request });
    expect(a.value).toEqual(b.value);
  });

  test("a missing entry in replay mode is a hard error, never a live fallback", () => {
    const { provider, calls } = countingProvider();
    const log = new DecisionLog();
    const recorder = createDecider({ mode: "record", provider, log });
    runFn(decideProgram(), fnId(decideProgram(), "ask"), [textV("recorded")], { decider: recorder.request });
    expect(calls.length).toBe(1);

    const replay = createDecider({ mode: "replay", provider, log });
    const program = decideProgram();
    // The decider object, not just its request fn: a replay miss that only reached the
    // decider would make this run look like it succeeded.
    const r = runFn(program, fnId(program, "ask"), [textV("never-recorded")], { decider: replay });
    expect(replay.diagnostics.map((d) => d.kind)).toContain("missing_decision_record");
    expect(r.diagnostics.map((d) => d.kind)).toContain("missing_decision_record");
    // The provider was not called: a replay miss cannot become a live call.
    expect(calls.length).toBe(1);
  });

  test("the log round-trips through a file", () => {
    const path = join(dir, "decisions.json");
    const { provider } = countingProvider();
    const recorder = createDecider({ mode: "record", provider, path });
    const program = decideProgram();
    const live = runFn(program, fnId(program, "ask"), [textV("persisted")], { decider: recorder.request });
    recorder.flush();

    const { log, diagnostics } = readDecisionLog(path);
    expect(diagnostics).toEqual([]);
    expect(log.size).toBe(1);

    const replay = createDecider({ mode: "replay", provider, log });
    const replayed = runFn(program, fnId(program, "ask"), [textV("persisted")], { decider: replay.request });
    expect(replayed.value).toEqual(live.value);
  });

  test("an unreadable log file is reported, not silently treated as empty-and-live", () => {
    const { log, diagnostics } = readDecisionLog(join(dir, "does-not-exist.json"));
    expect(log.size).toBe(0);
    expect(diagnostics.map((d) => d.kind)).toContain("missing_decision_record");
  });

  test("a log is append-only: re-recording an input is reported", () => {
    const { provider } = countingProvider();
    const log = new DecisionLog();
    const first = createDecider({ mode: "record", provider, log });
    const program = decideProgram();
    runFn(program, fnId(program, "ask"), [textV("dup")], { decider: first.request });
    const second = createDecider({ mode: "record", provider, log });
    runFn(program, fnId(program, "ask"), [textV("dup")], { decider: second.request });
    expect(second.diagnostics.map((d) => d.kind)).toContain("decision_log_conflict");
    expect(log.size).toBe(1);
  });
});

describe("interpreter wiring", () => {
  test("spawn runs synchronously and records its transfer discipline", () => {
    const program = load(`
fn worker() -> u32 {
    spawn shared {
        let a = 1
        a + 1
    }
    0
}
`);
    const interp = new Interp(program, {});
    interp.runFn(fnId(program, "worker"), []);
    expect(interp.spawnTransfers.map((t) => `${t.transfer}:${t.atomic}`)).toEqual(["shared:true"]);
    expect(interp.diagnostics).toEqual([]);
  });

  test("an unknown name is a diagnostic, not an exception", () => {
    const program = load(`
fn f() -> u32 { nope() }
`);
    const r = call(program, "f");
    expect(r.diagnostics.some((d) => d.kind === "unknown_builtin" || d.kind === "unknown_name")).toBe(true);
    expect(r.value).toEqual(UNIT);
  });
});
