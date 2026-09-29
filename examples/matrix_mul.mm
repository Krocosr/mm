// Dense matrix multiply over nested slices: the floating-point row of the
// benchmark matrix. Every buffer belongs to the caller; the kernel writes
// through `view mut` and never allocates.

type Matrix = [[f32]]

fn dot(a: view [f32], b: view [f32]) -> f32 {
    let n = a.len(); let mut acc: f32 = 0.0; let mut i = 0;
    while i < n {
        acc = acc + a[i] * b[i];
        i += 1;
    };
    acc
}

// out = a * b; returns the number of cells written.
fn mat_mul(a: view Matrix, b: view Matrix, out: view mut Matrix) -> usize {
    let rows = a.len(); let inner = b.len(); let cols = if inner == 0 { 0 } else { b[0].len() };
    let mut i = 0;
    while i < rows {
        let mut j = 0;
        while j < cols {
            let mut acc: f32 = 0.0; let mut k = 0;
            while k < inner {
                acc = acc + a[i][k] * b[k][j];
                k += 1;
            };
            out[i][j] = acc;
            j += 1;
        };
        i += 1;
    };
    rows * cols
}

fn mat_scale(m: view Matrix, k: f32, out: view mut Matrix) -> usize {
    let mut i = 0;
    while i < m.len() {
        let mut j = 0;
        while j < m[i].len() {
            out[i][j] = m[i][j] * k;
            j += 1;
        };
        i += 1;
    };
    m.len()
}

fn trace(m: view Matrix) -> f32 {
    let mut acc: f32 = 0.0; let mut i = 0;
    while i < m.len() {
        acc = acc + m[i][i];
        i += 1;
    };
    acc
}

test "multiplies two 2x2 matrices" {
    let a: Matrix = [[1.0, 2.0], [3.0, 4.0]]; let b: Matrix = [[5.0, 6.0], [7.0, 8.0]];
    let mut c: Matrix = [[0.0, 0.0], [0.0, 0.0]]; let cells = mat_mul(a, b, c); assert_eq(cells, 4);
    assert_eq(c[0][0], 19.0); assert_eq(c[0][1], 22.0); assert_eq(c[1][0], 43.0); assert_eq(c[1][1], 50.0)
}

test "scaling and tracing" {
    let m: Matrix = [[1.0, 2.0], [3.0, 4.0]]; let mut scaled: Matrix = [[0.0, 0.0], [0.0, 0.0]];
    mat_scale(m, 2.0, scaled); assert_eq(scaled[1][0], 6.0); assert_eq(trace(m), 5.0);
    assert_eq(dot([1.0, 2.0], [3.0, 4.0]), 11.0)
}
