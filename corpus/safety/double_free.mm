// case: double_free (drop of a moved resource) - expect E0417 (static)
//
// R-Own-9: a `@resource` has a drop path that runs exactly once. `a` is moved into
// `b` — a legal transfer — and then `a` is touched again. Its binding would still
// close the same handle at end of scope, so the resource is closed twice.
@resource(close = fs.close)
type Conn = Handle<Fd>

fn hand_off(c: Conn) -> usize {
    let a = c
    let b = a
    let again = a
    1
}
