import { describe, expect, test } from "bun:test";
import { performance } from "node:perf_hooks";
import { loadPath } from "../src/cli.ts";
import { buildGraph } from "../src/graph.ts";
import { buildSlice, renderSlice } from "../src/slice.ts";

/**
 * `buildSlice` ran in about eleven seconds on the 30-file example corpus while every
 * other semantic query stayed sub-millisecond. The cause was algorithmic, not constant
 * factor: the budget-trimming loop was cubic in the size of the selection.
 *
 * The existing slice tests in `graph.test.ts` do not catch this, and cannot. They build
 * slices over a handful of inline nodes, where the cubic term is invisible. A correctness
 * test on a five-node graph and a performance property on a three-thousand-node graph are
 * different claims, and only one of them was being made.
 *
 * So this is a scale test. The bound is deliberately loose — seconds, not milliseconds —
 * because the property worth protecting is "not cubic", not "fast". A bound tight enough
 * to catch a constant-factor regression would be a flaky test on shared CI hardware.
 */

const CORPUS = "examples";

/** Build the real corpus graph once: a 30-file program, not a fixture. */
function corpus() {
  const program = loadPath(CORPUS);
  return { program, graph: buildGraph(program) };
}

describe("buildSlice at scale", () => {
  test("a budget-constrained slice over a real corpus is not cubic", () => {
    const { graph } = corpus();
    expect(graph.nodes.size).toBeGreaterThan(500);

    // A budget far below what the graph would select, so the trimming loop has real
    // work to do. This is the path that was slow.
    const budget = 400;
    const t0 = performance.now();
    const slice = buildSlice(graph, {
      goal: "encode a byte buffer as base64 text",
      include: ["definitions", "affected_calls"],
      budgetTokens: budget,
    });
    const renderStart = performance.now();
    const text = renderSlice(slice, graph);
    const elapsed = performance.now() - renderStart + (renderStart - t0);

    expect(text.length).toBeGreaterThan(0);
    // Loose on purpose: 11 000 ms before the fix, well under 1 000 ms after.
    expect(elapsed).toBeLessThan(2000);
  }, 30_000);

  test("trimming to a budget still respects it and still closes the slice", () => {
    // The performance fix must not change what the trim loop decides. If it does, the
    // fast version is answering a different question and the speedup is worthless.
    const { graph } = corpus();
    const slice = buildSlice(graph, {
      goal: "insert into a binary search tree and report depth",
      include: ["definitions", "affected_calls"],
      budgetTokens: 800,
    });
    expect(slice.estimatedTokens).toBeLessThanOrEqual(800);
    expect(slice.overBudget).toBe(false);
    // Every selected node's outgoing edges land inside the selection.
    for (const e of slice.entries) {
      for (const h of graph.byHash(e.hash)?.deps ?? []) {
        expect(slice.entries.some((x) => x.hash === h)).toBe(true);
      }
    }
  }, 30_000);

  test("a larger budget selects more than a smaller one", () => {
    // Guards the obvious way a "fix" could silently become a no-op: returning early, or
    // dropping candidates, would make slice size flat in the budget.
    const { graph } = corpus();
    const small = buildSlice(graph, { goal: "inspect the package", include: ["definitions"], budgetTokens: 200 });
    const large = buildSlice(graph, { goal: "inspect the package", include: ["definitions"], budgetTokens: 8000 });
    expect(large.entries.length).toBeGreaterThan(small.entries.length);
  }, 30_000);
});
