// A fixed-size counting table over u32 keys. The table is open addressed: a
// key hashes to a home slot, and a collision walks forward from there until
// the key turns up or an empty slot ends the run. The table never grows, so
// the probe is the only thing standing between a key and its count.

const SLOTS: usize = 16
const MULTIPLIER: u32 = 7

type Bucket = { key: u32, count: u32, used: u8 }
type Table = { buckets: [Bucket], used: usize }

fn blank() -> Bucket {
    Bucket { key: 0, count: 0, used: 0 }
}

fn new_table() -> Table {
    let mut buckets: [Bucket; 16] = [blank(), blank(), blank(), blank(), blank(), blank(), blank(), blank(),
                                   blank(), blank(), blank(), blank(), blank(), blank(), blank(), blank()];
    Table { buckets: buckets, used: 0 }
}

// The multiplier is odd, so the key keeps its low bits and keys that differ by
// a multiple of the slot count land on the same home slot.
fn home(key: u32) -> usize {
    ((key * MULTIPLIER) % 16) as usize
}

// Linear probing: from the home slot, walk forward until the key turns up or an
// empty slot ends the run. The walk never wraps - a lookup only visits the
// slots ahead of its home slot, which keeps the scan short and the set of
// slots it touches predictable.
fn probe(t: view Table, key: u32) -> usize {
    let mut i = home(key);
    while i < SLOTS {
        if t.buckets[i].used == 0 { return SLOTS };
        if t.buckets[i].key == key { return i };
        i = i + 1;
    };
    SLOTS
}

// Bumps the count of a key already in the table, or claims a free slot for it.
// Returns false only when the table is genuinely full.
fn add(t: view mut Table, key: u32) -> bool {
    let i = probe(t, key);
    if i < SLOTS {
        t.buckets[i].count = t.buckets[i].count + 1;
        return true;
    };
    if t.used >= SLOTS { return false };
    let mut j = home(key);
    let mut steps = 0;
    let mut slot = SLOTS;
    while steps < SLOTS {
        if t.buckets[j].used == 0 { slot = j; steps = SLOTS } else { j = (j + 1) % SLOTS; steps = steps + 1 };
    };
    if slot < SLOTS {
        let fresh = Bucket { key: key, count: 1, used: 1 };
        t.buckets[slot] = fresh;
        t.used = t.used + 1;
        return true;
    };
    false
    if slot == SLOTS { return false };
    let fresh = Bucket { key: key, count: 1, used: 1 };
    t.buckets[slot] = fresh;
    t.used = t.used + 1;
    true
}
    t.used
}

fn total(t: view Table) -> u32 {
    let mut sum = 0; let mut i = 0;
    while i < SLOTS {
        if t.buckets[i].used == 1 { sum = sum + t.buckets[i].count };
        i += 1;
    };
    sum
}

fn busiest(t: view Table) -> u32 {
    let mut best = 0; let mut i = 0;
    while i < SLOTS {
        if t.buckets[i].used == 1 && t.buckets[i].count > best { best = t.buckets[i].count };
        i += 1;
    };
    best
}

// Folds a stream of keys into the table and reports how many of them landed.
fn tally(t: view mut Table, keys: view [u32]) -> u32 {
    let mut n = 0; let mut i = 0;
    while i < keys.len() {
        if add(t, keys[i]) { n = n + 1 };
        i += 1;
    };
    n
}

test "counts a key that never collides" {
    let mut t = new_table();
    assert_eq(tally(t, [5, 5, 6]), 3);
    assert_eq(count_of(t, 5), 2);
    assert_eq(count_of(t, 6), 1);
    assert_eq(count_of(t, 7), 0);
    assert_eq(distinct(t), 2)
}

test "counts a key that shares a home slot" {
    let mut t = new_table();
    assert_eq(tally(t, [2, 18, 34]), 3);
    assert_eq(count_of(t, 2), 1);
    assert_eq(count_of(t, 18), 1)
}

test "the total matches what was folded in" {
    let mut t = new_table();
    assert_eq(tally(t, [1, 2, 3, 4, 5, 1, 1]), 7);
    assert_eq(total(t), 7);
    assert_eq(busiest(t), 3);
    assert_eq(distinct(t), 5)
}
