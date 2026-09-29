// CSV reading: the strings row of the benchmark matrix. Fields are slices into
// the original document, so splitting a megabyte of CSV allocates nothing.

const COMMA: u8 = 44
const SEMI: u8 = 59
const NEWLINE: u8 = 10
const RETURN: u8 = 13
const ZERO: u8 = 48
const NINE: u8 = 57

fn is_separator(c: u8) -> bool {
    c == COMMA || c == SEMI
}

fn is_line_end(c: u8) -> bool {
    c == NEWLINE || c == RETURN
}

// Splits one line into `out` and returns the field count.
fn split_line(line: Text, out: view mut [Text]) -> usize {
    let bytes = line.as_bytes(); let mut n = 0; let mut start = 0; let mut i = 0;
    while i < bytes.len() {
        if is_separator(bytes[i]) {
            out[n] = line.slice(start, i);
            n += 1;
            start = i + 1;
        };
        i += 1;
    };
    out[n] = line.slice(start, bytes.len());
    n + 1
}

// Splits a whole document into non-empty lines.
fn split_lines(doc: Text, out: view mut [Text]) -> usize {
    let bytes = doc.as_bytes(); let mut n = 0; let mut start = 0; let mut i = 0;
    while i < bytes.len() {
        if is_line_end(bytes[i]) {
            if i > start {
                out[n] = doc.slice(start, i);
                n += 1;
            };
            start = i + 1;
        };
        i += 1;
    };
    if start < bytes.len() {
        out[n] = doc.slice(start, bytes.len());
        n += 1;
    };
    n
}

fn parse_u32(s: Text) -> Result<u32, IoErr> {
    if s.len() == 0 { return Err(IoErr.Other) }; let bytes = s.as_bytes(); let mut value: u32 = 0;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c < ZERO || c > NINE { return Err(IoErr.Other) };
        value = value * 10 + (c - ZERO) as u32;
        i += 1;
    };
    Ok(value)
}

fn or_zero(r: Result<u32, IoErr>) -> u32 {
    match r { Ok(v) => v, Err(e) => 0 }
}

test "splits a document into lines and fields" {
    let mut lines: [Text] = ["", "", "", ""]; assert_eq(split_lines("ab,cd\nef,gh\n", lines), 2);
    assert_eq(lines[0], "ab,cd"); let mut fields: [Text] = ["", "", ""];
    assert_eq(split_line(lines[0], fields), 2); assert_eq(fields[0], "ab"); assert_eq(fields[1], "cd")
}

test "semicolons separate too" {
    let mut fields: [Text] = ["", "", ""]; assert_eq(split_line("a;b;c", fields), 3);
    assert_eq(fields[2], "c")
}

test "numeric fields" {
    assert_eq(or_zero(parse_u32("1234")), 1234); assert_eq(or_zero(parse_u32("12x")), 0);
    assert_eq(or_zero(parse_u32("")), 0)
}
