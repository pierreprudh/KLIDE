# Foundations

Foundations carry the current state of an initiative across related
Conversations. They hold working decisions, open questions, and next steps.
Project Memory holds reviewed lessons for future work throughout the Workspace.

## User flow

Foundations appears beside a conversation only when it is linked to an active foundation. It starts as an icon and opens a preview only when clicked. Unlinked conversations have no Foundations card; setup is always available in Memory.

1. Open the **Foundations** icon on the right of a conversation for a compact summary, then choose **Manage in Memory**. The full editor is in **Memory → Foundations**, also accessible directly from the sidebar.
2. Name a note set and choose **Create set**.
3. Write the notes, or use an answer's **Add to Foundations** action to stage
   its text. Edit the draft, then **Save notes**.
4. In the **Conversations** tab, select other conversations in the Workspace.
   Provider selection does not affect membership. A conversation can belong to
   one set at a time; linking it to another set moves it.
5. Saved changes reach linked conversations on their next turn. Active Runs
   continue with the version they already received.
6. To preserve a lasting lesson, enter its title and text in the **Project Memory** tab, then **Review lesson**. The review
   editor opens on that draft. Edit, keep, or dismiss it using the existing
   Memory controls. The notes remain available independently of the lesson.
7. Archive a completed set to stop supplying its notes without losing them.
   Restore it to resume sharing, or delete it and its links explicitly.

Updates are user-controlled in this version. Agents do not silently publish
notes or promote lessons. Adding an answer stages a draft; it does not save
the answer automatically. Link lists include locally stored Conversations in
the Workspace and existing members of the selected set.

## Execution and provider behavior

The Harness reads the latest saved note set before each turn. A changed
snapshot enters the append-only Transcript through `context_injected`, before
the user's message. Native API and local providers receive this context through
the same message assembly as subscription/delegate providers. Resumed delegates
receive changed system context through the existing instruction-refresh path.
The provider/model is not part of note identity.

Notes are JSON-quoted and labeled working context rather than instructions or
reviewed knowledge. Unlinking, archiving, or deleting supplies an explicit null
snapshot so earlier notes are no longer authoritative. Historical snapshots
remain in the Transcript; clearing is not erasure of already supplied context.
Compaction restores the turn's current snapshot when it is no longer present.

In interactive CLI sessions, ordinary messages submitted through Klide's
composer include the current notes as one bracketed paste. Direct typing into
the terminal and CLI slash commands keep their original behavior. Custom CLIs
must accept bracketed paste, as with Klide's existing diff-comment flow.

## Storage and review

Rust owns `.klide/shared-notes/state.json`, including note sets, membership, and
a revision. Writes use an OS file lock and atomic replacement; stale revisions
are refused. The editor retains the user's draft and offers **Reload** and a
saved-version comparison after a conflict. Linked worktrees resolve the store
through the main checkout, like Project Memory.

The store is local/private by default and is ignored by this repository. A set
has a 12,000-byte note limit and a 160-byte title limit. The store allows 100
sets, 200 conversations per set, and up to 2 MB total. Archiving retains a set
and therefore does not free its storage allowance.

Promotion creates an operator-selected Memory draft using the existing inbox.
It records the note set and update time as its source and preserves the source
notes in the draft's review details. Foundations establish where a lesson came
from; they are not independent proof. Include supporting file paths or test
results when extracting a lesson, and verify it during review.

## Verification

`cargo test --manifest-path src-tauri/Cargo.toml --lib shared_notes` covers
durability, Workspace/worktree scope, single-set membership, conflicts, context
clearing, terminal prompt behavior, and Harness continuation across native and
delegate providers, including compaction. `src/sharedNotes.test.ts` covers
membership and lesson extraction. `preview/shared-notes.html` provides a
browser interaction fixture with in-memory IPC and no Workspace writes.
