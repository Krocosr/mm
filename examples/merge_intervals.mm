// Interval merging: an insertion sort on the start key, then a single linear
// sweep. A tuple type carries the merged bounds back to the caller.

type Interval = { lo: u32, hi: u32 }

// The bounds of an interval, as a plain pair of numbers.
type Span = (u32, u32)

fn as_span(iv: Interval) -> Span {
    (iv.lo, iv.hi)
}

// Tuple equality is a structural comparison, so spans compare directly.
fn same_span(a: Span, b: Span) -> bool {
    a == b
}

// A zeroed interval, used to claim storage before the caller fills it in.
fn blank() -> Interval {
    Interval { lo: 0, hi: 0 }
}

// Insertion sort by start key; returns the number of shifts performed.
fn sort_intervals(xs: view mut [Interval]) -> usize {
    let mut shifts = 0; let mut i = 1;
    while i < xs.len() {
        let cur = xs[i]; let mut j = i;
        while j > 0 && xs[j - 1].lo > cur.lo {
            xs[j] = xs[j - 1];
            j -= 1;
        };
        xs[j] = cur;
        shifts += i - j;
        i += 1;
    };
    shifts
}

// Merges touching and overlapping intervals into `out`, returning the count.
fn merge_intervals(xs: view [Interval], out: view mut [Interval]) -> usize {
    let mut count = 0; let mut i = 0;
    while i < xs.len() {
        let mut cur = xs[i]; let mut j = i + 1;
        while j < xs.len() && xs[j].lo <= cur.hi {
            if xs[j].hi > cur.hi { cur.hi = xs[j].hi };
            j += 1;
        };
        out[count] = cur;
        count += 1;
        i = j;
    };
    count
}

test "merges overlapping and touching intervals" {
    let mut xs: [Interval] = [blank(), blank(), blank(), blank()];
    xs[0] = Interval { lo: 1, hi: 3 };
    xs[1] = Interval { lo: 2, hi: 6 };
    xs[2] = Interval { lo: 8, hi: 10 };
    xs[3] = Interval { lo: 15, hi: 18 }; let mut out: [Interval] = [blank(), blank(), blank(), blank()];
    let count = merge_intervals(xs, out); assert_eq(count, 3); assert_eq(out[0].hi, 6);
    assert_eq(out[1].lo, 8); assert_eq(out[2].lo, 15); assert(same_span(as_span(out[0]), (1, 6)))
}

test "sorting first makes the sweep correct" {
    let mut xs: [Interval] = [blank(), blank(), blank()];
    xs[0] = Interval { lo: 15, hi: 18 };
    xs[1] = Interval { lo: 1, hi: 3 };
    xs[2] = Interval { lo: 8, hi: 10 }; let shifts = sort_intervals(xs); assert_eq(shifts, 2);
    assert_eq(xs[0].lo, 1); assert_eq(xs[2].lo, 15)
}
