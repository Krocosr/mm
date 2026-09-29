// case: cross-thread mutable alias - expect E0420 (static)
//
// kernel.md §9 case 7: an exclusive borrow may not cross a task boundary while
// the parent still holds it. `m` is a live `view mut` of `g` when `spawn`
// takes it, and the parent keeps reading `g` afterwards — two tasks, one place.
type Grid = { rows: u32, cols: u32 }

fn fan_out(g: view mut Grid) -> u32 {
    let m = g
    let s = view g
    spawn move {
        m.rows = 0
    }
    s.rows
}
