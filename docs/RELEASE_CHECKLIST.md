# Next release: acceptance checklist

Release candidate preparation; no release tag or bundle is published by this
checklist. The package version remains 0.6.11 until acceptance is complete.

## Automated gate

- Require green PR CI: dependency audits, frontend tests/build, macOS Rust tests,
  Linux tests and Windows compilation. Review informational audit warnings
  separately; do not suppress a vulnerability to make the gate pass.
- Run `npm run verify:distribution` on the built Mac bundle and record its
  source commit, build identity and resulting artifact hash.

## Desktop pass on the Mac

Use a throwaway repository. Record the build hash, provider/model, expected
result, actual result and any failure for each check.

1. Open a new folder and decline trust: no project opens. Open it again and
   approve; reopen the same path without a new prompt. Try a klide://project
   link to a different folder and decline; it must not switch projects.
2. Import a discovered connector: it remains disabled. Enable it explicitly.
   A server-labelled read must ask before first use; deny and verify the
   server receives no call. Approve a different call once, then test the Run
   and Workspace scopes separately. Full auto must not skip this gate.
3. On macOS, with command containment on, test a full-auto command that reads
   a throwaway .env canary and another that writes outside the project. Both
   must be denied. Repeat the secret read with sandbox network enabled: it
   must still be denied. Explicitly approved commands remain outside the
   sandbox; use dummy values only.
4. Verify Library's Memory/Skills/Foundations navigation, linked notes on the
   next turn, and a declined memory proposal staying out of recall.
5. Create a one-off local schedule, close/reopen Klide, inspect its outcome;
   test an approval waiting while closed and an explicit Stop after reopening.
6. Open Design mode on a local dev server. Preview a change and comment, send
   the review, inspect the normal diff, and confirm page previews alone do not
   save files. Check layout at 900 and 390 widths.
7. Run a worker through setup, checkCommand, Merge/Discard and Cancel; verify
   no duplicate changes, lost approval or misleading completion.

## Remote work — deferred until laptop access

Keep the existing SSH/tmux path intact. The next native transport work starts
with the rename and authenticated stdio bridge in docs/REMOTE_MACHINES.md.
Use the configured Linux machine and a throwaway checkout; require real
launch/stream, disconnect/replay, reconnect/Stop and remote diff/check evidence
before presenting it as a supported native remote workflow. No host credentials
should be copied to this checkout or bundled into a release.

## Publish gate

Resolve blockers, record scoped acceptance, choose the version and notes, then
build and publish the ad-hoc signed Apple Silicon bundle using the existing
release workflow. Keep the first-launch instructions and platform limitations
accurate. Native remote completion is a separate milestone unless explicitly
included in that release.
