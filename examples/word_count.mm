// UTF-8 aware word counting into a Map. Continuation bytes (10xxxxxx) never
// start a word and never end one, so a multi-byte character is one word rather
// than as many as it has bytes.

const SPACE: u8 = 32
const TAB: u8 = 9
const NEWLINE: u8 = 10
const RETURN: u8 = 13

fn is_space(c: u8) -> bool {
    c == SPACE || c == TAB || c == NEWLINE || c == RETURN
}

fn is_continuation(c: u8) -> bool {
    c >= 128 && c < 192
}

// Characters, not bytes: a continuation byte belongs to the character before it.
fn char_count(s: Text) -> usize {
    let bytes = s.as_bytes();
    let mut n = 0;
    let mut i = 0;
    while i < bytes.len() {
        if is_continuation(bytes[i]) == false { n += 1 };
        i += 1;
    };
    n
}

// Splits on ASCII whitespace only, which is why UTF-8 stays intact.
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

// Folds one document into the counts and returns how many words it had.
fn count_words(counts: view mut Map<Text, u32>, s: Text) -> usize {
    let mut words: [Text] = ["", "", "", "", "", "", "", ""]; let n = split_words(s, words); let mut i = 0;
    while i < n {
        let seen = counts.get(words[i]);
        counts.insert(words[i], seen + 1);
        i += 1;
    };
    n
}

fn distinct(counts: view Map<Text, u32>) -> usize {
    counts.len()
}

fn max_count(counts: view Map<Text, u32>) -> u32 {
    let mut best: u32 = 0;
    for entry in counts {
        if entry.value > best { best = entry.value };
    };
    best
}

fn byte_len(s: Text) -> usize {
    s.as_bytes().len()
}

test "counts words into a map" {
    let mut counts: Map<Text, u32> = Map::new(); assert_eq(count_words(counts, "the quick brown fox"), 4);
    assert_eq(counts.get("the"), 1); assert_eq(count_words(counts, "the end"), 2);
    assert_eq(counts.get("the"), 2); assert_eq(distinct(counts), 5); assert_eq(max_count(counts), 2)
}

test "a multi-byte character is one word" {
    let mut counts: Map<Text, u32> = Map::new();
    assert_eq(count_words(counts, "caf\u{e9} na\u{ef}ve caf\u{e9}"), 3);
    assert_eq(counts.get("caf\u{e9}"), 2); assert_eq(byte_len("caf\u{e9}"), 5);
    assert_eq(char_count("caf\u{e9}"), 4); assert_eq(distinct(counts), 2)
}
