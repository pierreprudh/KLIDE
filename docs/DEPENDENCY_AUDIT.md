# Dependency audit

CI blocks high and critical npm advisories through `npm run audit`, in
production and development dependencies alike. Moderate findings do not block.
An invalid audit response fails closed. `npm run test:audit` verifies these
boundaries.

There are no exceptions. The dev-only picomatch exception (GHSA-fc5q-39xc-vjpf,
added 2026-11-18) was removed on 2026-11-24 after GitHub withdrew the advisory.
