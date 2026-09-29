// safe: a view is live at the end of one loop iteration but is not carried
// into the next. Each iteration re-creates the borrow, so the per-iteration
// regions are disjoint.
type Item = { weight: u32 }

fn total(items: view mut [Item]) -> u32 {
    let mut acc = 0;
    for it in items {
        acc = acc + it.weight
    };
    acc
}
