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

## Honest limits

- **n is small.** The sweep is 4 tasks × 2 conditions × 2 repeats. That supports a
  direction, not a significance claim. No p-value is reported and none should be.
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
