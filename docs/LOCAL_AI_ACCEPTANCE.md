# Test the local AI improvements

Run from the updated checkout. The four changes are PRs
[#411](https://github.com/pierreprudh/KLIDE/pull/411) (catalog),
[#412](https://github.com/pierreprudh/KLIDE/pull/412) (setup),
[#413](https://github.com/pierreprudh/KLIDE/pull/413) (connections), and
[#414](https://github.com/pierreprudh/KLIDE/pull/414) (verification).

## Automated checks

```sh
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
python3 -m unittest discover -s scripts/harness-bench -p 'test_*.py'
```

These use fixtures, not paid inference. Socket/process tests need a normal host
environment. An optional public-network test downloads only catalog metadata:

```sh
cargo test --manifest-path src-tauri/Cargo.toml pinned_upstream_catalog_is_readable -- --ignored --nocapture
```

## In the app

Start the app with `npm run tauri dev`.

| Feature | Action | Expected result |
| --- | --- | --- |
| Catalog | Settings → Local AI → Llama → Browse model catalog | The detected computer is selected, even without a catalog entry. Exact chip/memory matches show recipes; missing entries are explained. Other hardware can be explored separately. |
| Evidence | Open a configuration's evidence link | The recipe opens at the pinned revision. Unknown measurements show “—”; upstream evidence does not claim Klide verification. |
| Catalog failure | Load the catalog offline, then reconnect and Retry | Retry works and managed setup stays available. Use a fresh app session if the catalog was already loaded. |
| Setup | Choose a small model that fits, then Set up & start | Engine installation, download and readiness are distinct stages. Klide's own GGUF shows byte counts; other models show loading without invented percentages. |
| Recovery | Stop and Start the managed server | Stop reaps the owned process. An owned but unhealthy server still offers Stop. |
| Selection | Stop, choose another model, then Start | The chosen model runs. Other panels cannot change it during setup; stale Start requests are rejected. |
| External server | Press Stop for a server started outside Klide | Klide leaves the external process running and explains where to stop it. |
| Saved state | Reopen settings or restart Klide | The chosen model persists; readiness is checked again. |
| Self-hosted | Settings → API → Self-hosted endpoints → Add endpoint | Enter the API base URL and optional token reference, then Test connection. Testing does not save the endpoint or start generation. |
| Discovery | Select a reported chat model and save | The endpoint/default appears as an intelligence source without changing the agent. Known embedding/OCR models are excluded. |
| Connection failure | Try an unused port, wrong base path or invalid token | The appropriate error appears. Changing the address/token clears the old success. |

First-time setup downloads weights; check the size on the card. Do not delete
existing models or caches just to test a first download. For a connection test
without a VPS, add an already-running llama.cpp server at
`http://127.0.0.1:8081/v1`. For remote servers use HTTPS, a private address or an
existing SSH tunnel; see [connection setup](SELF_HOSTED_INFERENCE.md).

## A real model through Klide

Start the model yourself and use its exact served ID. Preview makes no model
calls:

```sh
python3 scripts/harness-bench/run.py --harness native \
  --provider 'custom:my-vps' --model '<served-model-id>' \
  --task order-summary --repeats 1
```

Use your saved endpoint ID, or provider `ollama` for a local Ollama model.
Credentials must resolve from the process environment or `~/.klide/.env`;
disposable workspaces do not inherit your usual Workspace's `.env`.

Execute by adding `--run` and a fresh output directory:

```sh
python3 scripts/harness-bench/run.py --harness native \
  --provider 'custom:my-vps' --model '<served-model-id>' \
  --task order-summary --repeats 1 --run \
  --output /private/tmp/klide-model-smoke
```

This uses the real native Harness with edits/commands pre-approved in a disposable
workspace; paid endpoints may incur charges. Inspect `REPORT.md`, `report.json`,
`results.json` and the trial transcript. The independently graded file must pass;
the agent's claim is insufficient. Nonzero exit means the suite did not pass.
A failed coding task is not necessarily a connection failure.

For broader coverage, remove `--task`, use `--suite all --repeats 3`, and choose
another output directory. Unknown measurements remain unknown; fresh workspaces
do not clear server caches. Passing this suite does not establish full desktop
acceptance or automatically mark a model verified.

## Evidence status

PR review exercised automated suites, the endpoint's local HTTP fixture and the
pinned public catalog. First-download UI, real VPS inference and live model
quality remain manual acceptance checks.
