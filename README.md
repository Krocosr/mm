# MM — a negative result about agent context

**The thesis:** an agent working from a compact, compiler-maintained semantic projection
of a codebase needs materially less context than one reading source — *without completing
fewer tasks*.

**The finding:** the hypothesis is false, and not for want of a clean experiment. It is
false because the projection contained no statements, and therefore could not stand in
for source no matter how cheap it was.

---

## The one measurement that matters

The project's headline number was a slice costing **0.166–0.229** of the source it
replaced. That number was real, reproducible, and did not mean what it appeared to.

A slice renders signatures, call edges, field types, local variables with their
ownership, effect rows and test names. It renders **no statements** — the actual
instructions. So we tested what happens when the code grows and the symbols do not, by
padding every function body with executable statements that declare no new names:

| fixture | source growth | slice growth |
|---|---:|---:|
| bitfield | +176.0 % | **0.0 %** |
| slot_pool | +101.9 % | **0.0 %** |
| tally | +124.6 % | **0.0 %** |
| checkdigit | +108.5 % | **0.0 %** |

The bodies more than doubled. The projection did not move by one token.

**A slice's cost is a function of how many symbols exist, and is entirely independent of
how much implementation those symbols contain.** The ratio was measuring a file's
function count, not how much of the source reached the agent.

This is structural, not statistical. It is deterministic, it holds at n=1, and it is
asserted by `tests/projection-sensitivity.test.ts` so it cannot be quietly unlearned.
No repetition of the experiment, in any language, with any tool polish, can measure the
claim — because the information the claim is about is not in the thing being measured.

```bash
bun run scripts/measure-slice-sensitivity.ts
```

> A methodological trap worth repeating: padding with `let _padN = 1` adds a *local*, and
> locals *are* in the projection. That padding reports **+24 %** and supports the opposite
> conclusion. A measurement that returns 0 % everywhere is usually measuring nothing.

## The instrument lied for 24 runs

The agent harness was built to compare three conditions — text tools, semantic tools,
and semantic tools plus grep — over 4 tasks × 3 arms × 2 repeats.

The first sweep reported **63 %** for baseline and **88 %** for semantic. That looked
like a result. It was the instrument's error.

The compiler being measured **rejected 198 call sites that were correct**, and never
type-checked `test` bodies at all — which is where every assertion in the fixtures
lived. The semantic arm had a working `mm_check` reporting errors on correct code.

After fixing it, all 24 runs were repeated:

| condition | pass before | pass after | `mm_*` calls |
|---|---:|---:|---:|
| baseline | 63 % | **100 %** | 0 |
| semantic | 88 % | 88 %* | 8 |
| semantic_grep | 100 % | 100 % | 14 |

\* one crashed run, not a wrong answer.

**The 63 % vs 88 % gap was the false rejections biting the text-tool arm.** Scoring that
sweep on pass rate and stopping there would have reported a semantic-tools advantage that
does not exist. A harness cannot detect that the system under test is wrong — every number
was real, every run was graded, and the instrument was miscalibrated throughout.

## The treatment was never applied

Across 16 semantic runs, `mm_slice` — documented in its own schema as *"use instead of
reading files to scope a task"* — was called **zero** times. On `omp` 18.4.4 with a
working compiler, one run produced `mm_check` 5 times against `bash` 193. The `mm_check`
call returned `[]`, `isError: false`: correct.

Latency was not the reason. `mm_slice` was optimised from **11 040 ms to 50.6 ms** and
usage did not rise. The tools were available, fast, correct, and described as preferred.
They were ignored.

## The noise floor

| | before fix | after fix |
|---|---:|---:|
| within-cell spread (median) | 6.2× | **15.0×** |
| between-condition median gap | 16 % | 3 % |

At n=8, two runs of the *same condition on the same task* differed by up to 12.5×. Once
the pass axis saturated at 100 % in every arm, tokens were the only quantity left — and
tokens are noise. The experiment has no measurable outcome left to be underpowered about.

## The prior art, found too late

The generalised version of this thesis already ships, free and battle-tested:
**[Graphify](https://github.com/Graphify-Labs/graphify)** — ~122 000 stars, Y Combinator
S26, Apache 2.0, tree-sitter across ~40 languages, installed as a `/graphify` skill in
Claude Code, Cursor, Codex and Gemini CLI. It turns a codebase into a queryable knowledge
graph instead of something you grep. That is the thesis, already working.

Graphify is *syntactic*; MM's graph resolves types, ownership and effects and rejects a
program that double-frees. So the depth difference is real. It also runs the wrong way:
what MM has that Graphify lacks is precisely the capability this project's own experiment
showed agents do not use.

Graphify also tags every edge `EXTRACTED` or `INFERRED` — the provenance discipline this
repository's §10.7 exists because it lacked.

**Ten minutes of searching would have shown it.** The work began from a written report,
and once inside a thesis, "codebase knowledge graph" stopped being a search term and
became internal vocabulary. That is the most expensive lesson here, and the only one that
was free to avoid.

---

## What generalises

1. **Test a "reduction" claim for sensitivity to what it reduces.** If a 128 % larger
   body moves a summary by 0 %, the ratio is measuring the wrong thing.
2. **Verify the instrument, not just the experiment.** Run the system under test against
   something it was not built for. A harness cannot tell you the compiler is wrong.
3. **A passing arm is not evidence for it.** The pre-fix gap pointed the right way and
   was entirely the instrument's error.
4. **Separate "inert" from "no effect".** A null result is uninterpretable until you have
   measured that the treatment happened.
5. **Report the noise floor before the effect.** Ours was 15× against a 3 % gap.
6. **Check whether the problem is already solved** — before the first line of code.

## What is in here

A systems language, built to test the thesis and kept because the build was real:

- lexer, parser, formatter, HIR, type/effect/ownership checker, interpreter
- a content-hashed semantic graph with a queryable slice and packet projection
- a CLI, a stdio daemon, and an OMP extension exposing eight `mm_*` tools
- **216 tests**, a **29/29** adversarial safety corpus (118 assertions)
- a 24-run agent harness with an objective grader, run isolation and a scorer

The compiler's own `check examples` went **178 → 76** errors during the work, most of the
remainder being genuine. A type-alias expansion gap is documented and unfixed.

### Layout

| path | what |
|---|---|
| `docs/harness.md` | the experiment: design, findings 1–10, results, verdict |
| `docs/checkpoint-1.md` | the language build, and §3.2 on what the ratio did not measure |
| `docs/evidence/` | the three sweeps' scored summaries (60 KB) |
| `scripts/measure-slice-sensitivity.ts` | the measurement that refutes the thesis |
| `tests/projection-sensitivity.test.ts` | asserts the zero-growth property |
| `scripts/compare-sweeps.ts` | before/after, with the spread |

## Reproducing the refutation

```bash
bun install
bun test tests                                  # 216 pass
bun run scripts/measure-slice-sensitivity.ts    # slice growth 0.0%
bun run scripts/verify-fixtures.ts              # fixtures verified both directions
```

Archived at tag `archive/2026-09-30`. 62 commits.

## Why keep a refuted project

Because "this didn't work" is only useful when it says *why*, precisely enough that
someone can check it. Here the why is deterministic and asserted by a test: the
projection carries no statements, so it cannot substitute for source regardless of what
an agent spends on it. A weaker positive — had the numbers come out favourably — would
have been worth less, because it would have been a measurement of something other than
the claim.

The transferable asset is the method: the false-rejection audit, fixture verification in
both directions, and the sensitivity check are the parts worth carrying to the next
project.
