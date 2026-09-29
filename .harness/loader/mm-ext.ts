/**
 * The OMP-loadable adapter for the MM semantic tools.
 *
 * `omp-extension/mm.ts` is the library: it exports a `TOOLS` table and an
 * `MmExtension` class, and it has no default export. OMP loads an extension by
 * importing the module and taking `module.default` (or the module itself, if it is
 * callable) as a factory — so that file cannot be passed to `-e` as it stands. This
 * adapter is the loadable shell around it: it default-exports the factory, spawns one
 * `mmd` per working directory, and forwards each call to the daemon verb the library
 * already maps.
 *
 * It lives at `.harness/loader/`, deliberately outside every run's `work/` directory.
 * That is a validity requirement, not tidiness: the agent under test must not be able
 * to edit the tool it is being measured on.
 *
 * Two things the library does not do are done here:
 *
 *  - The daemon is spawned LAZILY, on the first tool call, never at module scope. OMP
 *    throws `ExtensionRuntimeNotInitializedError` if runtime actions are called while
 *    the extension is loading.
 *  - Every request carries a timeout. Without one, a daemon that dies mid-session
 *    leaves a pending promise that never settles, and the agent's whole turn hangs
 *    until the harness kills the run — which reads as a slow model, not a dead pipe.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { MmExtension, TOOLS } from "../../omp-extension/mm.ts";

const REQUEST_TIMEOUT_MS = 60_000;

/** The daemon this adapter drives, resolved relative to the harness, not the cwd. */
const MMD = join(import.meta.dir, "..", "..", "src", "mmd.ts");

interface DaemonResponse {
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

/**
 * The daemon child. stderr is `ignore`d, because stdout is the NDJSON channel and a
 * banner written there would corrupt the protocol.
 */
type DaemonChild = ChildProcessByStdio<Writable, Readable, null>;

/**
 * One `mmd` child, plus the request table that pairs answers with callers.
 *
 * Requests are matched by id, so several may be in flight. A daemon that exits takes
 * the in-flight entries with it: they are rejected rather than left pending, so the
 * agent gets an error to act on instead of a hang.
 */
class Daemon {
  private proc: DaemonChild | null = null;
  private buffer = "";
  private nextId = 1;
  /** Settles one in-flight request, with an answer or with the reason there is none. */
  private readonly pending = new Map<number, (r: DaemonResponse | Error) => void>();

  constructor(private readonly target: string) {}

  private start(): DaemonChild {
    if (this.proc) return this.proc;
    // `spawn` from node:child_process, not `Bun.spawn`: the daemon reader needs
    // `.on("data")`, and Bun's `stdout` is a web ReadableStream without it.
    const proc = spawn("bun", [MMD, this.target], { stdio: ["pipe", "pipe", "ignore"] });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl = this.buffer.indexOf("\n");
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line !== "") this.dispatch(line);
        nl = this.buffer.indexOf("\n");
      }
    });
    proc.on("exit", () => this.failAll("the mm daemon exited"));
    proc.on("error", (e) => this.failAll(`the mm daemon failed to start: ${e.message}`));
    this.proc = proc;
    return proc;
  }

  private failAll(reason: string): void {
    for (const [, reject] of this.pending) reject(new Error(reason));
    this.pending.clear();
  }

  private dispatch(line: string): void {
    let res: DaemonResponse;
    try {
      res = JSON.parse(line) as DaemonResponse;
    } catch {
      return; // a line we cannot parse is not answerable; the caller's timeout covers it
    }
    const settle = this.pending.get(res.id);
    if (!settle) return;
    this.pending.delete(res.id);
    settle(res);
  }

  request(tool: string, args: Record<string, unknown>): Promise<DaemonResponse> {
    const proc = this.start();
    return new Promise<DaemonResponse>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`\`${tool}\` timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        // The daemon can settle a request with an Error (it exited, or was shut down).
        if (r instanceof Error) reject(r);
        else resolve(r);
      });
      proc.stdin.write(`${JSON.stringify({ id, tool, args })}\n`);
    });
  }

  kill(): void {
    this.failAll("the mm daemon was shut down");
    this.proc?.kill();
    this.proc = null;
  }
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

export default function (pi: ExtensionAPI) {
  const z = pi.zod;
  // One daemon and one MmExtension per working directory, both created on first use
  // and never at load time.
  const live = new Map<string, { ext: MmExtension; daemon: Daemon }>();
  const sessionFor = (cwd: string): { ext: MmExtension; daemon: Daemon } => {
    let s = live.get(cwd);
    if (!s) {
      const daemon = new Daemon(cwd);
      // The library owns the tool-name -> daemon-verb mapping; this adapter supplies
      // only a transport, so the two can never drift apart.
      const ext = new MmExtension({ request: (req) => daemon.request(req.tool, req.args ?? {}) });
      s = { ext, daemon };
      live.set(cwd, s);
    }
    return s;
  };

  const call = async (
    name: string,
    args: Record<string, unknown>,
    cwd: string,
  ): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, never> }> => {
    try {
      const res: unknown = await sessionFor(cwd).ext.call(name, args);
      if (typeof res === "string") return text(res);
      // MmExtension reports a failed query as data, so narrow rather than cast.
      if (typeof res === "object" && res !== null && "ok" in res && res.ok === false) {
        const detail = "error" in res && typeof res.error === "string" ? res.error : "query failed";
        const code = "code" in res && typeof res.code === "string" ? res.code : "E0901";
        return text(`${name} failed [${code}]: ${detail}`);
      }
      return text(JSON.stringify(res, null, 2));
    } catch (e) {
      // A dead daemon is data, not a crash: the agent needs to see it and keep working.
      return text(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const ref = z.object({ ref: z.string().describe("A symbol id: `module::name`, or a bare name when unambiguous.") });

  for (const tool of TOOLS) {
    const name = tool.name;
    // Parameters are declared per tool so the model sees a real schema; the executor is
    // shared because every verb takes its arguments as one object.
    const parameters =
      name === "mm_check" || name === "mm_system" ? z.object({}) :
      name === "mm_symbol" || name === "mm_refs" || name === "mm_type" ? ref :
      name === "mm_slice"
        ? z.object({
            goal: z.string().describe("What you are about to do, in one sentence."),
            include: z.array(z.string()).optional().describe("Any of: definitions, affected_calls, wire_abi, tests, resources, decisions."),
            budgetTokens: z.number().optional().describe("Token budget for the returned context."),
          })
        : name === "mm_packet" ? z.object({ module: z.string() })
        : z.object({ hashes: z.array(z.string()) });

    pi.registerTool({
      name,
      label: name,
      description: tool.description,
      parameters,
      // These answer questions about the program; none of them mutate it.
      approval: "read",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        return call(name, params as Record<string, unknown>, ctx.cwd);
      },
    });
  }

  // The daemon holds a checked program in memory; leaving it running past the session
  // would strand a process per run, and a long sweep opens hundreds.
  pi.on("session_shutdown", () => {
    for (const s of live.values()) s.daemon.kill();
    live.clear();
  });
}
