#!/usr/bin/env bun
/**
 * The scorer.
 *
 * It grades what the runner recorded: for each run it copies the task's hidden tests
 * into the finished work directory and runs the MM CLI over the whole directory, then
 * reports the two numbers the research question needs — pass rate per condition, and
 * mean input tokens per condition. The experiment succeeds when tokens drop while
 * success holds, so both numbers are printed side by side and never separately.
 *
 * Grading a directory rather than a single file is deliberate: `mm run <file>` loads
 * only that file, so a hidden test that calls into the agent's edited module would not
 * resolve. Loading the directory lets the CLI see both, and the `ok`/`FAIL` lines are
 * filtered back down to the hidden modules so the agent's own tests cannot vote.
 *
 * Usage: `bun score.ts [--runs-dir .harness/runs] [--tasks-dir .harness/tasks] [--timeout 120]`
 */

import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { aggregate, type GradableRun, type RunRecord } from "./runner.ts";

const HARNESS = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const MM_ROOT = resolve(HARNESS, "..");
const DEFAULT_RUNS_DIR = join(HARNESS, "runs");
const DEFAULT_TASKS_DIR = join(HARNESS, "tasks");
const DEFAULT_TIMEOUT = 120;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ResultRecord extends GradableRun {

  /**
   * Why a run did not pass. `no_tests_ran` is deliberately distinct from a failure:
   * a run that executed zero hidden tests has not demonstrated anything, and folding
   * it into either bucket is how a broken fixture turns into a clean pass rate.
   */
  failure_kind?:
    | "run_did_not_finish"
    | "work_dir_missing"
    | "no_hidden_tests"
    | "no_tests_ran"
    | "hidden_tests_failed";
  /** The hidden test files this run was graded against, recorded for auditability. */
  hidden_tests: string[];
  task: string;
  condition: string;
  repeat: number;
  passed: boolean;
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
  /**
   * How many `mm_*` tools this run actually invoked, summed across the run.
   *
   * A semantic run that never calls an `mm_*` tool is not a semantic measurement: it
   * measured the baseline, and its token count says nothing about the semantic
   * interface. This number is what makes that failure visible instead of invisible.
   */
  mm_tool_calls: number;
  tool_calls_by_name: Record<string, number>;
  seconds: number;
  status: string;
  tools: string;
  extension: string | null;
  tests_total: number;
  tests_failed: number;
  failure_reason?: string;
}

// ---------------------------------------------------------------------------
// Grading one run
// ---------------------------------------------------------------------------

/**
 * The `ok`/`FAIL` lines `mm run` prints, as (module, name, passed).
 *
 * The module is everything before the FIRST `::`-free test-name boundary: the CLI
 * prints `<module>::<test name>`, and a test name may itself contain `::`, so the
 * split is on the first separator only.
 */
export function parseTestResults(stdout: string): { module: string; name: string; passed: boolean }[] {
  const out: { module: string; name: string; passed: boolean }[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(ok|FAIL)\s+(\S.*)$/.exec(line.trim());
    if (!m) continue;
    const qualified = m[2]!;
    const sep = qualified.indexOf("::");
    if (sep < 0) continue;
    out.push({
      module: qualified.slice(0, sep),
      name: qualified.slice(sep + 2),
      passed: m[1] === "ok",
    });
  }
  return out;
}

/**
 * Decide a verdict from the CLI's output for a hidden module.
 *
 * A run passes only if the hidden module reported at least one test AND every one of
 * them passed. Zero reported tests is a failure, not a pass: a missing or renamed test
 * file must never read as success.
 */
export function verdict(
  results: readonly { module: string; passed: boolean }[],
): { passed: boolean; total: number; failed: number; reason?: string } {
  const mine = results.filter((r) => isHiddenModule(r.module));
  const failed = mine.filter((r) => !r.passed).length;
  if (mine.length === 0) {
    return { passed: false, total: 0, failed: 0, reason: "no hidden tests were reported" };
  }
  if (failed > 0) {
    return { passed: false, total: mine.length, failed, reason: `${failed} of ${mine.length} hidden tests failed` };
  }
  return { passed: true, total: mine.length, failed: 0 };
}

/**
 * The module prefix every hidden test is loaded under.
 *
 * The hidden tests are copied into `<work>/hidden/`, so `mm run <work>` names them
 * `hidden::<file>::<test>`. Parsing splits a result line at the FIRST `::`, which
 * yields the module `hidden` — so the filter is on that leading component, not on the
 * whole qualified name.
 */
const HIDDEN_MODULE_PREFIX = "hidden";

function isHiddenModule(module: string): boolean {
  return module === HIDDEN_MODULE_PREFIX || module.startsWith(`${HIDDEN_MODULE_PREFIX}::`);
}

async function listHidden(hiddenDir: string): Promise<string[]> {
  if (!existsSync(hiddenDir)) return [];
  const out: string[] = [];
  for (const e of await readdir(hiddenDir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".mm")) out.push(e.name);
  }
  return out.sort();
}

async function gradeRun(opts: {
  run: RunRecord;
  tasksDir: string;
  timeout: number;
}): Promise<ResultRecord> {
  const { run, tasksDir, timeout } = opts;
  const base: ResultRecord = {
    task: run.task,
    condition: run.condition,
    repeat: run.repeat,
    passed: false,
    finished: run.ok,
    input_tokens: run.input_tokens,
    output_tokens: run.output_tokens,
    tool_calls: run.tool_calls,
    tool_calls_by_name: run.tool_calls_by_name ?? {},
    mm_tool_calls: Object.entries(run.tool_calls_by_name ?? {})
      .filter(([name]) => name.startsWith("mm_"))
      .reduce((n, [, count]) => n + count, 0),
    seconds: run.seconds,
    status: run.status,
    tools: run.tools,
    extension: run.extension,
    tests_total: 0,
    tests_failed: 0,
    hidden_tests: [],
  };

  // A run that never finished has no work dir worth grading: the timeout is the result.
  if (!run.ok) {
    return { ...base, failure_kind: "run_did_not_finish", failure_reason: `run did not finish (${run.status})` };
  }
  if (!existsSync(run.work_dir)) {
    return { ...base, failure_kind: "work_dir_missing", failure_reason: `work dir missing: ${run.work_dir}` };
  }

  const hiddenDir = join(tasksDir, run.task, "hidden");
  const files = await listHidden(hiddenDir);
  if (files.length === 0) {
    // Loud and distinct: a task graded against no tests has measured nothing at all.
    return {
      ...base,
      failure_kind: "no_hidden_tests",
      failure_reason: `task ${run.task} has no hidden tests under ${hiddenDir}`,
    };
  }

  // Copy the hidden tests in AFTER the agent is done, so the agent could never have
  // read them. The agent's edits are untouched; only the tests are added.
  const dest = join(run.work_dir, "hidden");
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  for (const f of files) await cp(join(hiddenDir, f), join(dest, f));

  const proc = Bun.spawn(
    ["bun", "run", join(MM_ROOT, "src", "cli.ts"), "run", run.work_dir],
    { cwd: MM_ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } },
  );
  const stdoutP = new Response(proc.stdout).text();
  const stderrP = new Response(proc.stderr).text();
  const timer = setTimeout(() => proc.kill(), timeout * 1000);
  let exitCode: number | null = null;
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timer);
  }
  const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);

  const results = parseTestResults(stdout);
  const v = verdict(results);
  const out: ResultRecord = {
    ...base,
    passed: v.passed,
    tests_total: v.total,
    tests_failed: v.failed,
    // Recorded so a graded run can always be traced back to the files that graded it.
    hidden_tests: files,
  };
  if (!v.passed) {
    const detail = v.reason ?? `exit ${exitCode}`;
    const firstFail = results.find((r) => isHiddenModule(r.module) && !r.passed);
    out.failure_kind = v.total === 0 ? "no_tests_ran" : "hidden_tests_failed";
    out.failure_reason = firstFail
      ? `${detail}: ${firstFail.module}::${firstFail.name}`
      : stderr.trim() !== "" ? `${detail}: ${stderr.trim().split("\n")[0]!.slice(0, 200)}` : detail;
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `mm harness — the scorer

USAGE
  bun score.ts [options]

OPTIONS
  --runs-dir <path>    Default: .harness/runs
  --tasks-dir <path>   Default: .harness/tasks
  --timeout <seconds>  Per-run grading cap. Default: ${DEFAULT_TIMEOUT}
  -h, --help           This message

Writes .harness/runs/results.json.
`;

interface Options { runsDir: string; tasksDir: string; timeout: number }

export function parseArgs(argv: readonly string[]): Options | { help: true } {
  const o: Options = { runsDir: DEFAULT_RUNS_DIR, tasksDir: DEFAULT_TASKS_DIR, timeout: DEFAULT_TIMEOUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "-h":
      case "--help": return { help: true };
      case "--runs-dir": o.runsDir = resolve(next()); break;
      case "--tasks-dir": o.tasksDir = resolve(next()); break;
      case "--timeout": o.timeout = Math.max(1, Number.parseInt(next(), 10) || DEFAULT_TIMEOUT); break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  return o;
}

/** Every `run.json` under a runs dir, in stable order. */
export async function discoverRuns(runsDir: string): Promise<string[]> {
  if (!existsSync(runsDir)) return [];
  const out: string[] = [];
  for (const task of (await readdir(runsDir, { withFileTypes: true })).filter((e) => e.isDirectory())) {
    for (const cond of (await readdir(join(runsDir, task.name), { withFileTypes: true })).filter((e) => e.isDirectory())) {
      const taskDir = join(runsDir, task.name, cond.name);
      for (const rep of (await readdir(taskDir, { withFileTypes: true })).filter((e) => e.isDirectory())) {
        const f = join(taskDir, rep.name, "run.json");
        if (existsSync(f)) out.push(f);
      }
    }
  }
  return out.sort();
}

async function main(argv: readonly string[]): Promise<number> {
  let opts: Options | { help: true };
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`score: ${(e as Error).message}\n`);
    console.log(USAGE);
    return 2;
  }
  if ("help" in opts) {
    console.log(USAGE);
    return 0;
  }

  const files = await discoverRuns(opts.runsDir);
  if (files.length === 0) {
    console.log(`score: no run.json under ${opts.runsDir}`);
    return 0;
  }

  const results: ResultRecord[] = [];
  for (const f of files) {
    const run = JSON.parse(await readFile(f, "utf8")) as RunRecord;
    const r = await gradeRun({ run, tasksDir: opts.tasksDir, timeout: opts.timeout });
    results.push(r);
    console.log(
      `  ${r.task}/${r.condition}/${r.repeat}: ${r.passed ? "PASS" : "FAIL"} ` +
      `(${r.tests_total - r.tests_failed}/${r.tests_total} hidden)` +
      (r.failure_reason ? ` — ${r.failure_reason}` : ""),
    );
  }

  const byCondition = aggregate(results);
  const mmCalls = (id: string): number =>
    results.filter((r) => r.condition === id).reduce((n, r) => n + r.mm_tool_calls, 0);
  const out = {
    generated_at: new Date().toISOString(),
    // A reader of this file in six months must be able to see the tool lists were
    // measured, not assumed, and see that the measurement contradicts the shipped docs.
    conditions_provenance: {
      omp_version: "18.4.3",
      tool_names_source: "the `TOOLS` array in omp-extension/mm.ts, in source order",
      tool_names: [
        "mm_check", "mm_symbol", "mm_refs", "mm_type",
        "mm_slice", "mm_packet", "mm_system", "mm_verify",
      ],
      measured_tools_flag_behaviour: {
        note:
          "Run directly on the installed omp; this CONTRADICTS omp://custom-tools.md, which " +
          "states --tools validates only built-in names. The observed behaviour is what these " +
          "results depend on.",
        registered_and_named: "works; tool callable",
        registered_not_named: "works; extension tools are force-included",
        named_but_not_registered:
          "hard startup error, 'Unknown tool in --tools', listing the registered tools. This is " +
          "why the semantic condition names its mm_* tools: it turns an extension that failed " +
          "to load into a loud failure instead of a silent downgrade to the baseline.",
      },
      semantic_extension:
        ".harness/loader/mm-ext.ts — omp-extension/mm.ts has no default export, so `-e` on the " +
        "library itself finds no factory and the tools silently do not exist. The loader lives " +
        "outside every run work/ dir so the agent cannot edit the tool it is measured on.",
    },
    results,
    by_condition: byCondition,
    // If a semantic condition never calls an mm_* tool, its token count is not evidence
    // about the semantic interface. Surface the total next to the rates.
    mm_tool_calls_by_condition: Object.fromEntries(byCondition.map((s) => [s.condition, mmCalls(s.condition)])),
  };
  await mkdir(opts.runsDir, { recursive: true });
  await writeFile(join(opts.runsDir, "results.json"), JSON.stringify(out, null, 2) + "\n", "utf8");

  // The two numbers the experiment exists for, side by side. Read the columns together
  // or the result is unreadable: tokens only mean something next to a pass rate.
  console.log("\n  condition     runs  passed  pass_rate  mean_in_tok  med_in_tok  in_tok range       mean_calls  mean_secs  mm_calls");
  for (const s of byCondition) {
    // Mean, median and range on one line. They disagree here, and which statistic you
    // pick changes the conclusion — that disagreement *is* the finding, so none of the
    // three is optional and the spread is never printed on a line of its own.
    const range = `${s.min_input_tokens}-${s.max_input_tokens}`;
    console.log(
      `  ${s.condition.padEnd(12)} ${String(s.runs).padStart(4)} ${String(s.passed).padStart(7)} ` +
      `${(s.pass_rate * 100).toFixed(0).padStart(9)}% ${s.mean_input_tokens.toFixed(0).padStart(12)} ` +
      `${s.median_input_tokens.toFixed(0).padStart(11)} ${range.padStart(15)} ` +
      `${s.mean_tool_calls.toFixed(1).padStart(11)} ${s.mean_seconds.toFixed(1).padStart(10)} ` +
      `${String(mmCalls(s.condition)).padStart(8)}`,
    );
  }
  for (const s of byCondition) {
    console.log(`  ${s.condition} per-run in_tok: ${s.input_tokens_each.join(", ")}`);
  }

  console.log("\n  finished runs only — a timeout burns tokens without producing an answer,");
  console.log("  so folding it into a cost average measures failure, not efficiency.");
  console.log(`  ${"condition".padEnd(14)}${"runs".padStart(6)}${"mean".padStart(11)}${"median".padStart(13)}`);
  for (const s of byCondition) {
    console.log(
      `  ${s.condition.padEnd(14)}${String(s.finished_runs).padStart(6)}` +
      `${s.mean_input_tokens_finished.toFixed(0).padStart(11)}` +
      `${s.median_input_tokens_finished.toFixed(0).padStart(13)}`,
    );
  }
  console.log(`\nresults: ${join(opts.runsDir, "results.json")}`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
