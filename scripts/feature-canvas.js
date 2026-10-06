// ── FEATURE CANVAS STATE (FC module — formerly Story Canvas) ──
// scCanvas: shared global store — also read by new Story Canvas and PI Canvas
// scStoryIdCounter: global, incremented by FC (AI gen) and new SC (manual add)
// scPiSelectedIds: global Set of feature IDs with ≥1 _stagedForPI story — read by PI Canvas

let scCanvas=[], scGroupMode='metric', scPanelFeatureId=null, scSelectedIds=new Set(), scModalBatchSize=0, scStoryIdCounter=0;
let scCapNavCollapsed=false, scCapNavFilter=null; // null = show all
// PI selection state — maintained by new Story Canvas, read by PI Canvas
let scPiSelectedIds=new Set();
// FC filter state
let fcStoriesFilter=new Set();         // Set of active filters: 'generated' | 'not-generated'
let fcOriginFilter=new Set();           // Set of active origin filters: 'origin-kpi' | 'origin-doc' | 'origin-custom' | 'origin-mi' | 'origin-diag'
// FC collapsed metric groups
let fcCollapsedGroups=new Set();
function fcToggleGroup(groupKey){
  if(fcCollapsedGroups.has(groupKey))fcCollapsedGroups.delete(groupKey);
  else fcCollapsedGroups.add(groupKey);
  fcRenderCanvas();
}
// Traceability panel state
let scPanelLineageOpen=false;

// ══════════════════════════════════════════════════════════════════════
// OUTCOME VERIFICATION LOOP — shared helpers (Phase A)
// Every surface that reads or aggregates outcomeHypothesis data MUST use
// these functions — never recompute independently. This is a deliberate
// deviation from this codebase's usual per-render-site computation style
// (see e.g. fcRenderCanvas()'s own inline doneCount), justified because
// this feature's premise depends on counts agreeing across the Outcome
// Pulse dashboard, the filter, and (future) PDF export. Divergent
// independent counts would directly undermine the feature's leadership-
// facing credibility. See outcome-verification-loop-spec.md §6.5 Findings
// C and D for the full reasoning.
// ══════════════════════════════════════════════════════════════════════

// Fixed default unit-of-measure list — no Settings-configurable list (see
// spec §1 scope discipline). 'custom' is always the escape hatch alongside
// this list, paired with a separate customLabel field.
const OUTCOME_HYP_UNITS=['%','days','hours','minutes','seconds','currency','count','score/rating'];

// ── Deep-clone a hypothesis object ──
// Guards against accidental shared-reference mutation — e.g. capStore's
// own copy of a feature (which can be regenerated/replaced later by a
// refinement re-generation) must never be the SAME object reference as
// the copy living in a scCanvas entry. Plain JSON round-trip is sufficient
// here since every field in this shape is a primitive, string, or array
// of primitives/strings — no functions, no Dates, no circular refs.
function cloneOutcomeHypothesis(hypothesis){
  if(!hypothesis)return null;
  try{return JSON.parse(JSON.stringify(hypothesis));}
  catch(e){return null;}
}

// ── Compute direction from baseline vs target ──
// Returns null when either input is missing/non-numeric — callers must
// treat null as "cannot compute," never coerce it to a default direction.
function computeDirection(baseline,target){
  // Defensive against empty-string inputs specifically (found via unit
  // testing, not yet reachable via any current call site since every
  // caller pre-normalizes '' to null before calling this — but this
  // function is a shared, reusable helper and should not rely on every
  // future caller remembering to do that normalization itself).
  if(baseline==='' || target==='')return null;
  const b=Number(baseline),t=Number(target);
  if(!isFinite(b)||!isFinite(t)||baseline===null||baseline===undefined||target===null||target===undefined)return null;
  if(t===b)return null; // no meaningful direction when baseline equals target
  return t<b?'decrease':'increase';
}

// ── Compute a SUGGESTED signal from actual vs baseline/target/direction ──
// This is advisory only — the PM can select any of the four signal values
// regardless of what this returns (per resolved design decision: signal
// entry has no numeric-value gate). Returns null when there isn't enough
// data to suggest anything; callers must treat null as "show no
// suggestion chip," never as a default signal value.
// Tolerance: within 1% of baseline-to-target range counts as "no change"
// rather than a false-precision Aligned/Opposed call on essentially flat
// movement. This tolerance is a deliberate, named constant so it can be
// tuned in one place rather than a magic number scattered across callers.
const OUTCOME_NOCHANGE_TOLERANCE_PCT=0.01;
function computeSuggestedSignal(primary){
  if(!primary)return null;
  const b=Number(primary.baseline),t=Number(primary.target),a=Number(primary.actual);
  if(!isFinite(b)||!isFinite(t)||!isFinite(a))return null;
  if(primary.baseline===null||primary.baseline===undefined)return null;
  if(primary.target===null||primary.target===undefined)return null;
  if(primary.actual===null||primary.actual===undefined)return null;
  const range=Math.abs(t-b);
  if(range===0)return null; // baseline===target — no directional signal is computable
  const movedFraction=(a-b)/(t-b); // 0 = no movement from baseline, 1 = reached target exactly
  const distFromBaseline=Math.abs(a-b);
  if(distFromBaseline<=range*OUTCOME_NOCHANGE_TOLERANCE_PCT)return'no-change';
  // Moving in the correct direction (movedFraction>0) counts as aligned,
  // regardless of whether it reached or overshot the target — the
  // "directionally correct but short of target" case collapses into
  // Aligned at this level by design (see spec §5.7). Moving the wrong way
  // (movedFraction<0) is opposed.
  return movedFraction>0?'aligned':'opposed';
}

// ── Is this feature tracked by Outcome Pulse at all? ──
// Per resolved design decision: any feature with outcomeHypothesis
// defined is tracked — no build/ship/release state exists anywhere in
// this app's data model to gate on instead (see spec §6.5 Finding A).
function isOutcomeTrackableFeature(feature){
  return!!(feature&&feature.outcomeHypothesis);
}

// ── Aggregate hypothesis signal counts across scCanvas ──
// The ONE function every Outcome Pulse surface must call for counts —
// the NSM-adjacent Hypothesis Health card, the Outcome Breakdown stage
// rows, the signal-status filter, and (future) PDF export all consume
// this same result, never their own independent tally.
function computeHypothesisAggregates(canvas){
  const out={aligned:0,opposed:0,noChange:0,awaiting:0,notApplicable:0,trackedCount:0};
  if(!Array.isArray(canvas))return out;
  canvas.forEach(f=>{
    if(!isOutcomeTrackableFeature(f))return;
    out.trackedCount++;
    const sig=f.outcomeHypothesis.primary&&f.outcomeHypothesis.primary.signal;
    if(sig==='aligned')out.aligned++;
    else if(sig==='opposed')out.opposed++;
    else if(sig==='no-change')out.noChange++;
    else if(sig==='not-applicable')out.notApplicable++;
    else out.awaiting++; // null/undefined signal = awaiting, per data model §3.1
  });
  return out;
}

// ── Format a unit for display, handling the 'custom' escape hatch ──
function formatOutcomeUnit(unit,customLabel){
  if(unit==='custom')return customLabel||'';
  return unit||'';
}

// ── Normalize a raw AI-returned hypothesis object into the real shape ──
// Used at both Capability Canvas generation call sites (§4.1) to convert
// the AI's {metric, unit, baseline, target, rationale} response into a
// full primary-hypothesis object with computed direction and source
// tagging. Returns null for anything malformed/missing rather than
// throwing — a broken hypothesis sub-object must never fail the whole
// feature-generation response (spec §6.5 Finding J).
function normalizeAIHypothesis(raw){
  if(!raw||typeof raw!=='object')return null;
  const metric=(raw.metric||'').toString().trim();
  if(!metric)return null;
  const unit=OUTCOME_HYP_UNITS.includes(raw.unit)?raw.unit:'custom';
  const customLabel=unit==='custom'?(raw.unit||'').toString().trim().slice(0,20):'';
  const baseline=isFinite(Number(raw.baseline))?Number(raw.baseline):null;
  const target=isFinite(Number(raw.target))?Number(raw.target):null;
  const direction=computeDirection(baseline,target);
  const rationale=(raw.rationale||'').toString().trim().slice(0,400);
  return{
    primary:{metric,unit,customLabel,baseline,target,direction,directionSource:'computed',rationale,source:'ai',actual:null,signal:null,loggedAt:null},
    secondary:[]
  };
}

// ══════════════════════════════════════════════════════════════════════
// END Outcome Verification Loop shared helpers
// ══════════════════════════════════════════════════════════════════════

// ── Toolbar actions kebab (v9.20) ──
// Consolidates the toolbar's standalone "Add Feature" and "Export" buttons
// into a single .tm-dots kebab, using the generic _uiRowMenuToggle()/
// _uiRowMenuClose() mechanics (utils.js) already proven in Team Management,
// PI Planning and Outcome Pulse. "Add Feature" drills in to the same two
// options scShowAddFeatureModal()/scShowUploadFeatModal() already power,
// replacing the popover's own content in place (same menuEl) rather than
// opening a side flyout - done by writing directly to _uiRowMenuOpen.menuEl
// instead of calling _uiRowMenuToggle again (which would just close it,
// since re-toggling the same trigger is a close).
function scTbKebabTopHtml(){
  const canEdit=(typeof canEditSession!=='function')||canEditSession();
  const addFeatRow=canEdit
    // v9.25.03 — dropped the <span> wrapper around icon+text: with
    // .tm-menu-item-expand's justify-content:space-between removed (see
    // 20-team-management.css), the span is no longer needed to protect
    // icon-text spacing from space-between, and kept it inconsistent with
    // this same menu's own Export row and CC's Add Capability row (all
    // three now share flat icon/text/chevron markup and the same 8px gap).
    ?'<div class="tm-menu-item tm-menu-item-expand" role="menuitem" tabindex="-1" onclick="event.stopPropagation();scTbKebabDrillAddFeature()"><i class="ti ti-plus" aria-hidden="true"></i> Add Feature <i class="ti ti-chevron-right" aria-hidden="true"></i></div>'
    :'';
  const exportDisabled=scCanvas.length===0||fcExportInFlight;
  const exportAttrs=exportDisabled?' aria-disabled="true" tabindex="-1" style="opacity:0.5;cursor:not-allowed;"':' tabindex="-1"';
  const exportClick=exportDisabled?'':'_uiRowMenuClose();scExportAll()';
  const exportIcon=fcExportInFlight?'<i class="ti ti-loader-2" style="font-size:12px;animation:spin 1s linear infinite;" aria-hidden="true"></i>':'<i class="ti ti-download" aria-hidden="true"></i>';
  const exportLabel=fcExportInFlight?'Exporting…':'Export';
  const exportRow='<div class="tm-menu-item" role="menuitem"'+exportAttrs+' onclick="'+exportClick+'">'+exportIcon+' '+exportLabel+'</div>';
  return '<div class="tm-menu-static" role="menu">'+addFeatRow+exportRow+'</div>';
}
function scToggleTbKebabMenu(triggerEl){
  _uiRowMenuToggle(triggerEl,scTbKebabTopHtml());
}
function scTbKebabShowTop(){
  if(typeof _uiRowMenuOpen!=='undefined'&&_uiRowMenuOpen&&_uiRowMenuOpen.menuEl){
    _uiRowMenuOpen.menuEl.innerHTML=scTbKebabTopHtml();
  }
}
function scTbKebabDrillAddFeature(){
  if(typeof _uiRowMenuOpen==='undefined'||!_uiRowMenuOpen||!_uiRowMenuOpen.menuEl)return;
  _uiRowMenuOpen.menuEl.innerHTML=
    '<div class="tm-submenu-standalone" role="menu">'
    +'<div class="tm-submenu-back" onclick="event.stopPropagation();scTbKebabShowTop()"><i class="ti ti-chevron-left" aria-hidden="true"></i> Add Feature</div>'
    +'<div class="cc-addcap-opt" role="menuitem" onclick="_uiRowMenuClose();scShowAddFeatureModal()"><i class="ti ti-pencil" aria-hidden="true"></i> Single Feature</div>'
    +'<div class="cc-addcap-opt" role="menuitem" onclick="_uiRowMenuClose();scShowUploadFeatModal()"><i class="ti ti-upload" aria-hidden="true"></i> Upload from File</div>'
    +'</div>';
}

let scPanelLinkingMetric=false;
let scLineageTargetElId='sc-panel-feat-meta'; // FC default; SC sets to 'nsc-trace-meta'

// ── Capability Nav Panel ──
function fcRenderCapNav(){
  const tree=document.getElementById('sc-cap-nav-tree');
  const nav=document.getElementById('sc-cap-nav');
  if(!tree||!nav)return;

  nav.classList.toggle('collapsed',scCapNavCollapsed);
  const colBtn=document.getElementById('sc-cap-nav-collapse');
  if(colBtn){
    colBtn.title=scCapNavCollapsed?'Expand':'Collapse';
    colBtn.innerHTML=scCapNavCollapsed
      ?'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/><polyline points="3 18 9 12 3 6"/></svg>'
      :'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/><polyline points="21 18 15 12 21 6"/></svg>';
  }

  if(!scCanvas.length){
    tree.innerHTML='<div class="sc-cap-nav-empty">No features on canvas yet.<br>Select features from the Discovery Map.</div>';
    return;
  }

  // CRITICAL: null guard is mandatory — fcRenderCapNav() is called before any tree is generated
  const stageOrder=gData?gData.stages.map(s=>s.label):[];
  // Dynamic colour map from STAGE_PALETTE (defined in kpi-tree.js) by stage index
  const stageColorMap={};
  if(gData&&gData.stages){gData.stages.forEach((s,i)=>{stageColorMap[s.label]=STAGE_PALETTE[i%STAGE_PALETTE.length];});}
  const stageColors=stageColorMap;

  // Build: stage → metric → cap → count
  const treeData={};
  // v9.06.02: removed the hardcoded 'Custom Capabilities' generic grouping
  // key — previously ALL pi-stage features merged under one undifferentiated
  // group regardless of which specific bucket/process-area they actually
  // belonged to, discarding the real name entirely. Now groups by f.metric
  // directly, exactly like KPI-linked features already do — the real bucket
  // name (already correctly maintained by piBucketRename(), including after
  // a rename, per item 7's fix) is what naturally distinguishes buckets from
  // each other here, with zero special-casing needed.
  scCanvas.forEach(f=>{
    const st=f.stage||'Other';
    const mt=f.metric||'Unknown';
    const cp=f.cap||'Uncategorised';
    if(!treeData[st])treeData[st]={metrics:{}};
    if(!treeData[st].metrics[mt])treeData[st].metrics[mt]={caps:{}};
    if(!treeData[st].metrics[mt].caps[cp])treeData[st].metrics[mt].caps[cp]=0;
    treeData[st].metrics[mt].caps[cp]++;
  });

  const allActive=scCapNavFilter===null;
  let h=`<div class="sc-nav-all${allActive?' active':''}" onclick="scSetCapFilter(null)">
    <i class="ti ti-layout-grid" style="font-size:12px;" aria-hidden="true"></i>
    <span class="sc-nav-all-text">All Features</span>
    <span class="sc-nav-count${allActive?' active':''}">${scCanvas.length}</span>
  </div>`;

  const orderedStages=[...stageOrder.filter(s=>treeData[s]),...Object.keys(treeData).filter(s=>!stageOrder.includes(s))];

  orderedStages.forEach(stage=>{
    const sg=treeData[stage];
    if(!sg)return;
    const color=stageColors[stage]||'var(--blue)';

    // v9.06.01: kept as a defensive safety net — once migration runs (see
    // migratePiStageLegacyLabel() in pi-bucket.js), 'stage' should already
    // say 'Custom Value Stage' directly, making this a harmless no-op. Left
    // in place in case any edge case still surfaces the raw legacy literal.
    const _dispStage=stage==='PI Plan'?'Custom Value Stage':stage;
    // Stage — coloured bar + label
    h+=`<div class="sc-nav-stage">
      <div class="sc-nav-stage-bar" style="background:${color}"></div>
      <span class="sc-nav-stage-lbl" style="color:${color}">${e(_dispStage)}</span>
    </div>`;

    Object.entries(sg.metrics).forEach(([metric,md])=>{
      // Check if any feature under this metric came from diagnostic
      const hasDiagFeature=scCanvas.some(f=>f.metric===metric&&f.stage===stage&&f.origin==='diagnostic');
      // v9.06.02: removed the "Custom Capabilities" -> mode-aware-term
      // display transformation — metric is never literally that generic
      // string anymore (grouping now uses f.metric directly, always the
      // bucket's real, correctly-maintained name). getOrCreateCurrentDefaultPiBucket()
      // already stores the mode-aware default name ('Custom Process Area'
      // or 'Custom Metric') directly in l1.name at creation time, so metric
      // is already correct as-is — no display-layer override needed.
      // Metric label — not interactive, just structural
      h+=`<div class="sc-nav-metric">${hasDiagFeature?'<span class="sc-nav-diag-dot" title="Contains diagnostic-origin features"></span>':''}<span class="sc-nav-metric-name">${e(metric)}</span></div>`;

      Object.entries(md.caps).forEach(([cap,count])=>{
        const isActive=scCapNavFilter===cap;
        const capSafe=e(cap).split("'").join('&#39;');
        h+=`<div class="sc-nav-cap${isActive?' active':''}" onclick="scSetCapFilter('${capSafe}')">
          <div class="sc-nav-cap-track">
            <div class="sc-nav-cap-node${isActive?' active':''}"></div>
          </div>
          <div class="sc-nav-cap-body">
            <span class="sc-nav-cap-name">${e(cap)}</span>
            <span class="sc-nav-count${isActive?' active':''}">${count}</span>
          </div>
        </div>`;
      });
    });
  });

  tree.innerHTML=h;
}

function scToggleCapNav(){
  scCapNavCollapsed=!scCapNavCollapsed;
  fcRenderCapNav();
}

function scSetCapFilter(capName){
  scCapNavFilter=capName;
  scSelectedIds.clear(); // selection is filter-scoped — prevents hidden cross-filter selections feeding Generate Stories
  // Update filter badge in toolbar
  const badge=document.getElementById('sc-filter-badge');
  const label=document.getElementById('sc-filter-label');
  if(badge&&label){
    if(capName){
      label.textContent=capName;
      badge.style.display='inline-flex';
    } else {
      badge.style.display='none';
    }
  }
  fcRenderCapNav();
  fcRenderCanvas();
  // v8.55: update panel nav counter if a panel is already open
  if(scPanelFeatureId)scUpdatePanelNav();
}

function scMakeFeatureId(metric,cap,feat){
  return (metric+'|'+cap+'|'+feat).replace(/['"]/g,'');
}

function scToggleFeature(fid,metric,stage,cap,fname,fwhy,checkEl,outcomeHypothesis){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const idx=scCanvas.findIndex(x=>x.id===fid);
  if(idx>=0){
    // Remove from canvas
    if(typeof pcDeleteProto==='function')pcDeleteProto(fid);
    scCanvas.splice(idx,1);
    checkEl.classList.remove('checked');
    checkEl.closest('.feat-item').classList.remove('on-canvas');
    // If this feature's panel is open, close it
    if(scPanelFeatureId===fid) scClosePanel();
    // Remove from both selection sets
    scSelectedIds.delete(fid);
    scPiSelectedIds.delete(fid);
  } else {
    // Add to canvas — compute full metric path from gData hierarchy
    const metricPath=scGetMetricPath(metric);
    // Outcome Verification Loop: carry hypothesis through if the drawer
    // lookup found one; cloned defensively so this scCanvas entry never
    // shares a reference with the capStore copy (per spec §6.5 Finding
    // on nested-object cloning risk — capStore's own copy could still be
    // regenerated/replaced later by a refinement re-generation).
    const _clonedHyp=(outcomeHypothesis&&typeof cloneOutcomeHypothesis==='function')
      ?cloneOutcomeHypothesis(outcomeHypothesis):null;
    scCanvas.push({id:fid,metric,metricPath,stage,cap,name:fname,why:fwhy,stories:null,origin:'kpi',outcomeHypothesis:_clonedHyp});
    checkEl.classList.add('checked');
    checkEl.closest('.feat-item').classList.add('on-canvas');
  }
  scUpdateCapDrawerFooter();
  fcUpdateTabBadge();
  fcRenderCanvas();
  // v8.147 fix: confirmed missing entirely — a third entry point (drawer
  // checkbox) for adding/removing a whole feature, same coarse semantics
  // as CC's own send/remove actions.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('sc',fid+_LS_SC_TARGET_SEP); });
  }
}

function scUpdateCapDrawerFooter(){
  // capability-drawer.js (and its #cap-drawer-footer/#cap-canvas-count-num
  // markup) was removed as dead code — this function is still called from
  // several unrelated feature-mutation call sites below, so guard rather
  // than remove those call sites.
  const footer=document.getElementById('cap-drawer-footer');
  const count=document.getElementById('cap-canvas-count-num');
  if(!footer||!count)return;
  count.textContent=scCanvas.length;
  footer.style.display=scCanvas.length>0?'flex':'none';
}

function fcUpdateTabBadge(){
  const badge=document.getElementById('fc-tab-badge');
  if(badge){badge.textContent=scCanvas.length;badge.classList.toggle('on',scCanvas.length>0);}
  // Reveal tab on first feature — one-way door, never re-hidden
  if(scCanvas.length>0){
    const tabBtn=document.getElementById('tab-fc');
    if(tabBtn)tabBtn.style.display='';
  }
}

// ── Canvas rendering ──
// Look up evidence for a metric name from the active diagnostic session
function scGetMetricEvidence(metricName){
  if(!diagnosticSessions||!diagnosticSessions.length||!activeDiagnosticId)return null;
  const session=diagnosticSessions.find(s=>s.id===activeDiagnosticId);
  if(!session||!session.tree)return null;
  for(var si=0;si<(session.tree.stages||[]).length;si++){
    var st=session.tree.stages[si];
    for(var li=0;li<(st.l1_metrics||[]).length;li++){
      var l1=st.l1_metrics[li];
      if(!l1)continue;
      if(l1.name===metricName)return l1.evidence||null;
      for(var l2i=0;l2i<(l1.l2_metrics||[]).length;l2i++){
        var l2=l1.l2_metrics[l2i];
        if(!l2)continue;
        if(l2.name===metricName)return l2.evidence||null;
        for(var l3i=0;l3i<(l2.l3_metrics||[]).length;l3i++){
          var l3=l2.l3_metrics[l3i];
          if(l3&&l3.name===metricName)return l3.evidence||null;
        }
      }
    }
  }
  return null;
}

// Build evidence chip HTML — returns empty string if no evidence
// Colour is driven by trend direction: Improving=green, Flat/Declining=amber, Unknown/none=grey
function scBuildEvidenceChip(metricName){
  const ev=scGetMetricEvidence(metricName);
  if(!ev||!ev.currentValue)return'';
  // Colour by trend direction
  var bgCls='sc-ev-chip-neutral';
  if(ev.trend==='Improving')bgCls='sc-ev-chip-improving';
  else if(ev.trend==='Declining'||ev.trend==='Flat')bgCls='sc-ev-chip-warning';
  // Build trend text with direction icon
  const trendMap={'Improving':'↑ Improving','Declining':'↓ Declining','Flat':'→ Flat','Unknown':'Unknown'};
  const trendHtml=ev.trend&&trendMap[ev.trend]?'<span class="sc-ev-trend">'+trendMap[ev.trend]+'</span>':'';
  return'<span class="sc-ev-chip '+bgCls+'">'+e(ev.currentValue)+(trendHtml?' '+trendHtml:'')+'</span>';
}

// Returns a flat ordered list of metric names in KPI tree order (L1, L2, L3 per stage) in KPI tree order (L1, L2, L3 per stage)
function scGetMetricOrder(){
  const order=[];
  if(!gData||!gData.stages)return order;
  gData.stages.forEach(function(st){
    (st.l1_metrics||[]).forEach(function(l1){
      if(l1&&l1.name){
        order.push(l1.name);
        (l1.l2_metrics||[]).forEach(function(l2){
          if(l2&&l2.name){
            order.push(l2.name);
            (l2.l3_metrics||[]).forEach(function(l3){if(l3&&l3.name)order.push(l3.name);});
          }
        });
      }
    });
  });
  return order;
}
// ── Metric path lookup ──
// Given a metric name and gData, returns the full path e.g. "L1 Name › L2 Name"
function scGetMetricPath(metricName){
  if(!gData||!gData.stages||!metricName)return metricName||'';
  for(var si=0;si<gData.stages.length;si++){
    var st=gData.stages[si];
    var l1s=st.l1_metrics||[];
    for(var li=0;li<l1s.length;li++){
      var l1=l1s[li];
      if(!l1)continue;
      if(l1.name===metricName)return l1.name;
      var l2s=l1.l2_metrics||[];
      for(var l2i=0;l2i<l2s.length;l2i++){
        var l2=l2s[l2i];
        if(!l2)continue;
        if(l2.name===metricName)return l1.name+' › '+l2.name;
        var l3s=l2.l3_metrics||[];
        for(var l3i=0;l3i<l3s.length;l3i++){
          var l3=l3s[l3i];
          if(!l3)continue;
          if(l3.name===metricName)return l1.name+' › '+l2.name+' › '+l3.name;
        }
      }
    }
  }
  return metricName;
}

// ── Metric breadcrumb builder (single line, right-truncate L1 first then L2) ──
function scBuildMetricBreadcrumb(metricPath){
  if(!metricPath)return'';
  var fullPath=metricPath;
  return'<div class="sc-metric-breadcrumb" data-tooltip="'+e(fullPath)+'">'+e(fullPath)+'</div>';
}

// Priority truncation for metric breadcrumb (single line)
function scFitMetricBreadcrumbs(){
  document.querySelectorAll('.sc-metric-breadcrumb').forEach(function(el){
    var fullPath=el.dataset.tooltip||'';
    if(el.scrollWidth<=el.clientWidth+2)return;
    var origSegs=fullPath.split(' › ').map(function(s){return s.trim();}).filter(Boolean);
    if(origSegs.length<=1)return;
    var segs=origSegs.slice();
    var MIN=6;
    var SEP=' › ';
    function render(){el.textContent=segs.join(SEP);}
    function fits(){return el.scrollWidth<=el.clientWidth+2;}
    // shorten L1 first
    for(var len=segs[0].length-3;len>=MIN;len-=3){
      segs[0]=origSegs[0].slice(0,len)+'…';
      render();if(fits())return;
    }
    segs[0]=origSegs[0].slice(0,MIN)+'…';
    // shorten L2 if 3 levels
    if(segs.length>=3){
      render();if(fits())return;
      for(var len2=segs[1].length-3;len2>=MIN;len2-=3){
        segs[1]=origSegs[1].slice(0,len2)+'…';
        render();if(fits())return;
      }
      segs[1]=origSegs[1].slice(0,MIN)+'…';
    }
    render();
  });
}

// ── Capability breadcrumb builder ──
// cap field format: "L1 Cap" or "L1 Cap › L2 Cap" or "L1 Cap › L2 Cap › L3 Cap"
// Returns HTML string for the breadcrumb line with full path in title attribute
function scBuildCapBreadcrumb(cap){
  if(!cap)return'';
  const segs=cap.split('›').map(s=>s.trim()).filter(Boolean);
  // Build full path for tooltip
  const fullPath=segs.join(' › ');
  // Build rendered HTML - segments joined with styled separator
  const rendered=segs.map(s=>e(s)).join('<span class="sc-bc-sep">›</span>');
  return'<div class="sc-cap-breadcrumb" data-tooltip="'+e(fullPath)+'" id="scbc-'+Math.random().toString(36).slice(2)+'">'+rendered+'</div>';
}

// Re-fit breadcrumbs on viewport resize, not just on render — without this,
// truncation set at one width goes stale (either under- or over-truncated)
// if the user resizes without triggering a card re-render.
if(typeof window!=='undefined'&&!window._scBreadcrumbResizeWired){
  window._scBreadcrumbResizeWired=true;
  var _scBcResizeTimer=null;
  window.addEventListener('resize',function(){
    clearTimeout(_scBcResizeTimer);
    _scBcResizeTimer=setTimeout(function(){scFitBreadcrumbs();},150);
  });
}

// Priority truncation: shorten L1 first, then L2, preserve L3
// Called after render via requestAnimationFrame
function scFitBreadcrumbs(){
  document.querySelectorAll('.sc-cap-breadcrumb').forEach(function(el){
    const MAX_LINES=2;
    const LINE_H=el.offsetHeight>0?el.scrollHeight/2:14;
    if(el.scrollHeight<=el.offsetHeight*MAX_LINES+2)return;
    const fullPath=el.dataset.tooltip||'';
    const origSegs=fullPath.split(' › ').map(s=>s.trim()).filter(Boolean);
    if(origSegs.length<=1)return;
    const segs=[...origSegs];
    const MIN=6;
    const SEP='<span class="sc-bc-sep">›</span>';
    function render(){el.innerHTML=segs.map(s=>e(s)).join(SEP);}
    function fits(){return el.scrollHeight<=el.clientHeight+4;}
    // Phase 1: shorten L1
    if(segs.length>=2){
      for(let len=segs[0].length-3;len>=MIN;len-=3){
        segs[0]=origSegs[0].slice(0,len)+'…';
        render();if(fits())return;
      }
      segs[0]=origSegs[0].slice(0,MIN)+'…';
    }
    // Phase 2: shorten L2
    if(segs.length>=3){
      render();if(fits())return;
      for(let len=segs[1].length-3;len>=MIN;len-=3){
        segs[1]=origSegs[1].slice(0,len)+'…';
        render();if(fits())return;
      }
      segs[1]=origSegs[1].slice(0,MIN)+'…';
    }
    // Phase 3: hard clamp L3 with CSS as last resort
    el.style.display='-webkit-box';
    el.style.webkitLineClamp='2';
    el.style.webkitBoxOrient='vertical';
    el.style.overflow='hidden';
    render();
  });
}

// Shared visible-set computation — capability filter + stories filter.
// Used by fcRenderCanvas (what's on screen) and scSelectAll (what "select all" should select),
// so the two never drift out of sync with each other.
function fcGetVisibleCanvas(){
  let visibleCanvas=scCapNavFilter ? scCanvas.filter(f=>f.cap===scCapNavFilter) : scCanvas;
  const _hasGen=fcStoriesFilter.has('generated');
  const _hasNotGen=fcStoriesFilter.has('not-generated');
  if(_hasGen&&!_hasNotGen) visibleCanvas=visibleCanvas.filter(f=>f.stories&&f.stories.length>0);
  else if(_hasNotGen&&!_hasGen) visibleCanvas=visibleCanvas.filter(f=>!f.stories||f.stories.length===0);
  if(fcOriginFilter.size){
    visibleCanvas=visibleCanvas.filter(f=>{
      const _o=f.origin||'kpi';
      const _isDoc=_o==='doc';
      const _isCustom=_o==='pi';
      const _isMI=_o==='market';
      const _isDiag=_o==='diagnostic';
      const _isKpi=!_isDoc&&!_isCustom&&!_isMI&&!_isDiag;
      if(fcOriginFilter.has('origin-doc')&&_isDoc)return true;
      if(fcOriginFilter.has('origin-custom')&&_isCustom)return true;
      if(fcOriginFilter.has('origin-mi')&&_isMI)return true;
      if(fcOriginFilter.has('origin-diag')&&_isDiag)return true;
      if(fcOriginFilter.has('origin-kpi')&&_isKpi)return true;
      // §9.1 — "Requirement Agent" origin value: RQ-agnostic (any
      // intakeBriefId) if the parent alone is checked, else scoped to
      // whichever RQs are individually checked (same tri-state model as CC).
      const _wRa=fcOriginFilter.has('origin-ra')||Array.from(fcOriginFilter).some(t=>t.indexOf('origin-ra-rq:')===0);
      if(_wRa&&f.intakeBriefId){
        const checkedRqIds=Array.from(fcOriginFilter).filter(t=>t.indexOf('origin-ra-rq:')===0).map(t=>t.slice('origin-ra-rq:'.length));
        if(checkedRqIds.length)return checkedRqIds.indexOf(f.intakeBriefId)>=0;
        return fcOriginFilter.has('origin-ra');
      }
      return false;
    });
  }
  // both or neither = show all
  return visibleCanvas;
}

function fcRenderCanvas(){
  // Keep cap nav in sync
  if(curTab==='fc') fcRenderCapNav();
  const empty=document.getElementById('sc-empty-state');
  const content=document.getElementById('sc-content');
  const actionBar=document.getElementById('sc-action-bar');
  // Apply capability nav filter + stories filter
  let visibleCanvas=fcGetVisibleCanvas();

  if(scCanvas.length===0){
    empty.style.display='flex';
    content.style.display='none';
    actionBar.style.display='none';
    return;
  }
  empty.style.display='none';
  content.style.display='flex';
  actionBar.style.display='flex';

  // Filter empty state
  if(visibleCanvas.length===0&&scCanvas.length>0){
    document.getElementById('sc-cards-container').innerHTML=
      `<div style="padding:40px 20px;text-align:center;color:var(--t3);">
        <div style="font-size:13px;font-weight:600;color:var(--t2);margin-bottom:8px;">No features match the current filter</div>
        <div style="font-size:11px;margin-bottom:14px;">Try clearing the filter to see all features.</div>
        <button onclick="fcClearFilter()" style="background:none;border:1px solid var(--divider);border-radius:5px;padding:5px 12px;font-size:11px;cursor:pointer;color:var(--t2);">Clear filter</button>
      </div>`;
    scUpdateActionBar(visibleCanvas);
    scUpdateDoneBadge();
    return;
  }

  // Build groups — use visibleCanvas for display
  let groups=[];
  if(scGroupMode==='metric'){
    const map={};
    visibleCanvas.forEach(f=>{
      // v9.06.02: removed the "merge all Custom Value Stage caps into one
      // group" special case — f.metric is now always the real, correctly-
      // maintained bucket name (including after a rename, per piBucketRename()'s
      // downstream-patching fix), so grouping by stage+metric works
      // identically for pi-origin and KPI-linked features alike, with two
      // distinct buckets under Custom Value Stage correctly staying separate
      // groups instead of collapsing into one.
      const k=f.stage+'||'+f.metric;
      const label=f.metricPath||f.metric;
      const metricKey=f.metric;
      if(!map[k])map[k]={label,metricKey,stage:f.stage,features:[]};
      map[k].features.push(f);
    });
    groups=Object.values(map);
  } else {
    const map={};
    visibleCanvas.forEach(f=>{
      const k=f.cap;
      if(!map[k])map[k]={label:f.cap,stage:f.stage,features:[]};
      map[k].features.push(f);
    });
    groups=Object.values(map);
  }

  // Dynamic colour map from STAGE_PALETTE by stage index
  const scRenderColorMap={};
  if(gData&&gData.stages){gData.stages.forEach((s,i)=>{scRenderColorMap[s.label]=STAGE_PALETTE[i%STAGE_PALETTE.length];});}

  // Sort groups: first by stage order, then by metric position within KPI tree
  if(gData&&gData.stages&&gData.stages.length){
    const stageOrder=gData.stages.map(s=>s.label);
    const metricOrder=scGetMetricOrder();
    groups.sort(function(a,b){
      const ai=stageOrder.indexOf(a.stage);
      const bi=stageOrder.indexOf(b.stage);
      if(ai!==bi){
        if(ai===-1)return 1;
        if(bi===-1)return -1;
        return ai-bi;
      }
      // Same stage — sort by metric position in KPI tree
      // Sort by bare metric name, not the full path label
      const ami=metricOrder.indexOf(a.metricKey||a.label);
      const bmi=metricOrder.indexOf(b.metricKey||b.label);
      if(ami===-1&&bmi===-1)return 0;
      if(ami===-1)return 1;
      if(bmi===-1)return -1;
      return ami-bmi;
    });
  }

  let h='';
  groups.forEach(g=>{
    const color=scRenderColorMap[g.stage]||STAGE_PALETTE[0];
    const featCount=g.features.length;
    const doneCount=g.features.filter(f=>f.stories&&f.stories.length>0).length;
    const countLabel=scGroupMode==='metric'
      ? featCount+' feature'+(featCount!==1?'s':'')+(doneCount>0?' · '+doneCount+' with stories':'')
      : featCount+' feature'+(featCount!==1?'s':'');
    const _fcGroupKey=g.stage+'||'+(g.metricKey||g.label);
    const _fcIsCollapsed=fcCollapsedGroups.has(_fcGroupKey);
    h+=`<div class="sc-metric-group">`;
    h+=`<div class="sc-metric-hdr" style="border-left:3px solid ${color};">`;
    h+=`<span class="sc-stage-pill" style="background:${color}">${e(g.stage)}</span>`;
    // Render metric hierarchy path with styled separators
    const metricSegs=(g.label||'').split('›').map(s=>s.trim()).filter(Boolean);
    const metricHtml=metricSegs.map((s,i)=>(i>0?'<span class="sc-metric-sep">›</span>':'')+`<span class="sc-metric-seg${i===metricSegs.length-1?' sc-metric-seg-last':''}">${e(s)}</span>`).join('');
    h+=`<div class="sc-metric-name" title="${e(g.label)}">${metricHtml}</div>`;
    // Evidence chip — only shown when diagnostic session has evidence for this metric
    h+=scBuildEvidenceChip(g.metricKey||g.label);
    h+=`<div class="sc-metric-count">${e(countLabel)}</div>`;
    h+=`<button class="nsc-chevron" onclick="fcToggleGroup('${e(_fcGroupKey)}')" title="${_fcIsCollapsed?'Expand':'Collapse'}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${_fcIsCollapsed?'<polyline points="9 18 15 12 9 6"/>':'<polyline points="18 15 12 9 6 15"/>'}</svg></button>`;
    h+=`</div>`;
    if(_fcIsCollapsed){
      h+=`<div class="nsc-collapsed-hint">Features hidden — click ▶ to expand</div>`;
    } else {
// ── Outcome Verification Loop: feature card hypothesis chip (B3) ──
// Pure read display — no canEditSession() gating needed, matches every
// other read-only badge/tag already on this card.
function scBuildOutcomeHypChipHTML(f){
  if(!isOutcomeTrackableFeature(f)){
    const _canEdit=(typeof canEditSession!=='function')||canEditSession();
    if(!_canEdit)
      return`<div class="sc-hyp-chip sc-hyp-chip-empty" style="cursor:default;opacity:0.6;" title="No outcome hypothesis set"><i class="ti ti-target-arrow" style="font-size:9px;" aria-hidden="true"></i> No hypothesis</div>`;
    return`<div class="sc-hyp-chip sc-hyp-chip-empty" onclick="event.stopPropagation();scShowEditFeatModal('${e(ejs(f.id))}')" style="cursor:pointer;" title="Add an outcome hypothesis for this feature"><i class="ti ti-plus" style="font-size:9px;" aria-hidden="true"></i> Define hypothesis</div>`;
  }
  const p=f.outcomeHypothesis.primary;
  const arrow=p.direction==='decrease'?'↓':(p.direction==='increase'?'↑':'');
  const label=(p.metric||'')+(arrow?' '+arrow:'');
  // Tooltip content: full metric name + baseline->target, richer than the
  // truncated chip label itself (Item 3 fix) — no direction arrow repeated
  // (already on the chip) and no secondary mention (chip only ever
  // represents primary), per explicit design decision.
  const hasBT=p.baseline!==null&&p.baseline!==undefined&&p.target!==null&&p.target!==undefined;
  const tooltipText=(p.metric||'')+(hasBT?' | '+p.baseline+' \u2192 '+p.target:'');
  // Bug 1 fix (v9.10.02 feedback round, adversarially confirmed): the
  // tooltip is a ::after pseudo-element of whichever DOM node carries the
  // pgt-tooltip class/data-tooltip attribute. Putting overflow:hidden (
  // required for text-overflow:ellipsis to truncate the long label) on
  // that SAME node clips its own tooltip content before it can ever
  // become visible — a real, unavoidable CSS conflict, not a z-index or
  // propagation issue. Fixed by splitting the two concerns onto two
  // nested elements, matching the identical pattern already proven
  // elsewhere in this codebase (home.js's .home-sdoc-name /
  // .home-sdoc-name-inner split): the OUTER span carries pgt-tooltip +
  // data-tooltip and NO overflow rule of its own; the INNER span carries
  // all the truncation styling (overflow:hidden, text-overflow:ellipsis,
  // white-space:nowrap, max-width) that used to live directly on
  // .sc-hyp-chip.
  // Adoption Readiness (v9.21, §4.1) — soft, non-blocking amber warning
  // badge when the carry-forward check (rcApplyHypothesisCarryForward(),
  // readiness-canvas.js) found no logged prior-release actual. Informational
  // only — never blocks generation, never requires dismissal.
  const carryWarn=p._rcNoPriorOutcomeWarning
    ?`<span class="sc-hyp-carry-warn pgt-tooltip" data-tooltip="No outcome logged for the prior release. Baseline shown below may be outdated. Consider checking Outcome Pulse before confirming."><i class="ti ti-alert-triangle" aria-hidden="true"></i></span>`
    :'';
  return`<span class="sc-hyp-chip pgt-tooltip" data-tooltip="${e(tooltipText)}"><span class="sc-hyp-chip-inner"><i class="ti ti-target-arrow" style="font-size:9px;" aria-hidden="true"></i> ${e(label)}</span></span>${carryWarn}`;
}

    h+=`<div class="sc-cards">`;
    g.features.forEach(f=>{
      const hasDone=f.stories&&f.stories.length>0;
      const isSel=scSelectedIds.has(f.id);
      const isActive=scPanelFeatureId===f.id;
      const isDiag=f.origin==='diagnostic';
      const isMI=f.origin==='market';
      const isPI=f.origin==='pi';
      const _inScCount=hasDone?(f.stories||[]).filter(st=>st._inSC).length:0;
      const _stagedCount=hasDone?(f.stories||[]).filter(st=>st._stagedForPI).length:0;
      const isPiSel=scPiSelectedIds.has(f.id)||_inScCount>0;
      const piSelStoryCount=_inScCount>0?_inScCount:_stagedCount;
      const piSelIsPartial=isPiSel&&piSelStoryCount>0&&piSelStoryCount<(f.stories||[]).length;

      let cls='sc-card';
      if(isDiag)cls+=' sc-card-diagnostic';
      else if(isMI)cls+=' sc-card-market';
      else if(isPI)cls+=' sc-card-pi';
      else cls+=' sc-card-kpi';
      if(hasDone&&isPiSel)cls+=' sc-card-pi-sel';
      else if(hasDone)cls+=' sc-card-done';
      else if(isSel)cls+=' sc-card-sel';
      if(isActive)cls+=' sc-card-active';

      const cardClick=`scOpenPanel('${e(f.id)}')`;
      const _canEditFcCard=(typeof canEditSession!=='function')||canEditSession();
      h+=`<div class="${cls}" id="sc-card-${e(f.id)}" onclick="${cardClick}" style="cursor:pointer;">`;
      h+=`<div class="sc-card-top">`;
      h+=scBuildCapBreadcrumb(f.cap);
      h+=`<div class="sc-card-actions">`;
      if(_canEditFcCard)h+=`<button class="sc-card-pencil" onclick="event.stopPropagation();scShowEditFeatModal('${e(f.id)}')" title="Edit feature" aria-label="Edit feature"><i class="ti ti-pencil" style="font-size:10px;" aria-hidden="true"></i></button>`;
      if(!hasDone){
        // No-story cards: checkbox selects feature for story generation
        h+=`<div class="sc-card-check${_canEditFcCard?'':' sc-card-check-disabled'}" ${_canEditFcCard?`onclick="event.stopPropagation();scToggleSelect('${e(f.id)}')"`:''} title="Select for story generation">`;
        if(isSel)h+=`<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        h+=`</div>`;
      } else {
        // Done cards: checkbox selects stories for PI planning (full/partial/none)
        const piCheckTitle=isPiSel?'Deselect from PI planning':'Select for PI planning';
        h+=`<div class="sc-card-check${isPiSel?' sc-card-check-pi':''}${_canEditFcCard?'':' sc-card-check-disabled'}" ${_canEditFcCard?`onclick="event.stopPropagation();scTogglePiSelect('${e(f.id)}')"`:''} title="${piCheckTitle}">`;
        if(isPiSel&&!piSelIsPartial){
          h+=`<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        } else if(piSelIsPartial){
          h+=`<div style="width:8px;height:2px;background:#fff;border-radius:1px;"></div>`;
        }
        h+=`</div>`;
      }
      if(_canEditFcCard){
        h+=`<button class="sc-card-remove" onclick="event.stopPropagation();scRemoveFeature('${e(f.id)}')" title="Remove from canvas">`;
        h+=`<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
        h+=`</button>`;
      }
      h+=`</div></div>`;
      // Origin icon + name
      const isDoc=f.origin==='doc';
      const _scOriginIcon=isDiag?'ti-microscope':isMI?'ti-world-search':isDoc?'ti-file-text':f.origin==='pi'?'ti-clipboard-list':'ti-hierarchy-2';
      const _scOriginTitle=isDiag?'From Experiment Canvas':isMI?'From Market Intelligence':isDoc?'From Session Document':f.origin==='pi'?'From Custom plan':'From Discovery Map Capability';
      const _scOriginClass=isDiag?'sc-origin-icon-diag':isMI?'sc-origin-icon-market':isDoc?'sc-origin-icon-doc':f.origin==='pi'?'sc-origin-icon-pi':'sc-origin-icon-kpi';
      h+=`<div class="sc-card-name-row"><span class="sc-origin-icon ${_scOriginClass}" title="${_scOriginTitle}" style="width:14px;height:14px;flex-shrink:0;border-radius:3px;"><i class="ti ${_scOriginIcon}" style="font-size:9px;" aria-hidden="true"></i></span><div class="sc-card-name">${e(f.name)}</div></div>`;
      h+=`<div class="sc-card-why">${e(f.why)}</div>`;
      h+=`<div class="sc-card-footer">`;
      if(hasDone){
        const storyLbl=f.stories.length+' stor'+(f.stories.length===1?'y':'ies');
        const inScCount=f.stories.filter(s=>s._inSC).length;
        h+=`<div class="sc-status-done"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span class="sc-story-badge">${storyLbl}</span></div>`;
        if(inScCount>0)h+=`<div class="sc-feat-insc-tag"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> ${inScCount} in Story Canvas</div>`;
      } else if(isSel){
        h+=`<div class="sc-status-none"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="6" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> No stories yet</div>`;

      } else {
        h+=`<div class="sc-status-none"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="6" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> No stories yet</div>`;
      }
      h+=scBuildOutcomeHypChipHTML(f);
      h+=`</div></div>`;
    });
    if(!_fcIsCollapsed){h+=`</div>`;}
    }
    h+=`</div>`;
  });
  document.getElementById('sc-cards-container').innerHTML=h;
  scUpdateActionBar(visibleCanvas);
  scUpdateDoneBadge();
  requestAnimationFrame(function(){requestAnimationFrame(scFitBreadcrumbs);});
}

function scUpdateDoneBadge(){
  const done=scCanvas.filter(f=>f.stories&&f.stories.length>0).length;
  const badge=document.getElementById('sc-done-badge');
  const countEl=document.getElementById('sc-done-count');
  badge.style.display=done>0?'flex':'none';
  countEl.textContent=done;
  document.getElementById('sc-feat-count-badge').textContent=scCanvas.length+' feature'+(scCanvas.length!==1?'s':'');
}

// ── FC: Compute how many stories are queued for SC send ──
// Rules: for each selected feature:
//   - if it has _stagedForPI stories → count only those (panel partial selection)
//   - else if it has stories → count all (card-level = send all)
//   - else → 0 (no stories, don't count)
function fcGetSCQueueCount(){
  let n=0;
  scSelectedIds.forEach(fid=>{
    const feat=scCanvas.find(x=>x.id===fid);
    if(!feat||!feat.stories||feat.stories.length===0)return;
    const piSel=feat.stories.filter(s=>s._stagedForPI).length;
    n+=piSel>0?piSel:feat.stories.length;
  });
  return n;
}

function scUpdateActionBar(visibleCanvas){
  const bar=document.getElementById('sc-action-bar');
  // v9.08.02: matches ccUpdateActionBar/newScUpdateActionBar — this bar
  // exists only to select+generate stories, nothing a view-only session
  // can do.
  const _canEditFcBar=(typeof canEditSession!=='function')||canEditSession();
  if(bar)bar.style.display=_canEditFcBar?'':'none';
  // Add Feature/Export now live inside the toolbar's single kebab
  // (#sc-tb-kebab-wrap, scTbKebabTopHtml()) - that menu is rebuilt fresh
  // every time it's opened, so edit-permission and disabled state are
  // resolved there rather than synced onto standalone elements here.
  // Refine bar + Send to Story Canvas — also static elements in index.html,
  // outside sc-action-bar's own scope, synced here for the same reason.
  const refineBar=document.getElementById('sc-refine-bar');
  if(refineBar)refineBar.style.display=_canEditFcBar?'':'none';
  const sendToScWrap=document.getElementById('fc-panel-sc-btn');
  if(sendToScWrap)sendToScWrap.closest('.sc-panel-split-cta-wrap').style.display=_canEditFcBar?'':'none';

  if(!visibleCanvas)visibleCanvas=scCanvas;
  const total=visibleCanvas.length;

  // v9.08.03 fix (superseded by v9.20's kebab consolidation, kept for the
  // rationale): Export must reflect "is there anything to export," never
  // edit permission - scTbKebabTopHtml() re-evaluates that (scCanvas.length)
  // every time the kebab opens, so no live sync onto a standalone button
  // is needed here.

  if(!_canEditFcBar)return;
  const visibleIds=new Set(visibleCanvas.map(f=>f.id));
  const sel=Array.from(scSelectedIds).filter(id=>visibleIds.has(id)).length;
  const done=scCanvas.filter(f=>f.stories&&f.stories.length>0).length;
  const doneVisible=visibleCanvas.filter(f=>f.stories&&f.stories.length>0).length;
  const totalStories=scCanvas.reduce((a,f)=>a+(f.stories?f.stories.length:0),0);

  // Select All toggle state
  const chk=document.getElementById('sc-select-all-chk');
  const lbl=document.getElementById('sc-select-all-lbl');
  if(chk){
    chk.checked=total>0&&sel===total;
    chk.indeterminate=sel>0&&sel<total;
  }
  if(lbl)lbl.textContent=sel===total&&total>0?'Deselect all':'Select all';

  // Info count
  const infoEl=document.getElementById('sc-action-info');
  if(infoEl){
    const _fcThresholdActive=sel>=4&&(typeof resolveThresholdModel==='function')&&resolveThresholdModel(sel)!==null;
    if(sel>0)infoEl.innerHTML=`<strong>${sel}</strong> of ${total} selected${_fcThresholdActive?' <span style="color:var(--blue);">· 4+ items use a faster, lower-quality AI model</span>':''}`;
    else infoEl.innerHTML=doneVisible>0?`<strong>${doneVisible}</strong> feature${doneVisible!==1?'s':''} with stories`:'';
  }

  // Generate button
  const genBtn=document.getElementById('sc-gen-btn');
  if(genBtn){genBtn.disabled=sel===0;}
  const genLbl=document.getElementById('sc-gen-btn-label');
  if(genLbl)genLbl.textContent=sel>1?'Generate for '+sel+' Features':sel===1?'Generate Stories':'Generate Stories';
}

function scSetGroup(mode){
  scGroupMode=mode;
  document.getElementById('sc-grp-metric').classList.toggle('active',mode==='metric');
  document.getElementById('sc-grp-cap').classList.toggle('active',mode==='cap');
  fcRenderCanvas();
}

function scToggleSelect(fid){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  if(scSelectedIds.has(fid))scSelectedIds.delete(fid);
  else scSelectedIds.add(fid);
  // Refresh panel tag if this feature is currently open
  if(scPanelFeatureId===fid){
    const tagEl=document.querySelector('.sc-panel-tag');
    if(tagEl){
      const isSel=scSelectedIds.has(fid);
      tagEl.innerHTML=isSel
        ?'User Stories &nbsp;<span style="font-size:8px;background:var(--purple-pale);color:var(--purple);border:1px solid var(--purple-light);border-radius:10px;padding:1px 6px;font-weight:700;letter-spacing:0;">Selected for gen</span>'
        :'User Stories';
    }
  }
  fcRenderCanvas();
}

function scClearSelection(){
  scSelectedIds.clear();
  fcRenderCanvas();
}

function scSelectAll(){
  fcGetVisibleCanvas().forEach(f=>scSelectedIds.add(f.id));
  fcRenderCanvas();
}

function scToggleSelectAll(chk){
  if(chk.checked){scSelectAll();}
  else{scClearSelection();}
}

// ── FC Filter ──
function fcToggleFilterDrop(evt){
  if(evt)evt.stopPropagation();
  const drop=document.getElementById('fc-filter-drop');
  if(!drop)return;
  const isOpen=drop.classList.contains('open');
  
  if(isOpen){
    drop.classList.remove('open');
    document.removeEventListener('mousedown',fcFilterDropOutside);
  } else {
    drop.classList.add('open');
    _fcRenderOriginRaFilterSlot();
    setTimeout(()=>document.addEventListener('mousedown',fcFilterDropOutside),0);
  }
}
function fcFilterDropOutside(e){
  const drop=document.getElementById('fc-filter-drop');
  if(!drop){document.removeEventListener('mousedown',fcFilterDropOutside);return;}
  if(!drop.contains(e.target)){
    drop.classList.remove('open');
    document.removeEventListener('mousedown',fcFilterDropOutside);
  }
}
// §9.1 — "Requirement Agent" nested Origin value + per-RQ sub-list. Same
// tri-state parent/child model as Capability Canvas's §8.2 implementation
// (ccToggleOriginRaParent()/ccToggleOriginRaChild() in capability-canvas.js)
// — kept as its own copy here rather than shared code since FC's filter
// markup is static HTML (index.html's #fc-filter-drop) with a JS-populated
// slot, not a fully JS-generated popover like CC's.
let fcOriginRaExpanded=false;
function _fcFinalizedRaConvs(){
  return (typeof raConversations!=='undefined'?raConversations:[]).filter(function(c){return c.status==='finalized';});
}
function _fcRenderOriginRaFilterSlot(){
  const slot=document.getElementById('fc-filter-origin-ra-slot');
  if(!slot)return;
  const convs=_fcFinalizedRaConvs();
  if(!convs.length){slot.innerHTML='';return;}
  const checkedRqTokens=convs.filter(function(c){return fcOriginFilter.has('origin-ra-rq:'+c.id);});
  const parentChecked=fcOriginFilter.has('origin-ra');
  // QA issue #5 — always show the RQ sub-list, even with only one finalized
  // RQ, matching Capability Canvas's identical fix (_ccOriginRaFilterHtml()).
  const showSubList=fcOriginRaExpanded||parentChecked||checkedRqTokens.length>0;
  const subListHtml=`<div id="fc-origin-ra-sublist" style="display:${showSubList?'block':'none'};padding-left:20px;border-left:1px dashed var(--divider);margin-left:20px;">`
    +convs.map(function(c){
      const cnt=(typeof scCanvas!=='undefined'?scCanvas.filter(f=>f.intakeBriefId===c.id).length:0);
      const isChecked=fcOriginFilter.has('origin-ra-rq:'+c.id);
      return `<label class="fc-filter-row" style="font-size:11px;" onclick="event.stopPropagation();"><input type="checkbox" ${isChecked?'checked':''} onchange="fcToggleOriginRaChild('${e(c.id)}')"> ${e(c.rqNumber||'')} &mdash; ${e(c.title||'Untitled')} <span style="margin-left:auto;font-size:9px;color:var(--t3);">${cnt}</span></label>`;
    }).join('')
    +`</div>`;
  slot.innerHTML=`<label class="fc-filter-row" id="fc-origin-ra-row" onclick="event.stopPropagation();fcToggleOriginRaExpand()"><input type="checkbox" id="fc-origin-ra-chk" ${parentChecked?'checked':''} onclick="event.stopPropagation();fcToggleOriginRaParent()"> <i class="ti ti-message-2" style="font-size:11px;color:var(--purple);" aria-hidden="true"></i> Requirement Agent <i class="ti ti-chevron-${showSubList?'down':'right'}" style="font-size:9px;margin-left:auto;" aria-hidden="true"></i></label>`
    +subListHtml;
  const chk=document.getElementById('fc-origin-ra-chk');
  if(chk)chk.indeterminate=checkedRqTokens.length>0&&checkedRqTokens.length<convs.length;
}
function fcToggleOriginRaParent(){
  const convs=_fcFinalizedRaConvs();
  if(fcOriginFilter.has('origin-ra')){
    fcOriginFilter.delete('origin-ra');
    convs.forEach(function(c){fcOriginFilter.delete('origin-ra-rq:'+c.id);});
  } else {
    fcOriginFilter.add('origin-ra');
    convs.forEach(function(c){fcOriginFilter.add('origin-ra-rq:'+c.id);});
    fcOriginRaExpanded=true;
  }
  fcRenderCanvas();
  _fcRenderOriginRaFilterSlot();
}
function fcToggleOriginRaChild(convId){
  const tok='origin-ra-rq:'+convId;
  if(fcOriginFilter.has(tok))fcOriginFilter.delete(tok);else fcOriginFilter.add(tok);
  const convs=_fcFinalizedRaConvs();
  const checkedCount=convs.filter(function(c){return fcOriginFilter.has('origin-ra-rq:'+c.id);}).length;
  if(checkedCount>0&&checkedCount===convs.length)fcOriginFilter.add('origin-ra');
  else fcOriginFilter.delete('origin-ra');
  fcRenderCanvas();
  _fcRenderOriginRaFilterSlot();
}
function fcToggleOriginRaExpand(){
  fcOriginRaExpanded=!fcOriginRaExpanded;
  _fcRenderOriginRaFilterSlot();
}
function fcSetOriginFilter(val){
  if(fcOriginFilter.has(val)){fcOriginFilter.delete(val);}
  else{fcOriginFilter.add(val);}
  const isActive=fcOriginFilter.size>0||fcStoriesFilter.size>0;
  const btn=document.getElementById('fc-filter-btn');
  if(btn)btn.classList.toggle('active',isActive);
  const badge=document.getElementById('sc-filter-badge');
  const label=document.getElementById('sc-filter-label');
  if(badge&&label){
    const total=fcOriginFilter.size+fcStoriesFilter.size;
    badge.style.display=total>0?'inline-flex':'none';
    label.textContent=total+' filter'+(total!==1?'s':'');
  }
  fcRenderCanvas();
  // Update panel nav counter if a panel is open
  if(scPanelFeatureId)scUpdatePanelNav();
}

function fcSetStoriesFilter(val){
  if(fcStoriesFilter.has(val)){fcStoriesFilter.delete(val);}
  else{fcStoriesFilter.add(val);}
  scSelectedIds.clear(); // selection is filter-scoped — same fix as scSetCapFilter
  const isActive=fcStoriesFilter.size>0&&fcStoriesFilter.size<2;
  const btn=document.getElementById('fc-filter-btn');
  if(btn)btn.classList.toggle('active',isActive);
  const badge=document.getElementById('sc-filter-badge');
  const label=document.getElementById('sc-filter-label');
  if(badge&&label){
    if(isActive){
      label.textContent='1 filter';
      badge.style.display='inline-flex';
    } else {
      badge.style.display='none';
    }
  }
  fcRenderCanvas();
  // Update panel nav counter if a panel is open — must fire after fcRenderCanvas
  // so fcGetVisibleCanvas() reflects the new filter state
  if(scPanelFeatureId)scUpdatePanelNav();
}
function fcClearFilter(){
  fcStoriesFilter=new Set();
  fcOriginFilter=new Set();
  ['fc-filter-origin-kpi','fc-filter-origin-doc','fc-filter-origin-custom','fc-filter-origin-mi','fc-filter-origin-diag'].forEach(function(id){
    const el=document.getElementById(id);
    if(el)el.checked=false;
  });
  fcOriginRaExpanded=false;
  _fcRenderOriginRaFilterSlot();
  scSelectedIds.clear(); // selection is filter-scoped — same fix as scSetCapFilter/fcSetStoriesFilter
  const btn=document.getElementById('fc-filter-btn');
  if(btn)btn.classList.remove('active');
  const badge=document.getElementById('sc-filter-badge');
  if(badge)badge.style.display='none';
  ['fc-filter-generated','fc-filter-not-generated'].forEach(id=>{
    const el=document.getElementById(id);if(el)el.checked=false;
  });
  fcRenderCanvas();
  // Update panel nav counter if a panel is open
  if(scPanelFeatureId)scUpdatePanelNav();
}







function scRemoveFeature(fid){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat)return;
  const storyCount=feat.stories&&feat.stories.length>0?feat.stories.length:0;
  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.id='sc-del-feat-overlay';
  const warningStrip=storyCount>0
    ?`<div style="display:flex;align-items:flex-start;gap:8px;background:var(--amber-bg,#FAEEDA);border:0.5px solid var(--amber,#BA7517);border-radius:6px;padding:8px 10px;margin-bottom:16px;">
        <i class="ti ti-alert-triangle" style="font-size:14px;color:var(--amber,#BA7517);margin-top:1px;flex-shrink:0;" aria-hidden="true"></i>
        <div style="font-size:11px;color:var(--amber-dark,#633806);line-height:1.5;">This will also delete <strong>${storyCount} associated stor${storyCount!==1?'ies':'y'}</strong>. This cannot be undone.</div>
      </div>`
    :`<div style="font-size:12px;color:var(--t3);line-height:1.6;margin-bottom:16px;">This cannot be undone.</div>`;
  overlay.innerHTML=`<div class="modal" style="max-width:380px;;position:relative;">
    <button onclick="document.getElementById('sc-del-feat-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:16px 44px 14px 16px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:500;color:var(--t1);">Delete "${e(feat.name)}"?</div>
    </div>
    <div style="padding:14px 20px 4px;">
      ${warningStrip}
    </div>
    <div class="modal-footer">
      <button class="modal-cancel-btn" onclick="document.getElementById('sc-del-feat-overlay').remove()">Cancel</button>
      <button class="modal-confirm-btn danger" onclick="document.getElementById('sc-del-feat-overlay').remove();scDoRemoveFeature('${e(fid)}')"><i class="ti ti-trash" style="font-size:12px;" aria-hidden="true"></i> Delete</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const _esc=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_esc,true);}};
  document.addEventListener('keydown',_esc,true);
  trapFocus(overlay);
}

function scDoRemoveFeature(fid){
  const idx=scCanvas.findIndex(x=>x.id===fid);
  if(idx<0)return;
  if(typeof pcDeleteProto==='function')pcDeleteProto(fid);
  scCanvas.splice(idx,1);
  // v9.11: laSentIds (product-leak-analysis.js) is a cache derived from
  // scCanvas, previously only ever rebuilt on session load or a live-sync
  // event — never on a plain feature deletion. Without this, deleting a
  // diagnostic/experiment-origin card left Experiment Canvas's own "Sent"
  // indicator stuck showing sent for an experiment no longer actually on
  // the canvas. Rebuilding here closes that gap at its actual source.
  if(typeof laRebuildSentIdsFromCanvas==='function')laRebuildSentIdsFromCanvas();
  scSelectedIds.delete(fid);
  scPiSelectedIds.delete(fid);
  if(scPanelFeatureId===fid)scClosePanel();
  fcUpdateTabBadge();
  scUpdateCapDrawerFooter();
  fcRenderCanvas();
  const chk=document.getElementById('fi-'+fid);
  if(chk){
    const checkEl=chk.querySelector('.feat-item-check');
    if(checkEl){checkEl.classList.remove('checked');chk.classList.remove('on-canvas');}
  }
  // v8.147 fix: confirmed missing entirely.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('sc',fid+_LS_SC_TARGET_SEP); });
  }
}

// ── Story Panel ──
function scOpenPanel(fid){
  if(blockIfGenerating(()=>scOpenPanel(fid)))return;
  // Toggle-close: clicking the already-open feature closes the panel
  if(scPanelFeatureId===fid){scClosePanel();return;}
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat)return;
  // v9.25 — #sc-refine-txt is STATIC HTML (index.html), never destroyed or
  // rebuilt by any render function here — a different failure mode from
  // every other surface's textarea. Switching to a different feature's
  // panel reassigns scPanelFeatureId while the SAME physical textarea node
  // persists untouched: without this guard, dictation started for the
  // previous feature would keep running and could get submitted against
  // the NEWLY active feature via scRefineStories() (which reads
  // scPanelFeatureId at click time, not at typing time) — silent
  // misattribution, not just silent loss.
  voiceStopActive('abort');
  scPanelFeatureId=fid;
  document.getElementById('sc-panel-feat-name').textContent=feat.name;
  // Show selection indicator in panel tag
  const tagEl=document.querySelector('.sc-panel-tag');
  if(tagEl){
    const isSel=scSelectedIds.has(fid);
    tagEl.innerHTML=isSel
      ?'User Stories &nbsp;<span style="font-size:8px;background:var(--purple-pale);color:var(--purple);border:1px solid var(--purple-light);border-radius:10px;padding:1px 6px;font-weight:700;letter-spacing:0;">Selected for gen</span>'
      :'User Stories';
  }
  scLineageTargetElId='sc-panel-feat-meta';
  scRenderLineage(feat);
  document.getElementById('sc-main').classList.add('panel-open');
  document.getElementById('sc-panel').classList.add('open');
  scRenderPanel(feat);
  scUpdatePanelNav();
  _scRenderVoiceSlot();
  fcRenderCanvas(); // update active card ring
}

// v9.25 — populates the static #sc-refine-voice-slot (index.html) with the
// mic button. Since #sc-refine-txt's row is static HTML, not JS-template-
// generated, there's no natural render pass to embed voiceButtonHtml()
// into the way other surfaces do — this runs once per panel-open instead,
// matching every other surface's own render-time gate check.
function _scRenderVoiceSlot(){
  const slot=document.getElementById('sc-refine-voice-slot');
  if(slot&&typeof voiceButtonHtml==='function')slot.innerHTML=voiceButtonHtml({textareaId:'sc-refine-txt',buttonId:'sc-refine-voice-btn',statusId:'sc-refine-voice-status'});
}

function scRenderLineage(feat,targetElId){
  const el=document.getElementById(targetElId||scLineageTargetElId||'sc-panel-feat-meta');
  if(!el)return;
  const fid=feat.id;
  const origin=feat.origin||'kpi';
  const isDiag=origin==='diagnostic';
  const isMI=origin==='market';
  const isPI=origin==='pi';
  const hasMetric=!!(feat.metric&&feat.metric.trim());
  // v9.06.01: removed the 'PI Plan' exclusion — the synthetic stage now has
  // a real, meaningful, user-editable name ('Custom Value Stage' by
  // default), so it's worth showing in traceability like any other stage.
  // Sequenced deliberately AFTER Issue #2's dynamic-label-resolution and
  // migration fixes, so this never surfaces the raw internal literal.
  const hasStage=!!(feat.stage&&feat.stage.trim());
  const _isCap=typeof gData!=='undefined'&&gData&&gData.approach==='capability-based';
  const _metricLbl=_isCap?'Process Area':'Metric';
  const _capDefaultLbl='Capability';

  // Build breadcrumb preview for collapsed state
  // v9.06.01: defensive relabel for the stage segment specifically (see
  // note above) — metric/cap segments never had this literal, untouched.
  const _dispFeatStageForPreview=feat.stage==='PI Plan'?'Custom Value Stage':feat.stage;
  const segs=[_dispFeatStageForPreview,feat.metric,feat.cap].filter(s=>s&&s.trim());
  const preview=segs.join(' › ')||feat.cap||'—';

  // Dot helper
  function dot(colorHex,sq,dashed){
    const br=sq?'border-radius:2px':'border-radius:50%';
    if(dashed)return`<span class="sc-panel-lineage-dot dashed"></span>`;
    return`<span class="sc-panel-lineage-dot ${sq?'sq':''}" style="background:${colorHex};${sq?'border-radius:2px':''}"></span>`;
  }

  // Collapsed state
  if(!scPanelLineageOpen){
    el.innerHTML=`<div class="sc-panel-lineage-hdr" onclick="scToggleLineage('${e(fid)}')">
      <i class="ti ti-git-branch" style="font-size:11px;color:#534AB7;flex-shrink:0;" aria-hidden="true"></i>
      <span class="sc-panel-lineage-label">Traceability</span>
      <span class="sc-panel-lineage-sep">|</span>
      <span class="sc-panel-lineage-preview">${e(preview)}</span>
      <i class="ti ti-chevron-down" style="font-size:11px;color:var(--t3);flex-shrink:0;" aria-hidden="true"></i>
    </div>`;
    return;
  }

  // Expanded state — build rows
  let rows='';

  // Stage row
  if(!hasStage){
    rows+=`<div class="sc-panel-lineage-row unlinked">
      <span class="sc-panel-lineage-key" style="color:var(--t3);">Stage</span>
      ${dot('','',true)}
      <span class="sc-panel-lineage-val" style="font-style:italic;color:var(--t3);">Not linked</span>
    </div>`;
  } else {
    // v9.06.01: defensive relabel — harmless no-op once migration has run
    // (feat.stage will already say 'Custom Value Stage' directly); only
    // matters for any edge case where the raw legacy literal still appears.
    const _dispFeatStage=feat.stage==='PI Plan'?'Custom Value Stage':feat.stage;
    rows+=`<div class="sc-panel-lineage-row">
      <span class="sc-panel-lineage-key" style="color:#0F6E56;">Stage</span>
      ${dot('#0F6E56',false,false)}
      <span class="sc-panel-lineage-val" style="color:#085041;">${e(_dispFeatStage)}</span>
    </div>`;
  }

  // Metric row
  if(!hasMetric&&!scPanelLinkingMetric){
    rows+=`<div class="sc-panel-lineage-row unlinked">
      <span class="sc-panel-lineage-key" style="color:var(--t3);">${_metricLbl}</span>
      ${dot('','',true)}
      <span class="sc-panel-lineage-val"><span style="font-style:italic;color:var(--t3);">No ${_metricLbl.toLowerCase()} linked.</span>&nbsp;<a class="sc-panel-lineage-link" onclick="scShowLinkMetricModal('${e(fid)}')">Link one?</a></span>
    </div>`;
  } else if(!hasMetric&&scPanelLinkingMetric){
    // Inline picker — Stage row shows resolving hint
    rows='';
    rows+=`<div class="sc-panel-lineage-row unlinked">
      <span class="sc-panel-lineage-key" style="color:var(--t3);">Stage</span>
      ${dot('','',true)}
      <span class="sc-panel-lineage-val" style="font-style:italic;color:var(--t3);">Resolves on selection</span>
    </div>`;
    // Build metric dropdown from gData L1 metrics only
    let opts=`<option value="">Select a ${_metricLbl.toLowerCase()}…</option>`;
    if(typeof gData!=='undefined'&&gData&&gData.stages){
      gData.stages.forEach(st=>{
        if(!st.l1_metrics||!st.l1_metrics.length)return;
        opts+=`<optgroup label="${e(st.label)}">`;
        st.l1_metrics.forEach(m=>{
          opts+=`<option value="${e(m.name)}">${e(m.name)}</option>`;
        });
        opts+=`</optgroup>`;
      });
    }
    rows+=`<div class="sc-panel-lineage-row" style="flex-direction:column;align-items:flex-start;padding:6px 0 8px;">
      <div style="display:flex;align-items:center;gap:5px;margin-bottom:5px;">
        ${dot('#185FA5',false,false)}
        <span class="sc-panel-lineage-key" style="color:#185FA5;width:auto;">${_metricLbl}</span>
        <span style="font-size:9px;color:var(--t3);">— pick one from your Discovery Map</span>
      </div>
      <div class="sc-panel-lineage-picker">
        <select id="sc-lineage-metric-sel" onchange="document.getElementById('sc-lineage-confirm').disabled=!this.value;">
          ${opts}
        </select>
        <div class="sc-panel-lineage-picker-btns">
          <button onclick="scCancelLinkMetric('${e(fid)}')" style="border:1px solid var(--divider);background:none;color:var(--t2);">Cancel</button>
          <button id="sc-lineage-confirm" onclick="scConfirmLinkMetric('${e(fid)}')" disabled style="border:none;background:var(--purple);color:#fff;font-weight:600;">Confirm</button>
        </div>
      </div>
    </div>`;
    // Cap and Feature rows still show
    const capLabel=isDiag?'Diagnostic finding':isMI?'Market signal':_capDefaultLbl;
    const capColor=isDiag?'#0F6E56':isMI?'#185FA5':'#534AB7';
    const capTextColor=isDiag?'#085041':isMI?'#0C447C':'#3C3489';
    rows+=`<div class="sc-panel-lineage-row">
      <span class="sc-panel-lineage-key" style="color:${capColor};">${e(capLabel)}</span>
      ${dot(capColor,false,false)}
      <span class="sc-panel-lineage-val" style="color:${capTextColor};">${e(feat.cap)}</span>
    </div>`;
    const featColor=isPI&&!hasMetric?'#854F0B':'#534AB7';
    const featTextColor=isPI&&!hasMetric?'#633806':'#3C3489';
    rows+=`<div class="sc-panel-lineage-row" style="border-bottom:none;">
      <span class="sc-panel-lineage-key" style="color:${featColor};">Feature</span>
      ${dot(featColor,true,false)}
      <span class="sc-panel-lineage-val" style="color:${featTextColor};">${e(feat.name)}</span>
    </div>`;
    el.innerHTML=`<div class="sc-panel-lineage-hdr" onclick="scToggleLineage('${e(fid)}')">
      <i class="ti ti-git-branch" style="font-size:11px;color:#534AB7;flex-shrink:0;" aria-hidden="true"></i>
      <span class="sc-panel-lineage-label">Traceability</span>
      <i class="ti ti-chevron-up" style="font-size:11px;color:var(--t3);flex-shrink:0;margin-left:auto;" aria-hidden="true"></i>
    </div>
    <div class="sc-panel-lineage-body">${rows}</div>`;
    return;
  } else {
    // Has metric
    const hierIcon=feat.metricPath&&feat.metricPath.includes(' › ')
      ?`<i class="ti ti-hierarchy-2 sc-panel-lineage-icon" title="${e(feat.metricPath)}" aria-label="${_isCap?'Process area path':'Parent metric path'}: ${e(feat.metricPath)}"></i>`:'';
    rows+=`<div class="sc-panel-lineage-row">
      <span class="sc-panel-lineage-key" style="color:#185FA5;">${_metricLbl}</span>
      ${dot('#185FA5',false,false)}
      <span class="sc-panel-lineage-val" style="color:#0C447C;">${e(feat.metric)}${hierIcon}</span>
    </div>`;
  }

  // Capability row
  const capLabel=isDiag?'Diagnostic finding':isMI?'Market signal':_capDefaultLbl;
  const capColor=isDiag?'#0F6E56':isMI?'#185FA5':'#534AB7';
  const capTextColor=isDiag?'#085041':isMI?'#0C447C':'#3C3489';
  rows+=`<div class="sc-panel-lineage-row">
    <span class="sc-panel-lineage-key" style="color:${capColor};">${e(capLabel)}</span>
    ${dot(capColor,false,false)}
    <span class="sc-panel-lineage-val" style="color:${capTextColor};">${e(feat.cap)}</span>
  </div>`;

  // Feature row
  const featColor=isPI&&!hasMetric?'#854F0B':'#534AB7';
  const featTextColor=isPI&&!hasMetric?'#633806':'#3C3489';
  rows+=`<div class="sc-panel-lineage-row" style="border-bottom:none;">
    <span class="sc-panel-lineage-key" style="color:${featColor};">Feature</span>
    ${dot(featColor,true,false)}
    <span class="sc-panel-lineage-val" style="color:${featTextColor};">${e(feat.name)}</span>
  </div>`;

  el.innerHTML=`<div class="sc-panel-lineage-hdr" onclick="scToggleLineage('${e(fid)}')">
    <i class="ti ti-git-branch" style="font-size:11px;color:#534AB7;flex-shrink:0;" aria-hidden="true"></i>
    <span class="sc-panel-lineage-label">Traceability</span>
    <i class="ti ti-chevron-up" style="font-size:11px;color:var(--t3);flex-shrink:0;margin-left:auto;" aria-hidden="true"></i>
  </div>
  <div class="sc-panel-lineage-body">${rows}</div>`;
}

// `||''` would treat a legitimate numeric 0 threshold (e.g. "guardrail
// breaches = 0") as missing. Only an actually-missing value falls back.
function _scNameOrThreshold(v){return v==null?'':String(v);}

// Rubric category classification (ai_feature eval scenarios / agentic
// acceptance-envelope rubrics) — the stored value is a lowercase slug
// matching agent-test-kit's own test-cases.json category convention
// verbatim (test-suite/agents/*/config/test-cases.json), not a Title-Case
// display string, so this data is a genuine zero-translation head start
// for whenever that feature is later onboarded into real automated
// testing. _scCategoryLabel() below renders the PM-friendly form. An
// unrecognized or missing value falls back to 'general' — it never drops
// the scenario/rubric entry itself (the exact bug class the storyType
// normalization fix above exists to prevent).
const _scRubricCategoryAliases={
  groundedness:'groundedness',
  hallucination:'hallucination',hallucinations:'hallucination',
  accuracy:'accuracy',
  adversarial:'adversarial','adversarial robustness':'adversarial',
  'out of context':'out_of_context',outofcontext:'out_of_context','out of scope':'out_of_context',
  consistency:'consistency','consistency determinism':'consistency',determinism:'consistency',
  format:'format','instruction following':'format','instruction following format':'format','format compliance':'format',
  bias:'bias','bias fairness':'bias',fairness:'bias',
  safety:'safety','safety harmful content':'safety','harmful content':'safety',
  robustness:'robustness','noisy input':'robustness','robustness to noisy input':'robustness',
  privacy:'privacy',pii:'privacy','privacy pii':'privacy',
  completeness:'completeness',coverage:'completeness','completeness coverage':'completeness',
  tone:'tone',calibration:'tone','tone calibration':'tone',
  general:'general'
};
function _scNormalizeRubricCategory(raw){
  // Collapse separators BEFORE trimming — otherwise a leading/trailing
  // separator (e.g. "-Groundedness") collapses to a leading/trailing space
  // that survives trim-first and fails the exact-match lookup below.
  const key=String(raw||'').toLowerCase().replace(/[\s_\-\/]+/g,' ').trim();
  // hasOwnProperty guard, not a bare `[key]||...` lookup — this is a plain
  // object used as a map, so an input that normalizes to a key already on
  // Object.prototype (e.g. "constructor") would otherwise resolve through
  // the prototype chain to a function value instead of falling back.
  return Object.prototype.hasOwnProperty.call(_scRubricCategoryAliases,key)?_scRubricCategoryAliases[key]:'general';
}
const _scCategoryLabels={groundedness:'Groundedness',hallucination:'Hallucination',accuracy:'Accuracy',adversarial:'Adversarial',out_of_context:'Out-of-context',consistency:'Consistency',format:'Format',bias:'Bias',safety:'Safety',robustness:'Robustness',privacy:'Privacy',completeness:'Completeness',tone:'Tone',general:'General'};
function _scCategoryLabel(category){return _scCategoryLabels[category]||category||'';}

// Scoring recommendation normalization — whitelists against agent-test-kit's
// own literal evaluatorType/scale vocabulary (test-suite/agents/*/config/
// rubrics.js) so this data could feed a future export into a real
// rubrics.js with no translation step. Falls back to the safer generic
// defaults (llm_judge / scale keyed off the resolved evaluator) rather than
// dropping anything — same defensive posture as every other normalizer here.
const _scEvaluatorTypes=['script_diff','llm_judge','toxicity_scan'];
const _scScales=['binary','0-1'];
function _scNormalizeScoring(raw){
  const o=raw||{};
  const etRaw=String(o.evaluator_type||o.evaluatorType||'').toLowerCase().trim().replace(/[\s\-]+/g,'_');
  const evaluatorType=_scEvaluatorTypes.includes(etRaw)?etRaw:'llm_judge';
  // Collapse whitespace around a hyphen (e.g. hand-typed "0 - 1") so it
  // still matches the literal "0-1" scale value — scaleRaw's own hyphen
  // (inside "0-1" itself) is never touched by this, only surrounding
  // whitespace is removed.
  const scaleRaw=String(o.scale||'').toLowerCase().trim().replace(/\s*-\s*/g,'-');
  const scale=_scScales.includes(scaleRaw)?scaleRaw:(evaluatorType==='script_diff'?'binary':'0-1');
  return{evaluatorType,scale,threshold:_scNameOrThreshold(o.threshold),rationale:_scNameOrThreshold(o.rationale)};
}

// Shared pill renderer — one template for every small colored label pill in
// this file, so scStoryTypeBadge()/scRubricCategoryBadge() can't drift out
// of sync with each other on padding/sizing/radius the way two independent
// hand-written templates eventually do.
function _scPill(label,opts){
  opts=opts||{};
  const size=opts.size||7.5;
  const border=opts.border?`border:1px solid ${opts.border};`:'';
  return `<span style="font-weight:700;font-size:${size}px;background:${opts.bg};color:${opts.fg};${border}border-radius:3px;padding:1px 5px;${opts.extraStyle||''}">${label}</span>`;
}

// Rubric category pill — neutral-colored so it never competes with the
// story-type pill. font-family is set explicitly since .sc-ac-scenario
// (styles/08-feature-canvas.css) forces monospace on its ancestor and this
// must not inherit it.
function scRubricCategoryBadge(category){
  if(!category)return'';
  return _scPill(e(_scCategoryLabel(category)),{bg:'var(--card)',fg:'var(--t3)',border:'var(--divider)',extraStyle:'font-family:var(--font);'});
}

// Scoring-recommendation line — stores the machine evaluatorType value,
// translates to a PM-friendly label only here at render time (same
// store-machine/render-friendly pattern scStoryTypeBadge() uses below).
const _scScoringMethodLabels={script_diff:'Deterministic check',llm_judge:'AI judge review',toxicity_scan:'Safety/content scan'};
function _scScoringLine(scoring){
  if(!scoring)return'';
  const methodLabel=_scScoringMethodLabels[scoring.evaluatorType]||scoring.evaluatorType||'';
  const summary=[methodLabel,scoring.scale,scoring.threshold?('threshold '+scoring.threshold):''].filter(Boolean).join(' · ');
  if(!summary)return'';
  return `<div style="font-size:9.5px;color:var(--t3);font-family:var(--font);margin-top:2px;">Suggested scoring: ${e(summary)}${scoring.rationale?' — '+e(scoring.rationale):''}</div>`;
}

// Shared story-type badge pill — single source for the AI FEATURE/AGENTIC
// label+color mapping so Feature Canvas, Story Canvas's card footer, and
// its edit-modal title tag can't drift out of sync with each other.
function scStoryTypeBadge(storyType,opts){
  if(storyType!=='ai_feature'&&storyType!=='agentic')return'';
  opts=opts||{};
  const isAgentic=storyType==='agentic';
  const label=isAgentic?'AGENTIC':'AI FEATURE';
  return _scPill(label,{bg:isAgentic?'var(--purple-pale)':'var(--blue-pale)',fg:isAgentic?'var(--purple)':'var(--blue)',size:opts.size,extraStyle:opts.extraStyle});
}

// Three-tier story classification (traditional / ai_feature / agentic) —
// shared across Story Canvas and Release Canvas detail panels, same
// cross-file-helper pattern as scRenderLineage() above. Returns an array
// of {label, html} fragments rather than one finished block so each caller
// keeps its own existing label/container chrome (the two screens already
// style "Story Statement" etc. differently) instead of all converging on
// one hardcoded look.
function scGetStorySections(st){
  const t=st.storyType||'traditional';
  const bullets=(arr)=>!arr||!arr.length?'<div style="font-size:10px;color:var(--label);font-style:italic;">None specified.</div>'
    :'<ul style="margin:0;padding-left:16px;font-size:11px;color:var(--t2);line-height:1.6;">'+arr.map(x=>`<li>${e(x)}</li>`).join('')+'</ul>';
  // Shared scenario+rubric row renderer — used both for ai_feature's
  // standalone Eval Scenarios section and for rubrics nested inside an
  // Acceptance Envelope (agentic) alongside its aggregate metrics.
  // category/scoring are independently optional — a legacy entry (pre-
  // categorization) has neither and must render with no badge/line at all,
  // not a 'General' badge (that's only ever applied at normalization time).
  const rubricRows=(arr)=>(arr&&arr.length)?arr.map(s=>{
    const _meta=(s.category?`<div style="margin-top:4px;">${scRubricCategoryBadge(s.category)}</div>`:'')+_scScoringLine(s.scoring);
    return `<div class="sc-ac-scenario"><div style="flex:1;white-space:pre-wrap;font-size:11px;color:var(--t2);">${e(s.scenario||'')}</div><div style="flex:1;white-space:pre-wrap;font-size:10px;color:var(--t3);font-style:italic;margin-top:2px;">Rubric: ${e(s.rubric||'')}</div>${_meta}</div>`;
  }).join(''):'';
  const metricsBlock=(m)=>{
    const o=m||{};const rows=o.metrics||[];
    let html=(rows.length?rows.map(r=>`<div style="display:flex;justify-content:space-between;gap:8px;font-size:11px;padding:2px 0;"><span>${e(r.name||'')}</span><span style="font-weight:600;flex-shrink:0;">${e(r.threshold||'')}</span></div>`).join('')
      :'<div style="font-size:10px;color:var(--label);font-style:italic;">No metrics specified.</div>');
    if(o.rubrics&&o.rubrics.length){
      html+='<div style="font-size:10px;font-weight:600;color:var(--t2);margin:8px 0 2px;">Rubrics</div>'+rubricRows(o.rubrics);
    }
    html+=(o.rerunTrigger?`<div style="font-size:10px;color:var(--t3);margin-top:4px;">Rerun trigger: ${e(o.rerunTrigger)}</div>`:'');
    return html;
  };
  if(t==='ai_feature'){
    const d=st.detail||{};
    return[
      {label:'User Outcome',html:`<div style="font-size:11px;color:var(--t3);line-height:1.5;font-style:italic;">${e(d.outcome||'')}</div>`},
      {label:'Behavior Expectations',html:bullets(d.behaviorExpectations)},
      {label:'Eval Scenarios & Rubrics',html:(d.evalScenarios&&d.evalScenarios.length?rubricRows(d.evalScenarios):'<div style="font-size:10px;color:var(--label);font-style:italic;">No eval scenarios.</div>')},
      {label:'Quality Bar',html:metricsBlock(d.qualityBar)}
    ];
  }
  if(t==='agentic'){
    const d=st.detail||{};
    const esc=d.escalation||{};
    return[
      {label:'Goal',html:`<div style="font-size:11px;color:var(--t3);line-height:1.5;font-style:italic;">${e(d.goal||'')}</div>`},
      {label:'Decision Rights',html:bullets(d.decisionRights)},
      {label:'Guardrails',html:bullets(d.guardrails)},
      {label:'Escalation',html:'<div style="font-size:10px;font-weight:600;color:var(--t2);margin-bottom:2px;">Triggers</div>'+bullets(esc.triggers)+'<div style="font-size:10px;font-weight:600;color:var(--t2);margin:6px 0 2px;">Handoff includes</div>'+bullets(esc.handoff)},
      {label:'Acceptance Envelope',html:metricsBlock(d.acceptanceEnvelope)}
    ];
  }
  // traditional — identical output to the previous hardcoded panel blocks
  const acHtml=(st.scenarios&&st.scenarios.length>0)
    ?`<div class="sc-ac-block">`+st.scenarios.map((sc)=>{
        if(typeof sc==='string'){
          return `<div class="sc-ac-scenario"><div style="flex:1;white-space:pre-wrap;font-size:10px;color:var(--t2);line-height:1.5;">${e(sc)}</div></div>`;
        }
        return `<div class="sc-ac-scenario"><div style="flex:1;white-space:pre-wrap;"><span class="sc-ac-kw">Scenario:</span> ${e(sc.name||'')}\n<span class="sc-ac-kw">Given</span> ${e(sc.given||'')}\n<span class="sc-ac-kw">When</span>  ${e(sc.when||'')}\n<span class="sc-ac-kw">Then</span>  ${e(sc.then||'')}${sc.and?`\n<span class="sc-ac-kw">And</span>   ${e(sc.and)}`:''}
        </div></div>`;
      }).join('')+`</div>`
    :'<div style="font-size:10px;color:var(--label);font-style:italic;">No acceptance criteria — generate stories in Feature Canvas to include ACs.</div>';
  return[
    {label:'Story Statement',html:`<div style="font-size:11px;color:var(--t3);line-height:1.5;font-style:italic;">${e(st.statement||'')}</div>`},
    {label:'Acceptance Criteria',html:acHtml}
  ];
}

function scToggleLineage(fid){
  scPanelLineageOpen=!scPanelLineageOpen;
  scPanelLinkingMetric=false;
  const feat=scCanvas.find(x=>x.id===fid);
  if(feat)scRenderLineage(feat);
}

function scShowLinkMetricModal(fid){
  // G3 — no KPI tree guard
  if(typeof gData==='undefined'||!gData||!gData.stages||!gData.stages.length){
    const _isCap=typeof gData!=='undefined'&&gData&&gData.approach==='capability-based';
    showToast(_isCap?'Generate your Discovery Map first to link a capability.':'Generate your Discovery Map first to link a metric.','warn');
    return;
  }
  scPanelLinkingMetric=true;
  scPanelLineageOpen=true;
  const feat=scCanvas.find(x=>x.id===fid);
  if(feat)scRenderLineage(feat);
}

function scCancelLinkMetric(fid){
  scPanelLinkingMetric=false;
  const feat=scCanvas.find(x=>x.id===fid);
  if(feat)scRenderLineage(feat);
}

function scConfirmLinkMetric(fid){
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat)return;
  const sel=document.getElementById('sc-lineage-metric-sel');
  if(!sel||!sel.value)return;
  const selectedMetric=sel.value;

  // Resolve stage from gData — capture both label and id
  let selectedStageLabel='', selectedStageId='';
  if(typeof gData!=='undefined'&&gData&&gData.stages){
    for(const st of gData.stages){
      if((st.l1_metrics||[]).find(m=>m.name===selectedMetric)){
        selectedStageLabel=st.label;
        selectedStageId=st.id;
        break;
      }
    }
  }
  if(!selectedStageLabel){
    showToast('Could not resolve stage for this metric. Please try again.','warn');
    return;
  }

  // G4 — duplicate id guard
  const newId=scMakeFeatureId(selectedMetric,feat.cap,feat.name);
  if(scCanvas.find(x=>x.id===newId&&x!==feat)){
    showToast('A feature with this name already exists under that metric.','warn');
    return;
  }

  const oldId=feat.id;

  // Write metric, stage, metricPath, id
  feat.metric=selectedMetric;
  feat.stage=selectedStageLabel;
  feat.metricPath=(typeof scGetMetricPath==='function'?scGetMetricPath(selectedMetric):selectedMetric)||selectedMetric;
  feat.id=newId;
  // Migrate prototype to new feature ID
  if(typeof pcMigrateProtoFeatureId==='function')pcMigrateProtoFeatureId(oldId,newId);

  // G1 — reset panel id before re-open
  scPanelFeatureId=null;

  // Update scSelectedIds
  if(scSelectedIds.has(oldId)){scSelectedIds.delete(oldId);scSelectedIds.add(newId);}

  // Update scPiSelectedIds
  if(scPiSelectedIds.has(oldId)){scPiSelectedIds.delete(oldId);scPiSelectedIds.add(newId);}

  // G2 — update submittedFeatureIds on every plan that references it
  if(typeof piPlans!=='undefined'&&Array.isArray(piPlans)){
    piPlans.forEach(function(_plan){
      if(!_plan.submittedFeatureIds)return;
      const idx=_plan.submittedFeatureIds.indexOf(oldId);
      if(idx>-1)_plan.submittedFeatureIds[idx]=newId;
    });
  }

  // G3 — propagate metric/stage to unlinked sibling features under same cap
  // Only PI-origin features with no metric yet — don't overwrite intentional links
  const metricPath=(typeof scGetMetricPath==='function'?scGetMetricPath(selectedMetric):selectedMetric)||selectedMetric;
  scCanvas.forEach(sib=>{
    if(sib===feat)return;
    if(sib.cap!==feat.cap)return;
    if(sib.origin!=='pi')return;
    if(sib.metric&&sib.metric.trim()&&sib.metric!==sib.cap)return; // already genuinely linked — don't overwrite
    const sibOldId=sib.id;
    sib.metric=selectedMetric;
    sib.stage=selectedStageLabel;
    sib.metricPath=metricPath;
    sib.id=scMakeFeatureId(selectedMetric,sib.cap+(sib.subCap?'/'+sib.subCap:''),sib.name);
    if(typeof pcMigrateProtoFeatureId==='function')pcMigrateProtoFeatureId(sibOldId,sib.id);
    if(scSelectedIds.has(sibOldId)){scSelectedIds.delete(sibOldId);scSelectedIds.add(sib.id);}
    if(scPiSelectedIds.has(sibOldId)){scPiSelectedIds.delete(sibOldId);scPiSelectedIds.add(sib.id);}
    if(typeof piPlans!=='undefined'&&Array.isArray(piPlans)){
      piPlans.forEach(function(_plan){
        if(!_plan.submittedFeatureIds)return;
        const si=_plan.submittedFeatureIds.indexOf(sibOldId);
        if(si>-1)_plan.submittedFeatureIds[si]=sib.id;
      });
    }
  });

  // G4 — sync metric/stage back to capStore to prevent phantom duplicates on re-send
  if(typeof capStore!=='undefined'){
    Object.values(capStore).forEach(entry=>{
      (entry.capabilities||[]).forEach(cap=>{
        if(cap.name!==feat.cap)return;
        const featKey='top';
        const capFeats=cap.featStore&&cap.featStore[featKey];
        if(!capFeats)return;
        capFeats.forEach(cf=>{
          if(!cf.metric||!cf.metric.trim()||cf.metric===cap.name){
            cf.metric=selectedMetric;
            cf.stage=selectedStageLabel;
          }
        });
      });
    });
  }

  // G5 — migrate capStore entry from pi|| key to KPI metric key
  // So CC left nav reflects the linked metric group instead of Custom Capabilities
  if(selectedStageId&&typeof capStore!=='undefined'){
    const piKey=Object.keys(capStore).find(k=>
      k.startsWith('pi||')&&
      (capStore[k].capabilities||[]).some(c=>c.name===feat.cap)
    );
    if(piKey){
      const kpiKey=selectedStageId+'||'+selectedMetric;
      const piEntry=capStore[piKey];
      const capObj=piEntry.capabilities.find(c=>c.name===feat.cap);
      if(capObj){
        capObj._piFirst=false;
        if(!capStore[kpiKey]){
          capStore[kpiKey]={
            metricName:selectedMetric,
            stageLabel:selectedStageLabel,
            stageId:selectedStageId,
            capabilities:[]
          };
        }
        capStore[kpiKey].capabilities.push(capObj);
        piEntry.capabilities=piEntry.capabilities.filter(c=>c.name!==feat.cap);
        if(piEntry.capabilities.length===0)delete capStore[piKey];
      }
    }
  }

  scPanelLinkingMetric=false;
  scPanelLineageOpen=true;

  fcRenderCanvas();
  if(typeof fcRenderCapNav==='function')fcRenderCapNav();
  if(typeof curTab!=='undefined'&&curTab==='sc'){
    // SC context: update panel feat id and re-render SC panel
    if(typeof newScPanelFeatId!=='undefined')newScPanelFeatId=feat.id;
    if(typeof newScRenderMain==='function')newScRenderMain();
    const _scSt=feat.stories&&typeof newScPanelStoryId!=='undefined'?feat.stories.find(s=>s.id===newScPanelStoryId):null;
    if(_scSt&&typeof newScRenderPanelContent==='function')newScRenderPanelContent(_scSt,feat);
  } else {
    scOpenPanel(feat.id);
  }
  showToast('Metric linked. Traceability chain complete.','success');
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('sc',fid+_LS_SC_TARGET_SEP); });
  }
}


// User-facing close (X button) — guarded against in-flight generation.
// Programmatic callers (feature delete/remove/purge) call scClosePanel() directly,
// since those aren't "leave mid-generation" scenarios.
function scClosePanelUserAction(){
  if(guardAiGenNav(()=>scClosePanel()))return;
  scClosePanel();
}

function scClosePanel(){
  // v9.25 — closing hides the panel via CSS class removal, it doesn't
  // destroy #sc-refine-txt's DOM node — so without this, a mic left
  // listening would keep capturing into a now-hidden textarea, same
  // privacy/resource-leak shape as the tab-backgrounding case, just
  // scoped to "this panel is closed" instead of "browser tab is hidden."
  voiceStopActive('abort');
  scPanelFeatureId=null;
  document.getElementById('sc-main').classList.remove('panel-open');
  document.getElementById('sc-panel').classList.remove('open');
  fcRenderCanvas();
}

function scUpdatePanelNav(){
  // Use fcGetVisibleCanvasSorted() — matches visual grid order (stage → metric)
  // so "Feature X of N" counter reflects card position, not insertion order
  const allFeats=fcGetVisibleCanvasSorted();
  const idx=allFeats.findIndex(f=>f.id===scPanelFeatureId);
  const navTotal=allFeats.length;
  const displayIdx=idx>=0?idx+1:1;
  document.getElementById('sc-panel-nav-info').textContent='Feature '+displayIdx+' of '+navTotal;
  document.getElementById('sc-panel-prev').disabled=idx<=0;
  document.getElementById('sc-panel-next').disabled=idx>=allFeats.length-1;
}

function scPanelNav(dir){
  // Use fcGetVisibleCanvasSorted() — navigate in visual grid order
  const allFeats=fcGetVisibleCanvasSorted();
  const idx=allFeats.findIndex(f=>f.id===scPanelFeatureId);
  const next=allFeats[idx+dir];
  if(next)scOpenPanel(next.id);
}

// ── Returns visible canvas sorted to match the visual grid order ──
// fcGetVisibleCanvas() returns features in scCanvas insertion order (generation time).
// The grid renders features sorted by stage index → metric index from gData.
// This function applies the same sort so nav counter and arrows match the visual grid.
function fcGetVisibleCanvasSorted(){
  const visible=fcGetVisibleCanvas();
  // Guard: if no KPI tree exists yet, insertion order is the only order we have
  if(!gData||!gData.stages||!gData.stages.length)return visible;
  const stageOrder=gData.stages.map(function(s){return s.label;});
  const metricOrder=scGetMetricOrder();
  return visible.slice().sort(function(a,b){
    const ai=stageOrder.indexOf(a.stage);
    const bi=stageOrder.indexOf(b.stage);
    if(ai!==bi){
      if(ai===-1)return 1;   // unknown stage → end
      if(bi===-1)return -1;
      return ai-bi;
    }
    // Same stage — sort by metric position in KPI tree
    const ami=metricOrder.indexOf(a.metric);
    const bmi=metricOrder.indexOf(b.metric);
    if(ami!==bmi){
      if(ami===-1)return 1;  // unknown metric → end of stage
      if(bmi===-1)return -1;
      return ami-bmi;
    }
    // Same stage + metric — preserve insertion order (stable sort tiebreak)
    return 0;
  });
}

function scRenderPanel(feat){
  const loading=document.getElementById('sc-panel-loading');
  const content=document.getElementById('sc-panel-content');
  loading.classList.remove('on');
  content.classList.remove('is-hidden');
  // Show/hide refine bar based on story existence
  const refineBar=document.getElementById('sc-refine-bar');
  if(refineBar)refineBar.style.display=(!feat.stories||feat.stories.length===0)?'none':'';
  // Always update panel footer CTA state regardless of story existence
  const _panelBtn=document.getElementById('fc-panel-sc-btn');
  if(_panelBtn){
    const hasStories=!!(feat.stories&&feat.stories.length>0);
    const allInSC=hasStories&&feat.stories.every(s=>s._inSC);
    const _stagedN=hasStories?feat.stories.filter(s=>s._stagedForPI).length:0;
    const _unsentN=hasStories?feat.stories.filter(s=>!s._inSC&&!s._inPIPlan).length:0;
    // Disable when no stories, or all already sent to SC
    _panelBtn.disabled=!hasStories||allInSC;
    if(hasStories&&!allInSC){
      const _panelN=_stagedN>0?_stagedN:_unsentN;
      _panelBtn.innerHTML=`<i class="ti ti-list-details" style="font-size:11px;" aria-hidden="true"></i> Send to Story Canvas${_panelN>0?' ('+_panelN+')':''}`;
    } else if(allInSC){
      _panelBtn.innerHTML=`<i class="ti ti-list-details" style="font-size:11px;" aria-hidden="true"></i> All sent to Story Canvas`;
    } else {
      _panelBtn.innerHTML=`<i class="ti ti-list-details" style="font-size:11px;" aria-hidden="true"></i> Send to Story Canvas`;
    }
  }
  const _splitSt=document.getElementById('sc-panel-split-status');
  if(_splitSt){
    if(feat.stories&&feat.stories.length>0){
      const _inScN=feat.stories.filter(s=>s._inSC).length;
      const _stagedN2=feat.stories.filter(s=>s._stagedForPI).length;
      if(_inScN===feat.stories.length){_splitSt.textContent='All '+_inScN+' in Story Canvas';}
      else if(_inScN>0){_splitSt.textContent=_inScN+' of '+feat.stories.length+' in Story Canvas';}
      else if(_stagedN2>0){_splitSt.textContent=_stagedN2+' of '+feat.stories.length+' selected';}
      else{_splitSt.textContent=feat.stories.length+' stor'+(feat.stories.length===1?'y':'ies');}
    } else {
      _splitSt.textContent='0 stories';
    }
  }
  if(!feat.stories||feat.stories.length===0){
    // Show empty state as direct child of sc-panel-scroll (sibling of sc-panel-loading)
    // This is the only reliable way to vertically centre content inside overflow-y:auto flex container
    const emptyEl=document.getElementById('sc-panel-empty');
    if(emptyEl){
      emptyEl.innerHTML=`<i class="ti ti-writing" style="font-size:28px;color:var(--label);margin-bottom:10px;" aria-hidden="true"></i>
        <div style="font-size:12px;font-weight:600;color:var(--t2);margin-bottom:4px;">No stories yet</div>
        <div style="font-size:11px;color:var(--t3);max-width:180px;line-height:1.4;margin-bottom:14px;text-align:center;">AI will generate user stories for this feature.</div>
        ${((typeof canEditSession!=='function')||canEditSession())?`<button class="gen-btn" style="font-size:11px;padding:8px 14px;width:auto;" onclick="scPanelGenerateStories('${e(feat.id)}')"><i class="ti ti-sparkles" style="font-size:11px;" aria-hidden="true"></i> Generate Stories</button>`:''}`;
      emptyEl.classList.add('on');
    }
    content.classList.add('is-hidden');
    content.innerHTML='';
    return;
  }
  // Has stories — hide empty state, show content
  const _emptyEl=document.getElementById('sc-panel-empty');
  if(_emptyEl){_emptyEl.classList.remove('on');_emptyEl.innerHTML='';}
  content.classList.remove('is-hidden');
  const piSelCount=(feat.stories||[]).filter(st=>st._stagedForPI).length;
  const _canEditFcPiPanel=(typeof canEditSession!=='function')||canEditSession();
  let h='';
  h+=`<div class="sc-panel-pi-hdr">`;
  h+=`<span class="sc-panel-pi-lbl"><i class="ti ti-list-details" style="font-size:10px;margin-right:3px;" aria-hidden="true"></i>SC selection &middot; <strong>${piSelCount} of ${feat.stories.length}</strong> selected</span>`;
  if(_canEditFcPiPanel){
    h+=`<div style="display:flex;gap:5px;">`;
    h+=`<button class="sc-panel-pi-sel-btn" onclick="scSelectAllPiStories('${e(feat.id)}')">All</button>`;
    h+=`<button class="sc-panel-pi-sel-btn" onclick="scClearAllPiStories('${e(feat.id)}')">None</button>`;
    h+=`</div>`;
  }
  h+=`</div>`;
  feat.stories.forEach((st,si)=>{
    const isPiChecked=!!st._stagedForPI;
    const isInSC=!!st._inSC;
    const itemCls='sc-story-item sc-story-item-pi-mode'+(isInSC?' sc-story-item-insc':'');
    const _clickHandler=isInSC?`scTogglePiStoryInSC('${e(feat.id)}',${si})`:`scTogglePiStory('${e(feat.id)}',${si})`;
    h+=`<div class="${itemCls}" ${_canEditFcPiPanel?`onclick="${_clickHandler}"`:''}>`;
    h+=`<div class="sc-story-pi-check${isInSC?' checked insc':isPiChecked?' checked':''}${_canEditFcPiPanel?'':' sc-story-pi-check-disabled'}" ${_canEditFcPiPanel?`onclick="event.stopPropagation();${_clickHandler}"`:''}>`;
    if(isPiChecked||isInSC)h+=`<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    h+=`</div>`;
    h+=`<div style="flex:1;min-width:0;">`;
    h+=`<div class="sc-story-meta">`;
    h+=`<span class="sc-story-id">${e(st.id)}</span>`;
    h+=`<span class="sc-story-pts">${st.points?st.points+' pts':'—'}</span>`;
    if(st.priority)h+=`<span class="sc-story-pri">${e(st.priority)}</span>`;
    if(isInSC)h+=`<span class="sc-feat-insc-tag" style="margin-left:2px;"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> In Story Canvas</span>`;
    h+=`</div>`;
    h+=`<div class="sc-story-title-row">`;
    h+=`<div class="sc-story-title" id="sc-st-title-${si}">${e(st.title)}</div>`;
    h+=scStoryTypeBadge(st.storyType,{extraStyle:'flex-shrink:0;'});
    if(_canEditFcPiPanel)h+=`<button class="sc-story-edit-btn" onmousedown="event.preventDefault()" onclick="event.stopPropagation();scEditStoryTitle('${e(feat.id)}',${si})" title="Edit title"><i class="ti ti-pencil" style="font-size:10px;" aria-hidden="true"></i></button>`;
    h+=`</div>`;
    if((st.storyType||'traditional')==='traditional'){
      h+=`<div class="sc-story-stmt-row">`;
      h+=`<div class="sc-story-stmt" id="sc-st-stmt-${si}">${e(st.statement)}</div>`;
      if(_canEditFcPiPanel)h+=`<button class="sc-story-edit-btn" onmousedown="event.preventDefault()" onclick="event.stopPropagation();scEditStoryStmt('${e(feat.id)}',${si})" title="Edit description" style="margin-top:2px;"><i class="ti ti-pencil" style="font-size:10px;" aria-hidden="true"></i></button>`;
      h+=`</div>`;
      if(st.scenarios&&st.scenarios.length>0){
        h+=`<div class="sc-ac-block"><div class="sc-ac-label">Acceptance criteria</div>`;
        st.scenarios.forEach((sc,sci)=>{
          h+=`<div class="sc-ac-scenario" id="sc-st-ac-${si}-${sci}">`;
          h+=`<div style="display:flex;justify-content:space-between;align-items:flex-start;">`;
          h+=`<div style="flex:1;white-space:pre-wrap;"><span class="sc-ac-kw">Scenario:</span> ${e(sc.name)}\n<span class="sc-ac-kw">Given</span> ${e(sc.given)}\n<span class="sc-ac-kw">When</span>  ${e(sc.when)}\n<span class="sc-ac-kw">Then</span>  ${e(sc.then)}${sc.and?`\n<span class="sc-ac-kw">And</span>   ${e(sc.and)}`:''}`;
          h+=`</div>`;
          if(_canEditFcPiPanel)h+=`<button class="sc-story-edit-btn" onmousedown="event.preventDefault()" onclick="event.stopPropagation();scEditStoryAC('${e(feat.id)}',${si},${sci})" title="Edit acceptance criteria" style="flex-shrink:0;margin-left:4px;margin-top:1px;"><i class="ti ti-pencil" style="font-size:10px;" aria-hidden="true"></i></button>`;
          h+=`</div>`;
          h+=`</div>`;
        });
        h+=`</div>`;
      }
    } else {
      // ai_feature / agentic — same shared sections as Story Canvas/Release
      // Canvas (scGetStorySections), read-only here (no per-field edit
      // affordance yet, matching the pencil-edit gating in Story Canvas).
      const _secs=(typeof scGetStorySections==='function')?scGetStorySections(st):[];
      // Plain text styling (no .sc-ac-scenario) — that class is monospace/
      // pre-wrap for Gherkin blocks and shouldn't apply to prose/bullet
      // sections here, matching the unstyled divs Story Canvas/PI Planning
      // use for the same scGetStorySections() output.
      h+=`<div class="sc-ac-block">`+_secs.map(sec=>`<div class="sc-ac-label" style="margin-top:8px;">${e(sec.label)}</div><div style="font-size:10px;color:var(--t2);line-height:1.7;">${sec.html}</div>`).join('')+`</div>`;
    }
    h+=`</div></div>`;
  });
  content.innerHTML=h;
}

// ── PI Selection (card ↔ panel bidirectional sync) ──
function scTogglePiSelect(fid){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat||!feat.stories||feat.stories.length===0)return;
  // None/partial → select all; all → deselect all
  const allSelected=feat.stories.every(st=>st._stagedForPI);
  if(allSelected){
    scPiSelectedIds.delete(fid);
    feat.stories.forEach(st=>{st._stagedForPI=false;});
  } else {
    scPiSelectedIds.add(fid);
    feat.stories.forEach(st=>{st._stagedForPI=true;});
  }
  fcRenderCanvas();
  if(scPanelFeatureId===fid)scRenderPanel(feat);
  // v8.147 fix: confirmed missing entirely. PI-staging state only — no
  // live-edit mark, matching the established selection-state convention.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId)sessionStoreSave(_activeSessionId);
}

function scTogglePiStory(fid,storyIdx){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat||!feat.stories||!feat.stories[storyIdx])return;
  const st=feat.stories[storyIdx];
  st._stagedForPI=!st._stagedForPI;
  const anySelected=feat.stories.some(s=>s._stagedForPI);
  if(anySelected)scPiSelectedIds.add(fid);
  else scPiSelectedIds.delete(fid);
  fcRenderCanvas();
  if(scPanelFeatureId===fid)scRenderPanel(feat);
  // v8.147 fix (your A6 finding): confirmed missing entirely. PI-staging
  // state only — no live-edit mark, same convention as scTogglePiSelect.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId)sessionStoreSave(_activeSessionId);
}

function scTogglePiStoryInSC(fid,storyIdx){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat||!feat.stories||!feat.stories[storyIdx])return;
  const warnId='sc-insc-warn-'+fid+'-'+storyIdx;
  // If warning already showing, dismiss it
  const existing=document.getElementById(warnId);
  if(existing){existing.remove();return;}
  // Find the clicked story item by index among all story items in panel
  const allItems=document.querySelectorAll('#sc-panel-content .sc-story-item');
  const targetEl=allItems[storyIdx];
  if(!targetEl)return;
  // Remove any other open warnings first
  document.querySelectorAll('.sc-insc-warn-strip').forEach(el=>el.remove());
  const warn=document.createElement('div');
  warn.id=warnId;
  warn.className='sc-insc-warn-strip';
  warn.innerHTML=`<div style="display:flex;align-items:flex-start;gap:8px;background:#FAEEDA;border:1px solid #C8870A;border-radius:6px;padding:8px 10px;margin:4px 0 2px;">
    <i class="ti ti-alert-triangle" style="font-size:13px;color:#C8870A;margin-top:1px;flex-shrink:0;" aria-hidden="true"></i>
    <div style="flex:1;min-width:0;">
      <div style="font-size:11px;color:#633806;line-height:1.5;margin-bottom:6px;">This story is in Story Canvas. Removing it here will also remove it from Story Canvas.</div>
      <div style="display:flex;gap:6px;">
        <button onclick="scConfirmRemoveInSCStory('${e(fid)}',${storyIdx})" style="font-size:10px;font-weight:700;padding:3px 10px;background:#C8870A;color:#fff;border:none;border-radius:4px;cursor:pointer;font-family:var(--font);">Yes, remove</button>
        <button onclick="document.getElementById('${warnId}').remove()" style="font-size:10px;font-weight:500;padding:3px 10px;background:none;color:#633806;border:1px solid #C8870A;border-radius:4px;cursor:pointer;font-family:var(--font);">Cancel</button>
      </div>
    </div>
  </div>`;
  targetEl.insertAdjacentElement('afterend',warn);
}

function scConfirmRemoveInSCStory(fid,storyIdx){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat||!feat.stories||!feat.stories[storyIdx])return;
  const st=feat.stories[storyIdx];
  const _sid=st.id;
  st._inSC=false;
  st._stagedForPI=false;
  st._hiddenFromSC=true;
  if(typeof pcMarkStale==='function')pcMarkStale(fid);
  // Rebuild scPiSelectedIds
  const anySelected=feat.stories.some(s=>s._stagedForPI);
  if(anySelected)scPiSelectedIds.add(fid);
  else scPiSelectedIds.delete(fid);
  // Re-render FC canvas and SC
  fcRenderCanvas();
  if(typeof newScRender==='function')newScRender();
  if(typeof newScUpdateTabBadge==='function')newScUpdateTabBadge();
  // Re-render panel
  if(scPanelFeatureId===fid)scRenderPanel(feat);
  showToast('Story removed from Story Canvas.','info');
  // v8.147 fix: confirmed missing entirely.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('sc',fid+_LS_SC_TARGET_SEP+_sid); });
  }
}

function scSelectAllPiStories(fid){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat||!feat.stories)return;
  feat.stories.forEach(st=>{st._stagedForPI=true;});
  scPiSelectedIds.add(fid);
  fcRenderCanvas();
  if(scPanelFeatureId===fid)scRenderPanel(feat);
  // v8.147 fix: confirmed missing entirely. PI-staging only, no mark.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId)sessionStoreSave(_activeSessionId);
}

function scClearAllPiStories(fid){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat||!feat.stories)return;
  feat.stories.forEach(st=>{st._stagedForPI=false;});
  scPiSelectedIds.delete(fid);
  fcRenderCanvas();
  if(scPanelFeatureId===fid)scRenderPanel(feat);
  // v8.147 fix: confirmed missing entirely. PI-staging only, no mark.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId)sessionStoreSave(_activeSessionId);
}

// ── Inline story title edit ──
function scEditStoryTitle(fid,storyIdx){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat||!feat.stories||!feat.stories[storyIdx])return;
  const titleEl=document.getElementById('sc-st-title-'+storyIdx);
  if(!titleEl)return;
  const current=feat.stories[storyIdx].title;
  titleEl.outerHTML=`<input class="sc-story-title-input" id="sc-st-inp-${storyIdx}"
    value="${e(current)}"
    onblur="scSaveStoryTitle('${e(fid)}',${storyIdx},this.value)"
    onkeydown="if(event.key==='Enter')this.blur();if(event.key==='Escape'){this.value='${e(current)}';this.blur();}"
    style="width:100%;" />`;
  const inp=document.getElementById('sc-st-inp-'+storyIdx);
  if(inp){inp.focus();inp.select();inp.addEventListener('mousedown',function(e){e.stopPropagation();});}
}

function scSaveStoryTitle(fid,storyIdx,newVal){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat||!feat.stories||!feat.stories[storyIdx])return;
  const trimmed=newVal.trim();
  if(!trimmed||trimmed===feat.stories[storyIdx].title)return;
  const _sid=feat.stories[storyIdx].id;
  feat.stories[storyIdx].title=trimmed;
  if(typeof pcMarkStale==='function')pcMarkStale(fid);
  scRenderPanel(feat);
  // v8.147 fix: confirmed missing entirely.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('sc',fid+_LS_SC_TARGET_SEP+_sid); });
  }
}

function scEditStoryStmt(fid,storyIdx){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat||!feat.stories||!feat.stories[storyIdx])return;
  const el=document.getElementById('sc-st-stmt-'+storyIdx);
  if(!el)return;
  const current=feat.stories[storyIdx].statement;
  el.outerHTML=`<textarea class="sc-story-title-input" id="sc-st-stmt-inp-${storyIdx}"
    onblur="scSaveStoryStmt('${e(fid)}',${storyIdx},this.value)"
    onkeydown="if(event.key==='Escape'){this.value='${e(current)}';this.blur();}"
    style="width:100%;height:56px;resize:none;font-family:var(--font);font-size:11px;">${e(current)}</textarea>`;
  const inp=document.getElementById('sc-st-stmt-inp-'+storyIdx);
  if(inp){inp.focus();inp.select();inp.addEventListener('mousedown',function(e){e.stopPropagation();});}
}

function scSaveStoryStmt(fid,storyIdx,newVal){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat||!feat.stories||!feat.stories[storyIdx])return;
  const trimmed=newVal.trim();
  if(!trimmed||trimmed===feat.stories[storyIdx].statement)return;
  const _sid=feat.stories[storyIdx].id;
  feat.stories[storyIdx].statement=trimmed;
  if(typeof pcMarkStale==='function')pcMarkStale(fid);
  scRenderPanel(feat);
  // v8.147 fix: confirmed missing entirely.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('sc',fid+_LS_SC_TARGET_SEP+_sid); });
  }
}

function scACToText(sc){
  let t='Scenario: '+sc.name+'\nGiven '+sc.given+'\nWhen '+sc.when+'\nThen '+sc.then;
  if(sc.and)t+='\nAnd '+sc.and;
  return t;
}

function scTextToAC(text,fallback){
  const lines=text.split('\n').map(l=>l.trim()).filter(Boolean);
  const get=kw=>{
    const line=lines.find(l=>l.toLowerCase().startsWith(kw.toLowerCase()));
    if(!line)return null;
    return line.substring(kw.length).trim();
  };
  const name=get('Scenario:')||get('scenario:')||fallback.name;
  const given=get('Given ')||get('given ')||fallback.given;
  const when=get('When ')||get('when ')||fallback.when;
  const then=get('Then ')||get('then ')||fallback.then;
  const and=get('And ')||get('and ')||undefined;
  return{name,given,when,then,...(and!==undefined?{and}:{})};
}

function scEditStoryAC(fid,storyIdx,scenarioIdx){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat||!feat.stories||!feat.stories[storyIdx])return;
  const sc=feat.stories[storyIdx].scenarios&&feat.stories[storyIdx].scenarios[scenarioIdx];
  if(!sc)return;
  const el=document.getElementById('sc-st-ac-'+storyIdx+'-'+scenarioIdx);
  if(!el)return;
  const currentText=scACToText(sc);
  const rows=currentText.split('\n').length+1;
  el.innerHTML=`<div style="display:flex;flex-direction:column;gap:4px;">
    <textarea id="sc-ac-txt-${storyIdx}-${scenarioIdx}"
      style="width:100%;border:1px solid var(--purple);border-radius:4px;padding:6px 8px;font-size:11px;font-family:var(--font);color:var(--t1);resize:vertical;line-height:1.5;"
      rows="${rows}"
      onblur="scSaveStoryAC('${e(fid)}',${storyIdx},${scenarioIdx})"
      onkeydown="if(event.key==='Escape'){event.preventDefault();scRenderPanel(scCanvas.find(x=>x.id==='${e(fid)}'));}">${e(currentText)}</textarea>
    <div style="font-size:9px;color:var(--label);line-height:1.4;">Edit freely. Start lines with <strong>Scenario:</strong> <strong>Given</strong> <strong>When</strong> <strong>Then</strong> <strong>And</strong> to preserve structure.</div>
  </div>`;
  const ta=document.getElementById('sc-ac-txt-'+storyIdx+'-'+scenarioIdx);
  if(ta){ta.focus();}
}

function scSaveStoryAC(fid,storyIdx,scenarioIdx){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat||!feat.stories||!feat.stories[storyIdx])return;
  const scenarios=feat.stories[storyIdx].scenarios;
  if(!scenarios||!scenarios[scenarioIdx])return;
  const ta=document.getElementById('sc-ac-txt-'+storyIdx+'-'+scenarioIdx);
  if(!ta)return;
  const _sid=feat.stories[storyIdx].id;
  const parsed=scTextToAC(ta.value,scenarios[scenarioIdx]);
  scenarios[scenarioIdx]=parsed;
  if(typeof pcMarkStale==='function')pcMarkStale(fid);
  scRenderPanel(feat);
  // v8.147 fix: confirmed missing entirely.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('sc',fid+_LS_SC_TARGET_SEP+_sid); });
  }
}


function scPanelGenerateStories(fid){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat){showToast('Feature not found.','warn');return;}
  scSelectedIds=new Set([fid]);
  scGenerateStories([fid]);
}

// ── FC: Send feature stories to Story Canvas ──
function fcPanelSendToSC(){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  if(!scPanelFeatureId)return;
  const feat=scCanvas.find(x=>x.id===scPanelFeatureId);
  if(!feat||!feat.stories||feat.stories.length===0){showToast('Generate stories first.','info');return;}
  // Mark _inSC: use panel selection if any staged, else mark all
  const hasStagedSel=feat.stories.some(s=>s._stagedForPI);
  let sentCount=0;
  feat.stories.forEach(s=>{
    if(!s._inSC&&!s._inPIPlan&&(hasStagedSel?s._stagedForPI:true)){
      s._inSC=true;
      s._stagedForPI=false;
      sentCount++;
    }
  });
  // Rebuild scPiSelectedIds
  if(typeof scPiSelectedIds!=='undefined'){
    scPiSelectedIds=new Set();
    scCanvas.forEach(f=>{if(f.stories&&f.stories.some(s=>s._stagedForPI))scPiSelectedIds.add(f.id);});
  }
  // Reveal SC tab silently (don't navigate away)
  const scTabBtn=document.getElementById('tab-sc');
  if(scTabBtn)scTabBtn.classList.add('revealed');
  // Signal new content in Story Canvas (cleared on first visit)
  if(sentCount>0&&typeof markTabPending==='function')markTabPending('sc');
  // Inline confirm — CC pattern: button turns green for 2 seconds
  const sendBtn=document.getElementById('fc-panel-sc-btn');
  if(sendBtn&&sentCount>0){
    const origHtml=sendBtn.innerHTML;
    sendBtn.innerHTML=`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> ${sentCount} sent`;
    sendBtn.style.cssText='background:var(--green);color:#fff;border:none;';
    sendBtn.disabled=true;
    setTimeout(()=>{
      sendBtn.innerHTML=origHtml;
      sendBtn.style.cssText='';
      sendBtn.disabled=false;
      scRenderPanel(feat);
      fcRenderCanvas();
    },2000);
  } else {
    scRenderPanel(feat);
    fcRenderCanvas();
  }
  if(sentCount>0)showToast(`${sentCount} stor${sentCount!==1?'ies':'y'} sent to Story Canvas.`,'success');
  if(sentCount>0&&typeof pcMarkStale==='function')pcMarkStale(scPanelFeatureId);
  if(sentCount>0&&!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    const _sentIds=feat.stories.filter(s=>s._inSC&&!s._inPIPlan).map(s=>s.id);
    const _fpFid=scPanelFeatureId;
    sessionStoreSave(_activeSessionId).then(function(ok){
      if(!ok||typeof _lsMarkManualEdit!=='function')return;
      _sentIds.forEach(function(sid){ _lsMarkManualEdit('sc',_fpFid+_LS_SC_TARGET_SEP+sid); });
    });
  }
}

function scRefineStories(){
  // v9.25 — stop-on-send: refinement below is read synchronously from the
  // live value, so stopping here first doesn't affect what gets captured.
  // No "next message" for continued dictation to feed once this fires.
  voiceStopActive('abort');
  if(!scPanelFeatureId)return;
  const feat=scCanvas.find(f=>f.id===scPanelFeatureId);
  if(!feat)return;
  const refinement=document.getElementById('sc-refine-txt').value.trim();
  // Mark this feature as pending re-generation
  scSelectedIds=new Set([scPanelFeatureId]);
  // Store refinement for injection into prompt
  feat._refinement=refinement;
  if(typeof pcMarkStale==='function')pcMarkStale(scPanelFeatureId);
  scGenerateStories([scPanelFeatureId]);
  // Clear the textarea after submission
  document.getElementById('sc-refine-txt').value='';
}

// ── Story Generation ──
function scClickGenerate(){
  const sel=Array.from(scSelectedIds);
  if(sel.length===0)return;
  if(sel.length>7){
    scShowBatchModal(sel);
  } else {
    scGenerateStories(sel);
  }
}

function scShowBatchModal(sel){
  const n=sel.length;
  const estStories=n*5;
  const estTokens=n*3000;
  const estTime=n<8?'~'+Math.round(n*10)+'s':'~'+Math.round(n*10/60)+' min';
  const estCost='~$'+((estTokens/1000000)*3).toFixed(2);
  document.getElementById('sc-modal-title').textContent=n+' features selected — recommend batching';
  document.getElementById('sc-modal-sub').textContent='Generating all '+n+' features at once will produce ~'+estStories+' user stories. Consider batching for faster, more focused results.';
  document.getElementById('sc-modal-features').textContent=n;
  document.getElementById('sc-modal-stories').textContent='~'+estStories;
  document.getElementById('sc-modal-time').textContent=estTime;
  document.getElementById('sc-modal-cost').textContent=estCost;
  // Build batch options — 3 options max
  const b1=Math.min(5,n);
  const b2=Math.min(7,n);
  const batches=n<=10?[[b1,'Conservative'],[n,'All at once']]:[[b1,'Conservative'],[b2,'Recommended'],[n,'All at once']];
  let bh='';
  batches.forEach((b,bi)=>{
    const isRec=b[1]==='Recommended';
    const bStories=b[0]*5;
    const bTime='~'+(b[0]*10<60?b[0]*10+'s':Math.round(b[0]*10/60)+'min');
    const bCost='~$'+((b[0]*3000/1000000)*3).toFixed(2);
    bh+=`<div class="sc-modal-batch${isRec?' rec':''}" onclick="scModalSelectBatch(${b[0]},this)">`;
    bh+=`<div class="sc-modal-batch-num">${b[0]}</div>`;
    bh+=`<div class="sc-modal-batch-lbl2">${b[1]}</div>`;
    bh+=`<div class="sc-modal-batch-meta">~${bStories} stories · ${bTime} · ${bCost}</div>`;
    if(isRec)bh+=`<div class="sc-modal-batch-tag">Best balance</div>`;
    bh+=`</div>`;
  });
  document.getElementById('sc-modal-batches').innerHTML=bh;
  // Default to recommended or first
  scModalBatchSize=n<=10?n:b2;
  const recLabel=n<=10?'Generate all '+n:('Generate batch of '+b2);
  document.getElementById('sc-modal-proceed-label').textContent=recLabel;
  document.getElementById('sc-modal-overlay').classList.add('on');
}

function scModalSelectBatch(n,el){
  scModalBatchSize=n;
  document.querySelectorAll('.sc-modal-batch').forEach(b=>b.classList.remove('rec'));
  el.classList.add('rec');
  document.getElementById('sc-modal-proceed-label').textContent='Generate '+(scModalBatchSize===scSelectedIds.size?'all '+scModalBatchSize:'batch of '+scModalBatchSize);
}

function scModalClose(){
  document.getElementById('sc-modal-overlay').classList.remove('on');
}

function scModalProceed(){
  scModalClose();
  const sel=Array.from(scSelectedIds);
  const batch=sel.slice(0,scModalBatchSize);
  scGenerateStories(batch);
}

async function scGenerateStories(featureIds){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const key=getKey();
  if(aiGenInFlight.active){showToast("Still working on your last request. Hang tight, this won't take long.",'info');return;}
  const features=featureIds.map(id=>scCanvas.find(f=>f.id===id)).filter(Boolean);
  if(!features.length)return;
  // Open panel on first feature being generated
  const firstFeat=features[0];
  // v9.25 code-review fix — this is a SECOND entry point that reassigns
  // scPanelFeatureId (scOpenPanel() is the other), and #sc-refine-txt is
  // static HTML that's never destroyed — the same misattribution risk
  // scOpenPanel()'s own guard exists to prevent: dictation started for
  // whatever feature's panel was open before this bulk-generate call would
  // otherwise keep running and could get submitted against firstFeat
  // instead via scRefineStories() (which reads scPanelFeatureId at click
  // time, not at typing time).
  voiceStopActive('abort');
  scPanelFeatureId=firstFeat.id;
  document.getElementById('sc-panel-feat-name').textContent=firstFeat.name;
  scLineageTargetElId='sc-panel-feat-meta';
  if(typeof scRenderLineage==='function')scRenderLineage(firstFeat);
  document.getElementById('sc-main').classList.add('panel-open');
  document.getElementById('sc-panel').classList.add('open');
  // Phase 5 (v8.117): immediate button-disable, before the lock check —
  // matching the pattern used across the other 9 functions. The loading-
  // class toggle on sc-panel-loading/sc-panel-content (the RICH loading
  // state) is deferred to inside the lock callback, below.
  document.getElementById('sc-gen-btn').disabled=true;
  const _scCtx=(typeof getFullProductCtx==='function')?getFullProductCtx():{name:(productContext&&productContext.name)||'the product',icp:(productContext&&productContext.icp)||'product manager'};
  var _scDocRes=(typeof buildDocContext==='function')?buildDocContext('sc',features.map(f=>f.name).filter(Boolean).join(' ')):{text:'',truncated:false};
  _scCtx.docContext=_scDocRes.text;
  _fireDocTruncatedToast(_scDocRes.truncated);
  // Collect refinement from any feature in the batch (used when called from scRefineStories)
  const refinement=features.length===1&&features[0]._refinement?features[0]._refinement:'';
  const prompt=scBuildStoryPrompt(_scCtx,features,refinement);
  const _whatCooking=features.length===1
    ?`Stories for "${features[0].name}" are being generated. Leaving now discards them, you'll need to regenerate from scratch.`
    :`Stories for ${features.length} features are being generated. Leaving now discards this batch, you'll need to start again.`;
  // Phase 5 (v8.117): attempt marker. Note: scOpenPanel() already has its
  // own guard (blockIfGenerating()) preventing the user from switching to
  // a DIFFERENT feature's panel while aiGenInFlight.active is true — a
  // more robust, block-at-the-source mechanism than the marker system,
  // for the specific window that guard covers. The marker still adds real
  // value for the narrower window BEFORE aiGenInFlight.active is set
  // (during the lock-check RPC itself, which runs before startAiGen() is
  // called inside the callback below) — added for consistency + that gap.
  const _attempt=newGenAttempt();
  // Phase 5: withGenerationLock wraps callAPI through applying stories to
  // scCanvas and sessionStoreSave(). scRenderLineage(firstFeat) above stays
  // OUTSIDE this wrap — per the known defect note in PROJECT_MAP.md, it
  // must run before generation starts to preserve the traceability toggle
  // strip, unrelated to lock timing.
  try{
    await withGenerationLock(async (_lock) => {
  // Lock confirmed — show the rich loading state now, marker-stamped.
  document.getElementById('sc-panel-loading').classList.add('on');
  document.getElementById('sc-panel-loading').setAttribute('data-gen-attempt',_attempt.id);
  document.getElementById('sc-panel-content').classList.add('is-hidden');
  document.getElementById('sc-panel-content').innerHTML='';
  const _genEmptyEl=document.getElementById('sc-panel-empty');
  if(_genEmptyEl){_genEmptyEl.classList.remove('on');_genEmptyEl.innerHTML='';}
  // Phase 5 (v8.117): local self-attribute marker check — sc-panel-loading
  // gets the attribute directly on itself (not a child), so the standard
  // getIfCurrentAttempt helper (which checks descendants via querySelector)
  // would never match it. Same class of fix as kpi-tree.js/diagnostic-view.js.
  function _scLoadingStillCurrent(){
    var el=document.getElementById('sc-panel-loading');
    return !!(el&&el.getAttribute('data-gen-attempt')===_attempt.id);
  }
  try{
    const _signal=startAiGen(_whatCooking);
  // Dynamic token limit: scale with features × stories to prevent truncation at higher settings.
  // Model override: if projected output exceeds ~7k tokens (Haiku's safe ceiling),
  // force Sonnet regardless of batch size — Haiku's 8192 output limit would truncate.
  // Per-story estimate raised 900->1300 for the three-tier story classification
  // (ai_feature/agentic stories carry a nested `detail` object) — this only
  // raises the ceiling passed to callAPI, not committed cost, but it does mean
  // the Haiku->Sonnet override below now trips at smaller batch sizes.
  const _maxStories=(typeof appSettings!=='undefined'?appSettings.maxStories:5)||5;
  const _projectedTok=features.length*_maxStories*1300;
  const _dynTok=Math.min(32000,Math.max(12000,_projectedTok+2000));
  const _batchModel=_projectedTok>7000?null:(typeof resolveThresholdModel==='function')?resolveThresholdModel(features.length):null;
  // v9.13: tags WHY a non-null _batchModel was supplied, so usage-tracking
  // records this as 'batch_threshold_override' rather than the honest-but-
  // uninformative 'explicit_override_unclassified' fallback every other
  // (unaudited) modelOverride call site currently gets.
  const _batchSource=_batchModel?'batch_threshold_override':null;
  const txt=await callAPI(
    'You are a senior product manager and scrum master. Write grooming-ready user stories, choosing the right rigor format per story (traditional Gherkin acceptance criteria, AI-feature eval scenarios with rubrics, or an agentic operating/evaluation contract) based on each story\'s own nature. Respond ONLY with valid JSON. No markdown, no backticks, no preamble. Never use em dashes (—) in your output; use a hyphen (-) or rewrite the phrase.',
    prompt,
    _dynTok,
    _signal,
    _batchModel,
    'fc-gen-stories',
    _batchSource
  );
    const clean=txt.replace(/```json|```/g,'').trim();
    let parsed;
    try{parsed=JSON.parse(clean);}catch(pe){
      // Attempt repair
      const last=clean.lastIndexOf(']');
      if(last>0){try{parsed=JSON.parse(clean.substring(0,last+1));}catch(pe2){throw new Error('Stories could not be parsed. Please try again.');}}
      else throw new Error('Stories could not be parsed. Please try again.');
    }
    if(!parsed||!Array.isArray(parsed))throw new Error('Invalid story format returned.');
    // Map stories back to features
    parsed.forEach(featBlock=>{
      const feat=scCanvas.find(f=>f.name===featBlock.feature);
      if(feat){
        const isRefine=!!(feat._refinement);
        const newStories=(featBlock.stories||[]).map((st)=>{
          scStoryIdCounter++;
          // Normalize separators (hyphen/space) before matching, and if the
          // model still returns something off-list, infer from whichever
          // detail.* shape is actually present rather than defaulting straight
          // to 'traditional' — that default previously discarded an entire
          // ai_feature/agentic detail payload (statement/scenarios stay empty
          // for those types) whenever story_type didn't match exactly.
          const _rawType=String(st.story_type||'traditional').toLowerCase().trim().replace(/[\s-]+/g,'_');
          const _d0=st.detail||{};
          const storyType=['traditional','ai_feature','agentic'].includes(_rawType)?_rawType
            :(_d0.goal||_d0.decision_rights||_d0.guardrails||_d0.escalation?'agentic'
              :(_d0.outcome||_d0.behavior_expectations||_d0.eval_scenarios||_d0.quality_bar?'ai_feature':'traditional'));
          const base={
            id:'ST-'+String(scStoryIdCounter).padStart(3,'0'),
            title:st.title,
            points:st.points||3,
            priority:st.priority||'Should Have',
            dor:'NOT READY',
            dorReason:'',
            storyType,
            scenarios:st.scenarios||[],
            _inSC:false,
            _hiddenFromSC:false
          };
          if(storyType==='traditional'){
            base.statement=st.statement||'';
            return base;
          }
          // ai_feature / agentic — every nested read defensively guarded so a
          // partially-truncated response (see the repair path above) degrades
          // to empty fields instead of throwing.
          const d=st.detail||{};
          if(storyType==='ai_feature'){
            base.detail={
              outcome:d.outcome||'',
              behaviorExpectations:Array.isArray(d.behavior_expectations)?d.behavior_expectations:[],
              evalScenarios:Array.isArray(d.eval_scenarios)?d.eval_scenarios.map(s=>({scenario:(s&&s.scenario)||'',rubric:(s&&s.rubric)||'',category:_scNormalizeRubricCategory(s&&s.category),scoring:_scNormalizeScoring(s&&s.scoring)})).filter(s=>s.scenario||s.rubric):[],
              qualityBar:{
                metrics:Array.isArray(d.quality_bar&&d.quality_bar.metrics)?d.quality_bar.metrics.map(m=>({name:_scNameOrThreshold(m&&m.name),threshold:_scNameOrThreshold(m&&m.threshold)})):[],
                rerunTrigger:(d.quality_bar&&d.quality_bar.rerun_trigger)||''
              }
            };
          } else {
            base.detail={
              goal:d.goal||'',
              decisionRights:Array.isArray(d.decision_rights)?d.decision_rights:[],
              guardrails:Array.isArray(d.guardrails)?d.guardrails:[],
              escalation:{
                triggers:Array.isArray(d.escalation&&d.escalation.triggers)?d.escalation.triggers:[],
                handoff:Array.isArray(d.escalation&&d.escalation.handoff)?d.escalation.handoff:[]
              },
              acceptanceEnvelope:{
                metrics:Array.isArray(d.acceptance_envelope&&d.acceptance_envelope.metrics)?d.acceptance_envelope.metrics.map(m=>({name:_scNameOrThreshold(m&&m.name),threshold:_scNameOrThreshold(m&&m.threshold)})):[],
                rubrics:Array.isArray(d.acceptance_envelope&&d.acceptance_envelope.rubrics)?d.acceptance_envelope.rubrics.map(s=>({scenario:(s&&s.scenario)||'',rubric:(s&&s.rubric)||'',category:_scNormalizeRubricCategory(s&&s.category),scoring:_scNormalizeScoring(s&&s.scoring)})).filter(s=>s.scenario||s.rubric):[],
                rerunTrigger:(d.acceptance_envelope&&d.acceptance_envelope.rerun_trigger)||''
              }
            };
          }
          return base;
        });
        if(isRefine&&feat.stories&&feat.stories.length>0){
          // Merge: keep existing stories, append new ones (avoiding duplicates by title)
          const existingTitles=new Set(feat.stories.map(s=>s.title.toLowerCase()));
          const toAdd=newStories.filter(s=>!existingTitles.has(s.title.toLowerCase()));
          // Item 21: carry PI selection to new stories
          if(scPiSelectedIds.has(feat.id)){toAdd.forEach(st=>{st._stagedForPI=true;});}
          feat.stories=[...feat.stories,...toAdd];
        } else {
          // Item 21: carry PI selection to replacement stories (Option B — keep selection)
          const wasPiSelected=scPiSelectedIds.has(feat.id);
          feat.stories=newStories;
          if(wasPiSelected){
            feat.stories.forEach(st=>{st._stagedForPI=true;});
            // Stories regenerated while PI-selected — user should review panel
            showToast('Stories regenerated. Review PI selection in the panel.','info');
          }
        }
        // Clear the refinement flag after use
        delete feat._refinement;
      }
    });
    // Clear selection for generated features
    featureIds.forEach(id=>scSelectedIds.delete(id));
    // Mark prototypes stale for all regenerated features
    if(typeof pcMarkStale==='function')featureIds.forEach(id=>pcMarkStale(id));
    fcRenderCanvas();
    if(typeof newScUpdateTabBadge==='function')newScUpdateTabBadge();
    scRenderPanel(scCanvas.find(f=>f.id===scPanelFeatureId)||features[0]);
    scUpdatePanelNav();
    const feat=scCanvas.find(f=>f.id===scPanelFeatureId)||features[0];
    const _panelScBtn=document.getElementById('fc-panel-sc-btn');
    if(_panelScBtn)_panelScBtn.disabled=!(feat.stories&&feat.stories.length>0);
    // Phase 5: checkpoint immediately before the save.
    _lock.throwIfLost();
    if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
      const _ok=await sessionStoreSave(_activeSessionId);
      if(_ok&&typeof _activeSessionIsShared!=='undefined'&&_activeSessionIsShared&&typeof _lsEmitContentEvent==='function'){
        // Build B: one event per feature actually in this batch, matching
        // the existing ccGenerateAll precedent — not one event for the
        // whole batch. Coarse target (no story-id half) since this
        // replaces the feature's entire story list.
        for(const _fid of featureIds){
          await _lsEmitContentEvent(_activeSessionId,'sc','stories_generated',_fid,null);
        }
      }
    }
  }catch(err){
    if(err.name==='AbortError'){
      endAiGen();
      // Phase 5: rethrow rather than return — see pi-planning.js for the
      // full rationale (adversarial review Finding 1).
      throw err;
    }
    // Phase 5 (v8.117): marker-guarded — a stale attempt's failure must
    // not clobber a newer attempt's panel content.
    if(_scLoadingStillCurrent()){
      const _errEmptyEl=document.getElementById('sc-panel-empty');
      if(_errEmptyEl){_errEmptyEl.classList.remove('on');_errEmptyEl.innerHTML='';}
      document.getElementById('sc-panel-content').classList.remove('is-hidden');
      document.getElementById('sc-panel-content').innerHTML='<div style="padding:16px;text-align:center;"><div style="color:var(--orange);font-size:13px;font-weight:600;margin-bottom:8px;">&#9888; Generation failed</div><div style="font-size:11px;color:var(--t3);">'+e(err.message)+'</div></div>';
    }
    throw err; // propagate so the outer finally-equivalent below still resets loading/button state
  }finally{
    // Phase 5 (v8.117): marker-guarded for the loading-class removal — a
    // stale attempt should not hide a newer attempt's own loading state.
    // The button re-enable is intentionally NOT marker-guarded — sc-gen-btn
    // is a single, app-wide generate button (not per-feature), and it
    // should always end up enabled again once ANY generation using it
    // finishes, regardless of which attempt.
    if(_scLoadingStillCurrent()){
      document.getElementById('sc-panel-loading').classList.remove('on');
    }
    document.getElementById('sc-gen-btn').disabled=scSelectedIds.size===0;
    endAiGen();
  }
    });
  }catch(lockErr){
    // Phase 5 (v8.117): since the rich loading state is only ever shown
    // INSIDE the lock callback now, a pre-flight rejection never touched
    // sc-panel-loading/sc-panel-content at all — nothing to clean up
    // there. sc-gen-btn still needs resetting since it was disabled
    // BEFORE the lock check.
    document.getElementById('sc-gen-btn').disabled=scSelectedIds.size===0;
  }
}

function scBuildStoryPrompt(ctx,features,refinement){
  const product=(ctx&&ctx.name)?ctx.name:'the product';
  const icp=(ctx&&ctx.icp)?ctx.icp:'product manager';
  // Outcome Verification Loop (A5): append hypothesis context per feature
  // when it exists, omitted entirely when it doesn't — no placeholder, no
  // empty structure for features without a hypothesis. Feeds whatever is
  // present (primary always if present, secondary too if present), per
  // spec §4.5. This does NOT change the returned story object's shape —
  // hypothesis is prompt context only, never persisted onto a story.
  const _scHypBlock=f=>{
    if(!isOutcomeTrackableFeature(f))return'';
    const p=f.outcomeHypothesis.primary;
    let block=`\n  Outcome hypothesis: this feature is expected to ${p.direction==='decrease'?'decrease':'increase'} "${p.metric}"`
      +(p.baseline!==null&&p.baseline!==undefined&&p.target!==null&&p.target!==undefined?` from ${p.baseline} to ${p.target}${formatOutcomeUnit(p.unit,p.customLabel)?' '+formatOutcomeUnit(p.unit,p.customLabel):''}`:'')
      +(p.rationale?`. Rationale: ${p.rationale}`:'.');
    const sec=(f.outcomeHypothesis.secondary||[]).filter(s=>s.metric);
    if(sec.length){
      block+='\n  Secondary hypotheses: '+sec.map(s=>`${s.metric}${s.direction?' ('+(s.direction==='decrease'?'decrease':'increase')+')':''}`).join(', ');
    }
    return block;
  };
  // §10 — story generation's PRIMARY source becomes the intake brief when
  // this feature carries a non-null intakeBriefId (RA-created), with the
  // feature's own name/why as secondary/grounding context - reversing the
  // pre-redesign priority order. If intakeBriefId is null (manually-created
  // feature, or RA-off), behavior is completely unchanged. Targeted
  // extraction via requirement-agent.js's _raGetCapabilityBriefExcerpt() -
  // never the entire liveDraftMd blob.
  const _scBriefBlock=f=>{
    if(!f.intakeBriefId||typeof _raFindConv!=='function'||typeof _raGetCapabilityBriefExcerpt!=='function')return'';
    const conv=_raFindConv(f.intakeBriefId);
    const excerpt=conv?_raGetCapabilityBriefExcerpt(conv,f.cap):'';
    return excerpt?`\n  RELEASE REQUIREMENTS BRIEF (PRIMARY source - ground the stories in this, using the feature name/why below only as secondary/supporting context):\n  ${excerpt.split('\n').join('\n  ')}`:'';
  };
  const featList=features.map(f=>`- Feature: "${f.name}" (Capability: ${f.cap}, Metric: ${f.metric}, Stage: ${f.stage})${_scBriefBlock(f)}\n  Why: ${f.why}${_scHypBlock(f)}`).join('\n');
  const _scDocText=(ctx&&ctx.docContext)?ctx.docContext:'';
  const _scHasDoc=String(_scDocText).trim().length>0;
  const _scEnrichment=_scHasDoc?'\n'+_docEnrichmentInstruction()+'\n'+_backlogEnrichmentInstruction():'';
  return `Product: ${product}
Primary user / ICP: ${icp}
${ctx&&ctx.productDesc?'Product description: '+ctx.productDesc:''}
${ctx&&ctx.problem?'Known problem: '+ctx.problem:''}
${ctx&&ctx.additionalContext?'Additional context: '+ctx.additionalContext:''}
${_scDocText}${_scEnrichment}
${refinement?'\nRefinement instruction: '+refinement+'\nApply this refinement to ALL stories generated below.':''}

Features to story-ify:
${featList}

Return a JSON array — one object per feature. Each story is classified independently with its own "story_type" and must match exactly ONE of the three shapes below — never mix shapes (a "traditional" story has no "detail" key; an "ai_feature"/"agentic" story has no "statement"/"scenarios" keys):
[
  {
    "feature": "exact feature name",
    "stories": [
      {
        "story_type": "traditional",
        "title": "outcome-oriented title — [Persona] can [action] so that [outcome]",
        "statement": "As a [persona], I want to [action], so that [outcome].",
        "points": 3, "priority": "Must Have", "dor": "READY", "dor_reason": "",
        "scenarios": [
          {"name": "scenario name", "given": "precondition", "when": "action", "then": "outcome", "and": "additional outcome or empty string"},
          {"name": "edge case name", "given": "precondition", "when": "action", "then": "outcome", "and": ""}
        ]
      },
      {
        "story_type": "ai_feature",
        "title": "outcome-oriented title", "points": 3, "priority": "Must Have", "dor": "READY", "dor_reason": "",
        "detail": {
          "outcome": "the user outcome this AI behavior should achieve",
          "behavior_expectations": ["concrete behavior that must always hold", "..."],
          "eval_scenarios": [{"scenario": "a concrete input/situation", "rubric": "one-sentence grading criteria for a good response to it", "category": "Groundedness", "scoring": {"evaluator_type": "llm_judge", "scale": "0-1", "threshold": ">= 0.7", "rationale": "one sentence on why this evaluator/scale/threshold fits"}}],
          "quality_bar": {"metrics": [{"name": "metric name", "threshold": ">= 90%"}], "rerun_trigger": "what change requires re-running the scenario set"}
        }
      },
      {
        "story_type": "agentic",
        "title": "outcome-oriented title", "points": 3, "priority": "Must Have", "dor": "READY", "dor_reason": "",
        "detail": {
          "goal": "the outcome the agent is pursuing and when it applies",
          "decision_rights": ["what it may determine, recommend, or execute on its own", "..."],
          "guardrails": ["what it must never do regardless of instruction", "..."],
          "escalation": {"triggers": ["concrete condition that forces a handoff to a human", "..."], "handoff": ["what context must travel with the handoff", "..."]},
          "acceptance_envelope": {"metrics": [{"name": "metric name", "threshold": ">= 80%"}], "rubrics": [{"scenario": "a concrete judgment-call situation the agent may face (e.g. a borderline escalation call)", "rubric": "one-sentence criteria for what a sound decision looks like in that situation", "category": "Accuracy", "scoring": {"evaluator_type": "llm_judge", "scale": "0-1", "threshold": ">= 0.7", "rationale": "one sentence on why this evaluator/scale/threshold fits"}}], "rerun_trigger": "what change requires re-running the scenario set"}
        }
      }
    ]
  }
]

Rules:
- Stories per feature: up to ${typeof appSettings!=='undefined'?appSettings.maxStories:5} per feature, varying by complexity — fewer for simple/single-interaction features, more for complex ones with multiple personas or edge cases. Do NOT default to the maximum for every feature — actively vary the count based on complexity
- title must be outcome-oriented, specific to ${product}
- points: Fibonacci 1/2/3/5/8/13 only
- priority: Must Have / Should Have / Could Have
- dor: READY or NOT READY
- dor_reason: only if NOT READY — state reason (e.g. "UX design needed", "API contract undefined")
- story_type: classify EACH story independently as "traditional", "ai_feature", or "agentic":
  - "traditional": one correct, verifiable behavior per input — a lookup, calculation, CRUD action, or workflow step where right/wrong is unambiguous and testable with Given/When/Then.
  - "ai_feature": the story's core behavior is produced by a generative/ML model where multiple different outputs can be equally acceptable (summarization, recommendation, drafting, judgment-based classification) — quality is graded by a rubric across a distribution of scenarios, not one pass/fail assertion.
  - "agentic": the system autonomously decides AND acts across multiple steps on the user's/business's behalf (not just answering a question) — it needs explicit decision rights, guardrails, and escalation rules because it can take consequential action without a human approving each step.
  Do not default every story in a feature to the same story_type — a single feature can and often should mix types. Most stories in most products are still "traditional" — reserve "ai_feature" and "agentic" for stories whose core value genuinely depends on model-generated judgment or autonomous action, not merely because the product itself has AI in it.
- scenarios (traditional only): minimum 2 per story, up to ${typeof appSettings!=='undefined'?appSettings.maxACs:3} — one happy path, one edge/error case always included. given/when/then/and: concrete, testable language — never vague. and: empty string if not needed
- detail.behavior_expectations / decision_rights / guardrails: 2-5 concrete bullets each, never vague
- detail.eval_scenarios (ai_feature only): minimum 2, up to ${typeof appSettings!=='undefined'?appSettings.maxACs:3} — concrete scenario + a one-sentence grading rubric for that scenario
- detail.escalation (agentic only): triggers = concrete handoff conditions; handoff = what context travels with the handoff
- detail.quality_bar / detail.acceptance_envelope: 1-4 measurable metrics with name+threshold (threshold is a short string with unit/operator, e.g. ">= 80%", "< $0.25", "= 0", never a bare number); rerun_trigger: one sentence on what change requires re-running the scenario set
- detail.acceptance_envelope.rubrics (agentic only): 2-4 concrete judgment-call scenarios the agent may plausibly face (a borderline escalation call, an ambiguous guardrail boundary, a low-confidence decision) + a one-sentence rubric for what a sound decision looks like in that scenario. This grades the quality of the agent's in-the-moment judgment, separate from the aggregate pass/fail metrics above — do not omit it, and do not just restate the guardrails as rubrics
- detail.eval_scenarios[] / detail.acceptance_envelope.rubrics[] — "category" and "scoring": category classifies what that specific rubric actually tests — Groundedness (claims traceable to real context/data), Hallucination (states fabricated info as fact), Accuracy (factually/numerically correct), Adversarial (resists manipulation/prompt-injection/jailbreak), Out-of-context (correctly handles requests outside intended scope), Consistency (stable output across reruns of the same input), Format (follows required output structure), Bias (fair/non-discriminatory across groups), Safety (avoids harmful/toxic content), Robustness (handles malformed/noisy input gracefully), Privacy (avoids leaking PII/sensitive data), Completeness (covers everything the scenario requires), Tone (appropriately calibrated confidence/register), or General if none of these cleanly applies — never force a stretch fit. scoring is your recommendation for how this would actually be scored in automated testing: evaluator_type is "script_diff" (fully deterministic, no judgment involved), "llm_judge" (needs a model-as-judge), or "toxicity_scan" (a safety/content classifier); scale is "binary" (pass/fail) or "0-1" (continuous score); threshold is a short pass line in the same style as the metrics above (e.g. ">= 0.7", "pass iff no fabricated claim"); rationale is one sentence on why that evaluator/scale/threshold fits. Pick category and scoring independently per rubric based on what that specific scenario actually tests — most will cluster around Groundedness, Accuracy, Out-of-context, or Completeness, and most scoring will not need "llm_judge"/"0-1" by default; reserve the rarer categories (Adversarial, Bias, Safety, Privacy, Tone, Robustness, Format, Consistency) and non-"llm_judge" choices for scenarios that genuinely test that specific concern, not out of habit or because the surrounding story is AI-generated
- If a feature lists an outcome hypothesis above, favor acceptance criteria / eval scenarios that would plausibly move that specific metric in that direction — do not ignore this context when present
- Return ONLY the JSON array. No other text.`;
}

// ── Export ──
// ── FC Export — in-flight state ──
var fcExportInFlight=false;
// v9.20: Export's own button (#sc-export-btn) was folded into the toolbar
// kebab (scTbKebabTopHtml()) and no longer exists as a standalone element.
// The kebab's Export row already closes the menu on click, before this
// in-flight state changes, so there is nothing left in the DOM to sync \u2014
// kept as a no-op stub since fcExportInFlight's toggling around it stays.
function fcSyncExportBtn(){}
async function scExportAll(){
  if(fcExportInFlight)return;
  var snap=(typeof fcGetVisibleCanvasSorted==='function')?fcGetVisibleCanvasSorted():(typeof fcGetVisibleCanvas==='function'?fcGetVisibleCanvas():[]);
  if(!snap.length){showToast('No features visible to export. Check your filter settings.','info');return;}
  var productName=typeof getProductCtx==='function'?getProductCtx().name:'Product';
  fcExportInFlight=true;fcSyncExportBtn();
  try{
    await fcDownloadBriefDOCX(snap,productName);
  }catch(err){
    showToast('Export failed: '+err.message,'error');
    console.error('[FC Export]',err);
  }finally{
    fcExportInFlight=false;fcSyncExportBtn();
  }
}
// Legacy alias — some paths still call scExportFeature
function scExportFeature(){scExportAll();}
function scToggleExportDrop(){}

// ── scPurgeStage — removes all features (and their stories) for a given stage ──
// Called from stage delete and stage edit (Case C) in kpi-tree.js
// Does NOT remove market-origin features — those are independent of KPI tree stages
function scPurgeStage(stageLabel){
  const toRemove=scCanvas.filter(f=>f.stage===stageLabel&&f.origin!=='market');
  if(!toRemove.length)return;
  const removeIds=new Set(toRemove.map(f=>f.id));
  // Delete prototypes for all removed features before filtering canvas
  if(typeof pcDeleteProto==='function')removeIds.forEach(id=>pcDeleteProto(id));
  // Close panel if open feature is being removed
  if(scPanelFeatureId&&removeIds.has(scPanelFeatureId))scClosePanel();
  // Clean selected IDs (both story-gen and PI selection)
  removeIds.forEach(id=>scSelectedIds.delete(id));
  removeIds.forEach(id=>scPiSelectedIds.delete(id));
  // Remove features (stories go with them — no separate store)
  scCanvas=scCanvas.filter(f=>!removeIds.has(f.id));
  scUpdateCapDrawerFooter();
  fcUpdateTabBadge();
  fcRenderCanvas();
  fcRenderCapNav();
  // Notify new Story Canvas
  if(typeof newScRender==='function')newScRender();
  // v8.147 fix: confirmed missing entirely — a bulk removal of possibly
  // many features at once. One coarse mark per removed feature.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    const _purgedIds=Array.from(removeIds);
    sessionStoreSave(_activeSessionId).then(function(ok){
      if(!ok||typeof _lsMarkManualEdit!=='function')return;
      _purgedIds.forEach(function(id){ _lsMarkManualEdit('sc',id+_LS_SC_TARGET_SEP); });
    });
  }
}








function scApplyPIPlannedBadges(assignments){
  // assignments: {storyId:{sprint,squad,...}} from piPlan.storyAssignments
  // Map story IDs back to feature IDs and mark features
  if(!assignments)return;
  scCanvas.forEach(f=>{
    if(!f.stories)return;
    const storyInPlan=f.stories.some(st=>assignments[st.id]);
    if(storyInPlan){
      f.piPlanned=true;
      // Find the sprint for this feature's first assigned story
      const firstStory=f.stories.find(st=>assignments[st.id]);
      f.piSprintAssigned=firstStory?assignments[firstStory.id].sprint:null;
    } else {
      f.piPlanned=false;
      f.piSprintAssigned=null;
    }
  });
  fcRenderCanvas();
  // Trigger new Story Canvas re-render if available
  if(typeof newScRender==='function')newScRender();
}

function scClearPIPlannedBadges(){
  scCanvas.forEach(f=>{f.piPlanned=false;f.piSprintAssigned=null;});
  fcRenderCanvas();
  if(typeof newScRender==='function')newScRender();
}

// ── Add Feature manually ──
function scShowAddFeatureModal(){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  // Duplicate-open guard (v9.10.02 feedback round, adversarially found):
  // this overlay uses a fixed, non-unique id — a fast double-click on the
  // trigger before the first overlay is visually registered could
  // otherwise create two elements sharing the same id, and
  // document.getElementById()/querySelector() are spec-defined to return
  // only the first one in document order. Removing any existing instance
  // before creating a new one makes this structurally impossible rather
  // than something later code has to defensively work around.
  const _existingAddOverlay=document.getElementById('sc-add-feat-overlay');
  if(_existingAddOverlay)_existingAddOverlay.remove();
  // Build capability options: union of all cap names from capStore + unique caps already on scCanvas
  const capSet=new Set();
  if(typeof capStore!=='undefined'){
    Object.values(capStore).forEach(entry=>{
      (entry.capabilities||[]).forEach(cap=>{if(cap.name)capSet.add(cap.name);});
    });
  }
  // From scCanvas (covers caps removed from CC but still on SC)
  scCanvas.forEach(f=>{if(f.cap)capSet.add(f.cap);});
  const sortedCaps=[...capSet].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()));
  // Pre-select the active capability filter if one is set
  const defaultCap=scCapNavFilter||null;
  let capOpts=`<option value="" ${!defaultCap?'selected':''}>— Select a capability —</option>`;
  sortedCaps.forEach(c=>{capOpts+=`<option value="${e(c)}"${defaultCap===c?' selected':''}>${e(c)}</option>`;});
  // Outcome Verification Loop: reset per-modal secondary-hypothesis working
  // state each time this modal opens fresh — see _scAddFeatSecondary below.
  _scAddFeatSecondary=[];
  // v9.10.02 (item 5 fix): also reset entry-mode state per fresh open —
  // without this, a previous session's "AI mode, already auto-switched"
  // state would leak into a subsequent Add Feature open, permanently
  // suppressing the one-time auto-switch behavior after its first use.
  _scHypEntryMode='manual';
  _scAiGateAutoSwitched=false;
  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.id='sc-add-feat-overlay';
  overlay.innerHTML=`<div class="modal" style="max-width:400px;max-height:88vh;overflow-y:auto;position:relative;">
    <button onclick="document.getElementById('sc-add-feat-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:16px 44px 14px 16px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:500;color:var(--t1);">Add Feature</div>
    </div>
    <div class="modal-body" style="font-size:11px;color:var(--t3);line-height:1.5;">Manually add a feature to the Story Canvas. It must be tagged to a capability.</div>
    <div style="display:flex;flex-direction:column;gap:10px;padding:0 20px 4px;">
      <div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Feature Name<span style="color:var(--red);margin-left:1px;">*</span></label>
        <input id="sc-add-feat-name" type="text" placeholder="e.g. One-click re-onboarding"
          style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);background:var(--bg);"
          oninput="scAddFeatValidate();scAddFeatSyncAIGate();" />
        <div id="sc-add-feat-name-err" style="display:none;font-size:9px;color:var(--red);margin-top:2px;align-items:center;gap:3px;">
          <i class="ti ti-alert-circle" style="font-size:9px;" aria-hidden="true"></i> A feature with this name already exists on the canvas.
        </div>
      </div>
      <div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Why It Matters <span style="font-size:9px;color:var(--label);">(Optional)</span></label>
        <textarea id="sc-add-feat-why" placeholder="Describe the problem this feature solves…"
          style="width:100%;height:60px;border:1px solid var(--divider);border-radius:5px;padding:6px 8px;font-size:11px;font-family:var(--font);color:var(--t1);background:var(--bg);resize:none;"></textarea>
      </div>
      <div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Capability<span style="color:var(--red);margin-left:1px;">*</span></label>
        <div style="position:relative;">
          <select id="sc-add-feat-cap"
            style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);background:var(--bg);appearance:none;"
            onchange="scAddFeatValidate()">
            ${capOpts}
          </select>
          <i class="ti ti-chevron-down" style="position:absolute;right:8px;top:9px;font-size:10px;color:var(--label);pointer-events:none;" aria-hidden="true"></i>
        </div>
        <div style="font-size:9px;color:var(--label);margin-top:2px;">All features must belong to a capability.</div>
      </div>
      ${scBuildOutcomeHypothesisSectionHTML('add')}
    </div>
    <div class="modal-footer">
      <button class="modal-cancel-btn" onclick="document.getElementById('sc-add-feat-overlay').remove()">Cancel</button>
      <button class="modal-confirm-btn" id="sc-add-feat-submit" disabled onclick="scDoAddFeat()">Add Feature</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  // Bug 2 fix (v9.10.02 feedback round): _scAddFeatSecondary was already
  // reset to [] earlier in this function, so this call renders zero rows
  // harmlessly for the normal add-new-feature case — included here
  // unconditionally, not just for symmetry with the Edit modal, but so a
  // future pre-fill/duplicate-from-template path can seed this array
  // before opening the modal and have it render correctly on first paint
  // without needing a separate code path.
  scRenderSecondaryHypRows(overlay);
  const _escHandler=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_escHandler,true);}};
  document.addEventListener('keydown',_escHandler,true);
  trapFocus(overlay);
}

// ══════════════════════════════════════════════════════════════════════
// OUTCOME VERIFICATION LOOP — shared modal section (Phase B)
// One HTML builder + one set of supporting functions, used identically by
// both scShowAddFeatureModal() and scShowEditFeatModal() — per resolved
// design decision, both modals must have full parity, no scope reduction
// for Add Feature. mode is 'add' or 'edit'; existingHyp is the feature's
// current outcomeHypothesis object when editing, or null when adding.
// ══════════════════════════════════════════════════════════════════════

// Working state for the modal currently open — cleared/populated each
// time a modal opens, read back by scDoAddFeat()/scDoEditFeat() on save.
// Only one hypothesis-bearing modal is ever open at once in this app
// (modals are singletons, per existing convention), so one shared working
// array is safe — same pattern as e.g. _scUploadFeatRows elsewhere in
// this file.
let _scAddFeatSecondary=[];

function _scOutcomeUnitOptionsHTML(selected){
  let h='';
  OUTCOME_HYP_UNITS.forEach(u=>{h+=`<option value="${e(u)}"${selected===u?' selected':''}>${e(u)}</option>`;});
  h+=`<option value="custom"${selected==='custom'?' selected':''}>Custom label</option>`;
  return h;
}

function scBuildOutcomeHypothesisSectionHTML(mode,existingHyp){
  const isEdit=mode==='edit';
  const p=(existingHyp&&existingHyp.primary)||null;
  const secondary=(existingHyp&&existingHyp.secondary)||[];
  // Seed the working array from the existing feature's secondary entries
  // when editing; scShowAddFeatureModal() already reset it to [] for the
  // add case before calling this function.
  if(isEdit)_scAddFeatSecondary=secondary.map(s=>({...s}));
  const badge=isEdit&&p
    ?`<span style="font-size:8px;font-weight:700;background:${p.source==='ai'?'var(--purple-pale)':'var(--card)'};color:${p.source==='ai'?'var(--purple)':'var(--t3)'};border-radius:10px;padding:1px 6px;">${p.source==='ai'?'AI-suggested':'Edited'}</span>`
    :'';
  const toggleRowHTML=isEdit?'':`
    <div style="display:flex;gap:6px;">
      <div id="sc-hyp-mode-manual" onclick="scSetHypEntryMode('manual')" style="flex:1;text-align:center;padding:7px;border:1.5px solid var(--purple);background:var(--purple-pale);border-radius:5px;font-size:10px;font-weight:600;color:var(--purple);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;">
        <i class="ti ti-pencil" style="font-size:11px;" aria-hidden="true"></i> Enter manually
      </div>
      <div id="sc-hyp-mode-ai" onclick="scSetHypEntryMode('ai')" style="flex:1;text-align:center;padding:7px;border:1.5px solid var(--divider);border-radius:5px;font-size:10px;font-weight:600;color:var(--label);cursor:not-allowed;display:flex;align-items:center;justify-content:center;gap:4px;background:var(--card);">
        <i class="ti ti-sparkles" style="font-size:11px;" aria-hidden="true"></i> Generate with AI
      </div>
    </div>
    <div id="sc-hyp-ai-gate-note" style="font-size:8.5px;color:var(--label);margin-top:-4px;">Enter a feature name above to enable AI generation.</div>
  `;
  const directionDisplay=p&&p.direction
    ?(p.direction==='decrease'?'↓ Decrease':'↑ Increase')
    :'—';
  return `
    <div id="sc-hyp-section" style="border:1px solid var(--divider);border-radius:7px;margin-top:4px;">
      <div onclick="scToggleHypSection()" style="display:flex;align-items:center;padding:9px 10px;background:var(--card);border-radius:7px 7px 0 0;cursor:pointer;gap:6px;">
        <i class="ti ti-target-arrow" style="font-size:12px;color:var(--purple);" aria-hidden="true"></i>
        <span style="font-size:11px;font-weight:600;color:var(--t1);">Outcome Hypothesis</span>
        ${badge}
        <i class="ti ti-chevron-down" id="sc-hyp-chevron" style="font-size:12px;color:var(--t3);margin-left:auto;transition:transform 0.15s;" aria-hidden="true"></i>
      </div>
      <div id="sc-hyp-body" style="padding:10px;display:flex;flex-direction:column;gap:8px;">
        ${toggleRowHTML}
        <div style="font-size:9px;font-weight:700;color:var(--label);text-transform:uppercase;letter-spacing:0.5px;">Primary hypothesis</div>
        <div style="display:grid;grid-template-columns:minmax(0,1fr) 70px;gap:6px;">
          <div style="min-width:0;">
            <label style="font-size:9px;font-weight:500;color:var(--t2);display:block;margin-bottom:2px;">Target metric</label>
            <input id="sc-hyp-metric" type="text" maxlength="60" value="${p?e(p.metric):''}" placeholder="e.g. Cart abandonment rate"
              style="width:100%;height:26px;border:1px solid var(--divider);border-radius:5px;padding:0 7px;font-size:10px;font-family:var(--font);color:var(--t1);background:var(--bg);box-sizing:border-box;" />
          </div>
          <div style="min-width:0;">
            <label style="font-size:9px;font-weight:500;color:var(--t2);display:block;margin-bottom:2px;">Unit</label>
            <select id="sc-hyp-unit" onchange="scSyncCustomUnitVisibility()" style="width:100%;height:26px;border:1px solid var(--divider);border-radius:5px;padding:0 5px;font-size:10px;font-family:var(--font);color:var(--t1);background:var(--bg);box-sizing:border-box;">
              ${_scOutcomeUnitOptionsHTML(p?p.unit:'')}
            </select>
          </div>
        </div>
        <div id="sc-hyp-custom-label-row" style="display:${p&&p.unit==='custom'?'block':'none'};">
          <label style="font-size:9px;font-weight:500;color:var(--t2);display:block;margin-bottom:2px;">Custom unit label</label>
          <input id="sc-hyp-custom-label" type="text" maxlength="20" value="${p?e(p.customLabel||''):''}" placeholder="e.g. tickets/week"
            style="width:100%;height:26px;border:1px solid var(--divider);border-radius:5px;padding:0 7px;font-size:10px;font-family:var(--font);color:var(--t1);background:var(--bg);box-sizing:border-box;" />
        </div>
        <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 70px;gap:6px;align-items:end;">
          <div style="min-width:0;">
            <label style="font-size:9px;font-weight:500;color:var(--t2);display:block;margin-bottom:2px;">Baseline</label>
            <input id="sc-hyp-baseline" type="number" step="any" value="${p&&p.baseline!==null&&p.baseline!==undefined?p.baseline:''}" placeholder="18" oninput="scRecomputeHypDirection()"
              style="width:100%;height:26px;border:1px solid var(--divider);border-radius:5px;padding:0 7px;font-size:10px;font-family:var(--font);color:var(--t1);background:var(--bg);box-sizing:border-box;" />
          </div>
          <div style="min-width:0;">
            <label style="font-size:9px;font-weight:500;color:var(--t2);display:block;margin-bottom:2px;">Target</label>
            <input id="sc-hyp-target" type="number" step="any" value="${p&&p.target!==null&&p.target!==undefined?p.target:''}" placeholder="12" oninput="scRecomputeHypDirection()"
              style="width:100%;height:26px;border:1px solid var(--divider);border-radius:5px;padding:0 7px;font-size:10px;font-family:var(--font);color:var(--t1);background:var(--bg);box-sizing:border-box;" />
          </div>
          <div style="min-width:0;">
            <label style="font-size:9px;font-weight:500;color:var(--t2);display:block;margin-bottom:2px;">Direction</label>
            <select id="sc-hyp-direction" onchange="scMarkDirectionManual()" style="width:100%;height:26px;border:1px solid var(--divider);border-radius:5px;padding:0 4px;font-size:9px;font-weight:600;color:var(--purple);background:var(--purple-pale);box-sizing:border-box;">
              <option value="" ${!p||!p.direction?'selected':''}>—</option>
              <option value="decrease" ${p&&p.direction==='decrease'?'selected':''}>↓ Decrease</option>
              <option value="increase" ${p&&p.direction==='increase'?'selected':''}>↑ Increase</option>
            </select>
          </div>
        </div>
        <input type="hidden" id="sc-hyp-direction-source" value="${p?(p.directionSource||'computed'):'computed'}" />
        <div>
          <label style="font-size:9px;font-weight:500;color:var(--t2);display:block;margin-bottom:2px;">Rationale <span style="font-size:8.5px;color:var(--label);">${isEdit?'(AI reasoning, editable)':'(optional)'}</span></label>
          <textarea id="sc-hyp-rationale" maxlength="280" placeholder="Why do you expect this outcome?"
            style="width:100%;height:38px;border:1px solid var(--divider);border-radius:5px;padding:6px 7px;font-size:10px;font-family:var(--font);color:var(--t1);background:var(--bg);resize:none;box-sizing:border-box;">${p?e(p.rationale||''):''}</textarea>
        </div>
        <div style="border-top:0.5px dashed var(--divider);padding-top:7px;display:flex;align-items:center;justify-content:space-between;">
          <div style="font-size:9px;font-weight:700;color:var(--label);text-transform:uppercase;letter-spacing:0.5px;">Secondary Hypothesis <span style="font-weight:400;text-transform:none;">(max 2)</span></div>
          <div id="sc-hyp-add-secondary-btn" onclick="scAddSecondaryHypRow()" style="font-size:10px;color:var(--purple);cursor:pointer;font-weight:600;">+ Add</div>
        </div>
        <div id="sc-hyp-secondary-rows"></div>
      </div>
    </div>
  `;
}

// ── Render the secondary hypothesis rows from the working array ──
// Scoped to an explicit root (v9.10.02 feedback round, adversarially
// found): the original implementation used a global
// document.getElementById(), which — combined with this overlay's fixed,
// non-unique id and no prior duplicate-open guard — could theoretically
// paint into a stale/wrong modal instance if two ever coexisted. Now
// requires the caller's own overlay element, falling back to
// document only if no root is passed (defensive, should not be relied on).
function scRenderSecondaryHypRows(root){
  const scope=root||document;
  const container=scope.querySelector?scope.querySelector('#sc-hyp-secondary-rows'):document.getElementById('sc-hyp-secondary-rows');
  if(!container)return;
  let h='';
  _scAddFeatSecondary.forEach((s,i)=>{
    h+=`
      <div style="border:1px solid var(--divider);border-radius:5px;padding:7px;display:flex;flex-direction:column;gap:5px;margin-bottom:5px;">
        <div style="display:grid;grid-template-columns:minmax(0,1fr) 70px 18px;gap:5px;">
          <input type="text" maxlength="60" value="${e(s.metric||'')}" placeholder="e.g. Time to first order" oninput="scUpdateSecondaryHyp(${i},'metric',this.value)"
            style="min-width:0;height:22px;border:1px solid var(--divider);border-radius:4px;padding:0 6px;font-size:9.5px;font-family:var(--font);color:var(--t1);background:var(--bg);box-sizing:border-box;" />
          <select onchange="scUpdateSecondaryHyp(${i},'unit',this.value)" style="min-width:0;height:22px;border:1px solid var(--divider);border-radius:4px;font-size:9px;font-family:var(--font);color:var(--t1);background:var(--bg);box-sizing:border-box;">
            ${_scOutcomeUnitOptionsHTML(s.unit)}
          </select>
          <div onclick="scRemoveSecondaryHypRow(${i})" style="min-width:0;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--t3);" title="Remove">
            <i class="ti ti-x" style="font-size:11px;" aria-hidden="true"></i>
          </div>
        </div>
        ${s.unit==='custom'?`<input type="text" maxlength="20" value="${e(s.customLabel||'')}" placeholder="Custom unit label" oninput="scUpdateSecondaryHyp(${i},'customLabel',this.value)"
          style="height:20px;border:1px solid var(--divider);border-radius:4px;padding:0 6px;font-size:9px;font-family:var(--font);color:var(--t1);background:var(--bg);box-sizing:border-box;width:100%;" />`:''}
        <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 70px;gap:5px;">
          <input type="number" step="any" value="${s.baseline!==null&&s.baseline!==undefined?s.baseline:''}" placeholder="Baseline" oninput="scUpdateSecondaryHyp(${i},'baseline',this.value)"
            style="min-width:0;height:22px;border:1px solid var(--divider);border-radius:4px;padding:0 6px;font-size:9.5px;font-family:var(--font);color:var(--t1);background:var(--bg);box-sizing:border-box;" />
          <input type="number" step="any" value="${s.target!==null&&s.target!==undefined?s.target:''}" placeholder="Target" oninput="scUpdateSecondaryHyp(${i},'target',this.value)"
            style="min-width:0;height:22px;border:1px solid var(--divider);border-radius:4px;padding:0 6px;font-size:9.5px;font-family:var(--font);color:var(--t1);background:var(--bg);box-sizing:border-box;" />
          <select onchange="scMarkSecondaryDirectionManual(${i});scUpdateSecondaryHyp(${i},'direction',this.value)" style="min-width:0;height:22px;border:1px solid var(--divider);border-radius:4px;padding:0 4px;font-size:8.5px;font-weight:600;color:var(--purple);background:var(--purple-pale);box-sizing:border-box;">
            <option value="" ${!s.direction?'selected':''}>—</option>
            <option value="decrease" ${s.direction==='decrease'?'selected':''}>↓ Decr.</option>
            <option value="increase" ${s.direction==='increase'?'selected':''}>↑ Incr.</option>
          </select>
        </div>
      </div>
    `;
  });
  container.innerHTML=h;
}

// ── Find whichever hypothesis-capturing overlay is currently open ──
// Add and Edit Feature modals share this same section builder but have
// different overlay ids — this resolves to whichever one actually exists
// right now, so the secondary-row handlers below stay correctly scoped
// regardless of which modal invoked them, without needing every inline
// onclick/oninput handler to pass a reference through.
function _scActiveHypOverlay(){
  return document.getElementById('sc-edit-feat-overlay')||document.getElementById('sc-add-feat-overlay')||document;
}

function scAddSecondaryHypRow(){
  if(_scAddFeatSecondary.length>=2)return;
  _scAddFeatSecondary.push({metric:'',unit:'',customLabel:'',baseline:null,target:null,direction:'',directionSource:'computed',actual:null});
  scRenderSecondaryHypRows(_scActiveHypOverlay());
  const addBtn=document.getElementById('sc-hyp-add-secondary-btn');
  if(addBtn)addBtn.style.display=_scAddFeatSecondary.length>=2?'none':'';
}

function scRemoveSecondaryHypRow(idx){
  _scAddFeatSecondary.splice(idx,1);
  scRenderSecondaryHypRows(_scActiveHypOverlay());
  const addBtn=document.getElementById('sc-hyp-add-secondary-btn');
  if(addBtn)addBtn.style.display='';
}

function scUpdateSecondaryHyp(idx,field,value){
  if(!_scAddFeatSecondary[idx])return;
  _scAddFeatSecondary[idx][field]=(field==='baseline'||field==='target')?(value===''?null:Number(value)):value;
  if(field==='baseline'||field==='target'){
    const s=_scAddFeatSecondary[idx];
    // v9.10.03 (BUILD-3): never silently overwrite a manual direction
    // override on baseline/target edit — matches primary's exact
    // discipline in scRecomputeHypDirection(), now that secondary's
    // Direction is a real, clickable control instead of a computed-only
    // display (per explicit consistency decision — secondary and primary
    // must behave identically, not just look similar).
    if(s.directionSource==='manual')return;
    const computed=computeDirection(s.baseline,s.target);
    if(computed)s.direction=computed;
    s.directionSource='computed';
  }
  if(field==='unit')scRenderSecondaryHypRows(_scActiveHypOverlay()); // re-render to show/hide custom label input
}

// ── Mark a specific secondary row's direction as manually overridden ──
// v9.10.03 (BUILD-3): secondary equivalent of scMarkDirectionManual(),
// indexed since there can be up to 2 secondary rows. Called from the
// row's own Direction <select> onchange, before scUpdateSecondaryHyp()
// writes the new value — order matters, since scUpdateSecondaryHyp's own
// baseline/target guard checks this flag.
function scMarkSecondaryDirectionManual(idx){
  if(_scAddFeatSecondary[idx])_scAddFeatSecondary[idx].directionSource='manual';
}

// ── Direction recompute + manual-override tracking (primary only) ──
function scRecomputeHypDirection(){
  const srcEl=document.getElementById('sc-hyp-direction-source');
  if(srcEl&&srcEl.value==='manual')return; // never silently overwrite a manual override
  const bEl=document.getElementById('sc-hyp-baseline'),tEl=document.getElementById('sc-hyp-target'),dEl=document.getElementById('sc-hyp-direction');
  if(!bEl||!tEl||!dEl)return;
  const computed=computeDirection(bEl.value===''?null:Number(bEl.value),tEl.value===''?null:Number(tEl.value));
  dEl.value=computed||'';
}
function scMarkDirectionManual(){
  const srcEl=document.getElementById('sc-hyp-direction-source');
  if(srcEl)srcEl.value='manual';
}

function scSyncCustomUnitVisibility(){
  const unitEl=document.getElementById('sc-hyp-unit'),row=document.getElementById('sc-hyp-custom-label-row');
  if(!unitEl||!row)return;
  row.style.display=unitEl.value==='custom'?'block':'none';
}

function scToggleHypSection(){
  const body=document.getElementById('sc-hyp-body'),chev=document.getElementById('sc-hyp-chevron');
  if(!body)return;
  const collapsed=body.style.display==='none';
  body.style.display=collapsed?'flex':'none';
  if(chev)chev.style.transform=collapsed?'':'rotate(-90deg)';
}

// ── Manual vs AI-generate toggle (Add Feature modal only) ──
let _scHypEntryMode='manual';
// ── Repaint-only: swaps the two buttons' visual highlight, no side effects ──
// v9.10.03 (BUILD-1): extracted out of scSetHypEntryMode() specifically so
// the auto-switch path (scAddFeatSyncAIGate below) can repaint the
// highlight WITHOUT also triggering AI generation. Previously the
// auto-switch called scSetHypEntryMode('ai') directly, which unconditionally
// calls scGenerateHypWithAI() as a side effect of switching modes — meaning
// the mere act of typing the first character into Feature Name silently
// launched a real API call before the user ever asked for one. Real button
// clicks still go through scSetHypEntryMode(), which calls this AND the
// trigger; only the silent auto-switch now calls this alone.
function _scPaintHypEntryMode(mode){
  const manualBtn=document.getElementById('sc-hyp-mode-manual'),aiBtn=document.getElementById('sc-hyp-mode-ai');
  if(!manualBtn||!aiBtn)return;
  if(mode==='manual'){
    manualBtn.style.cssText='flex:1;text-align:center;padding:7px;border:1.5px solid var(--purple);background:var(--purple-pale);border-radius:5px;font-size:10px;font-weight:600;color:var(--purple);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;';
    aiBtn.style.cssText='flex:1;text-align:center;padding:7px;border:1.5px solid var(--divider);border-radius:5px;font-size:10px;font-weight:600;color:var(--t2);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;background:#fff;';
  } else {
    aiBtn.style.cssText='flex:1;text-align:center;padding:7px;border:1.5px solid var(--purple);background:var(--purple-pale);border-radius:5px;font-size:10px;font-weight:600;color:var(--purple);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;';
    manualBtn.style.cssText='flex:1;text-align:center;padding:7px;border:1.5px solid var(--divider);border-radius:5px;font-size:10px;font-weight:600;color:var(--t2);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;background:#fff;';
  }
}

function scSetHypEntryMode(mode){
  const nameEl=document.getElementById('sc-add-feat-name');
  if(mode==='ai'&&(!nameEl||!nameEl.value.trim()))return; // gated — no-op if name empty
  _scHypEntryMode=mode;
  _scPaintHypEntryMode(mode);
  if(mode==='ai')scGenerateHypWithAI();
}

// ── Sync the AI-generate button's enabled/disabled visual state as the name field changes ──
// v9.10.02 (item 5 fix): the highlight auto-switches from "Enter manually"
// to "Generate with AI" the FIRST time a name becomes non-empty, guiding
// the user toward the faster path. Tracked via _scAiGateAutoSwitched so
// this only fires once per modal-open, not on every keystroke — otherwise
// a user who deliberately clicks back to "Enter manually" would have
// their choice silently reverted on their very next keystroke.
// v9.10.03 (BUILD-1 fix): this now calls _scPaintHypEntryMode() directly —
// the repaint-only function — instead of scSetHypEntryMode(), which would
// also silently trigger a real AI generation call on every first keystroke.
let _scAiGateAutoSwitched=false;
function scAddFeatSyncAIGate(){
  const nameEl=document.getElementById('sc-add-feat-name'),aiBtn=document.getElementById('sc-hyp-mode-ai'),note=document.getElementById('sc-hyp-ai-gate-note');
  if(!nameEl||!aiBtn)return;
  const hasName=!!nameEl.value.trim();
  aiBtn.style.cursor=hasName?'pointer':'not-allowed';
  if(note)note.style.display=hasName?'none':'';
  if(hasName&&!_scAiGateAutoSwitched&&_scHypEntryMode==='manual'){
    _scAiGateAutoSwitched=true;
    _scHypEntryMode='ai';
    _scPaintHypEntryMode('ai'); // repaint only — does NOT call scGenerateHypWithAI()
    return;
  }
  // Keep the enabled/disabled visual distinct even when not auto-switching
  // (e.g. name becomes empty again after being filled) — only touch color/
  // background here, never override an active highlight's border/bg.
  if(_scHypEntryMode!=='ai'){
    aiBtn.style.color=hasName?'var(--t2)':'var(--label)';
    aiBtn.style.background=hasName?'#fff':'var(--card)';
  }
}

// ── On-demand AI hypothesis generation for the Add Feature modal ──
// Reuses buildCapFeaturesPrompt-adjacent context where available but is a
// lighter, single-feature-scoped call — this is NOT the Capability Canvas
// generation path (§4.1), it's the manual-add on-demand path (§4.3).
async function scGenerateHypWithAI(){
  const nameEl=document.getElementById('sc-add-feat-name'),whyEl=document.getElementById('sc-add-feat-why'),capEl=document.getElementById('sc-add-feat-cap');
  if(!nameEl||!nameEl.value.trim())return;
  const featureName=nameEl.value.trim();
  const why=whyEl?whyEl.value.trim():'';
  const capName=capEl?capEl.value:'';
  const nsm=(typeof gData!=='undefined'&&gData&&gData.nsm)?gData.nsm.metric:'';
  const bodyEl=document.getElementById('sc-hyp-body');
  const _prevContent=bodyEl?bodyEl.innerHTML:'';
  // Stale-callback guard (v9.10.02 feedback round, adversarially found):
  // this is a real await boundary — the modal that started this request
  // could be closed (or, now that a duplicate-open guard exists elsewhere,
  // a fresh instance of the SAME modal could be reopened) before this
  // resolves. Snapshot the overlay element itself here, before the await,
  // and re-check its presence/identity in the DOM after — never assume
  // the ids this function reads/writes still belong to the same modal
  // instance that triggered the request.
  const _triggeringOverlay=document.getElementById('sc-add-feat-overlay');
  if(bodyEl)bodyEl.innerHTML=`<div style="display:flex;align-items:center;justify-content:center;padding:24px 0;gap:8px;color:var(--t3);font-size:11px;"><div class="cc-spin" style="width:16px;height:16px;border-width:2px;"></div> Generating hypothesis…</div>`;
  try{
    const sys='You are a senior product strategist. Respond ONLY with valid JSON. No markdown, no backticks, no preamble.';
    const usr=`Feature: "${featureName}"\n${why?'Why it matters: '+why+'\n':''}${capName?'Capability: '+capName+'\n':''}${nsm?'North Star Metric: '+nsm+'\n':''}\n`
      +`Suggest a single outcome hypothesis this feature should be expected to move.\n`
      +`Return ONLY this JSON: {"metric":"specific metric name","unit":"one of: ${OUTCOME_HYP_UNITS.join(', ')}","baseline":number,"target":number,"rationale":"one sentence, concrete mechanism, max 30 words"}\n`
      +`Rules: baseline and target must be plausible, realistic numeric estimates for this metric — never placeholders like 0 or 100 unless genuinely appropriate. unit must be exactly one of the listed values. rationale must end with a short, explicit note that baseline/target are an industry-plausible estimate, not the client's actual data (e.g. "(estimate - replace with your actual baseline once known)") — this still counts toward the 30-word max.`;
    const txt=await callAPI(sys,usr,800,undefined,undefined,'sc-add-feat-hyp-gen');
    // Re-check after the only await in this function — if the triggering
    // overlay is no longer in the document (closed, or replaced by a new
    // instance via the duplicate-open guard), abandon silently rather
    // than writing stale results into whatever now occupies these ids.
    if(!_triggeringOverlay||!document.body.contains(_triggeringOverlay))return;
    const clean=txt.replace(/```json|```/g,'').trim();
    let parsed;
    try{parsed=JSON.parse(clean);}
    catch(pe){const s=clean.indexOf('{'),l=clean.lastIndexOf('}');if(s>=0&&l>s){parsed=JSON.parse(clean.substring(s,l+1));}else throw pe;}
    if(bodyEl)bodyEl.innerHTML=_prevContent;
    scRenderSecondaryHypRows(_triggeringOverlay);
    const mEl=document.getElementById('sc-hyp-metric'),uEl=document.getElementById('sc-hyp-unit'),bEl=document.getElementById('sc-hyp-baseline'),tEl=document.getElementById('sc-hyp-target'),rEl=document.getElementById('sc-hyp-rationale');
    if(mEl)mEl.value=parsed.metric||'';
    if(uEl&&OUTCOME_HYP_UNITS.includes(parsed.unit))uEl.value=parsed.unit;
    if(bEl)bEl.value=parsed.baseline!==undefined&&parsed.baseline!==null?parsed.baseline:'';
    if(tEl)tEl.value=parsed.target!==undefined&&parsed.target!==null?parsed.target:'';
    if(rEl)rEl.value=parsed.rationale||'';
    scRecomputeHypDirection();
  }catch(err){
    if(!_triggeringOverlay||!document.body.contains(_triggeringOverlay))return;
    if(bodyEl)bodyEl.innerHTML=_prevContent;
    scRenderSecondaryHypRows(_triggeringOverlay);
    if(typeof showToast==='function')showToast('Could not generate hypothesis. You can enter it manually.','warn');
  }
}

// ── Read the Outcome Hypothesis section's current DOM state into an object ──
// Used identically by scDoAddFeat() and scDoEditFeat(). Returns null when
// the metric field is empty (no hypothesis was entered) — never returns a
// half-populated object with an empty metric name.
function scReadOutcomeHypothesisFromDOM(existingSource){
  const mEl=document.getElementById('sc-hyp-metric');
  if(!mEl)return null;
  const metric=mEl.value.trim();
  if(!metric)return null;
  const uEl=document.getElementById('sc-hyp-unit'),clEl=document.getElementById('sc-hyp-custom-label');
  const bEl=document.getElementById('sc-hyp-baseline'),tEl=document.getElementById('sc-hyp-target');
  const dEl=document.getElementById('sc-hyp-direction'),dsEl=document.getElementById('sc-hyp-direction-source');
  const rEl=document.getElementById('sc-hyp-rationale');
  const baseline=bEl&&bEl.value!==''?Number(bEl.value):null;
  const target=tEl&&tEl.value!==''?Number(tEl.value):null;
  const primary={
    metric,
    unit:uEl?uEl.value:'',
    customLabel:uEl&&uEl.value==='custom'&&clEl?clEl.value.trim():'',
    baseline,target,
    direction:dEl?(dEl.value||null):null,
    directionSource:dsEl?dsEl.value:'computed',
    rationale:rEl?rEl.value.trim():'',
    source:existingSource==='ai'?'ai-edited':(existingSource||'manual'),
    actual:null,signal:null,loggedAt:null
  };
  const secondary=_scAddFeatSecondary
    .filter(s=>s.metric&&s.metric.trim())
    .slice(0,2)
    .map(s=>({
      metric:s.metric.trim(),unit:s.unit||'',customLabel:s.unit==='custom'?(s.customLabel||''):'',
      baseline:s.baseline!==undefined?s.baseline:null,target:s.target!==undefined?s.target:null,
      direction:s.direction||null,directionSource:s.directionSource||'computed',actual:null
    }));
  return{primary,secondary};
}

// ══════════════════════════════════════════════════════════════════════
// END Outcome Verification Loop shared modal section
// ══════════════════════════════════════════════════════════════════════

function scAddFeatValidate(){
  const nameEl=document.getElementById('sc-add-feat-name');
  const capEl=document.getElementById('sc-add-feat-cap');
  const errEl=document.getElementById('sc-add-feat-name-err');
  const submitEl=document.getElementById('sc-add-feat-submit');
  if(!nameEl||!capEl||!errEl||!submitEl)return;
  const val=nameEl.value.trim();
  const capVal=capEl.value;
  if(!val){
    nameEl.style.borderColor='var(--divider)';
    errEl.style.display='none';
    submitEl.disabled=true;
    return;
  }
  // Duplicate check — case insensitive across scCanvas
  const lower=val.toLowerCase();
  const isDupe=scCanvas.some(f=>f.name.toLowerCase()===lower);
  if(isDupe){
    nameEl.style.borderColor='var(--red)';
    errEl.style.display='flex';
    submitEl.disabled=true;
    return;
  }
  nameEl.style.borderColor=val?'var(--purple)':'var(--divider)';
  errEl.style.display='none';
  // Both name and capability required
  submitEl.disabled=!(val&&capVal);
}

function scDoAddFeat(){
  const nameEl=document.getElementById('sc-add-feat-name');
  const whyEl=document.getElementById('sc-add-feat-why');
  const capEl=document.getElementById('sc-add-feat-cap');
  if(!nameEl||!capEl)return;
  const name=nameEl.value.trim();
  const why=whyEl?whyEl.value.trim():'';
  const cap=capEl.value;
  if(!name||!cap)return;
  // Resolve metric and stage from capStore
  let metric=cap;
  let stage=typeof getPiStageLabel==='function'?getPiStageLabel(gData):'Custom Value Stage';
  let metricPath=cap;
  let _bucketIdForFeature=null;
  if(typeof capStore!=='undefined'){
    for(const[mk,entry]of Object.entries(capStore)){
      const found=(entry.capabilities||[]).find(c=>c.name===cap);
      if(found){
        metric=entry.metricName||cap;
        stage=entry.stageLabel||(typeof getPiStageLabel==='function'?getPiStageLabel(gData):'Custom Value Stage');
        metricPath=scGetMetricPath(metric);
        _bucketIdForFeature=entry.bucketId||null;
        break;
      }
    }
  }
  const fid=scMakeFeatureId(metric,cap,name);
  // Guard against duplicate id
  if(scCanvas.find(x=>x.id===fid)){
    showToast('A feature with this name already exists on the canvas.','warn');
    return;
  }
  // Outcome Verification Loop: read whatever hypothesis was entered (manual
  // or AI-generated), or null if the metric field was left empty.
  const outcomeHypothesis=scReadOutcomeHypothesisFromDOM('manual');
  // v9.06.02: originBucketId hardening (going forward only, per ChatGPT
  // review — no backfill of existing features, since the field never
  // existed before). Enables a future, more precise identity-based rename
  // match than stage+name alone, for any feature created from this point on.
  scCanvas.push({id:fid,metric,metricPath,stage,cap,name,why,stories:null,origin:'pi',originBucketId:_bucketIdForFeature,outcomeHypothesis});
  // Close modal
  const overlay=document.getElementById('sc-add-feat-overlay');
  if(overlay)overlay.remove();
  fcUpdateTabBadge();
  fcRenderCanvas();
  // Auto-scroll to new feature card and open its story panel
  requestAnimationFrame(()=>{
    requestAnimationFrame(()=>{
      const _card=document.getElementById('sc-card-'+fid);
      if(_card)_card.scrollIntoView({behavior:'smooth',block:'center'});
      scOpenPanel(fid);
    });
  });
  showToast(`"${name}" added under ${cap}.`,'success');
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('sc',fid+_LS_SC_TARGET_SEP); });
  }
}

// ── Upload Features from file (C2-C4, v7.84) ──
// Modal 1: file upload using the Feature/Description/Capability template.
function scShowUploadFeatModal(){
  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.id='sc-upload-feat-overlay';
  overlay.innerHTML=`<div class="modal" style="max-width:420px;position:relative;">
    <button onclick="document.getElementById('sc-upload-feat-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:16px 44px 14px 16px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:500;color:var(--t1);">Upload Features</div>
    </div>
    <div class="modal-body" style="font-size:11px;color:var(--t3);line-height:1.5;">Upload a file of features to add. Each row must map to a capability already on the canvas - unmatched rows can be mapped manually or removed before adding.</div>
    <div style="padding:0 20px 4px;">
      <div class="cc-upload-row" id="sc-feat-upload-row" onclick="document.getElementById('sc-feat-upload-input').click()">
        <i class="ti ti-upload" style="font-size:13px;color:var(--purple);flex-shrink:0;" aria-hidden="true"></i>
        <span class="cc-upload-row-label">Click to upload</span>
        <span class="cc-upload-row-types">.xlsx &middot; .csv</span>
        <a href="assets/templates/capability-features-template.xlsx" class="cc-template-link" onclick="event.stopPropagation()" style="margin-left:auto;"><i class="ti ti-download" style="font-size:11px;" aria-hidden="true"></i> Template</a>
      </div>
      <input type="file" id="sc-feat-upload-input" accept=".xlsx,.csv" style="display:none" onchange="scHandleFeatUpload(this)">
      <div id="sc-feat-upload-result"></div>
    </div>
    <div class="modal-footer">
      <button class="modal-cancel-btn" onclick="document.getElementById('sc-upload-feat-overlay').remove()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const _escHandler=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_escHandler,true);}};
  document.addEventListener('keydown',_escHandler,true);
  trapFocus(overlay);
}

function scHandleFeatUpload(input){
  const file=input.files&&input.files[0];
  if(!file)return;
  const ext=file.name.split('.').pop().toLowerCase();
  const resultEl=document.getElementById('sc-feat-upload-result');
  if(resultEl)resultEl.innerHTML='<div class="cc-parse-loading"><div class="cc-spin-sm"></div> Reading file…</div>';
  if(ext==='csv'){
    const reader=new FileReader();
    reader.onload=ev=>_scParseFeatCSV(ev.target.result);
    reader.readAsText(file);
  } else if(ext==='xlsx'){
    const reader=new FileReader();
    reader.onload=ev=>{
      if(typeof XLSX==='undefined'){
        const s=document.createElement('script');
        s.src='https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
        s.onload=()=>_scParseFeatXLSX(ev.target.result);
        s.onerror=()=>_scShowFeatUploadError('Could not load XLSX library. Check internet connection.');
        document.head.appendChild(s);
      } else {
        _scParseFeatXLSX(ev.target.result);
      }
    };
    reader.readAsArrayBuffer(file);
  } else {
    _scShowFeatUploadError('Unsupported file type. Use .xlsx or .csv.');
  }
  input.value='';
}

function _scParseFeatXLSX(arrayBuffer){
  try{
    const wb=XLSX.read(arrayBuffer,{type:'array'});
    const ws=wb.Sheets[wb.SheetNames[0]];
    const data=XLSX.utils.sheet_to_json(ws,{defval:''});
    if(!data||data.length===0){_scShowFeatUploadError('File appears empty.');return;}
    const firstRow=data[0];
    const keys=Object.keys(firstRow).map(k=>k.toLowerCase().trim());
    const featKey=Object.keys(firstRow)[keys.indexOf('feature')]||Object.keys(firstRow)[keys.indexOf('features')];
    const descKey=Object.keys(firstRow)[keys.indexOf('description')];
    const capKey=Object.keys(firstRow)[keys.indexOf('capability')]||Object.keys(firstRow)[keys.indexOf('capabilities')];
    if(!featKey){_scShowFeatUploadError('Could not find a "Feature" column.');return;}
    const rows=[];
    data.forEach(row=>{
      const name=String(row[featKey]||'').trim();
      if(!name)return;
      rows.push({
        name,
        description:descKey?String(row[descKey]||'').trim():'',
        capRaw:capKey?String(row[capKey]||'').trim():''
      });
    });
    _scFinalizeFeatUpload(rows);
  }catch(err){
    _scShowFeatUploadError('Could not read file: '+err.message);
  }
}

function _scParseFeatCSV(text){
  try{
    const lines=text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l.length>0);
    if(lines.length===0){_scShowFeatUploadError('File appears empty.');return;}
    const header=lines[0].split(',').map(h=>h.trim().toLowerCase());
    const featIdx=header.indexOf('feature')>=0?header.indexOf('feature'):header.indexOf('features');
    const descIdx=header.indexOf('description');
    const capIdx=header.indexOf('capability')>=0?header.indexOf('capability'):header.indexOf('capabilities');
    if(featIdx<0){_scShowFeatUploadError('Could not find a "Feature" column.');return;}
    const rows=[];
    for(let i=1;i<lines.length;i++){
      const cols=lines[i].split(',').map(c=>c.trim());
      const name=cols[featIdx]||'';
      if(!name)continue;
      rows.push({
        name,
        description:descIdx>=0?(cols[descIdx]||''):'',
        capRaw:capIdx>=0?(cols[capIdx]||''):''
      });
    }
    _scFinalizeFeatUpload(rows);
  }catch(err){
    _scShowFeatUploadError('Could not read file: '+err.message);
  }
}

function _scShowFeatUploadError(msg){
  const resultEl=document.getElementById('sc-feat-upload-result');
  if(resultEl)resultEl.innerHTML=`<div class="cc-parse-error"><i class="ti ti-alert-circle" style="font-size:11px;" aria-hidden="true"></i> ${e(msg)}</div>`;
}

// Modal 2: review/map table — every row must map to an existing capability
// (mapTo: metricKey|cap pair, encoded as "capName") or be removed before confirm.
let _scUploadFeatRows=[];

function _scGetAllCapNames(){
  const capSet=new Set();
  if(typeof capStore!=='undefined'){
    Object.values(capStore).forEach(entry=>{(entry.capabilities||[]).forEach(c=>{if(c.name)capSet.add(c.name);});});
  }
  scCanvas.forEach(f=>{if(f.cap)capSet.add(f.cap);});
  return[...capSet].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()));
}

function _scFinalizeFeatUpload(rows){
  if(!rows||rows.length===0){_scShowFeatUploadError('No features found. Check the format.');return;}
  const capNames=_scGetAllCapNames();
  _scUploadFeatRows=rows.map(r=>{
    let mapTo=null;
    if(r.capRaw){
      const match=capNames.find(c=>ccFuzzyMatch(c.toLowerCase(),r.capRaw.toLowerCase()));
      if(match)mapTo=match;
    }
    return{name:r.name,description:r.description,mapTo,removed:false};
  });
  const uploadOverlay=document.getElementById('sc-upload-feat-overlay');
  if(uploadOverlay)uploadOverlay.remove();
  scShowFeatReviewModal();
}

function scShowFeatReviewModal(){
  const capNames=_scGetAllCapNames();
  const optsBase=`<option value="">— Select a capability —</option>`+capNames.map(c=>`<option value="${e(c)}">${e(c)}</option>`).join('');

  const rowsHtml=_scUploadFeatRows.map((r,idx)=>{
    if(r.removed)return ''; // removed rows are dropped from the table entirely
    const isUnresolved=!r.mapTo;
    let opts=`<option value=""${!r.mapTo?' selected':''}>— Select a capability —</option>`;
    capNames.forEach(c=>{opts+=`<option value="${e(c)}"${r.mapTo===c?' selected':''}>${e(c)}</option>`;});
    return `<div class="cc-cap-review-row${isUnresolved?' cc-cap-review-row-error':''}">
      <div class="cc-cap-review-name">${e(r.name)}</div>
      <div class="cc-cap-review-desc">${e(r.description||'—')}</div>
      <div class="cc-cap-review-mapsto${isUnresolved?' cc-cap-review-mapsto-error':''}">
        <select onchange="_scUploadFeatRows[${idx}].mapTo=this.value||null;scRefreshFeatReviewSummary()">${opts}</select>
        <a class="cc-cap-review-remove" onclick="_scUploadFeatRows[${idx}].removed=true;scRefreshFeatReviewSummary()" title="Remove this row"><i class="ti ti-x" aria-hidden="true"></i></a>
      </div>
    </div>`;
  }).join('');

  const remaining=_scUploadFeatRows.filter(r=>!r.removed);
  const unresolvedCount=remaining.filter(r=>!r.mapTo).length;
  const resolvedCount=remaining.length-unresolvedCount;

  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.id='sc-feat-review-overlay';
  overlay.innerHTML=`<div class="modal" style="max-width:620px;position:relative;">
    <button onclick="document.getElementById('sc-feat-review-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:16px 44px 14px 16px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:500;color:var(--t1);">Review features before adding</div>
      <div style="font-size:11px;color:var(--t3);margin-top:4px;">${remaining.length} feature${remaining.length===1?'':'s'} found. Every feature must map to a capability.</div>
    </div>
    <div style="padding:12px 16px 0;max-height:50vh;overflow-y:auto;" id="sc-feat-review-rows">
      <div class="cc-cap-review-row cc-cap-review-hdr">
        <div>Feature</div><div>Description</div><div>Maps to</div>
      </div>
      ${rowsHtml}
    </div>
    <div style="padding:0 16px;">
      <div id="sc-feat-review-summary" class="${unresolvedCount>0?'cc-parse-error':'cc-parse-ok'}" style="margin:12px 0 0;">${scFeatReviewSummaryText(resolvedCount,unresolvedCount)}</div>
    </div>
    <div class="modal-footer">
      <button class="modal-cancel-btn" onclick="document.getElementById('sc-feat-review-overlay').remove()">Cancel</button>
      <button class="modal-confirm-btn" id="sc-feat-review-confirm" ${unresolvedCount>0?'disabled':''} onclick="scConfirmFeatUpload()">Add ${resolvedCount} feature${resolvedCount===1?'':'s'}</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const _escHandler=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_escHandler,true);}};
  document.addEventListener('keydown',_escHandler,true);
  trapFocus(overlay);
}

function scFeatReviewSummaryText(resolvedCount,unresolvedCount){
  if(unresolvedCount>0){
    return `<i class="ti ti-alert-circle" style="font-size:11px;" aria-hidden="true"></i> ${unresolvedCount} feature${unresolvedCount===1?'':'s'} need${unresolvedCount===1?'s':''} a capability before you can continue - map or remove ${unresolvedCount===1?'it':'them'}.`;
  }
  return `<i class="ti ti-check" style="font-size:11px;" aria-hidden="true"></i> All ${resolvedCount} feature${resolvedCount===1?'':'s'} mapped to a capability.`;
}

function scRefreshFeatReviewSummary(){
  const overlay=document.getElementById('sc-feat-review-overlay');
  const scrollEl=overlay?overlay.querySelector('#sc-feat-review-rows'):null;
  const scrollTop=scrollEl?scrollEl.scrollTop:0;
  if(overlay)overlay.remove();
  scShowFeatReviewModal();
  const newScrollEl=document.getElementById('sc-feat-review-rows');
  if(newScrollEl)newScrollEl.scrollTop=scrollTop;
}

// Confirm: batched equivalent of scDoAddFeat() per resolved row.
function scConfirmFeatUpload(){
  const remaining=_scUploadFeatRows.filter(r=>!r.removed&&r.mapTo);
  if(remaining.length===0){
    const overlay=document.getElementById('sc-feat-review-overlay');
    if(overlay)overlay.remove();
    _scUploadFeatRows=[];
    return;
  }

  let added=0,skippedDupes=0;
  const affectedCaps=new Set();

  remaining.forEach(r=>{
    const cap=r.mapTo;
    let metric=cap,stage=(typeof getPiStageLabel==='function'?getPiStageLabel(gData):'Custom Value Stage'),metricPath=cap;
    let _bucketIdForFeature=null;
    if(typeof capStore!=='undefined'){
      for(const[mk,entry]of Object.entries(capStore)){
        const found=(entry.capabilities||[]).find(c=>c.name===cap);
        if(found){
          metric=entry.metricName||cap;
          stage=entry.stageLabel||(typeof getPiStageLabel==='function'?getPiStageLabel(gData):'Custom Value Stage');
          metricPath=scGetMetricPath(metric);
          _bucketIdForFeature=entry.bucketId||null;
          break;
        }
      }
    }
    const fid=scMakeFeatureId(metric,cap,r.name);
    if(scCanvas.find(x=>x.id===fid)){skippedDupes++;return;}
    // v9.06.02: originBucketId hardening, same rationale as the manual
    // single-add site above.
    scCanvas.push({id:fid,metric,metricPath,stage,cap,name:r.name,why:r.description||'',stories:null,origin:'pi',originBucketId:_bucketIdForFeature});
    affectedCaps.add(cap);
    added++;
  });

  const overlay=document.getElementById('sc-feat-review-overlay');
  if(overlay)overlay.remove();
  _scUploadFeatRows=[];

  fcUpdateTabBadge();
  fcRenderCanvas();

  let msg=`${added} feature${added===1?'':'s'} added`;
  if(affectedCaps.size===1)msg+=` under ${[...affectedCaps][0]}`;
  else if(affectedCaps.size>1)msg+=` across ${affectedCaps.size} capabilities`;
  if(skippedDupes>0)msg+=` (${skippedDupes} skipped - already on canvas)`;
  showToast(msg,added>0?'success':'warn');
  // v8.147 fix: confirmed missing entirely — a bulk upload of possibly
  // many new features at once. One coarse mark per added feature.
  if(added>0&&!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    const _addedIds=remaining.filter(r=>!r.removed&&r.mapTo).map(r=>{
      const cap=r.mapTo;
      let metric=cap;
      if(typeof capStore!=='undefined'){
        for(const[mk,entry]of Object.entries(capStore)){
          const found=(entry.capabilities||[]).find(c=>c.name===cap);
          if(found){metric=entry.metricName||cap;break;}
        }
      }
      return scMakeFeatureId(metric,cap,r.name);
    });
    sessionStoreSave(_activeSessionId).then(function(ok){
      if(!ok||typeof _lsMarkManualEdit!=='function')return;
      _addedIds.forEach(function(id){ _lsMarkManualEdit('sc',id+_LS_SC_TARGET_SEP); });
    });
  }
}


// ── Edit Feature modal ──
function scShowEditFeatModal(fid){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat)return;

  // Duplicate-open guard (v9.10.02 feedback round) — see matching
  // comment in scShowAddFeatureModal() for the full rationale.
  const _existingEditOverlay=document.getElementById('sc-edit-feat-overlay');
  if(_existingEditOverlay)_existingEditOverlay.remove();

  // Build cap options
  const capSet=new Set();
  if(typeof capStore!=='undefined'){
    Object.values(capStore).forEach(entry=>{(entry.capabilities||[]).forEach(cap=>{if(cap.name)capSet.add(cap.name);});});
  }
  scCanvas.forEach(f=>{if(f.cap)capSet.add(f.cap);});
  const sortedCaps=[...capSet].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()));
  let capOpts='';
  sortedCaps.forEach(c=>{capOpts+=`<option value="${e(c)}"${c===feat.cap?' selected':''}>${e(c)}</option>`;});

  const hasStories=feat.stories&&feat.stories.length>0;
  const storyCount=hasStories?feat.stories.length:0;

  let warnHtml='';
  if(hasStories){
    warnHtml=`<div id="sc-edit-warn-strip" style="display:none;">
      <div style="background:#FAEEDA;border:0.5px solid #FAC775;border-radius:5px;padding:8px 10px;margin-top:4px;display:flex;gap:6px;align-items:flex-start;">
        <i class="ti ti-alert-triangle" style="font-size:11px;color:#633806;flex-shrink:0;margin-top:1px;" aria-hidden="true"></i>
        <span style="font-size:11px;color:#633806;line-height:1.4;">This feature has ${storyCount} stor${storyCount!==1?'ies':'y'}. Changing the description may make them inaccurate — they will need to be regenerated.</span>
      </div>
      <div style="display:flex;gap:8px;margin-top:14px;margin-bottom:14px;">
        <button class="modal-cancel-btn" style="flex:1;font-size:11px;padding:5px 12px;" onclick="scDoEditFeat('${e(fid)}','clear')">Clear Stories</button>
        <button class="modal-confirm-btn" style="flex:1;font-size:11px;padding:5px 12px;" onclick="scDoEditFeat('${e(fid)}','keep')">Keep Existing</button>
      </div>
    </div>`;
  }

  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.id='sc-edit-feat-overlay';
  overlay.innerHTML=`<div class="modal" style="max-width:400px;overflow-y:auto;max-height:80vh;position:relative;">
    <button onclick="document.getElementById('sc-edit-feat-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:16px 44px 14px 16px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:500;color:var(--t1);">Edit Feature</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;padding:14px 20px 4px;">
      <div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Feature Name<span style="color:var(--red);margin-left:1px;">*</span></label>
        <input id="sc-edit-feat-name" type="text" value="${e(feat.name)}"
          style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);background:var(--bg);"
          oninput="scEditFeatValidate('${e(feat.name)}')" />
        <div id="sc-edit-feat-name-err" style="display:none;font-size:9px;color:var(--red);margin-top:2px;align-items:center;gap:3px;">
          <i class="ti ti-alert-circle" style="font-size:9px;" aria-hidden="true"></i> A feature with this name already exists on the canvas.
        </div>
      </div>
      <div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Why It Matters <span style="font-size:9px;color:var(--label);">(Optional)</span></label>
        <textarea id="sc-edit-feat-why"
          style="width:100%;height:60px;border:1px solid var(--divider);border-radius:5px;padding:6px 8px;font-size:11px;font-family:var(--font);color:var(--t1);background:var(--bg);resize:none;"
          oninput="(function(){var s=document.getElementById('sc-edit-warn-strip');if(s)s.style.display='';var f=document.getElementById('sc-edit-feat-footer');if(s&&f)f.style.display='none';})()">${e(feat.why||'')}</textarea>
      </div>
      <div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Capability<span style="color:var(--red);margin-left:1px;">*</span></label>
        <div style="position:relative;">
          <select id="sc-edit-feat-cap"
            style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);background:var(--bg);appearance:none;">
            ${capOpts}
          </select>
          <i class="ti ti-chevron-down" style="position:absolute;right:8px;top:9px;font-size:10px;color:var(--label);pointer-events:none;" aria-hidden="true"></i>
        </div>
        <div style="font-size:9px;color:var(--label);margin-top:2px;">Changing this moves the feature to the selected capability.</div>
      </div>
      ${scBuildOutcomeHypothesisSectionHTML('edit',feat.outcomeHypothesis)}
      ${warnHtml}
    </div>
    <div class="modal-footer" id="sc-edit-feat-footer">
      <button class="modal-cancel-btn" onclick="document.getElementById('sc-edit-feat-overlay').remove()">Cancel</button>
      <button class="modal-confirm-btn" id="sc-edit-feat-submit" onclick="scDoEditFeat('${e(fid)}','keep')">Save Changes</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  // Bug 2 fix (v9.10.02 feedback round): scBuildOutcomeHypothesisSectionHTML()
  // already seeded _scAddFeatSecondary from feat.outcomeHypothesis.secondary
  // BEFORE this HTML was built — but the returned template only contains an
  // empty <div id="sc-hyp-secondary-rows"></div> placeholder. Nothing ever
  // painted the seeded data into it until now; previously the only thing
  // that did was a later, unrelated user action (clicking "+ Add"), which
  // is exactly the reported symptom (existing secondary hypotheses appeared
  // only after clicking Add). This call closes that gap directly.
  scRenderSecondaryHypRows(overlay);
  const _esc=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_esc,true);}};
  document.addEventListener('keydown',_esc,true);
  trapFocus(overlay);
  const nameEl=document.getElementById('sc-edit-feat-name');
  if(nameEl){nameEl.focus();nameEl.select();}
}

function scEditFeatValidate(originalName){
  const nameEl=document.getElementById('sc-edit-feat-name');
  const errEl=document.getElementById('sc-edit-feat-name-err');
  const submitEl=document.getElementById('sc-edit-feat-submit');
  if(!nameEl||!errEl)return;
  const val=nameEl.value.trim();
  if(!val){nameEl.style.borderColor='var(--divider)';errEl.style.display='none';if(submitEl)submitEl.disabled=true;return;}
  const isDupe=val!==originalName&&scCanvas.some(f=>f.name.toLowerCase()===val.toLowerCase());
  if(isDupe){
    nameEl.style.borderColor='var(--red)';errEl.style.display='flex';if(submitEl)submitEl.disabled=true;
  } else {
    nameEl.style.borderColor='var(--purple)';errEl.style.display='none';if(submitEl)submitEl.disabled=false;
  }
}

function scDoEditFeat(fid, mode){
  const feat=scCanvas.find(x=>x.id===fid);
  if(!feat){
    // Outcome Verification Loop §6.5 Finding F: the feature this modal was
    // opened for is no longer found by this id — most likely it was
    // renamed/re-linked to a different metric (which changes feat.id) by
    // another action while this modal was open. Silently no-op'ing here
    // would lose whatever the user just edited with no indication anything
    // went wrong. Surface it explicitly instead.
    const overlay=document.getElementById('sc-edit-feat-overlay');
    if(overlay)overlay.remove();
    if(typeof showToast==='function')showToast('This feature changed while you were editing it. Reopen it to try again.','warn');
    return;
  }
  const nameEl=document.getElementById('sc-edit-feat-name');
  const whyEl=document.getElementById('sc-edit-feat-why');
  const capEl=document.getElementById('sc-edit-feat-cap');
  if(!nameEl||!capEl)return;
  const newName=nameEl.value.trim()||feat.name;
  const newWhy=whyEl?whyEl.value.trim():'';
  const newCap=capEl.value;
  const oldName=feat.name;

  feat.name=newName;
  feat.why=newWhy;
  const oldCap=feat.cap;
  feat.cap=newCap;
  // Mark prototype stale on any metadata change
  if(typeof pcMarkStale==='function')pcMarkStale(fid);

  // If cap association changed, resolve new stage/metric from capStore
  if(newCap!==oldCap){
    if(typeof capStore!=='undefined'){
      for(const[mk,entry]of Object.entries(capStore)){
        const found=(entry.capabilities||[]).find(c=>c.name===newCap);
        if(found){
          feat.metric=entry.metricName||newCap;
          feat.stage=entry.stageLabel||(typeof getPiStageLabel==='function'?getPiStageLabel(gData):'Custom Value Stage');
          feat.metricPath=typeof scGetMetricPath==='function'?scGetMetricPath(feat.metric):feat.metric;
          break;
        }
      }
    }
    // Reset left nav filter to All so user sees the feature in its new group
    scCapNavFilter=null;
    scSelectedIds.clear(); // selection is filter-scoped — same fix as scSetCapFilter
  }

  // Sync name+why change back to cap.featStore source
  if(typeof capStore!=='undefined'){
    Object.values(capStore).forEach(entry=>{
      (entry.capabilities||[]).forEach(cap=>{
        if(cap.featStore&&cap.featStore.top){
          const srcFeat=cap.featStore.top.find(f=>f.name===oldName);
          if(srcFeat){srcFeat.name=newName;srcFeat.why=newWhy;}
        }
      });
    });
  }

  // Outcome Verification Loop: read whatever is currently in the Outcome
  // Hypothesis section's DOM and write it back onto the feature. Preserves
  // actual/signal/loggedAt from the existing hypothesis if present, since
  // this modal never edits those fields (they're Outcome Pulse's job) —
  // scReadOutcomeHypothesisFromDOM() always returns actual/signal as null,
  // so we merge them back in here rather than losing a previously-logged
  // result just because the PM opened Edit Feature afterward.
  const _existingSource=feat.outcomeHypothesis&&feat.outcomeHypothesis.primary?feat.outcomeHypothesis.primary.source:null;
  const _newHyp=scReadOutcomeHypothesisFromDOM(_existingSource);
  if(_newHyp&&feat.outcomeHypothesis&&feat.outcomeHypothesis.primary){
    _newHyp.primary.actual=feat.outcomeHypothesis.primary.actual;
    _newHyp.primary.signal=feat.outcomeHypothesis.primary.signal;
    _newHyp.primary.loggedAt=feat.outcomeHypothesis.primary.loggedAt;
  }
  feat.outcomeHypothesis=_newHyp;

  if(mode==='clear'){
    // Delete prototype entirely when all stories cleared — no point keeping stale data
    if(typeof pcDeleteProto==='function')pcDeleteProto(fid);
    feat.stories=[];
    feat.piPlanned=false;
    feat.piSprintAssigned=null;
    feat.piSubmitted=false;
    feat.piSubmittedStoryCount=0;
    scSelectedIds.delete(fid);
    scPiSelectedIds.delete(fid);
    // Item 27: if feature was in a release plan, remove its stories from
    // whichever plan actually owns them (v9.20: searches across all plans,
    // not a single bare global - a feature's stories could in principle be
    // split across plans, though normally aren't).
    if(typeof piPlans!=='undefined'&&Array.isArray(piPlans)){
      piPlans.forEach(function(_plan){
        const oldStoryIds=Object.keys(_plan.storyAssignments||{}).filter(sid=>{
          const s=scCanvas.find(f=>f.stories&&f.stories.some(st=>st.id===sid));
          return !s; // story no longer exists on canvas
        });
        oldStoryIds.forEach(sid=>{delete _plan.storyAssignments[sid];});
      });
      if(typeof piBacklogStoryIds!=='undefined'&&Array.isArray(piBacklogStoryIds)){
        piBacklogStoryIds=piBacklogStoryIds.filter(sid=>!!scCanvas.find(f=>f.stories&&f.stories.some(st=>st.id===sid)));
      }
    }
    // Close story panel if this feature is open
    if(scPanelFeatureId===fid){
      const updatedFeat=scCanvas.find(x=>x.id===fid)||scCanvas.find(x=>x.id===newId);
      if(updatedFeat)scRenderPanel(updatedFeat);
    }
  }

  const overlay=document.getElementById('sc-edit-feat-overlay');
  if(overlay)overlay.remove();

  fcRenderCanvas();
  if(typeof fcRenderCapNav==='function')fcRenderCapNav();
  // Refresh panel in place if this feature is currently open
  if(scPanelFeatureId===fid)scOpenPanel(fid);
  if(mode==='clear'){
    if(hasPiPlan){
      showToast('Stories cleared. This feature was in your PI plan. Regenerate PI to update.','warn');
    } else {
      showToast('Feature updated. Stories cleared. Select the card to regenerate.','success');
    }
  } else {
    showToast('Feature updated.','success');
  }
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('sc',fid+_LS_SC_TARGET_SEP); });
  }
}
