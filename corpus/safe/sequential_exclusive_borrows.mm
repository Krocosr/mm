// safe: two `view mut` borrows of the same owner that do not overlap. The
// first borrow's region ends at its last use inside `bump`, before the second
// borrow is created.
type Counter = { n: u32 }

fn bump(c: view mut Counter) -> u32 {
    c.n = c.n + 1;
    c.n
}

fn twice(c: view mut Counter) -> u32 {
    let first = bump(c);
    let second = bump(c);
    first + second
}
