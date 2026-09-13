# Rehaul of handoff generation — agent-driven, template-based, with document-file tracking

**Status:** planned — design resolved 2026-09-13 ([design doc](../design/2026-09-13-template-unification.md), decisions D1–D6)

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

### Resolution (2026-09-13 design pass — [design doc](../design/2026-09-13-template-unification.md))

- **Template location/versioning (D1):** stays a code constant in
  `domain/handoff-template.ts`, now versioned
  (`HANDOFF_TEMPLATE_VERSION = 2`); no config key, no runtime file. Skill
  mirror drift closes mechanically — a smoke check asserts the skill's fenced
  contract block byte-equals the rendered constant.
- **Validation contract (D2):** the template is the *generation* contract
  only; validation stays `findNextTaskContent`-only, byte-identical,
  version-independent — `## Next Task` remains the sole hard gate, so template
  evolution never invalidates old docs.
- **v2 shape (D3–D5):** adds `## Document Files` (between Git State and
  Active Tasks) + a machine-stamped provenance header (never model-authored).
  "Document file" = `.md/.txt/.rst/.adoc` minus a path denylist (incl. the
  handoff data dir). Sources: git status with `--untracked-files=all`
  (primary — same exec count, catches subagent/manual writes incl. new
  untracked dirs) ∪ session write/edit tool-log scan; provenance is
  `in-session` vs `git-only` (created/edited is unknowable).
- **Which surface (D6):** both existing surfaces, no new one — detached LLM
  (gatherer supplies the file list into the payload) and warm skill agent
  (computes the list itself per updated skill). The bedrock fix gates
  work-profile *validation* of the detached path, not landing this.
