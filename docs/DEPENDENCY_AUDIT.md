# Dependency audit

CI blocks high and critical npm advisories through `npm run audit`.

Temporary exception reviewed 2026-11-18: [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
affects picomatch through 4.0.7; the advisory currently lists no patched release.
It is used by the Vite/Vitest development toolchain. Untrusted repeated-extglob
patterns can block the Node event loop. Keep development servers on trusted
interfaces and do not feed them untrusted glob patterns.

The exception covers only that exact advisory and its dependency chain when
all affected lockfile entries are development-only. A production dependency,
new advisory, critical severity, missing lock entry or invalid audit response
still blocks CI. Moderate findings retain the previous audit threshold.
`npm run test:audit` verifies these boundaries.

Remove the exception as soon as a patched compatible picomatch release is
available. This does not declare the dependency vulnerability fixed.
