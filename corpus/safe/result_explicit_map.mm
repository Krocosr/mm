// safe: bridging a `Result` whose error type differs from the caller's.
//
// `?` propagates the callee's own `Err`; it never invents a conversion. So an explicit
// `match` maps `NetErr` into `IoErr` at the call site, and only the already-converted
// result is propagated. MM has no first-class function values, so a `map_err(combinator)`
// form would not typecheck — writing the bridge out is the point of the example.
fn parse_one(t: Text) -> Result<u32, NetErr> {
    let n = t.len() as u32
    if n > 1000 {
        return Err(NetErr.Timeout)
    }
    Ok(n)
}

fn load(t: Text) -> Result<u32, IoErr> {
    let parsed = parse_one(t)
    match parsed {
        Ok(v) => Ok(v)
        Err(NetErr.Timeout) => Err(IoErr.Denied)
        Err(_) => Err(IoErr.Other)
    }
}
