// safe: a `shared` handle used in two mutually exclusive branches.
//
// R-Own-6 makes `shared` cloning a reference-count operation, not a move, so the handle
// stays live across the branch. MM has no implicit `.clone()` — cloning is explicit, and
// spelled `shared_clone`, because a silent clone is exactly the kind of cost an agent
// should have to name.
type Blob = { payload: Bytes }

fn pick(flag: bool, b: shared Blob) -> usize {
    if flag {
        let a = shared_clone(b)
        a.payload.len()
    } else {
        let c = shared_clone(b)
        c.payload.len()
    }
}

fn run(flag: bool) -> usize {
    let blob = Blob { payload: b"mm" }
    pick(flag, shared_new(blob))
}
