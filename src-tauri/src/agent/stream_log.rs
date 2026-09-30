//! Streamed output of a daemon-owned turn, written to the Transcript so a
//! reopened window replays it. A CLI can send hundreds of chunks per answer;
//! one transcript line (and one disk wait) per chunk would multiply the file
//! and the cost of every later read. Consecutive text deltas are merged into
//! one line per `WINDOW` (a timer writes the tail), other stream events flush
//! the pending text first,
//! and nothing streamed waits on the disk — the turn's final message, written
//! through the synced path, supersedes it.
use super::transcripts::append_stream_event;
use super::types::AgentEvent;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub(super) const WINDOW: Duration = Duration::from_millis(150);
const MAX_PENDING_BYTES: usize = 8 * 1024;

pub(super) type Broadcast = Box<dyn Fn(&str, u64, &AgentEvent) + Send + Sync>;

/// Shared by the stream channel and the run loop. A timer writes pending text
/// `WINDOW` after it started, so a chunk followed by silence (the CLI working
/// without a word) still reaches the Transcript and any watching window.
#[derive(Clone)]
pub(super) struct StreamLog {
    inner: Arc<Mutex<Inner>>,
    failure: Arc<Mutex<Option<String>>>,
}

struct Inner {
    runs_dir: PathBuf,
    run_id: String,
    sequence: Arc<Mutex<u64>>,
    broadcast: Broadcast,
    pending: Option<(AgentEvent, Instant)>,
}

impl StreamLog {
    pub fn new(runs_dir: PathBuf, run_id: String, sequence: Arc<Mutex<u64>>, broadcast: Broadcast) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner { runs_dir, run_id, sequence, broadcast, pending: None })),
            failure: Arc::new(Mutex::new(None)),
        }
    }

    pub fn push(&self, event: AgentEvent) -> Result<(), String> {
        let started = self.locked(|inner| inner.push(event))?;
        if started {
            let log = self.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(WINDOW).await;
                if let Err(error) = log.flush() {
                    log.failure.lock().unwrap().get_or_insert(error);
                }
            });
        }
        Ok(())
    }

    pub fn flush(&self) -> Result<(), String> {
        self.locked(Inner::flush)
    }

    /// A write that failed on the timer, reported once to the run loop.
    pub fn take_failure(&self) -> Option<String> {
        self.failure.lock().unwrap().take()
    }

    fn locked<T>(&self, f: impl FnOnce(&mut Inner) -> Result<T, String>) -> Result<T, String> {
        f(&mut *self.inner.lock().map_err(|_| "Stream log unavailable".to_string())?)
    }
}

impl Inner {
    /// True when this event started a new pending delta (needs a timer).
    fn push(&mut self, event: AgentEvent) -> Result<bool, String> {
        let AgentEvent::AssistantDelta { .. } = &event else {
            self.flush()?;
            self.write(&event)?;
            return Ok(false);
        };
        let merged = match self.pending.as_mut() {
            Some((pending, since)) => merge(pending, &event)
                .then(|| since.elapsed() >= WINDOW || delta_len(pending) >= MAX_PENDING_BYTES),
            None => None,
        };
        match merged {
            Some(full) => {
                if full {
                    self.flush()?;
                }
                Ok(false)
            }
            None => {
                self.flush()?;
                self.pending = Some((event, Instant::now()));
                Ok(true)
            }
        }
    }

    fn flush(&mut self) -> Result<(), String> {
        match self.pending.take() {
            Some((event, _)) => self.write(&event),
            None => Ok(()),
        }
    }

    fn write(&self, event: &AgentEvent) -> Result<(), String> {
        let mut seq = self.sequence.lock().map_err(|_| "Transcript sequence unavailable")?;
        append_stream_event(&self.runs_dir, &self.run_id, *seq, event)?;
        (self.broadcast)(&self.run_id, *seq, event);
        *seq += 1;
        Ok(())
    }
}

/// Fold `next` into `pending` when both are deltas of the same message.
fn merge(pending: &mut AgentEvent, next: &AgentEvent) -> bool {
    let (
        AgentEvent::AssistantDelta { message_id: a, text, thinking, ts, .. },
        AgentEvent::AssistantDelta { message_id: b, text: more, thinking: more_thinking, ts: later, .. },
    ) = (pending, next)
    else {
        return false;
    };
    if a != b {
        return false;
    }
    text.push_str(more);
    if let Some(extra) = more_thinking {
        thinking.get_or_insert_with(String::new).push_str(extra);
    }
    *ts = *later;
    true
}

fn delta_len(event: &AgentEvent) -> usize {
    match event {
        AgentEvent::AssistantDelta { text, thinking, .. } => text.len() + thinking.as_ref().map_or(0, String::len),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::transcripts::read_events;

    fn delta(message: &str, text: &str) -> AgentEvent {
        AgentEvent::AssistantDelta {
            run_id: "r".into(),
            message_id: message.into(),
            text: text.into(),
            thinking: None,
            ts: 0,
        }
    }

    fn log(label: &str) -> (PathBuf, StreamLog, Arc<Mutex<Vec<u64>>>) {
        let dir = std::env::temp_dir().join(format!("klide-stream-log-{label}-{}", crate::agent::transcripts::run_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let log = StreamLog::new(dir.clone(), "r".into(), Arc::new(Mutex::new(0)), Box::new(move |_, seq, _| sink.lock().unwrap().push(seq)));
        (dir, log, seen)
    }

    #[test]
    fn a_burst_of_chunks_becomes_one_line_with_all_the_text() {
        let (dir, log, seen) = log("burst");
        for word in ["Saved ", "while ", "away"] {
            log.push(delta("m", word)).unwrap();
        }
        log.flush().unwrap();
        let events = read_events(&dir, "r").unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], AgentEvent::AssistantDelta { text, .. } if text == "Saved while away"));
        assert_eq!(*seen.lock().unwrap(), vec![0]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn another_event_or_message_keeps_order_and_contiguous_seqs() {
        let (dir, log, seen) = log("order");
        log.push(delta("m", "before ")).unwrap();
        log.push(AgentEvent::ObservedToolResult { run_id: "r".into(), tool_call_id: "t".into(), ok: true, content: String::new(), ts: 0 }).unwrap();
        log.push(delta("m", "after")).unwrap();
        log.push(delta("n", "next message")).unwrap();
        log.flush().unwrap();
        let events = read_events(&dir, "r").unwrap();
        assert_eq!(events.len(), 4);
        assert!(matches!(&events[0], AgentEvent::AssistantDelta { text, .. } if text == "before "));
        assert!(matches!(&events[1], AgentEvent::ObservedToolResult { .. }));
        assert!(matches!(&events[3], AgentEvent::AssistantDelta { text, .. } if text == "next message"));
        assert_eq!(*seen.lock().unwrap(), vec![0, 1, 2, 3]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_chunk_followed_by_silence_reaches_disk_without_another_event() {
        let (dir, log, _) = log("silence");
        log.push(delta("m", "thinking out loud")).unwrap();
        std::thread::sleep(WINDOW * 4);
        assert_eq!(read_events(&dir, "r").unwrap().len(), 1);
        assert!(log.take_failure().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
