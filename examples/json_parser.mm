// A recursive-descent JSON parser over Text: the parsing row of the benchmark
// matrix. The value type is @wire because a parsed document crosses a module
// boundary, and every fallible step propagates with `?`.

use std.fs.{read_to_string}

@wire
type Json =
    Null
  | Bool { value: bool }
  | Num { raw: f64 }
  | Str { value: Text }
  | Arr { items: [Json], count: u32 }
  | Obj { fields: [(Text, Json)], count: u32 }

const QUOTE: u8 = 34
const COMMA: u8 = 44
const COLON: u8 = 58
const DASH: u8 = 45

fn skip_ws(s: Text, i: usize) -> usize {
    let bytes = s.as_bytes(); let mut j = i;
    while j < bytes.len() {
        let c = bytes[j];
        if c != 32 && c != 9 && c != 10 && c != 13 { break };
        j += 1;
    };
    j
}

fn parse_string(s: Text, i: usize) -> Result<Text, IoErr> {
    let bytes = s.as_bytes();
    if i >= bytes.len() || bytes[i] != QUOTE { return Err(IoErr.Other) }; let mut j = i + 1;
    while j < bytes.len() && bytes[j] != QUOTE { j += 1 };
    if j >= bytes.len() { return Err(IoErr.Other) };
    Ok(s.slice(i + 1, j))
}

fn parse_number(s: Text, i: usize) -> Result<Json, IoErr> {
    let bytes = s.as_bytes(); let mut j = i;
    if j < bytes.len() && bytes[j] == DASH { j += 1 }; let start = j;
    while j < bytes.len() {
        let c = bytes[j];
        if c < 48 || c > 57 { break };
        j += 1;
    };
    if j == start { return Err(IoErr.Other) }; let num = Num { raw: s.slice(i, j).as_f64() };
    Ok(num)
}

fn parse_value(s: Text, i: usize) -> Result<Json, IoErr> {
    let j = skip_ws(s, i);
    if j >= s.len() { return Err(IoErr.Other) }; let c = s.as_bytes()[j];
    if c == 123 { return parse_object(s, j) };
    if c == 91 { return parse_array(s, j) };
    if c == DASH || (c >= 48 && c <= 57) { return parse_number(s, j) };
    if c == QUOTE { return Ok(string_value(parse_string(s, j)?)) };
    if s.starts_with("true", j) { return Ok(bool_value(true)) };
    if s.starts_with("false", j) { return Ok(bool_value(false)) };
    if s.starts_with("null", j) { return Ok(Null) };
    Err(IoErr.Other)
}

fn string_value(text: Text) -> Json {
    Str { value: text }
}

fn parse_object(s: Text, i: usize) -> Result<Json, IoErr> {
    let mut fields: [(Text, Json); 8] = [("", Null), ("", Null), ("", Null), ("", Null),
                                       ("", Null), ("", Null), ("", Null), ("", Null)]; let mut n = 0;
    let mut j = skip_ws(s, i + 1);
    while j < s.len() && s.as_bytes()[j] != 125 {
        let key = parse_string(s, j)?;
        j = skip_ws(s, j + 1);
        if j >= s.len() || s.as_bytes()[j] != COLON { return Err(IoErr.Other) };
        fields[n] = (key, parse_value(s, j + 1)?);
        n += 1;
        j = skip_ws(s, j + 1);
        if j < s.len() && s.as_bytes()[j] == COMMA { j = skip_ws(s, j + 1) };
    }; let obj = Obj { fields: fields, count: n as u32 };
    Ok(obj)
}

fn parse_array(s: Text, i: usize) -> Result<Json, IoErr> {
    let mut items: [Json; 8] = [Null, Null, Null, Null, Null, Null, Null, Null]; let mut n = 0;
    let mut j = skip_ws(s, i + 1);
    while j < s.len() && s.as_bytes()[j] != 93 {
        items[n] = parse_value(s, j)?;
        n += 1;
        j = skip_ws(s, j + 1);
        if j < s.len() && s.as_bytes()[j] == COMMA { j = skip_ws(s, j + 1) };
    }; let arr = Arr { items: items, count: n as u32 };
    Ok(arr)
}

fn parse_text(s: Text) -> Result<Json, IoErr> { parse_value(s, 0) }

fn load_json(path: Path) -> Result<Json, IoErr> !{fs.read} {
    let body = read_to_string(path)?;
    parse_text(body)
}

fn field_count(r: Result<Json, IoErr>) -> u32 {
    match r { Ok(j) => match j { Obj { count } => count, _ => 0 }, Err(e) => 0 }
}

fn item_count(r: Result<Json, IoErr>) -> u32 {
    match r { Ok(j) => match j { Arr { count } => count, _ => 0 }, Err(e) => 0 }
}

fn first_number(r: Result<Json, IoErr>) -> f64 {
    match r { Ok(j) => match j { Num { raw } => raw, _ => 0.0 }, Err(e) => 0.0 }
}

fn as_text(r: Result<Json, IoErr>) -> Text {
    match r { Ok(j) => match j { Str { value } => value, _ => "" }, Err(e) => "" }
}

test "parses a nested object" {
    let doc = parse_text("{ \"a\": 1, \"b\": [true, null] }"); assert_eq(field_count(doc), 2);
    assert_eq(item_count(parse_text("[1, 2, 3]")), 3); assert_eq(field_count(parse_text("[]")), 0)
}

test "parses scalars" {
    assert_eq(first_number(parse_text("  -12.5 ")), -12.5); assert_eq(first_number(parse_text("7")), 7.0);
    assert_eq(as_text(parse_text("\"hi\"")), "hi"); assert_eq(as_text(parse_text("nope")), "")
}
