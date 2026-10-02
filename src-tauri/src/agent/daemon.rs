//! Runs owned by ptyd rather than the GUI. The existing Harness remains the
//! sole transcript writer, including while no window is connected.
//!
//! This is the daemon's adapter around `run_host`: admission, the handle,
//! the spawn and the backstop are the app's code, called here with the
//! daemon's map. What is the daemon's own: the coordination bridge it hosts,
//! the Mission operations it queues for the app to execute, and the socket
//! sink every event and journal move goes out on. The app judges the failure
//! budget before it hands a Run over, so there is none here.
use super::*;
use crate::coordination_bridge::{BridgeHooks, BridgeSession, CoordinationBridgeState};
use crate::pty_wire::ChatControl;

type OperationReply = tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>;
type OperationSink = Arc<dyn Fn(crate::pty_wire::ChatOperation) + Send + Sync>;

type EventSink = Arc<dyn Fn(&str, u64, &AgentEvent) + Send + Sync>;
/// `(workspace_root, journal seq)` — a coordination journal move made by a
/// Run this host owns, for the app's panels to hear through the socket.
type ChangeSink = Arc<dyn Fn(&str, u64) + Send + Sync>;

pub(crate) struct RunHost {
    runs: Mutex<HashMap<String, AgentRunHandle>>,
    starts: Mutex<HashMap<String, u64>>,
    store: CoordinationStoreState,
    bridge: CoordinationBridgeState,
    data_dir: PathBuf,
    sink: EventSink,
    change_sink: Mutex<Option<ChangeSink>>,
    operations: Mutex<HashMap<String, (crate::pty_wire::ChatOperation, OperationReply)>>,
    operation_sink: Mutex<Option<OperationSink>>,
}

impl RunHost {
    pub fn new(data_dir: PathBuf, sink: EventSink) -> Arc<Self> {
        Arc::new(Self {
            runs: Mutex::new(HashMap::new()),
            starts: Mutex::new(HashMap::new()),
            store: CoordinationStoreState::default(),
            bridge: CoordinationBridgeState::default(),
            data_dir,
            sink,
            change_sink: Mutex::new(None),
            operations: Mutex::new(HashMap::new()),
            operation_sink: Mutex::new(None),
        })
    }

    pub fn set_operation_sink(&self, sink: OperationSink) {
        *self.operation_sink.lock().unwrap() = Some(sink);
    }

    pub fn set_change_sink(&self, sink: ChangeSink) {
        *self.change_sink.lock().unwrap() = Some(sink);
    }

    fn announce_change(&self, root: &str, outcome: &CoordinationCommandOutcome) {
        let Some(line) = &outcome.appended else { return };
        if let Some(sink) = self.change_sink.lock().unwrap().as_ref() {
            sink(root, line.seq);
        }
    }

    pub fn operations(&self, id: &str) -> Vec<crate::pty_wire::ChatOperation> {
        self.operations
            .lock()
            .unwrap()
            .values()
            .filter(|(op, _)| op.run_id == id)
            .map(|(op, _)| op.clone())
            .collect()
    }

    pub fn reply(&self, id: &str, result: Result<serde_json::Value, String>) {
        if let Some((_, tx)) = self.operations.lock().unwrap().remove(id) {
            let _ = tx.send(result);
        }
    }

    fn queue_operation(
        &self,
        root: String,
        run_id: String,
        request: crate::missions::orchestration::Request,
    ) -> tokio::sync::oneshot::Receiver<Result<serde_json::Value, String>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let op = crate::pty_wire::ChatOperation {
            id: transcripts::run_id(),
            run_id,
            workspace_root: root,
            request,
        };
        self.operations
            .lock()
            .unwrap()
            .insert(op.id.clone(), (op.clone(), tx));
        if let Some(sink) = self.operation_sink.lock().unwrap().as_ref() {
            sink(op);
        }
        rx
    }

    /// Every Run this host holds a handle for, with its wire status. Active
    /// or settling: the app applies the one "active" rule to what it reads.
    pub fn statuses(&self) -> HashMap<String, String> {
        self.runs
            .lock()
            .unwrap()
            .iter()
            .map(|(id, h)| (id.clone(), run_status_wire(&h.status).into()))
            .collect()
    }

    pub fn status(&self, id: &str) -> (Option<String>, u64) {
        let runs = self.runs.lock().unwrap();
        let status = runs.get(id).map(|h| run_status_wire(&h.status).to_string());
        let from = self.starts.lock().unwrap().get(id).copied().unwrap_or(0);
        (status, from)
    }

    pub fn control(&self, id: &str, control: ChatControl) -> Result<bool, String> {
        let runs = self
            .runs
            .lock()
            .map_err(|_| "Agent state is unavailable")?;
        let handle = runs
            .get(id)
            .ok_or_else(|| format!("No known run with id {id}"))?;
        run_host::answer(handle, control)
    }

    pub fn start(
        self: &Arc<Self>,
        request: StartRunRequest,
        runs_dir: PathBuf,
    ) -> Result<u64, String> {
        self.start_with(request, runs_dir, RealProviderCaller)
    }

    fn start_with(
        self: &Arc<Self>,
        mut request: StartRunRequest,
        runs_dir: PathBuf,
        caller: impl AgentProviderCaller,
    ) -> Result<u64, String> {
        if !run_host::background_eligible(&request) {
            return Err("Only standalone subscription conversations can run in this host".into());
        }
        let id = request.run_id.clone().ok_or("Missing conversation id")?;
        validate_run_id(&id)?;
        std::fs::create_dir_all(&runs_dir).map_err(|e| e.to_string())?;
        request.command_allowlist = delegate_allowed_commands(
            &request.provider,
            &runs_dir,
            request.workspace_root.as_deref(),
        );
        let admitted = run_host::admit(&self.runs, &runs_dir, &id, &request, || Ok(()))?;
        let from = admitted.from_seq();
        self.starts.lock().unwrap().insert(id.clone(), from);
        self.ensure_bridge();
        // RunLease retires the handle on success, error, and panic; the
        // host's backstop reports a loop that left without settling. Dropping
        // a UI/socket observer never drops this task or its cancellation token.
        run_host::spawn_loop(
            self.clone(),
            runs_dir,
            id,
            request,
            Channel::new(|_| Ok(())),
            admitted,
            caller,
            |_| {},
        );
        Ok(from)
    }

    fn ensure_bridge(self: &Arc<Self>) {
        let live = Arc::downgrade(self);
        let operations = live.clone();
        let changes = live.clone();
        let endpoint = self.data_dir.join("chat-coordination-endpoint.json");
        if let Err(e) = self.bridge.ensure_server(
            &endpoint,
            self.store.clone(),
            BridgeHooks {
                orchestrate: Some(Box::new(move |session, request| {
                    let host = operations.upgrade().ok_or("Background host stopped")?;
                    host.queue_operation(
                        session.workspace_root.clone(),
                        session.run_id.clone(),
                        request,
                    )
                    .blocking_recv()
                    .map_err(|_| "Mission request was cancelled".to_string())?
                })),
                on_change: Box::new(move |root, outcome| {
                    if let Some(host) = changes.upgrade() {
                        host.announce_change(root, outcome);
                    }
                }),
                is_live: Box::new(move |id| live.upgrade().is_some_and(|h| h.is_live(id))),
                cancel: None,
                resolve_session: Box::new(|_| None),
            },
        ) {
            eprintln!("chat coordination bridge: {e}");
        }
    }

    fn wire(
        &self,
        id: &str,
        provider: &str,
        root: &str,
    ) -> Result<Option<crate::delegate::McpWiring>, String> {
        let Some(adapter) = crate::delegate::lookup(provider) else {
            return Ok(None);
        };
        let session_id = format!("{id}:{provider}");
        let dir = self.data_dir.join("chat-mcp");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stem = format!("{id}-{provider}");
        let secret_path = dir.join(format!("{stem}.secret"));
        let secret = crate::coordination_bridge::mint_session_secret()?;
        crate::durable::write_atomic_private(&secret_path, secret.as_bytes())?;
        let wiring = adapter.mcp_wiring(&crate::delegate::McpServerSpec {
            command: std::env::current_exe()
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .into(),
            args: vec!["mcp".into(), "coordination".into()],
            endpoint_path: self
                .data_dir
                .join("chat-coordination-endpoint.json")
                .to_string_lossy()
                .into(),
            session_id: session_id.clone(),
            secret_path: secret_path.to_string_lossy().into(),
            config_dir: dir.to_string_lossy().into(),
            file_stem: stem,
        });
        if let Some(w) = &wiring {
            for (path, contents) in &w.files {
                crate::durable::write_atomic_private(Path::new(path), contents.as_bytes())?;
            }
            self.bridge.bind_session(
                &session_id,
                BridgeSession {
                    run_id: id.into(),
                    workspace_root: root.into(),
                    terminal: false,
                    secret_sha256: crate::coordination_bridge::secret_sha256(&secret),
                },
            );
        }
        Ok(wiring)
    }
}

impl RunSupervisor for RunHost {
    fn set_status(&self, id: &str, status: AgentRunStatus) {
        let root = {
            let mut runs = self.runs.lock().unwrap();
            let Some(h) = runs.get_mut(id) else { return };
            h.status = status;
            h.coordination_workspace_root.clone()
        };
        if let Some(root) = root {
            // The same words the app writes for the same move.
            let _ = self.coordination_apply(
                &root,
                CoordinationCommand::SetRunState {
                    actor: CoordinationActor::Run { run_id: id.into() },
                    run_id: id.into(),
                    state: coordination_state_for_status(status, false),
                    reason: Some(coordination_reason_for_status(status)),
                },
            );
        }
    }
    fn with_handle(&self, id: &str, f: &mut dyn FnMut(&AgentRunHandle)) -> bool {
        let runs = self.runs.lock().unwrap();
        if let Some(h) = runs.get(id) {
            f(h);
            true
        } else {
            false
        }
    }
    fn persist_stream(&self) -> bool {
        true
    }
    fn observer_support(&self) -> Result<(), String> {
        Err("This conversation runs in the background host, which cannot start a new reply \
             when a command exits. Start the command with background: true and read its \
             output with read_command_output instead of notifyOnExit."
            .into())
    }
    fn broadcast(&self, id: &str, seq: u64, event: &AgentEvent) {
        (self.sink)(id, seq, event);
    }
    /// The handle goes last, as `RunLease::release` says: a reattach landing
    /// in between still finds the Run, and the loop's own backstop has
    /// already written before the lease lets go.
    fn retire_run(&self, id: &str) {
        self.operations
            .lock()
            .unwrap()
            .retain(|_, (op, _)| op.run_id != id);
        self.starts.lock().unwrap().remove(id);
        if let Ok(mut runs) = self.runs.lock() {
            runs.remove(id);
        }
    }
    fn orchestrate(
        &self,
        root: String,
        actor: String,
        request: crate::missions::orchestration::Request,
    ) -> tokio::sync::oneshot::Receiver<Result<serde_json::Value, String>> {
        self.queue_operation(root, actor, request)
    }
    fn coordination_apply(
        &self,
        root: &str,
        command: CoordinationCommand,
    ) -> Result<CoordinationCommandOutcome, String> {
        let outcome = off_the_worker(|| {
            crate::coordination::apply_coordination_command(&self.store, root, command)
        })?;
        // Tell the app's panels the journal moved, the way the app's own
        // supervisor does — through the socket, since this host has no window.
        self.announce_change(root, &outcome);
        Ok(outcome)
    }
    fn coordination_snapshot(&self, root: &str) -> Result<CoordinationSnapshot, String> {
        off_the_worker(|| crate::coordination::read_snapshot(&self.store, root))
    }
    fn coordination_changes(&self, root: &str) -> Option<tokio::sync::watch::Receiver<u64>> {
        crate::coordination::subscribe_changes(&self.store, root).ok()
    }
    fn delegate_mcp_wiring(
        &self,
        id: &str,
        provider: &str,
        root: Option<&str>,
    ) -> Option<crate::delegate::McpWiring> {
        self.wire(id, provider, root?).unwrap_or_else(|e| {
            eprintln!("chat MCP: {e}");
            None
        })
    }
    fn release_delegate_session(&self, id: &str, provider: &str) {
        self.bridge.forget_session(&format!("{id}:{provider}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Notify;

    #[derive(Clone)]
    struct HeldProvider {
        started: Arc<Notify>,
        finish: Arc<Notify>,
    }
    impl AgentProviderCaller for HeldProvider {
        fn call<'a>(
            &'a self,
            req: ProviderTurnRequest,
        ) -> Pin<Box<dyn Future<Output = Result<AiChatResponse, String>> + Send + 'a>> {
            Box::pin(async move {
                req.stream
                    .send(StreamChunk {
                        content: "Saved while away".into(),
                        ..Default::default()
                    })
                    .unwrap();
                self.started.notify_one();
                self.finish.notified().await;
                Ok(AiChatResponse {
                    content: "Saved while away".into(),
                    thinking: None,
                    tool_calls: vec![],
                    usage: None,
                    stop_reason: None,
                })
            })
        }
    }
    fn fixture(label: &str) -> (PathBuf, StartRunRequest, HeldProvider) {
        let dir = std::env::temp_dir().join(format!(
            "klide-background-chat-{label}-{}",
            transcripts::run_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let request = serde_json::from_value(serde_json::json!({
            "runId": "conversation", "mode": "chat", "provider": "opencode", "model": "default", "initialText": "Keep working"
        })).unwrap();
        (
            dir,
            request,
            HeldProvider {
                started: Arc::new(Notify::new()),
                finish: Arc::new(Notify::new()),
            },
        )
    }
    async fn settled(host: &RunHost) {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !host.statuses().is_empty() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("run should settle");
    }

    #[tokio::test]
    async fn disconnected_observer_does_not_cancel_and_reopen_reads_completed_answer() {
        let (dir, request, caller) = fixture("reopen");
        let (tx, rx) = std::sync::mpsc::channel();
        let host = RunHost::new(
            dir.clone(),
            Arc::new(move |_, seq, event| {
                let _ = tx.send((seq, event.clone()));
            }),
        );
        let runs = dir.join("runs");
        host.start_with(request.clone(), runs.clone(), caller.clone())
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            caller.started.notified(),
        )
        .await
        .unwrap();
        drop(rx); // the GUI and its output channel disappear mid-generation
        assert_eq!(host.statuses()["conversation"], "running");
        // Streamed text lands within the merge window, with the provider
        // still mid-turn and nobody watching.
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !read_events(&runs, "conversation").unwrap().iter().any(
                |e| matches!(e, AgentEvent::AssistantDelta { text, .. } if text == "Saved while away")
            ) {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("streamed text should reach the transcript mid-turn");
        assert!(host
            .start_with(request, runs.clone(), caller.clone())
            .unwrap_err()
            .contains("already active"));
        caller.finish.notify_one();
        settled(&host).await;
        let replay = read_events(&runs, "conversation").unwrap();
        assert!(matches!(replay.last(), Some(AgentEvent::RunResult { .. })));
        assert_eq!(
            replay
                .iter()
                .filter(|e| matches!(e, AgentEvent::UserMessage { .. }))
                .count(),
            1
        );
        assert_eq!(
            last_assistant_text(&runs, "conversation").as_deref(),
            Some("Saved while away")
        );
        // The durable sequence covers streamed and completed events together.
        for (seq, line) in std::fs::read_to_string(transcript_path(&runs, "conversation"))
            .unwrap()
            .lines()
            .enumerate()
        {
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(line).unwrap()["seq"],
                seq
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn explicit_stop_cancels_a_detached_run_and_releases_its_slot() {
        let (dir, request, caller) = fixture("stop");
        let host = RunHost::new(dir.clone(), Arc::new(|_, _, _| {}));
        let runs = dir.join("runs");
        host.start_with(request, runs.clone(), caller.clone())
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            caller.started.notified(),
        )
        .await
        .unwrap();
        host.control("conversation", ChatControl::Stop).unwrap();
        settled(&host).await;
        let replay = read_events(&runs, "conversation").unwrap();
        assert!(replay.iter().any(
            |e| matches!(e, AgentEvent::RunError { error, .. } if error.code == error_code::ABORTED)
        ));
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A "model" that streams a chunk and then panics — the loop's worst way
    /// out, with a stream-log flush still pending on its timer.
    #[derive(Clone)]
    struct StreamThenPanic;
    impl AgentProviderCaller for StreamThenPanic {
        fn call<'a>(
            &'a self,
            req: ProviderTurnRequest,
        ) -> Pin<Box<dyn Future<Output = Result<AiChatResponse, String>> + Send + 'a>> {
            Box::pin(async move {
                req.stream
                    .send(StreamChunk {
                        content: "half an answer".into(),
                        ..Default::default()
                    })
                    .unwrap();
                panic!("provider adapter bug")
            })
        }
    }

    /// The host's backstop used to take its seq from a fresh transcript count
    /// while the loop's stream log could still flush on the old counter, and
    /// the daemon released admission in a place of its own. Now one counter
    /// serves every writer of the Run and the lease releases the handle.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_panicking_loop_ends_on_one_terminal_error_with_contiguous_seqs() {
        let (dir, request, _) = fixture("panic");
        let (tx, rx) = std::sync::mpsc::channel();
        let host = RunHost::new(
            dir.clone(),
            Arc::new(move |_, seq, event| {
                let _ = tx.send((seq, event.clone()));
            }),
        );
        let runs = dir.join("runs");
        host.start_with(request, runs.clone(), StreamThenPanic).unwrap();
        settled(&host).await;
        // The handle is released by the lease during unwinding; the host's
        // backstop lands after the stream log's window has passed.
        tokio::time::sleep(stream_log::WINDOW * 4).await;
        let lines: Vec<serde_json::Value> =
            std::fs::read_to_string(transcript_path(&runs, "conversation"))
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
        for (index, line) in lines.iter().enumerate() {
            assert_eq!(line["seq"], index, "every line carries its own index once");
        }
        let terminal: Vec<&serde_json::Value> = lines
            .iter()
            .filter(|line| line["event"]["type"] == "run_error")
            .collect();
        assert_eq!(terminal.len(), 1, "exactly one terminal event: {lines:?}");
        assert_eq!(terminal[0]["event"]["error"]["code"], error_code::RUN_HOST_FAILED);
        assert_eq!(
            lines.last().map(|l| l["event"]["type"].as_str()),
            Some(Some("run_error")),
            "the Transcript ends on the terminal line, after the streamed tail"
        );
        let broadcast: Vec<u64> = rx.try_iter().map(|(seq, _)| seq).collect();
        assert!(broadcast.contains(&(lines.len() as u64 - 1)), "the backstop was broadcast");
        assert!(host.statuses().is_empty(), "the lease released the handle");
        assert_eq!(
            read_summary(&runs, "conversation").unwrap().status,
            "error"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_or_non_subscription_runs_are_rejected_before_spawn() {
        let (dir, mut request, _) = fixture("validation");
        let host = RunHost::new(dir.clone(), Arc::new(|_, _, _| {}));
        request.run_id = Some("../outside".into());
        assert!(host.start(request.clone(), dir.join("runs")).is_err());
        request.run_id = Some("valid".into());
        request.provider = "openai".into();
        assert!(host.start(request, dir.join("runs")).is_err());
        assert!(host.statuses().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
