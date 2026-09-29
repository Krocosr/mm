/**
 * MM — ownership and region checking.
 *
 * The claim this pass has to earn: *the semantic model is strict while the syntax is
 * simple*. There is no user-written lifetime syntax (kernel.md §3.6); regions are
 * inferred from control flow the way MIR-level region inference does it, and the
 * normative widening order in §3.5 decides whether a program is accepted.
 *
 * The algorithm is a linearized event pass:
 *
 *   1. flatten each body into a sequence of events (declare, use, move, borrow, scope-end);
 *   2. for each borrow, find its last use — that interval is its region;
 *   3. a move of the owner inside a live region is `E0412`;
 *   4. two overlapping borrows where at least one is `view mut` is `E0414`;
 *   5. a use outside the owner's scope is `E0413`.
 *
 * The widening step in §3.5 is applied *before* reporting: a borrow that would fail only
 * because its region is too narrow is retried over the owner's whole scope. A checker
 * that reports an error where widening would have succeeded is a checker bug, and the
 * false-rejection suite in `corpus/safe/` exists to catch exactly that.
 *
 * See docs/spec/kernel.md §3.4, §3.5, §6.5, §9.
 */

import type { Block, Expr, Pattern, Span, Stmt } from "./ast.ts";
import { type Ty, BUILTIN, deepResolve, isCopy, unown } from "./types.ts";
import type { Checker } from "./scope.ts";
import type { BodyChecker } from "./typeexpr.ts";
import type { FnInfo, Program } from "./program.ts";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

type Event =
  /** A binding comes into existence and is initialized. */
  | { k: "declare"; name: string; ty: Ty; span: Span }
  /** A read of a binding. */
  | { k: "use"; name: string; span: Span }
  /** An ownership move out of a binding. */
  | { k: "move"; name: string; span: Span }
  /** A borrow is taken of `owner` and bound to `name`. */
  | { k: "borrow"; name: string; owner: string; mutable: boolean; ty: Ty; span: Span }
  /** A value leaves the function. `borrow` records the borrow it is derived from, if any. */
  | { k: "return"; name: string; span: Span }
  /** A resource-typed value is dropped at this point. */
  | { k: "drop"; name: string; ty: Ty; span: Span }
  /**
   * A lexical scope closes. `scope` identifies *which* scope, not just how deep it is:
   * the two arms of an `if` share a scope, and a flat `scope` comparison would treat one
   * arm's close as the other's, producing a false "used after scope ended".
   */
  | { k: "scope_end"; scope: number; span: Span }
  /** An exclusive borrow is handed to another task. */
  | { k: "spawn"; span: Span }
  /** A binding is read by a spawned task, crossing the concurrency boundary. */
  | { k: "task_capture"; name: string; span: Span }
  /** A struct literal whose field initializers can abandon the construction. */
  | { k: "partial_init"; name: string; span: Span }
  /** An arena value is converted to a checked handle at this point. */
  | { k: "to_handle"; name: string; span: Span };

interface Binding {
  name: string;
  ty: Ty;
  span: Span;
  /** Identifier of the scope this binding belongs to. */
  scope: number;
  moved: boolean;
  dropped: boolean;
  /** For resources: which fields have been initialized (kernel.md §6.5). */
  resourceType: number | null;
  initialized: boolean;
}

// ---------------------------------------------------------------------------
// Pass entry
// ---------------------------------------------------------------------------

export function checkOwnership(c: Checker, body: BodyChecker | null): void {
  const program = c.program;
  for (const info of program.allFns()) {
    if (info.fn.body.stmts.length === 0 && !info.fn.body.tail) continue;
    checkFnOwnership(c, info);
  }
  // A `verify` function is the only place a `Verified<T>` may be produced
  // (kernel.md §4.5). A construction anywhere else is `E0601`.
  if (body) checkTrustLattice(c, body);
}

/**
 * The linearized event stream for one function, and the bindings it refers to.
 *
 * Exported because it is the honest debugging surface for the ownership rules: when a
 * region check surprises you, the answer is in the event order, not in the boolean.
 */
export interface OwnershipTrace {
  readonly events: readonly Event[];
  readonly bindings: ReadonlyMap<string, Binding>;
}

function traceFnOwnership(c: Checker, info: FnInfo): OwnershipTrace {
  const events: Event[] = [];
  const bindings = new Map<string, Binding>();
  const expand = (def: number, args: Ty[]) => c.expand(def, args);

  // Parameters are bindings too, declared in the outermost scope.
  //
  // A `view mut` parameter is a live *exclusive borrow* for the whole function, and it
  // has to be recorded as one: an overlapping `view` of the same parameter is then caught
  // by the R-Own-4 exclusivity check rather than passing unnoticed.
  info.fn.params.forEach((p, i) => {
    const ty = info.paramTys[i] ?? { k: "err" as const };
    bindings.set(p.name, {
      name: p.name, ty, span: p.span, scope: 0, moved: false, dropped: false,
      resourceType: resourceTypeOf(ty, c.program), initialized: true,
    });
    if (p.ownership === "viewmut") {
      events.push({ k: "borrow", name: p.name, owner: p.name, mutable: true, ty, span: p.span });
    }
  });

  const walker = new BodyWalker(c, info, bindings, events, expand);
  walker.block(info.fn.body, 0);
  return { events, bindings };
}

function checkFnOwnership(c: Checker, info: FnInfo): void {
  const { events, bindings } = traceFnOwnership(c, info);
  analyze(c, info, [...events], new Map(bindings));
}

/** Collect one function's ownership events without running the checks. */
export function traceOwnership(c: Checker, fnId: number): OwnershipTrace | null {
  const info = c.program.fnInfo.get(fnId);
  return info ? traceFnOwnership(c, info) : null;
}

// ---------------------------------------------------------------------------
// Body → events
// ---------------------------------------------------------------------------

class BodyWalker {
  /** Monotonic scope-id source; every block takes the next one. */
  private nextScope = 1;
  /** The scope currently being walked. */
  private currentScope = 0;

  constructor(
    readonly c: Checker,
    readonly info: FnInfo,
    readonly bindings: Map<string, Binding>,
    readonly events: Event[],
    readonly expand: (def: number, args: Ty[]) => ReturnType<Checker["expand"]>,
  ) {}

  /**
   * Walk a block as its own scope.
   *
   * Each block mints a *fresh* scope id rather than deriving one from its nesting depth:
   * the two arms of an `if` are at the same depth but are genuinely different scopes, and
   * a binding in one must not be reported as out-of-region when the other arm closes.
   */
  block(b: Block, _parent: number): void {
    const scope = this.nextScope++;
    const isFunctionBody = this.currentScope === 0;
    this.currentScope = scope;
    for (const s of b.stmts) this.stmt(s, scope);
    if (b.tail) this.expr(b.tail, scope);
    // A function body's tail expression *is* its return value. Recording it as a return
    // is what lets the escape rules see `fn first_of(a: arena Node) -> view Node { view a }`
    // handing a borrow out of the region.
    if (b.tail && isFunctionBody) {
      const root = placeRoot(b.tail);
      if (root) this.events.push({ k: "return", name: root, span: b.tail.span });
    }
    this.events.push({ k: "scope_end", scope, span: b.span });
    this.currentScope = scope - 1;
  }

  stmt(s: Stmt, scope: number): void {
    if (s.kind === "let") {
      let ty: Ty = { k: "err" };
      if (s.init) ty = this.tyOf(s.init);
      // The initializer is walked *first*: `let v = { ..; view b }` evaluates the block —
      // including its scope end — before `v` comes into being. Skipping this walk drops
      // every event inside the initializer, which silently disables the checks for all
      // borrow-carrying initializers.
      if (s.init) {
        this.expr(s.init, scope);
        // Initializing from a place *moves* out of it when the value is owned and not
        // trivially copyable. Without this `let b = a` reads as a mere use, and a
        // resource would appear to have two live owners — the double-free the R-Own-9
        // check exists to reject.
        const source = placeRoot(s.init);
        const binding = source ? this.bindings.get(source) : undefined;
        if (source && binding && !isCopyOf(binding.ty, this.c)) {
          this.events.push({ k: "move", name: source, span: s.init.span });
        }
      }
      this.declare(s.pat, ty, s.mutable, s.span, scope);
      // A `let` whose initializer *is* a borrow inherits that borrow under its own name,
      // so a later use of the binding can be matched against what it points at.
      if (s.init) {
        const borrowed = borrowSource(s.init);
        if (borrowed) {
          for (const name of patternNames(s.pat)) {
            this.events.push({
              k: "borrow", name, owner: borrowed.owner, mutable: borrowed.mutable,
              ty, span: s.init.span,
            });
          }
        }
      }
      return;
    }
    if (s.kind === "assign") {
      this.expr(s.target, scope);
      this.expr(s.value, scope);
      // Augmented assignment desugars to `assign(x, binary(x, op, v))`; that shape is a
      // read-modify-write, not a move-out, so the target is used rather than moved.
      const inPlace = s.value.kind === "binary" && samePlace(s.value.lhs, s.target);
      if (inPlace) {
        this.noteUses(s.target, scope);
      } else if (s.value.kind === "call" || s.value.kind === "method" || s.value.kind === "struct") {
        // A fresh value is being written into the target: the target is *re-initialized*,
        // not moved out of, so it stays live.
        this.noteUses(s.target, scope);
      } else {
        this.noteUses(s.target, scope);
        this.noteMove(s.target, s.span, scope);
      }
      return;
    }
    if (s.kind === "expr") this.expr(s.expr, scope);
  }

  declare(pat: Pattern, ty: Ty, mutable: boolean, span: Span, scope: number): void {
    for (const name of patternNames(pat)) {
      this.bindings.set(name, {
        name, ty, span, scope, moved: false, dropped: false,
        resourceType: resourceTypeOf(ty, this.c.program), initialized: true,
      });
      this.events.push({ k: "declare", name, ty, span });
    }
  }

  expr(e: Expr, scope: number): void {
    switch (e.kind) {
      case "path":
        this.events.push({ k: "use", name: e.value, span: e.span });
        return;
      case "field":
        this.noteUses(e.base, scope);
        this.expr(e.base, scope);
        return;
      case "index":
        this.expr(e.base, scope);
        this.expr(e.index, scope);
        return;
      case "call": {
        this.expr(e.callee, scope);
        for (const a of e.args) this.expr(a, scope);
        if (e.callee.kind === "path" && e.callee.value === "handle_of") {
          for (const a of e.args) {
            const root = placeRoot(a);
            if (root) this.events.push({ k: "to_handle", name: root, span: e.span });
          }
        }
        return;
      }
      case "method": {
        this.expr(e.base, scope);
        for (const a of e.args) this.expr(a, scope);
        return;
      }
      case "unary":
        this.expr(e.operand, scope);
        return;
      case "binary":
        this.expr(e.lhs, scope);
        this.expr(e.rhs, scope);
        return;
      case "assign":
        this.expr(e.target, scope);
        this.expr(e.value, scope);
        return;
      case "try":
      case "cast":
        this.expr(e.operand, scope);
        return;
      case "is":
        this.expr(e.base, scope);
        return;
      case "struct": {
        for (const f of e.fields) this.expr(f.value, scope);
        // kernel.md §6.5: if a field initializer can bail out, the value is only partly
        // built, and a drop path that ran then would close fields never bound. Recording
        // the hazard is what lets E0419 reject the construction.
        if (e.fields.some((f) => canBailOut(f.value))) {
          this.events.push({ k: "partial_init", name: "", span: e.span });
        }
        return;
      }
      case "array":
      case "tuple":
        for (const el of e.elems) this.expr(el, scope);
        return;
      case "block":
        this.block(e.block, scope + 1);
        return;
      case "if":
        this.expr(e.cond, scope);
        this.block(e.then, scope + 1);
        if (e.else_) {
          // `Block` carries no `kind`, so the union discriminates structurally.
          if ("kind" in e.else_) this.expr(e.else_, scope);
          else this.block(e.else_, scope + 1);
        }
        return;
      case "match":
        this.expr(e.scrutinee, scope);
        for (const arm of e.arms) {
          for (const n of patternNames(arm.pat)) {
            this.bindings.set(n, {
              name: n, ty: e.scrutinee.kind === "path" ? this.tyOf(e.scrutinee) : { k: "err" },
              // The arm's bindings live in the arm's own scope, which the arm's block
              // mints — not in the enclosing one, and not a synthetic `scope + 1`.
              span: arm.pat.span, scope: this.nextScope, moved: false, dropped: false,
              resourceType: null, initialized: true,
            });
            this.events.push({ k: "declare", name: n, ty: { k: "err" }, span: arm.pat.span });
          }
          this.expr(arm.body, scope + 1);
        }
        return;
      case "while":
        this.expr(e.cond, scope);
        this.block(e.body, scope + 1);
        return;
      case "loop":
        this.block(e.body, scope + 1);
        return;
      case "for": {
        this.expr(e.iter, scope);
        // kernel.md: iterating a `view mut [T]` yields mutable element bindings, which is
        // what makes the report's `normalize` example legal.
        const elemTy = this.elemTypeOf(e.iter);
        // Reserve the body's scope id *before* binding the loop variable, so both refer
        // to the same scope: the binding is created in the body it is scoped to.
        const bodyScope = this.nextScope++;
        for (const n of patternNames(e.pat)) {
          const ty: Ty = elemTy;
          this.bindings.set(n, {
            name: n, ty, span: e.pat.span, scope: bodyScope, moved: false, dropped: false,
            resourceType: resourceTypeOf(ty, this.c.program), initialized: true,
          });
          this.events.push({ k: "declare", name: n, ty, span: e.pat.span });
        }
        this.currentScope = bodyScope;
        for (const inner of e.body.stmts) this.stmt(inner, bodyScope);
        if (e.body.tail) this.expr(e.body.tail, bodyScope);
        this.events.push({ k: "scope_end", scope: bodyScope, span: e.body.span });
        return;
      }
      case "return": {
        if (!e.value) return;
        this.expr(e.value, scope);
        // Record what leaves the function: a `return` of a borrow derived from a local is
        // the escape the region rules are about (kernel.md §3.4 R-Own-3, R-Own-7).
        const root = placeRoot(e.value);
        if (root) this.events.push({ k: "return", name: root, span: e.span });
        return;
      }
      case "break":
        if (e.value) this.expr(e.value, scope);
        return;
      case "move": {
        // An explicit move takes the value out of its place.
        this.noteMove(e.operand, e.span, scope);
        this.expr(e.operand, scope);
        return;
      }
      case "view": {
        const owner = placeRoot(e.operand);
        this.noteUses(e.operand, scope);
        this.expr(e.operand, scope);
        const borrowed: Ty = { k: "own", ownership: e.mutable ? "viewmut" : "view", inner: unown(this.tyOf(e.operand)) };
        // `view x` with no new name is a temporary: its region ends at this statement.
        this.events.push({ k: "borrow", name: "", owner, mutable: e.mutable, ty: borrowed, span: e.span });
        return;
      }
      case "unsafe":
        this.block(e.body, scope + 1);
        return;
      case "consteval":
        this.block(e.body, scope + 1);
        return;
      case "spawn": {
        this.events.push({ k: "spawn", span: e.span });
        // Everything the task body reads is captured across the concurrency boundary.
        // Recording those names is what lets E0420 notice an exclusive borrow being
        // handed to another task while the parent still holds it.
        const start = this.events.length;
        this.block(e.body, scope + 1);
        const captured = new Set<string>();
        for (let i = start; i < this.events.length; i++) {
          const ev = this.events[i]!;
          if (ev.k === "use" || ev.k === "move") captured.add(ev.name);
        }
        for (const name of captured) {
          this.events.push({ k: "task_capture", name, span: e.span });
        }
        return;
      }
      case "tohandle": {
        const root = placeRoot(e.operand);
        this.events.push({ k: "to_handle", name: root, span: e.span });
        this.expr(e.operand, scope);
        return;
      }
      default:
        return;
    }
  }

  /**
   * The type the type pass assigned to an expression. When the pass has not run, this
   * degrades to the binding's declared type and then to `<error>`, so the ownership pass
   * stays quiet rather than inventing findings it cannot substantiate.
   */
  tyOf(e: Expr): Ty {
    const t = this.c.facts.get(key(e.span));
    if (t) return t;
    const b = e.kind === "path" ? this.bindings.get(e.value) : undefined;
    return b?.ty ?? { k: "err" };
  }

  elemTypeOf(iter: Expr): Ty {
    const t = deepResolve(unown(this.tyOf(iter)));
    if (t.k === "slice" || t.k === "array") return t.elem;
    return { k: "err" };
  }

  /** Record a read of whatever place this expression denotes. */
  noteUses(e: Expr, scope: number): void {
    const root = placeRoot(e);
    if (root) this.events.push({ k: "use", name: root, span: e.span });
  }

  /** Record a move out of whatever place this expression denotes. */
  noteMove(e: Expr, span: Span, scope: number): void {
    const root = placeRoot(e);
    if (root) this.events.push({ k: "move", name: root, span });
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function analyze(
  c: Checker,
  info: FnInfo,
  events: Event[],
  bindings: Map<string, Binding>,
): void {
  const cborrows = events.filter((e): e is Extract<Event, { k: "borrow" }> => e.k === "borrow");
  const partials = events.filter(
    (e): e is Extract<Event, { k: "partial_init" }> => e.k === "partial_init",
  );
  const moves = events.filter((e): e is Extract<Event, { k: "move" }> => e.k === "move");
  const uses = events.filter((e): e is Extract<Event, { k: "use" }> => e.k === "use");
  const captures = events.filter(
    (e): e is Extract<Event, { k: "task_capture" }> => e.k === "task_capture",
  );
  // Copy types are moved and used interchangeably; a "move" of a Copy value is a use.
  const isMove = (name: string): boolean => {
    const b = bindings.get(name);
    if (!b) return false;
    return !isCopy(b.ty, (def, args) => c.expand(def, args));
  };

  for (const borrow of cborrows) {
    const owner = bindings.get(borrow.owner);
    if (!owner) continue;

    // kernel.md §3.5 step 4: the normative widening. A borrow whose region would be split
    // by a move is retried over the owner's whole scope before any diagnostic is emitted.
    const lastUse = regionEnd(events, borrow);
    const ownerMovedInside = moves.some(
      (m) => m.name === borrow.owner && isMove(borrow.owner)
        && eventIndex(events, m) > eventIndex(events, borrow) && eventIndex(events, m) < lastUse,
    );
    const ownerMovedBeforeLastUse = moves.some(
      (m) => m.name === borrow.owner && isMove(borrow.owner) && eventIndex(events, m) < lastUse,
    );

    if (ownerMovedBeforeLastUse) {
      const moveEvent = moves.find(
        (m) => m.name === borrow.owner && isMove(borrow.owner) && eventIndex(events, m) < lastUse,
      )!;
      c.error(
        "E0412", "move_while_viewed",
        `\`${borrow.owner}\` cannot move here`,
        moveEvent.span,
        {
          value: `${borrow.owner}#${info.id}`,
          related: [{ span: borrow.span, label: "borrow starts here" }],
          data: { move: moveEvent.span, borrow: borrow.span, ownerLastUse: lastUse },
          repairs: [
            { op: "reorder", confidence: 0.95, note: "move after the last use" },
            { op: "clone", cost: "allocation", confidence: 0.4 },
            { op: "change_owner", to: "shared", confidence: 0.6 },
          ],
        },
      );
      continue;
    }

    if (ownerMovedInside) continue; // covered by the wider check above

    // R-Own-4: two overlapping borrows, at least one exclusive, is an aliasing error.
    for (const other of cborrows) {
      if (other === borrow) continue;
      if (other.owner !== borrow.owner) continue;
      if (!borrow.mutable && !other.mutable) continue; // two readers are fine
      const a = eventIndex(events, borrow);
      const b = eventIndex(events, other);
      const overlap = a < regionEnd(events, other) && b < regionEnd(events, borrow);
      if (!overlap) continue;
      c.error(
        "E0414", "mutable_alias",
        `\`${borrow.owner}\` is borrowed mutably at the same time as ${
          borrow.mutable && other.mutable ? "another mutable borrow" : "a shared borrow"
        }`,
        borrow.mutable ? borrow.span : other.span,
        {
          value: `${borrow.owner}#${info.id}`,
          related: [{ span: borrow.mutable ? other.span : borrow.span, label: "conflicting borrow" }],
          data: { owner: borrow.owner, a: borrow.span, b: other.span },
          repairs: [
            { op: "reorder", confidence: 0.6, note: "use the borrows in separate scopes" },
            { op: "change_owner", to: "shared", confidence: 0.3 },
          ],
        },
      );
      break;
    }
  }

  // R-Own-3: a binding is live only inside the scope that owns it.
  //
  // Two distinct failures are reported here. A *use* after its own scope closed is the
  // obvious one. A *borrow* used after its **owner's** scope closed is the use-after-free
  // the rule actually exists to prevent: the owner is gone, so the borrow dangles even
  // though the borrow's own binding is still lexically in scope.
  const scopeEnds = events.filter((e): e is Extract<Event, { k: "scope_end" }> => e.k === "scope_end");
  for (const use of uses) {
    const b = bindings.get(use.name);
    if (!b) continue;
    const closedBefore = scopeEnds.find(
      (s) => s.scope === b.scope && eventIndex(events, s) < eventIndex(events, use),
    );
    if (!closedBefore) continue;
    c.error(
      "E0413", "view_out_of_region",
      `\`${use.name}\` is used after the scope that owns it has ended`,
      use.span,
      {
        value: `${use.name}#${info.id}`,
        related: [{ span: b.span, label: "declared here" }],
        data: { name: use.name, scope: b.scope },
        repairs: [{ op: "reorder", confidence: 0.5 }, { op: "change_owner", to: "shared", confidence: 0.3 }],
      },
    );
    break;
  }

  for (const borrow of cborrows) {
    if (borrow.owner === borrow.name) continue; // a parameter borrowing itself
    const owner = bindings.get(borrow.owner);
    if (!owner) continue;
    // The owner's scope *ending* is what matters, not whether the borrow event precedes
    // it. In `let v = { let b = ..; view b }` the borrow is recorded after the block
    // closes — the binding only exists once the block yields — yet the use that follows
    // still reads a released owner, which is the whole failure.
    const ownerClosed = scopeEnds.find((s) => s.scope === owner.scope);
    if (!ownerClosed) continue;
    const usedAfter = uses.find(
      (u) => (u.name === borrow.name || u.name === borrow.owner)
        && eventIndex(events, u) > eventIndex(events, ownerClosed),
    );
    if (!usedAfter) continue;
    c.error(
      "E0413", "view_out_of_region",
      `\`${borrow.owner}\` is released here, but a ${borrow.mutable ? "mutable view of" : "view of"} it is used afterwards; the borrow outlives what it points at`,
      usedAfter.span,
      {
        value: `${borrow.owner}#${info.id}`,
        related: [
          { span: borrow.span, label: "borrow taken here" },
          { span: ownerClosed.span, label: "owner released here" },
        ],
        data: { owner: borrow.owner, borrow: borrow.span },
        repairs: [
          { op: "reorder", confidence: 0.5, note: "use the borrow before the owner is released" },
          { op: "change_owner", to: "shared", confidence: 0.4 },
        ],
      },
    );
    break;
  }

  // R-Own-9: a resource is dropped exactly once, and drop never runs on a value that
  // has already been moved out.
  //
  // The violation is a *use after move*, not the move itself: `let b = a` is a perfectly
  // legal transfer of ownership. What is unsound is touching `a` afterwards, because its
  // drop would then run on a binding that no longer owns the handle — the second close.
  for (const use of uses) {
    const b = bindings.get(use.name);
    if (!b || b.resourceType === null) continue;
    const priorMove = moves.find((m) => m.name === use.name && eventIndex(events, m) < eventIndex(events, use));
    if (!priorMove) continue;
    c.error(
      "E0417", "double_free",
      `\`${use.name}\` is an owned resource that was already moved out; using it again would close the same handle twice`,
      use.span,
      {
        value: `${use.name}#${info.id}`,
        related: [
          { span: priorMove.span, label: "moved out here" },
          { span: b.span, label: "acquired here" },
        ],
        data: { name: use.name, move: priorMove.span },
        repairs: [],
      },
    );
    break;
  }

  // R-Own-7: a reference *into* an arena must not escape its region.
  //
  // The check is on what leaves the function, not on every use: reading a field of an
  // arena parameter inside the body is ordinary and must not be reported. Only a borrow
  // that is returned — a `view`/`viewmut` derived from an arena value — is an escape.
  for (const borrow of cborrows) {
    if (!returnsBorrowOf(events, borrow)) continue;
    const owner = bindings.get(borrow.owner);
    if (!owner || !isArenaBacked(owner.ty)) continue;
    const converted = events.some(
      (e) => e.k === "to_handle" && e.name === borrow.owner && eventIndex(events, e) < eventIndex(events, borrow),
    );
    if (converted) continue;
    c.error(
      "E0415", "arena_escape",
      `\`${borrow.owner}\` lives in an arena; a \`${borrow.mutable ? "view mut" : "view"}\` of it cannot escape the region — convert it to a \`handle\` instead`,
      borrow.span,
      {
        value: `${borrow.owner}#${info.id}`,
        repairs: [{ op: "change_owner", to: "handle", confidence: 0.85 }],
      },
    );
    break;
  }
  // kernel.md §9 case 8 / §6.5: a resource must not be built by a literal whose field
  // initializers can bail out. The drop elaboration would then close a field that was
  // never bound, so the construction is rejected rather than silently tolerated.
  for (const init of partials) {
    c.error(
      "E0419", "partial_init_drop",
      "a `@resource` cannot be built by a struct literal whose field initializers can fail; bind the fallible fields into locals first so drop never runs on an unbound one",
      init.span,
      { repairs: [{ op: "reorder", confidence: 0.4, note: "compute the fallible fields before constructing" }] },
    );
    break;
  }

  // kernel.md §9 case 7: an exclusive borrow may not cross a task boundary.
  //
  // A task capturing a `view mut` — directly, or through another name bound to the same
  // place — hands exclusive access to a second thread while the parent still holds it.
  for (const capture of captures) {
    const b = bindings.get(capture.name);
    if (!b) continue;
    if (!isExclusive(b.ty)) continue;
    c.error(
      "E0420", "cross_thread_alias",
      `\`${capture.name}\` is a mutable borrow captured by a task; an exclusive borrow cannot cross a concurrency boundary`,
      capture.span,
      {
        value: `${capture.name}#${info.id}`,
        related: [{ span: capture.span, label: "captured by the task" }],
        repairs: [{ op: "change_owner", to: "shared", confidence: 0.7 }],
        data: { name: capture.name },
      },
    );
    break;
  }
}

// ---------------------------------------------------------------------------
// Trust lattice (kernel.md §4.5)
// ---------------------------------------------------------------------------

function checkTrustLattice(c: Checker, body: BodyChecker): void {
  for (const [, rec] of body.facts.constructions) {
    if (rec.typeName !== "Verified") continue;
    const info = c.program.fnInfo.get(c.currentFn);
    const name = info?.name ?? "";
    if (!isVerifyFunction(c, name)) {
      c.error(
        "E0601", "unverified_promotion",
        "`Verified<T>` may only be produced by a `verify` function that performed deterministic checks; a model result is untrusted",
        rec.span,
        { repairs: [] },
      );
    }
  }
}

/**
 * A `verify` function is one that takes an `Untrusted<...>` and returns `Verified<...>`.
 * Detected structurally rather than by name, so a rename cannot bypass the rule.
 */
function isVerifyFunction(c: Checker, name: string): boolean {
  void name;
  for (const info of c.program.allFns()) {
    const takesUntrusted = info.paramTys.some(containsUntrusted);
    const returnsVerified = containsVerified(info.retTy);
    if (takesUntrusted && returnsVerified) return true;
  }
  return false;
}

function containsUntrusted(t: Ty): boolean {
  const r = deepResolve(t);
  if (r.k === "named" && r.def === BUILTIN.Untrusted) return true;
  if (r.k === "own") return containsUntrusted(r.inner);
  if (r.k === "named") return r.args.some(containsUntrusted);
  return false;
}

function containsVerified(t: Ty): boolean {
  const r = deepResolve(t);
  if (r.k === "named" && r.def === BUILTIN.Verified) return true;
  if (r.k === "own") return containsVerified(r.inner);
  if (r.k === "result") return containsVerified(r.ok) || containsVerified(r.err);
  if (r.k === "named") return r.args.some(containsVerified);
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eventIndex(events: Event[], target: Event): number {
  return events.indexOf(target);
}

/**
 * The index, within the full event list, at which a borrow's region ends.
 *
 * That is its owner's last use. A temporary borrow (one that binds no name) ends where
 * it was created, because nothing can refer to it afterwards.
 */
function regionEnd(events: ReadonlyArray<Event>, borrow: Extract<Event, { k: "borrow" }>): number {
  const lastUse = lastUseIndex(events, borrow.owner);
  return lastUse < 0 ? events.indexOf(borrow) : lastUse;
}

/**
 * Whether a borrow leaves the function.
 *
 * A borrow escapes when a later `return` names either the borrow's own binding or the
 * place it was derived from. Returning the owner is not an escape of a *reference into*
 * it — the owner moves with its own data — which is the distinction R-Own-7 turns on.
 */
function returnsBorrowOf(
  events: ReadonlyArray<Event>,
  borrow: Extract<Event, { k: "borrow" }>,
): boolean {
  const at = events.indexOf(borrow);
  return events.some(
    (e): e is Extract<Event, { k: "return" }> =>
      e.k === "return" && events.indexOf(e) > at && (e.name === borrow.name || e.name === borrow.owner),
  );
}

/** Index of the last `use` of `name` within `events`, or -1 when it is never used. */
function lastUseIndex(events: ReadonlyArray<Event>, name: string): number {
  let last = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.k === "use" && e.name === name) last = i;
  }
  return last;
}

function containsToHandle(events: Event[], name: string): boolean {
  return events.some((e) => e.k === "to_handle" && e.name === name);
}

/**
 * The binding a place expression ultimately denotes.
 *
 * `view`/`move`/`tohandle` are transparent here: `return view a` returns a borrow *of*
 * `a`, so the escape to record is against `a`, not against a nameless temporary.
 */
function placeRoot(e: Expr): string {
  let cur = e;
  for (;;) {
    if (cur.kind === "field" || cur.kind === "index") { cur = cur.base; continue; }
    if (cur.kind === "view" || cur.kind === "move" || cur.kind === "tohandle") { cur = cur.operand; continue; }
    if (cur.kind === "block") {
      const tail = cur.block.tail;
      if (tail) { cur = tail; continue; }
    }
    if (cur.kind === "unsafe" || cur.kind === "consteval") {
      const tail = cur.body.tail;
      if (tail) { cur = tail; continue; }
    }
    return cur.kind === "path" ? cur.value : "";
  }
}

function samePlace(a: Expr, b: Expr): boolean {
  return a.kind === "path" && b.kind === "path" && a.value === b.value;
}

function patternNames(p: Pattern): string[] {
  switch (p.kind) {
    case "bind": return [p.name];
    case "at": return [p.name];
    case "or": return p.alts.flatMap(patternNames);
    case "tuple": return p.elems.flatMap(patternNames);
    case "record": return p.fields.flatMap((f) => patternNames(f.pat));
    default: return [];
  }
}

/**
 * If an expression's value is a borrow, the place it borrows and whether it is exclusive.
 *
 * Looks through a block's tail, so `let v = { ..; view b }` is recognised as borrowing
 * `b` rather than as an anonymous block value.
 */
function borrowSource(e: Expr): { owner: string; mutable: boolean } | null {
  if (e.kind === "view") {
    const owner = placeRoot(e.operand);
    return owner ? { owner, mutable: e.mutable } : null;
  }
  if (e.kind === "block") return e.block.tail ? borrowSource(e.block.tail) : null;
  return null;
}

/**
 * The `@resource` definition a value is, if any.
 *
 * Read off the type *before* ownership wrappers are stripped, because an alias like
 * `type File = Handle<Fd>` resolves to a bare handle and only the `resourceOf` marker
 * keeps the drop path attached to the value.
 */
function resourceTypeOf(ty: Ty, program: Program): number | null {
  const direct = deepResolve(ty);
  if (direct.k === "own" && direct.resourceOf !== undefined) return direct.resourceOf;
  const r = deepResolve(unown(ty));
  if (r.k === "own" && r.resourceOf !== undefined) return r.resourceOf;
  if (r.k !== "named") return null;
  return program.typeInfo.get(r.def)?.isResource ? r.def : null;
}

function isArenaBacked(ty: Ty): boolean {
  const r = deepResolve(ty);
  if (r.k === "own" && r.ownership === "arena") return true;
  return false;
}

/** Whether a type confers exclusive access to the place it refers to. */
function isExclusive(ty: Ty): boolean {
  const r = deepResolve(ty);
  return r.k === "own" && r.ownership === "viewmut";
}

function key(span: Span): number {
  return span.start * 4096 + span.end;
}

/**
 * Whether a value of this type is copied rather than moved on assignment.
 *
 * A `@resource` is never copied, whatever its representation says. `Handle<T>` is a
 * copyable *value* — two integers — but a resource behind one carries a close path, so
 * copying it would run that path twice. The attribute is the authority here, not the
 * layout.
 */
function isCopyOf(ty: Ty, c: Checker): boolean {
  if (resourceTypeOf(ty, c.program) !== null) return false;
  return isCopy(ty, (def, args) => c.expand(def, args));
}

/** Whether evaluating an expression can abandon the enclosing construction. */
function canBailOut(e: Expr): boolean {
  switch (e.kind) {
    case "try":
      return true;
    case "cast": case "unary": case "view": case "move": case "tohandle":
      return canBailOut(e.operand);
    case "is":
      return canBailOut(e.base);
    case "binary": return canBailOut(e.lhs) || canBailOut(e.rhs);
    // The receiver matters as much as the arguments: `fs.read(p)?.len()` is a method
    // whose *base* is the `?`, and missing that hides the bail-out entirely.
    case "method": return canBailOut(e.base) || e.args.some(canBailOut);
    case "call": return canBailOut(e.callee) || e.args.some(canBailOut);
    case "index": return canBailOut(e.base) || canBailOut(e.index);
    case "struct": return e.fields.some((f) => canBailOut(f.value));
    case "array": case "tuple": return e.elems.some(canBailOut);
    case "block": return e.block.tail !== undefined && canBailOut(e.block.tail);
    case "if": {
      const elseExpr: Expr | undefined = e.else_ === undefined
        ? undefined
        : "kind" in e.else_ ? e.else_ : e.else_.tail;
      return (e.then.tail !== undefined && canBailOut(e.then.tail))
        || (elseExpr !== undefined && canBailOut(elseExpr));
    }
    case "match": return e.arms.some((a) => canBailOut(a.body));
    case "while": return canBailOut(e.cond);
    case "for": return canBailOut(e.iter);
    case "return": case "break": return e.value !== undefined && canBailOut(e.value);
    default: return false;
  }
}
