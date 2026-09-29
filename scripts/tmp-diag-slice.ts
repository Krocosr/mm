import { loadPath } from "../src/cli.ts";
import { buildGraph } from "../src/graph.ts";
import { buildSlice } from "../src/slice.ts";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const corpusDir = "examples";

const index = new Map<string, string>();
const walk = (p: string): void => {
  if (statSync(p).isDirectory()) {
    for (const e of readdirSync(p).sort()) walk(join(p, e));
    return;
  }
  if (!p.endsWith(".mm")) return;
  const rel = relative(corpusDir, p).replace(/\.mm$/, "");
  index.set(rel.split(sep).join("::"), p);
};
walk(corpusDir);

const graph = buildGraph(loadPath(corpusDir));
const slice = buildSlice(graph, {
  goal: "encode a byte buffer as base64 text",
  include: ["definitions", "affected_calls"],
  budgetTokens: 1200,
});

console.log("index keys (first 5):", [...index.keys()].slice(0, 5));
console.log("index size:", index.size);
console.log("slice.files (first 5):", slice.files.slice(0, 5));
console.log("slice.files length:", slice.files.length);
const missing = slice.files.filter((m) => !index.has(m));
console.log("missing from index:", missing.length, missing.slice(0, 5));
const node = graph.byKind("fn")[0];
console.log("sample graph node module:", JSON.stringify(node?.module));
process.exit(0);
