//! deep: a native tinue solver for 6x6 Tak (see deep/README.md and the SOLVER.md brief).
//!
//! The library is free of threads, clocks and file IO so it can be compiled to WebAssembly:
//! budgets are node counts and table sizes are a runtime parameter (`lp` = log2 entries).

pub mod board;
pub mod cert;
pub mod check;
pub mod positions;
pub mod search;
pub mod testkit;

pub use board::{Board, Move};
pub use search::{Outcome, Search};
