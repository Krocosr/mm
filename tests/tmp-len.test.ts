import { analyzePasses } from "../src/check.ts";
import { runFn } from "../src/interp/interp.ts";
const src = `
type List = Nil | Cons { head: u32, tail: List }
fn slen(xs: view [u32]) -> usize { xs.len() }
fn total(xs: view List) -> usize {
    match xs { Nil => 0, Cons { head, tail } => head + total(tail) }
}
fn len(xs: view List) -> usize { match xs { Nil => 0, Cons { head, tail } => 1 + len(tail) } }
test "t" { assert_eq(1,1) }
`;
const p = analyzePasses([{ module: "e", text: src }]).program;
const S = (v: any): string => typeof v === "object" && v ? v.k + ":" + String(v.v ?? v.name ?? v.length ?? "?") : String(v);
for (const name of ["slen", "total", "len"]) {
  const f = p.allFns().find((x) => x.name === name)!;
  const args = name === "slen" ? [({ k: "slice", elems: [1,2,3], mutable: false } as any)] : [];
  const r = runFn(p, f.id, args as never, {});
  console.log(name, S(r.value), r.diagnostics.map((d) => `${d.code} ${d.message}`));
}
