// Reversing bytes in place and reversing word order: the strings row again,
// this time over caller-owned buffers. Word slices borrow the source string, so
// reversing the order copies eight bytes per word and no text.

const SPACE: u8 = 32
const TAB: u8 = 9
const NEWLINE: u8 = 10
const RETURN: u8 = 13

fn is_space(c: u8) -> bool {
    c == SPACE || c == TAB || c == NEWLINE || c == RETURN
}

fn split_words(s: Text, out: view mut [Text]) -> usize {
    let bytes = s.as_bytes(); let mut n = 0; let mut start = 0; let mut i = 0;
    while i < bytes.len() {
        if is_space(bytes[i]) {
            if i > start {
                out[n] = s.slice(start, i);
                n += 1;
            };
            start = i + 1;
        };
        i += 1;
    };
    if start < bytes.len() {
        out[n] = s.slice(start, bytes.len());
        n += 1;
    };
    n
}

// Swaps from both ends; the midpoint needs no special case.
fn reverse_bytes(xs: view mut [u8]) -> usize {
    if xs.len() == 0 { return 0 }; let mut lo = 0; let mut hi = xs.len() - 1;
    while lo < hi {
        let tmp = xs[lo];
        xs[lo] = xs[hi];
        xs[hi] = tmp;
        lo += 1;
        hi -= 1;
    };
    xs.len()
}

// Writes the words back to front and returns how many there were.
fn reverse_words(s: Text, out: view mut [Text]) -> usize {
    let mut words: [Text] = ["", "", "", "", "", ""]; let n = split_words(s, words); let mut i = 0;
    while i < n {
        out[i] = words[n - 1 - i];
        i += 1;
    };
    n
}

fn is_palindrome(s: Text) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() == 0 { return true }; let mut lo = 0; let mut hi = bytes.len() - 1;
    while lo < hi {
        if bytes[lo] != bytes[hi] { return false };
        lo += 1;
        hi -= 1;
    };
    true
}

test "reverses bytes in place" {
    let mut xs: [u8] = [1, 2, 3, 4, 5]; assert_eq(reverse_bytes(xs), 5); assert_eq(xs[0], 5);
    assert_eq(xs[4], 1); assert_eq(xs[2], 3)
}

test "reverses word order" {
    let mut out: [Text] = ["", "", ""]; assert_eq(reverse_words("ab cd ef", out), 3); assert_eq(out[0], "ef");
    assert_eq(out[1], "cd"); assert_eq(out[2], "ab")
}

test "palindrome check" {
    assert(is_palindrome("level")); assert(is_palindrome("abba")); assert(!is_palindrome("abc"));
    assert(is_palindrome(""))
}
