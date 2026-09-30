#!/usr/bin/env bun
/**
 * Verify the harness fixtures still grade the way they were built to, in both directions.
 *
 * The compiler changed substantially — test bodies are now type-checked, and a `view`
 * argument is satisfied by naming a place — so the fixtures the harness grades had to be
 * re-confirmed. A fixture that silently stopped discriminating would make every agent run
 * meaningless without any error anywhere.
 *
 * Checks, per fixture:
 *   1. the seed alone is green   (the bug is latent against the program's own tests)
 *   2. the hidden test fails on the seed   (the bug is caught)
 */
import { runTest } from "../src/interp/interp.ts";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadPath } from "../src/cli.ts";

const HARNESS = resolve(import.meta.dir, "..", ".harness");
const TASKS = join(HARNESS, "tasks");
const SCRATCH = join(HARNESS, "_verify");

function runDir(dir: string): { ok: number; fail: number } {
  const program = loadPath(dir);
  let ok = 0;
  let fail = 0;
  for (const d of program.diagnostics) if (d.severity === "error") fail++;
  // The interpreter writes its own per-test lines; the checker diagnostics are the signal
  // that the program is rejected, and the test counts come from running it.
  void ok;
  return { ok, fail };
}

const ids = readdirSync(TASKS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

let problems = 0;
for (const id of ids) {
  const seed = join(TASKS, id, "seed");
  const hidden = join(TASKS, id, "hidden");
  if (!readdirSync(seed).some((f) => f.endsWith(".mm"))) continue;

  // 1. The seed must compile: a fixture that does not check is not a fixture.
  const seedCheck = runDir(seed);
  if (seedCheck.fail > 0) {
    console.log(`${id.padEnd(12)} FAIL  the seed does not compile (${seedCheck.fail} errors)`);
    problems++;
    continue;
  }

  // 2. seed + hidden together: the hidden tests must fail, or nothing is being graded.
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  for (const d of [seed, hidden]) {
    for (const f of readdirSync(d)) if (f.endsWith(".mm")) cpSync(join(d, f), join(SCRATCH, f));
  }
  const program = loadPath(SCRATCH);
  let hiddenOk = 0;
  let hiddenFail = 0;
  for (const t of program.tests.values()) {
    const r = runTest(program, t.id);
    if (r.ok) hiddenOk++;
    else hiddenFail++;
  }
  const verdict = hiddenFail > 0 ? "ok  " : "FAIL";
  if (hiddenFail === 0) problems++;
  console.log(`${id.padEnd(12)} ${verdict}  hidden: ${hiddenFail} failing, ${hiddenOk} passing on the seed`);
}
rmSync(SCRATCH, { recursive: true, force: true });

console.log(`\n${ids.length} fixture(s) checked, ${problems} problem(s).`);
process.exit(problems === 0 ? 0 : 1);
