//! Stand-in for the atomic-wait crate in tinue's single-threaded WASI build of Syntaks. With one search thread
//! (the patched inline Searcher) no wait can be woken by anyone else, so a wait that would block is a bug: panic
//! instead of hanging the page.
use std::sync::atomic::{AtomicU32, Ordering};

pub fn wait(atomic: &AtomicU32, value: u32) {
    if atomic.load(Ordering::Acquire) == value {
        panic!("atomic-wait stub: would block forever (single-threaded build)");
    }
}
pub fn wake_one(_atomic: *const AtomicU32) {}
pub fn wake_all(_atomic: *const AtomicU32) {}
