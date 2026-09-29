/**
 * MM — Type→System lowering and System Plan verification.
 *
 * The claim being implemented: *a declared high-level type or effect can synthesize the
 * lower-level resources, interfaces, validation, policy, and run-time machinery required
 * to make that type operational.* `@wire Job` becomes a schema with a version and an
 * encoder; `@secret Token` becomes a redaction rule; `!{net}` becomes a policy request.
 *
 * The plan is a checkable artifact, not documentation. `verifySystem` enforces the three
 * invariants the report names:
 *
 *   effect conservation     Effects(T(P)) ⊆ Effects(P) ∪ Effects(synthesized, recorded)
 *   capability non-escalation  Capabilities(child) ⊆ Capabilities(parent)
 *   trust monotonicity      Decision<T> never satisfies an authority requirement
 *
 */

import type { AttrArg, Block, Diagnostic, Expr, Span, Stmt } from "./ast.ts";
import { type Ty, BUILTIN, deepResolve, deepUnown, unify, unown } from "./types.ts";
import type { Checker } from "./scope.ts";
import { AUTHORITY_EFFECTS, isSubset, sortedUnique } from "./effects.ts";
import { builtinFnById, builtinFnId, resolveMiniType } from "./builtins.ts";
import type { FnInfo, Program } from "./program.ts";

/** One synthesized system resource, keyed by the type or effect it came from. */
export interface SystemEntry {
  /** Stable within a plan; the graph hashes by content, not by this number. */
  readonly id: number;
  readonly kind: "wire" | "secret" | "resource" | "persist" | "decision" | "capability" | "stream";
  /** `module::Name` of the type this was synthesized from, or the effect name. */
  readonly source: string;
  /** Schema version for `@wire`, derived from the field list so it changes with meaning. */
  readonly schemaVersion: string;
  /** Effects this entry requests from the host. */
  readonly effects: readonly string[];
  readonly span: Span;
  /** Set when the entry was synthesized rather than written by hand. */
  readonly synthesized: boolean;
}

export interface SystemPlan {
  readonly entries: readonly SystemEntry[];
  /** Union of every authority request in the program. The host grants a subset. */
  readonly requested: readonly string[];
  /** Entry points: `@intent` functions and each module's public surface. */
  readonly entryPoints: readonly SystemEntry[];
}

export function lowerToSystem(c: Checker): SystemPlan | null {
  const program = c.program;
  const entries: SystemEntry[] = [];
  const entryPoints: SystemEntry[] = [];
  let nextId = 0;

  for (const info of program.allTypes()) {
    const decl = findDecl(program, info.id);
    if (!decl) continue;
    const span = info.nameSpan;

    if (info.isWire) {
      const version = wireSchemaVersion(c, info.id);
      const e: SystemEntry = {
        id: nextId++, kind: "wire", source: `${info.module}::${info.name}`,
        schemaVersion: version, effects: [], span, synthesized: true,
      };
      entries.push(e);
      // kernel.md A-2: a wire schema must not serialize a secret.
      if (containsSecretField(c, info.id)) {
        c.error(
          "E0701", "wire_over_secret",
          `\`@wire ${info.name}\` contains a \`@secret\` field; a wire schema must not serialize a secret`,
          span,
          { repairs: [] },
        );
      }
    }

    if (info.isSecret) {
      entries.push({
        id: nextId++, kind: "secret", source: `${info.module}::${info.name}`,
        schemaVersion: "1", effects: ["secret.read"], span, synthesized: true,
      });
    }

    if (info.isResource) {
      checkResourceContract(c, program, info, decl);
      entries.push({
        id: nextId++, kind: "resource", source: `${info.module}::${info.name}`,
        schemaVersion: "1", effects: ["fs.close"], span, synthesized: true,
      });
    }

    if (info.isPersist) {
      // kernel.md A-3: a persisted type needs a `@wire`-encodable key.
      if (!info.isWire) {
        c.error(
          "E0702", "persist_key_not_wire",
          `\`@persist ${info.name}\` must also be \`@wire\`: its key has to be encodable for the store`,
          span,
          { repairs: [] },
        );
      }
      entries.push({
        id: nextId++, kind: "persist", source: `${info.module}::${info.name}`,
        schemaVersion: info.ttl ? `ttl:${info.ttl}` : "1", effects: [], span, synthesized: true,
      });
    }
  }

  // Effects become capability requests, one entry per distinct authority effect.
  const requested = collectRequestedEffects(program);
  for (const eff of requested) {
    entries.push({
      id: nextId++, kind: "capability", source: eff,
      schemaVersion: "1",
      effects: AUTHORITY_EFFECTS[eff] ? [eff] : [],
      span: firstEffectSpan(program, eff),
      synthesized: true,
    });
  }

  // `@intent` functions become typed decision endpoints.
  for (const fn of program.allFns()) {
    if (!fn.attrs.includes("intent")) continue;
    const e: SystemEntry = {
      id: nextId++, kind: "decision", source: `${fn.module}::${fn.name}`,
      schemaVersion: decisionSchemaVersion(c, fn),
      effects: sortedUnique([...fn.effects]),
      span: fn.nameSpan,
      synthesized: true,
    };
    entries.push(e);
    entryPoints.push(e);
    // kernel.md §4.5: an intent endpoint returns a typed but untrusted decision.
    if (!returnsDecision(fn.retTy)) {
      c.error(
        "E0705", "intent_return_type",
        `\`@intent fn ${fn.name}\` must return \`Decision<Route>\`: an intent endpoint's whole purpose is a typed, untrusted decision`,
        fn.nameSpan,
        { repairs: [] },
      );
    }
  }

  for (const fn of program.allFns()) {
    if (fn.attrs.includes("intent")) continue;
    if (fn.visibility !== "pub") continue;
    entryPoints.push({
      id: nextId++, kind: "capability", source: `${fn.module}::${fn.name}`,
      schemaVersion: "1", effects: sortedUnique([...fn.effects]), span: fn.nameSpan,
      synthesized: false,
    });
  }

  return { entries, requested, entryPoints };
}

// ---------------------------------------------------------------------------
// Verification (kernel.md §5, §6.2)
// ---------------------------------------------------------------------------

export function verifySystem(c: Checker, plan: SystemPlan | null): void {
  if (!plan) return;
  const program = c.program;

  // Invariant 1 — effect conservation. Every effect a synthesized entry requests must
  // already be requested by the program, or be one of the effects Type→System is allowed
  // to add. Nothing here may invent authority.
  const programEffects = new Set(collectRequestedEffects(program));
  const SYNTHESIZABLE: Record<string, true> = {
    "secret.read": true, "fs.close": true, agent: true, nondet: true,
  };
  for (const entry of plan.entries) {
    for (const eff of entry.effects) {
      if (programEffects.has(eff)) continue;
      if (SYNTHESIZABLE[eff]) continue;
      c.error(
        "E0503", "effect_conservation",
        `synthesized \`${entry.kind}\` entry for \`${entry.source}\` requires \`${eff}\`, which the program does not request`,
        entry.span,
        { repairs: [], data: { entry: entry.source, effect: eff } },
      );
    }
  }

  // Invariant 2 — capability non-escalation. A call may not exercise more authority than
  // its caller holds, so a callee's effects must be a subset of the caller's.
  for (const caller of program.allFns()) {
    if (caller.fn.body.stmts.length === 0) continue;
    const held = new Set(caller.effects);
    for (const callee of calleesOf(c, caller)) {
      const child = callee.effects;
      if (isSubset(new Set(child), held)) continue;
      const extra = child.filter((e) => !held.has(e));
      c.error(
        "E0503", "capability_escalation",
        `\`${caller.name}\` calls \`${callee.name}\`, which needs ${extra.map((e) => `\`${e}\``).join(", ")} that \`${caller.name}\` does not hold`,
        caller.nameSpan,
        {
          repairs: extra.map((e) => ({ op: "add_effect" as const, effect: e, confidence: 0.8 })),
          data: { caller: caller.name, callee: callee.name, extra },
        },
      );
    }
  }

  // Invariant 3 — trust monotonicity, at the plan level: no entry may claim authority it
  // received from a decision. A `Decision` cannot appear in an `authority` position.
  for (const entry of plan.entries) {
    if (entry.kind !== "decision") continue;
    if (entry.effects.includes("secret.read") || entry.effects.includes("fs.write")) {
      c.error(
        "E0601", "decision_grants_authority",
        `intent endpoint \`${entry.source}\` requests \`${entry.effects.join(", ")}\` directly; a decision endpoint may only observe, never act`,
        entry.span,
        { repairs: [] },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Attribute rules
// ---------------------------------------------------------------------------

/** kernel.md A-4: a resource's close function must accept the resource's handle. */
function checkResourceContract(
  c: Checker,
  program: Program,
  info: { name: string; id: number; nameSpan: Span; ty?: Ty },
  decl: { attrs: readonly { name: string; args: Record<string, AttrArg> }[] },
): void {
  const attr = decl.attrs.find((a) => a.name === "resource");
  const closeArg = attr?.args["close"];
  if (!closeArg) {
    c.error(
      "E0703", "resource_without_close",
      `\`@resource ${info.name}\` must name a close function: \`@resource(close = fs.close)\``,
      info.nameSpan,
      { repairs: [] },
    );
    return;
  }
  const segments = closeArg.kind === "path"
    ? closeArg.segments
    : closeArg.kind === "ident" ? [closeArg.name] : [];
  const qualified = segments.join(".");
  // A close function may be a compiler-known builtin (`fs.close`) or a user function.
  // Either way it has to accept the resource it closes: a builtin signature is just as
  // much a contract as a user one, and `fs.close` taking a `Text` is no closer to a
  // `Handle<Fd>` than a user function taking one would be.
  const builtinId = builtinFnId(qualified) !== Number.MIN_SAFE_INTEGER ? builtinFnId(qualified) : null;
  const lastSegment = segments[segments.length - 1] ?? "";
  const closeFn = program.allFns().find((f) => f.name === lastSegment);
  if (builtinId === null && !closeFn) {
    c.error(
      "E0703", "unknown_close_function",
      `\`@resource ${info.name}\` names \`${qualified}\` as its close function, which does not exist`,
      closeArg.span,
      { repairs: [] },
    );
    return;
  }
  const paramTys = builtinId !== null
    ? builtinFnById(builtinId)!.params.map((p) => resolveMiniType(p))
    : closeFn!.paramTys;
  // What matters is whether the close function accepts the thing being closed, and the
  // ownership discipline is incidental: `File` and `fs.close`'s `Handle<Fd>` are the same
  // resource even though only one carries the alias's name. Comparing the payload is
  // what still rejects `close_path(p: Text)`, which closes something else entirely.
  const closes = paramTys.some((t) => payloadMatches(t, info.ty));
  if (closes) return;
  // A close function that does not accept the resource would have the drop path hand it
  // something else entirely — a path where a handle is expected, say.
  c.error(
    "E0703", "bad_ffi_ownership_contract",
    `\`@resource ${info.name}\` names \`${qualified}\` as its close function, but that function does not accept \`${info.name}\`; a close function must take the resource it closes`,
    closeArg.span,
    {
      repairs: [],
      data: { resource: info.name, closeFn: qualified, closeParams: paramTys.length },
    },
  );
}

/**
 * Whether a close function's parameter denotes the same resource as the type it closes.
 *
 * Ownership wrappers and the alias's own name are incidental; the payload is what
 * identifies the resource. `File = Handle<Fd>` and a `Handle<Fd>` parameter are the same
 * resource; a `Text` parameter is not, and that is exactly the A-4 mismatch.
 */
function payloadMatches(param: Ty, resource: Ty | undefined): boolean {
  if (!resource) return false;
  return unify(deepUnown(param), deepUnown(resource), new Map()) === null;
}

/** Whether a type mentions a given definition, following aliases and ownership wrappers. */
function mentionsType(t: Ty, defId: number): boolean {
  const r = deepResolve(t);
  if (r.k === "own") {
    // A `type File = Handle<Fd>` resolves to the handle discipline and keeps only the
    // `resourceOf` marker, so that is where the resource's identity now lives.
    if (r.resourceOf === defId) return true;
    return mentionsType(r.inner, defId);
  }
  if (r.k === "named" && r.def === defId) return true;
  if (r.k === "named") return r.args.some((a) => mentionsType(a, defId));
  if (r.k === "record") return r.fields.some((f) => mentionsType(f.ty, defId));
  return false;
}

function containsSecretField(c: Checker, defId: number): boolean {
  const fields = c.expand(defId, []);
  if (!fields) return false;
  for (const f of fields) {
    if (f.attrs.includes("secret")) return true;
    const r = deepResolve(f.ty);
    if (r.k === "named" && c.program.typeInfo.get(r.def)?.isSecret) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

/**
 * A wire schema's version is a hash of its field names and types, so it changes exactly
 * when the encoded bytes would change. It is deliberately content-derived rather than
 * hand-maintained, which is what makes `@persist` migration checks automatic.
 */
function wireSchemaVersion(c: Checker, defId: number): string {
  const fields = c.expand(defId, []) ?? [];
  const parts = fields
    .map((f) => `${f.name}:${renderMini(f.ty, c)}`)
    .sort();
  return hash8(`${defId >= 0 ? "w" : "b"}|${parts.join("|")}`);
}

function decisionSchemaVersion(c: Checker, fn: FnInfo): string {
  return hash8(
    `d|${renderMini(fn.retTy, c)}|${sortedUnique([...fn.effects]).join(",")}`,
  );
}

function renderMini(t: Ty, c: Checker): string {
  const r = deepResolve(unown(t));
  if (r.k === "prim") return r.name;
  if (r.k === "named") {
    const name = c.program.typeInfo.get(r.def)?.name ?? `#${r.def}`;
    return r.args.length ? `${name}<${r.args.map((a) => renderMini(a, c)).join(",")}>` : name;
  }
  if (r.k === "slice") return `[${renderMini(r.elem, c)}]`;
  if (r.k === "array") return `[${renderMini(r.elem, c)};${r.len}]`;
  if (r.k === "option") return `${renderMini(r.inner, c)}?`;
  if (r.k === "result") return `Result<${renderMini(r.ok, c)},${renderMini(r.err, c)}>`;
  if (r.k === "record") return `{${r.fields.map((f) => `${f.name}:${renderMini(f.ty, c)}`).join(",")}}`;
  if (r.k === "tuple") return `(${r.elems.map((e) => renderMini(e, c)).join(",")})`;
  return r.k;
}

/** A small, dependency-free, stable 32-bit string hash rendered as 8 hex digits. */
export function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Collection helpers
// ---------------------------------------------------------------------------

function collectRequestedEffects(program: Program): string[] {
  const out = new Set<string>();
  for (const fn of program.allFns()) for (const e of fn.effects) out.add(e);
  return sortedUnique([...out]);
}

function firstEffectSpan(program: Program, effect: string): Span {
  for (const fn of program.allFns()) {
    if (fn.effects.includes(effect)) return fn.nameSpan;
  }
  return program.allFns()[0]?.nameSpan ?? { start: 0, end: 0, file: 0 };
}

function calleesOf(c: Checker, caller: FnInfo): FnInfo[] {
  const facts = c.facts;
  void facts;
  const out = new Map<number, FnInfo>();
  for (const unit of c.program.units) {
    for (const fn of unit.fns) {
      if (fn.id !== caller.id) continue;
      for (const id of directCallees(c, fn.id)) {
        const info = c.program.fnInfo.get(id);
        if (info) out.set(id, info);
      }
    }
  }
  return [...out.values()];
}

function directCallees(c: Checker, fnId: number): number[] {
  const info = c.program.fnInfo.get(fnId);
  if (!info) return [];
  const out = new Set<number>();
  for (const e of walkCalls(info.fn.body)) {
    const rec = c.calls.get(key(e.span));
    if (rec) out.add(rec.callee);
  }
  return [...out];
}

function returnsDecision(t: Ty): boolean {
  const r = deepResolve(t);
  if (r.k === "named" && r.def === BUILTIN.Decision) return true;
  if (r.k === "result") return returnsDecision(r.ok);
  return false;
}

function findDecl(program: Program, id: number) {
  for (const unit of program.units) {
    const t = unit.types.find((x) => x.id === id);
    if (t) return t;
  }
  return null;
}

function walkCalls(node: { stmts: readonly Stmt[]; tail?: Expr }): Expr[] {
  const out: Expr[] = [];
  const visitExpr = (e: Expr): void => {
    if (e.kind === "call" || e.kind === "method") out.push(e);
    switch (e.kind) {
      case "call":
        e.args.forEach(visitExpr);
        return;
      case "method":
        visitExpr(e.base);
        e.args.forEach(visitExpr);
        return;
      case "field": visitExpr(e.base); return;
      case "index": visitExpr(e.base); visitExpr(e.index); return;
      case "unary": case "try": case "move": case "view": case "tohandle": case "cast":
        visitExpr(e.operand);
        return;
      case "binary": visitExpr(e.lhs); visitExpr(e.rhs); return;
      case "assign": visitExpr(e.target); visitExpr(e.value); return;
      case "struct": e.fields.forEach((f) => visitExpr(f.value)); return;
      case "array": case "tuple": e.elems.forEach(visitExpr); return;
      case "block": out.push(...walkCalls(e.block)); return;
      case "if":
        visitExpr(e.cond);
        out.push(...walkCalls(e.then));
        if (e.else_) {
          if ("kind" in e.else_) visitExpr(e.else_);
          else out.push(...walkCalls(e.else_));
        }
        return;
      case "match":
        visitExpr(e.scrutinee);
        e.arms.forEach((a) => visitExpr(a.body));
        return;
      case "while": visitExpr(e.cond); out.push(...walkCalls(e.body)); return;
      case "loop": case "unsafe": case "consteval": case "spawn": out.push(...walkCalls(e.body)); return;
      case "for": visitExpr(e.iter); out.push(...walkCalls(e.body)); return;
      case "return": case "break": if (e.value) visitExpr(e.value); return;
      default: return;
    }
  };
  node.stmts.forEach((s) => {
    if (s.kind === "let") { if (s.init) visitExpr(s.init); return; }
    if (s.kind === "assign") { visitExpr(s.value); return; }
    if (s.kind === "expr") visitExpr(s.expr);
  });
  if (node.tail) visitExpr(node.tail);
  return out;
}

function key(span: Span): number {
  return span.start * 4096 + span.end;
}

export type { Diagnostic };
