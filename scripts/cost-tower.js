// ── AI Cost Control Tower (v9.28) ──
// Standalone page (ai-cost-tower.html), own script, not part of the main
// canvas-app boot graph. Reads mt_ai_usage_events/mt_model_pricing via the
// admin-gated mt_ai_cost_events_list() RPC (sql/ai-cost-tower.sql) and
// computes every figure in this file client-side — no server-side
// aggregation RPC per grouping, matching this app's existing convention
// (KPI tree, Capability Canvas) of client-side computation over fetched
// data. Narrative text throughout is deterministic string substitution —
// no LLM call anywhere on these three screens (spec Section 11 item 6).

// ══════════════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════════════

var OPPORTUNITY_SMALL_SEGMENT_PCT = 0.4; // spec Section 6.4, Section 11 item 14
var CONFIDENCE_HIGH_MIN = 1000;
var CONFIDENCE_MEDIUM_MIN = 200;
var PRICING_MATCH_LAUNCH_GATE_PCT = 99; // spec Section 5.7, Section 11 item 11

var TIER_ORDER = { economical: 0, balanced: 1, frontier: 2 };
var TIER_LABEL = { economical: 'Economical', balanced: 'Balanced', frontier: 'Frontier' };
// TIER_BELOW (tier-below-current lookup) removed in the v9.37 period-
// aggregation migration — Type 1's tier-below logic now lives in SQL
// (mt_ai_cost_opportunities' `candidate` CTE, migration file Part E).

// Real values confirmed against resolveModelDecision() (scripts/api.js)
// during build-review — spec Section 5.2, Section 11 item 8.
var SELECTION_RULE_LABELS = {
  optimized_caller_default: 'Optimized (Default)',
  optimized_fallback_default: 'Optimized (Fallback)',
  user_selected_model: 'User-Selected',
  batch_threshold_override: 'Batch Threshold Override',
  explicit_override_unclassified: 'Explicit Override',
  governance_restricted: 'Governance Restricted (Admin)'
};

// ══════════════════════════════════════════════════════════════════════
// Small local utilities (this page does not load utils.js — kept
// self-contained rather than pulling in the full canvas-app helper file)
// ══════════════════════════════════════════════════════════════════════

function actEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function actFmtUSD(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function actFmtUSD0(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return '$' + Math.round(Number(n)).toLocaleString();
}
function actFmtNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString();
}
function actFmtTokens(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  n = Number(n);
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
function actFmtPct(n, digits) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toFixed(digits === undefined ? 1 : digits) + '%';
}
function actDeltaHtml(pct, higherIsBad) {
  if (pct === null || pct === undefined || isNaN(pct)) return '<span class="act-delta-flat">No prior data</span>';
  var isUp = pct > 0.05, isDown = pct < -0.05;
  var bad = higherIsBad === false ? isDown : isUp;
  var cls = (isUp || isDown) ? (bad ? 'act-delta-up' : 'act-delta-down') : 'act-delta-flat';
  var arrow = isUp ? 'Up' : isDown ? 'Down' : 'Flat';
  return '<span class="' + cls + '">' + arrow + ' ' + Math.abs(pct).toFixed(0) + '%</span>';
}
// Layout/motion aligned to the shared .app-toast pattern (styles/01-base.css)
// — top-anchored, pastel + border per type, icon, dismiss ×, width-capped,
// slide+fade — while staying this page's own local implementation (CSS in
// styles/26-cost-tower.css, using this page's own --blue/--red/--green
// tokens rather than .app-toast's hardcoded hex, so the palette isn't
// pixel-identical), matching the same standalone-page convention already
// used for actEsc()/_avatarInitialsLocal().
var _actToastTimer = null;
var _ACT_TOAST_ICONS = {
  error: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>',
  success: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M4 12l5 5L20 6"/></svg>',
  info: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>'
};
function actToast(msg, type) {
  type = (type === 'error' || type === 'success') ? type : 'info';
  var el = document.getElementById('act-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'act-toast';
    document.body.appendChild(el);
  }
  el.className = 'act-toast act-toast-' + type;
  el.innerHTML = _ACT_TOAST_ICONS[type] +
    '<span class="act-toast-msg">' + actEsc(msg) + '</span>' +
    '<button class="act-toast-close" onclick="this.parentElement.classList.remove(\'on\')" aria-label="Dismiss">&#x2715;</button>';
  el.classList.add('on');
  clearTimeout(_actToastTimer);
  _actToastTimer = setTimeout(function () { el.classList.remove('on'); }, 4000);
}
function _avatarInitialsLocal(displayName) {
  var parts = (displayName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ══════════════════════════════════════════════════════════════════════
// Bootstrap: auth → company → active-membership gate. Section 5.7's admin-
// only gate (mt_ai_cost_events_list() raising for a non-admin caller) was
// widened by the multi-app platform extension — every RPC's authorization
// check now accepts any active member, not just admins; see
// _cost_tower_can_access() in the SQL migration.
// ══════════════════════════════════════════════════════════════════════

var actCompanyId = null, actCompanyName = '', actCurrentUser = null;
// Role-based screen gate: AI Governance (Budget Configuration, Alerts,
// Opportunity Matrix) is admin+power-user only. Overview/Cost Breakdown/
// Outcome-Based Cost stay open to every role (unaffected by this).
var actUserRole = null;
// Single source of truth for "can this role see/use AI Governance" — every
// call site below reads this instead of comparing actUserRole directly, so
// the boundary only has to change in one place (matches the codebase's own
// existing _spIsAdmin()-style convention documented in settings-page.js,
// which cost-tower.js can't call directly — separate script graph/tab).
// Allow-list, not a readonly exclusion: fails toward the restrictive UI on
// a null/unexpected role, consistent with that same convention, rather than
// the exclusion-style check's fail-open behavior on an unset role.
function actIsGovernanceViewer() { return actUserRole === 'admin' || actUserRole === 'member'; }

// ── Multi-app platform extension: active-app state ──
// Cost Tower is a separate window.open() tab with its own boot-time context
// read (see actCompanyId above) — resolved once at boot via
// mt_company_apps_list(), never re-derived mid-session. actAvailableApps is
// the full granted-apps list for the current company (ordered oldest-granted
// first by the RPC itself), reused by the Switch App modal so it never has
// to re-fetch just to render its own list.
var actAppId = null, actAppName = '', actAppSupportsEnforcement = false, actAvailableApps = [];

function _pgtActiveAppKey(companyId) { return 'pgt_active_app_id_' + (companyId || 'none'); }

// Mirrors _pgtResolveCompany()'s two-step pattern (stored preference, else
// oldest granted) — but for app-within-company, not company-within-user.
// mt_company_apps_list() already orders by granted_at ASC, so "oldest
// granted" is simply the first row when no valid stored preference exists.
async function actResolveActiveApp() {
  var client = authInit();
  var result = await client.rpc('mt_company_apps_list', { p_company_id: actCompanyId });
  if (result.error) {
    console.error('[Cost Tower] mt_company_apps_list failed:', result.error.message);
    actToast('Could not load the apps granted to this company.', 'error');
  }
  actAvailableApps = (!result.error && result.data) ? result.data : [];

  if (!actAvailableApps.length) {
    actAppId = null; actAppName = ''; actAppSupportsEnforcement = false;
    return;
  }

  var stored = '';
  try { stored = localStorage.getItem(_pgtActiveAppKey(actCompanyId)) || ''; } catch (e) {}
  var match = null;
  for (var i = 0; i < actAvailableApps.length; i++) {
    if (actAvailableApps[i].app_id === stored) { match = actAvailableApps[i]; break; }
  }
  var chosen = match || actAvailableApps[0];

  actAppId = chosen.app_id;
  actAppName = chosen.name;
  actAppSupportsEnforcement = !!chosen.supports_enforcement;
}

document.addEventListener('DOMContentLoaded', actBoot);

async function actBoot() {
  var vEl = document.getElementById('act-hdr-version');
  if (vEl && typeof APP_VERSION !== 'undefined') vEl.textContent = APP_VERSION;

  actShowGate('Loading…', 'Checking your session…');

  var session = await authGetSession();
  if (!session) { window.location.href = 'login.html'; return; }
  actCurrentUser = await authGetUser();

  try { actCompanyId = localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY) || ''; } catch (e) { actCompanyId = ''; }
  if (!actCompanyId) {
    actShowGate('No Active Company', 'Open Product Studio in another tab and select a company first, then reopen this page.');
    return;
  }

  var client = authInit();
  // Membership check and app resolution both depend only on actCompanyId
  // (already known above), not on each other's result — issued together so
  // they run as one concurrent round-trip instead of two serial ones.
  var membershipPromise = client.from('mt_users_companies')
    .select('role, is_active, mt_companies(name)')
    .eq('user_id', actCurrentUser.id)
    .eq('company_id', actCompanyId)
    .maybeSingle();
  var appResolvePromise = actResolveActiveApp();

  var membership;
  try {
    var res = await membershipPromise;
    membership = res.data;
  } catch (e) { membership = null; }
  await appResolvePromise;

  // Open to every active member regardless of role (multi-app platform
  // extension; was admin-only in v9.28) — mirrors _cost_tower_can_access()'s
  // own widened check in the RPC layer, so the client-side gate and the
  // server-side authorization can't disagree about who's let in.
  if (!membership || !membership.is_active) {
    actShowGate('Access Required', 'You need an active membership in this company to view the AI Control Tower.');
    return;
  }

  if (!actAppId) {
    actShowGate('No Apps Available', 'No apps are available for your company. Contact your admin.');
    return;
  }

  actUserRole = membership.role;
  actCompanyName = (membership.mt_companies && membership.mt_companies.name) || '';
  var logoEl = document.getElementById('act-logo-txt');
  if (logoEl) logoEl.textContent = actCompanyName;
  var sepEl = document.getElementById('act-hdr-sep');
  if (sepEl) sepEl.style.display = actCompanyName ? '' : 'none';
  var avEl = document.getElementById('act-avatar');
  if (avEl) avEl.textContent = _avatarInitialsLocal(actCurrentUser.displayName);
  var anEl = document.getElementById('act-avatar-name');
  if (anEl) anEl.textContent = actCurrentUser.displayName || '';
  var aeEl = document.getElementById('act-avatar-email');
  if (aeEl) aeEl.textContent = actCurrentUser.email || '';
  _actApplyScreenNameHeader();
  var switchAppItem = document.getElementById('act-switch-app-item');
  if (switchAppItem) switchAppItem.style.display = actAvailableApps.length >= 2 ? '' : 'none';
  // Escape hatch for a control_tower-access admin (spec §6a.4 Option A) —
  // hidden for non-admins, who couldn't reach Team Management anyway.
  var teamSettingsItem = document.getElementById('act-team-settings-item');
  if (teamSettingsItem) teamSettingsItem.style.display = membership.role === 'admin' ? '' : 'none';
  // AI Governance tab: admin+power-user only, hidden entirely for read-only.
  // Real enforcement lives server-side (_cost_tower_can_manage_governance on
  // the budget/alert RPCs) — this is the matching client-side hint, same
  // two-layer pattern as the control_tower access restriction.
  var planTab = document.getElementById('act-tab-plan');
  if (planTab) planTab.style.display = actIsGovernanceViewer() ? '' : 'none';

  // Gate stays up through the data-fetch phase too — previously hidden
  // right here, before the Promise.all below even started, leaving the
  // (now-visible) app shell's content area blank for the 2-3s this takes.
  actShowGate('Loading…', 'Loading your cost and usage data…');

  // actLoadBudgetAndAlerts() still runs for every role — Overview's own
  // "% of budget used" stat needs the active budget regardless of the AI
  // Governance screen gate, and that function itself skips only the
  // alerts half for read-only (see there for why). actRenderPlan() and
  // actLoadLifetimeSpend() (whose only consumer is actRenderPlan()'s own
  // "Total spent overall" KPI) are both skipped outright for read-only, so
  // #act-scr-plan stays empty behind its hidden tab and no full-history
  // scan runs to compute a number nobody without governance access sees.
  var bootFetches = [actLoadMainContext(), actLoadBudgetAndAlerts(), actLoadProductNames(), actLoadTeamNames()];
  if (actIsGovernanceViewer()) bootFetches.push(actLoadLifetimeSpend());
  try {
    await Promise.all(bootFetches);
    await actSetOverviewPeriod('this_month');
    await actSetBreakdownPeriod('this_month');
    if (actIsGovernanceViewer()) actRenderPlan();
    // Outcome-Based Cost (v2, Screen 4) — eager load at boot, same as every
    // other screen. actShowScreen() is a pure visibility toggle in this
    // file (confirmed: no per-screen fetch logic lives there), so this
    // follows the established pattern rather than a lazy-load-on-tab-click
    // one. Now sources its own independent actOutcomePeriod rather than
    // reusing actMain.rows/actMain.prevRows — Overview and Outcome each got
    // their own period filter in this build; only Governance still reads
    // actMain directly (no filter, by design).
    if (typeof actSetOutcomePeriod === 'function') await actSetOutcomePeriod('this_month');
  } catch (err) {
    console.error('[Cost Tower] boot render failed:', err);
    actToast('Something went wrong loading cost data. Check the console for details.', 'error');
  } finally {
    actHideGate();
    document.getElementById('act-app-shell').style.display = 'flex';
  }
}

function actShowGate(title, sub) {
  document.getElementById('act-gate-title').textContent = title;
  document.getElementById('act-gate-sub').textContent = sub;
  document.getElementById('act-gate').style.display = 'flex';
}
function actHideGate() { document.getElementById('act-gate').style.display = 'none'; }

function actAvatarToggle() {
  var drop = document.getElementById('act-avatar-drop');
  var overlay = document.getElementById('act-avatar-overlay');
  if (!drop) return;
  var isOpen = drop.classList.contains('open');
  drop.classList.toggle('open', !isOpen);
  overlay.classList.toggle('open', !isOpen);
}
function actAvatarClose() {
  var drop = document.getElementById('act-avatar-drop');
  var overlay = document.getElementById('act-avatar-overlay');
  if (drop) drop.classList.remove('open');
  if (overlay) overlay.classList.remove('open');
}

// OpenAPI Ingestion Layer discovery link (spec §7.2) — opens this app's own
// branded /ai-cost-tower/api-docs.html instead of the raw proxy hostname
// directly, so the link a person actually clicks/bookmarks reads as part of
// this app rather than exposing an onrender.com/azurewebsites.net URL. That
// page immediately client-side-redirects to the correct proxy's /docs/ —
// see its own header comment for why this couldn't be a netlify.toml
// server-side redirect instead (this project's single netlify.toml deploys
// identically to both the dev and prod Netlify sites, with no per-site
// override mechanism available under a no-build-step, git-less deploy).
// No registration or credential-issuing action lives behind either page.
function actOpenApiDocs() {
  actAvatarClose();
  window.open('/ai-cost-tower/api-docs.html', '_blank');
}

// ══════════════════════════════════════════════════════════════════════
// Tab switching
// ══════════════════════════════════════════════════════════════════════

var ACT_SCREEN_NAMES = { overview: 'Overview', cost: 'Cost Breakdown', plan: 'AI Governance', outcome: 'Outcome-Based Cost' };
// Factored out of actShowScreen() so actBoot() can also set the header text
// before any tab switch ever happens. Always shows the app name, even for a
// single-app company — cheap now, sets the right expectation once a second
// app exists (spec default, no override requested).
function _actApplyScreenNameHeader() {
  var nameEl = document.getElementById('act-screen-name');
  if (nameEl) nameEl.textContent = actAppName ? 'AI Control Tower · ' + actAppName : 'AI Control Tower';
}
function actShowScreen(name) {
  // Defense in depth: the AI Governance tab button is already hidden for
  // read-only members (actBoot()), and #act-scr-plan is never populated for
  // them (actRenderPlan() is skipped) — this catches any other way 'plan'
  // could still be requested, rather than showing an empty screen.
  if (name === 'plan' && !actIsGovernanceViewer()) name = 'overview';
  document.querySelectorAll('.act-screen').forEach(function (s) { s.classList.remove('on'); });
  var scr = document.getElementById('act-scr-' + name);
  if (scr) scr.classList.add('on');
  document.querySelectorAll('.act-tab-row .act-tab-btn').forEach(function (b) { b.classList.remove('active'); });
  var btn = document.getElementById('act-tab-' + name);
  if (btn) btn.classList.add('active');
  _actApplyScreenNameHeader();
  var scroller = document.querySelector('.act-content-scroll');
  if (scroller) scroller.scrollTop = 0;
}

// ══════════════════════════════════════════════════════════════════════
// Switch App — avatar menu → modal, mirrors index.html's Switch Company
// shape (one card per granted app, current selection checked), reusing this
// page's own shared #act-modal-overlay/#act-modal-box rather than building
// new modal chrome. Visibility of the menu item itself is gated in actBoot()
// (2+ apps granted). On selection: persist the choice per-company (a user
// could have a different last-used app per company) and reload this page —
// Cost Tower is a reporting surface with no in-flight-generation state to
// guard against losing, confirmed absent from this file's script graph.
// ══════════════════════════════════════════════════════════════════════

function actOpenSwitchAppModal() {
  actAvatarClose();
  document.getElementById('act-modal-title').textContent = 'Choose an app';
  var cardsHtml = actAvailableApps.map(function (a) {
    var isCurrent = a.app_id === actAppId;
    return '<div class="act-switch-app-choice' + (isCurrent ? ' current' : '') + '"' +
      (isCurrent ? '' : ' onclick="actSelectApp(\'' + actEsc(a.app_id) + '\')"') + '>' +
      '<div class="act-switch-app-name">' + actEsc(a.name) + '</div>' +
      (isCurrent ? '<span class="act-switch-app-check">&#10003;</span>' : '') +
      '</div>';
  }).join('');
  document.getElementById('act-modal-body').innerHTML = '<div class="act-switch-app-list">' + cardsHtml + '</div>';
  // #act-modal-box's shared CSS (600px, vertically centered) is sized for
  // this page's other modals (Custom Date Range, Supporting Calls, outcome
  // detail) — reused here rather than building new chrome, but this one
  // choice-list content needs to match index.html's "Choose a company"
  // modal instead (top-aligned, narrow). Toggled via a CSS modifier class
  // (styles/26-cost-tower.css's .act-modal-compact), not inline styles, so
  // every other modal on this page keeps its own default size/position and
  // there's no risk of clearing 2 of 3 inline properties on close while
  // missing the third; actCloseModal() removes the class unconditionally.
  document.getElementById('act-modal-box').classList.add('act-modal-compact');
  actShowModal();
}
function actSelectApp(appId) {
  try { localStorage.setItem(_pgtActiveAppKey(actCompanyId), appId); } catch (e) {}
  actCloseModal();
  window.location.reload();
}
function actGoToBreakdown(group) {
  actShowScreen('cost');
  actSelectGroup(group);
  setTimeout(function () { actScrollToSection('act-main-breakdown'); }, 30);
}
function actScrollToSection(id) {
  var container = document.querySelector('.act-content-scroll');
  var target = document.getElementById(id);
  if (!container || !target) return;
  container.scrollTo({ top: target.offsetTop - 20, behavior: 'smooth' });
}
function actToggleMenu(id) {
  document.querySelectorAll('.act-dropdown-chip-menu').forEach(function (m) { if (m.id !== id) m.classList.remove('open'); });
  var m = document.getElementById(id);
  if (m) m.classList.toggle('open');
}
document.addEventListener('click', function (ev) {
  if (!ev.target.closest || !ev.target.closest('.act-dropdown-chip-wrap')) {
    document.querySelectorAll('.act-dropdown-chip-menu').forEach(function (m) { m.classList.remove('open'); });
  }
});

// ══════════════════════════════════════════════════════════════════════
// Data layer — period math, fetch (memoized), aggregation primitives
// ══════════════════════════════════════════════════════════════════════

function actMonthRange(offsetMonths) {
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth() + offsetMonths, 1, 0, 0, 0, 0);
  var end = new Date(now.getFullYear(), now.getMonth() + offsetMonths + 1, 1, 0, 0, 0, 0);
  return { start: start, end: end };
}
function actPriorPeriod(start, end) {
  var len = end.getTime() - start.getTime();
  return { start: new Date(start.getTime() - len), end: new Date(start.getTime()) };
}

// Single source of truth for the lifetime-spend floor date (spec Section
// 6.2, placeholder for v1; revisit if it proves inaccurate as history
// grows) — used by actLoadLifetimeSpend() (Governance's "Total spent
// overall") and actResolvePeriodRange()'s 'overall' branch below. Returns a
// fresh Date each call since Date objects are mutable and get reused as
// range boundaries elsewhere in this file.
function actLifetimeFloorDate() { return new Date(2024, 0, 1); }

// Shared period-resolution logic — used by actSetBreakdownPeriod,
// actSetOverviewPeriod, and actSetOutcomePeriod (cost-tower-outcomes.js) so
// this math only has to be fixed in one place. For the two calendar-month
// options, compares against the actual calendar prior month (same
// definition Overview's own KPI deltas use via actMonthRange(-1)) rather
// than a rolling window of equal length — the two would otherwise silently
// disagree whenever adjacent months have different day counts. A rolling
// window is kept for Last 3 Months/Custom, where there's no single
// well-defined "calendar-aligned prior period." 'overall' has no
// meaningful prior period at all — prior is a zero-width range (fetches 0
// rows), so every existing "vs prior period" delta already renders "No
// prior data" via actDeltaPct's existing prev===0 guard, with no new code.
function actResolvePeriodRange(type, customStart, customEnd) {
  var range, prior;
  if (type === 'this_month') { range = actMonthRange(0); prior = actMonthRange(-1); }
  else if (type === 'last_month') { range = actMonthRange(-1); prior = actMonthRange(-2); }
  else if (type === 'last_3_months') {
    var now = new Date();
    range = { start: new Date(now.getFullYear(), now.getMonth() - 2, 1, 0, 0, 0, 0), end: now };
    prior = actPriorPeriod(range.start, range.end);
  } else if (type === 'overall') {
    range = { start: actLifetimeFloorDate(), end: new Date() };
    prior = { start: range.start, end: range.start };
  } else {
    range = { start: customStart, end: customEnd };
    prior = actPriorPeriod(range.start, range.end);
  }
  return { range: range, prior: prior };
}

// v9.37 period-aggregation migration (sql/ai-cost-tower-period-aggregation-
// migration.sql) — mt_ai_cost_events_list is now paginated (p_limit/
// p_offset, default ORDER BY request_started_at DESC) rather than an
// unbounded fetch. Request Explorer's flat table is the only remaining
// caller that needs individual rows; every KPI/total below reads one of
// the new aggregate RPCs instead. Returns {rows, totalCount} — totalCount
// comes from the RPC's own total_row_count window column (the true count
// over the whole period, not just this page).
var _actRowCache = {};
async function actFetchRows(start, end, limit, offset) {
  limit = limit || 50; offset = offset || 0;
  var key = start.toISOString() + '|' + end.toISOString() + '|' + limit + '|' + offset;
  if (_actRowCache[key]) return _actRowCache[key];
  var client = authInit();
  var result = await client.rpc('mt_ai_cost_events_list', {
    p_company_id: actCompanyId,
    p_app_id: actAppId,
    p_period_start: start.toISOString(),
    p_period_end: end.toISOString(),
    p_limit: limit,
    p_offset: offset
  });
  if (result.error) {
    console.error('[Cost Tower] mt_ai_cost_events_list failed:', result.error.message);
    actToast('Could not load cost data for this period.', 'error');
    return { rows: [], totalCount: 0 };
  }
  var data = result.data || [];
  var out = { rows: data, totalCount: data.length ? Number(data[0].total_row_count) : 0 };
  _actRowCache[key] = out;
  return out;
}

// Scalar period totals (Overview's At-a-Glance, Cache Usage, Data
// Quality's 4 KPI tiles, Governance's MTD/lifetime figures, Outcome-Based
// Cost's TOTAL_AI_SPEND_PERIOD) — one row, always, immune to any row cap
// regardless of call volume. See migration file Part B for field-by-field
// provenance.
var _actCostSummaryCache = {};
async function actFetchCostSummary(start, end) {
  var key = start.toISOString() + '|' + end.toISOString();
  if (_actCostSummaryCache[key]) return _actCostSummaryCache[key];
  var client = authInit();
  var result = await client.rpc('mt_ai_cost_summary', {
    p_company_id: actCompanyId, p_app_id: actAppId,
    p_period_start: start.toISOString(), p_period_end: end.toISOString()
  });
  if (result.error) {
    console.error('[Cost Tower] mt_ai_cost_summary failed:', result.error.message);
    actToast('Could not load cost summary for this period.', 'error');
    return null;
  }
  var row = (result.data && result.data[0]) || null;
  _actCostSummaryCache[key] = row;
  return row;
}

// Server-grouped breakdown — one row per distinct value of p_group_by
// ('feature'|'product'|'model'|'user'|'prompt_version'|'selection_rule'|
// 'tier'|'user_role'|'unpriced_drill'|'outcome_type'), never per event —
// see migration file Part C. Cache key includes group_by since the same
// start|end window is fetched under multiple groupings by different
// widgets on the same screen.
var _actCostGroupedCache = {};
async function actFetchCostGrouped(start, end, groupBy) {
  var key = start.toISOString() + '|' + end.toISOString() + '|' + groupBy;
  if (_actCostGroupedCache[key]) return _actCostGroupedCache[key];
  var client = authInit();
  var result = await client.rpc('mt_ai_cost_grouped', {
    p_company_id: actCompanyId, p_app_id: actAppId,
    p_period_start: start.toISOString(), p_period_end: end.toISOString(),
    p_group_by: groupBy
  });
  if (result.error) {
    console.error('[Cost Tower] mt_ai_cost_grouped(' + groupBy + ') failed:', result.error.message);
    actToast('Could not load cost breakdown for this period.', 'error');
    return [];
  }
  _actCostGroupedCache[key] = result.data || [];
  return _actCostGroupedCache[key];
}

// Top-N calls by duration/size/cost, optionally per-partition (Longest/
// Largest's "By Call" mode when partitionBy is null; Outcome-Based Cost's
// per-type/per-caller sample calls when it isn't) — see migration file
// Part D. This replaces client-side max-finding over a row set that could
// silently be missing the actual longest/largest call under truncation.
var _actTopCallsCache = {};
async function actFetchTopCalls(start, end, orderBy, limit, partitionBy) {
  var key = start.toISOString() + '|' + end.toISOString() + '|' + orderBy + '|' + limit + '|' + (partitionBy || '');
  if (_actTopCallsCache[key]) return _actTopCallsCache[key];
  var client = authInit();
  var result = await client.rpc('mt_ai_cost_top_calls', {
    p_company_id: actCompanyId, p_app_id: actAppId,
    p_period_start: start.toISOString(), p_period_end: end.toISOString(),
    p_order_by: orderBy, p_limit: limit, p_partition_by: partitionBy || null
  });
  if (result.error) {
    console.error('[Cost Tower] mt_ai_cost_top_calls failed:', result.error.message);
    actToast('Could not load top calls for this period.', 'error');
    return [];
  }
  _actTopCallsCache[key] = result.data || [];
  return _actTopCallsCache[key];
}

// Needs Attention / Governance's Top Optimization Opportunities Type 1
// (intake routing) and Type 2 (prompt-version regression) — see migration
// file Part E. Type 3 (unassigned attribution) is deliberately NOT
// returned here; it's folded client-side from actFetchCostGrouped's
// 'feature' mode (actComputeType3Client below), same as today.
var _actOpportunitiesCache = {};
async function actFetchOpportunities(start, end) {
  var key = start.toISOString() + '|' + end.toISOString();
  if (_actOpportunitiesCache[key]) return _actOpportunitiesCache[key];
  var client = authInit();
  var result = await client.rpc('mt_ai_cost_opportunities', {
    p_company_id: actCompanyId, p_app_id: actAppId,
    p_period_start: start.toISOString(), p_period_end: end.toISOString()
  });
  if (result.error) {
    console.error('[Cost Tower] mt_ai_cost_opportunities failed:', result.error.message);
    actToast('Could not load optimization opportunities for this period.', 'error');
    return [];
  }
  _actOpportunitiesCache[key] = result.data || [];
  return _actOpportunitiesCache[key];
}

// Lazy, on-demand only (Type 1's "View Supporting Calls" modal) — not
// cached, since it's a single click-triggered fetch, not something every
// period-change re-requests.
async function actFetchOpportunitySupportingCalls(start, end, feature, limit) {
  var client = authInit();
  var result = await client.rpc('mt_ai_cost_opportunity_supporting_calls', {
    p_company_id: actCompanyId, p_app_id: actAppId,
    p_period_start: start.toISOString(), p_period_end: end.toISOString(),
    p_feature: feature, p_limit: limit || 5
  });
  if (result.error) {
    console.error('[Cost Tower] mt_ai_cost_opportunity_supporting_calls failed:', result.error.message);
    actToast('Could not load supporting calls.', 'error');
    return [];
  }
  return result.data || [];
}

// AI Trace Layer — remaining widgets (By Trace toggle, By Conversation
// ranking, Failure Cost's 2 new KPIs, Trace Explorer card). Separate
// fetch/cache pair, not a reuse of actFetchRows above — actFetchRows's
// cache key is start|end only, no RPC-name component, so sharing it with
// a second RPC would collide cache entries between the two. Governance-
// gated server-side (_cost_tower_can_manage_governance, same tier as the
// payload viewer's mt_ai_trace_payload_get) — callers should skip this
// fetch outright for a non-governance viewer rather than let it fail.
var _actTraceDetailCache = {};
async function actFetchTraceDetail(start, end) {
  var key = start.toISOString() + '|' + end.toISOString();
  if (_actTraceDetailCache[key]) return _actTraceDetailCache[key];
  var client = authInit();
  var result = await client.rpc('mt_ai_trace_detail_list', {
    p_company_id: actCompanyId,
    p_app_id: actAppId,
    p_period_start: start.toISOString(),
    p_period_end: end.toISOString()
  });
  if (result.error) {
    console.error('[Cost Tower] mt_ai_trace_detail_list failed:', result.error.message);
    actToast('Could not load trace detail for this period.', 'error');
    return [];
  }
  _actTraceDetailCache[key] = result.data || [];
  return _actTraceDetailCache[key];
}

// Groups mt_ai_trace_detail_list's span-level rows (one row per span,
// sharing trace_id/agent_name/etc. across every span of the same trace)
// into one summary object per trace — the frontend does this grouping,
// not the RPC, per §2's design. Computes each trace's total duration/
// cost/bytes and a status classification in one pass, so every consumer
// (Request Explorer's By Trace toggle, Longest/Largest's By Conversation
// ranking, Failure Cost's 2 new KPIs, Trace Explorer) reads the same
// already-computed fields instead of re-deriving them independently.
function actBuildTraceSummaries(detailRows) {
  var byTrace = Object.create(null);
  var order = [];
  detailRows.forEach(function (r) {
    if (!byTrace[r.trace_id]) {
      byTrace[r.trace_id] = {
        trace_id: r.trace_id, agent_name: r.agent_name, client_trace_id: r.client_trace_id,
        trace_started_at: r.trace_started_at, trace_completed_at: r.trace_completed_at,
        outcome_id: r.outcome_id, spans: []
      };
      order.push(r.trace_id);
    }
    byTrace[r.trace_id].spans.push(r);
  });
  return order.map(function (id) {
    var t = byTrace[id];
    t.spans.sort(function (a, b) { return (a.sequence_order || 0) - (b.sequence_order || 0); });
    var totalDuration = 0, totalCost = 0, totalBytes = 0, hasEarlierFailure = false;
    t.spans.forEach(function (s, idx) {
      totalDuration += Number(s.span_duration_ms || 0);
      if (s.calculated_cost != null) totalCost += Number(s.calculated_cost);
      totalBytes += Number(s.request_bytes || 0) + Number(s.response_bytes || 0);
      // Matches actFailedRows' own failure definition (status 'error' OR
      // 'timeout') — code-review fix: this previously only checked 'error',
      // undercounting a trace-level failure relative to the existing
      // per-call Failure Cost KPIs, which already treat both as failed.
      if (idx < t.spans.length - 1 && (s.span_status === 'error' || s.span_status === 'timeout')) hasEarlierFailure = true;
    });
    var lastStatus = t.spans[t.spans.length - 1].span_status;
    // Decision 2 (spec §0): abandoned = last span status='error', no
    // successful span after it — single-span-error traces count too, no
    // carve-out (§9 item 6). 'recovered' = worded as adjacency ("a later
    // span succeeded"), not confirmed retry-recovery — this schema can't
    // prove genuine retry semantics (§5). Code-review fix: 'recovered' now
    // requires the last span to have actually succeeded — previously this
    // fell through to 'recovered' whenever hasEarlierFailure was true and
    // lastStatus merely wasn't 'error' (e.g. lastStatus === 'timeout'),
    // which is not "a later span succeeded." A trace whose last span timed
    // out lands in 'other', not 'completed' or 'recovered'.
    var statusKind = lastStatus === 'error' ? 'abandoned'
      : (lastStatus === 'success' ? (hasEarlierFailure ? 'recovered' : 'completed') : 'other');
    t.totalDurationMs = totalDuration;
    t.totalCost = totalCost;
    t.totalBytes = totalBytes;
    t.spanCount = t.spans.length;
    t.statusKind = statusKind;
    t.lastStatus = lastStatus;
    return t;
  });
}

// Populated once per trace-detail fetch (actSetBreakdownPeriod), not
// per-render — every consumer (Request Explorer's By Trace rows, Trace
// Explorer card) shares this one map rather than each rebuilding it from
// whatever subset it happens to render, which would stomp on the others'
// entries when their renders are interleaved on the same screen.
var actTraceSpanRowById = Object.create(null);
function actIndexTraceSpans(traceSummaries) {
  actTraceSpanRowById = Object.create(null);
  traceSummaries.forEach(function (t) {
    t.spans.forEach(function (s) {
      if (s.usage_event_id) actTraceSpanRowById[String(s.usage_event_id)] = s;
    });
  });
}

function actTraceStatusPillHtml(t) {
  if (t.statusKind === 'abandoned') return '<span class="act-tag-status bad">abandoned</span>';
  if (t.statusKind === 'recovered') return '<span class="act-tag-status warn">1 error span</span>';
  if (t.statusKind === 'completed') return '<span class="act-tag-status ok">completed</span>';
  return '<span class="act-tag-status warn">' + actEsc(t.lastStatus || 'unknown') + '</span>';
}

// Shared trace→span expandable rows, used by both Request Explorer's By
// Trace toggle (Item 1) and the Trace Explorer card (Item 5) — the
// expand/collapse and payload-icon wiring exists in exactly one place,
// not duplicated per consumer, per the spec's explicit reuse instruction.
function actTraceGroupRowsHtml(traces) {
  if (!traces.length) return '';
  return traces.map(function (t) {
    var spansHtml = t.spans.map(function (s) {
      var canOpenPayload = actIsGovernanceViewer() && s.span_type === 'llm_call' && s.usage_event_id;
      var payloadBtn = canOpenPayload
        ? '<button type="button" class="act-payload-btn act-trace-span-payload-btn" data-usage-event-id="' + actEsc(String(s.usage_event_id)) + '" aria-label="Inspect prompt and response">↗</button>'
        : '';
      return '<div class="act-trace-span-row"><span class="act-trace-span-seq">' + s.sequence_order + '</span>' +
        '<span class="act-trace-span-type ' + (s.span_type === 'llm_call' ? 'llm' : 'tool') + '">' + (s.span_type === 'llm_call' ? 'llm_call' : actEsc(s.tool_name || 'tool_call')) + '</span>' +
        '<span class="act-trace-span-dur">' + (s.span_duration_ms != null ? (s.span_duration_ms / 1000).toFixed(1) + 's' : '—') + '</span>' +
        '<span class="act-trace-span-cost">' + (s.calculated_cost != null ? actFmtUSD(s.calculated_cost) : '—') + '</span>' +
        '<span class="act-trace-span-status"><span class="act-tag-status ' + (s.span_status === 'success' ? 'ok' : (s.span_status === 'error' ? 'bad' : 'warn')) + '">' + actEsc(s.span_status) + '</span>' + payloadBtn + '</span></div>';
    }).join('');
    return '<div class="act-trace-group" data-trace-id="' + actEsc(t.trace_id) + '">' +
      '<div class="act-trace-row" data-trace-toggle="' + actEsc(t.trace_id) + '">' +
      '<span class="act-trace-toggle-icon">&#9656;</span>' +
      '<span class="act-trace-agent">' + actEsc(t.agent_name) + '</span>' +
      '<span class="act-trace-meta">' + t.spanCount + ' call' + (t.spanCount === 1 ? '' : 's') + ' · ' + (t.totalDurationMs / 1000).toFixed(1) + 's</span>' +
      '<span class="act-trace-cost">' + actFmtUSD(t.totalCost) + '</span>' +
      actTraceStatusPillHtml(t) +
      '</div>' +
      '<div class="act-trace-span-list" style="display:none;">' + spansHtml + '</div>' +
      '</div>';
  }).join('');
}

// One delegated listener per container (idempotency flag, same pattern as
// actBindExplorerPayloadClicks) — handles both the expand/collapse toggle
// and the payload-inspect icon inside any span row.
function actBindTraceGroupClicks(containerEl) {
  if (!containerEl || containerEl._traceClickBound) return;
  containerEl._traceClickBound = true;
  containerEl.addEventListener('click', function (event) {
    var target = event.target;
    if (target && target.nodeType !== 1) target = target.parentElement;
    var payloadBtn = target && target.closest ? target.closest('.act-trace-span-payload-btn') : null;
    if (payloadBtn) {
      event.preventDefault(); event.stopPropagation();
      var id = payloadBtn.getAttribute('data-usage-event-id');
      var span = actTraceSpanRowById[id];
      if (!span) { actToast('Could not find payload row context.', 'error'); return; }
      actOpenPayloadModal(id, span);
      return;
    }
    var toggleRow = target && target.closest ? target.closest('[data-trace-toggle]') : null;
    if (!toggleRow) return;
    var group = toggleRow.closest('.act-trace-group');
    var list = group && group.querySelector('.act-trace-span-list');
    var icon = toggleRow.querySelector('.act-trace-toggle-icon');
    if (!list) return;
    var isOpen = list.style.display !== 'none';
    list.style.display = isOpen ? 'none' : 'block';
    if (icon) icon.innerHTML = isOpen ? '&#9656;' : '&#9662;';
  });
}

// Item 6 — Cost by Agent. Independent of the trace-detail RPC/fetch above
// (span-level detail is irrelevant to a per-agent rollup) and gated on the
// more open _cost_tower_can_access, not the governance gate — fetched
// unconditionally for every role.
var _actCostByAgentCache = {};
async function actFetchCostByAgent(start, end) {
  var key = start.toISOString() + '|' + end.toISOString();
  if (_actCostByAgentCache[key]) return _actCostByAgentCache[key];
  var client = authInit();
  var result = await client.rpc('mt_ai_cost_by_agent', {
    p_company_id: actCompanyId,
    p_app_id: actAppId,
    p_period_start: start.toISOString(),
    p_period_end: end.toISOString()
  });
  if (result.error) {
    console.error('[Cost Tower] mt_ai_cost_by_agent failed:', result.error.message);
    actToast('Could not load cost by agent for this period.', 'error');
    return [];
  }
  _actCostByAgentCache[key] = result.data || [];
  return _actCostByAgentCache[key];
}

// ══════════════════════════════════════════════════════════════════════
// Client-side folding over server-grouped rows (mt_ai_cost_grouped).
// mt_ai_cost_grouped('feature') returns one row per (caller, product_id)
// pair — bounded by distinct-caller count, never by event count. Every
// fold below collapses that already-small result through the SAME label
// logic actFeatureOf()/actIsCrossProductCaller() always used (summing
// across sub-groups is associative, so folding after aggregation is
// exact, not an approximation — unlike Type 1's percentile logic, which
// is why that one had to move server-side instead, see
// mt_ai_cost_opportunities). Field names match actGroupSum()'s old shape
// (cost/calls/failed/inputTok/outputTok) on purpose — actTopBy() below
// works unchanged on either.
// ══════════════════════════════════════════════════════════════════════

function actFoldGrouped(groupedRows, keyFn) {
  var map = {};
  (groupedRows || []).forEach(function (g) {
    var k = keyFn(g);
    if (!map[k]) map[k] = { key: k, calls: 0, cost: 0, failed: 0, failedCost: 0, inputTok: 0, outputTok: 0, unitsSum: 0, unitsResolved: 0, sampleTier: null, sampleUserRole: null, firstSeen: null, lastSeen: null };
    var m = map[k];
    m.calls += Number(g.calls || 0);
    m.cost += Number(g.cost || 0);
    m.failed += Number(g.failed_calls || 0);
    m.failedCost += Number(g.failed_cost || 0);
    m.inputTok += Number(g.input_tokens || 0);
    m.outputTok += Number(g.output_tokens || 0);
    m.unitsSum += Number(g.units_generated_sum || 0);
    m.unitsResolved += Number(g.units_resolved_count || 0);
    // Representative-only fields — meaningful when a mode groups by exactly
    // the label being folded to (model/user: one server row per key already,
    // so this is an exact passthrough, not an aggregate); for feature/product
    // modes, where several server rows DO fold into one label, these are
    // display-only and not claimed to represent every folded row.
    if (g.sample_tier) m.sampleTier = g.sample_tier;
    if (g.sample_user_role) m.sampleUserRole = g.sample_user_role;
    if (g.first_seen && (!m.firstSeen || g.first_seen < m.firstSeen)) m.firstSeen = g.first_seen;
    if (g.last_seen && (!m.lastSeen || g.last_seen > m.lastSeen)) m.lastSeen = g.last_seen;
  });
  return map;
}
function actFoldFeatureGroups(groupedRows) {
  return actFoldGrouped(groupedRows, function (g) { return actFeatureOf(g.group_key1); });
}
function actFoldProductGroups(groupedRows) {
  return actFoldGrouped(groupedRows, function (g) {
    return g.group_key2 || (actIsCrossProductCaller(g.group_key1) ? '__cross_product__' : '__unassigned__');
  });
}
function actFoldSimpleGroups(groupedRows, fallbackLabel) {
  return actFoldGrouped(groupedRows, function (g) { return g.group_key1 || fallbackLabel; });
}
// Main Breakdown's "Prompt Version" option — mt_ai_cost_grouped
// ('prompt_version') returns one row per (caller, prompt_version) pair (see
// migration file Part C); folded here to feature+version combined keys,
// matching the original client-side actGroupKeyFor()'s 'prompt' behavior
// exactly (a feature can reuse the same prompt_version string as another
// feature, so the two must not be merged).
function actFoldPromptGroups(groupedRows) {
  return actFoldGrouped(groupedRows, function (g) { return actFeatureOf(g.group_key1) + ' · ' + (g.group_key2 || 'Unversioned'); });
}
// Unassigned attribution (Type 3 / Overview's Unassigned Spend) — dollars
// with no product_id AND not a known cross-product caller, folded from
// the same (caller, product_id) rows 'feature' mode already returned.
// Mirrors actAttributionGap() exactly, just server-aggregated.
function actAttributionGapFromGrouped(groupedRows, totalCost) {
  var unassigned = 0;
  (groupedRows || []).forEach(function (g) {
    if (!g.group_key2 && !actIsCrossProductCaller(g.group_key1)) unassigned += Number(g.cost || 0);
  });
  return { pct: totalCost ? (unassigned / totalCost * 100) : 0, dollars: unassigned };
}

// ══════════════════════════════════════════════════════════════════════
// Opportunities — maps mt_ai_cost_opportunities' RPC rows (Type 1/2) back
// into the exact object shape actRenderOpportunities()/actOpenOppModal()
// already render, and folds Type 3 in client-side from an already-fetched
// 'feature' grouped result (no separate RPC call for Type 3).
// ══════════════════════════════════════════════════════════════════════

function actComputeType3Client(featureGroupedRows, totalCost) {
  var gap = actAttributionGapFromGrouped(featureGroupedRows, totalCost);
  if (gap.dollars <= 0) return null;
  return {
    type: 3, savings: gap.dollars,
    title: 'Unassigned product attribution',
    evidence: actFmtPct(gap.pct, 0) + ' of spend has no product_id. This is not savings, it is a measurement gap that blocks accurate governance.',
    confidence: null
  };
}
function actMapOpportunityRow(row) {
  if (Number(row.opp_type) === 1) {
    return {
      type: 1, feature: row.feature, savings: Number(row.savings),
      title: row.feature + ' intake routing',
      evidence: 'The smallest ' + Math.round(OPPORTUNITY_SMALL_SEGMENT_PCT * 100) + '% of ' + row.feature + ' calls by request size still route through ' + (TIER_LABEL[row.current_tier] || row.current_tier) + ' tier, alongside its larger calls.',
      confidence: actConfidenceTier(Number(row.segment_count)),
      segmentCount: Number(row.segment_count),
      outlierFactor: row.outlier_factor != null ? Number(row.outlier_factor) : null,
      currentTier: row.current_tier, candidateTier: row.candidate_tier,
      supportingCalls: null // lazy-loaded by actOpenOppModal via actFetchOpportunitySupportingCalls
    };
  }
  return {
    type: 2, feature: row.feature, savings: Number(row.savings),
    title: 'Prompt version ' + row.current_version + ' review',
    evidence: row.current_version + ' shows a higher avg cost/call ($' + Number(row.current_avg_cost).toFixed(2) + ') than the immediately preceding version ' + row.baseline_version + ' ($' + Number(row.baseline_avg_cost).toFixed(2) + ') for ' + row.feature + '.',
    confidence: actConfidenceTier(Number(row.segment_count)),
    outlierFactor: row.outlier_factor != null ? Number(row.outlier_factor) : null
  };
}
async function actLoadOpportunities(start, end, featureGroupedRows, totalCost) {
  var raw = await actFetchOpportunities(start, end);
  var mapped = raw.map(actMapOpportunityRow);
  var type3 = actComputeType3Client(featureGroupedRows, totalCost);
  if (type3) mapped.push(type3);
  mapped.sort(function (a, b) { return b.savings - a.savings; });
  return mapped;
}

// AI Governance's This-Month context — summary + the 3 grouped fetches its
// widgets need (feature: Opportunity Matrix + Type 3 fold; user_role: Role
// Economics; user: What-If's per-user percentile input; What-If's
// per-product side reuses featureGrouped via actFoldProductGroups, no
// separate fetch). Opportunities are shared with Overview's Needs
// Attention via the same actLoadOpportunities() call, one source of truth
// per the pre-existing "shared, not duplicated" comment on
// actComputeOpportunities().
var actMain = { summary: null, featureGrouped: [], userRoleGrouped: [], userGrouped: [], opportunities: [], start: null, end: null, now: null };
async function actLoadMainContext() {
  var thisMonth = actMonthRange(0);
  var results = await Promise.all([
    actFetchCostSummary(thisMonth.start, thisMonth.end),
    actFetchCostGrouped(thisMonth.start, thisMonth.end, 'feature'),
    actFetchCostGrouped(thisMonth.start, thisMonth.end, 'user_role'),
    actFetchCostGrouped(thisMonth.start, thisMonth.end, 'user')
  ]);
  actMain.summary = results[0];
  actMain.featureGrouped = results[1];
  actMain.userRoleGrouped = results[2];
  actMain.userGrouped = results[3];
  actMain.start = thisMonth.start; actMain.end = thisMonth.end; actMain.now = new Date();
  actMain.opportunities = await actLoadOpportunities(thisMonth.start, thisMonth.end, actMain.featureGrouped, actMain.summary ? Number(actMain.summary.total_cost) : 0);
}

var actBudget = null, actAlerts = [];

// Lifetime spend — Governance-only, all-time total distinct from actMain's
// calendar-month scope (spec Section 4.4/6.2). Floor date is a hardcoded
// placeholder for v1; revisit if it proves inaccurate as history grows.
// Loaded once at boot alongside actMain, not per-render. Now backed by
// mt_ai_cost_summary — this was the single most-exposed figure to the
// row-cap bug (the widest possible window), since it previously summed a
// client-fetched row array over the app's entire history.
var actLifetimeSpendTotal = 0;
async function actLoadLifetimeSpend() {
  var summary = await actFetchCostSummary(actLifetimeFloorDate(), new Date());
  actLifetimeSpendTotal = summary ? Number(summary.total_cost) : 0;
}
async function actLoadBudgetAndAlerts() {
  var client = authInit();
  try {
    var r1 = await client.rpc('mt_ai_budget_get_active', { p_company_id: actCompanyId, p_app_id: actAppId });
    if (r1.error) {
      console.error('[Cost Tower] mt_ai_budget_get_active failed:', r1.error.message);
      actToast('Could not load budget configuration.', 'error');
    }
    actBudget = (!r1.error && r1.data && r1.data.budget_id) ? r1.data : null;
  } catch (e) { console.error('[Cost Tower] mt_ai_budget_get_active exception:', e); actToast('Could not load budget configuration.', 'error'); actBudget = null; }
  // Alerts are AI-Governance-specific (rendered only by actRenderAlertsCard(),
  // called only from actRenderPlan()) — mt_ai_alerts_list is governance-gated
  // server-side (_cost_tower_can_manage_governance), so a read-only member's
  // call would just fail; skip it rather than fetch something never rendered.
  if (!actIsGovernanceViewer()) {
    actAlerts = [];
  } else {
    try {
      var r2 = await client.rpc('mt_ai_alerts_list', { p_company_id: actCompanyId, p_app_id: actAppId });
      if (r2.error) {
        console.error('[Cost Tower] mt_ai_alerts_list failed:', r2.error.message);
        actToast('Could not load budget alerts.', 'error');
      }
      actAlerts = (!r2.error && r2.data) ? r2.data : [];
    } catch (e) { console.error('[Cost Tower] mt_ai_alerts_list exception:', e); actToast('Could not load budget alerts.', 'error'); actAlerts = []; }
  }
}

// `mt_ai_cost_events_list` returns raw product_id/user_id — resolving them
// to display names is a separate, best-effort step (falls back to the raw
// id if either lookup fails, never blocks rendering).

var actProductNames = {};
async function actLoadProductNames() {
  try {
    var client = authInit();
    var result = await client.from('mt_products').select('id,name').eq('company_id', actCompanyId);
    (result.data || []).forEach(function (p) { actProductNames[p.id] = p.name; });
  } catch (e) { console.warn('[Cost Tower] product name lookup failed:', e); }
}
function actProductNameOf(id) { return actProductNames[id] || (id ? id : 'Unknown Product'); }

// User display names aren't queryable directly (Supabase's auth.users is
// protected) — reusing the same admin-only /api/team/list proxy route
// Team Management already uses for exactly this (scripts/team-management.js).
var actUserNames = {};
async function actLoadTeamNames() {
  try {
    var authToken = '';
    try { if (typeof authGetFreshToken === 'function') authToken = await authGetFreshToken(); } catch (e) {}
    var host = window.location.hostname;
    var isLocal = (host === '' || host === 'localhost' || host === '127.0.0.1');
    var base = isLocal ? 'http://localhost:3001' : ((typeof PROXY_URL !== 'undefined' && PROXY_URL) ? PROXY_URL.replace(/\/api\/anthropic\/?$/, '') : 'https://product-diagnostics-proxy.onrender.com');
    var headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['X-Auth-Token'] = authToken;
    // /api/team/list is admin-gated; Cost Tower is open to every active
    // member regardless of role, so name resolution goes through this
    // separate, member-gated route instead (returns only user_id/name).
    var res = await fetch(base + '/api/cost-tower/team-names', { method: 'POST', headers: headers, body: JSON.stringify({ company_id: actCompanyId }) });
    var data = await res.json().catch(function () { return {}; });
    (data.names || []).forEach(function (m) { actUserNames[m.user_id] = m.name; });
  } catch (e) { console.warn('[Cost Tower] team name lookup failed:', e); }
}
function actUserNameOf(id) { return actUserNames[id] || (id ? id : 'Unknown User'); }

// actPricedRows/actSumCost/actAvgCostPerCall/actPricingMatchRate/
// actFailedRows/actAttributionGap/actSumField (row-array reducers) removed
// in the v9.37 period-aggregation migration — every KPI they fed now reads
// a server-aggregated field (mt_ai_cost_summary/mt_ai_cost_grouped)
// instead. actIsPriced is kept: it's still applied per-row by Request
// Explorer's flat table and Longest/Largest's "By Call" mode, both of
// which still legitimately render individual rows.
function actIsPriced(r) { return r.calculated_cost !== null && r.calculated_cost !== undefined; }
function actDeltaPct(curr, prev) {
  // No comparable prior-period value — null means "no prior data," never
  // "0% change." Callers must not coerce this to 0 (that would misrepresent
  // an unknown baseline as a flat/no-change reading).
  if (prev === null || prev === undefined || prev === 0) return null;
  return (curr - prev) / prev * 100;
}
function actHealthTier(projected, budgetAmount) {
  if (!budgetAmount) return 'Unknown';
  if (projected > budgetAmount * 1.25) return 'Critical';
  if (projected > budgetAmount) return 'Watch';
  return 'On Track';
}
function actRunRate(spendSoFar, start, now, end) {
  var daysElapsed = Math.max(1, (now.getTime() - start.getTime()) / 86400000);
  var daysInPeriod = Math.max(daysElapsed, (end.getTime() - start.getTime()) / 86400000);
  var dailyAvg = spendSoFar / daysElapsed;
  return { dailyAvg: dailyAvg, projected: dailyAvg * daysInPeriod, daysElapsed: daysElapsed, daysInPeriod: daysInPeriod };
}

// Appendix C, corrected during build-review — a caller's prefix indicates
// which canvas triggers it, not always which canvas owns it. Exceptions
// checked before the general prefix rules.
// Callers that run across every product by design (ai-recommendations
// aggregates across all products/sessions; doc-summary serves the shared
// document library) never get a single product_id — that's expected, not
// a governance gap, so these are labeled and counted separately from
// genuinely-unassigned rows (any other caller unexpectedly missing one).
// Single source of truth for this file — actFeatureOf() below reads this
// same list rather than repeating the two caller strings independently, so
// the two can't silently drift apart. (scripts/api.js's CALLER_TIERS also
// lists these callers, for the unrelated purpose of model-tier routing —
// not reused here since this page is deliberately standalone and doesn't
// load api.js.)
var CROSS_PRODUCT_CALLERS = ['ai-recommendations', 'doc-summary'];
function actIsCrossProductCaller(caller) {
  return CROSS_PRODUCT_CALLERS.indexOf(caller) !== -1;
}

function actFeatureOf(caller) {
  if (!caller || caller === 'unknown') return 'Unknown / Other';
  if (caller === 'fc-gen-stories') return 'Story Canvas';
  if (caller === 'sc-add-feat-hyp-gen') return 'Feature Canvas';
  if (caller === 'md-dd-batch') return 'Capability Canvas';
  if (caller === 'diagnostic-leak') return 'Discovery Map';
  if (caller === 'guided-launch') return 'Guided Launch';
  if (caller === 'requirement-agent') return 'Requirement Agent';
  if (caller === 'outcome-pulse-suggest') return 'Outcome Pulse';
  if (actIsCrossProductCaller(caller)) return 'Shared / Cross-canvas';
  if (/^dm-/.test(caller)) return 'Discovery Map';
  if (/^mi-/.test(caller)) return 'Market Intelligence';
  if (/^cc-/.test(caller)) return 'Capability Canvas';
  if (/^fc-/.test(caller)) return 'Feature Canvas';
  if (/^sc-/.test(caller)) return 'Story Canvas';
  if (/^pi-/.test(caller)) return 'PI Canvas';
  if (/^arp-/.test(caller)) return 'Adoption Readiness';
  if (/^prototype-/.test(caller)) return 'Prototype Canvas';
  return 'Unknown / Other';
}
function actModelOf(row) { return row.response_model || row.requested_model || 'Unknown'; }

// actGroupSum (client-side row grouping) removed in the v9.37 period-
// aggregation migration — actFoldGrouped and its actFold*Groups() variants
// (near actFetchCostByAgent above) do the same job over server-grouped
// rows instead. actTopBy still works unchanged on either shape (both use
// the field names cost/calls/failed/inputTok/outputTok).
function actTopBy(map, field) {
  var best = null;
  Object.keys(map).forEach(function (k) {
    if (!best || map[k][field] > best[field]) best = map[k];
  });
  return best;
}

// ══════════════════════════════════════════════════════════════════════
// Shared: Top Optimization Opportunities (spec Section 6.4) — used by
// both Overview's Needs Attention and Governance's opportunity cards, one
// source of truth per the spec's explicit instruction. Type 1/2's
// row-level percentile logic (actComputeType1/actComputeType2, removed in
// the v9.37 period-aggregation migration) now runs server-side —
// mt_ai_cost_opportunities — since it needs to pool a feature's full call
// set before taking a percentile segment, which isn't safe to do over a
// client-fetched row array that can be silently capped. See
// actMapOpportunityRow/actLoadOpportunities above (near actFetchCostByAgent).
// ══════════════════════════════════════════════════════════════════════

function actConfidenceTier(n) {
  if (n > CONFIDENCE_HIGH_MIN) return 'High';
  if (n >= CONFIDENCE_MEDIUM_MIN) return 'Medium';
  return 'Low';
}

// ══════════════════════════════════════════════════════════════════════
// SCREEN 1: Overview (spec Section 4)
// ══════════════════════════════════════════════════════════════════════

// Independent period state, mirroring actBreakdown's shape — Overview no
// longer reads actMain directly (Governance still does, by design; it gets
// no filter). actOverviewPeriod.now is captured at fetch time since
// actRunRate() below needs a "now" pinned to when this period was loaded,
// the same role actMain.now already plays for Governance.
var actOverviewPeriod = {
  type: 'this_month', label: 'This Month',
  summary: null, prevSummary: null,
  featureGrouped: [], prevFeatureGrouped: [],
  modelGrouped: [], prevModelGrouped: [],
  agentRows: [], opportunities: [],
  start: null, end: null, now: null
};

// Sequence guard against out-of-order resolution — if the user selects a
// second period before the first one's fetch resolves, the first call's
// continuation must not clobber the second's already-committed (or
// still-pending) newer data. Each call captures its own sequence number and
// only commits/renders if it's still the latest when its fetch resolves.
var _actOverviewPeriodSeq = 0;

async function actSetOverviewPeriod(type, customStart, customEnd) {
  actOverviewPeriod.type = type;
  var mySeq = ++_actOverviewPeriodSeq;
  var resolved = actResolvePeriodRange(type, customStart, customEnd);
  var range = resolved.range, prior = resolved.prior;
  // Both fetches batched into one round-trip (matches actSetOutcomePeriod's
  // pattern), and — critically — nothing is written to the shared
  // actOverviewPeriod object until AFTER the sequence check below. Writing
  // .rows/.prevRows unconditionally before this check was the actual bug:
  // a stale call's data could still clobber a newer call's already-committed
  // state even though the stale call's own render was correctly skipped.
  var results = await Promise.all([
    actFetchCostSummary(range.start, range.end),
    actFetchCostSummary(prior.start, prior.end),
    actFetchCostGrouped(range.start, range.end, 'feature'),
    actFetchCostGrouped(prior.start, prior.end, 'feature'),
    actFetchCostGrouped(range.start, range.end, 'model'),
    actFetchCostGrouped(prior.start, prior.end, 'model'),
    actFetchCostByAgent(range.start, range.end)
  ]);
  if (mySeq !== _actOverviewPeriodSeq) return;
  actOverviewPeriod.start = range.start; actOverviewPeriod.end = range.end; actOverviewPeriod.now = new Date();
  actOverviewPeriod.summary = results[0];
  actOverviewPeriod.prevSummary = results[1];
  actOverviewPeriod.featureGrouped = results[2];
  actOverviewPeriod.prevFeatureGrouped = results[3];
  actOverviewPeriod.modelGrouped = results[4];
  actOverviewPeriod.prevModelGrouped = results[5];
  actOverviewPeriod.agentRows = results[6];
  actOverviewPeriod.opportunities = await actLoadOpportunities(range.start, range.end, actOverviewPeriod.featureGrouped, actOverviewPeriod.summary ? Number(actOverviewPeriod.summary.total_cost) : 0);
  if (mySeq !== _actOverviewPeriodSeq) return;
  actRenderOverview();
}

function actSelectOverviewPeriodChip(type, label) {
  actOverviewPeriod.label = label;
  document.getElementById('act-overview-period-menu').classList.remove('open');
  actSetOverviewPeriod(type).catch(function (e) { console.error(e); });
}

function actOpenOverviewCustomRangeModal() {
  document.getElementById('act-overview-period-menu').classList.remove('open');
  document.getElementById('act-modal-title').textContent = 'Custom Date Range';
  document.getElementById('act-modal-body').innerHTML =
    '<div class="act-config-grid">' +
    '<div class="act-field"><div class="act-field-label">From</div><input id="act-overview-custom-from" type="date"></div>' +
    '<div class="act-field"><div class="act-field-label">To</div><input id="act-overview-custom-to" type="date"></div>' +
    '</div>' +
    '<div style="margin-top:14px;color:var(--red);font-size:11px;" id="act-overview-custom-range-error"></div>' +
    '<div style="margin-top:14px;display:flex;justify-content:flex-end;"><button class="act-btn act-btn-primary act-btn-sm" onclick="actApplyOverviewCustomRange()">Apply</button></div>';
  actShowModal();
}

async function actApplyOverviewCustomRange() {
  var fromVal = document.getElementById('act-overview-custom-from').value;
  var toVal = document.getElementById('act-overview-custom-to').value;
  var errEl = document.getElementById('act-overview-custom-range-error');
  if (!fromVal || !toVal) { errEl.textContent = 'Choose both a start and end date.'; return; }
  var start = new Date(fromVal + 'T00:00:00');
  var end = new Date(new Date(toVal + 'T00:00:00').getTime() + 86400000);
  if (start >= end) { errEl.textContent = 'Start date must be before end date.'; return; }
  errEl.textContent = '';
  actCloseModal();
  actOverviewPeriod.label = fromVal + ' – ' + toVal;
  await actSetOverviewPeriod('custom', start, end);
}

// Item 6 (remaining-five-widgets spec) — conversation-level cost rollup by
// AI Trace Layer agent. Placed alongside Top Cost Drivers rather than
// literally inside it — this app's Overview screen has no single
// "Main Breakdown" card the prototype's own placement note assumed;
// Cost Breakdown's Main Breakdown is a different screen entirely. Open to
// every role (mt_ai_cost_by_agent uses _cost_tower_can_access, the same
// open gate mt_ai_cost_events_list already uses) — no gating needed here.
function actRenderCostByAgent(agentRows) {
  var rowsHtml = (agentRows || []).map(function (a) {
    return '<tr><td class="act-cell-name">' + actEsc(a.agent_name) + '</td><td>' + actFmtNum(a.trace_count) +
      '</td><td>' + (a.avg_calls_per_trace != null ? Number(a.avg_calls_per_trace).toFixed(1) : '—') +
      '</td><td class="act-cell-name">' + actFmtUSD(a.total_cost) + '</td></tr>';
  }).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--t4);padding:16px;">No traced conversations in this period.</td></tr>';
  return '<div class="act-section-title">Cost by Agent</div>' +
    '<div class="act-section-insight">Conversation-level rollup for AI Trace Layer agents — currently reflects Requirement Agent only, since it’s the sole caller writing traces today. Grows automatically as more features adopt the trace/span write path.</div>' +
    // Code-review fix: mt_ai_cost_by_agent's avg_calls_per_trace counts
    // every span (llm_call AND tool_call), not just billable provider
    // calls — "Avg Calls / Trace" read as if it were the latter. Relabeled
    // to say what it actually measures rather than changing the RPC
    // (already applied to dev; a metric-definition change belongs in its
    // own reviewed migration, not a silent code-review fix).
    '<div class="act-scoped-card"><table class="act-data-table"><thead><tr><th>Agent</th><th>Traces</th><th>Avg Spans / Trace <span class="act-cell-muted" style="font-weight:400;text-transform:none;">(LLM + tool calls)</span></th><th>Total Cost</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
}

function actRenderOverview() {
  var summary = actOverviewPeriod.summary || {}, prevSummary = actOverviewPeriod.prevSummary || {};
  var totalSpend = Number(summary.total_cost || 0), prevSpend = Number(prevSummary.total_cost || 0);
  var spendDelta = actDeltaPct(totalSpend, prevSpend);
  // The budget is a monthly figure — comparing more than one month of real
  // spend against it (Overall, Last 3 Months, or a multi-month Custom Range)
  // would show a nonsensical "Budget Used: 1,600%"/"Health: Critical" rather
  // than a wrong-but-plausible number, so it's treated as not-configured for
  // this render, reusing the existing no-budget fallback path (Health→
  // "Unknown", Needs Attention card doesn't render) rather than inventing a
  // separate rendering branch per multi-month period type. Originally only
  // excluded 'overall'; 'last_3_months' and any multi-month custom range had
  // the identical problem and were missed.
  var isSingleMonthPeriod = actOverviewPeriod.type === 'this_month' || actOverviewPeriod.type === 'last_month';
  var budgetAmount = (actBudget && isSingleMonthPeriod) ? Number(actBudget.amount) : null;
  var budgetUsedPct = budgetAmount ? (totalSpend / budgetAmount * 100) : null;
  var totalCalls = Number(summary.total_calls || 0), prevCalls = Number(prevSummary.total_calls || 0);
  var callsDelta = actDeltaPct(totalCalls, prevCalls);
  var inTok = Number(summary.total_input_tokens || 0), outTok = Number(summary.total_output_tokens || 0);
  var prevInTok = Number(prevSummary.total_input_tokens || 0), prevOutTok = Number(prevSummary.total_output_tokens || 0);
  var pricedCalls = Number(summary.priced_calls || 0), prevPricedCalls = Number(prevSummary.priced_calls || 0);
  var avgCost = pricedCalls ? totalSpend / pricedCalls : null;
  var prevAvgCost = prevPricedCalls ? prevSpend / prevPricedCalls : null;
  var avgCostDelta = actDeltaPct(avgCost, prevAvgCost);
  var pricingMatch = totalCalls ? (pricedCalls / totalCalls * 100) : null;
  var unpricedCount = Number(summary.unpriced_calls || 0);
  var attrib = actAttributionGapFromGrouped(actOverviewPeriod.featureGrouped, totalSpend);
  var run = actRunRate(totalSpend, actOverviewPeriod.start, actOverviewPeriod.now, actOverviewPeriod.end);
  var tier = actHealthTier(run.projected, budgetAmount);
  var tierClass = tier === 'Critical' ? 'red' : (tier === 'Watch' ? 'amber' : (tier === 'On Track' ? 'green' : ''));

  // Top Cost Drivers (Section 4.3) — three different selection rules, by
  // design. All three fold from the same two already-fetched grouped
  // arrays (feature/product share one 'feature'-mode fetch).
  var featureGroups = actFoldFeatureGroups(actOverviewPeriod.featureGrouped);
  var prevFeatureGroups = actFoldFeatureGroups(actOverviewPeriod.prevFeatureGrouped);
  var topFeature = actTopBy(featureGroups, 'cost');
  var topFeatureDelta = topFeature ? actDeltaPct(topFeature.cost, (prevFeatureGroups[topFeature.key] || { cost: 0 }).cost) : null;

  var modelGroups = actFoldSimpleGroups(actOverviewPeriod.modelGrouped, 'Unknown');
  var prevModelGroups = actFoldSimpleGroups(actOverviewPeriod.prevModelGrouped, 'Unknown');
  var topModel = actTopBy(modelGroups, 'cost');
  var topModelDelta = topModel ? actDeltaPct(topModel.cost, (prevModelGroups[topModel.key] || { cost: 0 }).cost) : null;

  var productGroups = actFoldProductGroups(actOverviewPeriod.featureGrouped);
  var prevProductGroups = actFoldProductGroups(actOverviewPeriod.prevFeatureGrouped);
  var topGrowthProduct = null, topGrowthPct = -Infinity;
  Object.keys(productGroups).forEach(function (k) {
    if (k === '__unassigned__' || k === '__cross_product__') return;
    var curr = productGroups[k].cost, prev = (prevProductGroups[k] || { cost: 0 }).cost;
    var growth = prev > 0 ? ((curr - prev) / prev * 100) : (curr > 0 ? Infinity : -Infinity);
    if (growth > topGrowthPct) { topGrowthPct = growth; topGrowthProduct = productGroups[k]; }
  });

  // Needs Attention (Section 4.4)
  var opportunities = actOverviewPeriod.opportunities;
  var top1 = opportunities[0];
  var balancedFrontierShare = totalCalls ? (Number(summary.balanced_frontier_calls || 0) / totalCalls * 100) : 0;
  var prevBalancedFrontierShare = prevCalls ? (Number(prevSummary.balanced_frontier_calls || 0) / prevCalls * 100) : 0;
  var tierShiftPp = balancedFrontierShare - prevBalancedFrontierShare;
  var overallDeltaPct = actDeltaPct(totalSpend, prevSpend);

  var needsAttentionHtml = '';
  if (tier !== 'On Track' && tier !== 'Unknown') {
    var headline = (overallDeltaPct === null
        ? 'Spend has no comparable prior-period data yet'
        : 'Spend is running ' + Math.abs(Math.round(overallDeltaPct)) + '% above prior period’s pace') +
      (topFeature ? ', mainly because ' + actEsc(topFeature.key) + ' increased' : '') +
      (tierShiftPp > 5 ? ' and higher-tier model usage increased ' + tierShiftPp.toFixed(0) + ' percentage points' : '') + '.';
    var variance = run.projected - budgetAmount;
    needsAttentionHtml =
      '<div class="act-section-title">Needs Attention</div>' +
      '<div class="act-insight-card status-' + tierClass + '">' +
      '<span class="act-status-pill ' + tierClass + '"><span class="act-status-dot"></span>Needs Attention</span>' +
      '<div class="act-insight-headline">' + headline + '</div>' +
      '<div class="act-insight-support">At the current run rate, this period is projected to close around <b>' + actFmtUSD0(run.projected) + '</b> against a <b>' + actFmtUSD0(budgetAmount) + '</b> budget, ' + (variance >= 0 ? 'an overage of roughly <b>' + actFmtUSD0(variance) + '</b>.' : 'inside budget.') + '</div>' +
      (top1 ?
        '<div class="act-insight-rec"><div class="act-insight-rec-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z"/></svg></div>' +
        // "/month" is only accurate when the selected period is exactly one
        // calendar month — top1.savings is a raw sum over whatever rows the
        // period covers, not normalized to a monthly rate.
        '<div class="act-insight-rec-text"><b>Recommended:</b> ' + actEsc(top1.title) + '. ' + actEsc(top1.evidence) + (top1.type !== 3 ? ' Estimated savings opportunity: <b>' + actFmtUSD0(top1.savings) + (isSingleMonthPeriod ? '/month' : ' over the selected period') + '</b>.' : ' Measured gap: <b>' + actFmtUSD0(top1.savings) + '</b>.') + '</div></div>'
        : '') +
      '<table class="act-evidence-table"><thead><tr><th>Evidence</th><th>This Period</th><th>Prior Period</th><th>Change</th></tr></thead><tbody>' +
      '<tr><td>Total calls</td><td>' + actFmtNum(totalCalls) + '</td><td>' + actFmtNum(prevCalls) + '</td><td>' + actDeltaHtml(callsDelta) + '</td></tr>' +
      '<tr><td>Total tokens</td><td>' + actFmtTokens(inTok + outTok) + '</td><td>' + actFmtTokens(prevInTok + prevOutTok) + '</td><td>' + actDeltaHtml(actDeltaPct(inTok + outTok, prevInTok + prevOutTok)) + '</td></tr>' +
      '<tr><td>Balanced/frontier share of calls</td><td>' + actFmtPct(balancedFrontierShare, 0) + '</td><td>' + actFmtPct(prevBalancedFrontierShare, 0) + '</td><td>' + (tierShiftPp >= 0 ? '<span class="act-delta-up">+' + tierShiftPp.toFixed(0) + 'pt</span>' : '<span class="act-delta-down">' + tierShiftPp.toFixed(0) + 'pt</span>') + '</td></tr>' +
      (topFeature ? '<tr><td>' + actEsc(topFeature.key) + ' spend</td><td>' + actFmtUSD(topFeature.cost) + '</td><td>' + actFmtUSD((prevFeatureGroups[topFeature.key] || { cost: 0 }).cost) + '</td><td>' + actDeltaHtml(topFeatureDelta) + '</td></tr>' : '') +
      '</tbody></table>' +
      '<div class="act-evidence-note">Numbers are deterministic calculations from mt_ai_usage_events joined to effective-dated mt_model_pricing. Narrative wording is generated from these figures, not the other way around.</div>' +
      '</div>';
  }

  var html =
    '<div class="act-screen-header-row"><div class="act-screen-title-block"><div class="act-eyebrow">Overview</div><div class="act-screen-subtitle">Leadership glance: spend health, top drivers, budget risk, and evidence-backed recommendation.</div></div>' +
    '<div class="act-header-actions">' +
    '<div class="act-dropdown-chip-wrap"><button class="act-dropdown-chip" onclick="actToggleMenu(\'act-overview-period-menu\')" aria-haspopup="true"><span class="act-dropdown-chip-value" id="act-overview-period-value">' + actEsc(actOverviewPeriod.label) + '</span><svg class="act-chip-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg></button>' +
    '<div class="act-dropdown-chip-menu" id="act-overview-period-menu">' +
    '<button onclick="actSelectOverviewPeriodChip(\'this_month\',\'This Month\')">This Month</button>' +
    '<button onclick="actSelectOverviewPeriodChip(\'last_month\',\'Last Month\')">Last Month</button>' +
    '<button onclick="actSelectOverviewPeriodChip(\'last_3_months\',\'Last 3 Months\')">Last 3 Months</button>' +
    '<button onclick="actSelectOverviewPeriodChip(\'overall\',\'Overall\')">Overall</button>' +
    '<button onclick="actOpenOverviewCustomRangeModal()">Custom Range…</button>' +
    '</div></div>' +
    '<button class="export-cta-btn" id="act-export-overview-btn" onclick="actDownloadReport(\'overview\')"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg> Export</button>' +
    '</div></div>' +
    '<div id="act-export-overview-target">' +
    '<div id="act-export-overview-header" style="text-align:center;font-size:24px;font-weight:700;color:var(--t1);margin-bottom:16px;display:none;"></div>' +
    '<div class="act-section-title" style="margin-top:0;">At A Glance</div>' +
    '<div class="act-kpi-strip">' +
    '<div class="act-kpi health ' + (tier === 'Critical' ? 'critical' : tier === 'On Track' ? 'ok' : '') + '"><div class="act-kpi-label">Health</div><div class="act-kpi-value ' + tierClass + '">' + tier + '</div><div class="act-kpi-sub">' + (tier === 'On Track' ? 'Tracking within budget' : tier === 'Unknown' ? (!isSingleMonthPeriod ? 'Budget comparisons only apply to This Month/Last Month' : 'No active budget configured') : 'Projected over budget') + '</div></div>' +
    '<div class="act-kpi"><div class="act-kpi-label">Total Spend</div><div class="act-kpi-value">' + actFmtUSD0(totalSpend) + '</div><div class="act-kpi-delta">' + actDeltaHtml(spendDelta) + ' vs prior period</div></div>' +
    '<div class="act-kpi"><div class="act-kpi-label">Budget Used</div><div class="act-kpi-value ' + tierClass + '">' + (budgetUsedPct !== null ? actFmtPct(budgetUsedPct, 0) : '—') + '</div><div class="act-kpi-sub">' + actFmtUSD0(totalSpend) + ' of ' + (budgetAmount ? actFmtUSD0(budgetAmount) : (!isSingleMonthPeriod ? 'not applicable to this period' : 'no budget set')) + '</div></div>' +
    '<div class="act-kpi"><div class="act-kpi-label">Total Calls</div><div class="act-kpi-value">' + actFmtNum(totalCalls) + '</div><div class="act-kpi-delta">' + actDeltaHtml(callsDelta) + '</div></div>' +
    '<div class="act-kpi"><div class="act-kpi-label">Total Tokens</div><div class="act-kpi-value">' + actFmtTokens(inTok + outTok) + '</div><div class="act-kpi-sub">' + actFmtTokens(inTok) + ' input · ' + actFmtTokens(outTok) + ' output</div></div>' +
    '<div class="act-kpi"><div class="act-kpi-label">Avg Cost / Call</div><div class="act-kpi-value">' + actFmtUSD(avgCost) + '</div><div class="act-kpi-delta">' + actDeltaHtml(avgCostDelta) + '</div></div>' +
    '</div>' +
    '<div class="act-trust-mini">' +
    '<div class="act-trust-chip"><b>' + actFmtPct(pricingMatch, 1) + '</b>Pricing match rate</div>' +
    '<div class="act-trust-chip"><b>' + actFmtNum(unpricedCount) + '</b>Unpriced calls need pricing resolution</div>' +
    '<div class="act-trust-chip"><b>' + actFmtPct(attrib.pct, 0) + '</b>' + actFmtUSD0(attrib.dollars) + ' of spend has no product assigned</div>' +
    '</div>' +
    '<div class="act-section-title">Top Cost Drivers</div>' +
    '<div class="act-driver-grid">' +
    (topFeature ? '<div class="act-driver-card"><div class="act-driver-top"><span class="act-driver-tag">Feature</span>' + actDeltaHtml(topFeatureDelta) + '</div><div class="act-driver-title">' + actEsc(topFeature.key) + '</div><div class="act-driver-value">' + actFmtUSD0(topFeature.cost) + '</div><div class="act-driver-note">Highest feature spend this period.</div><div class="act-driver-link" onclick="actGoToBreakdown(\'feature\')">Open Cost Breakdown &rarr;</div></div>' : '') +
    (topModel ? '<div class="act-driver-card"><div class="act-driver-top"><span class="act-driver-tag">Model</span>' + actDeltaHtml(topModelDelta) + '</div><div class="act-driver-title">' + actEsc(topModel.key) + '</div><div class="act-driver-value">' + actFmtUSD0(topModel.cost) + '</div><div class="act-driver-note">Highest model spend this period.</div><div class="act-driver-link" onclick="actGoToBreakdown(\'model\')">Open Model View &rarr;</div></div>' : '') +
    (topGrowthProduct ? '<div class="act-driver-card"><div class="act-driver-top"><span class="act-driver-tag">Product</span>' + (isFinite(topGrowthPct) ? actDeltaHtml(topGrowthPct) : '<span class="act-delta-up">New</span>') + '</div><div class="act-driver-title">' + actEsc(actProductNameOf(topGrowthProduct.key)) + '</div><div class="act-driver-value">' + actFmtUSD0(topGrowthProduct.cost) + '</div><div class="act-driver-note">Fastest growing product spend this period.</div><div class="act-driver-link" onclick="actGoToBreakdown(\'product\')">Open Product View &rarr;</div></div>' : '') +
    '</div>' +
    actRenderCostByAgent(actOverviewPeriod.agentRows) +
    needsAttentionHtml +
    '<div class="act-section-title">Unassigned Spend</div>' +
    '<div class="act-unassigned-line"><div class="act-unassigned-left"><div class="act-unassigned-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/></svg></div>' +
    '<div><b>' + actFmtUSD0(attrib.dollars) + '</b>, about <b>' + actFmtPct(attrib.pct, 0) + '</b> of total spend this period, has no product attribution.</div></div>' +
    '<button class="act-btn act-btn-tertiary act-btn-sm" onclick="actGoToBreakdown(\'product\')">Investigate Attribution</button></div>' +
    '</div>';

  document.getElementById('act-scr-overview').innerHTML = html;
}

// ══════════════════════════════════════════════════════════════════════
// SCREEN 2: Cost Breakdown (spec Section 5)
// ══════════════════════════════════════════════════════════════════════

// Every "Group by" option prefetches together (feature/product share one
// 'feature'-mode fetch — both CASE branches in mt_ai_cost_grouped produce
// identical (caller, product_id) rows, so 'product' as a separate mode is
// never actually requested), so actSelectGroup() below stays a pure
// client-side re-render — no per-mode network round trip when switching.
var actBreakdown = {
  type: 'this_month', label: 'This Month', group: 'feature',
  summary: null, prevSummary: null,
  featureGrouped: [], prevFeatureGrouped: [],
  modelGrouped: [], prevModelGrouped: [],
  userGrouped: [], prevUserGrouped: [],
  promptGrouped: [], selectionGrouped: [], failurePhaseGrouped: [], unpricedDrillGrouped: [], varianceCauseGrouped: [],
  topCallsDuration: [], topCallsSize: [],
  explorerRows: [], explorerTotalCount: 0, explorerOffset: 0,
  traceSummaries: [], start: null, end: null
};

// Sequence guard against out-of-order resolution — same pattern as
// _actOverviewPeriodSeq/_actOutcomePeriodSeq. This screen predates those two
// but never got the guard when they were added; a stale, slower-resolving
// fetch could otherwise still overwrite a newer selection's already-committed
// data even though its own render would look correct at the time.
var _actBreakdownPeriodSeq = 0;

async function actSetBreakdownPeriod(type, customStart, customEnd) {
  actBreakdown.type = type;
  var mySeq = ++_actBreakdownPeriodSeq;
  var resolved = actResolvePeriodRange(type, customStart, customEnd);
  var range = resolved.range, prior = resolved.prior;
  var wantsTraceDetail = actIsGovernanceViewer();
  var fetches = [
    actFetchCostSummary(range.start, range.end),
    actFetchCostSummary(prior.start, prior.end),
    actFetchCostGrouped(range.start, range.end, 'feature'),
    actFetchCostGrouped(prior.start, prior.end, 'feature'),
    actFetchCostGrouped(range.start, range.end, 'model'),
    actFetchCostGrouped(prior.start, prior.end, 'model'),
    actFetchCostGrouped(range.start, range.end, 'user'),
    actFetchCostGrouped(prior.start, prior.end, 'user'),
    actFetchCostGrouped(range.start, range.end, 'prompt_version'),
    actFetchCostGrouped(range.start, range.end, 'selection_rule'),
    actFetchCostGrouped(range.start, range.end, 'failure_phase'),
    actFetchCostGrouped(range.start, range.end, 'unpriced_drill'),
    actFetchCostGrouped(range.start, range.end, 'variance_cause'),
    actFetchTopCalls(range.start, range.end, 'duration', 10, null),
    actFetchTopCalls(range.start, range.end, 'size', 10, null),
    // Request Explorer's flat table is the one place that still needs
    // individual rows — page 0 (most recent 1,000, ORDER BY
    // request_started_at DESC) loads with the rest of the screen;
    // actExplorerGoToPage() fetches further pages on demand.
    actFetchRows(range.start, range.end, 1000, 0)
  ];
  // Trace-layer widgets (By Trace toggle, By Conversation ranking, Failure
  // Cost's 2 new KPIs, Trace Explorer card) share this one fetch, per the
  // spec's sequencing note. Governance-gated server-side, so skipped
  // outright for a read-only viewer rather than issuing a call known to fail.
  if (wantsTraceDetail) fetches.push(actFetchTraceDetail(range.start, range.end));
  var results = await Promise.all(fetches);
  if (mySeq !== _actBreakdownPeriodSeq) return;
  actBreakdown.start = range.start; actBreakdown.end = range.end;
  actBreakdown.summary = results[0]; actBreakdown.prevSummary = results[1];
  actBreakdown.featureGrouped = results[2]; actBreakdown.prevFeatureGrouped = results[3];
  actBreakdown.modelGrouped = results[4]; actBreakdown.prevModelGrouped = results[5];
  actBreakdown.userGrouped = results[6]; actBreakdown.prevUserGrouped = results[7];
  actBreakdown.promptGrouped = results[8];
  actBreakdown.selectionGrouped = results[9];
  actBreakdown.failurePhaseGrouped = results[10];
  actBreakdown.unpricedDrillGrouped = results[11];
  actBreakdown.varianceCauseGrouped = results[12];
  actBreakdown.topCallsDuration = results[13];
  actBreakdown.topCallsSize = results[14];
  actBreakdown.explorerRows = results[15].rows;
  actBreakdown.explorerTotalCount = results[15].totalCount;
  actBreakdown.explorerOffset = 0;
  actBreakdown.traceSummaries = wantsTraceDetail ? actBuildTraceSummaries(results[16] || []) : [];
  actIndexTraceSpans(actBreakdown.traceSummaries);
  console.log('[Cost Tower] period=' + type, 'range=', range.start.toISOString(), '→', range.end.toISOString(), 'total_calls=', actBreakdown.summary ? actBreakdown.summary.total_calls : 0);
  actRenderCostBreakdown();
}

function actSelectPeriodChip(type, label) {
  actBreakdown.label = label;
  document.getElementById('act-period-menu').classList.remove('open');
  actSetBreakdownPeriod(type).catch(function (e) { console.error(e); });
}

function actOpenCustomRangeModal() {
  document.getElementById('act-period-menu').classList.remove('open');
  document.getElementById('act-modal-title').textContent = 'Custom Date Range';
  document.getElementById('act-modal-body').innerHTML =
    '<div class="act-config-grid">' +
    '<div class="act-field"><div class="act-field-label">From</div><input id="act-custom-from" type="date"></div>' +
    '<div class="act-field"><div class="act-field-label">To</div><input id="act-custom-to" type="date"></div>' +
    '</div>' +
    '<div style="margin-top:14px;color:var(--red);font-size:11px;" id="act-custom-range-error"></div>' +
    '<div style="margin-top:14px;display:flex;justify-content:flex-end;"><button class="act-btn act-btn-primary act-btn-sm" onclick="actApplyCustomRange()">Apply</button></div>';
  actShowModal();
}

async function actApplyCustomRange() {
  var fromVal = document.getElementById('act-custom-from').value;
  var toVal = document.getElementById('act-custom-to').value;
  var errEl = document.getElementById('act-custom-range-error');
  if (!fromVal || !toVal) { errEl.textContent = 'Choose both a start and end date.'; return; }
  var start = new Date(fromVal + 'T00:00:00');
  var end = new Date(new Date(toVal + 'T00:00:00').getTime() + 86400000); // exclusive upper bound = day after "To"
  if (start >= end) { errEl.textContent = 'Start date must be before end date.'; return; }
  errEl.textContent = '';
  actCloseModal();
  actBreakdown.label = fromVal + ' – ' + toVal;
  await actSetBreakdownPeriod('custom', start, end);
}

function actSelectGroup(group) {
  actBreakdown.group = group;
  var labels = { feature: 'Feature', product: 'Product', model: 'Model', user: 'User', prompt: 'Prompt Version' };
  var el = document.getElementById('act-group-value');
  if (el) el.textContent = labels[group];
  document.getElementById('act-group-menu').classList.remove('open');
  actRenderMainBreakdown();
}

var BREAKDOWN_INSIGHTS = {}; // populated per render from actual winning row

// Picks the already-prefetched grouped array for the active "Group by"
// mode and folds it to the label the table/insight actually displays —
// feature/product share one 'feature'-mode fetch (see actBreakdown's own
// comment), so this never triggers a new network round trip.
function actGroupsForMode(group) {
  if (group === 'feature') return { groups: actFoldFeatureGroups(actBreakdown.featureGrouped), prevGroups: actFoldFeatureGroups(actBreakdown.prevFeatureGrouped) };
  if (group === 'product') return { groups: actFoldProductGroups(actBreakdown.featureGrouped), prevGroups: actFoldProductGroups(actBreakdown.prevFeatureGrouped) };
  if (group === 'model') return { groups: actFoldSimpleGroups(actBreakdown.modelGrouped, 'Unknown'), prevGroups: actFoldSimpleGroups(actBreakdown.prevModelGrouped, 'Unknown') };
  if (group === 'user') return { groups: actFoldSimpleGroups(actBreakdown.userGrouped, '__unknown_user__'), prevGroups: actFoldSimpleGroups(actBreakdown.prevUserGrouped, '__unknown_user__') };
  if (group === 'prompt') return { groups: actFoldPromptGroups(actBreakdown.promptGrouped), prevGroups: {} }; // no trend column for this mode
  return { groups: {}, prevGroups: {} };
}

function actRenderMainBreakdown() {
  var group = actBreakdown.group;
  var folded = actGroupsForMode(group);
  var groups = folded.groups, prevGroups = folded.prevGroups;
  var totalCost = actBreakdown.summary ? Number(actBreakdown.summary.total_cost) : 0;
  var keys = Object.keys(groups).sort(function (a, b) { return groups[b].cost - groups[a].cost; });
  var top = keys.length ? groups[keys[0]] : null;

  var insight = 'No data for this period.';
  if (top) {
    var share = totalCost ? (top.cost / totalCost * 100) : 0;
    if (group === 'feature') insight = actEsc(top.key) + ' accounts for ' + share.toFixed(0) + '% of spend this period.';
    else if (group === 'product') insight = actEsc(top.key === '__unassigned__' ? 'Unassigned spend' : top.key === '__cross_product__' ? 'Cross-Product (Shared) spend' : actProductNameOf(top.key)) + ' leads at ' + actFmtUSD(top.cost) + ' (' + share.toFixed(0) + '% of spend) this period.';
    else if (group === 'model') insight = actEsc(top.key) + ' drives ' + share.toFixed(0) + '% of spend this period.';
    // '__unknown_user__' is not a real person — every /v1-ingested row with
    // no user_id merged together (see actComputeWhatIfData's identical
    // exclusion) — so it gets its own sentence rather than being named via
    // actUserNameOf() as if it were one real top user.
    else if (group === 'user' && top.key === '__unknown_user__') insight = 'Unknown accounts for ' + share.toFixed(0) + '% of spend this period — usage recorded with no individual user attached (e.g. via the OpenAPI Ingestion Layer), not one real top user.';
    else if (group === 'user') insight = actEsc(actUserNameOf(top.key)) + ' accounts for ' + share.toFixed(0) + '% of spend this period. This is an audit signal, not a leaderboard.';
    else if (group === 'prompt') insight = actEsc(top.key) + ' is the highest-cost prompt version cut this period.';
  }

  var maxCost = top ? top.cost : 1;
  var rowsHtml = keys.map(function (k) {
    var g = groups[k];
    var prevCost = (prevGroups[k] || { cost: 0 }).cost;
    var delta = actDeltaPct(g.cost, prevCost);
    var share = totalCost ? (g.cost / totalCost * 100) : 0;
    var barPct = maxCost ? Math.max(4, g.cost / maxCost * 100) : 0;
    var displayName = k === '__unassigned__' ? '<span class="act-cell-name">Unassigned</span><div class="act-cell-muted">No product_id</div>'
      : k === '__cross_product__' ? '<span class="act-cell-name">Cross-Product (Shared)</span><div class="act-cell-muted">Runs across every product</div>'
      : actEsc(group === 'product' ? actProductNameOf(k) : k);
    if (group === 'model') {
      var tierBadge = g.sampleTier ? '<span class="act-tag-status info">' + (TIER_LABEL[g.sampleTier] || g.sampleTier) + '</span>' : '<span class="act-cell-muted">Unpriced</span>';
      return '<tr><td class="act-cell-name">' + displayName + '</td><td>' + tierBadge + '</td><td>' + actFmtNum(g.calls) + '</td><td class="act-cell-bar"><div class="act-cell-bar-track"><div class="act-cell-bar-fill" style="width:' + barPct + '%"></div></div>' + share.toFixed(0) + '%</td><td class="act-cell-name">' + actFmtUSD(g.cost) + '</td><td>' + actDeltaHtml(delta) + '</td></tr>';
    }
    if (group === 'user') {
      var role = g.sampleUserRole || '—';
      return '<tr><td class="act-cell-name">' + (k === '__unknown_user__' ? 'Unknown' : actEsc(actUserNameOf(k))) + '</td><td>' + actEsc(role) + '</td><td>' + actFmtNum(g.calls) + '</td><td class="act-cell-bar"><div class="act-cell-bar-track"><div class="act-cell-bar-fill" style="width:' + barPct + '%"></div></div>' + share.toFixed(0) + '%</td><td class="act-cell-name">' + actFmtUSD(g.cost) + '</td></tr>';
    }
    if (group === 'prompt') {
      var failRate = g.calls ? (g.failed / g.calls * 100) : 0;
      var avgTok = g.calls ? (g.inputTok + g.outputTok) / g.calls : 0;
      var avgCost = g.calls ? g.cost / g.calls : 0;
      return '<tr><td class="act-cell-name">' + actEsc(k) + '</td><td>' + actFmtNum(g.calls) + '</td><td>' + actFmtNum(Math.round(avgTok)) + '</td><td>' + actFmtUSD(avgCost) + '</td><td><span class="act-tag-status ' + (failRate > 5 ? 'warn' : 'ok') + '">' + failRate.toFixed(1) + '%</span></td></tr>';
    }
    return '<tr><td class="act-cell-name">' + displayName + '</td><td>' + actFmtNum(g.calls) + '</td><td>' + actFmtTokens(g.inputTok + g.outputTok) + '</td><td class="act-cell-bar"><div class="act-cell-bar-track"><div class="act-cell-bar-fill" style="width:' + barPct + '%"></div></div>' + share.toFixed(0) + '%</td><td class="act-cell-name">' + actFmtUSD(g.cost) + '</td><td>' + actDeltaHtml(delta) + '</td></tr>';
  }).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--t4);padding:20px;">No calls logged in this period.</td></tr>';

  var headerRow = group === 'model' ? '<tr><th>Model</th><th>Tier</th><th>Calls</th><th>Cost Share</th><th>Cost</th><th>Trend</th></tr>' :
    group === 'user' ? '<tr><th>User</th><th>Role</th><th>Calls</th><th>Cost Share</th><th>Cost</th></tr>' :
    group === 'prompt' ? '<tr><th>Feature · Prompt Version</th><th>Calls</th><th>Avg Tokens / Call</th><th>Cost / Call</th><th>Failure Rate</th></tr>' :
    '<tr><th>' + (group === 'product' ? 'Product' : 'Feature') + '</th><th>Calls</th><th>Tokens</th><th>Cost Share</th><th>Cost</th><th>Trend</th></tr>';

  document.getElementById('act-main-breakdown-insight').textContent = insight;
  document.getElementById('act-main-breakdown-table').innerHTML = '<thead>' + headerRow + '</thead><tbody>' + rowsHtml + '</tbody>';
}

function actRenderCostBreakdown() {
  var summary = actBreakdown.summary || {};
  var totalCalls = Number(summary.total_calls || 0);
  var pricingMatch = totalCalls ? (Number(summary.priced_calls || 0) / totalCalls * 100) : null;
  var confClass = pricingMatch !== null && pricingMatch < PRICING_MATCH_LAUNCH_GATE_PCT ? 'warn' : '';
  var periodMenuOptions = [
    { type: 'this_month', label: 'This Month' },
    { type: 'last_month', label: 'Last Month' },
    { type: 'last_3_months', label: 'Last 3 Months' },
    { type: 'overall', label: 'Overall' }
  ];
  var periodMenuHtml = periodMenuOptions.map(function (o) {
    return '<button onclick="actSelectPeriodChip(\'' + o.type + '\',\'' + o.label + '\')">' + o.label + '</button>';
  }).join('') + '<button onclick="actOpenCustomRangeModal()">Custom Range…</button>';

  var html =
    '<div class="act-screen-header-row"><div class="act-screen-title-block"><div class="act-eyebrow">Cost Breakdown</div><div class="act-screen-subtitle">Investigate spend by feature, product, model, user, prompt version, selection path, failure, and data quality.</div></div>' +
    '<div class="act-header-actions">' +
    '<div class="act-dropdown-chip-wrap"><button class="act-dropdown-chip" onclick="actToggleMenu(\'act-period-menu\')" aria-haspopup="true"><span class="act-dropdown-chip-value" id="act-period-value">' + actEsc(actBreakdown.label) + '</span><svg class="act-chip-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg></button>' +
    '<div class="act-dropdown-chip-menu" id="act-period-menu">' + periodMenuHtml + '</div></div>' +
    '<button class="export-cta-btn" id="act-export-cost-btn" onclick="actDownloadReport(\'cost\')"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg> Export</button>' +
    '</div></div>' +
    '<div id="act-export-cost-target">' +
    '<div id="act-export-cost-header" style="text-align:center;font-size:24px;font-weight:700;color:var(--t1);margin-bottom:16px;display:none;"></div>' +
    '<div class="act-filter-toolbar-hint" style="margin:0 0 14px;">' + actFmtNum(totalCalls) + ' calls · <span class="act-confidence-pill ' + confClass + '" style="margin-left:4px;"><span class="act-confidence-dot"></span>Pricing match ' + actFmtPct(pricingMatch, 1) + '</span></span></div>' +
    '<div class="act-anchor-row">' +
    '<span class="act-anchor-chip" onclick="actScrollToSection(\'act-main-breakdown\')">Main Breakdown</span>' +
    '<span class="act-anchor-chip" onclick="actScrollToSection(\'act-economics-signals\')">Economics Signals</span>' +
    '<span class="act-anchor-chip" onclick="actScrollToSection(\'act-operational-signals\')">Operational Signals</span>' +
    '<span class="act-anchor-chip" onclick="actScrollToSection(\'act-trust-audit\')">Trust &amp; Audit</span>' +
    '</div>' +

    '<div id="act-main-breakdown" class="act-group-card"><div class="act-group-head"><div><div class="act-group-kicker">A. Main Breakdown</div><div class="act-group-title">Where cost is concentrated</div></div>' +
    '<div class="act-dropdown-chip-wrap"><button class="act-dropdown-chip" onclick="actToggleMenu(\'act-group-menu\')" aria-haspopup="true"><span class="act-dropdown-chip-label">Group by</span><span class="act-dropdown-chip-value" id="act-group-value">' + actEsc({ feature: 'Feature', product: 'Product', model: 'Model', user: 'User', prompt: 'Prompt Version' }[actBreakdown.group]) + '</span><svg class="act-chip-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg></button>' +
    '<div class="act-dropdown-chip-menu" id="act-group-menu">' +
    '<button onclick="actSelectGroup(\'feature\')">Feature</button><button onclick="actSelectGroup(\'product\')">Product</button><button onclick="actSelectGroup(\'model\')">Model</button><button onclick="actSelectGroup(\'user\')">User</button><button onclick="actSelectGroup(\'prompt\')">Prompt Version</button>' +
    '</div></div>' +
    '</div>' +
    '<div class="act-group-body"><div class="act-section-insight" id="act-main-breakdown-insight"></div><table class="act-data-table" id="act-main-breakdown-table"></table></div></div>' +

    '<div id="act-economics-signals" class="act-group-card"><div class="act-group-head"><div class="act-group-kicker">B. Economics Signals</div><div class="act-group-title">What may be driving cost behavior</div></div>' +
    '<div class="act-group-body">' + actRenderSelectionEconomics(actBreakdown.selectionGrouped) +
    '<div class="act-callout card"><div><b>Prompt version analysis:</b> use Group by: Prompt Version in the Main Breakdown above. Keeping it there avoids showing overlapping prompt-version tables with different slices of the same data.</div></div>' +
    '</div></div>' +

    '<div id="act-operational-signals" class="act-group-card"><div class="act-group-head"><div class="act-group-kicker">C. Operational Signals</div><div class="act-group-title">Failures, large calls, and cache readiness</div></div>' +
    '<div class="act-group-body"><div class="act-planning-grid">' + actRenderFailureCost(summary, actBreakdown.featureGrouped, actBreakdown.failurePhaseGrouped, actBreakdown.traceSummaries) + actRenderCacheUsage(summary) + '</div>' + actRenderLongestLargest(actBreakdown.topCallsDuration, actBreakdown.topCallsSize, actBreakdown.traceSummaries) + '</div></div>' +

    '<div id="act-trust-audit" class="act-group-card"><div class="act-group-head"><div class="act-group-kicker">D. Trust &amp; Audit</div><div class="act-group-title">Prove the cost numbers are reliable</div></div>' +
    '<div class="act-group-body">' + actRenderDataQuality(summary, actBreakdown.unpricedDrillGrouped, actBreakdown.varianceCauseGrouped) + actRenderRequestExplorer(actBreakdown.explorerRows, actBreakdown.explorerTotalCount, actBreakdown.explorerOffset, actBreakdown.traceSummaries) + actRenderTraceExplorer(actBreakdown.traceSummaries) + '</div></div>' +

    '<div class="act-foot-hint">Reporting period governs every section above except Trust &amp; Audit’s Request Explorer statement of scope. Timezone: browser-local.</div>' +
    '</div>';

  document.getElementById('act-scr-cost').innerHTML = html;
  actRenderMainBreakdown();
  actApplyExplorerFilter();
  actRenderLongestLargestBody();
  // Code-review fix: only build the By Trace view's HTML when it's the
  // active mode — it was previously rendered unconditionally into a
  // hidden div on every single Cost Breakdown render (every period
  // switch), work with zero visible benefit unless the toggle was opened.
  // actSetExplorerViewMode() renders it lazily on demand when switched to.
  if (actExplorerViewMode === 'trace') actRenderExplorerTraceView();
  actApplyTraceExplorerFilter();
}

function actRenderSelectionEconomics(groupedRows) {
  var groups = actFoldSimpleGroups(groupedRows, 'unknown');
  var keys = Object.keys(groups);
  var body = keys.length ? keys.map(function (k) {
    var g = groups[k];
    var avg = g.calls ? g.cost / g.calls : 0;
    var failRate = g.calls ? (g.failed / g.calls * 100) : 0;
    var label = SELECTION_RULE_LABELS[k] || k;
    return '<tr><td class="act-cell-name">' + actEsc(label) + '<div class="act-cell-muted">' + actEsc(k) + '</div></td><td>' + actFmtNum(g.calls) + '</td><td>' + actFmtUSD(avg) + '</td><td class="act-cell-name">' + actFmtUSD(g.cost) + '</td><td>' + failRate.toFixed(1) + '%</td></tr>';
  }).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--t4);padding:16px;">No data for this period.</td></tr>';
  return '<div class="act-scoped-card"><div class="act-section-title">Selection Economics</div>' +
    '<span class="act-section-caveat">Observed comparison, not a controlled experiment</span>' +
    '<div class="act-section-insight">Comparing cost, failure rate, and volume across how each call’s model was actually selected. This does not prove one path causes cheaper or more expensive outcomes — task complexity is not held constant across paths.</div>' +
    '<table class="act-data-table"><thead><tr><th>Selection Path</th><th>Calls</th><th>Avg Cost / Call</th><th>Total Cost</th><th>Failure Rate</th></tr></thead><tbody>' + body + '</tbody></table></div>';
}

function actRenderFailureCost(summary, featureGroupedRows, phaseGroupedRows, traceSummaries) {
  var totalCalls = Number(summary.total_calls || 0);
  var totalCost = Number(summary.total_cost || 0);
  var failCost = Number(summary.failed_cost || 0);
  var failRate = totalCalls ? (Number(summary.failed_calls || 0) / totalCalls * 100) : 0;
  var phaseGroups = actFoldSimpleGroups(phaseGroupedRows, 'unspecified');
  var topPhase = actTopBy(phaseGroups, 'cost');
  // 'Top Feature' ranks by FAILURE cost specifically (failedCost), not
  // total cost — actFoldFeatureGroups already carries failedCost per
  // feature from the same 'feature'-mode fetch Main Breakdown uses, so no
  // separate failed-rows-only fetch is needed.
  var featureGroups = actFoldFeatureGroups(featureGroupedRows);
  var topFeature = actTopBy(featureGroups, 'failedCost');
  // Code-review fix: actTopBy() picks the FIRST key when every candidate
  // ties (its `!best` branch), which every feature does at failedCost===0
  // in a period with zero failures — featureGroups is the full, unfiltered
  // grouping, not pre-filtered to failed rows the way the old client-side
  // actGroupSum(failed, ...) was. Without this guard, "Top Feature" showed
  // an arbitrary feature name instead of "—" whenever nothing had failed.
  if (topFeature && topFeature.failedCost <= 0) topFeature = null;

  // Items 3 (remaining-five-widgets spec) — 2 new conversation-level KPIs,
  // only for a governance viewer with trace data (mt_ai_trace_detail_list
  // is gated the same as the payload viewer) — the original 4-KPI strip is
  // unchanged for a read-only viewer rather than showing a half-locked card.
  var traceKpisHtml = '', gridCols = 4;
  if (actIsGovernanceViewer() && traceSummaries) {
    var traces = traceSummaries;
    // Code-review fix: match actFailedRows' own failure definition (error
    // OR timeout) — previously only 'error' counted here, undercounting
    // relative to the existing per-call Failure Cost KPIs on this same card.
    var withFailedSpan = traces.filter(function (t) { return t.spans.some(function (s) { return s.span_status === 'error' || s.span_status === 'timeout'; }); });
    var pctWithFailedSpan = traces.length ? (withFailedSpan.length / traces.length * 100) : null;
    // Denominator is ALL traces, not just withFailedSpan — matches the
    // prototype's own implied semantics (9% recovered sits alongside 12%
    // w/ ≥1 failed span, both out of the same total).
    var recovered = traces.filter(function (t) { return t.statusKind === 'recovered'; });
    var pctRecovered = traces.length ? (recovered.length / traces.length * 100) : null;
    var abandoned = traces.filter(function (t) { return t.statusKind === 'abandoned'; });
    var abandonedSpend = abandoned.reduce(function (s, t) { return s + t.totalCost; }, 0);
    gridCols = 6;
    traceKpisHtml =
      '<div class="act-kpi" style="background:var(--amber-pale);"><div class="act-kpi-label">Traces w/ &ge;1 Failed Span</div><div class="act-kpi-value">' + (pctWithFailedSpan !== null ? pctWithFailedSpan.toFixed(1) + '%' : '—') + '</div><div class="act-kpi-sub">' + (pctRecovered !== null ? 'a later span succeeded: ' + pctRecovered.toFixed(0) + '%' : 'no traces this period') + '</div></div>' +
      '<div class="act-kpi" style="background:var(--amber-pale);"><div class="act-kpi-label">Spend on Abandoned Traces</div><div class="act-kpi-value">' + actFmtUSD0(abandonedSpend) + '</div><div class="act-kpi-sub">last span errored, nothing after</div></div>';
  }

  return '<div class="act-scoped-card"><div class="act-section-title">Provider-Call Failure Cost</div>' +
    '<div class="act-kpi-strip" style="grid-template-columns:repeat(' + (gridCols === 6 ? 3 : 4) + ',1fr);">' +
    '<div class="act-kpi"><div class="act-kpi-label">Failure Cost</div><div class="act-kpi-value">' + actFmtUSD0(failCost) + '</div><div class="act-kpi-sub">' + (totalCost ? (failCost / totalCost * 100).toFixed(1) : '0') + '% of spend</div></div>' +
    '<div class="act-kpi"><div class="act-kpi-label">Failure Rate</div><div class="act-kpi-value">' + failRate.toFixed(1) + '%</div></div>' +
    '<div class="act-kpi"><div class="act-kpi-label">Top Phase</div><div class="act-kpi-value" style="font-size:13px;">' + (topPhase ? actEsc(topPhase.key) : '—') + '</div></div>' +
    '<div class="act-kpi"><div class="act-kpi-label">Top Feature</div><div class="act-kpi-value" style="font-size:13px;">' + (topFeature ? actEsc(topFeature.key) : '—') + '</div></div>' +
    traceKpisHtml +
    '</div><div class="act-scoped-card-note">Covers failed or timed-out provider calls only, not poor-quality successful outputs or user rework. Phase detail is limited today — every failed call currently logs the same phase, so Top Phase will not vary until that field carries more granularity.' +
    (gridCols === 6 ? ' The two conversation-level KPIs above reflect the AI Trace Layer’s current adoption (Requirement Agent only) — they undercount as more features adopt tracing, not because failures elsewhere aren’t happening.' : '') +
    '</div></div>';
}

// cache_eligible_input/cache_read_tokens/cache_savings are computed
// server-side by mt_ai_cost_summary using this exact same provider-
// conditional formula (Anthropic's input_tokens excludes cache reads —
// additive; OpenAI/Gemini's already includes them — see migration file
// Part B and sql/ai-cost-tower-cache-cost-fix.sql for the original
// per-row logic this mirrors).
function actRenderCacheUsage(summary) {
  var totalEligibleInput = Number(summary.cache_eligible_input || 0);
  var totalCacheRead = Number(summary.cache_read_tokens || 0);
  var savings = Number(summary.cache_savings || 0);
  var sharePct = totalEligibleInput > 0 ? (totalCacheRead / totalEligibleInput * 100) : null;
  var noteMsg = 'OpenAI and Gemini cache usage is tracked automatically. Anthropic prompt caching is not yet enabled — Anthropic calls will show zero cache reads until that ships separately.';
  if (totalCacheRead === 0) {
    return '<div class="act-scoped-card"><div class="act-section-title">Cache Usage</div>' +
      '<div class="act-empty-state"><div class="act-empty-state-title">No cache reads this period</div>' +
      '<div class="act-empty-state-sub">' + actEsc(noteMsg) + '</div></div></div>';
  }
  return '<div class="act-scoped-card"><div class="act-section-title">Cache Usage</div>' +
    '<div class="act-kpi-strip" style="grid-template-columns:repeat(2,1fr);">' +
    '<div class="act-kpi"><div class="act-kpi-label">Cache-Read Share of Input</div><div class="act-kpi-value">' + actFmtPct(sharePct) + '</div></div>' +
    '<div class="act-kpi"><div class="act-kpi-label">Estimated Cache Savings</div><div class="act-kpi-value">' + actFmtUSD(savings) + '</div></div>' +
    '</div><div class="act-scoped-card-note">' + actEsc(noteMsg) + '</div></div>';
}

// Item 2 (remaining-five-widgets spec) — "By Conversation" ranks whole
// traces instead of individual calls. Same top-10-longest + top-10-largest
// merge-and-cap-20 logic as the existing "By Call" view, re-aggregated
// over trace-level totals instead of per-call fields.
var actLongestLargestMode = 'call';
var actLongestLargestTopDuration = [];
var actLongestLargestTopSize = [];
var actLongestLargestTraces = [];

function actSetLongestLargestMode(mode) {
  actLongestLargestMode = mode;
  document.querySelectorAll('#act-longest-largest-toggle .act-view-toggle-btn').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-mode') === mode);
  });
  actRenderLongestLargestBody();
}

// topDuration/topSize are already the server's own top-10-by-duration and
// top-10-by-size (mt_ai_cost_top_calls, migration file Part D) — correct
// by construction, unlike sorting a client-fetched row array that could be
// silently missing the actual longest/largest call under the old row cap.
function actLongestLargestCallHtml(topDuration, topSize) {
  var seen = {}, combined = [];
  (topDuration || []).concat(topSize || []).forEach(function (r) {
    var key = r.request_started_at + '|' + r.caller + '|' + r.duration_ms;
    if (!seen[key]) { seen[key] = true; combined.push(r); }
  });
  combined = combined.slice(0, 20).sort(function (a, b) { return (b.duration_ms || 0) - (a.duration_ms || 0); });
  var featureCounts = {};
  combined.forEach(function (r) { var f = actFeatureOf(r.caller); featureCounts[f] = (featureCounts[f] || 0) + 1; });
  var topFeature = Object.keys(featureCounts).sort(function (a, b) { return featureCounts[b] - featureCounts[a]; })[0];
  // Code-review fix: this insight is rendered via textContent (actRenderLongestLargestBody), which
  // does not decode HTML entities the way the old innerHTML-based render did — actEsc() here would
  // double-escape (e.g. a literal "&amp;" shown instead of "&").
  var insight = topFeature ? topFeature + ' accounts for the most rows in the combined longest/largest set this period.' : 'No data for this period.';
  var rowsHtml = combined.map(function (r) {
    return '<tr><td>' + new Date(r.request_started_at).toLocaleString() + '</td><td class="act-cell-name">' + actEsc(actFeatureOf(r.caller)) + '</td><td>' + actEsc(actModelOf(r)) + '</td><td>' + ((r.duration_ms || 0) / 1000).toFixed(1) + 's</td><td>' + Math.round(((r.request_bytes || 0) + (r.response_bytes || 0)) / 1024) + ' KB</td><td><span class="act-tag-status ' + (r.status === 'success' ? 'ok' : 'bad') + '">' + actEsc(r.status) + '</span></td></tr>';
  }).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--t4);padding:16px;">No calls in this period.</td></tr>';
  return {
    insight: insight,
    head: '<tr><th>Time</th><th>Feature</th><th>Model</th><th>Duration</th><th>Payload Size</th><th>Status</th></tr>',
    body: rowsHtml
  };
}

function actLongestLargestConversationHtml(traces) {
  var longest = traces.slice().sort(function (a, b) { return b.totalDurationMs - a.totalDurationMs; }).slice(0, 10);
  var largest = traces.slice().sort(function (a, b) { return b.totalBytes - a.totalBytes; }).slice(0, 10);
  var seen = {}, combined = [];
  longest.concat(largest).forEach(function (t) {
    if (!seen[t.trace_id]) { seen[t.trace_id] = true; combined.push(t); }
  });
  combined = combined.slice(0, 20).sort(function (a, b) { return b.totalDurationMs - a.totalDurationMs; });
  var insight = combined.length ? 'Ranking whole conversations, not individual calls — a conversation with several quick calls can outrank a single slow call.' : 'No traced conversations in this period.';
  var rowsHtml = combined.map(function (t) {
    return '<tr><td>' + new Date(t.trace_started_at).toLocaleString() + '</td><td class="act-cell-name">' + actEsc(t.agent_name) + '</td><td>' + t.spanCount + '</td><td>' + (t.totalDurationMs / 1000).toFixed(1) + 's</td><td>' + Math.round(t.totalBytes / 1024) + ' KB</td><td>' + actTraceStatusPillHtml(t) + '</td></tr>';
  }).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--t4);padding:16px;">No traced conversations in this period.</td></tr>';
  return {
    insight: insight,
    head: '<tr><th>Started</th><th>Agent</th><th>Calls</th><th>Total Duration</th><th>Total Size</th><th>Outcome</th></tr>',
    body: rowsHtml
  };
}

function actRenderLongestLargestBody() {
  var insightEl = document.getElementById('act-longest-largest-insight');
  var headEl = document.getElementById('act-longest-largest-thead');
  var bodyEl = document.getElementById('act-longest-largest-tbody');
  if (!bodyEl) return;
  var result = actLongestLargestMode === 'conversation'
    ? actLongestLargestConversationHtml(actLongestLargestTraces)
    : actLongestLargestCallHtml(actLongestLargestTopDuration, actLongestLargestTopSize);
  if (insightEl) insightEl.textContent = result.insight;
  if (headEl) headEl.innerHTML = result.head;
  bodyEl.innerHTML = result.body;
}

function actRenderLongestLargest(topDuration, topSize, traceSummaries) {
  actLongestLargestTopDuration = topDuration;
  actLongestLargestTopSize = topSize;
  actLongestLargestTraces = traceSummaries || [];
  var toggleHtml = actIsGovernanceViewer()
    ? '<div class="act-view-toggle" id="act-longest-largest-toggle" style="margin-bottom:10px;">' +
      '<button class="act-view-toggle-btn ' + (actLongestLargestMode === 'call' ? 'active' : '') + '" data-mode="call" onclick="actSetLongestLargestMode(\'call\')">By Call</button>' +
      '<button class="act-view-toggle-btn ' + (actLongestLargestMode === 'conversation' ? 'active' : '') + '" data-mode="conversation" onclick="actSetLongestLargestMode(\'conversation\')">By Conversation</button>' +
      '</div>'
    : '';
  return '<div class="act-scoped-card"><div class="act-section-title">Longest and Largest Requests</div>' +
    toggleHtml +
    '<div class="act-section-insight" id="act-longest-largest-insight"></div>' +
    '<div style="max-height:340px;overflow-y:auto;"><table class="act-data-table"><thead id="act-longest-largest-thead"></thead><tbody id="act-longest-largest-tbody"></tbody></table></div></div>';
}

function actRenderDataQuality(summary, unpricedDrillGroupedRows, varianceCauseGroupedRows) {
  var totalCalls = Number(summary.total_calls || 0);
  var unpricedCount = Number(summary.unpriced_calls || 0);
  var pricingMatch = totalCalls ? (Number(summary.priced_calls || 0) / totalCalls * 100) : null;
  var nullTokenCount = Number(summary.null_token_calls || 0);
  var varianceCount = Number(summary.model_variance_calls || 0);
  var variancePct = totalCalls ? (varianceCount / totalCalls * 100) : 0;

  var unpricedGroups = actFoldGrouped(unpricedDrillGroupedRows, function (g) { return g.group_key1 + ' · ' + g.group_key2; });
  var unpricedKeys = Object.keys(unpricedGroups).sort(function (a, b) { return unpricedGroups[b].calls - unpricedGroups[a].calls; });
  var topUnpriced = unpricedKeys[0] ? unpricedGroups[unpricedKeys[0]] : null;

  var varianceGroups = actFoldSimpleGroups(varianceCauseGroupedRows, 'mixed');
  var dominantVarianceCause = null;
  Object.keys(varianceGroups).forEach(function (k) {
    if (varianceCount && varianceGroups[k].calls / varianceCount > 0.5) dominantVarianceCause = k;
  });

  var trustNote = topUnpriced
    ? actEsc(unpricedKeys[0]) + ' has the highest unpriced-call count this period (' + topUnpriced.calls + ' calls).'
    : 'No unpriced calls this period.';
  trustNote += ' ' + (dominantVarianceCause ? 'Model variance is mostly driven by ' + actEsc(dominantVarianceCause) + '.' : (varianceCount ? 'Model variance causes are mixed — no single pattern accounts for a clear majority.' : ''));

  var launchGateWarning = (pricingMatch !== null && pricingMatch < PRICING_MATCH_LAUNCH_GATE_PCT)
    ? '<div class="act-callout amber"><div><b>Launch gate:</b> Pricing Match Rate is below ' + PRICING_MATCH_LAUNCH_GATE_PCT + '%. Overview’s Total Spend figure for this period should be treated as provisional, not an unqualified number.</div></div>' : '';

  var drillRows = unpricedKeys.map(function (k) {
    var g = unpricedGroups[k];
    var first = g.firstSeen ? new Date(g.firstSeen).toLocaleDateString() : '—';
    var last = g.lastSeen ? new Date(g.lastSeen).toLocaleDateString() : '—';
    return '<tr><td>' + actEsc(k) + '</td><td>' + g.calls + '</td><td>' + first + '</td><td>' + last + '</td></tr>';
  }).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--t4);padding:12px;">No unpriced calls.</td></tr>';

  return '<div class="act-scoped-card"><div class="act-section-title">Data Quality and Trust</div>' +
    '<div class="act-section-insight">A cost tool that silently undercounts is worse than no cost tool.</div>' +
    '<div class="act-kpi-strip" style="grid-template-columns:repeat(4,1fr);margin-bottom:12px;">' +
    '<div class="act-kpi"><div class="act-kpi-label">Pricing Match Rate</div><div class="act-kpi-value green">' + actFmtPct(pricingMatch, 1) + '</div></div>' +
    '<div class="act-kpi"><div class="act-kpi-label">Unpriced Calls</div><div class="act-kpi-value amber">' + unpricedCount + '</div></div>' +
    '<div class="act-kpi"><div class="act-kpi-label">Null-Token Calls</div><div class="act-kpi-value">' + nullTokenCount + '</div></div>' +
    '<div class="act-kpi"><div class="act-kpi-label">Model Variance</div><div class="act-kpi-value">' + variancePct.toFixed(1) + '%</div><div class="act-kpi-sub">response ≠ requested</div></div>' +
    '</div>' + launchGateWarning +
    '<div class="act-callout amber"><div><b>Trust note:</b> ' + trustNote + '</div></div>' +
    '<div class="act-section-title" style="font-size:12px;margin:16px 0 6px;">Unpriced Calls Drill List</div>' +
    '<table class="act-data-table"><thead><tr><th>Provider · Requested → Response</th><th>Count</th><th>First Seen</th><th>Last Seen</th></tr></thead><tbody>' + drillRows + '</tbody></table>' +
    '</div>';
}

var EXPLORER_ROW_CAP = 300;
var actExplorerSourceRows = [];

// AI Trace Layer — Prompt & Response Payload Viewer (v9.34). Maps
// usage_event_id -> its full row object so the delegated click listener
// below can retrieve rowContext without closing over a per-render local
// variable (actExplorerRowHtml's `r` no longer exists once its returned
// string is injected via innerHTML). Reset every re-render inside
// actApplyExplorerFilter() so entries don't accumulate across a session.
var actExplorerPayloadRowById = Object.create(null);

// Hybrid model display (build-review decision): show the model that
// actually produced the response (what was billed) as the primary value —
// only when it differs from what was requested does a small badge reveal
// the original request, surfacing the rare fallback/substitution case this
// column exists for without cluttering the common case where they match.
function actExplorerModelCell(r) {
  var shown = r.response_model || r.requested_model || '—';
  if (r.requested_model && r.response_model && r.requested_model !== r.response_model) {
    return actEsc(shown) + ' <span class="act-tag-status warn" title="Requested: ' + actEsc(r.requested_model) + '">changed</span>';
  }
  return actEsc(shown);
}

function actExplorerRowHtml(r) {
  return '<tr><td>' + new Date(r.request_started_at).toLocaleString() + '</td><td class="act-cell-name">' + actEsc(actFeatureOf(r.caller)) + '</td><td>' + actEsc(r.provider || '—') + '</td><td>' + actExplorerModelCell(r) + '</td>' + actExplorerPromptCell(r) + '<td>' + actFmtNum((r.input_tokens || 0) + (r.output_tokens || 0)) + '</td><td>' + (actIsPriced(r) ? actFmtUSD(r.calculated_cost) : '—') + '</td><td><span class="act-tag-status ' + (r.status === 'success' ? 'ok' : 'bad') + '">' + actEsc(r.status) + '</span></td></tr>';
}

// Prompt column's inspect affordance (AI Trace Layer, v9.34). Replaces the
// prompt_version fallback this cell used to show — prompt_version is
// unpopulated in production today, and Nethaji decided the icon is a
// natural evolution of this column's intent rather than a shared cell.
// Active only for a caller who passes the governance check AND whose row
// carries a non-null usage_event_id (server-side NULL-masked for
// non-governance roles in mt_ai_cost_events_list, §5.1 of the payload-
// viewer spec) — the icon itself is a UX-layer hint only; the RPC behind
// it enforces access independently. Icon is active whenever the row is
// identifiable at all, not only when a payload is confirmed present — the
// modal (not this cell) resolves the actual payload state after the click,
// since the table's own data can't cheaply distinguish those cases without
// an extra round-trip per row.
function actExplorerPromptCell(r) {
  if (!actIsGovernanceViewer() || !r.usage_event_id) return '<td>—</td>';
  actExplorerPayloadRowById[String(r.usage_event_id)] = r;
  return '<td><button type="button" class="act-payload-btn" data-usage-event-id="' +
    actEsc(String(r.usage_event_id)) +
    '" aria-label="Inspect prompt and response">↗</button></td>';
}

// One delegated listener on the (already-existing) tbody, bound once per
// freshly-created <tbody> element — not one inline handler per row (`r` is
// a per-render local variable that no longer exists once actExplorerRowHtml's
// returned string is injected via innerHTML, so an inline onclick
// referencing it would throw ReferenceError on click).
function actBindExplorerPayloadClicks() {
  var body = document.getElementById('act-explorer-body');
  if (!body || body._payloadClickBound) return;
  body._payloadClickBound = true;
  body.addEventListener('click', function (event) {
    var target = event.target;
    // event.target can be a text node (nodeType !== 1) when the click lands
    // on the button's inner glyph rather than the button element itself —
    // text nodes have no .closest(), so walk up to the nearest element node
    // first.
    if (target && target.nodeType !== 1) target = target.parentElement;
    var btn = target && target.closest ? target.closest('.act-payload-btn') : null;
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    var id = btn.getAttribute('data-usage-event-id');
    var row = actExplorerPayloadRowById[id];
    if (!row) {
      actToast('Could not find payload row context.', 'error');
      return;
    }
    actOpenPayloadModal(id, row);
  });
}

// Inline per-column filters, applied client-side over the full period's
// fetched rows (not just whatever's currently displayed) — a period can
// hold thousands of rows, so filtering down to a specific one needs more
// than scrolling a 200-row cap.
function actApplyExplorerFilter() {
  var f = {
    feature: ((document.getElementById('act-exp-f-feature') || {}).value || '').trim().toLowerCase(),
    provider: ((document.getElementById('act-exp-f-provider') || {}).value || '').trim().toLowerCase(),
    status: ((document.getElementById('act-exp-f-status') || {}).value || '').trim().toLowerCase(),
    timeFrom: (document.getElementById('act-exp-f-time-from') || {}).value || '',
    timeTo: (document.getElementById('act-exp-f-time-to') || {}).value || ''
  };
  // Date-only filter (not a timestamp) — "From" means the start of that
  // calendar day, "To" means the end of it, so a whole day is included.
  var fromMs = f.timeFrom ? new Date(f.timeFrom + 'T00:00:00').getTime() : null;
  var toMs = f.timeTo ? new Date(f.timeTo + 'T23:59:59.999').getTime() : null;

  var filtered = actExplorerSourceRows.filter(function (r) {
    if (f.feature && actFeatureOf(r.caller).toLowerCase().indexOf(f.feature) === -1) return false;
    if (f.provider && (r.provider || '').toLowerCase().indexOf(f.provider) === -1) return false;
    if (f.status && r.status !== f.status) return false;
    var t = new Date(r.request_started_at).getTime();
    if (fromMs !== null && t < fromMs) return false;
    if (toMs !== null && t > toMs) return false;
    return true;
  }).sort(function (a, b) { return new Date(b.request_started_at) - new Date(a.request_started_at); });

  var shown = filtered.slice(0, EXPLORER_ROW_CAP);

  // Reset the payload row-lookup map before repopulating it via
  // actExplorerRowHtml -> actExplorerPromptCell — without this, entries
  // from every prior filter/date-range change accumulate indefinitely
  // across a long session. Not a security issue (the RPC behind the modal
  // enforces access independently of anything client-side) — state
  // hygiene only, but cheap to get right.
  actExplorerPayloadRowById = Object.create(null);

  // Also invalidate any payload fetch still in flight for a row that no
  // longer appears in this filtered view — without this, a slow response
  // for a row clicked before the filter changed could still pop the
  // payload modal open afterward, for a row the viewer has since moved
  // away from, even though no modal was open at the time to have masked
  // its arrival.
  actUiInvalidationSeq++;

  var body = document.getElementById('act-explorer-body');
  if (body) {
    body.innerHTML = shown.map(actExplorerRowHtml).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--t4);padding:16px;">No calls match these filters.</td></tr>';
    actBindExplorerPayloadClicks();
  }
  var countEl = document.getElementById('act-explorer-count');
  if (countEl) {
    var pageStart = actBreakdown.explorerOffset + 1;
    var pageEnd = actBreakdown.explorerOffset + actExplorerSourceRows.length;
    var pageNote = actBreakdown.explorerTotalCount > actExplorerSourceRows.length || actBreakdown.explorerOffset > 0
      ? ' · viewing rows ' + actFmtNum(pageStart) + '–' + actFmtNum(pageEnd) + ' of ' + actFmtNum(actBreakdown.explorerTotalCount) + ' total this period'
      : '';
    countEl.textContent = 'Showing ' + actFmtNum(shown.length) + ' of ' + actFmtNum(filtered.length) + ' matching calls in this page' + pageNote + '.';
  }
}

// Fetches the previous/next 1,000-row page (mt_ai_cost_events_list is
// ORDER BY request_started_at DESC — page 0 is the most recent 1,000).
// Re-renders the whole Cost Breakdown screen rather than patching just
// this widget's DOM — paging through the audit table is not a hot path,
// and a full re-render avoids partial-state bugs between this widget and
// its filters/inline listeners.
async function actExplorerGoToPage(delta) {
  // Code-review fix: reuses _actBreakdownPeriodSeq (the same guard
  // actSetBreakdownPeriod already checks) rather than leaving this the one
  // fetch chain on the screen with no race guard — a second page click
  // before the first resolves, or a period change while a page fetch is
  // in flight, must not let the stale response overwrite newer state.
  var mySeq = ++_actBreakdownPeriodSeq;
  var pageSize = 1000;
  var newOffset = Math.max(0, actBreakdown.explorerOffset + delta * pageSize);
  if (newOffset >= actBreakdown.explorerTotalCount && delta > 0) return;
  var result = await actFetchRows(actBreakdown.start, actBreakdown.end, pageSize, newOffset);
  if (mySeq !== _actBreakdownPeriodSeq) return;
  // A page past the true end (or a race with in-flight data change) can
  // return zero rows — mt_ai_cost_events_list's total_row_count window
  // column is then 0-over-an-empty-set, not the period's real total.
  // Preserve the last known-good total instead of letting the pager and
  // "N total this period" text collapse to 0.
  actBreakdown.explorerRows = result.rows;
  actBreakdown.explorerTotalCount = result.rows.length ? result.totalCount : actBreakdown.explorerTotalCount;
  actBreakdown.explorerOffset = newOffset;
  actRenderCostBreakdown();
}

// Item 1 (remaining-five-widgets spec) — "By Trace" toggle. Flat view is
// entirely unchanged; By Trace groups the same period's data via the
// shared trace-detail fetch (actBreakdown.traceSummaries), reusing
// actTraceGroupRowsHtml/actBindTraceGroupClicks (also used by the Trace
// Explorer card below) rather than a second implementation of the same
// expand/collapse + payload-icon behavior.
var actExplorerViewMode = 'flat';
var actExplorerTraceSummaries = [];

function actSetExplorerViewMode(mode) {
  actExplorerViewMode = mode;
  var flatWrap = document.getElementById('act-explorer-flat-wrap');
  var traceWrap = document.getElementById('act-explorer-trace-wrap');
  if (flatWrap) flatWrap.style.display = mode === 'flat' ? '' : 'none';
  if (traceWrap) traceWrap.style.display = mode === 'trace' ? '' : 'none';
  document.querySelectorAll('#act-explorer-view-toggle .act-view-toggle-btn').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-mode') === mode);
  });
  if (mode === 'trace') actRenderExplorerTraceView();
}

function actRenderExplorerTraceView() {
  var wrap = document.getElementById('act-explorer-trace-wrap');
  if (!wrap) return;
  var traces = actExplorerTraceSummaries;
  var rowsHtml = actTraceGroupRowsHtml(traces);
  wrap.innerHTML =
    '<div class="act-cell-muted" style="margin-bottom:6px;">' + actFmtNum(traces.length) + ' conversation' + (traces.length === 1 ? '' : 's') + ' this period (capped at the 100 most recent).</div>' +
    (rowsHtml ? '<div class="act-trace-group-list">' + rowsHtml + '</div>' : '<div class="act-empty-state"><div class="act-empty-state-title">No traced conversations in this period.</div></div>') +
    '<div class="act-scoped-card-note" style="margin-top:10px;">Only calls from features that have adopted the AI Trace Layer appear grouped here — today, that’s Requirement Agent only. Every other feature’s calls are still visible in Flat view, just not grouped into conversations yet.</div>';
  actBindTraceGroupClicks(wrap);
}

function actRenderRequestExplorer(rows, totalCount, offset, traceSummaries) {
  actExplorerSourceRows = rows;
  actExplorerTraceSummaries = traceSummaries || [];
  var toggleHtml = actIsGovernanceViewer()
    ? '<div class="act-view-toggle" id="act-explorer-view-toggle">' +
      '<button class="act-view-toggle-btn ' + (actExplorerViewMode === 'flat' ? 'active' : '') + '" data-mode="flat" onclick="actSetExplorerViewMode(\'flat\')">Flat</button>' +
      '<button class="act-view-toggle-btn ' + (actExplorerViewMode === 'trace' ? 'active' : '') + '" data-mode="trace" onclick="actSetExplorerViewMode(\'trace\')">By Trace</button>' +
      '</div>'
    : '';
  // Real server-side pagination (1,000 rows/page, ORDER BY
  // request_started_at DESC) — only rendered when the period holds more
  // than one page, so a small period looks exactly as it did before this
  // migration.
  var pagerHtml = totalCount > 1000
    ? '<div class="act-explorer-pager" style="display:flex;gap:8px;align-items:center;margin:0 0 8px;">' +
      '<button class="act-btn act-btn-secondary act-btn-sm" onclick="actExplorerGoToPage(-1)" ' + (offset <= 0 ? 'disabled' : '') + '>&larr; Newer 1,000</button>' +
      '<button class="act-btn act-btn-secondary act-btn-sm" onclick="actExplorerGoToPage(1)" ' + (offset + 1000 >= totalCount ? 'disabled' : '') + '>Older 1,000 &rarr;</button>' +
      '</div>'
    : '';
  return '<div class="act-scoped-card"><div class="act-section-title-row"><div class="act-section-title" style="margin:0;">Request Explorer</div>' + toggleHtml + '</div>' +
    '<div class="act-section-insight">Raw event-level audit table. Uses the reporting period only — intentionally ignores Main Breakdown’s Group By, since an audit view needs everything in the period, not a dimension-filtered slice. Filter any column below to narrow down a specific record.</div>' +
    pagerHtml +
    '<div id="act-explorer-flat-wrap"' + (actExplorerViewMode === 'flat' ? '' : ' style="display:none;"') + '>' +
    '<div class="act-cell-muted" id="act-explorer-count" style="margin-bottom:6px;"></div>' +
    '<div style="max-height:420px;overflow-y:auto;"><table class="act-data-table"><thead>' +
    '<tr><th>Time</th><th>Feature</th><th>Provider</th><th>Model</th><th>Prompt</th><th>Tokens</th><th>Cost</th><th>Status</th></tr>' +
    '<tr>' +
    '<th><div style="display:flex;flex-direction:column;gap:2px;"><input id="act-exp-f-time-from" type="date" title="From date" oninput="actApplyExplorerFilter()" style="width:100%;font-size:9px;padding:3px 4px;border:1px solid var(--divider);border-radius:4px;"><input id="act-exp-f-time-to" type="date" title="To date" oninput="actApplyExplorerFilter()" style="width:100%;font-size:9px;padding:3px 4px;border:1px solid var(--divider);border-radius:4px;"></div></th>' +
    '<th><input id="act-exp-f-feature" type="text" placeholder="Filter…" oninput="actApplyExplorerFilter()" style="width:100%;font-size:10px;padding:4px 6px;border:1px solid var(--divider);border-radius:4px;"></th>' +
    '<th><input id="act-exp-f-provider" type="text" placeholder="Filter…" oninput="actApplyExplorerFilter()" style="width:100%;font-size:10px;padding:4px 6px;border:1px solid var(--divider);border-radius:4px;"></th>' +
    '<th></th><th></th><th></th><th></th>' +
    '<th><select id="act-exp-f-status" onchange="actApplyExplorerFilter()" style="width:100%;font-size:10px;padding:4px 2px;border:1px solid var(--divider);border-radius:4px;"><option value="">All</option><option value="success">Success</option><option value="error">Error</option><option value="timeout">Timeout</option></select></th>' +
    '</tr>' +
    '</thead><tbody id="act-explorer-body"></tbody></table></div></div>' +
    '<div id="act-explorer-trace-wrap"' + (actExplorerViewMode === 'trace' ? '' : ' style="display:none;"') + '></div>' +
    '</div>';
}

// Item 5 (remaining-five-widgets spec) — Trace Explorer card. Placed next
// to Request Explorer (Decision 1: a card inside Cost Breakdown, not a new
// tab). Reuses actTraceGroupRowsHtml/actBindTraceGroupClicks — the same
// expand/collapse + payload-icon behavior as Item 1's By Trace toggle, and
// the same payload modal already shipped (actOpenPayloadModal) rather than
// a separate "Payload Inspector" surface.
var actTraceExplorerSummaries = [];
var actTraceExplorerFilter = { agent: '', status: '' };

function actApplyTraceExplorerFilter() {
  var body = document.getElementById('act-trace-explorer-body');
  if (!body) return;
  // Code-review fix: matches actApplyExplorerFilter's own race guard — a
  // payload icon clicked just before an agent/status filter change here
  // could otherwise still pop the modal open for a trace the viewer has
  // since filtered away from.
  actUiInvalidationSeq++;
  actTraceExplorerFilter.agent = ((document.getElementById('act-te-f-agent') || {}).value || '').trim().toLowerCase();
  actTraceExplorerFilter.status = (document.getElementById('act-te-f-status') || {}).value || '';
  var filtered = actTraceExplorerSummaries.filter(function (t) {
    if (actTraceExplorerFilter.agent && t.agent_name.toLowerCase().indexOf(actTraceExplorerFilter.agent) === -1) return false;
    if (actTraceExplorerFilter.status && t.statusKind !== actTraceExplorerFilter.status) return false;
    return true;
  });
  var rowsHtml = actTraceGroupRowsHtml(filtered);
  body.innerHTML = rowsHtml ? '<div class="act-trace-group-list">' + rowsHtml + '</div>'
    : '<div class="act-empty-state"><div class="act-empty-state-title">No traced conversations match these filters.</div></div>';
  actBindTraceGroupClicks(body);
  var countEl = document.getElementById('act-trace-explorer-count');
  if (countEl) countEl.textContent = 'Showing ' + actFmtNum(filtered.length) + ' of ' + actFmtNum(actTraceExplorerSummaries.length) + ' traced conversations this period (capped at the 100 most recent).';
}

function actRenderTraceExplorer(traceSummaries) {
  if (!actIsGovernanceViewer()) {
    return '<div class="act-scoped-card"><div class="act-section-title">Trace Explorer</div>' +
      '<div class="act-empty-state"><div class="act-empty-state-title">Admin or Power User access required</div>' +
      '<div class="act-empty-state-sub">Trace/span-level detail is gated the same as Request Explorer’s payload viewer.</div></div></div>';
  }
  actTraceExplorerSummaries = traceSummaries || [];
  return '<div class="act-scoped-card"><div class="act-section-title">Trace Explorer</div>' +
    '<div class="act-section-insight">Conversation-level drill-down — one row per trace, expand for its ordered spans. Filters below apply within this reporting period.</div>' +
    '<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">' +
    '<input id="act-te-f-agent" type="text" placeholder="Filter by agent…" oninput="actApplyTraceExplorerFilter()" style="font-size:11px;padding:6px 8px;border:1px solid var(--divider);border-radius:6px;flex:1;min-width:140px;">' +
    '<select id="act-te-f-status" onchange="actApplyTraceExplorerFilter()" style="font-size:11px;padding:6px 8px;border:1px solid var(--divider);border-radius:6px;">' +
    '<option value="">All statuses</option><option value="completed">Completed</option><option value="recovered">1 error span</option><option value="abandoned">Abandoned</option><option value="other">Other (e.g. timeout)</option>' +
    '</select></div>' +
    '<div class="act-cell-muted" id="act-trace-explorer-count" style="margin-bottom:6px;"></div>' +
    '<div id="act-trace-explorer-body"></div>' +
    '<div class="act-scoped-card-note" style="margin-top:10px;">Trace Explorer currently reflects Requirement Agent conversations only, since it’s the sole caller writing traces today — every other feature’s calls remain visible in Request Explorer, just not grouped into conversations yet.</div>' +
    '</div>';
}

// ══════════════════════════════════════════════════════════════════════
// SCREEN 3: AI Governance (spec Section 6)
// ══════════════════════════════════════════════════════════════════════

function actRenderPlan() {
  var summary = actMain.summary || {};
  var totalSpend = Number(summary.total_cost || 0);
  var run = actRunRate(totalSpend, actMain.start, actMain.now, actMain.end);
  var budgetAmount = actBudget ? Number(actBudget.amount) : null;
  var variance = budgetAmount !== null ? (run.projected - budgetAmount) : null;
  var whatIfData = actComputeWhatIfData(actMain.featureGrouped, actMain.userGrouped);

  var html =
    '<div class="act-screen-header-row"><div class="act-screen-title-block"><div class="act-eyebrow">AI Governance</div><div class="act-screen-subtitle">Track run rate against budget, act on optimization opportunities, and restrict or stop AI usage directly when needed.</div></div>' +
    '<button class="export-cta-btn" id="act-export-plan-btn" onclick="actDownloadReport(\'plan\')"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg> Export</button></div>' +
    '<div id="act-export-plan-target">' +
    '<div id="act-export-plan-header" style="text-align:center;font-size:24px;font-weight:700;color:var(--t1);margin-bottom:16px;display:none;"></div>' +
    actRenderBudgetBar() +
    '<div class="act-section-title" style="margin-top:20px;">Cost Governance</div>' +
    '<div class="act-section-insight">Not a statistical forecast yet. This is a straight run-rate projection from the current period’s pace.</div>' +
    '<div class="act-kpi-strip" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px;">' +
    '<div class="act-kpi"><div class="act-kpi-label">Spend This Month (MTD)</div><div class="act-kpi-value">' + actFmtUSD0(totalSpend) + '</div><div class="act-kpi-sub" style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--divider);">Total spent overall: <b>' + actFmtUSD0(actLifetimeSpendTotal) + '</b></div></div>' +
    '<div class="act-kpi"><div class="act-kpi-label">Daily Average</div><div class="act-kpi-value">' + actFmtUSD0(run.dailyAvg) + '</div><div class="act-kpi-sub">' + Math.round(run.daysElapsed) + ' days elapsed</div></div>' +
    '<div class="act-kpi"><div class="act-kpi-label">Projected Month-End</div><div class="act-kpi-value">' + actFmtUSD0(run.projected) + '</div></div>' +
    '<div class="act-kpi"><div class="act-kpi-label">Budget Variance</div><div class="act-kpi-value ' + (variance !== null && variance > 0 ? 'amber' : 'green') + '">' + (variance !== null ? (variance >= 0 ? '+' : '') + actFmtUSD0(variance) : '—') + '</div></div>' +
    '</div>' +
    actRenderCostControls(whatIfData) +
    '<div class="act-planning-grid" style="margin-top:20px;">' + actRenderRoleEconomics(actMain.userRoleGrouped) + actRenderAlertsCard() + '</div>' +
    actRenderOpportunities(actMain.opportunities, actMain.start, actMain.end) +
    actRenderOpportunityMatrix(actMain.featureGrouped) +
    '</div>';

  document.getElementById('act-scr-plan').innerHTML = html;
  window._actWhatIf = whatIfData;
}

function actRenderRoleEconomics(groupedRows) {
  var groups = actFoldSimpleGroups(groupedRows, 'Unknown');
  var keys = Object.keys(groups).sort(function (a, b) { return groups[b].calls - groups[a].calls; });
  var body = keys.map(function (k, idx) {
    var g = groups[k];
    var avg = g.calls ? g.cost / g.calls : 0;
    var signal = keys.length <= 1 ? 'Only Role' : (idx === 0 ? 'Highest' : (idx === keys.length - 1 ? 'Low' : 'Medium'));
    var rank = idx === 0 ? 'highest' : (idx === keys.length - 1 ? 'lowest' : 'middle');
    return '<tr><td class="act-cell-name">' + actEsc(k) + '</td><td>' + actFmtUSD(avg) + '</td><td>' + signal + '</td><td>' + actFmtNum(g.calls) + ' calls; ' + rank + '-volume role this period.</td></tr>';
  }).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--t4);padding:16px;">No data for this period.</td></tr>';
  return '<div class="act-scoped-card"><div class="act-section-title">Role-Based Unit Economics</div><table class="act-data-table"><thead><tr><th>Role</th><th>Avg Cost / Call</th><th>Volume Signal</th><th>Planning Note</th></tr></thead><tbody>' + body + '</tbody></table></div>';
}

function actPercentile(values, p) {
  if (!values.length) return null;
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  var idx = (p / 100) * (sorted.length - 1);
  var lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Computes the What-If percentile inputs separately from rendering — the
// resulting data is applied to window._actWhatIf, and actUpdateWhatIf() is
// invoked only when the admin clicks the "Simulate" button (actRenderPlan()
// no longer auto-calls it after the innerHTML swap — Projected Add-On starts
// blank until Simulate runs). A <script> tag embedded via innerHTML never
// executes anyway (a DOM/HTML spec behavior, not a bug in this app) — this
// must NOT be reintroduced as an inline <script> inside the returned HTML string.
function actComputeWhatIfData(featureGroupedRows, userGroupedRows) {
  var productGroups = actFoldProductGroups(featureGroupedRows);
  var productCosts = Object.keys(productGroups).filter(function (k) { return k !== '__unassigned__' && k !== '__cross_product__'; }).map(function (k) { return productGroups[k].cost; });
  var userGroups = actFoldSimpleGroups(userGroupedRows, '__unknown__');
  // '__unknown__' bucket excluded from the percentile inputs — it's not one
  // user, it's every /v1-ingested row with no user_id merged together
  // (mt_ai_usage_events.user_id is nullable for the OpenAPI Ingestion Layer;
  // previously unreachable when the column was NOT NULL). Treating that
  // merged total as a single per-user data point would skew uLow/uHigh
  // toward whatever this synthetic bucket's total happens to be, rather
  // than reflecting the real per-user distribution this projection means
  // to estimate.
  var userCosts = Object.keys(userGroups).filter(function (k) { return k !== '__unknown__'; }).map(function (k) { return userGroups[k].cost; });
  var enoughProducts = productCosts.length >= 2, enoughUsers = userCosts.length >= 2;
  return {
    pLow: enoughProducts ? actPercentile(productCosts, 25) : null,
    pHigh: enoughProducts ? actPercentile(productCosts, 75) : null,
    uLow: enoughUsers ? actPercentile(userCosts, 25) : null,
    uHigh: enoughUsers ? actPercentile(userCosts, 75) : null,
    enough: enoughProducts && enoughUsers
  };
}

function actRenderWhatIf(whatIfData) {
  var warn = !whatIfData.enough ? '<div class="act-scoped-card-note" style="color:var(--amber);">Too few existing products or users this period to derive a meaningful percentile range — shown once more data accumulates.</div>' : '';
  return '<div class="act-scoped-card"><div class="act-section-title">What-If Scenario</div>' +
    '<div class="act-config-grid">' +
    '<div class="act-field"><div class="act-field-label">Additional Products</div><input id="act-whatif-products" type="number" min="0" value="1"></div>' +
    '<div class="act-field"><div class="act-field-label">Additional Users</div><input id="act-whatif-users" type="number" min="0" value="5"></div>' +
    '<div class="act-field"><div class="act-field-label">Usage Intensity</div><select id="act-whatif-intensity"><option value="1">Current Mix</option><option value="0.7">Low</option><option value="1.35">High</option></select></div>' +
    '<div class="act-field"><div class="act-field-label">Projected Add-On <span class="act-computed-tag">(computed)</span></div><input id="act-whatif-output" type="text" value="—" readonly aria-readonly="true"></div>' +
    '</div>' + warn +
    '<div class="act-scoped-card-note">Percentiles are recomputed from this period’s actual per-product and per-user spend each time this screen loads, not hardcoded.</div>' +
    '<div class="act-config-footer"><button class="act-btn act-btn-primary act-btn-sm" onclick="actUpdateWhatIf()">Simulate</button></div>' +
    '</div>';
}

function actUpdateWhatIf() {
  var w = window._actWhatIf;
  var out = document.getElementById('act-whatif-output');
  if (!w || !out) return;
  if (!w.enough) { out.value = 'Not enough data yet'; return; }
  var products = Math.max(0, Number((document.getElementById('act-whatif-products') || {}).value || 0));
  var users = Math.max(0, Number((document.getElementById('act-whatif-users') || {}).value || 0));
  var intensity = Number((document.getElementById('act-whatif-intensity') || {}).value || 1);
  var low = (products * w.pLow + users * w.uLow) * intensity;
  var high = (products * w.pHigh + users * w.uHigh) * intensity;
  out.value = actFmtUSD0(low) + ' - ' + actFmtUSD0(high);
}

function actRenderOpportunities(opps, periodStart, periodEnd) {
  window._actOppData = opps;
  window._actOppPeriod = { start: periodStart, end: periodEnd };
  var cards = opps.map(function (opp, idx) {
    var rankTag = '<span class="act-opp-rank">#' + (idx + 1) + (opp.type === 3 ? ' · Governance' : '') + '</span>';
    var amountHtml = opp.type === 3
      ? '<div class="act-opp-gap">' + actFmtUSD0(opp.savings) + ' attribution gap</div><div class="act-opp-sub">not counted as savings until attribution is fixed</div>'
      : '<div class="act-opp-savings">' + actFmtUSD0(opp.savings) + '/mo</div><div class="act-opp-sub">estimated ' + (opp.type === 1 ? 'savings opportunity' : 'avoidable spend') + '</div>';
    var meta = opp.confidence
      ? '<span class="act-opp-chip ' + (opp.confidence === 'High' ? 'ok' : opp.confidence === 'Low' ? 'warn' : '') + '">' + opp.confidence + ' confidence</span>'
      : '<span class="act-opp-chip">Measured, not estimated — no confidence factor applies</span>';
    var action = opp.type === 1
      ? '<button class="act-btn act-btn-secondary act-btn-sm" onclick="actOpenOppModal(' + idx + ')">View Supporting Calls</button>'
      : opp.type === 2
      ? '<button class="act-btn act-btn-secondary act-btn-sm" onclick="actGoToBreakdown(\'prompt\')">Open Prompt View</button>'
      : '<button class="act-btn act-btn-secondary act-btn-sm" onclick="actGoToBreakdown(\'product\')">Investigate</button>';
    return '<div class="act-opp-card"><div class="act-opp-head"><div class="act-opp-title">' + actEsc(opp.title) + '</div>' + rankTag + '</div>' +
      amountHtml + '<div class="act-opp-evidence">' + actEsc(opp.evidence) + '</div>' +
      '<div class="act-opp-meta">' + meta + '</div><div class="act-opp-action">' + action + '</div></div>';
  }).join('') || '<div class="act-empty-state"><div class="act-empty-state-title">No opportunities identified this period.</div></div>';

  return '<div class="act-section-title-row"><div><div class="act-section-title">Top Optimization Opportunities</div>' +
    '<div class="act-section-insight" style="margin-bottom:0;">Ranked by estimated dollar impact, not a normalized score — v1 has no distribution of past scores to normalize against yet.</div></div></div>' +
    '<div class="act-opportunity-grid">' + cards + '</div>';
}

// Async — supportingCalls is no longer pre-computed (mt_ai_cost_opportunities
// doesn't return per-call detail, only the winning feature/segment stats);
// this fetches mt_ai_cost_opportunity_supporting_calls on demand when the
// modal opens, scoped to the SAME period the opportunities card used
// (window._actOppPeriod, set by actRenderOpportunities()).
async function actOpenOppModal(idx) {
  var opp = (window._actOppData || [])[idx];
  var period = window._actOppPeriod;
  if (!opp || opp.type !== 1 || !period) return;
  document.getElementById('act-modal-title').textContent = 'Supporting Calls: ' + opp.title;
  document.getElementById('act-modal-body').innerHTML = '<div class="act-section-insight">Loading…</div>';
  actShowModal();
  // Code-review fix: captured AFTER actShowModal() (which already bumps
  // actUiInvalidationSeq on open) — same race-guard pattern
  // actOpenPayloadModal uses, so a double-click, a close, or opening a
  // different opportunity's modal before this fetch resolves discards the
  // stale response instead of overwriting newer modal content.
  var seq = actUiInvalidationSeq;
  var calls = await actFetchOpportunitySupportingCalls(period.start, period.end, opp.feature, 5);
  if (seq !== actUiInvalidationSeq) return;
  var rowsHtml = calls.map(function (r) {
    return '<tr><td>' + new Date(r.request_started_at).toLocaleTimeString() + '</td><td>' + Math.round((r.request_bytes || 0) / 1024) + ' KB</td><td>' + ((r.duration_ms || 0) / 1000).toFixed(1) + 's</td><td>' + (TIER_LABEL[r.tier] || 'Untiered') + '</td><td>' + actFmtUSD(r.calculated_cost) + '</td></tr>';
  }).join('');
  document.getElementById('act-modal-body').innerHTML =
    '<div class="act-section-insight" style="margin-bottom:10px;">Up to 5 example calls from the actual qualifying segment this period.</div>' +
    '<table class="act-data-table"><thead><tr><th>Time</th><th>Request Size</th><th>Duration</th><th>Current Tier</th><th>Actual Cost</th></tr></thead><tbody>' + rowsHtml + '</tbody></table>' +
    '<div class="act-scoped-card-note">The estimate is based on the full qualifying segment (' + opp.segmentCount + ' calls this period), not these rows alone.</div>';
}

// Shared modal show/hide — adds the focus trap and capture-phase Escape
// handler DESIGN_SYSTEM.md's Modal Construction Standard requires (§8),
// which the two callers above previously skipped by toggling the overlay
// classes directly. Self-contained rather than loading utils.js's
// trapFocus() (this page is deliberately standalone), but follows the same
// contract: trap Tab/Shift+Tab inside the dialog, close on Escape, and
// clean up both listeners when the modal closes.
var _actModalFocusCleanup = null;
function _actModalEscHandler(ev) {
  if (ev.key === 'Escape') actCloseModal();
}
// General-purpose "invalidate any pending async UI update" counter — not
// owned by any one feature. Any code that fetches data and later mutates
// the DOM based on the response should capture this value before
// awaiting and compare after, abandoning a stale response if it no
// longer matches. actShowModal()/actCloseModal() bump it below (any
// modal open/close invalidates a pending fetch elsewhere), and
// actApplyExplorerFilter() bumps it too (a filter/date-range change
// invalidates a payload fetch for a row the viewer has since filtered
// away from). Currently consumed by actOpenPayloadModal; a future
// second async-then-render feature should reuse this counter rather
// than invent its own.
var actUiInvalidationSeq = 0;
function _actTrapFocus(container) {
  var focusable = container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (!focusable.length) return null;
  var first = focusable[0], last = focusable[focusable.length - 1];
  first.focus();
  function handleTab(ev) {
    if (ev.key !== 'Tab') return;
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  }
  container.addEventListener('keydown', handleTab);
  return function () { container.removeEventListener('keydown', handleTab); };
}
function actShowModal() {
  actUiInvalidationSeq++; // any modal opening invalidates a still-in-flight async fetch — see below
  document.getElementById('act-modal-overlay').classList.add('open');
  var box = document.getElementById('act-modal-box');
  box.classList.add('open');
  document.addEventListener('keydown', _actModalEscHandler, true);
  if (_actModalFocusCleanup) _actModalFocusCleanup();
  _actModalFocusCleanup = _actTrapFocus(box);
}
function actCloseModal() {
  actUiInvalidationSeq++; // ditto — closing the shared modal also invalidates it
  document.getElementById('act-modal-overlay').classList.remove('open');
  var box = document.getElementById('act-modal-box');
  box.classList.remove('open');
  // Remove actOpenSwitchAppModal()'s size/position modifier so the next
  // modal opened (Custom Date Range, Supporting Calls, etc.) falls back to
  // its own default 600px/vertically-centered CSS, not this one's leftover.
  box.classList.remove('act-modal-compact');
  document.removeEventListener('keydown', _actModalEscHandler, true);
  if (_actModalFocusCleanup) { _actModalFocusCleanup(); _actModalFocusCleanup = null; }
}

// ══════════════════════════════════════════════════════════════════════
// AI Trace Layer — Prompt & Response Payload Viewer (v9.34). Reuses the
// shared #act-modal-overlay/#act-modal-box (actShowModal/actCloseModal
// above) rather than building separate modal chrome — same pattern as
// actOpenSwitchAppModal/actOpenCustomRangeModal/actOpenOppModal, all of
// which already populate #act-modal-title/#act-modal-body and call
// actShowModal(). Reached from Request Explorer's delegated click listener
// (actBindExplorerPayloadClicks, above actExplorerRowHtml).
// ══════════════════════════════════════════════════════════════════════

// actUiInvalidationSeq (declared above, alongside actShowModal/actCloseModal)
// is bumped by those two functions and by actApplyExplorerFilter() too —
// this guard invalidates a still-in-flight payload fetch whenever the user
// closes this modal, opens ANY other modal (Custom Date Range, Supporting
// Calls, a second payload lookup), or changes a Request Explorer filter/
// date field before the RPC resolves — not only a second payload click.
var MAX_PAYLOAD_PREVIEW_BYTES = 500000;
var MAX_PAYLOAD_PREVIEW_CHARS = 500000;

// Pre-fetch size gate — runs before any RPC call or JSON.stringify. Uses
// rowContext's own request_bytes/response_bytes (already part of
// mt_ai_cost_events_list's return shape) as a cheap proxy for serialized
// payload size, so an oversized payload never reaches JSON.stringify at
// all, rather than being stringified and then checked.
function actPayloadPreviewTooLarge(rowContext) {
  var reqBytes = Number((rowContext && rowContext.request_bytes) || 0);
  var resBytes = Number((rowContext && rowContext.response_bytes) || 0);
  return (reqBytes + resBytes) > MAX_PAYLOAD_PREVIEW_BYTES;
}

// Secondary guard only — the primary guard is actPayloadPreviewTooLarge()
// above. This one still calls JSON.stringify, so it does not by itself
// prevent a freeze; it exists only for the residual case where
// request_bytes/response_bytes undersell the actual serialized size.
function actStringifyPayloadForPreview(value) {
  var text;
  try { text = JSON.stringify(value, null, 2); }
  catch (e) { return '[Unable to render payload JSON]'; }
  if (text.length <= MAX_PAYLOAD_PREVIEW_CHARS) return text;
  return text.slice(0, MAX_PAYLOAD_PREVIEW_CHARS) +
    '\n\n… Payload preview truncated. Full payload is larger than the safe browser-rendering limit.';
}

function actPayloadGateStripHtml() {
  return '<div class="act-payload-gate-strip">🔒 Visible to Admin and Power User — raw call content, distinct from the rest of this table’s metadata-level access.</div>';
}

async function actOpenPayloadModal(usageEventId, rowContext) {
  var seq = ++actUiInvalidationSeq;

  // Gate before the RPC call and before any JSON handling — an oversized
  // payload is rejected here without ever being fetched or stringified.
  if (actPayloadPreviewTooLarge(rowContext)) {
    actRenderPayloadTooLargeModal();
    return;
  }

  var result;
  try {
    var client = authInit();
    // supabase-js RPC calls return { data, error } — they do not throw for
    // a normal SQL exception. Deliberately not using .single()/.maybeSingle():
    // both would collapse the "no payload row" state (a normal, common,
    // non-error outcome) into the same code path as a genuine
    // authorization/network failure. Wrapped in try/catch (matching
    // actLoadBudgetAndAlerts/actLoadProductNames elsewhere in this file)
    // since this is reached directly from a click handler with no outer
    // try/catch of its own — an actual thrown exception (network drop,
    // client-library error), not just a populated `error`, must still
    // surface a toast instead of an unhandled rejection.
    result = await client.rpc('mt_ai_trace_payload_get', {
      p_company_id: actCompanyId,
      p_app_id: actAppId,
      p_usage_event_id: usageEventId
    });
  } catch (e) {
    console.error('[Cost Tower] mt_ai_trace_payload_get exception:', e);
    if (seq === actUiInvalidationSeq) actToast('Could not load payload data for this call.', 'error');
    return;
  }

  // Race guard: if the user closed this modal, opened a different one,
  // changed a Request Explorer filter, or clicked a different row while
  // this request was in flight, actUiInvalidationSeq has since changed —
  // abandon this stale response rather than overwrite whatever state is
  // now current.
  if (seq !== actUiInvalidationSeq) return;

  if (result.error) {
    console.error('[Cost Tower] mt_ai_trace_payload_get failed:', result.error.message);
    actToast('Could not load payload data for this call.', 'error');
    return;
  }

  var data = result.data;
  // Unexpected-shape guard: do not silently coerce a non-array response
  // into an empty array — that would misreport an integration bug as the
  // ordinary "no payload captured" product state.
  if (!Array.isArray(data)) {
    console.error('[Cost Tower] Unexpected mt_ai_trace_payload_get response shape:', data);
    actToast('Could not load payload data for this call.', 'error');
    return;
  }

  if (data.length === 0) {
    // Zero rows with no error is the normal, expected "no payload
    // captured" outcome — not an error, must not toast.
    actRenderNoPayloadModal();
    return;
  }

  if (data.length > 1) {
    // Should be structurally impossible — mt_ai_trace_payloads.usage_event_id
    // is UNIQUE — but a defensive check costs nothing and a silent
    // "pick the first row" would hide a real data problem if this
    // invariant is ever violated by a future schema change.
    actToast('Unexpected duplicate payload records for this call.', 'error');
    return;
  }

  var payload = data[0];
  if (payload.request_payload == null && payload.response_payload == null) {
    actRenderEmptyPayloadRecordModal(payload);
    return;
  }

  actRenderPayloadModal(payload, rowContext);
}

function actRenderNoPayloadModal() {
  document.getElementById('act-modal-title').textContent = 'No Payload Captured';
  document.getElementById('act-modal-body').innerHTML =
    '<div class="act-scoped-card-note" style="margin:0 0 14px;">No payload was captured for this call — either this feature isn’t yet on the AI Trace Layer, or the call predates payload capture being enabled, or capture was gated off for this app at the time.</div>' +
    actPayloadGateStripHtml();
  actShowModal();
}

function actRenderEmptyPayloadRecordModal(payload) {
  document.getElementById('act-modal-title').textContent = 'Prompt & Response';
  document.getElementById('act-modal-body').innerHTML =
    '<div class="act-scoped-card-note" style="margin:0 0 6px;">A payload record exists for this call, but it doesn’t contain any prompt or response content.</div>' +
    '<div class="act-payload-id-note">Payload ID: ' + actEsc(payload.payload_id) + '</div>' +
    '<div style="margin-top:14px;">' + actPayloadGateStripHtml() + '</div>';
  actShowModal();
}

function actRenderPayloadTooLargeModal() {
  document.getElementById('act-modal-title').textContent = 'Prompt & Response';
  document.getElementById('act-modal-body').innerHTML =
    '<div class="act-scoped-card-note" style="margin:0 0 14px;">This call’s payload is too large to preview safely in the browser (over ' + actFmtNum(MAX_PAYLOAD_PREVIEW_BYTES) + ' bytes combined). It was not fetched.</div>' +
    actPayloadGateStripHtml();
  actShowModal();
}

// Found-with-content states (payload found with both/either side present,
// optionally past its retention window). Mandatory rendering rule: the
// request_payload/response_payload content itself is assigned via
// textContent, never innerHTML — this content originates from end-user
// and model text, is untrusted, and interpolating it into innerHTML would
// be an avoidable stored-XSS vector inside this modal. Everything else in
// this modal (labels, notes, gate strip) may continue to use this file's
// existing innerHTML-based construction pattern.
function actRenderPayloadModal(payload, rowContext) {
  document.getElementById('act-modal-title').textContent = 'Prompt & Response';
  var hasReq = payload.request_payload != null;
  var hasRes = payload.response_payload != null;
  var reqBadge = (hasReq && rowContext && rowContext.input_tokens != null)
    ? ' <span class="act-payload-block-badge">' + actFmtNum(rowContext.input_tokens) + ' tokens</span>'
    : '';
  var expiredNote = payload.is_expired
    ? '<div class="act-payload-expired-note">This payload passed its 90-day retention window on ' +
        actEsc(new Date(payload.expires_at).toLocaleDateString()) +
        ' — it’s still viewable because the cleanup process hasn’t run yet, not because it’s meant to be kept long-term.</div>'
    : '';

  document.getElementById('act-modal-body').innerHTML =
    expiredNote +
    '<div class="act-payload-block-label">Request' + reqBadge + '</div>' +
    (hasReq ? '<pre class="act-payload-box" id="act-payload-request-box"></pre>'
            : '<div class="act-cell-muted" style="margin:0 0 16px;">No request payload captured for this call.</div>') +
    '<div class="act-payload-block-label">Response</div>' +
    (hasRes ? '<pre class="act-payload-box" id="act-payload-response-box"></pre>'
            : '<div class="act-cell-muted" style="margin:0;">No response payload captured for this call.</div>') +
    actPayloadGateStripHtml();

  if (hasReq) document.getElementById('act-payload-request-box').textContent = actStringifyPayloadForPreview(payload.request_payload);
  if (hasRes) document.getElementById('act-payload-response-box').textContent = actStringifyPayloadForPreview(payload.response_payload);

  actShowModal();
}

function actRenderOpportunityMatrix(groupedRows) {
  var groups = actFoldFeatureGroups(groupedRows);
  var keys = Object.keys(groups);
  if (!keys.length) return '<div class="act-section-title">Opportunity Matrix</div><div class="act-empty-state"><div class="act-empty-state-title">No data for this period.</div></div>';

  var points = keys.map(function (k) {
    var g = groups[k];
    return { name: k, calls: g.calls, cost: g.cost, avgCost: g.calls ? g.cost / g.calls : 0 };
  });
  var overallAvg = points.reduce(function (s, p) { return s + p.avgCost; }, 0) / points.length;
  var maxCalls = Math.max.apply(null, points.map(function (p) { return p.calls; })) || 1;
  var maxAvg = Math.max.apply(null, points.map(function (p) { return p.avgCost; })) || 1;
  var maxCost = Math.max.apply(null, points.map(function (p) { return p.cost; })) || 1;
  var minCost = Math.min.apply(null, points.map(function (p) { return p.cost; })) || 0;

  var dots = points.map(function (p) {
    var xPct = 8 + (p.calls / maxCalls) * 84;
    var yPct = 8 + (p.avgCost / maxAvg) * 84;
    var size = 16 + ((maxCost > minCost) ? ((p.cost - minCost) / (maxCost - minCost)) * 26 : 13);
    var flagged = p.avgCost > overallAvg * 1.5;
    return '<div class="act-matrix-dot' + (flagged ? ' flagged' : '') + '" style="left:' + xPct + '%;bottom:' + yPct + '%;width:' + size + 'px;height:' + size + 'px;">' +
      '<div class="act-matrix-tooltip"><b>' + actEsc(p.name) + '</b>' + actFmtNum(p.calls) + ' calls · ' + actFmtUSD0(p.cost) + ' total<br>' + actFmtUSD(p.avgCost) + ' avg cost/call</div></div>' +
      '<div class="act-matrix-dot-label" style="left:' + xPct + '%;bottom:' + (yPct + 4) + '%;">' + actEsc(p.name) + '</div>';
  }).join('');

  var flaggedNames = points.filter(function (p) { return p.avgCost > overallAvg * 1.5; }).map(function (p) { return p.name; });

  return '<div class="act-section-title">Opportunity Matrix</div>' +
    '<div class="act-section-insight">X-axis is call volume, Y-axis is average cost per call, bubble size is total spend, red indicates average cost/call above 1.5× the cross-feature average this period. Hover a bubble for exact figures.</div>' +
    '<div class="act-matrix-wrap"><div class="act-matrix-axis-label" style="bottom:5px;left:50%;transform:translateX(-50%);">Call volume &rarr;</div>' +
    '<div class="act-matrix-axis-label" style="left:9px;top:50%;transform:rotate(-90deg) translateX(50%);transform-origin:left;">Avg cost / call &rarr;</div>' +
    '<div class="act-matrix-plot">' +
    '<div class="act-matrix-quad-label" style="top:7px;left:7px;">High Cost / Low Volume</div><div class="act-matrix-quad-label" style="top:7px;right:7px;">High Cost / High Volume</div>' +
    '<div class="act-matrix-quad-label" style="bottom:7px;left:7px;">Low Cost / Low Volume</div><div class="act-matrix-quad-label" style="bottom:7px;right:7px;">Low Cost / High Volume</div>' +
    dots + '</div>' +
    '<div class="act-matrix-legend"><div class="act-legend-items"><span><span class="act-legend-dot red"></span>Flagged (&gt;1.5× avg cost/call)</span><span><span class="act-legend-dot"></span>Normal</span><span>Bubble size = total spend</span></div></div></div>' +
    (flaggedNames.length ? '<div class="act-callout card"><div><b>Flagged:</b> ' + flaggedNames.map(actEsc).join(', ') + ' exceed 1.5× the average cost per call across all plotted features this period.</div></div>' : '');
}

// Standalone, full-width — pulled out of the old two-column grid so it
// sits above Cost Governance instead of sharing a row with the alert
// list/config (reviewed wireframe, AI Governance restructure).
function actRenderBudgetBar() {
  var spendSoFar = actMain.summary ? Number(actMain.summary.total_cost) : 0;
  var amount = actBudget ? Number(actBudget.amount) : 0;
  var warnPct = actBudget ? Number(actBudget.warn_threshold_pct) : 80;
  var escPct = actBudget ? Number(actBudget.escalate_threshold_pct) : 90;
  var usedPct = amount ? Math.min(100, spendSoFar / amount * 100) : 0;
  var barColor = !actBudget ? 'var(--divider)' : (usedPct >= escPct ? 'var(--red)' : (usedPct >= warnPct ? 'var(--amber)' : 'var(--purple)'));
  var daysInMonth = Math.round((actMain.end - actMain.start) / 86400000);
  var daysRemaining = Math.max(0, daysInMonth - Math.floor((actMain.now - actMain.start) / 86400000));
  return '<div class="act-budget-card"><div class="act-budget-top"><div class="act-budget-name">Overall Monthly Budget</div><div class="act-budget-figures">' + actFmtUSD0(spendSoFar) + ' of ' + (actBudget ? actFmtUSD0(amount) : 'not set') + '</div></div>' +
    '<div class="act-budget-bar-track"><div class="act-budget-bar-fill" style="width:' + usedPct + '%;background:' + barColor + ';"></div></div>' +
    '<div class="act-budget-foot"><span>' + usedPct.toFixed(0) + '% used</span><span>' + daysRemaining + ' days remaining</span></div></div>';
}

function actRenderBudgetConfigCard() {
  var amount = actBudget ? Number(actBudget.amount) : 0;
  var warnPct = actBudget ? Number(actBudget.warn_threshold_pct) : 80;
  var escPct = actBudget ? Number(actBudget.escalate_threshold_pct) : 90;
  var actionOnBreach = (actBudget && actBudget.action_on_breach) || 'notify';
  // Multi-app platform extension (§3.6/§7.6): real-time enforcement only
  // exists for Product Studio today. An app without it can never be given
  // 'restrict_tier'/'stop' — mt_ai_budget_upsert rejects it server-side
  // regardless, so a disabled-but-visible select would just invite "is this
  // broken or unfinished" confusion. Static text instead, with the save call
  // sending 'notify' unconditionally (never read from a control the person
  // could manipulate client-side).
  var actionField = actAppSupportsEnforcement
    ? '<div class="act-field"><div class="act-field-label">Action On Save</div><select id="act-cfg-action"><option value="notify"' + (actionOnBreach === 'notify' ? ' selected' : '') + '>Notify Only</option><option value="restrict_tier"' + (actionOnBreach === 'restrict_tier' ? ' selected' : '') + '>Restrict to Economical Tier</option><option value="stop"' + (actionOnBreach === 'stop' ? ' selected' : '') + '>Stop AI Usage</option></select></div>'
    : '<div class="act-field"><div class="act-field-label">Action On Save</div><input type="text" value="Notify Only" readonly><div class="act-field-hint">Real-time enforcement is only available for Product Studio.</div></div>';
  return '<div class="act-config-card"><div class="act-section-title">Budget Configuration</div>' +
    '<div class="act-config-grid">' +
    '<div class="act-field"><div class="act-field-label">Monthly Budget</div><input id="act-cfg-amount" type="number" min="0" step="1" value="' + (actBudget ? amount : '') + '"></div>' +
    '<div class="act-field"><div class="act-field-label">Warn Threshold %</div><input id="act-cfg-warn" type="number" min="1" max="99" value="' + warnPct + '"></div>' +
    '<div class="act-field"><div class="act-field-label">Escalate Threshold %</div><input id="act-cfg-escalate" type="number" min="1" max="100" value="' + escPct + '"></div>' +
    actionField +
    '</div>' +
    '<div class="act-scoped-card-note">Applies to every AI call the moment you save, regardless of current spend. Resets to Notify Only automatically at the start of next month.</div>' +
    '<div class="act-config-footer"><button class="act-btn act-btn-primary act-btn-sm" onclick="actSaveBudget()">Save Configuration</button></div>' +
    '</div>';
}

// Collapsible "Cost Controls" wrapper around Budget Configuration +
// What-If Scenario (reviewed wireframe). Collapsed by default on every
// fresh load — actCostControlsOpen is a plain module-level flag, not
// persisted, so it always starts collapsed and only stays open across
// a full re-render (e.g. after Save Configuration) because actRenderPlan()
// re-reads this same flag. The toggle itself is a pure DOM show/hide, not
// a re-render: cc-body is always present in the markup (its visibility is
// inline-style, not conditional HTML), so clicking the bar can never wipe
// an admin's unsaved edits in the Budget Configuration/What-If fields, and
// never re-triggers the screen's other aggregation work (What-If
// percentiles, Opportunities, Opportunity Matrix) just to expand/collapse.
var actCostControlsOpen = false;
function actToggleCostControls() {
  actCostControlsOpen = !actCostControlsOpen;
  var body = document.getElementById('act-cc-body');
  var chevron = document.getElementById('act-cc-chevron');
  if (body) body.style.display = actCostControlsOpen ? '' : 'none';
  if (chevron) chevron.classList.toggle('open', actCostControlsOpen);
}
function actRenderCostControls(whatIfData) {
  return '<div class="cc-bar" onclick="actToggleCostControls()">' +
    '<div class="cc-bar-left"><div class="cc-bar-title">Cost Controls</div><div class="cc-bar-sub">Budget Configuration &amp; What-If Scenario</div></div>' +
    '<svg id="act-cc-chevron" class="cc-chevron' + (actCostControlsOpen ? ' open' : '') + '" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>' +
    '</div>' +
    '<div class="cc-body" id="act-cc-body"' + (actCostControlsOpen ? '' : ' style="display:none;"') + '><div class="act-planning-grid">' + actRenderBudgetConfigCard() + actRenderWhatIf(whatIfData) + '</div></div>';
}

// Bordered/titled card matching Role-Based Unit Economics' own
// act-scoped-card treatment (reviewed wireframe) — replaces the old
// untitled, unbounded act-alert-list. Scroll-capped via CSS
// (.act-alert-list's max-height) rather than left to grow forever, and
// mt_ai_alerts_list() itself now also scopes to the current + prior
// month (sql/ai-cost-tower-alert-dismiss.sql) so this never has to
// render more than a couple months' worth even before anything is
// dismissed. Dismiss (the × in the corner, or the Dismiss button) is a
// separate, persisted action from Acknowledge — it permanently removes
// the alert from every future load, not just this render.
function actRenderAlertsCard() {
  var rowsHtml = actAlerts.map(function (a) {
    var isEsc = a.threshold_type === 'escalate';
    var statusHtml = a.status === 'open'
      ? '<button class="act-btn act-btn-secondary act-btn-sm" onclick="actAcknowledgeAlert(\'' + a.alert_id + '\')">Acknowledge</button>'
      : '<span class="act-alert-ack-done">Acknowledged ' + (a.acknowledged_at ? new Date(a.acknowledged_at).toLocaleString() : '') + '</span>';
    return '<div class="act-alert-row">' +
      '<button class="act-alert-x" onclick="actDismissAlert(\'' + a.alert_id + '\')" aria-label="Dismiss" title="Dismiss"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg></button>' +
      '<div class="act-alert-row-top"><span class="act-alert-level ' + (isEsc ? 'escalate' : 'warn') + '">' + a.threshold_type + '</span><span class="act-alert-title">Spend crossed ' + Number(a.threshold_pct) + '% of the monthly budget.</span><span class="act-alert-date">' + new Date(a.created_at).toLocaleDateString() + '</span></div>' +
      '<div class="act-alert-what">' + (isEsc ? 'Admins were notified. This alert does not trigger anything on its own — apply an action in Budget Configuration if you want one.' : 'Admins were notified. No automatic action fires at the Warn level.') + '</div>' +
      '<div class="act-alert-actions">' + statusHtml + '<button class="act-btn act-btn-tertiary act-btn-sm" onclick="actDismissAlert(\'' + a.alert_id + '\')">Dismiss</button></div>' +
      '</div>';
  }).join('');
  var body = actAlerts.length
    ? '<div class="act-alert-list">' + rowsHtml + '</div>'
    : '<div class="act-empty-state"><div class="act-empty-state-title">No alerts yet for the active budget.</div></div>';
  return '<div class="act-scoped-card"><div class="act-section-title">Alerts</div>' + body + '</div>';
}

async function actSaveBudget() {
  var client = authInit();
  var amount = Number(document.getElementById('act-cfg-amount').value || 0);
  var warn = Number(document.getElementById('act-cfg-warn').value || 80);
  var esc = Number(document.getElementById('act-cfg-escalate').value || 90);
  var actionEl = document.getElementById('act-cfg-action');
  var actionOnBreach = actAppSupportsEnforcement ? actionEl.value : 'notify';
  if (!amount || amount <= 0) { actToast('Enter a monthly budget amount greater than 0.', 'error'); return; }
  if (esc <= warn) { actToast('Escalate threshold must be greater than Warn threshold.', 'error'); return; }
  try {
    var result = await client.rpc('mt_ai_budget_upsert', {
      p_company_id: actCompanyId, p_app_id: actAppId, p_amount: amount, p_currency: 'USD',
      p_warn_threshold_pct: warn, p_escalate_threshold_pct: esc,
      p_enforcement_mode: 'monitor', p_action_on_breach: actionOnBreach
    });
    if (result.error) throw result.error;
    actBudget = result.data;
    actToast('Budget configuration saved.', 'success');
    actRenderOverview();
    // Guarded the same as every other actRenderPlan() call site — this
    // button only exists once actRenderPlan() has already rendered it
    // (never true for a read-only boot), but matching the same defense-in-
    // depth pattern used elsewhere in case that ever changes.
    if (actIsGovernanceViewer()) actRenderPlan();
  } catch (err) {
    console.error('[Cost Tower] budget save failed:', err);
    actToast('Could not save budget configuration.', 'error');
  }
}

// Patches actAlerts in place from an RPC's own RETURNING * row, instead of
// re-fetching the budget + full alert list — acknowledging/dismissing one
// alert never changes the budget row, and the RPC response already has
// everything needed. A row that comes back 'dismissed' is removed outright
// (mt_ai_alerts_list() would exclude it on the next real fetch anyway);
// any other status is patched into the existing row in place.
function _actPatchAlert(updated) {
  if (!updated) return;
  if (updated.status === 'dismissed') {
    actAlerts = actAlerts.filter(function (a) { return a.alert_id !== updated.alert_id; });
  } else {
    actAlerts = actAlerts.map(function (a) { return a.alert_id === updated.alert_id ? updated : a; });
  }
}

// Shared by actAcknowledgeAlert()/actDismissAlert() — same rpc-call/patch/
// render/toast shape for both, differing only in which RPC and which copy.
async function _actAlertAction(rpcName, alertId, successMsg, failMsg) {
  var client = authInit();
  try {
    var result = await client.rpc(rpcName, { p_alert_id: alertId });
    if (result.error) throw result.error;
    _actPatchAlert(result.data);
    // Same defense-in-depth guard as actSaveBudget() and every other
    // actRenderPlan() call site.
    if (actIsGovernanceViewer()) actRenderPlan();
    actToast(successMsg, 'success');
  } catch (err) {
    console.error('[Cost Tower] ' + rpcName + ' failed:', err);
    actToast(failMsg, 'error');
  }
}

function actAcknowledgeAlert(alertId) {
  return _actAlertAction('mt_ai_alert_acknowledge', alertId, 'Alert acknowledged.', 'Could not acknowledge alert.');
}

// Permanent removal, distinct from Acknowledge — mt_ai_alert_dismiss()
// (sql/ai-cost-tower-alert-dismiss.sql) works on an open OR already-
// acknowledged alert, and mt_ai_alerts_list() excludes dismissed rows
// from every future load, not just this render.
function actDismissAlert(alertId) {
  return _actAlertAction('mt_ai_alert_dismiss', alertId, 'Alert dismissed.', 'Could not dismiss alert.');
}

// ══════════════════════════════════════════════════════════════════════
// Export — same html2canvas + jsPDF pattern as Outcome Pulse's
// opDownloadReport() (scripts/outcome-pulse.js), reused rather than
// reinvented (spec Section 3.1).
// ══════════════════════════════════════════════════════════════════════

var _actHtml2CanvasPromise = null;
async function _actLoadHtml2Canvas() {
  if (typeof html2canvas !== 'undefined') return true;
  if (_actHtml2CanvasPromise) return _actHtml2CanvasPromise;
  _actHtml2CanvasPromise = new Promise(function (res) {
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
    s.onload = function () { res(true); };
    s.onerror = function () { _actHtml2CanvasPromise = null; res(false); };
    document.head.appendChild(s);
  });
  return _actHtml2CanvasPromise;
}
var _actJsPDFPromise = null;
async function _actLoadJsPDF() {
  if (typeof window.jspdf !== 'undefined') return true;
  if (_actJsPDFPromise) return _actJsPDFPromise;
  _actJsPDFPromise = new Promise(function (res) {
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
    s.onload = function () { res(true); };
    s.onerror = function () { _actJsPDFPromise = null; res(false); };
    document.head.appendChild(s);
  });
  return _actJsPDFPromise;
}

async function actDownloadReport(screen) {
  var btn = document.getElementById('act-export-' + screen + '-btn');
  var target = document.getElementById('act-export-' + screen + '-target');
  var exportHeader = document.getElementById('act-export-' + screen + '-header');
  if (!target) return;
  if (exportHeader) {
    // The Reporting Period chip lives in .act-header-actions, outside the
    // captured #act-export-{screen}-target — without this, an exported PDF
    // is visually indistinguishable between e.g. "This Month" and "Last 3
    // Months". Fold the selected period into this same header text instead
    // of restructuring the live screens' DOM/CSS just for capture.
    var periodLabelByScreen = {
      overview: (typeof actOverviewPeriod !== 'undefined') ? actOverviewPeriod.label : null,
      cost: (typeof actBreakdown !== 'undefined') ? actBreakdown.label : null,
      outcome: (typeof actOutcomePeriod !== 'undefined') ? actOutcomePeriod.label : null
    };
    var periodLabel = periodLabelByScreen[screen];
    exportHeader.textContent = (actCompanyName ? actCompanyName + ' - ' : '') + 'AI Control Tower - ' + ACT_SCREEN_NAMES[screen] + (periodLabel ? ' (' + periodLabel + ')' : '');
    exportHeader.style.display = 'block';
  }
  var origHtml = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.innerHTML = 'Preparing...'; }
  try {
    var ok1 = await _actLoadHtml2Canvas(), ok2 = await _actLoadJsPDF();
    if (!ok1 || !ok2) throw new Error('Could not load PDF export libraries.');
    var canvas = await html2canvas(target, { backgroundColor: '#ffffff', scale: 2 });
    var jsPDF = window.jspdf.jsPDF;
    var pdf = new jsPDF('p', 'pt', 'a4');
    var pageWidth = pdf.internal.pageSize.getWidth(), pageHeight = pdf.internal.pageSize.getHeight();
    var margin = 36, usableWidth = pageWidth - margin * 2, usableHeight = pageHeight - margin * 2;
    var imgWidth = usableWidth, imgHeight = (canvas.height * imgWidth) / canvas.width;
    // JPEG at high quality instead of lossless PNG — a raster screenshot of
    // UI (mostly flat colour/text, no photographic detail) gains nothing
    // from PNG's lossless encoding but pays for it in file size; JPEG at
    // 0.92 cuts export size dramatically with no visible quality loss.
    var imgData = canvas.toDataURL('image/jpeg', 0.92);
    var heightRemaining = imgHeight, pageIndex = 0;
    while (heightRemaining > 0) {
      if (pageIndex > 0) pdf.addPage();
      var yOffset = margin - (pageIndex * usableHeight);
      pdf.addImage(imgData, 'JPEG', margin, yOffset, imgWidth, imgHeight);
      heightRemaining -= usableHeight;
      pageIndex++;
    }
    pdf.save((actCompanyName ? actCompanyName.replace(/\s+/g, '_') + '_' : '') + 'AI_Control_Tower_' + ACT_SCREEN_NAMES[screen].replace(/[^A-Za-z0-9]+/g, '_') + '.pdf');
  } catch (err) {
    console.error('[Cost Tower] PDF export failed:', err);
    actToast('PDF export failed. Please try again.', 'error');
  } finally {
    if (exportHeader) exportHeader.style.display = 'none';
    if (btn) { btn.disabled = false; if (origHtml !== null) btn.innerHTML = origHtml; }
  }
}
