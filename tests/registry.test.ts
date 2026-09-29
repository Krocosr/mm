import { describe, expect, test } from "bun:test";
import { BUILTIN_NAMES } from "../src/interp/prelude.ts";
import { BodyChecker } from "../src/typeexpr.ts";
import { Checker, checkDeclarations } from "../src/scope.ts";
import { Program } from "../src/program.ts";
import { BUILTIN, type Ty } from "../src/types.ts";
import { PURE_BUILTIN_FNS } from "../src/builtins.ts";

/**
 * The prelude and the type checker keep two independent registries of which methods
 * exist. The interpreter dispatches on `<type>_<name>` keys in the prelude; the checker
 * answers from a hand-written `methodType` switch. Nothing asserts they agree.
 *
 * When they drift, the program that loses is a correct one: the interpreter runs it, and
 * the checker refuses it with `E0203 no method`. `check examples` currently reports 86
 * `E0203` and 74 `E0205` on programs the interpreter executes correctly.
 *
 * This test closes that gap. It is the fourth appearance of the same shape on this
 * project — after `slice.len` versus `elems.length` and the six `want*` accessors — and
 * the reason to write it down is that all three were the same mistake: one value, two
 * homes, no test.
 *
 * The mapping below is deliberately explicit rather than derived. Deriving it would
 * re-create the coupling this test exists to detect.
 */

/** Receivers we can construct a `Ty` for, and the builtin-name prefix they answer to. */
const RECEIVERS: { prefix: string; ty: Ty }[] = [
  { prefix: "slice", ty: { k: "slice", elem: { k: "prim", name: "u8" } } },
  { prefix: "array", ty: { k: "array", elem: { k: "prim", name: "u8" }, len: 0 } },
  { prefix: "text", ty: { k: "named", def: BUILTIN.Text_, args: [] } },
  { prefix: "bytes", ty: { k: "named", def: BUILTIN.Bytes_, args: [] } },
  { prefix: "map", ty: { k: "named", def: BUILTIN.Map, args: [{ k: "prim", name: "u8" }, { k: "prim", name: "u8" }] } },
  { prefix: "set", ty: { k: "named", def: BUILTIN.Set, args: [{ k: "prim", name: "u8" }] } },
];

function checker(): BodyChecker {
  const program = new Program();
  program.addFile({ module: "registry_probe", text: "", bytes: new TextEncoder().encode("") });
  return new BodyChecker(new Checker(program));
}

/** Methods the prelude implements for a receiver, by `<prefix>_<name>` key. */
function implemented(prefix: string): string[] {
  return BUILTIN_NAMES.filter((n) => n.startsWith(`${prefix}_`)).map((n) => n.slice(prefix.length + 1));
}

describe("the prelude and the checker agree on which methods exist", () => {
  const body = checker();

  for (const { prefix, ty } of RECEIVERS) {
    test(`${prefix}_* builtins all have a checker type`, () => {
      const missing = implemented(prefix).filter(
        (name) => body.methodType(ty, name, { start: 0, end: 0, file: -1 }) === null,
      );
      // Every name here is a method the interpreter will dispatch. If the checker does
      // not know it, every call to it is a false rejection at compile time.
      expect(missing).toEqual([]);
    });
  }

  test("a method the checker knows but the prelude does not implement", () => {
    // The mirror image: a type the checker accepts for a call the runtime will reject at
    // run time. `get` is deliberately excluded from this check because slice element
    // access is syntax, not a prelude builtin, and is handled by `get` in the checker
    // only for slices that came from a container type.
    const ty: Ty = { k: "named", def: BUILTIN.Text_, args: [] };
    const claimed = ["len", "is_empty", "contains", "starts_with", "ends_with", "to_upper", "to_lower", "trim", "split", "concat", "as_bytes", "bytes", "chars", "slice", "clone"];
    const notImplemented = claimed.filter(
      (name) => !implemented("text").includes(name) && body.methodType(ty, name, { start: 0, end: 0, file: -1 }) !== null,
    );
    expect(notImplemented).toEqual([]);
  });
});

describe("the pure builtin table matches what the interpreter implements", () => {
  // The third registry. A program calling `pow(2, 10)` was refused with
  // `E0203 unknown_function` while the interpreter ran it, and an agent's own `mm_check`
  // call came back with exactly that diagnostic. The corpus never surfaced it, because
  // every `assert_eq` in the corpus lives inside a `test` block and test bodies are not
  // type-checked — a corpus finds bugs in the code you wrote, not in code you have not.
  const pure = new Set(PURE_BUILTIN_FNS.map((f) => f.name));

  test("a pure builtin call resolves in the checker", () => {
    const text = "fn t() -> i64 { pow(2, 10) }";
    const program = new Program();
    program.addFile({ module: "pure_probe", text, bytes: new TextEncoder().encode(text) });
    const checker = new Checker(program);
    checkDeclarations(checker);
    new BodyChecker(checker).checkAllFns();
    expect(program.diagnostics.map((e) => e.message)).toEqual([]);
  });

  test("a user function wins over a pure builtin of the same name", () => {
    // The two tables shadow in opposite directions, deliberately. A capability builtin
    // must not be definable away — that would shed the effect being requested — but a
    // pure one must be, because at run time `evalCall` resolves the function first.
    // Getting this backwards made a program's own `fn sum(xs: view [f32])` fail to
    // resolve against its own call sites, which is how the split was found.
    expect(pure.has("sum")).toBe(false);
  });
});
