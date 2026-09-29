// A stack machine over a `[u8]` bytecode program: the interpreter row. The
// program counter, the stack pointer, and the operand stack are all explicit,
// so the step count and the stack depth are measurable rather than implied.

const OP_PUSH: u8 = 1
const OP_ADD: u8 = 2
const OP_MUL: u8 = 3
const OP_DUP: u8 = 4
const OP_SWAP: u8 = 5
const OP_HALT: u8 = 6

fn opcode_name(op: u8) -> Text {
    match op {
        1 => "PUSH",
        2 => "ADD",
        3 => "MUL",
        4 => "DUP",
        5 => "SWAP",
        _ => "HALT"
    }
}

// Runs at most `budget` instructions; returns the top of stack, or 0.
fn run(code: view [u8], stack: view mut [u32], budget: usize) -> u32 {
    let mut sp: usize = 0; let mut pc: usize = 0; let mut steps: usize = 0;
    while pc < code.len() && steps < budget {
        let op = code[pc];
        if op == OP_PUSH {
            stack[sp] = code[pc + 1] as u32;
            sp += 1;
            pc += 2;
        } else if op == OP_ADD {
            let b = stack[sp - 1]; let a = stack[sp - 2];
            stack[sp - 2] = a + b;
            sp -= 1;
            pc += 1;
        } else if op == OP_MUL {
            let b = stack[sp - 1]; let a = stack[sp - 2];
            stack[sp - 2] = a * b;
            sp -= 1;
            pc += 1;
        } else if op == OP_DUP {
            stack[sp] = stack[sp - 1];
            sp += 1;
            pc += 1;
        } else if op == OP_SWAP {
            let a = stack[sp - 1];
            stack[sp - 1] = stack[sp - 2];
            stack[sp - 2] = a;
            pc += 1;
        } else if op == OP_HALT {
            break;
        } else {
            return 0;
        };
        steps += 1;
    };
    if sp == 0 { return 0 };
    stack[sp - 1]
}

// Disassembles into caller-owned text slots, one per instruction.
fn trace(code: view [u8], out: view mut [Text], budget: usize) -> usize {
    let mut pc: usize = 0; let mut n: usize = 0;
    while pc < code.len() && n < budget {
        let op = code[pc];
        out[n] = opcode_name(op);
        n += 1;
        pc = pc + if op == OP_PUSH { 2 } else { 1 };
    };
    n
}

test "computes (2 + 3) * 10" {
    let code: [u8] = [1, 2, 1, 3, 2, 1, 10, 3]; let mut stack: [u32] = [0, 0, 0, 0];
    assert_eq(run(code, stack, 32), 50); assert_eq(stack[0], 50)
}

test "halt stops before the rest of the program" {
    let code: [u8] = [1, 7, 6, 1, 9, 6]; let mut stack: [u32] = [0, 0, 0, 0];
    assert_eq(run(code, stack, 32), 7); assert_eq(opcode_name(3), "MUL")
}

test "the trace follows the instruction stream" {
    let code: [u8] = [1, 2, 1, 3, 2]; let mut out: [Text] = ["", "", "", "", ""];
    assert_eq(trace(code, out, 8), 3); assert_eq(out[0], "PUSH"); assert_eq(out[2], "ADD")
}
