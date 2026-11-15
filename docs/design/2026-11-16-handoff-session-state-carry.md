# Design — handoff carries the session state (keep / route), no closing Phase Adherence

**Date:** 2026-11-16 · **Issue:** javapacr/pi-handoff #7 (epic #6) · **Story:** W1
**Status:** IMPLEMENTED in the W1 branch (not yet merged).
**Pinned upstream:** pi-session-states `515187b` (`515187bc0608f9d1f1c92bd90cb2e6865df4cb7e`, the installed copy live sessions load).

A handoff with no goal resumes the new session in the old session's session state, with its done checklist marks and evidence carried over. A goal, `--route`, or a different `nextState` routes through classify instead. The new session's first message states what pi-handoff seeded. The closing canonical `## Phase Adherence` is gone.

## Decisions

- **D1 Keep mechanism.** Seed entries inside `ctx.newSession({ setup })` through `sm.appendCustomEntry`: one `transition {who:"flag", from:null, to}` plus the current state's `check` entries. This works because pi runs `setup` before `session_start` fires in the new session (E1, E2).
- **D2 Decision.** No goal → keep. A goal or an explicit next state → route via classify. Overrides work both ways.
- **D3 Carried.** Done marks and their evidence carry. Nudge and window entries do not.
- **D4 Own state only.** Only the session's own current state is seeded. Seeding another would bypass `next` allow-lists and classify's checkout checks.
- **D5 Modes.** `off` carries (seed `off`); `dormant` and `unset` seed nothing.
- **D6 Override surface.** `/handoff --keep-state <goal>`, `/handoff --route`; the `continue` tool takes an optional `nextState` (absent or equal to the current state → keep; another name → route).
- **D7 Stamp.** The model authors `## Session State`; the extension stamps one machine line of what was seeded under the provenance line.
- **D9 Phase Adherence.** The canonical section is no longer appended. A legacy trailing `## Phase Adherence` is still stripped.
- **D11 One pure module.** The v1 replay, the keep/route decision and the stamp text live in `domain/session-state-carry.ts` (no imports). `createHandoffSession` only appends a seed it is given and decides nothing. The detached payload later reuses the module.
- **D12 Module surface.** `replaySessionStates`, `parseHandoffArgs`, `planCarry`, `SESSION_STATES_PREFIX`, `SESSION_STATES_EVENT_VERSION`.
- **D13 Counted entries.** `type === "custom"` and a `customType` starting `session-states:`. `custom_message` entries (`entered`, `reminder`, `snapshot`) are ignored. One drifted counted entry (`data` not an object, `v ≠ 1`, kind outside the six, `data.kind` ≠ customType suffix, a transition without a string `to`, a check without string `state`/`id`/`evidence`, a malformed `who`) refuses the whole replay.
- **D14 Decision rule.** `/handoff`: `override ?? (goal ? "route" : "keep")`. `continue`: keep when `nextState` is blank or equals the replayed current state; otherwise route with `routeTo = nextState`. No state-list check — pi-handoff loads no state config. Generic `/continue <text>` builds no plan.
- **D15 Plan rules (mode first).** absent → no seed, no stamp. drift → `not carried — unrecognized schema`. off → seed `off`, `kept off`. dormant/unset → `not carried — dormant|unset`. active + keep → transition then one check per mark, `kept <state> (<n> marks carried)`. active + route → nothing, `not carried — route` or `— route to <name>`.
- **D16 Seeding schema.** See below.
- **D17 Live message.** `provenance\nstamp\n\ndocument` with a stamp, else `provenance\n\ndocument`. The `handoff-origin` audit `details.document` stays `provenance\n\ndocument`.
- **D18 Flags.** Leading exact `--keep-state` / `--route` tokens only; both → refused with a notify naming the conflict, nothing launched; the rest is the goal verbatim.
- **D19 `nextState` validation.** A present but non-blank-string `nextState` is an `isError` repair result; nothing is staged.
- **D20 Fixture.** `test/fixtures/session-states-v1.json` is written only by `scripts/capture-session-states-fixture.mjs`, a `.mjs` that loads upstream `src/state.ts` by a computed `import()` path and records the upstream rev. Upstream never becomes a runtime or dev import.
- **D23 `who` on check.** Replay accepts a check whose `who` is absent or one of `flag`/`agent`/`user`; any other present value is drift. Seeded checks preserve the effective check's `who` and omit the key when it was absent, so `isOwnMark` answers the same for every seeded check as for the old session's effective check.
- **D24 Fixture shape.** `{upstreamRev, regenerate, scenarios: {<name>: {branch, replayed, expectedSeed?, seedReplayed?, ownMarkIdsBranch?, ownMarkIdsSeed?}}}`; seed entries are `{customType, data}` (upstream `toDraft` minus `type`).

## Seeding schema

Each seed entry is the `(customType, data)` pair `sm.appendCustomEntry` takes; key order matches upstream `toDraft`:

```
session-states:transition  {v:1, kind:"transition", who:"flag", from:null, to}
session-states:check       {v:1, kind:"check", state, id, evidence}            // effective check had no who
session-states:check       {v:1, kind:"check", state, id, evidence, who}       // effective check had who
session-states:off         {v:1, kind:"off"}
```

Checks follow `Object.entries(marks)` order (first-insertion order, latest evidence wins).

## Decision table

| Launch | Outcome |
| --- | --- |
| `/handoff` (no goal) | keep |
| `/handoff <goal>` | route |
| `/handoff --keep-state <goal>` | keep |
| `/handoff --route` | route (next task inferred as for a no-goal handoff) |
| `continue` tool, `nextState` absent or = current | keep |
| `continue` tool, `nextState` names another state | route |
| `/continue <text>` / `/continue <path>` (no handoff staged) | seed nothing, no stamp |
| any route | seeds nothing; the new session enters classify |

Mode rules apply first: `off` carries in both keep and route (routing only applies when the mode is active); `dormant`/`unset` seed nothing.

## Notes

- **Stricter than upstream.** Upstream's replay skips a drifted entry; pi-handoff refuses to seed the whole session. A visible `not carried — unrecognized schema` fallback beats a false "kept". It also treats a malformed `who` as drift where upstream ignores it, because pi-handoff can neither copy it nor drop it without flipping `isOwnMark`.
- **E2 is load-bearing.** The whole mechanism rests on pi running `setup` before `session_start` in the new session, so upstream's replay sees the seed. Re-run the live keep check after each pi upgrade (see the story's manual check): a new session must show `⟳ <state> k/n` with the same `k`.
- **Template version stays 2.** Removing Phase Adherence changes the template's section set while `HANDOFF_TEMPLATE_VERSION` stays 2 — an exception to [2026-09-13-template-unification.md](2026-09-13-template-unification.md)'s "bumps on any section-set change", taken because no code parses the version and W2 bumps it to 3.
- **Stamp reports seeding, not effect (Q3).** `kept build` means pi-handoff seeded it; whether pi-session-states accepts it is upstream's call.

## Regenerate the fixture

```
npx tsx scripts/capture-session-states-fixture.mjs ~/.pi/agent/git/github.com/javapacr/pi-session-states
```

Run it against the installed copy (read-only). The recorded `upstreamRev` must be `515187b…`; the script warns on stderr otherwise. After an upstream bump, regenerate, review the diff, and update the pin in the script.
