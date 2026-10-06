# Design System — Product Studio

This document is the single source of truth for all visual, layout, and component standards.
Read this before writing any new CSS, building any new screen, or adding any UI component.

## MANDATORY — No new component inventions

**Any UI element being added to the product — a button, panel, modal, badge, tooltip, upload zone, card, chip, action bar, or any other component — must first be checked against this document for an existing pattern.** If a matching or near-matching component already exists here (even in a different tab/screen than the one being built), reuse it: its markup structure, its CSS classes, its exact spacing/sizing/colour values. Do not design a new visual treatment for something this file already specifies.

- If no existing pattern fits, that is itself a signal to flag to the user before building — not a silent green light to invent a new one-off style.
- A "close enough" existing pattern should be reused as-is, not subtly reinvented with slightly different padding, radius, or colour choices.
- This applies even under time pressure or for something that looks trivial (e.g. "just a small badge") — trivial-looking components are exactly where silent one-off inventions accumulate into visual inconsistency across screens.
- When in doubt whether something counts as "already specified here," ask before building rather than assuming a new pattern is warranted.

---

## 1. Typography

| Token | Value |
|---|---|
| Primary font | DM Sans (`var(--font)`) |
| Display font | DM Serif Display (`var(--font-d)`) — empty-state titles and cover headings only |
| Base size | 13px (set on `html, body`) |

**Scale:**

| Use | Size | Weight |
|---|---|---|
| Page / section titles | 13–14px | 700 |
| Tab labels | 12px | 500 active / 400 inactive |
| Card titles / metric names | 11px | 600–700 |
| Body / descriptions | 11–12px | 400 |
| Labels, eyebrows | 9–10px | 700, uppercase, letter-spacing 0.5–1px |
| Hints, metadata | 9–10px | 400 |
| Badges, tags | 7.5–8px | 700 |

Never go below 9px for any visible text. Use Calibri only in PPTX exports — never in the web app.

### Text casing rules (mandatory)

| Element type | Casing | Examples |
|---|---|---|
| Page / screen titles | Title Case | Welcome Back, Create Your Account |
| Tab labels | Title Case | Discovery Map, Capability Canvas, Market Intelligence |
| Named features / modules | Title Case | Story Canvas, Release Canvas, Product Diagnostics |
| Button CTAs | Title Case | Sign In, Create Account, Generate, Launch Session |
| Form field labels | Title Case | Display Name, Email, Password, Company Name |
| Segmented control options | Title Case | Outcome-Based, AI Generated, Capability-Based |
| Badges and tags | Title Case | AI-Powered, Core |
| Descriptive subtitles | Sentence case | Sign in to your account to continue |
| Hints and helper text | Sentence case | Min. 8 characters, This field is required |
| Toast / feedback messages | Sentence case | Signed in. Redirecting… |
| Inline descriptive copy | Sentence case | If that email is registered, a reset link is on its way. |

**Rule:** Title Case applies to anything that is a label, name, or CTA. Sentence case applies to anything that is a description, instruction, or feedback message. When in doubt — if it's a noun or action label, Title Case; if it's a sentence explaining something, sentence case.

---

## 2. Colour palette

All colours are defined as CSS custom properties in `styles/00-tokens.css`.
**Always use the variable, never hardcode hex values in component CSS.**

### Brand colours

| Variable | Hex | Use |
|---|---|---|
| `var(--navy)` | `#003087` | Header background, NSM node, cover blocks |
| `var(--purple)` | `#5F1EBE` | Primary interactive: active tabs, CTAs, Activation stage |
| `var(--purple-deep)` | `#411482` | Hover state on purple CTAs |
| `var(--purple-light)` | `#8C69F0` | Borders on purple elements |
| `var(--purple-pale)` | `#EEEDFE` | Purple surface backgrounds |
| `var(--blue)` | `#0F5FDC` | Secondary interactive, Acquisition stage, info state |
| `var(--blue-pale)` | `#DCE6F0` | Blue surface backgrounds |
| `var(--blue-mid)` | `#B5D4F4` | Blue borders |
| `var(--green)` | `#007873` | Engagement stage, success, Analyze CTA, done state |
| `var(--amber)` | `#C8870A` | Retention stage, warning state |
| `var(--red)` | `#A32D2D` | Error, P1 priority, destructive action |

### Neutral colours

| Variable | Hex | Use |
|---|---|---|
| `var(--card)` | `#F4F6FA` | Universal chrome/surface token: left panel backgrounds, right panel headers and footers, section card backgrounds, gen-wrap footers, status blocks |
| `var(--card-purple)` | `#EEEDFE` | Purple card surfaces |
| `var(--divider)` | `#D0D5E8` | All borders and dividers |
| `var(--label)` | `#A5AFBE` | Muted labels, placeholder text |
| `var(--t1)` | `#000000` | Primary text |
| `var(--t2)` | `#3d3d3a` | Secondary text |
| `var(--t3)` | `#6b6b68` | Tertiary / muted text |
| `var(--t4)` | `#9a9a96` | Hint / disabled text |

### Stage colours

Stage colours reuse the brand palette above — there are no separate hex values for stages. This table exists only to map each stage name to its variable at a glance; the authoritative hex values live in the Brand colours table and in `styles/00-tokens.css`, never here.

| Stage | Variable | Hex (from `styles/00-tokens.css`) |
|---|---|---|
| Acquisition | `var(--blue)` | `#0F5FDC` |
| Activation | `var(--purple)` | `#5F1EBE` |
| Engagement | `var(--green)` | `#007873` |
| Retention | `var(--amber)` | `#C8870A` |

**These variable-to-stage mappings are fixed — never change which variable represents which stage.** If the hex value ever needs to change, change it once in `styles/00-tokens.css` and both tables update automatically — never hardcode a stage colour anywhere else.

### Additional tokens (defined in `styles/00-tokens.css`, not yet given dedicated use-case rows above)

| Variable | Hex | Use |
|---|---|---|
| `var(--blue-bright)` | `#3C91FF` | (confirm intended use before applying — not yet documented with a specific rule) |
| `var(--orange)` | `#E05A00` | (confirm intended use before applying — not yet documented with a specific rule) |
| `var(--amber-pale)` | `#FAEEDA` | Amber surface background (matches Warn-modal icon background in §8) |
| `var(--green-pale)` | `#E1F5EE` | Green surface background |

---

## 3. Layout

### App shell structure

```
body (flex column)
  .hdr                       ← full-width header (navy)
  .app-shell (flex column)
    .out-hdr                 ← full-width tab row (white, border-bottom)
      .tab-row               ← tab buttons
    .app (flex row)
      .left  (300px)         ← left panel
      .right (flex-1)        ← main content area
        [tab content areas]
```

**Critical:** The tab row lives in `.app-shell`, above `.app` — NOT inside `.right`.
This ensures tabs span full viewport width regardless of which tab is active.

### Scrollbar standard

Every scrollable area in the app uses a thin custom scrollbar. Always include:

```css
::-webkit-scrollbar { width: 3px; }
::-webkit-scrollbar-thumb { background: var(--divider); border-radius: 2px; }
```

Never omit this on any new scrollable container.

---

## 4. Left Panel

### Container

```css
width: 300px; min-width: 300px;        /* BOTH required — min-width prevents flex reflow */
background: var(--card);
border-right: 1px solid var(--divider);
display: flex; flex-direction: column;
overflow: hidden; flex-shrink: 0;
transition: width 0.22s cubic-bezier(0.4,0,0.2,1),
            min-width 0.22s cubic-bezier(0.4,0,0.2,1);
```

**Collapsed:** `width: 44px; min-width: 44px` — ALL panels, no exceptions.

### Panel header (.ph)

```css
padding: 10px 12px;
border-bottom: 1px solid var(--divider);
display: flex; align-items: center; justify-content: space-between;
flex-shrink: 0;
/* No background — inherits var(--card) from panel */
```

**Collapsed state:** `padding: 10px 0; justify-content: center`

**Eyebrow label:**
```css
font-size: 10px; font-weight: 700;
color: var(--blue); letter-spacing: 1px;
text-transform: uppercase;
```

**Subtitle (.ph-sub):**
```css
font-size: 11px; color: var(--t3);
margin-top: 2px; line-height: 1.4;
```

### Collapse/expand button — MANDATORY STANDARD

```css
background: none;
border: 1px solid var(--divider);
border-radius: 4px;
width: 24px; height: 24px;
display: flex; align-items: center; justify-content: center;
cursor: pointer; color: var(--t3);   /* MANDATORY — controls SVG currentColor */
flex-shrink: 0; padding: 0;
transition: background 0.12s;

/* Hover */
background: var(--blue-pale);
border-color: var(--blue);
color: var(--blue);
```

**`color: var(--t3)` is mandatory.** The SVG uses `stroke="currentColor"` which inherits from the button's `color`. Without this, it inherits from the parent — producing a darker, heavier-looking icon.

**SVG icon:** `width="12" height="12"` — never any other size.
`stroke="currentColor"` — never hardcoded hex. `stroke-width="2.5"`, `stroke-linecap="round"`, `stroke-linejoin="round"`.
- Expanded (collapse action): `<polyline points="15 18 9 12 15 6"/><polyline points="21 18 15 12 21 6"/>`
- Collapsed (expand action): `<polyline points="9 18 15 12 9 6"/><polyline points="3 18 9 12 3 6"/>`

### Collapsed state — what hides/stays

| Element | Collapsed |
|---|---|
| `.form-scroll`, `.gen-wrap`, panel body | `display: none` |
| `.ph-text`, `.ph-sub` | `display: none` |
| Collapse button | Always visible, centred in 44px strip |

### Generate / CTA footer (.gen-wrap)

```css
padding: 12px 16px;
border-top: 1px solid var(--divider);   /* always 1px — never 2px */
background: var(--card);
flex-shrink: 0;
```

**Generate button (.gen-btn):**
```css
font-size: 12px; font-weight: 700;
border-radius: 7px; padding: 11px 16px;
width: 100%; background: var(--purple);
```

**Semantic exception:** Diagnostics "Analyze" CTA uses `var(--green)` — green = run/execute, purple = AI generate. This is intentional and must not be changed.

---

## 5. Right Panel

### Two open mechanisms — flex-expand is preferred

**Flex-expand (preferred — new panels must use this):**
```css
width: 0; min-width: 0; flex-shrink: 0;
border-left: 0 solid var(--divider);
background: #fff;
display: flex; flex-direction: column; overflow: hidden;
transition: width 0.28s cubic-bezier(0.4,0,0.2,1),
            min-width 0.28s cubic-bezier(0.4,0,0.2,1),
            border-left-width 0.28s;

/* Open state */
width: 440px; min-width: 440px; border-left-width: 1px;
```

The parent container must be `flex-direction: row` to accept the expanding sibling.
No `position: relative` hack on the parent needed. No magic offset numbers. Width change is self-referencing.

**Absolute slide-in (legacy — do not use for new panels):**
```css
position: absolute; top: 0; right: -460px;
width: 440px; height: 100%;
transition: right 0.28s cubic-bezier(0.4,0,0.2,1);
/* Open: right: 0 */
```

The 20px over-offset (`-460px` for a `440px` panel) prevents box-shadow bleed-through when closed. This is why flex-expand is superior — no magic numbers.

### Standard panel width

**440px** across all panels. No exceptions.

### Box shadow

Only on absolute-positioned drawers — not on flex-expand panels:
```css
box-shadow: -4px 0 18px rgba(0,0,0,0.07);
```

### Chrome-content-chrome anatomy (MANDATORY)

Every right panel must follow this three-zone structure:

```
┌─────────────────────────────┐
│  HEADER  var(--card)        │  ← structural chrome
├─────────────────────────────┤
│  BODY    #fff (scrollable)  │  ← content
├─────────────────────────────┤
│  FOOTER  var(--card)        │  ← structural chrome
└─────────────────────────────┘
```

The grey header and footer frame the white scrollable body. This is a deliberate design decision — do not set headers or footers to `#fff`.

### Panel header

```css
padding: 12px 14px 10px;
border-bottom: 1px solid var(--divider);
background: var(--card);                /* MANDATORY — part of chrome-content-chrome */
flex-shrink: 0;
```

**Eyebrow (contextual label):**
```css
font-size: 9px; font-weight: 700;
letter-spacing: 0.8px; text-transform: uppercase;
color: var(--label);
```

**Title:**
```css
font-size: 13px; font-weight: 700;
color: var(--t1); line-height: 1.3;
```

**Subtitle / meta:**
```css
font-size: 10px; color: var(--t3);
```

### Close button — MANDATORY STANDARD

```css
background: none;
border: 1px solid var(--divider);
border-radius: 4px;
width: 24px; height: 24px;
display: flex; align-items: center; justify-content: center;
cursor: pointer; color: var(--t3);
padding: 0; flex-shrink: 0;
transition: all 0.12s;
```

**Default hover (all panels except evidence drawers):**
```css
background: var(--blue-pale);
border-color: var(--blue);
color: var(--blue);
```

**Evidence drawer hover (KPI/DV only — closing discards unsaved data):**
```css
border-color: var(--red);
color: var(--red);
```

**Icon:** SVG × at `12×12`, `stroke-width: 2.5`, `stroke-linecap: round`, `stroke="currentColor"`:
```html
<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <line x1="18" y1="6" x2="6" y2="18"/>
  <line x1="6" y1="6" x2="18" y2="18"/>
</svg>
```

Never use font icons (`ti-x`, `&#215;`, `&#x2715;`) for close buttons — use SVG only.

### Panel body

```css
flex: 1; overflow-y: auto;
padding: 12px 14px;
/* scrollbar */
::-webkit-scrollbar { width: 3px; }
::-webkit-scrollbar-thumb { background: var(--divider); border-radius: 2px; }
```

### Panel footer

```css
padding: 10px 14px;
border-top: 1px solid var(--divider);
background: var(--card);               /* MANDATORY — part of chrome-content-chrome */
flex-shrink: 0;
```

**Primary CTA in footer:**
```css
font-size: 11px; font-weight: 700;
border-radius: 6px; background: var(--purple);
color: #fff;
```

### No backdrop/overlay

Right panels in this app never dim the canvas behind them. The canvas remains fully interactive when a panel is open. This is intentional — panels are supplementary detail, not blocking dialogs.

### Right panel vs modal — when to use which

| Use a right panel | Use a modal |
|---|---|
| Supplementary detail that coexists with the canvas | Blocking action that requires a decision before continuing |
| User can read the canvas while the panel is open | Canvas interaction must be paused |
| Content is contextual to a selected card/item | Action is not tied to a specific canvas item |

---

## 6. Tab row

- Full-width, above the app shell
- Active tab: `color: var(--purple)`, `border-bottom: 2px solid var(--purple)`, `font-weight: 700`
- Inactive tab: `color: var(--t3)`, `font-weight: 500`
- Tab button font: `font-size: 11px`

### Tab button vs tab content — critical distinction

There are TWO different elements per tab — they use DIFFERENT visibility mechanisms:

| Element | ID pattern | Visibility mechanism |
|---|---|---|
| Tab button (in tab row) | `#tab-mi`, `#tab-dv`, `#tab-la` | `element.style.display = ''` to show, `element.style.display = 'none'` to hide |
| Tab content area | `#mi-tab`, `#dv-tab`, `#sc-tab` | `element.classList.add('on')` to show, `element.classList.remove('on')` to hide |
| Gated tab buttons | `#tab-sc`, `#tab-pi` | `element.classList.add('revealed')` to show, `classList.remove('revealed')` to hide |

**Never apply `.on` class to a tab button. Never apply `style.display` to a tab content div.**

---

## 7. Sticky bottom action bar

For primary progression CTAs ("Run Diagnostics", "Analyze product leak").
Appended to the containing flex column — never inside the scrollable area.

```css
position: sticky; bottom: 0;
height: 48px; background: #fff;
border-top: 1px solid var(--divider);
display: flex; align-items: center;
justify-content: flex-end;
padding: 0 20px; gap: 12px;
z-index: 5; flex-shrink: 0;
```

Layout: hint text left (muted) + primary CTA button right.

### Action bar button hierarchy

When an action bar has more than one CTA, assign exactly one tier per button using this decision rule:

- **Primary** — the single action that completes or advances the user's current task to its next stage. Exactly one per bar, ever.
  Class `.diag-bar-cta`. Filled `var(--purple)`, white text.
- **Secondary** — an action that is useful and complete in itself, but not the expected default (the user could reasonably do this *instead of* primary, not just *before* it).
  Class `.diag-bar-secondary`. Pale fill + border in an accent color (`var(--blue-pale)` background, `var(--blue-mid)` border, `var(--blue)` text). Reuse the `var(--blue)` family unless the action represents a genuinely distinct domain — do not introduce new accent colors for tier alone.
- **Tertiary** — an action that modifies or revisits the current state rather than progressing it (refine, edit, adjust, go back).
  Class `.diag-refine-btn-tertiary`. Ghost — no fill, `var(--divider)` border, `var(--t2)` text.

If two candidate actions both seem "primary," that's a signal the screen is trying to do two things — resolve by picking the one that matches the screen's stated purpose (e.g. "Discovery Map ready" → progressing past Discovery Map is primary; analyzing the current Discovery Map further is secondary).

Maximum 3 CTAs per action bar. If a 4th is needed, move it into the refine/expand panel (see Inline refine pattern below) rather than adding a 4th tier.

### Inline refine pattern

Any "refine via free-text AI prompt" action — regardless of screen — uses: a toggle button (tertiary tier, `.diag-refine-btn-tertiary`) to show/hide a textarea, paired with a single icon-only submit button beside the textarea (refresh icon, filled `var(--purple)`, `.diag-refine-send` / `.sc-refine-send`, 30-34px square, white icon).

Never pair the textarea with separate text-labeled "Refine"/"Cancel" buttons — the toggle button is the only collapse mechanism.

### "Add X" dropdown + upload/map pattern

When an "Add [item]" action needs both a single-item path and a bulk-upload path, replace the plain button with a small dropdown (`.cc-addcap-drop`/`.cc-addcap-opt` — two rows, icon + label, no descriptions): "Single [item]" opens the existing single-item modal unchanged; "Upload from file" opens a two-step flow:

1. **Upload modal** — `.cc-upload-row` (upload zone + Template download link) using the unified `Capability/Description/Parent Capability (optional)` (or equivalent) template, `.xlsx`/`.csv` only.
2. **Review/map modal** — a table (`.cc-cap-review-row` grid: name / description / "maps to" dropdown) pre-filled via fuzzy-match against the file's mapping column, with a default destination (e.g. Custom Capabilities) highlighted via `.cc-cap-review-row-custom`. A summary pill (`.cc-parse-ok`) shows the mapped/default split. Confirm performs the batched equivalent of the single-item add action per row, then shows a toast summarising the split — no forced navigation.

Cancel at either step needs no confirmation (low-cost action, file re-upload is fast).

**Mandatory-mapping variant:** when every row MUST map to a destination (no default fallback - e.g. FC's "Add Feature" upload, where every feature needs a capability), unmatched rows get `.cc-cap-review-row-error` + `.cc-cap-review-mapsto-error` (red, empty "— Select —" dropdown) plus a `.cc-cap-review-remove` (×) action. The summary pill becomes `.cc-parse-error` while any row is unresolved, and Confirm stays disabled until every remaining row is either mapped or removed. Confirm's count always reflects only resolved rows.

---

## 8. Modal Construction Standard

### When to use a modal vs right panel

Use a modal for blocking decisions (delete, regenerate, confirm destructive action). Use a right panel for non-blocking supplementary detail. Never use native `alert()`, `confirm()`, or `prompt()`.

### Three modal types

**Type 1 — Warn** (reversible destructive): amber icon, amber CTA. Use for: remove from PI, clear stories.
**Type 2 — Danger** (permanent): red trash icon, red CTA. Use for: delete capability, delete feature, delete story.
**Type 3 — Confirm** (neutral): blue/action icon, purple CTA. Use for: regenerate, proceed with choice.

### Required anatomy

```html
<div class="modal" style="max-width:400px;position:relative;">

  <!-- 1. × close button — ALWAYS position:absolute top:12px right:12px -->
  <button onclick="document.getElementById('OVERLAY-ID').remove()"
    style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;
    padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;"
    title="Close">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  </button>

  <!-- 2. Header — padding 20px, right side 52px to clear × -->
  <div style="padding:20px 52px 20px 20px;display:flex;align-items:flex-start;gap:12px;">
    <!-- Icon: 30×30px rounded square, type-specific colour -->
    <div style="width:30px;height:30px;border-radius:7px;background:#FAEEDA;
      display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;">
      <i class="ti ti-alert-triangle" style="font-size:15px;color:#BA7517;" aria-hidden="true"></i>
    </div>
    <div style="flex:1;min-width:0;">
      <div style="font-size:13px;font-weight:500;color:var(--t1);line-height:1.35;margin-bottom:6px;">
        Modal title here
      </div>
      <div style="font-size:11px;color:var(--t3);line-height:1.6;">
        Sub-text explaining what will happen.
      </div>
    </div>
  </div>

  <!-- 3. Footer — no border, compact padding -->
  <div style="padding:10px 20px 16px;display:flex;justify-content:flex-end;gap:6px;">
    <button class="modal-cancel-btn"
      onclick="document.getElementById('OVERLAY-ID').remove()">Cancel</button>
    <button style="background:#BA7517;color:#fff;border:none;border-radius:5px;
      padding:5px 14px;font-size:11px;font-weight:700;font-family:var(--font);cursor:pointer;">
      Action Label
    </button>
  </div>

</div>
```

### Mandatory rules

- **× close button** — always `position:absolute; top:12px; right:12px`. Never inside the header flex row.
- **Header padding-right: 52px** — ensures copy never runs under the × button.
- **Overlay ID** — every `overlay.id` must be unique and set before `innerHTML` assignment. Always reference by ID in onclick handlers.
- **Focus trap** — always call `trapFocus(overlay)` after `document.body.appendChild(overlay)`.
- **Escape key** — always `capture:true`. Always self-clean with `removeEventListener`.

```javascript
const _esc=function(ev){
  if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_esc,true);}
};
document.addEventListener('keydown',_esc,true);
trapFocus(overlay);
```

- **CTA colours:** Warn = `#BA7517`, Danger = `#A32D2D`, Confirm = `var(--purple)`
- **Cancel** — always ghost (`modal-cancel-btn` class), never coloured.
- **Disabled confirm** — use `disabled` attribute; `.modal-confirm-btn:disabled` in `09-modals-export.css` handles styling.

---

## 9. CSS location reference

| Component | File |
|---|---|
| Design tokens (all CSS variables) | `styles/00-tokens.css` |
| Base resets, toast, shared utilities | `styles/01-base.css` |
| App shell, left panel base, tab row | `styles/02-layout.css` |
| Header, settings | `styles/03-header-settings.css` |
| Left panel form inputs, gen-btn, collapse-btn | `styles/04-left-panel.css` |
| KPI tree, action bar, evidence drawer trigger | `styles/05-kpi-tree.css` |
| Metrics definition | `styles/06-metrics-definition.css` |
| Feature Canvas + Story Canvas shared | `styles/08-feature-canvas.css` |
| Modals, export overlays | `styles/09-modals-export.css` |
| Capability Canvas | `styles/10-capability-canvas.css` |
| Diagnostic View | `styles/11-diagnostic-view.css` |
| Product Diagnostics (leak analysis) | `styles/12-product-leak-analysis.css` |
| Market Intelligence | `styles/13-market-intelligence.css` |
| Release Canvas | `styles/14-pi-planning.css` |
| Admin Settings page | `styles/15-settings.css` |
| Story Canvas | `styles/16-story-canvas-new.css` |
| Home tab | `styles/17-home.css` |
| Auth / login page | `styles/18-auth.css` |
| Prototype Canvas | `styles/19-prototype-canvas.css` |
| Team Management | `styles/20-team-management.css` |

---

## 10. New Component Standards

These components were introduced as part of the Settings and Home tab rearchitecture.
All use existing design tokens. No new colour hex values are introduced.

### File Upload Zone

Used in: Settings Section 1 (Company Profile), Settings Section 5 (Product Profiles).

```html
<div class="sp-upload-zone">
  <div class="sp-upload-icon">
    <i class="ti ti-upload" aria-hidden="true"></i>
  </div>
  <div class="sp-upload-text">
    <div class="sp-upload-title">Upload files</div>
    <div class="sp-upload-sub">PDF, DOCX, TXT, CSV · Max 5MB per file · Up to 5 files</div>
  </div>
  <button class="sp-upload-btn" onclick="...">Browse</button>
  <input type="file" class="sp-upload-input" multiple accept=".pdf,.docx,.txt,.csv" />
</div>
```

```css
.sp-upload-zone {
  border: 1px dashed var(--divider);
  border-radius: 6px;
  padding: 10px 12px;
  background: var(--card);
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}
.sp-upload-icon {
  width: 28px; height: 28px;
  border-radius: 5px;
  background: var(--purple-pale);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
  color: var(--purple);
  font-size: 13px;
}
.sp-upload-title { font-size: 10px; font-weight: 600; color: var(--t1); }
.sp-upload-sub   { font-size: 9px; color: var(--label); margin-top: 1px; }
.sp-upload-text  { flex: 1; min-width: 0; }
.sp-upload-btn {
  font-size: 9px; font-weight: 600;
  color: var(--purple); border: 1px solid var(--purple-light);
  border-radius: 4px; padding: 3px 8px;
  background: var(--purple-pale); cursor: pointer;
  white-space: nowrap; flex-shrink: 0;
}
.sp-upload-input { display: none; }
```

**File chip** — rendered after upload, one per file:

```html
<span class="sp-file-chip">
  <i class="ti ti-file" aria-hidden="true"></i>
  filename.pdf · 1,200w
  <button class="sp-file-chip-remove" onclick="spRemoveDoc(scope, idx)" aria-label="Remove file">
    <i class="ti ti-x" aria-hidden="true"></i>
  </button>
</span>
```

```css
.sp-file-chip {
  display: inline-flex; align-items: center; gap: 4px;
  background: var(--blue-pale); border: 1px solid var(--blue-mid);
  border-radius: 4px; padding: 2px 6px;
  font-size: 9px; font-weight: 600; color: var(--blue);
  margin-top: 5px; margin-right: 4px;
}
.sp-file-chip-remove {
  background: none; border: none; cursor: pointer;
  color: var(--label); display: flex; align-items: center;
  padding: 0; font-size: 9px;
}
.sp-file-chip-remove:hover { color: var(--red); }
```

**Word count meter:**

```html
<div class="sp-word-meter-wrap">
  <div class="sp-word-meter-bar" style="width: 24%;"></div>
</div>
<div class="sp-word-meter-label">1,200 / 5,000 words used · 1 file</div>
```

```css
.sp-word-meter-wrap {
  height: 4px; background: var(--divider);
  border-radius: 2px; margin-top: 6px; overflow: hidden;
}
.sp-word-meter-bar {
  height: 100%; background: var(--purple);
  border-radius: 2px; transition: width 0.2s;
}
.sp-word-meter-label {
  font-size: 9px; color: var(--label); margin-top: 3px;
}
```

**Rules:**
- Upload zone always shows even when 5 files are loaded — disable Browse button and show "Maximum files reached" instead of hiding the zone
- Word meter bar uses `var(--purple)` fill — turns `var(--amber)` when > 80% of word cap used
- File chips always render below the upload zone, never inside it
- Truncation: if extracted words > 1,500 per file, store only first 1,500 words and append warning chip label: `filename.pdf · 1,500w (truncated)`
- Minimum viable extracted text: if extracted words < 50, show chip with amber border and warning label: `filename.pdf · too little text — check file`

---

### Product Profile Card (Settings Section 5 List View)

```html
<div class="sp-profile-card">
  <div class="sp-profile-card-icon">
    <i class="ti ti-box" aria-hidden="true"></i>
  </div>
  <div class="sp-profile-card-body">
    <div class="sp-profile-card-name">
      Product Name
      <span class="sp-profile-type-badge">B2C</span>
    </div>
    <div class="sp-profile-card-desc">One-line product description</div>
    <div class="sp-profile-card-meta">
      <span><i class="ti ti-file" aria-hidden="true"></i> 2 docs · 2,400w</span>
      <span><i class="ti ti-world" aria-hidden="true"></i> Industry</span>
    </div>
  </div>
  <div class="sp-profile-card-actions">
    <button class="sp-profile-action-btn" onclick="spP5ShowEdit(id)" aria-label="Edit profile">
      <i class="ti ti-pencil" aria-hidden="true"></i>
    </button>
    <button class="sp-profile-action-btn sp-profile-action-del" onclick="spP5DeleteProfile(id)" aria-label="Delete profile">
      <i class="ti ti-trash" aria-hidden="true"></i>
    </button>
  </div>
</div>
```

```css
.sp-profile-card {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--divider);
  border-radius: 7px; background: #fff;
  margin-bottom: 8px; cursor: pointer;
  transition: border-color 0.12s;
}
.sp-profile-card:hover { border-color: var(--purple-light); }
.sp-profile-card-icon {
  width: 32px; height: 32px; border-radius: 6px;
  background: var(--purple-pale);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; color: var(--purple); font-size: 14px;
}
.sp-profile-card-body  { flex: 1; min-width: 0; }
.sp-profile-card-name  {
  font-size: 11px; font-weight: 700; color: var(--t1);
  margin-bottom: 2px;
  display: flex; align-items: center; gap: 6px;
}
.sp-profile-card-desc  {
  font-size: 10px; color: var(--t3); line-height: 1.4;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sp-profile-card-meta  {
  font-size: 9px; color: var(--label);
  margin-top: 4px; display: flex; align-items: center; gap: 8px;
}
.sp-profile-card-meta i { font-size: 9px; }
.sp-profile-type-badge {
  font-size: 8px; font-weight: 700;
  background: var(--blue-pale); color: var(--blue);
  border-radius: 20px; padding: 1px 6px;
}
.sp-profile-card-actions {
  display: flex; align-items: center; gap: 6px; flex-shrink: 0;
}
.sp-profile-action-btn {
  width: 26px; height: 26px;
  border: 1px solid var(--divider); border-radius: 5px;
  background: var(--card);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--t3); font-size: 12px;
  transition: all 0.12s;
}
.sp-profile-action-btn:hover {
  border-color: var(--purple); color: var(--purple);
  background: var(--purple-pale);
}
.sp-profile-action-del:hover {
  border-color: var(--red); color: var(--red);
  background: #FCE8E8;
}
```

---

### Settings Section 5 — Split Panel Layout

Used only in Settings Section 5 (Product Profiles). Not used elsewhere.

```html
<div class="sp-p5-shell">
  <div class="sp-p5-list" id="sp-p5-list">
    <!-- profile cards + add button -->
  </div>
  <div class="sp-p5-divider" id="sp-p5-divider"></div>
  <div class="sp-p5-edit" id="sp-p5-edit" style="display:none;">
    <!-- edit form -->
  </div>
</div>
```

```css
.sp-p5-shell {
  display: flex; height: 100%; min-height: 0; overflow: hidden;
}
.sp-p5-list {
  flex: 1; overflow-y: auto; padding: 10px 16px;
  min-width: 0;
}
.sp-p5-list::-webkit-scrollbar { width: 3px; }
.sp-p5-list::-webkit-scrollbar-thumb { background: var(--divider); border-radius: 2px; }
.sp-p5-divider {
  width: 1px; background: var(--divider);
  flex-shrink: 0; display: none;
}
.sp-p5-divider.visible { display: block; }
.sp-p5-edit {
  width: 52%; min-width: 320px; flex-shrink: 0;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.sp-p5-edit-hdr {
  padding: 10px 16px; border-bottom: 1px solid var(--divider);
  display: flex; align-items: center; gap: 8px;
  background: var(--card); flex-shrink: 0;
}
.sp-p5-edit-back {
  width: 24px; height: 24px;
  border: 1px solid var(--divider); border-radius: 4px;
  background: #fff; display: flex; align-items: center;
  justify-content: center; cursor: pointer;
  color: var(--t3); flex-shrink: 0;
  transition: all 0.12s;
}
.sp-p5-edit-back:hover {
  border-color: var(--blue); color: var(--blue);
  background: var(--blue-pale);
}
.sp-p5-edit-title { font-size: 11px; font-weight: 600; color: var(--t1); }
.sp-p5-edit-sub   { font-size: 9px; color: var(--label); margin-top: 1px; }
.sp-p5-edit-scroll {
  flex: 1; overflow-y: auto; padding: 10px 16px;
}
.sp-p5-edit-scroll::-webkit-scrollbar { width: 3px; }
.sp-p5-edit-scroll::-webkit-scrollbar-thumb { background: var(--divider); border-radius: 2px; }
.sp-p5-edit-footer {
  padding: 8px 16px; border-top: 1px solid var(--divider);
  background: var(--card); flex-shrink: 0;
  display: flex; justify-content: flex-end; gap: 6px;
}
```

**Behaviour rules:**
- List view is full-width when edit panel is hidden
- When edit panel opens: divider becomes visible, list narrows to remaining space, edit panel takes 52% min 320px
- Back arrow in edit header: closes edit, hides divider, list returns to full width
- Edit panel never opens as a modal — always inline within the settings right card
- On screens narrower than 900px total settings width: edit panel overlays list (full width) instead of splitting — not in scope for current build (desktop only)

---

### Tooltip Standard — `.pgt-tooltip`

**Rule:** Never use native `title=` attributes for truncated text that needs a readable reveal. Native browser tooltips render in OS-default style (black/white) and cannot be styled. Use `.pgt-tooltip` instead.

**When to use `.pgt-tooltip`:**
- Truncated filenames, labels, or long strings that overflow with ellipsis
- Any element where the user needs to read the full value on hover

**When to leave as native `title=`:**
- Short icon-button action labels (Edit, Delete, Toggle, Close) — these are brief and don't need styled presentation

**Usage:**
```html
<span class="some-class pgt-tooltip" data-tooltip="Full filename or text here">
  Truncated text...
</span>
```

**CSS:** Defined globally in `styles/01-base.css`. Do not redefine in feature CSS files.

**Style spec:**
- Background: `var(--navy)` (`#003087`)
- Text: `#fff`
- Font: 9px DM Sans, normal weight
- Border-radius: `5px`
- Box-shadow: `0 2px 8px rgba(0,0,0,0.18)`
- Position: appears above the element (`bottom: calc(100% + 5px)`)
- z-index: `9000`

**Existing instances:** Session doc filename chips in Home tab (`home-sdoc-name` spans in `scripts/home.js`).

**Note:** `08-feature-canvas.css` has an equivalent dark tooltip on `.sc-cap-breadcrumb` and `.sc-metric-breadcrumb` using the same visual style — these predate the global rule and are intentionally left as-is.
