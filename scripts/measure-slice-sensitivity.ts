#!/usr/bin/env bun
/**
 * Is the slice's size a function of the code, or only of the symbol count?
 *
 * The headline number in the report is a *ratio*: a goal-directed slice costs
 * 0.166-0.229 of the source it stands for. A ratio like that reads as a compression
 * factor, and it invites the conclusion that the agent gets the same information for a
 * fifth of the price. That reading is only valid if the projection carries the source's
 * information.
 *
 * This measures the thing the ratio hides. For each fixture it renders a slice, then
 * inflates every function body with inert statements and renders again. If the slice is a
 * faithful compression it must grow with the source. If it is a structural index it will
 * not move, because the injected statements are exactly the information the projection
 * does not carry.
 *
 * The outcome is a property of the projection, not of any model, so this needs no agent
 * and no sweep. It is deterministic.
 */
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dir, "..");
const SEEDS = ["bitfield", "slot_pool", "tally", "checkdigit"];

/**
 * Insert inert executable code that declares no new names.
 *
 * Padding with `let _padN = ...` would be confounded: each one is a new local, and
 * locals *are* part of the projection, so the slice would grow for a reason that has
 * nothing to do with statements. These statements reuse a name the body already has, so
 * the symbol count is unchanged and the only thing that moves is the size of the body.
 */
function inflate(src: string, n: number): string {
  const lines = src.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    out.push(line);
    // Seeds put the opening brace on the `fn` line, so that is what opens a body.
    if (/^\s*fn\s+\w+\s*\(/.test(line) && line.trimEnd().endsWith("{")) {
      for (let k = 0; k < n; k++) out.push(`    if key == ${900000 + k} { key = ${900000 + k}; }`);
    }
  }
  return out.join("\n");
}

function run(argv: string[]): string {
  const r = Bun.spawnSync(argv, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(r.stdout);
}

function sliceTokens(path: string, goal: string): number {
  const raw = run(["bun", "run", "src/cli.ts", "slice", path, `--goal=${goal}`]);
  const m = raw.match(/"estimatedTokens":\s*(\d+)/);
  if (m === null) throw new Error(`no estimatedTokens for ${path}\n${raw.slice(0, 400)}`);
  return Number(m[1]);
}

const dir = mkdtempSync(join(tmpdir(), "mmsens-"));
console.log("Does a slice grow when the code it stands for grows?\n");
console.log(
  ["fixture", "src bytes", "x2 src", "slice", "x2 slice", "src growth", "slice growth"]
    .map((h, i) => h.padEnd([14, 10, 10, 8, 9, 12, 12][i]!))
    .join(""),
);

const rows: { name: string; srcGrowth: number; sliceGrowth: number }[] = [];
for (const name of SEEDS) {
  const seed = join(ROOT, ".harness", "tasks", name, "seed", `${name}.mm`);
  const src = readFileSync(seed, "utf8");
  const goal = `fix the ${name} defect`;

  const a = join(dir, `${name}_a.mm`);
  const b = join(dir, `${name}_b.mm`);
  writeFileSync(a, src);
  writeFileSync(b, inflate(src, 12));

  const aBytes = readFileSync(a).length;
  const bBytes = readFileSync(b).length;
  const aTok = sliceTokens(a, goal);
  const bTok = sliceTokens(b, goal);

  const srcGrowth = (bBytes - aBytes) / aBytes;
  const sliceGrowth = (bTok - aTok) / aTok;
  rows.push({ name, srcGrowth, sliceGrowth });

  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  console.log(
    [
      name,
      String(aBytes),
      String(bBytes),
      String(aTok),
      String(bTok),
      pct(srcGrowth),
      pct(sliceGrowth),
    ]
      .map((v, i) => v.padEnd([14, 10, 10, 8, 9, 12, 12][i]!))
      .join(""),
  );
}

copyFileSync; // keep the import honest if the temp dir is ever cleaned differently

const meanSrc = rows.reduce((s, r) => s + r.srcGrowth, 0) / rows.length;
const meanSlice = rows.reduce((s, r) => s + r.sliceGrowth, 0) / rows.length;
console.log(`\nmean source growth ${(meanSrc * 100).toFixed(1)}%, mean slice growth ${(meanSlice * 100).toFixed(1)}%`);

if (Math.abs(meanSlice) < 0.1 && meanSrc > 0.3) {
  console.log(
    "\nVERDICT: the slice does not grow with the code. Its size is set by the symbol\n" +
      "count, so the source/slice ratio measures how many functions a file has, not how\n" +
      "much of the source's information reaches the agent. A projection that carries no\n" +
      "statements cannot be a compression of the statements, and the ratio is not a\n" +
      "compression factor.",
  );
} else {
  console.log(
    "\nVERDICT: inconclusive at this inflation — the slice does track the source, so the\n" +
      "ratio may be a genuine compression factor after all.",
  );
}
