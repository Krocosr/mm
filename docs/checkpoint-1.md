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

**Verification.** `bun test tests` → **205 passing, 0 failing**. `bunx tsc --noEmit` → clean.
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

---

## 4. What was NOT measured

The report is explicit that a token saving means nothing without the success rate:

> A 70 % context reduction that creates a 20 % success-rate reduction is not a win.

**Not run:** the fourth condition, *semantic tools* (the agent querying the graph live
rather than receiving a batched packet), and the **task success rate** across all four
conditions. Both require running the same model against the same fixed task set with a
scoring harness. Neither is estimated anywhere in this repository.

So the honest reading of §3 is: **the context reduction is real and measured; whether it
converts into successful agent work is untested.** That is the experiment this checkpoint
exists to set up, and it is the next thing to build.

---

## 5. The examples corpus: partial, and improving

`examples/` holds 30 programs and 73 test items. **48 of 73 pass under the interpreter**,
up from 6 of 75 at the first measurement. `bun test tests` → 205 passing, 0 failing.

The gap was never thirty independent problems. Nearly every jump came from a single
*systemic* interpreter defect — a duplicated source of truth, or one accessor in a family
of six that had been left behind. Ten are recorded here:

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

Three of these produced *silently wrong answers* rather than errors, and the full unit
suite passed throughout. They were found only by running the corpus.

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

The remaining failures are individual and need their own diagnosis each. Some — notably
`routing_intent`, which needs `Decision<T>` and the agent constructs — are missing
capability rather than defects, and the honest outcome for those is to record them as
unbuilt rather than weaken the ownership or effect system until they go green.

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

---

## 7. Next

1. Build the agent-run harness and measure the success rate the report requires. Until
   that exists, §3 is a measurement of context size and nothing more. The report is
   explicit that a large context reduction paired with any drop in task success is not a
   win, so the comparison cannot be called a result until both axes exist.
2. Finish the example corpus — 48 of 73, from 6. This is the difference between
   "compiles" and "works", and it is the last thing standing between the language and a
   defensible claim that it runs real programs.
3. `mmd` and the OMP extension are built and tested over a real pipe, but have not been
   driven by an actual agent session yet. The harness is what will do that.
