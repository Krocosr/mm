// Bump-pointer arena over caller-owned memory: the allocation-churn row of the
// benchmark matrix. Blocks live in the arena, so a reference into it is only
// valid while the arena is; escaping one needs a `handle` instead.

const CAPACITY: usize = 64

type Block = { offset: usize, size: usize }
type Arena = { blocks: [Block], cursor: usize, live: usize, total: usize }

fn blank_block() -> Block {
    Block { offset: 0, size: 0 }
}

fn new_arena() -> Arena {
    let mut blocks: [Block; 8] = [blank_block(), blank_block(), blank_block(), blank_block(),
                                 blank_block(), blank_block(), blank_block(), blank_block()];
    Arena { blocks: blocks, cursor: 0, live: 0, total: 0 }
}

fn has_room(a: view Arena, size: usize) -> bool {
    a.live < a.blocks.len() && a.cursor + size <= CAPACITY
}

// Returns the offset of a fresh block; a full arena allocates nothing.
fn alloc(a: view mut Arena, size: usize) -> usize {
    if has_room(a, size) == false { return 0 }; let offset = a.cursor;
    a.blocks[a.live] = Block { offset: offset, size: size };
    a.cursor = offset + size;
    a.live += 1;
    a.total += size;
    offset
}

// Swap-remove: the freed offset may be handed out again by a later bump.
fn dealloc(a: view mut Arena, offset: usize) -> bool {
    let mut i = 0;
    while i < a.live {
        if a.blocks[i].offset == offset {
            let last = a.live - 1;
            a.blocks[i] = a.blocks[last];
            a.total = a.total - a.blocks[i].size;
            a.blocks[last] = blank_block();
            a.live = last;
            return true;
        };
        i += 1;
    };
    false
}

// The `arena` parameter borrows the whole arena: the result may not outlive it.
fn block_at(a: arena Arena, index: usize) -> Block {
    a.blocks[index]
}

fn live_bytes(a: view Arena) -> usize {
    a.total
}

test "bump allocation hands out increasing offsets" {
    let mut a = new_arena(); let x = alloc(a, 16); let y = alloc(a, 32); let z = alloc(a, 8); assert_eq(x, 0);
    assert_eq(y, 16); assert_eq(z, 48); assert_eq(a.live, 3); assert_eq(live_bytes(a), 56)
}

test "freeing returns the block to the pool" {
    let mut a = new_arena();
    alloc(a, 16); let y = alloc(a, 32); assert(dealloc(a, y)); assert_eq(a.live, 1);
    assert_eq(live_bytes(a), 16); assert_eq(block_at(a, 0).size, 16)
}

test "a full arena allocates nothing" {
    let mut a = new_arena(); let mut i = 0;
    while i < 8 {
        alloc(a, 8);
        i += 1;
    }; let before = live_bytes(a);
    alloc(a, 8); assert_eq(live_bytes(a), before); assert(!has_room(a, 8))
}
