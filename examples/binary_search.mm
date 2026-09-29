// Binary search over a sorted slice: the branch-prediction row of the matrix.
// A miss returns `xs.len()`, so a caller tests the result against the length
// rather than against a sentinel value the slice might legitimately contain.

fn bsearch(xs: view [u32], needle: u32) -> usize {
    let mut lo = 0; let mut hi = xs.len();
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if xs[mid] == needle { return mid };
        if xs[mid] < needle { lo = mid + 1 } else { hi = mid };
    };
    xs.len()
}

// The recursive form: same probes, but the bounds live on the stack.
fn bsearch_rec(xs: view [u32], needle: u32, lo: usize, hi: usize) -> usize {
    if lo >= hi { return xs.len() }; let mid = lo + (hi - lo) / 2;
    if xs[mid] == needle { return mid };
    if xs[mid] < needle { return bsearch_rec(xs, needle, mid + 1, hi) };
    bsearch_rec(xs, needle, lo, mid)
}

// First index whose element is at least `needle`: the insertion point.
fn lower_bound(xs: view [u32], needle: u32) -> usize {
    let mut lo = 0; let mut hi = xs.len();
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if xs[mid] < needle { lo = mid + 1 } else { hi = mid };
    };
    lo
}

fn contains(xs: view [u32], needle: u32) -> bool {
    bsearch(xs, needle) < xs.len()
}

// How many comparisons a lookup costs, for the benchmark harness.
fn probes(xs: view [u32], needle: u32) -> usize {
    let mut lo = 0; let mut hi = xs.len(); let mut steps = 0;
    while lo < hi {
        steps += 1; let mid = lo + (hi - lo) / 2;
        if xs[mid] == needle { return steps };
        if xs[mid] < needle { lo = mid + 1 } else { hi = mid };
    };
    steps
}

test "finds every element" {
    let xs: [u32] = [1, 3, 5, 7, 9, 11]; assert_eq(bsearch(xs, 1), 0); assert_eq(bsearch(xs, 7), 3);
    assert_eq(bsearch(xs, 11), 5); assert_eq(bsearch(xs, 4), 6)
}

test "recursive form agrees" {
    let xs: [u32] = [2, 4, 6, 8]; assert_eq(bsearch_rec(xs, 6, 0, xs.len()), 2);
    assert_eq(bsearch_rec(xs, 5, 0, xs.len()), 4); assert(contains(xs, 8)); assert(!contains(xs, 9))
}

test "lower bound and probe count" {
    let xs: [u32] = [1, 3, 5, 7, 9]; assert_eq(lower_bound(xs, 6), 3); assert_eq(lower_bound(xs, 0), 0);
    assert_eq(lower_bound(xs, 9), 4); assert_eq(probes(xs, 9), 2)
}
