// CAPABILITY CANVAS
// capStore keyed by metricKey = stageId+'||'+metricName
// Each entry: { metricName, stageLabel, stageId, capabilities:[{name,why,subCaps,features:[]}] }
// capActiveMetricKey, capActiveCapIdx, capActiveSubCapIdx live in state.js

// Requirement Agent redesign (Discovery-First Entry Point) — RA no longer
// triggers from Capability Canvas at all (it triggers from Discovery Map
// instead, see kpi-tree.js's continueCta). Capability Canvas's own card
// checkboxes, bulk "Generate Features" bar, and per-capability "Generate
// Features" CTA now behave identically regardless of raEnabled — there is
// no RA-on suppression branch left in this file. raEnabled itself is
// retained as a global (still gates Discovery Map's CTA relabel/reroute)
// but is no longer read anywhere in this file.

// CC card filter state: null | 'no-features' | 'features-generated' | 'selected'
let ccCapFilter=new Set();
// CC collapsed metric groups
let ccCollapsedGroups=new Set();
// §8.2 — view-only expand/collapse state for the "Requirement Agent" Origin
// sub-list (chevron/label click only, never touches ccCapFilter membership).
let ccOriginRaExpanded=false;

// ══════════════════════════════════════════════════════════════════════════
// Origin filter — "Requirement Agent" nested value (§8.2). Extends the
// existing Origin filter (origin-kpi/origin-doc/origin-custom/origin-mi/
// origin-diag, all Set-membership tokens on ccCapFilter) with a sixth value
// plus a nested per-RQ sub-list — a genuinely new tri-state parent/child
// checkbox pattern for this codebase (confirmed via code research: no
// existing precedent, the only other indeterminate-checkbox usage in this
// app is flat "select-all" master checkboxes, an unrelated mechanism).
// Filter membership keys off conv.intakeBriefId directly (§5.2) — this
// sidesteps the whole "how is origin stored for capabilities" question
// entirely (confirmed: Capability Canvas has no stored origin field on
// capabilities at all; manually-added ones carry a `_manual:true` boolean
// instead, "Custom plan" being a derived display label, not a stored value).
// ══════════════════════════════════════════════════════════════════════════
function _ccFinalizedRaConvs(){
  return (typeof raConversations!=='undefined'?raConversations:[]).filter(function(c){return c.status==='finalized';});
}
// Shared HTML for the popover's "Requirement Agent" row + nested RQ
// sub-list — used verbatim at both card-grid render sites (All Caps view +
// single-metric view) so they can never drift apart on this, same
// convention _ccActionBarHtml() already established.
function _ccOriginRaFilterHtml(){
  const convs=_ccFinalizedRaConvs();
  if(!convs.length)return''; // no finalized RQs yet — nothing to filter to
  const checkedRqTokens=convs.filter(function(c){return ccCapFilter.has('origin-ra-rq:'+c.id);});
  const parentChecked=ccCapFilter.has('origin-ra');
  // QA issue #5 — always show the RQ sub-list, even with only one finalized
  // RQ, for a uniform experience regardless of count (previously suppressed
  // at exactly 1 RQ, per the original prototype's State C — reversed per
  // explicit feedback).
  const showSubList=ccOriginRaExpanded||parentChecked||checkedRqTokens.length>0;
  const subListHtml=`<div class="cc-origin-ra-sublist" id="cc-origin-ra-sublist" style="display:${showSubList?'block':'none'};padding-left:20px;border-left:1px dashed var(--divider);margin-left:20px;">`
    +convs.map(function(c){
      const cnt=(c.createdCapabilityKeys||[]).length;
      const isChecked=ccCapFilter.has('origin-ra-rq:'+c.id);
      return `<label class="fc-filter-row" style="font-size:11px;" onclick="event.stopPropagation();"><input type="checkbox" ${isChecked?'checked':''} onchange="ccToggleOriginRaChild('${e(c.id)}')"> ${e(c.rqNumber||'')} &mdash; ${e(c.title||'Untitled')} <span style="margin-left:auto;font-size:9px;color:var(--t3);">${cnt}</span></label>`;
    }).join('')
    +`</div>`;
  return `<label class="fc-filter-row" id="cc-origin-ra-row" onclick="event.stopPropagation();ccToggleOriginRaExpand()"><input type="checkbox" id="cc-origin-ra-chk" ${parentChecked?'checked':''} onclick="event.stopPropagation();ccToggleOriginRaParent()"> <i class="ti ti-message-2" style="font-size:11px;color:var(--purple);" aria-hidden="true"></i> Requirement Agent <i class="ti ti-chevron-${showSubList?'down':'right'}" style="font-size:9px;margin-left:auto;" aria-hidden="true"></i></label>`
    +subListHtml;
}
function ccToggleOriginRaParent(){
  const dropWasOpen=(function(){const d=document.getElementById('cc-cap-filter-drop');return d&&d.classList.contains('open');})();
  const convs=_ccFinalizedRaConvs();
  if(ccCapFilter.has('origin-ra')){
    ccCapFilter.delete('origin-ra');
    convs.forEach(function(c){ccCapFilter.delete('origin-ra-rq:'+c.id);});
  } else {
    ccCapFilter.add('origin-ra');
    convs.forEach(function(c){ccCapFilter.add('origin-ra-rq:'+c.id);});
    ccOriginRaExpanded=true;
  }
  ccSelectedCapIds.clear();
  _ccRerenderCcAfterFilterChange(dropWasOpen);
}
function ccToggleOriginRaChild(convId){
  const dropWasOpen=(function(){const d=document.getElementById('cc-cap-filter-drop');return d&&d.classList.contains('open');})();
  const tok='origin-ra-rq:'+convId;
  if(ccCapFilter.has(tok))ccCapFilter.delete(tok);else ccCapFilter.add(tok);
  const convs=_ccFinalizedRaConvs();
  const checkedCount=convs.filter(function(c){return ccCapFilter.has('origin-ra-rq:'+c.id);}).length;
  if(checkedCount===0||checkedCount<convs.length)ccCapFilter.delete('origin-ra'); // 0 checked -> fully unchecked; partial -> indeterminate (both: parent token absent)
  else ccCapFilter.add('origin-ra'); // every RQ checked -> parent fully checked
  ccSelectedCapIds.clear();
  _ccRerenderCcAfterFilterChange(dropWasOpen);
}
function ccToggleOriginRaExpand(){
  ccOriginRaExpanded=!ccOriginRaExpanded;
  _ccRerenderCcAfterFilterChange(true);
}
function _ccRerenderCcAfterFilterChange(dropWasOpen){
  if(capActiveMetricKey===null)ccRenderAllCaps();
  else ccRenderMainContent();
  if(dropWasOpen){
    const d=document.getElementById('cc-cap-filter-drop');
    if(d){
      d.classList.add('open');
      document.removeEventListener('mousedown',_ccFilterDropOutside);
      setTimeout(()=>document.addEventListener('mousedown',_ccFilterDropOutside),0);
    }
  }
  _ccApplyOriginRaIndeterminate();
}
// input.indeterminate can only be set via the DOM property, never an HTML
// attribute — applied as a small post-render step, same reasoning as every
// other indeterminate checkbox in this codebase (e.g. ccUpdateActionBar()'s
// "select all" checkbox).
function _ccApplyOriginRaIndeterminate(){
  const chk=document.getElementById('cc-origin-ra-chk');
  if(!chk)return;
  const convs=_ccFinalizedRaConvs();
  const checkedCount=convs.filter(function(c){return ccCapFilter.has('origin-ra-rq:'+c.id);}).length;
  chk.indeterminate=checkedCount>0&&checkedCount<convs.length;
}
// Whether a capability matches the "Requirement Agent" origin filter as
// currently configured — RQ-agnostic (any intakeBriefId) if the parent is
// checked with no specific RQ narrowing, else scoped to whichever RQs are
// individually checked.
function _ccCapMatchesOriginRa(cap){
  if(!cap||!cap.intakeBriefId)return false;
  const checkedRqIds=Array.from(ccCapFilter).filter(function(t){return t.indexOf('origin-ra-rq:')===0;}).map(function(t){return t.slice('origin-ra-rq:'.length);});
  if(checkedRqIds.length)return checkedRqIds.indexOf(cap.intakeBriefId)>=0;
  return ccCapFilter.has('origin-ra'); // parent checked alone, no RQ narrowing (or single-RQ product) — RQ-agnostic
}

function ccSetCapFilter(val){
  // Capture dropdown open state before re-render destroys the DOM
  const _dropWasOpen=val!==null&&(function(){const d=document.getElementById('cc-cap-filter-drop');return d&&d.classList.contains('open');})();
  if(val===null){ccCapFilter=new Set();}
  else if(ccCapFilter.has(val)){ccCapFilter.delete(val);}
  else{ccCapFilter.add(val);}
  ccSelectedCapIds.clear(); // selection is view-scoped — same convention as FC's fcSetStoriesFilter, prevents now-hidden capabilities from feeding ccGenerateFeaturesForSelected
  if(capActiveMetricKey===null)ccRenderAllCaps();
  else ccRenderMainContent();
  // Re-open dropdown after re-render (checkbox selections should keep it open)
  if(_dropWasOpen){
    const d=document.getElementById('cc-cap-filter-drop');
    if(d){
      d.classList.add('open');
      document.removeEventListener('mousedown',_ccFilterDropOutside);
      setTimeout(()=>document.addEventListener('mousedown',_ccFilterDropOutside),0);
    }
  }
  _ccApplyOriginRaIndeterminate();
}

function ccToggleGroup(metricKey){
  if(ccCollapsedGroups.has(metricKey))ccCollapsedGroups.delete(metricKey);
  else ccCollapsedGroups.add(metricKey);
  ccRenderAllCaps();
}

// ── Add Capability dropdown (B2, v7.83) ──
// Replaces the plain "Add Capability" button with a dropdown offering
// "Single capability" (existing modal) and "Upload from file" (new, B3-B5).
// btnClass: 'cc-tb-btn-add' (toolbar) or 'cc-ghost-btn' (empty-state variant)
function ccAddCapBtnHTML(btnClass,btnStyle){
  // v9.08: gated at the single definition point rather than at each call
  // site — this function is called from both the toolbar and the
  // empty-state variant, so hiding it here covers both automatically.
  if(typeof canEditSession==='function'&&!canEditSession())return'';
  const cls=btnClass||'cc-tb-btn-add';
  const style=btnStyle||'';
  return `<div class="cc-addcap-wrap" style="position:relative;">
    <button class="${cls}" style="${style}" onclick="ccToggleAddCapDrop(event)"><i class="ti ti-plus" style="font-size:${cls==='cc-tb-btn-add'?'11':'10'}px;" aria-hidden="true"></i> Add Capability <i class="ti ti-chevron-down" style="font-size:10px;" aria-hidden="true"></i></button>
    <div class="cc-addcap-drop" id="cc-addcap-drop">
      <div class="cc-addcap-opt" onclick="ccCloseAddCapDrop();ccShowAddCapModal()"><i class="ti ti-pencil" aria-hidden="true"></i> Single Capability</div>
      <div class="cc-addcap-opt" onclick="ccCloseAddCapDrop();ccShowUploadCapModal()"><i class="ti ti-upload" aria-hidden="true"></i> Upload from File</div>
    </div>
  </div>`;
}

function ccToggleAddCapDrop(evt){
  if(evt)evt.stopPropagation();
  const drop=document.getElementById('cc-addcap-drop');
  if(!drop)return;
  const isOpen=drop.classList.contains('open');
  document.querySelectorAll('.cc-export-drop.open,.cc-addcap-drop.open').forEach(d=>{d.classList.remove('open');d.style.top='';d.style.right='';});
  if(isOpen){
    drop.classList.remove('open');
    document.removeEventListener('mousedown',_ccAddCapDropOutside);
  } else {
    drop.classList.add('open');
    setTimeout(()=>document.addEventListener('mousedown',_ccAddCapDropOutside),0);
  }
}
function ccCloseAddCapDrop(){
  const drop=document.getElementById('cc-addcap-drop');
  if(drop)drop.classList.remove('open');
  document.removeEventListener('mousedown',_ccAddCapDropOutside);
}
function _ccAddCapDropOutside(e){
  const drop=document.getElementById('cc-addcap-drop');
  if(!drop){document.removeEventListener('mousedown',_ccAddCapDropOutside);return;}
  if(!drop.contains(e.target)){
    drop.classList.remove('open');
    document.removeEventListener('mousedown',_ccAddCapDropOutside);
  }
}

// ── Toolbar kebab menu - consolidates the standalone "Add Capability"
// dropdown and standalone Export button into a single .tm-dots trigger.
// Uses the generic _uiRowMenuToggle(triggerEl, menuHtml) / _uiRowMenuClose()
// helpers already proven by Outcome Pulse, Team Management and PI Planning
// (scripts/utils.js) - no new dropdown component invented. The Filter
// button stays a separate, always-visible control next to the kebab.
function ccToolbarMenuHtml(){
  const _canEditCcMenu=(typeof canEditSession!=='function')||canEditSession();
  const addCapRow=_canEditCcMenu?`<div class="tm-menu-item tm-menu-item-expand" role="menuitem" tabindex="0" onclick="event.stopPropagation();ccMenuDrillAddCap()"><i class="ti ti-plus" aria-hidden="true"></i> Add Capability <i class="ti ti-chevron-right" aria-hidden="true"></i></div>`:'';
  return `<div class="tm-menu-static" role="menu">
    ${addCapRow}
    <div class="tm-menu-item" role="menuitem" tabindex="0" onclick="_uiRowMenuClose();ccExportDocx()"><i class="ti ti-download" aria-hidden="true"></i> Export</div>
  </div>`;
}

// Drill-in: swaps the currently-open popover's own content in place to show
// the "Add Capability" sub-options - not a side flyout. Reuses the existing
// _uiRowMenuOpen state (utils.js) so position/outside-click/escape handling
// stays anchored to the same menu element; only its innerHTML changes.
function ccMenuDrillAddCap(){
  if(typeof _uiRowMenuOpen==='undefined'||!_uiRowMenuOpen||!_uiRowMenuOpen.menuEl)return;
  _uiRowMenuOpen.menuEl.innerHTML=`<div class="tm-submenu-standalone" role="menu">
    <div class="cc-addcap-opt" role="menuitem" tabindex="0" onclick="_uiRowMenuClose();ccShowAddCapModal()"><i class="ti ti-pencil" aria-hidden="true"></i> Single Capability</div>
    <div class="cc-addcap-opt" role="menuitem" tabindex="0" onclick="_uiRowMenuClose();ccShowUploadCapModal()"><i class="ti ti-upload" aria-hidden="true"></i> Upload from File</div>
  </div>`;
}

function ccToggleCCFilterDrop(evt){
  if(evt)evt.stopPropagation();
  const drop=document.getElementById('cc-cap-filter-drop');
  if(!drop)return;
  const isOpen=drop.classList.contains('open');
  document.querySelectorAll('.cc-export-drop.open').forEach(d=>{d.classList.remove('open');d.style.top='';d.style.right='';});
  if(isOpen){
    drop.classList.remove('open');
    document.removeEventListener('mousedown',_ccFilterDropOutside);
  } else {
    drop.classList.add('open');
    setTimeout(()=>document.addEventListener('mousedown',_ccFilterDropOutside),0);
  }
}
function _ccFilterDropOutside(e){
  const drop=document.getElementById('cc-cap-filter-drop');
  if(!drop){document.removeEventListener('mousedown',_ccFilterDropOutside);return;}
  if(!drop.contains(e.target)){
    drop.classList.remove('open');
    document.removeEventListener('mousedown',_ccFilterDropOutside);
  }
}

// ── Helpers ──
function ccMetricKey(stageId,metricName){return stageId+'||'+metricName;}
function ccStageColor(stageId){
  // Try legacy AAER map first (for backward compat with hardcoded stageIds)
  const legacy={acquisition:'#185FA5',activation:'#534AB7',engagement:'#007873',retention:'#C8870A'};
  if(legacy[stageId])return legacy[stageId];
  // Dynamic products: stageId is a snake_case_slug — look up by index in gData.stages
  if(gData&&gData.stages){
    const idx=gData.stages.findIndex(s=>s.id===stageId);
    if(idx>=0)return STAGE_PALETTE[idx%STAGE_PALETTE.length];
  }
  return STAGE_PALETTE[0];
}
function ccStageBg(stageId){return{acquisition:'#E6F1FB',activation:'var(--card-purple)',engagement:'#EAF3DE',retention:'#FAEEDA'}[stageId]||'var(--card)';}
function ccStageText(stageId){return{acquisition:'#0C447C',activation:'var(--purple-deep)',engagement:'#27500A',retention:'#633806'}[stageId]||'#444';}

function ccGetAllL1Metrics(){
  // KPI-tree derived metrics
  const out=[];
  if(gData){
    gData.stages.forEach(st=>{
      st.l1_metrics.forEach(m=>{
        // v9.06.02: bucketId included for pi-stage entries — the render
        // loop needs it to synthesize a virtual "entry" by merging every
        // capStore['pi||'+capName] key sharing this bucketId (a bucket
        // maps to MANY capStore keys, one per capability, unlike ordinary
        // metrics where metricKey IS the capStore key directly).
        out.push({stageId:st.id,stageLabel:st.label,metricName:m.name,metricKey:ccMetricKey(st.id,m.name),bucketId:m.bucketId});
      });
    });
  }
  // PI-first entries: always include pi|| capStore entries (regardless of piMode)
  Object.keys(capStore).filter(k=>k.startsWith('pi||')).forEach(k=>{
    const entry=capStore[k];
    if(entry&&!out.find(m=>m.metricKey===k)){
      out.push({stageId:'pi',stageLabel:(typeof getPiStageLabel==='function'?getPiStageLabel(gData):'Custom Value Stage'),metricName:entry.metricName,metricKey:k,bucketId:entry.bucketId});
    }
  });
  return out;
}

// Requirement Agent redesign (Discovery-First Entry Point, §8.1) — called
// right after switchTab('cc') at the end of raRunFinalizeSequence(), since
// switchTab() itself takes no target-metric parameter. Auto-selects the
// first populated metric (value chain stage order, then metric order within
// stage — same ordering ccGetAllL1Metrics() already produces) instead of
// leaving the PM on CC's generic "select a metric" empty state. No-op if no
// metric has any capabilities yet.
function ccSelectFirstPopulatedMetric(){
  var metrics=ccGetAllL1Metrics();
  for(var i=0;i<metrics.length;i++){
    var entry=capStore[metrics[i].metricKey];
    if(entry&&entry.capabilities&&entry.capabilities.length){
      ccMNSelectMetric(metrics[i].metricKey);
      return;
    }
  }
}

function ccCountGenerated(){
  // Exclude mi|| and diag|| entries — these are injected from MI/PD sends, not CC-generated
  return Object.keys(capStore).filter(k=>!k.startsWith('mi||')&&!k.startsWith('diag||')).length;
}

// ── FIX 2.1 (v9.03): Migration for old sessions with removed prev-pi type ──
function ccMigrateLegacyPIInputs(piInputs){
  // Safety: does NOT clear imported data, only normalizes type value
  if(!piInputs)return;
  
  // Whitelist of allowed types
  var allowedTypes={
    'caps-only':true,
    'caps-features':true
    // 'prev-pi' deliberately absent — removed feature
  };
  
  // If type is not allowed, normalize to default
  if(!allowedTypes[piInputs.type]){
    console.warn('[CC] Normalizing legacy piInputs.type from "'+piInputs.type+'" to "caps-only"');
    piInputs.type='caps-only';
    // CRITICAL: Do NOT clear parsedCaps, parsedFeatures, or any imported work
    // Migration is ONLY about the removed UI option, not data loss
  }
}

// ── Tab switch entry point (called from api.js switchTab) ──
function ccOnTabEnter(){
  // PI-first mode
  if(typeof piMode!=='undefined'&&piMode){
    // If build already completed, go straight to canvas (not form)
    if(typeof piFirstBuilt!=='undefined'&&piFirstBuilt){
      ccOpenNavigator();
      return;
    }
    ccShowPIFirstForm();
    return;
  }
  // Check for any caps first — includes mi|| and diag|| entries injected from MI/PD sends
  // ccCountGenerated() excludes those keys (correct for nav remaining count) so we use hasAnyCaps here
  const hasAnyCaps=Object.keys(capStore).length>0;
  const done=ccCountGenerated(); // KPI/PI caps only — used by ccOpenMetricNav remaining count
  // Stricter guard: capActiveMetricKey must point to an entry with actual capabilities
  // Avoids routing to KPI metric view when only injected caps (mi||/diag||) exist
  // v9.06.02: uses the shared resolver so a bucket:<id> selection is
  // correctly recognized as valid — a direct capStore[capActiveMetricKey]
  // check would always be undefined for a bucket tag, incorrectly
  // treating a legitimate bucket selection as stale and clearing it.
  const _activeGroup=typeof ccResolveCapGroup==='function'?ccResolveCapGroup(capActiveMetricKey):null;
  const activeEntryHasCaps=capActiveMetricKey&&_activeGroup&&_activeGroup.cards.length>0;
  if(hasAnyCaps&&activeEntryHasCaps){ccOpenNavigator();return;}
  if(hasAnyCaps){
    // Clear stale active metric state so ccOpenMetricNav routes to ccRenderAllCaps
    capActiveMetricKey=null;capActiveCapIdx=null;
    capActiveSubCapIdx=null;ccPanelCapKey=null;
    ccRenderPartial();return;
  }
  // No caps and no KPI tree: show dual-CTA entry
  if(!gData){ccShowDualEntry();return;}
  // Auto-select first metric when KPI tree exists but no caps generated yet
  // Skips the blank "Select a metric" state entirely
  if(gData&&gData.stages&&gData.stages.length>0){
    const allMetrics=ccGetAllL1Metrics().filter(m=>!m.metricKey.startsWith('pi||'));
    if(allMetrics.length>0){
      capActiveMetricKey=allMetrics[0].metricKey;
      capActiveCapIdx=null;
    }
  }
  ccRenderEmpty();
}

// Alias for legacy calls
function ccEnter(){ccOnTabEnter();}

// ── Dual-CTA empty state (no gData, not piMode) ──
function ccShowDualEntry(){
  const el=document.getElementById('cc-main');
  if(!el)return;
  const _isCap=typeof gData!=='undefined'&&gData&&gData.approach==='capability-based';
  el.innerHTML=`<div class="cc-empty-wrap">
    <div class="cc-empty-icon"><i class="ti ti-layers-subtract" aria-hidden="true"></i></div>
    <div class="cc-empty-title" style="font-family:var(--font);font-size:22px;">${_isCap?'Process Areas':'Capability Canvas'}</div>
    <div class="cc-empty-sub">Map every capability your product needs. Start from your KPI metrics, or paste a plan you already have.</div>
    <div class="cc-dual-entry">
      <div class="cc-entry-card">
        <div class="cc-entry-eyebrow">Discovery-led path</div>
        <div class="cc-entry-label">Generate from Discovery Map</div>
        <div class="cc-entry-desc">AI derives capabilities directly from your product's growth metrics and value chain stages.</div>
        <button class="cc-btn-primary" onclick="switchTab('mm')"><i class="ti ti-hierarchy-2" style="font-size:12px;" aria-hidden="true"></i> Go to Discovery Map</button>
      </div>
      <div class="cc-entry-divider">or</div>
      <div class="cc-entry-card">
        <div class="cc-entry-eyebrow">Release-First Path</div>
        <div class="cc-entry-label">I already have a capability plan</div>
        <div class="cc-entry-desc">Paste or upload your capabilities. AI generates features for each — skip the Discovery Map entirely.</div>
        <button class="cc-btn-ghost" onclick="ccActivatePIFirst()"><i class="ti ti-clipboard-list" style="font-size:12px;" aria-hidden="true"></i> Use my own plan</button>
      </div>
    </div>
  </div>`;
}

// ── Activate PI-first mode ──
function ccActivatePIFirst(){
  // If KPI-linked capStore has data, warn before clearing
  const kpiKeys=Object.keys(capStore).filter(k=>!k.startsWith('pi||'));
  const kpiCount=kpiKeys.length;
  if(kpiCount>0){
    const totalCaps=kpiKeys.reduce((a,k)=>a+(capStore[k]&&capStore[k].capabilities?capStore[k].capabilities.length:0),0);
    const totalMetrics=ccGetAllL1Metrics().length;
    // In-app modal instead of browser confirm()
    const overlay=document.createElement('div');
    overlay.id='cc-pi-switch-overlay';
    overlay.className='modal-overlay';
    overlay.innerHTML=`<div class="modal" style="max-width:440px;;position:relative;">
    <button onclick="document.getElementById('cc-pi-switch-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:16px 44px 14px 16px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:500;color:var(--t1);">Switch to your own plan?</div>
    </div>
      <div class="modal-body" style="margin-bottom:12px;">You have <strong>${totalCaps} capabilities</strong> from your Discovery Map. How would you like to proceed?</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">
        <label style="display:flex;align-items:flex-start;gap:10px;border:1px solid var(--divider);border-radius:7px;padding:10px 12px;cursor:pointer;" onclick="this.closest('.modal').querySelectorAll('.cc-choice-card').forEach(c=>c.classList.remove('selected'));this.classList.add('selected');this.closest('.modal').querySelector('.modal-confirm-btn').disabled=false;this.dataset.choice='keep';" class="cc-choice-card">
          <div style="width:16px;height:16px;border-radius:50%;border:1.5px solid var(--divider);flex-shrink:0;margin-top:1px;display:flex;align-items:center;justify-content:center;" class="cc-choice-radio"></div>
          <div><div style="font-size:12px;font-weight:600;color:var(--t1);margin-bottom:2px;">Keep both</div><div style="font-size:11px;color:var(--t3);line-height:1.5;">Your KPI capabilities are retained. Both paths visible in "All capabilities".</div></div>
        </label>
        <label style="display:flex;align-items:flex-start;gap:10px;border:1px solid var(--divider);border-radius:7px;padding:10px 12px;cursor:pointer;" onclick="this.closest('.modal').querySelectorAll('.cc-choice-card').forEach(c=>c.classList.remove('selected'));this.classList.add('selected');this.closest('.modal').querySelector('.modal-confirm-btn').disabled=false;this.dataset.choice='clear';" class="cc-choice-card">
          <div style="width:16px;height:16px;border-radius:50%;border:1.5px solid var(--divider);flex-shrink:0;margin-top:1px;display:flex;align-items:center;justify-content:center;" class="cc-choice-radio"></div>
          <div><div style="font-size:12px;font-weight:600;color:var(--t1);margin-bottom:2px;">Start fresh</div><div style="font-size:11px;color:var(--t3);line-height:1.5;">KPI capabilities are cleared. Only your uploaded plan will be used.</div></div>
        </label>
      </div>
      <div class="modal-footer">
        <button class="modal-cancel-btn" onclick="document.getElementById('cc-pi-switch-overlay').remove()">Cancel</button>
        <button class="modal-confirm-btn" disabled onclick="ccConfirmPIFirstChoice(this)">Continue</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    const _escPi=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_escPi,true);}};
    document.addEventListener('keydown',_escPi,true);
    trapFocus(overlay);
    return;
  }
  piMode=true;
  ccShowPIFirstForm();
}

function ccRenderEmpty(){
  // Route to the unified metric nav layout (same as partial/navigator)
  ccOpenMetricNav();
}

function ccRenderPartial(){
  // ccOpenMetricNav handles routing: if only mi||/diag|| caps exist (hasAnyCaps true, done=0),
  // it renders all-caps view. If KPI/PI caps exist, it renders metric nav.
  ccOpenMetricNav();
}

// ── Inline expand for one-metric generate ──
function ccExpandMetric(metricKey,metricName,stageLabel,stageId){
  const safeKey=metricKey.replace(/[^a-z0-9]/gi,'_');
  const expEl=document.getElementById('ccexp-'+safeKey);
  if(!expEl)return;
  document.querySelectorAll('.cc-metric-expand').forEach(el=>{if(el.id!=='ccexp-'+safeKey)el.style.display='none';});
  if(expEl.style.display==='block'){expEl.style.display='none';return;}
  expEl.style.display='block';
  // Store data on expander element — avoids inline string escaping
  expEl.dataset.mkey=metricKey;
  expEl.dataset.mname=metricName;
  expEl.dataset.slabel=stageLabel;
  expEl.dataset.sid=stageId;
  expEl.innerHTML=`<div class="cc-exp-body">
    <div class="cc-exp-label">Add context before generating (optional)</div>
    <input class="cc-exp-input" id="ccinput-${safeKey}" placeholder="e.g. We already have a setup wizard. Focus on in-product nudges and contextual tooltips..." />
    <div class="cc-exp-hint">Leave blank to let AI infer from your product and KPI context.</div>
    <div class="cc-exp-actions">
      <button class="cc-btn-primary" style="font-size:11px;padding:7px 14px;" onclick="ccGenerateOneFromEl(this)">
        <i class="ti ti-layers-subtract" style="font-size:11px;" aria-hidden="true"></i> Generate for This Metric
      </button>
      <button class="cc-btn-ghost" style="font-size:11px;" onclick="this.closest('.cc-metric-expand').style.display='none'">Cancel</button>

    </div>
  </div>`;
}

function ccGenerateOneFromEl(btn){
  const expEl=btn.closest('.cc-metric-expand');
  if(!expEl)return;
  ccGenerateOne(expEl.dataset.mkey,expEl.dataset.mname,expEl.dataset.slabel,expEl.dataset.sid);
}

// ── Generate one metric ──
// ── Error state helper for ccGenerateOne — replaces loader with visible error + retry ──
function ccRenderGenerateOneError(mainArea,err,retryArgs){
  var msg=err&&err.message?err.message:String(err||'Generation failed');
  mainArea.innerHTML='<div style="display:flex;flex:1;align-items:center;justify-content:center;">'
    +'<div style="text-align:center;padding:32px;max-width:400px;">'
    +'<i class="ti ti-alert-circle" style="font-size:28px;color:var(--red);margin-bottom:12px;display:block;" aria-hidden="true"></i>'
    +'<div style="font-size:13px;font-weight:600;color:var(--t1);margin-bottom:6px;">Generation failed</div>'
    +'<div style="font-size:11px;color:var(--t3);margin-bottom:16px;">'+e(msg)+'</div>'
    +'<button class="gen-btn" type="button" style="font-size:11px;" data-cc-retry>'
    +'<i class="ti ti-refresh" style="font-size:11px;" aria-hidden="true"></i> Try again'
    +'</button>'
    +'</div></div>';
  var retryBtn=mainArea.querySelector('[data-cc-retry]');
  if(retryBtn){
    retryBtn.addEventListener('click',function(){
      ccGenerateOne(retryArgs.metricKey,retryArgs.metricName,retryArgs.stageLabel,retryArgs.stageId);
    });
  }
}

async function ccGenerateOne(metricKey,metricName,stageLabel,stageId,triggerEl){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const key=getKey();
  if(aiGenInFlight.active){showToast("Still working on your last request. Hang tight, this won't take long.",'info');return;}
  // v8.133 fix (item 3): courtesy pre-check, for consistency with the
  // other four canvases.
  if(typeof _lsPeekIfLocked==='function' && typeof _activeSessionId!=='undefined' && _activeSessionId){
    const _peek=await _lsPeekIfLocked(_activeSessionId);
    if(_peek.locked){
      showToast(_peek.holderName+' is already generating on this session. Try again in a moment.','warn');
      return;
    }
  }
  const safeKey=metricKey.replace(/[^a-z0-9]/gi,'_');
  const expEl=document.getElementById('ccexp-'+safeKey);
  const refinement=document.getElementById('ccinput-'+safeKey)?document.getElementById('ccinput-'+safeKey).value.trim():'';
  // Phase 5 (v8.117): immediate visual acknowledgment on click — disable
  // the button synchronously, before ANY async work (including the lock
  // check) starts. Confirmed via UI/UX review as the right pattern here:
  // a lock-check RPC round-trip is a real network delay, not instant, and
  // showing nothing at all until it resolves reads as broken/unresponsive.
  // The RICH loader ("Generating Capabilities...") is deliberately NOT
  // shown yet — that only appears once the lock is actually confirmed
  // acquired (inside withGenerationLock's callback below), since showing
  // it earlier would misleadingly claim generation started when the app
  // is still only checking whether it's ALLOWED to start.
  //
  // Phase 5 fix (v8.118): the disable above only ever reached the GLOBAL
  // "Generate for All Metrics" button — never the actual empty-state
  // "Generate Capabilities" button the user visibly clicked (confirmed via
  // live testing: clicking it showed no immediate feedback at all during
  // the lock-check delay, leading to a double-click and a confusing "still
  // running in this tab" toast). That button has no unique ID (a shared
  // .gen-btn class used generically across the app), so the fix is to pass
  // the clicked element itself via `this` at the call site and disable it
  // directly here — works regardless of which markup renders it.
  ccSetGenAllBtnDisabled(true);
  if(triggerEl&&typeof triggerEl==='object'&&triggerEl.disabled!==undefined){
    triggerEl.disabled=true;
  }
  if(expEl){expEl.style.display='none';}
  const _ctx1=getFullProductCtx();
  var _ccDocRes1=(typeof buildDocContext==='function')?buildDocContext('cc',[metricName,stageLabel].filter(Boolean).join(' ')):{text:'',truncated:false};
  _ctx1.docContext=_ccDocRes1.text;
  _fireDocTruncatedToast(_ccDocRes1.truncated);
  const nsm=gData?gData.nsm.metric:(typeof piInputs!=='undefined'&&piInputs.piGoal?piInputs.piGoal:'');
  const _capInfo1=ccFindMetricInGData(metricKey);
  const capDescription1=_capInfo1&&_capInfo1.why?_capInfo1.why:'';
  const _docGrounded1=String(_ctx1.docContext||'').trim().length>0;

  // Phase 5 (v8.117): a unique attempt marker for THIS call, created here
  // and threaded through every later write. Found via adversarial review:
  // a bare "re-query by element ID, then overwrite" fix for the stuck-
  // loader bug is unsafe in this no-virtual-DOM app — a slow, stale
  // attempt (e.g. this exact call, failing late) can otherwise clobber
  // whatever the user is CURRENTLY looking at (a different metric they've
  // since navigated to), or clobber a NEWER, already-succeeded attempt on
  // this same metric. Every write below checks getIfCurrentAttempt() first
  // and silently skips itself if something newer has already replaced the
  // content this attempt was writing into.
  const _attempt=newGenAttempt();

  try{
    await withGenerationLock(async (_lock) => {
  try{
    // Lock confirmed acquired — NOW show the real loader, marker-stamped.
    const mainArea=document.getElementById('cc-main-area');
    if(mainArea){
      mainArea.innerHTML=markGenAttempt(_attempt,`<div style="display:flex;flex:1;overflow:hidden;min-height:0;">
      <div class="cc-cap-grid-wrap">
        <div class="cc-cap-grid-hdr">
          <div>
            <div class="cc-breadcrumb">${stageLabel?`<span class="cc-ctx-pill" style="background:${e(ccStageBg(stageId||''))};color:${e(ccStageText(stageId||''))};">${e(stageLabel)}</span><span class="cc-ctx-sep">›</span>`:''}
              <span class="cc-ctx-pill" style="background:var(--card-purple);color:var(--purple-deep);">${e(metricName)}</span>
            </div>
          </div>
        </div>
        <div class="loading on" style="flex:1;">
          <div class="spin"></div>
          <div class="load-txt">Generating Capabilities…</div>
          <div class="load-sub">${(gData&&gData.approach==='capability-based')?'Identifying capabilities under '+e(metricName):'Mapping product capabilities that drive '+e(metricName)}</div>
        </div>
      </div>
    </div>`);
    }
    const rowEl=document.getElementById('ccrow-'+safeKey);
    if(rowEl){
      var _statusEl=rowEl.querySelector('.cc-metric-status');
      if(_statusEl)_statusEl.innerHTML=markGenAttempt(_attempt,`<span style="display:flex;align-items:center;gap:6px;font-size:10px;color:var(--color-text-secondary);"><div class="cc-spin-sm"></div> Generating...</span>`);
    }

    const _signal=startAiGen(`Capabilities for "${metricName}" are being generated. Leaving now discards them, you'll need to regenerate from scratch.`);
    const txt=await callAPI(
      'You are a senior product strategist. Specific, opinionated, product-native. Respond ONLY with valid JSON. No markdown, no backticks, no preamble. Never use em dashes (—) in your output; use a hyphen (-) or rewrite the phrase.',
      (gData&&gData.approach==='capability-based')
        ?buildCapCanvasPromptCapDriven(_ctx1,gData&&gData.measurementModel&&gData.measurementModel.frameworks?gData.measurementModel.frameworks:[],nsm,metricName,stageLabel,refinement,capDescription1)
        :buildCapCanvasPrompt(_ctx1,gData&&gData.measurementModel&&gData.measurementModel.frameworks?gData.measurementModel.frameworks:[],nsm,metricName,stageLabel,refinement),
      3000,
      _signal,
      null,
      'cc-gen-one'
    );
    const clean=txt.replace(/```json|```/g,'').trim();
    let parsed;
    try{parsed=JSON.parse(clean);}catch(pe){
      const s=clean.indexOf('{');const l=clean.lastIndexOf('}');
      if(s>=0&&l>s){try{parsed=JSON.parse(clean.substring(s,l+1));}catch(pe2){throw new Error('Could not parse capability response.');}}
      else throw new Error('Could not parse capability response.');
    }
    if(!parsed||!Array.isArray(parsed.capabilities))throw new Error('Invalid capabilities response shape.');
    // Store — normalise sub_capabilities; filter exact-match duplicates across metrics
    const _existingNames=_ccGetAllExistingCapNames(metricKey);
    capStore[metricKey]={
      metricName,stageLabel,stageId,
      _docGrounded:_docGrounded1,
      capabilities:parsed.capabilities.filter(cap=>cap.name&&!_existingNames.has(cap.name.toLowerCase().trim())).map(cap=>({
        name:cap.name,
        why:cap.why,
        subCaps:(cap.sub_capabilities&&cap.sub_capabilities.length>0)?cap.sub_capabilities:null,
        features:[]
      }))
    };
    capStoreInvalidated=false;
    ccUpdateTabBadge();
    ccSetGenAllBtnDisabled(false);
    // Phase 5 (v8.117): only navigate to the navigator view if THIS
    // attempt still owns the main area — if the user has since switched
    // to a different metric, don't yank them back to this one just
    // because its (now-stale) generation happened to finish.
    if(getIfCurrentAttempt('cc-main-area',_attempt)){
      ccOpenNavigator();
    }
    // Phase 5: checkpoint immediately before the save.
    _lock.throwIfLost();
    if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
      // Phase 2 fix (v8.125): AWAITED, not .then()'d. withGenerationLock
      // releases the lock as soon as this enclosing callback's promise
      // resolves — a .then() chain let the release race ahead of (and
      // usually win against) the emit's own insert, which requires the
      // session's active_user_id to still be the current holder. Confirmed
      // live: every emit was being silently rejected by RLS as a result.
      const _ok=await sessionStoreSave(_activeSessionId);
      if(_ok&&typeof _activeSessionIsShared!=='undefined'&&_activeSessionIsShared&&typeof _lsEmitContentEvent==='function'){
        await _lsEmitContentEvent(_activeSessionId,'cc','capabilities_generated',metricKey,null);
      }
      // Item 2: this metric's capability list was just regenerated — clear
      // any pending manual-edit target for it (whole-list AND any narrower
      // feature-level targets under it), no pause step needed since CC's
      // own generation isn't destructive across the whole canvas the way a
      // full plan/DM regeneration is.
      if(typeof _lsClearManualEditAfterRegeneration==='function')_lsClearManualEditAfterRegeneration('cc',metricKey+_LS_CC_TARGET_SEP);
    }
    endAiGen();
  }catch(err){
    ccSetGenAllBtnDisabled(false);
    // Phase 5 fix (v8.118): re-enable the specific button the user clicked
    // too, not just the global batch button — this branch's error state
    // typically leaves the empty-state view in place (unlike the success
    // path, which replaces it entirely via ccOpenNavigator/error render,
    // making the button moot there), so it genuinely needs re-enabling
    // here for the user to be able to retry via the same button.
    if(triggerEl&&typeof triggerEl==='object'&&triggerEl.disabled!==undefined){
      triggerEl.disabled=false;
    }
    endAiGen();
    if(err.name==='AbortError'){
      // Abort: user navigated away — only re-render nav if this attempt
      // still owns the main area (per marker check), otherwise leave
      // whatever the user has since navigated to alone.
      if(getIfCurrentAttempt('cc-main-area',_attempt)&&typeof ccOpenNavigator==='function')ccOpenNavigator();
      // Phase 5: rethrow rather than return — see pi-planning.js for the
      // full rationale (adversarial review Finding 1).
      throw err;
    }
    // Phase 5 (v8.117): every write below is guarded by getIfCurrentAttempt —
    // if something newer has already replaced this content (a different
    // metric selected, or a newer attempt on the SAME metric that already
    // succeeded), this stale attempt's error must not clobber it.
    var _errMainArea=getIfCurrentAttempt('cc-main-area',_attempt);
    if(_errMainArea){
      ccRenderGenerateOneError(_errMainArea,err,{metricKey,metricName,stageLabel,stageId});
    }
    var _errRowStatusHost=document.getElementById('ccrow-'+safeKey);
    var _errStatusEl=_errRowStatusHost&&_errRowStatusHost.querySelector('.cc-metric-status');
    if(_errStatusEl&&_errStatusEl.querySelector('[data-gen-attempt="'+_attempt.id+'"]')){
      _errStatusEl.innerHTML='<button class="gen-btn" type="button" style="font-size:10px;padding:3px 8px;" data-cc-row-retry>'
        +'<i class="ti ti-refresh" style="font-size:10px;" aria-hidden="true"></i> Retry</button>';
      var _rowRetryBtn=_errStatusEl.querySelector('[data-cc-row-retry]');
      if(_rowRetryBtn){
        _rowRetryBtn.addEventListener('click',function(){
          ccGenerateOne(metricKey,metricName,stageLabel,stageId);
        });
      }
    }
    if(err.message==='generation_lock_lost'){
      throw err;
    }
  }
    });
  }catch(lockErr){
    // Phase 5 fix (v8.118): REAL BUG found via live testing — this outer
    // catch fires for a pre-flight lock rejection (exactly the "someone
    // else is generating" case), and my earlier v8.117 comment's reasoning
    // was wrong: I assumed this path was moot because "the DOM gets
    // replaced anyway," based on the INNER catch's behavior (a real
    // mid-generation failure, which DOES replace #cc-main-area via
    // ccRenderGenerateOneError). But THIS outer catch never touches
    // #cc-main-area at all — the original empty-state view, including the
    // button the user clicked, is still sitting there completely
    // untouched. Without this re-enable, that button stayed disabled
    // forever, only recoverable by navigating to a different metric/tab
    // and re-rendering the view some other way — confirmed exactly this
    // symptom via live testing, not a hypothetical.
    ccSetGenAllBtnDisabled(false);
    if(triggerEl&&typeof triggerEl==='object'&&triggerEl.disabled!==undefined){
      triggerEl.disabled=false;
    }
  }
}

// ── Generate all metrics sequentially ──
async function ccGenerateAll(){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const key=getKey();
  if(aiGenInFlight.active){showToast("Still working on your last request. Hang tight, this won't take long.",'info');return;}
  // v8.133 fix (item 3): courtesy pre-check, for consistency with the
  // other four canvases.
  if(typeof _lsPeekIfLocked==='function' && typeof _activeSessionId!=='undefined' && _activeSessionId){
    const _peek=await _lsPeekIfLocked(_activeSessionId);
    if(_peek.locked){
      showToast(_peek.holderName+' is already generating on this session. Try again in a moment.','warn');
      return;
    }
  }
  const metrics=ccGetAllL1Metrics().filter(m=>!capStore[m.metricKey]);
  if(!metrics.length){ccOpenNavigator();return;}
  // Ensure metric nav is open first (preserves cc-nav left panel)
  if(!document.getElementById('cc-main-area'))ccOpenMetricNav();
  if(!document.getElementById('cc-main-area'))return;
  const _ctx2=getFullProductCtx();
  var _ccDocRes2=(typeof buildDocContext==='function')?buildDocContext('cc'):{text:'',truncated:false};
  _ctx2.docContext=_ccDocRes2.text;
  _fireDocTruncatedToast(_ccDocRes2.truncated);
  const batchDocGrounded=String(_ctx2.docContext||'').trim().length>0;
  const nsm=gData?gData.nsm.metric:(typeof piInputs!=='undefined'&&piInputs.piGoal?piInputs.piGoal:'');

  // Phase 5 (v8.117): immediate button disable, no rich loader until the
  // lock is confirmed acquired — same rationale as ccGenerateOne() above.
  ccSetGenAllBtnDisabled(true);
  const _attempt=newGenAttempt();

  // Phase 5: withGenerationLock wraps the ENTIRE batch loop below as ONE
  // lock acquisition, not one per iteration — splitting it per-iteration
  // would release the lock between metrics, reopening the exact collision
  // window this lock exists to close, for a batch that can run for
  // several minutes across many metrics.
  try{
    await withGenerationLock(async (_lock) => {

  const _signal=startAiGen(`Capabilities for ${metrics.length} metric${metrics.length!==1?'s':''} are being generated. Leaving now discards this batch, you'll need to start again.`);
  // Lock confirmed — now write the real batch loader, marker-stamped.
  // Every per-iteration progress update below is guarded by re-checking
  // this same marker via getIfCurrentAttempt() before writing, since the
  // user can navigate to a different metric/view mid-batch (many other
  // functions can replace #cc-main-area's content — confirmed via grep,
  // not assumed), and a stale batch's own progress updates must not
  // clobber whatever the user has since navigated to.
  var _mainArea=document.getElementById('cc-main-area');
  if(_mainArea){
    _mainArea.innerHTML=markGenAttempt(_attempt,`<div class="loading on" style="flex:1;height:100%;">
    <div class="spin"></div>
    <div class="load-txt">Generating Capabilities…</div>
    <div class="load-sub" id="cc-progress-sub">Starting…</div>
    <div class="load-steps" id="cc-progress-list"></div>
  </div>`);
  }

  let i=0;
  // Phase 2 (v8.123, live sync): tracks which metrics actually got a
  // capability set generated in this loop, so one content event per metric
  // can be emitted after the batch's single final save confirms — not one
  // giant batch event, keeping the event shape identical to ccGenerateOne's
  // single-metric case for downstream consumers.
  var _genAllEventMetricKeys=[];
  for(const m of metrics){
    if(!aiGenInFlight.active)break; // aborted via "Leave anyway"
    // Re-check the marker each iteration — if the user has navigated away
    // from this batch's view, stop touching the DOM entirely (but keep
    // generating and saving to capStore in the background, since the
    // work itself is still valid, only the on-screen progress display
    // is no longer relevant to show).
    var _stillCurrent=!!getIfCurrentAttempt('cc-main-area',_attempt);
    if(_stillCurrent){
      const sub=document.getElementById('cc-progress-sub');
      const list=document.getElementById('cc-progress-list');
      if(sub)sub.textContent=(gData&&gData.approach==='capability-based')?`Capability ${i+1} of ${metrics.length}: ${m.metricName}`:`Metric ${i+1} of ${metrics.length}: ${m.metricName}`;
      if(list){
        const row=document.createElement('div');
        row.className='cc-progress-row';
        row.id='ccprow-'+i;
        row.innerHTML=`<div class="cc-spin-sm" style="flex-shrink:0;"></div><span style="font-size:11px;color:var(--t3);">${e(m.metricName)}</span>`;
        row.style.cssText='display:flex;align-items:center;gap:8px;';
        list.appendChild(row);
      }
    }
    try{
      const _capInfo2=ccFindMetricInGData(m.metricKey);
      const capDescription2=_capInfo2&&_capInfo2.why?_capInfo2.why:'';
      const txt=await callAPI(
        'You are a senior product strategist. Specific, opinionated, product-native. Respond ONLY with valid JSON. No markdown, no backticks, no preamble. Never use em dashes (—) in your output; use a hyphen (-) or rewrite the phrase.',
        (gData&&gData.approach==='capability-based')
          ?buildCapCanvasPromptCapDriven(_ctx2,gData&&gData.measurementModel&&gData.measurementModel.frameworks?gData.measurementModel.frameworks:[],nsm,m.metricName,m.stageLabel,'',capDescription2)
          :buildCapCanvasPrompt(_ctx2,gData&&gData.measurementModel&&gData.measurementModel.frameworks?gData.measurementModel.frameworks:[],nsm,m.metricName,m.stageLabel,''),
        3000,
        aiGenInFlight.controller?aiGenInFlight.controller.signal:undefined,
        null,
        'cc-gen-all'
      );
      const clean=txt.replace(/```json|```/g,'').trim();
      let parsed;
      try{parsed=JSON.parse(clean);}catch(pe){
        const s=clean.indexOf('{');const l=clean.lastIndexOf('}');
        if(s>=0&&l>s){try{parsed=JSON.parse(clean.substring(s,l+1));}catch(pe2){parsed=null;}}
      }
      if(parsed&&parsed.capabilities){
        const _existNamesAll=_ccGetAllExistingCapNames(m.metricKey);
        capStore[m.metricKey]={
          metricName:m.metricName,stageLabel:m.stageLabel,stageId:m.stageId,
          _docGrounded:batchDocGrounded,
          capabilities:parsed.capabilities.filter(cap=>cap.name&&!_existNamesAll.has(cap.name.toLowerCase().trim())).map(cap=>({
            name:cap.name,why:cap.why,
            subCaps:(cap.sub_capabilities&&cap.sub_capabilities.length>0)?cap.sub_capabilities:null,
            features:[]
          }))
        };
        // Phase 2 (v8.123, live sync): only recorded here, inside the
        // success branch — a metric that failed or returned nothing gets
        // no event, matching what actually happened.
        _genAllEventMetricKeys.push(m.metricKey);
      }
      if(getIfCurrentAttempt('cc-main-area',_attempt)){
        const row=document.getElementById('ccprow-'+i);
        if(row)row.innerHTML=`<i class="ti ti-check" style="color:var(--green);font-size:12px;" aria-hidden="true"></i><span style="color:var(--t2);">${e(m.metricName)}</span>`;
      }
    }catch(err){
      if(err.name==='AbortError')break;
      if(getIfCurrentAttempt('cc-main-area',_attempt)){
        const row=document.getElementById('ccprow-'+i);
        if(row)row.innerHTML=`<i class="ti ti-x" style="color:var(--red);font-size:12px;" aria-hidden="true"></i><span style="color:var(--red);">${e(m.metricName)} — failed</span>`;
      }
    }
    i++;
  }
  endAiGen();
  ccSetGenAllBtnDisabled(false);
  capStoreInvalidated=false;
  ccUpdateTabBadge();
  // Phase 5: checkpoint before the batch's final save. If the lock was
  // lost partway through the batch, whatever was generated so far is
  // discarded rather than saved — the person sees a toast and can retry;
  // this matches the same "don't persist under an uncertain lock" rule
  // used everywhere else, just applied once at the end of a batch instead
  // of per-iteration (per-iteration checkpoints would abandon an
  // otherwise-successful batch over a transient mid-batch heartbeat blip,
  // which is a worse trade for a multi-minute operation than checking once
  // at the natural save point).
  _lock.throwIfLost();
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    var _sessIdForEvent=_activeSessionId;
    var _metricKeysForEvent=_genAllEventMetricKeys.slice();
    // Phase 2 fix (v8.125): awaited, not .then()'d — see ccGenerateOne's
    // matching fix for the full explanation of the lock-release race this
    // closes. Promise.all here since a batch can emit several events.
    const _ok=await sessionStoreSave(_sessIdForEvent);
    if(_ok&&typeof _activeSessionIsShared!=='undefined'&&_activeSessionIsShared&&typeof _lsEmitContentEvent==='function'){
      await Promise.all(_metricKeysForEvent.map(function(mk){
        return _lsEmitContentEvent(_sessIdForEvent,'cc','capabilities_generated',mk,null);
      }));
    }
  }
  // Auto-open navigator after generation — only if this attempt still
  // owns the view; don't yank the user back if they've navigated away.
  if(getIfCurrentAttempt('cc-main-area',_attempt)){
    setTimeout(()=>ccOpenNavigator(),600);
  }
    });
  }catch(lockErr){
    // Phase 5 (v8.117): since the batch loader is only ever written INSIDE
    // the lock callback now (after acquisition is confirmed), a pre-flight
    // rejection never wrote anything to the DOM in the first place —
    // nothing to clean up there. A rethrown lock_lost from the checkpoint
    // already left whatever progress rows were showing (marker-guarded
    // writes above already stopped touching the DOM once this attempt
    // was superseded, if that ever happened). Button/flag reset only.
    ccSetGenAllBtnDisabled(false);
    endAiGen();
  }
}

// ── View a metric from partial list ──
function ccViewMetric(metricKey){
  if(!capStore[metricKey])return;
  capActiveMetricKey=metricKey;
  capActiveCapIdx=0;
  capActiveSubCapIdx=null;
  ccOpenNavigator();
}

// ── Open full navigator (left panel + main area) ──
function ccOpenNavigator(){ccOpenMetricNav();}

// ── Unified metric navigator (items 5-7: replaces partial + empty + old navigator) ──
function ccOpenMetricNav(){
  const el=document.getElementById('cc-main');
  if(!el)return;
  const metrics=ccGetAllL1Metrics();
  const done=ccCountGenerated(); // KPI/PI caps only — used for remaining count and Generate All button
  const hasAnyCaps=Object.keys(capStore).length>0; // includes mi|| and diag|| — used for nav render and routing
  const total=metrics.length;
  const remaining=total-done;
  // Group metrics by stage
  const byStage={};
  metrics.filter(m=>!m.metricKey.startsWith('pi||')).forEach(m=>{
    if(!byStage[m.stageId])byStage[m.stageId]={label:m.stageLabel,id:m.stageId,metrics:[]};
    byStage[m.stageId].metrics.push(m);
  });
  // Build left nav — SC track+node pattern
  // totalCaps = capability count (for internal use), totalFeats = feature count (for badge)
  const totalCaps=Object.values(capStore).reduce((a,entry)=>a+(entry.capabilities?entry.capabilities.length:0),0);
  const totalFeats=Object.values(capStore).reduce((a,entry)=>{
    return a+(entry.capabilities||[]).reduce((b,cap)=>{
      return b+(cap.featStore&&cap.featStore.top?cap.featStore.top.length:0);
    },0);
  },0);
  const allActive=capActiveMetricKey===null&&hasAnyCaps;
  // All capabilities item — badge shows total FEATURE count (same unit as cap node badges)
  let navHtml=hasAnyCaps?`<div class="cc-nav-all${allActive?' active':''}" onclick="ccMNSelectAll()" data-metric-key="__all__">
    <i class="ti ti-layout-grid" style="font-size:11px;" aria-hidden="true"></i>
    <span class="cc-nav-all-text">All Capabilities</span>
    <span class="cc-nav-count${allActive?' active':''}">${totalCaps}</span>
  </div>`:'';
  Object.values(byStage).forEach(sg=>{
    const color=ccStageColor(sg.id);
    // Stage bar (SC sc-nav-stage pattern)
    navHtml+=`<div class="cc-nav-stage">
      <div class="cc-nav-stage-bar" style="background:${color};"></div>
      <span class="cc-nav-stage-lbl" style="color:${color};">${e(sg.label)}</span>
    </div>`;
    sg.metrics.forEach(m=>{
      const injectedKey=ccFindInjectedCapKey(m.metricName); // diag|| only
      const isDone=!!capStore[m.metricKey]||(injectedKey!==null);
      const capCount=isDone?(capStore[m.metricKey]?(capStore[m.metricKey].capabilities||[]).length:0)+(injectedKey?(capStore[injectedKey].capabilities||[]).length:0):0;
      const isMetricActive=capActiveMetricKey===m.metricKey||(injectedKey&&capActiveMetricKey===injectedKey);
      const _metricCapCount=capCount;
      const _isMetricActive=isMetricActive;
      navHtml+=`<div class="cc-nav-metric cc-nav-metric-clickable${_isMetricActive?' cc-nav-metric-active':''}" onclick="ccMNSelectMetric('${e(m.metricKey)}')" title="${isDone?'View capabilities':'Click to generate capabilities'}" data-metric-key="${e(m.metricKey)}">${e(m.metricName)}${isDone?`<span class="cc-nav-count">${_metricCapCount}</span>`:''}</div>`;
    });
  });
  // Combined nav: always show KPI metrics + Custom Capabilities if pi|| keys exist
  const isPIFirst=(typeof piMode!=='undefined'&&piMode)||(typeof piFirstBuilt!=='undefined'&&piFirstBuilt);
  const piKeys=Object.keys(capStore).filter(k=>k.startsWith('pi||'));
  const hasPICaps=piKeys.length>0;
  // v9.05 fix: previously this rendered ONE combined nav row for ALL pi||
  // capabilities regardless of how many distinct custom process areas/
  // metrics actually existed (bucketId was introduced for the main content
  // area's grouping but this sidebar was never updated to match) — causing
  // a visible mismatch immediately after adding a capability to a NEW
  // bucket (sidebar showed 1 combined row, main area showed 2+ separate
  // bucket groups) until an unrelated full re-render happened to paper
  // over it. Now renders one row per distinct bucketId, exactly mirroring
  // ccRenderAllCaps()'s/ccRenderPICapView()'s own grouping.
  const _piBucketNavGroups={};
  piKeys.forEach(k=>{
    const entry=capStore[k];
    if(!entry)return;
    const _bId=entry.bucketId||(typeof PI_BUCKET_LEGACY_ID!=='undefined'?PI_BUCKET_LEGACY_ID:'__legacy_unbucketed__');
    if(!_piBucketNavGroups[_bId])_piBucketNavGroups[_bId]={bucketId:_bId,metricName:entry.metricName||'Custom Process Area',keys:[],capCount:0};
    _piBucketNavGroups[_bId].keys.push(k);
    _piBucketNavGroups[_bId].capCount+=(entry.capabilities||[]).length;
  });
  const piTotalCaps=piKeys.reduce((a,k)=>a+(capStore[k].capabilities?capStore[k].capabilities.length:0),0);
  // Combined nav: KPI nav + PI Plan section (if PI caps exist) + Market Intelligence section (if mi|| caps exist)
  let leftNavContent=navHtml||'';
  if(hasPICaps){
    leftNavContent+=`<div class="cc-nav-stage">
      <div class="cc-nav-stage-bar" style="background:var(--green);"></div>
      <span class="cc-nav-stage-lbl" style="color:var(--green);">${e(typeof getPiStageLabel==='function'?getPiStageLabel(gData):'Custom Value Stage')}</span>
    </div>`;
    Object.values(_piBucketNavGroups).forEach(bucketGroup=>{
      const _bucketActive=capActiveMetricKey===('bucket:'+bucketGroup.bucketId);
      leftNavContent+=`<div class="cc-nav-metric cc-nav-metric-clickable${_bucketActive?' cc-nav-metric-active':''}" onclick="ccMNSelectPIBucket('${e(bucketGroup.bucketId)}')" title="View this custom process area">${e(bucketGroup.metricName)}${bucketGroup.capCount>0?`<span class="cc-nav-count">${bucketGroup.capCount}</span>`:''}</div>`;
    });
  }
  // Market Intelligence section — single mi||capabilities key, one "MI Capabilities" nav item
  const miEntry=capStore['mi||capabilities'];
  if(miEntry){
    const miColor='var(--purple)';
    const miCapCount=(miEntry.capabilities||[]).length;
    const miActive=capActiveMetricKey==='mi||capabilities';
    leftNavContent+=`<div class="cc-nav-stage">
      <div class="cc-nav-stage-bar" style="background:${miColor};"></div>
      <span class="cc-nav-stage-lbl" style="color:${miColor};">Market Intelligence</span>
    </div>
    <div class="cc-nav-metric cc-nav-metric-clickable${miActive?' cc-nav-metric-active':''}" onclick="ccMNSelectMI('mi||capabilities')" title="View Market Intelligence capabilities">MI Capabilities${miCapCount>0?`<span class="cc-nav-count">${miCapCount}</span>`:''}</div>`;
  }
  if(!leftNavContent){
    leftNavContent=`<div class="ccmn-empty-msg"><i class="ti ti-hierarchy-2" style="font-size:20px;color:var(--label);margin-bottom:6px;" aria-hidden="true"></i><div>Generate your Discovery Map first to see metrics here.</div></div>`;
  }
  // Persist collapse state before re-rendering
  const _wasCollapsed=document.getElementById('cc-nav')&&document.getElementById('cc-nav').classList.contains('collapsed');
  el.innerHTML=`
    <div class="cc-layout">
      <div class="cc-nav${_wasCollapsed?' collapsed':''}" id="cc-nav">
        <div class="ph" style="flex-shrink:0;">
          <div class="ph-text">
            <div class="ph-title">${(typeof gData!=='undefined'&&gData&&gData.approach==='capability-based')?'Process Areas':'Outcome Metrics'}</div>
            <div class="ph-sub">${(typeof gData!=='undefined'&&gData&&gData.approach==='capability-based')?'Align capabilities across the process areas':'Align capabilities across the KPIs'}</div>
          </div>
          <button class="collapse-btn" onclick="ccToggleNav()" title="${_wasCollapsed?'Expand panel':'Collapse panel'}">
            ${_wasCollapsed
              ?'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/><polyline points="3 18 9 12 3 6"/></svg>'
              :'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/><polyline points="21 18 15 12 21 6"/></svg>'
            }
          </button>
        </div>
        <div class="cc-nav-tree" id="cc-nav-tree">
          ${leftNavContent}
        </div>
      </div>
      <div class="cc-main-area" id="cc-main-area"></div>
    </div>`;
  // Render main content — sync with nav state
  if(!capActiveMetricKey&&hasAnyCaps){
    // Nav shows "All capabilities" as active — render all caps view to match
    ccRenderAllCaps();
  } else {
    ccRenderMainContent();
  }
}

// ── Find diag|| capStore key whose metricName matches a given KPI metric name ──
// Used to resolve PD caps when clicking a metric in the left nav
// MI caps are no longer resolved here — they have their own nav section
function ccFindInjectedCapKey(metricName){
  if(!metricName)return null;
  return Object.keys(capStore).find(k=>
    k.startsWith('diag||')&&
    capStore[k]&&
    capStore[k].metricName===metricName&&
    Array.isArray(capStore[k].capabilities)&&
    capStore[k].capabilities.length>0
  )||null;
}

function ccMNSelectAll(){
  capActiveMetricKey=null;
  capActiveCapIdx=null;capActiveSubCapIdx=null;
  ccOpenMetricNav(); // ccOpenMetricNav calls ccRenderAllCaps when capActiveMetricKey=null
}

// v9.06.02: replaces the old ccMNSelectPIAll(), which always showed ALL
// pi buckets combined regardless of which one was clicked — inconsistent
// with the established, correct behavior for AI-generated process areas
// (clicking one shows only that one). Now takes a specific bucketId and
// sets the bucket:<id> tagged selection, routed through the same
// ccRenderMainContent() used for KPI-linked metrics.
function ccMNSelectPIBucket(bucketId){
  if(!bucketId)return;
  capActiveMetricKey='bucket:'+bucketId;
  capActiveCapIdx=null;capActiveSubCapIdx=null;
  ccOpenMetricNav();
  ccRenderMainContent();
}

function ccMNSelectCap(metricKey,capIdx){
  capActiveMetricKey=metricKey;
  capActiveCapIdx=capIdx;
  capActiveSubCapIdx=null;
  ccOpenMetricNav();
  // v9.06.02: ccRenderPICapView() removed — Custom Value Stage buckets
  // are now selected via ccMNSelectPIBucket() (bucket:<id> tagged
  // selection), not by passing an individual pi|| capability key here.
  ccRenderMainContent();
}

// ── Select a Market Intelligence cap from the MI nav section ──
function ccMNSelectMI(miKey){
  capActiveMetricKey=miKey;
  capActiveCapIdx=null;capActiveSubCapIdx=null;
  ccPanelCapKey=null;
  ccOpenMetricNav();
}

function ccMNSelectMetric(metricKey){
  // If KPI metric has no generated caps but a diag|| cap exists for the same metric name,
  // use the injected key so ccRenderMainContent finds the entry
  const kpiEntry=capStore[metricKey];
  const hasKpiCaps=kpiEntry&&Array.isArray(kpiEntry.capabilities)&&kpiEntry.capabilities.length>0;
  if(!hasKpiCaps){
    const kpiMetric=ccGetAllL1Metrics().find(m=>m.metricKey===metricKey);
    if(kpiMetric){
      const injectedKey=ccFindInjectedCapKey(kpiMetric.metricName); // diag|| only
      if(injectedKey) { metricKey=injectedKey; }
    }
  }
  capActiveMetricKey=metricKey;
  capActiveCapIdx=null;capActiveSubCapIdx=null;
  ccPanelCapKey=null; // close right panel when switching metrics
  ccSelectedCapIds.clear(); // selection is view-scoped — same convention as FC's scSetCapFilter/fcSetStoriesFilter/fcClearFilter, prevents stale cross-metric selections feeding ccGenerateFeaturesForSelected
  // v9.06.02: removed unreachable pi|| branch that called ccRenderPICapView()
  // — this function's only caller (the KPI-metrics nav loop) explicitly
  // filters out pi|| keys before ever invoking this, confirmed via
  // grep. Custom Value Stage buckets are now selected via the separate
  // ccMNSelectPIBucket() function, routed through ccRenderMainContent().
  // Always rebuild full layout for reliable rendering
  ccOpenMetricNav();
}

function ccMNGenerate(metricKey,metricName,stageLabel,stageId){
  capActiveMetricKey=metricKey;
  // Update badge to spinner immediately for visual feedback
  document.querySelectorAll('.ccmn-metric-item').forEach(el=>{
    if(el.querySelector('.ccmn-metric-name')&&el.querySelector('.ccmn-metric-name').textContent===metricName){
      const badge=el.querySelector('.ccmn-badge-gen');
      if(badge)badge.innerHTML='<div class="cc-spin-sm" style="display:inline-block;"></div>';
    }
  });
  ccGenerateOne(metricKey,metricName,stageLabel,stageId,'');
}

function ccToggleNav(){
  const nav=document.getElementById('cc-nav');
  if(!nav)return;
  const isCollapsed=nav.classList.toggle('collapsed');
  // Update collapse button — replace entire button innerHTML for reliability
  const btn=nav.querySelector('.collapse-btn');
  if(btn){
    btn.innerHTML=isCollapsed
      ?'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/><polyline points="3 18 9 12 3 6"/></svg>'
      :'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/><polyline points="21 18 15 12 21 6"/></svg>';
  }
}

// ccRenderLeftNav is now handled inside ccOpenNavigator
function ccRenderLeftNav(){ ccOpenNavigator(); }

function ccRenderTree(){
  const treeEl=document.getElementById('cc-nav-tree');
  if(!treeEl)return;
  const metrics=ccGetAllL1Metrics();
  let h='';
  let lastStageId=null;
  metrics.forEach(m=>{
    const entry=capStore[m.metricKey];
    if(!entry)return;
    if(m.stageId!==lastStageId){
      if(lastStageId!==null)h+=`<div class="cc-tree-divider"></div>`;
      const stageColor=ccStageColor(m.stageId);
      h+=`<div class="cc-tree-stage-lbl"><span class="cc-tree-stage-dot" style="background:${stageColor}"></span>${e(m.stageLabel)}</div>`;
      lastStageId=m.stageId;
    }
    const isMetricActive=capActiveMetricKey===m.metricKey;
    entry.capabilities.forEach((cap,ci)=>{
      const hasSubCaps=cap.subCaps&&cap.subCaps.length>0;
      const isCapActive=isMetricActive&&capActiveCapIdx===ci&&capActiveSubCapIdx===null;
      const isCapExpanded=isMetricActive&&capActiveCapIdx===ci;
      // Sub-caps rendered inside tree-cap so CSS open class can show/hide them
      let subCapHtml='';
      if(hasSubCaps){
        subCapHtml='<div class="cc-tree-subcaps">';
        cap.subCaps.forEach((sc,si)=>{
          const isScActive=isMetricActive&&capActiveCapIdx===ci&&capActiveSubCapIdx===si;
          subCapHtml+=`<div class="cc-tree-subcap ${isScActive?'cc-tree-subcap-active':''}" onclick="event.stopPropagation();ccSelectSubCap('${e(m.metricKey)}',${ci},${si})">
            <span class="cc-tree-subcap-dot${isScActive?' cc-tree-subcap-dot-active':''}"></span>
            <span class="cc-tree-subcap-name">${e(sc.name)}</span>
          </div>`;
        });
        subCapHtml+='</div>';
      }
      h+=`<div class="cc-tree-cap${isCapActive?' cc-tree-cap-active':''}${isCapExpanded&&hasSubCaps?' open':''}" onclick="ccSelectCap('${e(m.metricKey)}',${ci})">
        <div class="cc-tree-cap-inner">
          <span class="cc-tree-chevron">${hasSubCaps?'&#9658;':''}</span>
          <span class="cc-tree-dot"></span>
          <span class="cc-tree-cap-name">${e(cap.name)}</span>
        </div>

        ${subCapHtml}
      </div>`;
    });
  });
  treeEl.innerHTML=h||'<div style="padding:12px;font-size:11px;color:var(--t3);">No capabilities generated yet.</div>';
}

function ccSelectCap(metricKey,capIdx){
  capActiveMetricKey=metricKey;
  capActiveCapIdx=capIdx;
  capActiveSubCapIdx=null;
  ccRenderTree();
  ccRenderMainArea();
}

function ccSelectSubCap(metricKey,capIdx,subCapIdx){
  capActiveMetricKey=metricKey;
  capActiveCapIdx=capIdx;
  capActiveSubCapIdx=subCapIdx;
  ccRenderTree();
  ccRenderMainArea();
}

// ── All capabilities view — grouped by stage › metric ──
function ccRenderAllCaps(){
  const el=document.getElementById('cc-main-area')||document.getElementById('cc-main');
  if(!el)return;
  // Save scroll position — re-render (e.g. after Send to FC) must not jump to top
  const _scrollEl=el.querySelector('.cc-cap-grid-wrap');
  const _savedScroll=_scrollEl?_scrollEl.scrollTop:0;
  if(!Object.keys(capStore).length){
    el.innerHTML=`<div class="cc-cap-grid-empty"><i class="ti ti-layers-subtract" style="font-size:32px;color:var(--label);" aria-hidden="true"></i><div style="font-size:14px;font-weight:600;color:var(--t2);margin-top:12px;">No capabilities yet</div></div>`;
    return;
  }
  // v8.56: iterate in DM stage→metric order (matches left nav) instead of capStore insertion order
  const miCaps=[];
  // Collect mi|| caps for unified group at bottom (pi|| is now handled
  // directly by the generic per-process-area loop below, via
  // ccGetAllL1Metrics() — see v9.06.02 note further down)
  Object.keys(capStore).filter(k=>k.startsWith('mi||')).forEach(mk=>{
    const entry=capStore[mk];if(!entry)return;
    (entry.capabilities||[]).forEach((cap,ci)=>{miCaps.push({metricKey:mk,capIdx:ci,cap,entry});});
  });
  // Collect diag|| caps — appended after ordered metrics, before pi/mi
  const diagMetrics=[];
  Object.keys(capStore).filter(k=>k.startsWith('diag||')).forEach(mk=>{
    const entry=capStore[mk];
    if(entry)diagMetrics.push({metricKey:mk,metricName:entry.metricName,stageLabel:entry.stageLabel||'Experiment Canvas',stageId:entry.stageId||'diag',entry});
  });
  // v9.06.02: Custom Value Stage buckets now render through this SAME
  // generic per-process-area loop as every other stage — matching the
  // confirmed reference behavior (one unconditional, standalone header row
  // per process area, never a special two-level "outer stage wrapper").
  // ccGetAllL1Metrics() returns one row PER CAPABILITY for pi|| entries
  // (each capability has its own capStore key) — dedupe down to one row
  // PER BUCKET (matching the AI-generated case, where one row = one
  // process area, not one row per capability).
  const _allL1=ccGetAllL1Metrics();
  const _seenBucketIds={};
  const _orderedDMMetrics=_allL1.filter(m=>{
    if(!m.metricKey.startsWith('pi||'))return true;
    const bId=m.bucketId||'__legacy_unbucketed__';
    if(_seenBucketIds[bId])return false;
    _seenBucketIds[bId]=true;
    return true;
  });
  const _allOrderedMetrics=[..._orderedDMMetrics,...diagMetrics];
  let html='<div class="cc-all-caps-wrap">';
  _allOrderedMetrics.forEach(({metricKey:mk,metricName:_mn,stageLabel,stageId,entry:_e,bucketId:_bucketId})=>{
    // v9.06.02: for pi-stage buckets, synthesize a virtual "entry" by
    // merging every capStore['pi||'+capName] key sharing this bucketId —
    // a bucket maps to MANY capStore keys (one per capability), unlike an
    // ordinary metric where metricKey IS the capStore key directly.
    let entry=_e||capStore[mk];
    let _displayMetricKey=mk; // used for onclick handlers below — for pi buckets this must stay a REAL capStore key per-capability, resolved inside the per-cap loop, not this synthetic one
    if(mk.startsWith('pi||')&&_bucketId){
      const _mergedCaps=[];
      Object.keys(capStore).forEach(k=>{
        const e2=capStore[k];
        if(e2&&e2.bucketId===_bucketId){
          (e2.capabilities||[]).forEach((cap,ci)=>{_mergedCaps.push({_realKey:k,_realIdx:ci,cap});});
        }
      });
      entry={
        metricName:(entry&&entry.metricName)||_mn||'Custom Process Area',
        stageLabel:(entry&&entry.stageLabel)||stageLabel||'',
        stageId:'pi',
        capabilities:_mergedCaps.map(x=>x.cap),
        _piMergedRefs:_mergedCaps // real {key, idx} pairs, positionally aligned with capabilities[] above
      };
    }
    if(!entry)return; // metric not yet generated — skip
    const metricName=entry.metricName||_mn||'';
    const _stageLabel=entry.stageLabel||stageLabel||'';
    const _stageId=entry.stageId||stageId||'';
    const _stageColor=ccStageColor(_stageId);
    const caps=entry.capabilities||[];
      // Apply card filter
      const filteredCaps=caps.filter((cap,ci)=>{
        if(!ccCapFilter.size)return true;
        const hasFeat=!!(cap.featStore&&cap.featStore.top&&cap.featStore.top.length>0);
        const _wantWith=ccCapFilter.has('with-features');
        const _wantWithout=ccCapFilter.has('without-features');
        if(_wantWith&&!_wantWithout&&!hasFeat)return false;
        if(_wantWithout&&!_wantWith&&hasFeat)return false;
        const _wOriginKpi=ccCapFilter.has('origin-kpi');
        const _wOriginDoc=ccCapFilter.has('origin-doc');
        const _wOriginCustom=ccCapFilter.has('origin-custom');
        const _wOriginMi=ccCapFilter.has('origin-mi');
        const _wOriginDiag=ccCapFilter.has('origin-diag');
        const _hasOriginFilter=_wOriginKpi||_wOriginDoc||_wOriginCustom||_wOriginMi||_wOriginDiag;
        if(_hasOriginFilter){
          const _isDoc=!!(entry&&entry._docGrounded);
          const _isCustom=!!(cap._manual||entry._piFirst);
          const _isMI=!!(entry&&typeof entry.metricKey==='string'&&entry.metricKey.startsWith('mi||'));
          const _isDiag=!!(entry&&typeof entry.metricKey==='string'&&entry.metricKey.startsWith('diag||'));
          const _isKpi=!_isDoc&&!_isCustom&&!_isMI&&!_isDiag;
          if(_wOriginDoc&&_isDoc)return true;
          if(_wOriginCustom&&_isCustom)return true;
          if(_wOriginMi&&_isMI)return true;
          if(_wOriginDiag&&_isDiag)return true;
          if(_wOriginKpi&&_isKpi)return true;
          return false;
        }
        return true;
      });
      if(filteredCaps.length===0)return;
      const _groupToggleKey=(mk.startsWith('pi||')&&_bucketId)?('bucket:'+_bucketId):mk;
      const _isCollapsed=ccCollapsedGroups.has(_groupToggleKey);
      html+=`<div class="cc-all-group-hdr" style="border-left:3px solid ${_stageColor}"><span class="cc-all-stage-pill" style="background:${_stageColor}">${e(_stageLabel)}</span><span class="cc-all-metric-name">${e(metricName)}</span><span class="cc-all-metric-count">${caps.length} cap${caps.length!==1?'s':''}</span><button class="nsc-chevron" onclick="ccToggleGroup('${e(_groupToggleKey)}')" title="${_isCollapsed?'Expand':'Collapse'}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${_isCollapsed?'<polyline points="9 18 15 12 9 6"/>':'<polyline points="18 15 12 9 6 15"/>'}</svg></button></div>`;
      if(_isCollapsed){
        html+=`<div class="nsc-collapsed-hint" style="margin:0 22px;">Capabilities hidden — click ▶ to expand</div>`;
      } else {
        html+=`<div class="cc-cap-cards-grid" style="padding:0 22px 12px;">`;
      filteredCaps.forEach((cap)=>{
        const ci=caps.indexOf(cap);
        // v9.06.02: for a pi-bucket's MERGED virtual entry, mk/ci above are
        // synthetic (mk is just the first capability's real key) — each
        // individual card must resolve to ITS OWN real capStore key+index
        // via _piMergedRefs, or actions (open panel, edit, remove, select)
        // would silently operate on the wrong capability.
        const _realRef=(entry._piMergedRefs&&entry._piMergedRefs[ci])?entry._piMergedRefs[ci]:null;
        const _cardKey=_realRef?_realRef._realKey:mk;
        const _cardIdx=_realRef?_realRef._realIdx:ci;
        const features=cap.featStore?cap.featStore.top:null;
        const featCount=features?features.length:0;
        const stageColor=ccStageColor(entry.stageId);
        const _acFeat=cap.featStore&&cap.featStore.top&&cap.featStore.top.length>0;
        const _acActive=capActiveMetricKey===_cardKey&&capActiveCapIdx===_cardIdx;
        const _acState=_acActive?' cc-cap-card-active':_acFeat?' cc-cap-card-done':'';
        const _acIsPi=_cardKey.startsWith('pi||');
        const _acIsManual=!!(cap._manual);
        const _acOriginIcon=entry._docGrounded?'ti-file-text':(_acIsPi||_acIsManual)?'ti-clipboard-list':'ti-hierarchy-2';
        const _acOriginColor=entry._docGrounded?'var(--orange)':(_acIsPi||_acIsManual)?'var(--green)':'var(--blue)';
        const _acMetricLbl=_acIsPi?(entry&&entry.metricName?entry.metricName:'Custom Process Area'):e(metricName);
        const _acIsSel=ccSelectedCapIds.has(_cardKey+'|'+_cardIdx);
        const _acFeatSelState=ccGetFeatSelState(cap);
        const _acCardState=_acActive?' cc-cap-card-done cc-cap-card-active':_acFeat?' cc-cap-card-done':_acIsSel?' cc-cap-card-sel':'';
        const _acCardId='cc-cap-'+_cardKey.replace(/[^a-z0-9|]/gi,'_')+'-'+_cardIdx;
        const _acChkContent=_acFeat?(_acFeatSelState==='all'?'<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>':_acFeatSelState==='partial'?'<div style=\"width:7px;height:2px;background:#fff;border-radius:1px;\"></div>':''):(_acIsSel?'<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>':'');
        const _acChkSel=_acFeat?(_acFeatSelState!=='none'):_acIsSel;
        const _canEditCcCard1=(typeof canEditSession!=='function')||canEditSession();
        html+=`<div class="cc-cap-card${_acCardState}" id="${_acCardId}" onclick="ccOpenCapPanel('${e(_cardKey)}',${_cardIdx})" style="cursor:pointer;" title="">
          <div class="cc-card-top">
            <span class="cc-card-mlbl">${_acMetricLbl}</span>
            <div class="cc-card-actions">
              ${_canEditCcCard1?`<button class="cc-card-pencil" onclick="event.stopPropagation();ccShowEditCapModal('${e(_cardKey)}',${_cardIdx})" title="Edit capability" aria-label="Edit capability"><i class="ti ti-pencil" style="font-size:10px;" aria-hidden="true"></i></button>`:''}
              <div class="cc-card-chk${_acChkSel?' cc-card-chk-sel':''}${_canEditCcCard1?'':' cc-card-chk-disabled'}" ${_canEditCcCard1?`onclick="event.stopPropagation();ccToggleCapSelect('${e(_cardKey)}',${_cardIdx})"`:''}>${_acChkContent}</div>
              ${_canEditCcCard1?`<button class="cc-card-remove" onclick="event.stopPropagation();ccRemoveCapability('${e(_cardKey)}',${_cardIdx})" title="Remove"><i class="ti ti-x" style="font-size:9px;" aria-hidden="true"></i></button>`:''}
            </div>
          </div>
          <div class="cc-cap-card-name-row"><i class="ti ${_acOriginIcon}" style="font-size:10px;color:${_acOriginColor};flex-shrink:0;margin-top:2px;" aria-hidden="true"></i><div class="cc-cap-card-name">${e(cap.name)}</div></div>
          <div class="cc-cap-card-why">${e(cap.why||'')}</div>
          <div class="cc-cap-card-footer">
            ${(()=>{
              const _acInFCCount=features?features.filter(f=>{const fid=typeof scMakeFeatureId==='function'?scMakeFeatureId(f.metric,f.cap+(f.subCap?'/'+f.subCap:''),f.name):'';return fid&&scCanvas&&scCanvas.find(x=>x.id===fid);}).length:0;
              if(_acFeat)return '<div class="cc-cap-status-done"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span class="cc-feat-badge">'+featCount+' feature'+(featCount!==1?'s':'')+'</span></div>'+(_acInFCCount>0?'<div class="cc-feat-insc-tag"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> '+_acInFCCount+' in Feature Canvas</div>':'');
              return '<div class="cc-cap-status-none"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg> No features yet</div>';
            })()}
          </div>
        </div>`;
      });
      if(!_isCollapsed){html+=`</div>`;}
      }  // close else block
  });
  // Add MI caps as single unified group — one Market Intelligence header, all MI caps underneath
  if(miCaps.length>0){
    const miColor='var(--purple)';
    const filteredMiCaps=miCaps.filter(({cap})=>{
      if(!ccCapFilter.size)return true;
      const _hasOriginF=ccCapFilter.has('origin-kpi')||ccCapFilter.has('origin-doc')||ccCapFilter.has('origin-custom')||ccCapFilter.has('origin-mi')||ccCapFilter.has('origin-diag');
      if(_hasOriginF&&!ccCapFilter.has('origin-mi'))return false;
      const hasFeat=!!(cap.featStore&&cap.featStore.top&&cap.featStore.top.length>0);
      const _hasOriginFPI=ccCapFilter.has('origin-kpi')||ccCapFilter.has('origin-doc')||ccCapFilter.has('origin-custom')||ccCapFilter.has('origin-mi')||ccCapFilter.has('origin-diag');
      if(_hasOriginFPI&&!ccCapFilter.has('origin-custom'))return false;
      const _wWith=ccCapFilter.has('with-features');
      const _wWithout=ccCapFilter.has('without-features');
      if(_wWith&&_wWithout)return true;
      if(_wWith)return hasFeat;
      if(_wWithout)return !hasFeat;
      return true;
    });
    if(filteredMiCaps.length>0){
      const _miCollapsed=ccCollapsedGroups.has('mi||all');
      html+=`<div class="cc-all-group-hdr" style="border-left:3px solid ${miColor}"><span class="cc-all-stage-pill" style="background:${miColor}">Market Intelligence</span><span class="cc-all-metric-name">MI Capabilities</span><span class="cc-all-metric-count">${miCaps.length} cap${miCaps.length!==1?'s':''}</span><button class="nsc-chevron" onclick="ccToggleGroup('mi||all')" title="${_miCollapsed?'Expand':'Collapse'}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${_miCollapsed?'<polyline points="9 18 15 12 9 6"/>':'<polyline points="18 15 12 9 6 15"/>'}</svg></button></div>`;
      if(_miCollapsed){
        html+=`<div class="nsc-collapsed-hint" style="margin:0 22px;">Capabilities hidden — click ▶ to expand</div>`;
      } else {
        html+=`<div class="cc-cap-cards-grid" style="padding:0 22px 12px;">`;
        filteredMiCaps.forEach(({metricKey,capIdx:ci,cap})=>{
          const features=cap.featStore?cap.featStore.top:null;
          const featCount=features?features.length:0;
          const _acFeat=!!(features&&featCount>0);
          const _acActive=capActiveMetricKey===metricKey&&capActiveCapIdx===ci;
          const _acIsSel=ccSelectedCapIds.has(metricKey+'|'+ci);
          const _acFeatSelState=ccGetFeatSelState(cap);
          const _acChkContent=_acFeat?(_acFeatSelState==='all'?'<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>':_acFeatSelState==='partial'?'<div style=\"width:7px;height:2px;background:#fff;border-radius:1px;\"></div>':''):(_acIsSel?'<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>':'');
          const _acChkSel=_acFeat?(_acFeatSelState!=='none'):_acIsSel;
          const _acCardState=_acActive?' cc-cap-card-done cc-cap-card-active':_acFeat?' cc-cap-card-done':_acIsSel?' cc-cap-card-sel':'';
          const _acCardId='cc-cap-'+metricKey.replace(/[^a-z0-9|]/gi,'_')+'-'+ci;
          const _miInFCCount=features?features.filter(f=>{const fid=typeof scMakeFeatureId==='function'?scMakeFeatureId(f.metric,f.cap+(f.subCap?'/'+f.subCap:''),f.name):'';return fid&&scCanvas&&scCanvas.find(x=>x.id===fid);}).length:0;
          const _canEditCcCard2=(typeof canEditSession!=='function')||canEditSession();
          html+=`<div class="cc-cap-card${_acCardState}" id="${_acCardId}" onclick="ccOpenCapPanel('${e(metricKey)}',${ci})" style="cursor:pointer;" title="">
            <div class="cc-card-top">
              <span class="cc-card-mlbl" style="color:${miColor};">Market Intel</span>
              <div class="cc-card-actions">
                ${_canEditCcCard2?`<button class="cc-card-pencil" onclick="event.stopPropagation();ccShowEditCapModal('${e(metricKey)}',${ci})" title="Edit capability" aria-label="Edit capability"><i class="ti ti-pencil" style="font-size:10px;" aria-hidden="true"></i></button>`:''}
                <div class="cc-card-chk${_acChkSel?' cc-card-chk-sel':''}${_canEditCcCard2?'':' cc-card-chk-disabled'}" ${_canEditCcCard2?`onclick="event.stopPropagation();ccToggleCapSelect('${e(metricKey)}',${ci})"`:''}>${_acChkContent}</div>
                ${_canEditCcCard2?`<button class="cc-card-remove" onclick="event.stopPropagation();ccRemoveCapability('${e(metricKey)}',${ci})" title="Remove"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`:''}
              </div>
            </div>
            <div class="cc-cap-card-name-row"><i class="ti ti-world-search" style="font-size:10px;color:${miColor};flex-shrink:0;margin-top:2px;" aria-hidden="true"></i><div class="cc-cap-card-name">${e(cap.name)}</div></div>
            <div class="cc-cap-card-why">${e(cap.why||'')}</div>
            <div class="cc-cap-card-footer">
              ${_acFeat?'<div class="cc-cap-status-done"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg><span class="cc-feat-badge">'+featCount+' feature'+(featCount!==1?'s':'')+'</span></div>'+(_miInFCCount>0?'<div class="cc-feat-insc-tag"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> '+_miInFCCount+' in Feature Canvas</div>':''):'<div class="cc-cap-status-none"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg> No features yet</div>'}
            </div>
          </div>`;
        });
        html+=`</div>`;
      }
    }
  }
  // v9.06.02: the redundant hand-rolled "piCaps" special-case block that
  // used to render here (a two-level "outer stage wrapper + inner bucket
  // sub-header" structure) has been REMOVED — Custom Value Stage buckets
  // now render through the SAME generic per-process-area loop above as
  // every other stage, producing one unconditional, standalone header row
  // per bucket, exactly matching the confirmed reference behavior for
  // AI-generated process areas (e.g. "Organic Discovery & Signup Flow"
  // and "Referral Program Integration" each get their own full header,
  // never merged under a shared "Acquisition" wrapper).
  // Empty state when filter matches nothing
  const _filterLabels={'without-features':'Without features','with-features':'With features'};
  if(ccCapFilter.size&&!html.includes('cc-cap-card')){
    html+=`<div style="padding:40px 20px;text-align:center;color:var(--t3);">
      <div style="font-size:13px;font-weight:600;color:var(--t2);margin-bottom:8px;">No capabilities match the current filter</div>
      <div style="font-size:11px;margin-bottom:14px;">Try clearing the filter to see all capabilities.</div>
      <button onclick="ccSetCapFilter(null)" style="background:none;border:1px solid var(--divider);border-radius:5px;padding:5px 12px;font-size:11px;cursor:pointer;color:var(--t2);">Clear filter</button>
    </div>`;
  }
  html+='</div>';
  // Right panel: only show if a cap is actively selected
  let allCapsRp=null;
  if(capActiveMetricKey&&capStore[capActiveMetricKey]&&capActiveCapIdx!==null){
    const ae=capStore[capActiveMetricKey];
    const ac=ae.capabilities[capActiveCapIdx];
    if(ac)allCapsRp=ccBuildFeatPanel(ae,ac,capActiveCapIdx);
  }
  el.innerHTML=`<div style="display:flex;flex:1;overflow:hidden;min-height:0;">
    <div class="cc-cap-grid-wrap" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;">
      <div class="cc-cap-grid-hdr">
        <div class="cc-toolbar-l">
          <span class="cc-canvas-title">Capability Canvas</span>
          <span class="cc-count-badge" id="cc-cap-count-badge-all">${ccGetTotalCaps()} capabilities</span>
          ${ccGetTotalFeats()>0?`<span class="cc-done-badge"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> ${ccGetTotalFeats()} features</span>`:''}
          ${(ccCapFilter.size>0)?`<span id="cc-filter-badge" style="display:inline-flex;font-size:9px;font-weight:700;background:var(--card-purple);color:var(--purple);border:1px solid #CECBF6;border-radius:10px;padding:2px 8px;align-items:center;gap:5px;"><i class="ti ti-filter" style="font-size:9px;"></i> ${ccCapFilter.size} filter${ccCapFilter.size!==1?'s':''} <span onclick="ccSetCapFilter(null)" style="cursor:pointer;color:var(--t3);margin-left:2px;" title="Clear filter">&#x2715;</span></span>`:''}
        </div>
        <div style="display:flex;gap:7px;align-items:center;">
          <div class="cc-export-wrap" style="position:relative;"><button class="cc-tb-btn${ccCapFilter.size>0?' active':''}" id="cc-cap-filter-btn" onclick="ccToggleCCFilterDrop(event)" style="display:flex;align-items:center;gap:4px;"><i class="ti ti-filter" style="font-size:10px;" aria-hidden="true"></i> Filter <i class="ti ti-chevron-down" style="font-size:10px;" aria-hidden="true"></i></button><div class="cc-export-drop" id="cc-cap-filter-drop"><div style="padding:8px 12px 4px;font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--label);">Capabilities</div><label class="fc-filter-row"><input type="checkbox" ${ccCapFilter.has('without-features')?'checked':''} onchange="ccSetCapFilter('without-features')"> Without features</label><label class="fc-filter-row"><input type="checkbox" ${ccCapFilter.has('with-features')?'checked':''} onchange="ccSetCapFilter('with-features')"> With features</label><div style="height:0.5px;background:var(--divider);margin:4px 0;"></div><div style="padding:4px 12px 4px;font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--label);">Origin</div><label class="fc-filter-row"><input type="checkbox" ${ccCapFilter.has('origin-kpi')?'checked':''} onchange="ccSetCapFilter('origin-kpi')"> <i class="ti ti-hierarchy-2" style="font-size:11px;color:var(--blue);" aria-hidden="true"></i> Discovery Map</label><label class="fc-filter-row"><input type="checkbox" ${ccCapFilter.has('origin-doc')?'checked':''} onchange="ccSetCapFilter('origin-doc')"> <i class="ti ti-file-text" style="font-size:11px;color:var(--orange);" aria-hidden="true"></i> Session document</label><label class="fc-filter-row"><input type="checkbox" ${ccCapFilter.has('origin-custom')?'checked':''} onchange="ccSetCapFilter('origin-custom')"> <i class="ti ti-clipboard-list" style="font-size:11px;color:var(--green);" aria-hidden="true"></i> Custom plan</label><label class="fc-filter-row"><input type="checkbox" ${ccCapFilter.has('origin-mi')?'checked':''} onchange="ccSetCapFilter('origin-mi')"> <i class="ti ti-world-search" style="font-size:11px;color:var(--purple);" aria-hidden="true"></i> Market intelligence</label><label class="fc-filter-row"><input type="checkbox" ${ccCapFilter.has('origin-diag')?'checked':''} onchange="ccSetCapFilter('origin-diag')"> <i class="ti ti-microscope" style="font-size:11px;color:var(--amber);" aria-hidden="true"></i> Diagnostics</label>${_ccOriginRaFilterHtml()}<div style="border-top:1px solid var(--divider);margin:4px 0;"></div><div style="padding:4px 12px 8px;"><button onclick="ccSetCapFilter(null)" style="font-size:10px;color:var(--purple);background:none;border:none;cursor:pointer;font-family:var(--font);padding:0;">Clear all filters</button></div></div></div>
          <button class="tm-dots" onclick="_uiRowMenuToggle(this,ccToolbarMenuHtml())" aria-label="Capability Canvas actions" aria-haspopup="true" aria-expanded="false"><i class="ti ti-dots-vertical" aria-hidden="true"></i></button>
        </div>
      </div>
      <div class="cc-legend">
        <span class="cc-legend-lbl">Card states</span>
        <div class="cc-legend-item"><div class="cc-legend-bar lb-none"></div> No features yet</div>
        <div class="cc-legend-item"><div class="cc-legend-bar lb-done"></div> Features generated</div>
        <div class="cc-legend-item"><div class="cc-legend-bar lb-sel"></div> Selected</div>
        <span class="cc-legend-sep"></span>
        <span class="cc-legend-lbl" style="margin-left:4px;">Origin</span>
        <div class="cc-legend-item"><i class="ti ti-hierarchy-2" style="font-size:11px;color:var(--blue);" aria-hidden="true"></i> Discovery Map</div>
        <div class="cc-legend-item"><i class="ti ti-file-text" style="font-size:11px;color:var(--orange);" aria-hidden="true"></i> Session doc</div>
        <div class="cc-legend-item"><i class="ti ti-clipboard-list" style="font-size:11px;color:var(--green);" aria-hidden="true"></i> Custom plan</div>
        <div class="cc-legend-item"><i class="ti ti-world-search" style="font-size:11px;color:var(--purple);" aria-hidden="true"></i> Market intel</div>
        <div class="cc-legend-item"><i class="ti ti-microscope" style="font-size:11px;color:var(--amber);" aria-hidden="true"></i> Diagnostics</div>
      </div>
      <div style="flex:1;overflow-y:auto;">${html}</div>
      ${_ccActionBarHtml()}
    </div>
    ${allCapsRp!==null?`<div class="cc-feat-panel" id="cc-feat-panel">${allCapsRp}</div>`:''}
  </div>`;
  // Sync action bar after render — matches fcRenderCanvas's pattern and the
  // identical fix applied to ccRenderMainContent.
  ccUpdateActionBar();
  // Restore scroll position after full innerHTML rebuild (e.g. after Send to FC)
  const _newScrollEl=el.querySelector('.cc-cap-grid-wrap');
  if(_newScrollEl&&_savedScroll>0)_newScrollEl.scrollTop=_savedScroll;
}

// ── Main area rendering ──
function ccRenderMainArea(){const t=document.getElementById('cc-main-area');if(t)return ccRenderMainContent();ccRenderMainContent();}
// ── Main content: capability card grid for selected metric ──
function ccRenderMainContent(){
  const el=document.getElementById('cc-main-area')||document.getElementById('cc-main');
  if(!el)return;
  if(!capActiveMetricKey){
    const _isCap=gData&&gData.approach==='capability-based';
    el.innerHTML=`<div class="cc-cap-grid-empty">
      <i class="ti ti-layers-subtract" style="font-size:32px;color:var(--label);" aria-hidden="true"></i>
      <div style="font-size:14px;font-weight:600;color:var(--t2);margin-top:12px;">${_isCap?'Select a process area':'Select a metric'}</div>
      <div style="font-size:12px;color:var(--t3);max-width:280px;line-height:1.5;margin-top:4px;">${_isCap?'Choose a process area from the left panel to view its capabilities.':'Choose a metric from the left panel to view its capabilities.'}</div>
    </div>`;
    return;
  }
  // v9.06.02: bucket-aware resolution via the shared resolver, checked
  // BEFORE the "not yet generated" KPI-only empty-state below — a
  // manually-created custom bucket is never "not yet generated" (it
  // always exists the moment a capability is added to it), so that
  // empty-state branch structurally doesn't apply here.
  const _isBucketSelection=capActiveMetricKey.indexOf('bucket:')===0;
  let _group=null;
  if(_isBucketSelection){
    _group=typeof ccResolveCapGroup==='function'?ccResolveCapGroup(capActiveMetricKey):null;
    if(!_group){
      // Bucket is empty/deleted (e.g. last capability just removed by
      // another action, or a stale selection from before a live-sync
      // apply) — clear the stale selection and fall back to the empty
      // "select a process area" state rather than showing broken UI.
      capActiveMetricKey=null;capActiveCapIdx=null;
      ccRenderMainContent();
      return;
    }
  }
  if(!_isBucketSelection&&!capStore[capActiveMetricKey]){
    // Metric selected but not yet generated
    const pendingMetric=ccGetAllL1Metrics().find(m=>m.metricKey===capActiveMetricKey);
    const _isCap=gData&&gData.approach==='capability-based';
    const pendingName=pendingMetric?pendingMetric.metricName:(_isCap?'this capability':'this metric');
    const pendingStage=pendingMetric?pendingMetric.stageLabel:'';
    el.innerHTML=`<div style="display:flex;flex:1;overflow:hidden;min-height:0;">
      <div class="cc-cap-grid-wrap">
        <div class="cc-cap-grid-hdr">
          <div>
            <div class="cc-breadcrumb">${pendingStage?`<span class="cc-ctx-pill-${pendingMetric.stageId}">${e(pendingStage)}</span><span class="cc-ctx-sep">›</span>`:''}
              <span class="cc-ctx-pill" style="background:var(--card-purple);color:var(--purple-deep);">${e(pendingName)}</span></div>
            <div style="font-size:11px;color:var(--t3);margin-top:2px;">No capabilities generated yet</div>
          </div>
        </div>
        <div class="cc-cap-grid-empty" style="flex:1;">
          <i class="ti ti-sparkles" style="font-size:32px;color:var(--label);" aria-hidden="true"></i>
          <div style="font-size:14px;font-weight:600;color:var(--t2);margin-top:12px;">Generate Capabilities</div>
          <div style="font-size:12px;color:var(--t3);max-width:280px;line-height:1.5;margin-top:4px;margin-bottom:16px;">${_isCap?'AI will identify the capabilities that make up <strong>'+e(pendingName)+'</strong>.':'AI will identify the key product capabilities that drive <strong>'+e(pendingName)+'</strong>.'}</div>
          ${((typeof canEditSession!=='function')||canEditSession())?`<div style="display:flex;align-items:center;gap:8px;flex-wrap:nowrap;">
            <button class="gen-btn" style="font-size:11px;padding:8px 16px;width:auto;white-space:nowrap;" onclick="ccGenerateOne('${e(capActiveMetricKey)}','${e(pendingName)}','${e(pendingStage)}','${pendingMetric?e(pendingMetric.stageId):''}',this)"><i class="ti ti-sparkles" style="font-size:11px;" aria-hidden="true"></i> Generate Capabilities</button>
            <button class="cc-ghost-btn" style="font-size:11px;padding:8px 14px;white-space:nowrap;" onclick="ccGenerateAll()"><i class="ti ti-table" style="font-size:10px;" aria-hidden="true"></i> ${_isCap?'Generate for All Capabilities':'Generate for All Metrics'}</button>
            ${ccAddCapBtnHTML('cc-ghost-btn','font-size:11px;padding:8px 14px;white-space:nowrap;')}
          </div>`:`<div style="font-size:11px;color:var(--label);font-style:italic;">No capabilities have been generated yet for this ${_isCap?'capability':'metric'}.</div>`}
        </div>
        <div class="cc-bottom-bar">
          <input type="text" class="cc-bottom-refine" placeholder="Refine or regenerate capabilities…" disabled style="opacity:0.4;cursor:not-allowed;">
          <button class="cc-bottom-send" disabled style="opacity:0.4;"><i class="ti ti-arrow-up" style="font-size:11px;" aria-hidden="true"></i></button>
        </div>
      </div>
    </div>`;
    return;
  }
  // v9.06.02: for a bucket selection, entry/caps are the MERGED virtual
  // view from the resolver — caps[] here is used ONLY for counting/
  // iteration structure below; every per-card ACTION uses the resolved
  // real key/idx from _group.cards[i], never capActiveMetricKey+ci
  // directly, since those would be synthetic/wrong for a merged bucket.
  const entry=_isBucketSelection
    ?{metricName:_group.groupLabel,stageLabel:_group.stageLabel,stageId:_group.stageId,capabilities:_group.cards.map(c=>c.cap),_piMergedCards:_group.cards}
    :capStore[capActiveMetricKey];
  const caps=entry.capabilities||[];
  const isPIFirst=!!(entry._piFirst)||_isBucketSelection;
  const stageLabel=entry.stageLabel||'';
  const metricName=entry.metricName||'';
  // Build capability cards
  let cardsHtml='';
  caps.forEach((cap,ci)=>{
    // v9.06.02: for a bucket selection, ci is an index into the MERGED
    // virtual capabilities[] array — each card must resolve its OWN
    // real capStore key + index (via entry._piMergedCards, positionally
    // aligned) for every action. Using capActiveMetricKey+ci directly
    // here (as the old code did) would misidentify/corrupt the wrong
    // capability for any card past the first one in a merged bucket.
    const _realRef=_isBucketSelection&&entry._piMergedCards&&entry._piMergedCards[ci]?entry._piMergedCards[ci]:null;
    const _cardKey=_realRef?_realRef.realKey:capActiveMetricKey;
    const _cardIdx=_realRef?_realRef.realIdx:ci;
    const featKey='top';
    const features=cap.featStore?cap.featStore[featKey]:null;
    const featCount=features?features.length:0;
    const selectedCount=features?features.filter(f=>f.selected).length:0;
    const isFromPlan=isPIFirst&&features&&features.length>0;
    const _capKey=_cardKey+'|'+_cardIdx;
    const _hasFeat=!!(features&&featCount>0);
    const _isSel=ccSelectedCapIds.has(_capKey);
    const _isPanelOpen=ccPanelCapKey===_capKey;
    // Card state: done (has features) > selected > default (SC pattern)
    let _cardState='';
    if(_hasFeat)_cardState=' cc-cap-card-done';
    if(_isSel)_cardState=' cc-cap-card-sel';
    if(_isPanelOpen)_cardState=' cc-cap-card-done cc-cap-card-active';
    const _originIcon=entry._docGrounded?'ti-file-text':(isPIFirst||cap._manual)?'ti-clipboard-list':'ti-hierarchy-2';
    const _originColor=entry._docGrounded?'var(--orange)':(isPIFirst||cap._manual)?'var(--green)':'var(--blue)';
    const _metricLbl=isPIFirst?(entry&&entry.metricName?entry.metricName:'Custom Process Area'):e(metricName);
    // Card click: open panel (has features) or toast (no features). Checkbox handles selection only.
    const _featSelState3=ccGetFeatSelState(cap);
    const _chkContent3=_hasFeat?(_featSelState3==='all'?'<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>':_featSelState3==='partial'?'<div style=\"width:7px;height:2px;background:#fff;border-radius:1px;\"></div>':''):(_isSel?'<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>':'');
    const _chkSel3=_hasFeat?(_featSelState3!=='none'):_isSel;
    // Count features sent to FC
    const inFCCount=features?features.filter(f=>{
      const fid=typeof scMakeFeatureId==='function'?scMakeFeatureId(f.metric,f.cap+(f.subCap?'/'+f.subCap:''),f.name):'';
      return fid&&scCanvas&&scCanvas.find(x=>x.id===fid);
    }).length:0;
    const _canEditCcCard3=(typeof canEditSession!=='function')||canEditSession();
    cardsHtml+=`<div class="cc-cap-card${_cardState}" id="cc-cap-${_cardKey.replace(/[^a-z0-9|]/gi,'_')}-${_cardIdx}" onclick="ccOpenCapPanel('${e(_cardKey)}',${_cardIdx})" style="cursor:pointer;" title="">
      <div class="cc-card-top">
        <span class="cc-card-mlbl">${_metricLbl}</span>
        <div class="cc-card-actions">
          ${_canEditCcCard3?`<button class="cc-card-pencil" onclick="event.stopPropagation();ccShowEditCapModal('${e(_cardKey)}',${_cardIdx})" title="Edit capability" aria-label="Edit capability"><i class="ti ti-pencil" style="font-size:10px;" aria-hidden="true"></i></button>`:''}
          <div class="cc-card-chk${_chkSel3?' cc-card-chk-sel':''}${_canEditCcCard3?'':' cc-card-chk-disabled'}" ${_canEditCcCard3?`onclick="event.stopPropagation();ccToggleCapSelect('${e(_cardKey)}',${_cardIdx})"`:''}>${_chkContent3}</div>
          ${_canEditCcCard3?`<button class="cc-card-remove" onclick="event.stopPropagation();ccRemoveCapability('${e(_cardKey)}',${_cardIdx})" title="Remove"><i class="ti ti-x" style="font-size:9px;" aria-hidden="true"></i></button>`:''}
        </div>
      </div>
      <div class="cc-cap-card-name-row"><i class="ti ${_originIcon}" style="font-size:10px;color:${_originColor};flex-shrink:0;margin-top:2px;" aria-hidden="true"></i><div class="cc-cap-card-name">${e(cap.name)}</div></div>
      <div class="cc-cap-card-why">${e(cap.why||'')}</div>
      <div class="cc-cap-card-footer">
        ${_hasFeat
          ?`<div class="cc-cap-status-done"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span class="cc-feat-badge">${featCount} feature${featCount!==1?'s':''}</span></div>${inFCCount>0?`<div class="cc-feat-insc-tag"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> ${inFCCount} in Feature Canvas</div>`:''}`
          :_isSel
            ?`<div class="cc-cap-status-none"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg> No features yet</div>`
            :`<div class="cc-cap-status-none"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg> No features yet</div>`
        }
      </div>
    </div>`;
  });
  // Right panel — only open when ccPanelCapKey set (explicit done-card click)
  // v9.06.02: for a bucket selection, ccPanelCapKey holds a REAL capStore
  // key (set by ccOpenCapPanel() using the resolved _cardKey/_cardIdx —
  // see the card loop above), which will never equal capActiveMetricKey
  // itself (that's 'bucket:<id>', a different string entirely). Resolve
  // by finding which position in the merged caps[] array this real
  // key+idx corresponds to, via entry._piMergedCards, instead of a
  // direct string-equality check against capActiveMetricKey.
  let rpCapIdx=null;
  if(ccPanelCapKey){
    const _parts=ccPanelCapKey.split('|');
    const _pci=parseInt(_parts[_parts.length-1]);
    const _pmk=_parts.slice(0,-1).join('|');
    if(_isBucketSelection&&entry._piMergedCards){
      const _foundPos=entry._piMergedCards.findIndex(function(r){return r.realKey===_pmk&&r.realIdx===_pci;});
      if(_foundPos>=0)rpCapIdx=_foundPos;
    } else if(_pmk===capActiveMetricKey&&!isNaN(_pci)&&_pci<caps.length){
      rpCapIdx=_pci;
    }
  }
  const rp=rpCapIdx!==null?ccBuildFeatPanel(entry,caps[rpCapIdx],rpCapIdx,_isBucketSelection&&entry._piMergedCards&&entry._piMergedCards[rpCapIdx]?entry._piMergedCards[rpCapIdx].realKey:capActiveMetricKey):null;
  const capsWithoutFeats=(caps.filter(c=>!c.featStore||!c.featStore.top||c.featStore.top.length===0)).length;
  el.innerHTML=`
    <div style="display:flex;flex:1;overflow:hidden;min-height:0;">
    <div class="cc-cap-grid-wrap">
      <div class="cc-cap-grid-hdr">
        <div class="cc-toolbar-l">
          <span class="cc-canvas-title">Capability Canvas</span>
          <span class="cc-count-badge" id="cc-cap-count-badge">${ccGetTotalCaps()} capabilities</span>
          ${ccGetTotalFeats()>0?`<span class="cc-done-badge"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> ${ccGetTotalFeats()} features</span>`:''}
          ${(ccCapFilter.size>0)?`<span id="cc-filter-badge" style="display:inline-flex;font-size:9px;font-weight:700;background:var(--card-purple);color:var(--purple);border:1px solid #CECBF6;border-radius:10px;padding:2px 8px;align-items:center;gap:5px;"><i class="ti ti-filter" style="font-size:9px;"></i> ${ccCapFilter.size} filter${ccCapFilter.size!==1?'s':''} <span onclick="ccSetCapFilter(null)" style="cursor:pointer;color:var(--t3);margin-left:2px;" title="Clear filter">&#x2715;</span></span>`:''}
        </div>
        <div style="display:flex;gap:7px;align-items:center;">
          <div class="cc-export-wrap" style="position:relative;"><button class="cc-tb-btn${ccCapFilter.size>0?' active':''}" id="cc-cap-filter-btn" onclick="ccToggleCCFilterDrop(event)" style="display:flex;align-items:center;gap:4px;"><i class="ti ti-filter" style="font-size:10px;" aria-hidden="true"></i> Filter <i class="ti ti-chevron-down" style="font-size:10px;" aria-hidden="true"></i></button><div class="cc-export-drop" id="cc-cap-filter-drop"><div style="padding:8px 12px 4px;font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--label);">Capabilities</div><label class="fc-filter-row"><input type="checkbox" ${ccCapFilter.has('without-features')?'checked':''} onchange="ccSetCapFilter('without-features')"> Without features</label><label class="fc-filter-row"><input type="checkbox" ${ccCapFilter.has('with-features')?'checked':''} onchange="ccSetCapFilter('with-features')"> With features</label><div style="height:0.5px;background:var(--divider);margin:4px 0;"></div><div style="padding:4px 12px 4px;font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--label);">Origin</div><label class="fc-filter-row"><input type="checkbox" ${ccCapFilter.has('origin-kpi')?'checked':''} onchange="ccSetCapFilter('origin-kpi')"> <i class="ti ti-hierarchy-2" style="font-size:11px;color:var(--blue);" aria-hidden="true"></i> Discovery Map</label><label class="fc-filter-row"><input type="checkbox" ${ccCapFilter.has('origin-doc')?'checked':''} onchange="ccSetCapFilter('origin-doc')"> <i class="ti ti-file-text" style="font-size:11px;color:var(--orange);" aria-hidden="true"></i> Session document</label><label class="fc-filter-row"><input type="checkbox" ${ccCapFilter.has('origin-custom')?'checked':''} onchange="ccSetCapFilter('origin-custom')"> <i class="ti ti-clipboard-list" style="font-size:11px;color:var(--green);" aria-hidden="true"></i> Custom plan</label><label class="fc-filter-row"><input type="checkbox" ${ccCapFilter.has('origin-mi')?'checked':''} onchange="ccSetCapFilter('origin-mi')"> <i class="ti ti-world-search" style="font-size:11px;color:var(--purple);" aria-hidden="true"></i> Market intelligence</label><label class="fc-filter-row"><input type="checkbox" ${ccCapFilter.has('origin-diag')?'checked':''} onchange="ccSetCapFilter('origin-diag')"> <i class="ti ti-microscope" style="font-size:11px;color:var(--amber);" aria-hidden="true"></i> Diagnostics</label>${_ccOriginRaFilterHtml()}<div style="border-top:1px solid var(--divider);margin:4px 0;"></div><div style="padding:4px 12px 8px;"><button onclick="ccSetCapFilter(null)" style="font-size:10px;color:var(--purple);background:none;border:none;cursor:pointer;font-family:var(--font);padding:0;">Clear all filters</button></div></div></div>
          <button class="tm-dots" onclick="_uiRowMenuToggle(this,ccToolbarMenuHtml())" aria-label="Capability Canvas actions" aria-haspopup="true" aria-expanded="false"><i class="ti ti-dots-vertical" aria-hidden="true"></i></button>
        </div>
      </div>
      <div class="cc-legend">
        <span class="cc-legend-lbl">Card states</span>
        <div class="cc-legend-item"><div class="cc-legend-bar lb-none"></div> No features yet</div>
        <div class="cc-legend-item"><div class="cc-legend-bar lb-done"></div> Features generated</div>
        <div class="cc-legend-item"><div class="cc-legend-bar lb-sel"></div> Selected</div>
        <span class="cc-legend-sep"></span>
        <span class="cc-legend-lbl" style="margin-left:4px;">Origin</span>
        <div class="cc-legend-item"><i class="ti ti-hierarchy-2" style="font-size:11px;color:var(--blue);" aria-hidden="true"></i> Discovery Map</div>
        <div class="cc-legend-item"><i class="ti ti-file-text" style="font-size:11px;color:var(--orange);" aria-hidden="true"></i> Session doc</div>
        <div class="cc-legend-item"><i class="ti ti-clipboard-list" style="font-size:11px;color:var(--green);" aria-hidden="true"></i> Custom plan</div>
        <div class="cc-legend-item"><i class="ti ti-world-search" style="font-size:11px;color:var(--purple);" aria-hidden="true"></i> Market intel</div>
        <div class="cc-legend-item"><i class="ti ti-microscope" style="font-size:11px;color:var(--amber);" aria-hidden="true"></i> Diagnostics</div>
      </div>
      ${stageLabel||metricName?`<div class="cc-all-group-hdr" style="border-left:3px solid ${ccStageColor(entry.stageId||'')}"><span class="cc-all-stage-pill" style="background:${ccStageColor(entry.stageId||'')}">${e(stageLabel||'')}</span><span class="cc-all-metric-name">${e(metricName)}</span><span class="cc-all-metric-count">${caps.length} cap${caps.length!==1?'s':''}</span></div>`:''}
      <div class="cc-cap-cards-grid" id="cc-cap-cards-grid">${cardsHtml}</div>
      ${_ccActionBarHtml()}
    </div>
    ${rp!==null?`<div class="cc-feat-panel" id="cc-feat-panel">${rp}</div>`:''}
    </div>`;
  // Sync action bar after render — matches fcRenderCanvas's pattern (FC's
  // proven, working equivalent): the render function itself owns the
  // action-bar sync, so every code path that triggers a re-render
  // automatically gets a correct, up-to-date checkbox/count/button state,
  // with no separate call for each caller to remember.
  ccUpdateActionBar();
}

// ── Build right panel HTML for a capability ──
function ccBuildFeatPanel(entry,cap,capIdx,metricKey){
  // v9.25 — this "pure" string builder gets an intentional side effect:
  // confirmed via tracing that EVERY call site (capability switch, feature-
  // selection toggle, feature edit/remove, live-sync remote update, and
  // more — over a dozen sites) immediately assigns its return value to
  // replace #cc-feat-panel's live DOM content, directly or nested inside a
  // caller's larger template. A single guard here, rather than
  // instrumenting each call site individually, covers all of them at once
  // and can't be missed by a future one. voiceStopActive() is a safe no-op
  // if #cc-feat-refine-txt isn't the active dictation instance.
  voiceStopActive('abort');
  // metricKey param added to avoid relying on capActiveMetricKey which is null in All Caps view
  // Fall back to capActiveMetricKey for callers that don't pass it yet
  const _mk=metricKey||(capActiveMetricKey)||'';
  if(!cap)return`<div class="cc-feat-panel-empty"><i class="ti ti-layout-grid" style="font-size:24px;color:var(--label);margin-bottom:8px;" aria-hidden="true"></i><div style="font-size:12px;color:var(--t3);">Click a capability card to view features</div></div>`;
  const featKey='top';
  const features=cap.featStore?cap.featStore[featKey]:null;
  const isPIFirst=!!(entry._piFirst);
  const selectedCount=features?features.filter(f=>f.selected).length:0;
  const totalOnCanvas=scCanvas?scCanvas.length:0;
  let featHtml='';
  if(!features){
    const _canEditCcEmptyGen=(typeof canEditSession!=='function')||canEditSession();
    featHtml=`<div class="cc-feat-panel-empty" style="flex:1;">
      <i class="ti ti-layout-grid" style="font-size:24px;color:var(--label);margin-bottom:8px;" aria-hidden="true"></i>
      <div style="font-size:12px;font-weight:600;color:var(--t2);">No features yet</div>
      <div style="font-size:11px;color:var(--t3);max-width:180px;line-height:1.4;margin-top:4px;margin-bottom:14px;">AI will generate a feature set for this capability.</div>
      ${_canEditCcEmptyGen?`<button class="gen-btn" style="font-size:11px;padding:8px 14px;width:auto;" onclick="ccGenerateFeaturesForCapClick('${e(_mk)}',${capIdx},'',null,{triggerEl:this})"><i class="ti ti-sparkles" style="font-size:11px;" aria-hidden="true"></i> Generate Features</button>`:''}
    </div>`;
  } else {
    const fromPlan=isPIFirst&&features.length>0&&features.every(f=>!f._aiAdded);
    const mixedPlan=isPIFirst&&features.some(f=>f._aiAdded)&&features.some(f=>!f._aiAdded);
    const badgeHtml=fromPlan
      ?'<span style="font-size:9px;background:#E1F5EE;color:#085041;border-radius:8px;padding:1px 7px;font-weight:600;">From custom plan</span>'
      :mixedPlan
        ?'<span style="font-size:9px;background:#E1F5EE;color:#085041;border-radius:8px;padding:1px 7px;font-weight:600;">From custom plan</span> <span style="font-size:9px;background:var(--card-purple);color:var(--purple-deep);border-radius:8px;padding:1px 7px;font-weight:600;">+ AI</span>'
        :'<span style="font-size:9px;background:var(--card-purple);color:var(--purple-deep);border-radius:8px;padding:1px 7px;font-weight:600;">AI generated</span>';
    featHtml=`<div style="padding:4px 12px 4px;flex-shrink:0;">
      <div style="font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--label);display:flex;align-items:center;gap:6px;">Features ${badgeHtml}</div>
    </div>
    <div class="cc-feat-item-list" id="cc-feat-panel-list-${capIdx}">`;
    features.forEach((f,fi)=>{
      const isSel=f.selected||false;
      const fid=typeof scMakeFeatureId==='function'?scMakeFeatureId(f.metric,f.cap+(f.subCap?'/'+f.subCap:''),f.name):'';
      const isInSC=fid&&scCanvas&&scCanvas.find(x=>x.id===fid);
      const _canEditCcFeatItem=(typeof canEditSession!=='function')||canEditSession();
      const _rowClickable=_canEditCcFeatItem;
      const _canEditThisFeat=_canEditCcFeatItem&&!isInSC;
      featHtml+=`<div class="cc-feat-item${isInSC?' cc-feat-item-insc':isSel?' cc-feat-item-sel':''}" ${_rowClickable?`onclick="ccToggleFeatPanel(${capIdx},${fi})" style="cursor:pointer;"`:'style="cursor:default;"'}>
        <div class="cc-feat-item-chk${isInSC?' done':isSel?' sel':''}${_rowClickable?'':' cc-feat-item-chk-disabled'}" ${_rowClickable?`onclick="event.stopPropagation();ccToggleFeatPanel(${capIdx},${fi})"`:''}>
          ${isInSC||isSel?'<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>':''}
        </div>
        <div style="flex:1;min-width:0;">
          <div class="cc-feat-name-row">
            <div class="cc-feat-name" id="cc-feat-name-${capIdx}-${fi}">${e(f.name)}</div>
            ${_canEditThisFeat?`<button class="cc-feat-edit-btn" onmousedown="event.preventDefault()" onclick="event.stopPropagation();ccEditFeatName(${capIdx},${fi})" title="Edit feature name"><i class="ti ti-pencil" style="font-size:10px;" aria-hidden="true"></i></button>`:''}
          </div>
          <div class="cc-feat-why-row">
            <div class="cc-feat-why" id="cc-feat-why-${capIdx}-${fi}">${e(f.why||'')}</div>
            ${_canEditThisFeat?`<button class="cc-feat-edit-btn cc-feat-why-edit-btn" onmousedown="event.preventDefault()" onclick="event.stopPropagation();ccEditFeatWhy(${capIdx},${fi})" title="Edit description"><i class="ti ti-pencil" style="font-size:10px;" aria-hidden="true"></i></button>`:''}
          </div>
          ${(isInSC||f.outcomeHypothesis)?`<div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
            ${isInSC?'<div class="cc-feat-insc-tag"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> In Feature Canvas</div>':''}
            ${ccBuildFeatHypChipHTML(f)}
          </div>`:''}
        </div>
      </div>`;
    });
    featHtml+=`</div>`;
  }
  // SC panel pattern: tag/name/meta/close → nav row → scroll → chat → footer
  const statusTxt=selectedCount>0?`${selectedCount} feature${selectedCount!==1?'s':''} selected`:'';
  // Navigation: v8.54 — global pool in All Caps view, metric-scoped in metric view
  let navTotal, navIdx;
  if(capActiveMetricKey===null){
    // All Caps view — navigate globally across all caps
    const _navPool=ccGetCapNavPool();
    const _navEntry2=capStore[_mk];
    const _navKey=(_navEntry2?((_navEntry2.stageId||'')+'||'+(_navEntry2.metricName||'')):'')+'|'+capIdx;
    navIdx=_navPool.findIndex(n=>n.key===_navKey);
    if(navIdx<0)navIdx=0;
    navTotal=_navPool.length;
  } else {
    // Metric view — scope to current metric's caps, filtered to match card grid
    const _navEntry=capStore[_mk];
    const _navCaps=_navEntry?(_navEntry.capabilities||[]):[];
    const _filteredNavCaps=_navCaps.filter(cap=>_ccKpiCapPassesFilter(cap,_navEntry,_mk));
    navTotal=_filteredNavCaps.length;
    // navIdx = position of current cap in filtered list (absolute capIdx used for open/close)
    const _currentCap=_navCaps[capIdx];
    navIdx=_currentCap?_filteredNavCaps.indexOf(_currentCap):0;
    if(navIdx<0)navIdx=0;
  }
  const hasPrev=navIdx>0;
  const hasNext=navIdx<navTotal-1;
  return`<div class="cc-feat-panel-hdr">
    <div class="cc-panel-tag">${isPIFirst?'Your capability':'Capability'}</div>
    <div class="cc-feat-panel-cap-name">${e(cap.name)}</div>
    ${cap.why?`<div class="cc-feat-panel-meta" title="${e(cap.why)}">${e(cap.why)}</div>`:''}
    <button class="cc-feat-panel-close" onclick="ccCloseFeatPanelUserAction()" title="Close panel" style="position:absolute;top:12px;right:12px;"><i class="ti ti-x" style="font-size:11px;" aria-hidden="true"></i></button>
  </div>
  ${navTotal>=1?`<div class="cc-panel-nav">
    <div class="cc-panel-nav-info">Capability ${navIdx+1} of ${navTotal}</div>
    <div class="cc-panel-nav-arrows">
      <button class="cc-panel-nav-btn" onclick="ccCapPanelNav(-1)" ${hasPrev?'':'disabled'} title="Previous capability"><i class="ti ti-chevron-left" style="font-size:11px;" aria-hidden="true"></i></button>
      <button class="cc-panel-nav-btn" onclick="ccCapPanelNav(1)" ${hasNext?'':'disabled'} title="Next capability"><i class="ti ti-chevron-right" style="font-size:11px;" aria-hidden="true"></i></button>
    </div>
  </div>`:''}
  <div class="cc-feat-panel-scroll">
    ${featHtml}
  </div>
  ${((typeof canEditSession!=='function')||canEditSession())?`<div class="cc-chat-bar" style="flex-shrink:0;">
    <div class="cc-chat-lbl">${features?(isPIFirst?'Add AI features':'Refine features'):'Generate features with context'}</div>
    <div class="cc-chat-row">
      <textarea class="cc-chat-input" id="cc-feat-refine-txt" rows="2" placeholder="${features?(isPIFirst?'e.g. Add a feature for guest checkout...':'e.g. Focus on mobile only, avoid enterprise features...'):'e.g. Focus on self-serve setup, avoid enterprise-only features...'}"></textarea>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
        <span class="cc-chat-hint">↵ send</span>
        <div class="cc-chat-btn-group">
          ${(typeof voiceButtonHtml==='function')?voiceButtonHtml({textareaId:'cc-feat-refine-txt',buttonId:'cc-feat-voice-btn',statusId:'cc-feat-voice-status'}):''}
          <button class="cc-chat-send" onclick="ccGenerateFeaturesForCapClick('${e(_mk)}',${capIdx},document.getElementById('cc-feat-refine-txt').value.trim(),null,{triggerEl:this})" aria-label="Generate or refine features">
            <i class="ti ti-arrow-up" style="font-size:12px;" aria-hidden="true"></i>
          </button>
        </div>
      </div>
    </div>
  </div>`:''}
  ${features?`<div class="cc-panel-footer-split">
    <div class="cc-panel-split-status">${statusTxt}</div>
    <div class="cc-panel-split-cta-wrap">
      <button class="cc-panel-split-cta" onclick="ccSendToStoryCanvas()" ${selectedCount===0?'disabled':''}>
        <i class="ti ti-writing" style="font-size:11px;" aria-hidden="true"></i> Send to Feature Canvas
      </button>
    </div>
  </div>`:''}`;

}

function ccSelectCapCard(metricKey,capIdx){
  // Delegate to SC-matching handlers
  const entry=capStore[metricKey];
  if(!entry)return;
  const cap=entry.capabilities[capIdx];
  const hasFeat=cap&&cap.featStore&&cap.featStore.top&&cap.featStore.top.length>0;
  if(hasFeat){
    ccOpenCapPanel(metricKey,capIdx);
  } else {
    ccToggleCapSelect(metricKey,capIdx);
  }
}

// ── Feature generation ──
async function ccGenerateFeatures(refinement){
  const key=getKey();
  if(aiGenInFlight.active){showToast("Still working on your last request. Hang tight, this won't take long.",'info');return;}
  // v9.06.02: when capActiveMetricKey holds a bucket:<id> selection (the
  // grid view), the panel-level "Generate Features" action still needs
  // to operate on the ONE specific capability whose panel is actually
  // open — resolved via ccPanelCapKey (which always holds a REAL
  // capStore key + idx, per ccOpenCapPanel()'s fix), not capActiveMetricKey
  // directly, since that would be the synthetic bucket tag, not a real key.
  const _isBucketSel=typeof capActiveMetricKey==='string'&&capActiveMetricKey.indexOf('bucket:')===0;
  let _genMetricKey=capActiveMetricKey;
  let _genCapIdx=capActiveCapIdx;
  if(_isBucketSel){
    if(!ccPanelCapKey)return; // no specific card open — nothing to generate for
    const _parts=ccPanelCapKey.split('|');
    _genCapIdx=parseInt(_parts[_parts.length-1]);
    _genMetricKey=_parts.slice(0,-1).join('|');
  }
  if(!_genMetricKey||!capStore[_genMetricKey])return;
  const entry=capStore[_genMetricKey];
  // Default capActiveCapIdx to 0 if not set (non-bucket path only —
  // bucket path already resolved _genCapIdx above from ccPanelCapKey)
  if(!_isBucketSel&&capActiveCapIdx===null)capActiveCapIdx=0;
  if(!_isBucketSel)_genCapIdx=capActiveCapIdx;
  const cap=entry.capabilities[_genCapIdx];
  if(!cap)return;
  const isSubCap=capActiveSubCapIdx!==null&&cap.subCaps&&cap.subCaps[capActiveSubCapIdx];
  const subCapName=isSubCap?cap.subCaps[capActiveSubCapIdx].name:null;
  const featKey=isSubCap?'sc'+capActiveSubCapIdx:'top';
  const _ctxFC1=getFullProductCtx();
  var _fcDocRes1=(typeof buildDocContext==='function')?buildDocContext('fc',[cap&&cap.name,subCapName].filter(Boolean).join(' ')):{text:'',truncated:false};
  _ctxFC1.docContext=_fcDocRes1.text;
  _fireDocTruncatedToast(_fcDocRes1.truncated);
  const nsm=gData?gData.nsm.metric:(typeof piInputs!=='undefined'&&piInputs.piGoal?piInputs.piGoal:'');

  // Phase 5 (v8.117): immediate disable, no rich loader until lock confirmed.
  const sendBtn=document.querySelector('.cc-chat-send');
  if(sendBtn)sendBtn.disabled=true;
  ccSetGenAllBtnDisabled(true);
  const _attempt=newGenAttempt();

  // Phase 5: withGenerationLock wraps callAPI through applying results to
  // cap.featStore. Note: unlike most other wrapped functions, this one has
  // NO sessionStoreSave() call of its own — featStore changes get
  // persisted by whichever LATER action saves next (e.g. Send to Story
  // Canvas), a pre-existing app pattern, not something introduced here.
  // No throwIfLost() checkpoint is needed before a save that doesn't exist
  // in this function — the lock still has real value here, preventing two
  // people from running simultaneous feature generation against the SAME
  // capability, even though the eventual persistence happens elsewhere.
  try{
    await withGenerationLock(async (_lock) => {
  try{
    // Lock confirmed — show the real loader, marker-stamped.
    var _featArea=document.getElementById('cc-feat-area');
    if(_featArea){
      _featArea.innerHTML=markGenAttempt(_attempt,`<div class="cc-feat-loading" style="flex-direction:column;justify-content:center;align-items:center;min-height:160px;text-align:center;gap:12px;">
      <div class="cc-spin" style="width:32px;height:32px;border-width:3px;"></div>
      <span class="cc-load-txt">Generating Features for ${e(isSubCap?subCapName:cap.name)}…</span>
    </div>`);
    }
    const _capOrSubName=isSubCap?subCapName:cap.name;
    const _signal=startAiGen(`Features for "${_capOrSubName}" are being generated. Leaving now discards them, you'll need to regenerate from scratch.`);
    // §6.5 — if this capability has a non-null intakeBriefId (RA-created),
    // ground feature generation in that conversation's brief content for
    // THIS capability specifically, as the primary driver. Sub-capabilities
    // never carry intakeBriefId (RA only creates top-level capabilities), so
    // this only ever applies when !isSubCap. If intakeBriefId is null
    // (manually-created capability, or RA-off), behavior is completely
    // unchanged - falls through to the existing name+description-only prompt.
    const _capFeatPrompt=(!isSubCap&&cap.intakeBriefId)
      ?buildRAFeatureGenPrompt(_ctxFC1,nsm,entry.stageLabel,entry.metricName,cap.name,cap.intakeBriefId,refinement)
      :buildCapFeaturesPrompt(_ctxFC1,nsm,entry.stageLabel,entry.metricName,cap.name,subCapName,refinement);
    const txt=await callAPI(
      'You are a senior product strategist. Specific, actionable, product-native. Respond ONLY with valid JSON. No markdown, no backticks, no preamble. Never use em dashes (—) in your output; use a hyphen (-) or rewrite the phrase.',
      _capFeatPrompt,
      2000,
      _signal,
      null,
      'cc-gen-features'
    );
    const clean=txt.replace(/```json|```/g,'').trim();
    let parsed;
    try{parsed=JSON.parse(clean);}catch(pe){
      const s=clean.indexOf('{');const l=clean.lastIndexOf('}');
      if(s>=0&&l>s){try{parsed=JSON.parse(clean.substring(s,l+1));}catch(pe2){throw new Error('Could not parse features.');}}
      else throw new Error('Could not parse features.');
    }
    if(!parsed||!parsed.features)throw new Error('No features returned.');
    if(!cap.featStore)cap.featStore={};
    // Outcome Verification Loop (A4): normalizeAIHypothesis() tolerates a
    // missing/malformed f.hypothesis by returning null — a broken
    // hypothesis sub-object never fails the whole feature-generation
    // response (verified requirement, spec §6.5 Finding J).
    // QA issue #4 — carry the parent capability's RA provenance down onto
    // each newly generated feature. Confirmed regression: this was never
    // set here, silently breaking the Origin/Brief filters (which key off
    // feature.intakeBriefId) for every feature generated from an RA-created
    // capability. null for manually-created capabilities/sub-caps, exactly
    // as before.
    cap.featStore[featKey]=parsed.features.map(f=>{
      // Adoption Readiness (v9.21, §4.1) — hypothesis carry-forward check.
      // Runs unconditionally (including for previously "Achieved" hypotheses)
      // before the feature object is finalized: overwrites baseline from
      // Outcome Pulse's most recently logged actual for a feature of this
      // same name if one exists; otherwise leaves baseline as-is and stamps
      // a soft, non-blocking warning flag the card chip renders (feature-canvas.js).
      let _hyp=(typeof normalizeAIHypothesis==='function')?normalizeAIHypothesis(f.hypothesis):null;
      if(_hyp&&typeof rcApplyHypothesisCarryForward==='function')_hyp=rcApplyHypothesisCarryForward(f.name,_hyp);
      return{name:f.name,why:f.why,selected:false,
      metric:entry.metricName,stage:entry.stageLabel,cap:cap.name,subCap:subCapName,
      outcomeHypothesis:_hyp,
      intakeBriefId:(!isSubCap&&cap.intakeBriefId)?cap.intakeBriefId:null,
      rqNumber:(!isSubCap&&cap.rqNumber)?cap.rqNumber:null};
    });
    // Only re-render the main area / clear the refine input if this
    // attempt still owns the feature panel — otherwise the user has since
    // navigated to a different capability and this stale success should
    // not yank the view back or clobber the refine textbox they may have
    // already started typing something new into.
    if(getIfCurrentAttempt('cc-feat-area',_attempt)){
      ccRenderMainArea();
      const txt2=document.getElementById('cc-feat-refine-txt');
      if(txt2)txt2.value='';
    }
  }catch(err){
    if(err.name==='AbortError'){
      endAiGen();
      // Phase 5: rethrow rather than return — see pi-planning.js for the
      // full rationale (adversarial review Finding 1).
      throw err;
    }
    // Phase 5 (v8.117): every error write below is marker-guarded — a
    // stale attempt's failure must not clobber a different capability's
    // view the user has since navigated to, or a newer attempt's success.
    var _errFeatArea=getIfCurrentAttempt('cc-feat-area',_attempt);
    if(_errFeatArea){
      _errFeatArea.innerHTML=`<div class="cc-feat-empty">
        <div style="color:var(--color-text-danger,var(--red));font-size:13px;margin-bottom:8px;">Generation failed</div>
        <div style="font-size:11px;color:var(--color-text-secondary);">${e(err.message)}</div>
        <button class="cc-btn-ghost" style="margin-top:12px;font-size:11px;" onclick="ccGenerateFeatures('')">Try again</button>
      </div>`;
    }
    if(err.message==='generation_lock_lost'){
      throw err;
    }
  }finally{
    if(sendBtn)sendBtn.disabled=false;
    ccSetGenAllBtnDisabled(false);
    endAiGen();
  }
    });
  }catch(lockErr){
    // Phase 5 (v8.117): since the loader is only ever written INSIDE the
    // lock callback now, a pre-flight rejection never wrote anything to
    // #cc-feat-area — nothing to clean up there. sendBtn/ccSetGenAllBtnDisabled
    // still need resetting here since they're set BEFORE the lock check.
    if(sendBtn)sendBtn.disabled=false;
    ccSetGenAllBtnDisabled(false);
  }
}

// ── Feature selection ──
// v9.06.02: shared helper for the "resolve the ONE capability whose panel
// is open, regardless of whether capActiveMetricKey is a bucket:<id> tag
// or a real key" logic — used identically by ccToggleFeat() and
// ccSelectAll(), avoiding a third copy of the same resolution pattern.
function _ccResolveActivePanelCap(){
  const _isBucketSel=typeof capActiveMetricKey==='string'&&capActiveMetricKey.indexOf('bucket:')===0;
  let _mk=capActiveMetricKey;
  let _ci=capActiveCapIdx;
  if(_isBucketSel){
    if(!ccPanelCapKey)return null;
    const _parts=ccPanelCapKey.split('|');
    _ci=parseInt(_parts[_parts.length-1]);
    _mk=_parts.slice(0,-1).join('|');
  }
  if(!_mk||!capStore[_mk])return null;
  const cap=capStore[_mk].capabilities[_ci];
  return cap||null;
}

function ccToggleFeat(fi){
  const cap=_ccResolveActivePanelCap();
  if(!cap||!cap.featStore)return;
  const isSubCap=capActiveSubCapIdx!==null&&cap.subCaps&&cap.subCaps[capActiveSubCapIdx];
  const featKey=isSubCap?'sc'+capActiveSubCapIdx:'top';
  const features=cap.featStore[featKey];
  if(!features||!features[fi])return;
  features[fi].selected=!features[fi].selected;
  ccRenderMainArea();
}

function ccSelectAll(){
  const cap=_ccResolveActivePanelCap();
  if(!cap||!cap.featStore)return;
  const isSubCap=capActiveSubCapIdx!==null&&cap.subCaps&&cap.subCaps[capActiveSubCapIdx];
  const featKey=isSubCap?'sc'+capActiveSubCapIdx:'top';
  const features=cap.featStore[featKey];
  if(!features)return;
  const allSelected=features.every(f=>f.selected);
  features.forEach(f=>f.selected=!allSelected);
  ccRenderMainArea();
}

// ── Send to Feature Canvas ──
function ccSendToStoryCanvas(){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  // Derive metricKey + capIdx from ccPanelCapKey (avoids stale capActiveCapIdx)
  if(!ccPanelCapKey)return;
  const _sk=ccPanelCapKey.split('|');
  const _sci=parseInt(_sk[_sk.length-1]);
  const _smk=_sk.slice(0,-1).join('|');
  if(!capStore[_smk])return;
  const entry=capStore[_smk];
  const cap=entry.capabilities[_sci];
  if(!cap||!cap.featStore)return;
  // Capture All Caps view state before mutating capActiveMetricKey
  const _wasAllCaps=(capActiveMetricKey===null);
  // Sync capActiveMetricKey so downstream functions work correctly
  capActiveMetricKey=_smk;
  const isSubCap=capActiveSubCapIdx!==null&&cap.subCaps&&cap.subCaps[capActiveSubCapIdx];
  const featKey=isSubCap?'sc'+capActiveSubCapIdx:'top';
  const features=cap.featStore[featKey];
  if(!features)return;
  const selected=features.filter(f=>f.selected);
  if(!selected.length){showToast('Select at least one feature to send to Feature Canvas.','warn');return;}
  const _sendCount=selected.length;
  selected.forEach(f=>{
    const fid=scMakeFeatureId(f.metric,f.cap+(f.subCap?'/'+f.subCap:''),f.name);
    if(!scCanvas.find(x=>x.id===fid)){
      const metricPath=typeof scGetMetricPath==='function'?scGetMetricPath(f.metric):f.metric;
      const _curPiLbl=typeof getPiStageLabel==='function'?getPiStageLabel(gData):'Custom Value Stage';
      scCanvas.push({id:fid,metric:f.metric,metricPath,stage:f.stage,cap:f.cap+(f.subCap?' › '+f.subCap:''),name:f.name,why:f.why,stories:null,origin:((typeof piMode!=='undefined'&&piMode)||f.stage===_curPiLbl||f.stage==='PI Plan')?'pi':(f._docGrounded?'doc':'kpi'),
        // Outcome Verification Loop (A2): cloned defensively — this
        // scCanvas entry must never share a reference with capStore's own
        // copy, since a later regeneration on the SAME capability could
        // still mutate/replace capStore's copy independently.
        outcomeHypothesis:(f.outcomeHypothesis&&typeof cloneOutcomeHypothesis==='function')?cloneOutcomeHypothesis(f.outcomeHypothesis):null,
        // QA issue #4 — carry RA provenance through to Feature Canvas, same
        // fields capStore's own copy now carries (fixed at the feature-
        // generation call sites above).
        intakeBriefId:f.intakeBriefId||null,rqNumber:f.rqNumber||null});
    }
  });
  fcUpdateTabBadge();
  scUpdateCapDrawerFooter();
  // Signal new content in Feature Canvas (cleared on first visit)
  if(typeof markTabPending==='function')markTabPending('fc');
  // Deselect after sending
  features.forEach(f=>f.selected=false);
  // Restore All Caps view if user was there before send
  // v8.53: render BEFORE nulling capActiveMetricKey so ccRenderAllCaps() can include the right panel
  if(_wasAllCaps){ccRenderAllCaps();capActiveMetricKey=null;}else{ccRenderMainArea();}
  // Inline confirmation — replace Send button with green strip for 2 seconds
  const sendBtn=document.querySelector('.cc-panel-split-cta');
  if(sendBtn){
    const orig=sendBtn.outerHTML;
    sendBtn.outerHTML=`<div class="cc-panel-split-confirm"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> ${selected.length} sent</div>`;
    setTimeout(()=>{
      const conf=document.querySelector('.cc-panel-split-confirm');
      if(conf)conf.outerHTML=orig;
    },2000);
  }
  // Update the right panel to show In Feature Canvas tags immediately
  const rp=document.getElementById('cc-feat-panel');
  const entry2=capStore[capActiveMetricKey||_smk];
  if(rp&&entry2&&_sci!==null&&!isNaN(_sci)){
    rp.innerHTML=ccBuildFeatPanel(entry2,entry2.capabilities[_sci],_sci,capActiveMetricKey||_smk);
  }
  showToast(`${_sendCount} feature${_sendCount!==1?'s':''} sent to Feature Canvas.`,'success');
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    // Coarse target — each sent feature is a whole new scCanvas entry, not
    // an edit to an existing story, so this uses the coarse (empty story
    // half) target for each one, same shape as a full feature-list sync.
    var _sentFids=selected.map(function(f){ return scMakeFeatureId(f.metric,f.cap+(f.subCap?'/'+f.subCap:''),f.name); });
    sessionStoreSave(_activeSessionId).then(function(ok){
      if(!ok||typeof _lsMarkManualEdit!=='function')return;
      _sentFids.forEach(function(fid){ _lsMarkManualEdit('sc',fid+_LS_SC_TARGET_SEP); });
    });
  }
}

// ── Generate features for ALL capabilities of the active metric ──
// Phase 5: wraps the ENTIRE loop in ONE lock acquisition — passes its own
// lockHandle to ccGenerateFeaturesForCap() via ctx.lockHandle so each
// capability call JOINS this outer lock instead of acquiring its own,
// which would release/reacquire between every capability in the batch.
async function ccGenerateFeaturesForMetric(metricKey){
  if(!metricKey||!capStore[metricKey])return;
  const entry=capStore[metricKey];
  const caps=entry.capabilities||[];
  if(!caps.length)return;
  const key=getKey();
  const _docToastRef={truncated:false};
  try{
    await withGenerationLock(async (lockHandle) => {
      // Generate features only for caps without features (don't overwrite existing)
      for(let ci=0;ci<caps.length;ci++){
        const cap=caps[ci];
        if(cap.featStore&&cap.featStore.top&&cap.featStore.top.length>0)continue;
        capActiveCapIdx=ci;
        await ccGenerateFeaturesForCap(metricKey,ci,'',null,{lockHandle,docToastRef:_docToastRef});
      }
    });
  }catch(lockErr){
    // Phase 5: pre-loop lock failure, or a rethrown AbortError/lock_lost
    // from inside the loop — ccGenerateFeaturesForCap's own inner catch
    // already reset its own UI state (marker-guarded, see the inner
    // function's own writes) before rethrowing; this just stops the loop
    // from continuing to the next capability.
  }
  _fireDocTruncatedToast(_docToastRef.truncated);
  capActiveCapIdx=null;
  // Phase 5 (v8.117): only re-render if the user is still viewing THIS
  // metric — this batch's own loop never wrote directly to the DOM itself
  // (each ccGenerateFeaturesForCap() call already marker-guards its own
  // writes), but this final render was previously unconditional, which
  // could yank the user back to metricKey's view even if they've since
  // navigated to a different metric entirely while the batch was running.
  if(capActiveMetricKey===metricKey||capActiveMetricKey===null){
    ccRenderMainContent();
  }
}

// ── Refine/regenerate ALL capabilities for a metric ──
async function ccRefineCapabilities(metricKey,refinement){
  if(!metricKey)return;
  const key=getKey();
  if(aiGenInFlight.active){showToast("Still working on your last request. Hang tight, this won't take long.",'info');return;}
  const metric=ccGetAllL1Metrics().find(m=>m.metricKey===metricKey);
  if(!metric)return;
  // Show loader in main area
  const mainArea=document.getElementById('cc-main-area');
  if(mainArea){
    const stageColor=ccStageColor(metric.stageId||'');
    mainArea.innerHTML=`<div style="display:flex;flex:1;overflow:hidden;min-height:0;">
      <div class="cc-cap-grid-wrap">
        <div class="cc-cap-grid-hdr">
          <div>
            <div class="cc-breadcrumb"><span class="cc-ctx-pill" style="background:${e(ccStageBg(metric.stageId||''))};color:${e(ccStageText(metric.stageId||''))};">${e(metric.stageLabel)}</span><span class="cc-ctx-sep">›</span><span class="cc-ctx-pill" style="background:var(--card-purple);color:var(--purple-deep);">${e(metric.metricName)}</span></div>
          </div>
        </div>
        <div class="loading on" style="flex:1;">
          <div class="spin"></div>
          <div class="load-txt">Regenerating Capabilities…</div>
          <div class="load-sub">${refinement?`Refining with: "${e(refinement)}"`:('Re-mapping capabilities for '+e(metric.metricName))}</div>
        </div>
      </div>
    </div>`;
  }
  const _ctx4=getFullProductCtx();
  var _ccDocRes4=(typeof buildDocContext==='function')?buildDocContext('cc',metric.metricName):{text:'',truncated:false};
  _ctx4.docContext=_ccDocRes4.text;
  _fireDocTruncatedToast(_ccDocRes4.truncated);
  const nsm=gData?gData.nsm.metric:'';
  try{
    const _signal=startAiGen(`Capabilities for "${metric.metricName}" are being regenerated. Leaving now discards them, you'll need to start again.`);
    ccSetGenAllBtnDisabled(true);
    const txt=await callAPI(
      'You are a senior product strategist. Specific, opinionated, product-native. Respond ONLY with valid JSON. No markdown, no backticks, no preamble. Never use em dashes (—) in your output; use a hyphen (-) or rewrite the phrase.',
      buildCapCanvasPrompt(_ctx4,gData&&gData.measurementModel&&gData.measurementModel.frameworks?gData.measurementModel.frameworks:[],nsm,metric.metricName,metric.stageLabel,refinement||''),
      3000,
      _signal,
      null,
      'cc-regen-metric'
    );
    const clean=txt.replace(/```json|```/g,'').trim();
    let parsed;
    try{parsed=JSON.parse(clean);}catch(pe){
      const s=clean.indexOf('{');const l=clean.lastIndexOf('}');
      if(s>=0&&l>s){try{parsed=JSON.parse(clean.substring(s,l+1));}catch(pe2){parsed=null;}}
    }
    if(parsed&&parsed.capabilities){
      // Preserve existing features on caps with matching names
      const oldCaps=(capStore[metricKey]&&capStore[metricKey].capabilities)||[];
      capStore[metricKey]={
        metricName:metric.metricName,stageLabel:metric.stageLabel,stageId:metric.stageId,
        capabilities:parsed.capabilities.map(cap=>{
          const existing=oldCaps.find(c=>c.name.toLowerCase()===cap.name.toLowerCase());
          return{name:cap.name,why:cap.why,subCaps:(cap.sub_capabilities&&cap.sub_capabilities.length>0)?cap.sub_capabilities:null,
            features:[],featStore:existing?existing.featStore:{}};
        })
      };
    }
    capActiveCapIdx=null;
    ccUpdateTabBadge();
    ccSetGenAllBtnDisabled(false);
    ccOpenNavigator();
    // Clear refine input
    const inp=document.getElementById('cc-cap-refine-txt');
    if(inp)inp.value='';
    endAiGen();
  }catch(err){
    if(err.name==='AbortError'){ccSetGenAllBtnDisabled(false);endAiGen();return;}
    ccSetGenAllBtnDisabled(false);
    endAiGen();
    ccOpenNavigator();
  }
}

// ── Capability regeneration ──
async function ccRegenCapability(metricKey,capIdx){
  const key=getKey();
  const entry=capStore[metricKey];
  if(!entry)return;
  const refineTxt=document.getElementById('cc-cap-refine-txt');
  const refinement=refineTxt?refineTxt.value.trim():'';
  const _ctx5=getFullProductCtx();
  var _ccDocRes5=(typeof buildDocContext==='function')?buildDocContext('cc',entry.metricName):{text:'',truncated:false};
  _ctx5.docContext=_ccDocRes5.text;
  _fireDocTruncatedToast(_ccDocRes5.truncated);
  const nsm=gData?gData.nsm.metric:(typeof piInputs!=='undefined'&&piInputs.piGoal?piInputs.piGoal:'');
  const treeEl=document.getElementById('cc-nav-tree');
  if(treeEl){const capEls=treeEl.querySelectorAll('.cc-tree-cap');if(capEls[capIdx])capEls[capIdx].style.opacity='0.5';}
  try{
    const txt=await callAPI(
      'You are a senior product strategist. Specific, opinionated, product-native. Respond ONLY with valid JSON. No markdown, no backticks, no preamble. Never use em dashes (—) in your output; use a hyphen (-) or rewrite the phrase.',
      buildCapCanvasPrompt(_ctx5,gData&&gData.measurementModel&&gData.measurementModel.frameworks?gData.measurementModel.frameworks:[],nsm,entry.metricName,entry.stageLabel,refinement),
      3000,
      undefined,
      undefined,
      'cc-refine-metric'
    );
    const clean=txt.replace(/```json|```/g,'').trim();
    let parsed;
    try{parsed=JSON.parse(clean);}catch(pe){parsed=null;}
    if(parsed&&parsed.capabilities&&parsed.capabilities[capIdx]){
      const newCap=parsed.capabilities[capIdx];
      entry.capabilities[capIdx]={
        name:newCap.name,why:newCap.why,
        subCaps:(newCap.sub_capabilities&&newCap.sub_capabilities.length>0)?newCap.sub_capabilities:null,
        features:[],featStore:{}
      };
      if(capActiveMetricKey===metricKey&&capActiveCapIdx===capIdx){capActiveSubCapIdx=null;}
    }
    if(refineTxt)refineTxt.value='';
  }catch(err){console.warn('Capability regen failed:',err);}
  ccRenderTree();
  if(capActiveMetricKey===metricKey&&capActiveCapIdx===capIdx)ccRenderMainArea();
}

function ccRefineCapability(){
  if(capActiveMetricKey===null||capActiveCapIdx===null)return;
  ccRegenCapability(capActiveMetricKey,capActiveCapIdx);
}

// ── Exit navigator back to inputs ──
function ccExitNavigator(){
  // Nav is inside cc-main — just re-render the partial view
  capActiveMetricKey=null;capActiveCapIdx=null;capActiveSubCapIdx=null;
  const el=document.getElementById('cc-main');
  if(el)el.innerHTML='<div id="cc-main" style="display:flex;flex-direction:column;flex:1;overflow:hidden;"></div>';
  ccRenderPartial();
}

// Store original left panel HTML on first load
let _origLeftPanelHTML='';
document.addEventListener('DOMContentLoaded',function(){
  const lp=document.getElementById('left-panel');
  if(lp)_origLeftPanelHTML=lp.innerHTML;
});

// ── Export dropdown (replaces modal) ──

// ── CC Export — in-flight state, render helper, snapshot builder ──
var ccExportInFlight=false;
function ccRenderExportBtn(){
  return'<button id="cc-export-btn" class="export-cta-btn" onclick="ccExportDocx()"'+(ccExportInFlight?' disabled':'')+'>'+
    (ccExportInFlight?'<i class="ti ti-loader-2" style="font-size:11px;animation:spin 1s linear infinite;" aria-hidden="true"></i> Exporting\u2026':
    '<i class="ti ti-download" style="font-size:11px;" aria-hidden="true"></i> Export')+
  '</button>';
}
function ccSyncExportBtn(){
  var btn=document.getElementById('cc-export-btn');
  if(!btn)return;
  btn.disabled=!!ccExportInFlight;
  btn.innerHTML=ccExportInFlight?
    '<i class="ti ti-loader-2" style="font-size:11px;animation:spin 1s linear infinite;" aria-hidden="true"></i> Exporting\u2026':
    '<i class="ti ti-download" style="font-size:11px;" aria-hidden="true"></i> Export';
}
function _ccGetVisibleCapsSnapshot(){
  var result=[];
  if(!capStore)return result;
  var stageOrder=(typeof gData!=='undefined'&&gData&&Array.isArray(gData.stages))?gData.stages.map(function(s){return s&&s.id;}).filter(Boolean):[];
  var byStage={};
  Object.keys(capStore).forEach(function(mk){
    var en=capStore[mk];if(!en)return;
    var sid=en.stageId||'other';
    if(!byStage[sid])byStage[sid]=[];
    byStage[sid].push({mk:mk,en:en});
  });
  var allIds=[].concat(stageOrder,Object.keys(byStage).filter(function(s){return stageOrder.indexOf(s)<0;}));
  allIds.forEach(function(sid){
    var group=byStage[sid];if(!group||!group.length)return;
    group.forEach(function(item){
      var mk=item.mk,en=item.en;
      var isPi=mk.indexOf('pi||')===0,isDiag=mk.indexOf('diag||')===0,isMi=mk.indexOf('mi||')===0;
      var stageLabel=en.stageLabel||sid;
      var rawColor=(typeof ccStageColor==='function')?ccStageColor(sid):'#003087';
      var origin=isMi?'market':isDiag?'diagnostic':isPi?'pi':(en._docGrounded?'doc':'kpi');
      (en.capabilities||[]).forEach(function(cap){
        var passes=isPi||isDiag||isMi
          ?(typeof _ccPiCapPassesFilter==='function'?_ccPiCapPassesFilter(cap,en):true)
          :(typeof _ccKpiCapPassesFilter==='function'?_ccKpiCapPassesFilter(cap,en):true);
        if(!passes)return;
        result.push({stageLabel:stageLabel,stageId:sid,stageColor:rawColor,metricName:en.metricName||'',cap:cap,origin:origin});
      });
    });
  });
  return result;
}
async function ccExportDocx(){
  if(ccExportInFlight)return;
  var snap=_ccGetVisibleCapsSnapshot();
  if(!snap.length){showToast('No capabilities to export. Check your filter settings.','info');return;}
  var productName=typeof getProductCtx==='function'?getProductCtx().name:'Product';
  ccExportInFlight=true;ccSyncExportBtn();
  try{
    await ccDownloadBriefDOCX(snap,productName);
  }catch(err){
    showToast('Export failed: '+err.message,'error');
    console.error('[CC Export]',err);
  }finally{
    ccExportInFlight=false;ccSyncExportBtn();
  }
}

// ccOnTabLeave — MJ-7 fix: check state directly, not class
function ccOnTabLeave(){
  if(capActiveMetricKey!==null){
    ccExitNavigator();
  }
}

// ══════════════════════════════════════════════════════════
// PI-FIRST MODE — Path B
// ══════════════════════════════════════════════════════════

// ── Show PI inputs form — rendered INSIDE cc-main as a sidebar layout ──
// #left-panel is sc-hidden on CC tab, so we inject the entire layout into cc-main

function ccShowPIFirstForm(isEditing){
  const main=document.getElementById('cc-main');
  if(!main)return;
  const piGoalVal=(typeof piInputs!=='undefined'&&piInputs.piGoal)||'';
  const constraintsVal=(typeof piInputs!=='undefined'&&piInputs.constraints)||'';
  const type=(typeof piInputs!=='undefined'&&piInputs.type)||'caps-only';

  main.innerHTML=`
    <div class="cc-layout">
      <div class="cc-pif-panel" id="cc-pif-panel">
        <div class="cc-pif-hdr">
          <div class="cc-pif-hdr-top">
            ${isEditing
              ?`<button class="cc-pif-back" onclick="piFirstBuilt=true;ccOpenNavigator()"><i class="ti ti-x" style="font-size:10px;" aria-hidden="true"></i> Cancel</button>`
              :`<button class="cc-pif-back" onclick="ccExitPIFirst()"><i class="ti ti-chevron-left" style="font-size:10px;" aria-hidden="true"></i> Back to Discovery Map</button>`
            }
          </div>
          <div class="ph-title" style="margin-top:6px;">${isEditing?'EDIT CUSTOM PLAN':'YOUR CAPABILITY PLAN'}</div>
          <div class="ph-sub">${isEditing?'Add more capabilities — existing ones are preserved.':'Paste your capabilities — AI builds features for each.'}</div>
        </div>
        <div class="form-scroll" id="cc-pif-scroll">
          <div class="fl">
            <label>Business Outcome / Release Goal</label>
            <textarea id="cc-pi-goal" class="f-textarea" rows="2"
              placeholder="e.g. Reduce cart abandonment by 12% before peak season."
              maxlength="300"
              oninput="if(typeof piInputs!=='undefined')piInputs.piGoal=this.value"
            >${e(piGoalVal)}</textarea>
            <span class="hint">Sets AI context for all feature and story generation.</span>
          </div>
          <div class="fl">
            <label>Capability Plan Format</label>
            <div class="cc-pi-type-group">
              <label class="cc-pi-type-opt">
                <input type="radio" name="piInputType" value="caps-only"
                  ${type==='caps-only'?'checked':''}
                  onchange="ccPITypeChange(this.value)">
                Capabilities only
              </label>
              <label class="cc-pi-type-opt">
                <input type="radio" name="piInputType" value="caps-features"
                  ${type==='caps-features'?'checked':''}
                  onchange="ccPITypeChange(this.value)">
                Capabilities + features
              </label>
            </div>
          </div>
          <div class="fl">
            <label>Upload file</label>
            <div class="cc-upload-row" onclick="document.getElementById('cc-file-input').click()">
              <i class="ti ti-upload" style="font-size:13px;color:var(--purple);flex-shrink:0;" aria-hidden="true"></i>
              <span class="cc-upload-row-label">Click to upload</span>
              <span class="cc-upload-row-types">.xlsx &middot; .csv &middot; .txt</span>
              <a href="assets/templates/capability-list-template.xlsx" class="cc-template-link" onclick="event.stopPropagation()" style="margin-left:auto;"><i class="ti ti-download" style="font-size:11px;" aria-hidden="true"></i> Template</a>
            </div>
            <input type="file" id="cc-file-input" accept=".xlsx,.csv,.txt" style="display:none" onchange="ccHandleFileUpload(this)">
          </div>
          <div class="fl">
            <label>Paste Capabilities</label>
            <textarea id="cc-paste-area" class="f-textarea" rows="4"
              placeholder="One capability per line&#10;e.g.&#10;Checkout redesign&#10;Returns flow&#10;Loyalty tier upgrade"
              maxlength="3000"
              oninput="ccParsePasteInput(this.value)"></textarea>
            <span class="ctx-counter" id="cc-paste-counter">0 / 20 capabilities</span>
          </div>
          <div id="cc-parse-result"></div>
          <div class="fl">
            <label>Known Constraints</label>
            <textarea id="cc-constraints" class="f-textarea" rows="2"
              placeholder="e.g. Payments infra must complete before checkout redesign."
              maxlength="1000"
              oninput="if(typeof piInputs!=='undefined')piInputs.constraints=this.value"
            >${e(constraintsVal)}</textarea>
            <span class="hint">One per line. AI treats these as hard sequencing rules.</span>
          </div>
        </div>
        <div class="gen-wrap">
          <button class="gen-btn" id="cc-pi-build-btn" onclick="ccBuildPICanvas()">
            <i class="ti ti-layers-subtract" style="font-size:13px;" aria-hidden="true"></i>
            ${isEditing?'Add to Canvas':'Build Process Areas'}
          </button>
        </div>
      </div>
      <div class="cc-pif-main" id="cc-pif-main">
        <div class="cc-pif-empty">
          <i class="ti ti-clipboard-list" style="font-size:32px;color:var(--label);" aria-hidden="true"></i>
          <div class="cc-pif-empty-title">Your process areas will appear here</div>
          <div class="cc-pif-empty-sub">Fill in the form on the left and click Build Process Areas.</div>
        </div>
      </div>
    </div>`;

  // Re-validate if data already exists
  if(typeof piInputs!=='undefined'&&piInputs.parsedCaps&&piInputs.parsedCaps.length>0){
    // Pre-populate paste area with existing cap names
    const ta=document.getElementById('cc-paste-area');
    if(ta&&!ta.value.trim()){
      ta.value=piInputs.parsedCaps.map(c=>c.name).join('\n');
    }
    ccRenderParseResult(piInputs.parsedCaps);
  }
}

function ccPITypeChange(val){
  if(typeof piInputs!=='undefined')piInputs.type=val;
  const ta=document.getElementById('cc-paste-area');
  if(!ta)return;
  const hints={'caps-only':'One capability per line\ne.g.\nCheckout redesign\nReturns flow\nLoyalty tier upgrade',
    'caps-features':'Format: Capability: Feature name\ne.g.\nCheckout redesign: Fast checkout UX\nCheckout redesign: Address autocomplete\nReturns flow: Self-serve portal'};
  ta.placeholder=hints[val]||hints['caps-only'];
  const link=document.querySelector('.cc-template-link');
  if(link){
    const maps={'caps-only':'assets/templates/capability-list-template.xlsx','caps-features':'assets/templates/capability-features-template.xlsx'};
    link.href=maps[val]||maps['caps-only'];
  }
}

function ccHandleFileUpload(input){
  const file=input.files[0];
  if(!file)return;
  const ext=file.name.split('.').pop().toLowerCase();
  const resultEl=document.getElementById('cc-parse-result');
  if(resultEl)resultEl.innerHTML='<div class="cc-parse-loading"><div class="cc-spin-sm"></div> Reading file…</div>';
  if(ext==='txt'||ext==='csv'){
    const reader=new FileReader();
    reader.onload=ev=>ccParseTextContent(ev.target.result);
    reader.readAsText(file);
  } else if(ext==='xlsx'){
    const reader=new FileReader();
    reader.onload=ev=>{
      if(typeof XLSX==='undefined'){
        const s=document.createElement('script');
        s.src='https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
        s.onload=()=>ccParseXLSX(ev.target.result);
        s.onerror=()=>ccShowParseError('Could not load XLSX library. Check internet connection.');
        document.head.appendChild(s);
      } else {
        ccParseXLSX(ev.target.result);
      }
    };
    reader.readAsArrayBuffer(file);
  } else {
    ccShowParseError('Unsupported file type. Use .xlsx, .csv, or .txt.');
  }
}

function ccParseXLSX(arrayBuffer){
  try{
    const wb=XLSX.read(arrayBuffer,{type:'array'});
    const ws=wb.Sheets[wb.SheetNames[0]];
    const data=XLSX.utils.sheet_to_json(ws,{defval:''});
    if(!data||data.length===0){ccShowParseError('File appears empty.');return;}
    // Try to find capability column
    const firstRow=data[0];
    const keys=Object.keys(firstRow).map(k=>k.toLowerCase());
    const capKey=Object.keys(firstRow)[keys.indexOf('capability')]||Object.keys(firstRow)[keys.indexOf('capabilities')];
    const featKey=Object.keys(firstRow)[keys.indexOf('feature')]||Object.keys(firstRow)[keys.indexOf('features')];
    if(!capKey){ccShowParseError('Could not find a "Capability" column. Download the template for the expected format.');return;}
    const caps={};
    data.forEach(row=>{
      const capName=(row[capKey]||'').trim();
      if(!capName)return;
      if(!caps[capName])caps[capName]={name:capName,features:[]};
      if(featKey&&row[featKey]){
        caps[capName].features.push({name:(row[featKey]||'').trim(),why:''});
      }
    });
    const parsed=Object.values(caps);
    ccFinalizeParse(parsed);
  }catch(err){
    ccShowParseError('Could not read file: '+err.message);
  }
}

function ccParseTextContent(text){
  const type=(typeof piInputs!=='undefined'&&piInputs.type)||'caps-only';
  const lines=text.split('\n').map(l=>l.trim()).filter(Boolean);
  const caps={};
  lines.forEach(line=>{
    if(type==='caps-features'&&line.includes(':')){
      const idx=line.indexOf(':');
      const capName=line.substring(0,idx).trim();
      const featName=line.substring(idx+1).trim();
      if(capName){
        if(!caps[capName])caps[capName]={name:capName,features:[]};
        if(featName)caps[capName].features.push({name:featName,why:''});
      }
    } else {
      const capName=line.replace(/^[-•*]\s*/,'');
      if(capName&&!caps[capName])caps[capName]={name:capName,features:[]};
    }
  });
  ccFinalizeParse(Object.values(caps));
}

function ccParsePasteInput(text){
  const lines=text.split('\n').map(l=>l.trim()).filter(Boolean);
  const counter=document.getElementById('cc-paste-counter');
  const type=(typeof piInputs!=='undefined'&&piInputs.type)||'caps-only';
  const caps={};
  lines.forEach(line=>{
    if(type==='caps-features'&&line.includes(':')){
      const capName=line.substring(0,line.indexOf(':')).trim();
      const featName=line.substring(line.indexOf(':')+1).trim();
      if(capName){if(!caps[capName])caps[capName]={name:capName,features:[]};if(featName)caps[capName].features.push({name:featName,why:''});}
    } else {
      const capName=line.replace(/^[-•*]\s*/,'');
      if(capName&&!caps[capName])caps[capName]={name:capName,features:[]};
    }
  });
  const parsed=Object.values(caps);
  if(counter)counter.textContent=parsed.length+' / 20 capabilities';
  if(parsed.length>0)ccFinalizeParse(parsed);
  else{const r=document.getElementById('cc-parse-result');if(r)r.innerHTML='';}
}

function ccFinalizeParse(parsed){
  if(!parsed||parsed.length===0){ccShowParseError('No capabilities found. Check the format.');return;}
  if(parsed.length>20){parsed=parsed.slice(0,20);}
  // Store parsed data
  if(typeof piInputs!=='undefined'){
    piInputs.parsedCaps=parsed.map(c=>({name:c.name,description:''}));
    piInputs.parsedFeatures=parsed.flatMap(c=>(c.features||[]).map(f=>({capability:c.name,name:f.name,why:f.why||''})));
  }
  // Check for overlaps with existing KPI capStore
  const kpiCaps=Object.values(capStore).filter(e=>!e._piFirst).flatMap(e=>e.capabilities.map(c=>c.name.toLowerCase()));
  const overlaps=parsed.filter(p=>kpiCaps.some(k=>ccFuzzyMatch(k,p.name.toLowerCase())));
  ccRenderParseResult(parsed,overlaps);
}

function ccFuzzyMatch(a,b){
  if(a===b)return true;
  const shorter=a.length<b.length?a:b;
  const longer=a.length<b.length?b:a;
  if(longer.includes(shorter))return true;
  const wordsA=a.split(/\s+/);const wordsB=b.split(/\s+/);
  const shared=wordsA.filter(w=>w.length>3&&wordsB.includes(w));
  return shared.length>=2;
}

function ccRenderParseResult(parsed,overlaps){
  const resultEl=document.getElementById('cc-parse-result');
  if(!resultEl)return;
  const featCount=(typeof piInputs!=='undefined'&&piInputs.parsedFeatures)?piInputs.parsedFeatures.length:0;
  let html=`<div class="cc-parse-ok"><i class="ti ti-check" style="font-size:11px;" aria-hidden="true"></i> ${parsed.length} capabilities detected${featCount>0?' · '+featCount+' features':' · AI will generate features for each'}</div>`;
  if(overlaps&&overlaps.length>0){
    html+=`<div class="cc-parse-overlap"><i class="ti ti-alert-triangle" style="font-size:11px;flex-shrink:0;" aria-hidden="true"></i>
      <div><strong>${overlaps.length} possible overlap${overlaps.length>1?'s':''} with Discovery Map</strong><br>
      ${overlaps.map(o=>`"${e(o.name)}" ≈ KPI entry. 
        <button class="cc-overlap-btn" onclick="ccResolveOverlap('${e(o.name)}','merge')">Merge with KPI</button>
        <button class="cc-overlap-btn cc-overlap-btn-ghost" onclick="ccResolveOverlap('${e(o.name)}','separate')">Keep separate</button>`).join('<br>')}
      </div></div>`;
  }
  resultEl.innerHTML=html;
}

function ccShowParseError(msg){
  const r=document.getElementById('cc-parse-result');
  if(r)r.innerHTML=`<div class="cc-parse-error"><i class="ti ti-alert-circle" style="font-size:11px;" aria-hidden="true"></i> ${e(msg)} <a href="assets/templates/capability-list-template.xlsx" style="color:var(--purple);font-size:10px;">Download template ↓</a></div>`;
}

function ccResolveOverlap(capName,resolution){
  if(typeof piInputs!=='undefined')piInputs.overlapResolutions[capName]=resolution;
  // Refresh parse result display — keep result but remove that overlap row
  const updated=(piInputs.parsedCaps||[]);
  const remainingOverlaps=updated.filter(p=>{
    const kpiCaps=Object.values(capStore).filter(e=>!e._piFirst).flatMap(e=>e.capabilities.map(c=>c.name.toLowerCase()));
    return kpiCaps.some(k=>ccFuzzyMatch(k,p.name.toLowerCase()))&&!piInputs.overlapResolutions[p.name];
  });
  ccRenderParseResult(updated,remainingOverlaps);
}

async function ccBuildPICanvas(){
  const key=getKey();
  if(aiGenInFlight.active){showToast("Still working on your last request. Hang tight, this won't take long.",'info');return;}
  const caps=(typeof piInputs!=='undefined'&&piInputs.parsedCaps)||[];
  if(caps.length===0){showToast('Add at least one capability to continue.','warn');return;}
  const btn=document.getElementById('cc-pi-build-btn');
  if(btn){btn.disabled=true;btn.innerHTML='<div class="cc-spin-sm"></div> Building…';}
  // Show loader in main panel
  const pifMain=document.getElementById('cc-pif-main');
  if(pifMain){pifMain.innerHTML=`<div class="loading on" style="flex:1;">
    <div class="spin"></div>
    <div class="load-txt" id="cc-pif-load-txt">Building your Process Areas…</div>
    <div class="load-sub" id="cc-pif-load-sub">AI is generating capabilities for each item.</div>
    <div class="load-steps" id="cc-pif-load-steps"></div>
  </div>`;}
  // Rotate loader messages
  const _pifMsgs=['Mapping your capabilities to product outcomes…','Identifying feature opportunities for each capability…','Building your product canvas from the ground up…','Almost there — finalising your capability map…'];
  let _pifMsgIdx=0;
  const _pifMsgInterval=setInterval(()=>{
    const el=document.getElementById('cc-pif-load-sub');
    if(el&&_pifMsgIdx<_pifMsgs.length){el.textContent=_pifMsgs[_pifMsgIdx++];}
    else clearInterval(_pifMsgInterval);
  },4000);
  const _ctx7=getFullProductCtx();
  const piGoal=(typeof piInputs!=='undefined'&&piInputs.piGoal)||'';
  var _piDocRes1=(typeof buildDocContext==='function')?buildDocContext('pi',piGoal):{text:'',truncated:false};
  _ctx7.docContext=_piDocRes1.text;
  _fireDocTruncatedToast(_piDocRes1.truncated);
  const withFeatures=(typeof piInputs!=='undefined'&&piInputs.parsedFeatures&&piInputs.parsedFeatures.length>0);
  const _needsAI=!withFeatures&&caps.some(cap=>!capStore[ccPIKey(cap.name)]);
  if(_needsAI)startAiGen(`Capabilities for ${caps.length} item${caps.length!==1?'s':''} are being generated. Leaving now discards this batch, you'll need to start again.`);
  // Generate each capability
  for(const cap of caps){
    if(_needsAI&&!aiGenInFlight.active)break; // aborted via "Leave anyway"
    const key2=ccPIKey(cap.name);
    if(capStore[key2])continue; // already generated
    // If features were pasted, use them directly
    if(withFeatures){
      const feats=(piInputs.parsedFeatures||[]).filter(f=>f.capability===cap.name);
      // v9.05: PI-first path treats each parsed capability as its own
      // independent process area (unlike the Add Capability modal's shared
      // default bucket) — each gets its OWN fresh bucketId, so Discovery
      // Map shows one distinct custom process area per PI-first capability,
      // matching how this flow already behaves conceptually (a full plan
      // of independent capabilities, not repeated adds to one bucket).
      //
      // v9.05 fix: the capStore write and the l1_metrics write MUST share
      // the exact same guard condition — a prior version of this code had
      // them under different conditionals, meaning a capStore entry could
      // be created with a bucketId that has no matching l1_metrics entry
      // in gData.stages (orphaned, invisible in Discovery Map, fully
      // functional in Capability Canvas — a split-brain state).
      const _canBucket=(typeof makeBucketId==='function'&&typeof gData!=='undefined'&&gData);
      const _bucketId=_canBucket?makeBucketId():null;
      if(_canBucket){
        if(!Array.isArray(gData.stages))gData.stages=[];
        let _piStage=gData.stages.find(s=>s&&s.id==='pi');
        if(!_piStage){
          _piStage={id:'pi',label:'Custom Value Stage',description:'Captures process areas and capabilities added directly in Capability Canvas, outside the AI-generated stages above.',l1_metrics:[]};
          gData.stages.push(_piStage);
        }
        if(!Array.isArray(_piStage.l1_metrics))_piStage.l1_metrics=[];
        _piStage.l1_metrics.push({name:cap.name,why:'Auto-created from your release-first capability plan.',bucketId:_bucketId,_isDefaultCustomMetric:false});
      }
      const _piLbl=typeof getPiStageLabel==='function'?getPiStageLabel(gData):'Custom Value Stage';
      capStore[key2]={metricName:cap.name,stageLabel:_piLbl,stageId:'pi',bucketId:_bucketId,_piFirst:true,
        capabilities:[{name:cap.name,why:piGoal||'release-first capability',subCaps:null,features:[],
          featStore:{top:feats.map(f=>({name:f.name,why:f.why||'release-first feature',selected:false,metric:'',stage:_piLbl,cap:cap.name,subCap:null}))}}]};
    } else {
      // AI generates capabilities for this name
      try{
        const txt=await callAPI(
          'You are a senior product strategist. Respond ONLY with valid JSON. No markdown, no backticks, no preamble. Never use em dashes (—) in your output; use a hyphen (-) or rewrite the phrase.',
          buildPICapPrompt(_ctx7,piGoal,cap.name,''),
          2000,
          aiGenInFlight.controller?aiGenInFlight.controller.signal:undefined,
          null,
          'cc-gen-features-pi'
        );
        const clean=txt.replace(/```json|```/g,'').trim();
        let parsed;
        try{parsed=JSON.parse(clean);}catch(pe){const s=clean.indexOf('{');const l=clean.lastIndexOf('}');if(s>=0&&l>s)try{parsed=JSON.parse(clean.substring(s,l+1));}catch(pe2){}}
        if(parsed&&parsed.capabilities&&parsed.capabilities.length>0){
          const c=parsed.capabilities[0];
          const _capName=c.name||cap.name;
          // v9.05: same independent-bucket-per-capability rationale, and
          // same shared-guard fix, as the withFeatures branch above.
          const _canBucket=(typeof makeBucketId==='function'&&typeof gData!=='undefined'&&gData);
          const _bucketId=_canBucket?makeBucketId():null;
          if(_canBucket){
            if(!Array.isArray(gData.stages))gData.stages=[];
            let _piStage=gData.stages.find(s=>s&&s.id==='pi');
            if(!_piStage){
              _piStage={id:'pi',label:'Custom Value Stage',description:'Captures process areas and capabilities added directly in Capability Canvas, outside the AI-generated stages above.',l1_metrics:[]};
              gData.stages.push(_piStage);
            }
            if(!Array.isArray(_piStage.l1_metrics))_piStage.l1_metrics=[];
            _piStage.l1_metrics.push({name:_capName,why:'Auto-created from your release-first capability plan.',bucketId:_bucketId,_isDefaultCustomMetric:false});
          }
          capStore[key2]={metricName:_capName,stageLabel:(typeof getPiStageLabel==='function'?getPiStageLabel(gData):'Custom Value Stage'),stageId:'pi',bucketId:_bucketId,_piFirst:true,
            capabilities:[{name:_capName,why:c.why||piGoal||'release-first capability',
              subCaps:c.sub_capabilities&&c.sub_capabilities.length>0?c.sub_capabilities:null,
              features:[],featStore:{}}]};
        }
      }catch(err){
        if(err.name==='AbortError')break;
        console.warn('PI cap generation failed for',cap.name,err);
      }
    }
  }
  if(_needsAI)endAiGen();
  piMode=true;
  piFirstBuilt=true;
  capStoreInvalidated=false;
  if(btn){btn.disabled=false;btn.innerHTML='<i class="ti ti-layers-subtract" style="font-size:13px;" aria-hidden="true"></i> Build Process Areas';}
  // v9.05: normalize + sync local DM view — de-dupes any malformed
  // l1_metrics entries and reflects the new PI-first buckets immediately.
  if(typeof syncPiStageFromCapStore==='function')syncPiStageFromCapStore(gData,capStore);
  if(typeof curTab!=='undefined'&&curTab==='mm'&&typeof renderMM==='function')renderMM(gData);
  // Show All Capabilities view automatically
  capActiveMetricKey=null;
  capActiveCapIdx=null;capActiveSubCapIdx=null;
  ccOpenNavigator();
  fcUpdateTabBadge();
  ccUpdateTabBadge();
}

function ccPIKey(capName){
  return 'pi||'+capName.toLowerCase().trim().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'');
}

function ccExitPIFirst(){
  piMode=false;
  piFirstBuilt=false;
  switchTab('mm');
}

// ── syncRightPanelBodyState ──────────────────────────────────────────────────
// Derives right-panel open state from DOM and syncs #out-body class.
// Called after every DD panel or evidence drawer open/close.
// Exposed on window so diagnostic-view.js can call it safely.
function syncRightPanelBodyState(){
  const ob=document.getElementById('out-body');
  if(!ob)return;
  const anyOpen=!!document.querySelector('.dd-panel.open')||!!document.querySelector('.kpi-evidence-drawer.open');
  ob.classList.toggle('has-right-panel',anyOpen);
}
window.syncRightPanelBodyState=syncRightPanelBodyState;

// ── Metrics Dictionary panel trigger (called from KPI tree L1 node) ──
function ccOpenDDPanel(metricKey,metricName,stageLabel){
  // Close evidence drawer if open — only one right panel at a time
  if(typeof dvCloseEvidenceDrawer==='function')dvCloseEvidenceDrawer();
  piDdPanelMetricKey=metricKey;
  piDdPanelOpen=true;
  let panel=document.getElementById('dd-panel');
  if(!panel){
    panel=document.createElement('div');
    panel.id='dd-panel';
    panel.className='dd-panel';
    const right=document.querySelector('.right');
    if(right)right.appendChild(panel);
    else document.body.appendChild(panel);
  }
  panel.classList.add('open');
  syncRightPanelBodyState();
  // Push KPI tree content left so panel doesn't cover it
  const ob=document.getElementById('out-body');
  if(ob)ob.style.marginRight='440px';
  const metric=gData?ccFindMetricInGData(metricKey):null;
  const metricObj=metric||{name:metricName,why:'',definition:'',benchmark:'',redFlag:'',instrumentation:''};
  panel.innerHTML=ccRenderDDPanel(metricObj,metricName,stageLabel);
  // Auto-generate DD fields if this metric has no data yet
  if(!ccMetricHasDDData(metricObj,metricName)){
    const requestKey=metricKey;
    setTimeout(function(){
      if(!piDdPanelOpen||piDdPanelMetricKey!==requestKey)return;
      ccDDGenerateForMetricSafe(requestKey,metricName,stageLabel);
    },0);
  }
}

function ccFindMetricInGData(metricKey){
  if(!gData)return null;
  const parts=metricKey.split('||');
  const metricName=(parts[1]||'').toLowerCase().trim();
  for(const st of gData.stages){
    for(const l1 of (st.l1_metrics||[])){
      if(l1&&(l1.name||'').toLowerCase().trim()===metricName)return{...l1,stageLabel:st.label};
      for(const l2 of (l1.l2_metrics||[])){
        if(l2&&(l2.name||'').toLowerCase().trim()===metricName)return{...l2,stageLabel:st.label};
        for(const l3 of (l2.l3_metrics||[])){
          if(l3&&(l3.name||'').toLowerCase().trim()===metricName)return{...l3,stageLabel:st.label};
        }
      }
    }
  }
  return null;
}

function ccRenderDDPanel(metric,metricName,stageLabel){
  const metrics=ccGetAllL1Metrics();
  const idx=metrics.findIndex(m=>m.metricName===metricName);
  const total=metrics.length;
  // Look up generated DD data from window._ddRows if available
  const ddRow=(window._ddRows||[]).find(r=>r.name&&r.name.toLowerCase().trim()===metricName.toLowerCase().trim());
  const def=ddRow?ddRow.def:(metric.definition||null);
  const bm=ddRow?ddRow.bm:(metric.benchmark||null);
  const rf=ddRow?(ddRow.rf):(metric.red_flag||metric.redFlag||null);
  const why=metric.why||null;
  // Row-level hasDD: true if any DD field has usable data (not just global ddGenerated flag)
  const _usable=function(v){const s=String(v||'').trim();return s&&s!=='—';};
  const rowHasDD=_usable(def)||_usable(bm)||_usable(rf);
  const hasDD=rowHasDD;
  const notGenerated='<span style="font-size:10px;color:var(--label);font-style:italic;">Generate to populate</span>';
  return`<div class="dd-panel-hdr">
    <div class="dd-panel-breadcrumb"><span class="dd-panel-stage">${e(stageLabel)}</span><span class="dd-panel-sep">›</span><span class="dd-panel-title">Dictionary</span></div>
    <div class="dd-panel-actions">
      <button class="dd-panel-close" onclick="ccCloseDDPanelUserAction()">✕</button>
    </div>
  </div>
  <div class="dd-panel-metric-name">${e(metricName)}</div>
  <div class="dd-panel-body-scroll">
    <div class="dd-panel-section-lbl">WHY IT MATTERS</div>
    <div class="dd-panel-section-val">${why?e(why):notGenerated}</div>
    <div class="dd-panel-section-lbl">DEFINITION</div>
    <div class="dd-panel-section-val">${def&&def!=='—'?e(def):notGenerated}</div>
    <div class="dd-panel-section-lbl">BENCHMARK</div>
    <div class="dd-panel-section-val dd-panel-benchmark">${bm&&bm!=='—'?e(bm):notGenerated}</div>
    <div class="dd-panel-section-lbl">RED FLAG</div>
    <div class="dd-panel-section-val dd-panel-redflag">${rf&&rf!=='—'?e(rf):notGenerated}</div>
    <div class="dd-panel-gen-strip" id="dd-gen-strip">
      ${ddGenerated&&Array.isArray(window._ddRows)&&window._ddRows.length>0
        ?`<div class="dd-panel-gen-note" style="color:var(--green);margin-bottom:8px;"><i class="ti ti-check" style="font-size:11px;" aria-hidden="true"></i> Dictionary generated for all metrics</div>
           <button class="dl-btn" id="dd-panel-dl-btn" onclick="ccDDDownload()" style="width:100%;">↓ Download .xlsx</button>`
        :((typeof canEditSession!=='function')||canEditSession())
          ?`<div class="dd-panel-gen-note" style="margin-bottom:8px;">Want definitions for all metrics?</div>
           <button class="gen-btn" style="font-size:11px;padding:8px;width:100%;" onclick="ccDDGenerateAll()">
             <i class="ti ti-table" style="font-size:12px;" aria-hidden="true"></i> Generate for All Metrics
           </button>`
          :`<div class="dd-panel-gen-note" style="margin-bottom:0;">Dictionary not yet generated for all metrics.</div>`
      }
    </div>
  </div>
  <div class="dd-panel-nav">
    <button class="dd-panel-nav-btn" onclick="ccNavDDPanel(-1)" ${idx<=0?'disabled':''}>‹ Prev</button>
    <span class="dd-panel-nav-info">${idx+1} of ${total}</span>
    <button class="dd-panel-nav-btn" onclick="ccNavDDPanel(1)" ${idx>=total-1?'disabled':''}>Next ›</button>
  </div>`;
}

function ccNavDDPanel(dir){
  const metrics=ccGetAllL1Metrics();
  const idx=metrics.findIndex(m=>m.metricKey===piDdPanelMetricKey);
  const newIdx=Math.max(0,Math.min(metrics.length-1,idx+dir));
  const m=metrics[newIdx];
  if(m)ccOpenDDPanel(m.metricKey,m.metricName,m.stageLabel);
}

// User-facing close (X button) — guarded against in-flight generation.
function ccCloseDDPanelUserAction(){
  if(guardAiGenNav(()=>ccCloseDDPanel()))return;
  ccCloseDDPanel();
}

function ccCloseDDPanel(){
  piDdPanelOpen=false;
  const panel=document.getElementById('dd-panel');
  if(panel)panel.classList.remove('open');
  // Restore out-body margin
  const ob=document.getElementById('out-body');
  if(ob)ob.style.marginRight='';
  syncRightPanelBodyState();
}

// ── Metrics Dictionary download (generate if needed, then download) ──
async function ccDDDownload(){
  const btn=document.getElementById('dd-panel-dl-btn');
  if(btn){btn.disabled=true;btn.textContent='Preparing…';}
  try{
    if(!ddGenerated){
      // Generate first
      if(typeof generateDD==='function')await generateDD();
    }
    // Download
    if(typeof downloadXLSX==='function')downloadXLSX();
    // Re-render panel to reflect generated state
    if(piDdPanelMetricKey&&piDdPanelOpen){
      const metrics=ccGetAllL1Metrics();
      const m=metrics.find(x=>x.metricKey===piDdPanelMetricKey);
      if(m){const metric=ccFindMetricInGData(piDdPanelMetricKey)||{name:m.metricName};
        const panel=document.getElementById('dd-panel');
        if(panel)panel.innerHTML=ccRenderDDPanel(metric,m.metricName,m.stageLabel);}
    }
  }catch(err){console.error('DD download error:',err);}
  finally{if(btn){btn.disabled=false;btn.textContent='↓ Download full dict';}}
}

// Called from in-app modal confirm button
function ccConfirmPIFirst(btn){
  btn.closest('.modal-overlay').remove();
  capActiveMetricKey=null;capActiveCapIdx=null;capActiveSubCapIdx=null;
  piMode=true;
  ccShowPIFirstForm();
}

function ccConfirmPIFirstChoice(btn){
  const modal=btn.closest('.modal');
  const chosen=modal.querySelector('.cc-choice-card.selected');
  if(!chosen)return;
  btn.closest('.modal-overlay').remove();
  if(chosen.dataset.choice==='clear'){
    // Start fresh — remove KPI caps
    Object.keys(capStore).filter(k=>!k.startsWith('pi||')).forEach(k=>delete capStore[k]);
  }
  // else keep both — do nothing extra
  capActiveMetricKey=null;capActiveCapIdx=null;capActiveSubCapIdx=null;
  piMode=true;
  ccShowPIFirstForm();
}

// ── DD Panel: check if metric has any usable DD data ──
function ccMetricHasDDData(metric,metricName){
  const norm=function(s){return String(s||'').trim().toLowerCase();};
  const usable=function(v){const s=String(v||'').trim();return s&&s!=='—';};
  const row=(window._ddRows||[]).find(function(r){return r.name&&norm(r.name)===norm(metricName);});
  const def=row?row.def:(metric&&metric.definition);
  const bm=row?row.bm:(metric&&metric.benchmark);
  const rf=row?row.rf:(metric&&(metric.red_flag||metric.redFlag));
  // Return true if ANY field has usable data — prevents repeated auto-generation on partial rows
  return usable(def)||usable(bm)||usable(rf);
}

// ── DD Panel: safe single-metric generation (aiGenInFlight-aware, key-guarded) ──
async function ccDDGenerateForMetricSafe(metricKey,metricName,stageLabel){
  if(aiGenInFlight&&aiGenInFlight.active){return;}
  const startedKey=metricKey;
  const panel=document.getElementById('dd-panel');
  const strip=panel?panel.querySelector('#dd-gen-strip'):null;
  if(strip)strip.innerHTML='<div class="cc-parse-loading"><div class="cc-spin-sm"></div> Generating for '+e(metricName)+'…</div>';
  try{
    if(!gData)throw new Error('No Discovery Map data.');
    const key=getKey();
    const txt=await callAPI((typeof SYS_DD!=='undefined'?SYS_DD:''),buildDDPrompt([{stage:stageLabel,level:'L1',name:metricName}]),1500,null,'claude-haiku-4-5','cc-dd-single');
    const clean=txt.replace(/```json|```/g,'').trim();
    let parsed=null;
    try{const arr=JSON.parse(clean);if(Array.isArray(arr))parsed=arr;else if(arr&&arr.name)parsed=[arr];}
    catch(pe){const m2=clean.match(/\[[\s\S]*/);if(m2){try{parsed=JSON.parse(m2[0]);}catch(pe2){}}}
    if(!parsed||!parsed.length)throw new Error('Could not parse definitions.');
    if(!window._ddRows)window._ddRows=[];
    const existing=window._ddRows.findIndex(function(r){return r.name&&r.name.toLowerCase().trim()===metricName.toLowerCase().trim();});
    const row={name:metricName,sl:stageLabel,lvl:'L1',def:parsed[0].definition||'—',bm:parsed[0].benchmark||'—',rf:parsed[0].red_flag||'—'};
    if(existing>=0)window._ddRows[existing]=row;else window._ddRows.push(row);
    // Only re-render if panel is still showing the metric we generated for
    if(!piDdPanelOpen||piDdPanelMetricKey!==startedKey)return;
    const m=ccGetAllL1Metrics().find(function(x){return x.metricKey===startedKey;});
    if(m){
      const metric=ccFindMetricInGData(startedKey)||{name:m.metricName};
      const currentPanel=document.getElementById('dd-panel');
      if(currentPanel)currentPanel.innerHTML=ccRenderDDPanel(metric,m.metricName,m.stageLabel);
    }
  }catch(err){
    if(!piDdPanelOpen||piDdPanelMetricKey!==startedKey)return;
    const currentStrip=document.querySelector('#dd-panel #dd-gen-strip');
    if(currentStrip)currentStrip.innerHTML='<div class="cc-parse-error"><span>Generation failed: '+e(err.message||'unknown error')+'. <button onclick="ccDDGenerateForMetric(\''+e(ejs(metricName))+'\',\''+e(ejs(stageLabel))+'\')" style="display:inline;background:none;border:none;padding:0;font-size:inherit;color:inherit;text-decoration:underline;cursor:pointer;font-family:inherit;">Try again?</button></span></div>';
  }
}

// ── DD Panel: generate for single KPI only — thin wrapper (safe path) ──
// Kept for backward compat with retry buttons; routes through ccDDGenerateForMetricSafe.
async function ccDDGenerateForMetric(metricName,stageLabel){
  const metric=ccGetAllL1Metrics().find(function(m){return m.metricName===metricName&&m.stageLabel===stageLabel;});
  if(!metric)return;
  return ccDDGenerateForMetricSafe(metric.metricKey,metric.metricName,metric.stageLabel);
}

// ── DD Panel: generate for all metrics (stays on current tab — no switchTab) ──
async function ccDDGenerateAll(){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  if(aiGenInFlight.active){showToast("Still working on your last request. Hang tight, this won't take long.",'info');return;}
  const strip=document.getElementById('dd-gen-strip');
  if(strip)strip.innerHTML='<div class="cc-parse-loading"><div class="cc-spin-sm"></div> Generating dictionary for all metrics…</div>';
  try{
    if(!gData)throw new Error('No Discovery Map data. Generate your Discovery Map first.');
    const key=getKey();
    const productName=getProductCtx().name;
    // Build metric list from gData (all L1+L2+L3)
    const metricList=[];
    (gData.stages||[]).forEach(st=>{
      (st.l1_metrics||[]).forEach(l1=>{
        if(!l1||!l1.name)return;
        metricList.push({stage:st.label,level:'L1',name:l1.name});
        (l1.l2_metrics||[]).forEach(l2=>{
          if(!l2||!l2.name)return;
          metricList.push({stage:st.label,level:'L2',name:l2.name});
          (l2.l3_metrics||[]).forEach(l3=>{
            if(l3&&l3.name)metricList.push({stage:st.label,level:'L3',name:l3.name});
          });
        });
      });
    });
    const _signal=startAiGen(`This AI response is still being generated. Leaving now discards it, you'll need to start again.`);
    const txt=await callAPI(
      'You are a senior product metrics expert. Return ONLY a raw JSON array starting with [ and ending with ]. No wrapper object, no markdown, no backticks, no preamble. Never use em dashes (—) in your output; use a hyphen (-) or rewrite the phrase.',
      buildDDPrompt(metricList),
      8000,
      _signal,'claude-haiku-4-5',
      'cc-dd-batch'
    );
    const clean=txt.replace(/```json|```/g,'').trim();
    let metrics=null;
    try{const arr=JSON.parse(clean);if(Array.isArray(arr))metrics=arr;else if(arr&&arr.metrics)metrics=arr.metrics;}
    catch(pe){const m2=clean.match(/\[[\s\S]*/);if(m2){const last=m2[0].lastIndexOf('}');if(last>0)try{metrics=JSON.parse(m2[0].substring(0,last+1)+']');}catch(pe2){}}}
    if(!metrics||!metrics.length)throw new Error('Could not parse definitions.');
    // Store in window._ddRows (same as renderDDTable)
    const defMap={};metrics.forEach(m=>defMap[(m.name||'').toLowerCase().trim()]=m);
    window._ddRows=[];
    (gData.stages||[]).forEach(st=>{
      (st.l1_metrics||[]).forEach(l1=>{
        if(!l1||!l1.name)return;
        const d=defMap[l1.name.toLowerCase().trim()]||{};
        window._ddRows.push({name:l1.name,sl:st.label,lvl:'L1',def:d.definition||'—',bm:d.benchmark||'—',rf:d.red_flag||'—'});
      });
    });
    ddGenerated=true;
    // Re-render panel with populated data
    const m=ccGetAllL1Metrics().find(x=>x.metricKey===piDdPanelMetricKey);
    if(m){const metric=ccFindMetricInGData(piDdPanelMetricKey)||{name:m.metricName};
      const panel=document.getElementById('dd-panel');
      if(panel)panel.innerHTML=ccRenderDDPanel(metric,m.metricName,m.stageLabel);}
    endAiGen();
  }catch(err){
    if(err.name==='AbortError'){endAiGen();return;}
    endAiGen();
    if(strip)strip.innerHTML='<div class="cc-parse-error">Generation failed: '+e(err.message||'unknown')+'<br><button onclick="ccDDGenerateAll()" style="margin-top:8px;background:none;border:1px solid var(--divider);border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer;color:var(--t2);">&#8635; Try again</button></div>';
  }
}

// ── Toggle feature in the right panel ──
// ── Outcome Verification Loop (FC-4): read-only hypothesis chip for CC
// drawer feature rows. Deliberately NOT reusing scBuildOutcomeHypChipHTML()
// here — that function's empty-state click target opens Edit Feature via
// scShowEditFeatModal(f.id), which assumes the feature already exists on
// scCanvas. A capStore feature in this drawer may not have been sent to
// Feature Canvas yet, so that click target would silently fail here.
// This chip is purely informational in this context — no click action —
// distinct in color from the existing stage-colored breadcrumb pill
// (ccStageBg/ccStageText) already shown elsewhere on this screen, reusing
// the same purple hypothesis-chip treatment already established in
// Feature Canvas so the same KIND of information reads consistently
// across both screens.
function ccBuildFeatHypChipHTML(f){
  if(!f||!f.outcomeHypothesis||!f.outcomeHypothesis.primary)return'';
  const p=f.outcomeHypothesis.primary;
  if(!p.metric)return'';
  const arrow=p.direction==='decrease'?'↓':(p.direction==='increase'?'↑':'');
  const label=(p.metric||'')+(arrow?' '+arrow:'');
  const hasBT=p.baseline!==null&&p.baseline!==undefined&&p.target!==null&&p.target!==undefined;
  const tooltipText=(p.metric||'')+(hasBT?' | '+p.baseline+' \u2192 '+p.target:'');
  // v9.10.02: kept in sync with scBuildOutcomeHypChipHTML's outer/inner
  // split (Bug 1 fix).
  // v9.25.03: removed this instance's max-width:none override on both spans
  // — with white-space:nowrap still active on .sc-hyp-chip-inner, an
  // uncapped width let long metric labels overflow past the CC right
  // panel's edge. Now inherits the shared class's normal 140px+ellipsis
  // truncation, same as Story Canvas's own chip; the full text remains
  // available via the tooltip.
  return`<span class="sc-hyp-chip pgt-tooltip" data-tooltip="${e(tooltipText)}" style="margin-left:0;"><span class="sc-hyp-chip-inner">${e(label)}</span></span>`;
}

function ccToggleFeatPanel(capIdx,featIdx){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  // Resolve metric key — capActiveMetricKey is null in All Caps view, use ccPanelCapKey instead
  let resolvedMetricKey=capActiveMetricKey;
  if(!resolvedMetricKey&&ccPanelCapKey){
    const parts=ccPanelCapKey.split('|');
    resolvedMetricKey=parts.slice(0,-1).join('|');
  }
  if(!resolvedMetricKey||!capStore[resolvedMetricKey])return;
  const entry=capStore[resolvedMetricKey];
  const cap=entry.capabilities[capIdx];
  if(!cap||!cap.featStore||!cap.featStore.top)return;
  const f=cap.featStore.top[featIdx];
  // Check if feature is in SC — warn before deselecting
  const fid=typeof scMakeFeatureId==='function'?scMakeFeatureId(f.metric,f.cap+(f.subCap?'/'+f.subCap:''),f.name):'';
  const isInSC=fid&&scCanvas&&scCanvas.find(x=>x.id===fid);
  if(isInSC){
    // Show in-app warning strip instead of browser confirm
    const rp=document.getElementById('cc-feat-panel');
    if(rp){
      const existing=rp.querySelector('.cc-warn-strip');
      if(existing)existing.remove();
      const strip=document.createElement('div');
      strip.className='cc-warn-strip';
      strip.innerHTML=`<div style="font-weight:600;font-size:11px;margin-bottom:4px;">Remove from Feature Canvas?</div>
        <div style="font-size:10px;color:var(--amber-deep);margin-bottom:8px;">"${e(f.name)}" is on your Feature Canvas. Removing it here will also remove it from Feature Canvas.</div>
        <div style="display:flex;gap:6px;">
          <button style="flex:1;font-size:11px;padding:5px;background:var(--amber);color:#fff;border:none;border-radius:5px;cursor:pointer;font-family:var(--font);" onclick="ccConfirmRemoveFromSC('${e(fid)}',${capIdx},${featIdx})">Yes, remove</button>
          <button style="flex:1;font-size:11px;padding:5px;background:var(--card);color:var(--t2);border:1px solid var(--divider);border-radius:5px;cursor:pointer;font-family:var(--font);" onclick="this.closest('.cc-warn-strip').remove()">Cancel</button>
        </div>`;
      // Insert before chat bar (above refine + footer)
      const chatBar=rp.querySelector('.cc-chat-bar');
      const anchor=chatBar||rp.querySelector('.cc-panel-footer-split');
      if(anchor)rp.insertBefore(strip,anchor);else rp.appendChild(strip);
    }
    return;
  }
  f.selected=!f.selected;
  // Update panel in-place only — no full grid re-render needed when toggling a feature
  const rp=document.getElementById('cc-feat-panel');
  if(rp){
    const _scrollEl=rp.querySelector('.cc-feat-panel-scroll');
    const _scrollTop=_scrollEl?_scrollEl.scrollTop:0;
    rp.innerHTML=ccBuildFeatPanel(entry,cap,capIdx,resolvedMetricKey);
    const _scrollElAfter=rp.querySelector('.cc-feat-panel-scroll');
    if(_scrollElAfter)_scrollElAfter.scrollTop=_scrollTop;
  }
  // Update card checkbox to reflect new aggregate feature selection state
  ccUpdateCardChk(resolvedMetricKey,capIdx);
  // Update action bar to reflect new selection count
  ccUpdateActionBar();
}

// ── Edit feature name inline (Path A + B) ──
function ccEditFeatName(capIdx,featIdx){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const nameEl=document.getElementById('cc-feat-name-'+capIdx+'-'+featIdx);
  if(!nameEl)return;
  const current=nameEl.textContent;
  nameEl.outerHTML=`<input class="cc-feat-name-input" id="cc-feat-name-inp-${capIdx}-${featIdx}"
    value="${e(current)}"
    onclick="event.stopPropagation()"
    onmousedown="event.stopPropagation()"
    onblur="ccSaveFeatName(${capIdx},${featIdx},this.value)"
    onkeydown="if(event.key==='Enter')this.blur();if(event.key==='Escape'){this.value='${e(current)}';this.blur();}"
    style="width:100%;" />`;
  const inp=document.getElementById('cc-feat-name-inp-'+capIdx+'-'+featIdx);
  if(inp){inp.focus();inp.select();inp.addEventListener('mousedown',function(e){e.stopPropagation();});}
}

function ccEditFeatWhy(capIdx,featIdx){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const whyEl=document.getElementById('cc-feat-why-'+capIdx+'-'+featIdx);
  if(!whyEl)return;
  const current=whyEl.textContent;
  whyEl.outerHTML=`<textarea class="cc-feat-name-input" id="cc-feat-why-inp-${capIdx}-${featIdx}"
    onclick="event.stopPropagation()"
    onmousedown="event.stopPropagation()"
    onblur="ccSaveFeatWhy(${capIdx},${featIdx},this.value)"
    onkeydown="if(event.key==='Escape'){this.value='${e(current)}';this.blur();}"
    style="width:100%;height:48px;resize:none;">${e(current)}</textarea>`;
  const inp=document.getElementById('cc-feat-why-inp-'+capIdx+'-'+featIdx);
  if(inp){inp.focus();inp.select();inp.addEventListener('mousedown',function(e){e.stopPropagation();});}
}

// ── Confirm removal of feature from SC ──
function ccConfirmRemoveFromSC(fid,capIdx,featIdx){
  // Resolve metricKey — capActiveMetricKey is null in All Caps view
  let _rmk=capActiveMetricKey;
  if(!_rmk&&ccPanelCapKey){const _p=ccPanelCapKey.split('|');_rmk=_p.slice(0,-1).join('|');}
  if(!_rmk||!capStore[_rmk])return;
  const entry=capStore[_rmk];
  const cap=entry.capabilities[capIdx];
  if(!cap||!cap.featStore||!cap.featStore.top)return;
  const f=cap.featStore.top[featIdx];
  // Remove from scCanvas
  const idx=scCanvas.findIndex(x=>x.id===fid);
  if(idx>-1)scCanvas.splice(idx,1);
  fcUpdateTabBadge&&fcUpdateTabBadge();
  // Deselect the feature
  f.selected=false;
  // Re-render right panel
  const rp=document.getElementById('cc-feat-panel');
  if(rp){rp.innerHTML=ccBuildFeatPanel(entry,cap,capIdx,_rmk);}
  if(capActiveMetricKey===null) ccRenderAllCaps(); else ccRenderMainContent();
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    // Coarse target — the whole scCanvas entry for this feature is gone.
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('sc',fid+_LS_SC_TARGET_SEP); });
  }
}

function ccSaveFeatName(capIdx,featIdx,newName){
  // Resolve metricKey — capActiveMetricKey is null in All Caps view
  let _rmk=capActiveMetricKey;
  if(!_rmk&&ccPanelCapKey){const _p=ccPanelCapKey.split('|');_rmk=_p.slice(0,-1).join('|');}
  if(!_rmk||!capStore[_rmk])return;
  const entry=capStore[_rmk];
  const cap=entry.capabilities[capIdx];
  if(!cap||!cap.featStore||!cap.featStore.top)return;
  const feat=cap.featStore.top[featIdx];
  const oldName=feat.name;
  const trimmed=newName.trim()||oldName;
  feat.name=trimmed;
  // Sync to matching scCanvas entry
  if(scCanvas&&trimmed!==oldName){
    const scFeat=scCanvas.find(x=>x.name===oldName&&x.cap===cap.name);
    if(scFeat)scFeat.name=trimmed;
  }
  const rp=document.getElementById('cc-feat-panel');
  if(rp){rp.innerHTML=ccBuildFeatPanel(entry,cap,capIdx,_rmk);}
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('cc',_rmk+_LS_CC_TARGET_SEP+cap.name); });
  }
}

function ccSaveFeatWhy(capIdx,featIdx,newWhy){
  // Resolve metricKey — capActiveMetricKey is null in All Caps view
  let _rmk=capActiveMetricKey;
  if(!_rmk&&ccPanelCapKey){const _p=ccPanelCapKey.split('|');_rmk=_p.slice(0,-1).join('|');}
  if(!_rmk||!capStore[_rmk])return;
  const entry=capStore[_rmk];
  const cap=entry.capabilities[capIdx];
  if(!cap||!cap.featStore||!cap.featStore.top)return;
  const feat=cap.featStore.top[featIdx];
  feat.why=newWhy.trim();
  // Sync to matching scCanvas entry
  if(scCanvas){
    const scFeat=scCanvas.find(x=>x.name===feat.name&&x.cap===cap.name);
    if(scFeat)scFeat.why=feat.why;
  }
  const rp=document.getElementById('cc-feat-panel');
  if(rp){rp.innerHTML=ccBuildFeatPanel(entry,cap,capIdx,_rmk);}
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('cc',_rmk+_LS_CC_TARGET_SEP+cap.name); });
  }
}

// ── Generate/refine features for specific cap in right panel ──
// Phase 5: public, safe entry point. Direct callers (button clicks) call
// this with no 4th argument — it acquires its own lock via
// withGenerationLock(). Batch callers (ccGenerateFeaturesForMetric,
// ccGenerateFeaturesForSelected) that already hold ONE lock around their
// whole loop pass { lockHandle } so this function joins the EXISTING lock
// instead of acquiring a new one per capability — acquiring per-capability
// inside a multi-minute batch would release the lock between every
// capability, reopening exactly the collision window the lock exists to
// close. See api.js's _assertGenerationLockHandle for why the inner
// function below requires a BRANDED handle, not just any object shaped
// like one — vanilla JS has no enforced module privacy, so a leading
// underscore alone isn't a reliable guard against a future caller
// accidentally bypassing the lock.
async function ccGenerateFeaturesForCap(metricKey,capIdx,refinement,modelOverride=null,ctx=null){
  // Phase 5 fix (v8.118): immediate visual acknowledgment for a DIRECT
  // click (ctx.triggerEl), before the lock check even runs — same pattern
  // as ccGenerateOne()'s fix. Skipped entirely for batch-invoked calls
  // (ctx.lockHandle present instead), since those already have their own
  // batch-level disable at their own caller's top, and this function's own
  // disable would be redundant/momentary for each individual iteration.
  if(ctx&&ctx.triggerEl&&typeof ctx.triggerEl==='object'&&ctx.triggerEl.disabled!==undefined){
    ctx.triggerEl.disabled=true;
  }
  if (ctx && ctx.lockHandle) {
    return await _ccGenerateFeaturesForCapInner_REQUIRES_LOCK_HANDLE(metricKey,capIdx,refinement,modelOverride,ctx.lockHandle,ctx.docToastRef);
  }
  try {
    return await withGenerationLock(async (lockHandle) => {
      return await _ccGenerateFeaturesForCapInner_REQUIRES_LOCK_HANDLE(metricKey,capIdx,refinement,modelOverride,lockHandle,ctx&&ctx.docToastRef);
    });
  } catch(err) {
    // Phase 5 fix (v8.118): re-enable on any rejection/error path — the
    // inner function's own error rendering (see below) typically replaces
    // the DOM the trigger lived in anyway, but this is cheap, harmless
    // insurance for any path that doesn't, same reasoning as ccGenerateOne().
    if(ctx&&ctx.triggerEl&&typeof ctx.triggerEl==='object'&&ctx.triggerEl.disabled!==undefined){
      ctx.triggerEl.disabled=false;
    }
    throw err;
  }
}

// v8.133 fix (item 5): confirmed live — ccGenerateFeaturesForCap()
// deliberately rethrows after its own cleanup (by design, so a caller
// COULD react), but none of its 3 direct onclick callers ever did,
// producing an unhandled promise rejection on every lock conflict. The
// toast and button re-enable already happen inside the function itself
// before the rethrow — this wrapper only exists to give the rejection
// somewhere to land instead of surfacing as a console error. Every direct
// onclick caller should use this wrapper, not the function directly.
function ccGenerateFeaturesForCapClick(metricKey,capIdx,refinement,modelOverride,ctx){
  // v9.25 code-review fix — canEditSession() now checked BEFORE stopping
  // voice (was after): a read-only collaborator's click here is a no-op
  // regardless, so it shouldn't also silently kill their dictation with no
  // explanation. Matches kpi-tree.js's regen(), which already had this
  // ordering right.
  if(typeof canEditSession==='function'&&!canEditSession())return Promise.resolve();
  // stop-on-send: refinement (above) is already read synchronously from
  // #cc-feat-refine-txt's live value in the onclick attribute, before this
  // function runs, so stopping here doesn't affect what was captured. No
  // "next message" for continued dictation to feed once this fires.
  voiceStopActive('abort');
  return ccGenerateFeaturesForCap(metricKey,capIdx,refinement,modelOverride,ctx).catch(function(err){
    console.warn('[cc] generate features click handler error:', err);
  });
}

// Phase 5: NEVER call this directly. It does the real work but performs NO
// lock acquisition of its own — it trusts the lockHandle it's given.
// Asserts the handle is a genuine, branded one from withGenerationLock()
// and throws immediately if not, turning an accidental unlocked call into
// a loud error instead of a silent same-tab race. Always go through
// ccGenerateFeaturesForCap() above.
async function _ccGenerateFeaturesForCapInner_REQUIRES_LOCK_HANDLE(metricKey,capIdx,refinement,modelOverride,lockHandle,docToastRef){
  _assertGenerationLockHandle(lockHandle,'_ccGenerateFeaturesForCapInner_REQUIRES_LOCK_HANDLE');
  const _wasAllCaps=(capActiveMetricKey===null);
  capActiveMetricKey=metricKey;
  capActiveCapIdx=capIdx;
  capActiveSubCapIdx=null;
  const entry=capStore[metricKey];
  if(!entry)return;
  const cap=entry.capabilities[capIdx];
  if(!cap)return;
  const key=getKey();
  if(aiGenInFlight.active){showToast("Still working on your last request. Hang tight, this won't take long.",'info');return;}
  const featKey='top';
  const isPIFirst=!!(entry._piFirst);
  const _ctxFC2=getFullProductCtx();
  var _fcDocRes2=(typeof buildDocContext==='function')?buildDocContext('fc',cap.name):{text:'',truncated:false};
  _ctxFC2.docContext=_fcDocRes2.text;
  if(_fcDocRes2.truncated){
    // Batch callers (ccGenerateFeaturesForMetric/ccGenerateFeaturesForSelected)
    // pass a shared docToastRef so this per-capability truncation just
    // accumulates into one flag instead of re-firing the toast on every
    // iteration; they fire it once, after their loop, themselves.
    if(docToastRef)docToastRef.truncated=true;
    else _fireDocTruncatedToast(true);
  }
  const nsm=gData?gData.nsm.metric:(typeof piInputs!=='undefined'&&piInputs.piGoal?piInputs.piGoal:'');
  // Phase 5 (v8.117): this inner function only ever runs AFTER a lock is
  // already confirmed held (either its own caller's withGenerationLock,
  // or a batch's already-acquired lock passed via ctx.lockHandle) — so
  // unlike ccGenerateOne/ccGenerateAll/ccGenerateFeatures, there's no
  // "loader before lock" timing problem to fix here. The marker-staleness
  // problem (user navigates to a different capability, or a batch's later
  // iteration supersedes an earlier one — not really possible within ONE
  // batch since each iteration targets a different capability, but a
  // DIRECT call on capability X racing a BATCH iteration also touching
  // capability X is a real, if narrow, case) still applies regardless.
  const _attempt=newGenAttempt();
  // Show loader in right panel feat area, marker-stamped.
  const rp=document.getElementById('cc-feat-panel');
  if(rp){
    const scroll=rp.querySelector('.cc-feat-panel-scroll');
    if(scroll){scroll.innerHTML=markGenAttempt(_attempt,`<div class="cc-feat-panel-empty" style="flex:1;">
      <div class="cc-spin" style="width:28px;height:28px;border-width:2px;margin-bottom:8px;"></div>
      <div style="font-size:11px;color:var(--t3);">Generating Features…</div>
    </div>`);}
  }
  try{
    const _signal=startAiGen(`Features for "${cap.name}" are being generated. Leaving now discards them, you'll need to regenerate from scratch.`);
    ccSetGenAllBtnDisabled(true);
    // §6.5 — same intakeBriefId branch as the single-capability generation
    // path above: ground in the RA brief when present, unchanged otherwise.
    const _capFeatPrompt2=cap.intakeBriefId
      ?buildRAFeatureGenPrompt(_ctxFC2,nsm,entry.stageLabel,entry.metricName,cap.name,cap.intakeBriefId,refinement)
      :buildCapFeaturesPrompt(_ctxFC2,nsm,entry.stageLabel,entry.metricName,cap.name,null,refinement);
    const txt=await callAPI(
      'You are a senior product strategist. Specific, actionable, product-native. Respond ONLY with valid JSON. No markdown, no backticks, no preamble. Never use em dashes (—) in your output; use a hyphen (-) or rewrite the phrase.',
      _capFeatPrompt2,
      2000,
      _signal,
      modelOverride,
      'cc-gen-features-cap'
    );
    const clean=txt.replace(/```json|```/g,'').trim();
    let parsed;
    try{parsed=JSON.parse(clean);}catch(pe){const s=clean.indexOf('{');const l=clean.lastIndexOf('}');if(s>=0&&l>s){try{parsed=JSON.parse(clean.substring(s,l+1));}catch(pe2){throw new Error('Could not parse features.');}}}
    if(!parsed||!parsed.features)throw new Error('No features returned.');
    if(!cap.featStore)cap.featStore={};
    // QA issue #4 — same RA-provenance carry-through as the single-capability
    // generation path above (ccGenerateFeaturesForCapClick).
    // Adoption Readiness (v9.21, §4.1) — same carry-forward check as the
    // single-capability generation path above; applies unconditionally.
    const newFeats=parsed.features.map(f=>{
      let _hyp=(typeof normalizeAIHypothesis==='function')?normalizeAIHypothesis(f.hypothesis):null;
      if(_hyp&&typeof rcApplyHypothesisCarryForward==='function')_hyp=rcApplyHypothesisCarryForward(f.name,_hyp);
      return{name:f.name,why:f.why,selected:false,metric:entry.metricName,stage:entry.stageLabel,cap:cap.name,subCap:null,
      outcomeHypothesis:_hyp,
      intakeBriefId:cap.intakeBriefId||null,rqNumber:cap.rqNumber||null};
    });
    if(isPIFirst&&cap.featStore[featKey]&&cap.featStore[featKey].length>0){
      // Path B: ADD to existing features, don't replace
      cap.featStore[featKey]=[...cap.featStore[featKey],...newFeats];
    } else {
      // Path A: replace with new features but preserve existing selections
      // AND, per Outcome Verification Loop: preserve an existing
      // hypothesis if the PM already edited it (source==='ai-edited') —
      // a fresh regeneration must not silently discard a manual edit just
      // because the feature happened to be regenerated. An AI-sourced
      // (never-edited) hypothesis IS safe to overwrite with fresh AI
      // output, since nothing manual would be lost.
      const prevFeats=cap.featStore[featKey]||[];
      cap.featStore[featKey]=newFeats.map(f=>{
        const prev=prevFeats.find(p=>p.name===f.name);
        if(!prev)return f;
        const _keepHyp=(prev.outcomeHypothesis&&prev.outcomeHypothesis.primary&&prev.outcomeHypothesis.primary.source==='ai-edited')
          ?prev.outcomeHypothesis:f.outcomeHypothesis;
        return{...f,selected:prev.selected,outcomeHypothesis:_keepHyp};
      });
    }
    // Phase 5 (v8.117): panel re-render is marker-guarded — if a different
    // capability's panel is now showing (user navigated away, or the
    // narrow direct-call-races-batch-iteration case above), don't yank
    // the view back to this capability just because its generation
    // happened to finish.
    if(getIfCurrentAttempt('cc-feat-panel',_attempt)){
      if(rp){rp.innerHTML=ccBuildFeatPanel(entry,cap,capIdx,metricKey);}
      // Restore All Caps view if user was there before generation started.
      // v8.35 fix: call ccRenderAllCaps() BEFORE resetting capActiveMetricKey to null —
      // ccRenderAllCaps() reads capActiveMetricKey + ccPanelCapKey to rebuild the right
      // panel. Resetting first caused the right panel to vanish after generation.
      if(_wasAllCaps){ccRenderAllCaps();capActiveMetricKey=null;}else{ccRenderMainContent();}
    }
    ccSetGenAllBtnDisabled(false);
    // Phase 5: checkpoint immediately before the save.
    lockHandle.throwIfLost();
    if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
      // Phase 2 (v8.123, live sync): cap.name (not capIdx) travels with the
      // event — capIdx is a positional array index and unsafe to rely on
      // later if capabilities are added/removed before a viewer applies
      // this event (found during adversarial review of this feature).
      // This single instrumentation point covers ccGenerateFeaturesForMetric,
      // ccGenerateFeaturesForAllPI, and ccGenerateFeaturesForSelected too —
      // confirmed by reading each of their bodies, all three delegate to
      // this exact function per-capability, none has its own separate save.
      var _capNameForEvent=cap.name;
      // Phase 2 fix (v8.125): awaited, not .then()'d — same lock-release
      // race as ccGenerateOne/ccGenerateAll, closed the same way.
      const _ok=await sessionStoreSave(_activeSessionId);
      if(_ok&&typeof _activeSessionIsShared!=='undefined'&&_activeSessionIsShared&&typeof _lsEmitContentEvent==='function'){
        await _lsEmitContentEvent(_activeSessionId,'cc','features_generated',metricKey,_capNameForEvent);
      }
      // Item 2: this specific capability's features were just regenerated —
      // clear any pending manual-edit target for it. Does NOT touch the
      // metric's whole-list target, if one happens to also be dirty — a
      // feature-level regeneration doesn't supersede an unrelated pending
      // capability-list-level edit.
      if(typeof _lsClearManualEditAfterRegeneration==='function')_lsClearManualEditAfterRegeneration('cc',metricKey+_LS_CC_TARGET_SEP+_capNameForEvent);
    }
    endAiGen();
  }catch(err){
    if(err.name==='AbortError'){
      ccSetGenAllBtnDisabled(false);endAiGen();
      // Phase 5: rethrow rather than return — see pi-planning.js for the
      // full rationale (adversarial review Finding 1). This matters even
      // more here since a batch caller's loop needs to see this error to
      // stop iterating, not silently continue to the next capability.
      throw err;
    }
    // v8.35 fix: restore All Caps state on error path too — capActiveMetricKey was
    // set to metricKey at function start and must be cleared when _wasAllCaps is true.
    if(_wasAllCaps)capActiveMetricKey=null;
    ccSetGenAllBtnDisabled(false);
    endAiGen();
    var _errRp=getIfCurrentAttempt('cc-feat-panel',_attempt);
    if(_errRp){const scroll=_errRp.querySelector('.cc-feat-panel-scroll');if(scroll)scroll.innerHTML=`<div class="cc-feat-panel-empty" style="flex:1;"><div style="color:var(--red);font-size:12px;">${e(err.message)}</div><button class="cc-btn-ghost" style="font-size:11px;margin-top:8px;" onclick="ccGenerateFeaturesForCapClick('${e(metricKey)}',${capIdx},'',${modelOverride?`'${e(modelOverride)}'`:'null'},{triggerEl:this})">Try again</button></div>`;}
    throw err; // Phase 5: propagate so a batch caller's loop knows to stop, not just single-capability callers
  }
}

// ── Path A ↔ B view switching (capabilities retained in both) ──
async function ccGenerateFeaturesForAllPI(){
  const piKeys=Object.keys(capStore).filter(k=>k.startsWith('pi||'));
  const key=getKey();
  for(const mk of piKeys){
    await ccGenerateFeaturesForMetric(mk);
  }
}

// ── Toggle Path B context strip ──
function ccTogglePICtx(){
  const body=document.getElementById('cc-pi-ctx-body');
  const chevron=document.getElementById('cc-pi-ctx-chevron');
  if(!body)return;
  const isHidden=body.style.display==='none';
  body.style.display=isHidden?'':'none';
  if(chevron)chevron.style.transform=isHidden?'':'rotate(-90deg)';
}

// ── Toggle disabled state on the left-nav "Generate All Capabilities"/"Generate AI Features"
// footer button while any CC generation is in flight (it would otherwise stay clickable
// and only show a toast on click) ──
function ccSetGenAllBtnDisabled(disabled){
  const btn=document.getElementById('cc-gen-all-btn');
  if(btn)btn.disabled=disabled;
}

// ── Update CC tab badge ──
function ccUpdateTabBadge(){
  const badge=document.getElementById('cc-tab-badge');
  if(!badge)return;
  const total=Object.values(capStore).reduce((a,e)=>a+(e.capabilities?e.capabilities.length:0),0);
  badge.textContent=total;
  badge.classList.toggle('on',total>0);
}

// ── Select cap from All-Capabilities view — delegates to SC state machine ──
function ccAllCapsSelectCap(metricKey,capIdx){
  const entry=capStore[metricKey];
  if(!entry)return;
  const cap=entry.capabilities[capIdx];
  const hasFeat=cap&&cap.featStore&&cap.featStore.top&&cap.featStore.top.length>0;
  if(hasFeat){
    // Done card — open right panel, preserve All Caps view
    ccOpenCapPanel(metricKey,capIdx);
  } else {
    // No-feature card — toggle selection, preserve All Caps view
    ccToggleCapSelect(metricKey,capIdx);
  }
}

// ── CC helper: total caps and features across capStore ──
function ccGetTotalCaps(){
  return Object.values(capStore).reduce((a,e)=>a+(e.capabilities?e.capabilities.length:0),0);
}
// Capability keys currently visible in the main panel — scoped to capActiveMetricKey
// when a single metric is being viewed, otherwise the full capStore (mirrors FC's
// fcGetVisibleCanvas pattern; same fix applied here for the same selection-scoping bug).
function ccGetVisibleCapKeys(){
  // v9.06.02: uses the shared resolver so a bucket:<id> selection
  // correctly scopes to just that bucket's merged cards — the previous
  // direct capStore[capActiveMetricKey] check would always fail for a
  // bucket tag, silently falling through to reporting EVERY capability
  // in the entire app as "visible" while a bucket's detail view was open.
  const _group=typeof ccResolveCapGroup==='function'?ccResolveCapGroup(capActiveMetricKey):null;
  if(capActiveMetricKey&&_group){
    return _group.cards.map(c=>c.cardSelectionKey);
  }
  const keys=[];
  Object.keys(capStore).forEach(mk=>{
    const entry=capStore[mk];
    (entry.capabilities||[]).forEach((_,ci)=>keys.push(mk+'|'+ci));
  });
  return keys;
}
function ccGetVisibleCapCount(){
  return ccGetVisibleCapKeys().length;
}
function ccGetTotalFeats(){
  return Object.values(capStore).reduce((a,e)=>{
    return a+(e.capabilities||[]).reduce((b,cap)=>b+(cap.featStore&&cap.featStore.top?cap.featStore.top.length:0),0);
  },0);
}

// ── Feature selection aggregate state for a capability ──
// Returns: 'all' | 'partial' | 'none'
function ccGetFeatSelState(cap){
  const feats=cap&&cap.featStore&&cap.featStore.top;
  if(!feats||feats.length===0)return'none';
  const selCount=feats.filter(f=>{
    if(f.selected)return true;
    const fid=typeof scMakeFeatureId==='function'?scMakeFeatureId(f.metric,f.cap+(f.subCap?'/'+f.subCap:''),f.name):'';
    return fid&&scCanvas&&scCanvas.find(x=>x.id===fid);
  }).length;
  if(selCount===feats.length)return'all';
  if(selCount>0)return'partial';
  return'none';
}

// ── Update a cap card's checkbox to reflect feature selection aggregate state ──
function ccUpdateCardChk(metricKey,capIdx){
  const cardId='cc-cap-'+metricKey.replace(/[^a-z0-9|]/gi,'_')+'-'+capIdx;
  const card=document.getElementById(cardId);
  if(!card)return;
  const entry=capStore[metricKey];
  if(!entry)return;
  const cap=entry.capabilities[capIdx];
  const state=ccGetFeatSelState(cap);
  const chk=card.querySelector('.cc-card-chk');
  if(!chk)return;
  if(state==='all'){
    chk.classList.add('cc-card-chk-sel');
    chk.innerHTML='<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  } else if(state==='partial'){
    chk.classList.add('cc-card-chk-sel');
    chk.innerHTML='<div style="width:7px;height:2px;background:#fff;border-radius:1px;"></div>';
  } else {
    chk.classList.remove('cc-card-chk-sel');
    chk.innerHTML='';
  }
}

// ── CC cap selection (SC scToggleSelect pattern) ──
function ccToggleCapSelect(metricKey,capIdx){
  const capKey=metricKey+'|'+capIdx;
  const entry=capStore[metricKey];
  const cap=entry&&entry.capabilities[capIdx];
  const hasFeat=cap&&cap.featStore&&cap.featStore.top&&cap.featStore.top.length>0;

  if(hasFeat){
    // Done card: checkbox drives feature selection (like SC PI select)
    // Determine new state from current aggregate
    const currentState=ccGetFeatSelState(cap);
    const selectAll=currentState!=='all'; // if not all selected, select all; if all, deselect all
    cap.featStore.top.forEach(f=>{f.selected=selectAll;});
    // Update panel in-place if open for this cap
    if(ccPanelCapKey===capKey){
      const rp=document.getElementById('cc-feat-panel');
      if(rp){rp.innerHTML=ccBuildFeatPanel(entry,cap,capIdx,metricKey);}
    }
    // Update card checkbox to reflect new aggregate state
    ccUpdateCardChk(metricKey,capIdx);
    // Update Send to Feature Canvas button state in action bar
    ccUpdateActionBar();
    return;
  }

  // No features: original behaviour — toggle cap-for-generation selection
  if(ccSelectedCapIds.has(capKey)){ccSelectedCapIds.delete(capKey);}
  else{ccSelectedCapIds.add(capKey);}
  const isSel=ccSelectedCapIds.has(capKey);
  const card=document.getElementById('cc-cap-'+metricKey.replace(/[^a-z0-9|]/gi,'_')+'-'+capIdx);
  if(card){
    const isOpenPanel=ccPanelCapKey===capKey;
    card.classList.toggle('cc-cap-card-sel',isSel);
    card.classList.remove('cc-cap-card-done');
    if(!isOpenPanel)card.classList.remove('cc-cap-card-active');
    if(entry){
      if(hasFeat)card.classList.add('cc-cap-card-done');
      if(isOpenPanel)card.classList.add('cc-cap-card-active');
    }
    const chk=card.querySelector('.cc-card-chk');
    if(chk){
      chk.classList.toggle('cc-card-chk-sel',isSel);
      chk.innerHTML=isSel?'<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>':'';
    }
    const footer=card.querySelector('.cc-cap-card-footer');
    if(footer){
      if(isSel){
        footer.innerHTML=`<div class="cc-cap-status-none"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg> No features yet</div>`;
      } else {
        footer.innerHTML=`<div class="cc-cap-status-none"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg> No features yet</div>`;
      }
    }
  }
  ccUpdateActionBar();
}

// Kept as one shared function called from both card-grid render sites
// (All Caps view + single-metric view) so the two can never drift apart on
// this — they already shared identical markup before this change (verified
// via grep, both blocks byte-identical). No longer branches on Requirement
// Agent — RA no longer triggers from Capability Canvas at all (see
// kpi-tree.js's Discovery Map CTA), so this bar always shows the bulk-
// selection controls.
function _ccActionBarHtml(){
  return `<div class="cc-action-bar" id="cc-action-bar">
    <div class="sc-action-left">
      <label class="sc-select-all-toggle" id="cc-select-all-wrap">
        <input type="checkbox" id="cc-select-all-chk" onchange="ccToggleSelectAll(this)" title="Select / deselect all">
        <span id="cc-select-all-lbl">Select all</span>
      </label>
      <span class="sc-action-count" id="cc-action-info"></span>
    </div>
    <div style="display:flex;gap:8px;align-items:center;">
      <button class="cc-gen-sel-btn" id="cc-gen-sel-btn" onclick="ccGenerateFeaturesForSelected()" disabled><i class="ti ti-sparkles" style="font-size:11px;" aria-hidden="true"></i> Generate Features</button>
    </div>
  </div>`;
}

function ccToggleSelectAll(chk){
  if(chk.checked){
    // Select all visible caps (scoped to capActiveMetricKey filter, if set)
    ccGetVisibleCapKeys().forEach(k=>ccSelectedCapIds.add(k));
  } else {
    ccClearCapSelection();
    return;
  }
  if(capActiveMetricKey===null)ccRenderAllCaps();
  else ccRenderMainContent();
}

function ccUpdateActionBar(){
  const bar=document.getElementById('cc-action-bar');
  if(!bar)return;
  // v9.08: view-only sessions have nothing this action bar exists to
  // support (selecting capabilities to bulk-generate features) — hide the
  // whole bar rather than leaving a dead "Select all" checkbox with
  // nothing useful for it to trigger.
  const _canEditCc=(typeof canEditSession!=='function')||canEditSession();
  bar.style.display=_canEditCc?'':'none';
  if(!_canEditCc)return;
  const visibleKeys=new Set(ccGetVisibleCapKeys());
  const n=Array.from(ccSelectedCapIds).filter(k=>visibleKeys.has(k)).length;
  const total=visibleKeys.size;
  // Update Select All toggle
  const chk=document.getElementById('cc-select-all-chk');
  const lbl=document.getElementById('cc-select-all-lbl');
  if(chk){chk.checked=total>0&&n===total;chk.indeterminate=n>0&&n<total;}
  if(lbl)lbl.textContent=n===total&&total>0?'Deselect all':'Select all';
  // Update info count
  const info=document.getElementById('cc-action-info');
  if(info){
    const _ccThresholdActive=n>=4&&(typeof resolveThresholdModel==='function')&&resolveThresholdModel(n)!==null;
    info.innerHTML=n>0?`<strong>${n}</strong> of ${total} selected${_ccThresholdActive?' <span style="color:var(--blue);">· 4+ items use a faster, lower-quality AI model</span>':''}`:'';
  }
  // Update generate button
  const btn=document.getElementById('cc-gen-sel-btn');
  if(btn){
    btn.disabled=(n===0);
    btn.innerHTML=`<i class="ti ti-sparkles" style="font-size:11px;" aria-hidden="true"></i> ${n>0?'Generate for '+n+' Capabilit'+(n===1?'y':'ies'):'Generate Features'}`;
  }
}

// ── CC cap panel navigation (SC scPanelNav pattern) ──
// ── Returns a Set of lowercased+trimmed cap names from all capStore entries
// except the specified metric key — used for exact-match duplicate blocking ──
function _ccGetAllExistingCapNames(excludeMetricKey){
  const names=new Set();
  Object.keys(capStore).forEach(function(k){
    if(k===excludeMetricKey)return;
    (capStore[k].capabilities||[]).forEach(function(c){
      if(c.name)names.add(c.name.toLowerCase().trim());
    });
  });
  return names;
}

// ── Cap filter predicates — used by ccGetCapNavPool to match what the card grid shows ──
// _ccKpiCapPassesFilter: handles KPI, MI, and diag caps (full origin + features filter)
function _ccKpiCapPassesFilter(cap,entry,metricKey){
  if(!ccCapFilter.size)return true;
  const hasFeat=!!(cap.featStore&&cap.featStore.top&&cap.featStore.top.length>0);
  const _wantWith=ccCapFilter.has('with-features');
  const _wantWithout=ccCapFilter.has('without-features');
  if(_wantWith&&!_wantWithout&&!hasFeat)return false;
  if(_wantWithout&&!_wantWith&&hasFeat)return false;
  const _wOriginKpi=ccCapFilter.has('origin-kpi');
  const _wOriginDoc=ccCapFilter.has('origin-doc');
  const _wOriginCustom=ccCapFilter.has('origin-custom');
  const _wOriginMi=ccCapFilter.has('origin-mi');
  const _wOriginDiag=ccCapFilter.has('origin-diag');
  const _wOriginRa=ccCapFilter.has('origin-ra')||Array.from(ccCapFilter).some(function(t){return t.indexOf('origin-ra-rq:')===0;});
  const _hasOriginFilter=_wOriginKpi||_wOriginDoc||_wOriginCustom||_wOriginMi||_wOriginDiag||_wOriginRa;
  if(_hasOriginFilter){
    const _isDoc=!!(entry&&entry._docGrounded);
    const _isCustom=!!(cap._manual||(entry&&entry._piFirst));
    const _isMI=!!(metricKey&&metricKey.startsWith('mi||'));
    const _isDiag=!!(metricKey&&metricKey.startsWith('diag||'));
    const _isKpi=!_isDoc&&!_isCustom&&!_isMI&&!_isDiag;
    if(_wOriginDoc&&_isDoc)return true;
    if(_wOriginCustom&&_isCustom)return true;
    if(_wOriginMi&&_isMI)return true;
    if(_wOriginDiag&&_isDiag)return true;
    if(_wOriginKpi&&_isKpi)return true;
    if(_wOriginRa&&_ccCapMatchesOriginRa(cap))return true;
    return false;
  }
  return true;
}
// _ccPiCapPassesFilter: PI caps bypass the 5 pre-existing origin values —
// features filter always applies; the new "Requirement Agent" origin value
// (§8.2/§9) applies here too, since RA-created capabilities live in pi||
// capStore entries and render through this path, not _ccKpiCapPassesFilter.
function _ccPiCapPassesFilter(cap){
  const _wOriginRa=ccCapFilter.has('origin-ra')||Array.from(ccCapFilter).some(function(t){return t.indexOf('origin-ra-rq:')===0;});
  if(_wOriginRa&&!_ccCapMatchesOriginRa(cap))return false;
  if(!ccCapFilter.size)return true;
  const hasFeat=!!(cap.featStore&&cap.featStore.top&&cap.featStore.top.length>0);
  const _wWith=ccCapFilter.has('with-features');
  const _wWithout=ccCapFilter.has('without-features');
  if(_wWith&&_wWithout)return true;
  if(_wWith)return hasFeat;
  if(_wWithout)return !hasFeat;
  return true;
}

function ccGetCapNavPool(){
  // All caps filtered to match the current card grid, ordered stage→metric→capIdx.
  // Uses absolute capIdx throughout so ccOpenCapPanel() calls remain correct.
  const pool=[];
  ccGetAllL1Metrics().forEach(m=>{
    const entry=capStore[m.metricKey];
    if(!entry)return;
    const isPi=m.metricKey.startsWith('pi||');
    entry.capabilities.forEach((cap,ci)=>{
      const passes=isPi?_ccPiCapPassesFilter(cap):_ccKpiCapPassesFilter(cap,entry,m.metricKey);
      if(passes)pool.push({key:(entry.stageId||'')+'||'+(entry.metricName||'')+'|'+ci,metricKey:m.metricKey,capIdx:ci});
    });
  });
  // Include mi|| entries (Market Intelligence caps)
  Object.keys(capStore).filter(k=>k.startsWith('mi||')).forEach(k=>{
    const entry=capStore[k];
    if(!entry)return;
    entry.capabilities.forEach((cap,ci)=>{
      if(_ccKpiCapPassesFilter(cap,entry,k))
        pool.push({key:(entry.stageId||'')+'||'+(entry.metricName||'')+'|'+ci,metricKey:k,capIdx:ci});
    });
  });
  // Include diag|| entries (Product Diagnostics caps)
  Object.keys(capStore).filter(k=>k.startsWith('diag||')).forEach(k=>{
    const entry=capStore[k];
    if(!entry)return;
    entry.capabilities.forEach((cap,ci)=>{
      if(_ccKpiCapPassesFilter(cap,entry,k))
        pool.push({key:(entry.stageId||'')+'||'+(entry.metricName||'')+'|'+ci,metricKey:k,capIdx:ci});
    });
  });
  return pool;
}

function ccCapPanelNav(dir){
  if(!ccPanelCapKey)return;
  const parts=ccPanelCapKey.split('|');
  const ci=parseInt(parts[parts.length-1]);
  const mk=parts.slice(0,-1).join('|');
  const entry=capStore[mk];
  if(!entry)return;
  if(capActiveMetricKey===null){
    // All Caps view — navigate globally via pool (v8.54)
    const pool=ccGetCapNavPool();
    const navKey=(entry.stageId||'')+'||'+(entry.metricName||'')+'|'+ci;
    const idx=pool.findIndex(n=>n.key===navKey);
    const next=pool[idx+dir];
    if(next)ccOpenCapPanel(next.metricKey,next.capIdx);
  } else {
    // Metric view — navigate within filtered caps; use absolute capIdx for ccOpenCapPanel
    const caps=entry.capabilities||[];
    const filteredCaps=caps.filter(cap=>_ccKpiCapPassesFilter(cap,entry,mk));
    const currentCap=caps[ci];
    const filteredIdx=currentCap?filteredCaps.indexOf(currentCap):-1;
    const nextCap=filteredCaps[filteredIdx+dir];
    if(nextCap){
      const nextAbsIdx=caps.indexOf(nextCap);
      if(nextAbsIdx>=0)ccOpenCapPanel(mk,nextAbsIdx);
    }
  }
}

function ccClearCapSelection(){
  ccSelectedCapIds.clear();
  if(capActiveMetricKey===null) ccRenderAllCaps();
  else ccRenderMainContent();
}

// ── Open right panel for a done cap card (SC scOpenPanel pattern) ──
function ccOpenCapPanel(metricKey,capIdx){
  if(blockIfGenerating(()=>ccOpenCapPanel(metricKey,capIdx)))return;
  // Toggle-close: clicking the already-open capability closes the panel
  if(ccPanelCapKey===metricKey+'|'+capIdx){
    ccCloseFeatPanel();
    // Re-render with correct function — All Caps view vs bucket/metric view
    if(capActiveMetricKey===null) ccRenderAllCaps();
    else ccRenderMainContent();
    return;
  }
  ccPanelCapKey=metricKey+'|'+capIdx;
  // v9.06.02: do NOT overwrite capActiveMetricKey with the clicked card's
  // real key when it currently holds a bucket:<id> selection — the grid
  // view (showing ALL cards in that bucket) and the panel view (showing
  // ONE specific card's detail) are separate concerns now. Overwriting
  // would silently destroy the bucket context, making it impossible to
  // return to the bucket's grid view. ccPanelCapKey alone tracks which
  // card's panel is open; capActiveMetricKey keeps saying 'bucket:<id>'
  // throughout, exactly as the resolver/render logic above expects.
  const _curIsBucketSel=typeof capActiveMetricKey==='string'&&capActiveMetricKey.indexOf('bucket:')===0;
  if(capActiveMetricKey!==null&&!_curIsBucketSel)capActiveMetricKey=metricKey;
  // Update active card
  document.querySelectorAll('.cc-cap-card').forEach(c=>{
    c.classList.remove('cc-cap-card-active');
  });
  const card=document.getElementById('cc-cap-'+metricKey.replace(/[^a-z0-9|]/gi,'_')+'-'+capIdx);
  if(card)card.classList.add('cc-cap-card-active');
  // Render right panel in-place or rebuild
  const existing=document.getElementById('cc-feat-panel');
  const entry=capStore[metricKey];
  if(!entry)return;
  const cap=entry.capabilities[capIdx];
  const html=ccBuildFeatPanel(entry,cap,capIdx,metricKey);
  if(existing){
    existing.innerHTML=html;
  } else {
    const wrapper=document.querySelector('#cc-main-area .cc-cap-grid-wrap');
    if(wrapper&&wrapper.parentElement){
      const rp=document.createElement('div');
      rp.className='cc-feat-panel';rp.id='cc-feat-panel';
      rp.innerHTML=html;
      wrapper.parentElement.appendChild(rp);
    } else {
      ccRenderMainContent();
    }
  }
}

// ── Generate features for selected caps ──
async function ccGenerateFeaturesForSelected(){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  if(!ccSelectedCapIds.size)return;
  const key=getKey();
  // Phase 5 fix (v8.118): immediate visual acknowledgment on click, before
  // the lock check — same pattern as the other wrapped functions. Unlike
  // several of them, this trigger genuinely has a stable, unique ID
  // (cc-gen-sel-btn, confirmed via grep — used at two render call sites,
  // both identical), so no triggerEl-threading is needed here at all.
  const _selBtn=document.getElementById('cc-gen-sel-btn');
  if(_selBtn)_selBtn.disabled=true;
  // Defensive: only generate for capabilities that are BOTH selected AND
  // currently visible — closes the "hidden batch generation" risk where a
  // stale selection from a previous metric/filter view could otherwise feed
  // generation for capabilities the user can no longer see on screen.
  const visibleKeys=new Set(ccGetVisibleCapKeys());
  const toGenerate=Array.from(ccSelectedCapIds).filter(k=>visibleKeys.has(k));
  if(!toGenerate.length){
    if(_selBtn)_selBtn.disabled=(ccSelectedCapIds.size===0);
    return;
  }
  const totalCount=toGenerate.length;
  const batchModel=(typeof resolveThresholdModel==='function')?resolveThresholdModel(totalCount):null;
  // Capture the scope the user was actually in BEFORE the loop starts — the
  // loop itself reassigns capActiveMetricKey per-iteration (line below), so
  // by the time the loop ends it's left pointing at whichever capability was
  // processed LAST, not restored to wherever the user actually started.
  const _originalActiveMetricKey=capActiveMetricKey;
  ccSelectedCapIds.clear();
  ccUpdateActionBar();
  // Open/create right panel with initial loader before loop starts
  let rp=document.getElementById('cc-feat-panel');
  if(!rp){
    const wrapper=document.querySelector('#cc-main-area .cc-cap-grid-wrap');
    if(wrapper&&wrapper.parentElement){
      rp=document.createElement('div');
      rp.className='cc-feat-panel';rp.id='cc-feat-panel';
      wrapper.parentElement.appendChild(rp);
    }
  }
  let doneCount=0;
  const _docToastRef={truncated:false};
  const _attempt=newGenAttempt();
  // Phase 5: wraps the ENTIRE loop in ONE lock acquisition — same
  // reasoning as ccGenerateFeaturesForMetric above. Setup (selection
  // clear, panel creation) happens before the lock acquires; scope
  // restoration happens after, regardless of how the loop exited.
  try{
    await withGenerationLock(async (lockHandle) => {
  // Lock confirmed — stamp the panel with this batch's attempt marker now.
  if(rp){
    rp.innerHTML=markGenAttempt(_attempt,'<div class="cc-feat-panel-empty" style="flex:1;"><div style="text-align:center;padding:24px 16px;"><div class="cc-spin" style="width:28px;height:28px;border-width:2px;margin:0 auto 10px;"></div></div></div>');
  }
  for(const capKey of toGenerate){
    const parts=capKey.split('|');
    const ci=parseInt(parts[parts.length-1]);
    const mk=parts.slice(0,-1).join('|');
    if(capStore[mk]&&capStore[mk].capabilities[ci]){
      const capName=capStore[mk].capabilities[ci].name;
      // Phase 5 (v8.117): re-query the panel fresh each iteration and only
      // write if this batch's marker is still present — a captured `rp`
      // reference from before the loop started could be stale by the
      // time later iterations run (the user could have closed/replaced
      // the panel), and writing into a stale reference is exactly the
      // "invisible write, silently wrong" case a plain re-query alone
      // doesn't fully solve.
      var _liveRp=getIfCurrentAttempt('cc-feat-panel',_attempt);
      if(_liveRp){
        _liveRp.innerHTML=markGenAttempt(_attempt,`<div class="cc-feat-panel-hdr">
          <div class="cc-panel-tag">Generating features</div>
          <div class="cc-feat-panel-cap-name">${e(capName)}</div>
        </div>
        <div class="cc-feat-panel-scroll" style="display:flex;align-items:center;justify-content:center;flex:1;">
          <div style="text-align:center;padding:24px 16px;">
            <div class="cc-spin" style="width:28px;height:28px;border-width:2px;margin:0 auto 10px;"></div>
            <div style="font-size:11px;font-weight:600;color:var(--t1);margin-bottom:4px;">${e(capName)}</div>
            <div style="font-size:10px;color:var(--t3);">${doneCount+1} of ${totalCount} capabilities</div>
          </div>
        </div>`);
      }
      capActiveMetricKey=mk;
      ccPanelCapKey=mk+'|'+ci;
      await ccGenerateFeaturesForCap(mk,ci,'',batchModel,{lockHandle,docToastRef:_docToastRef});
      doneCount++;
    }
  }
    });
  }catch(lockErr){
    // Phase 5: pre-loop lock failure, or a rethrown AbortError/lock_lost
    // from inside the loop — ccGenerateFeaturesForCap's own inner catch
    // already reset its own UI state before rethrowing; this just stops
    // the loop from continuing, scope restoration below still runs.
  }
  _fireDocTruncatedToast(_docToastRef.truncated);
  // Restore the scope the user actually started from — fixes the bug where
  // capActiveMetricKey was left pointing at the last-processed capability
  // instead of returning to All Capabilities (null) or whichever single
  // metric the user was viewing before the batch ran.
  capActiveMetricKey=_originalActiveMetricKey;
  if(capActiveMetricKey===null)ccRenderAllCaps();else ccRenderMainContent();
  ccUpdateActionBar();
}


// ── Remove a capability from capStore ──
function ccRemoveCapability(metricKey,capIdx){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const entry=capStore[metricKey];
  if(!entry)return;
  const cap=entry.capabilities[capIdx];
  if(!cap)return;
  const capName=cap.name||'this capability';
  // Count features associated with this cap on scCanvas
  const featCount=scCanvas?scCanvas.filter(f=>f.cap===capName).length:0;
  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.id='cc-del-cap-overlay';
  const warningStrip=featCount>0
    ?`<div style="display:flex;align-items:flex-start;gap:8px;background:var(--amber-bg,#FAEEDA);border:0.5px solid var(--amber,#BA7517);border-radius:6px;padding:8px 10px;margin-bottom:16px;">
        <i class="ti ti-alert-triangle" style="font-size:14px;color:var(--amber,#BA7517);margin-top:1px;flex-shrink:0;" aria-hidden="true"></i>
        <div style="font-size:11px;color:var(--amber-dark,#633806);line-height:1.5;">This will also delete <strong>${featCount} associated feature${featCount!==1?'s':''}</strong> from the Feature Canvas. This cannot be undone.</div>
      </div>`
    :`<div style="font-size:12px;color:var(--t3);line-height:1.6;margin-bottom:16px;">This cannot be undone.</div>`;
  overlay.innerHTML=`<div class="modal" style="max-width:380px;;position:relative;">
    <button onclick="document.getElementById('cc-del-cap-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:16px 44px 14px 16px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:500;color:var(--t1);">Delete "${e(capName)}"?</div>
    </div>
    <div style="padding:14px 20px 4px;">
      ${warningStrip}
    </div>
    <div class="modal-footer">
      <button class="modal-cancel-btn" onclick="document.getElementById('cc-del-cap-overlay').remove()">Cancel</button>
      <button class="modal-confirm-btn danger" onclick="document.getElementById('cc-del-cap-overlay').remove();ccDoRemoveCapability('${e(metricKey)}',${capIdx})"><i class="ti ti-trash" style="font-size:12px;" aria-hidden="true"></i> Delete</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const _esc=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_esc,true);}};
  document.addEventListener('keydown',_esc,true);
  trapFocus(overlay);
}

function ccDoRemoveCapability(metricKey,capIdx){
  const entry=capStore[metricKey];
  if(!entry)return;
  const cap=entry.capabilities[capIdx];
  const capName=cap?cap.name:null;
  entry.capabilities.splice(capIdx,1);
  if(entry.capabilities.length===0)delete capStore[metricKey];
  // Cascade delete features from scCanvas
  if(capName&&scCanvas){
    const before=scCanvas.length;
    for(let i=scCanvas.length-1;i>=0;i--){
      if(scCanvas[i].cap===capName){
        scSelectedIds&&scSelectedIds.delete(scCanvas[i].id);
        scCanvas.splice(i,1);
      }
    }
    if(scCanvas.length!==before&&typeof fcUpdateTabBadge==='function')fcUpdateTabBadge();
  }
  if(capActiveMetricKey===metricKey&&(capActiveCapIdx===capIdx||capActiveCapIdx>=(capStore[metricKey]&&capStore[metricKey].capabilities?capStore[metricKey].capabilities.length:0))){
    capActiveCapIdx=null;
  }
  ccUpdateTabBadge();
  ccOpenMetricNav();
  // v8.142 fix (bundled with item 2): confirmed missing entirely — this
  // destructive delete (which also cascades to remove associated features)
  // was never persisted at all, same class of gap as item 7's functions,
  // but worse given the cascading data loss. Added here, plus mark-after-
  // success chaining for the whole-capability-list target.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('cc',metricKey+_LS_CC_TARGET_SEP); });
  }
}

// ── Close feature right panel ──
// User-facing close (X button) — guarded against in-flight generation.
function ccCloseFeatPanelUserAction(){
  if(guardAiGenNav(()=>{
    ccCloseFeatPanel();
    if(typeof capActiveMetricKey!=='undefined'&&capActiveMetricKey===null)ccRenderAllCaps();else ccRenderMainContent();
  }))return;
  ccCloseFeatPanel();
  if(typeof capActiveMetricKey!=='undefined'&&capActiveMetricKey===null)ccRenderAllCaps();else ccRenderMainContent();
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId)sessionStoreSave(_activeSessionId);
}

function ccCloseFeatPanel(){
  // v9.25 — rp.remove() below is a SEPARATE destruction mechanism from
  // ccBuildFeatPanel()'s own guard (that one covers rebuilds; this one
  // covers outright removal) — called from the explicit close button, the
  // toggle-close-same-capability path, and live-sync's panelShouldClose
  // branch. voiceStopActive() is a safe no-op if not active.
  voiceStopActive('abort');
  // Only null capActiveCapIdx when in metric-specific view (not All Caps)
  if(capActiveMetricKey!==null) capActiveCapIdx=null;
  ccPanelCapKey=null;
  const rp=document.getElementById('cc-feat-panel');
  if(rp)rp.remove();
  document.querySelectorAll('.cc-cap-card').forEach(c=>c.classList.remove('cc-cap-card-active'));
}

// ── Add Capability manually ──
function ccShowAddCapModal(){
  // Build metric options: generic "pi" first (unchanged, permanent), then
  // individual existing buckets, then all KPI metrics sorted A→Z.
  const allMetrics=ccGetAllL1Metrics().filter(m=>!m.metricKey.startsWith('pi||'));
  allMetrics.sort((a,b)=>a.metricName.toLowerCase().localeCompare(b.metricName.toLowerCase()));
  // v9.06.02: pre-selection now has 3 cases — a SPECIFIC bucket active
  // (pre-select that bucket, a UX improvement identified during the
  // capActiveMetricKey audit — "Add Capability" while viewing Compliance
  // Process should default to adding into Compliance Process), the
  // generic default (no selection, or a bucket that's since become
  // invalid), or a specific KPI metric.
  const _activeBucketId=typeof capActiveMetricKey==='string'&&capActiveMetricKey.indexOf('bucket:')===0
    ?capActiveMetricKey.slice('bucket:'.length):null;
  const _addDefaultPi=!capActiveMetricKey||(!_activeBucketId&&typeof capActiveMetricKey==='string'&&capActiveMetricKey.startsWith('pi||'));
  let metricOpts=`<option value="pi"${_addDefaultPi?' selected':''}>${(typeof gData!=='undefined'&&gData&&gData.approach==='capability-based')?'Custom Process Area':'Custom Metric'}</option>`;
  // v9.06.01: individual existing buckets, each separately selectable —
  // per product decision, generic option stays first and unchanged.
  if(typeof piBuildBucketDropdownOptions==='function'){
    metricOpts+=piBuildBucketDropdownOptions(gData,_activeBucketId?('bucket:'+_activeBucketId):null);
  }
  allMetrics.forEach(m=>{
    const sel=(!_addDefaultPi&&!_activeBucketId&&m.metricKey===capActiveMetricKey)?' selected':'';
    metricOpts+=`<option value="${e(m.metricKey)}"${sel}>${e(m.metricName)}</option>`;
  });
  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.id='cc-add-cap-overlay';
  overlay.innerHTML=`<div class="modal" style="max-width:400px;;position:relative;">
    <button onclick="document.getElementById('cc-add-cap-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:16px 44px 14px 16px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:500;color:var(--t1);">Add Capability</div>
    </div>
    <div class="modal-body" style="font-size:11px;color:var(--t3);line-height:1.5;">Manually define a capability. It will appear on the canvas alongside AI-generated ones.</div>
    <div style="display:flex;flex-direction:column;gap:10px;padding:0 20px 4px;">
      <div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Capability Name<span style="color:var(--red);margin-left:1px;">*</span></label>
        <input id="cc-add-cap-name" type="text" placeholder="e.g. A/B Test Framework"
          style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);background:var(--bg);"
          oninput="ccAddCapValidate()" />
        <div id="cc-add-cap-name-err" style="display:none;font-size:9px;color:var(--red);margin-top:2px;align-items:center;gap:3px;">
          <i class="ti ti-alert-circle" style="font-size:9px;" aria-hidden="true"></i> A capability with this name already exists.
        </div>
      </div>
      <div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Why It Matters <span style="font-size:9px;color:var(--label);">(Optional)</span></label>
        <textarea id="cc-add-cap-why" placeholder="Describe the problem this capability solves…"
          style="width:100%;height:60px;border:1px solid var(--divider);border-radius:5px;padding:6px 8px;font-size:11px;font-family:var(--font);color:var(--t1);background:var(--bg);resize:none;"></textarea>
      </div>
      <div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Metric / Process Area<span style="color:var(--red);margin-left:1px;">*</span></label>
        <div style="position:relative;">
          <select id="cc-add-cap-metric"
            style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);background:var(--bg);appearance:none;">
            ${metricOpts}
          </select>
          <i class="ti ti-chevron-down" style="position:absolute;right:8px;top:9px;font-size:10px;color:var(--label);pointer-events:none;" aria-hidden="true"></i>
        </div>
        <div style="font-size:9px;color:var(--label);margin-top:2px;">Determines which group this capability appears under on the canvas.</div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="modal-cancel-btn" onclick="document.getElementById('cc-add-cap-overlay').remove()">Cancel</button>
      <button class="modal-confirm-btn" id="cc-add-cap-submit" disabled onclick="ccDoAddCap()">Add Capability</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const _escHandler=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_escHandler,true);}};
  document.addEventListener('keydown',_escHandler,true);
  trapFocus(overlay);
}

function ccAddCapValidate(){
  const nameEl=document.getElementById('cc-add-cap-name');
  const errEl=document.getElementById('cc-add-cap-name-err');
  const submitEl=document.getElementById('cc-add-cap-submit');
  if(!nameEl||!errEl||!submitEl)return;
  const val=nameEl.value.trim();
  if(!val){
    nameEl.style.borderColor='var(--divider)';
    errEl.style.display='none';
    submitEl.disabled=true;
    return;
  }
  // Duplicate check — case insensitive across all capStore entries
  const lower=val.toLowerCase();
  const isDupe=Object.values(capStore).some(entry=>
    (entry.capabilities||[]).some(cap=>cap.name.toLowerCase()===lower)
  );
  if(isDupe){
    nameEl.style.borderColor='var(--red)';
    errEl.style.display='flex';
    submitEl.disabled=true;
  } else {
    nameEl.style.borderColor='var(--purple)';
    errEl.style.display='none';
    submitEl.disabled=false;
  }
}

function ccDoAddCap(){
  const nameEl=document.getElementById('cc-add-cap-name');
  const whyEl=document.getElementById('cc-add-cap-why');
  const metricEl=document.getElementById('cc-add-cap-metric');
  if(!nameEl||!metricEl)return;
  const name=nameEl.value.trim();
  const why=whyEl?whyEl.value.trim():'';
  const metricVal=metricEl.value;
  if(!name)return;
  // Block exact-match duplicate cap names (case-insensitive) across all metrics
  const _addExisting=_ccGetAllExistingCapNames('__none__');
  if(_addExisting.has(name.toLowerCase())){
    showToast('A capability with this name already exists.','warn');
    return;
  }
  const newCap={name,why,subCaps:null,features:[],_manual:true};
  const _parsedTarget=typeof parsePiDropdownValue==='function'?parsePiDropdownValue(metricVal):{type:metricVal==='pi'?'pi-default':'metric-key',metricKey:metricVal};
  // v9.06.02: hoisted so the post-add navigation block below can route to
  // the SPECIFIC bucket that was actually resolved/targeted, instead of
  // the old "just show all pi buckets" behavior.
  let _resolvedBucketIdForNav=null;
  if(_parsedTarget.type==='pi-default'||_parsedTarget.type==='pi-bucket'){
    // Add to Custom Value Stage — one cap per PI key, grouped into a bucket via bucketId
    const piKey=ccPIKey(name);
    // v9.06.01: explicit bucket targeting (dropdown value "bucket:<id>")
    // uses that bucketId DIRECTLY — no default-resolution triggered, per
    // the approved plan. Generic "pi" option still resolves via
    // getOrCreateCurrentDefaultPiBucket() exactly as before.
    const _bucketId=_parsedTarget.type==='pi-bucket'
      ?_parsedTarget.bucketId
      :(typeof getOrCreateCurrentDefaultPiBucket==='function'?getOrCreateCurrentDefaultPiBucket(gData,capStore):null);
    _resolvedBucketIdForNav=_bucketId;
    const _piStage=(typeof gData!=='undefined'&&gData&&Array.isArray(gData.stages))?gData.stages.find(s=>s&&s.id==='pi'):null;
    const _bucketEntry=(_piStage&&Array.isArray(_piStage.l1_metrics))?_piStage.l1_metrics.find(l1=>l1&&l1.bucketId===_bucketId):null;
    const _bucketDisplayName=_bucketEntry?_bucketEntry.name:'Custom Process Area';
    const _piStageLbl=typeof getPiStageLabel==='function'?getPiStageLabel(gData):'Custom Value Stage';
    if(!capStore[piKey]){
      capStore[piKey]={metricName:_bucketDisplayName,stageLabel:_piStageLbl,stageId:'pi',bucketId:_bucketId,_piFirst:true,capabilities:[]};
    } else {
      // v9.05 fix: ccPIKey()'s slugification can collide for genuinely
      // different names (e.g. "A/B Test" and "A-B Test" both slugify to
      // 'pi||ab_test') even though the earlier duplicate-name check treats
      // them as distinct — without this, the user's bucket selection for
      // THIS add would be silently discarded in favour of whatever bucket
      // the colliding earlier entry happened to have.
      capStore[piKey].bucketId=_bucketId;
      capStore[piKey].metricName=_bucketDisplayName;
      capStore[piKey].stageId='pi';
      capStore[piKey].stageLabel=_piStageLbl;
    }
    capStore[piKey].capabilities.push(newCap);
  } else {
    // Add to KPI metric group
    if(capStore[metricVal]){
      capStore[metricVal].capabilities.push(newCap);
    } else {
      // Metric exists in gData but hasn't been generated yet — create entry
      const metricInfo=ccGetAllL1Metrics().find(m=>m.metricKey===metricVal);
      if(metricInfo){
        capStore[metricVal]={
          metricName:metricInfo.metricName,
          stageLabel:metricInfo.stageLabel,
          stageId:metricInfo.stageId,
          capabilities:[newCap]
        };
      }
    }
  }
  // Close modal
  const overlay=document.getElementById('cc-add-cap-overlay');
  if(overlay)overlay.remove();
  // Update state and re-render
  ccUpdateTabBadge();
  capStoreInvalidated=false;
  // Navigate to the metric group where cap was added
  // Preserve All Caps view if user was there; otherwise navigate to new metric
  const _wasAllCaps=capActiveMetricKey===null;
  const _isPiTarget=(_parsedTarget.type==='pi-default'||_parsedTarget.type==='pi-bucket');
  if(!_wasAllCaps){
    if(_isPiTarget){
      ccMNSelectPIBucket(_resolvedBucketIdForNav);
    } else {
      capActiveMetricKey=metricVal;
      capActiveCapIdx=null;
      ccOpenMetricNav();
    }
  } else {
    ccOpenMetricNav();
  }
  // Auto-scroll to new cap card and open its feature panel
  const _mk=_isPiTarget?ccPIKey(name):metricVal;
  const _entry=capStore[_mk];
  if(_entry){
    const _ci=_entry.capabilities.findIndex(c=>c.name===name);
    if(_ci>=0){
      requestAnimationFrame(()=>{
        requestAnimationFrame(()=>{
          const _cardId='cc-cap-'+_mk.replace(/[^a-z0-9|]/gi,'_')+'-'+_ci;
          const _card=document.getElementById(_cardId);
          if(_card)_card.scrollIntoView({behavior:'smooth',block:'center'});
          ccOpenCapPanel(_mk,_ci);
        });
      });
    }
  }
  const groupLabel=_entry?_entry.metricName:(_isPiTarget?'Custom Process Area':metricVal);
  showToast(`"${name}" added to ${groupLabel}.`,'success');
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){
      if(!ok||typeof _lsMarkManualEdit!=='function')return;
      _lsMarkManualEdit('cc',_mk+_LS_CC_TARGET_SEP);
      // v9.05: keep the local user's own Discovery Map view consistent —
      // the receiving-collaborator side is handled separately in
      // live-sync.js's CC-apply path, not here.
      if(typeof syncPiStageFromCapStore==='function')syncPiStageFromCapStore(gData,capStore);
      if(typeof curTab!=='undefined'&&curTab==='mm'&&typeof renderMM==='function')renderMM(gData);
    });
  }
}

// ── Upload Capabilities from file (B3-B5, v7.83) ──
// Modal 1: file upload using the unified Capability/Description/Parent Capability template.
function ccShowUploadCapModal(){
  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.id='cc-upload-cap-overlay';
  overlay.innerHTML=`<div class="modal" style="max-width:420px;position:relative;">
    <button onclick="document.getElementById('cc-upload-cap-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:16px 44px 14px 16px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:500;color:var(--t1);">Upload Capabilities</div>
    </div>
    <div class="modal-body" style="font-size:11px;color:var(--t3);line-height:1.5;">Upload a file of capabilities to add. Each row maps to a Process Area - rows without a match go to Custom Process Area.</div>
    <div style="padding:0 20px 4px;">
      <div class="cc-upload-row" id="cc-cap-upload-row" onclick="document.getElementById('cc-cap-upload-input').click()">
        <i class="ti ti-upload" style="font-size:13px;color:var(--purple);flex-shrink:0;" aria-hidden="true"></i>
        <span class="cc-upload-row-label">Click to upload</span>
        <span class="cc-upload-row-types">.xlsx &middot; .csv</span>
        <a href="assets/templates/capability-list-template.xlsx" class="cc-template-link" onclick="event.stopPropagation()" style="margin-left:auto;"><i class="ti ti-download" style="font-size:11px;" aria-hidden="true"></i> Template</a>
      </div>
      <input type="file" id="cc-cap-upload-input" accept=".xlsx,.csv" style="display:none" onchange="ccHandleCapUpload(this)">
      <div id="cc-cap-upload-result"></div>
    </div>
    <div class="modal-footer">
      <button class="modal-cancel-btn" onclick="document.getElementById('cc-upload-cap-overlay').remove()">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const _escHandler=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_escHandler,true);}};
  document.addEventListener('keydown',_escHandler,true);
  trapFocus(overlay);
}

function ccHandleCapUpload(input){
  const file=input.files&&input.files[0];
  if(!file)return;
  const ext=file.name.split('.').pop().toLowerCase();
  const resultEl=document.getElementById('cc-cap-upload-result');
  if(resultEl)resultEl.innerHTML='<div class="cc-parse-loading"><div class="cc-spin-sm"></div> Reading file…</div>';
  if(ext==='csv'){
    const reader=new FileReader();
    reader.onload=ev=>_ccParseCapCSV(ev.target.result);
    reader.readAsText(file);
  } else if(ext==='xlsx'){
    const reader=new FileReader();
    reader.onload=ev=>{
      if(typeof XLSX==='undefined'){
        const s=document.createElement('script');
        s.src='https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
        s.onload=()=>_ccParseCapXLSX(ev.target.result);
        s.onerror=()=>_ccShowCapUploadError('Could not load XLSX library. Check internet connection.');
        document.head.appendChild(s);
      } else {
        _ccParseCapXLSX(ev.target.result);
      }
    };
    reader.readAsArrayBuffer(file);
  } else {
    _ccShowCapUploadError('Unsupported file type. Use .xlsx or .csv.');
  }
  input.value='';
}

function _ccParseCapXLSX(arrayBuffer){
  try{
    const wb=XLSX.read(arrayBuffer,{type:'array'});
    const ws=wb.Sheets[wb.SheetNames[0]];
    const data=XLSX.utils.sheet_to_json(ws,{defval:''});
    if(!data||data.length===0){_ccShowCapUploadError('File appears empty.');return;}
    const firstRow=data[0];
    const keys=Object.keys(firstRow).map(k=>k.toLowerCase().trim());
    const capKey=Object.keys(firstRow)[keys.indexOf('capability')]||Object.keys(firstRow)[keys.indexOf('capabilities')];
    const descKey=Object.keys(firstRow)[keys.indexOf('description')];
    const parentKeyIdx=keys.findIndex(k=>k.startsWith('parent capability')||k.startsWith('process area'));
    const parentKey=parentKeyIdx>=0?Object.keys(firstRow)[parentKeyIdx]:null;
    if(!capKey){_ccShowCapUploadError('Could not find a "Capability" column.');return;}
    const rows=[];
    data.forEach(row=>{
      const name=String(row[capKey]||'').trim();
      if(!name)return;
      rows.push({
        name,
        description:descKey?String(row[descKey]||'').trim():'',
        parentRaw:parentKey?String(row[parentKey]||'').trim():''
      });
    });
    _ccFinalizeCapUpload(rows);
  }catch(err){
    _ccShowCapUploadError('Could not read file: '+err.message);
  }
}

function _ccParseCapCSV(text){
  try{
    const lines=text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l.length>0);
    if(lines.length===0){_ccShowCapUploadError('File appears empty.');return;}
    const header=lines[0].split(',').map(h=>h.trim().toLowerCase());
    const capIdx=header.indexOf('capability')>=0?header.indexOf('capability'):header.indexOf('capabilities');
    const descIdx=header.indexOf('description');
    const parentIdx=header.findIndex(h=>h.startsWith('parent capability')||h.startsWith('process area'));
    if(capIdx<0){_ccShowCapUploadError('Could not find a "Capability" column.');return;}
    const rows=[];
    for(let i=1;i<lines.length;i++){
      const cols=lines[i].split(',').map(c=>c.trim());
      const name=cols[capIdx]||'';
      if(!name)continue;
      rows.push({
        name,
        description:descIdx>=0?(cols[descIdx]||''):'',
        parentRaw:parentIdx>=0?(cols[parentIdx]||''):''
      });
    }
    _ccFinalizeCapUpload(rows);
  }catch(err){
    _ccShowCapUploadError('Could not read file: '+err.message);
  }
}

function _ccShowCapUploadError(msg){
  const resultEl=document.getElementById('cc-cap-upload-result');
  if(resultEl)resultEl.innerHTML=`<div class="cc-parse-error"><i class="ti ti-alert-circle" style="font-size:11px;" aria-hidden="true"></i> ${e(msg)}</div>`;
}

// Modal 2: review/map table — pre-fills "Maps to" via fuzzy match against
// Parent Capability column (or Custom Capabilities if blank/unmatched).
let _ccUploadCapRows=[];

function _ccFinalizeCapUpload(rows){
  if(!rows||rows.length===0){_ccShowCapUploadError('No capabilities found. Check the format.');return;}
  const parents=ccGetAllL1Metrics().filter(m=>!m.metricKey.startsWith('pi||'));
  _ccUploadCapRows=rows.map(r=>{
    let mapTo='__custom__';
    if(r.parentRaw){
      const match=parents.find(p=>ccFuzzyMatch(p.metricName.toLowerCase(),r.parentRaw.toLowerCase()));
      if(match)mapTo=match.metricKey;
    }
    return{name:r.name,description:r.description,mapTo};
  });
  // Close upload modal, open review modal
  const uploadOverlay=document.getElementById('cc-upload-cap-overlay');
  if(uploadOverlay)uploadOverlay.remove();
  ccShowCapReviewModal();
}

function ccShowCapReviewModal(){
  const parents=ccGetAllL1Metrics().filter(m=>!m.metricKey.startsWith('pi||'));
  let parentOpts=`<option value="__custom__">Custom Process Area</option>`;
  // v9.06.01: individual existing buckets, each separately selectable —
  // generic "__custom__" option stays first and unchanged, per product
  // decision. Uses the same bucket: tagged value format as the single
  // Add Capability modal, for consistency.
  if(typeof piBuildBucketDropdownOptions==='function'){
    parentOpts+=piBuildBucketDropdownOptions(gData,null);
  }
  parents.forEach(p=>{parentOpts+=`<option value="${e(p.metricKey)}">${e(p.metricName)}</option>`;});

  const rowsHtml=_ccUploadCapRows.map((r,idx)=>{
    if(r.removed)return''; // removed rows are dropped from the table entirely (mirrors FC)
    let opts=`<option value="__custom__"${r.mapTo==='__custom__'?' selected':''}>Custom Process Area</option>`;
    if(typeof piBuildBucketDropdownOptions==='function'){
      opts+=piBuildBucketDropdownOptions(gData,r.mapTo);
    }
    parents.forEach(p=>{opts+=`<option value="${e(p.metricKey)}"${r.mapTo===p.metricKey?' selected':''}>${e(p.metricName)}</option>`;});
    const isCustom=(r.mapTo==='__custom__')||(typeof r.mapTo==='string'&&r.mapTo.indexOf('bucket:')===0);
    return `<div class="cc-cap-review-row${isCustom?' cc-cap-review-row-custom':''}">
      <div class="cc-cap-review-name">${e(r.name)}</div>
      <div class="cc-cap-review-desc">${e(r.description||'—')}</div>
      <div class="cc-cap-review-mapsto${isCustom?' cc-cap-review-mapsto-custom':''}">
        ${isCustom?'<i class="ti ti-clipboard-list" aria-hidden="true"></i>':''}
        <select onchange="_ccUploadCapRows[${idx}].mapTo=this.value;ccRefreshCapReviewSummary()">${opts}</select>
        <a class="cc-cap-review-remove" onclick="_ccUploadCapRows[${idx}].removed=true;ccRefreshCapReviewSummary()" title="Remove this row"><i class="ti ti-x" aria-hidden="true"></i></a>
      </div>
    </div>`;
  }).join('');

  const remaining=_ccUploadCapRows.filter(r=>!r.removed);

  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.id='cc-cap-review-overlay';
  overlay.innerHTML=`<div class="modal" style="max-width:620px;position:relative;">
    <button onclick="document.getElementById('cc-cap-review-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:16px 44px 14px 16px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:500;color:var(--t1);">Review capabilities before adding</div>
      <div style="font-size:11px;color:var(--t3);margin-top:4px;">${remaining.length} capabilit${remaining.length===1?'y':'ies'} found. Confirm where each one should appear.</div>
    </div>
    <div style="padding:12px 16px 0;max-height:50vh;overflow-y:auto;">
      <div class="cc-cap-review-row cc-cap-review-hdr">
        <div>Capability</div><div>Description</div><div>Maps to</div>
      </div>
      ${rowsHtml}
    </div>
    <div style="padding:0 16px;">
      <div id="cc-cap-review-summary" class="cc-parse-ok" style="margin:12px 0 0;">${ccCapReviewSummaryText()}</div>
    </div>
    <div class="modal-footer">
      <button class="modal-cancel-btn" onclick="document.getElementById('cc-cap-review-overlay').remove()">Cancel</button>
      <button class="modal-confirm-btn" onclick="ccConfirmCapUpload()">Add ${remaining.length} capabilit${remaining.length===1?'y':'ies'}</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const _escHandler=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_escHandler,true);}};
  document.addEventListener('keydown',_escHandler,true);
  trapFocus(overlay);
}

function ccCapReviewSummaryText(){
  const remaining=_ccUploadCapRows.filter(r=>!r.removed);
  // v9.06.01: count both generic "__custom__" AND bucket-specific rows as
  // "custom" for this summary — they're all headed to Custom Value Stage.
  const custom=remaining.filter(r=>r.mapTo==='__custom__'||(typeof r.mapTo==='string'&&r.mapTo.indexOf('bucket:')===0)).length;
  const mapped=remaining.length-custom;
  const parts=[];
  if(mapped>0)parts.push(`${mapped} mapped to existing process area${mapped===1?'':'s'}`);
  if(custom>0)parts.push(`${custom} will go to Custom Process Area`);
  return `<i class="ti ti-check" style="font-size:11px;" aria-hidden="true"></i> ${parts.join(' &middot; ')}`;
}

function ccRefreshCapReviewSummary(){
  // Re-render rows (mapTo selection may change the Custom Capabilities icon/grouping)
  const overlay=document.getElementById('cc-cap-review-overlay');
  const scrollEl=overlay?overlay.querySelector('.modal > div[style*="overflow-y:auto"]'):null;
  const scrollTop=scrollEl?scrollEl.scrollTop:0;
  if(overlay)overlay.remove();
  ccShowCapReviewModal();
  const newScrollEl=document.querySelector('#cc-cap-review-overlay .modal > div[style*="overflow-y:auto"]');
  if(newScrollEl)newScrollEl.scrollTop=scrollTop;
}

// Confirm: batched equivalent of ccDoAddCap() per row.
function ccConfirmCapUpload(){
  const remaining=_ccUploadCapRows.filter(r=>!r.removed);
  if(remaining.length===0){
    const overlay=document.getElementById('cc-cap-review-overlay');
    if(overlay)overlay.remove();
    _ccUploadCapRows=[];
    return;
  }
  const affectedKeys=new Set();
  // v9.05: resolve the default custom bucket ONCE for this whole upload batch —
  // all rows mapped to the GENERIC "__custom__" option in a single upload
  // session share the same bucket, rather than each row independently
  // re-resolving (which could create multiple buckets in one batch).
  // v9.06.01: rows mapped to a SPECIFIC existing bucket (value format
  // "bucket:<id>") resolve DIRECTLY to that bucketId, per-row — no shared
  // batch-level caching needed for those, since the bucketId is already
  // known from the dropdown selection itself.
  let _uploadBucketId=null;
  let _uploadBucketName='Custom Process Area';
  const _hasGenericCustomRows=remaining.some(r=>r.mapTo==='__custom__');
  if(_hasGenericCustomRows&&typeof getOrCreateCurrentDefaultPiBucket==='function'){
    _uploadBucketId=getOrCreateCurrentDefaultPiBucket(gData,capStore);
    const _piStage=(typeof gData!=='undefined'&&gData&&Array.isArray(gData.stages))?gData.stages.find(s=>s&&s.id==='pi'):null;
    const _bucketEntry=(_piStage&&Array.isArray(_piStage.l1_metrics))?_piStage.l1_metrics.find(l1=>l1&&l1.bucketId===_uploadBucketId):null;
    if(_bucketEntry)_uploadBucketName=_bucketEntry.name;
  }
  const _uploadPiStageLbl=typeof getPiStageLabel==='function'?getPiStageLabel(gData):'Custom Value Stage';
  remaining.forEach(r=>{
    const newCap={name:r.name,why:r.description||'',subCaps:null,features:[],_manual:true};
    const _rowTarget=typeof parsePiDropdownValue==='function'
      ?parsePiDropdownValue(r.mapTo==='__custom__'?'pi':r.mapTo)
      :{type:r.mapTo==='__custom__'?'pi-default':'metric-key',metricKey:r.mapTo};
    if(_rowTarget.type==='pi-default'||_rowTarget.type==='pi-bucket'){
      const piKey=ccPIKey(r.name);
      // Specific bucket rows use THEIR OWN bucketId directly; generic rows
      // share the one batch-level default resolved above.
      const _rowBucketId=_rowTarget.type==='pi-bucket'?_rowTarget.bucketId:_uploadBucketId;
      let _rowBucketName=_uploadBucketName;
      if(_rowTarget.type==='pi-bucket'){
        const _piStage2=(typeof gData!=='undefined'&&gData&&Array.isArray(gData.stages))?gData.stages.find(s=>s&&s.id==='pi'):null;
        const _bucketEntry2=(_piStage2&&Array.isArray(_piStage2.l1_metrics))?_piStage2.l1_metrics.find(l1=>l1&&l1.bucketId===_rowBucketId):null;
        _rowBucketName=_bucketEntry2?_bucketEntry2.name:'Custom Process Area';
      }
      if(!capStore[piKey]){
        capStore[piKey]={metricName:_rowBucketName,stageLabel:_uploadPiStageLbl,stageId:'pi',bucketId:_rowBucketId,_piFirst:true,capabilities:[]};
      } else {
        // v9.05 fix: same slugification-collision fix as ccDoAddCap() —
        // don't silently preserve a stale bucketId from a colliding name.
        capStore[piKey].bucketId=_rowBucketId;
        capStore[piKey].metricName=_rowBucketName;
        capStore[piKey].stageId='pi';
        capStore[piKey].stageLabel=_uploadPiStageLbl;
      }
      capStore[piKey].capabilities.push(newCap);
      affectedKeys.add(piKey);
    } else {
      if(capStore[r.mapTo]){
        capStore[r.mapTo].capabilities.push(newCap);
      } else {
        const metricInfo=ccGetAllL1Metrics().find(m=>m.metricKey===r.mapTo);
        if(metricInfo){
          capStore[r.mapTo]={
            metricName:metricInfo.metricName,
            stageLabel:metricInfo.stageLabel,
            stageId:metricInfo.stageId,
            capabilities:[newCap]
          };
        }
      }
      affectedKeys.add(r.mapTo);
    }
  });

  const total=remaining.length;
  // v9.06.01: count both generic and bucket-specific custom rows together
  const customCount=remaining.filter(r=>r.mapTo==='__custom__'||(typeof r.mapTo==='string'&&r.mapTo.indexOf('bucket:')===0)).length;
  const mappedCount=total-customCount;

  // Close modal
  const overlay=document.getElementById('cc-cap-review-overlay');
  if(overlay)overlay.remove();
  _ccUploadCapRows=[];

  ccUpdateTabBadge();
  capStoreInvalidated=false;
  ccOpenMetricNav();
  // v9.05: keep local Discovery Map view consistent with any new custom
  // bucket(s) just created via bulk upload — mirrors ccDoAddCap()'s same
  // sync call. NOTE: this function has no sessionStoreSave() call today
  // (pre-existing, unrelated to this feature) — flagging as out of scope.
  if(typeof syncPiStageFromCapStore==='function')syncPiStageFromCapStore(gData,capStore);
  if(typeof curTab!=='undefined'&&curTab==='mm'&&typeof renderMM==='function')renderMM(gData);

  let msg=`${total} capabilit${total===1?'y':'ies'} added`;
  const parts=[];
  if(mappedCount>0)parts.push(`${mappedCount} to existing parent${mappedCount===1?'':'s'}`);
  if(customCount>0)parts.push(`${customCount} to Custom Capabilities`);
  if(parts.length)msg+=' - '+parts.join(', ');
  showToast(msg,'success');
}


// ── Edit Capability modal ──
function ccShowEditCapModal(metricKey, capIdx){
  // v9.08: gated here covers both Capability Canvas and Market
  // Intelligence, since MI reuses this exact modal for its own capability
  // cards rather than having a separate one.
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const entry=capStore[metricKey];
  if(!entry)return;
  const cap=entry.capabilities[capIdx];
  if(!cap)return;

  const allMetrics=ccGetAllL1Metrics().filter(m=>!m.metricKey.startsWith('pi||'));
  allMetrics.sort((a,b)=>a.metricName.toLowerCase().localeCompare(b.metricName.toLowerCase()));
  // v9.06.01: pre-select the SPECIFIC bucket this capability currently
  // belongs to (if any), not just the generic "pi" fallback — so re-
  // opening Edit Capability on a capability already in "Compliance
  // Process" shows that bucket selected, not just "Custom Process Area".
  const _curBucketId=(entry&&entry.bucketId)?entry.bucketId:null;
  const _isPiEntry=metricKey.startsWith('pi||');
  let metricOpts=`<option value="pi"${(_isPiEntry&&!_curBucketId)?' selected':''}>${(typeof gData!=='undefined'&&gData&&gData.approach==='capability-based')?'Custom Process Area':'Custom Metric'}</option>`;
  if(typeof piBuildBucketDropdownOptions==='function'){
    metricOpts+=piBuildBucketDropdownOptions(gData,_curBucketId?('bucket:'+_curBucketId):null);
  }
  allMetrics.forEach(m=>{
    const sel=(m.metricKey===metricKey)?' selected':'';
    metricOpts+=`<option value="${e(m.metricKey)}"${sel}>${e(m.metricName)}</option>`;
  });

  const features=cap.featStore&&cap.featStore.top?cap.featStore.top:[];
  const featCount=features.length;
  const storyCount=features.reduce((a,f)=>a+(f.stories?f.stories.length:0),0);

  let warnHtml='';
  if(featCount>0){
    const withStories=features.filter(f=>f.stories&&f.stories.length>0).length;
    const warnCopy=withStories>0
      ?`This capability has ${featCount} feature${featCount!==1?'s':''}, ${withStories} with stories. Changing the description may make them inaccurate — features and their stories will need to be regenerated.`
      :`This capability has ${featCount} feature${featCount!==1?'s':''}. Changing the description may make them inaccurate — they will need to be regenerated.`;
    warnHtml=`<div id="cc-edit-warn-strip" style="display:none;">
      <div style="background:#FAEEDA;border:0.5px solid #FAC775;border-radius:5px;padding:8px 10px;margin-top:4px;display:flex;gap:6px;align-items:flex-start;">
        <i class="ti ti-alert-triangle" style="font-size:11px;color:#633806;flex-shrink:0;margin-top:1px;" aria-hidden="true"></i>
        <span style="font-size:11px;color:#633806;line-height:1.4;">${warnCopy}</span>
      </div>
      <div style="display:flex;gap:8px;margin-top:14px;margin-bottom:14px;">
        <button class="modal-cancel-btn" style="flex:1;font-size:11px;padding:5px 12px;" onclick="ccDoEditCap('${e(metricKey)}',${capIdx},'clear')">Clear Features</button>
        <button class="modal-confirm-btn" style="flex:1;font-size:11px;padding:5px 12px;" onclick="ccDoEditCap('${e(metricKey)}',${capIdx},'keep')">Keep Existing</button>
      </div>
    </div>`;
  }

  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.id='cc-edit-cap-overlay';
  overlay.innerHTML=`<div class="modal" style="max-width:400px;overflow-y:auto;max-height:80vh;position:relative;">
    <button onclick="document.getElementById('cc-edit-cap-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:16px 44px 14px 16px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:500;color:var(--t1);">Edit Capability</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;padding:14px 20px 4px;">
      <div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Capability Name<span style="color:var(--red);margin-left:1px;">*</span></label>
        <input id="cc-edit-cap-name" type="text" value="${e(cap.name)}"
          style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);background:var(--bg);"
          oninput="ccEditCapValidate('${e(cap.name)}')" />
        <div id="cc-edit-cap-name-err" style="display:none;font-size:9px;color:var(--red);margin-top:2px;align-items:center;gap:3px;">
          <i class="ti ti-alert-circle" style="font-size:9px;" aria-hidden="true"></i> A capability with this name already exists.
        </div>
      </div>
      <div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Why It Matters <span style="font-size:9px;color:var(--label);">(Optional)</span></label>
        <textarea id="cc-edit-cap-why"
          style="width:100%;height:60px;border:1px solid var(--divider);border-radius:5px;padding:6px 8px;font-size:11px;font-family:var(--font);color:var(--t1);background:var(--bg);resize:none;"
          oninput="(function(){var s=document.getElementById('cc-edit-warn-strip');if(s){s.style.display='';var f=document.getElementById('cc-edit-cap-footer');if(f)f.style.display='none';}})()">${e(cap.why||'')}</textarea>
      </div>
      <div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Metric / Process Area<span style="color:var(--red);margin-left:1px;">*</span></label>
        <div style="position:relative;">
          <select id="cc-edit-cap-metric"
            style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);background:var(--bg);appearance:none;">
            ${metricOpts}
          </select>
          <i class="ti ti-chevron-down" style="position:absolute;right:8px;top:9px;font-size:10px;color:var(--label);pointer-events:none;" aria-hidden="true"></i>
        </div>
        <div style="font-size:9px;color:var(--label);margin-top:2px;">Changing this moves the capability to the selected group.</div>
      </div>
      ${warnHtml}
    </div>
    <div class="modal-footer" id="cc-edit-cap-footer">
      <button class="modal-cancel-btn" onclick="document.getElementById('cc-edit-cap-overlay').remove()">Cancel</button>
      <button class="modal-confirm-btn" id="cc-edit-cap-submit" onclick="ccDoEditCap('${e(metricKey)}',${capIdx},'keep')">Save Changes</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const _esc=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_esc,true);}};
  document.addEventListener('keydown',_esc,true);
  trapFocus(overlay);
  // Pre-focus name input
  const nameEl=document.getElementById('cc-edit-cap-name');
  if(nameEl){nameEl.focus();nameEl.select();}
}

function ccEditCapValidate(originalName){
  const nameEl=document.getElementById('cc-edit-cap-name');
  const errEl=document.getElementById('cc-edit-cap-name-err');
  const submitEl=document.getElementById('cc-edit-cap-submit');
  if(!nameEl||!errEl)return;
  const val=nameEl.value.trim();
  if(!val){nameEl.style.borderColor='var(--divider)';errEl.style.display='none';if(submitEl)submitEl.disabled=true;return;}
  const lower=val.toLowerCase();
  const isDupe=val!==originalName&&Object.values(capStore).some(entry=>(entry.capabilities||[]).some(cap=>cap.name.toLowerCase()===lower));
  if(isDupe){
    nameEl.style.borderColor='var(--red)';errEl.style.display='flex';if(submitEl)submitEl.disabled=true;
  } else {
    nameEl.style.borderColor='var(--purple)';errEl.style.display='none';if(submitEl)submitEl.disabled=false;
  }
}

function ccDoEditCap(metricKey, capIdx, mode){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const entry=capStore[metricKey];
  if(!entry)return;
  const cap=entry.capabilities[capIdx];
  if(!cap)return;
  const nameEl=document.getElementById('cc-edit-cap-name');
  const whyEl=document.getElementById('cc-edit-cap-why');
  const metricEl=document.getElementById('cc-edit-cap-metric');
  if(!nameEl||!metricEl)return;
  const newName=nameEl.value.trim()||cap.name;
  const newWhy=whyEl?whyEl.value.trim():'';
  const newMetricVal=metricEl.value;
  const oldName=cap.name;

  // Save name + why
  cap.name=newName;
  cap.why=newWhy;

  // Sync name change to scCanvas features and cap.featStore
  if(newName!==oldName){
    if(scCanvas){scCanvas.forEach(f=>{if(f.cap===oldName)f.cap=newName;});}
    // Sync back to featStore entries (name used as display in CC right panel)
    if(cap.featStore&&cap.featStore.top){
      cap.featStore.top.forEach(f=>{
        // Update scCanvas name match
        if(scCanvas){const sc=scCanvas.find(x=>x.name===f.name&&x.cap===oldName);if(sc)sc.cap=newName;}
      });
    }
  }

  // Clear features if requested
  if(mode==='clear'){
    if(scCanvas){
      for(let i=scCanvas.length-1;i>=0;i--){
        if(scCanvas[i].cap===newName||scCanvas[i].cap===oldName){
          scSelectedIds&&scSelectedIds.delete(scCanvas[i].id);
          scCanvas.splice(i,1);
        }
      }
      if(typeof fcUpdateTabBadge==='function')fcUpdateTabBadge();
      if(typeof fcRenderCanvas==='function')fcRenderCanvas();
    }
    cap.featStore=null;
  }

  // Handle metric/PI group reassignment
  const _newTarget=typeof parsePiDropdownValue==='function'?parsePiDropdownValue(newMetricVal):{type:newMetricVal==='pi'?'pi-default':'metric-key',metricKey:newMetricVal};
  // v9.06.01: "did the target actually change" now needs to compare against
  // the CAPABILITY'S CURRENT LOCATION, not just a raw string equality
  // against the old metricKey — since newMetricVal can be 'pi',
  // 'bucket:<id>', or a raw metricKey, none of which match metricKey's OWN
  // format directly. Re-selecting the bucket a capability is ALREADY in
  // (now correctly pre-selected in the dropdown) must be a no-op, not a
  // pointless remove-and-re-add cycle.
  const _curEntryBucketId=entry.bucketId||null;
  let _targetUnchanged=false;
  if(_newTarget.type==='pi-bucket'){
    _targetUnchanged=(_curEntryBucketId===_newTarget.bucketId);
  } else if(_newTarget.type==='pi-default'){
    _targetUnchanged=(metricKey.startsWith('pi||')&&!_curEntryBucketId);
  } else {
    _targetUnchanged=(newMetricVal===metricKey);
  }
  if(!_targetUnchanged){
    // Remove from old key
    entry.capabilities.splice(capIdx,1);
    if(entry.capabilities.length===0)delete capStore[metricKey];

    // Add to new key
    if(_newTarget.type==='pi-default'||_newTarget.type==='pi-bucket'){
      const piKey=ccPIKey(newName);
      // Specific bucket target uses that bucketId DIRECTLY; generic default
      // resolves via getOrCreateCurrentDefaultPiBucket() exactly as before.
      const _bucketId=_newTarget.type==='pi-bucket'
        ?_newTarget.bucketId
        :(typeof getOrCreateCurrentDefaultPiBucket==='function'?getOrCreateCurrentDefaultPiBucket(gData,capStore):null);
      const _piStage=(typeof gData!=='undefined'&&gData&&Array.isArray(gData.stages))?gData.stages.find(s=>s&&s.id==='pi'):null;
      const _bucketEntry=(_piStage&&Array.isArray(_piStage.l1_metrics))?_piStage.l1_metrics.find(l1=>l1&&l1.bucketId===_bucketId):null;
      const _bucketDisplayName=_bucketEntry?_bucketEntry.name:'Custom Process Area';
      const _reassignPiStageLbl=typeof getPiStageLabel==='function'?getPiStageLabel(gData):'Custom Value Stage';
      if(!capStore[piKey]){
        capStore[piKey]={metricName:_bucketDisplayName,stageLabel:_reassignPiStageLbl,stageId:'pi',bucketId:_bucketId,_piFirst:true,capabilities:[]};
      } else {
        // v9.05 fix: same slugification-collision fix as ccDoAddCap().
        capStore[piKey].bucketId=_bucketId;
        capStore[piKey].metricName=_bucketDisplayName;
        capStore[piKey].stageId='pi';
        capStore[piKey].stageLabel=_reassignPiStageLbl;
      }
      capStore[piKey].capabilities.push(cap);
    } else {
      // v9.06.01: reassigning OUT of the pi stage to an ordinary KPI
      // metric — explicitly clear bucketId-related identity from the
      // MOVED capability's context. Note: bucketId lives on the capStore
      // ENTRY (wrapper), not on the individual cap object itself (verified
      // via code read), so there is no stale field on `cap` to clear here
      // — the target capStore[newMetricVal] entry (existing or freshly
      // created below) simply never has a bucketId field, which is
      // correct by construction.
      if(capStore[newMetricVal]){
        capStore[newMetricVal].capabilities.push(cap);
      } else {
        const metricInfo=ccGetAllL1Metrics().find(m=>m.metricKey===newMetricVal);
        if(metricInfo){
          capStore[newMetricVal]={metricName:metricInfo.metricName,stageLabel:metricInfo.stageLabel,stageId:metricInfo.stageId,capabilities:[cap]};
        }
      }
    }
    // Close right panel if it was open for this cap
    if(capActiveMetricKey===metricKey){capActiveCapIdx=null;ccPanelCapKey=null;}
    // After reassignment always return to All Caps view
    capActiveMetricKey=null;
    capActiveCapIdx=null;
  }

  // Close modal
  const overlay=document.getElementById('cc-edit-cap-overlay');
  if(overlay)overlay.remove();

  ccUpdateTabBadge();
  // Always refresh left nav (fixes stale badge counts) then render
  capActiveCapIdx=null;
  ccPanelCapKey=null;
  ccOpenMetricNav();

  if(mode==='clear'){
    showToast(`Capability updated. Features cleared. Select the card to regenerate.`,'success');
  } else {
    showToast(`Capability updated.`,'success');
  }
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    // A metric/PI-group reassignment changes TWO capability lists (the one
    // it left, the one it joined) — mark both if that happened, otherwise
    // just the one list that was actually edited in place.
    // v9.06.01: reuse the same _newTarget/_targetUnchanged computed above
    // (during the actual reassignment) rather than re-deriving with the
    // old newMetricVal==='pi' check, which no longer correctly identifies
    // a "pi-bucket" targeted value.
    var _newResolvedKey=(_newTarget.type==='pi-default'||_newTarget.type==='pi-bucket')?ccPIKey(newName):newMetricVal;
    var _wasReassigned=!_targetUnchanged;
    sessionStoreSave(_activeSessionId).then(function(ok){
      if(!ok||typeof _lsMarkManualEdit!=='function')return;
      _lsMarkManualEdit('cc',metricKey+_LS_CC_TARGET_SEP);
      if(_wasReassigned)_lsMarkManualEdit('cc',_newResolvedKey+_LS_CC_TARGET_SEP);
      // v9.05: local Discovery Map consistency, same pattern as ccDoAddCap()
      if(typeof syncPiStageFromCapStore==='function')syncPiStageFromCapStore(gData,capStore);
      if(typeof curTab!=='undefined'&&curTab==='mm'&&typeof renderMM==='function')renderMM(gData);
    });
  }
}
