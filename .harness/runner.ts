#!/usr/bin/env bun
/**
 * The experiment runner.
 *
 * For every (task, condition, repeat) it prepares a fresh copy of the task's seed
 * directory, hands the prompt to `omp` in non-interactive JSON mode, and records what
 * the run cost and whether it finished. Nothing here interprets the model's work: the
 * runner's only job is to make the two conditions comparable and to keep an honest
 * record of tokens, tool calls, wall time and failure.
 *
 * The pure parts — NDJSON parsing and the aggregate arithmetic — are exported so they
 * can be unit tested without spawning a model.
 *
 * Usage: `bun runner.ts --tasks a,b --conditions baseline,semantic --repeats 2 --timeout 600`
 */

import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Condition {
  id: string;
  tools: string;
  extension: string | null;
  label: string;
}

export interface TaskSpec {
  id: string;
  promptFile: string;
  hiddenTest: string | null;
  description: string;
  /** Absolute path to the task directory. */
  dir: string;
}

export type RunStatus = "ok" | "timeout" | "crashed";

export interface RunRecord {
  task: string;
  condition: string;
  repeat: number;
  status: RunStatus;
  ok: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  tool_calls: number;
  turns: number;
  is_terminal: boolean;
  seconds: number;
  exit_code: number | null;
  tools: string;
  extension: string | null;
  work_dir: string;
  events: string;
  model: string;
  started_at: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HARNESS = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const TASKS_DIR = join(HARNESS, "tasks");
const RUNS_DIR = join(HARNESS, "runs");
const CONDITIONS_FILE = join(HARNESS, "conditions.json");

const DEFAULT_MODEL = "freeflow/space-bunny-free";
const DEFAULT_TIMEOUT = 600;

// ---------------------------------------------------------------------------
// NDJSON parsing
// ---------------------------------------------------------------------------

/** One assistant turn's terminal usage record. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
}

export interface ParsedEvents {
  /**
   * Sum of usage over assistant turns. `omp` emits one `message_end` per assistant
   * message, and a turn can contain several; the contract is to count the LAST
   * `message_end` of each turn, so a partially-streamed message is not double counted.
   */
  usage: Usage;
  toolCalls: number;
  turns: number;
  isTerminal: boolean;
  /** Non-fatal problems: unparseable lines, missing agent_end, and so on. */
  warnings: string[];
}

/** Read a usage object off an event, treating absent or non-finite fields as zero. */
function readUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as Partial<Usage>;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { input: n(u.input), output: n(u.output), cacheRead: n(u.cacheRead) };
}

function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead };
}


/**
 * Fold an `omp --mode=json` event stream into the metrics the experiment compares.
 *
 * Tolerant by construction: the stream is NDJSON over a pipe and the process can be
 * killed mid-line, so a partial trailing line is a warning rather than a crash. A run
 * that produced no parseable events yields all-zero metrics, which is honest — it spent
 * nothing measurable — rather than a fabricated number.
 */
export function parseEvents(text: string): ParsedEvents {
  const warnings: string[] = [];
  let usage: Usage = { input: 0, output: 0, cacheRead: 0 };
  let toolCalls = 0;
  let turns = 0;
  let isTerminal = false;
  let sawAgentEnd = false;
  // Usage of the most recent assistant message_end, carried into the next turn_end.
  let pending: Usage | null = null;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // A killed process leaves a half-written last line; that is expected, not an error.
      warnings.push(`line ${i + 1}: not JSON`);
      continue;
    }

    switch (ev.type) {
      case "message_end": {
        const msg = ev.message as { role?: string; usage?: unknown } | undefined;
        if (msg?.role === "assistant") pending = readUsage(msg.usage);
        break;
      }
      case "turn_end": {
        turns += 1;
        // The turn's cost is the last assistant message_end seen within it.
        if (pending) usage = addUsage(usage, pending);
        pending = null;
        const results = ev.toolResults;
        if (Array.isArray(results)) toolCalls += results.length;
        break;
      }
      case "agent_end": {
        sawAgentEnd = true;
        isTerminal = ev.isTerminal === true;
        break;
      }
      default:
        break;
    }
  }

  // A stream cut off before its final turn_end still spent tokens; do not discard them.
  if (pending) {
    usage = addUsage(usage, pending);
    warnings.push("stream ended without a closing turn_end");
  }
  if (!sawAgentEnd) warnings.push("no agent_end event");

  return { usage, toolCalls, turns, isTerminal, warnings };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface ConditionSummary {
  condition: string;
  runs: number;
  finished: number;
  passed: number;
  /** pass rate over runs that produced a gradeable work dir, 0 when there are none. */
  pass_rate: number;
  mean_input_tokens: number;
  mean_output_tokens: number;
  mean_tool_calls: number;
  mean_seconds: number;
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const round = (n: number): number => Math.round(n * 100) / 100;

/** Anything that can report a pass/fail verdict and its cost. */
export interface GradableRun {
  condition: string;
  passed: boolean;
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
  seconds: number;
}

/**
 * Group runs by condition and reduce each group to the two numbers the research
 * question actually needs: did success hold, and did input tokens drop.
 *
 * Ungraded runs (crashed, timed out) are excluded from the means but counted in
 * `runs`, so a condition that dies half way through cannot look cheap by averaging
 * over the survivors alone. `pass_rate` is over `finished` — the runs that reached
 * grading — with a crashed run counting as a failure of the condition as a whole.
 */
export function aggregate(runs: readonly GradableRun[]): ConditionSummary[] {
  const byCondition = new Map<string, GradableRun[]>();
  for (const r of runs) {
    const list = byCondition.get(r.condition);
    if (list) list.push(r);
    else byCondition.set(r.condition, [r]);
  }

  const out: ConditionSummary[] = [];
  for (const [condition, group] of byCondition) {
    const passed = group.filter((r) => r.passed).length;
    out.push({
      condition,
      runs: group.length,
      finished: group.length,
      passed,
      pass_rate: group.length === 0 ? 0 : round(passed / group.length),
      mean_input_tokens: round(mean(group.map((r) => r.input_tokens))),
      mean_output_tokens: round(mean(group.map((r) => r.output_tokens))),
      mean_tool_calls: round(mean(group.map((r) => r.tool_calls))),
      mean_seconds: round(mean(group.map((r) => r.seconds))),
    });
  }
  return out.sort((a, b) => a.condition.localeCompare(b.condition));
}

// ---------------------------------------------------------------------------
// Task discovery
// ---------------------------------------------------------------------------

/** Read the task ids present on disk, in stable order. */
export async function discoverTasks(tasksDir: string): Promise<string[]> {
  if (!existsSync(tasksDir)) return [];
  const entries = await readdir(tasksDir, { withFileTypes: true });
  const ids: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (existsSync(join(tasksDir, e.name, "task.json"))) ids.push(e.name);
  }
  return ids.sort();
}

async function loadTask(tasksDir: string, id: string): Promise<TaskSpec> {
  const dir = join(tasksDir, id);
  const raw = await readFile(join(dir, "task.json"), "utf8");
  const spec = JSON.parse(raw) as Partial<TaskSpec>;
  return {
    id: spec.id ?? id,
    promptFile: spec.promptFile ?? "prompt.txt",
    hiddenTest: spec.hiddenTest ?? null,
    description: spec.description ?? "",
    dir,
  };
}

// ---------------------------------------------------------------------------
// Running one (task, condition, repeat)
// ---------------------------------------------------------------------------

export function runDir(runsDir: string, task: string, condition: string, repeat: number): string {
  return join(runsDir, task, condition, String(repeat));
}

/**
 * The argv for one run. Exported so the conditions' effect on the command line is
 * directly assertable: the two conditions must differ in exactly `--tools` and `-e`.
 */
export function buildArgv(opts: {
  prompt: string;
  model: string;
  cwd: string;
  tools: string;
  extension: string | null;
}): string[] {
  const argv = [
    "-p", opts.prompt,
    "--mode=json",
    "--no-session",
    `--model=${opts.model}`,
    `--cwd=${opts.cwd}`,
    `--tools=${opts.tools}`,
  ];
  if (opts.extension) argv.push("-e", opts.extension);
  return argv;
}

async function runOne(opts: {
  task: TaskSpec;
  condition: Condition;
  repeat: number;
  runsDir: string;
  model: string;
  timeout: number;
}): Promise<RunRecord> {
  const { task, condition, repeat, runsDir, model, timeout } = opts;
  const dir = runDir(runsDir, task.id, condition.id, repeat);
  const work = join(dir, "work");
  const eventsPath = join(dir, "events.ndjson");

  // A fresh work dir per run: a repeat must never inherit a previous attempt's edits,
  // and the hidden test is never copied in — only `seed/` is.
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  await cp(join(task.dir, "seed"), work, { recursive: true });

  const prompt = (await readFile(join(task.dir, task.promptFile), "utf8")).trim();
  const argv = buildArgv({ prompt, model, cwd: work, tools: condition.tools, extension: condition.extension });
  const command = ["omp", ...argv];

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const proc = Bun.spawn(command, {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
    // Keep the child's console quiet; the event stream is the record.
    env: { ...process.env, NO_COLOR: "1" },
  });

  // Read both pipes concurrently with the wait, or a full pipe buffer deadlocks the child.
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeout * 1000);

  let exitCode: number | null = null;
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timer);
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const seconds = (Date.now() - t0) / 1000;

  await mkdir(dir, { recursive: true });
  await writeFile(eventsPath, stdout, "utf8");
  if (stderr.trim() !== "") await writeFile(join(dir, "stderr.log"), stderr, "utf8");

  const parsed = parseEvents(stdout);
  // A stream that never reached agent_end means the agent did not finish its own loop.
  const finished = !timedOut && parsed.isTerminal && exitCode === 0;
  const status: RunStatus = timedOut ? "timeout" : finished ? "ok" : "crashed";

  const record: RunRecord = {
    task: task.id,
    condition: condition.id,
    repeat,
    status,
    ok: finished,
    input_tokens: parsed.usage.input,
    output_tokens: parsed.usage.output,
    cache_read_tokens: parsed.usage.cacheRead,
    tool_calls: parsed.toolCalls,
    turns: parsed.turns,
    is_terminal: parsed.isTerminal,
    seconds: Math.round(seconds * 100) / 100,
    exit_code: exitCode,
    tools: condition.tools,
    extension: condition.extension,
    work_dir: work,
    events: eventsPath,
    model,
    started_at: startedAt,
  };
  if (status === "crashed" && stderr.trim() !== "") {
    record.error = stderr.trim().split("\n").slice(0, 4).join(" | ").slice(0, 400);
  }
  if (parsed.warnings.length > 0 && !record.error) {
    record.error = `event stream: ${parsed.warnings.join("; ")}`;
  }

  await writeFile(join(dir, "run.json"), JSON.stringify(record, null, 2) + "\n", "utf8");
  return record;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `mm harness — the experiment runner

USAGE
  bun runner.ts [options]

OPTIONS
  --tasks <a,b>            Task ids to run. Default: every task on disk.
  --tasks-dir <path>       Task root. Default: .harness/tasks
  --conditions <a,b>       Condition ids to run. Default: every condition in conditions.json
  --conditions-file <path> Default: .harness/conditions.json
  --repeats <n>            Repeats per (task, condition). Default: 1
  --timeout <seconds>      Hard wall-clock cap per run. Default: 600
  --model <id>             Default: ${DEFAULT_MODEL}
  --runs-dir <path>        Default: .harness/runs
  -h, --help               This message

Runs whose run.json already exists are skipped, so a long sweep can be restarted
by re-running the same command.
`;

interface Options {
  tasks: string[] | null;
  tasksDir: string;
  conditions: string[] | null;
  conditionsFile: string;
  repeats: number;
  timeout: number;
  model: string;
  runsDir: string;
}

export function parseArgs(argv: readonly string[]): Options | { help: true } {
  const o: Options = {
    tasks: null,
    tasksDir: TASKS_DIR,
    conditions: null,
    conditionsFile: CONDITIONS_FILE,
    repeats: 1,
    timeout: DEFAULT_TIMEOUT,
    model: DEFAULT_MODEL,
    runsDir: RUNS_DIR,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    const list = (): string[] => next().split(",").map((s) => s.trim()).filter((s) => s !== "");
    switch (a) {
      case "-h":
      case "--help":
        return { help: true };
      case "--tasks": o.tasks = list(); break;
      case "--tasks-dir": o.tasksDir = resolve(next()); break;
      case "--conditions": o.conditions = list(); break;
      case "--conditions-file": o.conditionsFile = resolve(next()); break;
      case "--repeats": o.repeats = Math.max(1, Number.parseInt(next(), 10) || 1); break;
      case "--timeout": o.timeout = Math.max(1, Number.parseInt(next(), 10) || DEFAULT_TIMEOUT); break;
      case "--model": o.model = next(); break;
      case "--runs-dir": o.runsDir = resolve(next()); break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  return o;
}

async function main(argv: readonly string[]): Promise<number> {
  let opts: Options | { help: true };
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`runner: ${(e as Error).message}\n`);
    console.log(USAGE);
    return 2;
  }
  if ("help" in opts) {
    console.log(USAGE);
    return 0;
  }

  const spec = JSON.parse(await readFile(opts.conditionsFile, "utf8")) as { conditions: Condition[] };
  const byId = new Map(spec.conditions.map((c) => [c.id, c]));
  const wantedConditions = opts.conditions ?? spec.conditions.map((c) => c.id);
  const conditions: Condition[] = [];
  for (const id of wantedConditions) {
    const c = byId.get(id);
    if (!c) {
      console.error(`runner: no condition \`${id}\` in ${opts.conditionsFile}`);
      return 2;
    }
    conditions.push(c);
  }

  const available = await discoverTasks(opts.tasksDir);
  const taskIds = opts.tasks ?? available;
  for (const id of taskIds) {
    if (!available.includes(id)) {
      console.error(`runner: no task \`${id}\` under ${opts.tasksDir}`);
      return 2;
    }
  }
  if (taskIds.length === 0) {
    console.log(`runner: no tasks under ${opts.tasksDir}`);
    return 0;
  }

  console.log(
    `runner: ${taskIds.length} task(s) x ${conditions.length} condition(s) x ${opts.repeats} repeat(s), ` +
    `timeout ${opts.timeout}s, model ${opts.model}`,
  );

  const records: RunRecord[] = [];
  for (const id of taskIds) {
    const task = await loadTask(opts.tasksDir, id);
    for (const condition of conditions) {
      for (let repeat = 1; repeat <= opts.repeats; repeat++) {
        const dir = runDir(opts.runsDir, task.id, condition.id, repeat);
        const existing = join(dir, "run.json");
        if (existsSync(existing)) {
          const prior = JSON.parse(await readFile(existing, "utf8")) as RunRecord;
          records.push(prior);
          console.log(
            `  ${task.id}/${condition.id}/${repeat}: skip (already recorded, ${prior.status})`,
          );
          continue;
        }
        console.log(`  ${task.id}/${condition.id}/${repeat}: running…`);
        const rec = await runOne({
          task, condition, repeat,
          runsDir: opts.runsDir, model: opts.model, timeout: opts.timeout,
        });
        records.push(rec);
        console.log(
          `  ${task.id}/${condition.id}/${repeat}: ${rec.status} ` +
          `in=${rec.input_tokens} out=${rec.output_tokens} tools=${rec.tool_calls} ${rec.seconds}s`,
        );
      }
    }
  }

  // The runner's own pass rate is always 0: nothing is graded until score.ts runs.
  const summary = {
    generated_at: new Date().toISOString(),
    model: opts.model,
    tasks: taskIds,
    conditions: conditions.map((c) => ({ id: c.id, tools: c.tools, extension: c.extension, label: c.label })),
    runs: records,
    by_condition: aggregate(records.map((r) => ({
      condition: r.condition, passed: false,
      input_tokens: r.input_tokens, output_tokens: r.output_tokens,
      tool_calls: r.tool_calls, seconds: r.seconds,
    }))),
  };
  await mkdir(opts.runsDir, { recursive: true });
  await writeFile(join(opts.runsDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log("\nruns by condition (pass rate is 0 until score.ts grades):");
  console.log("  condition    runs  ok  in_tok  out_tok  calls   secs");
  for (const s of summary.by_condition) {
    const ok = records.filter((r) => r.condition === s.condition && r.ok).length;
    console.log(
      `  ${s.condition.padEnd(11)} ${String(s.runs).padStart(4)} ${String(ok).padStart(3)} ` +
      `${s.mean_input_tokens.toFixed(0).padStart(7)} ${s.mean_output_tokens.toFixed(0).padStart(8)} ` +
      `${s.mean_tool_calls.toFixed(1).padStart(6)} ${s.mean_seconds.toFixed(1).padStart(6)}`,
    );
  }
  console.log(`\nsummary: ${join(opts.runsDir, "summary.json")}`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
