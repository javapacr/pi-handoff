# Rehaul of handoff generation — agent-driven, template-based, with document-file tracking

**Status:** open, needs planning (2026-09-13, owner direction)

Owner direction: change *how* the handoff document is produced. Ask the
agent to go through the session and generate the handoff against a defined
**handoff template**, and the handoff must **track all document (non-code)
files created/edited in the session** that could be important to the new
session.

### Two deltas vs today

1. **Template-driven generation.** The doc's shape becomes an explicit,
   versioned template (sections fixed, content filled per session) rather
   than free-form generator output. Feeds directly into
   [unified-template-continue-linkage.md](unified-template-continue-linkage.md),
   which makes the same template the contract for *all* handoff styles.
2. **Document-file tracking.** The handoff lists document files (docs,
   plans, backlog items, notes — not code) created or edited during the
   session, so the new session knows which files to read before
   continuing. Code files stay out: git context (`git-client.ts`) already
   carries working-tree state.

### Candidate sources for the file list (decide at planning)

- Session tool-call log — `write`/`edit` paths, filtered to a document
  extension allowlist (`.md`, `.txt`, …).
- Git status per repo — modified/untracked doc files (catches edits made
  outside the session's own tool calls, e.g. by subagents).
- Dedupe + provenance (created vs edited).

### Open questions

- Where the template lives and how it versions (repo file, config key, or
  embedded in the skill) — and whether the template doubles as the
  validation contract `/continue` and the `continue` tool already enforce
  (`## Next Task` is load-bearing).
- Definition of "document file": extension allowlist vs path allowlist vs
  git-diff classification.
- Which surface runs the agent pass — the detached generator prompt
  ([bedrock-validation-error.md](bedrock-validation-error.md) fixes that
  path first) or a turn injected into the live session.
