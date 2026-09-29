#!/usr/bin/env bun
/**
 * How much of an agent run is the model, and how much is everything else?
 *
 * The token experiment assumes the semantic tools are *usable*. That assumption deserves
 * a number, because `mm_slice` was observed taking ~15 s against a grep measured in
 * milliseconds — long enough that an agent routes around it, at which point both
 * conditions are really the same condition and the token comparison means nothing.
 *
 * `omp`'s event stream carries `duration` on every `message_end`, which is the model's
 * own inference time for that turn. Subtracting the sum of those from the run's wall
 * clock leaves everything that was not the model thinking: tool execution, daemon
 * round-trips, event streaming, and process overhead.
 *
 * This is not a pure tool-time measurement — the residue is an upper bound on it, and it
 * includes fixed overhead the conditions share. It is the right first decomposition
 * because it needs no new instrumentation and can be run over runs already taken.
 *
 * See docs/harness.md.
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const RUNS = join(import.meta.dir, "..", ".harness", "runs");

interface Row {
  run: string;
  condition: string;
  wall_s: number;
  model_s: number;
  other_s: number;
  other_pct: number;
  turns: number;
  mean_model_ms: number;
}

/** Sum `message_end.duration` (ms) over a run's event log. Returns null if unreadable. */
function modelMillis(eventsPath: string): { total: number; count: number } | null {
  let raw: string;
  try {
    raw = readFileSync(eventsPath, "utf8");
  } catch {
    return null;
  }
  let total = 0;
  let count = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t.length === 0 || !t.includes('"message_end"')) continue;
    let e: { message?: { usage?: unknown; duration?: unknown } };
    try {
      e = JSON.parse(t) as typeof e;
    } catch {
      continue;
    }
    const d = e.message?.duration;
    if (typeof d === "number" && Number.isFinite(d)) {
      total += d;
      count++;
    }
  }
  return { total, count };
}

const rows: Row[] = [];
for (const task of readdirSync(RUNS).sort()) {
  const taskDir = join(RUNS, task);
  if (!statSync(taskDir).isDirectory()) continue;
  for (const cond of readdirSync(taskDir).sort()) {
    const condDir = join(taskDir, cond);
    if (!statSync(condDir).isDirectory()) continue;
    for (const rep of readdirSync(condDir).sort()) {
      const runPath = join(condDir, rep, "run.json");
      let run: { status?: string; seconds?: number; turns?: number };
      try {
        run = JSON.parse(readFileSync(runPath, "utf8")) as typeof run;
      } catch {
        continue;
      }
      if (run.status !== "ok" || typeof run.seconds !== "number") continue;
      const m = modelMillis(join(condDir, rep, "events.ndjson"));
      if (!m || m.count === 0) continue;
      const modelS = m.total / 1000;
      const otherS = Math.max(0, run.seconds - modelS);
      rows.push({
        run: `${task}/${cond}/${rep}`,
        condition: cond,
        wall_s: run.seconds,
        model_s: Math.round(modelS * 10) / 10,
        other_s: Math.round(otherS * 10) / 10,
        other_pct: Math.round((otherS / run.seconds) * 100),
        turns: run.turns ?? m.count,
        mean_model_ms: Math.round(m.total / m.count),
      });
    }
  }
}

const pad = (s: string, n: number): string => s.padEnd(n);
console.log(`${pad("run", 26)}${pad("cond", 11)}${pad("wall s", 9)}${pad("model s", 10)}${pad("other s", 10)}${pad("other %", 9)}mean model ms`);
for (const r of rows.sort((a, b) => a.run.localeCompare(b.run))) {
  console.log(
    pad(r.run, 26) + pad(r.condition, 11) + pad(r.wall_s.toFixed(1), 9) +
    pad(r.model_s.toFixed(1), 10) + pad(r.other_s.toFixed(1), 10) +
    pad(`${r.other_pct}%`, 9) + r.mean_model_ms,
  );
}

const byCond = new Map<string, Row[]>();
for (const r of rows) {
  const l = byCond.get(r.condition);
  if (l) l.push(r);
  else byCond.set(r.condition, [r]);
}
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log("\nby condition:");
for (const [c, list] of [...byCond.entries()].sort()) {
  console.log(
    `  ${pad(c, 11)}runs=${String(list.length).padStart(2)}  ` +
    `mean wall ${mean(list.map((r) => r.wall_s)).toFixed(1)}s  ` +
    `mean model ${mean(list.map((r) => r.model_s)).toFixed(1)}s  ` +
    `mean other ${mean(list.map((r) => r.other_s)).toFixed(1)}s  ` +
    `mean other-share ${mean(list.map((r) => r.other_pct)).toFixed(0)}%`,
  );
}
console.log("\n'other' is an upper bound on tool time: it also carries daemon round-trips,");
console.log("event streaming and process overhead, all of which the conditions share.");

mkdirSync("bench", { recursive: true });
writeFileSync("bench/run-time.json", `${JSON.stringify({ rows }, null, 2)}\n`);
console.log("wrote bench/run-time.json");
