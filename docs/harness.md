# MM — the agent-run harness

The report's central claim is not "semantic packets are smaller than source". It is that
an agent working from compiler-maintained semantics needs materially less context
**without completing fewer tasks**. The first half was measured in `checkpoint-1.md` §3.
This document covers the machinery for the second half, and the findings that fell out of
building it — several of which are about the experiment being invalid rather than about
the language.

## The question

> "A 70 % context reduction that creates a 20 % success-rate reduction is not a win."

`checkpoint-1.md` §4 records what was *not* measured: the fourth condition, and the task
success rate for any condition. Until both exist, `R_token = 0.2853` is a measurement of
context size and nothing more. This harness produces both.

## Design

**Two conditions, identical except for the tool set.** Same model
(`freeflow/space-bunny-free`), same system prompt, same task prompt, same starting
repository, same grader.

| Condition | Built-in tools | Extension |
|---|---|---|
| `baseline` | `read, grep, bash, edit, write` | none |
| `semantic` | `read, bash, edit, write` | `.harness/loader/mm-ext.ts` — eight `mm_*` tools |

`grep` is the discriminator. A text agent rediscovers meaning by searching; a semantic
agent asks the compiler. Removing `grep` from the semantic condition is what stops the
semantic agent from simply doing the baseline's job with extra tools.

**A fixture is a working program with one planted defect, plus a hidden test the defect
fails.** The seed passes its own tests. This matters: the example corpus is not yet
green, so reusing those files would confound an interpreter bug with a task failure.
Each defect is *latent against the seed's own tests* — the seed is green precisely
because the bug is in a case the seed does not exercise.

| id | subsystem | defect |
|---|---|---|
| `bitfield` | arithmetic/bit | tag field masked with the length field's 10-bit width, so tags ≥ 1024 truncate |
| `slot_pool` | ownership/lifetime | a reused slot is stamped with the pool's unchanged generation, so a retired handle still reads as live |
| `tally` | data structure | linear probe never wraps, so a key whose run falls off the end reads as absent |
| `checkdigit` | text/serialization | Luhn doubling keyed off the leftmost digit instead of the string's length parity |


Each was verified in both directions — fails on the seed, passes on a reference fix — and
`.harness/tasks/README.md` carries a runnable recipe so that claim can be re-checked
without trusting the harness.

**Isolation.** Every run gets a fresh copy at
`.harness/runs/<task>/<condition>/<repeat>/work/`. The hidden test is never copied in. The
loader lives at `.harness/loader/`, outside every `work/` directory: the agent under test
must not be able to edit the tool it is being measured on.

**Grading is objective.** The hidden test is copied into the finished work directory, run
through the real compiler and interpreter, and filtered to the hidden modules so the
agent's own tests cannot vote. A run passes iff every hidden test passes.

## Findings from building it

These are the substantive results of this phase, and none of them are about the language.

### 1. The OMP extension could not have been loaded at all

`omp-extension/mm.ts` exports a `TOOLS` table and two classes, and **no default export**.
OMP selects an extension's factory as `getExtensionFactory(module)` — the module itself if
callable, otherwise `module.default` — and a non-function export fails with a structured
error. So `-e omp-extension/mm.ts` could never have worked.

The failure mode is what makes this worth recording: OMP writes load failures to
`~/.omp/logs/omp.<date>.<pid>.log` and deliberately **not** to the console, so a failed
load shows up as a silent no-op in the event stream. A harness would have reported a
perfectly ordinary run in which the semantic tools simply never fired. The loader adapter
was authored in response, and verified by a real headless run in which `mm_symbol` and
`mm_check` appear in `toolResults` with real daemon output.

### 2. The shipped documentation is wrong about `--tools`

`omp://custom-tools.md` line 160 states that CLI `--tools` "validates only built-in tool
names". Measured against the installed `omp` v18.4.3, that is not the behaviour:

| case | result |
|---|---|
| extension registers `mm_check`, `--tools=read,mm_check` | works, tool callable |
| extension registers `mm_check`, `--tools=read` | works, tool **still** callable |
| extension registers only `mm_check`, `--tools=read,mm_slice` | **hard startup error** naming the other registered tools |

Case B is what the doc describes. Case C contradicts it. The consequence is a design
decision: the semantic condition **names** the eight `mm_*` tools in `--tools`, because
that turns a failed extension load into an immediate startup error. Without the names, a
broken extension is force-included away and the "semantic" condition silently degrades
into measuring the baseline — the one failure this experiment cannot detect downstream.
The provenance, including the doc contradiction, is recorded in `results.json`.

### 3. There is no `mm_explain`

The eight names are `mm_check, mm_symbol, mm_refs, mm_type, mm_slice, mm_packet,
mm_system, mm_verify`. Diagnostics are `mm_check`, mapping to the daemon verb
`mm.diagnostics`, which the CLI surfaces under the user-facing name `explain`. The
extension renamed it. An earlier brief in this project referred to "mm_explain"; that was
wrong, and the tools are the thing an agent actually sees, so it mattered.

### 4. Four defects that would have invalidated the results

- **Hidden-test parsing split at the first `::`.** A module named `hidden::stats_hidden`
  parsed to `hidden`, so the filter never matched and every run would have graded as "no
  hidden tests". This is the defect that mattered most: it silently invalidates every
  number in the experiment.
- **The hard timeout did not bound wall time.** `proc.kill()` leaves the agent's `bash`
  grandchild holding the pipe, so a 1 s cap took ~50 s, and the buffered event log was
  discarded — a run that had already spent real tokens reported zero. Events now stream
  to disk as they arrive, with a 5 s drain grace, so a timed-out run reports what it
  actually spent.
- **One throwing run aborted the sweep.** Per-run failures are now caught and written as
  status `crashed`, so the sweep stays resumable.
- **`loadTask` fell back to a default prompt file.** A task whose prompt could not be
  resolved silently got `prompt.txt`, grading a run against a prompt the agent never saw.
  It now throws, and validates every task before spending a model call.

### 5. The stdio transport had a defect that looks like slowness

`StdioDaemonClient` kept only `stdout` from its spawn factory and re-invoked the factory
for `stdin`. With a spawn-per-call factory, requests were written to a second daemon
while replies were read from the first — every request hung forever. Requests also had no
timeout, so a dead daemon left the promise pending indefinitely. Both now fail loudly.

Writing the regression test for this immediately caught a **third** defect introduced
alongside the fix: an `unref`'d request timer does not fire when nothing else keeps the
event loop alive, which is precisely the situation a timeout exists for. A timeout that
cannot fire is worse than no timeout, because it looks like a hang rather than a bug.

### 6. "Both conditions failed identically" is a fixture bug, not a result

Two of the first-draft hidden tests asserted the wrong values, and both conditions failed
for that reason. Identical failure across conditions is the signature of a bad fixture
rather than a real effect, and it cost two sweep cycles. Every fixture is now verified in
both directions before it is used.

### 7. `mm_slice` was ~5 500x slower than a grep, and the semantic condition cannot work
###    until that is fixed

The token experiment assumes the semantic tools are *usable*. That assumption deserved a
number, and the number is bad. Measured over the 30-file example corpus, median of nine
samples after warmup (`bun run scripts/measure-tool-latency.ts examples`):

| Operation | Median |
|---|---:|
| `mm_symbol` (x40, batched) | 0.0 ms |
| `mm_refs` (x40, batched) | 0.0 ms |
| `mm_type` (x40, batched) | 0.0 ms |
| read the 21 source files a broad slice covers | 1.1 ms |
| grep across 30 files | 2.0 ms |
| reload: parse + check + graph over 30 files | 212.5 ms |
| **`mm_slice` (build + render)** | **11 040.9 ms** |

Every *other* semantic tool is sub-millisecond, so the semantic graph itself is fast. The
whole cost is in `buildSlice`'s budget-trimming loop, and it is algorithmic:

- `closureSafeToRemove` answered "does anything still selected depend on this node?" by
  rescanning the entire selection and doing a linear `deps.includes` — once per
  candidate, once per removal.
- `scoreOf` did a linear `scored.find(...)` per candidate.
- `totalCost` re-summed the whole selection after every removal.
- The outer loop runs once per removed node.

That is cubic in the size of the selection, and eleven seconds is what a few thousand
selected nodes costs. The answer to "is anything still selected depending on this node"
is a *count*, and the count can be maintained as nodes leave; the total can be
decremented rather than recomputed.

**Why this matters more than the number.** An agent that calls `mm_slice` waits eleven
seconds. It will route around a tool that slow, and if both conditions end up using text
tools then the token comparison is between two identical conditions. The semantic runs
recorded below were taken against this slow build, so they understate what a fixed
`mm_slice` would make possible — and the fix must land before the result is quoted as
anything but a floor.

**The cost was masked, not absent.** `omp` reports `duration` on every `message_end`,
which is the model's own inference time. Subtracting it from the run's wall clock gives
everything that was not the model thinking (`bun run scripts/summarize-time.ts`):

| condition | runs | mean wall | mean model | mean non-model |
|---|---:|---:|---:|---:|
| baseline | 7 | 128.6 s | 110.0 s | 18.6 s (16 %) |
| semantic | 6 | 116.8 s | 114.9 s | 7.2 s (8 %) |

Runs are 86–94 % model inference. So an eleven-second `mm_slice` does not show up in
wall time at all — not because it is fast, but because **it was called once in thirteen
runs**. The moment agents actually use the tool, that column moves. Semantic runs
currently spend *less* non-model time than baseline runs, which is what a toolset that
is present but unused looks like.

The practical consequence for the design: tool latency is not a secondary metric here.
With the model dominating, a tool has to be fast enough that an agent tolerates it, or
it will simply not be used — and an unused semantic tool is an experiment that measures
nothing while looking perfectly healthy.

**Weak tool descriptions were ruled out.** The other explanation for low usage is that
the agent simply did not know the tools were worth calling. That is not what the
descriptions say: `mm_slice` is documented as *"A dependency-closed context sized to a
token budget, for a stated goal… Use instead of reading files to scope a task."* The
agent was told to prefer it, called it once, and did not call it again. The most
economical explanation is the eleven-second wait, not a weak prompt.

This is still an inference rather than a controlled result — the honest version of the
experiment would fix the latency and re-run, which is the next step. But it is a
prediction with a clear test: if a fast `mm_slice` does not increase `mm_tool_calls`,
the cause is somewhere else, and the descriptions become the next thing to look at.

### 8. Fixed: `mm_slice` is now 50.6 ms, and the fix was found by the scale test

The trim loop now keeps the outgoing edges of every selected node and, from them, an
incoming count. A node may leave when its count is zero, and leaving decrements the
counts of the nodes it *depended on*.

> **The first attempt was wrong in a way only the tests caught.** The decrement was
> applied to the nodes the departing node *blocked* rather than the nodes it *depended
> on* — the same edge, read backwards. It compiled, it was principled, and it was 218x
> faster. But it left 112 nodes falsely blocked, so the trim stopped at 6 165 tokens
> instead of reaching the 800-token budget. The timing test passed; the budget test
> failed. Fixing the direction made `blockersMismatch` zero against a from-scratch
> recomputation.

| | before | after |
|---|---:|---:|
| `mm_slice` (build + render), median | 11 040.9 ms | **50.6 ms** |
| vs a corpus grep | 5 493x slower | 33x slower |
| test suite wall clock | 49 s | 3.3 s |

The suite timing is the more honest number, because it includes everything the single
benchmark does not: the trim loop runs on every slice in every test.

**What this does and does not establish.** `mm_slice` at 50 ms is comfortably usable.
Whether agents now *use* it is a separate, falsifiable question, and the first sweep
gave the baseline for it: `mm_slice` was called once in sixteen runs, with 1–4 `mm_*`
calls per run out of 12–32 tool calls. If the fast build does not move that number, the
latency was not the binding constraint and the tool descriptions become the next thing
to examine.

## 9. The experiment as run confounds three things

The first sweep compared text tools against semantic tools, on MM, on tasks written in
MM, graded by tests written for MM. The semantic tooling only understands MM. So a win
for the semantic condition would be partly a fact about the apparatus having been
co-designed around one language, and the number would not generalise.

Three factors move together and only one is being varied:

| | text tools | semantic tools |
|---|---|---|
| **MM** | measured | measured |
| **Rust** | not measured | not measured |

The fix is a 2x2: hold language and tasks fixed, vary only tooling. That separates "the
projection format is a better context" from "the language is ours".

### 9.1 The Rust arm is the interesting one, not a concession

Feeding Rust through a syntax parser into the *same* graph shape — reusing `buildSlice`
and `renderSlice` unchanged — is the experiment with the most information in it:

- If the format carries the benefit, it transfers, and the win is about compact
  structured context rather than about MM.
- If it does not, the benefit needs type and ownership awareness rather than a tidy
  projection. That is the more useful result, and it is only visible if the Rust
  projection is *weaker* than MM's.

That last point cuts against the obvious instinct. Building an `mm_slice` on Rust as
capable as MM's would match the co-design advantage and destroy the experiment. A
syntax-only projection is the point.

### 9.2 What has to be true before the 2x2 is worth building

The four cells are only meaningful if the treatment is actually applied. In the first
sweep it was not: `mm_slice` was called once in sixteen runs. A 2x2 built on an inert
treatment would give four cells, two of which are not testing the thing they name.

So the order is: fix the latency (done — §8), re-run the MM arm, and check that
`mm_tool_calls` actually rises. If it does not, latency was not the binding constraint
and the tool descriptions are the next thing to look at. Only then is the Rust arm
worth building.

### 9.3 A within-language ablation that is nearly free

The 2x2 is the right design but it is expensive. One cell is almost free and would
separate two different claims about the semantic condition:

- `baseline+grep` (current baseline) — semantic tools replace grep
- `semantic+grep` — semantic tools are *added* to grep

If `semantic+grep` performs like `semantic`, the value is in the tools being present.
If it performs like `baseline`, then the measured effect is agents choosing grep *over*
the tools, which is a usability finding rather than a capability one. That needs no
new tasks and no new language, and it discriminates between two explanations the 2x2
would otherwise conflate.

### 9.4 The prompts do not leak the treatment

Checked, because it would be an easy way to manufacture a result. Every `prompt.txt`
describes the defect in domain terms only — the fields, the dispatcher, the wrong
header — and contains no occurrence of `mm_`, `slice`, `semantic`, or `grep`. The
baseline and semantic agents are handed byte-identical task text; the only difference
between them is the tool set, which is the treatment.

What the agents *are* told differs, necessarily: OMP's system prompt enumerates the
active tools, so the semantic agent knows the semantic tools exist. That is the
treatment, not a leak — withholding it would be testing a hidden feature rather than an
available one.


### 9.5 A timeout is a failure *and* an unbounded cost, and averaging it in flips the answer

This is the one methodological error in the harness that changed a conclusion, so it is
recorded rather than quietly corrected.

The first scorer averaged input tokens over every run. But a run that hits the wall-clock
cap keeps spending tokens until it is killed — it is a failure *and* an unbounded cost,
and folding it into a mean measures "what a broken run costs before it gives up" rather
than "what a run costs". On the fast-build sweep that was enough to reverse the sign of
the result: the all-runs mean said the semantic condition was about a quarter cheaper,
and the median said it was *dearer*. The mean was being dragged by the timeout runs, and
the timeout runs were concentrated in the baseline arm.

`score.ts` now reports both: the all-runs statistics and the finished-only statistics,
side by side, with the count of runs that reached a terminal state. Neither can quietly
do the work on its own.

The general lesson is the one the report itself states about context reduction — a
number that only means something next to the other axis. Here the other axis is *what
kind of run produced it*. "The semantic condition used fewer tokens" is not a claim
until you know whether the baseline's extra tokens were productive work or an agent
looping until it was killed.

---

## Results

The fast-build sweep, plus the ablation arm: 4 tasks × 2 repeats,
`cl100k_base` and `freeflow/space-bunny-free`.

| condition | runs | passed | pass rate | mean in_tok | median in_tok | range | mm calls |
|---|---:|---:|---:|---:|---:|---|---:|
| baseline — grep | 8 | 5 | 63 % | 13 806 | 12 284 | 4 457–27 792 | 0 |
| semantic — mm tools, no grep | 8 | 7 | 88 % | 10 469 | 10 674 | 3 882–17 988 | 13 |
| semantic_grep — both | 8 | 8 | **100 %** | 10 378 | **8 352** | 2 236–24 580 | 12 |

Restricting to runs that reached a terminal state, which is the comparison §9.5 says is
the honest one:

| condition | finished | mean in_tok | median in_tok |
|---|---:|---:|---:|
| baseline | 6 | 11 822 | 12 284 |
| semantic | 7 | **9 964** | 9 163 |
| semantic_grep | 8 | 10 378 | **8 352** |

Both non-baseline arms land well below baseline, and the ablation does **not** cleanly
separate the two explanations: `semantic` is cheaper by mean, `semantic_grep` by median,
and the two statistics disagree about which arm is better. That is the signature of a
2.4x noise floor rather than of an effect.

The tools are used about equally with and without `grep` available — 13 calls against 12
— which is the same preference seen throughout: given a choice, the agent reaches for
`grep` and `read` and leaves the projection alone.


### 10.1 But the saving cannot be attributed to the semantic tools

This is the finding that governs how much any of the above is worth.

`mm_slice` was called **zero times** in sixteen runs. Total `mm_*` invocations across the
whole semantic arm: 13, over eight runs, ranging from 0 to 3 per run.

The prediction recorded in §8 was explicit — if the fast build did not move usage,
latency was not the binding constraint and the descriptions were next. It did not move
usage, and `mm_slice` actually went *down*, from one call on the 11-second build to none
on the 50 ms build. So the tool was made 218× faster and the agents used it less.

Which means the comparison above is not measuring semantic tooling. The semantic arm
differed from baseline in two ways at once: it **lost `grep`** and it **gained eight
tools it almost never called**. The likeliest explanation for a 16–25 % context saving
and a higher pass rate is the first of those, not the second — an agent that cannot
grep reads less, and reads less because it has to, not because it chose a better context.

### 10.3 The tools were advertised on every turn, and ignored

The obvious alternative explanation is discoverability: maybe the agent never saw the
tools, or never read their descriptions. The event stream rules that out.

Across the eight semantic runs the tool schema is re-sent on every turn, so the
descriptions appear hundreds of times:

| tool | mentions in the event stream | actual calls |
|---|---:|---:|
| `mm_check` | 363 | 13 |
| `mm_packet` | 36 | 3 |
| `mm_symbol` | 30 | 2 |
| `mm_slice` | **15** | **0** |
| `mm_refs` | 10 | 0 |

`mm_slice`'s description is literally *"Use instead of reading files to scope a task."*
The agent read that hundreds of times and called it never. So the 218× speedup did not
fail to be noticed because it was too slow to be noticed: the tools are visible,
described, and recommended, and the agent reaches for `read` and `bash` anyway.

That is a finding about the design rather than about the benchmark. A projection only
pays for itself if the agent prefers it to reading the file, and on this task set, with
this model, it does not. Either the projection becomes the *only* way to get the
information, or it has to be good enough that choosing it is the obvious move — which
50 ms and a clear description demonstrably are not.

`semantic_grep` exists to settle the grep question, and it is the experiment that matters
now. It differs from `semantic` by exactly one tool.

### 10.4 The sandbox is advisory, not enforced

During the fast-build sweep a `repro.mm` appeared at the **repository root** — a correct
fixed version of the `slot_pool` fixture, all four of its tests passing. It was an
agent's scratch file, written outside the run's `work/` directory.

The guarantee that actually matters held: the loader lives at `.harness/loader/`,
outside every `work/`, so the agent under test cannot edit the tool it is being measured
on. But nothing *prevents* an agent from writing elsewhere in the tree — it can reach the
repo root with an absolute path, and it did.

This is worth stating rather than fixing quietly, because the experiment's validity rests
on the assumption that agents only touch their own sandbox. In practice:

- the loader is safe by placement, not by sandbox;
- agents can and do write outside `work/`, so a post-sweep `git status` is part of the
  harness's own hygiene, not an optional check;
- a stray file left at the repo root is also a *false positive* waiting to happen — had
  it been a `.mm` file, a later `mm check .` would have picked it up.

`collectSources` now skips dot-directories and `scratch/`, which limits the blast radius,
but a file written to the repo root is still collected. Enforcing the sandbox is a real
piece of work; noting the gap is the honest minimum until then.

### 10.5 Verdict: the experiment as designed cannot measure the claim

The honest summary of 24 runs across three arms:

**What is real.** Semantic tooling exists, loads into a real agent session, and answers
correctly. A goal-directed slice is **0.166–0.229** the size of the source it replaces
(exact BPE). The semantic arm passed more often than baseline — 88 % against 63 % — and
spent fewer input tokens on runs that finished, by both mean and median. None of that
is nothing.

**What the data does not support.** Three findings each independently block the claim
the report makes:

1. **The treatment was not applied.** `mm_slice` was called zero times in sixteen runs.
    Total `mm_*` calls across the whole semantic arm: 13, over eight runs, 0–3 per run.
    The projection cannot be credited with a token saving it was never asked for.
2. **The noise floor is larger than the effect.** Two runs of the *same condition on the
    same task* differ by a median of **2.4×** — and by 11× on `tally/semantic_grep`. The
    between-condition gap in question was 16 %. A 16 % difference is not distinguishable
    from a 2.4× run-to-run spread at n = 2. `node .harness/spread.mjs` prints it.
3. **The measurement is confounded with the language.** Tasks, grader and tooling were
    all built for MM. Even a clean result would not generalise (§9).

**So the verdict is: unproven, and the experiment is not currently capable of proving
it.** That is a different statement from "the idea does not work", and the distinction
matters — nothing here shows the projection is useless. It shows that *this* experiment,
at this size, on these tasks, with these tools, cannot tell.

### 10.6 What would make it answerable

In rough order of leverage:

1. **Make the agent use the tool, or stop measuring it.** Either the projection becomes
   the only route to the information — so not using it means failing — or the question is
   abandoned. Nothing in between produces an interpretable experiment. This is the
   binding constraint, and no amount of extra repeats fixes it.
2. **Raise n until the effect clears the noise floor.** The spread is 2.4×, so
   separating a 16 % difference needs roughly an order of magnitude more runs per cell
   than we have. That is expensive, and it is only worth paying after (1).
3. **Hold the language fixed** (§9): run the same arm on Rust with a deliberately weaker
   projection, so "the projection helps" is separable from "the language is ours".
4. **Drop the tasks that time out.** Three of sixteen runs hit the 420 s cap, and a
   timeout is both a failure and an unbounded cost, which forced §9.5's whole correction.
   A task set where agents reliably finish would remove an axis of variance that has
   nothing to do with the hypothesis.

The cheapest next measurement is (4), followed by (1). Neither requires new tasks or a
new language.

### 10.7 A caveat on every number above

The sweep in this section was taken against a compiler that **refused correct code**,
and that was not known when the runs happened. Two defects, both systematic:

- `test` bodies were not type-checked at all. Every `assert_eq` in the fixtures lives in
  one, so the compiler's answers about the parts of a program an agent actually reasons
  about were never exercised by the corpus.
- A `view` parameter was not satisfied by naming a place, though the interpreter has
  always lent the place. 198 call sites were rejected that the interpreter runs.

So the semantic condition had a working `mm_check` that lied to it, and the agents were
reasoning about a compiler that disagreed with the interpreter on the language's central
ownership feature. Those runs are preserved in `.harness-runs-precompilerfix/` and the
sweep has been re-run against the fixed compiler.

This is the same lesson as the rest of this document, arriving from a new direction: the
measurements were real, the instrumentation was faithful, and the thing being measured
was broken in a way nobody had checked. **A harness cannot tell you the compiler is
wrong; only running the compiler against something else can.**

---

## Honest limits

- **The treatment was barely applied, so the sweep does not yet test the hypothesis.**
  This is the most important limit and it is not a caveat at the margin. Across the six
  semantic runs, total `mm_*` calls per run were between 1 and 4, out of 12 to 32 total
  tool calls. `mm_slice` — the flagship tool, and the one the report's design is built
  around — was invoked **once in the entire sweep**. The semantic condition was, in
  practice, "text tools plus a brief semantic check". Any token difference between the
  conditions is therefore mostly a difference between two agents doing nearly the same
  thing, and it cannot be read as a measurement of semantic tooling.

  The most likely cause is finding 7: a tool that takes eleven seconds gets used once.
  The fix has to land, and the sweep has to be re-run, before this experiment says
  anything about whether the design works.

- **n is small.** The sweep is 4 tasks × 2 conditions × 2 repeats. That supports a
  direction, not a significance claim. No p-value is reported and none should be.
- **Within-condition spread is comparable to the between-condition gap.** Observed input
  tokens within a single condition ranged from 1 911 to 6 930. A mean over two runs is
  not a measurement, which is why the scorer prints min–max beside it.
- **One model, one provider, one prompt shape.** Nothing here establishes that the result
  transfers to a different model.
- **The tasks are synthetic.** They were written against this codebase and this
  language's idioms, which plausibly favours the condition that offers semantic tools.
- **The token metric is input tokens from the provider**, not the tokenizer used in §3.
  Both are recorded, and they are not the same quantity.

## Reproducing

```
cd mm/.harness
bun runner.ts --tasks bitfield,slot_pool,tally,checkdigit \
              --conditions baseline,semantic --repeats 2 --timeout 420
bun score.ts --runs-dir runs --tasks-dir tasks
```

`runner.ts` is resumable: a run whose `run.json` exists is skipped, so an interrupted
sweep continues where it stopped. Results land in `runs/results.json` and
`runs/summary.json`.
