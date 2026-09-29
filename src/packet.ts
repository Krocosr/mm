/**
 * MM — the LLM projection of the semantic graph (kernel.md §7.3).
 *
 * A packet is what an agent actually reads. It is not source text with holes in it:
 * every line is a resolved fact.
 *
 *   Never emitted: keywords that carry no information, imports, comments, unchanged
 *                  neighbouring statements, prose diagnostics, tool logs.
 *   Always emitted: the resolved type, the effect set, the ownership of every parameter,
 *                   and the outgoing dependency edges.
 *
 * Deltas (`Δ F27/b3`) are the default edit representation; line patches are not.
 */

import type { NodeKind, SemanticGraph, SemanticNode } from "./graph.ts";
import { ALIAS_PREFIX, contentHash } from "./graph.ts";

/**
 * A **character-count proxy only**.
 *
 * It is not a tokenizer and must never be reported as evidence of token savings:
 * tokenization is encoding- and model-dependent (kernel.md §7.3), so a real claim
 * requires counting against the actual tokenizer. Every `budgetTokens` in this codebase
 * is a proxy for *ordering and budgeting decisions*, never a measured saving.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface PacketOptions {
  /** Restrict the packet to one module. Omit to project every module in the graph. */
  readonly module?: string;
  /** Nodes to project: content hashes or `module::name` ids. */
  readonly nodes: readonly string[];
  /**
   * Optional proxy budget. Nodes are emitted in the order given and lines past the
   * budget are dropped, so the highest-priority symbols are the ones that survive.
   */
  readonly budgetTokens?: number;
}

/** Stable short id for a module: a content hash of its path, never a line number. */
export function moduleId(module: string): string {
  return contentHash(`module:${module}`);
}

/** Resolve a node reference (hash or `module::name`) to a node. */
export function resolveRef(graph: SemanticGraph, ref: string): SemanticNode | undefined {
  return graph.byHash(ref) ?? graph.bySourceId(ref);
}

/**
 * Render a packet for the given nodes. Deterministic, apart from assigning the
 * session-local aliases on first touch — which is the documented behaviour of `alias`.
 */
export function renderPacket(graph: SemanticGraph, options: PacketOptions): string {
  const nodes = options.nodes
    .map((r) => resolveRef(graph, r))
    .filter((n): n is SemanticNode => n !== undefined)
    .filter((n) => options.module === undefined || n.module === options.module);
  const modules = [...new Set(nodes.map((n) => n.module))].sort();
  const lines: string[] = [];
  for (const m of modules) {
    lines.push(`M ${m}#${moduleId(m)} rev=${moduleRevision(graph, m)}`);
    lines.push("");
    for (const n of nodes.filter((x) => x.module === m)) lines.push(...renderNode(graph, n));
    lines.push("");
  }
  const text = lines.join("\n").replace(/\n+$/, "\n");
  return options.budgetTokens === undefined ? text : truncateToProxyBudget(lines, options.budgetTokens);
}

/** The highest revision in a module: the version stamp an agent compares against. */
function moduleRevision(graph: SemanticGraph, module: string): number {
  return graph
    .byKind("type")
    .concat(graph.byKind("fn"), graph.byKind("test"), graph.byKind("const"))
    .filter((n) => n.module === module)
    .reduce((acc, n) => Math.max(acc, n.revision), 0);
}

function truncateToProxyBudget(lines: readonly string[], budgetTokens: number): string {
  const out: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const line of lines) {
    const cost = estimateTokens(`${line}\n`);
    if (used + cost > budgetTokens && out.length > 0) {
      dropped++;
      continue;
    }
    out.push(line);
    used += cost;
  }
  if (dropped > 0) out.push(`… ${dropped} lines dropped by the proxy budget`);
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Node rendering
// ---------------------------------------------------------------------------

function aliasOf(graph: SemanticGraph, node: SemanticNode): string {
  return graph.alias(node.hash) ?? `${ALIAS_PREFIX[node.kind]}${node.hash}`;
}

function aliasForHash(graph: SemanticGraph, hash: string): string {
  const node = graph.byHash(hash);
  return node === undefined ? hash : aliasOf(graph, node);
}

/** Direct children (fields, variants, parameters, locals) in source order. */
function childrenOf(graph: SemanticGraph, node: SemanticNode): SemanticNode[] {
  return [...graph.nodes.values()].filter((n) => n.parent === node.hash);
}

/** `User.id` / `Shape.Circle` — the readable path, never a line number. */
function renderedPath(node: SemanticNode): string {
  const parts = node.sourceId.split("::");
  return parts.slice(1).join(".").replace(/^[a-z]+:/, "");
}

function renderNode(graph: SemanticGraph, node: SemanticNode): string[] {
  const alias = aliasOf(graph, node);
  switch (node.kind) {
    case "type": return renderType(graph, node);
    case "fn": return renderFn(graph, node);
    case "test": return renderTest(graph, node);
    case "field": return [`${alias} ${renderedPath(node)}:${node.renderedType} ${node.ownership}`];
    case "variant": return [`${alias} ${renderedPath(node)}`];
    case "local": return [`  ${node.name}:${node.renderedType} ${node.ownership}`];
    case "param": return [`  ${node.name}:${node.renderedType} ${node.ownership}`];
    case "const": return [`${alias} ${node.name}:${node.renderedType || "?"} const`];
    case "trait": return [`${alias} trait ${node.name}`];
    case "impl": return [`${alias} impl ${node.name}`];
  }
}

function renderType(graph: SemanticGraph, node: SemanticNode): string[] {
  const head = `${aliasOf(graph, node)} ${node.name}`;
  const kids = childrenOf(graph, node);
  if (kids.length === 0) return [`${head}=${node.renderedType}`];
  const variants = kids.filter((k) => k.kind === "variant");
  const body = variants.length > 0
    ? variants
      .map((v) => {
        const fields = childrenOf(graph, v);
        return fields.length === 0
          ? v.name
          : `${v.name}{${fields.map((f) => `${f.name}:${f.renderedType}`).join(",")}}`;
      })
      .join("|")
    : `{${kids.filter((k) => k.kind === "field")
      .map((f) => `${f.name}:${f.renderedType}`)
      .join(",")}}`;
  const out = [`${head}=${body}`];
  if (node.attributes.length > 0) out.push(`  @${node.attributes.join(" @")}`);
  return out;
}

function renderFn(graph: SemanticGraph, node: SemanticNode): string[] {
  const kids = childrenOf(graph, node);
  const params = kids.filter((c) => c.kind === "param");
  const locals = kids.filter((c) => c.kind === "local");
  const out = [`${aliasOf(graph, node)} ${node.name} ${node.renderedType}`];
  if (node.attributes.length > 0) out.push(`  @${node.attributes.join(" @")}`);
  if (node.effectSet.length > 0) out.push(`  !{${node.effectSet.join(",")}}`);
  const calls = node.depEdges.filter((e) => e.role === "call").map((e) => aliasForHash(graph, e.hash));
  if (calls.length > 0) out.push(`  calls ${calls.join(",")}`);
  const types = node.depEdges.filter((e) => e.role === "type").map((e) => aliasForHash(graph, e.hash));
  if (types.length > 0) out.push(`  of ${types.join(",")}`);
  const tests = graph.refsTo(node.hash).filter((t) => t.kind === "test");
  if (tests.length > 0) out.push(`  test ${tests.map((t) => aliasForHash(graph, t.hash)).join(",")}`);
  if (params.length > 0) {
    out.push(`  params ${params.map((p) => `${p.name}:${p.ownership}`).join(" ")}`);
  }
  for (const l of locals) out.push(`  ${l.name}:${l.renderedType} ${l.ownership}`);
  return out;
}

function renderTest(graph: SemanticGraph, node: SemanticNode): string[] {
  const out = [`${aliasOf(graph, node)} test "${node.name}"`];
  const uses = node.depEdges.filter((e) => e.role !== "parent").map((e) => aliasForHash(graph, e.hash));
  if (uses.length > 0) out.push(`  uses ${uses.join(",")}`);
  return out;
}

/** A packet for exactly one symbol: its facts plus the edges leaving it. */
export function renderSymbolPacket(graph: SemanticGraph, sourceId: string): string {
  const node = graph.bySourceId(sourceId);
  if (node === undefined) return "";
  return renderPacket(graph, { module: node.module, nodes: [node.hash] });
}

// ---------------------------------------------------------------------------
// Deltas — the default edit representation
// ---------------------------------------------------------------------------

export interface DeltaOptions {
  /** Restrict the delta to these hashes or `module::name` ids. */
  readonly nodes?: readonly string[];
}

/**
 * Render the change between two graphs. `Δ <alias>/<base revision>` heads each changed
 * symbol; the body lists only what actually changed. A semantic delta, never a line patch.
 */
export function renderDelta(prev: SemanticGraph, next: SemanticGraph, options: DeltaOptions = {}): string {
  const wanted = options.nodes === undefined
    ? null
    : new Set(options.nodes.map((r) => next.byHash(r)?.sourceId ?? r));
  const out: string[] = [];
  const candidates = next
    .byKind("fn")
    .concat(next.byKind("type"), next.byKind("test"), next.byKind("const"));
  for (const node of candidates) {
    if (wanted !== null && !wanted.has(node.sourceId)) continue;
    const alias = aliasOf(next, node);
    const base = prev.bySourceId(node.sourceId);
    if (base === undefined) {
      out.push(`Δ ${alias}/new`, `  +new ${node.name}`);
      continue;
    }
    const body = deltaBody(prev, next, base, node);
    if (body.length === 0) continue;
    out.push(`Δ ${alias}/b${base.revision}`, ...body);
  }
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

function deltaBody(
  prev: SemanticGraph,
  next: SemanticGraph,
  base: SemanticNode,
  node: SemanticNode,
): string[] {
  void prev;
  if (base.revision === node.revision && base.canonical === node.canonical) return [];
  const out: string[] = [];
  const baseEdges = new Set(base.deps);
  const nodeEdges = new Set(node.deps);
  for (const e of node.depEdges) {
    if (!baseEdges.has(e.hash)) out.push(`  +${e.role} ${aliasForHash(next, e.hash)}`);
  }
  for (const e of base.depEdges) {
    if (!nodeEdges.has(e.hash)) out.push(`  -${e.role} ${aliasForHash(next, e.hash)}`);
  }
  for (const eff of node.effectSet) {
    if (!base.effectSet.includes(eff)) out.push(`  +effect ${eff}`);
  }
  for (const eff of base.effectSet) {
    if (!node.effectSet.includes(eff)) out.push(`  -effect ${eff}`);
  }
  for (const attr of node.attributes) {
    if (!base.attributes.includes(attr)) out.push(`  +attr ${attr}`);
  }
  for (const attr of base.attributes) {
    if (!node.attributes.includes(attr)) out.push(`  -attr ${attr}`);
  }
  if (base.renderedType !== node.renderedType) {
    out.push(`  -type ${base.renderedType}`);
    out.push(`  +type ${node.renderedType}`);
  }
  return out;
}
