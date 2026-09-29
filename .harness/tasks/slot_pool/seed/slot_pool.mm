// A fixed-capacity pool of records addressed by generational handles. A handle
// is a value, not a reference: it names a slot plus the generation that slot
// was in when the handle was made. Freeing a record retires the handle, and
// the slot goes onto the free list for the next allocation to reuse.

const CAPACITY: usize = 8
const NONE: handle Cell = Handle::none()

type Cell = { value: u32, gen: u32, live: u8 }
type Pool = { cells: [Cell], free: [usize], free_n: usize, next: usize, gen: u32 }

fn blank() -> Cell {
    Cell { value: 0, gen: 0, live: 0 }
}

fn new_pool() -> Pool {
    let mut cells: [Cell; 8] = [blank(), blank(), blank(), blank(), blank(), blank(), blank(), blank()];
    let mut free: [usize; 8] = [0, 0, 0, 0, 0, 0, 0, 0];
    Pool { cells: cells, free: free, free_n: 0, next: 0, gen: 1 }
}

// A handle is stale when it names nothing, when it names a slot that was never
// handed out, or when the slot has been retired since the handle was made.
fn is_stale(p: view Pool, h: handle Cell) -> bool {
    if h.is_null() { return true };
    if h.index() >= CAPACITY { return true };
    if h.generation() != p.cells[h.index()].gen { return true };
    p.cells[h.index()].live == 0
}

// Hands back a slot, preferring one that was freed over a fresh one. The
// handle it returns is stamped with the pool's current generation, and the
// slot is stamped with the same one so a later comparison can tell whether
// the slot was reused underneath the handle.
fn alloc(p: view mut Pool, value: u32) -> handle Cell {
    let mut index = p.next;
    if p.free_n > 0 {
        p.free_n = p.free_n - 1;
        index = p.free[p.free_n];
    } else if p.next >= CAPACITY {
        return NONE;
    } else {
        p.next = p.next + 1;
    };
    let h = Handle::at(index, p.gen);
    p.cells[index] = Cell { value: value, gen: p.gen, live: 1 };
    h
}

fn get(p: view Pool, h: handle Cell) -> u32 {
    if is_stale(p, h) { return 0 };
    p.cells[h.index()].value
}

// Retires the handle and returns the slot to the free list.
fn release(p: view mut Pool, h: handle Cell) -> bool {
    if is_stale(p, h) { return false };
    p.cells[h.index()].live = 0;
    p.cells[h.index()].value = 0;
    p.cells[h.index()].gen = p.gen + 1;
    p.free[p.free_n] = h.index();
    p.free_n = p.free_n + 1;
    true
}

fn live_count(p: view Pool) -> usize {
    let mut n = 0; let mut i = 0;
    while i < p.next {
        if p.cells[i].live == 1 { n += 1 };
        i += 1;
    };
    n
}

test "live handles read their value" {
    let mut p = new_pool(); let a = alloc(p, 11); let b = alloc(p, 22);
    assert_eq(get(p, a), 11); assert_eq(get(p, b), 22);
    assert_eq(p.next, 2); assert_eq(live_count(p), 2)
}

test "a released slot is handed out again" {
    let mut p = new_pool(); let a = alloc(p, 11); let b = alloc(p, 22);
    assert(release(p, a));
    let c = alloc(p, 33);
    assert_eq(c.index(), a.index());
    assert_eq(get(p, c), 33);
    assert_eq(get(p, b), 22);
    assert_eq(live_count(p), 2)
}

test "releasing a retired handle is a no-op" {
    let mut p = new_pool(); let a = alloc(p, 11);
    assert(release(p, a));
    assert_eq(release(p, a), false);
    assert_eq(p.free_n, 1)
}
