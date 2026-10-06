# AI Editing Rules — Product Studio

Read this file before making any change to any file in this project.

**Rewritten 2026-07-15** to remove contradictory/duplicate packaging specs that had accumulated across iterations. This is now the single source of truth — there is exactly one packaging spec, one tree diagram, one naming convention. If any other document or memory contradicts this file, this file wins.

---

## Project structure

```
index.html            app entry point — layout, tab buttons, script/CSS reference
login.html             standalone login/signup page
styles/                CSS files grouped by app area
scripts/                JavaScript files grouped by feature
assets/                 templates and style-guide reference content
netlify/functions/      Netlify serverless function (production API route)
proxy/                  Render.com Express proxy (separate deployable)
DESIGN_SYSTEM.md       single source of truth for all visual and layout standards
PROJECT_MAP.md         which file owns which function
FILE_MANIFEST.txt      current complete list of all project files
CHANGELOG.md           plain-English change history
AI_EDITING_RULES.md    this file
```

---

## Before making any change

1. Read `PROJECT_MAP.md` to identify the correct file(s). This is the mechanism that makes rule 4 possible — `PROJECT_MAP.md` exists specifically so a request touching one feature area only requires opening the 1-3 files it points to, not the whole codebase.
2. Read `DESIGN_SYSTEM.md` before writing any new CSS or building any new screen — this includes checking it for an existing component pattern before designing anything new; `DESIGN_SYSTEM.md` requires reusing an existing pattern whenever one fits and flagging to the user when none does, rather than inventing a new one-off style.
3. Read `FILE_MANIFEST.txt` to understand the current file inventory — never assume file counts from memory.
4. Inspect only the relevant files. Do not open unrelated files.
5. For JS changes: run a syntax check after every edit (`node --check filename.js`).
6. After completing a change: update `CHANGELOG.md`. If new files were added or file ownership changed, update `PROJECT_MAP.md` and `FILE_MANIFEST.txt`.

---

## MANDATORY PROCESS — diagnose before building

**HARD RULE: Never write a single line of code, run a single command, or modify any file until the user has explicitly approved the build list.**

This rule applies to EVERY change — no matter how small, no matter how obvious the fix. One line. One CSS tweak. One label change. All of it requires approval first.

When the user reports issues or requests changes:
1. Read the relevant files to understand the current state
2. Diagnose the root cause of each issue
3. Present a **Confirmed Build List** — every item listed with: what's wrong, root cause, proposed fix
4. **STOP. Wait for explicit approval.** Do not touch any file.
5. Only begin building after the user says "go ahead", "ok", "approved" or equivalent
6. If the user asks a question or makes a suggestion during the build list review — answer it, update the list if needed, then wait for approval again before building

**Violation examples — all of these are wrong:**
- User asks "did you fix X?" → Claude says "no" then immediately fixes it without approval
- User suggests a label change → Claude agrees then immediately builds it
- User says "fix all" after a summary → Claude builds without presenting a final list first
- User reports a bug → Claude diagnoses it and immediately fixes it without presenting a build list
- User says "confirm and propose a fix" → this is a request for diagnosis, not approval. Confirming a diagnosis is not the same as approving a build.
- Claude judges a fix as "obvious" or "one line" → builds without approval. Simplicity is never an exception.
- Any scenario where code is written before the user has seen and approved a build list

**The hotfix trap:** Bug reports feel urgent. The fix feels obvious. Claude skips the list and builds. This is the most common violation pattern and there are zero exceptions — a one-line hotfix still requires a presented build list and explicit approval before a single character is changed.

This rule exists because Nethaji has flagged this repeatedly. Every violation wastes a test cycle and disrespects his time. There is no exception.

---

## MANDATORY — Design and impact thinking (before any wireframe or build list)

This section applies to all feature design, UX proposals, and build planning.
Violating this is the same category of error as building without approval.

### Step 1 — Read the code before forming opinions
Never describe, assume, or design based on memory of how something works.
Before any wireframe or spec:
- Read the relevant JS function(s) to understand current behaviour
- Check the actual CSS constraints (panel widths, z-index, overflow rules)
- Read the data model fields on the objects involved — don't assume field names or values

### Step 2 — Enumerate all states before designing the happy path
Every UI interaction has multiple states. Identify all of them first:
- All origin variants (e.g. kpi / diagnostic / market / pi)
- Empty states, error states, partially-populated states
- What the UI looks like before the action, during it, and after it
Design must account for all states — not just the one that looks good in a wireframe

### Step 3 — Trace the full journey
For every proposed interaction, answer these questions before proposing anything:
- What triggers this? (user action, system event, data condition)
- What state does the system land in immediately after?
- What does the user see on screen — does it re-render, refresh, close, update in place?
- Is there any other canvas, panel, or data structure affected?
- What happens if the user cancels or partially completes the action?

### Step 4 — Check surface constraints before designing
- Measure available width/height from CSS before building horizontal or grid layouts
- Check if a modal already exists for this context — reuse patterns before inventing new ones
- Check if the proposed UX creates panel-over-panel, modal-over-modal, or scroll-within-scroll
- Verify that the data needed for the design actually exists on the object in state

### Step 5 — Impact analysis across the full codebase
Before finalising a build list, ask:
- Which other canvases read the data this change writes?
- Does changing a field affect any IDs, keys, or Set memberships used elsewhere?
- Does this change require a re-render anywhere outside the primary file?
- Are there demo data implications — will demo mode exercise this new state?

### The standard
Raise all of the above proactively.
Do not wait for the user to identify gaps, missing states, or downstream impacts.
If something was missed and the user catches it — treat it as the same class of process
violation as building without approval. Learn from it, update these rules, move on.

---

## MANDATORY — Pre-build-list stress test

This section governs the diagnosis stage itself — before any Confirmed Build List
is presented for approval. It exists because a build list was presented as
"diagnosis complete" without this step, and stress testing afterward surfaced
two real scope changes (a missed copy location, and a missing rename-cascade
that would have orphaned data) that should have been caught before the list
was first shown to the user.

**Run this for every item before it goes into a Confirmed Build List:**

1. **Cross-reference grep, not memory.** For every proposed fix, grep the
   codebase for every other consumer of the function/string/data field being
   touched — not just the one location the bug report pointed at.
2. **Trace every data field by its full lifecycle, not just its render point.**
   If a fix touches a field that's also read elsewhere (a name used as a
   dictionary key, a string matched against a session snapshot, a flag checked
   by a different render path), confirm whether that other consumer needs an
   equivalent update. Ask explicitly: does this field get cloned/snapshotted
   anywhere, and if so, does this change desync the clone from the source?
3. **Check for an existing pattern before inventing a new one.** If a similar
   problem was already solved elsewhere in the codebase (e.g.
   `stageRenameDownstream()` for stage renames), the new fix must either reuse
   that pattern or explicitly justify why it doesn't apply. Silently omitting
   it is a regression risk, not a simplification.
4. **State confirmed-safe findings, not just confirmed-risk findings.** Report
   what was checked and found to be NOT a problem (e.g. "checked X, no other
   callers, safe"), so the user can trust an absence of a finding was due to
   checking, not skipping.
5. **Present stress-test results as part of the Confirmed Build List itself —
   not as a separate step the user has to ask for.** Every item in the build
   list must show what was cross-checked and what (if anything) the check
   changed about the item's original scope.
6. **This happens before the Confirmed Build List is finalized — not after
   approval, not during build.** If stress testing surfaces a scope change,
   the user reviews the updated list before any code is touched.

---

## MANDATORY — Live-sync event emission for shared sessions (v8.123+)

This applies to ANY code change that modifies session data after a user action and persists that data to the database.

**The rule:**

For every user action that mutates persisted session content visible to collaborators:

**1. Capture session identity BEFORE async work:**
```javascript
var saveSessionId = _activeSessionId;
var wasSharedSession = (typeof _activeSessionIsShared !== 'undefined' && _activeSessionIsShared);
```
Do not read these globals inside `.then()` or later async callbacks — they can change.

**2. Mutate state and render optimistically.**

**3. Persist the mutation via `sessionStoreSave()`:**
```javascript
sessionStoreSave(saveSessionId).then(function(ok) {
  if (!ok) {
    // REVERT state and show error
    // Do NOT emit event
    return;
  }
  // Save succeeded — proceed to next step
}).catch(function(e) {
  // REVERT state and show error
  // Do NOT emit event
});
```

**4. ONLY if save succeeds, emit exactly one live-sync event:**
```javascript
if (wasSharedSession && typeof _lsEmitContentEvent === 'function') {
  try {
    _lsEmitContentEvent(saveSessionId, 'canvas', 'event_type', metricKey || null, capName || null);
  } catch (e) {
    console.warn('Event emission failed (save already succeeded):', e);
    // Failure here does not block the transaction
  }
}
```

**When NOT to emit:**
- If save returns false or rejects — emit nothing
- If state was reverted due to save failure — emit nothing
- For local-only UI state that is not persisted
- For transient/ephemeral data

**Why this ordering:**
- Events are only emitted for content that is durably persisted
- Events are never visible before their content is fetchable
- Teammates always see consistent state (no corrupted broadcasts)
- Missed emission (if event fails) is acceptable; lost data (if emit blocks save) is not

**Important: Stale-write limitation (v9.03+)**

Live-sync emission is NOT a substitute for conflict detection. The baseline `sessionStoreSave()` uses full snapshot writes with no version checking. For shared sessions with concurrent PI/Story Canvas edits, User A's stale local state can overwrite User B's remote changes. This is a pre-existing gap, not introduced by this rule. It must be addressed in a future phase (version-checked saves or stale-session blocking).

**Event type reference:**
Current known types: `pi_plan_generated`, `pi_plan_updated`, `capabilities_generated`, `capability_manually_updated`, `features_generated`, `story_manually_updated`, `feature_stories_manually_updated`, `prototype_generated`, `prototype_manually_updated`. See CHANGELOG for current complete list.

**This is a pre-build-list stress test item:**
Before finalizing any Confirmed Build List that touches session data, explicitly check:
- ✅ Does this change mutate session data? If yes, proceed. If no, skip this section.
- ✅ Is session identity captured BEFORE the async boundary?
- ✅ Does the function snapshot state before mutation and revert on save failure?
- ✅ Is the event wrapped in `if(wasSharedSession && typeof _lsEmitContentEvent === 'function')` guard?
- ✅ Is the event emitted ONLY after `sessionStoreSave()` resolves without error?
- ✅ Is the event type appropriate for this mutation (generation vs manual edit)?
- ✅ Are helper functions (`_lsMarkManualEdit`, `_lsEmitContentEvent`) wrapped in try-catch independently?
- If any check fails, add a new build list item to fix it before presenting the list to the user.

---

## MANDATORY — View-only / permission-gated UI: hidden vs. disabled (v9.08.02+)

This applies to ANY UI element whose action is blocked for some users in some
state (view-only shared sessions, locked fields, read-only modes generally).

**The rule — two categories, one consistent treatment each:**

1. **Standalone action buttons** (Add, Generate, Send to X, Refine, Remove-
   as-a-button, any button whose entire purpose is to trigger an action with
   no other content) → **hidden entirely** at render time. Do not disable
   these — a disabled standalone button invites a "why can't I click this"
   support question, and removing it entirely is also less code than wiring
   a disabled state, tooltip, etc.

2. **Toggles, checkboxes, inline-editable fields, dropdowns, and clickable
   inline links/badges** (anything that's part of a card's normal content,
   not a separate action button) → **disabled**, using the correct native
   attribute for the element type, or a `-disabled` CSS class with
   `pointer-events:none` for custom (non-native) controls. Hiding these
   instead often looks broken — removing a checkbox from a card but leaving
   everything else looks like a rendering bug, not an intentional lock.

**Critical implementation detail — `readonly` does NOT work on checkboxes
or radios.** This attribute only suppresses editing on text-like inputs
(text, textarea, email, etc.). For `<input type="checkbox">` or
`<input type="radio">`, the only attribute that actually prevents
interaction is `disabled`. A `readonly` checkbox will still visually
toggle on click — this exact bug shipped once (Story Canvas's DoR toggle,
found and fixed in v9.08.02) and must not be repeated. When gating any
checkbox/radio/toggle-label pair, use `disabled` on the input itself, not
`readonly`, and verify the fix by actually clicking it, not just reading
the template.

**Second implementation detail — removing `onclick` alone is not sufficient
defense-in-depth for native form controls.** A `<label>`/`<input>` pair, or
any element with browser-native default behavior, can still change its own
visual state on interaction even with no JS handler attached. The disabling
mechanism must be a real HTML attribute (`disabled`, `readonly` where
applicable) or `pointer-events:none` in CSS — not merely the absence of an
`onclick`.

**Static HTML elements (defined directly in `index.html`, not generated by
a JS template function) need their own runtime sync, not a template
conditional.** Several gaps in the original v9.08 build turned out to be
buttons hardcoded into `index.html` (Feature Canvas's "Add Feature",
"Send to Story Canvas", and refine bar were all static markup, not
JS-rendered) — a template-string `${condition?...:''}` has no effect on
markup that was never generated by a template in the first place. For any
static element that needs to be permission-gated, add an `id` to it and
sync its visibility (`style.display`) from whatever function already runs
on the relevant render/tab-enter/panel-open cycle — do not assume a
template fix covers it without confirming the element's actual origin.

**This checklist is now part of the pre-build-list stress test** for any
change touching permission-gated UI — before finalizing a build list,
explicitly check each affected element against:
- ✅ Is this a standalone action button (hide) or a toggle/checkbox/field
  (disable)?
- ✅ For checkboxes/radios specifically — is the fix `disabled`, not
  `readonly`?
- ✅ Is the element static HTML or a JS template? If static, does it have
  an `id` and a runtime sync call, not just a template conditional?
- ✅ Does the underlying handler ALSO have a guard (defense-in-depth), not
  just the visual layer?

---

## MANDATORY — Layout/CSS bugs: measure before modifying (parent-chain first)

This section exists because of a real incident (v7.61, Home tab empty-state centering)
where ~8 CSS variants were tried on `.home-empty-wrap` / `.home-main` before the actual
root cause was found: a sibling element (`.right`, `flex:1`) was competing for space
inside `.app`, capping `#home-tab` at ~679px instead of the full panel width. The child
elements were centering correctly all along — inside a parent that was the wrong size.

**The rule:**

1. If a centering, alignment, or sizing fix does not produce the expected visual change
   after **one** attempt, STOP iterating on the target element's own CSS.
2. Before proposing a second variant, measure the actual rendered dimensions of the full
   parent chain — every ancestor up to the nearest known-good/full-size container — using
   `getBoundingClientRect()` via Playwright against the **real `index.html`** (not an
   isolated repro — repros can hide sibling/competition issues that only exist in the
   full DOM).
3. Compare the broken layout's container chain against a working reference pattern
   elsewhere in the app (e.g. `.right > .app-shell > .out-body > .empty`). Structural
   differences in the chain — extra/missing wrappers, competing `flex:1` siblings,
   inline styles overriding stylesheet rules — are more often the cause than the
   target element's own alignment properties.
4. **`position:absolute; inset:0` producing literally no visible change is a strong
   signal the containing block is not what you think it is** — not a signal to try yet
   another centering approach on the same element.
5. A child element can be correctly centered inside a parent that is itself the wrong
   size. Always verify the parent's box dimensions before concluding the child's CSS
   is wrong.

This applies to any layout bug, not just centering — overflow, clipping, unexpected
width/height, and z-index stacking issues are all parent-chain bugs more often than
target-element bugs.

---

## Build base — which directory to start from

**The `/mnt/project/` files are a frozen snapshot. They are NOT the current codebase. Never use them as a build base if a more recent one exists.**

### Case 1: Same conversation thread, prior build exists
```
Base = the last build directory from this session (e.g. /home/claude/build-629/)
Command: cp -r /home/claude/build-629 /home/claude/build-630
NEVER: cp -r /mnt/project /home/claude/build-630
```
Using `/mnt/project/` as the base when a prior build exists will silently discard all previous fixes.

### Case 2: New conversation thread, no prior build directory in session
```
Base = /mnt/project/ (only option available)
```
Before building, verify state against `CHANGELOG.md` and `config.js`'s `APP_VERSION` — `/mnt/project/` is frequently several versions behind the deployed app. Flag any mismatch to the user before building.

### Permanent fix (user action required)
Update the Claude Project files after each significant build session by uploading the latest JS/CSS files. This makes `/mnt/project/` reflect true current state and eliminates Case 2 regressions.

---

## Pre-build verification checklist (code integrity — run before packaging)

Run ALL of these before constructing the packaging tree or calling `present_files`:

1. All JS files pass `node --check`.
2. **CSS integrity check — MANDATORY:** every CSS file must have balanced `{`/`}` braces. A single truncated CSS file breaks the entire app layout on Netlify.
3. **Proxy URL cross-check:** `PROXY_URL` in `scripts/api.js` must point to the Render proxy (`https://product-diagnostics-proxy.onrender.com/api/anthropic` prod, or the dev equivalent) for hosted deployments — never the Netlify function for any call with `max_tokens` large enough to risk exceeding Netlify's function timeout window.
4. No `style.display` assignments targeting `#mi-tab`, `#dv-tab`, `#sc-tab` content divs — these use `classList.toggle('on')`.
5. No `classList.add/remove('on')` targeting `#tab-mi`, `#tab-dv`, `#tab-la` tab buttons — these use `style.display`.
6. No hardcoded hex colours in CSS files (use token variables from `styles/00-tokens.css`).
7. No duplicate function declarations in any JS file.
8. Every collapse button CSS class includes `color: var(--t3)` — never rely on colour inheritance.
9. Every collapse button SVG is `width="12" height="12"` with `stroke="currentColor"` — never hardcoded hex, never 14×14.
10. **Version string — MANDATORY:** update `APP_VERSION` in `scripts/config.js` to the new version number before every build (see Versioning rules below for the correct format). `index.html` and `login.html` read this automatically — never hardcode version strings in HTML, never edit `hdr-version` spans directly.
11. **CHANGELOG verification — MANDATORY:** confirm the new version entry exists at the top of `CHANGELOG.md` before zipping.

---

## Tab button vs tab content — CRITICAL DISTINCTION

There are TWO different elements per tab with DIFFERENT visibility mechanisms:

| Element | ID pattern | Mechanism |
|---|---|---|
| Tab button | `#tab-mi`, `#tab-dv`, `#tab-la` | `style.display = ''` / `'none'` |
| Tab content div | `#mi-tab`, `#dv-tab`, `#sc-tab` | `classList.add/remove('on')` |

**Before replacing any `style.display` assignment, read the element's ID and confirm which type it is.**

---

## Editing principles

- Prefer targeted surgical edits over broad rewrites.
- Do not rewrite a full file when a str_replace will do.
- Do not rebuild a working screen unless explicitly instructed.
- Do not add unrequested features or scope creep.
- Do not hardcode colour hex values in component CSS — always use the token variables from `styles/00-tokens.css`.
- Do not change the 300px left panel width. Do not change the tab row position (it must be in `.app-shell`, above `.app`).
- The user is non-technical for casual reference purposes but is a 22+ year retail/CPG PM practitioner — infer the correct file from `PROJECT_MAP.md` rather than asking the user to name files; do not over-explain fundamentals.

---

## Adding new features

When adding a new tab, screen, or major feature:

1. New features get **new files** — a new `scripts/feature-name.js` and `styles/NN-feature-name.css`.
2. Minimal changes to existing files — add state variables to `state.js`, add prompts to `prompts.js`, add tab switch logic to `api.js`, add script/CSS references to `index.html`.
3. Follow the naming convention: CSS files are numbered sequentially (`21-`, `22-`, etc.).
4. Update `FILE_MANIFEST.txt` with the new files.
5. Update `PROJECT_MAP.md` with the new file's ownership and routing — in **both** places it's tracked: the file-by-file "File responsibilities" section AND the task-oriented "Common request routing" table. These are two independent indexes into the same functions, organized differently (by file vs. by user-facing task) — updating only one will let them drift out of sync silently, since neither references the other.

---

## Deployment verification rules

**Before every zip delivery, verify these:**

1. **Proxy URL matches `netlify.toml`** — Open `scripts/api.js` and find `PROXY_URL`. Open `netlify.toml` and find the `[[redirects]]` `from` path. They must be consistent with the intended routing. If they don't align, the deployed app will fail on every API call while working perfectly locally.

2. **Render proxy is the correct hosted proxy for large-payload calls** — The Netlify function has a shorter timeout than long-running generations (e.g. KPI/Outcome Map tree generation) can reliably need. Always use the Render proxy for hosted deployments carrying these calls.

3. **Render free-tier cold starts:** Both Render proxy services (`product-diagnostics-proxy.onrender.com` prod, `pgt-proxy-dev.onrender.com` dev) run on Render's free tier and spin down after ~15 minutes of inactivity, adding 50+ seconds to the first request after idle. **The correct fix is a Render tier upgrade (Starter or above), which Nethaji manages on his own timeline. Do not suggest UptimeRobot, cron-ping, or any other keep-alive workaround as a substitute or in place of the upgrade — there is no keep-alive service configured on this project, and none should be proposed.**

4. **Local vs hosted routing** — The app behaves differently locally (`file://`, `localhost`) vs deployed. Any change to `api.js` routing logic must be tested mentally against both paths: (a) local file open, (b) Netlify deployment. Never assume local success = Netlify success.

---

## Versioning rules

**Always read `CHANGELOG.md` and `scripts/config.js`'s `APP_VERSION` to determine the current version before naming any zip.** Never infer the version from memory or prior conversation.

**Format — three-part version string: `vMAJOR.FEATURE.PATCH`**

- **Feature release** (new tab, new screen, new major capability, or a meaningful improvement to existing behaviour): increment the middle segment, reset patch to nothing (two-part form). Example: `v9.06` → `v9.07`.
- **Bug fix on top of an already-shipped feature release** (patching something already delivered, no new capability): add or increment a third segment. Example: `v9.06` ships, then a bug in it is fixed as `v9.06.01`, next bug as `v9.06.02`, and so on.
- A patch version always nests under its feature version — `v9.06.03` is a fix on `v9.06`, not a standalone release.
- **Every build increments the version, no exceptions.** There is no concept of "patching" or "re-zipping" under the same version number — even a one-line hotfix gets a new version.

**Before every build:**
1. Read `CHANGELOG.md` and `scripts/config.js` — confirm current version.
2. Decide feature-vs-patch per the rule above, and compute the new version string.
3. Update `APP_VERSION` in `scripts/config.js`. Never edit `hdr-version` spans in HTML directly — both `index.html` and `login.html` read `APP_VERSION` automatically.
4. Add a `CHANGELOG.md` entry for the new version, inserted immediately above the previously-topmost entry (not appended to a static anchor).
5. Name the zip folder and zip file with the new version number, per the naming convention below.

**CHANGELOG entry length — depends on release type:**
- **Feature release** (`vX.XX`): maximum 4 bullet points. Cover only the meaningful changes — do not pad to reach 4, and do not exceed it.
- **Bug-fix patch** (`vX.XX.XX`): exactly 1 bullet point. A patch fixes one thing; state what was wrong and what changed, in a single bullet. If a patch appears to need more than one bullet, it is actually multiple patches or should have been scoped as a feature release — flag this to the user rather than writing a multi-bullet patch entry.

---

## MANDATORY — Build packaging and naming convention

**This is the only packaging specification in this document. Follow it exactly for every build — there is no alternate tree, no alternate naming scheme.**

### ZIP NAMING CONVENTION
- Feature release: `Product-Studio-vX.XX.zip` (e.g. `Product-Studio-v9.07.zip`)
- Bug-fix patch on a feature release: `Product-Studio-vX.XX.XX.zip` (e.g. `Product-Studio-v9.06.03.zip`)
- Version in the zip name MUST match `APP_VERSION` in `scripts/config.js` exactly.
- Never use any other naming scheme (no `Product-Diagnostics-Toolkit-*`, `PGT-*`, `Product-Metrics-Teardown-App-*`, or similar — these are stale names from earlier project phases and must not be used).

### DIRECTORY STRUCTURE (authoritative — the only tree)
```
Product-Studio-vX.XX(.XX)/
├── index.html
├── login.html
├── netlify.toml
├── favicon.ico                       (binary .ico, decoded from favicon-base64.txt — never include the .txt itself)
├── ai-cost-tower.html                (v9.28, AI Control Tower — standalone admin-only page, opened via window.open())
├── AI_EDITING_RULES.md
├── CHANGELOG.md
├── DESIGN_SYSTEM.md
├── FILE_MANIFEST.txt
├── PROJECT_MAP.md
├── package.json                      (Netlify Functions dependencies — root only, NOT copied from/to proxy/)
│
├── ai-cost-tower/                    (v9.32)
│   └── api-docs.html                 (branded redirect to the correct proxy's /docs/ per environment — see the file's own header comment for why this is a client-side redirect, not a netlify.toml rule)
│
├── scripts/                          (ALL frontend .js files, and ONLY frontend .js files)
│   ├── config.js
│   ├── cost-tower.js                 (v9.28, AI Control Tower — standalone, loaded only by ai-cost-tower.html)
│   ├── state.js
│   ├── utils.js
│   ├── auth.js
│   ├── api.js
│   ├── main.js
│   ├── home.js
│   ├── prompts.js
│   ├── kpi-tree.js
│   ├── capability-canvas.js
│   ├── feature-canvas.js
│   ├── story-canvas-new.js
│   ├── pi-planning.js
│   ├── pi-bucket.js
│   ├── metrics-definition.js
│   ├── diagnostic-view.js
│   ├── product-leak-analysis.js
│   ├── market-intelligence.js
│   ├── prototype-canvas.js
│   ├── team-management.js
│   ├── settings.js
│   ├── settings-page.js
│   ├── left-panel.js
│   ├── session-store.js
│   ├── live-sync.js
│   ├── demo-data.js
│   ├── export-docx.js
│   ├── export-xlsx.js
│   ├── export-pi-docx.js
│   ├── export-diagnostic-docx.js
│   ├── export-market-intel-docx.js
│   ├── local-server.js               (zero-dependency local static file server — distinct from proxy/server.js; NOT a duplicate, NOT the same file)
│   ├── guided-launch.js
│   ├── outcome-pulse.js
│   ├── readiness-canvas.js
│   ├── requirement-agent.js
│   └── voice-input.js
│
├── styles/                           (ALL .css files, 26 total, and ONLY .css files)
│   ├── 00-tokens.css
│   ├── 01-base.css
│   ├── 02-layout.css
│   ├── 03-header-settings.css
│   ├── 04-left-panel.css
│   ├── 05-kpi-tree.css
│   ├── 06-metrics-definition.css
│   ├── 08-feature-canvas.css
│   ├── 09-modals-export.css
│   ├── 10-capability-canvas.css
│   ├── 11-diagnostic-view.css
│   ├── 12-product-leak-analysis.css
│   ├── 13-market-intelligence.css
│   ├── 14-pi-planning.css
│   ├── 15-settings.css
│   ├── 16-story-canvas-new.css
│   ├── 17-home.css
│   ├── 18-auth.css
│   ├── 19-prototype-canvas.css
│   ├── 20-team-management.css
│   ├── 21-outcome-pulse.css
│   ├── 22-guided-launch.css
│   ├── 23-requirement-agent.css
│   ├── 24-readiness-canvas.css
│   ├── 25-voice-input.css
│   └── 26-cost-tower.css
│
├── assets/
│   ├── prototype-style-default.md    (fetched at runtime via 'assets/prototype-style-default.md' — must sit here, NOT inside templates/, NOT renamed)
│   └── templates/
│       ├── capabilitylisttemplate.xlsx        (camelCase — matches actual source filename, do not rename)
│       └── capabilityfeaturestemplate.xlsx    (camelCase — matches actual source filename, do not rename)
│
├── netlify/functions/
│   └── anthropic-proxy.js            (production API route — lives ONLY here, never duplicated into scripts/)
│
└── proxy/                            (separate Render.com/Azure App Service deployable — never merge into frontend root)
    ├── server.js                     (Express proxy backend — lives ONLY here, never duplicated into scripts/; requires npm install, cannot run standalone like local-server.js)
    ├── providerAdapters.js           (canonical adapter module, v9.14 — imported by BOTH proxy/server.js and netlify/functions/anthropic-proxy.js, never duplicated into either)
    ├── package.json                  (proxy-specific dependency list — see exact content below, never copy root package.json here)
    ├── README.md
    ├── routes/v1/                    (v9.32 — AI Cost Control Tower OpenAPI Ingestion Layer, consumer-tier /v1 API)
    │   ├── usageEvents.js
    │   ├── outcomes.js
    │   ├── outcomeTypes.js
    │   ├── companyApps.js
    │   ├── traces.js                 (v9.33 — AI Trace Layer: POST/PATCH/GET /v1/traces, GET /v1/traces/{id}/spans)
    │   └── toolSpans.js              (v9.33 — AI Trace Layer: POST /v1/tool-spans)
    ├── middleware/
    │   └── apiKeyAuth.js             (v9.32 — Bearer API key → (company_id, app_id), never a Supabase Auth session)
    ├── lib/costTower/
    │   ├── idempotency.js            (v9.32)
    │   ├── unitsGenerated.js         (v9.32)
    │   ├── idempotencyStrict.js      (v9.33 — AI Trace Layer: insertIdempotentStrict(), used by routes/v1/traces.js)
    │   └── usageEventRpcParams.js    (v9.33 — AI Trace Layer: shared mt_ai_record_usage_event_with_span RPC parameter mapping, used by proxy/server.js and routes/v1/usageEvents.js)
    └── openapi/                      (v9.32 — served at /docs, unauthenticated)
        ├── openapi.yaml
        ├── docs.html
        ├── redoc.standalone.js       (vendored — cdn.jsdelivr.net is unreachable on this network, do not switch back to a CDN script tag)
        └── redoc.standalone.js.LICENSE.txt
```

### CRITICAL: `proxy/package.json` content (must match exactly)
```json
{
  "name": "aipm-toolkit-proxy",
  "version": "1.0.0",
  "private": true,
  "description": "Express proxy server for AI PM Toolkit. Routes API calls through Anthropic proxy with rate limiting, JWT auth, and Supabase integration.",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node server.js"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "express-rate-limit": "^7.1.5",
    "jsonwebtoken": "^9.0.2",
    "jwks-rsa": "^3.1.0"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "devDependencies": {
    "eslint-plugin-security": "^4.0.1"
  }
}
```
Dependencies are extracted from `server.js`'s actual `require()` statements. Node engine constraint ensures Render.com compatibility. `devDependencies` (`eslint-plugin-security`) is dev-time-only lint tooling — never affects the deployed runtime, but is part of the exact spec so a fresh package.json write doesn't silently drop it.

### FILES THAT MUST BE EXCLUDED FROM EVERY ZIP
- ❌ `scripts/env.js` — contains live Supabase credentials (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `PROXY_URL`). Never included. The user creates this file once locally and drops it into `scripts/` after unzipping — its absence from the zip is expected and correct, not a bug to fix.
- ❌ `node_modules/` — build artifact; `proxy/package.json` lists all deps, `npm install` run once after unzip.
- ❌ `.git/`
- ❌ `favicon-base64.txt` — source-only; only the decoded `favicon.ico` binary goes in the zip.

*(Note: `prevpitemplate.xlsx` was a decommissioned feature and no longer exists in the project at all — there is nothing to exclude regarding it. Do not reference it in future rules or checklists.)*

### PRE-BUILD CHECKLIST — run before every zip, in order

**Version & Documentation:**
- [ ] `APP_VERSION` in `scripts/config.js` matches the new version string, feature or patch form as appropriate
- [ ] `CHANGELOG.md` has a new entry at the top for this exact version
- [ ] Entry follows the length rule: max 4 bullets for a feature release (`vX.XX`), exactly 1 bullet for a patch (`vX.XX.XX`)
- [ ] All 5 governance files present at root: `AI_EDITING_RULES.md`, `CHANGELOG.md`, `DESIGN_SYSTEM.md`, `FILE_MANIFEST.txt`, `PROJECT_MAP.md`

**Root level:**
- [ ] `index.html`, `login.html`, `netlify.toml`, `favicon.ico` (real `.ico`, not `.txt`), `package.json` present
- [ ] NO `.js` or `.css` files at root

**`ai-cost-tower/`:**
- [ ] `api-docs.html` present (v9.32 — without it, the avatar menu's "API Documentation" link 404s)

**`scripts/`:**
- [ ] Every `.js` file in `FILE_MANIFEST.txt`'s `scripts/` list is present, including `local-server.js`
- [ ] `local-server.js` present and distinct from `proxy/server.js` — not merged, not omitted
- [ ] NO `env.js` present
- [ ] NO `server.js` present (that file belongs only in `proxy/`)
- [ ] NO `anthropic-proxy.js` present (that file belongs only in `netlify/functions/`)

**`styles/`:**
- [ ] 26 `.css` files present, matching `FILE_MANIFEST.txt`

**`assets/`:**
- [ ] `assets/prototype-style-default.md` present (NOT inside `templates/`)
- [ ] `assets/templates/capabilitylisttemplate.xlsx` present (camelCase, unmodified name)
- [ ] `assets/templates/capabilityfeaturestemplate.xlsx` present (camelCase, unmodified name)

**`netlify/functions/`:**
- [ ] `anthropic-proxy.js` present, and present ONLY here (not also in `scripts/`)

**`proxy/`:**
- [ ] `server.js`, `providerAdapters.js`, `package.json` (proxy-specific content above), `README.md` all present
- [ ] `proxy/server.js` present ONLY here (not also in `scripts/`)
- [ ] `routes/v1/usageEvents.js`, `outcomes.js`, `outcomeTypes.js`, `companyApps.js` all present (v9.32 — AI Cost Control Tower OpenAPI Ingestion Layer; `proxy/server.js` `require()`s all four and fails to start if any is missing)
- [ ] `routes/v1/traces.js`, `toolSpans.js` both present (v9.33 — AI Trace Layer; `proxy/server.js` `require()`s both and fails to start if either is missing)
- [ ] `middleware/apiKeyAuth.js` present (v9.32)
- [ ] `lib/costTower/idempotency.js`, `unitsGenerated.js` both present (v9.32)
- [ ] `lib/costTower/idempotencyStrict.js`, `usageEventRpcParams.js` both present (v9.33 — AI Trace Layer; `routes/v1/traces.js` and `proxy/server.js`/`routes/v1/usageEvents.js` respectively fail to start without them)
- [ ] `openapi/openapi.yaml`, `docs.html`, `redoc.standalone.js`, `redoc.standalone.js.LICENSE.txt` all present (v9.32 — `/docs` serves a blank page with no error if `redoc.standalone.js` is missing, since it's a vendored file, not CDN-loaded)

**Exclusions — confirm none of these exist anywhere in the tree:**
- [ ] NO `env.js`
- [ ] NO `node_modules/`
- [ ] NO `.git/`
- [ ] NO `favicon-base64.txt`

**ZIP file:**
- [ ] Filename matches `Product-Studio-vX.XX.zip` or `Product-Studio-vX.XX.XX.zip` exactly
- [ ] File placed in `/mnt/user-data/outputs/`

**If ANY check fails: do not zip. Fix the issue, re-run the full checklist, only zip when everything passes.**

### Pre-zip file-reference verification
Before zipping, cross-check every `script src` and `link href` in `index.html` resolves to an actual file in the build folder — a missing script causes a blank screen on load with no visible error. Confirm every referenced `scripts/*.js` and `styles/*.css` path exists in the tree just built.

---

## Local testing

Open `index.html` in a browser. The `styles/`, `scripts/`, and `assets/` folders must remain beside `index.html`. The app requires an Anthropic API key (entered in Settings) to generate AI content. Demo Mode (if present) works without an API key. `local-server.js` can optionally serve the folder over `http://localhost:3000` with zero npm install — distinct from and unrelated to `proxy/server.js`.

---

## Netlify deployment

Drag the unzipped project folder into Netlify Drop (netlify.com/drop). No build configuration needed. The app is a static site with no server-side dependencies. The Anthropic API key is entered by the user in the browser — it is not baked into the deployment.

---

## MANDATORY — External tool consultation (ChatGPT / second opinions)

This section exists because of repeated incidents where ChatGPT was consulted but given incomplete context, leading to fixes that broke related behaviour.

### Before writing a ChatGPT prompt

1. **Read the actual live code first — all of it.** Not just the broken function. Read:
   - The full CSS for every element the fix touches (not just the target element — all ancestors and siblings)
   - The full call chain: every function that calls the broken function, and every function it calls
   - Every `switchTab()` branch that touches the affected state
   - Every render path that could overwrite the fix

2. **Describe the cause, not the symptom.** "text-transform:uppercase in .hdr-product.has-name CSS rule" not "text goes CAPS". ChatGPT fixes what it's told — if told a symptom, it guesses the cause.

3. **Include in the prompt:**
   - The exact failing line of code (not a paraphrase)
   - The full relevant CSS rules (not just the selector)
   - The full call chain showing where the function is called from
   - What other functions touch the same element or state variable
   - The history: "this fix was attempted N times and broke because of X"

4. **Ask ChatGPT explicitly:** "What else could break from this fix?" and "What am I missing in this diagnosis?" — not just "how do I fix this?"

### Before building from ChatGPT output

1. **Run the adversarial check against the proposed code** — not just the diagnosis.
2. **Verify every CSS rule that touches the affected element** — ChatGPT rarely looks at CSS unless given it explicitly.
3. **Trace every call site of every function being changed** — grep the codebase. A function with 8 call sites fixed at 1 call site is still broken at 7.
4. **Never build from ChatGPT output that hasn't been adversarially reviewed** for state management, cross-file impact, timing, or third-party library behaviour.

### The failure pattern to avoid

```
Problem reported → Claude diagnoses (incompletely) → writes ChatGPT prompt (with incomplete context)
→ ChatGPT fixes the described symptom → build ships → same area breaks differently next version
```

The correct pattern:
```
Problem reported → Claude reads ALL relevant code → identifies exact failing line
→ writes ChatGPT prompt with full context including CSS, call chain, history
→ adversarial check on ChatGPT output → build with verified fix
```

---

## KNOWN PATTERN — Cross-canvas state sync (`piFindStory()` returns copy)

**Critical detail for PI Canvas developers:**

`piFindStory()` (in `pi-planning.js`) returns a SHALLOW COPY of the story object:
```javascript
return{...st,featureId:f.id};  // ← SPREAD OPERATOR creates shallow copy
```

**Why:** The copy includes `featureId` which PI Canvas needs but Story Canvas doesn't store in its story objects.

**The Problem:**
If you mutate a story from `piFindStory()` (e.g., `story._inPIPlan=false`), the mutation only affects the copy, NOT the original story in `scCanvas`. Story Canvas will never see the change.

**The Solution (v9.04 pattern):**
When you need to mutate a story and have Story Canvas reflect the change:

1. **Find the ORIGINAL in `scCanvas`** — don't use `piFindStory()`:
```javascript
var story=null;
for(var i=0;i<scCanvas.length;i++){
  var f=scCanvas[i];
  if(f.stories){
    for(var j=0;j<f.stories.length;j++){
      if(f.stories[j].id===storyId){
        story=f.stories[j];  // ← ORIGINAL, not copy
        break;
      }
    }
    if(story)break;
  }
}
// Fallback for stories in piStoryPool (created in PI)
if(!story&&typeof piStoryPool!=='undefined'&&piStoryPool[storyId]){
  story=piStoryPool[storyId];
}
```

2. **Mutate the original** — now changes persist

3. **After save succeeds, refresh Story Canvas:**
```javascript
if(typeof newScRender==='function'){
  newScRender();
}
```

**See v9.04 implementation:** `piRemoveStoryFromBacklog()` in `pi-planning.js`.

---

## Do not do this

- Do not collapse everything back into one large HTML file.
- Do not create a `/dist` or `/build` folder.
- Do not hardcode colour hex values in component CSS files.
- Do not change the 300px left panel width without an explicit instruction.
- Do not move the tab row inside `.right` — it must stay in `.app-shell`.
- Do not ask the user to identify source files by name. Use `PROJECT_MAP.md`.
- Do not hallucinate file counts. Read `FILE_MANIFEST.txt` for the current inventory.
- Do not deviate from the `Product-Studio-vX.XX` / `Product-Studio-vX.XX.XX` naming convention.
- Do not include root-level `.js` or `.css` files in the zip.
- Do not create duplicate files in multiple folders — one canonical location per file. In particular: `anthropic-proxy.js` lives only in `netlify/functions/`; `server.js` lives only in `proxy/`; neither is ever also placed in `scripts/`.
- Do not copy root `package.json` to `proxy/` — use the proxy-specific `package.json` content specified above.
- Do not include instruction files (`.md`, `.txt`) anywhere except root.
- Do not forget the `favicon.ico` conversion from `favicon-base64.txt`.
- Do not rename the xlsx template files — keep camelCase, matching the actual source files.
- Do not reference `prevpitemplate.xlsx` anywhere — it is fully decommissioned, not merely excluded.
- Do not suggest, configure, or reference UptimeRobot or any other keep-alive/ping workaround for Render cold starts, under any framing (cost-saving, temporary, testing). The Render tier upgrade is the only sanctioned fix, and Nethaji owns its timing.
- Do not treat "confirm the diagnosis" or "propose a fix" as build approval. Only an explicit go-ahead after a build list is shown authorizes touching files.
- Do not read only one packaging/tree section of this document and assume it's complete — this document now contains exactly one packaging spec; if a future edit ever reintroduces a second one, that is itself a documentation bug to flag and fix, not to reconcile silently.
