import { describe, expect, test } from "bun:test";
import { Program } from "../src/program.ts";
import { analyzePasses } from "../src/check.ts";
import { type SemanticGraph, buildGraph } from "../src/graph.ts";
import { renderPacket, renderSymbolPacket } from "../src/packet.ts";
import { buildSlice, isClosed } from "../src/slice.ts";
import { makeSession, querySymbol, queryRefs, querySlice, queryType, queryVerify, dispatch } from "../src/query.ts";
import type { SourceFile } from "../src/ast.ts";

function load(sources: ReadonlyArray<{ module: string; text: string }>): { program: Program; graph: SemanticGraph } {
  const program = analyzePasses(sources).program;
  return { program, graph: buildGraph(program) };
}

const one = (text: string) => load([{ module: "t", text }]);

describe("semantic graph identity", () => {
  test("hashes are stable across comments and blank lines", () => {
    const a = one(`
fn add(x: i64, y: i64) -> i64 { x + y }
`);
    const b = one(`
// a leading comment
fn add(x: i64, y: i64) -> i64 { x + y }
`);
    const ha = a.graph.bySourceId("t::add")?.hash;
    const hb = b.graph.bySourceId("t::add")?.hash;
    expect(ha).toBeDefined();
    expect(hb).toBe(ha);
  });

  test("a line number is never the identity", () => {
    // Same function, pushed down by unrelated leading lines. The hash must not move and
    // the span must: that is exactly the "semantic IDs become unstable under refactoring"
    // failure the spec warns about.
    const a = one(`fn f(x: i64) -> i64 { x }`);
    const b = one(`
// 1
// 2
// 3
fn f(x: i64) -> i64 { x }
`);
    const na = a.graph.bySourceId("t::f");
    const nb = b.graph.bySourceId("t::f");
    expect(nb?.hash).toBe(na?.hash);
    expect(nb?.span.start).not.toBe(na?.span.start);
  });

  test("two structurally identical functions hash identically", () => {
    const { graph } = one(`
fn alpha(x: i64) -> i64 { x + 1 }
fn beta(x: i64) -> i64 { x + 1 }
`);
    expect(graph.bySourceId("t::alpha")?.hash).toBe(graph.bySourceId("t::beta")?.hash);
  });

  test("a change in meaning changes the hash", () => {
    const a = one(`fn f(x: i64) -> i64 { x + 1 }`);
    const b = one(`fn f(x: i64) -> i64 { x + 2 }`);
    expect(b.graph.bySourceId("t::f")?.hash).not.toBe(a.graph.bySourceId("t::f")?.hash);
  });

  test("a change in a dependency changes the dependent's hash", () => {
    const a = load([{ module: "a", text: `fn base() -> i64 { 1 }` }, { module: "b", text: `fn caller() -> i64 { base() }` }]);
    const b = load([{ module: "a", text: `fn base() -> i64 { 2 }` }, { module: "b", text: `fn caller() -> i64 { base() }` }]);
    // The caller has not changed textually, but what it means has.
    expect(b.graph.bySourceId("b::caller")?.hash).not.toBe(a.graph.bySourceId("b::caller")?.hash);
  });

  test("deps are content hashes, not names", () => {
    const { graph } = one(`
fn helper() -> i64 { 7 }
fn caller() -> i64 { helper() }
`);
    const caller = graph.bySourceId("t::caller");
    expect(caller).toBeDefined();
    const deps = caller!.deps;
    expect(deps.length).toBeGreaterThan(0);
    for (const d of deps) {
      expect(graph.byHash(d)).toBeDefined();
    }
  });

  test("aliases are session-local and not part of the identity", () => {
    const { graph } = one(`fn f() -> i64 { 1 }`);
    const node = graph.bySourceId("t::f")!;
    const a1 = graph.alias(node.hash);
    expect(a1).toMatch(/^F\d+$/);
    // A fresh graph renumbers from scratch; the hash is what survives.
    const again = buildGraph(load([{ module: "t", text: `fn f() -> i64 { 1 }` }]).program);
    expect(again.bySourceId("t::f")?.hash).toBe(node.hash);
  });
});

describe("graph navigation", () => {
  const { graph } = one(`
fn helper() -> i64 { 7 }
fn caller() -> i64 { helper() }
type Point = { x: i64, y: i64 }
`);

  test("refsTo finds the dependents", () => {
    const helper = graph.bySourceId("t::helper")!;
    const dependents = graph.refsTo(helper.hash).map((n) => n.sourceId);
    expect(dependents).toContain("t::caller");
  });

  test("reach walks dependencies outward, which is what closure needs", () => {
    const helper = graph.bySourceId("t::helper")!;
    const caller = graph.bySourceId("t::caller")!;
    // Outgoing: what `caller` needs. This is the direction slice closure is built on.
    expect(graph.reach([caller.hash], 1).has(helper.hash)).toBe(true);
    // Incoming: what depends on `helper` — impact analysis, the other direction.
    expect(graph.refsTo(helper.hash).map((n) => n.sourceId)).toContain("t::caller");
    expect(graph.reach([helper.hash], 1).has(caller.hash)).toBe(false);
  });

  test("byKind finds every definition of that kind", () => {
    const types = graph.byKind("type").map((n) => n.sourceId);
    expect(types).toContain("t::Point");
  });
});

describe("LLM projection", () => {
  const { graph, program } = one(`
use std.fs

@wire
type Job = { id: u64 }

fn load(path: Path) -> Result<Bytes, IoErr> !{fs.read} { fs.read(path) }

fn run(p: Path) -> Result<u64, IoErr> !{fs.read} { Ok(load(p)?.len() as u64) }
`);

  test("a symbol packet carries the effect row and the call edge", () => {
    const packet = renderSymbolPacket(graph, "t::load");
    expect(packet).toContain("fs.read");
    expect(packet).toContain("load");
  });

  test("a packet never contains imports or comments", () => {
    const nodes = graph.byKind("fn").map((n) => n.hash);
    const text = renderPacket(graph, { nodes });
    expect(text).not.toContain("use std.fs");
    expect(text).not.toContain("//");
  });

  test("a module packet renders its definitions", () => {
    const nodes = graph.byKind("fn").map((n) => n.hash);
    const text = renderPacket(graph, { module: "t", nodes });
    expect(text.length).toBeGreaterThan(0);
    // The packet is a projection: it carries the effect row, not the source text.
    expect(text).toContain("fs.read");
    expect(typeof program.errors()).toBe("object");
  });
});

describe("dependency-directed slices", () => {
  const { graph } = load([
    { module: "a", text: `@wire type User = { id: u64, name: Text }` },
    { module: "b", text: `fn decode_user(b: Bytes) -> User { User { id: 0, name: "x" } }` },
    { module: "c", text: `fn test_user_roundtrip() -> u64 { 1 }` },
  ]);

  test("a slice is dependency closed", () => {
    const slice = buildSlice(graph, {
      goal: "change User.id from u32 to u64",
      include: ["definitions", "affected_calls"],
      budgetTokens: 4000,
    });
    expect(slice.dependencyClosed).toBe(true);
    expect(isClosed(graph, new Set(slice.entries.map((e) => e.hash)))).toBe(true);
  });

  test("a wire type is reported as system risk", () => {
    const slice = buildSlice(graph, {
      goal: "change User.id from u32 to u64",
      include: ["definitions", "wire_abi"],
      budgetTokens: 4000,
    });
    expect(slice.systemRisk.some((r) => r.kind === "wire")).toBe(true);
  });
});

describe("query dispatch", () => {
  const program = analyzePasses([{
    module: "t",
    text: `fn helper() -> i64 { 1 }\nfn caller() -> i64 { helper() }`,
  }]).program;
  const s = makeSession(program);

  test("mm.symbol returns identity and a packet", () => {
    const r = querySymbol(s, "t::helper");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { node: { sourceId: string }; packet: string };
    expect(data.node.sourceId).toBe("t::helper");
    expect(data.packet).toContain("helper");
  });

  test("mm.type returns the resolved type and effects", () => {
    const r = queryType(s, "t::caller");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { type: string; dependencies: string[] };
    expect(data.type).toContain("i64");
    expect(data.dependencies).toContain("t::helper");
  });

  test("mm.refs finds the caller", () => {
    const r = queryRefs(s, "t::helper");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { direct: Array<{ sourceId: string }> };
    expect(data.direct.map((n) => n.sourceId)).toContain("t::caller");
  });

  test("an unknown symbol is an error, not a throw", () => {
    const r = querySymbol(s, "t::nope");
    expect(r.ok).toBe(false);
  });

  test("mm.verify reports an unclosed selection", () => {
    const caller = s.graph.bySourceId("t::caller")!;
    const r = queryVerify(s, [caller.hash]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { closed: boolean; missing: unknown[] };
    expect(data.closed).toBe(false);
    expect(data.missing.length).toBeGreaterThan(0);
  });

  test("dispatch routes every tool name consistently", () => {
    expect(dispatch(s, "mm.symbol", { ref: "t::helper" }).ok).toBe(true);
    expect(dispatch(s, "mm.type", { ref: "t::helper" }).ok).toBe(true);
    expect(dispatch(s, "mm.system", {}).ok).toBe(true);
    expect(dispatch(s, "mm.diagnostics", {}).ok).toBe(true);
    expect(dispatch(s, "mm.nonsense", {}).ok).toBe(false);
  });

  test("mm.slice returns a closed, renderable slice", () => {
    const r = querySlice(s, { goal: "read helper", include: ["definitions"], budgetTokens: 2000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { closed: boolean; text: string };
    expect(data.closed).toBe(true);
    expect(data.text.length).toBeGreaterThan(0);
  });
});
