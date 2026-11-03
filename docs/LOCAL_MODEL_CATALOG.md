# Local model recommendations

Settings → Local AI → Llama includes an opt-in, read-only browser for the
[Local AI registry](https://github.com/sybil-solutions/local-ai-registry).
The existing four managed llama.cpp models remain the installable selection.

Opening the browser downloads `dist/catalog.json` at the reviewed revision in
`src-tauri/src/local_model_catalog.rs`. It does not download weights or run
commands. Catalog failure leaves managed setup available; Retry fetches again.
The adapter accepts catalog schema 4, limits downloads to 12 MiB, and projects
up to three published picks per hardware entry. Withdrawn, archived and captured
proofs are excluded. Legacy and related-hardware proofs have distinct labels.

The detected computer is always shown and selected, even when the catalog has
no tested configuration for it. Chip names and memory must match exactly before
that computer shows upstream recipes. A missing entry is explained separately
from failed detection or unknown memory. The user can also select catalog
hardware explicitly, including a different machine's GPU. This is hardware
matching, not a free-memory or performance guarantee.
Unknown measurements stay unknown. Each card links to its recipe at the same
commit, with upstream requirements and evidence. Nothing is labelled verified
in Klide: full agent acceptance requires separate evidence.

To update the registry pin, review schema and launch changes, update the revision,
run the adapter tests, then check the browser against that catalog. Recipe launch
commands are deliberately not interpreted or executed by this adapter.

An opt-in smoke test reads the pinned public catalog without loading any model:

```sh
cargo test --manifest-path src-tauri/Cargo.toml pinned_upstream_catalog_is_readable -- --ignored --nocapture
```
