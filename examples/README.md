# MM example corpus

Thirty self-contained, runnable programs covering the report's benchmark matrix.
Each file is one module, has no imports beyond the few it names explicitly, and
ends with `test` items that assert concrete numeric or string results. Together
they exercise integers, floats, bytes, text, slices, maps, records, unions,
choices, generics, recursion, `view` / `view mut`, `shared`, `arena`, `handle`,
`@resource`, `@wire`, and `Decision`.

A file with no effect row is pure: it performs no I/O, no clock or randomness
reads, and no agent calls. Only the three files whose effects column is
non-empty declare a row, and each of those declares it explicitly.

| file | what it demonstrates | ownership constructs used | effects |
|---|---|---|---|
| `fib_iterative.mm` | Fibonacci as a caller-owned buffer and as a rolling pair; the loop a compiler benchmark measures | `view mut [u64]`, owned `u64` locals | none (pure) |
| `fib_recursive.mm` | Naive, tail-recursive, and accumulator recursion; call-count growth | owned `u64` params, owned returns | none (pure) |
| `sieve.mm` | Sieve of Eratosthenes over a caller-owned `[bool]`; allocation-free marking | `view mut [bool]`, `view [bool]` | none (pure) |
| `bubble_sort.mm` | Generic in-place sort with an explicit swap count; read-only verification pass | `view mut [T]`, `view [T]`, `[T: Ord]` bound | none (pure) |
| `quicksort.mm` | Generic quicksort with Lomuto partitioning and an explicit index range | `view mut [T]`, `view [T]`, `[T: Ord]` bound | none (pure) |
| `merge_intervals.mm` | Insertion sort by key plus a linear merge sweep; bounds returned as a tuple | `view mut [Interval]`, `view [Interval]`, tuple `Span` | none (pure) |
| `hash_fnv1a.mm` | FNV-1a over bytes, over `Text`, and over a chunk list; order-sensitive combination | `view Bytes`, `view [Bytes]` | none (pure) |
| `checksum_crc32.mm` | CRC-32 twice: bitwise folding and a 256-entry table built from the same polynomial | `view Bytes`, `view mut [u32]`, `view [u32]` | none (pure) |
| `base64.mm` | Base64 encode and decode, including one- and two-byte tails, through caller-owned buffers | `view Bytes`, `view mut [u8]` | none (pure) |
| `json_parser.mm` | Recursive-descent parser over `Text` into a `@wire` tagged union, with `?` propagation | `@wire` union, `Result` / `?`, owned `Text` values | `fs.read` |
| `csv_parse.mm` | Zero-copy line and field splitting into borrowed `Text` slices; numeric field parsing | `view mut [Text]`, `Result` / `Err` | none (pure) |
| `matrix_mul.mm` | Dense `f32` multiply, scale, and trace over nested slices | `view [[f32]]`, `view mut [[f32]]` | none (pure) |
| `binary_search.mm` | Iterative, recursive, and lower-bound search; probe counting for the harness | `view [u32]` | none (pure) |
| `linked_list.mm` | Owned recursive union; `view` traversals beside a consuming traversal | owned `List`, `view List`, `match` destructuring | none (pure) |
| `btree_minimal.mm` | Binary search tree in caller-owned memory, reached only through generational `handle` slots | `handle Slot`, `view Tree`, `view mut Tree` | none (pure) |
| `graph_traverse.mm` | Breadth-first and depth-first walks of a `Map` adjacency table, sharing one seen-set | `Map<u32, [u32]>`, `view Graph`, `view mut` visit buffers | none (pure) |
| `arena_alloc.mm` | Bump allocation, swap-remove free, and the arena-borrowed read that may not escape | `arena Arena`, `view mut Arena`, `view Arena` | none (pure) |
| `handle_store.mm` | Generational handle store: retire a slot, watch old handles go stale, reuse the slot | `handle Entry`, `view Store`, `view mut Store` | none (pure) |
| `shared_graph.mm` | `shared` node graph with cyclic peer links; refcount discipline across a walk | `shared Node`, peer list of `shared` | none (pure) |
| `resource_file.mm` | `@resource` handle with a close path, an early return, and the drop that still runs | `@resource(close = fs.close)`, `Handle<Fd>`, `view File`, `?` | `fs.read`, `fs.close` |
| `option_result_zoo.mm` | `Some`/`None`, `Ok`/`Err`, `?`, unwrap-or, map, and and-then in one module | `u32?`, `Result<T, E>`, `view` params | none (pure) |
| `iterator_pipeline.mm` | map / filter / take over slices, as separate passes and as one fused pass | `view [u32]`, `view mut [u32]`, `fn(u32) -> u32` pointers | none (pure) |
| `word_count.mm` | UTF-8 aware splitting and counting into `Map<Text, u32>`; continuation bytes never split a word | `view mut Map<Text, u32>`, `view Map<Text, u32>` | none (pure) |
| `text_reverse_words.mm` | In-place byte reversal, word-order reversal, and a palindrome check | `view mut [u8]`, `view mut [Text]` | none (pure) |
| `roman_numerals.mm` | Integer to numeral by four digit tables, and the subtractive parse back to an integer | `const` tables, `Text` values | none (pure) |
| `caesar_cipher.mm` | ASCII shift with per-case wrapping; encrypt and decrypt round trip | `view mut [u8]`, `view` byte slices | none (pure) |
| `state_machine.mm` | Tagged union state driven by a `match` transition table, with a final absorbing state | owned `State` union, `match` destructuring | none (pure) |
| `tiny_vm.mm` | Stack machine over a `[u8]` bytecode program: explicit pc, sp, step budget, and a disassembler | `view [u8]`, `view mut [u32]` | none (pure) |
| `event_sourcing.mm` | Append-only `@wire` event log folded into state, plus the wire encoding | `@wire` union, owned `Account` state | none (pure) |
| `routing_intent.mm` | Agent routing: a `choice` enum returned inside a `Decision`, with a deterministic rule to check it against | `choice` type, `@intent`, `Decision<Route>` | `agent`, `nondet`, `clock` |

## Writing rules these files follow

The corpus is written against the parser as it exists today, so it stays
loadable while the analysis passes land:

- ASCII only. The lexer indexes source bytes but slices the JS string, so a
  multi-byte character in a comment desynchronises the two.
- Shifts are written as division by a power of two: the tokeniser has no `<<`
  or `>>` token, and the operands are unsigned, so the meaning is unchanged.
- A statement-position `if`, `while`, `for`, or `match` ends with `;` unless it
  is the last thing in its block; the parser otherwise reads it as the block's
  tail value and closes the block early.
- Struct and variant literals appear at statement level, never inside a call
  argument, an array literal, or an `if` block; the parser suppresses struct
  literals in all three positions. Values are built by a named constructor and
  then passed.
- Variant construction uses the bare variant name (`Deposited { amount: 1 }`),
  the same form the `match` patterns use.

## Running them

`tests/examples.test.ts` loads all thirty files into one `Program` and asserts
that each parses with zero diagnostics and declares at least one `test` item.
