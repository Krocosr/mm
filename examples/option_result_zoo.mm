// Every Option and Result combinator in one module, so an agent can read the
// whole error surface without grepping: `?`, `Some`/`None`, `Ok`/`Err`, and the
// match-based combinators that stand in for map/and_then/unwrap_or.

fn parse_port(s: Text) -> Result<u16, IoErr> {
    let digits = s.as_bytes();
    if digits.len() == 0 { return Err(IoErr.NotFound) }; let mut value: u32 = 0; let mut i = 0;
    while i < digits.len() {
        let c = digits[i];
        if c < 48 || c > 57 { return Err(IoErr.Other) };
        value = value * 10 + (c - 48) as u32;
        i += 1;
    };
    if value > 65535 { return Err(IoErr.Other) };
    Ok(value as u16)
}

fn head(xs: view [u32]) -> u32? {
    if xs.len() == 0 { return None };
    Some(xs[0])
}

fn first_even(xs: view [u32]) -> u32? {
    let mut i = 0;
    while i < xs.len() {
        if xs[i] % 2 == 0 { return Some(xs[i]) };
        i += 1;
    };
    None
}

fn unwrap_or(x: u32?, fallback: u32) -> u32 {
    match x { Some(v) => v, None => fallback }
}

fn map(x: u32?, k: u32) -> u32? {
    match x { Some(v) => Some(v * k), None => None }
}

fn and_then(x: u32?, xs: view [u32]) -> u32? {
    match x { Some(v) => first_even_after(xs, v), None => None }
}

fn first_even_after(xs: view [u32], from: u32) -> u32? {
    let mut i = 0;
    while i < xs.len() {
        if xs[i] > from && xs[i] % 2 == 0 { return Some(xs[i]) };
        i += 1;
    };
    None
}

fn is_some(x: u32?) -> bool {
    match x { Some(v) => true, None => false }
}

fn or_zero(r: Result<u16, IoErr>) -> u16 {
    match r { Ok(v) => v, Err(e) => 0 }
}

// `?` in the middle of a pipeline: the error leaves without unwrapping.
fn port_or(xs: view [u32], s: Text) -> u32 {
    let p = parse_port(s)?;
    unwrap_or(first_even(xs), p as u32)
}

test "option combinators" {
    let xs: [u32] = [3, 4, 5]; assert_eq(unwrap_or(head(xs), 99), 3); assert_eq(unwrap_or(head([]), 99), 99);
    assert_eq(unwrap_or(map(head(xs), 10), 0), 30); assert_eq(unwrap_or(first_even(xs), 0), 4);
    assert_eq(unwrap_or(and_then(head(xs), xs), 0), 4); assert(is_some(head(xs)));
    assert(!is_some(first_even([1, 3])))
}

test "result propagation" {
    assert_eq(or_zero(parse_port("8080")), 8080); assert_eq(or_zero(parse_port("99999")), 0);
    assert_eq(or_zero(parse_port("80a")), 0); assert_eq(port_or([2, 4], "80"), 2)
}
