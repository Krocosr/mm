#!/usr/bin/env bun
/**
 * MM — the compiler daemon.
 *
 * An agent asks questions in a loop; recompiling the package on every question would
 * dominate its latency. `mmd` holds one checked program and its semantic graph in memory
 * and answers queries over newline-delimited JSON on stdio.
 *
 * The protocol is deliberately small: one JSON object per line in, one per line out, and
 * every answer goes through the same `dispatch` the CLI uses, so a daemon answer and a
 * CLI answer can never disagree.
 *
 *   → {"id":1,"tool":"mm.symbol","args":{"ref":"demo::main"}}
 *   ← {"id":1,"ok":true,"data":{…}}
 *
 * See docs/spec/kernel.md §7.
 */

import { watch } from "node:fs";
import { type Session, dispatch, makeSession } from "./query.ts";
import { buildGraph, type SemanticGraph } from "./graph.ts";
import { loadPath } from "./cli.ts";
import { createInterface } from "node:readline";

export interface Request {
  id: number;
  tool: string;
  args?: Record<string, unknown>;
}

export interface Response {
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

/** The mutable state a daemon session carries between requests. */
export class Daemon {
  private target: string;
  private session: Session | null = null;
  private previous: SemanticGraph | null = null;
  /** Revision of the loaded program; every answer reports the one it came from. */
  revision = 0;

  constructor(target: string) {
    this.target = target;
  }

  /** Load, check, and build the graph. Returns the errors found, if any. */
  load(): string[] {
    const program = loadPath(this.target);
    const graph = buildGraph(program);
    this.previous = this.session?.graph ?? null;
    this.session = makeSession(program, graph);
    this.revision += 1;
    return program.errors().map((d) => `${d.code} ${d.message}`);
  }

  private require(): Session {
    if (!this.session) this.load();
    return this.session!;
  }

  handle(req: Request): Response {
    try {
      const s = this.require();
      const r = dispatch(s, req.tool, req.args ?? {}, this.previous ?? undefined);
      if (r.ok) return { id: req.id, ok: true, data: r.data };
      return { id: req.id, ok: false, error: r.error, code: r.code };
    } catch (err) {
      // A malformed request must not take the daemon down: the agent is mid-loop and a
      // dead process means restarting the whole session.
      return { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err), code: "E0901" };
    }
  }

  /** Re-read the target and rebuild, keeping the previous graph for `mm.delta`. */
  reload(): string[] {
    return this.load();
  }

  get root(): string {
    return this.target;
  }
}
/** Read requests from an input stream and write one response line per request. */
export async function serve(
  daemon: Daemon,
  input: NodeJS.ReadableStream,
  out: NodeJS.WritableStream,
): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const write = (res: Response): void => {
    out.write(`${JSON.stringify(res)}\n`);
  };
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let req: Request;
    try {
      req = JSON.parse(trimmed) as Request;
    } catch {
      write({ id: -1, ok: false, error: "malformed JSON request", code: "E0901" });
      continue;
    }
    // `mm.reload` is the daemon's own control verb, not a graph query.
    if (req.tool === "mm.reload") {
      const errors = daemon.reload();
      write({ id: req.id, ok: true, data: { revision: daemon.revision, errors } });
      continue;
    }
    write(daemon.handle(req));
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const target = argv.find((a) => !a.startsWith("-")) ?? ".";
  const daemon = new Daemon(target);
  const errors = daemon.load();
  process.stderr.write(`mmd: watching ${daemon.root} (${errors.length} errors)\n`);

  // The source is watched so a long-lived agent session sees edits without a restart.
  // A failed reload is reported, never fatal: the agent may be mid-edit.
  try {
    watch(target, { recursive: true }, () => {
      const errs = daemon.reload();
      process.stderr.write(`mmd: reloaded (${errs.length} errors)\n`);
    });
  } catch {
    process.stderr.write("mmd: watch unavailable; use `mm.reload` to pick up edits\n");
  }

  // Awaited rather than detached: a floating promise leaves nothing holding the event
  // loop, so the process would exit before answering its first request.
  await serve(daemon, process.stdin, process.stdout);
  return 0;
}

if (import.meta.main) {
  // `main` is async, so its exit code is a promise; passing that to `process.exit`
  // would pass a Promise where a number is required.
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
