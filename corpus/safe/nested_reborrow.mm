// safe: a `view` is reborrowed inside a nested block and the outer view is
// still usable afterwards. The inner region is strictly nested inside the
// outer's, so no widening is needed and the program is legal.
type Pair = { a: u32, b: u32 }

fn inner(p: view Pair) -> u32 {
    p.a + p.b
}

fn outer(p: view Pair) -> u32 {
    let first = inner(p);
    let nested = inner(view p);
    first + nested
}
