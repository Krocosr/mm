/**
 * MM — the Oh My Pi extension.
 *
 * This is the surface an agent actually touches. It exposes the compiler's semantic tools
 * as OMP tools, each backed by one query against `mmd`, so the agent never greps source
 * and never re-derives what a symbol means.
 *
 * The design rule, from the report: **replace textual rediscovery with compiler
 * queries.** Every tool here returns structure — identities, types, effect rows,
 * dependency edges — not text to read. `mm.slice` in particular is the tool that makes
 * the token claim: it returns a dependency-closed context sized to a budget, so the
 * agent asks for what it needs instead of reading the package.
 *
 * The extension does no analysis of its own. It speaks the same protocol as the CLI, so
 * an answer from the agent and an answer from a terminal cannot disagree.
 *
 * See docs/spec/kernel.md §7.
 */

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

  constructor(
    private readonly spawn: () => { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream },
  ) {}

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    const { stdout } = this.spawn();
    stdout.setEncoding?.("utf8");
    stdout.on("data", (chunk: string | Buffer) => {
      this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let nl = this.buffer.indexOf("\n");
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line.length > 0) this.dispatch(line);
        nl = this.buffer.indexOf("\n");
      }
    });
  }

  private started = false;

  private dispatch(line: string): void {
    let res: DaemonResponse;
    try {
      res = JSON.parse(line) as DaemonResponse;
    } catch {
      return; // a line we cannot parse is not answerable; the caller's timeout covers it
    }
    const resolve = this.pending.get(res.id);
    if (resolve) {
      this.pending.delete(res.id);
      resolve(res);
    }
  }

  async request(req: Omit<DaemonRequest, "id">): Promise<DaemonResponse> {
    this.ensureStarted();
    const id = this.nextId++;
    const { stdin } = this.spawn();
    return new Promise<DaemonResponse>((resolve) => {
      this.pending.set(id, resolve);
      stdin.write(`${JSON.stringify({ ...req, id })}\n`);
    });
  }
}
