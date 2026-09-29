// safe: the `normalize` shape from the smoke fixture - a `for` loop mutating
// through a `view mut [T]`, with one read borrow taken and released first.
fn sum(xs: view [f32]) -> f32 {
    let mut s = 0.0;
    for x in xs {
        s = s + x
    };
    s
}

fn normalize(xs: view mut [f32]) {
    let s = sum(xs);
    for x in xs {
        x /= s
    }
}
