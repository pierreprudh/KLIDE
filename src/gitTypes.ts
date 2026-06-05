// Shared types for Git status payloads exchanged with the Rust backend.
// Lives outside any one component so the App, GitReview, Sidebar, and
// StatusBar can all share the same definition.

export type GitFile = {
  path: string;
  status: string;
  staged: boolean;
};

export type GitStatus = {
  branch: string;
  files: GitFile[];
};
