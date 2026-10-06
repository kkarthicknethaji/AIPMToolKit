// ── AI Cost Control Tower v2: Outcome-Based Cost (Screen 4) ──
// Standalone page (ai-cost-tower.html), loaded after cost-tower.js — reuses
// its globals (actCompanyId, actMain, actMonthRange, actDeltaPct,
// actFetchCostSummary, actFetchCostGrouped, actFetchTopCalls, actFoldGrouped,
// authInit, authGetFreshToken) rather than duplicating them. Computes the prototype's
// exact outcomeTypes object shape from real RPC data and reuses its render
// functions — see ai-cost-control-tower-v2-outcome-prototype.html for the
// shape/render spec of record. Two deliberate, labeled deviations from that
// file: outcomeCardHtml()/openOutcomeModal()'s isRelease branches and the
// yield branch's Avg-Cost-/-Unit row, both null-guarded for data this build
// doesn't populate yet (Release Plan lineage rollup — no RPC exists to read
// mt_sessions.snapshot from this standalone page; Yield units_generated —
// the 13-caller report-back wiring is Phase 6, not yet built).

// ══════════════════════════════════════════════════════════════════════
// Constants — copied verbatim from the prototype
// ══════════════════════════════════════════════════════════════════════

var MIN_SAMPLE_DELIVERABLE = 8;
var MIN_SAMPLE_YIELD = 50;

// Completion-signal display copy — modal text only, not logic-bearing.
// Hand-typed from the taxonomy doc's milestone table, with Adoption
// Readiness/Release Plan reflecting the Phase 1 corrections (four real
// arp-* callers, outcome created at rcCreatePlan(); trigger moved to top of
// piGenerate()) rather than the taxonomy doc's original phrasing.
var OUTCOME_COMPLETION_SIGNAL = {
  discovery_map: 'KPI tree generation completes (dm_created).',
  requirement_brief: 'Conversation finalized (brief_finalized).',
  market_intelligence_report: 'MI generated OR full report downloaded, whichever first (mi_generated / mi_report_downloaded).',
  adoption_readiness_report: 'Plan finalized (arp_report_finalized).',
  release_plan: 'Every story in the plan has a live sprint assignment (release_plan_sprints_complete).'
};

// ══════════════════════════════════════════════════════════════════════
// Fetch layer
// ══════════════════════════════════════════════════════════════════════

var _outcomesRowCache = {};
async function _outcomesFetchOutcomeRows(start, end) {
  var key = start.toISOString() + '|' + end.toISOString();
  if (_outcomesRowCache[key]) return _outcomesRowCache[key];
  var client = authInit();
  var result = await client.rpc('mt_outcomes_list', {
    p_company_id: actCompanyId,
    p_app_id: actAppId,
    p_period_start: start.toISOString(),
    p_period_end: end.toISOString()
  });
  if (result.error) {
    console.error('[Cost Tower] mt_outcomes_list failed:', result.error.message);
    actToast('Could not load outcome data for this period.', 'error');
    return [];
  }
  _outcomesRowCache[key] = result.data || [];
  return _outcomesRowCache[key];
}

async function _outcomesFetchTypes() {
  var client = authInit();
  var result = await client.rpc('mt_outcome_types_list', { p_app_id: actAppId });
  if (result.error) {
    console.error('[Cost Tower] mt_outcome_types_list failed:', result.error.message);
    actToast('Could not load outcome type catalog.', 'error');
    return [];
  }
  return result.data || [];
}

// Mirrors actLoadTeamNames()'s exact pattern for calling a non-/api/anthropic
// proxy route (local-vs-hosted base URL detection, X-Auth-Token header).
// No company_id — this is global reference data (server.js is the one
// hand-typed copy of CALLER_ATTRIBUTION_MODE), not tenant data.
async function _outcomesFetchCallerModes() {
  try {
    var authToken = '';
    try { if (typeof authGetFreshToken === 'function') authToken = await authGetFreshToken(); } catch (e) {}
    var host = window.location.hostname;
    var isLocal = (host === '' || host === 'localhost' || host === '127.0.0.1');
    var base = isLocal ? 'http://localhost:3001' : ((typeof PROXY_URL !== 'undefined' && PROXY_URL) ? PROXY_URL.replace(/\/api\/anthropic\/?$/, '') : 'https://product-diagnostics-proxy.onrender.com');
    var headers = {};
    if (authToken) headers['X-Auth-Token'] = authToken;
    var res = await fetch(base + '/api/outcome-caller-modes?app_id=' + encodeURIComponent(actAppId || ''), { method: 'GET', headers: headers });
    var data = await res.json().catch(function () { return {}; });
    return data.callerModes || {};
  } catch (e) {
    console.warn('[Cost Tower] outcome-caller-modes fetch failed:', e);
    return {};
  }
}

// ══════════════════════════════════════════════════════════════════════
// Trend — reuses cost-tower.js's own actDeltaPct()/actMonthRange() verbatim,
// extending Screens 1-3's existing period-comparison convention rather than
// inventing a new one for this screen.
// ══════════════════════════════════════════════════════════════════════

// A null delta must NEVER map to trendDir:'up' — that's what keeps
// fastestGrowingType()'s existing filter (trendDir==='up') correctly
// excluding no-baseline types, with zero change needed to that function.
// 'unknown' is distinct from 'flat': a real 0% change and "nothing to
// compare against" are different facts, and conflating them would
// misrepresent an unmeasured baseline as measured-and-flat. 'n/a' (not an
// em dash) matches this file's own established convention for the same
// kind of gap elsewhere (Cost / Completed when a type has zero completions).
function _outcomesTrendFields(currCost, prevCost) {
  var delta = actDeltaPct(currCost, prevCost);
  if (delta === null) return { trend: 'n/a', trendDir: 'unknown' };
  if (delta > 0) return { trend: '+' + Math.round(delta) + '%', trendDir: 'up' };
  if (delta < 0) return { trend: Math.round(delta) + '%', trendDir: 'down' };
  return { trend: '0%', trendDir: 'flat' };
}

// ══════════════════════════════════════════════════════════════════════
// Aggregation — replaces the prototype's hardcoded outcomeTypes constant
// with real data in the exact same shape.
// ══════════════════════════════════════════════════════════════════════

// v9.37 period-aggregation migration — cost-side inputs are now
// server-aggregated (mt_ai_cost_grouped('outcome_type')/('feature'),
// mt_ai_cost_top_calls) instead of raw currCosts/prevCosts row arrays
// filtered client-side. actFoldGrouped (cost-tower.js) does the summing;
// this file only reshapes the already-small result.

// Folds mt_ai_cost_grouped('outcome_type')'s (outcome_type_id,
// completion_bucket) rows into {[outcome_type_id]: {total, completed,
// sunk}} — mirrors buildOutcomeTypes()'s old completedIds/abandonedIds
// split, just computed server-side (migration file Part C's LEFT JOIN
// LATERAL already scopes each cost row to an outcome that both exists and
// itself started within the period, the same membership rule the old
// currOutcomeIds/prevOutcomeIds filter enforced).
function _outcomesFoldByTypeBucket(groupedRows) {
  var byType = {};
  (groupedRows || []).forEach(function (g) {
    var id = g.group_key1;
    if (!byType[id]) byType[id] = { total: 0, completed: 0, sunk: 0 };
    var cost = Number(g.cost || 0);
    byType[id].total += cost;
    if (g.group_key2 === 'completed') byType[id].completed += cost;
    if (g.group_key2 === 'abandoned') byType[id].sunk += cost;
  });
  return byType;
}

// mt_ai_cost_top_calls(partition_by=...) already caps each partition key
// at its own top-N — merging a type's several caller-partitions and
// re-ranking is safe (the true top-3 across a caller set must each be
// within their own caller's top-3) and avoids a second RPC per type.
function _outcomesSampleCallsForCallers(topCallsByCaller, callers) {
  var combined = (topCallsByCaller || []).filter(function (r) { return callers.indexOf(r.partition_key) !== -1; });
  combined.sort(function (a, b) { return (b.calculated_cost || 0) - (a.calculated_cost || 0); });
  return combined.slice(0, 3).map(function (r) { return { caller: r.caller, cost: Number(r.calculated_cost) || 0, note: '' }; });
}
function _outcomesSampleCallsForType(topCallsByType, id) {
  return (topCallsByType || []).filter(function (r) { return r.partition_key === id; })
    .map(function (r) { return { caller: r.caller, cost: Number(r.calculated_cost) || 0, note: '' }; });
}

function buildOutcomeTypes(typeRows, currOutcomes, prevOutcomes, typeBucketGrouped, prevTypeBucketGrouped, featureGrouped, prevFeatureGrouped, topCallsByType, topCallsByCaller, callerModes) {
  var outcomeTypes = {};
  var currTypeTotals = _outcomesFoldByTypeBucket(typeBucketGrouped);
  var prevTypeTotals = _outcomesFoldByTypeBucket(prevTypeBucketGrouped);
  // actFoldGrouped (cost-tower.js) keyed by caller alone — ignores
  // product_id, collapsing every (caller, product_id) row mt_ai_cost_grouped
  // ('feature') returns for the same caller into one entry, which is
  // exactly the per-caller total a yield type's caller list needs.
  var currCallerTotals = actFoldGrouped(featureGrouped, function (g) { return g.group_key1; });
  var prevCallerTotals = actFoldGrouped(prevFeatureGrouped, function (g) { return g.group_key1; });

  // Yield callers grouped by outcomeType — callerModes is {caller: outcomeType},
  // the Yield-relevant subset of CALLER_ATTRIBUTION_MODE fetched once above.
  var yieldCallersByType = {};
  Object.keys(callerModes).forEach(function (caller) {
    var typeId = callerModes[caller];
    if (!yieldCallersByType[typeId]) yieldCallersByType[typeId] = [];
    yieldCallersByType[typeId].push(caller);
  });

  typeRows.forEach(function (typeRow) {
    var id = typeRow.outcome_type_id;

    if (typeRow.costing_method === 'session_sum') {
      var currTypeOutcomes = currOutcomes.filter(function (o) { return o.outcome_type_id === id; });
      var totals = currTypeTotals[id] || { total: 0, completed: 0, sunk: 0 };
      var prevTotals = prevTypeTotals[id] || { total: 0, completed: 0, sunk: 0 };
      var trendFields = _outcomesTrendFields(totals.total, prevTotals.total);

      var entry = {
        name: typeRow.name,
        group: 'deliverable',
        canvas: typeRow.canvas,
        attempts: currTypeOutcomes.length,
        completed: currTypeOutcomes.filter(function (o) { return o.status === 'completed'; }).length,
        abandoned: currTypeOutcomes.filter(function (o) { return o.is_abandoned; }).length,
        totalCost: totals.total,
        // Cost actually attributable to outcomes that reached status
        // 'completed' — NOT totalCost minus sunkCost. That residual would
        // silently include cost from outcomes still in progress (neither
        // completed nor abandoned yet), which is a different, third bucket
        // (see computePortfolio()'s inProgressValue).
        completedCost: totals.completed,
        sunkCost: totals.sunk,
        trend: trendFields.trend,
        trendDir: trendFields.trendDir,
        completionSignal: OUTCOME_COMPLETION_SIGNAL[id] || '',
        abandonWindow: typeRow.abandonment_window_hrs,
        sampleCalls: _outcomesSampleCallsForType(topCallsByType, id)
      };

      // Release Plan lineage rollup — DEFERRED (Phase 4/5 build-list
      // decision). No RPC exists yet to read mt_sessions.snapshot from this
      // standalone page (confirmed: cost-tower.js has zero references to
      // capStore/mt_sessions/snapshot, and this page loads none of the
      // canvas scripts that define capStore — referencing it would throw
      // ReferenceError, not return empty). null, not 0 — 0 would falsely
      // claim "checked, no upstream cost." Guarded explicitly in
      // outcomeCardHtml() and openOutcomeModal()'s isRelease branches below.
      if (id === 'release_plan') {
        entry.isRelease = true;
        entry.rollupCost = null;
        entry.rollupBreakdown = null;
      }

      outcomeTypes[id] = entry;
    } else {
      // yield_ratio
      var callers = yieldCallersByType[id] || [];
      var totalCost2 = 0, prevTotalCost2 = 0, units = 0, hasAnyUnits = false, unitsResolvedCount = 0, failedCost2 = 0;
      callers.forEach(function (c) {
        var g = currCallerTotals[c];
        if (g) {
          totalCost2 += g.cost;
          // units_generated is only reliably populated for fixed_1 callers
          // today (set at insert time, Phase 4/5 fix) and for anything the
          // Phase 6 report-back endpoint has since updated. unitsResolved
          // (COUNT(*) FILTER (WHERE units_generated IS NOT NULL), summed
          // per caller) is the same "has anything reported" signal the old
          // per-row hasAnyUnits check used, just server-counted.
          if (g.unitsResolved > 0) { hasAnyUnits = true; units += g.unitsSum; unitsResolvedCount += g.unitsResolved; }
          failedCost2 += g.failedCost;
        }
        var pg = prevCallerTotals[c];
        if (pg) prevTotalCost2 += pg.cost;
      });
      var trendFields2 = _outcomesTrendFields(totalCost2, prevTotalCost2);

      // failedSharePct: cost-based (failedCost2 is SUM(calc_cost) FILTER
      // (WHERE status IN ('error','timeout')) per caller), never
      // units-based — null (not yet reported) and 0 (confirmed failure) are
      // different facts, same distinction the old per-row filter preserved.
      var failedSharePct = totalCost2 > 0 ? Math.round((failedCost2 / totalCost2) * 100) : 0;

      outcomeTypes[id] = {
        name: typeRow.name,
        group: 'yield',
        canvas: typeRow.canvas,
        totalCost: totalCost2,
        // null (not 0) when nothing has reported units yet — outcomeCardHtml()
        // guards on this the same way it guards Release Plan's rollupCost,
        // rather than showing a wildly overstated avg from a near-empty count.
        units: hasAnyUnits ? units : null,
        // Count of rows across this type's callers with a resolved (non-null)
        // units_generated — meaningful today for any fixed_1 caller (always
        // resolved), fills in for array/binary-counted callers as their own
        // report-back wiring lands. Relies on the same invariant units above
        // depends on: at most one caller per type ever reports a nonzero
        // value for a given real attempt (see e.g. Prototype's
        // prototype-wireframe/prototype-brief pairing) — if that's ever
        // violated, this double-counts right alongside units.
        attempts: unitsResolvedCount,
        failedSharePct: failedSharePct,
        trend: trendFields2.trend,
        trendDir: trendFields2.trendDir,
        callers: callers,
        sampleCalls: _outcomesSampleCallsForCallers(topCallsByCaller, callers)
      };
    }
  });

  return outcomeTypes;
}

// ══════════════════════════════════════════════════════════════════════
// Portfolio-level helpers — copied verbatim from the prototype, operating
// on whatever outcomeTypes buildOutcomeTypes() produced.
// ══════════════════════════════════════════════════════════════════════

var outcomeTypes = {};
var TOTAL_AI_SPEND_PERIOD = 0;

function fmt$(n) { return '$' + Math.round(n).toLocaleString(); }
function fmt$2(n) { return '$' + n.toFixed(2); }
// Yield: avgCost is always DERIVED from the real ledger total divided by
// units, never the other way around. Returns null when units aren't
// available yet (see buildOutcomeTypes()) — callers must guard, not divide.
function yieldAvg(t) { return (t.units !== null && t.units > 0) ? t.totalCost / t.units : null; }
function deliverableTotal(t) { return t.totalCost; }
function yieldTotal(t) { return t.totalCost; }
function volumeOf(t) { return t.group === 'deliverable' ? t.attempts : (t.units || 0); }
function minSampleFor(t) { return t.group === 'deliverable' ? MIN_SAMPLE_DELIVERABLE : MIN_SAMPLE_YIELD; }
function isLowSample(t) { return volumeOf(t) < minSampleFor(t); }

function computePortfolio() {
  var deliverables = Object.values(outcomeTypes).filter(function (t) { return t.group === 'deliverable'; });
  var yields = Object.values(outcomeTypes).filter(function (t) { return t.group === 'yield'; });
  var deliverableSpend = deliverables.reduce(function (s, t) { return s + deliverableTotal(t); }, 0);
  var yieldSpend = yields.reduce(function (s, t) { return s + yieldTotal(t); }, 0);
  var totalOutcomeSpend = deliverableSpend + yieldSpend;
  var totalSunk = deliverables.reduce(function (s, t) { return s + t.sunkCost; }, 0);
  // completedValue is cost actually attributed to status==='completed'
  // outcomes (see buildOutcomeTypes()'s completedCost) — deliberately NOT
  // deliverableSpend - totalSunk, which would silently fold in-progress
  // (neither completed nor abandoned) cost into "completed." inProgressValue
  // is the remainder, surfaced explicitly rather than dropped, so every
  // dollar of deliverableSpend is accounted for across exactly one of the
  // three buckets.
  var completedValue = deliverables.reduce(function (s, t) { return s + t.completedCost; }, 0);
  var inProgressValue = deliverableSpend - completedValue - totalSunk;
  var attempts = deliverables.reduce(function (s, t) { return s + t.attempts; }, 0);
  var completed = deliverables.reduce(function (s, t) { return s + t.completed; }, 0);
  var completionRate = attempts > 0 ? Math.round((completed / attempts) * 100) : 0;
  var unattributed = TOTAL_AI_SPEND_PERIOD - totalOutcomeSpend;
  var unattributedPct = TOTAL_AI_SPEND_PERIOD > 0 ? Math.round((unattributed / TOTAL_AI_SPEND_PERIOD) * 100) : 0;
  return { deliverableSpend: deliverableSpend, yieldSpend: yieldSpend, totalOutcomeSpend: totalOutcomeSpend, totalSunk: totalSunk, completedValue: completedValue, inProgressValue: inProgressValue, attempts: attempts, completed: completed, completionRate: completionRate, unattributed: unattributed, unattributedPct: unattributedPct };
}

function topCostType() {
  return Object.entries(outcomeTypes).map(function (e) {
    return { id: e[0], t: e[1], cost: e[1].group === 'deliverable' ? deliverableTotal(e[1]) : yieldTotal(e[1]) };
  }).sort(function (a, b) { return b.cost - a.cost; })[0];
}
// Excludes low-sample types — a trend from a handful of attempts is noise,
// not signal, and shouldn't be promoted to a headline claim.
function fastestGrowingType() {
  return Object.entries(outcomeTypes).map(function (e) {
    return { id: e[0], t: e[1], pct: parseFloat(e[1].trend) };
  }).filter(function (x) { return x.t.trendDir === 'up' && !isLowSample(x.t); })
    .sort(function (a, b) { return b.pct - a.pct; })[0];
}
function topAbandonedType() {
  return Object.entries(outcomeTypes).filter(function (e) { return e[1].group === 'deliverable'; })
    .map(function (e) { return { id: e[0], t: e[1] }; })
    .sort(function (a, b) { return b.t.sunkCost - a.t.sunkCost; })[0];
}

// ══════════════════════════════════════════════════════════════════════
// Render functions — copied verbatim from the prototype (structure and
// logic unchanged); renderExecCards()/topAbandonedType() guard against an
// empty portfolio (no rows loaded yet) rather than assume all three
// exec-card candidates always exist.
// ══════════════════════════════════════════════════════════════════════

function renderExecCards() {
  var top = topCostType();
  var fastest = fastestGrowingType();
  var abandoned = topAbandonedType();
  var grid = document.getElementById('exec-insight-grid');
  if (!grid) return;
  if (!top || !abandoned) { grid.innerHTML = ''; return; }
  var topCost = top.t.group === 'deliverable' ? deliverableTotal(top.t) : yieldTotal(top.t);
  grid.innerHTML =
    '<div class="act-exec-card">' +
      '<div class="act-exec-kicker">Highest Cost Outcome</div>' +
      '<div class="act-exec-name">' + top.t.name + '</div>' +
      '<div class="act-exec-stat">' + fmt$(topCost) + '</div>' +
      '<div class="act-exec-sub">' + (top.t.group === 'deliverable' ? 'Direct cost this period' : 'Total cost this period') + '</div>' +
    '</div>' +
    (fastest ?
    '<div class="act-exec-card">' +
      '<div class="act-exec-kicker">Fastest Growing</div>' +
      '<div class="act-exec-name">' + fastest.t.name + '</div>' +
      '<div class="act-exec-stat act-delta-up">Cost ' + fastest.t.trend + '</div>' +
      '<div class="act-exec-sub">' + volumeOf(fastest.t).toLocaleString() + ' ' + (fastest.t.group === 'deliverable' ? 'attempts' : 'units') + ' this period vs. last</div>' +
    '</div>' :
    '<div class="act-exec-card">' +
      '<div class="act-exec-kicker">Fastest Growing</div>' +
      '<div class="act-exec-sub">Not enough period-over-period data yet.</div>' +
    '</div>') +
    '<div class="act-exec-card warn">' +
      '<div class="act-exec-kicker">Highest Abandoned Cost</div>' +
      '<div class="act-exec-name">' + abandoned.t.name + '</div>' +
      '<div class="act-exec-stat" style="color:var(--red);">' + fmt$(abandoned.t.sunkCost) + '</div>' +
      '<div class="act-exec-sub">' + abandoned.t.abandoned + ' of ' + abandoned.t.attempts + ' attempts abandoned</div>' +
    '</div>';
}

function renderOutcomeSupport() {
  var p = computePortfolio();
  var el = document.getElementById('outcome-support');
  if (!el) return;
  el.innerHTML =
    fmt$(p.totalOutcomeSpend) + ' was spent on outcome-generating work this period, ' + fmt$(p.completedValue) + ' of it landed in a completed deliverable, ' + fmt$(p.inProgressValue) + ' is still in progress, and ' + fmt$(p.totalSunk) + ' was lost to abandoned work (' + p.completionRate + '% completion). ' +
    fmt$(p.unattributed) + ' (' + p.unattributedPct + '% of this period\'s <b>total</b> AI spend, not just outcome-eligible spend) isn\'t attributed to any of the twelve outcome types yet, mostly small utility and assist calls made outside an active outcome\'s session.';
}

function renderOutcomeKpiStrip() {
  var p = computePortfolio();
  var strip = document.getElementById('outcome-kpi-strip');
  if (!strip) return;
  strip.innerHTML =
    '<div class="act-kpi"><div class="act-kpi-label">Outcome-Attributed Spend</div><div class="act-kpi-value">' + fmt$(p.totalOutcomeSpend) + '</div><div class="act-kpi-sub">of ' + fmt$(TOTAL_AI_SPEND_PERIOD) + ' total AI spend this period</div></div>' +
    '<div class="act-kpi"><div class="act-kpi-label">Completed Deliverable Cost</div><div class="act-kpi-value green">' + fmt$(p.completedValue) + '</div><div class="act-kpi-sub">deliverables only, cost not proof of value</div></div>' +
    '<div class="act-kpi"><div class="act-kpi-label">Abandoned Deliverable Cost</div><div class="act-kpi-value red">' + fmt$(p.totalSunk) + '</div></div>' +
    '<div class="act-kpi"><div class="act-kpi-label">Completion Rate</div><div class="act-kpi-value">' + p.completionRate + '%</div><div class="act-kpi-sub">' + p.completed + ' of ' + p.attempts + ' attempts</div></div>' +
    '<div class="act-kpi"><div class="act-kpi-label">Outcome-Unattributed Spend</div><div class="act-kpi-value amber">' + fmt$(p.unattributed) + '</div><div class="act-kpi-sub">' + p.unattributedPct + '% of total AI spend, different from Overview\'s product-unassigned figure</div></div>';
}

function renderSunkCostTable() {
  var rows = Object.entries(outcomeTypes).filter(function (e) { return e[1].group === 'deliverable'; }).map(function (e) {
    var t = e[1];
    var share = t.totalCost > 0 ? Math.round((t.sunkCost / t.totalCost) * 100) : 0;
    var rate = t.attempts > 0 ? Math.round((t.completed / t.attempts) * 100) : 0;
    return '<tr>' +
      '<td class="act-cell-name">' + t.name + '</td>' +
      '<td>' + fmt$(t.sunkCost) + '</td>' +
      '<td><div class="act-cell-bar"><div class="act-cell-bar-track"><div class="act-cell-bar-fill" style="width:' + share + '%;background:' + (share > 15 ? 'var(--red)' : 'var(--blue-mid)') + '"></div></div>' + share + '% of type total</div></td>' +
      '<td>' + rate + '%</td>' +
      '<td>' + t.abandonWindow + 'h</td>' +
    '</tr>';
  }).join('');
  var table = document.getElementById('sunk-cost-table');
  if (!table) return;
  table.innerHTML = '<thead><tr><th>Deliverable</th><th>Abandoned Cost</th><th>Share Of Type Total</th><th>Completion Rate</th><th>Abandon Window</th></tr></thead><tbody>' + rows + '</tbody>';
}

function lowSampleBadge(t) {
  return isLowSample(t) ? '<span class="act-low-sample-badge" title="' + volumeOf(t) + ' ' + (t.group === 'deliverable' ? 'attempts' : 'units') + ' this period, trend shown for context only">Low sample</span>' : '';
}

function trendBadge(t) {
  var cls = t.trendDir === 'up' ? 'act-delta-up' : t.trendDir === 'down' ? 'act-delta-down' : 'act-delta-flat';
  return '<span class="' + cls + '">Cost ' + t.trend + '</span>';
}

function outcomeCardHtml(id, t) {
  if (t.group === 'deliverable') {
    var rate = t.attempts > 0 ? Math.round((t.completed / t.attempts) * 100) : 0;
    var costPerCompleted = t.completed > 0 ? deliverableTotal(t) / t.completed : null;
    if (t.isRelease) {
      // Deviation from the prototype, explicit and reviewed (Phase 4/5
      // decision): rollupCost is null until the mt_sessions.snapshot RPC
      // exists — guard before computing the Economic Footprint sum, never
      // let a null flow into arithmetic.
      var footprintRow = t.rollupCost != null
        ? '<div class="act-outcome-secondary-row"><span>Economic Footprint (incl. upstream)</span><span>' + fmt$(deliverableTotal(t) + t.rollupCost) + '</span></div>'
        : '<div class="act-outcome-secondary-row"><span>Economic Footprint (incl. upstream)</span><span class="act-cell-muted">Not yet available</span></div>';
      return '<div class="act-outcome-card" onclick="openOutcomeModal(\'' + id + '\')">' +
        '<div class="act-outcome-top"><span class="act-outcome-type-tag deliverable">Deliverable</span>' + trendBadge(t) + lowSampleBadge(t) + '</div>' +
        '<div class="act-outcome-name">' + t.name + '</div>' +
        '<div class="act-outcome-primary-label">Direct Cost</div>' +
        '<div class="act-outcome-primary-stat">' + fmt$(deliverableTotal(t)) + '</div>' +
        footprintRow +
        '<div class="act-outcome-secondary-row"><span>' + t.completed + ' of ' + t.attempts + ' completed</span><span>' + rate + '%</span></div>' +
        (t.sunkCost > 0 ? '<div class="act-outcome-flag-row">&#9888; ' + fmt$(t.sunkCost) + ' abandoned cost this period</div>' : '<div class="act-outcome-flag-row none">No abandoned cost this period</div>') +
        '<div class="act-outcome-card-foot"><span class="act-outcome-view-link">View breakdown &rarr;</span></div>' +
      '</div>';
    }
    return '<div class="act-outcome-card" onclick="openOutcomeModal(\'' + id + '\')">' +
      '<div class="act-outcome-top"><span class="act-outcome-type-tag deliverable">Deliverable</span>' + trendBadge(t) + lowSampleBadge(t) + '</div>' +
      '<div class="act-outcome-name">' + t.name + '</div>' +
      '<div class="act-outcome-primary-label">Total Cost</div>' +
      '<div class="act-outcome-primary-stat">' + fmt$(deliverableTotal(t)) + '</div>' +
      '<div class="act-outcome-secondary-row"><span>Cost / Completed</span><span>' + (costPerCompleted !== null ? fmt$2(costPerCompleted) : 'n/a') + '</span></div>' +
      '<div class="act-outcome-secondary-row"><span>' + t.completed + ' of ' + t.attempts + ' completed</span><span>' + rate + '%</span></div>' +
      (t.sunkCost > 0 ? '<div class="act-outcome-flag-row">&#9888; ' + fmt$(t.sunkCost) + ' abandoned cost this period</div>' : '<div class="act-outcome-flag-row none">No abandoned cost this period</div>') +
      '<div class="act-outcome-card-foot"><span class="act-outcome-view-link">View breakdown &rarr;</span></div>' +
    '</div>';
  } else {
    // Deviation from the prototype, explicit and reviewed (Phase 4/5
    // decision): units is null until Phase 6 wires the 13 Yield callers'
    // report-back calls — guard before dividing, same pattern as Release
    // Plan's rollupCost above, not a separate new convention.
    var avg = yieldAvg(t);
    // yieldAvg() correctly returns null for t.units===0 too (a real,
    // reported zero has no defined cost-per-unit, not just missing data) —
    // but the LABEL must say why, distinguishing "not yet reported"
    // (t.units === null) from "reported as zero, ratio undefined"
    // (t.units === 0), so this row never disagrees with unitsRow below
    // about whether unit data actually exists for this type.
    var avgRow = avg !== null
      ? '<div class="act-outcome-secondary-row"><span>Avg Cost / Unit</span><span>' + fmt$2(avg) + '</span></div>'
      : '<div class="act-outcome-secondary-row"><span>Avg Cost / Unit</span><span class="act-cell-muted">' + (t.units === null ? 'Not yet available' : 'n/a') + '</span></div>';
    var unitsRow = t.units !== null
      ? '<div class="act-outcome-secondary-row"><span>' + t.units.toLocaleString() + ' generated</span><span></span></div>'
      : '<div class="act-outcome-secondary-row"><span class="act-cell-muted">Unit count not yet available</span><span></span></div>';
    var attemptsRow = '<div class="act-outcome-secondary-row"><span>Attempts</span><span>' + t.attempts.toLocaleString() + '</span></div>';
    return '<div class="act-outcome-card" onclick="openOutcomeModal(\'' + id + '\')">' +
      '<div class="act-outcome-top"><span class="act-outcome-type-tag yield">Generated Artifact</span>' + trendBadge(t) + lowSampleBadge(t) + '</div>' +
      '<div class="act-outcome-name">' + t.name + '</div>' +
      '<div class="act-outcome-primary-label">Total Cost</div>' +
      '<div class="act-outcome-primary-stat">' + fmt$(yieldTotal(t)) + '</div>' +
      attemptsRow + avgRow + unitsRow +
      (t.failedSharePct >= 3 ? '<div class="act-outcome-flag-row">&#9888; ' + t.failedSharePct + '% of cost from failed calls</div>' : '<div class="act-outcome-flag-row none">' + t.failedSharePct + '% of cost from failed calls</div>') +
      '<div class="act-outcome-card-foot"><span class="act-outcome-view-link">View formula &rarr;</span></div>' +
    '</div>';
  }
}

// Portfolio state: one flat, sortable set of all eleven types, shown as cards.
var portfolioSortKey = 'cost';

function wasteValue(t) {
  return t.group === 'deliverable' ? t.sunkCost : yieldTotal(t) * (t.failedSharePct / 100);
}
function sortedPortfolio() {
  return Object.entries(outcomeTypes).map(function (e) {
    var t = e[1];
    var cost = t.group === 'deliverable' ? deliverableTotal(t) : yieldTotal(t);
    // Non-finite trend (e.g. parseFloat('n/a') => NaN) sorts last, not to
    // wherever NaN - NaN happens to leave it in Array.sort()'s comparator.
    var parsedTrend = parseFloat(t.trend);
    var trendPct = Number.isFinite(parsedTrend) ? parsedTrend : -Infinity;
    return { id: e[0], t: t, cost: cost, trendPct: trendPct, waste: wasteValue(t) };
  }).sort(function (a, b) {
    if (portfolioSortKey === 'trend') return b.trendPct - a.trendPct;
    if (portfolioSortKey === 'waste') return b.waste - a.waste;
    return b.cost - a.cost;
  });
}

function renderPortfolioCards() {
  var grid = document.getElementById('portfolio-cards');
  if (!grid) return;
  grid.innerHTML = sortedPortfolio().map(function (r) { return outcomeCardHtml(r.id, r.t); }).join('');
}
function renderPortfolio() { renderPortfolioCards(); }

function setPortfolioSort(key, label) {
  portfolioSortKey = key;
  var el = document.getElementById('sort-value');
  if (el) el.textContent = label;
  var menu = document.getElementById('sort-menu');
  if (menu) menu.classList.remove('open');
  renderPortfolio();
}

function sampleCallsTable(t) {
  var rows = t.sampleCalls.map(function (c) {
    return '<tr><td class="act-cell-name">' + c.caller + '</td><td>' + fmt$2(c.cost) + '</td><td class="act-cell-muted">' + c.note + '</td></tr>';
  }).join('');
  return '<table class="act-data-table"><thead><tr><th>Caller</th><th>Cost</th><th>Note</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div class="act-scoped-card-note">Illustrative sample calls, not the full contributing set for this period.</div>';
}

// Reuses this page's ONE existing shared modal (act-modal-overlay/act-modal-box/
// act-modal-title/act-modal-body, actShowModal()/actCloseModal()) — the same
// mechanism Screens 1-3 already use for the custom-date-range picker and the
// supporting-calls detail (cost-tower.js:702-722, 1205-1225). The prototype
// was a standalone file with no pre-existing modal to reuse and built its
// own outcome-modal-* shell; adopting that here would duplicate the concept
// on the same page. No new HTML, no new open/close functions — actShowModal()/
// actCloseModal() already handle the overlay click, Escape key, and focus
// trap for this modal too (code review, Phase 4/5: an earlier version of
// this function toggled the overlay/box classes directly instead of calling
// actShowModal(), silently skipping the Escape handler and focus trap).
function openOutcomeModal(id) {
  var t = outcomeTypes[id];
  if (!t) return;
  var titleEl = document.getElementById('act-modal-title');
  if (titleEl) titleEl.textContent = t.name;
  var body = '';
  if (isLowSample(t)) {
    body += '<div class="act-callout amber" style="margin-top:0;">Low sample: only ' + volumeOf(t) + ' ' + (t.group === 'deliverable' ? 'attempts' : 'units') + ' this period. Trend and ranking shown for context, not as a reliable signal yet.</div>';
  }
  if (t.isRelease) {
    var rate = t.attempts > 0 ? Math.round((t.completed / t.attempts) * 100) : 0;
    body += '<div class="act-modal-subtle">' + t.canvas + ' &middot; Completion signal: ' + t.completionSignal + ' &middot; Abandoned after ' + t.abandonWindow + 'h of inactivity</div>';
    // Deviation from the prototype, explicit and reviewed: rollupCost/
    // rollupBreakdown are null until the mt_sessions.snapshot RPC exists.
    // Never reference t.rollupBreakdown.discoveryMap etc. when
    // rollupBreakdown itself doesn't exist — skip both blocks entirely.
    if (t.rollupCost != null && t.rollupBreakdown) {
      body += '<div class="act-split-row">' +
        '<div class="act-split-block"><div class="act-split-label">Direct Cost</div><div class="act-split-value">' + fmt$(t.totalCost) + '</div><div class="act-split-note">Release Canvas\'s own authoring calls for this plan, exact and traced. Used in Portfolio totals and the cross-type ranking.</div></div>' +
        '<div class="act-split-block"><div class="act-split-label">Economic Footprint (Direct + Upstream)</div><div class="act-split-value">' + fmt$(t.totalCost + t.rollupCost) + '</div><div class="act-split-note">Traced where a direct outcome cost exists upstream; averaged at the current Yield rate otherwise. Not used in Portfolio totals, those dollars are already counted against their own outcome types.</div></div>' +
      '</div>';
      body += '<div class="act-formula-box">Upstream breakdown (current-state resolution, not a historical snapshot - this can shift if upstream work is later edited or deleted) - Discovery Map: ' + fmt$(t.rollupBreakdown.discoveryMap) + ' (traced) &middot; Requirement Brief: ' + fmt$(t.rollupBreakdown.requirementBrief) + ' (traced) &middot; Capability: ' + fmt$(t.rollupBreakdown.capability) + ' (avg &times; count) &middot; Feature: ' + fmt$(t.rollupBreakdown.feature) + ' (avg &times; count) &middot; Story: ' + fmt$(t.rollupBreakdown.story) + ' (avg &times; count)</div>';
    } else {
      body += '<div class="act-callout card" style="margin-top:0;">Upstream rollup isn\'t available yet for this build — Direct Cost above is real and complete.</div>';
    }
    body += '<div class="act-section-insight" style="margin-bottom:8px;">' + t.completed + ' of ' + t.attempts + ' release plans completed this period, ' + fmt$(t.sunkCost) + ' abandoned on the rest.</div>';
    body += sampleCallsTable(t);
  } else if (t.group === 'deliverable') {
    var rate2 = t.attempts > 0 ? Math.round((t.completed / t.attempts) * 100) : 0;
    var costPerCompleted = t.completed > 0 ? t.totalCost / t.completed : null;
    body += '<div class="act-modal-subtle">' + t.canvas + ' &middot; Completion signal: ' + t.completionSignal + ' &middot; Abandoned after ' + t.abandonWindow + 'h of inactivity</div>';
    body += '<div class="act-split-row">' +
      '<div class="act-split-block"><div class="act-split-label">Total Cost (fully loaded)</div><div class="act-split-value">' + fmt$(t.totalCost) + '</div><div class="act-split-note">' + t.attempts + ' attempts this period, includes ' + fmt$(t.sunkCost) + ' of abandoned cost.</div></div>' +
      '<div class="act-split-block"><div class="act-split-label">Cost / Completed ' + t.name + '</div><div class="act-split-value">' + (costPerCompleted !== null ? fmt$2(costPerCompleted) : 'n/a') + '</div><div class="act-split-note">Fully-loaded basis: total cost divided by ' + t.completed + ' completed, abandoned attempts included since they\'re real spend on this outcome type.</div></div>' +
    '</div>';
    body += '<div class="act-section-insight" style="margin-bottom:8px;">' + t.completed + ' completed, ' + t.abandoned + ' abandoned (' + fmt$(t.sunkCost) + '), ' + rate2 + '% completion rate.</div>';
    body += sampleCallsTable(t);
  } else {
    var avg = yieldAvg(t);
    body += '<div class="act-modal-subtle">' + t.canvas + '</div>';
    if (avg !== null) {
      body += '<div class="act-formula-box">Cost per ' + t.name + ' = <code>SUM(cost, ' + t.callers.join(' + ') + ')</code> &divide; <code>SUM(units_generated)</code><br>= ' + fmt$(t.totalCost) + ' &divide; ' + t.units.toLocaleString() + ' units = <b>' + fmt$2(avg) + '</b> per unit (the total is the real ledger figure, the average is derived from it, never the other way around)</div>';
    } else {
      body += '<div class="act-callout card" style="margin-top:0;">Unit counts aren\'t available yet for this build — Total Cost above is real and complete.</div>';
    }
    body += '<div class="act-section-insight" style="margin-bottom:8px;">' + t.failedSharePct + '% of this total came from calls that failed and produced zero units, still counted in the cost, never in the unit count.</div>';
    body += sampleCallsTable(t);
  }
  var bodyEl = document.getElementById('act-modal-body');
  if (bodyEl) bodyEl.innerHTML = body;
  // actShowModal() (cost-tower.js), not manual classList toggling — it also
  // registers the Escape-key handler and focus trap that toggling the
  // overlay/box classes directly would skip (this exact bypass was already
  // identified and fixed once for this page's other two modal callers).
  actShowModal();
}

// ══════════════════════════════════════════════════════════════════════
// Independent period state (spec Section 4.5) — mirrors actBreakdown/
// actOverviewPeriod's shape and actSetBreakdownPeriod()'s period-resolution
// logic exactly. Outcome-Based Cost no longer reuses actMain/actMonthRange
// locals — it fetches both cost-event rows and outcome rows itself, for
// current + prior range, so its filter genuinely governs every widget.
// ══════════════════════════════════════════════════════════════════════

var actOutcomePeriod = {
  type: 'this_month', label: 'This Month', start: null, end: null,
  summary: null, typeBucketGrouped: [], prevTypeBucketGrouped: [],
  featureGrouped: [], prevFeatureGrouped: [], topCallsByType: [], topCallsByCaller: [],
  outcomes: [], prevOutcomes: [], typeRows: [], callerModes: {}
};

// Sequence guard against out-of-order resolution — mirrors
// _actOverviewPeriodSeq (cost-tower.js). If the user selects a second
// period before the first one's fetch resolves, the first call's
// continuation must not clobber the second's already-committed (or
// still-pending) newer data and re-render with it.
var _actOutcomePeriodSeq = 0;

async function actSetOutcomePeriod(type, customStart, customEnd) {
  actOutcomePeriod.type = type;
  var mySeq = ++_actOutcomePeriodSeq;
  var resolved = actResolvePeriodRange(type, customStart, customEnd);
  var range = resolved.range, prior = resolved.prior;
  actOutcomePeriod.start = range.start; actOutcomePeriod.end = range.end;
  var valEl = document.getElementById('act-outcome-period-value');
  if (valEl) valEl.textContent = actOutcomePeriod.label;
  // All fetches run in one round-trip, including _outcomesFetchTypes()/
  // _outcomesFetchCallerModes() — neither depends on the period range, but
  // running them here (rather than in actRenderOutcomeScreen(), after this
  // Promise.all already resolved) avoids paying a second, fully sequential
  // round-trip on every period change. Cost-side inputs now come from
  // cost-tower.js's server-aggregated RPCs (mt_ai_cost_summary/
  // mt_ai_cost_grouped/mt_ai_cost_top_calls) instead of raw actFetchRows —
  // mt_outcomes_list stays row-based (low volume, hardened with ORDER BY
  // only, see migration file Part G).
  var results = await Promise.all([
    actFetchCostSummary(range.start, range.end),
    actFetchCostGrouped(range.start, range.end, 'outcome_type'),
    actFetchCostGrouped(prior.start, prior.end, 'outcome_type'),
    actFetchCostGrouped(range.start, range.end, 'feature'),
    actFetchCostGrouped(prior.start, prior.end, 'feature'),
    actFetchTopCalls(range.start, range.end, 'cost', 3, 'outcome_type'),
    actFetchTopCalls(range.start, range.end, 'cost', 3, 'caller'),
    _outcomesFetchOutcomeRows(range.start, range.end),
    _outcomesFetchOutcomeRows(prior.start, prior.end),
    _outcomesFetchTypes(),
    _outcomesFetchCallerModes()
  ]);
  if (mySeq !== _actOutcomePeriodSeq) return;
  actOutcomePeriod.summary = results[0];
  actOutcomePeriod.typeBucketGrouped = results[1];
  actOutcomePeriod.prevTypeBucketGrouped = results[2];
  actOutcomePeriod.featureGrouped = results[3];
  actOutcomePeriod.prevFeatureGrouped = results[4];
  actOutcomePeriod.topCallsByType = results[5];
  actOutcomePeriod.topCallsByCaller = results[6];
  actOutcomePeriod.outcomes = results[7];
  actOutcomePeriod.prevOutcomes = results[8];
  actOutcomePeriod.typeRows = results[9];
  actOutcomePeriod.callerModes = results[10];
  await actRenderOutcomeScreen();
}

function actSelectOutcomePeriodChip(type, label) {
  actOutcomePeriod.label = label;
  document.getElementById('act-outcome-period-menu').classList.remove('open');
  actSetOutcomePeriod(type).catch(function (e) { console.error(e); });
}

function actOpenOutcomeCustomRangeModal() {
  document.getElementById('act-outcome-period-menu').classList.remove('open');
  document.getElementById('act-modal-title').textContent = 'Custom Date Range';
  document.getElementById('act-modal-body').innerHTML =
    '<div class="act-config-grid">' +
    '<div class="act-field"><div class="act-field-label">From</div><input id="act-outcome-custom-from" type="date"></div>' +
    '<div class="act-field"><div class="act-field-label">To</div><input id="act-outcome-custom-to" type="date"></div>' +
    '</div>' +
    '<div style="margin-top:14px;color:var(--red);font-size:11px;" id="act-outcome-custom-range-error"></div>' +
    '<div style="margin-top:14px;display:flex;justify-content:flex-end;"><button class="act-btn act-btn-primary act-btn-sm" onclick="actApplyOutcomeCustomRange()">Apply</button></div>';
  actShowModal();
}

async function actApplyOutcomeCustomRange() {
  var fromVal = document.getElementById('act-outcome-custom-from').value;
  var toVal = document.getElementById('act-outcome-custom-to').value;
  var errEl = document.getElementById('act-outcome-custom-range-error');
  if (!fromVal || !toVal) { errEl.textContent = 'Choose both a start and end date.'; return; }
  var start = new Date(fromVal + 'T00:00:00');
  var end = new Date(new Date(toVal + 'T00:00:00').getTime() + 86400000);
  if (start >= end) { errEl.textContent = 'Start date must be before end date.'; return; }
  errEl.textContent = '';
  actCloseModal();
  actOutcomePeriod.label = fromVal + ' – ' + toVal;
  await actSetOutcomePeriod('custom', start, end);
}

// ══════════════════════════════════════════════════════════════════════
// Orchestration — called once from actBoot()'s existing sequential chain
// (after the initial Promise.all, alongside actSetOverviewPeriod()/
// actSetBreakdownPeriod()), not lazily on tab entry. actShowScreen() is a
// pure visibility toggle in this file (confirmed: no per-screen fetch logic
// lives there) — every screen's data loads eagerly at boot, this one
// follows the same pattern rather than inventing a lazy-load convention.
// ══════════════════════════════════════════════════════════════════════

async function actRenderOutcomeScreen() {
  try {
    var currOutcomes = actOutcomePeriod.outcomes;
    var prevOutcomes = actOutcomePeriod.prevOutcomes;
    var typeRows = actOutcomePeriod.typeRows;
    var callerModes = actOutcomePeriod.callerModes;

    TOTAL_AI_SPEND_PERIOD = actOutcomePeriod.summary ? Number(actOutcomePeriod.summary.total_cost) : 0;
    outcomeTypes = buildOutcomeTypes(typeRows, currOutcomes, prevOutcomes,
      actOutcomePeriod.typeBucketGrouped, actOutcomePeriod.prevTypeBucketGrouped,
      actOutcomePeriod.featureGrouped, actOutcomePeriod.prevFeatureGrouped,
      actOutcomePeriod.topCallsByType, actOutcomePeriod.topCallsByCaller,
      callerModes);

    renderExecCards();
    renderOutcomeSupport();
    renderOutcomeKpiStrip();
    renderSunkCostTable();
    renderPortfolio();
  } catch (err) {
    console.error('[Cost Tower] Outcome-Based Cost render failed:', err);
    actToast('Something went wrong loading outcome data. Check the console for details.', 'error');
  }
}
