// case: mutable_read_alias (a `view` overlapping a live `view mut`) - expect E0414 (static)
//
// R-Own-4: while `g` is exclusively borrowed through its `view mut` parameter, no
// other view of the same place may be live. `r` is read after the exclusive borrow
// is still in scope, so the two regions overlap.
type Grid = { rows: u32, cols: u32 }

fn fill(g: view mut Grid, v: u32) {
    g.rows = v;
}

fn mix(g: view mut Grid) -> u32 {
    let r = view g;
    fill(g, 0);
    r.rows
}
