// case: bad FFI ownership contract - expect E0703 (static)
//
// A-4: `@resource(close = f)` requires `f` to accept the resource it closes.
// `close_path` takes a `Text` while `File` is a `Handle<Fd>`, so the generated
// drop path would hand foreign code a path where it expects a handle — a
// contract the compiler must refuse to synthesize.
fn close_path(p: Text) -> bool !{fs.close} {
    fs.close(p);
    true
}

@resource(close = close_path)
type File = Handle<Fd>
