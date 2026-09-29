#!/usr/bin/env bun
/**
 * MM — condition 4 of the report's agent experiment: the cost of a goal-directed slice.
 *
 * `measure-tokens.ts` scores the two conditions that need no agent: the source an agent
 * would read, and a whole-module semantic packet. The report's fourth condition — an
 * agent querying the graph live rather than receiving a batched packet — had no measured
 * context cost at all, and was recorded as NOT MEASURED.
 *
 * This fills that cell for the static half. For a set of goals it builds a real slice
 * through the same `buildSlice` the daemon serves, then measures:
 *
 *   source-touched   exact tokens of the source of the files the slice actually covers
 *   semantic-slice   exact tokens of the rendered slice the agent would receive
 *
 * The ratio is the honest form of the claim: a slice is only cheaper if it carries less
 * text than the source it stands for. A slice broad enough to cover most of the corpus
 * will land near 1.0, and reporting that as a saving would be false — so the broad goal
 * is measured deliberately, not omitted.
 *
 * The other half of condition 4 — whether the agent still succeeds — needs the agent-run
 * harness and is NOT measured here. This ratio is worth nothing on its own.
 *
 * See docs/checkpoint-1.md §3.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { loadPath } from "../src/cli.ts";
import { buildGraph } from "../src/graph.ts";
import { buildSlice, renderSlice, type SliceRequest } from "../src/slice.ts";
import { compare, measure, resolveTokenizer, type Measurement } from "../src/tokens.ts";

/**
 * Goals spanning the corpus rather than flattering it: one narrow, one mid-sized, and one
 * so broad it necessarily covers most of the program.
 */
const GOALS: { label: string; goal: string; budgetTokens: number }[] = [
  { label: "narrow", goal: "encode a byte buffer as base64 text", budgetTokens: 1200 },
  { label: "medium", goal: "insert into a binary search tree and report depth", budgetTokens: 2400 },
  { label: "broad", goal: "inspect the package", budgetTokens: 4000 },
];

const INCLUDE = ["definitions", "affected_calls"] as const;

interface Row {
  label: string;
  goal: string;
  files: number;
  symbols: number;
  sourceTokens: number;
  sliceTokens: number;
  sourceChars: number;
  sliceChars: number;
  tokenizerId: string;
  approximate: boolean;
  closed: boolean;
  overBudget: boolean;
}

/**
 * Map a module name to the file it came from.
 *
 * `slice.files` holds module names, not paths — `Slice.files` is built from
 * `node.module` (slice.ts:173), which is the corpus-relative path with separators
 * rewritten to `::` and the extension dropped. The corpus is walked the same way the
 * CLI's `collectSources` does so the two agree exactly.
 */
function indexCorpus(corpusDir: string): Map<string, string> {
  const index = new Map<string, string>();
  const walk = (p: string): void => {
    if (statSync(p).isDirectory()) {
      for (const entry of readdirSync(p).sort()) walk(join(p, entry));
      return;
    }
    if (!p.endsWith(".mm")) return;
    const rel = relative(corpusDir, p).replace(/\.mm$/, "");
    index.set(rel.split(sep).join("::"), p);
  };
  walk(corpusDir);
  return index;
}

/** The source of the files a slice covers, in slice order. */
function sourceOf(modules: readonly string[], index: Map<string, string>): string {
  const parts: string[] = [];
  const missing: string[] = [];
  for (const m of modules) {
    const p = index.get(m);
    if (p === undefined) {
      missing.push(m);
      continue;
    }
    parts.push(readFileSync(p, "utf8"));
  }
  if (missing.length > 0) {
    // Silently measuring fewer files than the slice covers would understate the
    // baseline and flatter the ratio. Say so instead.
    console.error(`WARNING: ${missing.length} slice module(s) not found in the corpus index: ${missing.slice(0, 5).join(", ")}`);
  }
  return parts.join("\n");
}

async function main(): Promise<number> {
  const corpusDir = process.argv[2] ?? "examples";
  const tokenizerId = process.argv[3] ?? "tiktoken/cl100k_base";
  if (!existsSync(corpusDir)) {
    console.error(`no such corpus: ${corpusDir}`);
    return 2;
  }

  const program = loadPath(corpusDir);
  const graph = buildGraph(program);
  const corpusIndex = indexCorpus(corpusDir);
  const rows: Row[] = [];

  const resolved = await resolveTokenizer(tokenizerId);
  if (resolved.status === "unavailable") {
    // A character proxy would misstate the saving by a wide margin, and the margin is
    // the claim. Refuse rather than report a number that looks like a result.
    console.error(`tokenizer unavailable: ${resolved.reason}`);
    console.error("refusing to report a ratio from an approximation");
    return 2;
  }
  const tk = resolved.tokenizer;


  for (const g of GOALS) {
    const request: SliceRequest = {
      goal: g.goal,
      include: [...INCLUDE],
      budgetTokens: g.budgetTokens,
    };
    const slice = buildSlice(graph, request);
    const text = renderSlice(slice, graph);
    const source = sourceOf(slice.files, corpusIndex);

    const base: Measurement = measure(source, tk);
    const cand: Measurement = measure(text, tk);

    rows.push({
      label: g.label,
      goal: g.goal,
      files: slice.files.length,
      symbols: slice.entries.length,
      sourceTokens: base.tokens,
      sliceTokens: cand.tokens,
      sourceChars: source.length,
      sliceChars: text.length,
      tokenizerId: tk.id,
      approximate: tk.approximate,
      closed: slice.dependencyClosed,
      overBudget: slice.overBudget,
    });
  }

  const pad = (s: string, n: number): string => s.padEnd(n);
  const num = (n: number): string => n.toLocaleString("en-US");

  console.log(`corpus: ${corpusDir}`);
  console.log(`tokenizer: ${tk.id}\n`);
  console.log(
    `${pad("goal", 9)}${pad("files", 7)}${pad("symbols", 9)}` +
    `${pad("src tok", 10)}${pad("slice tok", 11)}ratio`,
  );
  for (const r of rows) {
    const cmp = compare(measure("", tk), measure("x".repeat(r.sourceChars), tk));
    void cmp;
    const ratio = r.sourceTokens === 0 ? NaN : r.sliceTokens / r.sourceTokens;
    console.log(
      `${pad(r.label, 9)}${pad(String(r.files), 7)}${pad(String(r.symbols), 9)}` +
      `${pad(num(r.sourceTokens), 10)}${pad(num(r.sliceTokens), 11)}${ratio.toFixed(3)}`,
    );
  }

  console.log(`\nA ratio near 1.000 means the slice carries about as much text as the source`);
  console.log(`it replaces. That is a real result and is reported as such: the saving`);
  console.log(`measured for whole-module packets does not automatically carry over to`);
  console.log(`slices, and a slice that has to cover the whole program cannot save anything.`);
  console.log(`\nNOT MEASURED here: whether an agent working from slices still completes the`);
  console.log(`task. That is the agent-run harness. A cheaper context that loses tasks is`);
  console.log(`not a win, so this ratio is not a result on its own.`);

  writeFileSync(
    "bench/slice-tokens.json",
    `${JSON.stringify({ corpus: corpusDir, tokenizerId: tk.id, approximate: tk.approximate, rows }, null, 2)}\n`,
  );
  console.log("wrote bench/slice-tokens.json");
  return 0;
}

process.exit(await main());
