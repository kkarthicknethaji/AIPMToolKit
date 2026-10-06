// ── OUTCOME PULSE TAB (op) ──
// New tab added by the Outcome Verification Loop feature. Consumes
// outcomeHypothesis data already carried on scCanvas feature objects
// (see feature-canvas.js's shared helpers section) and gData.nsm's
// baseline/target/actual/updatedAt fields (see kpi-tree.js).
//
// This file owns rendering only — the underlying data model, shared
// aggregation/computation helpers (computeHypothesisAggregates,
// computeSuggestedSignal, isOutcomeTrackableFeature, etc.), and the
// hypothesis-capture UI in Feature Canvas's Edit/Add Feature modals all
// live in feature-canvas.js, per the "new features get new files" /
// "don't duplicate a helper across files" conventions.
//
// State: which Outcome Breakdown stage rows are expanded, and the current
// signal-status filter value. Both reset to defaults on every tab entry —
// deliberately NOT persisted across sessions, since this is view-state,
// not session content.
let opExpandedStages=new Set();
let opSignalFilter=''; // '' = all signals
let opMetricFilter=''; // '' = all metrics (v9.11, Outcome Pulse Iteration Loop)
let opGroupMode='stage'; // 'stage' | 'release' (v9.21, Adoption Readiness §3.2) — shares opSignalFilter/opMetricFilter across both views, not a per-view filter

// ── opGetTrackedMetrics — distinct, alphabetically sorted list of metric
// names across tracked features (v9.11). "Tracked" here means the same
// definition isOutcomeTrackableFeature already uses elsewhere in this app —
// a feature carrying outcomeHypothesis at all. Powers the new metric filter
// dropdown; deliberately excludes any metric that has no tracked hypothesis,
// so the dropdown never lists a dead option with zero rows behind it.
function opGetTrackedMetrics(){
  if(!scCanvas||!scCanvas.length)return[];
  const set=new Set();
  scCanvas.forEach(function(f){
    if(!isOutcomeTrackableFeature(f))return;
    const m=f.outcomeHypothesis.primary&&f.outcomeHypothesis.primary.metric;
    if(m)set.add(m);
  });
  return[...set].sort(function(a,b){return a.localeCompare(b);});
}

// ── Entry point, called by switchTab('op') ──
function opRender(){
  const root=document.getElementById('op-main');
  if(!root)return;
  if(!gData){
    root.innerHTML=`<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;padding:48px 24px;text-align:center;color:var(--t3);">
      <div style="font-size:13px;font-weight:600;color:var(--t2);margin-bottom:6px;">No Discovery Map yet</div>
      <div style="font-size:11px;max-width:320px;line-height:1.6;">Generate a Discovery Map first — Outcome Pulse tracks hypotheses against your product's value chain stages.</div>
    </div>`;
    return;
  }
  root.innerHTML=`
    <div style="padding:16px 18px;background:var(--card);flex:1;overflow-y:auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div style="font-size:13px;font-weight:700;color:var(--t1);">Outcome Pulse</div>
        <button class="export-cta-btn" id="op-export-btn" onclick="opDownloadReport()"><i class="ti ti-download" style="font-size:11px;" aria-hidden="true"></i> Export</button>
      </div>
      <div id="op-export-target">
        <div id="op-export-header" style="text-align:center;font-size:30px;font-weight:700;color:var(--t1);margin-bottom:16px;display:none;"></div>
        <div id="op-top-row" style="display:flex;gap:12px;align-items:stretch;margin-bottom:14px;"></div>
        <div id="op-breakdown-card"></div>
      </div>
    </div>
  `;
  opRenderTopRow();
  opRenderBreakdown();
}

// ══════════════════════════════════════════════════════════════════════
// NSM card + Hypothesis Health card (top row)
// ══════════════════════════════════════════════════════════════════════

function opRenderTopRow(){
  const container=document.getElementById('op-top-row');
  if(!container)return;
  container.innerHTML=`
    <div id="op-nsm-wrap" style="width:25%;flex-shrink:0;position:relative;">${opBuildNSMCardHTML()}</div>
    <div id="op-hyp-health-wrap" style="width:75%;">${opBuildHypHealthCardHTML()}</div>
  `;
  opAttachNSMHoverHandlers();
}

// ── Number formatting with thousands separators (OP-3) — applied to every
// DISPLAYED (non-input) numeric value across Outcome Pulse. Live input
// fields keep raw unformatted values, since a user typing "7,000" into a
// number input is exactly the kind of thing browsers reject. ──
function opFormatNumber(n){
  if(n===null||n===undefined||n===''||isNaN(Number(n)))return String(n===null||n===undefined?'—':n);
  const num=Number(n);
  // v9.12.06 fix: previously used only {maximumFractionDigits:2}, which
  // rounds correctly (61.5643->61.56, 61.5678->61.57) but does NOT pad a
  // single-decimal value up to two digits (61.5 stayed "61.5" instead of
  // "61.50"). Whole numbers were already correct before this fix (100
  // stayed "100", not "100.00") and must stay that way — so this can't be
  // a single toLocaleString call with a fixed minimumFractionDigits (that
  // would force "100.00"); it has to check, after rounding, whether the
  // result is actually a whole number and only pad to 2dp otherwise.
  const rounded=Math.round(num*100)/100;
  if(Number.isInteger(rounded))return rounded.toLocaleString('en-US');
  return rounded.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
}

// ── Normalize gData.nsm for backward compatibility — old sessions won't
// have unit/customLabel (added in this build), per this app's no-schema-
// versioning convention: absence must always be treated as valid "not set
// yet," never assumed present. Every NSM read path should go through this. ──
function opNormalizeNsm(nsm){
  return{
    metric:(nsm&&nsm.metric)||'',
    definition:(nsm&&nsm.definition)||'',
    unit:(nsm&&nsm.unit)||'',
    customLabel:(nsm&&nsm.customLabel)||'',
    baseline:(nsm&&nsm.baseline!==undefined&&nsm.baseline!==null)?nsm.baseline:null,
    target:(nsm&&nsm.target!==undefined&&nsm.target!==null)?nsm.target:null,
    actual:(nsm&&nsm.actual!==undefined&&nsm.actual!==null)?nsm.actual:null,
    updatedAt:(nsm&&nsm.updatedAt)||null
  };
}

function opBuildNSMCardHTML(){
  const nsm=opNormalizeNsm(gData&&gData.nsm);
  const hasActual=nsm.actual!==null;
  const hasBaselineTarget=nsm.baseline!==null&&nsm.target!==null;
  let trajectoryText='Not yet tracked',trajectoryIcon='ti-minus',trajectoryColor='var(--t3)';
  let progressPct=0;
  if(hasActual&&hasBaselineTarget){
    const range=nsm.target-nsm.baseline;
    progressPct=range!==0?Math.max(0,Math.min(100,((nsm.actual-nsm.baseline)/range)*100)):0;
    const movedFraction=range!==0?(nsm.actual-nsm.baseline)/range:0;
    if(Math.abs(nsm.actual-nsm.baseline)<=Math.abs(range)*0.02){trajectoryText='Flat';trajectoryIcon='ti-minus';trajectoryColor='var(--t3)';}
    else if(movedFraction>0){trajectoryText='Tracking toward target';trajectoryIcon='ti-trending-up';trajectoryColor='var(--green)';}
    else{trajectoryText='Moving away from target';trajectoryIcon='ti-trending-down';trajectoryColor='var(--red)';}
  }
  const _canEditOp=(typeof canEditSession!=='function')||canEditSession();
  const updatedLabel=nsm.updatedAt?opFormatRelativeTime(nsm.updatedAt):'Never';
  const unitSuffix=formatOutcomeUnit(nsm.unit,nsm.customLabel);
  return`
    <div style="background:#fff;border:1px solid var(--divider);border-radius:10px;padding:14px 16px;height:100%;box-sizing:border-box;">
      <div style="font-size:9px;font-weight:700;color:var(--label);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">North Star Metric</div>
      <div style="font-size:10px;font-weight:600;color:var(--t2);margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${e(nsm.metric||'')}">${e(nsm.metric||'No North Star Metric set')}</div>
      <div style="font-size:30px;font-weight:700;color:var(--t1);line-height:1;margin-bottom:6px;">${hasActual?e(opFormatNumber(nsm.actual)):'—'}${hasActual&&unitSuffix?`<span style="font-size:16px;color:var(--t3);"> ${e(unitSuffix)}</span>`:''}</div>
      <div style="font-size:10px;color:${trajectoryColor};font-weight:600;display:flex;align-items:center;gap:4px;margin-bottom:10px;"><i class="ti ${trajectoryIcon}" style="font-size:12px;" aria-hidden="true"></i> ${trajectoryText}</div>
      <div style="height:6px;background:var(--divider);border-radius:3px;overflow:hidden;margin-bottom:10px;"><div style="width:${progressPct}%;height:100%;background:var(--green);"></div></div>
      <div style="border-top:1px solid var(--divider);padding-top:9px;display:flex;">
        <div style="flex:1;"><div style="font-size:8px;color:var(--label);text-transform:uppercase;">Baseline</div><div style="font-size:11px;font-weight:600;color:var(--t2);">${nsm.baseline!==null?e(opFormatNumber(nsm.baseline)):'—'}</div></div>
        <div style="flex:1;text-align:center;border-left:1px solid var(--divider);border-right:1px solid var(--divider);"><div style="font-size:8px;color:var(--label);text-transform:uppercase;">Target</div><div style="font-size:11px;font-weight:600;color:var(--t2);">${nsm.target!==null?e(opFormatNumber(nsm.target)):'—'}</div></div>
        <div style="flex:1;text-align:right;"><div style="font-size:8px;color:var(--label);text-transform:uppercase;">Updated</div><div style="font-size:11px;font-weight:600;color:var(--t2);">${e(updatedLabel)}</div></div>
      </div>
      ${_canEditOp?`<div id="op-nsm-pencil" onclick="opOpenNSMEditModal()" style="position:absolute;top:24px;right:22px;width:18px;height:18px;border-radius:5px;background:var(--purple-pale);display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;transition:opacity 0.12s;" title="Edit"><i class="ti ti-pencil" style="font-size:9px;color:var(--purple);" aria-hidden="true"></i></div>`:''}
    </div>
  `;
}

// ── Hover reveal for the pencil icon — attached once per render via the wrapper ──
function opAttachNSMHoverHandlers(){
  const wrap=document.getElementById('op-nsm-wrap');
  const pencil=document.getElementById('op-nsm-pencil');
  if(!wrap||!pencil)return;
  wrap.addEventListener('mouseenter',()=>{pencil.style.opacity='1';});
  wrap.addEventListener('mouseleave',()=>{pencil.style.opacity='0';});
}

// ── OP-2: NSM edit modal (replaces the old pinned overlay entirely). ──
// A real modal — height is never constrained by the triggering card, so
// the overflow-past-boundary bug (§ old opOpenNSMEditOverlay) cannot
// recur by construction, not by patching a height value.
//
// Structure per the agreed redesign:
//  - hero "current actual" field, always visible, matches the frequent/
//    low-stakes edit action (logging a fresh actual reading)
//  - collapsed "Edit metric definition" section (name/unit/baseline/
//    target) — a rare, higher-consequence action, kept visually and
//    interactionally separate so casually opening this modal to log a
//    number never puts the metric name in the same weight as a quick
//    value update. Auto-EXPANDED only when baseline AND target are both
//    strictly null (first-time setup) — an explicit null check, never a
//    falsy check, so a real baseline/target of 0 is never mistaken for
//    "not set yet" (per review finding).
//  - amber cross-tab notice, shown only once the definition section is
//    expanded, since only then does editing something with a Discovery
//    Map consequence become possible
//  - Option A only (per design decision): this modal is reachable only
//    from Outcome Pulse, never from Discovery Map.
function opOpenNSMEditModal(){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const nsm=opNormalizeNsm(gData&&gData.nsm);
  const isFirstTimeSetup=(nsm.baseline===null&&nsm.target===null);
  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.id='op-nsm-modal-overlay';
  overlay.innerHTML=`<div class="modal" style="max-width:420px;position:relative;">
    <button onclick="document.getElementById('op-nsm-modal-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:16px 44px 12px 16px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:500;color:var(--t1);">Update North Star Metric</div>
    </div>
    <div style="padding:16px 20px 4px;display:flex;flex-direction:column;gap:12px;">

      <div style="background:var(--card);border-radius:8px;padding:12px 14px;">
        <div style="font-size:9px;font-weight:700;color:var(--label);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;" id="op-nsm-modal-metric-label">${e(nsm.metric||'North Star Metric')}</div>
        <div style="display:flex;align-items:center;gap:10px;">
          <label style="font-size:10px;color:var(--t2);white-space:nowrap;">Current actual</label>
          <input id="op-nsm-actual-input" type="number" step="any" value="${nsm.actual!==null?nsm.actual:''}"
            style="flex:1;height:32px;border:1.5px solid var(--purple);border-radius:6px;padding:0 10px;font-size:13px;font-weight:600;color:var(--purple);font-family:var(--font);background:#fff;box-sizing:border-box;" />
          <span style="font-size:11px;color:var(--t3);">${e(formatOutcomeUnit(nsm.unit,nsm.customLabel))}</span>
        </div>
      </div>

      <div id="op-nsm-def-toggle" onclick="opToggleNsmDefinitionSection()" style="display:flex;align-items:center;justify-content:space-between;padding-top:12px;cursor:pointer;border-top:0.5px dashed var(--divider);">
        <div style="font-size:10.5px;font-weight:600;color:var(--t2);display:flex;align-items:center;gap:5px;">
          <i class="ti ti-adjustments" style="font-size:12px;color:var(--t3);" aria-hidden="true"></i> Edit metric definition
        </div>
        <i class="ti ti-chevron-down" id="op-nsm-def-chevron" style="font-size:12px;color:var(--t3);transition:transform 0.15s;${isFirstTimeSetup?'transform:rotate(0deg);':'transform:rotate(-90deg);'}" aria-hidden="true"></i>
      </div>

      <div id="op-nsm-def-section" style="display:${isFirstTimeSetup?'flex':'none'};flex-direction:column;gap:10px;">
        <div style="background:var(--amber-pale);border-radius:6px;padding:8px 10px;display:flex;gap:6px;align-items:flex-start;">
          <i class="ti ti-info-circle" style="font-size:12px;color:var(--amber);margin-top:1px;" aria-hidden="true"></i>
          <span style="font-size:9.5px;color:#633806;line-height:1.5;">Editing name, unit, baseline or target here also updates the North Star Metric shown in Discovery Map.</span>
        </div>
        <div>
          <label style="font-size:9px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Metric name</label>
          <input id="op-nsm-name-input" type="text" maxlength="80" value="${e(nsm.metric||'')}"
            style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);background:var(--bg);box-sizing:border-box;" />
        </div>
        <div style="display:grid;grid-template-columns:70px minmax(0,1fr) minmax(0,1fr);gap:6px;">
          <div style="min-width:0;">
            <label style="font-size:9px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Unit</label>
            <select id="op-nsm-unit-input" onchange="opSyncNsmCustomUnitVisibility()" style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 5px;font-size:11px;font-family:var(--font);color:var(--t1);background:var(--bg);box-sizing:border-box;">
              ${_scOutcomeUnitOptionsHTML(nsm.unit)}
            </select>
          </div>
          <div style="min-width:0;">
            <label style="font-size:9px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Baseline</label>
            <input id="op-nsm-baseline-input" type="number" step="any" value="${nsm.baseline!==null?nsm.baseline:''}"
              style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);background:var(--bg);box-sizing:border-box;" />
          </div>
          <div style="min-width:0;">
            <label style="font-size:9px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Target</label>
            <input id="op-nsm-target-input" type="number" step="any" value="${nsm.target!==null?nsm.target:''}"
              style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);background:var(--bg);box-sizing:border-box;" />
          </div>
        </div>
        <div id="op-nsm-custom-label-row" style="display:${nsm.unit==='custom'?'block':'none'};">
          <label style="font-size:9px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Custom unit label</label>
          <input id="op-nsm-custom-label-input" type="text" maxlength="20" value="${e(nsm.customLabel||'')}"
            style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);background:var(--bg);box-sizing:border-box;" />
        </div>
      </div>

    </div>
    <div class="modal-footer">
      <button class="modal-cancel-btn" onclick="document.getElementById('op-nsm-modal-overlay').remove()">Cancel</button>
      <button class="modal-confirm-btn" onclick="opSaveNSMEdit()">Save</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const actualInput=document.getElementById('op-nsm-actual-input');
  if(actualInput){actualInput.focus();actualInput.select();}
  const _esc=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_esc,true);}};
  document.addEventListener('keydown',_esc,true);
  if(typeof trapFocus==='function')trapFocus(overlay);
}

function opToggleNsmDefinitionSection(){
  const section=document.getElementById('op-nsm-def-section');
  const chevron=document.getElementById('op-nsm-def-chevron');
  if(!section)return;
  const collapsed=section.style.display==='none';
  section.style.display=collapsed?'flex':'none';
  if(chevron)chevron.style.transform=collapsed?'rotate(0deg)':'rotate(-90deg)';
}

function opSyncNsmCustomUnitVisibility(){
  const unitEl=document.getElementById('op-nsm-unit-input'),row=document.getElementById('op-nsm-custom-label-row');
  if(!unitEl||!row)return;
  row.style.display=unitEl.value==='custom'?'block':'none';
}

// ── Save NSM edit — mm-area manual edit, per resolved decision (open
// question 11): uses the EXISTING mm-canvas wholesale-apply/confirm-gate
// live-sync fallback. No new event type built. Snapshot-before/mutate-
// locally/persist-then-revert-on-failure discipline still applies to the
// save itself, per this project's mandated mutation pattern. ──
function opSaveNSMEdit(){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  if(!gData)return;
  if(!gData.nsm)gData.nsm={metric:'',definition:'',baseline:null,target:null,actual:null,updatedAt:null,unit:'',customLabel:''};
  const aEl=document.getElementById('op-nsm-actual-input');
  const nameEl=document.getElementById('op-nsm-name-input');
  const unitEl=document.getElementById('op-nsm-unit-input');
  const clEl=document.getElementById('op-nsm-custom-label-input');
  const bEl=document.getElementById('op-nsm-baseline-input');
  const tEl=document.getElementById('op-nsm-target-input');
  // Snapshot every field for revert-on-save-failure — per mandated
  // discipline, mutate locally first, persist, only keep the mutation if
  // the save actually succeeds.
  const _prev={metric:gData.nsm.metric,unit:gData.nsm.unit,customLabel:gData.nsm.customLabel,
    baseline:gData.nsm.baseline,target:gData.nsm.target,actual:gData.nsm.actual,updatedAt:gData.nsm.updatedAt};
  // Definition fields only exist in the DOM if the collapsible section was
  // ever rendered open — if a user only touched "current actual" and
  // never expanded the definition section, these elements won't exist,
  // and the existing gData.nsm values for name/unit/baseline/target must
  // be left completely untouched, not overwritten with blanks.
  if(nameEl)gData.nsm.metric=nameEl.value.trim();
  if(unitEl)gData.nsm.unit=unitEl.value;
  if(clEl)gData.nsm.customLabel=unitEl&&unitEl.value==='custom'?clEl.value.trim():'';
  if(bEl)gData.nsm.baseline=bEl.value!==''?Number(bEl.value):null;
  if(tEl)gData.nsm.target=tEl.value!==''?Number(tEl.value):null;
  gData.nsm.actual=aEl&&aEl.value!==''?Number(aEl.value):null;
  gData.nsm.updatedAt=new Date().toISOString();
  const overlay=document.getElementById('op-nsm-modal-overlay');
  if(overlay)overlay.remove();
  opRenderTopRow();
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    const _saveSessionId=_activeSessionId;
    sessionStoreSave(_saveSessionId).then(function(ok){
      if(!ok){
        if(gData&&gData.nsm){
          gData.nsm.metric=_prev.metric;gData.nsm.unit=_prev.unit;gData.nsm.customLabel=_prev.customLabel;
          gData.nsm.baseline=_prev.baseline;gData.nsm.target=_prev.target;
          gData.nsm.actual=_prev.actual;gData.nsm.updatedAt=_prev.updatedAt;
        }
        opRenderTopRow();
        if(typeof showToast==='function')showToast('Failed to save. Changes reverted.','error');
        return;
      }
      // No new live-sync event type — mm's existing wholesale-apply/
      // confirm-gate mechanism already covers gData broadly (per resolved
      // open question 11). Nothing further to emit here. Also: gData.nsm.metric
      // is the single source of truth Discovery Map's own NSM display already
      // reads from, so no separate write-back step is needed — Discovery
      // Map picks this up automatically the next time it renders.
    });
  }
}

// ── Relative time formatting for the "Updated" field — plain, no
// staleness color/warning treatment at all, per resolved design decision. ──
function opFormatRelativeTime(isoString){
  if(!isoString)return'Never';
  const then=new Date(isoString).getTime();
  if(isNaN(then))return'Never';
  const diffMs=Date.now()-then;
  const mins=Math.floor(diffMs/60000);
  if(mins<1)return'Just now';
  if(mins<60)return mins+'m ago';
  const hrs=Math.floor(mins/60);
  if(hrs<24)return hrs+'h ago';
  const days=Math.floor(hrs/24);
  if(days<30)return days+'d ago';
  const months=Math.floor(days/30);
  if(months<12)return months+'mo ago';
  return Math.floor(months/12)+'y ago';
}

// ══════════════════════════════════════════════════════════════════════
// Hypothesis Health card
// ══════════════════════════════════════════════════════════════════════

function opBuildHypHealthCardHTML(){
  const agg=computeHypothesisAggregates(scCanvas);
  const total=agg.trackedCount;
  const pct=(n)=>total>0?Math.round((n/total)*100):0;
  const segs=[
    {n:agg.aligned,color:'var(--green)'},
    {n:agg.opposed,color:'var(--red)'},
    {n:agg.noChange,color:'var(--amber)'},
    {n:agg.awaiting,color:'var(--divider)'}
    // Not applicable is intentionally excluded from the visual distribution
    // bar and the count grid — it's a real, all-features-visible dashboard
    // decision (per spec §5 — every feature should still be visible in the
    // dashboard, not hidden), but a "not applicable" hypothesis carries no
    // signal information worth a colored segment in a signal-distribution
    // bar. Its count is still shown as a plain 5th number below.
  ];
  const barHTML=total>0
    ?segs.map(s=>`<div style="width:${pct(s.n)}%;background:${s.color};"></div>`).join('')
    :`<div style="width:100%;background:var(--divider);"></div>`;
  return`
    <div style="background:#fff;border:1px solid var(--divider);border-radius:10px;padding:14px 16px;height:100%;box-sizing:border-box;">
      <div style="font-size:9px;font-weight:700;color:var(--label);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Hypothesis Health</div>
      <div style="font-size:10px;color:var(--t3);margin-bottom:10px;">${total} feature${total===1?'':'s'} - ${total} hypothes${total===1?'is':'es'} tracked</div>
      <div style="display:flex;height:12px;border-radius:6px;overflow:hidden;margin-bottom:10px;">${barHTML}</div>
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:10px;">
        <div><div style="display:flex;align-items:center;gap:4px;"><span style="width:7px;height:7px;border-radius:2px;background:var(--green);"></span><span style="font-size:9px;font-weight:600;color:var(--t2);">Aligned</span></div><div style="font-size:15px;font-weight:700;color:var(--t1);">${agg.aligned}</div></div>
        <div><div style="display:flex;align-items:center;gap:4px;"><span style="width:7px;height:7px;border-radius:2px;background:var(--red);"></span><span style="font-size:9px;font-weight:600;color:var(--t2);">Opposed</span></div><div style="font-size:15px;font-weight:700;color:var(--t1);">${agg.opposed}</div></div>
        <div><div style="display:flex;align-items:center;gap:4px;"><span style="width:7px;height:7px;border-radius:2px;background:var(--amber);"></span><span style="font-size:9px;font-weight:600;color:var(--t2);">No Change</span></div><div style="font-size:15px;font-weight:700;color:var(--t1);">${agg.noChange}</div></div>
        <div><div style="display:flex;align-items:center;gap:4px;"><span style="width:7px;height:7px;border-radius:2px;background:var(--divider);"></span><span style="font-size:9px;font-weight:600;color:var(--t2);">Awaiting</span></div><div style="font-size:15px;font-weight:700;color:var(--t1);">${agg.awaiting}</div></div>
        <div><div style="display:flex;align-items:center;gap:4px;"><span style="width:7px;height:7px;border-radius:2px;background:var(--label);"></span><span style="font-size:9px;font-weight:600;color:var(--t2);">Not Applicable</span></div><div style="font-size:15px;font-weight:700;color:var(--t1);">${agg.notApplicable}</div></div>
      </div>
      <div style="border-top:0.5px dashed var(--divider);padding-top:8px;font-size:8.5px;color:var(--t3);line-height:1.6;">
        <b style="color:var(--green);">Aligned</b> = moved as expected &middot; <b style="color:var(--red);">Opposed</b> = moved the wrong way &middot; <b style="color:var(--amber);">No Change</b> = stayed flat &middot; <b style="color:var(--t3);">Awaiting</b> = no result logged yet &middot; <b style="color:var(--label);">Not Applicable</b> = out of scope
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════
// Outcome Breakdown — stage rows derived from the LIVE gData.stages array
// (per §6.5 Finding B — never hard-coded to Acquisition/Activation/
// Engagement/Retention, since stage sets vary by industry/framework and
// are user-renameable).
// ══════════════════════════════════════════════════════════════════════

function opRenderBreakdown(){
  const container=document.getElementById('op-breakdown-card');
  if(!container)return;
  const stageRows=(opGroupMode==='release')?opBuildReleaseGroups():opBuildStageGroups();
  let rowsHTML='';
  stageRows.forEach(sg=>{
    const isExpanded=opExpandedStages.has(sg.stageKey);
    const agg=sg.aggregates;
    const total=agg.trackedCount;
    const pct=(n)=>total>0?Math.round((n/total)*100):0;
    const segs=[
      {n:agg.aligned,color:'var(--green)'},{n:agg.opposed,color:'var(--red)'},
      {n:agg.noChange,color:'var(--amber)'},{n:agg.awaiting,color:'var(--divider)'}
    ];
    const miniBarHTML=total>0?segs.map(s=>`<div style="width:${pct(s.n)}%;background:${s.color};"></div>`).join(''):`<div style="width:100%;background:var(--divider);"></div>`;
    rowsHTML+=`
      <div style="border-bottom:1px solid var(--divider);${isExpanded?'background:var(--card);':''}">
        <div onclick="opToggleStage('${e(sg.stageKey)}')" style="display:flex;align-items:center;padding:10px 16px;cursor:pointer;">
          <i class="ti ${isExpanded?'ti-chevron-down':'ti-chevron-right'}" style="font-size:11px;color:${isExpanded?'var(--purple)':'var(--label)'};margin-right:8px;" aria-hidden="true"></i>
          <div style="flex:1;min-width:0;"><div style="font-size:11px;font-weight:600;color:var(--t1);">${e(sg.stageLabel)}</div><div style="font-size:9px;color:var(--label);">${sg.features.length} feature${sg.features.length===1?'':'s'} - ${total} hypothes${total===1?'is':'es'}</div></div>
          <div style="display:flex;height:8px;width:160px;border-radius:4px;overflow:hidden;">${miniBarHTML}</div>
        </div>
        ${isExpanded?opBuildStageLedgerHTML(sg):''}
      </div>
    `;
  });
  container.innerHTML=`
    <div style="background:#fff;border:1px solid var(--divider);border-radius:10px;overflow:hidden;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--divider);">
        <div style="font-size:11px;font-weight:700;color:var(--t1);text-transform:uppercase;letter-spacing:0.5px;">Outcome Breakdown</div>
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="op-group-toggle">
            <button class="op-group-toggle-btn ${opGroupMode==='stage'?'active':''}" onclick="opSetGroupMode('stage')">By Stage</button>
            <button class="op-group-toggle-btn ${opGroupMode==='release'?'active':''}" onclick="opSetGroupMode('release')">By Release</button>
          </div>
          <div class="op-filter-ctrl">
            <i class="ti ti-filter" aria-hidden="true"></i>
            <select id="op-signal-filter" onchange="opSetSignalFilter(this.value)" class="op-filter-select">
              <option value="">All Signals</option>
              <option value="aligned" ${opSignalFilter==='aligned'?'selected':''}>Aligned</option>
              <option value="opposed" ${opSignalFilter==='opposed'?'selected':''}>Opposed</option>
              <option value="no-change" ${opSignalFilter==='no-change'?'selected':''}>No Change</option>
              <option value="awaiting" ${opSignalFilter==='awaiting'?'selected':''}>Awaiting</option>
              <option value="not-applicable" ${opSignalFilter==='not-applicable'?'selected':''}>Not Applicable</option>
            </select>
          </div>
          <div class="op-filter-ctrl">
            <i class="ti ti-chart-line" aria-hidden="true"></i>
            <select id="op-metric-filter" onchange="opSetMetricFilter(this.value)" class="op-filter-select">
              <option value="" title="All Metrics">All Metrics</option>
              ${opGetTrackedMetrics().map(m=>`<option value="${e(m)}" title="${e(m)}" ${opMetricFilter===m?'selected':''}>${e(m)}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>
      ${rowsHTML||`<div style="padding:32px 16px;text-align:center;color:var(--t3);font-size:11px;">No tracked hypotheses yet. Add one from a feature's Edit or Add Feature modal.</div>`}
    </div>
  `;
}

// ── Derive stage groups from the LIVE gData.stages array, never hard-coded ──
function opBuildStageGroups(){
  const stageOrder=(gData&&gData.stages)?gData.stages.map(s=>({key:s.id||s.label,label:s.label})):[];
  const byStage={};
  stageOrder.forEach(s=>{byStage[s.key]={stageKey:s.key,stageLabel:s.label,features:[]};});
  // "Unmapped" bucket for any feature whose stage doesn't match a current
  // gData.stages entry (per §6.5 Finding B) — can happen after certain
  // edits/renames elsewhere in the app.
  const UNMAPPED_KEY='__unmapped__';
  scCanvas.forEach(f=>{
    if(!isOutcomeTrackableFeature(f))return;
    const matchedStage=stageOrder.find(s=>s.label===f.stage||s.key===f.stage);
    const key=matchedStage?matchedStage.key:UNMAPPED_KEY;
    if(!byStage[key])byStage[key]={stageKey:UNMAPPED_KEY,stageLabel:'Unmapped',features:[]};
    byStage[key].features.push(f);
  });
  // Apply the signal filter and (v9.11) metric filter to each stage's
  // feature list before aggregating, so counts and the mini bar reflect the
  // filtered view, not the total. Both filters apply together (AND), not
  // as alternatives.
  const filtered=Object.values(byStage).map(sg=>{
    let filteredFeatures=opSignalFilter
      ?sg.features.filter(f=>{
          const sig=f.outcomeHypothesis.primary&&f.outcomeHypothesis.primary.signal;
          const normalizedSig=sig||'awaiting';
          return normalizedSig===opSignalFilter;
        })
      :sg.features;
    if(opMetricFilter){
      filteredFeatures=filteredFeatures.filter(f=>f.outcomeHypothesis.primary&&f.outcomeHypothesis.primary.metric===opMetricFilter);
    }
    return{...sg,features:filteredFeatures,aggregates:computeHypothesisAggregates(filteredFeatures)};
  });
  // Only show stages with at least one tracked feature (post-filter)
  return filtered.filter(sg=>sg.features.length>0);
}

// ── By Release grouping (v9.21, Adoption Readiness §3.2) — same shape/
// filter logic as opBuildStageGroups() above, grouping by which Release
// Plan last touched each feature (resolved per-story via that plan's
// storyAssignments, rolled up to feature level) instead of by value-chain
// stage. A feature touched by multiple releases appears once per release
// group it belongs to (same underlying hypothesis object each time — this
// app does not persist a separate hypothesis snapshot per release, see
// ADOPTION_READINESS_SPEC.md §5 non-goals: no per-release checkpoint
// field). Shares opSignalFilter/opMetricFilter with the Stage view. ──
function opBuildReleaseGroups(){
  // A release only earns a place in the outcome breakdown once its own
  // Adoption Readiness plan has been finalized — a draft/in-review release
  // hasn't actually launched yet, so there's no real outcome signal to
  // attribute to it (matches the same "draft content shouldn't count as
  // done" principle used throughout Adoption Readiness's review gating).
  const readinessPlans=(typeof piReadinessPlans!=='undefined'?piReadinessPlans:[]);
  const plans=(typeof piPlans!=='undefined'?piPlans:[]).filter(p=>{
    const rp=readinessPlans.find(r=>r.releasePlanId===p.id);
    return rp&&rp.status==='finalized';
  });
  const byRelease={};
  plans.forEach(p=>{byRelease[p.id]={stageKey:'release:'+p.id,stageLabel:p.name||'Untitled Release',features:[]};});
  scCanvas.forEach(f=>{
    if(!isOutcomeTrackableFeature(f))return;
    if(!f.stories||!f.stories.length)return;
    const storyIds=f.stories.map(s=>s.id);
    plans.forEach(p=>{
      const touched=storyIds.some(id=>p.storyAssignments&&p.storyAssignments[id]);
      if(touched)byRelease[p.id].features.push(f);
    });
  });
  const filtered=Object.values(byRelease).map(sg=>{
    let filteredFeatures=opSignalFilter
      ?sg.features.filter(f=>{
          const sig=f.outcomeHypothesis.primary&&f.outcomeHypothesis.primary.signal;
          const normalizedSig=sig||'awaiting';
          return normalizedSig===opSignalFilter;
        })
      :sg.features;
    if(opMetricFilter){
      filteredFeatures=filteredFeatures.filter(f=>f.outcomeHypothesis.primary&&f.outcomeHypothesis.primary.metric===opMetricFilter);
    }
    return{...sg,features:filteredFeatures,aggregates:computeHypothesisAggregates(filteredFeatures)};
  });
  // Same rule as Stage view: a release group with zero surviving rows after
  // filtering does not render at all — no placeholder/empty-state for it.
  return filtered.filter(sg=>sg.features.length>0);
}

function opSetGroupMode(mode){
  opGroupMode=(mode==='release')?'release':'stage';
  opRenderBreakdown();
}

function opToggleStage(stageKey){
  if(opExpandedStages.has(stageKey))opExpandedStages.delete(stageKey);
  else opExpandedStages.add(stageKey);
  opRenderBreakdown();
}

function opSetSignalFilter(val){
  opSignalFilter=val;
  opRenderBreakdown();
}

function opSetMetricFilter(val){
  opMetricFilter=val;
  opRenderBreakdown();
}

// ── opCountPulseExperimentsForMetric — v9.11. Counts ONLY
// productLeakAnalysis runs with source==='outcome-pulse' whose experiments
// target this exact metric name. Deliberately excludes real-diagnostic-
// origin runs even if they target the same metric, matching Experiment
// Library's own scoping exactly (per explicit decision) — the badge must
// never promise more than Library actually shows.
function opCountPulseExperimentsForMetric(metricName){
  if(!metricName||typeof productLeakAnalysis==='undefined'||!productLeakAnalysis)return 0;
  let count=0;
  productLeakAnalysis.forEach(function(run){
    const src=run.source||'diagnostic';
    if(src!=='outcome-pulse')return;
    (run.experiments||[]).forEach(function(exp){
      if(exp.linkedMetricName===metricName)count++;
    });
  });
  return count;
}

// ── opToggleRowMenu — the new 3-dot kebab menu replacing "Log Result" as a
// bare text link (v9.11). Reuses the app's existing generic row-menu
// helper (_uiRowMenuToggle, utils.js) already proven in Home and Team
// Management — no new dropdown component invented. Menu items are built
// fresh on every open so they always reflect current state (no stale
// closures over feature id).
function opToggleRowMenu(triggerEl,fid){
  // v9.11.03 (Fix 9) — look up the feature via the fid this function
  // already receives, rather than changing the call signature at
  // opBuildStageLedgerHTML's single call site. An experiment-derived card
  // (origin==='diagnostic', covering BOTH real-Diagnostic-Analysis-origin
  // and Outcome-Pulse-origin — this is a structural rule about "is this
  // card itself already an experiment," not about which mechanism produced
  // it, per explicit decision) cannot itself be the source of a further
  // Suggest Experiment call, to avoid an unbounded chain of experiment-of-
  // an-experiment cards. Shown disabled with an explanatory tooltip rather
  // than hidden outright — a PM looking at this row might reasonably
  // wonder why the option is missing, and a taught boundary is better than
  // a silent one, per this app's own hidden-vs-disabled convention for
  // cases where the "why" matters to the user.
  const _feat=scCanvas.find(function(f){return f.id===fid;});
  const _isExperimentDerived=!!(_feat&&_feat.origin==='diagnostic');
  const _suggestItem=_isExperimentDerived
    ?'<div class="tm-menu-item" role="menuitem" tabindex="-1" aria-disabled="true" style="color:var(--label);cursor:not-allowed;" title="Experiments can only be generated for original features, not experiment-derived ones.">Suggest Experiment</div>'
    :'<div class="tm-menu-item" role="menuitem" tabindex="-1" onclick="_uiRowMenuClose();opOpenSuggestExperimentModal(\''+fid.replace(/'/g,"\\'")+'\')">Suggest Experiment</div>';
  const menuHtml='<div style="width:170px;background:#fff;border:1px solid var(--divider);border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,0.12);overflow:hidden;">'
    +'<div class="tm-menu-item" role="menuitem" tabindex="-1" onclick="_uiRowMenuClose();opOpenHypothesisModal(\''+fid.replace(/'/g,"\\'")+'\')">Log Result</div>'
    +_suggestItem
    +'<div class="tm-menu-item" role="menuitem" tabindex="-1" onclick="_uiRowMenuClose();opOpenExperimentLibrary(\''+fid.replace(/'/g,"\\'")+'\')">Experiment Library</div>'
    +'</div>';
  _uiRowMenuToggle(triggerEl,menuHtml);
}

// ── Expanded stage row — full ledger detail inline (merged Layer 2+3) ──
// ── Shared column-width scheme for every Outcome Breakdown ledger table
// (OP-4 fix) — previously each stage rendered its own auto-sized table,
// so column boundaries didn't line up between stages with different
// text lengths. table-layout:fixed + one shared colgroup forces every
// stage's table to the same column widths regardless of its own content.
// Widths re-balanced to fit 7 columns after adding "Last Updated"
// (between Signal and Action) — Feature/Metric trimmed slightly to make
// room, everything else unchanged from the 6-column scheme.
const OP_LEDGER_COLGROUP=`
  <colgroup>
    <col style="width:21%;">
    <col style="width:18%;">
    <col style="width:15%;">
    <col style="width:11%;">
    <col style="width:13%;">
    <col style="width:12%;">
    <col style="width:10%;">
  </colgroup>
`;

function opBuildStageLedgerHTML(sg){
  // Sort features alphabetically by name within this stage (item 9,
  // v9.10.01 feedback round) — previously unspecified/insertion-order.
  const sortedFeatures=[...sg.features].sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  let rows='';
  sortedFeatures.forEach((f,i)=>{
    const p=f.outcomeHypothesis.primary;
    const sig=p.signal||'awaiting';
    const badge=opBuildSignalBadgeHTML(sig);
    const actualDisplay=p.actual!==null&&p.actual!==undefined?e(opFormatNumber(p.actual)):'-';
    // v9.10.03 (BUILD-4): previously an all-or-nothing AND condition —
    // if EITHER baseline or target was missing, the whole cell showed a
    // bare "-", silently discarding whatever value DID exist. Now each
    // side is formatted independently (opFormatNumber already returns
    // "—" for null/undefined on its own), only collapsing to a bare "-"
    // when BOTH are genuinely absent.
    const hasBaseline=p.baseline!==null&&p.baseline!==undefined;
    const hasTarget=p.target!==null&&p.target!==undefined;
    const baselineTarget=(!hasBaseline&&!hasTarget)
      ?'-'
      :`${hasBaseline?e(opFormatNumber(p.baseline)):'—'} to ${hasTarget?e(opFormatNumber(p.target)):'—'}`;
    // Last Updated column: reuses the same plain-text, no-color pattern
    // already established for the NSM card's "Updated" field (per
    // explicit design decision — no staleness warning/color anywhere).
    // Sourced from p.loggedAt, the feature-level equivalent of
    // gData.nsm.updatedAt, stamped by opSaveHypothesisModal() on save.
    const lastUpdatedDisplay=p.loggedAt?e(opFormatRelativeTime(p.loggedAt)):'-';
    // v9.11 (Outcome Pulse Iteration Loop): passive experiment-count badge —
    // counts ONLY outcome-pulse-sourced experiments linked to this feature's
    // metric, matching exactly what Experiment Library itself shows (never
    // real-diagnostic-origin experiments), so the badge never promises more
    // than Library actually contains. Non-interactive by design — no
    // onclick — the kebab menu's "Experiment Library" item is the entry
    // point, this is informational only.
    const expCount=opCountPulseExperimentsForMetric(p.metric);
    // v9.11.03 (Fix 10) — no badge on an experiment-derived card
    // (origin==='diagnostic'). Consistent with Fix 9: a card that can't
    // itself spawn further experiments shouldn't display a badge inviting
    // exactly that action — reported live as a "cyclical loop" appearance
    // (an experiment-derived feature showing the same experiment-count
    // badge as the original feature it came from, since both share the
    // same tracked metric).
    const expBadge=(expCount>0&&f.origin!=='diagnostic')?`<span style="background:var(--card);color:var(--t3);border:1px solid var(--divider);font-size:8px;font-weight:600;padding:2px 7px;border-radius:20px;margin-left:6px;" title="${expCount} Outcome Pulse experiment${expCount!==1?'s':''} in Experiment Library"><i class="ti ti-flask" style="font-size:8px;vertical-align:-1px;" aria-hidden="true"></i> ${expCount}</span>`:'';
    const _canEditOpRow=(typeof canEditSession!=='function')||canEditSession();
    rows+=`
      <tr style="${i%2===1?'background:var(--card);':''}">
        <td style="padding:7px 16px 7px 38px;font-weight:600;color:var(--t1);font-size:10px;overflow-wrap:anywhere;">${e(f.name)}</td>
        <td style="padding:7px 8px;color:var(--t2);font-size:10px;overflow-wrap:anywhere;">${e(p.metric)}</td>
        <td style="padding:7px 8px;color:var(--t2);font-size:10px;overflow-wrap:anywhere;">${baselineTarget}</td>
        <td style="padding:7px 8px;color:var(--t2);font-size:10px;overflow-wrap:anywhere;">${actualDisplay}</td>
        <td style="padding:7px 8px;display:flex;align-items:center;">${badge}${expBadge}</td>
        <td style="padding:7px 8px;color:var(--t2);font-size:10px;">${lastUpdatedDisplay}</td>
        <td style="padding:7px 16px;position:relative;">${_canEditOpRow?`<button class="tm-dots" aria-label="Hypothesis actions" aria-expanded="false" onclick="event.stopPropagation();opToggleRowMenu(this,'${e(f.id)}')"><i class="ti ti-dots-vertical" aria-hidden="true"></i></button>`:`<span onclick="opOpenHypothesisModal('${e(f.id)}')" style="color:var(--purple);cursor:pointer;font-size:10px;font-weight:600;">Log Result</span>`}</td>
      </tr>
    `;
  });
  return`
    <table style="width:100%;border-collapse:collapse;font-size:10px;margin-bottom:6px;table-layout:fixed;">
      ${OP_LEDGER_COLGROUP}
      <tr style="background:var(--purple-pale);">
        <td style="padding:5px 16px 5px 38px;font-size:8.5px;font-weight:700;color:var(--purple);text-transform:uppercase;overflow-wrap:anywhere;">Feature</td>
        <td style="padding:5px 8px;font-size:8.5px;font-weight:700;color:var(--purple);text-transform:uppercase;">Metric</td>
        <td style="padding:5px 8px;font-size:8.5px;font-weight:700;color:var(--purple);text-transform:uppercase;">Baseline to Target</td>
        <td style="padding:5px 8px;font-size:8.5px;font-weight:700;color:var(--purple);text-transform:uppercase;">Actual</td>
        <td style="padding:5px 8px;font-size:8.5px;font-weight:700;color:var(--purple);text-transform:uppercase;">Signal</td>
        <td style="padding:5px 8px;font-size:8.5px;font-weight:700;color:var(--purple);text-transform:uppercase;">Last Updated</td>
        <td style="padding:5px 16px;font-size:8.5px;font-weight:700;color:var(--purple);text-transform:uppercase;">Action</td>
      </tr>
      ${rows}
    </table>
  `;
}

function opBuildSignalBadgeHTML(sig){
  const map={
    'aligned':{label:'Aligned',bg:'var(--green-pale)',color:'var(--green)'},
    'opposed':{label:'Opposed',bg:'#FCE8E8',color:'var(--red)'},
    'no-change':{label:'No Change',bg:'var(--amber-pale)',color:'var(--amber)'},
    'awaiting':{label:'Awaiting',bg:'var(--card)',color:'var(--t3)'},
    'not-applicable':{label:'Not Applicable',bg:'var(--card)',color:'var(--label)'}
  };
  const m=map[sig]||map['awaiting'];
  return`<span style="font-size:8px;font-weight:700;background:${m.bg};color:${m.color};border-radius:10px;padding:2px 6px;">${m.label}</span>`;
}

// ══════════════════════════════════════════════════════════════════════
// Unified hypothesis modal — single "Log result" entry point for every
// row, regardless of state. Read-only hypothesis display + editable
// actual/signal, per final design decisions.
// ══════════════════════════════════════════════════════════════════════

function opOpenHypothesisModal(fid){
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat||!isOutcomeTrackableFeature(feat)){
    if(typeof showToast==='function')showToast('This feature changed. Reopen Outcome Pulse to try again.','warn');
    return;
  }
  const p=feat.outcomeHypothesis.primary;
  const secondary=feat.outcomeHypothesis.secondary||[];
  const _canEditOp=(typeof canEditSession!=='function')||canEditSession();
  const suggested=computeSuggestedSignal(p);
  const suggestedLabel=suggested?({'aligned':'Aligned','opposed':'Opposed','no-change':'No Change'})[suggested]:null;
  // Item 7 fix (v9.10.02 feedback round): each pill's SELECTED color now
  // matches its own semantic meaning everywhere else in the app (green
  // distribution segment/badge = Aligned, red = Opposed, amber = No
  // Change, grey = Not Applicable) — previously every pill turned the
  // same green regardless of which one was picked, which was wrong for
  // Opposed/No Change/Not Applicable and answers the reviewer's direct
  // question: no, this should not be a purple-or-green-only convention.
  const _pillColors={aligned:'var(--green)',opposed:'var(--red)','no-change':'var(--amber)','not-applicable':'var(--label)'};
  const signalPillHTML=(value,label)=>{
    const isSelected=(p.signal||null)===value||(value==='awaiting'&&!p.signal);
    const selColor=_pillColors[value]||'var(--green)';
    return`<div onclick="${_canEditOp?`opSetModalSignal('${value}')`:''}" data-op-signal-pill="${value}" style="padding:5px 10px;border-radius:6px;font-size:9px;font-weight:600;cursor:${_canEditOp?'pointer':'not-allowed'};${isSelected?`background:${selColor};color:#fff;`:`border:1px solid var(--divider);color:var(--t2);`}">${label}</div>`;
  };
  const secondaryHTML=secondary.filter(s=>s.metric).map((s,i)=>`
    <div style="border:1px solid var(--divider);border-radius:5px;padding:7px;display:flex;flex-direction:column;gap:5px;margin-bottom:5px;">
      <div style="display:flex;justify-content:space-between;">
        <div style="font-size:9.5px;font-weight:600;color:var(--t1);">${e(s.metric)}</div>
        <div style="font-size:9px;color:var(--t3);">${s.baseline!==null&&s.baseline!==undefined&&s.target!==null&&s.target!==undefined?e(opFormatNumber(s.baseline))+' &rarr; '+e(opFormatNumber(s.target)):''}</div>
      </div>
      <input id="op-modal-secondary-actual-${i}" type="number" step="any" value="${s.actual!==null&&s.actual!==undefined?s.actual:''}" placeholder="Actual" ${_canEditOp?'':'disabled'}
        style="width:80px;height:22px;border:1px solid var(--divider);border-radius:4px;padding:0 6px;font-size:9.5px;font-family:var(--font);color:var(--t1);background:${_canEditOp?'var(--bg)':'var(--card)'};box-sizing:border-box;" />
    </div>
  `).join('');
  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.id='op-hyp-modal-overlay';
  overlay.innerHTML=`<div class="modal" style="max-width:440px;max-height:88vh;overflow-y:auto;position:relative;">
    <button onclick="document.getElementById('op-hyp-modal-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:16px 44px 12px 16px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:500;color:var(--t1);margin-bottom:4px;">${e(feat.name)}</div>
      <div style="font-size:9px;color:var(--label);">${e(feat.cap||'')} &rsaquo; ${e(p.metric||'')}</div>
    </div>
    <div style="padding:14px 20px 4px;display:flex;flex-direction:column;gap:10px;">
      <div>
        <div style="font-size:9px;font-weight:700;color:var(--label);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Why it matters</div>
        <div style="font-size:10.5px;color:var(--t2);line-height:1.5;">${e(feat.why||'')}</div>
      </div>
      <div style="border:1px solid var(--divider);border-radius:7px;">
        <div style="padding:9px 10px;background:var(--card);border-radius:7px 7px 0 0;display:flex;align-items:center;gap:6px;">
          <i class="ti ti-target-arrow" style="font-size:12px;color:var(--purple);" aria-hidden="true"></i>
          <span style="font-size:11px;font-weight:600;color:var(--t1);">Outcome hypothesis</span>
        </div>
        <div style="padding:10px;display:flex;flex-direction:column;gap:8px;">
          <div style="font-size:9px;font-weight:700;color:var(--label);text-transform:uppercase;letter-spacing:0.5px;">Primary</div>
          <div style="display:grid;grid-template-columns:1fr 60px;gap:6px;">
            <div><div style="font-size:8px;color:var(--label);text-transform:uppercase;">Target metric</div><div style="font-size:10.5px;font-weight:600;color:var(--t1);">${e(p.metric)}</div></div>
            <div><div style="font-size:8px;color:var(--label);text-transform:uppercase;">Unit</div><div style="font-size:10.5px;font-weight:600;color:var(--t1);">${e(formatOutcomeUnit(p.unit,p.customLabel))}</div></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 60px;gap:6px;">
            <div><div style="font-size:8px;color:var(--label);text-transform:uppercase;">Baseline</div><div style="font-size:10.5px;font-weight:600;color:var(--t1);">${p.baseline!==null&&p.baseline!==undefined?e(opFormatNumber(p.baseline)):'-'}</div></div>
            <div><div style="font-size:8px;color:var(--label);text-transform:uppercase;">Target</div><div style="font-size:10.5px;font-weight:600;color:var(--t1);">${p.target!==null&&p.target!==undefined?e(opFormatNumber(p.target)):'-'}</div></div>
            <div><div style="font-size:8px;color:var(--label);text-transform:uppercase;">Direction</div><div style="font-size:9px;font-weight:600;color:var(--purple);background:var(--purple-pale);border-radius:4px;padding:2px 5px;text-align:center;">${p.direction==='decrease'?'&darr; Decr.':(p.direction==='increase'?'&uarr; Incr.':'-')}</div></div>
          </div>
          <div style="background:var(--purple-pale);border-radius:5px;padding:8px;">
            <label style="font-size:8px;font-weight:700;color:var(--purple);text-transform:uppercase;letter-spacing:0.3px;display:block;margin-bottom:4px;">Actual value <span style="font-weight:400;color:var(--t3);text-transform:none;">(optional)</span></label>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
              <input id="op-modal-actual-input" type="number" step="any" value="${p.actual!==null&&p.actual!==undefined?p.actual:''}" ${_canEditOp?`oninput="opRecomputeModalSuggestion('${e(fid)}')"`:'disabled'}
                style="width:80px;height:26px;border:1px solid var(--purple);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--purple);font-weight:600;background:${_canEditOp?'#fff':'var(--card)'};box-sizing:border-box;" />
              <span style="font-size:10px;color:var(--t3);">${e(formatOutcomeUnit(p.unit,p.customLabel))}</span>
              <span id="op-modal-suggestion" style="font-size:8.5px;color:var(--label);margin-left:auto;">${suggestedLabel?'Suggests: '+suggestedLabel:''}</span>
            </div>
            <label style="font-size:8px;font-weight:700;color:var(--purple);text-transform:uppercase;letter-spacing:0.3px;display:block;margin-bottom:4px;">Signal</label>
            <div style="display:flex;gap:5px;flex-wrap:wrap;">
              ${signalPillHTML('aligned','Aligned')}
              ${signalPillHTML('opposed','Opposed')}
              ${signalPillHTML('no-change','No Change')}
              ${signalPillHTML('not-applicable','Not Applicable')}
            </div>
            <div style="font-size:8.5px;color:var(--label);margin-top:6px;">${p.loggedAt?'Logged '+opFormatRelativeTime(p.loggedAt):'Not yet logged'}</div>
          </div>
          <div>
            <div style="font-size:8px;color:var(--label);text-transform:uppercase;margin-bottom:2px;">Rationale</div>
            <div style="font-size:10px;color:var(--t2);line-height:1.5;">${e(p.rationale||'')}</div>
          </div>
          ${secondaryHTML?`<div style="border-top:0.5px dashed var(--divider);padding-top:8px;font-size:9px;font-weight:700;color:var(--label);text-transform:uppercase;letter-spacing:0.5px;">Secondary</div>${secondaryHTML}`:''}
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <div style="flex:1;"></div>
      <button class="modal-cancel-btn" onclick="document.getElementById('op-hyp-modal-overlay').remove()">Cancel</button>
      <button class="modal-confirm-btn" id="op-modal-save-btn" ${_canEditOp?`onclick="opSaveHypothesisModal('${e(fid)}')"`:'disabled'}>Save Result</button>
    </div>
  </div>`;
  // Stash the working (not-yet-saved) signal selection on the overlay element
  // itself via a data attribute, since this modal edits state before Save
  // is clicked, same pattern as _scAddFeatSecondary elsewhere.
  overlay.dataset.opWorkingSignal=p.signal||'';
  document.body.appendChild(overlay);
  const _esc=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_esc,true);}};
  document.addEventListener('keydown',_esc,true);
  trapFocus(overlay);
}

function opSetModalSignal(value){
  const overlay=document.getElementById('op-hyp-modal-overlay');
  if(!overlay)return;
  overlay.dataset.opWorkingSignal=value;
  const _pillColors={aligned:'var(--green)',opposed:'var(--red)','no-change':'var(--amber)','not-applicable':'var(--label)'};
  overlay.querySelectorAll('[data-op-signal-pill]').forEach(el=>{
    const pillValue=el.getAttribute('data-op-signal-pill');
    const isSelected=pillValue===value;
    el.style.background=isSelected?(_pillColors[pillValue]||'var(--green)'):'';
    el.style.color=isSelected?'#fff':'var(--t2)';
    el.style.border=isSelected?'none':'1px solid var(--divider)';
  });
}

function opRecomputeModalSuggestion(fid){
  const feat=scCanvas.find(x=>x.id===fid);
  const actualInput=document.getElementById('op-modal-actual-input');
  const suggestionEl=document.getElementById('op-modal-suggestion');
  if(!feat||!feat.outcomeHypothesis||!actualInput||!suggestionEl)return;
  const tempPrimary={...feat.outcomeHypothesis.primary,actual:actualInput.value!==''?Number(actualInput.value):null};
  const suggested=computeSuggestedSignal(tempPrimary);
  const label=suggested?({'aligned':'Aligned','opposed':'Opposed','no-change':'No Change'})[suggested]:null;
  suggestionEl.textContent=label?'Suggests: '+label:'';
}

function opSaveHypothesisModal(fid){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat||!feat.outcomeHypothesis){
    const overlay=document.getElementById('op-hyp-modal-overlay');
    if(overlay)overlay.remove();
    if(typeof showToast==='function')showToast('This feature changed. Reopen it to try again.','warn');
    return;
  }
  const overlay=document.getElementById('op-hyp-modal-overlay');
  const actualInput=document.getElementById('op-modal-actual-input');
  const workingSignal=overlay?overlay.dataset.opWorkingSignal:'';
  const _newActual=actualInput&&actualInput.value!==''?Number(actualInput.value):null;
  feat.outcomeHypothesis.primary.actual=_newActual;
  // v9.11.04 (Fix 12) — previously saved signal:null whenever no pill was
  // explicitly clicked, even if a valid actual was entered — indistinguishable
  // from a feature where no result has ever been logged at all (reported
  // live: actual entered, Signal column still showed "Awaiting"). An
  // explicit pill click always wins; only when the PM never touched a
  // pill does this fall back to the same suggested signal already
  // computed and displayed live next to the actual input
  // (opRecomputeModalSuggestion) — computed here from a temp object using
  // the about-to-be-saved actual, not feat.outcomeHypothesis.primary's
  // still-stale pre-save value, matching that same live-hint logic
  // exactly. No visible marker distinguishing an auto-filled signal from
  // an explicitly clicked one, per explicit decision.
  const _tempPrimaryForSuggestion={...feat.outcomeHypothesis.primary,actual:_newActual};
  const _suggestedSignal=(typeof computeSuggestedSignal==='function')?computeSuggestedSignal(_tempPrimaryForSuggestion):null;
  feat.outcomeHypothesis.primary.signal=workingSignal||_suggestedSignal||null;
  feat.outcomeHypothesis.primary.loggedAt=new Date().toISOString();
  // Secondary actuals
  (feat.outcomeHypothesis.secondary||[]).forEach((s,i)=>{
    const inp=document.getElementById('op-modal-secondary-actual-'+i);
    if(inp)s.actual=inp.value!==''?Number(inp.value):null;
  });
  if(overlay)overlay.remove();
  opRenderBreakdown();
  opRenderTopRow();
  if(typeof showToast==='function')showToast('Result logged.','success');
  // Live-sync: sc-area manual edit, existing emit path (per §6.2 Finding 3a) —
  // same call as Edit Feature / Add Feature's hypothesis saves.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('sc',fid+_LS_SC_TARGET_SEP); });
  }
}

// ══════════════════════════════════════════════════════════════════════
// PDF export — new mechanism, no existing precedent in this codebase
// (confirmed per §6.5/§5.8 — every other export in this app produces a
// structured document from data, not a rendered-screen capture).
// Uses the same html2canvas + jsPDF pattern already loaded for Prototype
// Canvas's screenshot capture (see prototype-canvas.js's
// _pcLoadHtml2Canvas), reusing that lazy-CDN-load convention rather than
// inventing a new one. Pagination: since Outcome Breakdown can expand to
// arbitrary height with multiple stage rows open, the canvas is sliced
// into page-height chunks rather than scaled to fit one page.
// ══════════════════════════════════════════════════════════════════════

var _opHtml2CanvasPromise=null;
async function _opLoadHtml2Canvas(){
  if(typeof html2canvas!=='undefined')return true;
  if(_opHtml2CanvasPromise)return _opHtml2CanvasPromise;
  _opHtml2CanvasPromise=new Promise(function(res){
    const s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
    s.onload=function(){res(true);};
    s.onerror=function(){_opHtml2CanvasPromise=null;console.warn('[Outcome Pulse] html2canvas CDN load failed');res(false);};
    document.head.appendChild(s);
  });
  return _opHtml2CanvasPromise;
}
var _opJsPDFPromise=null;
async function _opLoadJsPDF(){
  if(typeof window.jspdf!=='undefined')return true;
  if(_opJsPDFPromise)return _opJsPDFPromise;
  _opJsPDFPromise=new Promise(function(res){
    const s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
    s.onload=function(){res(true);};
    s.onerror=function(){_opJsPDFPromise=null;console.warn('[Outcome Pulse] jsPDF CDN load failed');res(false);};
    document.head.appendChild(s);
  });
  return _opJsPDFPromise;
}

async function opDownloadReport(){
  const btn=document.getElementById('op-export-btn');
  const target=document.getElementById('op-export-target');
  const exportHeader=document.getElementById('op-export-header');
  if(!target)return;
  // Populate + reveal the export-only header (product name, centered)
  // immediately before capture — this header lives INSIDE the captured
  // subtree but the trigger button does not (per PDF-1 fix: the button
  // is a sibling outside #op-export-target, so its own loading-state
  // mutation below can never leak into the capture regardless of timing).
  // v9.10.03 (BUILD-5): combined into one title, "Product Name - Outcome
  // Pulse" (plain hyphen, never an em dash, per explicit instruction),
  // at a font size matching the NSM hero-number's visual weight (30px) —
  // this fix was requested in the previous round but never actually
  // built; only the earlier centering fix landed.
  const productName=(typeof productContext!=='undefined'&&productContext&&productContext.name)?productContext.name:'';
  if(exportHeader){
    exportHeader.textContent=productName?(productName+' - Outcome Pulse'):'Outcome Pulse';
    exportHeader.style.display='block';
  }
  if(btn){btn.disabled=true;const _origHTML=btn.innerHTML;btn.dataset.origHtml=_origHTML;btn.innerHTML='<i class="ti ti-loader-2" style="font-size:11px;animation:spin 1s linear infinite;" aria-hidden="true"></i> Preparing...';}
  try{
    const [hcOk,pdfOk]=[await _opLoadHtml2Canvas(),await _opLoadJsPDF()];
    if(!hcOk||!pdfOk)throw new Error('Could not load PDF export libraries.');
    const canvas=await html2canvas(target,{backgroundColor:'#ffffff',scale:2});
    const { jsPDF }=window.jspdf;
    const pdf=new jsPDF('p','pt','a4');
    const pageWidth=pdf.internal.pageSize.getWidth();
    const pageHeight=pdf.internal.pageSize.getHeight();
    // Real margin on all 4 sides (PDF-1) — 36pt (~0.5in) standard margin,
    // image placed and sized within the margin box, not edge-to-edge.
    const margin=36;
    const usableWidth=pageWidth-(margin*2);
    const usableHeight=pageHeight-(margin*2);
    const imgWidth=usableWidth;
    const imgHeight=(canvas.height*imgWidth)/canvas.width;
    // JPEG at high quality instead of lossless PNG — a raster screenshot of
    // UI (mostly flat colour/text, no photographic detail) gains nothing
    // from PNG's lossless encoding but pays for it in file size; JPEG at
    // 0.92 cuts export size dramatically with no visible quality loss.
    const imgData=canvas.toDataURL('image/jpeg',0.92);
    let heightRemaining=imgHeight;
    let pageIndex=0;
    while(heightRemaining>0){
      if(pageIndex>0)pdf.addPage();
      // The image is always placed at the same horizontal margin. Its
      // vertical position shifts upward by one full usable-page-height
      // per page already rendered, so each page reveals the next slice
      // of the same tall image through the page's own margin-bounded
      // viewport — standard jsPDF multi-page image-slicing technique.
      const yOffset=margin-(pageIndex*usableHeight);
      pdf.addImage(imgData,'JPEG',margin,yOffset,imgWidth,imgHeight);
      heightRemaining-=usableHeight;
      pageIndex++;
    }
    const fileSafeName=productName?productName.replace(/\s+/g,'_'):'Product';
    pdf.save(fileSafeName+'_Outcome_Pulse_Report.pdf');
  }catch(err){
    console.error('[Outcome Pulse] PDF export failed:',err);
    if(typeof showToast==='function')showToast('PDF export failed. Please try again.','error');
  }finally{
    if(exportHeader)exportHeader.style.display='none';
    if(btn){btn.disabled=false;if(btn.dataset.origHtml)btn.innerHTML=btn.dataset.origHtml;}
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Suggest Experiment modal + Experiment Library panel
// (Outcome Pulse Iteration Loop, v9.11)
// ═══════════════════════════════════════════════════════════════════════

// Attempt-marker guard (mirrors diagnostic-view.js's _dvOverlayStillCurrent
// pattern) — this modal doesn't mutate scCanvas during generation, only on
// accept, so it doesn't need the full withGenerationLock cross-tab lock;
// a lighter local marker is enough to discard a stale/abandoned regenerate
// response and to prevent double-accept.
let _opSuggestAttemptId=null;
let _opSuggestCurrentResult=null; // last successfully generated experiment JSON, or null

function _opSuggestOverlayStillCurrent(attemptId){
  const el=document.getElementById('op-suggest-overlay');
  return!!(el&&el.getAttribute('data-gen-attempt')===attemptId);
}

// ── Gather every existing experiment already linked to this metric, both
// real-diagnostic-origin and outcome-pulse-origin — used as dedup CONTEXT
// fed to the prompt. (Separate from Experiment Library's own listing,
// which deliberately shows outcome-pulse-origin only — this dedup context
// is intentionally broader than what Library displays, since duplicating
// something a real diagnostic run already suggested is just as wasteful as
// duplicating a prior Outcome Pulse suggestion.)
function _opGatherPriorExperimentsForMetric(metricName){
  if(!metricName||typeof productLeakAnalysis==='undefined'||!productLeakAnalysis)return[];
  const out=[];
  productLeakAnalysis.forEach(function(run){
    (run.experiments||[]).forEach(function(exp){
      if(exp.linkedMetricName===metricName)out.push(exp);
    });
  });
  return out;
}

// ── Mechanical duplicate check — normalize and compare title, not just
// trust the prompt's own dedup instruction. Prompt-level dedup can miss
// paraphrases or degrade under a long prior-experiment list; this is a
// second, cheap layer that catches near-identical titles specifically.
// Non-blocking by design — the PM can still proceed past a warning.
function _opFindPossibleDuplicate(newExp,priorExperiments){
  if(!newExp||!newExp.experimentTitle)return null;
  const norm=function(s){return(s||'').trim().toLowerCase();};
  const newTitle=norm(newExp.experimentTitle);
  return priorExperiments.find(function(x){return norm(x.experimentTitle)===newTitle;})||null;
}

// v9.25 — single shared close path for the suggest-experiment overlay,
// used by every trigger (X button, Escape key, both Cancel/Close buttons
// rendered in the two result states) instead of each calling .remove()
// independently — voiceStopActive() is a safe no-op if the refine box
// (only present in the no-recommendation state) isn't the active instance.
function _opCloseSuggestOverlay(){
  voiceStopActive('abort');
  const overlay=document.getElementById('op-suggest-overlay');
  if(overlay)overlay.remove();
}

function opOpenSuggestExperimentModal(fid){
  const feat=scCanvas.find(function(f){return f.id===fid;});
  if(!feat||!feat.outcomeHypothesis)return;
  // v9.25 code-review fix — was a raw .remove() that bypassed
  // _opCloseSuggestOverlay(), the shared close path added specifically so
  // every removal of this overlay stops dictation first. Reachable if this
  // is invoked a second time (e.g. from the Experiment Library) while a
  // prior overlay — possibly with an active mic in its "no recommendation"
  // state — is still open.
  _opCloseSuggestOverlay();
  _opSuggestCurrentResult=null;
  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.id='op-suggest-overlay';
  overlay.innerHTML=_opSuggestModalShell(feat);
  document.body.appendChild(overlay);
  if(typeof trapFocus==='function')trapFocus(overlay);
  const _esc=function(ev){
    if(ev.key==='Escape'){_opCloseSuggestOverlay();document.removeEventListener('keydown',_esc,true);}
  };
  document.addEventListener('keydown',_esc,true);
  overlay.dataset.escHandlerAttached='1';
  _opRunSuggestExperiment(fid,'');
}

function _opSuggestModalShell(feat){
  const p=feat.outcomeHypothesis.primary;
  return`<div class="modal" style="max-width:420px;position:relative;">
    <button onclick="_opCloseSuggestOverlay()"
      style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;
      padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;"
      title="Close">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
    <div style="padding:20px 52px 14px 20px;">
      <div style="font-size:13px;font-weight:500;color:var(--t1);margin-bottom:4px;">Suggest an experiment</div>
      <div style="font-size:11px;color:var(--t3);">For ${e(feat.name)} &middot; ${e(p.metric)}</div>
    </div>
    <div id="op-suggest-body" style="padding:0 20px 4px;">
      ${_opSuggestLoadingHTML()}
    </div>
    <div id="op-suggest-footer" style="padding:10px 20px 16px;display:flex;justify-content:flex-end;gap:6px;"></div>
  </div>`;
}

// v9.11.05 (Fix 17) — rotating sub-message during generation, a lightweight
// setInterval pattern (not the heavier multi-step stepper used in
// diagnostic-view.js's full analysis loader — this modal is small and the
// call is fast, so a single rotating text line fits better than importing
// extra stepper structure).
const OP_SUGGEST_LOADING_MESSAGES=[
  'Generating a suggestion...',
  'Comparing against this feature\'s hypothesis...',
  'Looking for an angle that could move the metric...'
];

function _opSuggestLoadingHTML(){
  return`<div style="display:flex;align-items:center;gap:8px;padding:16px 0;color:var(--t3);font-size:11px;">
    <i class="ti ti-loader-2" style="font-size:13px;animation:spin 1s linear infinite;" aria-hidden="true"></i> <span id="op-suggest-loading-msg">${OP_SUGGEST_LOADING_MESSAGES[0]}</span>
  </div>`;
}

async function _opRunSuggestExperiment(fid,refinement){
  // v9.25 — single choke point: EVERY invocation of this function (the
  // initial empty-refinement call on modal open, or a PM-submitted
  // refinement from the no-recommendation state) immediately wipes bodyEl
  // below to show a loader — the only place #op-suggest-refine-txt is ever
  // destroyed. Also covers stop-on-send, since refinement (the param) was
  // already read synchronously from the live textarea value before this
  // function was even called.
  voiceStopActive('abort');
  const feat=scCanvas.find(function(f){return f.id===fid;});
  if(!feat)return;
  const overlay=document.getElementById('op-suggest-overlay');
  if(!overlay)return;
  const _attempt=newGenAttempt();
  _opSuggestAttemptId=_attempt.id;
  overlay.setAttribute('data-gen-attempt',_attempt.id);
  const bodyEl=document.getElementById('op-suggest-body');
  const footerEl=document.getElementById('op-suggest-footer');
  if(bodyEl)bodyEl.innerHTML=_opSuggestLoadingHTML();
  if(footerEl)footerEl.innerHTML='';
  let _opSuggestMsgIdx=0;
  const _opSuggestMsgTimer=setInterval(function(){
    _opSuggestMsgIdx=(_opSuggestMsgIdx+1)%OP_SUGGEST_LOADING_MESSAGES.length;
    const msgEl=document.getElementById('op-suggest-loading-msg');
    if(msgEl)msgEl.textContent=OP_SUGGEST_LOADING_MESSAGES[_opSuggestMsgIdx];
  },2200);
  const _diagSignal=startAiGen('Generating an experiment suggestion. Leaving now discards it.');
  try{
    const priorExperiments=_opGatherPriorExperimentsForMetric(feat.outcomeHypothesis.primary.metric);
    const promptTxt=buildOutcomePulseExperimentPrompt(feat,priorExperiments,refinement);
    // v9.12.05 fix: removed hardcoded 'claude-haiku-4-5-20251001' override,
    // which completely bypassed resolveModel()'s Optimized/user-choice
    // precedence chain — confirmed a real gap, not deliberate. Passing null
    // now lets this caller correctly resolve via CALLER_MODEL_DEFAULTS
    // (registered as 'claude-sonnet-4-6' for Optimized, api.js), same as
    // every other caller in this app.
    const txt=await callAPI(
      'You are a senior product growth consultant. Respond ONLY with valid strict JSON. No markdown, no backticks, no preamble. Never use em dashes (—) in your output; use a hyphen (-) or rewrite the phrase.',
      promptTxt,2000,_diagSignal,null,'outcome-pulse-suggest'
    );
    endAiGen();
    if(!_opSuggestOverlayStillCurrent(_attempt.id))return; // stale/abandoned — discard silently
    const clean=txt.replace(/```json|```/g,'').trim();
    let parsed;
    try{parsed=JSON.parse(clean);}catch(pe){throw new Error('Could not read the suggestion. Please try again.');}
    // v9.11.01 (Fix 3) — canonicalize the metric identity as a full unit,
    // not just linkedMetricName in isolation. The AI is free to paraphrase
    // the metric name in its JSON response; _laResolveStageFromMetric()
    // requires EXACT string equality against the live KPI tree, so any
    // drift here silently breaks stage resolution and falls back to the
    // AI's own less-reliable lifecycleStage guess — reproduced live in
    // testing (an Acquisition-stage feature's generated experiment landed
    // under Activation). feature.outcomeHypothesis.primary.metric is the
    // known-correct string already driving this feature's own tracking —
    // overwritten unconditionally, not just as a fallback for a missing
    // value. Sibling fields (successMetric.metricName) are corrected too,
    // so nothing downstream can disagree with the canonical string; the
    // metric IDs are nulled rather than preserving a possibly-hallucinated
    // value with nothing real to validate it against.
    if(!parsed.no_recommendation){
      const canonicalMetric=feat.outcomeHypothesis.primary.metric;
      parsed.linkedMetricName=canonicalMetric;
      parsed.linkedMetricId=null;
      if(parsed.successMetric&&typeof parsed.successMetric==='object'){
        parsed.successMetric.metricName=canonicalMetric;
        parsed.successMetric.metricId=null;
      }
    }
    if(parsed.no_recommendation){
      _opSuggestCurrentResult=null;
      _opRenderSuggestNoRecommendation(fid,parsed.reason||'No unexplored angles found for this metric right now.');
    }else{
      _opSuggestCurrentResult=parsed;
      _opRenderSuggestFound(fid,parsed,priorExperiments);
    }
  }catch(err){
    endAiGen();
    if(!_opSuggestOverlayStillCurrent(_attempt.id))return;
    if(bodyEl)bodyEl.innerHTML=`<div style="font-size:11px;color:var(--red);padding:12px 0;">Error: ${e(err.message)}</div>`;
    if(footerEl)footerEl.innerHTML=`<button class="modal-cancel-btn" onclick="_opCloseSuggestOverlay()">Close</button>`;
  }finally{
    clearInterval(_opSuggestMsgTimer);
  }
}

function _opRenderSuggestFound(fid,exp,priorExperiments){
  const bodyEl=document.getElementById('op-suggest-body');
  const footerEl=document.getElementById('op-suggest-footer');
  if(!bodyEl||!footerEl)return;
  const dup=_opFindPossibleDuplicate(exp,priorExperiments);
  const dupWarning=dup?`<div style="display:flex;gap:8px;align-items:flex-start;background:#FAEEDA;border-radius:7px;padding:8px 10px;margin-bottom:10px;">
      <i class="ti ti-alert-triangle" style="font-size:12px;color:#854F0B;margin-top:1px;" aria-hidden="true"></i>
      <div style="font-size:10.5px;color:#63380A;line-height:1.5;">Possible duplicate of an existing experiment: "${e(dup.experimentTitle)}". You can still proceed if this is meaningfully different.</div>
    </div>`:'';
  bodyEl.innerHTML=`
    ${dupWarning}
    <div style="background:var(--card);border-radius:7px;padding:12px;">
      <div style="font-size:12px;font-weight:700;color:var(--t1);margin-bottom:4px;">${e(exp.experimentTitle)}</div>
      <div style="font-size:11px;color:var(--t2);line-height:1.5;">${e(exp.description||exp.hypothesis||'')}</div>
    </div>
  `;
  footerEl.innerHTML=`
    <button id="op-suggest-regen-btn" class="modal-cancel-btn" onclick="_opRunSuggestExperiment('${e(fid)}','')">Regenerate</button>
    <button id="op-suggest-accept-btn" class="modal-confirm-btn" onclick="_opAcceptSuggestedExperiment('${e(fid)}')">Send to Experiment Canvas</button>
  `;
}

function _opRenderSuggestNoRecommendation(fid,reason){
  const bodyEl=document.getElementById('op-suggest-body');
  const footerEl=document.getElementById('op-suggest-footer');
  if(!bodyEl||!footerEl)return;
  bodyEl.innerHTML=`
    <div style="display:flex;gap:8px;align-items:flex-start;background:#FAEEDA;border-radius:7px;padding:10px 12px;margin-bottom:12px;">
      <i class="ti ti-info-circle" style="font-size:13px;color:#854F0B;margin-top:1px;" aria-hidden="true"></i>
      <div style="font-size:11px;color:#63380A;line-height:1.5;">${e(reason)}</div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
      <div style="font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--label);">Add context to try again</div>
      <div style="position:relative;">${(typeof voiceButtonHtml==='function')?voiceButtonHtml({textareaId:'op-suggest-refine-txt',buttonId:'op-suggest-voice-btn',statusId:'op-suggest-voice-status'}):''}</div>
    </div>
    <textarea id="op-suggest-refine-txt" style="width:100%;box-sizing:border-box;border:1px solid var(--divider);border-radius:6px;padding:8px 10px;font-size:11px;font-family:var(--font);resize:none;" rows="3" placeholder="e.g. Focus on returning users, not first-time signups..."></textarea>
  `;
  footerEl.innerHTML=`
    <button class="modal-cancel-btn" onclick="_opCloseSuggestOverlay()">Cancel</button>
    <button id="op-suggest-regen-with-context-btn" class="modal-confirm-btn" onclick="_opRunSuggestExperiment('${e(fid)}',document.getElementById('op-suggest-refine-txt').value.trim())">Generate</button>
  `;
}

// ── Accept: synthesize a minimal productLeakAnalysis run, emit the live-
// sync event (mirrors diagnostic-view.js's own real-diagnostic-analysis
// path exactly, same event type), then hand off to Experiment Canvas.
async function _opAcceptSuggestedExperiment(fid){
  if(!_opSuggestCurrentResult)return;
  const acceptBtn=document.getElementById('op-suggest-accept-btn');
  const regenBtn=document.getElementById('op-suggest-regen-btn');
  if(acceptBtn)acceptBtn.disabled=true;
  if(regenBtn)regenBtn.disabled=true;
  const feat=scCanvas.find(function(f){return f.id===fid;});
  if(!feat){if(acceptBtn)acceptBtn.disabled=false;if(regenBtn)regenBtn.disabled=false;return;}
  const exp=_opSuggestCurrentResult;
  const _runTs=Date.now();
  const _runId='run-'+_runTs;
  const p=feat.outcomeHypothesis.primary;
  // v9.11: synthesized run leaves severity/evidenceStrength/diagnosticCaveat/
  // evidenceSummary/instrumentationGaps genuinely absent — never faked —
  // since no real diagnostic evidence-gathering happened here. Existing
  // "Highest severity"/"Worst evidence strength" summary aggregates in
  // product-leak-analysis.js already tolerate absence gracefully.
  const run={
    runId:_runId,
    runLabel:exp.linkedMetricName+' · '+new Date(_runTs).toLocaleString('en-US',{month:'short',day:'numeric'}),
    runTimestamp:_runTs,
    runCustomName:false,
    leakingStage:'',
    primaryBottleneckMetric:exp.linkedMetricName||p.metric,
    problemStatement:p.rationale||('Outcome Pulse iteration on '+p.metric),
    experiments:[exp],
    source:'outcome-pulse',
    // v9.11.02 (Fix 7) — the real originating feature's own capability and
    // stage, captured here since this is the only point in the whole flow
    // where they're known with certainty (opOpenSuggestExperimentModal()
    // cannot even open without a resolvable feat). Consumed by
    // laSendToStoryCanvas() to place the resulting card under the SAME
    // real hierarchy the feature already lives in, instead of falling
    // through to the synthetic "Diagnostic Experiments — {metric}"
    // capability that mechanism was built for real Diagnostic Analysis
    // experiments (which genuinely have no originating feature) — not for
    // this origin, which always has one.
    originFeatureCap:feat.cap,
    originFeatureStage:feat.stage,
    // v9.11.03 (Fix 8) — the real KPI-tree metric string, distinct from
    // outcomeHypothesis.primary.metric (a separate, free-text label that
    // happens to often match but isn't the same field). Feature Canvas
    // groups cards by stage+metric (fcRenderCanvas()) — capturing cap/
    // stage alone (v9.11.02) was not sufficient; without this, the new
    // card's metric came from the hypothesis label instead, causing a
    // second, duplicate stage section to appear even with the correct
    // stage/capability otherwise in place. Also carries forward the
    // original hypothesis's current actual/baseline/target so the new
    // sibling card can inherit sensible values instead of showing blank
    // baseline/target (reported live).
    originFeatureMetric:feat.metric,
    originHypothesisActual:p.actual,
    originHypothesisBaseline:p.baseline,
    originHypothesisTarget:p.target,
    // v9.11.04 (Fix 11) — the original feature's OWN hypothesis metric
    // label, distinct from feat.metric above. By original v9.10.00 design
    // (see buildCapFeaturesPrompt()'s explicit instruction), a feature's
    // outcomeHypothesis.primary.metric is deliberately allowed to be MORE
    // GRANULAR than the KPI-tree metric it's grouped under — e.g. a
    // feature grouped under "Organic Sign-ups" might track "Share-to-
    // Invite Conversion Rate" as its own hypothesis. The new sibling card
    // needs to inherit THIS field for its own hypothesis, not
    // feat.metric — using the wrong one caused the new card's METRIC
    // column and Experiment Library lookup to both show/search the wrong
    // string, reported live.
    originHypothesisMetric:p.metric
  };
  productLeakAnalysis.push(run);
  const saveSessionId=(typeof _activeSessionId!=='undefined')?_activeSessionId:null;
  const wasSharedSession=(typeof _activeSessionIsShared!=='undefined'&&_activeSessionIsShared);
  try{
    if(!_isDemoSession&&typeof sessionStoreSave==='function'&&saveSessionId){
      const _ok=await sessionStoreSave(saveSessionId);
      if(_ok&&wasSharedSession&&typeof _lsEmitContentEvent==='function'){
        try{
          await _lsEmitContentEvent(saveSessionId,'la','diagnostic_generated',null,null);
        }catch(lsErr){
          console.warn('Live-sync emission failed (save already succeeded):',lsErr);
        }
      }
    }
  }catch(saveErr){
    console.warn('Session save failed after synthesizing Outcome Pulse experiment:',saveErr);
  }
  // v9.25 code-review fix — was a raw .remove() that bypassed
  // _opCloseSuggestOverlay(), the 5th of the overlay's close paths and the
  // only one this refactor missed (Accept, not just Cancel/Close/Escape/X).
  _opCloseSuggestOverlay();
  if(typeof laRebuildSentIdsFromCanvas==='function')laRebuildSentIdsFromCanvas();
  _opNavigateToExperimentCanvasDetail(_runId,0,true);
}

// ── _opNavigateToExperimentCanvasDetail — v9.11.01 (Fix 1 & Fix 2). Shared
// by the Suggest Experiment modal's accept handler and Experiment Library's
// card click handler — both need to land on Experiment Canvas with a
// specific experiment's detail panel open; only whether to also
// pre-select that row differs (accept: yes, so the very next click can be
// "Send to Feature Canvas"; Library: no, since Library is pure navigation,
// not an accept action).
//
// Previously (accept handler only) called laSelectRun(runId), which (a)
// unconditionally clears leakSelectedIds ("clear selections on run
// switch" — correct for a normal user-driven switch, wrong here) so a
// newly-sent experiment never stayed selected, and (b) scoped
// _laActiveRunId to only that one run, hiding every other run's
// experiments from view (a prior Outcome Pulse experiment appeared to
// vanish after a second one was generated). Neither behavior is wanted
// from either caller.
//
// laOpenDetailPanel() has no dependency on _laActiveRunId — verified by
// reading it directly, it's keyed purely by the runId/idx arguments — so
// there is no need to scope the view to this run just to make the detail
// panel open correctly. Forcing _laActiveRunId=null (All Experiments)
// instead keeps every other run's experiments visible, including this
// one, and avoids a worse regression: if a user had been viewing some
// OTHER specific run beforehand, leaving _laActiveRunId untouched would
// open a detail panel for an experiment invisible in its own list, since
// the underlying table would still be scoped to that other run.
//
// Mutating leakSelectedIds directly (rather than via laToggleExperiment/
// laToggleExperimentByRow) is safe — both of those functions do nothing
// beyond a Set mutation, a table refresh, and a conditional detail-panel
// resync, none of which needs replicating here since the render below
// already covers all three.
//
// No manual laRenderAnalysis() call is made — switchTab('la') (invoked by
// revealAndSwitchTab below) already calls laRenderAnalysis() once
// internally on entering the tab; state must be set BEFORE that call so
// the single render reflects it, not after (which would need a second,
// redundant render).
function _opNavigateToExperimentCanvasDetail(runId,idx,preselect){
  _laActiveRunId=null;
  if(preselect)leakSelectedIds.add(runId+'|'+idx);
  if(typeof revealAndSwitchTab==='function')revealAndSwitchTab('la');
  if(typeof laOpenDetailPanel==='function')laOpenDetailPanel(runId,idx);
}

// ── Experiment Library panel (v9.11) — read-only, shared single instance
// across all Outcome Breakdown rows (not per-row state), scoped to whichever
// metric was clicked most recently. Shows ONLY outcome-pulse-sourced
// experiments (run.source==='outcome-pulse') for that metric — real-
// diagnostic-origin experiments targeting the same metric are deliberately
// excluded, per explicit decision, distinct from the broader dedup context
// fed to the generation prompt itself.
let _opLibraryMetric=null;
// v9.11.04 (Fix 14/6) — the specific feature id that opened Library, kept
// alongside the derived metric string. Needed because after Fix 11, two
// sibling cards (an original feature and its experiment-derived
// counterpart) can legitimately share the identical hypothesis metric
// string — a metric-only re-lookup (scCanvas.find() by metric, matching
// whichever card happens to come first in array order) could silently
// resolve to the WRONG sibling's origin, incorrectly gating the empty-
// state "Suggest Experiment" CTA. Storing the exact fid removes that
// ambiguity entirely.
let _opLibraryFeatureId=null;

function opOpenExperimentLibrary(fid){
  const feat=scCanvas.find(function(f){return f.id===fid;});
  if(!feat||!feat.outcomeHypothesis)return;
  _opLibraryMetric=feat.outcomeHypothesis.primary.metric;
  _opLibraryFeatureId=fid;
  _opRenderExperimentLibrary();
}

function opCloseExperimentLibrary(){
  _opLibraryMetric=null;
  _opLibraryFeatureId=null;
  const panel=document.getElementById('op-lib-panel');
  if(panel){panel.classList.remove('op-lib-panel-open');panel.innerHTML='';}
}

// ── Live status for one experiment card — never stored, always re-derived
// at render time from laFindCanvasCardForExperiment + that card's own
// stories.length, so a card deleted from Feature Canvas correctly reverts
// to "In Experiment Canvas" on the very next render with no separate
// invalidation step needed anywhere.
function _opLibraryStatusChipHTML(runId,expIdx){
  const card=(typeof laFindCanvasCardForExperiment==='function')?laFindCanvasCardForExperiment(runId,expIdx):null;
  if(!card)return'<span class="op-lib-status-chip op-lib-status-canvas">In Experiment Canvas</span>';
  const storyCount=card.stories&&card.stories.length?card.stories.length:0;
  return storyCount>0
    ?`<span class="op-lib-status-chip op-lib-status-fc">In Feature Canvas &middot; ${storyCount} stor${storyCount===1?'y':'ies'}</span>`
    :'<span class="op-lib-status-chip op-lib-status-fc">In Feature Canvas &middot; No stories generated</span>';
}

function _opRenderExperimentLibrary(){
  const panel=document.getElementById('op-lib-panel');
  if(!panel||!_opLibraryMetric)return;
  // v9.11.04 (Fix 14/6) — resolve by the exact fid captured on open, not a
  // fresh metric-only scCanvas.find(). Falls back to the old metric-only
  // lookup only if the stored fid's feature no longer exists (e.g.
  // deleted between opening Library and this render) — matching this
  // panel's existing "always re-derive live" convention rather than
  // failing closed.
  let anchorFeat=_opLibraryFeatureId?scCanvas.find(function(f){return f.id===_opLibraryFeatureId;}):null;
  if(!anchorFeat){
    anchorFeat=scCanvas.find(function(f){
      return isOutcomeTrackableFeature(f)&&f.outcomeHypothesis.primary.metric===_opLibraryMetric;
    });
  }
  const p=anchorFeat?anchorFeat.outcomeHypothesis.primary:null;
  const hasBaseline=p&&p.baseline!==null&&p.baseline!==undefined;
  const hasTarget=p&&p.target!==null&&p.target!==undefined;
  const baselineTargetLine=(hasBaseline||hasTarget)
    ?`Baseline ${hasBaseline?e(opFormatNumber(p.baseline)):'—'} &rarr; Target ${hasTarget?e(opFormatNumber(p.target)):'—'}`
    :'';
  const items=[];
  (productLeakAnalysis||[]).forEach(function(run){
    const src=run.source||'diagnostic';
    if(src!=='outcome-pulse')return;
    (run.experiments||[]).forEach(function(exp,idx){
      if(exp.linkedMetricName===_opLibraryMetric)items.push({run:run,exp:exp,idx:idx});
    });
  });
  // v9.11.04 (Fix 14) — the anchor feature's own origin, resolved from the
  // exact fid captured on open (see above) — same gate already used for
  // the kebab menu's disabled "Suggest Experiment" state (Fix 9/13), so
  // the empty-state CTA never invites an action that's actually unavailable
  // from this specific row.
  const _isAnchorExperimentDerived=!!(anchorFeat&&anchorFeat.origin==='diagnostic');
  const cardsHTML=items.length
    ?items.map(function(it){
        // v9.11.01 (Fix 2): clickable card navigating to Experiment Canvas's
        // detail panel for this exact experiment. Reuses the same shared
        // navigation helper as the Suggest Experiment modal's accept
        // handler, minus pre-selection (this is pure read navigation, not
        // an accept action). No permission gating needed — navigating to
        // view a detail panel mutates nothing, so a read-only session can
        // use this identically to an editable one. tabindex+role+onkeydown
        // give it real keyboard access, not just a mouse-only click zone.
        return`<div class="op-lib-card" role="button" tabindex="0" style="cursor:pointer;"
          onclick="_opNavigateToExperimentCanvasDetail('${e(it.run.runId)}',${it.idx},false)"
          onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();_opNavigateToExperimentCanvasDetail('${e(it.run.runId)}',${it.idx},false);}">
          <div class="op-lib-card-title">${e(it.exp.experimentTitle||'')}</div>
          <div class="op-lib-card-desc">${e(it.exp.description||it.exp.hypothesis||'')}</div>
          ${_opLibraryStatusChipHTML(it.run.runId,it.idx)}
        </div>`;
      }).join('')
    :`<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--t3);font-size:11px;flex:1;padding:24px 0;">
        <div style="margin-bottom:${(!_isAnchorExperimentDerived&&anchorFeat)?'12px':'0'};">No Outcome Pulse experiments suggested yet for this metric.</div>
        ${(!_isAnchorExperimentDerived&&anchorFeat)?`<button class="gen-btn" style="width:auto;padding:8px 14px;font-size:11px;" onclick="opCloseExperimentLibrary();opOpenSuggestExperimentModal('${e(anchorFeat.id)}')"><i class="ti ti-sparkles" style="font-size:11px;" aria-hidden="true"></i> Suggest Experiment</button>`:''}
      </div>`;
  panel.innerHTML=`
    <div class="cc-feat-panel-hdr" style="position:relative;">
      <div style="font-size:9px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:var(--blue);">Experiment Library</div>
      <div class="cc-feat-panel-cap-name">${e(_opLibraryMetric)}</div>
      ${baselineTargetLine?`<div style="font-size:10px;color:var(--t3);margin-top:2px;">${baselineTargetLine}</div>`:''}
      <button onclick="opCloseExperimentLibrary()" title="Close panel" aria-label="Close panel"
        style="position:absolute;top:12px;right:12px;background:none;border:1px solid var(--divider);border-radius:4px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--t3);">
        <i class="ti ti-x" style="font-size:11px;" aria-hidden="true"></i>
      </button>
    </div>
    <div class="cc-feat-panel-scroll">
      ${items.length?`<div style="font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--label);margin-bottom:8px;">Experiments</div>`:''}
      ${cardsHTML}
    </div>
  `;
  panel.classList.add('op-lib-panel-open');
}
