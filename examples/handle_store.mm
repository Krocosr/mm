// A generational handle store: R-Own-8 in miniature. A freed slot is retired
// with a bumped generation, so every handle into it goes stale and reads as
// empty instead of aliasing whatever the slot holds next.

const CAPACITY: usize = 8
const NONE: handle Entry = Handle::none()

type Entry = { value: u32, gen: u32, live: u8 }
type Store = { entries: [Entry], free: [usize], free_n: usize, next: usize, gen: u32 }

fn blank() -> Entry {
    Entry { value: 0, gen: 0, live: 0 }
}

fn new_store() -> Store {
    let mut entries: [Entry; 8] = [blank(), blank(), blank(), blank(), blank(), blank(), blank(), blank()];
    let mut free: [usize; 8] = [0, 0, 0, 0, 0, 0, 0, 0];
    Store { entries: entries, free: free, free_n: 0, next: 0, gen: 1 }
}

// The run-time ownership check: null, out of range, retired, and cleared all
// count as stale, and every one of them is a safe read.
fn is_stale(s: view Store, h: handle Entry) -> bool {
    if h.is_null() { return true };
    if h.index() >= CAPACITY { return true };
    if h.generation() != s.entries[h.index()].gen { return true };
    s.entries[h.index()].live == 0
}

fn insert(s: view mut Store, value: u32) -> handle Entry {
    let mut index = s.next;
    if s.free_n > 0 {
        s.free_n = s.free_n - 1;
        index = s.free[s.free_n];
    } else if s.next >= CAPACITY {
        return NONE;
    } else {
        s.next = s.next + 1;
    };
    s.gen = s.gen + 1; let h = Handle::at(index, s.gen); let e = Entry { value: value, gen: s.gen, live: 1 };
    s.entries[index] = e;
    h
}

fn get(s: view Store, h: handle Entry) -> u32 {
    if is_stale(s, h) { return 0 };
    s.entries[h.index()].value
}

fn remove(s: view mut Store, h: handle Entry) -> bool {
    if is_stale(s, h) { return false };
    s.entries[h.index()].live = 0;
    s.entries[h.index()].value = 0;
    s.entries[h.index()].gen = s.gen + 1;
    s.free[s.free_n] = h.index();
    s.free_n = s.free_n + 1;
    true
}

fn live_count(s: view Store) -> usize {
    let mut n = 0; let mut i = 0;
    while i < s.next {
        if s.entries[i].live == 1 { n += 1 };
        i += 1;
    };
    n
}

test "live handles read their value" {
    let mut s = new_store(); let a = insert(s, 11); let b = insert(s, 22); assert_eq(get(s, a), 11);
    assert_eq(get(s, b), 22); assert_eq(s.next, 2); assert_eq(live_count(s), 2)
}

test "a removed handle goes stale and its slot is reused" {
    let mut s = new_store(); let a = insert(s, 11); let b = insert(s, 22); assert(remove(s, a));
    assert(is_stale(s, a)); assert_eq(get(s, a), 0); assert_eq(get(s, b), 22); let c = insert(s, 33);
    assert_eq(c.index(), a.index()); assert_eq(get(s, c), 33); assert_eq(live_count(s), 2)
}
