# Foundations

Foundations carry the current state of an initiative across related
Conversations. They hold working decisions, open questions, and next steps.
Project Memory holds reviewed lessons for future work throughout the Workspace.

## User flow

Foundations appears beside a conversation only when it is linked to an active foundation. It starts as an icon and opens a preview only when clicked. Unlinked conversations have no Foundations card; setup is always available in **Library → Foundations**.

1. Open **Library → Foundations** from the sidebar, or use the linked conversation's Foundations control to open its summary and full editor.
2. Choose **New foundation**, give it a name, and choose **Create foundation**.
3. Edit the working notes, then choose **Save**. An answer's **Add to Foundations** action stages text; choose **Add to notes** in the editor and save to keep it.
4. Use the **Conversations** section to link other conversations in the Workspace. Save or discard pending edits before changing membership. Provider selection does not affect membership; a conversation belongs to one foundation at a time.
5. Saved changes reach linked conversations on their next turn. Active Runs continue with the version they already received.
6. For a lasting lesson, select a passage in the notes and choose **propose it for Project Memory** under **Lasting lesson**. Enter the lesson and choose **Review in Memory**; edit, keep or dismiss the draft in Library's Memory tab.
7. Archive a completed foundation to stop supplying its notes without losing them. Restore it to resume sharing, or delete it and its links explicitly.

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
