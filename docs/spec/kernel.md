# MM Semantic Kernel — Normative Specification (v0.1)

This document is the **contract**. Every compiler pass, the interpreter, the semantic
graph, and the harness tools implement exactly these rules. Where this document and an
implementation disagree, the document is wrong and must be fixed first.

Normative keywords: **MUST**, **MUST NOT**, **SHOULD**, **MAY**.

---

## 0. Scope of v0.1

The kernel is deliberately small. It is the smallest language that can honestly exercise
the two novel claims:

1. Ownership/region checking that does not require user-written lifetime syntax.
2. A typed semantic graph that is the primary interface for agents.

Everything else (custom native backend, full dependent types, pervasive gradual typing)
is out of scope. See `roadmap.md`.

---

## 1. Lexical form

Source is UTF-8. A file is a sequence of **items**. No textual headers: module
identity comes from the file path relative to the package root.

- **Comments** — `//` line, `/* */` block (not nested).
- **Identifiers** — `[A-Za-z_][A-Za-z0-9_]*`. `snake_case` is the convention.
- **Type parameters** — uppercase identifiers are *not* special; the grammar is
  positional. A `type`/`fn` declaration binds its `<T, U>` in order.
- **Literals** — `123`, `1_000`, `0xff`, `0b1010`, `3.14`, `1e-9`, `true`, `false`,
  `"text"`, `b"bytes"`, `c"cstring"`, `'c'` (char code).
- **Operators** — as in the grammar below. `?` is postfix try, not a ternary.
  Ternary does not exist; use `if`/`match`.
- **Newlines are not significant.** Statement boundaries use `;` optionally before a
  block-closing token, matching the "ASI-lite" rule in §2.1.

### 2.1 Statement separation rule

A statement ends at `;`, or at `}` when the next token cannot continue an expression.
This keeps the sample programs readable without introducing indentation syntax.

---

## 2. Items

```text
module-item  := use-item | type-item | fn-item | trait-item | impl-item | const-item | test-item
```

### 2.1 Imports

```text
use std.fs.{read, write}
use std.text as t
use crate::demo.math
```

Paths are `::`-separated. `use` does **not** introduce text into the program; it binds
names in the module namespace. The semantic graph records the resolved dependency edge.
**An agent never needs to see an import to understand a call** — imports are a text
projection detail, and are elided from the LLM projection when the resolved edge is
already visible (§7.3).

### 2.2 Type items

```text
type Point = { x: f32, y: f32 }
type Shape = Circle { r: f32 } | Rect { w: f32, h: f32 }
type Opt[T] = None | Some(T)
type Alias = shared Node
```

- A record type: `{ field: T, ... }`.
- A tagged union: `Variant { fields } | Variant2 | ...`. A bare `Variant` is a
  nullary variant (unit).
- `choice { a, b, c }` is sugar for a nullary union restricted to decision output.
  It exists so routing decisions are greppable and so the System Plan can render
  them as an enum schema.
- Type parameters `[T, U]` may have bounds: `[T: Ord, U]`.
- Attributes may precede: see §5.

### 2.3 Function items

```text
fn dist2(a: view Point, b: view Point) -> f32 { ... }
fn load(path: Path) -> Result<Bytes, IoErr> !{fs.read} { ... }
unsafe[ffi, rawptr] fn map_page(p: *mut u8, n: usize) -> view mut [u8] { ... }
extern "C" unsafe fn fopen(path: *const c8, mode: *const c8) -> *mut CFile
@intent fn triage(t: Ticket) -> Decision<Route> !{agent, nondet} { ... }
```

- Parameters: `name: T`. The `name:` prefix is **required**; it is what makes the
  semantic graph's parameter list addressable.
- Effect row `!{e1, e2}` is **optional inside a module** and **REQUIRED on every
  `pub` item** (§4.3).
- `unsafe[caps]` enumerates exactly which unsafe powers are used; the emitted metadata
  records them verbatim. A `pub unsafe` fn's caps are part of its public type.

### 2.4 Trait and impl items

```text
trait DecisionProvider {
    fn decide[S, Q](state: view S, question: view Q) -> Decision<Q.Output> !{agent, nondet}
}

impl DecisionProvider for JevProvider { ... }
```

Implementation is restricted to be **coherent**: a given trait may have at most one impl
per type, and orphan impls (neither trait nor type local) are rejected.

### 2.5 Const items

```text
const MAX: usize = 4096
const fn hash_len(s: &Text) -> usize { ... }
```

`const fn` bodies are evaluated by the compile-time evaluator (§8), which has a fuel
budget and **no ambient capability**. A const fn that reaches an effect-bearing
operation is rejected at compile time, not at evaluation time.

### 2.6 Test items

```text
test "sums a list" { assert_eq(sum([1, 2, 3]), 6) }
```

Tests are graph nodes with an edge to every symbol they reference. They are inputs to
`mm.slice` (the report requires "tests" in the include set) and to
dependency-directed context selection.

---

## 3. Types

### 3.1 Primitive

`u8 u16 u32 u64 usize i8 i16 i32 i64 isize f32 f64 bool char`
`Text` (UTF-8, immutable, heap), `Bytes` (immutable, heap), `c8` (`u8`, C ABI text),
`Path` (Text alias with OS semantics), `Fd` (`i32`), `Void`.

### 3.2 Structural

- `T` — tuple, `(A, B)`.
- `[T]` — slice, `(len, ptr)`, bounds-checked.
- `[T; N]` — fixed array, `N` a const-evaluable `usize`.
- `?T` — optional, sugar for `Opt[T]`.
- `Result<T, E>` — builtin tagged union; the `?` operator propagates `Err`.
- `Map<K, V>`, `Set<T>` — builtin, ordered-by-key.

### 3.3 Generic application

`Foo<A, B>`. Arity mismatch is `E0201`.

### 3.4 Ownership wrappers (the core of v0.1)

| Form | Meaning | Copy? | Cost |
|---|---|---|---|
| `T` | owned, affine | no (unless trivially copyable) | move |
| `view T` | temporary immutable borrow | n/a | free |
| `view mut T` | temporary exclusive borrow | n/a | free |
| `shared T` | explicit refcounted ownership | clone | RC ops |
| `arena T` | lifetime bounded by an arena owner | no | bump alloc |
| `handle T` | generational indirect ref | no | index + gen check |

**R-Own-1 (affinity).** A non-`Copy` value has exactly one owner at any point.
Assignment and argument passing **move** it. Re-binding a moved value is `E0412`.

**R-Own-2 (trivially copyable).** `u*`, `i*`, `f*`, `bool`, `char`, `Void`, raw
pointers, `handle T` (a handle is a value: index+generation), and a record **all of
whose fields are trivially copyable** are `Copy`. Assignment copies them; they may be
used any number of times. `Text`, `Bytes`, `[T]` (unsized), and any type containing
them are **not** `Copy`.

**R-Own-3 (view validity).** A `view`/`view mut` is valid only within the region of
the place it is derived from. Using a view after the owner's region ends is `E0413`.
Regions are inferred (§3.5); **the user never writes a lifetime**.

**R-Own-4 (exclusivity).** While a `view mut T` is live in a region, no other view of
the same place may be live in an overlapping region, and the place MUST NOT be moved.
`E0414`.

**R-Own-5 (view counts as a use).** A move of an owned value invalidates every live
view of it. This is the `move_while_viewed` case from the report.

**R-Own-6 (shared escape).** A value of type `shared T` may be cloned freely. The
compiler selects non-atomic reference counting when it can prove single-thread
confinement, and atomic RC when the value crosses a `task` boundary. Both are sound;
only the cost differs. The choice is recorded in graph metadata, not in source.

**R-Own-7 (arena escape).** An `arena T` value lives in its arena. A reference to arena
contents MUST NOT escape the arena's region unless converted to a `handle T` (a
checked, generational, indirection). Escape is `E0415`.

**R-Own-8 (handles are checked, not proven).** `handle T` deref is a **run-time** check
against a generational store: a stale generation is `E0416` at run time. This is the
one intentional run-time ownership check, and the report requires it be reported as
such rather than claimed as static safety.

**R-Own-9 (resource drop).** A type with `@resource(close = f)` gets a drop path. Drop
runs at end of region, exactly once, including on early return and on partial
initialization failure (§6.3). Double-drop and use-after-drop are `E0417`/`E0418`.

### 3.5 Region inference

Regions are inferred, never written. The algorithm is fixed so it is testable:

1. Build the control-flow graph of the function body over HIR.
2. Give every local binding a **definition point** and every use a **use point**.
3. A view's region is the set of points dominated by its creation and strictly
   post-dominated by its last use (standard liveness region). This is the MM analogue
   of MIR-level region inference; the surface syntax carries no annotations.
4. If a use is not dominated by the view's creation, or the view's region would have
   to be split across a move of the owner, the checker **escalates**: it first tries
   widening to the owner's whole region, and only then reports a diagnostic. Diagnostics
   MUST suggest, in order: reorder, `clone`, change owner to `shared`, change to
   `arena`, introduce `handle`.
5. A function that still cannot be typed after widening is `E0413`/`E0414` with the
   full ownership path printed.

**Widening order is normative.** A checker that reports an error where step 4 would
have succeeded is a checker bug. The false-rejection suite (§9) exists to catch it.

### 3.6 No user lifetimes (v0.1 non-goal)

`fn foo<'a>(x: &'a T)` is a **parse error** (`E0100`). This is a deliberate,
load-bearing rejection: the report's thesis is that removing lifetime syntax is part of
the agent-ergonomics bet. It will be revisited only after real failure cases are
collected, per the report's "highest risks" section.

---

## 4. Effects

An effect is a capability name. Built-ins:

```text
fs.read  fs.write  fs.close  net  net.tls  proc  proc.exec  os.vm
agent  nondet  unsafe  clock  random  env  secret.read
```

Plus user-scoped effects: `!{bank.transfer}` names a capability `bank.transfer` that
must be granted by a host (§6.4).

### 4.1 Syntax

`!{a, b, c}` on a fn. `!{..}` means "polymorphic in all effects" and is legal only on
trait method signatures.

### 4.2 Inference vs annotation

- Within a module, a function's effect set is **inferred** from its body (§4.3).
- At a `pub` boundary, or where the effect set is the subject of a capability
  grant, the effect set **MUST** be written explicitly. A missing effect row on a
  `pub` item is `E0501`.
- This is the report's mitigation for "effects become annotation noise".

### 4.3 Effect subtyping

Effects are a **set lattice ordered by inclusion** only. `E1 ⊆ E2` iff every member of
`E1` is in `E2`. There is no subsumption by "read ⊆ write" — MM deliberately avoids
effect *qualifiers* in v0.1 because they make the lattice non-monotone and produce
exactly the permission-escalation confusion the report warns about. Effect
qualifiers are a v0.2 research item.

In a call, the call site's context effect set **MUST** be a superset of the callee's
inferred set. This is checked at every call edge: calling an effectful function from a
pure one is `E0502`.

### 4.4 Effect conservation (normative invariant)

For any transformation `T` (optimizer, Type→System lowering, inlining, monomorphization):

```text
Effects(T(P)) ⊆ Effects(P) ∪ Effects(explicitly synthesized and recorded)
```

No transformation **MAY** introduce `net`, `fs.*`, `proc`, `agent`, `unsafe`, `os.vm`,
or `secret.read` that is not in the checked program's set or in an explicitly recorded
synthesis. This is checked by `mm.verify` and MUST run on every program that uses
Type→System. Violation is `E0503`.

### 4.5 Trust monotonicity (normative invariant)

A `Decision<T>` is a **typed but untrusted nondeterministic value**. The following MUST
NOT typecheck:

```text
fn bad(d: Decision<Approval>) -> Cap<bank.transfer>   // E0601
```

Promotion requires an explicit verification step that produces a distinct nominal
type `Verified<T>`, and `Verified<T>` is only constructible inside a `verify` fn that
performs deterministic checks. `Untrusted<T> → Verified<T>` is the only promotion edge,
and it is the only place where a non-deterministic input becomes authoritative.

This is the report's "type-safe output format is not the same as epistemic correctness"
rule, made into a type error.

---

## 5. Attributes / Type→System

| Attribute | Legal on | System IR artifact | Runtime behavior |
|---|---|---|---|
| `@resource(close = f)` | type | `OwnedResource` | drop/close path, exactly once |
| `@wire` | type | `WireSchema<T>` + version id | encoder/decoder, RPC schema |
| `@secret` | type | `Sensitive<T>` | log redaction, context-export ban |
| `@persist(ttl = ...)` | type | `PersistentStore` | schema, versioning, migration |
| `@intent` | fn | typed decision endpoint | tool schema, replay record |
| `@repr(c)` | type | C layout contract | fixed layout, C ABI |
| `@untrusted` | type | trust-lattice node | validator required before use |

Rules:

- **A-1.** An `@attr` on a non-`pub` item that is never re-exported and never the type
  of a `pub` item MAY be dropped by the System Plan with a recorded reason.
- **A-2.** `@wire` on a type containing a `@secret` field is `E0701` — a wire schema
  must not silently serialize a secret.
- **A-3.** `@persist(ttl=...)` requires a key type that is `@wire`-encodable; else
  `E0702`.
- **A-4.** `@resource(close = f)` requires `f` to resolve to a function whose
  parameter type matches the resource's handle type. Mismatch is `E0703`.
- **A-5.** `@secret` values MUST NOT appear in any diagnostic, semantic packet, or
  context slice. The graph stores the *type*, never the value. Enforced in
  `mm.slice`/packets, tested.
- **A-6.** `@intent` functions have effect `agent` (implied; adding it explicitly is
  allowed and redundant, removing it is `E0704`).

---

## 6. System Plan and capability verification

### 6.1 Shape

The System Plan is a checkable artifact, not a comment:

```text
system route_job {
  input       wire Job#8bd7
  output      Decision<Route#44a1>
  effects     agent,nondet
  authority   none
  provider    system1
  fallback    route_rules
  telemetry   decision+confidence
  replay      record
}
```

### 6.2 Derivation

A `SystemPlan` is produced per `@intent` fn and per program entry point:
- `input` / `output` from the signature's `@wire`-annotated types.
- `effects` = the fn's effect set, **closed** (§4.3).
- `authority` = the set of `Cap<E>` values reachable in the transitive call graph. A
  function that never receives a `Cap` has `authority none`.
- `provider` / `fallback` from `@intent(provider = ..., fallback = ...)` attributes.
- `replay` = `record` if `agent` ∈ effects.

### 6.3 Capability non-escalation

```text
Capabilities(child) ⊆ Capabilities(parent)
```

enforced structurally: a `Cap<E>` value can only enter a function's parameter list
(granted by the caller, who must itself hold it) or be constructed by a host-granted
factory. **There is no syntax that constructs a `Cap` from a value.** A classifier
result, a pointer cast, a confidence score, and text are all statically incapable of
producing one. This is checked by an AST-level rule: `Cap<E>` may appear only as a
parameter type, in a `struct` field, or in a `!{E}`-carrying function that receives it
from its caller. Any other position is `E0602`.

### 6.4 Granted ⊆ Requested

The compiler generates the *requested* policy. The host grants an equal or narrower
policy. `mm.run` enforces this at process setup: a program whose requested effects
exceed the granted set MUST NOT start, and the denial is reported structurally
(`E0801`) with the specific over-requested capability named. Approval dialogs in a
harness are **not** this mechanism — per the report, harness approval is not
sandboxing.

### 6.5 Drop on partial initialization

`@resource` types get a **drop-elaboration**: the compiler tracks, per function, which
fields of each resource-typed local have been initialized, and emits drops only for
initialized fields, in reverse order. This is what makes "destructor after partial
initialization" (§9, safety corpus) statically correct rather than a crash.

---

## 7. The semantic graph

### 7.1 Identity

Three separate identity spaces; conflating them is a bug:

| Space | Form | Stability |
|---|---|---|
| **Content hash** | `sha256(normalized semantic form)` → first 4 bytes hex | stable across moves, stable across whitespace/comments, changes when meaning changes |
| **Source id** | `module_path::name` | stable until renamed |
| **Session alias** | `S#11`, `T#27` | **ephemeral**, valid only within one daemon session |

**A line number is NEVER an identity.** Renaming a symbol does not change its content
hash if its semantic form is unchanged.

### 7.2 Node

```text
SemanticNode {
  hash          // content hash, primary identity
  source_id     // module::name
  alias         // session-local, assigned on first touch
  kind          // type | fn | field | variant | param | local | test | const | trait | impl
  type_hash     // resolved type's content hash
  effect_set    // [] for non-fn
  ownership     // owned | view | viewmut | shared | arena | handle | copy
  span          // source span, for humans only
  deps[]        // outgoing edges by content hash
  revision      // monotonic per-node revision
  attributes[]  // @wire, @secret, ...
}
```

### 7.3 LLM projection

Semantic packets are the agent's view. Rules:

- **Never** emit: keywords that carry no information, imports, comments, unchanged
  neighbouring statements, prose diagnostics, tool logs.
- **Always** emit: the resolved type, the effect set, the ownership of each parameter,
  and the outgoing dependency edges.
- **Deltas** (`Δ F27/b3`) are the default edit representation. Line patches are
  rejected by `mm.patch` unless the caller opts in.
- The projection is measured against real tokenizers, never estimated from character
  count (the report is explicit that tokenization is encoding-dependent). A
  character-count proxy is not acceptable evidence.

---

## 8. Compile-time evaluation

`const fn` and `const` items are evaluated by a restricted interpreter:

- **Fuel-bounded** (default 1e6 steps). Exhaustion is a compile error, not a hang.
- **Capability-free.** Any operation that would need an effect is rejected at
  verification time before evaluation.
- **Deterministic.** No clock, no random, no float `NaN`-producing ops beyond what's
  explicitly allowed (float const eval is permitted; `NaN`/`inf` compare by bit
  pattern to keep it total).
- Used for array lengths, layout queries, schema version ids, and generic
  specialization. Layout queries are what let `@wire` compute a stable schema id.

---

## 9. Safety corpus (normative acceptance criteria)

The following ten programs MUST be **rejected at compile time** (not crash at run
time), each with the named code, except `E0416` which is the documented run-time
checked-handle case:

| # | Case | Code | Static or runtime |
|---|---|---|---|
| 1 | use after free (owner dropped, view used) | `E0413` | static |
| 2 | double free (drop of a moved resource) | `E0417` | static |
| 3 | iterator invalidation (mutate a `[T]` while iterating a `view [T]`) | `E0414` | static |
| 4 | mutable/read alias | `E0414` | static |
| 5 | reference escapes arena | `E0415` | static |
| 6 | stale generational handle | `E0416` | **runtime by design** |
| 7 | cross-thread mutable alias | `E0420` | static |
| 8 | destructor after partial init | `E0419` | static |
| 9 | integer-to-pointer misuse | `E0430` | static |
| 10 | bad FFI ownership contract | `E0703`/`E0704` | static |

**FR-1 (false rejection).** A companion suite of known-safe patterns — including
borrowck-hard cases that Rust accepts — MUST compile without error. A model that
rejects everything is not a model. The false-rejection rate is reported alongside the
reject rate; both are part of the checkpoint.

---

## 10. Diagnostic contract

Every diagnostic has a human form and a machine form, and **the machine form is
canonical**:

```json
{
  "code": "E0412",
  "kind": "move_while_viewed",
  "message": "`buf` cannot move here",
  "value": "S:buf#71",
  "move": "span:39:8-39:11",
  "view": "span:31:12-44:19",
  "repairs": [
    {"op": "reorder", "confidence": 0.98},
    {"op": "clone", "cost": "allocation"},
    {"op": "change_owner", "to": "shared"}
  ]
}
```

Requirements:
- `repairs` MUST be ordered by descending confidence, and MUST be produced by
  actually running the candidate repair's checker where feasible — a repair that does
  not typecheck MUST NOT be offered. An unverifiable repair is omitted, not guessed.
- Secrets never appear in `message` (§A-5).
- `kind` is a stable kebab-case slug; agents branch on it, not on prose.
- Codes are **stable** and never reused for a different meaning.

---

## 11. Error code registry

| Range | Area |
|---|---|
| E01xx | lexical/syntax |
| E02xx | types |
| E03xx | generics/bounds/const |
| E04xx | ownership/regions/handles |
| E05xx | effects |
| E06xx | trust/authority |
| E07xx | Type→System attributes |
| E08xx | capability policy/sandbox |
| E09xx | semantic graph/internals (compiler bugs should surface here) |

An internal compiler failure is `E0900` and is always a bug — never a user error.
