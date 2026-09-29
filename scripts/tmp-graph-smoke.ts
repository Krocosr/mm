import { readFileSync } from "node:fs";
import { Program } from "../src/program.ts";
import { buildGraph } from "../src/graph.ts";
import type { SourceFile } from "../src/ast.ts";

function load(text: string, module = "smoke"): Program {
  const p = new Program();
  p.addFile({ module, text, bytes: new TextEncoder().encode(text) } satisfies SourceFile);
  return p;
}

const text = readFileSync(new URL("../tests/fixtures/smoke.mm", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "utf8");
const g = buildGraph(load(text));
console.log("nodes", g.nodes.size);
for (const n of [...g.nodes.values()]) {
  if (n.kind === "local") continue;
  console.log(n.kind, n.sourceId, n.hash, "|", n.typeHash, "|", JSON.stringify(n.deps), "|", n.ownership, "|", n.attributes.join("+"));
}
const dist2 = g.bySourceId("smoke::dist2");
console.log("refsTo(dist2)", g.refsTo(dist2!.hash).map((n) => n.sourceId));
const walk = g.bySourceId("smoke::walk");
console.log("refsFrom(walk)", g.refsFrom(walk!.hash).map((n) => n.sourceId));
console.log("reach(walk,3)", [...g.reach([walk!.hash], 3)].map((h) => g.byHash(h)?.sourceId));

// stability under comment/blank-line insertion
const g2 = buildGraph(load("// a leading comment\n\n\n" + text));
const h1 = new Map([...g.nodes.values()].map((n) => [n.sourceId, n.hash]));
const diffs = [...g2.nodes.values()].filter((n) => h1.get(n.sourceId) !== n.hash);
console.log("hash diffs after comment insert:", diffs.map((n) => n.sourceId));

// two identically-shaped functions with different names
const twin = `
fn alpha(a: u32) -> u32 { a + 1 }
fn beta(a: u32) -> u32 { a + 1 }
fn gamma(a: u32) -> u32 { a + 2 }
`;
const g3 = buildGraph(load(twin, "twin"));
console.log("twins", g3.bySourceId("twin::alpha")?.hash, g3.bySourceId("twin::beta")?.hash, g3.bySourceId("twin::gamma")?.hash);

// file reordering stability
const a = `type P = { x: f32 }\nfn useP(p: view P) -> f32 { p.x }\n`;
const b = `type Q = { y: u32 }\nfn useQ(q: view Q) -> u32 { q.y }\n`;
const one = new Program();
one.addFile({ module: "a", text: a, bytes: new TextEncoder().encode(a) } satisfies SourceFile);
one.addFile({ module: "b", text: b, bytes: new TextEncoder().encode(b) } satisfies SourceFile);
const two = new Program();
two.addFile({ module: "b", text: b, bytes: new TextEncoder().encode(b) } satisfies SourceFile);
two.addFile({ module: "a", text: a, bytes: new TextEncoder().encode(a) } satisfies SourceFile);
const ga = buildGraph(one);
const gb = buildGraph(two);
for (const id of ["a::P", "a::useP", "b::Q", "b::useQ"]) {
  console.log("reorder", id, ga.bySourceId(id)?.hash, gb.bySourceId(id)?.hash);
}
