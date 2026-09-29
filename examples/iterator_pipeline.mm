// map / filter / take over a slice, fused into single passes: the shape every
// string-pipeline benchmark in the report ends up with. Each stage writes into
// a caller-owned buffer, so a pipeline allocates exactly as much as the widest
// stage needs and no more.

fn double(x: u32) -> u32 {
    x * 2
}

fn is_even(x: u32) -> bool {
    x % 2 == 0
}

// map: one element in, one element out.
fn map_with(xs: view [u32], f: fn(u32) -> u32, out: view mut [u32]) -> usize {
    let mut n = 0;
    while n < xs.len() && n < out.len() {
        out[n] = f(xs[n]);
        n += 1;
    };
    n
}

// filter: keeps the elements the predicate accepts.
fn filter(xs: view [u32], pred: fn(u32) -> bool, out: view mut [u32]) -> usize {
    let mut n = 0; let mut i = 0;
    while i < xs.len() && n < out.len() {
        if pred(xs[i]) {
            out[n] = xs[i];
            n += 1;
        };
        i += 1;
    };
    n
}

// take: the first n elements, or all of them.
fn take(xs: view [u32], limit: usize) -> usize {
    let mut n = 0;
    while n < xs.len() && n < limit {
        n += 1;
    };
    n
}

fn sum_of(xs: view [u32], n: usize) -> u32 {
    let mut total: u32 = 0; let mut i = 0;
    while i < n {
        total = total + xs[i];
        i += 1;
    };
    total
}

fn range(limit: usize, out: view mut [u32]) -> usize {
    let mut n = 0;
    while n < out.len() && n < limit {
        out[n] = n as u32;
        n += 1;
    };
    n
}

// range -> map double -> filter divisible by three, in one pass.
fn pipeline(out: view mut [u32], limit: u32) -> usize {
    let mut n = 0; let mut i = 0;
    while i < limit {
        let doubled = i * 2;
        if doubled % 3 == 0 {
            out[n] = doubled;
            n += 1;
        };
        i += 1;
    };
    n
}

test "map and filter as separate passes" {
    let xs: [u32] = [1, 2, 3, 4, 5, 6]; let mut doubled: [u32] = [0, 0, 0, 0, 0, 0];
    assert_eq(map_with(xs, double, doubled), 6); assert_eq(doubled[3], 8);
    let mut evens: [u32] = [0, 0, 0, 0, 0, 0]; assert_eq(filter(xs, is_even, evens), 3);
    assert_eq(evens[2], 6); assert_eq(sum_of(evens, 3), 12)
}

test "take bounds the pipeline" {
    let xs: [u32] = [10, 20, 30, 40]; assert_eq(take(xs, 2), 2); assert_eq(take(xs, 9), 4);
    assert_eq(sum_of(xs, take(xs, 2)), 30);
    let mut buf: [u32] = [0, 0, 0, 0, 0, 0]; assert_eq(range(5, buf), 5);
    assert_eq(sum_of(buf, 5), 10)
}

test "a fused pipeline keeps only what survives" {
    let mut out: [u32] = [0, 0, 0, 0, 0, 0, 0, 0]; let n = pipeline(out, 10); assert_eq(n, 4);
    assert_eq(sum_of(out, n), 36)
}
