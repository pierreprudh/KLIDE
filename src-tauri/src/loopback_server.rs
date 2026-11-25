//! The accept-loop rules every tiny_http loopback listener shares (the
//! coordination bridge, the model-source bridge, the status hook server).
//!
//! tiny_http parses headers on its own threads but hands each request to one
//! accept loop, and reading a body — or dropping a request, which drains the
//! body it declared — blocks on the socket. So the loop never touches a body
//! it does not already hold: a request is answered there only when its body
//! is buffered, otherwise on a counted thread, and with no thread free it is
//! parked. A stalled caller costs one connection, never the listener.

use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// tiny_http reads a body this small with the headers.
const BUFFERED_BODY_BYTES: usize = 1024;

/// One serving thread, returned to the pool when dropped.
pub struct Slot(Arc<AtomicUsize>);

impl Slot {
    pub fn take(counter: &Arc<AtomicUsize>, max: usize) -> Option<Slot> {
        counter
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < max).then_some(n + 1))
            .ok()
            .map(|_| Slot(counter.clone()))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Whether tiny_http already holds this request's whole body in memory, so
/// answering and dropping it on the accept thread cannot block on the socket.
pub fn body_is_buffered(request: &tiny_http::Request) -> bool {
    let expects_continue = request.headers().iter().any(|h| h.field.equiv("Expect"));
    match request.body_length() {
        None | Some(0) => true,
        Some(n) => n <= BUFFERED_BODY_BYTES && !expects_continue,
    }
}

/// Answer a request the listener will not serve, without reading its body. A
/// buffered one is answered right here; one with body bytes still on the
/// socket is answered on a counted thread (dropping it drains them), and with
/// no thread free it is parked rather than let a stalled client hold the
/// accept loop.
pub fn answer<R: Read + Send + 'static>(request: tiny_http::Request, response: tiny_http::Response<R>, slot: Option<Slot>) {
    if body_is_buffered(&request) {
        let _ = request.respond(response);
        return;
    }
    match slot {
        Some(slot) => {
            std::thread::spawn(move || {
                let _slot = slot;
                let _ = request.respond(response);
            });
        }
        None => abandon(request, response),
    }
}

/// Write the answer, then leak the connection instead of dropping it: tiny_http
/// would otherwise drain the declared body into one allocation of that size,
/// and a claimed exabyte aborts the app. A hostile request costs one parked
/// connection, never the process.
pub fn abandon<R: Read>(request: tiny_http::Request, response: tiny_http::Response<R>) {
    let stream = request.upgrade("klide-abandoned", response);
    std::mem::forget(stream);
}
