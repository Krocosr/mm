// Roman numerals by digit table: four array lookups and three concatenations.
// The tables are `const`, so they live in the binary rather than on the stack.

const THOUSANDS: [Text] = ["", "M", "MM", "MMM"]
const HUNDREDS: [Text] = ["", "C", "CC", "CCC", "CD", "D", "DC", "DCC", "DCCC", "CM"]
const TENS: [Text] = ["", "X", "XX", "XXX", "XL", "L", "LX", "LXX", "LXXX", "XC"]
const ONES: [Text] = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"]

fn roman(n: u32) -> Text {
    let mut out = "";
    out = out + THOUSANDS[(n / 1000) as usize];
    out = out + HUNDREDS[((n / 100) % 10) as usize];
    out = out + TENS[((n / 10) % 10) as usize];
    out = out + ONES[(n % 10) as usize];
    out
}

fn symbol_value(c: char) -> u32 {
    match c {
        'I' => 1,
        'V' => 5,
        'X' => 10,
        'L' => 50,
        'C' => 100,
        'D' => 500,
        'M' => 1000,
        _ => 0
    }
}

// Subtractive notation: a smaller symbol before a larger one is negative.
fn from_roman(s: Text) -> u32 {
    let chars = s.chars(); let mut total: u32 = 0; let mut i = 0;
    while i < chars.len() {
        let v = symbol_value(chars[i]);
        if i + 1 < chars.len() && v < symbol_value(chars[i + 1]) {
            total = total - v;
        } else {
            total = total + v;
        };
        i += 1;
    };
    total
}

fn symbol_count(s: Text) -> usize {
    s.chars().len()
}

test "renders the canonical examples" {
    assert_eq(roman(4), "IV"); assert_eq(roman(9), "IX"); assert_eq(roman(1994), "MCMXCIV");
    assert_eq(roman(2024), "MMXXIV")
}

test "reads numerals back" {
    assert_eq(from_roman("MCMXCIV"), 1994); assert_eq(from_roman("IV"), 4);
    assert_eq(symbol_count("MCMXCIV"), 7)
}
