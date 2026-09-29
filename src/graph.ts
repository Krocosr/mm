/**
 * MM — the semantic graph (kernel.md §7).
 *
 * The graph, not the source text, is the primary interface an agent uses. Identity has
 * three separate spaces and conflating them is a bug:
 *
 *   - `hash`      content hash of a canonical *semantic* form. The primary identity.
 *                 Stable across moves, comments, whitespace and file reordering;
 *                 changes when meaning changes.
 *   - `sourceId`  `module::name`. Stable until renamed.
 *   - `alias`     `T#27`. Ephemeral, assigned on first touch, session-local.
 *
 * A line number is NEVER an identity: `span` exists for humans only and never
 * participates in a hash.
 */
import { createHash } from "node:crypto";
import type {
  Attribute, Block, Expr, LoweredField, LoweredFn, Pattern, Span, Stmt, TypeExpr,
} from "./ast.ts";
import type { LoweredTypeDeclDef } from "./lower.ts";
import { ownershipOf } from "./lower.ts";
import type { Program } from "./program.ts";
import { expandTypeFields } from "./program.ts";
import type { Ty } from "./types.ts";
import { BUILTIN, TY_ERR, isCopy, renderTy } from "./types.ts";

export type { LoweredTypeDeclDef };

// ---------------------------------------------------------------------------
// Node shapes
// ---------------------------------------------------------------------------

export type NodeKind =
  | "type" | "fn" | "param" | "local" | "field" | "variant"
  | "test" | "const" | "trait" | "impl";

/** Ownership discipline of a value, plus the derived `copy` case (kernel.md §3.4). */
export type NodeOwnership = "owned" | "view" | "viewmut" | "shared" | "arena" | "handle" | "copy";

/** Why an edge exists. The graph stores edges by hash; this is the human/agent label. */
export type EdgeRole =
  | "call"        // this node calls the target
  | "type"        // the target's type appears in this node's signature/body
  | "ref"         // the target is referenced by name (const, path expression)
  | "member"      // a field of the target record/union is selected or constructed
  | "test"        // a test node references the target
  | "parent";     // containment: param/local/field/variant → its owner

export interface DepEdge {
  /** Content hash of the target node. Never a name, never an id. */
  readonly hash: string;
  readonly role: EdgeRole;
}

/** One addressable thing in the program. Mirrors kernel.md §7.2. */
export interface SemanticNode {
  readonly hash: string;
  readonly sourceId: string;
  /** Session-local alias, assigned lazily on first touch via `graph.alias()`. */
  readonly alias: string | null;
  readonly kind: NodeKind;
  readonly module: string;
  readonly name: string;
  /** Resolved type's rendered canonical form (empty string for kindless nodes). */
  readonly typeHash: string;
  /** The resolved type in readable form, for packets. Never an input to the hash. */
  readonly renderedType: string;
  readonly effectSet: readonly string[];
  readonly ownership: NodeOwnership;
  readonly span: Span;
  /** Sorted, de-duplicated content hashes of the outgoing edges. */
  readonly deps: readonly string[];
  /** The same edges, labelled. `deps` is exactly the sorted unique set of `depEdges`. */
  readonly depEdges: readonly DepEdge[];
  readonly revision: number;
  readonly attributes: readonly string[];
  /** Owning node hash for param/local/field/variant nodes. */
  readonly parent: string | null;
  /** The definition id in the program table, when the node mirrors one. */
  readonly defId: number | null;
  /** Canonical semantic form the hash was taken over. Useful for deltas/debugging. */
  readonly canonical: string;
}

/** Incremental-revision input: build the next graph against the previous one. */
export interface GraphOptions {
  readonly previous?: SemanticGraph | undefined;
}

export class SemanticGraph {
  readonly program: Program;
  readonly nodes: ReadonlyMap<string, SemanticNode>;
  /** sourceId → definition node (fields/locals are reachable via `allBySourceId`). */
  private readonly defBySourceId: Map<string, SemanticNode>;
  private readonly allBySourceIdMap: Map<string, SemanticNode[]>;
  private readonly aliasByHash: Map<string, string> = new Map();
  private readonly byAliasMap: Map<string, SemanticNode> = new Map();
  private readonly refsToMap: Map<string, Set<string>> = new Map();
  private readonly refsFromMap: Map<string, Set<string>> = new Map();
  private readonly kindList: Map<NodeKind, SemanticNode[]>;
  private counter = 0;

  constructor(program: Program, nodes: readonly SemanticNode[]) {
    this.program = program;
    const byHash = new Map<string, SemanticNode>();
    for (const n of nodes) {
      if (byHash.has(n.hash)) continue; // identical semantics: one node, both source ids
      byHash.set(n.hash, n);
    }
    this.nodes = byHash;
    this.defBySourceId = new Map();
    this.allBySourceIdMap = new Map();
    const kinds = new Map<NodeKind, SemanticNode[]>();
    for (const n of nodes) {
      const bucket = this.allBySourceIdMap.get(n.sourceId) ?? [];
      this.allBySourceIdMap.set(n.sourceId, bucket);
      bucket.push(n);
      if (!this.defBySourceId.has(n.sourceId)) this.defBySourceId.set(n.sourceId, n);
      const kb = kinds.get(n.kind) ?? [];
      kb.push(n);
      kinds.set(n.kind, kb);
    }
    this.kindList = kinds;
    // Rebuild the reverse index: an edge A→B makes A a reference *to* B's definition.
    for (const n of byHash.values()) {
      const from = this.refsFromMap.get(n.hash) ?? new Set<string>();
      for (const e of n.depEdges) {
        if (e.role === "parent") continue;
        from.add(e.hash);
        const to = this.refsToMap.get(e.hash) ?? new Set<string>();
        to.add(n.hash);
        this.refsFromMap.set(n.hash, from);
        this.refsToMap.set(e.hash, to);
      }
    }
  }

  // -- lookups ---------------------------------------------------------------

  byHash(hash: string): SemanticNode | undefined {
    return this.nodes.get(hash);
  }

  bySourceId(sourceId: string): SemanticNode | undefined {
    return this.defBySourceId.get(sourceId);
  }

  allBySourceId(sourceId: string): readonly SemanticNode[] {
    return this.allBySourceIdMap.get(sourceId) ?? [];
  }

  byAlias(alias: string): SemanticNode | undefined {
    return this.byAliasMap.get(alias);
  }

  /** Every node of a kind, in stable (construction) order. */
  byKind(kind: NodeKind): readonly SemanticNode[] {
    return this.kindList.get(kind) ?? [];
  }

  /** Resolve a definition id of any kind to its node. */
  byDefId(id: number): SemanticNode | undefined {
    const t = this.program.typeInfo.get(id);
    if (t) return this.bySourceId(`${t.module}::${t.name}`);
    const f = this.program.fnInfo.get(id);
    if (f) return this.bySourceId(`${f.module}::${f.name}`);
    for (const [key, ref] of this.program.symbols) {
      if (ref.id === id) return this.bySourceId(key);
    }
    for (const t2 of this.program.traits.values()) {
      if (t2.id === id) return this.bySourceId(`${t2.module}::${t2.name}`);
    }
    for (const t3 of this.program.tests.values()) {
      if (t3.id === id) return this.bySourceId(`${t3.module}::test:${t3.name}`);
    }
    for (const c of this.program.consts.values()) {
      if (c.id === id) return this.bySourceId(`${c.module}::${c.name}`);
    }
    return undefined;
  }

  /** Nodes that depend on `hash` (callers, users, tests). */
  refsTo(hash: string): SemanticNode[] {
    return [...(this.refsToMap.get(hash) ?? [])].map((h) => this.nodes.get(h)!).filter(Boolean);
  }

  /** Nodes `hash` depends on (callees, referenced types, fields). */
  refsFrom(hash: string): SemanticNode[] {
    return [...(this.refsFromMap.get(hash) ?? [])].map((h) => this.nodes.get(h)!).filter(Boolean);
  }

  /**
   * Forward transitive closure: every node reachable from `seeds` by outgoing
   * dependency edges, out to `depth` hops (0 = the seeds themselves).
   */
  reach(seedHashes: Iterable<string>, depth = 1): Set<string> {
    const seen = new Set<string>();
    let frontier = [...seedHashes];
    for (let d = 0; d <= depth; d++) {
      const next: string[] = [];
      for (const h of frontier) {
        if (seen.has(h)) continue;
        seen.add(h);
        for (const e of this.nodes.get(h)?.depEdges ?? []) {
          if (e.role === "parent") continue;
          if (!seen.has(e.hash)) next.push(e.hash);
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    return seen;
  }

  /** Source files the graph touches, in load order. */
  files(): string[] {
    const out = new Set<string>();
    for (const n of this.nodes.values()) {
      const f = this.program.files[n.span.file];
      if (f) out.add(f.module);
    }
    return [...out];
  }

  /** Touch a node: assign and return its ephemeral session alias. */
  alias(hash: string): string | null {
    const node = this.nodes.get(hash);
    if (!node) return null;
    const existing = this.aliasByHash.get(hash);
    if (existing !== undefined) return existing;
    const alias = `${ALIAS_PREFIX[node.kind]}${++this.counter}`;
    this.aliasByHash.set(hash, alias);
    this.byAliasMap.set(alias, node);
    return alias;
  }

  /** Every hash touched so far, in first-touch order. */
  touchedAliases(): ReadonlyMap<string, string> {
    return this.aliasByHash;
  }

}

export const ALIAS_PREFIX: Record<NodeKind, string> = {
  type: "T", field: "T", variant: "T", test: "T",
  fn: "F", param: "F", local: "L",
  const: "C", trait: "D", impl: "I",
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** Hashing/edge-collection context for one function body or type definition. */
interface Refs {
  readonly program: Program;
  readonly module: string;
  generics: Map<string, Ty>;
  /** Named references discovered in the body, keyed by name so repeats collapse. */
  readonly out: Map<string, Ref>;
  /** Shape tokens: a name-free fingerprint of the body's structure. */
  readonly shape: string[];
}

interface Ref {
  readonly role: EdgeRole;
  /** Symbol name; resolved to a node hash after the body walk. */
  readonly name: string;
}

/** Canonical content hash: first 8 hex chars of SHA-256 (kernel.md §7.1). */
export function contentHash(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 8);
}

/** One hash input line. Sorted field values are joined with `,`; fields with `|`. */
function canonicalForm(parts: readonly (readonly string[])[]): string {
  return parts
    .map((fields) => fields.filter((f) => f.length > 0).join("|"))
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Build the semantic graph for a loaded program.
 *
 * Pass `options.previous` to get monotonic revisions: a node whose canonical form is
 * unchanged keeps its revision, a changed one gets `base + 1`, a brand new node starts
 * at 1.
 */
export function buildGraph(program: Program, options: GraphOptions = {}): SemanticGraph {
  const drafts: NodeDraft[] = [];
  const reg = new Registry(drafts);

  for (const unit of program.units) {
    for (const decl of unit.types) {
      collectType(program, reg, drafts, unit.module, decl.def, decl.attrs, decl.span, decl.id);
    }
    for (const fn of unit.fns) {
      // Trait and impl methods are collected with their owner and qualified by it.
      if (!unit.methodIds.has(fn.id)) collectFn(program, reg, drafts, fn);
    }
    for (const trait of unit.traits) {
      const refs = newRefs(program, trait.module);
      for (const g of trait.generics) refs.generics.set(g.name, { k: "var", id: g.name.length, name: g.name, bound: null });
      const d = reg.define({
        sourceId: `${trait.module}::${trait.name}`, kind: "trait", module: trait.module,
        name: trait.name, typeForm: `trait<${trait.methods.length}>`, effects: [],
        ownership: "owned", attrs: attrNames(trait.attrs), span: trait.span,
        defId: trait.id, parent: null, shape: `trait<${trait.methods.length}>`, refs: [],
        resolvedTy: null, qualName: trait.name,
      });
      for (const m of trait.methods) collectFn(program, reg, drafts, m, `${trait.name}.`, d);
    }
    for (const impl of unit.impls) {
      const refs = newRefs(program, impl.module);
      refs.out.set(impl.trait, { role: "type", name: impl.trait });
      refs.out.set(impl.typeName, { role: "type", name: impl.typeName });
      const d = reg.define({
        sourceId: `${impl.module}::impl ${impl.trait} for ${impl.typeName}`, kind: "impl",
        module: impl.module, name: `${impl.trait}/${impl.typeName}`,
        typeForm: `impl ${impl.typeName}`, effects: [], ownership: "owned",
        attrs: attrNames(impl.attrs), span: impl.span, defId: impl.id, parent: null,
        shape: `impl<${impl.methods.length}>`, refs: [...refs.out.values()], resolvedTy: null,
        qualName: impl.typeName,
      });
      for (const m of impl.methods) collectFn(program, reg, drafts, m, `${impl.typeName}.`, d);
    }
    for (const c of unit.consts) {
      const refs = newRefs(program, c.module);
      if ("stmts" in c.value) walkBlock(refs, c.value);
      else walkExpr(refs, c.value);
      const typeForm = c.ty ? renderTy(resolveTyExpr(program, c.ty, refs), defNameFor(program)) : "";
      reg.define({
        sourceId: `${c.module}::${c.name}`, kind: "const", module: c.module, name: c.name,
        typeForm, effects: [], ownership: "owned", attrs: attrNames(c.attrs), span: c.span,
        defId: c.id, parent: null, shape: c.isConstFn ? "constfn" : "const",
        refs: [...refs.out.values()], resolvedTy: null, qualName: c.name,
      });
    }
    for (const t of unit.tests) {
      const refs = newRefs(program, t.module);
      walkBlock(refs, t.body);
      reg.define({
        sourceId: `${t.module}::test:${t.name}`, kind: "test", module: t.module, name: t.name,
        typeForm: "()", effects: [], ownership: "owned", attrs: attrNames(t.attrs), span: t.span,
        defId: t.id, parent: null, shape: refs.shape.join(","), refs: [...refs.out.values()],
        resolvedTy: null, qualName: t.name,
      });
    }
  }

  return finalize(program, drafts, options);
}

interface NodeDraft {
  readonly sourceId: string;
  readonly kind: NodeKind;
  readonly module: string;
  readonly name: string;
  /** Canonical rendered type of the node's own value, filled during collection. */
  typeForm: string;
  readonly effects: readonly string[];
  readonly ownership: NodeOwnership;
  readonly attrs: readonly string[];
  readonly span: Span;
  readonly defId: number | null;
  readonly parent: string | null;
  /** Name-free structural fingerprint: the part of meaning that survives a rename. */
  shape: string;
  /** Named references found in the body/signature, resolved to hashes in `finalize`. */
  refs: readonly Ref[];
  /** Resolved type of a value node, kept for `isCopy`/ownership derivation. */
  resolvedTy: Ty | null;
  /** Name usable in `sourceId` and in `packet` rendering (methods carry their owner). */
  readonly qualName: string;
}


/** Draft-level index: name → the single definition node that owns the name. */
class Registry {
  private readonly byName = new Map<string, NodeDraft>();

  constructor(private readonly drafts: NodeDraft[]) {}

  /** Record a definition draft and index it by the name its references will use. */
  define(d: NodeDraft): NodeDraft {
    this.drafts.push(d);
    if (!this.byName.has(d.qualName)) this.byName.set(d.qualName, d);
    return d;
  }


  /** Local first, then builtin, then a unique cross-module suffix — mirrors `Program`. */
  lookup(program: Program, module: string, name: string): NodeDraft | undefined {
    void program;
    const tail = name.includes("::") ? name.slice(name.lastIndexOf("::") + 2) : name;
    const local = this.byName.get(tail);
    if (local) return local;
    if (BUILTIN_LOOKUP[tail]) return undefined; // compiler-known: no node needed
    let found: NodeDraft | undefined;
    let ambiguous = false;
    for (const [defName, d] of this.byName) {
      if (d.module === module || defName !== tail) continue;
      if (found) ambiguous = true;
      found = d;
    }
    return ambiguous ? undefined : found;
  }
}

/** Builtin type/function names are compiler-known: they need no graph node. */
const BUILTIN_LOOKUP: Record<string, true> = Object.fromEntries(
  ["Result", "Opt", "Map", "Set", "Decision", "Untrusted", "Verified", "Cap", "Stream",
    "Context", "Handle", "Bytes", "Ticket", "IoErr", "NetErr", "Text", "Path", "ProviderId",
    "ModelId", "assert_eq", "assert", "sum", "fs", "db", "print"].map((n) => [n, true]),
);

function attrNames(attrs: readonly Attribute[]): readonly string[] {
  return [...attrs.map((a) => a.name)].sort();
}

function defNameFor(program: Program): (id: number) => string | null {
  return (id: number): string | null => program.typeInfo.get(id)?.name ?? null;
}

function newRefs(program: Program, module: string): Refs {
  return { program, module, generics: new Map(), out: new Map(), shape: [] };
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

function collectType(
  program: Program,
  reg: Registry,
  drafts: NodeDraft[],
  module: string,
  def: LoweredTypeDeclDef,
  attrs: readonly Attribute[],
  span: Span,
  defId: number,
): void {
  const refs = newRefs(program, module);
  for (const g of def.generics) {
    refs.generics.set(g.name, { k: "var", id: -g.name.length, name: g.name, bound: null });
  }
  const typeDraft = reg.define({
    sourceId: `${module}::${def.name}`, kind: "type", module, name: def.name,
    typeForm: "", effects: [], ownership: "owned", attrs: attrNames(attrs), span,
    defId, parent: null, shape: `${def.form}<${def.generics.length}>`, refs: [],
    resolvedTy: null, qualName: def.name,
  });

  const addField = (f: LoweredField, ownerSourceId: string, shape: string): void => {
    const frefs = newRefs(program, module);
    frefs.generics = refs.generics;
    const ty = resolveTyExpr(program, f.ty, frefs);
    drafts.push({
      sourceId: `${ownerSourceId}::${f.name}`, kind: "field", module, name: f.name,
      typeForm: renderTy(ty, defNameFor(program)), effects: [],
      ownership: ownershipFor(program, ty, f.ty, frefs), attrs: attrNames(f.attrs), span: f.span,
      defId, parent: typeDraft.sourceId, shape, refs: [...frefs.out.values()], resolvedTy: ty,
      qualName: `${def.name}.${f.name}`,
    });
  };

  switch (def.form) {
    case "record":
      for (const f of def.fields) addField(f, typeDraft.sourceId, "field");
      break;
    case "union":
      for (const v of def.variants) {
        const vshape = `variant<${v.fields.length}>`;
        drafts.push({
          sourceId: `${typeDraft.sourceId}::${v.name}`, kind: "variant", module, name: v.name,
          typeForm: "", effects: [], ownership: "owned", attrs: [], span: v.span,
          defId, parent: typeDraft.sourceId, shape: vshape, refs: [], resolvedTy: null,
          qualName: `${def.name}.${v.name}`,
        });
        for (const f of v.fields) addField(f, `${typeDraft.sourceId}::${v.name}`, "field");
      }
      break;
    case "choice":
      for (const c of def.choices) {
        drafts.push({
          sourceId: `${typeDraft.sourceId}::${c}`, kind: "variant", module, name: c,
          typeForm: "", effects: [], ownership: "owned", attrs: [], span,
          defId, parent: typeDraft.sourceId, shape: "choice", refs: [], resolvedTy: null,
          qualName: `${def.name}.${c}`,
        });
      }
      break;
    case "alias": {
      const ty = resolveTyExpr(program, def.target, refs);
      typeDraft.typeForm = renderTy(ty, defNameFor(program));
      typeDraft.resolvedTy = ty;
      typeDraft.refs = [...refs.out.values()];
      typeDraft.shape = "alias";
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Function collector
// ---------------------------------------------------------------------------

function collectFn(
  program: Program,
  reg: Registry,
  drafts: NodeDraft[],
  fn: LoweredFn,
  prefix = "",
  owner?: NodeDraft,
): void {
  const refs = newRefs(program, fn.module);
  for (const g of fn.generics) {
    refs.generics.set(g.name, { k: "var", id: -g.name.length, name: g.name, bound: null });
  }
  const qualName = `${prefix}${fn.name}`;
  const sourceId = `${fn.module}::${qualName}`;
  const fnDraft = reg.define({
    sourceId, kind: "fn", module: fn.module, name: fn.name, typeForm: "",
    effects: [...(fn.effects ?? fn.inferredEffects ?? [])].sort(), ownership: "owned",
    attrs: attrNames(fn.attrs), span: fn.span, defId: fn.id,
    parent: owner ? owner.sourceId : null, shape: "", refs: [], resolvedTy: null, qualName,
  });
  const paramOwnerships: NodeOwnership[] = [];
  for (const p of fn.params) {
    const ty = resolveTyExpr(program, p.ty, refs);
    const ownership = ownershipFor(program, ty, p.ty, refs);
    paramOwnerships.push(ownership);
    drafts.push({
      sourceId: `${sourceId}::p:${p.name}`, kind: "param", module: fn.module, name: p.name,
      typeForm: renderTy(ty, defNameFor(program)), effects: [], ownership,
      attrs: attrNames(p.attrs), span: p.span, defId: fn.id, parent: sourceId,
      shape: "param", refs: [], resolvedTy: ty, qualName: `${qualName}.${p.name}`,
    });
  }

  walkBlock(refs, fn.body);
  collectLocals(program, drafts, refs, fn, sourceId, fn.body, fn.generics.map((g) => g.name));

  const ret = resolveTyExpr(program, fn.ret, refs);
  const retForm = fn.ret ? renderTy(ret, defNameFor(program)) : "()";
  const flags = [
    fn.isConst ? "const" : "",
    fn.externAbi ? `extern:${fn.externAbi}` : "",
    fn.unsafety ? `unsafe:${[...fn.unsafety].sort().join("+")}` : "",
  ].filter((f) => f.length > 0).join(";");
  fnDraft.typeForm = `fn(${fn.params.map((p) => renderTy(resolveTyExpr(program, p.ty, refs), defNameFor(program))).join(",")})->${retForm}`;
  fnDraft.shape = `fn<${fn.generics.length}>[${paramOwnerships.join(",")}]{${flags}}${refs.shape.join(",")}`;
  fnDraft.refs = [...refs.out.values()];
  fnDraft.resolvedTy = ret;
}

function collectLocals(
  program: Program,
  drafts: NodeDraft[],
  refs: Refs,
  fn: LoweredFn,
  fnSourceId: string,
  block: Block,
  generics: readonly string[],
): void {
  let counter = 0;
  const walk = (b: Block): void => {
    for (const s of b.stmts) {
      if (s.kind !== "let") continue;
      for (const name of boundNames(s.pat)) {
        const localRefs = newRefs(program, fn.module);
        localRefs.generics = new Map(refs.generics);
        const ty = s.ty
          ? resolveTyExpr(program, s.ty, localRefs)
          : s.init ? inferExprTy(program, s.init, localRefs) : TY_ERR;
        drafts.push({
          sourceId: `${fnSourceId}::l${counter++}:${name}`, kind: "local", module: fn.module,
          name, typeForm: renderTy(ty, defNameFor(program)), effects: [],
          ownership: s.ty ? ownershipFor(program, ty, s.ty, localRefs) : ownershipOfTy(ty),
          attrs: [], span: s.pat.span, defId: fn.id, parent: fnSourceId,
          shape: s.mutable ? "let*" : "let", refs: [], resolvedTy: ty,
          qualName: `${fn.name}.${name}`,
        });
      }
    }
    for (const s of b.stmts) {
      const inner = s.kind === "expr" ? s.expr : s.kind === "assign" ? s.value : null;
      if (inner && inner.kind === "block") walk(inner.block);
    }
  };
  void generics;
  walk(block);
}


function boundNames(p: Pattern, out: string[] = []): string[] {
  switch (p.kind) {
    case "bind": out.push(p.name); break;
    case "tuple": for (const e of p.elems) boundNames(e, out); break;
    case "record": for (const f of p.fields) boundNames(f.pat, out); break;
    case "at": out.push(p.name); boundNames(p.sub, out); break;
    case "or": for (const a of p.alts) boundNames(a, out); break;
    default: break;
  }
  return out;
}

/** Ownership of a `let` binding with no annotation: derived from the value's type. */
function ownershipOfTy(ty: Ty): NodeOwnership {
  if (ty.k === "own" && ty.ownership !== "owned") return ty.ownership;
  return "owned";
}

function ownershipFor(program: Program, ty: Ty, expr: TypeExpr, refs: Refs): NodeOwnership {
  const written = ownershipOf(expr);
  if (written !== "owned") return written;
  const copy = isCopy(ty, (def, args) => {
    const expanded = expandTypeFields(program, def, args, (e) => resolveTyExpr(program, e, refs));
    return expanded ? expanded.map((f) => ({ name: f.name, ty: f.ty, attrs: f.attrs })) : null;
  });
  return copy ? "copy" : "owned";
}

// ---------------------------------------------------------------------------
// Type expression → resolved type
// ---------------------------------------------------------------------------

function resolveTyExpr(program: Program, e: TypeExpr | null, refs: Refs): Ty {
  if (!e) return TY_ERR;
  switch (e.kind) {
    case "prim": return { k: "prim", name: e.name };
    case "path": {
      const name = e.segments[e.segments.length - 1] ?? "";
      const args = e.args.map((a) => resolveTyExpr(program, a, refs));
      const bound = refs.generics.get(name);
      if (bound) return bound;
      refs.out.set(name, { role: "type", name });
      const def = program.resolveType(name, refs.module);
      return def === null ? TY_ERR : { k: "named", def, args };
    }
    case "record":
      return {
        k: "record",
        fields: e.fields.map((f) => ({
          name: f.name, ty: resolveTyExpr(program, f.ty, refs), attrs: attrNames(f.attrs),
        })),
      };
    case "tuple": return { k: "tuple", elems: e.elems.map((el) => resolveTyExpr(program, el, refs)) };
    case "slice": {
      const elem = resolveTyExpr(program, e.elem, refs);
      return e.len === null ? { k: "slice", elem } : { k: "array", elem, len: e.len };
    }
    case "option": return { k: "option", inner: resolveTyExpr(program, e.inner, refs) };
    case "ptr": return { k: "ptr", mutable: e.mutable, inner: resolveTyExpr(program, e.inner, refs) };
    case "own": return { k: "own", ownership: e.ownership, inner: resolveTyExpr(program, e.inner, refs) };
    case "fnptr":
      return {
        k: "fnptr", params: e.params.map((p) => resolveTyExpr(program, p, refs)),
        ret: resolveTyExpr(program, e.ret, refs), effects: [...e.effects].sort(),
      };
    case "impl": return TY_ERR;
  }
}

/** Best-effort type of a value expression, used for unannotated locals. */
function inferExprTy(program: Program, e: Expr, refs: Refs): Ty {
  switch (e.kind) {
    case "int": return { k: "prim", name: "u64" };
    case "float": return { k: "prim", name: "f64" };
    case "bool": return { k: "prim", name: "bool" };
    case "char": return { k: "prim", name: "char" };
    case "string": return { k: "named", def: BUILTIN.Text_, args: [] };
    case "bytes": return { k: "named", def: BUILTIN.Bytes_, args: [] };
    case "path": {
      const def = program.resolveType(e.value, refs.module);
      return def === null ? TY_ERR : { k: "named", def, args: [] };
    }
    case "struct": {
      const def = program.resolveType(e.path, refs.module);
      return def === null ? TY_ERR : { k: "named", def, args: [] };
    }
    case "cast": return resolveTyExpr(program, e.ty, refs);
    case "try": return inferExprTy(program, e.operand, refs);
    case "unary": return inferExprTy(program, e.operand, refs);
    case "binary": return inferExprTy(program, e.lhs, refs);
    case "view": {
      const inner = inferExprTy(program, e.operand, refs);
      return { k: "own", ownership: e.mutable ? "viewmut" : "view", inner };
    }
    case "array": {
      const elems = e.elems.map((el) => inferExprTy(program, el, refs));
      const first = elems[0];
      return first === undefined ? { k: "slice", elem: TY_ERR } : { k: "slice", elem: first };
    }
    case "tuple": return { k: "tuple", elems: e.elems.map((el) => inferExprTy(program, el, refs)) };
    case "block": return e.block.tail ? inferExprTy(program, e.block.tail, refs) : TY_ERR;
    case "call": {
      if (e.callee.kind !== "path") return TY_ERR;
      const id = program.resolveFn(e.callee.value, refs.module);
      const info = id === null ? undefined : program.fnInfo.get(id);
      return info ? resolveTyExpr(program, info.fn.ret, refs) : TY_ERR;
    }
    case "method": {
      const id = program.resolveFn(e.name, refs.module);
      const info = id === null ? undefined : program.fnInfo.get(id);
      return info ? resolveTyExpr(program, info.fn.ret, refs) : TY_ERR;
    }
    default: return TY_ERR;
  }
}

// ---------------------------------------------------------------------------
// Body walk: reference collection + name-free structural fingerprint
// ---------------------------------------------------------------------------

function walkBlock(refs: Refs, b: Block): void {
  for (const s of b.stmts) walkStmt(refs, s);
  if (b.tail) walkExpr(refs, b.tail);
}

function walkStmt(refs: Refs, s: Stmt): void {
  switch (s.kind) {
    case "let":
      refs.shape.push("let");
      if (s.ty) resolveTyExpr(refs.program, s.ty, refs);
      if (s.init) walkExpr(refs, s.init);
      return;
    case "expr": walkExpr(refs, s.expr); return;
    case "assign": walkExpr(refs, s.target); walkExpr(refs, s.value); refs.shape.push("assign"); return;
    case "item": refs.shape.push("item"); return;
  }
}

function walkExpr(refs: Refs, e: Expr): void {
  const push = (token: string): void => { refs.shape.push(token); };
  switch (e.kind) {
    // Literal values are meaning: `a + 1` and `a + 2` are not the same function.
    case "int": push(`int:${e.value}`); return;
    case "float": push(`float:${e.value}`); return;
    case "bool": push(`bool:${e.value}`); return;
    case "string": push(`str:${e.value}`); return;
    case "bytes": push(`bytes:${e.value.length}`); return;
    case "char": push(`char:${e.value}`); return;
    case "path":
      push("path");
      refs.out.set(e.value, { role: "ref", name: e.value });
      return;
    case "call":
      push("call");
      if (e.callee.kind === "path") refs.out.set(e.callee.value, { role: "call", name: e.callee.value });
      else walkExpr(refs, e.callee);
      for (const a of e.args) walkExpr(refs, a);
      for (const t of e.typeArgs ?? []) resolveTyExpr(refs.program, t, refs);
      return;
    case "method":
      push("method");
      refs.out.set(e.name, { role: "call", name: e.name });
      walkExpr(refs, e.base);
      for (const a of e.args) walkExpr(refs, a);
      for (const t of e.typeArgs ?? []) resolveTyExpr(refs.program, t, refs);
      return;
    case "struct":
      push("struct");
      refs.out.set(e.path, { role: "type", name: e.path });
      for (const f of e.fields) walkExpr(refs, f.value);
      return;
    case "field":
      push("field");
      walkExpr(refs, e.base);
      return;
    case "index":
      push("index");
      walkExpr(refs, e.base);
      walkExpr(refs, e.index);
      return;
    case "unary": push(`un${e.op}`); walkExpr(refs, e.operand); return;
    case "binary": push(`bin${e.op}`); walkExpr(refs, e.lhs); walkExpr(refs, e.rhs); return;
    case "assign": push("assign"); walkExpr(refs, e.target); walkExpr(refs, e.value); return;
    case "try": push("try"); walkExpr(refs, e.operand); return;
    case "cast": push("cast"); walkExpr(refs, e.operand); resolveTyExpr(refs.program, e.ty, refs); return;
    case "is": push("is"); walkExpr(refs, e.base); resolveTyExpr(refs.program, e.ty, refs); return;
    case "move": push("move"); walkExpr(refs, e.operand); return;
    case "view": push(e.mutable ? "view!" : "view"); walkExpr(refs, e.operand); return;
    case "tohandle": push("tohandle"); walkExpr(refs, e.operand); return;
    case "array": push("array"); for (const el of e.elems) walkExpr(refs, el); return;
    case "tuple": push("tuple"); for (const el of e.elems) walkExpr(refs, el); return;
    case "block": push("block"); walkBlock(refs, e.block); return;
    case "if":
      push("if");
      walkExpr(refs, e.cond);
      walkBlock(refs, e.then);
      if (e.else_ !== undefined) {
        if ("stmts" in e.else_) walkBlock(refs, e.else_);
        else walkExpr(refs, e.else_);
      }
      return;
    case "while": push("while"); walkExpr(refs, e.cond); walkBlock(refs, e.body); return;
    case "loop": push("loop"); walkBlock(refs, e.body); return;
    case "for": push("for"); walkPattern(refs, e.pat); walkExpr(refs, e.iter); walkBlock(refs, e.body); return;
    case "match":
      push(`match${e.arms.length}`);
      walkExpr(refs, e.scrutinee);
      for (const arm of e.arms) { walkPattern(refs, arm.pat); walkExpr(refs, arm.body); }
      return;
    case "return": push("return"); if (e.value) walkExpr(refs, e.value); return;
    case "break": push("break"); if (e.value) walkExpr(refs, e.value); return;
    case "continue": push("continue"); return;
    case "effectset": push(`eff{${[...e.effects].sort().join(",")}}`); return;
    case "unsafe": push("unsafe"); walkBlock(refs, e.body); return;
    case "spawn": push("spawn"); walkBlock(refs, e.body); return;
    case "consteval": push("const"); walkBlock(refs, e.body); return;
    default: return;
  }
}

function walkPattern(refs: Refs, p: Pattern): void {
  switch (p.kind) {
    case "bind":
      refs.shape.push("bind");
      if (p.ty) resolveTyExpr(refs.program, p.ty, refs);
      return;
    case "unit": refs.out.set(p.path, { role: "type", name: p.path }); refs.shape.push("unit"); return;
    case "tuple":
      refs.out.set(p.path, { role: "type", name: p.path });
      refs.shape.push("ptuple");
      for (const e of p.elems) walkPattern(refs, e);
      return;
    case "record":
      refs.out.set(p.path, { role: "type", name: p.path });
      refs.shape.push("precord");
      for (const f of p.fields) walkPattern(refs, f.pat);
      return;
    case "at": refs.shape.push("at"); walkPattern(refs, p.sub); return;
    case "or": refs.shape.push("or"); for (const a of p.alts) walkPattern(refs, a); return;
    default: refs.shape.push(p.kind); return;
  }
}

// ---------------------------------------------------------------------------
// Finalize: resolve edges, break cycles, hash
// ---------------------------------------------------------------------------

/**
 * The canonical semantic form a hash is taken over. It is independent of whitespace,
 * comments, formatting and of *names*: a named type is rendered through its own content
 * hash, and dependencies enter only as hashes. Two definitions with the same meaning
 * therefore hash identically no matter what they are called.
 */
function canonicalOf(
  kind: NodeKind,
  typeForm: string,
  effects: readonly string[],
  ownership: NodeOwnership,
  attrs: readonly string[],
  shape: string,
  depTokens: readonly string[],
  valueName: string,
): string {
  return canonicalForm([
    [`kind=${kind}`],
    [`type=${typeForm}`],
    [`effects=${[...effects].sort().join(",")}`],
    [`ownership=${ownership}`],
    [`attrs=${[...attrs].sort().join(",")}`],
    [`shape=${shape}`],
    [`value=${valueName}`],
    [`deps=${[...depTokens].sort().join(",")}`],
  ]);
}

const DEFINITION_KINDS: readonly NodeKind[] = ["type", "fn", "const", "test", "trait", "impl"];

function isDefinition(d: NodeDraft): boolean {
  return DEFINITION_KINDS.includes(d.kind);
}

function sourceDepth(sourceId: string): number {
  return sourceId.split("::").length;
}

/** Iterative Tarjan: component id per node plus a dependency order over components. */
function sccOrder(
  n: number,
  edgesOf: (i: number) => number[],
): { comp: Int32Array; order: Int32Array } {
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const comp = new Int32Array(n).fill(-1);
  const onStack = new Set<number>();
  const stack: number[] = [];
  let counter = 0;
  let comps = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const work: Array<[number, number]> = [[root, 0]];
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const u = frame[0];
      if (frame[1] === 0) {
        index[u] = counter;
        low[u] = counter;
        counter++;
        stack.push(u);
        onStack.add(u);
      }
      const es = edgesOf(u);
      let descended = false;
      while (frame[1] < es.length) {
        const w = es[frame[1]]!;
        frame[1]++;
        if (index[w] === -1) {
          work.push([w, 0]);
          descended = true;
          break;
        }
        if (onStack.has(w) && index[w]! < low[u]!) low[u] = index[w]!;
      }
      if (descended) continue;
      if (low[u] === index[u]) {
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          comp[w] = comps;
          if (w === u) break;
        }
        comps++;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined && low[u]! < low[parent[0]]!) low[parent[0]] = low[u]!;
    }
  }
  const deps = new Map<number, Set<number>>();
  for (let i = 0; i < n; i++) {
    const c = comp[i]!;
    if (c === -1) continue;
    const set = deps.get(c) ?? new Set<number>();
    for (const w of edgesOf(i)) if (comp[w] !== c) set.add(comp[w]!);
    deps.set(c, set);
  }
  const remaining = new Map(deps);
  const order = new Int32Array(comps).fill(-1);
  let placed = 0;
  while (remaining.size > 0) {
    let pick = -1;
    for (const [c, need] of remaining) {
      let ready = true;
      for (const d of need) if (remaining.has(d)) { ready = false; break; }
      if (ready) { pick = c; break; }
    }
    if (pick === -1) for (const c of remaining.keys()) { pick = c; break; }
    remaining.delete(pick);
    order[pick] = placed++;
  }
  return { comp, order };
}

/**
 * Field and variant names are part of the meaning of a type — they are its wire schema.
 * Every other name is an identity, not meaning, and stays out of the hash, so renaming a
 * function or a parameter cannot change what it means.
 */
function valueName(d: NodeDraft): string {
  return d.kind === "field" || d.kind === "variant" ? d.name : "";
}

/**
 * A type rendered with every named type replaced by that type's content hash. This is
 * what makes a rename invisible to the hash while a type *change* stays visible.
 */
function structuralTy(
  t: Ty,
  ctx: NodeDraft,
  typeHashByDefId: ReadonlyMap<number, string>,
): string {
  switch (t.k) {
    case "prim": return t.name;
    case "var": return t.bound ? structuralTy(t.bound, ctx, typeHashByDefId) : `$${t.name}`;
    case "err": return "?";
    case "record":
      return t.fields.length === 0
        ? "{}"
        : `{${t.fields.map((f) => `${f.name}:${structuralTy(f.ty, ctx, typeHashByDefId)}`).join(",")}}`;
    case "tuple": return `(${t.elems.map((e) => structuralTy(e, ctx, typeHashByDefId)).join(",")})`;
    case "slice": return `[${structuralTy(t.elem, ctx, typeHashByDefId)}]`;
    case "array": return `[${structuralTy(t.elem, ctx, typeHashByDefId)};${t.len}]`;
    case "option": return `?${structuralTy(t.inner, ctx, typeHashByDefId)}`;
    case "result":
      return `Result<${structuralTy(t.ok, ctx, typeHashByDefId)},${structuralTy(t.err, ctx, typeHashByDefId)}>`;
    case "ptr": return `*${t.mutable ? "mut" : "const"} ${structuralTy(t.inner, ctx, typeHashByDefId)}`;
    case "own":
      return t.ownership === "owned"
        ? structuralTy(t.inner, ctx, typeHashByDefId)
        : `${t.ownership} ${structuralTy(t.inner, ctx, typeHashByDefId)}`;
    case "fnptr":
      return `fn(${t.params.map((p) => structuralTy(p, ctx, typeHashByDefId)).join(",")})->${structuralTy(t.ret, ctx, typeHashByDefId)}`;
    case "named": {
      if (ctx.kind === "type" && ctx.defId !== null && t.def === ctx.defId) return "SELF";
      const h = typeHashByDefId.get(t.def);
      if (h === undefined) return `#${t.def}`;
      return t.args.length
        ? `#${h}<${t.args.map((a) => structuralTy(a, ctx, typeHashByDefId)).join(",")}>`
        : `#${h}`;
    }
  }
}

function finalize(program: Program, drafts: NodeDraft[], options: GraphOptions): SemanticGraph {
  void program;
  const n = drafts.length;
  const bySourceId = new Map<string, number>();
  const byQualName = new Map<string, number>();
  drafts.forEach((d, i) => {
    if (!bySourceId.has(d.sourceId)) bySourceId.set(d.sourceId, i);
    if (isDefinition(d) && !byQualName.has(d.qualName)) byQualName.set(d.qualName, i);
  });

  // 1. Edges, in draft-index space. Every edge target is a node, never a name.
  const edges: number[][] = drafts.map(() => []);
  const roles: EdgeRole[][] = drafts.map(() => []);
  const pushEdge = (from: number, to: number, role: EdgeRole): void => {
    if (to === from) return;
    edges[from]!.push(to);
    roles[from]!.push(role);
  };
  drafts.forEach((d, i) => {
    for (const r of d.refs) {
      // A reference resolves in its own module first, then across the package when the
      // name is unique. A bare-name lookup that only searched the defining module would
      // silently drop every cross-module edge, and with it the whole dependency graph.
      const local = bySourceId.get(`${d.module}::${r.name}`);
      const target = local ?? byQualName.get(r.name);
      if (target !== undefined) {
        pushEdge(i, target, r.role);
        continue;
      }
      // `a::b` written explicitly, or a single-segment name that is unique package-wide.
      for (const [sourceId, idx] of bySourceId) {
        const tail = sourceId.slice(sourceId.lastIndexOf("::") + 1);
        if (tail !== r.name) continue;
        if (byQualName.has(r.name)) continue; // ambiguous: another module also defines it
        pushEdge(i, idx, r.role);
        break;
      }
    }
    if (d.parent !== null) {
      const p = bySourceId.get(d.parent);
      if (p !== undefined) pushEdge(i, p, "parent");
    }
  });

  // 2. Descendants: a type's fields and variants are part of its meaning.
  const children = new Map<number, number[]>();
  drafts.forEach((d, i) => {
    if (d.parent === null) return;
    const p = bySourceId.get(d.parent);
    if (p === undefined) return;
    const list = children.get(p) ?? [];
    list.push(i);
    children.set(p, list);
  });
  const descendants = (i: number): number[] => {
    const out: number[] = [];
    const stack = [...(children.get(i) ?? [])];
    while (stack.length > 0) {
      const c = stack.pop()!;
      out.push(c);
      stack.push(...(children.get(c) ?? []));
    }
    return out.sort((a, b) => sourceDepth(drafts[a]!.sourceId) - sourceDepth(drafts[b]!.sourceId) || a - b);
  };

  // 3. Type hashes first: everything that mentions a type renders it by content hash.
  const typeDefs = drafts
    .map((d, i) => (d.kind === "type" && d.parent === null ? i : -1))
    .filter((i) => i >= 0);
  const typeSet = new Set(typeDefs);
  const typeRefTargets = (i: number): number[] => {
    const out = new Set<number>();
    for (const j of [i, ...descendants(i)]) {
      for (const w of edges[j] ?? []) if (typeSet.has(w)) out.add(w);
    }
    return [...out];
  };
  const typeScc = sccOrder(n, (i) => (typeSet.has(i) ? typeRefTargets(i) : []));
  const hashOf = new Map<number, string>();
  const canonicalOfDraft = new Map<number, string>();
  const typeHashByDefId = new Map<number, string>();
  const typeToken = (from: number, w: number): string =>
    typeScc.comp[from] === typeScc.comp[w] ? "SELF" : (hashOf.get(w) ?? "?");
  const orderedTypes = [...typeDefs].sort(
    (a, b) => typeScc.order[typeScc.comp[a]!]! - typeScc.order[typeScc.comp[b]!]! || a - b,
  );
  for (const i of orderedTypes) {
    const memberHashes: string[] = [];
    for (const m of descendants(i)) {
      const md = drafts[m]!;
      const canonical = canonicalOf(
        md.kind, structuralTy(md.resolvedTy ?? TY_ERR, md, typeHashByDefId), [], md.ownership,
        md.attrs, md.shape, edges[m]!.filter((w) => typeSet.has(w)).map((w) => typeToken(m, w)),
        valueName(md),
      );
      hashOf.set(m, contentHash(canonical));
      canonicalOfDraft.set(m, canonical);
      memberHashes.push(hashOf.get(m)!);
    }
    const d = drafts[i]!;
    const canonical = canonicalOf(
      d.kind, memberHashes.join(","), [], d.ownership, d.attrs, d.shape,
      typeRefTargets(i).map((w) => typeToken(i, w)), "",
    );
    const h = contentHash(canonical);
    hashOf.set(i, h);
    canonicalOfDraft.set(i, canonical);
    if (d.defId !== null) typeHashByDefId.set(d.defId, h);
  }

  // 4. The rest. Function-level recursion is broken with `SELF`: the edge is real, the
  //    name is not an input to the hash.
  const defEdges = (i: number): number[] => edges[i]!.filter((w) => isDefinition(drafts[w]!));
  const defScc = sccOrder(n, defEdges);
  const defToken = (i: number, w: number): string =>
    defScc.comp[i] === defScc.comp[w] ? "SELF" : (hashOf.get(w) ?? "?");
  const defs = drafts.map((d, i) => (isDefinition(d) ? i : -1)).filter((i) => i >= 0);
  const orderedDefs = [...defs].sort(
    (a, b) => defScc.order[defScc.comp[a]!]! - defScc.order[defScc.comp[b]!]! || a - b,
  );
  const finish = (i: number): void => {
    if (hashOf.has(i)) return;
    const d = drafts[i]!;
    const canonical = canonicalOf(
      d.kind, structuralTy(d.resolvedTy ?? TY_ERR, d, typeHashByDefId), d.effects, d.ownership,
      d.attrs, d.shape, defEdges(i).map((w) => defToken(i, w)), valueName(d),
    );
    hashOf.set(i, contentHash(canonical));
    canonicalOfDraft.set(i, canonical);
  };
  for (const i of orderedDefs) finish(i);
  const nested = drafts
    .map((d, i) => ({ d, i }))
    .filter(({ d, i }) => !isDefinition(d) && !hashOf.has(i))
    .sort((a, b) => sourceDepth(a.d.sourceId) - sourceDepth(b.d.sourceId) || a.i - b.i);
  for (const { i } of nested) {
    const d = drafts[i]!;
    const canonical = canonicalOf(
      d.kind, structuralTy(d.resolvedTy ?? TY_ERR, d, typeHashByDefId), d.effects, d.ownership,
      d.attrs, d.shape, edges[i]!.map((w) => hashOf.get(w) ?? "?"), valueName(d),
    );
    hashOf.set(i, contentHash(canonical));
    canonicalOfDraft.set(i, canonical);
  }

  // 5. Materialise the nodes.
  const nodes: SemanticNode[] = drafts.map((d, i) => {
    const depEdges: DepEdge[] = edges[i]!.map((w, k) => ({
      hash: hashOf.get(w) ?? "",
      role: roles[i]![k]!,
    }));
    const parentIdx = d.parent === null ? undefined : bySourceId.get(d.parent);
    const canonical = canonicalOfDraft.get(i) ?? "";
    return {
      hash: hashOf.get(i)!,
      sourceId: d.sourceId,
      alias: null,
      kind: d.kind,
      module: d.module,
      name: d.name,
      typeHash: contentHash(structuralTy(d.resolvedTy ?? TY_ERR, d, typeHashByDefId)),
      renderedType: d.typeForm,
      effectSet: [...d.effects].sort(),
      ownership: d.ownership,
      span: d.span,
      deps: [...new Set(depEdges.map((e) => e.hash))].sort(),
      depEdges,
      revision: revisionFrom(options.previous, hashOf.get(i) ?? "", canonical),
      attributes: [...d.attrs].sort(),
      parent: parentIdx === undefined ? null : (hashOf.get(parentIdx) ?? null),
      defId: d.defId,
      canonical,
    };
  });
  return new SemanticGraph(program, nodes);
}

function revisionFrom(previous: SemanticGraph | undefined, hash: string, canonical: string): number {
  const old = previous?.byHash(hash);
  if (!old) return 1;
  return old.canonical === canonical ? old.revision : old.revision + 1;
}


