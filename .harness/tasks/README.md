# Task fixtures

Four bug-fixing tasks for the context-cost / task-success experiment. Each one
is a small self-contained MM program that runs correctly apart from exactly one
planted defect, so the agent has to reason about what the code is supposed to
compute rather than just run the tests and read a failure.

For every fixture the seed's own `test` items pass with the defect in place -
the defect is latent for the input class the seed exercises - and the hidden
test, which is never present in the agent's work directory, fails on the seed
and passes once the defect is fixed.

| id | subsystem | planted defect |
|---|---|---|
| `bitfield` | arithmetic / bit fields | `tag_of` masks the 12-bit tag field at the length field's 10-bit width, so tags of 1024 and above come back truncated and `score` / `handler_for` dispatch on the wrong header. |
| `slot_pool` | ownership / lifetime | `alloc` stamps a reused slot with the pool's unchanged generation, so a handle that was already retired still passes `is_stale` and reads the record the new occupant put there. |
| `tally` | data structure | The open-addressing probe walks forward but never wraps at the end of the slot array, so a key whose probe run runs off the end reads back as absent and re-inserting it creates a duplicate bucket instead of bumping a count. |
| `checkdigit` | text / serialization | `luhn_total` alternates the doubling pass from the leftmost digit instead of following the parity of the string's length, so odd-length numbers total wrongly and even-length payloads get a check digit that does not complete them. |

## Layout

```text
tasks/<id>/
  task.json            the task manifest
  prompt.txt           the exact prompt handed to the agent
  seed/<id>.mm         the program the agent sees and edits, defect included
  hidden/<id>_test.mm  the grading test; never copied into the work directory
```

`task.json` uses the snake_case spelling of the harness contract:
`prompt_file`, `hidden_test`, `id`, `description`. `.harness/runner.ts` reads
both spellings, so nothing depends on the camelCase form.

The hidden test opens with `use <id>`, so grading it means putting
`seed/<id>.mm` and `hidden/<id>_test.mm` in the same directory and running
`bun run src/cli.ts run <that directory>`: every test must report `ok`.

This file is for the human reader. No prompt refers to it, and no task
directory contains it.

## Checking a fixture without trusting the harness

Grading is `bun run src/cli.ts run <dir>` over a directory holding
`seed/<id>.mm` and `hidden/<id>_test.mm` side by side. A fixture is sound when
the hidden tests fail on the seed and pass once the defect is fixed. The
recipe below does exactly that, in a scratch directory, so it never disturbs
the fixtures themselves.

Run this from the repository root (`mm/`), in a shell that has `bun` and GNU
`sed` on `PATH`:

```sh
verify() {
  T=$1; FIX=$2; W=$(mktemp -d)
  cp ".harness/tasks/$T/seed/$T.mm" ".harness/tasks/$T/hidden/${T}_test.mm" "$W"/
  echo "--- $T ON THE SEED: every ${T}_test.mm line must say FAIL"
  bun run src/cli.ts run "$W" | grep -E '^(ok|FAIL)'
  echo "--- $T reference fix applied"
  sed -i "$FIX" "$W/$T.mm"
  echo "--- $T AFTER THE FIX: every line must say ok"
  bun run src/cli.ts run "$W" | grep -E '^(ok|FAIL)'
  rm -rf "$W"; echo
}
```

Then one call per task, each supplying the reference fix as a `sed` program:

```sh
verify bitfield 's|pow(2, TAG_SHIFT)) % pow(2, LEN_BITS)|pow(2, TAG_SHIFT)) % pow(2, TAG_BITS)|'

verify slot_pool 's|^    let h = Handle::at(index, p.gen);$|    p.gen = p.gen + 1; let h = Handle::at(index, p.gen);|'

verify tally '/^fn probe/,/^}/{
s|^    let mut i = home(key);$|    let mut i = home(key); let mut steps = 0;|
s|^    while i < SLOTS {$|    while steps < SLOTS {|
s|^        i = i + 1;$|        i = (i + 1) % SLOTS; steps = steps + 1;|
}'

verify checkdigit 's|if i % 2 == 0 { d = fold(d \* 2) };|if i % 2 == s.len() % 2 { d = fold(d * 2) };|'
```

The `sed` program is the reference fix, not part of the fixture: the graded
artefact is `seed/<id>.mm` and the hidden test only. It is spelled out here so
that a human can confirm the hidden test really discriminates, without having
to take the harness's word for it.

### What each run should print

| task | on the seed | after the fix |
|---|---|---|
| `bitfield` | 4 of the 6 `bitfield_test.mm` tests FAIL; the 2 seed tests and 2 regression guards pass | 7 of 7 `ok` |
| `slot_pool` | 5 of the 6 `slot_pool_test.mm` tests FAIL; the 3 seed tests and 1 regression guard pass | 9 of 9 `ok` |
| `tally` | all 6 `tally_test.mm` tests FAIL; the 3 seed tests pass | 9 of 9 `ok` |
| `checkdigit` | 5 of the 6 `checkdigit_test.mm` tests FAIL; the 5 seed tests and 1 regression guard pass | 11 of 11 `ok` |

The tests that pass on the seed are deliberate: the seed's own tests must stay
green so the agent cannot find the defect by running them, and the extra
hidden tests that pass are regression guards that confirm the fix does not
disturb the cases that were already right.

A run that reports no `FAIL` line at all on the seed, or no `ok` line after
the fix, means the fixture is not discriminating and must not be used.
