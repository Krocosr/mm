import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadPath } from "../src/cli.ts";
import { buildGraph } from "../src/graph.ts";
import { buildSlice, renderSlice } from "../src/slice.ts";

/**
 * The projection must not be confused with a compression of the source.
 *
 * The report quotes a slice at 0.166-0.229 of the source it stands for. That ratio is
 * only a compression factor if the projection carries the source's information. It does
 * not: it renders signatures, call edges, field types, locals and test names, and no
 * statements at all. A ratio against bytes-of-code therefore measures how many functions
 * a file has, not how much of the source reaches the agent.
 *
 * Measured: padding every function body with executable code grows the source 102-176%
 * and the slice 0.0%. This asserts that, so the ratio cannot be quoted without the
 * caveat being enforced.
 *
 * The padding declares no new names, and that is load-bearing: `let padN = 1` would add a
 * *local*, and locals are in the projection, so it would grow the slice for a reason that
 * has nothing to do with statements.
 */

const ROOT = resolve(import.meta.dirname, "..");
const SEEDS = ["bitfield", "slot_pool", "tally", "checkdigit"] as const;

function inflate(src: string, n: number): string {
  const out: string[] = [];
  for (const line of src.split("\n")) {
    out.push(line);
    // The seeds put the opening brace on the `fn` line, so that is what opens a body.
    if (/^\s*fn\s+\w+\s*\(/.test(line) && line.trimEnd().endsWith("{")) {
      for (let k = 0; k < n; k++) out.push(`    if key == ${900000 + k} { key = ${900000 + k}; }`);
    }
  }
  return out.join("\n");
}

function rendered(file: string, goal: string): { text: string; nodes: number } {
  const graph = buildGraph(loadPath(file));
  const slice = buildSlice(graph, {
    goal,
    include: ["definitions", "affected_calls"],
    budgetTokens: 4000,
  });
  return { text: renderSlice(slice, graph), nodes: graph.nodes.size };
}

describe("projection is a structural index, not a compression", () => {
  for (const name of SEEDS) {
    test(`${name}: slice cost is independent of body size`, () => {
      const seed = join(ROOT, ".harness", "tasks", name, "seed", `${name}.mm`);
      const base = readFileSync(seed, "utf8");
      const padded = inflate(base, 12);

      // The padding has to actually be there, or the assertion below is vacuous.
      expect(padded.length).toBeGreaterThan(base.length * 1.4);

      const dir = mkdtempSync(join(tmpdir(), "proj-"));
      const a = join(dir, `${name}_a.mm`);
      const b = join(dir, `${name}_b.mm`);
      writeFileSync(a, base);
      writeFileSync(b, padded);

      const goal = `fix the ${name} defect`;
      const ra = rendered(a, goal);
      const rb = rendered(b, goal);

      // Identical symbol graph: the padding introduced no new names.
      expect(rb.nodes).toBe(ra.nodes);

      // The body more than doubled. The projection must not follow it.
      expect(rb.text.length).toBe(ra.text.length);
    });
  }
});
