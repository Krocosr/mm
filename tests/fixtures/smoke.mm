// Smoke fixture: exercises every item kind and the ownership/effect surface syntax.
use std.fs.{read, write}
use std.text as t

const MAX: usize = 4096

type Point = { x: f32, y: f32 }

type Shape =
    Circle { r: f32 }
  | Rect { w: f32, h: f32 }

type Route = choice { fast, deep, reject }

type Node = { name: Text, next: shared Node? }

@resource(close = fs.close)
type File = Handle<fd>

@wire
type Job = { id: u64, input: Bytes }

@secret
type ApiToken = Bytes

trait DecisionProvider {
    fn decide[S, Q](state: view S, question: view Q) -> Decision<Q.Output> !{agent, nondet}
}

impl DecisionProvider for RuleProvider {
    fn decide[S, Q](state: view S, question: view Q) -> Decision<Q.Output> !{agent, nondet} {
        Decision { value: question.default, confidence: 0.5 }
    }
}

fn dist2(a: view Point, b: view Point) -> f32 {
    let dx = a.x - b.x
    let dy = a.y - b.y
    dx * dx + dy * dy
}

fn normalize(xs: view mut [f32]) {
    let s = sum(xs)
    for x in xs {
        x /= s
    }
}

fn load(path: Path) -> Result<Bytes, IoErr> !{fs.read} {
    let f = fs.open(path)?
    let b = f.read_all()?
    parse_bytes(b)
}

@intent
fn triage(t: Ticket) -> Decision<Route> !{agent, nondet} {
    Decision { value: Route.fast, confidence: 0.9 }
}

unsafe[ffi, rawptr] fn map_page(p: *mut u8, n: usize) -> view mut [u8] {
    unsafe { raw_slice(p, n) }
}

extern "C" unsafe fn fopen(path: *const c8, mode: *const c8) -> *mut CFile {
    null
}

fn classify(shape: view Shape) -> u8 {
    match shape {
        Circle { r } => 1
        Rect { w, h } => 2
    }
}

fn walk(n: shared Node, depth: usize) -> usize {
    match n.next {
        Some(next) => depth + walk(next, depth + 1)
        None => depth
    }
}

test "dist2 of unit square" {
    let a = Point { x: 0.0, y: 0.0 }
    let b = Point { x: 3.0, y: 4.0 }
    assert_eq(dist2(a, b), 25.0)
}
