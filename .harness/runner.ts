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

import { existsSync, readdirSync } from "node:fs";
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
  /** Per-tool invocation counts, so condition differences are verifiable after the fact. */
  tool_calls_by_name: Record<string, number>;
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
  /**
   * Top-level repository entries that appeared during this run.
   *
   * The sandbox is advisory: the loader is kept outside every `work/` by placement, but
   * an agent can still write elsewhere in the tree, and one did — a `.mm` file at the
   * repo root, which a later `mm check .` would collect. Recording the strays on the run
   * that caused them is the difference between a known gap and an unexplained file.
   */
  stray_files?: string[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HARNESS = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
/** The repository root — the tree an agent can still reach outside its `work/` dir. */
const MM_ROOT = resolve(HARNESS, "..");
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
  /**
   * How many times each tool was actually invoked, keyed by tool name.
   *
   * This is what makes the two conditions verifiably different rather than merely
   * configured differently: a semantic run that finishes without touching an `mm_*`
   * tool measured the baseline, and its token count must not be read as evidence.
   */
  toolCallsByName: Record<string, number>;
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
  const toolCallsByName: Record<string, number> = {};
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
        if (Array.isArray(results)) {
          toolCalls += results.length;
          for (const r of results) {
            const name = (r as { toolName?: unknown }).toolName;
            if (typeof name === "string") toolCallsByName[name] = (toolCallsByName[name] ?? 0) + 1;
          }
        }
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

  return { usage, toolCalls, toolCallsByName, turns, isTerminal, warnings };
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
  /**
   * Min and max input tokens in this condition.
   *
   * A mean over a handful of runs hides the thing that decides whether the mean means
   * anything. Observed spread in the first sweep was 3x *within* a single condition
   * (6150 vs 1911 for `baseline`), which is wider than any difference between conditions.
   * Quoting the mean alone would present noise as a finding, so the range travels with it.
   */
  min_input_tokens: number;
  max_input_tokens: number;
  /** The individual per-run input tokens, so a reader can see the distribution. */
  input_tokens_each: number[];
  /**
   * Median input tokens, reported beside the mean.
   *
   * With eight runs per condition and a 10x spread, the mean and the median disagree
   * about which condition is cheaper — the mean is dragged by a tail of expensive runs.
   * A reader shown only the mean would be shown a conclusion that reverses under a
   * different choice of statistic, which is the whole problem in one number.
   */
  median_input_tokens: number;
  /**
   * The same statistics over runs that actually finished.
   *
   * A run that hits the wall-clock cap is both a *failure* and an unbounded cost — it
   * keeps spending tokens until it is killed. Averaging it into the token figure
   * conflates "what a run costs" with "what a broken run costs before it gives up",
   * and it is enough on its own to flip the sign of the result: the all-runs mean said
   * the semantic condition was 26 % cheaper, the median said it was 15 % dearer. Both
   * numbers are reported so the reader can see which is doing the work.
   */
  finished_runs: number;
  mean_input_tokens_finished: number;
  median_input_tokens_finished: number;
}

/** Middle value, or the mean of the two middle values for an even count. */
const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const round = (n: number): number => Math.round(n * 100) / 100;

/** Anything that can report a pass/fail verdict and its cost. */
export interface GradableRun {
  condition: string;
  passed: boolean;
  /**
   * True when the agent reached a terminal state inside the time cap.
   *
   * Distinct from `passed`: a run can finish and still fail its hidden tests, and a run
   * that timed out is neither finished nor passed — but it still spent real tokens, and
   * folding that into a cost average is what made the mean and the median disagree.
   */
  finished: boolean;
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
    const tokens = group.map((r) => r.input_tokens);
    const done = group.filter((r) => r.finished).map((r) => r.input_tokens);
    out.push({
      condition,
      runs: group.length,
      finished: group.length,
      passed,
      pass_rate: group.length === 0 ? 0 : round(passed / group.length),
      mean_input_tokens: round(mean(tokens)),
      mean_output_tokens: round(mean(group.map((r) => r.output_tokens))),
      mean_tool_calls: round(mean(group.map((r) => r.tool_calls))),
      mean_seconds: round(mean(group.map((r) => r.seconds))),
      min_input_tokens: tokens.length === 0 ? 0 : Math.min(...tokens),
      max_input_tokens: tokens.length === 0 ? 0 : Math.max(...tokens),
      input_tokens_each: tokens.slice().sort((a, b) => a - b),
      median_input_tokens: round(median(tokens)),
      finished_runs: done.length,
      mean_input_tokens_finished: round(mean(done)),
      median_input_tokens_finished: round(median(done)),
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

/**
 * Read a task's spec, accepting both the contract's snake_case keys and the camelCase
 * spelling. A silently-ignored key is the dangerous case here: a task whose prompt file
 * resolved wrong would be graded against a prompt nobody saw, so an unresolvable
 * prompt is a hard error rather than a default.
 */
export async function loadTask(tasksDir: string, id: string): Promise<TaskSpec> {
  const dir = join(tasksDir, id);
  const spec = JSON.parse(await readFile(join(dir, "task.json"), "utf8")) as Record<string, unknown>;
  const str = (key: string): string | null => {
    for (const k of [key, key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())]) {
      const v = spec[k];
      if (typeof v === "string" && v !== "") return v;
    }
    return null;
  };
  const promptFile = str("prompt_file") ?? "prompt.txt";
  if (!existsSync(join(dir, promptFile))) {
    throw new Error(`task \`${id}\`: prompt file \`${promptFile}\` not found in ${dir}`);
  }
  return {
    id: typeof spec.id === "string" ? spec.id : id,
    promptFile,
    hiddenTest: str("hidden_test"),
    description: typeof spec.description === "string" ? spec.description : "",
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


/**
 * Make `work` an empty directory, tolerating a transient Windows lock.
 *
 * Returns the directory actually used, which is `work` unless the old one could not be
 * removed; the caller must seed whichever is returned.
 */
async function resetWorkDir(work: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(work, { recursive: true, force: true });
      await mkdir(work, { recursive: true });
      return work;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") throw e;
      await Bun.sleep(500 * (attempt + 1));
    }
  }
  // Still locked: take a new name so the run proceeds instead of taking the sweep down.
  const fallback = `${work}-${Date.now().toString(36)}`;
  await mkdir(fallback, { recursive: true });
  return fallback;
}
/**
 * The record for a run that never got as far as producing an event stream.
 *
 * It is written to the same place a real run's record goes, so the sweep stays
 * resumable and the failure is visible to the scorer instead of vanishing.
 */
function failedRun(
  task: TaskSpec,
  condition: Condition,
  repeat: number,
  opts: { runsDir: string; model: string },
  reason: string,
): RunRecord {
  return {
    task: task.id,
    condition: condition.id,
    repeat,
    status: "crashed",
    ok: false,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    tool_calls: 0,
    tool_calls_by_name: {},
    turns: 0,
    is_terminal: false,
    seconds: 0,
    exit_code: null,
    tools: condition.tools,
    extension: condition.extension,
    work_dir: join(runDir(opts.runsDir, task.id, condition.id, repeat), "work"),
    events: join(runDir(opts.runsDir, task.id, condition.id, repeat), "events.ndjson"),
    model: opts.model,
    started_at: new Date().toISOString(),
    error: reason,
  };
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
  const eventsPath = join(dir, "events.ndjson");

  // A fresh work dir per run: a repeat must never inherit a previous attempt's edits,
  // and the hidden test is never copied in — only `seed/` is.
  //
  // On Windows a just-finished run can still hold a handle on its work dir, and `rm`
  // fails EBUSY. Retrying briefly clears the common case; if the dir stays locked the
  // run moves to a fresh uniquely-named one rather than aborting. Isolation holds
  // either way, because a new name is a new directory with nothing inherited.
  const work = await resetWorkDir(join(dir, "work"));
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

  // Stream both pipes to disk as they arrive rather than buffering in memory. A run
  // that is killed mid-flight has already spent real tokens, and those events only
  // survive if they were written out before the kill.
  await mkdir(dir, { recursive: true });
  const eventsOut = Bun.file(eventsPath).writer();
  const stderrOut = Bun.file(join(dir, "stderr.log")).writer();
  const decoder = new TextDecoder();
  /** A pipe's decoder, with a latch so a late chunk cannot write to a closed file. */
  interface StreamSink { write(chunk: Uint8Array): void; close(): void }
  const sink = (out: { write(s: string): void; end(): void }): StreamSink => {
    let closed = false;
    return {
      write: (chunk: Uint8Array) => { if (!closed) out.write(decoder.decode(chunk, { stream: true })); },
      close: () => { if (!closed) { closed = true; out.end(); } },
    };
  };
  const outSink = sink(eventsOut);
  const errSink = sink(stderrOut);
  const drain = (stream: ReadableStream<Uint8Array>, s: StreamSink) =>
    (async () => { for await (const chunk of stream) s.write(chunk); })();
  const drains = Promise.all([drain(proc.stdout, outSink), drain(proc.stderr, errSink)]);

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

  // A killed `omp` can leave a `bash` grandchild holding the pipe open, so waiting on
  // the drains unconditionally would let one wedged run stretch the sweep past its cap.
  // Give them a short grace period, then close the files with whatever has landed.
  await Promise.race([drains, Bun.sleep(5000)]);
  outSink.close();
  errSink.close();
  const seconds = (Date.now() - t0) / 1000;

  const stdout = await readFile(eventsPath, "utf8");
  const stderr = await readFile(join(dir, "stderr.log"), "utf8").catch(() => "");
  if (stderr.trim() === "") await rm(join(dir, "stderr.log"), { force: true });

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
    tool_calls_by_name: parsed.toolCallsByName,
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

  // Load and validate every task BEFORE spending a single model call. A task whose
  // spec does not resolve must abort the sweep: running the other tasks and reporting
  // a pass rate would hide a broken fixture behind a healthy-looking number.
  const tasks: TaskSpec[] = [];
  for (const id of taskIds) {
    try {
      tasks.push(await loadTask(opts.tasksDir, id));
    } catch (e) {
      console.error(`runner: ${(e as Error).message}`);
      return 2;
    }
  }

/** Top-level entries of a directory, for spotting writes that escaped the sandbox. */
function topLevel(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

  const records: RunRecord[] = [];
  for (const task of tasks) {
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
        // The sandbox is advisory: the loader is outside every `work/` by placement, but
        // nothing stops an agent writing elsewhere in the tree, and one did — a `.mm`
        // file at the repo root, which a later `mm check .` would collect. Snapshot the
        // top level so a stray is recorded on the run that made it rather than being
        // discovered later as an unexplained file.
        const before = topLevel(MM_ROOT);
        // One run blowing up must not abort the sweep: a long sweep is expected to hit
        // transient failures, and losing every later run to the first exception throws
        // away work that was already paid for. The failure is recorded instead.
        let rec: RunRecord;
        try {
          rec = await runOne({
            task, condition, repeat,
            runsDir: opts.runsDir, model: opts.model, timeout: opts.timeout,
          });
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          rec = failedRun(task, condition, repeat, opts, reason);
          await mkdir(runDir(opts.runsDir, task.id, condition.id, repeat), { recursive: true });
          await writeFile(
            join(runDir(opts.runsDir, task.id, condition.id, repeat), "run.json"),
            JSON.stringify(rec, null, 2) + "\n",
            "utf8",
          );
        }
        const strays = topLevel(MM_ROOT).filter((f) => !before.includes(f));
        if (strays.length > 0) {
          // Recorded, not deleted: a file an agent wrote outside its sandbox is evidence
          // about the agent, and quietly cleaning it up would hide the gap.
          rec.stray_files = strays;
          console.log(`      wrote outside work/: ${strays.join(", ")}`);
        }
        records.push(rec);
        console.log(
          `  ${task.id}/${condition.id}/${repeat}: ${rec.status} ` +
          `in=${rec.input_tokens} out=${rec.output_tokens} tools=${rec.tool_calls} ${rec.seconds}s` +
          (rec.error ? ` — ${rec.error.split("\n")[0]!.slice(0, 160)}` : ""),
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
      condition: r.condition, passed: false, finished: r.ok,
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
