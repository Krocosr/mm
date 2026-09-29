// A Caesar shift over ASCII text: the strings row with arithmetic in it.
// Letters wrap inside their own case block; every other byte passes through,
// so punctuation and digits survive the round trip.

const LOWER_LO: u8 = 97
const LOWER_HI: u8 = 122
const UPPER_LO: u8 = 65
const UPPER_HI: u8 = 90
const ALPHABET: u8 = 26

fn is_lower(c: u8) -> bool {
    c >= LOWER_LO && c <= LOWER_HI
}

fn is_upper(c: u8) -> bool {
    c >= UPPER_LO && c <= UPPER_HI
}

fn is_letter(c: u8) -> bool {
    is_lower(c) || is_upper(c)
}

// Shifts one byte by `k`, wrapping at the ends of the case block.
fn shift(c: u8, k: u8) -> u8 {
    if is_lower(c) { return LOWER_LO + (c - LOWER_LO + k) % ALPHABET };
    if is_upper(c) { return UPPER_LO + (c - UPPER_LO + k) % ALPHABET };
    c
}

fn encrypt(s: Text, k: u8, out: view mut [u8]) -> usize {
    let bytes = s.as_bytes(); let mut n = 0;
    while n < bytes.len() && n < out.len() {
        out[n] = shift(bytes[n], k);
        n += 1;
    };
    n
}

fn decrypt(s: Text, k: u8, out: view mut [u8]) -> usize {
    encrypt(s, ALPHABET - k, out)
}

fn to_text(bytes: view [u8], n: usize) -> Text {
    let mut s = ""; let mut i = 0;
    while i < n {
        s = s + (bytes[i] as char);
        i += 1;
    };
    s
}

fn letter_count(s: Text) -> usize {
    let bytes = s.as_bytes(); let mut n = 0; let mut i = 0;
    while i < bytes.len() {
        if is_letter(bytes[i]) { n += 1 };
        i += 1;
    };
    n
}

test "shifts letters and wraps the alphabet" {
    let mut buf: [u8] = [0, 0, 0, 0, 0]; assert_eq(encrypt("AbZ-1", 1, buf), 5);
    assert_eq(to_text(buf, 5), "BcA-1"); assert_eq(letter_count("AbZ-1"), 3)
}

test "decrypting is the inverse shift" {
    let mut buf: [u8] = [0, 0, 0, 0, 0]; let n = encrypt("BcA-1", 1, buf);
    assert_eq(to_text(buf, n), "CdB-0"); let mut back: [u8] = [0, 0, 0, 0, 0];
    let m = decrypt("CdB-0", 1, back); assert_eq(to_text(back, m), "BcA-1")
}
