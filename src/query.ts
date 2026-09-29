/**
 * MM — the query layer.
 *
 * This is the compiler's actual product surface. An agent should not read source text and
 * re-derive meaning; it should ask the graph. Every function here is pure and
 * JSON-serializable, so the same queries serve the CLI, the `mmd` daemon, and an editor
 * extension without any of them re-implementing resolution.
 *
 * The tools map one-to-one onto the report's "Compiler-native agent tools" table.
 *
 * See docs/spec/kernel.md §7.
 */

import type { Diagnostic } from "./ast.ts";
import { type Program, type FnInfo } from "./program.ts";
import { type SemanticGraph, type SemanticNode, buildGraph } from "./graph.ts";
import { renderPacket, renderSymbolPacket, renderDelta, resolveRef } from "./packet.ts";
import { type Slice, type SliceRequest, buildSlice, renderSlice } from "./slice.ts";
import { type SystemPlan } from "./system.ts";
import { renderTy } from "./types.ts";

/** A loaded program plus the graph and plan derived from it. */
export interface Session {
  readonly program: Program;
  readonly graph: SemanticGraph;
  readonly system: SystemPlan | null;
  /** Diagnostics from every pass, errors and warnings alike. */
  readonly diagnostics: readonly Diagnostic[];
}

export type QueryResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; code?: string };

const fail = (error: string, code = "E0901"): QueryResult => ({ ok: false, error, code });
const done = (data: unknown): QueryResult => ({ ok: true, data });

// ---------------------------------------------------------------------------
// The queries
// ---------------------------------------------------------------------------

/**
 * Resolve one symbol and everything an agent needs to work on it.
 *
 * Returns the node's identity, signature, effects, and outgoing edges — the packet
 * projection, which is the whole point: the agent gets semantics, not text.
 */
export function querySymbol(s: Session, ref: string): QueryResult {
  const node = resolveRef(s.graph, ref);
  if (!node) return fail(`no symbol matches \`${ref}\``, "E0203");
  return done({
    node: describeNode(s, node),
    packet: renderSymbolPacket(s.graph, node.sourceId),
    references: s.graph.refsTo(node.hash).map((n) => describeNode(s, n)),
    referencedBy: s.graph.refsTo(node.hash).length,
  });
}

/** Everything that depends on a symbol — the callers, the wire ABI, the tests. */
export function queryRefs(s: Session, ref: string): QueryResult {
  const node = resolveRef(s.graph, ref);
  if (!node) return fail(`no symbol matches \`${ref}\``, "E0203");
  const direct = s.graph.refsTo(node.hash);
  const transitive = s.graph.reach([node.hash], 2);
  return done({
    symbol: describeNode(s, node),
    direct: direct.map((n) => describeNode(s, n)),
    transitive: [...transitive]
      .filter((h) => h !== node.hash)
      .map((h) => s.graph.byHash(h))
      .filter((n): n is SemanticNode => n !== undefined)
      .map((n) => describeNode(s, n)),
  });
}

/** The resolved type and effect set of a symbol, rendered for a model to read. */
export function queryType(s: Session, ref: string): QueryResult {
  const node = resolveRef(s.graph, ref);
  if (!node) return fail(`no symbol matches \`${ref}\``, "E0203");
  const defName = (id: number): string | null => s.program.typeInfo.get(id)?.name ?? null;
  return done({
    symbol: node.sourceId,
    type: node.renderedType || null,
    effects: [...node.effectSet].sort(),
    ownership: node.ownership,
    attributes: [...node.attributes].sort(),
    dependencies: s.graph.refsFrom(node.hash).map((n) => n.sourceId),
  });
}

/**
 * A dependency-closed context for a bounded task.
 *
 * This is the token-efficiency claim made executable: the caller states a goal and a
 * budget, and gets the smallest set of symbols that is closed under dependencies and
 * carries the system risk the edit implies.
 */
export function querySlice(s: Session, request: SliceRequest): QueryResult {
  const slice: Slice = buildSlice(s.graph, request);
  return done({
    sliceId: slice.id,
    symbols: slice.entries.length,
    files: slice.files.length,
    estimatedTokens: slice.estimatedTokens,
    closed: slice.dependencyClosed,
    overBudget: slice.overBudget,
    systemRisk: slice.systemRisk,
    text: renderSlice(slice, s.graph),
  });
}

/** A whole module as a semantic packet. */
export function queryPacket(s: Session, module: string): QueryResult {
  return done(renderPacket(s.graph, { ...(module ? { module } : {}), nodes: [] }));
}

/** The change between two compilations, as semantic operations rather than line diffs. */
export function queryDelta(prev: SemanticGraph, next: SemanticGraph): QueryResult {
  return done(renderDelta(prev, next));
}

/** Diagnostics, in the canonical machine form the spec requires. */
export function queryDiagnostics(s: Session, opts: { includeWarnings?: boolean } = {}): QueryResult {
  const includeWarnings = opts.includeWarnings ?? true;
  return done(
    s.diagnostics
      .filter((d) => includeWarnings || d.severity === "error")
      .map((d) => ({
        code: d.code,
        kind: d.kind,
        severity: d.severity,
        message: d.message,
        file: fileOf(s, d),
        repairs: (d.repairs ?? []).map((r) => r.op),
      })),
  );
}

/** The System Plan: what the program synthesizes and what authority it requests. */
export function querySystem(s: Session): QueryResult {
  if (!s.system) return done({ entries: [], requested: [], entryPoints: [] });
  return done({
    entries: s.system.entries.map((e) => ({
      kind: e.kind,
      source: e.source,
      schemaVersion: e.schemaVersion,
      effects: [...e.effects],
      synthesized: e.synthesized,
    })),
    requested: [...s.system.requested],
    entryPoints: s.system.entryPoints.map((e) => `${e.kind} ${e.source}`),
  });
}

/** Dependency-closure check: is a selected set self-sufficient? */
export function queryVerify(s: Session, hashes: readonly string[]): QueryResult {
  const selected = new Set(hashes);
  const missing: Array<{ from: string; needs: string }> = [];
  for (const h of selected) {
    for (const dep of s.graph.refsFrom(h)) {
      if (!selected.has(dep.hash)) {
        missing.push({ from: s.graph.byHash(h)?.sourceId ?? h, needs: dep.sourceId });
      }
    }
  }
  return done({
    closed: missing.length === 0,
    selected: selected.size,
    missing,
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A graph node as a plain object, with no references the caller cannot serialize. */
function describeNode(s: Session, n: SemanticNode): Record<string, unknown> {
  return {
    hash: n.hash,
    sourceId: n.sourceId,
    alias: n.alias,
    kind: n.kind,
    type: n.renderedType || null,
    effects: [...n.effectSet].sort(),
    ownership: n.ownership,
    attributes: [...n.attributes].sort(),
    revision: n.revision,
  };
}

function fileOf(s: Session, d: Diagnostic): string {
  return s.program.files[d.span.file]?.module ?? "<unknown>";
}

/** A function's full annotation, for tools that already resolved an id. */
export function describeFn(program: Program, info: FnInfo): Record<string, unknown> {
  const defName = (id: number): string | null => program.typeInfo.get(id)?.name ?? null;
  return {
    name: `${info.module}::${info.name}`,
    parameters: info.fn.params.map((p, i) => ({
      name: p.name,
      type: renderTy(info.paramTys[i] ?? { k: "err" }, defName),
      ownership: p.ownership,
    })),
    returns: renderTy(info.retTy, defName),
    effects: [...info.effects].sort(),
    declaredEffects: info.declaredEffects ? [...info.declaredEffects] : null,
    attributes: [...info.attrs].sort(),
    visibility: info.visibility,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * The single entry point the daemon and the OMP extension call.
 *
 * Keeping one dispatcher means a tool name means the same thing everywhere, and adding a
 * tool cannot leave the CLI and the extension disagreeing about what it does.
 */
export function dispatch(
  s: Session,
  tool: string,
  args: Record<string, unknown>,
  prev?: SemanticGraph,
): QueryResult {
  const str = (k: string): string => {
    const v = args[k];
    return typeof v === "string" ? v : "";
  };
  switch (tool) {
    case "mm.symbol": return querySymbol(s, str("ref"));
    case "mm.refs": return queryRefs(s, str("ref"));
    case "mm.type": return queryType(s, str("ref"));
    case "mm.slice": return querySlice(s, args as unknown as SliceRequest);
    case "mm.packet": return queryPacket(s, str("module"));
    case "mm.diagnostics": return queryDiagnostics(s);
    case "mm.system": return querySystem(s);
    case "mm.verify": return queryVerify(s, Array.isArray(args.hashes) ? (args.hashes as string[]) : []);
    case "mm.delta": {
      if (!prev) return fail("mm.delta needs the previous graph");
      return queryDelta(prev, s.graph);
    }
    default:
      return fail(`unknown tool \`${tool}\``, "E0901");
  }
}

/** Build a session from a program and its graph. */
export function makeSession(program: Program, graph?: SemanticGraph, system: SystemPlan | null = null): Session {
  return {
    program,
    graph: graph ?? buildGraph(program),
    system,
    diagnostics: program.diagnostics,
  };
}
