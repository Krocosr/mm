// safe: a read-only view is used, then a `for` loop writes through the same
// slice, then a read-only view is taken again. Each borrow's region ends
// before the next one is created.
type Row = { a: u32, b: u32 }

fn total(rows: view [Row]) -> u32 {
    let mut t = 0;
    for r in rows {
        t = t + r.a + r.b
    };
    t
}

fn rewrite(rows: view mut [Row]) -> u32 {
    for r in rows {
        r.a = 0
    };
    total(rows)
}
