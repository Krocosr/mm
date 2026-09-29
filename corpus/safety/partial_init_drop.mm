// case: destructor after partial initialization - expect E0419 (static)
//
// kernel.md §6.5: a `@resource` gets a drop path, and that path must not run against
// a field that was never bound. The `?` below bails out partway through building
// `s`, so the drop elaboration would otherwise close an fd it never received.
@resource(close = fs.close)
type Session = { fd: Fd, id: u64 }

fn start_session(p: Path) -> Result<u64, IoErr> !{fs.read} {
    let s = Session { fd: 3, id: fs.read(p)?.len() as u64 };
    Ok(s.id)
}
