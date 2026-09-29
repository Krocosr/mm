// Base64 in both directions: the serialization row of the benchmark matrix.
// Bytes in, bytes out, through caller-owned buffers - no hidden allocation.

const ALPHABET: Text = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const PAD: u8 = 61

fn sextet_char(i: u32) -> u8 {
    ALPHABET.as_bytes()[i as usize]
}

// The inverse alphabet: a character to its 6-bit value, or 255 when invalid.
fn sextet_value(c: u8) -> u32 {
    if c >= 65 && c <= 90 { (c - 65) as u32 }
    else if c >= 97 && c <= 122 { (c - 97 + 26) as u32 }
    else if c >= 48 && c <= 57 { (c - 48 + 52) as u32 }
    else if c == 43 { 62 }
    else if c == 47 { 63 }
    else { 255 }
}

// Encodes `data` into `out` and returns the number of bytes written.
fn encode(data: view Bytes, out: view mut [u8]) -> usize {
    let mut n = 0; let mut i = 0;
    while i + 2 < data.len() {
        let t = (data[i] as u32) * 65536 + (data[i + 1] as u32) * 256 + data[i + 2] as u32;
        out[n] = sextet_char((t / 262144) % 64);
        out[n + 1] = sextet_char((t / 4096) % 64);
        out[n + 2] = sextet_char((t / 64) % 64);
        out[n + 3] = sextet_char(t % 64);
        n += 4;
        i += 3;
    }; let rest = data.len() - i;
    if rest == 1 {
        let t = (data[i] as u32) * 65536;
        out[n] = sextet_char((t / 262144) % 64);
        out[n + 1] = sextet_char((t / 4096) % 64);
        out[n + 2] = PAD;
        out[n + 3] = PAD;
        n += 4;
    } else if rest == 2 {
        let t = (data[i] as u32) * 65536 + (data[i + 1] as u32) * 256;
        out[n] = sextet_char((t / 262144) % 64);
        out[n + 1] = sextet_char((t / 4096) % 64);
        out[n + 2] = sextet_char((t / 64) % 64);
        out[n + 3] = PAD;
        n += 4;
    };
    n
}

// Decodes `text` into `out` and returns the number of bytes written. Stops at
// the first padding or invalid character, so a truncated stream never overruns.
fn decode(text: view Bytes, out: view mut [u8]) -> usize {
    let mut n = 0; let mut acc: u32 = 0; let mut group = 0;
    for c in text {
        if c == PAD { break }; let v = sextet_value(c);
        if v == 255 { break };
        acc = acc * 64 + v;
        group += 1;
        if group == 4 {
            out[n] = (acc / 65536) % 256;
            out[n + 1] = (acc / 256) % 256;
            out[n + 2] = acc % 256;
            n += 3;
            acc = 0;
            group = 0;
        }
    };
    if group == 2 {
        out[n] = (acc / 16) % 256;
        n += 1;
    } else if group == 3 {
        out[n] = (acc / 1024) % 256;
        out[n + 1] = (acc / 4) % 256;
        n += 2;
    };
    n
}

test "encodes a two byte tail" {
    let mut out: [u8] = [0, 0, 0, 0, 0, 0, 0, 0]; let n = encode(b"MM", out); assert_eq(n, 4);
    assert_eq(out[0], 84); assert_eq(out[1], 85); assert_eq(out[2], 48); assert_eq(out[3], 61)
}

test "encodes a one byte tail" {
    let mut out: [u8] = [0, 0, 0, 0, 0, 0, 0, 0]; let n = encode(b"M", out); assert_eq(n, 4);
    assert_eq(out[0], 84); assert_eq(out[1], 81); assert_eq(out[2], 61); assert_eq(out[3], 61)
}

test "encodes a whole triple" {
    let mut out: [u8] = [0, 0, 0, 0, 0, 0, 0, 0]; let n = encode(b"abc", out); assert_eq(n, 4);
    assert_eq(out[0], 89); assert_eq(out[1], 87); assert_eq(out[2], 74); assert_eq(out[3], 106)
}

test "decode is the inverse of encode" {
    let mut buf: [u8] = [0, 0, 0, 0, 0, 0, 0, 0]; let n = decode(b"TU0=", buf); assert_eq(n, 2);
    assert_eq(buf[0], 77); assert_eq(buf[1], 77)
}
