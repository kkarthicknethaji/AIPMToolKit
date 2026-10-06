// ── PRODUCT LEAK ANALYSIS ──
// v8.36: productLeakAnalysis is now an array of run objects.
// Each run: { runId, runLabel, runTimestamp, runCustomName, leakingStage,
//             primaryBottleneckMetric, severity, evidenceStrength,
//             diagnosticCaveat, problemStatement, evidenceSummary,
//             instrumentationGaps, secondaryConcern, experiments[] }
//
// Owns: laRenderAnalysis, laRenderLeftPanel, laRenderSummaryCards, laRenderTable,
//       laRefreshTable, laToggleExperiment, laOpenDetailPanel, laOpenSummaryDetail,
//       laCloseDetailPanel, laSendToStoryCanvas, laToggleColPopover,
//       laUpdateSentCounter, laUpdateSendBtn, laSelectRun, laRenameRun,
//       laIsSent, laMarkSent, laGetSentCount, laRebuildSentIdsFromCanvas

// ── Active run state ──
// null = All Experiments view; runId string = single run view
let _laActiveRunId=null;

// ── laSentIds: Map<runId, Set<experimentIndex>> ──
// Cache only — rebuilt from scCanvas on session restore.
// Use helpers laIsSent/laMarkSent/laGetSentCount — never access Map directly.
let laSentIds=new Map();

// ── laSentIds helpers ──
function laIsSent(runId,idx){return laSentIds.get(runId)?.has(idx)===true;}
function laMarkSent(runId,idx){
  let s=laSentIds.get(runId);
  if(!s){s=new Set();laSentIds.set(runId,s);}
  s.add(idx);
}
function laGetSentCount(){
  let t=0;
  for(const s of laSentIds.values())t+=s.size;
  return t;
}
// Scoped sent count for a specific run — uses laIsSent() to respect
// "never access laSentIds Map directly" convention (see line 18-20).
function laGetSentCountForRun(runId){
  if(!runId)return laGetSentCount();
  const run=productLeakAnalysis&&productLeakAnalysis.find(function(r){return r.runId===runId;});
  if(!run)return 0;
  let t=0;
  (run.experiments||[]).forEach(function(_,idx){if(laIsSent(runId,idx))t++;});
  return t;
}
function laRebuildSentIdsFromCanvas(){
  laSentIds=new Map();
  if(!scCanvas||!scCanvas.length)return;
  scCanvas.forEach(function(item){
    if(item.origin!=='diagnostic')return;
    const dc=item.diagnosticContext||{};
    if(dc.runId&&dc.experimentIndex!=null)laMarkSent(dc.runId,dc.experimentIndex);
  });
}

// ── laFindCanvasCardForExperiment — reverse lookup (Outcome Pulse Iteration
// Loop, v9.11): the ONE direction this file never needed before. Every
// existing lookup goes canvas → run (laRebuildSentIdsFromCanvas, for sent-
// state dedup). Experiment Library needs the opposite direction — given a
// specific experiment (runId + index), find its scCanvas card, if any, so
// the panel can show live status ("In Experiment Canvas" vs "In Feature
// Canvas · N stories") without storing that status anywhere. Always queries
// scCanvas fresh — no cache, so a card deleted from Feature Canvas is
// reflected on the very next call with no separate invalidation step.
function laFindCanvasCardForExperiment(runId,expIdx){
  if(!scCanvas||!scCanvas.length||!runId||expIdx==null)return null;
  return scCanvas.find(function(item){
    if(item.origin!=='diagnostic')return false;
    const dc=item.diagnosticContext||{};
    return dc.runId===runId&&dc.experimentIndex===expIdx;
  })||null;
}

// ── laGetActiveRun — central resolver ──
// Returns the active run object, or null in All view / if not found.
function laGetActiveRun(){
  if(!_laActiveRunId||!productLeakAnalysis||!productLeakAnalysis.length)return null;
  return productLeakAnalysis.find(function(r){return r.runId===_laActiveRunId;})||null;
}

// ── laGetVisibleExps — returns [{run, exp, origIdx}] for current view ──
function laGetVisibleExps(){
  if(!productLeakAnalysis||!productLeakAnalysis.length)return[];
  var run=laGetActiveRun();
  var items=[];
  if(run){
    (run.experiments||[]).forEach(function(exp,i){items.push({run:run,exp:exp,origIdx:i});});
  } else {
    productLeakAnalysis.forEach(function(r){
      (r.experiments||[]).forEach(function(exp,i){items.push({run:r,exp:exp,origIdx:i});});
    });
  }
  return items;
}

// ── laSelectRun ──
function laSelectRun(runId){
  _laActiveRunId=runId||null;
  leakSelectedIds=new Set();  // clear selections on run switch
  leakDetailExperiment=null;
  const container=document.getElementById('la-tab');
  if(container)laRenderAnalysis();
}

// ── laRenameRun ──
function laRenameRun(runId){
  if(!runId)return;
  var safeId=String(runId).replace(/"/g,'\\"');
  var nameEls=document.querySelectorAll('.sc-nav-cap[onclick*="'+safeId+'"] .sc-nav-cap-name');
  if(!nameEls.length)return;
  var nameEl=nameEls[0];
  // Idempotency guard 1: element itself is already an input
  if(nameEl.tagName==='INPUT'){nameEl.focus();if(typeof nameEl.select==='function')nameEl.select();return;}
  // Idempotency guard 2: parent already has an input
  var parent=nameEl.parentNode;
  if(parent){
    var existingInp=parent.querySelector('input.sc-nav-cap-name-input,input.la-run-name-input');
    if(existingInp){existingInp.focus();if(typeof existingInp.select==='function')existingInp.select();return;}
  }
  var oldName=(nameEl.textContent||'').trim();
  var inp=document.createElement('input');
  inp.type='text';
  inp.className='sc-nav-cap-name sc-nav-cap-name-input la-run-name-input';
  inp.value=oldName;
  inp.setAttribute('aria-label','Rename run');
  inp.style.cssText='width:100%;font-size:11px;border:1px solid var(--purple);border-radius:3px;padding:1px 4px;outline:none;background:var(--card);color:var(--t1);';
  var closed=false;
  function _getRun(){
    if(!Array.isArray(productLeakAnalysis))return null;
    return productLeakAnalysis.find(function(r){return r&&r.runId===runId;})||null;
  }
  function _close(displayName){
    if(closed)return;
    closed=true;
    var span=document.createElement('span');
    span.className='sc-nav-cap-name';
    span.textContent=displayName||oldName||'Untitled run';
    inp.replaceWith(span);
  }
  function _save(){
    if(closed)return;
    var nextName=(inp.value||'').trim();
    if(!nextName){_close(oldName);return;}
    var run=_getRun();
    if(run){run.runLabel=nextName;run.runCustomName=true;}
    _close(nextName);
    if(typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId)sessionStoreSave(_activeSessionId);
    if(typeof laRefreshTable==='function')laRefreshTable();
  }
  function _cancel(){_close(oldName);}
  inp.addEventListener('mousedown',function(e){e.stopPropagation();});
  inp.addEventListener('click',function(e){e.stopPropagation();});
  inp.addEventListener('keydown',function(e){
    if(e.key==='Enter'){e.preventDefault();e.stopPropagation();_save();}
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();_cancel();}
  });
  inp.addEventListener('blur',function(){if(!closed)_cancel();});
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();
}


// Shared DOM read-back for the left panel's collapsed state - #la-left
// stays in the DOM (just hidden) between tab switches, see
// laToggleLeftPanel()'s matching write. Used both here and by
// laRenderLeftPanel() below, instead of each inlining the same read.
function laIsLeftPanelCollapsed(){
  const lp=document.getElementById('la-left');
  return !!(lp&&lp.classList.contains('collapsed'));
}

function laRenderAnalysis(){
  const container=document.getElementById('la-tab');
  if(!container)return;
  if(!productLeakAnalysis||!productLeakAnalysis.length){
    container.innerHTML=`<div class="dv-empty"><div class="dv-empty-icon"><i class="ti ti-microscope" aria-hidden="true"></i></div><div class="dv-empty-title">No analysis yet</div><div class="dv-empty-desc">Add evidence to metrics in the Discovery Map, then click Run Diagnostics.</div><button class="dv-empty-btn" onclick="switchTab('mm')"><i class="ti ti-arrow-left" style="font-size:11px;" aria-hidden="true"></i> Go to Discovery Map</button></div>`;
    return;
  }

  const session=diagnosticSessions&&diagnosticSessions.find(function(s){return s.id===activeDiagnosticId;});
  // Restore panel collapsed state from the existing #la-left.
  const laLeftCollapsed=laIsLeftPanelCollapsed();
  const laLeftHtml=laRenderLeftPanelInner(session,laLeftCollapsed);
  const activeRun=laGetActiveRun();
  const mainTitle=activeRun?activeRun.runLabel+' — diagnostic detail':'Experiment Canvas';
  const mainSub=activeRun
    ?(activeRun.experiments.length+' experiments \u00b7 '+e(activeRun.leakingStage||'')+' identified as primary leak')
    :(productLeakAnalysis.length+' diagnostic run'+(productLeakAnalysis.length!==1?'s':'')+' \u00b7 aggregate view');

  container.innerHTML=`
    <div class="la-layout">
      <div class="la-left${laLeftCollapsed?' collapsed':''}" id="la-left">${laLeftHtml}</div>
      <div class="la-main" id="la-main">
        <div class="la-main-content">
          <div class="la-scroll" id="la-scroll">
            <div class="la-toolbar">
              <div>
                <div class="la-title">${e(mainTitle)}</div>
                <div class="la-sub">${mainSub}</div>
              </div>
              <div class="la-toolbar-right">
                <button class="export-cta-btn" onclick="laDownloadDocx()"><i class="ti ti-download" style="font-size:11px;" aria-hidden="true"></i> Export</button>
              </div>
            </div>
            <div class="la-cards-row" id="la-cards-row">${laRenderSummaryCards()}</div>
            <div class="la-table-zone" id="la-table-zone">
              <div class="la-table-toolbar">
                <div class="la-table-title-wrap">
                  <div class="la-table-title">Prioritized Experiments</div>
                  <div class="la-sent-counter" id="la-sent-counter" style="display:none;"></div>
                </div>
                <div class="la-tbar-right">
                  <label class="la-filter-check-lbl"><input type="checkbox" id="la-sel-only-chk" ${leakFilters.selectedOnly?'checked':''} onchange="leakFilters.selectedOnly=this.checked;laRefreshTable()"> Selected &amp; sent only</label>
                  <button class="la-filter-btn" id="la-col-btn" onclick="laToggleColPopover()"><i class="ti ti-layout-columns" style="font-size:10px;" aria-hidden="true"></i> Columns</button>
                </div>
              </div>
              <div class="la-table-wrap" id="la-table-wrap">${laRenderTable()}</div>
            </div>
            <div id="la-col-popover" class="la-col-popover-float" style="display:none;"></div>
          </div>
          <div class="la-footer-bar">
            <span class="la-footer-status" id="la-footer-status">0 selected</span>
            <button class="la-send-btn" onclick="laSendToStoryCanvas()" id="la-send-btn" disabled><i class="ti ti-arrow-right" style="font-size:11px;" aria-hidden="true"></i> Send to Feature Canvas</button>
          </div>
        </div>
        <div class="la-detail-panel" id="la-detail-panel"></div>
      </div>
    </div>`;
  laUpdateSentCounter();
  laUpdateSendBtn();
  if(!window._laOutsideClickAttached){
    document.addEventListener('click',laHandleOutsideClick);
    window._laOutsideClickAttached=true;
  }
}

// ── Left panel inner HTML ──
function laRenderLeftPanelInner(session,isCollapsed){
  if(!session){
    return `<div class="dv-lp-header">
      <div class="dv-lp-text-wrap">
        <div class="dv-lp-eyebrow">Experiment Canvas</div>
        <div class="dv-lp-sub" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Identify leaks and prioritise experiments</div>
      </div>
      <button class="dv-collapse-btn" onclick="laToggleLeftPanel()" title="${isCollapsed?'Expand':'Collapse'} panel">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          ${isCollapsed?'<polyline points="9 18 15 12 9 6"/><polyline points="3 18 9 12 3 6"/>':'<polyline points="15 18 9 12 15 6"/><polyline points="21 18 15 12 21 6"/>'}
        </svg>
      </button>
    </div>`;
  }
  const r=session.readiness||{level:'No evidence',totalMetrics:0,metricsWithEvidence:0};
  const pct=r.totalMetrics>0?Math.round((r.metricsWithEvidence/r.totalMetrics)*100):0;
  const readinessColor={'No evidence':'var(--t3)','Partial':'var(--amber)','Good':'var(--blue)','Strong':'var(--green)'}[r.level]||'var(--t3)';
  const totalExps=productLeakAnalysis&&productLeakAnalysis.length?productLeakAnalysis.reduce(function(s,run){return s+(run.experiments||[]).length;},0):0;
  const totalRuns=productLeakAnalysis&&productLeakAnalysis.length?productLeakAnalysis.length:0;
  const isAllActive=!_laActiveRunId;

  // Build run items grouped by stage → metric → run (matching FC nav pattern)
  var runItems='';
  if(productLeakAnalysis&&productLeakAnalysis.length){
    // Group runs by stage then metric
    var stageGroups={};
    var stageOrder=[];
    productLeakAnalysis.forEach(function(run){
      var stage=run.leakingStage||'Unknown';
      var metric=run.primaryBottleneckMetric||'Unknown';
      if(!stageGroups[stage]){stageGroups[stage]={metrics:{}};stageOrder.push(stage);}
      if(!stageGroups[stage].metrics[metric])stageGroups[stage].metrics[metric]=[];
      stageGroups[stage].metrics[metric].push(run);
    });
    // Get stage colour from STAGE_PALETTE via gData
    // Normalise stage keys: trim and match case-insensitively against gData.stages
    var stageColorMap={};
    var stageNormMap={};  // normalised-key → original gData label
    if(typeof gData!=='undefined'&&gData&&gData.stages){
      gData.stages.forEach(function(s,i){
        if(typeof STAGE_PALETTE!=='undefined'){
          stageColorMap[s.label]=STAGE_PALETTE[i%STAGE_PALETTE.length];
          stageNormMap[s.label.trim().toLowerCase()]=STAGE_PALETTE[i%STAGE_PALETTE.length];
        }
      });
    }
    stageOrder.forEach(function(stage){
      // Try exact match first, then case-insensitive match
      var color=stageColorMap[stage]||stageNormMap[(stage||'').trim().toLowerCase()]||'var(--purple)';
      // Stage row — single left bar + right-aligned label (FC sc-nav-stage pattern)
      runItems+=`<div class="sc-nav-stage">
        <div class="sc-nav-stage-bar" style="background:${color};"></div>
        <span class="sc-nav-stage-lbl" style="color:${color};">${e(stage)}</span>
      </div>`;
      var metricMap=stageGroups[stage].metrics;
      Object.keys(metricMap).forEach(function(metric){
        // Metric label
        runItems+=`<div class="sc-nav-metric"><span class="sc-nav-metric-name">${e(metric)}</span></div>`;
        metricMap[metric].forEach(function(run){
          var isActive=_laActiveRunId===run.runId;
          var sentCount=laSentIds.get(run.runId)?laSentIds.get(run.runId).size:0;
          var expCount=(run.experiments||[]).length;
          runItems+=`<div class="sc-nav-cap${isActive?' active':''}" onclick="laSelectRun('${e(run.runId)}')">
            <div class="sc-nav-cap-track">
              <div class="sc-nav-cap-node${isActive?' active':''}"></div>
            </div>
            <div class="sc-nav-cap-body">
              <span class="sc-nav-cap-name">${e(run.runLabel||metric)}</span>
              <button class="la-run-rename" onclick="event.stopPropagation();laRenameRun('${e(run.runId)}')" title="Rename" aria-label="Rename run"><i class="ti ti-pencil" style="font-size:10px;" aria-hidden="true"></i></button>
              <span class="sc-nav-count${isActive?' active':''}">${expCount}</span>
            </div>
          </div>`;
        });
      });
    });
  }

  return `
    <div class="dv-lp-header">
      <div class="dv-lp-text-wrap">
        <div class="dv-lp-eyebrow">Experiment Canvas</div>
        <div class="dv-lp-sub" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Identify leaks and prioritise experiments</div>
      </div>
      <button class="dv-collapse-btn" onclick="laToggleLeftPanel()" title="${isCollapsed?'Expand':'Collapse'} panel">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          ${isCollapsed?'<polyline points="9 18 15 12 9 6"/><polyline points="3 18 9 12 3 6"/>':'<polyline points="15 18 9 12 15 6"/><polyline points="21 18 15 12 21 6"/>'}
        </svg>
      </button>
    </div>
    <div class="la-lp-tree">
      <div class="sc-nav-all${isAllActive?' active':''}" onclick="laSelectRun(null)">
        <div class="sc-nav-all-icon"><i class="ti ti-layout-grid" style="font-size:11px;" aria-hidden="true"></i></div>
        <span class="sc-nav-all-text">All Experiments</span>
        <span class="sc-nav-count${isAllActive?' active':''}">${totalExps}</span>
      </div>
      ${runItems}
    </div>
    <div class="la-readiness-foot">
      <div class="la-readiness-row">
        <span class="la-readiness-lbl">Diagnostic Readiness</span>
      </div>
      <div class="la-readiness-row">
        <span class="la-readiness-val" style="color:${readinessColor};">${r.level}</span>
        <span class="la-readiness-frac">${r.metricsWithEvidence} / ${r.totalMetrics} metrics</span>
      </div>
      <div class="la-readiness-bar"><div class="la-readiness-fill" style="width:${pct}%;background:${readinessColor};"></div></div>
    </div>`;
}


function laRenderLeftPanel(session,isCollapsed){
  if(isCollapsed===undefined){isCollapsed=laIsLeftPanelCollapsed();}
  return laRenderLeftPanelInner(session,isCollapsed);
}

function laToggleLeftPanel(){
  const lp=document.getElementById('la-left');
  if(!lp)return;
  lp.classList.toggle('collapsed');
  const isCollapsed=lp.classList.contains('collapsed');
  const session=diagnosticSessions&&diagnosticSessions.find(function(s){return s.id===activeDiagnosticId;});
  lp.innerHTML=laRenderLeftPanelInner(session,isCollapsed);
}

function laHandleOutsideClick(ev){
  const colPop=document.getElementById('la-col-popover');
  const colBtn=document.getElementById('la-col-btn');
  if(colPop&&colPop.style.display!=='none'){
    if(!colPop.contains(ev.target)&&(!colBtn||!colBtn.contains(ev.target))){
      colPop.style.display='none';
    }
  }
}

// ── Summary cards ──
// All view: aggregate stats. Single run: run-specific diagnosis cards.
function laRenderSummaryCards(){
  const run=laGetActiveRun();
  if(run){
    // Single run cards
    const caveat=run.diagnosticCaveat||'';
    const caveatDisplay=caveat.length>55?caveat.substring(0,52)+'...':caveat;
    const session=diagnosticSessions.find(function(s){return s.id===activeDiagnosticId;});
    const r=(session&&session.readiness)||{level:'',metricsWithEvidence:0,totalMetrics:0};
    const cards=[
      {label:'Leaking stage',value:run.leakingStage||'\u2014',sub:'Primary growth leak detected',accent:'var(--purple)',tooltip:run.leakingStage||''},
      {label:'Bottleneck metric',value:run.primaryBottleneckMetric||'\u2014',sub:'Primary driver of the leak',accent:'var(--red)',small:true,tooltip:run.primaryBottleneckMetric||''},
      {label:'Severity',value:run.severity||'\u2014',sub:'Impact on downstream metrics',accent:'var(--amber)',tooltip:(run.severity||'')+(run.problemStatement?' \u2014 '+run.problemStatement.substring(0,100):'')},
      {label:'Evidence strength',value:run.evidenceStrength||'\u2014',sub:'Based on available metric data',accent:'var(--blue)',tooltip:(run.evidenceStrength||'')+' \u2014 '+r.level+' ('+r.metricsWithEvidence+' of '+r.totalMetrics+' metrics have evidence)'},
      {label:'Diagnostic caveat',value:caveatDisplay,sub:'',accent:'var(--label)',small:true,tooltip:caveat}
    ];
    return cards.map(function(c){return`
      <div class="la-summary-card" style="border-top:2.5px solid ${c.accent};" title="${e(c.tooltip||c.value)}">
        <div class="la-card-eyebrow">${e(c.label)}</div>
        <div class="la-card-value${c.small?' la-card-value-sm':''}">${e(c.value)}</div>
        ${c.sub?`<div class="la-card-sub">${e(c.sub)}</div>`:''}
      </div>`;}).join('');
  }
  // Aggregate cards
  const allRuns=productLeakAnalysis||[];
  const totalExps=allRuns.reduce(function(s,r){return s+(r.experiments||[]).length;},0);
  const totalSent=laGetSentCount();
  const severities=['Critical','High','Medium','Low'];
  const highestSev=severities.find(function(sv){return allRuns.some(function(r){return r.severity===sv;});});
  const stages=[...new Set(allRuns.map(function(r){return r.leakingStage;}).filter(Boolean))];
  const evStrengths=['Strong','Moderate','Weak'];
  const worstEv=evStrengths.find(function(ev){return allRuns.some(function(r){return r.evidenceStrength===ev;});});
  const aggCards=[
    {label:'Highest severity',value:highestSev||'\u2014',sub:'Across all runs',accent:'var(--amber)'},
    {label:'Stages diagnosed',value:stages.length+(stages.length===1?' stage':' stages'),sub:stages.slice(0,2).join(', ')+(stages.length>2?' +more':''),accent:'var(--purple)',small:true},
    {label:'Evidence strength',value:worstEv||'\u2014',sub:'Weakest across runs',accent:'var(--blue)'},
    {label:'Sent to FC',value:totalSent+' of '+totalExps,sub:'Across all runs',accent:'var(--green)'},
    {label:'Total experiments',value:totalExps+' across '+allRuns.length+' run'+(allRuns.length!==1?'s':''),sub:'',accent:'var(--label)',small:true}
  ];
  return aggCards.map(function(c){return`
    <div class="la-summary-card" style="border-top:2.5px solid ${c.accent};">
      <div class="la-card-eyebrow">${e(c.label)}</div>
      <div class="la-card-value${c.small?' la-card-value-sm':''}">${e(c.value)}</div>
      ${c.sub?`<div class="la-card-sub">${e(c.sub)}</div>`:''}
    </div>`;}).join('');
}

// ── Table ──
function laRenderTable(){
  if(!productLeakAnalysis||!productLeakAnalysis.length)return`<div class="la-empty-table">No experiments generated.</div>`;
  const isAllView=!_laActiveRunId;

  // Get visible items
  var items=laGetVisibleExps();

  // Apply filters
  if(leakFilters.priority)items=items.filter(function(x){return x.exp.priority===leakFilters.priority;});
  if(leakFilters.linkedMetric)items=items.filter(function(x){return x.exp.linkedMetricName===leakFilters.linkedMetric;});
  if(leakFilters.experimentType)items=items.filter(function(x){return x.exp.experimentType===leakFilters.experimentType;});
  if(leakFilters.selectedOnly)items=items.filter(function(x){
    return leakSelectedIds.has(x.run.runId+'|'+x.origIdx)||laIsSent(x.run.runId,x.origIdx);
  });

  if(!items.length)return`<div class="la-empty-table">No experiments match the current filters. <button class="la-clear-filter-btn" onclick="leakFilters={priority:'',linkedMetric:'',experimentType:'',selectedOnly:false};document.getElementById('la-sel-only-chk').checked=false;laRefreshTable()">Clear filters</button></div>`;

  // Build filter options from all visible items (unfiltered)
  var allItems=laGetVisibleExps();
  // Deduplicate metric names case-insensitively but preserve original display case
  const _metricMap=new Map();
  allItems.forEach(function(x){if(x.exp.linkedMetricName){var k=x.exp.linkedMetricName.trim().toLowerCase();if(!_metricMap.has(k))_metricMap.set(k,x.exp.linkedMetricName.trim());}});
  const allMetrics=Array.from(_metricMap.values());
  const allTypes=[...new Set(allItems.map(function(x){return x.exp.experimentType;}).filter(Boolean))];

  const allCols=[
    {id:'priority',label:'Pri',title:'Priority',w:'44px'},
    {id:'run',label:'Run',w:'10%',allViewOnly:true},
    {id:'experiment',label:'Experiment',w:null,always:true},
    {id:'linkedMetric',label:'Linked metric',w:'12%',
     filter:`<select class="la-th-filter" onclick="event.stopPropagation()" onchange="leakFilters.linkedMetric=this.value;laRefreshTable()"><option value="">All</option>${allMetrics.map(function(m){return`<option value="${e(m)}"${leakFilters.linkedMetric===m?' selected':''}>${e(m)}</option>`;}).join('')}</select>`},
    {id:'lifecycleStage',label:'Stage',w:'64px'},
    {id:'experimentType',label:'Type',w:'64px',
     filter:`<select class="la-th-filter" onclick="event.stopPropagation()" onchange="leakFilters.experimentType=this.value;laRefreshTable()"><option value="">All</option>${allTypes.map(function(t){return`<option value="${e(t)}"${leakFilters.experimentType===t?' selected':''}>${e(t)}</option>`;}).join('')}</select>`},
    {id:'successMetric',label:'Success metric',w:'18%'},
    {id:'instrumentationNeeded',label:'Instrumentation',w:'8%'},
    {id:'assumptions',label:'Assumptions',w:'8%'},
    {id:'details',label:'',w:'48px',always:true}
  ];
  const cols=allCols.filter(function(c){
    if(c.allViewOnly)return isAllView;
    return c.always||leakColVisible[c.id]!==false;
  });
  const prioColors={P1:'la-p1',P2:'la-p2',P3:'la-p3'};

  let h=`<table class="la-exp-table"><colgroup><col style="width:26px;">${cols.map(function(c){
    return c.w ? `<col style="width:${c.w};">` : `<col>`;
  }).join('')}</colgroup>`;
  h+=`<thead><tr><th style="min-width:26px;padding-left:8px;"></th>${cols.map(function(c){
    if(c.filter){return`<th class="la-th-filterable${leakFilters[c.id]?' la-th-active':''}"${c.title?` title="${e(c.title)}"`:''}>
<div class="la-th-inner"><span>${e(c.label)}</span>${c.filter}</div></th>`;}
    return`<th${c.title?` title="${e(c.title)}"`:''} >${e(c.label)}</th>`;
  }).join('')}</tr></thead><tbody>`;

  items.forEach(function(item){
    const run=item.run;
    const exp=item.exp;
    const origIdx=item.origIdx;
    const selKey=run.runId+'|'+origIdx;
    const sel=leakSelectedIds.has(selKey);
    const sent=laIsSent(run.runId,origIdx);
    const rowCls=sent?'la-row-sent':sel?'la-row-sel':'';
    // Use data attributes for run-scoped identity — avoids encoding in onclick strings
    const _canEditPdRow=(typeof canEditSession!=='function')||canEditSession();
    h+=`<tr class="${rowCls}" data-run-id="${e(run.runId)}" data-exp-idx="${origIdx}" ${_canEditPdRow?`onclick="laToggleExperimentByRow(this)"`:''}>`;
    h+=`<td style="min-width:26px;padding-left:8px;">`;
    if(sent){
      h+=`<div class="la-cb-sent" title="Already sent to Feature Canvas">&#10003;</div>`;
    }else{
      h+=`<div class="la-cb${sel?' la-cb-checked':''}${_canEditPdRow?'':' la-cb-disabled'}" ${_canEditPdRow?`onclick="event.stopPropagation();laToggleExperimentByRow(this.closest('tr'))"`:''}></div>`;
    }
    h+=`</td>`;
    cols.forEach(function(col){
      if(col.id==='priority'){
        h+=`<td><span class="la-prio ${prioColors[exp.priority]||''}">${e(exp.priority||'')}</span></td>`;
      }else if(col.id==='run'){
        h+=`<td title="${e(run.runLabel||'')}"><span class="la-run-pill">${e(run.runLabel||'')}</span></td>`;
      }else if(col.id==='experiment'){
        h+=`<td><div class="la-exp-title">${e(exp.experimentTitle||'')}${sent?` <span class="la-sent-badge">Sent &#10003;</span>`:''}</div><div class="la-exp-hyp">${e(exp.hypothesis||'')}</div></td>`;
      }else if(col.id==='linkedMetric'){
        h+=`<td><div class="la-metric-link">${e(exp.linkedMetricName||'')}</div><div class="la-metric-stage">${e(exp.lifecycleStage||'')} &middot; L1</div></td>`;
      }else if(col.id==='lifecycleStage'){
        h+=`<td style="font-size:10px;">${e(exp.lifecycleStage||'')}</td>`;
      }else if(col.id==='experimentType'){
        h+=`<td style="font-size:10px;">${e(exp.experimentType||'')}</td>`;
      }else if(col.id==='successMetric'){
        const sm=exp.successMetric||{};
        h+=`<td><div class="la-success-val">${e(sm.metricName||'')}${sm.currentValue?' &middot; '+e(sm.currentValue):''}</div>`;
        if(sm.targetValue)h+=`<div class="la-success-target">&rarr; ${e(sm.targetValue)}</div>`;
        if(sm.measurementWindow)h+=`<div class="la-success-window">${e(sm.measurementWindow)}</div>`;
        h+=`</td>`;
      }else if(col.id==='instrumentationNeeded'){
        h+=`<td style="font-size:9px;color:var(--t3);">${e(exp.instrumentationNeeded||'\u2014')}</td>`;
      }else if(col.id==='assumptions'){
        const assumps=(exp.assumptions||[]).slice(0,2).map(function(a){return`<div class="la-assump">${e(a)}</div>`;}).join('');
        h+=`<td>${assumps}</td>`;
      }else if(col.id==='details'){
        h+=`<td><button class="la-detail-link" data-run-id="${e(run.runId)}" data-exp-idx="${origIdx}" onclick="event.stopPropagation();laOpenDetailPanelByBtn(this)">View &rarr;</button></td>`;
      }
    });
    h+=`</tr>`;
  });
  h+=`</tbody></table>`;
  return h;
}

// ── Row interaction helpers (read runId + expIdx from data attributes) ──
function laToggleExperimentByRow(tr){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  if(!tr)return;
  const runId=tr.dataset.runId;
  const idx=parseInt(tr.dataset.expIdx);
  if(!runId||isNaN(idx))return;
  const selKey=runId+'|'+idx;
  if(laIsSent(runId,idx))return; // sent — not toggleable
  if(leakSelectedIds.has(selKey))leakSelectedIds.delete(selKey);
  else leakSelectedIds.add(selKey);
  laRefreshTable();
  // Keep open detail panel in sync
  if(leakDetailExperiment&&leakDetailExperiment.runId===runId&&leakDetailExperiment.idx===idx){
    laOpenDetailPanel(runId,idx);
  }
}

function laOpenDetailPanelByBtn(btn){
  if(!btn)return;
  const runId=btn.dataset.runId;
  const idx=parseInt(btn.dataset.expIdx);
  if(!runId||isNaN(idx))return;
  laOpenDetailPanel(runId,idx);
}

function laRefreshTable(){
  const wrap=document.getElementById('la-table-wrap');
  if(wrap)wrap.innerHTML=laRenderTable();
  laUpdateSendBtn();
  laUpdateSentCounter();
}

function laUpdateSentCounter(){
  const el=document.getElementById('la-sent-counter');
  if(!productLeakAnalysis||!productLeakAnalysis.length)return;
  const activeRun=laGetActiveRun();
  const items=laGetVisibleExps();
  const total=items.length;
  // Use run-scoped count when viewing a specific run — prevents stale cross-run totals
  const sent=activeRun?laGetSentCountForRun(activeRun.runId):laGetSentCount();
  if(el){
    if(sent===0){el.style.display='none';el.textContent='';}
    else{el.style.display='';el.textContent=sent+' of '+total+' experiment'+(total!==1?'s':'')+' sent to FC';}
  }
  const statusEl=document.getElementById('la-footer-status');
  if(statusEl){
    const selCount=leakSelectedIds.size;
    statusEl.textContent=selCount===0?'0 selected':`${selCount} selected \u00b7 ${sent} sent to Feature Canvas`;
  }
}

function laUpdateSendBtn(){
  const btn=document.getElementById('la-send-btn');
  if(!btn)return;
  // v9.08: hidden for view-only sessions rather than left disabled — this
  // button has nothing to enable toward for a viewer.
  if(typeof canEditSession==='function'&&!canEditSession()){
    btn.style.display='none';
    return;
  }
  btn.style.display='';
  const selected=Array.from(leakSelectedIds);
  if(selected.length===0){
    btn.disabled=true;
    btn.innerHTML=`<i class="ti ti-arrow-right" style="font-size:11px;" aria-hidden="true"></i> Send to Feature Canvas`;
    return;
  }
  const allAlreadySent=selected.every(function(key){
    const parts=key.split('|');
    const runId=parts.slice(0,-1).join('|');
    const idx=parseInt(parts[parts.length-1]);
    return laIsSent(runId,idx);
  });
  if(allAlreadySent){
    btn.disabled=true;
    btn.innerHTML=`<i class="ti ti-check" style="font-size:11px;" aria-hidden="true"></i> Already on Feature Canvas`;
  }else{
    const newCount=selected.filter(function(key){
      const parts=key.split('|');
      const runId=parts.slice(0,-1).join('|');
      const idx=parseInt(parts[parts.length-1]);
      return !laIsSent(runId,idx);
    }).length;
    btn.disabled=false;
    btn.innerHTML=`<i class="ti ti-arrow-right" style="font-size:11px;" aria-hidden="true"></i> Send ${newCount} to Feature Canvas`;
  }
}

// ── Toggle experiment (legacy — kept for any remaining direct calls) ──
function laToggleExperiment(idx){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  // In single-run view only — find active run
  const run=laGetActiveRun();
  if(!run)return;
  const selKey=run.runId+'|'+idx;
  if(laIsSent(run.runId,idx))return;
  if(leakSelectedIds.has(selKey))leakSelectedIds.delete(selKey);
  else leakSelectedIds.add(selKey);
  laRefreshTable();
  if(leakDetailExperiment&&leakDetailExperiment.runId===run.runId&&leakDetailExperiment.idx===idx){
    laOpenDetailPanel(run.runId,idx);
  }
}

// ── Detail panels ──
function laOpenSummaryDetail(){
  const run=laGetActiveRun()||((productLeakAnalysis&&productLeakAnalysis.length)?productLeakAnalysis[productLeakAnalysis.length-1]:null);
  if(!run)return;
  const panel=document.getElementById('la-detail-panel');
  if(!panel)return;
  leakDetailExperiment=null;
  panel.innerHTML=`
    <div class="la-dp-head">
      <div><div class="la-dp-title">Diagnostic summary</div><div class="la-dp-sub">${e(run.runLabel||'Full analysis detail')}</div></div>
      <button class="la-dp-close" onclick="laCloseDetailPanel()" aria-label="Close">&#215;</button>
    </div>
    <div class="la-dp-body">
      <div class="la-dp-section">
        <div class="la-dp-section-lbl">Consulting problem statement</div>
        <div class="la-ps-box">${e(run.problemStatement||'')}</div>
      </div>
      ${run.evidenceSummary&&run.evidenceSummary.length?`<div class="la-dp-section"><div class="la-dp-section-lbl">Evidence summary</div><ul class="la-dp-list">${run.evidenceSummary.map(function(x){return`<li>${e(x)}</li>`;}).join('')}</ul></div>`:''}
      ${run.instrumentationGaps&&run.instrumentationGaps.length?`<div class="la-dp-section"><div class="la-dp-section-lbl">Instrumentation gaps</div><ul class="la-dp-list la-dp-list-gap">${run.instrumentationGaps.map(function(x){return`<li>${e(x)}</li>`;}).join('')}</ul></div>`:''}
      ${run.secondaryConcern?`<div class="la-dp-section"><div class="la-dp-section-lbl">Secondary concern</div><div class="la-dp-text">${e(run.secondaryConcern)}</div></div>`:''}
    </div>`;
  panel.classList.add('open');
}

function laOpenDetailPanel(runId,idx){
  const run=productLeakAnalysis&&productLeakAnalysis.find(function(r){return r.runId===runId;});
  if(!run||!run.experiments[idx])return;
  const exp=run.experiments[idx];
  leakDetailExperiment={runId:runId,idx:idx};
  const panel=document.getElementById('la-detail-panel');
  if(!panel)return;
  const selKey=runId+'|'+idx;
  const sel=leakSelectedIds.has(selKey);
  const sent=laIsSent(runId,idx);
  // v9.11.01 (Fix 5) — previously hardcoded "Product leak diagnostic"
  // unconditionally, misreporting origin for every outcome-pulse-sourced
  // experiment (found during adversarial review, not in the original bug
  // report). Legacy runs with no source field at all default to
  // 'diagnostic', matching the same fallback convention used everywhere
  // else run.source is read.
  const originLabel=(run.source||'diagnostic')==='outcome-pulse'?'Outcome Pulse suggestion':'Product leak diagnostic';
  panel.innerHTML=`
    <div class="la-dp-head">
      <div>
        <div class="la-dp-title">Experiment detail</div>
        <div class="la-dp-sub">${e(exp.experimentTitle||'')} &middot; ${e(exp.priority||'')}${sent?' &middot; <span style="color:var(--green);font-weight:700;">Sent &#10003;</span>':''}</div>
      </div>
      <button class="la-dp-close" onclick="laCloseDetailPanel()" aria-label="Close">&#215;</button>
    </div>
    <div class="la-dp-body">
      <div class="la-dp-section"><div class="la-dp-section-lbl">Consulting problem statement</div><div class="la-ps-box">${e(run.problemStatement||'')}</div></div>
      <div class="la-dp-section"><div class="la-dp-section-lbl">Hypothesis</div><div class="la-dp-text">${e(exp.hypothesis||'')}</div></div>
      ${exp.assumptions&&exp.assumptions.length?`<div class="la-dp-section"><div class="la-dp-section-lbl">Assumptions</div><ul class="la-dp-list">${exp.assumptions.map(function(a){return`<li>${e(a)}</li>`;}).join('')}</ul></div>`:''}
      ${exp.instrumentationNeeded?`<div class="la-dp-section"><div class="la-dp-section-lbl">Instrumentation needed</div><div class="la-dp-text">${e(exp.instrumentationNeeded)}</div></div>`:''}
      <div class="la-dp-section"><div class="la-dp-section-lbl">Story canvas mapping</div>
        <div class="la-mapping-box">
          <div class="la-map-row"><span>Feature name</span><span>${e(exp.experimentTitle||'')}</span></div>
          <div class="la-map-row"><span>Source metric</span><span>${e(exp.linkedMetricName||'')}</span></div>
          <div class="la-map-row"><span>Stage</span><span>${e(exp.lifecycleStage||'')} &middot; ${e(exp.priority||'')}</span></div>
          <div class="la-map-row"><span>Origin</span><span class="la-origin-val">${e(originLabel)}</span></div>
        </div>
      </div>
    </div>
    <div class="la-dp-footer">
      ${sent
        ?`<div class="la-dp-sent-state"><i class="ti ti-check" style="font-size:12px;" aria-hidden="true"></i> Already on Feature Canvas</div>`
        :((typeof canEditSession!=='function')||canEditSession())
          ?`<button class="la-dp-add-btn${sel?' la-dp-add-sel':''}" data-run-id="${e(runId)}" data-exp-idx="${idx}" onclick="laToggleExperimentByRow(this.closest('[data-run-id]')||this);laOpenDetailPanel('${e(runId)}',${idx})">
          <i class="ti ti-${sel?'minus':'plus'}" style="font-size:10px;" aria-hidden="true"></i> ${sel?'Remove from selection':'Add to selection'}
         </button>`
          :''
      }
    </div>`;
  panel.classList.add('open');
}

function laCloseDetailPanel(){
  const panel=document.getElementById('la-detail-panel');
  if(panel)panel.classList.remove('open');
  leakDetailExperiment=null;
}

// ── Columns popover ──
function laRenderColPopoverContent(){
  const pop=document.getElementById('la-col-popover');
  if(!pop)return;
  const cols=[
    {id:'priority',label:'Priority'},
    {id:'linkedMetric',label:'Linked metric'},
    {id:'lifecycleStage',label:'Lifecycle stage'},
    {id:'experimentType',label:'Experiment type'},
    {id:'successMetric',label:'Success metric'},
    {id:'instrumentationNeeded',label:'Instrumentation needed'},
    {id:'assumptions',label:'Assumptions'}
  ];
  pop.innerHTML=`<div class="la-pop-inner">
    <div class="la-pop-title">Show / hide columns</div>
    ${cols.map(function(c){return`<div class="la-pop-field la-pop-check"><label><input type="checkbox" ${leakColVisible[c.id]!==false?'checked':''} onchange="leakColVisible['${c.id}']=this.checked;laRefreshTable()"> ${e(c.label)}</label></div>`;}).join('')}
    <div class="la-pop-footer"><button onclick="Object.assign(leakColVisible,{priority:true,linkedMetric:true,successMetric:true,lifecycleStage:false,experimentType:false,instrumentationNeeded:false,assumptions:false});laRefreshTable();laRenderColPopoverContent()">Reset to defaults</button></div>
  </div>`;
}

function laToggleColPopover(){
  const pop=document.getElementById('la-col-popover');
  if(!pop)return;
  const isOpen=pop.style.display!=='none';
  if(!isOpen){
    laRenderColPopoverContent();
    const btn=document.getElementById('la-col-btn');
    if(btn){
      const r=btn.getBoundingClientRect();
      const scroll=document.getElementById('la-scroll');
      const sr=scroll?scroll.getBoundingClientRect():{top:0,left:0};
      pop.style.top=(r.bottom-sr.top+scroll.scrollTop+4)+'px';
      pop.style.right=(sr.right-r.right)+'px';
    }
    pop.style.display='block';
  }else{
    pop.style.display='none';
  }
}

// ── Send to Feature Canvas ──
// ── Key parser for composite leakSelectedIds keys (runId|idx) ──
// Uses lastIndexOf to handle runIds that may themselves contain pipes.
function laParseSelectedExperimentKey(key){
  var pipeIndex=key.lastIndexOf('|');
  if(pipeIndex===-1)return null;
  var runId=key.slice(0,pipeIndex);
  var idxRaw=key.slice(pipeIndex+1);
  var idx=Number(idxRaw);
  if(!runId||!Number.isInteger(idx)||idx<0)return null;
  return {runId:runId,idx:idx};
}

// ── Stage resolver for diagnostic experiments ──
// Walks gData.stages to find the KPI tree stage for a given metric name.
// Fixes FC grouping: experiments group under the metric's KPI tree stage,
// not the AI-inferred execution stage (lifecycleStage).
function _laResolveStageFromMetric(metricName){
  if(!metricName||typeof gData==='undefined'||!gData||!gData.stages)return '';
  for(var si=0;si<gData.stages.length;si++){
    var st=gData.stages[si];
    var l1s=st.l1_metrics||[];
    for(var li=0;li<l1s.length;li++){
      var l1=l1s[li];
      if(!l1)continue;
      if(l1.name===metricName)return st.label;
      var l2s=l1.l2_metrics||[];
      for(var l2i=0;l2i<l2s.length;l2i++){
        var l2=l2s[l2i];
        if(!l2)continue;
        if(l2.name===metricName)return st.label;
        var l3s=l2.l3_metrics||[];
        for(var l3i=0;l3i<l3s.length;l3i++){
          var l3=l3s[l3i];
          if(l3&&l3.name===metricName)return st.label;
        }
      }
    }
  }
  return '';
}

function laSendToStoryCanvas(){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  if(!productLeakAnalysis||!productLeakAnalysis.length)return;
  // Build run lookup map for efficient resolution
  var runsById=new Map(productLeakAnalysis.map(function(r){return[r.runId,r];}));
  var added=0;
  var _laSentFids=[];

  for(var key of leakSelectedIds){
    var parsed=laParseSelectedExperimentKey(key);
    if(!parsed)continue;
    var run=runsById.get(parsed.runId);
    if(!run)continue;
    var exp=run.experiments&&run.experiments[parsed.idx];
    if(!exp)continue;
    if(laIsSent(parsed.runId,parsed.idx))continue;

    var linkedMetric=exp.linkedMetricName||'Unknown Metric';
    // v9.11.02 (Fix 7) — the synthetic "Diagnostic Experiments — {metric}"
    // capability + isolated stage bucket below was built for real
    // Diagnostic Analysis experiments, which genuinely have no originating
    // feature (that flow starts from raw KPI-tree evidence, not from an
    // existing feature — verified in _dvRunAnalysis(), which takes
    // stagesWithEvidence/changedMetrics, never a feature reference). That
    // mechanism is architecturally wrong for outcome-pulse-origin
    // experiments, which always have a real, known originating feature
    // (opOpenSuggestExperimentModal() cannot open without one) — reported
    // live: an Acquisition-stage feature's generated experiment landed
    // under a phantom stage bucket instead of its own real hierarchy, and
    // that phantom bucket's unbounded-length AI-generated stage name (from
    // the unconstrained exp.lifecycleStage fallback) also caused a
    // horizontal-scroll layout regression on Feature Canvas.
    var _isOutcomePulseOrigin=run.source==='outcome-pulse';
    var capLabel,resolvedStage,fid;
    // v9.11.03 (Fix 8) — even with cap/stage now correct (v9.11.02), the
    // grouping key Feature Canvas actually uses is stage+METRIC
    // (fcRenderCanvas(): k=f.stage+'||'+f.metric) — and linkedMetric here
    // was still exp.linkedMetricName (the AI's/hypothesis's own metric
    // label), never the real KPI-tree metric string. Any mismatch between
    // those two strings put the new card in a second, duplicate stage
    // section even though stage/capability were both correct. For
    // outcome-pulse origin, override linkedMetric with the real KPI-tree
    // string captured at generation time — used for BOTH the fid and the
    // card's own metric field below, so grouping and hypothesis label are
    // finally consistent with the original feature throughout.
    if(_isOutcomePulseOrigin&&run.originFeatureMetric){
      linkedMetric=run.originFeatureMetric;
    }
    if(_isOutcomePulseOrigin){
      // Real hierarchy already exists and is known with certainty — use it
      // directly. No stage resolution needed (nothing to resolve), no
      // synthetic capability label, no capStore entry (nothing new needs
      // to be created — the real capability is already tracked elsewhere).
      capLabel=run.originFeatureCap||linkedMetric;
      resolvedStage=run.originFeatureStage||'';
      fid=scMakeFeatureId(linkedMetric,capLabel,exp.experimentTitle||'');
    } else {
      capLabel='Diagnostic Experiments — '+linkedMetric;
      resolvedStage=_laResolveStageFromMetric(linkedMetric)||exp.lifecycleStage||'';
      fid=scMakeFeatureId(linkedMetric,capLabel+':'+parsed.runId,exp.experimentTitle||'');
    }
    _laSentFids.push(fid);
    if(!scCanvas.some(function(f){return f.id===fid;})){
      var sm=exp.successMetric||{};
      var successCtx=sm.metricName?(sm.metricName+(sm.currentValue?' ('+sm.currentValue+'→'+(sm.targetValue||'target')+')':'')):'';
      // v9.11.01 (Fix 4) — previously this card was created with no
      // outcomeHypothesis at all, for either run source (real diagnostic
      // or outcome-pulse), even though the source experiment already
      // carries hypothesis/success-metric data. Reported: "the hypothesis
      // is left empty while it has already been defined in the
      // experiments." Mapped here from the same fields already present on
      // the experiment object, reusing computeDirection() exactly like
      // every other hypothesis-creation path in this app rather than
      // inventing new null-handling — verified computeSuggestedSignal()
      // doesn't consume direction at all (only baseline/target/actual) and
      // every render site already degrades gracefully on a falsy
      // direction, so there is no correctness reason to leave it
      // uncomputed when baseline/target are both known.
      // Empty-string guard before Number() conversion: Number('') is 0, a
      // real, misleading numeric value — not the "not set" state an empty
      // string from the AI's loose JSON schema actually represents. Same
      // defensive check computeDirection() already applies internally to
      // its own inputs; applied here too since hypBaseline/hypTarget are
      // stored directly, not just passed through that one function.
      var _expBaseline=(sm.currentValue===''||sm.currentValue==null)?null:(isFinite(Number(sm.currentValue))?Number(sm.currentValue):null);
      var _expTarget=(sm.targetValue===''||sm.targetValue==null)?null:(isFinite(Number(sm.targetValue))?Number(sm.targetValue):null);
      // v9.11.03 (Fix 8) — for outcome-pulse origin, inherit baseline/
      // target from the original feature rather than relying solely on
      // the experiment's own (often absent) successMetric numbers,
      // per the agreed rule: baseline = original's logged actual if
      // present, else its baseline; target = the experiment's own
      // proposed target if present, else the original's target. Real-
      // diagnostic origin is unaffected — no original feature exists for
      // it to inherit from, so it keeps using the experiment's own
      // successMetric values exactly as before.
      var hypBaseline=_expBaseline;
      var hypTarget=_expTarget;
      if(_isOutcomePulseOrigin){
        hypBaseline=(run.originHypothesisActual!=null)?run.originHypothesisActual:(run.originHypothesisBaseline!=null?run.originHypothesisBaseline:_expBaseline);
        hypTarget=(_expTarget!=null)?_expTarget:(run.originHypothesisTarget!=null?run.originHypothesisTarget:null);
      }
      var mappedHypothesis={
        primary:{
          // v9.11.04 (Fix 11) — for outcome-pulse origin, the new
          // sibling's hypothesis metric now inherits the ORIGINAL
          // feature's own hypothesis metric label (run.originHypothesisMetric),
          // not linkedMetric (the KPI-tree grouping field, correct for
          // fid/stage/cap but NOT the same thing as the hypothesis's own,
          // deliberately-more-granular metric label by original v9.10.00
          // design). Verified: exp.successMetric.metricName was already
          // correctly canonicalized to this same hypothesis-metric string
          // by an earlier fix (Fix 3, at generation time), independent of
          // this change — no other field needed correcting.
          metric:_isOutcomePulseOrigin?(run.originHypothesisMetric||linkedMetric):(sm.metricName||linkedMetric),
          unit:'custom',customLabel:'',
          baseline:hypBaseline,target:hypTarget,
          direction:computeDirection(hypBaseline,hypTarget),
          directionSource:'computed',
          rationale:(exp.hypothesis||exp.description||'').toString().trim().slice(0,400),
          source:'ai',actual:null,signal:null,loggedAt:null
        },
        secondary:[]
      };
      scCanvas.push({id:fid,metric:linkedMetric,stage:resolvedStage,
        cap:capLabel,name:exp.experimentTitle||'',
        why:exp.hypothesis||exp.description||'',stories:null,origin:'diagnostic',
        outcomeHypothesis:mappedHypothesis,
        diagnosticContext:{runId:parsed.runId,experimentIndex:parsed.idx,
          leakingStage:run.leakingStage||'',bottleneckMetric:run.primaryBottleneckMetric||'',
          problemStatement:run.problemStatement||'',priority:exp.priority||'',
          successMetric:successCtx,instrumentationNeeded:exp.instrumentationNeeded||'',
          severity:run.severity||'',
          evidenceStrength:run.evidenceStrength||'',
          // v9.11.01 (Fix 6) — origin stays 'diagnostic' for both run
          // sources (unchanged, to avoid a wider FC card-styling change
          // this patch isn't scoped for); runSource distinguishes them for
          // any downstream code that needs to, without overloading origin.
          runSource:run.source||'diagnostic'}});
      added++;

      // v9.11.02 (Fix 7) — skip the synthetic capStore entry entirely for
      // outcome-pulse origin: the real capability this experiment now
      // lives under already exists and is already tracked wherever it was
      // originally created (Capability Canvas). Creating a parallel
      // "diag||" entry here would be pure clutter with no offsetting
      // benefit, since nothing downstream reads or depends on it (verified:
      // laMarkSent, scUpdateCapDrawerFooter, fcUpdateTabBadge, and
      // fcRenderCanvas all read live state, none depend on this block
      // having executed).
      if(!_isOutcomePulseOrigin){
        var capStoreKey='diag||'+linkedMetric;
        if(!capStore[capStoreKey]){
          capStore[capStoreKey]={
            metricName:linkedMetric,stageLabel:'Experiment Canvas',stageId:'diag',_diagCap:true,
            capabilities:[{name:capLabel,why:(run.problemStatement||'Diagnostic experiments linked to '+linkedMetric),
              subCaps:null,featStore:{top:[]}}]
          };
        }
        var capEntry=capStore[capStoreKey];
        if(!capEntry.capabilities[0].featStore)capEntry.capabilities[0].featStore={top:[]};
        if(!capEntry.capabilities[0].featStore.top)capEntry.capabilities[0].featStore.top=[];
        var featTop=capEntry.capabilities[0].featStore.top;
        if(!featTop.some(function(x){return x.name===(exp.experimentTitle||'');})){
          featTop.push({name:exp.experimentTitle||'',why:exp.hypothesis||exp.description||'',
            selected:false,metric:linkedMetric,stage:'Experiment Canvas',cap:capLabel,_diagSent:true});
        }
      }
    }
    laMarkSent(parsed.runId,parsed.idx);
  }

  if(added>0){
    scUpdateCapDrawerFooter();
    fcUpdateTabBadge();
    if(typeof scCapNavFilter!=='undefined')scCapNavFilter=null;
    fcRenderCanvas();
    if(typeof ccUpdateTabBadge==='function')ccUpdateTabBadge();
    if(typeof capActiveMetricKey!=='undefined'&&
       (capActiveMetricKey===null||!capStore[capActiveMetricKey])){
      capActiveMetricKey=null;capActiveCapIdx=null;
      capActiveSubCapIdx=null;ccPanelCapKey=null;
      if(typeof ccOpenMetricNav==='function'&&document.getElementById('cc-main')){
        ccOpenMetricNav();
      }else if(typeof ccRenderAllCaps==='function'){
        ccRenderAllCaps();
      }
    }
    var ccTabEl=document.getElementById('tab-cc');
    if(ccTabEl&&ccTabEl.style.display==='none')ccTabEl.style.display='';
    leakSelectedIds.clear();
    laRefreshTable();
    laUpdateSentCounter();
    laUpdateSendBtn();
    laShowSentConfirmation(added);
    if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
      // v8.147 fix: confirmed missing entirely — a third file (besides CC
      // and Feature Canvas itself) writing new feature entries directly
      // to scCanvas. Same coarse target shape as CC's own send action.
      sessionStoreSave(_activeSessionId).then(function(ok){
        if(!ok||typeof _lsMarkManualEdit!=='function')return;
        _laSentFids.forEach(function(fid){ _lsMarkManualEdit('sc',fid+_LS_SC_TARGET_SEP); });
      });
    }
  }
}


function laShowSentConfirmation(count){
  const existing=document.getElementById('la-sent-toast');
  if(existing)existing.remove();
  const toast=document.createElement('div');
  toast.id='la-sent-toast';
  toast.className='la-sent-toast';
  toast.innerHTML=`<i class="ti ti-check" style="font-size:12px;" aria-hidden="true"></i> ${count} experiment${count!==1?'s':''} added to Feature Canvas. <button onclick="switchTab('fc');document.getElementById('la-sent-toast').remove()" class="la-toast-link">Open Feature Canvas</button>`;
  document.body.appendChild(toast);
  setTimeout(function(){toast.classList.add('on');},50);
  setTimeout(function(){toast.classList.remove('on');setTimeout(function(){toast.remove();},400);},6000);
}

// ── laClearAnalysis ──
function laClearAnalysis(){
  productLeakAnalysis=[];
  laSentIds=new Map();
  leakSelectedIds=new Set();
  leakDetailExperiment=null;
  _laActiveRunId=null;
  const laTabEl=document.getElementById('tab-la');
  if(laTabEl)laTabEl.style.display='none';
  if(curTab==='la')switchTab('mm');
}
