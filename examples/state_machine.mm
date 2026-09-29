// A tagged union driven by a match transition table: the control-flow row.
// Each state and event pair has exactly one successor, and the table is the
// match itself, so an agent can read the machine as a graph without executing it.

type State =
    Idle
  | Running { ticks: u32 }
  | Paused { ticks: u32 }
  | Done { total: u32 }

type Event = Tick | Pause | Resume | Stop

fn running(ticks: u32) -> State {
    Running { ticks: ticks }
}

fn paused(ticks: u32) -> State {
    Paused { ticks: ticks }
}

fn finished(total: u32) -> State {
    Done { total: total }
}

fn state_name(s: State) -> Text {
    match s {
        Idle => "idle",
        Running { ticks } => "running",
        Paused { ticks } => "paused",
        Done { total } => "done"
    }
}

fn tick_count(s: State) -> u32 {
    match s {
        Running { ticks } => ticks,
        Paused { ticks } => ticks,
        Idle => 0,
        Done { total } => total
    }
}

fn is_final(s: State) -> bool {
    match s { Done { total } => true, _ => false }
}

// The transition table. Done is absorbing: every event stays Done.
fn step(s: State, e: Event) -> State {
    match s {
        Idle => match e { Tick => running(0), _ => Idle },
        Running { ticks } => match e {
            Tick => running(ticks + 1),
            Pause => paused(ticks),
            Stop => finished(ticks),
            Resume => running(ticks)
        },
        Paused { ticks } => match e {
            Resume => running(ticks),
            Stop => finished(ticks),
            _ => paused(ticks)
        },
        Done { total } => finished(total)
    }
}

fn run(s: State, events: view [Event]) -> State {
    let mut cur = s; let mut i = 0;
    while i < events.len() {
        cur = step(cur, events[i]);
        i += 1;
    };
    cur
}

test "ticks accumulate while running" {
    let s = run(Idle, [Tick, Tick, Tick]); assert_eq(tick_count(s), 2); assert_eq(state_name(s), "running")
}

test "pause and resume preserve the count" {
    let s = run(Idle, [Tick, Tick, Pause, Resume, Tick]); assert_eq(tick_count(s), 2);
    let held = Paused { ticks: 7 }; assert_eq(state_name(step(held, Pause)), "paused")
}

test "stop is final and absorbing" {
    let s = run(Idle, [Tick, Tick, Tick, Stop, Tick]); assert_eq(state_name(s), "done");
    assert_eq(tick_count(s), 2); assert(is_final(s)); assert(is_final(step(s, Tick)))
}
