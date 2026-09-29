// safe: an early `return` out of a scope holding a `@resource`.
//
// R-Own-9: drop runs exactly once on the early-return path, and running it is what
// makes the early return *safe* — a resource that leaked on the way out would be a
// defect, not a surprise. The `Handle` is a checked generational indirection, so a
// resource is referred to rather than constructed inline.
@resource(close = fs.close)
type File = Handle<Fd>

fn read_or_abort(f: view File, want: usize) -> usize {
    if want == 0 {
        return 0
    }
    want
}

fn take(f: File) -> File {
    f
}

fn run() -> usize {
    let f = take(handle_of(3));
    read_or_abort(f, 5)
}
