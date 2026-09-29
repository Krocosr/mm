/**
 * MM — the Oh My Pi extension.

/** One tool as OMP sees it. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments. Kept minimal: these are queries, not forms. */
  parameters: Record<string, unknown>;
}

/** A request sent to the daemon. */
export interface DaemonRequest {
  id: number;
  tool: string;
  args?: Record<string, unknown>;
}

export interface DaemonResponse {
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

/** The daemon connection. Injectable so tests and the CLI can supply their own. */
export interface DaemonClient {
  request(req: DaemonRequest): Promise<DaemonResponse>;
}

/**
 * The handles one spawned daemon process exposes.
 *
 * `stdin` and `stdout` must come from the *same* process: the protocol is one JSON
 * object per line in each direction, so writing to a second daemon while reading the
 * first produces a tool that hangs forever and looks merely slow.
 */
export interface DaemonChild {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  /** Register a callback for process exit, so in-flight requests can be failed. */
  onExit?: (cb: () => void) => void;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const REF_PARAM = {
  ref: { type: "string", description: "A symbol id: `module::name`, or a bare name when unambiguous." },
} as const;

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "mm_check",
    description:
      "Type-, effect-, ownership-, and System-IR-check MM source. Returns machine-readable diagnostics with repair suggestions. Prefer this over reading a build log.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mm_symbol",
    description:
      "Resolve one symbol: its content-hash identity, resolved type, effect row, ownership, and outgoing call edges. Replaces grep + read for understanding what something is.",
    parameters: { type: "object", properties: { ...REF_PARAM }, required: ["ref"], additionalProperties: false },
  },
  {
    name: "mm_refs",
    description:
      "Everything that depends on a symbol, directly and transitively. The first thing to ask before changing a shared type.",
    parameters: { type: "object", properties: { ...REF_PARAM }, required: ["ref"], additionalProperties: false },
  },
  {
    name: "mm_type",
    description: "The resolved type and effect set of a symbol, plus its dependencies.",
    parameters: { type: "object", properties: { ...REF_PARAM }, required: ["ref"], additionalProperties: false },
  },
  {
    name: "mm_slice",
    description:
      "A dependency-closed context sized to a token budget, for a stated goal. Returns the affected symbols and the system risk (wire ABI, persistence migration) the change implies. Use instead of reading files to scope a task.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What you are about to do, in one sentence." },
        include: {
          type: "array",
          items: { type: "string" },
          description: "Any of: definitions, affected_calls, wire_abi, tests, resources, decisions.",
        },
        budgetTokens: { type: "number", description: "Token budget for the returned context." },
      },
      required: ["goal"],
      additionalProperties: false,
    },
  },
  {
    name: "mm_packet",
    description:
      "A module as a semantic packet: signatures, effect rows, and call edges, with imports, comments, and unchanged code elided. The compact alternative to reading a module's source.",
    parameters: {
      type: "object",
      properties: { module: { type: "string" } },
      required: ["module"],
      additionalProperties: false,
    },
  },
  {
    name: "mm_system",
    description:
      "The System Plan: what the program synthesizes (wire schemas, resources, decision endpoints) and the authority it requests. Answers 'what would this program be allowed to do?'.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mm_verify",
    description:
      "Check a proposed context is dependency-closed, so the agent knows it is not reasoning from a partial view.",
    parameters: {
      type: "object",
      properties: { hashes: { type: "array", items: { type: "string" } } },
      required: ["hashes"],
      additionalProperties: false,
    },
  },
];

/** Map an OMP tool name onto the daemon's protocol verb. */
const TOOL_TO_VERB: Record<string, string> = {
  mm_check: "mm.diagnostics",
  mm_symbol: "mm.symbol",
  mm_refs: "mm.refs",
  mm_type: "mm.type",
  mm_slice: "mm.slice",
  mm_packet: "mm.packet",
  mm_system: "mm.system",
  mm_verify: "mm.verify",
};

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

/**
 * OMP extension over one daemon.
 *
 * It is a thin, total translation layer: every call either returns the daemon's answer
 * or an error that names what went wrong. Nothing here interprets compiler output, so a
 * new query becomes a new tool by adding one line to the table above.
 */
export class MmExtension {
  private nextId = 1;

  constructor(private readonly client: DaemonClient) {}

  tools(): readonly ToolDefinition[] {
    return TOOLS;
  }

  /** Invoke a tool by its OMP name. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const verb = TOOL_TO_VERB[name];
    if (!verb) {
      return { ok: false, error: `unknown tool \`${name}\``, code: "E0901" };
    }
    const res = await this.client.request({ id: this.nextId++, tool: verb, args });
    if (!res.ok) {
      return { ok: false, error: res.error ?? "query failed", code: res.code };
    }
    return res.data;
  }

  /**
   * The check tool, shaped for an agent loop.
   *
   * A failed check is data, not an exception: the agent needs the code and the repairs to
   * act on, and an exception would turn a normal compile error into a crash.
   */
  async check(): Promise<{ ok: boolean; errors: number; diagnostics: unknown[] }> {
    const res = await this.client.request({ id: this.nextId++, tool: "mm.diagnostics", args: {} });
    if (!res.ok) return { ok: false, errors: 1, diagnostics: [] };
    const data = res.data as Array<{ severity: string }>;
    const errors = data.filter((d) => d.severity === "error").length;
    return { ok: errors === 0, errors, diagnostics: data };
  }
}

// ---------------------------------------------------------------------------
// A client over the daemon's stdio protocol
// ---------------------------------------------------------------------------

/**
 * Line-delimited JSON client for `mmd`.
 *
 * Requests are matched to responses by id, so a caller may have several in flight. The
 * read loop is started once and never torn down: a daemon that dies mid-session costs
 * the agent its whole working set.
 */
export class StdioDaemonClient implements DaemonClient {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (r: DaemonResponse) => void>();
  private child: DaemonChild | null = null;

  /**
   * @param spawn    Creates the daemon process. Called **once**, lazily.
   * @param timeoutMs How long a single request may go unanswered before it is failed.
   */
  constructor(
    private readonly spawn: () => DaemonChild,
    private readonly timeoutMs = 15_000,
  ) {}

  /**
   * Start the daemon on first use and keep the handle.
   *
   * The child is memoized because stdin and stdout must belong to the *same* process.
   * Holding only stdout here and re-invoking `spawn` for stdin in `request` means a
   * factory that creates a new process per call writes requests into a second daemon
   * while reading replies from the first — every request then hangs forever, which
   * looks exactly like a slow tool rather than a transport bug.
   */
  private ensureStarted(): DaemonChild {
    if (this.child) return this.child;
    const child = this.spawn();
    this.child = child;
    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => {
      this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let nl = this.buffer.indexOf("\n");
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line.length > 0) this.dispatch(line);
        nl = this.buffer.indexOf("\n");
      }
    });
    // A daemon that exits takes every in-flight request with it. Failing them here
    // turns a silent hang into a diagnosable error at the call site.
    child.onExit?.(() => this.failAll(`the mm daemon exited while a request was in flight`));
    return child;
  }

  private dispatch(line: string): void {
    let res: DaemonResponse;
    try {
      res = JSON.parse(line) as DaemonResponse;
    } catch {
      // A line we cannot parse carries no id, so nothing is waiting on it. Dropping it
      // is correct: the request that wanted it will hit its own timeout and say so.
      return;
    }
    const resolve = this.pending.get(res.id);
    if (resolve) {
      this.pending.delete(res.id);
      resolve(res);
    }
  }

  /** Fail every request still waiting, with the same reason. */
  private failAll(reason: string): void {
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve({ id, ok: false, error: reason, code: "E0901" });
    }
  }

  async request(req: Omit<DaemonRequest, "id">): Promise<DaemonResponse> {
    const child = this.ensureStarted();
    const id = this.nextId++;
    return new Promise<DaemonResponse>((resolve) => {
      let settled = false;
      const finish = (r: DaemonResponse): void => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        finish({
          id,
          ok: false,
          error: `\`${req.tool}\` did not answer within ${this.timeoutMs}ms (is the mm daemon running?)`,
          code: "E0901",
        });
      }, this.timeoutMs);
      // Deliberately referenced. An unref'd timer does not fire when nothing else keeps
      // the loop alive, which is exactly the situation a timeout exists for: a daemon
      // that went quiet is the only thing left pending. `finish` clears it on every path.
      this.pending.set(id, finish);
      try {
        child.stdin.write(`${JSON.stringify({ ...req, id })}\n`);
      } catch (e) {
        finish({
          id,
          ok: false,
          error: `\`${req.tool}\` could not reach the mm daemon: ${String(e)}`,
          code: "E0901",
        });
      }
    });
  }
}
