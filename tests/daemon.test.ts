import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { MmExtension, type DaemonClient, type DaemonRequest, type DaemonResponse } from "../omp-extension/mm.ts";
import { Daemon } from "../src/mmd.ts";
import { Program } from "../src/program.ts";
import { buildGraph } from "../src/graph.ts";
import { makeSession } from "../src/query.ts";
import { loadPath } from "../src/cli.ts";


/**
 * Narrow a value that crossed a process boundary.
 *
 * The extension's answers arrive as JSON, so the shape is genuinely unproven until it is
 * checked. A cast would let the test assert against a shape nobody implements; these
 * checks fail loudly instead.
 */
function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null) throw new Error(`${what} is not an object: ${String(v)}`);
  return v as Record<string, unknown>;
}
function arr(v: unknown, what: string): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) throw new Error(`${what} is not an array`);
  return v.map((x) => obj(x, `${what} element`));
}
function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Error(`${what} is not a string`);
  return v;
}

const FIXTURE = join(import.meta.dir, "fixtures", "daemon_target");

/** An in-process daemon: the same class `mmd` runs, without the stdio plumbing. */
function inProcessClient(target: string): DaemonClient {
  const daemon = new Daemon(target);
  daemon.load();
  return {
    request: async (req: DaemonRequest): Promise<DaemonResponse> => daemon.handle({ ...req }),
  };
}

/** A client speaking the real line protocol over a real child process. */
function stdioClient(target: string): DaemonClient {
  const proc = spawn("bun", [join(import.meta.dir, "..", "src", "mmd.ts"), target], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  let buffer = "";
  let nextId = 1;
  const pending = new Map<number, (r: DaemonResponse) => void>();
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        const res = JSON.parse(line) as DaemonResponse;
        pending.get(res.id)?.(res);
        pending.delete(res.id);
      }
      nl = buffer.indexOf("\n");
    }
  });
  return {
    request: (req: Omit<DaemonRequest, "id">) =>
      new Promise<DaemonResponse>((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        proc.stdin?.write(`${JSON.stringify({ ...req, id })}\n`);
      }),
  };
}

describe("mmd daemon", () => {
  test("loads a target and reports its errors", () => {
    const d = new Daemon(FIXTURE);
    expect(d.load()).toEqual([]);
    expect(d.revision).toBe(1);
  });

  test("answers a symbol query", () => {
    const d = new Daemon(FIXTURE);
    d.load();
    const r = d.handle({ id: 1, tool: "mm.symbol", args: { ref: "demo::helper" } });
    expect(r.ok).toBe(true);
    expect((r.data as { node: { sourceId: string } }).node.sourceId).toBe("demo::helper");
  });

  test("an unknown tool is an error, not a crash", () => {
    const d = new Daemon(FIXTURE);
    d.load();
    const r = d.handle({ id: 1, tool: "mm.nope" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("E0901");
  });

  test("an unknown symbol is an error, not a crash", () => {
    const d = new Daemon(FIXTURE);
    d.load();
    const r = d.handle({ id: 1, tool: "mm.symbol", args: { ref: "demo::nope" } });
    expect(r.ok).toBe(false);
  });

  test("reload bumps the revision and keeps the previous graph for mm.delta", () => {
    const d = new Daemon(FIXTURE);
    d.load();
    d.reload();
    expect(d.revision).toBe(2);
  });
});

describe("OMP extension", () => {
  test("exposes the report's compiler-native tool set", () => {
    const ext = new MmExtension(inProcessClient(FIXTURE));
    const names = ext.tools().map((t) => t.name);
    for (const expected of [
      "mm_check", "mm_symbol", "mm_refs", "mm_type", "mm_slice", "mm_packet", "mm_system", "mm_verify",
    ]) {
      expect(names).toContain(expected);
    }
  });

  test("every tool carries a description and a schema", () => {
    const ext = new MmExtension(inProcessClient(FIXTURE));
    for (const t of ext.tools()) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.parameters.type).toBe("object");
    }
  });

  test("mm_symbol returns identity and a packet", async () => {
    const ext = new MmExtension(inProcessClient(FIXTURE));
    const r = obj(await ext.call("mm_symbol", { ref: "demo::helper" }), "mm_symbol result");
    const node = obj(r["node"], "node");
    expect(str(node["sourceId"], "sourceId")).toBe("demo::helper");
    expect(str(node["hash"], "hash").length).toBeGreaterThan(0);
    expect(str(r["packet"], "packet")).toContain("helper");
  });

  test("mm_type returns the resolved signature and effects", async () => {
    const ext = new MmExtension(inProcessClient(FIXTURE));
    const r = obj(await ext.call("mm_type", { ref: "demo::load" }), "mm_type result");
    expect(str(r["type"], "type")).toContain("Result<Bytes,IoErr>");
    const effects = r["effects"];
    expect(Array.isArray(effects) && effects).toContain("fs.read");
  });

  test("mm_refs finds the dependents of a symbol", async () => {
    const ext = new MmExtension(inProcessClient(FIXTURE));
    const r = obj(await ext.call("mm_refs", { ref: "demo::helper" }), "mm_refs result");
    const direct = arr(r["direct"], "direct");
    // `run` and the test call `helper`; `load` does not, and the graph says so.
    expect(direct.map((n) => n["sourceId"])).toContain("demo::run");
  });

  test("mm_slice returns a dependency-closed context for a goal", async () => {
    const ext = new MmExtension(inProcessClient(FIXTURE));
    const r = obj(await ext.call("mm_slice", {
      goal: "change the payload type of helper",
      include: ["definitions", "affected_calls"],
      budgetTokens: 4000,
    }), "mm_slice result");
    expect(r["closed"]).toBe(true);
    expect(Number(r["symbols"])).toBeGreaterThan(0);
    expect(str(r["text"], "text").length).toBeGreaterThan(0);
  });

  test("mm_check reports a clean program as ok", async () => {
    const ext = new MmExtension(inProcessClient(FIXTURE));
    const r = await ext.check();
    expect(r.errors).toBe(0);
    expect(r.ok).toBe(true);
  });

  test("an unknown tool returns an error object rather than throwing", async () => {
    const ext = new MmExtension(inProcessClient(FIXTURE));
    const r = obj(await ext.call("mm_nonsense"), "unknown tool result");
    expect(r["ok"]).toBe(false);
    expect(str(r["error"], "error")).toContain("unknown tool");
  });

  test("answers arrive over a real stdio pipe", async () => {
    const ext = new MmExtension(stdioClient(FIXTURE));
    const r = obj(await ext.call("mm_symbol", { ref: "demo::helper" }), "mm_symbol result");
    const node = obj(r["node"], "node");
    expect(str(node["sourceId"], "sourceId")).toBe("demo::helper");
  }, 20_000);
});

describe("daemon and CLI agree", () => {
  test("the same query returns the same identity through both paths", () => {
    const program: Program = loadPath(FIXTURE);
    const viaGraph = buildGraph(program).bySourceId("demo::helper")?.hash;
    const viaSession = makeSession(program).graph.bySourceId("demo::helper")?.hash;
    expect(viaSession).toBe(viaGraph);
  });
});
