/**
 * Unit tests for the harness plumbing.
 *
 * Two things are worth pinning down independently of any model call: that the NDJSON
 * parser reads a real `omp --mode=json` stream the way the contract specifies, and that
 * the aggregation arithmetic cannot quietly flatter a condition. The event stream used
 * here is a genuine capture from `omp v18.4.3`, not a hand-written mock, so a change in
 * the event shape shows up as a failure rather than as a silently zeroed metric.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { aggregate, buildArgv, parseArgs, parseEvents } from "./runner.ts";
import { parseTestResults, verdict } from "./score.ts";

const HARNESS = join(import.meta.dir);
const REAL_EVENTS = join(HARNESS, "selftest", "real-events.ndjson");

/** A minimal event line, so a test can state only the fields it cares about. */
function ev(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

const assistantEnd = (usage: Record<string, number>): string =>
  ev({ type: "message_end", message: { role: "assistant", usage } });

const turnEnd = (usage: Record<string, number>, toolResults: unknown[] = []): string =>
  ev({ type: "turn_end", message: { role: "assistant", usage }, toolResults });

const TOOL_RESULT = { role: "toolResult", toolName: "bash" };

// ---------------------------------------------------------------------------

describe("parseEvents", () => {
  test("sums usage from the last message_end of each turn", () => {
    const stream = [
      // Turn 1 streamed two assistant messages; only the last one's usage counts.
      assistantEnd({ input: 10, output: 1, cacheRead: 100 }),
      assistantEnd({ input: 20, output: 2, cacheRead: 200 }),
      turnEnd({ input: 20, output: 2, cacheRead: 200 }, [TOOL_RESULT]),
      assistantEnd({ input: 5, output: 3, cacheRead: 0 }),
      turnEnd({ input: 5, output: 3, cacheRead: 0 }),
      ev({ type: "agent_end", isTerminal: true }),
    ].join("\n");

    const p = parseEvents(stream);
    expect(p.usage).toEqual({ input: 25, output: 5, cacheRead: 200 });
    expect(p.turns).toBe(2);
    expect(p.toolCalls).toBe(1);
    expect(p.isTerminal).toBe(true);
    expect(p.warnings).toEqual([]);
  });

  test("ignores usage on user and toolResult messages", () => {
    // Only assistant messages are billed to the model; a toolResult carries no usage
    // and counting it would inflate input tokens for a condition that called more tools.
    const stream = [
      ev({ type: "message_end", message: { role: "user", content: [] } }),
      assistantEnd({ input: 7, output: 2, cacheRead: 3 }),
      ev({ type: "message_end", message: { role: "toolResult", toolName: "bash" } }),
      turnEnd({ input: 7, output: 2, cacheRead: 3 }, [TOOL_RESULT]),
      ev({ type: "agent_end", isTerminal: true }),
    ].join("\n");

    expect(parseEvents(stream).usage).toEqual({ input: 7, output: 2, cacheRead: 3 });
  });

  test("counts tool results across every turn", () => {
    const stream = [
      turnEnd({ input: 1, output: 1, cacheRead: 0 }, [TOOL_RESULT, TOOL_RESULT]),
      turnEnd({ input: 1, output: 1, cacheRead: 0 }, [TOOL_RESULT]),
      turnEnd({ input: 1, output: 1, cacheRead: 0 }, []),
      ev({ type: "agent_end", isTerminal: true }),
    ].join("\n");
    expect(parseEvents(stream).toolCalls).toBe(3);
  });

  test("keeps tokens spent by a stream that was cut off before turn_end", () => {
    // A killed run still cost tokens. Reporting zero would make a timeout look free.
    const stream = [assistantEnd({ input: 99, output: 4, cacheRead: 1 })].join("\n");
    const p = parseEvents(stream);
    expect(p.usage).toEqual({ input: 99, output: 4, cacheRead: 1 });
    expect(p.warnings).toContain("stream ended without a closing turn_end");
    expect(p.isTerminal).toBe(false);
  });

  test("a truncated trailing line is a warning, not a crash", () => {
    const stream = [
      assistantEnd({ input: 3, output: 1, cacheRead: 0 }),
      turnEnd({ input: 3, output: 1, cacheRead: 0 }),
      ev({ type: "agent_end", isTerminal: true }),
      '{"type":"message_end","mess',
    ].join("\n");
    const p = parseEvents(stream);
    expect(p.usage.input).toBe(3);
    expect(p.isTerminal).toBe(true);
    expect(p.warnings.some((w) => w.includes("not JSON"))).toBe(true);
  });

  test("an empty stream is all zeros and says so", () => {
    const p = parseEvents("");
    expect(p.usage).toEqual({ input: 0, output: 0, cacheRead: 0 });
    expect(p.toolCalls).toBe(0);
    expect(p.isTerminal).toBe(false);
    expect(p.warnings).toContain("no agent_end event");
  });

  test("missing or non-numeric usage fields count as zero", () => {
    const stream = [
      // No usage object at all on the message, and unusable values on the next.
      ev({ type: "message_end", message: { role: "assistant" } }),
      turnEnd({}, []),
      assistantEnd({ input: "lots", output: "many", cacheRead: null }),
      turnEnd({}, []),
      ev({ type: "agent_end", isTerminal: true }),
    ].join("\n");
    expect(parseEvents(stream).usage).toEqual({ input: 0, output: 0, cacheRead: 0 });
  });

  test("reads a real captured omp event stream", async () => {
    if (!existsSync(REAL_EVENTS)) return; // capture is regenerable; never fail on its absence
    const parsed = parseEvents(await Bun.file(REAL_EVENTS).text());

    // Ground truth read straight off the capture, not off the parser.
    const events = (await Bun.file(REAL_EVENTS).text())
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const turns = events.filter((e) => e.type === "turn_end");
    expect(parsed.turns).toBe(turns.length);
    expect(parsed.toolCalls).toBe(turns.reduce((n, e) => n + e.toolResults.length, 0));
    expect(parsed.usage.input).toBe(
      turns.reduce((n, e) => n + (e.message?.usage?.input ?? 0), 0),
    );
    expect(parsed.usage.output).toBe(
      turns.reduce((n, e) => n + (e.message?.usage?.output ?? 0), 0),
    );
    expect(parsed.isTerminal).toBe(true);
    expect(parsed.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("aggregate", () => {
  const run = (condition: string, passed: boolean, input: number, calls: number, seconds = 10) => ({
    condition, passed, input_tokens: input, output_tokens: 1, tool_calls: calls, seconds,
  });

  test("computes pass rate and mean input tokens per condition", () => {
    const out = aggregate([
      run("baseline", true, 100, 5),
      run("baseline", false, 300, 15),
      run("semantic", true, 50, 2),
      run("semantic", true, 150, 6),
    ]);

    expect(out).toEqual([
      {
        condition: "baseline", runs: 2, finished: 2, passed: 1, pass_rate: 0.5,
        mean_input_tokens: 200, mean_output_tokens: 1,
        mean_tool_calls: 10, mean_seconds: 10,
      },
      {
        condition: "semantic", runs: 2, finished: 2, passed: 2, pass_rate: 1,
        mean_input_tokens: 100, mean_output_tokens: 1,
        mean_tool_calls: 4, mean_seconds: 10,
      },
    ]);
  });

  test("an empty condition cannot claim a perfect score", () => {
    const [s] = aggregate([run("baseline", true, 10, 1)]);
    expect(s!.runs).toBe(1);
    // No semantic runs at all: a naive `passed / max(runs,1)` would invent a rate here.
    expect(aggregate([])).toEqual([]);
  });

  test("a failed run still counts toward the mean, so it cannot look cheap", () => {
    // The failure mode this guards: averaging only over passes would report the cheap
    // failed run's cost nowhere and make a broken condition look efficient.
    const [s] = aggregate([run("semantic", false, 10, 1), run("semantic", true, 90, 9)]);
    expect(s!.mean_input_tokens).toBe(50);
    expect(s!.pass_rate).toBe(0.5);
  });

  test("rounds means to two decimals", () => {
    const out = aggregate([run("baseline", true, 10, 1), run("baseline", true, 11, 1), run("baseline", true, 12, 1)]);
    expect(out[0]!.mean_input_tokens).toBe(11);
    expect(aggregate([run("b", true, 1, 1), run("b", true, 1, 1), run("b", true, 2, 1)])[0]!.mean_input_tokens).toBe(1.33);
  });

  test("orders conditions by name so the report is stable", () => {
    const out = aggregate([run("semantic", true, 1, 1), run("baseline", true, 1, 1), run("alpha", true, 1, 1)]);
    expect(out.map((s) => s.condition)).toEqual(["alpha", "baseline", "semantic"]);
  });
});

// ---------------------------------------------------------------------------

describe("parseTestResults", () => {
  test("splits module from test name and records the verdict", () => {
    const out = parseTestResults(
      "ok   hidden::stats_hidden::max holds\n" +
      "FAIL hidden::stats_hidden::mean truncates\n" +
      "       E0191 assert_eq failed: left is 1, right is 2\n" +
      "ok   stats::seed test\n",
    );
    expect(out).toEqual([
      { module: "hidden", name: "stats_hidden::max holds", passed: true },
      { module: "hidden", name: "stats_hidden::mean truncates", passed: false },
      { module: "stats", name: "seed test", passed: true },
    ]);
  });

  test("ignores diagnostics and non-result lines", () => {
    expect(parseTestResults("no tests\nmm: 1 error\nE0191 assert_eq failed\n")).toEqual([]);
  });
});

describe("verdict", () => {
  const r = (module: string, passed: boolean) => ({ module, passed });

  test("passes only when every hidden test passed", () => {
    expect(verdict([r("hidden", true), r("hidden", true)], ["hidden"]))
      .toMatchObject({ passed: true, total: 2, failed: 0 });
  });

  test("fails when any hidden test failed", () => {
    const v = verdict([r("hidden", true), r("hidden", false)], ["hidden"]);
    expect(v.passed).toBe(false);
    expect(v.failed).toBe(1);
    expect(v.reason).toContain("1 of 2");
  });

  test("ignores the agent's own tests", () => {
    // The agent may have edited or added its own tests; they must not vote on the grade.
    const v = verdict([r("hidden", true), r("stats", false), r("stats", false)], ["hidden"]);
    expect(v.passed).toBe(true);
    expect(v.total).toBe(1);
  });

  test("zero reported hidden tests is a failure, not a pass", () => {
    const v = verdict([r("stats", true)], ["hidden"]);
    expect(v.passed).toBe(false);
    expect(v.reason).toContain("no hidden tests");
  });
});

// ---------------------------------------------------------------------------

const CONDITIONS = JSON.parse(await Bun.file(join(HARNESS, "conditions.json")).text()) as {
  conditions: { id: string; tools: string; extension: string | null }[];
};
const CONDITION_BY_ID = Object.fromEntries(CONDITIONS.conditions.map((c) => [c.id, c]));

describe("the two conditions differ in tool set and nothing else", () => {
  const byId = CONDITION_BY_ID;

  test("conditions.json declares exactly baseline and semantic", () => {
    expect(Object.keys(byId).sort()).toEqual(["baseline", "semantic"]);
  });

  test("baseline gets the text tools, including grep", () => {
    expect(byId.baseline!.tools.split(",")).toEqual(["read", "grep", "bash", "edit", "write"]);
    expect(byId.baseline!.extension).toBeNull();
  });

  test("semantic gets the mm tools and no grep", () => {
    const tools = byId.semantic!.tools.split(",");
    expect(tools).toContain("mm_check");
    expect(tools).toContain("mm_slice");
    expect(tools).not.toContain("grep");
    expect(byId.semantic!.extension).not.toBeNull();
  });

  test("buildArgv differs between conditions only in --tools and -e", () => {
    const common = { prompt: "fix it", model: "m", cwd: "C:/w" };
    const base = buildArgv({ ...common, tools: byId.baseline!.tools, extension: null });
    const sem = buildArgv({ ...common, tools: byId.semantic!.tools, extension: byId.semantic!.extension });

    expect(base).not.toEqual(sem);
    // Everything except the tool set and the extension flag must be byte-identical, or
    // the experiment is measuring the difference between the prompts instead.
    const strip = (argv: string[]) => argv.filter((a) => !a.startsWith("--tools=") && a !== "-e");
    expect(strip(sem).filter((a) => a !== byId.semantic!.extension)).toEqual(strip(base));
    expect(base).toContain("--tools=read,grep,bash,edit,write");
    expect(sem).toContain("-e");
  });

  test("buildArgv always disables sessions and asks for the json stream", () => {
    const argv = buildArgv({ prompt: "p", model: "m", cwd: "C:/w", tools: "read", extension: null });
    expect(argv).toContain("--no-session");
    expect(argv).toContain("--mode=json");
    expect(argv).toEqual(expect.arrayContaining(["-p", "p"]));
  });
});

describe("parseArgs", () => {
  test("parses the documented invocation", () => {
    const o = parseArgs(["--tasks", "a,b", "--conditions", "baseline,semantic", "--repeats", "2", "--timeout", "600"]);
    expect(o).toMatchObject({
      tasks: ["a", "b"],
      conditions: ["baseline", "semantic"],
      repeats: 2,
      timeout: 600,
    });
  });

  test("returns help without touching the filesystem", () => {
    expect(parseArgs(["--help"])).toEqual({ help: true });
  });

  test("rejects an unknown option and a missing value", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown option/);
    expect(() => parseArgs(["--repeats"])).toThrow(/needs a value/);
  });

  test("a nonsensical count falls back to a runnable value", () => {
    expect(parseArgs(["--repeats", "0"])).toMatchObject({ repeats: 1 });
    expect(parseArgs(["--repeats", "abc"])).toMatchObject({ repeats: 1 });
  });
});
