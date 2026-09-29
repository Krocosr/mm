import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The within-cell spread of input tokens, per (task, condition).
 *
 * This is the number that decides what the sweep can support. If two runs of the *same*
 * condition on the *same* task differ by 10x, then a 20% gap between conditions is well
 * inside the noise and no mean or median across cells means anything on its own.
 */
const rows = [];
for (const task of readdirSync("runs").sort()) {
  const td = join("runs", task);
  if (!statSync(td).isDirectory()) continue;
  for (const cond of readdirSync(td).sort()) {
    const cd = join(td, cond);
    if (!statSync(cd).isDirectory()) continue;
    const v = [];
    for (const rep of readdirSync(cd).sort()) {
      try {
        const j = JSON.parse(readFileSync(join(cd, rep, "run.json"), "utf8"));
        if (j.status === "ok") v.push(j.input_tokens);
      } catch {
        /* not a finished run */
      }
    }
    if (v.length >= 2) {
      rows.push({ cell: `${task}/${cond}`, v, ratio: Math.max(...v) / Math.min(...v) });
    }
  }
}
rows.sort((a, b) => b.ratio - a.ratio);
for (const r of rows) {
  console.log(`  ${r.cell.padEnd(34)}${r.ratio.toFixed(1).padStart(6)}x   ${r.v.join(", ")}`);
}
const rs = rows.map((r) => r.ratio).sort((a, b) => a - b);
const med = rs[Math.floor(rs.length / 2)];
console.log(`\nmedian within-cell spread: ${med.toFixed(1)}x across ${rows.length} cells`);
const byCond = new Map();
for (const r of rows) {
  const c = r.cell.split("/")[1];
  byCond.set(c, [...(byCond.get(c) ?? []), r.ratio]);
}
for (const [c, xs] of [...byCond.entries()].sort()) {
  xs.sort((a, b) => a - b);
  console.log(`  ${c.padEnd(16)} median ${xs[Math.floor(xs.length / 2)].toFixed(1)}x  (${xs.length} cells)`);
}
