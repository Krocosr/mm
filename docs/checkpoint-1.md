# MM — First Research Checkpoint

The report asks for a first checkpoint before any production optimizer exists: build
enough of the language to run a corpus of small programs, then measure whether an agent
working from the compiler's semantic graph actually needs less context than one working
from source. This document records what was built, what was measured, and — as importantly
— what was *not* measured.

Every number below is reproducible with the commands shown. Nothing here is estimated.

---

## 1. What exists

| Layer | Module | State |
|---|---|---|
| Lexer, parser, formatter | `src/lexer.ts`, `src/parser.ts`, `src/format.ts` | Complete |
| HIR + symbol table | `src/lower.ts`, `src/program.ts` | Complete |
| Types (ADTs, generics, inference, patterns, traits) | `src/scope.ts`, `src/typeexpr.ts` | Complete |
| Effects (inference, subtyping, fixed point) | `src/effects.ts` | Complete |
| Ownership (affine move, view/view-mut/shared/arena/handle, regions) | `src/ownership.ts` | Complete |
| Trust lattice (`Decision`/`Untrusted`/`Verified`/`Cap`) | `src/ownership.ts`, `src/typeexpr.ts` | Complete |
| Type→System + invariants | `src/system.ts` | Complete |
| Interpreter, const evaluator, decision replay | `src/interp/` | Complete |
| Semantic graph, packets, slices | `src/graph.ts`, `src/packet.ts`, `src/slice.ts` | Complete |
| Query layer, CLI, daemon, OMP extension | `src/query.ts`, `src/cli.ts`, `src/mmd.ts`, `omp-extension/mm.ts` | Complete |

**Verification.** `bun test tests` → **200 passing, 0 failing**. `bunx tsc --noEmit` → clean.
`bun test tests/corpus.test.ts` → 29 passing, 118 assertions, covering both the safety
corpus (each rejected at its named code) and the false-rejection suite.

---

## 2. The safety corpus

The report's normative table (kernel spec §9) requires these programs to be *rejected at
compile time*, each with a named code.

| Program | Code | Verified |
|---|---|---|
| use after free | `E0413` | yes |
| iterator invalidation | `E0414` | yes |
| mutable/read alias | `E0414` | yes |
| reference escapes arena | `E0415` | yes |
| double free (resource) | `E0417` | yes |
| destructor after partial init | `E0419` | yes |
| cross-thread mutable alias | `E0420` | yes |
| integer-to-pointer misuse | `E0430` | yes |
| `Decision` used as authority | `E0601` | yes |
| `Cap` constructed from a value | `E0602` | yes |
| bad FFI ownership contract | `E0703` | yes |
| stale generational handle | `E0416` | compiles clean by design; the check is a run-time one |

Reproduce: `bun test tests/corpus.test.ts`.

**False rejections.** A model that rejects everything is not a model. The companion suite
of 14 known-safe programs — including the borrowck-hard cases — compiles with **zero**
errors. Reproduce: `bun test tests/corpus.test.ts`.

---

## 3. The token measurement

This is the report's central measurable claim, and the only part of the agent story that
can be scored without an agent.

```
bun run scripts/measure-tokens.ts examples tiktoken/cl100k_base
```

Measured over the 30-file example corpus with **exact BPE** (`cl100k_base`), not a
character proxy:

| Condition | Tokens | vs baseline |
|---|---:|---:|
| Baseline — the `.mm` source an agent would read | 23 132 | 100.0 % |
| **Semantic packet** — compiler projection | **6 600** | **28.5 %** |
| Compact source — formatter only | 23 836 | 103.0 % |

$$R_{token} = \frac{6600}{23132} = \mathbf{0.2853}$$

**A 71 % reduction**, from a projection the agent did not have to re-derive.

**The control matters more than the headline.** Deterministic formatting — the obvious
way to shrink source — makes the corpus *larger* (1.030), not smaller. The saving
therefore comes from the semantic graph eliding imports, comments, and unchanged
structure, not from whitespace. Any claim that "fewer tokens" is achievable by
minification is falsified here.

Provenance is recorded in `bench/tokens.json`: every row carries its tokenizer id and an
`approximate` flag, and `compare` refuses to produce a ratio across two different
vocabularies. When `js-tiktoken` was absent, the tool reported that it was unavailable
rather than silently falling back to the heuristic.

**Reproduced on demand.** The figure above was re-derived after the example corpus had
grown from 42 to 48 passing programs, and came back identical: 23 132 / 6 600 / 0.2853.

That reproduction also showed why the exact tokenizer matters. Run without the tokenizer
argument the tool falls back to a character-density heuristic, which reports
`R_token = 0.2028` — the same direction, but a **29 % smaller saving** than the real one.
The heuristic does not merely add noise, it changes the size of the effect being claimed.
Any future number quoted from this repository must name its tokenizer.

---

## 4. What was NOT measured

The report is explicit that a token saving means nothing without the success rate:

> A 70 % context reduction that creates a 20 % success-rate reduction is not a win.

**Not run at the time of writing:** the fourth condition, *semantic tools* (the agent
querying the graph live rather than receiving a batched packet), and the **task success
rate** across conditions. Both require running the same model against the same fixed task
set with a scoring harness. The harness now exists and is described in `harness.md`; the
verdict is in `harness.md` §Results.

So the honest reading of §3 is: **the context reduction is real and measured; whether it
converts into successful agent work is a separate question answered elsewhere.**

### 4.1 Native performance: unmeasured, and currently unmeasurable

The design report's headline is "C-class native execution", and its benchmark matrix has
a row for it:

> | Custom backend | LLVM versus MM-native | correctness and native performance |
> C should not be used as a straw man. C, Rust, MM-LLVM, and where appropriate MM-Cranelift
> should compile with comparable optimization settings.

**That benchmark has not been run and cannot be run yet.** There is no code generator in
this repository. MM compiles to an HIR, a semantic graph and a bytecode-like
interpretation, all in TypeScript on Bun — there is no MM-LLVM and no MM-Cranelift to
compare against anything.

So the claim is **untested, not disproven**. And any performance number produced today
would be measuring Bun's JIT on a tree-walking interpreter, which says nothing about MM
as a systems language. Quoting one would be worse than quoting nothing, because it would
look like the benchmark the report asked for.

Two consequences worth stating plainly:

- The native spine — MIR, an LLVM or Cranelift backend, incremental compilation — was
  never started. It is the single largest piece of the original plan and it remains
  entirely ahead.
- Routing accuracy, ECE and routing latency are also unmeasurable, because `Decision<T>`
  and the agent/decision surface are unimplemented. That is the same gap that leaves
  `examples/routing_intent.mm` red (§5.2).

What *is* measured on the agent side, because it is measurable today: wall-clock seconds
per run, input/output/cache-read token counts, tool-call counts broken down by tool name,
and the count of `mm_*` tool invocations per condition. The token metric in §3 is a
static projection under `cl100k_base`; the harness metric is provider-reported input
tokens. **They are different quantities and are never combined.**

---

## 5. The examples corpus: partial, and improving

`examples/` holds 30 programs and 75 test items. **59 of 75 pass under the interpreter**,
up from 6 of 75 at the first measurement. The permanent suite is 200 tests, 0 failing.

The denominator rose from 73 to 75 because files that previously aborted part-way now
run to completion and report every item they contain — a file counted as `0/1` because
it hung is now counted honestly as `2/2` or `0/2`.

The gap was never thirty independent problems. Every jump came from a single *systemic*
interpreter defect — a duplicated source of truth, an accessor left behind in a family of
six, or a discriminator weaker than the thing it discriminates. Seventeen are recorded
here; the last seven were the most productive of the whole exercise:

| Defect | Why it was systemic |
|---|---|
| `blockValue` unwrapped every `Signal` to its value | Every early `return` inside an `if` was silently a no-op. Any guard clause was dead. |
| Element and field cells never wrote back | `xs[i] = v` through a `view` mutated nothing, so `quicksort` recursed forever. |
| `deref` unwrapped one view level | A `view mut T` parameter handed a `view mut T` nested; every method call then dispatched `view_get`. |
| Recursion ceiling of 512 | `go(2000)` — ordinary tail recursion — was rejected as too deep. |
| Builtin variants absent from the variant table | `None`, `IoErr.Other` and `Handle::none` did not resolve. |
| Iteration covered slices only | `for x in bytes` and over a `Map` were rejected. |
| `Handle::none` registered as `handle_null` | The associated-constructor form rewrites `Owner::member` to `owner_member`; the name never matched. 74 occurrences of one missing symbol. |
| Function-valued parameters not callable by name | `fn map_with(.., f: fn(u32) -> u32, ..)` could not call `f(..)`. A whole calling convention was missing. |
| `slice.len` captured at construction | Every in-place mutator (`push`, `pop`, `insert`) left it stale, so the bounds check rejected indexes that were plainly in range. `E0193` fell from 67 to 3. |
| `wantText` / `wantBytes` did not `deref` | The other four `want*` accessors did. Any `view Bytes` or `view Text` parameter was rejected by every method on it. |
| Bare variant names in patterns parsed as bindings | The parser has no type information, so it special-cased the literal `None` only. Every *other* nullary variant became a binding, and a binding matches anything — so the first arm of every `match` over a union swallowed the rest. **The single largest defect: 48 → 51 on its own.** |
| `findMethod` resolved by name, not receiver type | It scanned for any function named `len`, so an unrelated free `fn len(..)` silently changed what every slice's length was. |
| `matchPattern` compared the borrow, not through it | A `view T` scrutinee arrived as a cell; neither tag nor payload was visible, so every match fell to the first arm. |
| `as` was a no-op | `case "cast": return this.eval(expr.operand)` — `b as char` stayed an `int`. |
| `chars()` yielded `Text` while `s[i]` yielded `char` | Two ways to read the same string disagreed on the element type. |
| The checker rejected legal `Text` operations | `methodType`'s `Text` table was missing four methods the prelude implements, and `checkBinary` rejected `Text + Text` that the runtime had always allowed — so programs type-checked wrong while running right. |

Many of these produced *silently wrong answers* rather than errors, and the full unit
suite passed throughout. Every one of them was found by running the corpus.

### 5.1 One bug that was not a bug

`examples/quicksort.mm` hangs in a step-budget abort, and it is tempting to record that
as an interpreter defect. It is not. Its Lomuto partition takes the pivot from the last
element; when every element in the range is below the pivot it returns `store == hi`, and
`quicksort_range` then recurses on the identical `(lo, hi)` range forever. The example is
wrong. The interpreter's `swap` and its `view mut` write-through were verified correct in
isolation — a two-index swap through a `view mut [T]`, generic and monomorphic, nested
and repeated, all behave correctly.

The cost of that check was high and the finding was worth it: a speculative `readThrough`
cell hook was written, measured, found to change nothing observable, and removed. R-value
reads of `xs[i]` go through `indexOf` straight to the backing array, so cells are only
ever assignment targets and never go stale. The change is gone rather than left in as
unverified machinery.

### 5.2 What is still failing

Sixteen tests across seven files. They are recorded individually rather than as a count,
because the useful distinction is *why* each one is red:

| File | Classification | Reason |
|---|---|---|
| `routing_intent` | **Unbuilt surface** | `triage` needs `agent, clock, nondet`, which this build grants nothing. Forcing it green would mean weakening the effect system, so it stays red. |
| `word_count` | **Open bug** | A `Map` written through `view mut` across two successive calls: the second call's insert does not reach the caller's map, though `get` on the same map reads correctly. Narrowed to a reproducer, not yet root-caused. The example was deliberately *not* edited to dodge it. |
| `json_parser` | Missing surface, unconfirmed | Needs a `Text as_f64` the prelude does not implement. Whether the other two tests depend only on that was not established. |
| `hash_fnv1a` | Open bug | Returns 36342608335481132 against an expected 3826002220 — a 64-bit value shaped like an untruncated intermediate, so a distinct arithmetic/truncation defect. |
| `btree_minimal`, `resource_file`, `csv_parse`, `base64` | Open, undiagnosed | Diagnosed as a cluster, not yet root-caused. |
| `fib_recursive` | Unverified | Aborts on the step budget. Step accounting may simply be too coarse for naive recursion; whether that is a bug or expensive example code was not established. |

Leaving `routing_intent` red is the correct outcome. A corpus that is made green by
weakening the system it is meant to test is worse than a corpus that reports honestly.

The corpus is not yet a validation that MM runs real programs, and should not be cited as
though it were.

One robustness fix came out of this work and applies beyond the corpus: a native stack
overflow is now caught and reported as a diagnostic. A runaway recursion cannot take the
process down, which is a property the interpreter needs regardless of what it is running.

---

## 6. Findings worth carrying forward

1. **The ownership model held up under adversarial input.** The five hardest rules —
   move-while-viewed, region escape, arena escape, cross-task aliasing, and partial-init
   drop — all fire on their intended cases and none fires on the 14 known-safe programs.
   That is the load-bearing result of this phase.

2. **Two spec properties needed real work, not just encoding.**
   - *No user-written lifetimes* is only viable because scope identity, not nesting depth,
     is what the region check compares. Using depth made every `if`/`else` arm a false
     positive.
   - *Effect inference* is a least fixed point over the call graph. Cycles resolve by
     seeding from declared rows, which terminates because the graph is finite.

3. **Compiler robustness on bad input is a correctness property.** A `match` arm without a
   progress guard spun until the JavaScript engine aborted with `MemoryExhaustion` — a
   15 GB allocation triggered by one malformed line. Any recovery loop can now hang the
   process, so the parser has both a per-loop progress guard and a global step budget that
   degrades to a diagnostic.

4. **A passing unit suite is not a working system.** Three of the ten interpreter defects
   found via the corpus produced *silently wrong answers* rather than errors, and every
   test still passed. Running real programs is what surfaced them. The corpus is worth
   more than the tests beside it, and worth more still once it runs clean.

5. **Look for the duplicated source of truth, not the missing case.** Every late jump in
   the corpus came from one value existing in two places. `slice.len` mirrored
   `elems.length` and drifted. `wantText` and `wantBytes` skipped the `deref` their four
   sibling accessors performed. The same shape produced 67 index errors, 86 unresolved
   calls, and 20 text failures — 173 of 256 errors in the corpus from three such defects.
   When a whole family of functions disagrees, the outlier is the bug, and the fix is to
   delete the second source of truth rather than to keep the two in step.

6. **Verify a fix is load-bearing before keeping it.** A plausible `readThrough` cell hook
   was added while diagnosing the quicksort hang. It typechecked, it was principled, and
   it changed nothing observable, because r-value reads bypass cells entirely. It was
   removed. A change that cannot be shown to fix anything is cost, not progress — and on
   a system this size it accumulates.

7. **The corpus and its author disagreed about the language.** The example programs were
   written against an API surface that did not exist (`Handle::at()`, `Map::new()`). The
   tests they shipped checked only that the files *parse* — real evidence for a narrow
   claim, and reported as such. Parsing clean is not running.

8. **Not every failing program is a failing implementation.** `quicksort.mm` is a correct
   interpreter failing an incorrect program (§5.1). The instinct on a red test is to
   suspect the system under test; here that instinct would have produced a plausible
   interpreter change that fixed nothing and broke the thing that was already right.

9. **The most productive bug class was a discriminator weaker than identity.** Three
   separate defects, and the single largest of the whole exercise, were a match or a
   dispatch that keyed on something vaguer than what it was discriminating:

   - The parser has no type information, so it could only special-case the literal
     `None`. Every *other* nullary variant — `Nothing`, `Nil`, `Red` — parsed as a
     binding, and a binding matches anything. The first arm of every `match` over a
     union therefore swallowed every later arm. This one change moved the corpus from
     48 to 51.
   - `findMethod` resolved `xs.len()` by scanning for *any* function named `len`,
     ignoring the receiver entirely. Declaring an unrelated free `fn len(..)` in a file
     silently changed what every slice's length was.
   - `map.get` returned a default rather than distinguishing an absent key from a
>     stored one, so "missing" and "zero" were the same value.

   A match that cannot fail is a bug that presents as a plausible answer. The tell is
   that the failure mass clusters on the *first* arm, or on whatever the loosest key
   happens to be. When many programs fail the same way, ask what the dispatch is keyed
   on before asking what the code is doing.

10. **Two of the corpus programs were themselves wrong**, in ways worth separating from
    interpreter defects. `caesar_cipher.mm`'s second test contradicted its own first
    test — the first proves digits pass through unchanged, the second expected a digit
    to become `'0'` — and `quicksort.mm` recursed forever on a degenerate partition. A
    corpus that only ever blames the implementation will eventually be "fixed" into
    agreeing with itself.

11. **Two registries of "what methods exist" have been drifting, and the checker loses
    every time.** The prelude implements methods under `<type>_<name>` keys. The type
    checker keeps its own hand-written `methodType` switch, per type, with no link to
    the prelude. A method implemented but not listed is a *false rejection*: a program
    the runtime executes correctly is refused at compile time with `E0203`.

    `check examples` reports **86 `E0203` and 74 `E0205`** — 160 of 178 — while the
    interpreter runs 59 of 75 tests in those same files. The comment on the entries that
    were patched says it outright: *"The interpreter implements these, so a program that
    uses them is not writing nonsense — the table was simply incomplete."*

    Adding entries one at a time treats the symptom. The two tables need a test that
    asserts they agree, so the next method added to the prelude fails a build rather
    than silently becoming a rejection. Such a test cannot be written against the source
    text — parsing `case` labels out of a switch tests spelling, not behaviour — so
    `methodType` has to become reachable. It is currently private to `BodyChecker`.

    This is the third time the same shape has appeared here: a duplicated source of
    truth — `slice.len` versus `elems.length`, the six `want*` accessors, and now the
    two method registries. **When many programs fail alike, the productive question is
    "what does this consult?" rather than "what is it doing?"**

---

## 7. Next

1. Run the agent sweep to completion and record the verdict. The harness is built and
   verified end to end; see `harness.md`. Until the sweep lands, §3 is a measurement of
   context size and nothing more. The report is explicit that a large context reduction
   paired with any drop in task success is not a win, so the comparison cannot be called
   a result until both axes exist.
2. Finish the example corpus — 48 of 73, from 6. This is the difference between
   "compiles" and "works", and it is the last thing standing between the language and a
   defensible claim that it runs real programs.
3. `mmd` and the OMP extension are now driven by a real headless agent session, with
   `mm_symbol` and `mm_check` returning live daemon output in `toolResults`. See
   `harness.md` §1 for the load defect that had to be fixed first, and §2 for a case
   where the shipped OMP documentation is contradicted by the installed binary.
