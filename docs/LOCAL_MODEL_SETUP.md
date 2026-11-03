# Managed local model setup

The llama.cpp settings surface reports checking, engine installation, model
download/verification and loading/readiness separately. Klide model downloads
include byte counts; unknown totals remain unknown. Other GGUF models download
inside llama.cpp and show the loading stage without invented percentages.

Rust admits one setup per provider, including engine-only installation. Opening
another settings panel observes that same setup. Duplicate starts and model
changes during setup are rejected. Failures leave a retryable state with the
original error; an interrupted command releases admission. Progress is local to
the app process. After restart, readiness is probed again rather than restoring
a misleading in-progress job. Installed artifacts retain their existing caches.

A remembered process is not sufficient to report readiness: dead processes are
reaped before retry, and an unhealthy live managed process must be stopped before
restarting. A process that fails before readiness is killed and reaped on every
exit path. Stop affects only Klide-owned processes. Setup itself is not cancellable
from this first UI slice; Stop is available after setup completes.

Readiness and process ownership are reported separately. An unhealthy owned
server still offers Stop, so the user can recover without leaving settings.
Start, Stop and model selection use the same admission lease; Start refuses
if the caller's chosen model changed in another panel. Blocking selection and
runtime extraction retain their locks until their filesystem work completes.

Existing download checks remain in force: official runtime archives require a
SHA-256 match, and the Klide GGUF is published only after its pinned digest matches.
Other curated models continue to use llama.cpp's own Hugging Face downloader.
