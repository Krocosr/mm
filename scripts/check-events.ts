#!/usr/bin/env bun
/**
 * Which events does the runner lose to omp's unescaped-newline bug?
 *
 * `omp --mode=json` writes a raw newline inside a JSON string when a tool argument
 * carries a multi-line command. One logical event then arrives as several physical
 * lines, none of which parse. The runner parses line-by-line, warns, and continues.
 *
 * That is harmless for a notification and harmful for an event carrying usage or tool
 * counts, so the question is not "are there bad lines" but "which event types are the
 * bad lines". This prints the opening of every unparseable physical line, so the answer
 * is read rather than inferred.
 *
 * Expectation: only `tool_execution_update`, which carries no usage. If a
 * `message_end` or `turn_end` ever appears here, that run's token or tool-call number
 * is understated and the run should be re-taken.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const RUNS = join(import.meta.dir, "..", ".harness", "runs");

/** Best-effort event type from a line that may be a fragment. */
function opening(line: string): string {
  const m = /"type"\s*:\s*"([^"]+)"/.exec(line);
  return m?.[1] ?? "<no type field>";
}

const lostTypes = new Map<string, number>();
const byRun: string[] = [];

for (const task of readdirSync(RUNS).sort()) {
  const taskDir = join(RUNS, task);
  if (!statSync(taskDir).isDirectory()) continue;
  for (const cond of readdirSync(taskDir).sort()) {
    const condDir = join(taskDir, cond);
    if (!statSync(condDir).isDirectory()) continue;
    for (const rep of readdirSync(condDir).sort()) {
      let raw: string;
      try {
        raw = readFileSync(join(condDir, rep, "events.ndjson"), "utf8");
      } catch {
        continue;
      }
      const bad: string[] = [];
      let ok = 0;
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (t.length === 0) continue;
        try {
          JSON.parse(t);
          ok++;
        } catch {
          bad.push(t);
        }
      }
      if (bad.length === 0) continue;
      const types = new Set(bad.map(opening));
      for (const t of types) lostTypes.set(t, (lostTypes.get(t) ?? 0) + bad.length);
      byRun.push(`${task}/${cond}/${rep}`.padEnd(26) + `ok=${ok} bad=${bad.length} types=${[...types].join(",")}`);
    }
  }
}

console.log("runs with unparseable event lines:");
console.log(byRun.join("\n") || "  (none)");
console.log("\nunparseable physical lines, by the event type they open with:");
for (const [t, n] of [...lostTypes.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${t}`);
}

const USAGE_BEARING = new Set(["message_end", "turn_end", "agent_end"]);
const lost = [...lostTypes.entries()].filter(([t]) => USAGE_BEARING.has(t));
console.log(
  lost.length === 0
    ? "\nVERDICT: no usage-bearing event was lost. Token and tool counts stand."
    : `\nVERDICT: LOST USAGE — ${lost.map(([t, n]) => `${n}x ${t}`).join(", ")}. Those runs understate cost.`,
);
