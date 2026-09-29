/**
 * MM — dependency-directed context selection (`mm.slice`).
 *
 * The report's thesis is that context should be typed data, not one giant string: the
 * compiler solves
 *
 *     max  Σ relevance_i · information_i
 *     s.t. Σ tokens_i ≤ Budget
 *          dependencies(selected) ⊆ selected ∪ compilerKnown
 *
 * The third constraint is the one that makes the result *usable*: a slice whose nodes
 * reference symbols the agent cannot see is not a slice, it is a trap. Everything the
 * budget removes is removed in closure-safe order, so the constraint always holds.
 *
 * Scoring is deterministic: no randomness, no wall clock, no ordering dependence on
 * hash-map iteration. Equal scores break on the node's source id.
 */

import type { SemanticGraph, SemanticNode } from "./graph.ts";
import { contentHash } from "./graph.ts";
import { estimateTokens, renderSymbolPacket } from "./packet.ts";

export type IncludeKey =
  | "definitions"
  | "affected_calls"
  | "wire_abi"
  | "tests"
  | "signatures"
  | "impls";

const KNOWN_INCLUDES: Record<string, true> = {
  definitions: true,
  affected_calls: true,
  wire_abi: true,
  tests: true,
  signatures: true,
  impls: true,
};

const STOPWORDS: Record<string, true> = {
  the: true, a: true, an: true, of: true, to: true, in: true, on: true, for: true,
  and: true, or: true, from: true, into: true, with: true, that: true, this: true,
  change: true, make: true, add: true, remove: true, update: true, please: true,
};

export interface SliceRequest {
  /** A natural-language goal. Scored by word overlap with symbol names. */
  readonly goal: string;
  /** What the caller wants included beyond the goal match. */
  readonly include: readonly string[];
  /** Proxy budget; see `estimateTokens` — a character proxy, not a tokenizer. */
  readonly budgetTokens: number;
}

export interface SliceEntry {
  readonly hash: string;
  readonly sourceId: string;
  readonly kind: SemanticNode["kind"];
  readonly relevance: number;
  readonly information: number;
  readonly tokens: number;
}

export type RiskKind = "wire" | "persist" | "resource" | "intent" | "secret";

export interface SystemRisk {
  readonly kind: RiskKind;
  readonly subject: string;
  readonly note: string;
}

export interface AffectedSymbol {
  readonly symbol: string;
  readonly kind: "fn" | "test" | "wire" | "field" | "persist";
  readonly reason: string;
}

export interface Slice {
  /** Content hash of the selection: two identical selections share an id. */
  readonly id: string;
  readonly goal: string;
  readonly include: readonly string[];
  readonly unknownInclude: readonly string[];
  readonly budgetTokens: number;
  readonly estimatedTokens: number;
  readonly symbols: number;
  readonly files: readonly string[];
  /** True when `Σ deps(selected) ⊆ selected ∪ compilerKnown` holds. */
  readonly dependencyClosed: boolean;
  /** True when the proxy budget could not be met without breaking closure. */
  readonly overBudget: boolean;
  readonly entries: readonly SliceEntry[];
  readonly affected: readonly AffectedSymbol[];
  readonly systemRisk: readonly SystemRisk[];
}

export function buildSlice(graph: SemanticGraph, request: SliceRequest): Slice {
  const include = request.include.filter((k) => KNOWN_INCLUDES[k] === true);
  const unknownInclude = request.include.filter((k) => KNOWN_INCLUDES[k] !== true);
  const goalTerms = termSet(request.goal);

  const scored = [...graph.nodes.values()]
    .map((node) => score(graph, node, goalTerms, include))
    .sort((a, b) => b.relevance - a.relevance || (a.node.sourceId < b.node.sourceId ? -1 : 1));

  const wanted = new Set<string>();
  const add = (hash: string): void => { wanted.add(hash); };
  for (const { node, relevance } of scored) {
    if (relevance > 0) add(node.hash);
  }
  expand(graph, wanted, include);

  // Dependency closure: every edge leaving a selected node must land in the selection.
  const closure = (seeds: ReadonlySet<string>): Set<string> => {
    const out = new Set<string>(seeds);
    const stack = [...seeds];
    while (stack.length > 0) {
      const h = stack.pop()!;
      for (const e of graph.byHash(h)?.depEdges ?? []) {
        if (out.has(e.hash)) continue;
        out.add(e.hash);
        stack.push(e.hash);
      }
    }
    return out;
  };

  let selected = closure(wanted);
  const costs = new Map<string, number>();
  const relevance = new Map<string, number>();
  for (const s of scored) {
    costs.set(s.node.hash, s.tokens);
    relevance.set(s.node.hash, s.relevance);
  }

  // Outgoing edges, then the incoming count they imply. "Does anything still selected
  // depend on this node?" was answered by rescanning the whole selection with a linear
  // `deps.includes`, once per candidate, once per removal — cubic, and about eleven
  // seconds on a thirty-file corpus. The answer is a *count*, maintained as nodes leave.
  const dependsOn = new Map<string, readonly string[]>();
  for (const h of selected) dependsOn.set(h, graph.byHash(h)?.deps ?? []);
  const blockers = new Map<string, number>();
  for (const h of selected) {
    for (const t of dependsOn.get(h) ?? []) blockers.set(t, (blockers.get(t) ?? 0) + 1);
  }

  // Budget trimming, always closure-safe: a node may only leave if nothing that stays
  // still depends on it.
  let total = totalCost(selected, costs);
  while (total > request.budgetTokens) {
    let victim: string | null = null;
    let worst = Infinity;
    for (const h of selected) {
      if ((blockers.get(h) ?? 0) > 0) continue;
      const value = relevance.get(h) ?? 0;
      if (value < worst) { worst = value; victim = h; }
    }
    if (victim === null) break;
    selected.delete(victim);
    // The departing node's *outgoing* edges are what vanish, so the counters to
    // decrement belong to the things it depended on — not to the things that depended
    // on it. Getting this backwards leaves nodes falsely blocked and the trim stops
    // early, which is exactly what happened the first time round.
    for (const t of dependsOn.get(victim) ?? []) {
      const n = blockers.get(t);
      if (n !== undefined) blockers.set(t, n - 1);
    }
    total -= costs.get(victim) ?? 0;
  }


  const ordered = [...selected].sort();
  const entries: SliceEntry[] = ordered.map((hash) => {
    const s = scoreOfEntry(scored, hash);
    const node = graph.byHash(hash)!;
    return {
      hash,
      sourceId: node.sourceId,
      kind: node.kind,
      relevance: s.relevance,
      information: s.information,
      tokens: s.tokens,
    };
  });

  const affected = collectAffected(graph, selected);
  const systemRisk = collectSystemRisk(graph, selected);

  return {
    id: contentHash(ordered.join("|")),
    goal: request.goal,
    include,
    unknownInclude,
    budgetTokens: request.budgetTokens,
    estimatedTokens: total,
    symbols: entries.length,
    files: [...new Set(ordered.map((h) => graph.byHash(h)!.module))].sort(),
    dependencyClosed: isClosed(graph, selected),
    overBudget: total > request.budgetTokens,
    entries,
    affected,
    systemRisk,
  };
}

/** True when every outgoing edge of a selected node also selects its target. */
export function isClosed(graph: SemanticGraph, selected: ReadonlySet<string>): boolean {
  for (const h of selected) {
    for (const e of graph.byHash(h)?.depEdges ?? []) {
      if (!selected.has(e.hash)) return false;
    }
  }
  return true;
}

function totalCost(selected: ReadonlySet<string>, costs: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const h of selected) total += costs.get(h) ?? 0;
  return total;
}


function scoreOfEntry(scored: readonly Scored[], hash: string): Scored {
  const found = scored.find((s) => s.node.hash === hash);
  if (found === undefined) throw new Error(`unscored node ${hash}`);
  return found;
}

interface Scored {
  readonly node: SemanticNode;
  readonly relevance: number;
  readonly information: number;
  readonly tokens: number;
}

function score(
  graph: SemanticGraph,
  node: SemanticNode,
  goalTerms: ReadonlySet<string>,
  include: readonly string[],
): Scored {
  const own = termSet(node.name);
  let overlap = 0;
  for (const t of goalTerms) {
    if (own.has(t)) overlap++;
    if (t.length > 3 && node.name.toLowerCase().includes(t)) overlap++;
  }
  const kindBase = KIND_BASE[node.kind];
  let relevance = kindBase + overlap * 4;
  if (include.includes("definitions") && overlap > 0) relevance += 2;
  if (include.includes("signatures") && (node.kind === "param" || node.kind === "field")) relevance += 1;
  if (include.includes("wire_abi") && node.attributes.length > 0) relevance += 2;
  if (include.includes("impls") && (node.kind === "impl" || node.kind === "trait")) relevance += 2;
  const tokens = estimateTokens(renderSymbolPacket(graph, node.sourceId) || node.sourceId);
  const information = Math.round((1 + tokens / 8) * 1000) / 1000;
  return { node, relevance, information, tokens };
}

const KIND_BASE: Record<SemanticNode["kind"], number> = {
  type: 3, field: 2, variant: 2, fn: 3, param: 1, local: 1,
  test: 2, const: 1, trait: 1, impl: 1,
};

/** Split a name or goal into comparable terms: snake, camel and words. */
function termSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (raw.length === 0) continue;
    const lower = raw.toLowerCase();
    if (!STOPWORDS[lower]) out.add(lower);
    for (const piece of raw.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
      const p = piece.toLowerCase();
      if (p.length > 1 && !STOPWORDS[p]) out.add(p);
    }
  }
  return out;
}

/** Widen the goal match by the include set. */
function expand(graph: SemanticGraph, wanted: Set<string>, include: readonly string[]): void {
  const seeds = [...wanted];
  for (const hash of seeds) {
    const node = graph.byHash(hash);
    if (node === undefined) continue;
    if (node.parent !== null) continue;
    for (const child of [...graph.nodes.values()]) {
      if (child.parent === hash) wanted.add(child.hash);
    }
  }
  if (!include.includes("affected_calls") && !include.includes("tests")) return;
  for (const hash of [...wanted]) {
    for (const ref of graph.refsTo(hash)) {
      const viaCall = ref.depEdges.some((e) => e.hash === hash && e.role === "call");
      if (viaCall || include.includes("tests")) wanted.add(ref.hash);
    }
  }
  if (!include.includes("wire_abi")) return;
  for (const node of graph.nodes.values()) {
    if (node.attributes.includes("wire") || node.attributes.includes("persist")) wanted.add(node.hash);
  }
}

function collectAffected(graph: SemanticGraph, selected: ReadonlySet<string>): AffectedSymbol[] {
  const out = new Map<string, AffectedSymbol>();
  for (const hash of selected) {
    const node = graph.byHash(hash);
    if (node === undefined || node.kind === "param" || node.kind === "local") continue;
    for (const ref of graph.refsTo(hash)) {
      const viaCall = ref.depEdges.some((e) => e.hash === hash && e.role === "call");
      if (ref.kind === "fn" && viaCall) {
        out.set(`fn:${ref.name}`, { symbol: ref.name, kind: "fn", reason: `calls ${node.name}` });
      }
      if (ref.kind === "test") {
        out.set(`test:${ref.name}`, { symbol: ref.name, kind: "test", reason: `exercises ${node.name}` });
      }
    }
    if (node.kind === "field" && node.parent !== null) {
      const owner = graph.byHash(node.parent);
      if (owner?.attributes.includes("wire") === true) {
        out.set(`wire:${owner.name}.${node.name}`, {
          symbol: `${owner.name}.${node.name}`, kind: "wire",
          reason: "wire schema field",
        });
      }
    }
  }
  return [...out.values()].sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
}

function collectSystemRisk(graph: SemanticGraph, selected: ReadonlySet<string>): SystemRisk[] {
  const out = new Map<string, SystemRisk>();
  const add = (r: SystemRisk): void => { out.set(`${r.kind}:${r.subject}`, r); };
  for (const hash of selected) {
    const node = graph.byHash(hash);
    if (node === undefined || node.kind === "param" || node.kind === "local") continue;
    if (node.attributes.includes("wire")) {
      add({ kind: "wire", subject: node.name, note: "wire schema changes" });
    }
    if (node.attributes.includes("persist")) {
      add({ kind: "persist", subject: node.name, note: "persistence migration required" });
    }
    if (node.attributes.includes("resource")) {
      add({ kind: "resource", subject: node.name, note: "drop/close contract changes" });
    }
    if (node.attributes.includes("secret")) {
      add({ kind: "secret", subject: node.name, note: "values must never enter a packet" });
    }
    if (node.kind === "fn" && node.attributes.includes("intent")) {
      add({ kind: "intent", subject: node.name, note: "system plan input/output changes" });
    }
  }
  return [...out.values()].sort((a, b) => (a.subject < b.subject ? -1 : 1));
}

/** The compact, storable form of a slice: the shape an agent actually reads. */
export function renderSlice(slice: Slice, graph: SemanticGraph): string {
  const lines = [
    `slice ${slice.id}`,
    `symbols ${slice.symbols}`,
    `files ${slice.files.length}`,
    `budget ${slice.budgetTokens}`,
    `estimated ${slice.estimatedTokens}${slice.overBudget ? " (over budget: closure requires more)" : ""}`,
    "",
  ];
  for (const entry of slice.entries) {
    const node = graph.byHash(entry.hash);
    if (node === undefined || node.kind === "param" || node.kind === "local") continue;
    const refs = graph.refsTo(node.hash)
      .filter((r) => r.kind !== "param" && r.kind !== "local")
      .map((r) => graph.alias(r.hash) ?? r.name);
    const head = node.kind === "type"
      ? `${graph.alias(node.hash) ?? node.hash} ${node.name}`
      : `${graph.alias(node.hash) ?? node.hash} ${node.name}${node.renderedType ? ` ${node.renderedType}` : ""}`;
    lines.push(`${head}${refs.length > 0 ? ` -> refs ${refs.join(",")}` : ""}`);
  }
  if (slice.affected.length > 0) {
    lines.push("", "affected:");
    for (const a of slice.affected) lines.push(`  ${a.kind} ${a.symbol} (${a.reason})`);
  }
  if (slice.systemRisk.length > 0) {
    lines.push("", "system-risk:");
    for (const r of slice.systemRisk) lines.push(`  ${r.note}: ${r.subject}`);
  }
  return `${lines.join("\n")}\n`;
}
