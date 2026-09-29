#!/usr/bin/env bun
/**
 * MM — tool latency: is the semantic interface fast enough to be worth using?
 *
 * The token experiment asks whether semantic context is cheaper. It quietly assumes the
 * semantic tools are *usable*: an agent that waits 15 seconds for `mm_slice` will route
 * around it, and then the token comparison is measuring two agents that both used text
 * tools. Observed cost of `mm slice examples` during development was ~15 s, against a
 * `grep` measured in milliseconds, so this is not a hypothetical concern.
 *
 * This measures the two sides on the same corpus, through the same code paths the daemon
 * serves. It is a pure in-process comparison — no model, no network — so the numbers are
 * the tool's own cost, not end-to-end agent latency (which is dominated by inference and
 * measured separately as `seconds` per run in the harness).
 *
 * Every figure is median and p95 over repeated samples after a warmup, because a single
 * timing on a JIT is a measurement of the warmup. The full sample set is printed, since a
 * median over a bimodal distribution hides the mode that matters.
 *
 * See docs/harness.md.
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { loadPath } from "../src/cli.ts";
import { buildGraph } from "../src/graph.ts";
import { buildSlice, renderSlice, type SliceRequest } from "../src/slice.ts";
import { querySymbol, queryRefs, queryType, type Session } from "../src/query.ts";

const WARMUP = 2;
const SAMPLES = 9;

interface Stat {
  name: string;
  median: number;
  p95: number;
  min: number;
  max: number;
  samples: number[];
}

function summarise(name: string, times: number[]): Stat {
  const s = times.slice().sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return {
    name,
    median: round(at(0.5)),
    p95: round(at(0.95)),
    min: round(s[0]!),
    max: round(s[s.length - 1]!),
    samples: s.map(round),
  };
}
const round = (n: number): number => Math.round(n * 100) / 100;

/** Time `fn` after warming it, so the figure is steady-state rather than first-call. */
function measure(name: string, fn: () => unknown): Stat {
  for (let i = 0; i < WARMUP; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return summarise(name, times);
}

/** Every `.mm` under a directory, in stable order. */
function mmFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    if (statSync(p).isDirectory()) {
      for (const e of readdirSync(p).sort()) walk(join(p, e));
      return;
    }
    if (p.endsWith(".mm")) out.push(p);
  };
  walk(dir);
  return out;
}

function main(): number {
  const corpusDir = process.argv[2] ?? "examples";
  const files = mmFiles(corpusDir);
  if (files.length === 0) {
    console.error(`no .mm files under ${corpusDir}`);
    return 2;
  }

  // Built once: an agent's daemon is long-lived, so charging it a fresh parse on every
  // tool call would measure startup cost, not tool cost. Reload cost is reported
  // separately below, because an agent that edits a file does pay it.
  const program = loadPath(corpusDir);
  const graph = buildGraph(program);
  const session: Session = { program, graph, system: null, diagnostics: program.diagnostics };

  const stats: Stat[] = [];

  // ---- semantic side -----------------------------------------------------
  const sliceReq: SliceRequest = {
    goal: "encode a byte buffer as base64 text",
    include: ["definitions", "affected_calls"],
    budgetTokens: 2400,
  };
  stats.push(measure("mm_slice (build + render)", () => {
    const s = buildSlice(graph, sliceReq);
    return renderSlice(s, graph);
  }));

  const fnRefs = graph.byKind("fn").slice(0, 40);
  stats.push(measure("mm_symbol (x40, batched)", () => {
    for (const n of fnRefs) querySymbol(session, n.name);
  }));
  stats.push(measure("mm_refs (x40, batched)", () => {
    for (const n of fnRefs) queryRefs(session, n.name);
  }));
  stats.push(measure("mm_type (x40, batched)", () => {
    for (const n of fnRefs) queryType(session, n.name);
  }));

  // ---- text side ---------------------------------------------------------
  // The fair counterpart to a slice is reading the source it covers.
  const broadSlice = buildSlice(graph, {
    goal: "inspect the package",
    include: ["definitions", "affected_calls"],
    budgetTokens: 4000,
  });
  const covered = broadSlice.files
    .map((m) => files.find((f) => relative(corpusDir, f).replace(/\.mm$/, "").split(/[\\/]/).join("::") === m))
    .filter((f): f is string => f !== undefined);

  stats.push(measure(`read ${covered.length} source files (slice's own coverage)`, () => {
    let n = 0;
    for (const f of covered) n += readFileSync(f, "utf8").length;
    return n;
  }));

  const needle = "fn ";
  stats.push(measure(`grep '${needle}' across ${files.length} files`, () => {
    let hits = 0;
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      let i = text.indexOf(needle);
      while (i >= 0) {
        hits++;
        i = text.indexOf(needle, i + needle.length);
      }
    }
    return hits;
  }));

  // ---- what an edit costs the semantic side ------------------------------
  stats.push(measure(`reload: parse + check + graph over ${files.length} files`, () => {
    const p = loadPath(corpusDir);
    return buildGraph(p).byKind("fn").length;
  }));

  const pad = (s: string, n: number): string => s.padEnd(n);
  console.log(`corpus: ${corpusDir} (${files.length} .mm files)`);
  console.log(`warmup ${WARMUP}, samples ${SAMPLES}\n`);
  console.log(`${pad("operation", 52)}${pad("median ms", 11)}${pad("p95 ms", 10)}min      max`);
  for (const s of stats) {
    console.log(
      pad(s.name, 52) + pad(s.median.toFixed(1), 11) + pad(s.p95.toFixed(1), 10) +
      pad(s.min.toFixed(1), 9) + s.max.toFixed(1),
    );
  }

  const sliceMs = stats.find((s) => s.name.startsWith("mm_slice"))!.median;
  const readMs = stats.find((s) => s.name.startsWith("read "))!.median;
  const grepMs = stats.find((s) => s.name.startsWith("grep"))!.median;
  console.log(`\nmm_slice is ${(sliceMs / Math.max(grepMs, 0.01)).toFixed(0)}x a corpus grep, ` +
    `${(sliceMs / Math.max(readMs, 0.01)).toFixed(0)}x reading the files it replaces.`);
  console.log(`At ~${sliceMs} ms a slice, an agent that would rather grep will. A token`);
  console.log(`saving the agent cannot afford to collect is not a saving.`);

  mkdirSync("bench", { recursive: true });
  writeFileSync(
    "bench/tool-latency.json",
    `${JSON.stringify({ corpus: corpusDir, files: files.length, warmup: WARMUP, samples: SAMPLES, stats }, null, 2)}\n`,
  );
  console.log("wrote bench/tool-latency.json");
  return 0;
}

process.exit(main());
