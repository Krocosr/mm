#!/usr/bin/env bun
/**
 * Compare the sweep taken before the compiler stopped refusing correct code with the one
 * taken after.
 *
 * The first sweep ran against a compiler that rejected 198 call sites the interpreter
 * accepts, and never type-checked a `test` body — which is where every assertion in the
 * fixtures lives. So the semantic arm had a working `mm_check` that lied to it. This
 * prints both sweeps side by side so the difference is visible rather than asserted.
 *
 * Read the per-run lists before the means. The within-cell spread has been ~2.4x in every
 * condition, which is wider than any difference between conditions, so a mean on its own
 * is not a measurement.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const AFTER = join(ROOT, ".harness", "runs", "results.json");
const BEFORE = join(ROOT, ".harness-runs-precompilerfix", "results.json");

interface Cond {
  condition: string;
  runs: number;
  pass_rate: number;
  mean_input_tokens: number;
  median_input_tokens: number;
  finished_runs?: number;
  median_input_tokens_finished?: number;
  min_input_tokens?: number;
  max_input_tokens?: number;
  input_tokens_each?: number[];
}
interface Results {
  by_condition: Cond[];
  runs: { task: string; condition: string; repeat: number; input_tokens: number }[];
}

function load(p: string): Results | null {
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Results;
}

const before = load(BEFORE);
const after = load(AFTER);
if (!after) {
  console.error("no current results.json — run the scorer first");
  process.exit(1);
}

const pad = (s: string, n: number): string => s.padEnd(n);
const num = (n: number): string => n.toLocaleString("en-US");

console.log("input tokens per condition, before and after the compiler fix\n");
console.log(
  `${pad("condition", 15)}${pad("runs", 6)}${pad("pass", 7)}${pad("med(all)", 10)}` +
  `${pad("med(fin)", 10)}${pad("range", 18)}`,
);
for (const a of after.by_condition) {
  const b = before?.by_condition.find((x) => x.condition === a.condition);
  const range = a.min_input_tokens !== undefined
    ? `${a.min_input_tokens}-${a.max_input_tokens}`
    : "-";
  console.log(
    pad(`${a.condition} now`, 15) + pad(String(a.runs), 6) +
    pad(`${(a.pass_rate * 100).toFixed(0)}%`, 7) +
    pad(num(a.median_input_tokens), 10) +
    pad(num(a.median_input_tokens_finished ?? 0), 10) + pad(range, 18),
  );
  if (b) {
    console.log(
      pad(`${a.condition} before`, 15) + pad(String(b.runs), 6) +
      pad(`${(b.pass_rate * 100).toFixed(0)}%`, 7) +
      pad(num(b.median_input_tokens), 10) +
      pad(num(b.median_input_tokens_finished ?? 0), 10) +
      pad(`${b.min_input_tokens}-${b.max_input_tokens}`, 18),
    );
  }
}

console.log("\nper-run input tokens:");
for (const a of after.by_condition) {
  const b = before?.by_condition.find((x) => x.condition === a.condition);
  console.log(`  ${pad(a.condition, 15)} now    ${(a.input_tokens_each ?? []).join(", ")}`);
  if (b) console.log(`  ${pad("", 15)} before ${(b.input_tokens_each ?? []).join(", ")}`);
}

// The spread is the number that decides whether any of the above means anything.
const spread = (rs: Results): number[] => {
  const out: number[] = [];
  for (const c of rs.by_condition) {
    const v = c.input_tokens_each ?? [];
    if (v.length >= 2) out.push(Math.max(...v) / Math.min(...v));
  }
  return out.sort((x, y) => x - y);
};
const m = (xs: number[]): number => (xs.length ? xs[Math.floor(xs.length / 2)]! : 0);
console.log(`\nmedian within-cell spread: before ${m(spread(before ?? { by_condition: [], runs: [] })).toFixed(1)}x, after ${m(spread(after)).toFixed(1)}x`);
console.log("A difference smaller than this is not distinguishable from run-to-run noise.");
