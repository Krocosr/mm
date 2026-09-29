// safe: one record field is moved out of a local and the rest of the local is
// used afterwards. Partial moves of a record are sound.
type Named = { name: Text, age: u32 }

fn label(p: Named) -> Text {
    p.name
}

fn years(p: Named) -> u32 {
    p.age
}

fn describe() -> u32 {
    let p = Named { name: "ada", age: 36 };
    let n = label(p);
    years(p) + n.len() as u32
}
