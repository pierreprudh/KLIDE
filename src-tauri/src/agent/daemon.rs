//! Runs owned by ptyd rather than the GUI. The existing Harness remains the
//! sole transcript writer, including while no window is connected.
use super::*;
use crate::coordination_bridge::{BridgeHooks, BridgeSession, CoordinationBridgeState};
use crate::pty_wire::ChatControl;

type OperationReply = tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>;
type OperationSink = Arc<dyn Fn(crate::pty_wire::ChatOperation) + Send + Sync>;

type EventSink = Arc<dyn Fn(&str, u64, &AgentEvent) + Send + Sync>;

pub(crate) struct RunHost {
    state: AgentSupervisorState,
    starts: Mutex<HashMap<String, u64>>,
    store: CoordinationStoreState,
    bridge: CoordinationBridgeState,
    data_dir: PathBuf,
    sink: EventSink,
    operations: Mutex<HashMap<String, (crate::pty_wire::ChatOperation, OperationReply)>>,
    operation_sink: Mutex<Option<OperationSink>>,
}

impl RunHost {
    pub fn new(data_dir: PathBuf, sink: EventSink) -> Arc<Self> {
        Arc::new(Self {
            state: AgentSupervisorState::default(),
            starts: Mutex::new(HashMap::new()),
            store: CoordinationStoreState::default(),
            bridge: CoordinationBridgeState::default(),
            data_dir,
            sink,
            operations: Mutex::new(HashMap::new()),
            operation_sink: Mutex::new(None),
        })
    }

    pub fn set_operation_sink(&self, sink: OperationSink) {
        *self.operation_sink.lock().unwrap() = Some(sink);
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

    pub fn statuses(&self) -> HashMap<String, String> {
        self.state
            .runs
            .lock()
            .unwrap()
            .iter()
            .map(|(id, h)| (id.clone(), run_status_wire(&h.status).into()))
            .collect()
    }

    pub fn status(&self, id: &str) -> (Option<String>, u64) {
        let runs = self.state.runs.lock().unwrap();
        let status = runs.get(id).map(|h| run_status_wire(&h.status).to_string());
        let from = self.starts.lock().unwrap().get(id).copied().unwrap_or(0);
        (status, from)
    }

    pub fn control(&self, id: &str, control: ChatControl) -> Result<bool, String> {
        let runs = self
            .state
            .runs
            .lock()
            .map_err(|_| "Agent state unavailable")?;
        let h = runs
            .get(id)
            .ok_or_else(|| format!("No known run with id {id}"))?;
        let (sender, answer) = match control {
            ChatControl::Stop => {
                h.cancel.cancel();
                return Ok(false);
            }
            ChatControl::CommandPolicy { auto_approve } => {
                return permission::apply_command_policy(h, auto_approve)
            }
            ChatControl::Permission { decision } => (&h.pending_permission, decision.to_string()),
            ChatControl::Diff { decision } => (&h.pending_diff, decision.to_string()),
            ChatControl::Question { answer } => (&h.pending_question, answer),
        };
        sender
            .lock()
            .unwrap()
            .take()
            .ok_or("No pending request for this run")?
            .send(answer)
            .map_err(|_| "Run stopped before the answer arrived")?;
        Ok(true)
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
        if !super::remote::eligible(&request) {
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
        if let Some(reason) =
            self.state
                .failure_budget
                .check(&id, &request.provider, &request.model, now_ms())
        {
            return Err(reason);
        }
        let cancel = CancellationToken::new();
        let from;
        {
            let mut runs = self
                .state
                .runs
                .lock()
                .map_err(|_| "Agent state unavailable")?;
            if runs.contains_key(&id) {
                return Err(format!("A run is already active for this conversation ({id}). Wait for it to finish or stop it first."));
            }
            // Read under the admission lock: a previous turn cannot retire
            // between counting its transcript and claiming this conversation.
            from = if transcript_path(&runs_dir, &id).exists() {
                read_events(&runs_dir, &id)?.len() as u64
            } else {
                0
            };
            self.starts.lock().unwrap().insert(id.clone(), from);
            runs.insert(
                id.clone(),
                AgentRunHandle {
                    status: AgentRunStatus::Running,
                    cancel: cancel.clone(),
                    coordination_workspace_root: request.workspace_root.clone(),
                    coordination_is_terminal_run: false,
                    pending_diff: Mutex::new(None),
                    pending_question: Mutex::new(None),
                    pending_permission: Mutex::new(None),
                    trust: permission::TrustMemory::default(),
                    subject: permission::GateSubject::from_request(&request),
                    out_of_band: Mutex::new(None),
                },
            );
        }
        self.ensure_bridge();
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            // RunLease retires the handle on success, error, and panic. Dropping
            // a UI/socket observer never drops this task or its cancellation token.
            let result = tauri::async_runtime::spawn(run_agent_loop(
                host.clone(),
                runs_dir.clone(),
                id.clone(),
                request,
                Channel::new(|_| Ok(())),
                cancel,
                caller,
            ))
            .await
            .unwrap_or_else(|_| Err("Background run panicked".into()));
            if let Err(message) = result {
                let seq = read_events(&runs_dir, &id)
                    .map(|events| events.len() as u64)
                    .unwrap_or(0);
                let event = AgentEvent::RunError {
                    run_id: id.clone(),
                    error: AgentError {
                        code: "background_run_failed".into(),
                        message,
                        detail: None,
                        retryable: true,
                    },
                    ts: now_ms(),
                };
                let _ = append_event(&runs_dir, &id, seq, &event);
                host.broadcast(&id, seq, &event);
            }
            let mut runs = host.state.runs.lock().unwrap();
            host.starts.lock().unwrap().remove(&id);
            runs.remove(&id);
        });
        Ok(from)
    }

    fn ensure_bridge(self: &Arc<Self>) {
        let live = Arc::downgrade(self);
        let operations = live.clone();
        let permissions = live.clone();
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
                permission: Some(Box::new(move |session, ask| {
                    let host = permissions.upgrade().ok_or("Background host stopped")?;
                    super::permission_relay::answer(&*host, &session.run_id, &session.workspace_root, ask)
                })),
                on_change: Box::new(|_, _| {}),
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
            let mut runs = self.state.runs.lock().unwrap();
            let Some(h) = runs.get_mut(id) else { return };
            h.status = status;
            h.coordination_workspace_root.clone()
        };
        if let Some(root) = root {
            let _ = self.coordination_apply(
                &root,
                CoordinationCommand::SetRunState {
                    actor: CoordinationActor::Run { run_id: id.into() },
                    run_id: id.into(),
                    state: coordination_state_for_status(status, false),
                    reason: Some(run_status_wire(&status).into()),
                },
            );
        }
    }
    fn with_handle(&self, id: &str, f: &mut dyn FnMut(&AgentRunHandle)) -> bool {
        let runs = self.state.runs.lock().unwrap();
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
    fn broadcast(&self, id: &str, seq: u64, event: &AgentEvent) {
        (self.sink)(id, seq, event);
    }
    fn retire_run(&self, id: &str) {
        self.operations
            .lock()
            .unwrap()
            .retain(|_, (op, _)| op.run_id != id);
        // The outer task releases admission after error/panic reporting too.
    }
    fn orchestrate(
        &self,
        root: String,
        actor: String,
        request: crate::missions::orchestration::Request,
    ) -> tokio::sync::oneshot::Receiver<Result<serde_json::Value, String>> {
        self.queue_operation(root, actor, request)
    }
    fn note_terminal(&self, id: &str, provider: &str, model: &str, failed: bool) {
        if failed {
            self.state
                .failure_budget
                .record_failure(id, provider, model, now_ms());
        } else {
            self.state.failure_budget.record_success(id);
        }
    }
    fn coordination_apply(
        &self,
        root: &str,
        command: CoordinationCommand,
    ) -> Result<CoordinationCommandOutcome, String> {
        off_the_worker(|| {
            crate::coordination::apply_coordination_command(&self.store, root, command)
        })
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
