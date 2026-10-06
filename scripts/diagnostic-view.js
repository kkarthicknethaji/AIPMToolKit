// ── DIAGNOSTIC VIEW ──
// Owns: dvCreate, dvMergeEvidenceOnRegen, dvRenderView,
//       dvOpenEvidenceDrawer, dvCloseEvidenceDrawer, dvSaveEvidence,
//       dvClearEvidence, dvCalcEvidenceStrength, dvCalcReadiness

// ── Evidence strength calculation ──
function dvCalcEvidenceStrength(ev){
  if(!ev)return'No evidence';
  if(ev.instrumentationStatus==='Not instrumented')return'Instrumentation gap';
  const filled=[ev.currentValue,ev.previousValue,ev.targetBenchmark,ev.trend].filter(v=>v&&v.trim()!=='');
  const hasNotes=ev.notes&&ev.notes.trim()!=='';
  const hasInst=ev.instrumentationStatus&&ev.instrumentationStatus!=='';
  if(filled.length===0&&!hasNotes&&!hasInst)return'No evidence';
  if(filled.length===0&&hasNotes)return'Weak evidence';
  if(filled.length===1&&!ev.previousValue&&!ev.targetBenchmark&&!ev.trend)return'Moderate evidence';
  if(ev.currentValue&&ev.currentValue.trim()&&(ev.previousValue||ev.targetBenchmark||ev.trend))return'Strong evidence';
  return'Weak evidence';
}

// ── Diagnostic readiness calculation ──
function dvCalcReadiness(session){
  const allMetrics=dvFlattenMetrics(session.tree);
  const total=allMetrics.length;
  if(total===0)return{level:'No evidence',totalMetrics:0,metricsWithEvidence:0,notInstrumentedCount:0,strongestStage:'',weakestStage:''};
  let withEvidence=0,notInstrumented=0;
  const stageStrong={};
  allMetrics.forEach(m=>{
    const str=dvCalcEvidenceStrength(m.evidence);
    if(str!=='No evidence')withEvidence++;
    if(str==='Instrumentation gap')notInstrumented++;
    const st=m.stage||'';
    if(!stageStrong[st])stageStrong[st]={strong:0,total:0};
    stageStrong[st].total++;
    if(str==='Strong evidence'||str==='Moderate evidence')stageStrong[st].strong++;
  });
  const pct=withEvidence/total;
  let level='No evidence';
  if(withEvidence===0)level='No evidence';
  else if(pct<0.5)level='Partial';
  else{
    const stagesWithStrong=Object.values(stageStrong).filter(s=>s.strong>0).length;
    level=(stagesWithStrong>=2)?'Strong':'Good';
  }
  const stages=Object.entries(stageStrong).sort((a,b)=>b[1].strong-a[1].strong);
  return{
    level,totalMetrics:total,metricsWithEvidence:withEvidence,
    notInstrumentedCount:notInstrumented,
    strongestStage:stages.length>0?stages[0][0]:'',
    weakestStage:stages.length>1?stages[stages.length-1][0]:''
  };
}

// ── Flatten all metrics from tree (with stage context) ──
function dvFlattenMetrics(tree){
  const result=[];
  if(!tree||!tree.stages)return result;
  tree.stages.forEach(st=>{
    (st.l1_metrics||[]).forEach(l1=>{
      result.push({id:l1._dvId,name:l1.name,stage:st.label||st.id,level:'L1',evidence:l1.evidence||null});
      (l1.l2_metrics||[]).forEach(l2=>{
        result.push({id:l2._dvId,name:l2.name,stage:st.label||st.id,level:'L2',evidence:l2.evidence||null});
        (l2.l3_metrics||[]).forEach(l3=>{
          result.push({id:l3._dvId,name:l3.name,stage:st.label||st.id,level:'L3',evidence:l3.evidence||null});
        });
      });
    });
  });
  return result;
}

// ── Deep-clone KPI tree and attach empty evidence objects ──
function dvDeepCloneTree(kpiTree){
  const clone=JSON.parse(JSON.stringify(kpiTree));
  let idCounter=0;
  const emptyEv=()=>({currentValue:'',previousValue:'',targetBenchmark:'',trend:'',instrumentationStatus:'',notes:''});
  (clone.stages||[]).forEach(st=>{
    (st.l1_metrics||[]).forEach(l1=>{
      l1._dvId='dv-'+(++idCounter);
      if(!l1.evidence)l1.evidence=emptyEv();
      (l1.l2_metrics||[]).forEach(l2=>{
        l2._dvId='dv-'+(++idCounter);
        if(!l2.evidence)l2.evidence=emptyEv();
        (l2.l3_metrics||[]).forEach(l3=>{
          l3._dvId='dv-'+(++idCounter);
          if(!l3.evidence)l3.evidence=emptyEv();
        });
      });
    });
  });
  return clone;
}

// ── Merge evidence on KPI tree regeneration ──
// Retains evidence for metrics with matching names, discards removed metrics
function dvMergeEvidenceOnRegen(session,newKpiTree){
  if(!session||!session.tree)return;
  // Build old evidence map by metric name
  const oldMap={};
  dvFlattenMetrics(session.tree).forEach(m=>{
    if(m.evidence&&m.name)oldMap[m.name]=m.evidence;
  });
  // Clone new tree and attach matching evidence
  const newTree=dvDeepCloneTree(newKpiTree);
  dvFlattenMetrics(newTree).forEach(m=>{
    const metric=dvFindMetricById(newTree,m.id);
    if(metric&&oldMap[m.name]){
      metric.evidence=JSON.parse(JSON.stringify(oldMap[m.name]));
    }
  });
  session.tree=newTree;
  // Invalidate analysis since tree changed
  productLeakAnalysis=[];  // clear all runs — tree structural change invalidates all previous diagnostics
  // Show merge notice
  const retained=dvFlattenMetrics(newTree).filter(m=>m.evidence&&m.evidence.currentValue).length;
  dvShowMergeNotice(retained);
}

function dvShowMergeNotice(retained){
  // Brief toast notification
  const existing=document.getElementById('dv-merge-toast');
  if(existing)existing.remove();
  const toast=document.createElement('div');
  toast.id='dv-merge-toast';
  toast.className='dv-merge-toast';
  toast.textContent='Discovery Map updated. Evidence retained for '+retained+' matching metric'+(retained!==1?'s':'')+'.'
  document.body.appendChild(toast);
  setTimeout(()=>{toast.classList.add('on');},50);
  setTimeout(()=>{toast.classList.remove('on');setTimeout(()=>toast.remove(),400);},4000);
}

// ── Find metric object by _dvId in tree ──
function dvFindMetricById(tree,id){
  for(const st of(tree.stages||[])){
    for(const l1 of(st.l1_metrics||[])){
      if(l1._dvId===id)return l1;
      for(const l2 of(l1.l2_metrics||[])){
        if(l2._dvId===id)return l2;
        for(const l3 of(l2.l3_metrics||[])){
          if(l3._dvId===id)return l3;
        }
      }
    }
  }
  return null;
}

// ── Create diagnostic view (called from CTA) ──
function dvCreate(){
  if(!gData){showToast('Generate a Discovery Map first.','info');return;}
  if(!featDiag){
    showToast('Product Leak Diagnostic is disabled. Enable it in Settings to use this feature.','info');
    return;
  }
  if(diagnosticSessions.length===0){
    // Create fresh session
    const session={
      id:'diag-01',
      name:'Diagnostic 01',
      tree:dvDeepCloneTree(gData),
      readiness:null
    };
    diagnosticSessions=[session];
    activeDiagnosticId='diag-01';
  }
  // Reveal tab and navigate
  revealAndSwitchTab('dv');
}

// ── Render the full Diagnostic View ──
function dvRenderView(){
  const container=document.getElementById('dv-tab');
  if(!container)return;
  if(diagnosticSessions.length===0||!activeDiagnosticId){
    container.innerHTML=dvRenderNoKpiState();
    return;
  }
  const session=diagnosticSessions.find(s=>s.id===activeDiagnosticId);
  if(!session){container.innerHTML=dvRenderNoKpiState();return;}
  session.readiness=dvCalcReadiness(session);
  dvRenderLeftPanel(session);
  dvRenderTreeArea(session);
}

function dvRenderNoKpiState(){
  return`<div class="dv-empty"><div class="dv-empty-icon"><i class="ti ti-chart-tree-map" aria-hidden="true"></i></div><div class="dv-empty-title">Generate a Discovery Map first</div><div class="dv-empty-desc">The diagnostic view uses your generated north star metric and lifecycle Discovery Map as its starting point.</div><button class="dv-empty-btn" onclick="switchTab('mm')"><i class="ti ti-arrow-left" style="font-size:11px;" aria-hidden="true"></i> Go to Discovery Map</button></div>`;
}

function dvRenderLeftPanel(session){
  const lp=document.getElementById('dv-left');
  if(!lp)return;
  const r=session.readiness;
  const pct=r.totalMetrics>0?Math.round((r.metricsWithEvidence/r.totalMetrics)*100):0;
  const readinessColor={'No evidence':'var(--t3)','Partial':'var(--amber)','Good':'var(--blue)','Strong':'var(--green)'}[r.level]||'var(--t3)';
  const isCollapsed=lp.classList.contains('collapsed');
  lp.innerHTML=`
    <div class="dv-lp-header">
      <div class="dv-lp-text-wrap">
        <div class="dv-lp-eyebrow">Diagnostics</div>
        <div class="dv-lp-sub">Add evidence, then run analysis</div>
      </div>
      <button class="dv-collapse-btn" onclick="dvTogglePanel()" title="${isCollapsed?'Expand':'Collapse'} panel">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          ${isCollapsed?'<polyline points="9 18 15 12 9 6"/><polyline points="3 18 9 12 3 6"/>':'<polyline points="15 18 9 12 15 6"/><polyline points="21 18 15 12 21 6"/>'}
        </svg>
      </button>
    </div>
    <div class="dv-lp-body">
      <div class="dv-session-card">
        <div class="dv-session-dot"></div>
        <div class="dv-session-info">
          <div class="dv-session-name">${e(session.name)}</div>
          <div class="dv-session-meta">Active &middot; ${r.metricsWithEvidence} of ${r.totalMetrics} metrics have evidence</div>
        </div>
      </div>
      <div class="dv-readiness-block">
        <div class="dv-readiness-label">Diagnostic readiness</div>
        <div class="dv-readiness-level" style="color:${readinessColor}">${r.level}</div>
        <div class="dv-readiness-detail">
          ${r.metricsWithEvidence} of ${r.totalMetrics} metrics have evidence<br>
          ${r.notInstrumentedCount>0?r.notInstrumentedCount+' metric'+(r.notInstrumentedCount!==1?'s':'')+' not instrumented<br>':''}
          ${r.strongestStage?r.strongestStage+' has most coverage':''}
        </div>
        <div class="dv-readiness-bar"><div class="dv-readiness-fill" style="width:${pct}%;background:${readinessColor}"></div></div>
      </div>
      <div class="dv-lp-hint"><i class="ti ti-info-circle" style="font-size:12px;flex-shrink:0;" aria-hidden="true"></i><span>Click any metric to expand, then use the evidence trigger to add data.</span></div>
    </div>`;
}

function dvToggleBanner(){
  dvBannerCollapsed=!dvBannerCollapsed;
  const body=document.getElementById('dv-model-banner-body');
  const toggle=document.getElementById('dv-model-banner-toggle');
  if(body)body.style.display=dvBannerCollapsed?'none':'block';
  if(toggle)toggle.textContent=dvBannerCollapsed?'show ▼':'hide ▲';
}

function dvTogglePanel(){
  const lp=document.getElementById('dv-left');
  if(!lp)return;
  lp.classList.toggle('collapsed');
  const session=diagnosticSessions.find(s=>s.id===activeDiagnosticId);
  if(session)dvRenderLeftPanel(session);
}


function dvRenderTreeArea(session){
  const area=document.getElementById('dv-tree-area');
  if(!area)return;
  const tree=session.tree;
  let h='';
  h+=`<div class="nsm-node"><div class="nsm-lbl">North Star Metric</div><div class="nsm-val">${e(tree.nsm.metric)}</div><div class="nsm-def">${e(tree.nsm.definition)}</div></div>`;
  // Measurement model banner — full structure, collapsed by default (dvBannerCollapsed=true)
  const dvMM=tree.measurementModel||gData&&gData.measurementModel||null;
  if(dvMM&&dvMM.modelName){
    const dvPills=(dvMM.frameworks||[]).map(f=>`<span class="mm-fw-pill">${e(f)}</span>`).join('');
    h+=`<div class="mm-model-banner" id="dv-model-banner">`;
    h+=`<div class="mm-banner-hdr">`;
    h+=`<div class="mm-banner-left"><i class="ti ti-book" aria-hidden="true"></i><span class="mm-model-name">${e(dvMM.modelName)}</span>${dvPills?'<span class="mm-fw-pills">'+dvPills+'</span>':''}</div>`;
    h+=`<button class="mm-banner-toggle" id="dv-model-banner-toggle" onclick="dvToggleBanner()">${dvBannerCollapsed?'show ▼':'hide ▲'}</button>`;
    h+=`</div>`;
    h+=`<div class="mm-banner-body" id="dv-model-banner-body" style="${dvBannerCollapsed?'display:none':''}">`;
    if(dvMM.rationale)h+=`<p class="mm-banner-rationale">${e(dvMM.rationale)}</p>`;
    h+=`</div>`;
    h+=`</div>`;
  }
  // Scroll hint for >4 stages
  if((tree.stages||[]).length>4){
    h+=`<div class="mm-scroll-hint"><i class="ti ti-arrow-right" aria-hidden="true"></i> ${tree.stages.length} stages &mdash; scroll horizontally to see all</div>`;
  }
  h+=`<div class="stages">`;
  (tree.stages||[]).forEach((st,idx)=>{
    if(!st||!st.id)return;
    const stLabel=st.label||st.id;
    const color=typeof STAGE_PALETTE!=='undefined'?STAGE_PALETTE[idx%STAGE_PALETTE.length]:'#0F5FDC';
    const l1list=Array.isArray(st.l1_metrics)&&st.l1_metrics.length>0?st.l1_metrics:null;
    h+=`<div class="sc"><div class="sh" style="background:${color}"><div class="sh-lbl">Stage ${idx+1}</div><div class="sh-title">${e(stLabel)}</div></div>`;
    if(!l1list){
      h+=`<div class="stage-empty"><div class="stage-empty-icon"><i class="ti ti-minus" aria-hidden="true"></i></div><div class="stage-empty-msg">No KPIs for this stage</div></div>`;
    }else{
      l1list.forEach((l1,li)=>{
        if(!l1||!l1.name)return;
        const lid=`dv-l1-${st.id}-${li}`;
        const evStr=dvCalcEvidenceStrength(l1.evidence);
        const dotCls=dvEvidenceDotClass(evStr);
        h+=`<div class="l1 dv-metric" id="${lid}" onclick="dvTogMetric('${lid}')">`;
        h+=`<div class="l1-hdr"><div class="l1-info"><div class="l1-name">${e(l1.name)}<span class="dv-ev-dot ${dotCls}" title="${evStr}"></span></div>`;
        if(l1.evidence&&l1.evidence.currentValue)h+=`<div class="dv-current-val">${e(l1.evidence.currentValue)}${l1.evidence.trend?' &middot; '+e(l1.evidence.trend):''}</div>`;
        h+=`</div><div class="exp">+</div></div>`;
        // L1 kids
        h+=`<div class="l1-kids">`;
        (l1.l2_metrics||[]).forEach((l2,l2i)=>{
          if(!l2||!l2.name)return;
          const l2id=`dv-l2-${st.id}-${li}-${l2i}`;
          const ev2=dvCalcEvidenceStrength(l2.evidence);
          h+=`<div class="l2 dv-metric" id="${l2id}" onclick="event.stopPropagation();dvTogMetric('${l2id}')">`;
          h+=`<div class="l2-name"><span class="dv-ev-dot ${dvEvidenceDotClass(ev2)}" style="width:6px;height:6px;" title="${ev2}"></span>${e(l2.name)}</div>`;
          if(l2.evidence&&l2.evidence.currentValue)h+=`<div class="dv-current-val" style="margin-left:14px;">${e(l2.evidence.currentValue)}</div>`;
          // L2 kids
          h+=`<div class="l2-kids">`;
          (l2.l3_metrics||[]).forEach((l3,l3i)=>{
            if(!l3||!l3.name)return;
            const ev3=dvCalcEvidenceStrength(l3.evidence);
            h+=`<div class="l3 dv-metric" onclick="event.stopPropagation();">`;
            h+=`<div class="l3-name"><span class="dv-ev-dot ${dvEvidenceDotClass(ev3)}" style="width:5px;height:5px;" title="${ev3}"></span>${e(l3.name)}</div>`;
            h+=`<button class="cap-trigger cap-trigger-xs" onclick="event.stopPropagation();dvOpenEvidenceDrawer('${e(l3._dvId)}','${e(l3.name)}','${e(stLabel)}','L3')">`;
            h+=dvEvidenceTriggerLabel(l3.evidence);
            h+=`</button>`;
            h+=`</div>`;
          });
          h+=`</div>`;
          h+=`<button class="cap-trigger cap-trigger-sm" onclick="event.stopPropagation();dvOpenEvidenceDrawer('${e(l2._dvId)}','${e(l2.name)}','${e(stLabel)}','L2')">`;
          h+=dvEvidenceTriggerLabel(l2.evidence);
          h+=`</button>`;
          h+=`</div>`;
        });
        h+=`</div>`;
        // L1 evidence trigger — same size as L1 cap-trigger
        h+=`<button class="cap-trigger" onclick="event.stopPropagation();dvOpenEvidenceDrawer('${e(l1._dvId)}','${e(l1.name)}','${e(stLabel)}','L1')">`;
        h+=dvEvidenceTriggerLabel(l1.evidence);
        h+=`</button>`;
        h+=`</div>`;
      });
    }
    h+=`</div>`;
  });
  h+=`</div>`;
  area.innerHTML=h;
  // Render analyze bottom bar
  dvRenderAnalyzeBar(session);
}

function dvRenderAnalyzeBar(session){
  const existing=document.getElementById('dv-analyze-bar');
  if(existing)existing.remove();
  const treeArea=document.getElementById('dv-tree-area');
  if(!treeArea)return;
  const r=session?session.readiness:null;
  const hasEvidence=r&&r.metricsWithEvidence>0;
  const bar=document.createElement('div');
  bar.id='dv-analyze-bar';
  bar.className='dv-analyze-bar';
  bar.innerHTML=`
    <span class="dv-analyze-bar-hint">${hasEvidence?r.metricsWithEvidence+' of '+r.totalMetrics+' metrics have evidence':'Add evidence to any metric to run analysis'}</span>
    <button class="dv-analyze-bar-btn" id="dv-analyze-btn" onclick="dvAnalyze()" ${hasEvidence?'':'disabled'}>
      <i class="ti ti-microscope" style="font-size:12px;" aria-hidden="true"></i> Analyze Product Leak
    </button>`;
  const layout=document.getElementById('dv-right-col');
  if(layout)layout.appendChild(bar);
}

function dvEvidenceTriggerLabel(ev){
  const hasEvidence=ev&&(ev.currentValue||ev.previousValue||ev.targetBenchmark||ev.trend||ev.notes||ev.instrumentationStatus);
  const _canEditDvTrigger=(typeof canEditSession!=='function')||canEditSession();
  if(hasEvidence&&_canEditDvTrigger)return`<i class="ti ti-pencil" style="font-size:10px;" aria-hidden="true"></i> Edit evidence &#8594;`;
  return`Evidence &#8594;`;
}

function dvEvidenceDotClass(evStr){
  if(evStr==='Strong evidence')return'dv-dot-green';
  if(evStr==='Moderate evidence'||evStr==='Weak evidence')return'dv-dot-amber';
  if(evStr==='Instrumentation gap')return'dv-dot-red';
  return'dv-dot-gray';
}

function dvTogMetric(id){
  const el=document.getElementById(id);
  if(el)el.classList.toggle('open');
}

// ── Evidence Drawer ──
function dvOpenEvidenceDrawer(metricId,metricName,stageName,level){
  // Close DD panel if open — only one right panel at a time
  if(typeof ccCloseDDPanel==='function')ccCloseDDPanel();
  const session=diagnosticSessions.find(s=>s.id===activeDiagnosticId);
  if(!session)return;
  const metric=dvFindMetricById(session.tree,metricId);
  if(!metric)return;
  diagEvidenceDrawerMetricId=metricId;
  const ev=metric.evidence||{currentValue:'',previousValue:'',targetBenchmark:'',trend:'',instrumentationStatus:'',notes:''};
  const evStr=dvCalcEvidenceStrength(ev);
  const drawer=document.getElementById('kpi-evidence-drawer');
  if(!drawer)return;
  // Push KPI tree content left — same as DD panel
  const ob=document.getElementById('out-body');
  if(ob)ob.style.marginRight='440px';
  const strColors={'Strong evidence':'var(--green)','Moderate evidence':'var(--amber)','Weak evidence':'var(--amber)','Instrumentation gap':'var(--red)','No evidence':'var(--t3)'};
  const strBg={'Strong evidence':'#e8f5f3','Moderate evidence':'#fff4d7','Weak evidence':'#fff4d7','Instrumentation gap':'#fde8e8','No evidence':'var(--card)'};
  const strBorder={'Strong evidence':'#a3d9d4','Moderate evidence':'#efd58d','Weak evidence':'#efd58d','Instrumentation gap':'#efb5b5','No evidence':'var(--divider)'};
  const strDesc={'Strong evidence':'Current value, previous value, target, and/or trend filled','Moderate evidence':'Current value filled — add trend or target for stronger signal','Weak evidence':'Notes or partial data only — add current values for better analysis','Instrumentation gap':'Metric is not tracked — flag for instrumentation before analysis','No evidence':'No data entered yet for this metric'};
  const trendOpts=['','Improving','Flat','Declining','Unknown'].map(v=>`<option value="${v}"${ev.trend===v?' selected':''}>${v||'Select trend'}</option>`).join('');
  const instOpts=['','Instrumented','Partially instrumented','Not instrumented','Unknown'].map(v=>`<option value="${v}"${ev.instrumentationStatus===v?' selected':''}>${v||'Select status'}</option>`).join('');
  // v9.08.02: computed once per drawer open. Per project rule, standalone
  // action buttons (Save/Clear) are hidden; inline-editable fields are
  // readonly/disabled rather than hidden, so the panel remains readable.
  const _canEditDvEv=(typeof canEditSession!=='function')||canEditSession();
  drawer.innerHTML=`
    <div class="dv-drawer-head">
      <div class="dv-drawer-head-text">
        <div class="dv-drawer-eyebrow">Metric Evidence</div>
        <div class="dv-drawer-sub">${e(metricName)} &middot; ${e(stageName)} &middot; ${e(level)}</div>
      </div>
      <button class="dv-drawer-close" onclick="dvCloseEvidenceDrawer()" aria-label="Close"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="dv-drawer-body">
      <div class="dv-field"><label class="dv-field-lbl">Current value</label><input type="text" class="dv-field-input" id="dvf-current" value="${e(ev.currentValue||'')}" placeholder="e.g. 38%, 3.4 days, Unknown" ${_canEditDvEv?'':'readonly'}/></div>
      <div class="dv-field"><label class="dv-field-lbl">Previous value</label><input type="text" class="dv-field-input" id="dvf-previous" value="${e(ev.previousValue||'')}" placeholder="e.g. 44% last month, Unknown" ${_canEditDvEv?'':'readonly'}/></div>
      <div class="dv-field"><label class="dv-field-lbl">Target / benchmark</label><input type="text" class="dv-field-input" id="dvf-target" value="${e(ev.targetBenchmark||'')}" placeholder="e.g. 65%, Same-day activation" ${_canEditDvEv?'':'readonly'}/></div>
      <div class="dv-field-row">
        <div class="dv-field"><label class="dv-field-lbl">Trend</label><select class="dv-field-select" id="dvf-trend" ${_canEditDvEv?'':'disabled'}>${trendOpts}</select></div>
        <div class="dv-field"><label class="dv-field-lbl">Instrumentation</label><select class="dv-field-select" id="dvf-inst" ${_canEditDvEv?'':'disabled'}>${instOpts}</select></div>
      </div>
      <div class="dv-field"><label class="dv-field-lbl">Notes</label><textarea class="dv-field-textarea" id="dvf-notes" placeholder="e.g. Drop-off seems highest after step 2..." ${_canEditDvEv?'':'readonly'}>${e(ev.notes||'')}</textarea></div>
      <div class="dv-ev-strength-bar" style="background:${strBg[evStr]};border-color:${strBorder[evStr]};" id="dv-strength-bar">
        <div class="dv-ev-strength-lbl">Evidence strength</div>
        <div class="dv-ev-strength-val" style="color:${strColors[evStr]};" id="dv-strength-val">${evStr}</div>
        <div class="dv-ev-strength-desc" id="dv-strength-desc">${strDesc[evStr]}</div>
      </div>
    </div>
    ${_canEditDvEv?`<div class="dv-drawer-footer">
      <button class="dv-drawer-clear" onclick="dvClearEvidence()">Clear</button>
      <button class="dv-drawer-save" onclick="dvSaveEvidence()">Save Evidence</button>
    </div>`:''}`;
  drawer.classList.add('open');
  if(typeof syncRightPanelBodyState==='function')syncRightPanelBodyState();
  // Live update strength as user types
  ['dvf-current','dvf-previous','dvf-target','dvf-trend','dvf-inst','dvf-notes'].forEach(fid=>{
    const el=document.getElementById(fid);
    if(el)el.addEventListener('input',dvUpdateStrengthLive);
  });
}

function dvUpdateStrengthLive(){
  const ev={
    currentValue:(document.getElementById('dvf-current')||{}).value||'',
    previousValue:(document.getElementById('dvf-previous')||{}).value||'',
    targetBenchmark:(document.getElementById('dvf-target')||{}).value||'',
    trend:(document.getElementById('dvf-trend')||{}).value||'',
    instrumentationStatus:(document.getElementById('dvf-inst')||{}).value||'',
    notes:(document.getElementById('dvf-notes')||{}).value||''
  };
  const evStr=dvCalcEvidenceStrength(ev);
  const strColors={'Strong evidence':'var(--green)','Moderate evidence':'var(--amber)','Weak evidence':'var(--amber)','Instrumentation gap':'var(--red)','No evidence':'var(--t3)'};
  const strDesc={'Strong evidence':'Current value, previous value, target, and/or trend filled','Moderate evidence':'Current value filled — add trend or target for stronger signal','Weak evidence':'Notes or partial data only — add current values for better analysis','Instrumentation gap':'Metric is not tracked — flag for instrumentation before analysis','No evidence':'No data entered yet for this metric'};
  const valEl=document.getElementById('dv-strength-val');
  const descEl=document.getElementById('dv-strength-desc');
  if(valEl){valEl.textContent=evStr;valEl.style.color=strColors[evStr]||'var(--t3)';}
  if(descEl)descEl.textContent=strDesc[evStr]||'';
}

function dvCloseEvidenceDrawer(){
  const drawer=document.getElementById('kpi-evidence-drawer');
  if(drawer)drawer.classList.remove('open');
  diagEvidenceDrawerMetricId=null;
  const ob=document.getElementById('out-body');
  if(ob)ob.style.marginRight='';
  if(typeof syncRightPanelBodyState==='function')syncRightPanelBodyState();
}

function dvSaveEvidence(){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  if(!diagEvidenceDrawerMetricId)return;
  const session=diagnosticSessions.find(s=>s.id===activeDiagnosticId);
  if(!session)return;
  const metric=dvFindMetricById(session.tree,diagEvidenceDrawerMetricId);
  if(!metric)return;
  metric.evidence={
    currentValue:(document.getElementById('dvf-current')||{}).value||'',
    previousValue:(document.getElementById('dvf-previous')||{}).value||'',
    targetBenchmark:(document.getElementById('dvf-target')||{}).value||'',
    trend:(document.getElementById('dvf-trend')||{}).value||'',
    instrumentationStatus:(document.getElementById('dvf-inst')||{}).value||'',
    notes:(document.getElementById('dvf-notes')||{}).value||''
  };
  dvCloseEvidenceDrawer();
  // Re-evaluate Run Diagnostics button state
  if(typeof kpiUpdateRunDiagnosticsBtn==='function')kpiUpdateRunDiagnosticsBtn();
  // Reflect evidence state on KPI tree metric nodes
  if(typeof kpiRenderEvidenceStates==='function')kpiRenderEvidenceStates();
  // Re-render diagnostic view to update dots and triggers
  session.readiness=dvCalcReadiness(session);
  dvRenderLeftPanel(session);
  dvRenderTreeArea(session);
  // Refresh Story Canvas evidence chips if canvas has features
  if(typeof fcRenderCanvas==='function'&&scCanvas&&scCanvas.length>0){
    fcRenderCanvas();
  }
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId)sessionStoreSave(_activeSessionId);
}

function dvClearEvidence(){
  ['dvf-current','dvf-previous','dvf-target','dvf-notes'].forEach(id=>{
    const el=document.getElementById(id);
    if(el)el.value='';
  });
  ['dvf-trend','dvf-inst'].forEach(id=>{
    const el=document.getElementById(id);
    if(el)el.value='';
  });
  dvUpdateStrengthLive();
}

// ── Analyze Product Leak ──

// ── Evidence snapshot builder ──
// Stores only structured fields (not free text notes) for diff comparison.
function _dvBuildEvidenceSnapshot(stagesWithEvidence){
  var snap={};
  stagesWithEvidence.forEach(function(st){
    (st.l1_metrics||[]).forEach(function(l1){
      if(l1.evidenceStrength!=='No evidence'&&l1.evidence){
        snap[l1.name]={
          currentValue:l1.evidence.currentValue||'',
          trend:l1.evidence.trend||'',
          targetBenchmark:l1.evidence.targetBenchmark||'',
          instrumentationStatus:l1.evidence.instrumentationStatus||'',
          hasEvidence:true
        };
      }
    });
  });
  return snap;
}

// ── Evidence diff ──
// Returns array of {name, changeType:'new'|'updated'} for metrics that changed
// since their last appearance in any prior run's evidenceSnapshot.
// Metrics with no prior snapshot = 'new'. Unchanged = excluded.
function _dvDiffEvidence(currentSnap){
  var changed=[];
  var runs=productLeakAnalysis||[];
  Object.keys(currentSnap).forEach(function(metricName){
    var cur=currentSnap[metricName];
    // Find most recent run that includes this metric
    var lastSnap=null;
    for(var i=runs.length-1;i>=0;i--){
      var runSnap=(runs[i].evidenceSnapshot)||{};
      if(runSnap[metricName]){lastSnap=runSnap[metricName];break;}
    }
    if(!lastSnap){
      changed.push({name:metricName,changeType:'new'});
    } else {
      // Compare structured fields only
      var fields=['currentValue','trend','targetBenchmark','instrumentationStatus'];
      var diff=fields.some(function(f){return (cur[f]||'')!==(lastSnap[f]||'');});
      if(diff)changed.push({name:metricName,changeType:'updated'});
    }
  });
  return changed;
}

// ── dvAnalyzeForce ──
// Called by "Run again anyway" link — bypasses the no-change guard
function dvAnalyzeForce(){
  // Temporarily override forceRun by calling dvAnalyze with a flag
  var _orig=productLeakAnalysis?productLeakAnalysis.length:0;
  // Clear productLeakAnalysis temporarily to bypass guard, then restore
  // Simpler: just call _dvRunAnalysis directly if possible, else call dvAnalyze
  // Since dvAnalyze checks _changedMetrics.length, we need to bypass that check
  // We use the _ssRestoring trick: set a force flag
  window._dvForceRunFlag=true;
  dvAnalyze().then(function(){window._dvForceRunFlag=false;}).catch(function(){window._dvForceRunFlag=false;});
}

async function dvAnalyze(){
  const session=diagnosticSessions.find(s=>s.id===activeDiagnosticId);
  if(!session){return;}
  const readiness=dvCalcReadiness(session);
  if(readiness.metricsWithEvidence===0){
    dvShowNoEvidenceWarning();
    return;
  }
  // v8.133 fix (item 3): courtesy pre-check, for consistency with the
  // other four canvases.
  if(typeof _lsPeekIfLocked==='function' && typeof _activeSessionId!=='undefined' && _activeSessionId){
    const _peek=await _lsPeekIfLocked(_activeSessionId);
    if(_peek.locked){
      showToast(_peek.holderName+' is already generating on this session. Try again in a moment.','warn');
      return;
    }
  }
  // Build product context
  // Use productContext (populated after generation) — fallback to form fields for safety
  const productCtx=productContext||{
    name:gv('f-name'),url:gv('f-url'),description:'',kpis:gv('f-kpis'),
    problem:gv('f-problem'),icp:gv('f-icp'),
    industry:seg.industry,productType:seg.productType,
    measurementModelName:'',frameworks:[]
  };
  // Build stages with evidence for prompt
  const stagesWithEvidence=(session.tree.stages||[]).map(st=>({
    stage:st.label||st.id,
    l1_metrics:(st.l1_metrics||[]).map(l1=>({
      name:l1.name,why:l1.why||'',
      evidence:l1.evidence||null,
      evidenceStrength:dvCalcEvidenceStrength(l1.evidence),
      l2_metrics:(l1.l2_metrics||[]).map(l2=>({
        name:l2.name,
        evidence:l2.evidence||null,
        evidenceStrength:dvCalcEvidenceStrength(l2.evidence),
        l3_metrics:(l2.l3_metrics||[]).map(l3=>({
          name:l3.name,
          evidence:l3.evidence||null,
          evidenceStrength:dvCalcEvidenceStrength(l3.evidence)
        }))
      }))
    }))
  }));
  // Build evidence snapshot and diff against prior runs
  const _evSnap=_dvBuildEvidenceSnapshot(stagesWithEvidence);
  const _changedMetrics=_dvDiffEvidence(_evSnap);
  // Skip if nothing changed — unless user explicitly clicked "Run again anyway"
  if(_changedMetrics.length===0&&(productLeakAnalysis&&productLeakAnalysis.length>0)&&!window._dvForceRunFlag){
    return;
  }
  // Phase 5 (v8.117): immediate button-disable, matching the same pattern
  // used across all 10 wrapped functions — dvShowAnalyzeLoading(true) does
  // BOTH the button-disable AND the overlay creation in one call, so
  // calling it in full here (as the original code did) would show the
  // rich "Analyzing..." overlay before the lock check even runs. Doing
  // the button-disable inline here instead, and deferring the overlay
  // itself into _dvRunAnalysis() (inside the lock callback).
  const _diagBtn=document.getElementById('diag-run-btn');
  if(_diagBtn){_diagBtn.disabled=true;_diagBtn.innerHTML=`<span class="dv-spin"></span> Analyzing...`;}
  const _diagRefineBtn=document.getElementById('diag-refine-btn');
  if(_diagRefineBtn){_diagRefineBtn.disabled=true;_diagRefineBtn.style.opacity='0.45';_diagRefineBtn.style.pointerEvents='none';}
  const _diagRefineSend=document.getElementById('diag-refine-send');
  if(_diagRefineSend){_diagRefineSend.disabled=true;}
  const _diagSignal=startAiGen('Your diagnostic analysis is running. Leaving now discards it — you\'ll need to re-run from scratch.');
  _dvRunAnalysis(stagesWithEvidence,_evSnap,_changedMetrics,false,_diagSignal);
} // end dvAnalyze

async function _dvRunAnalysis(stagesWithEvidence,evSnap,changedMetrics,forceRun,_diagSignal){
  const session=diagnosticSessions.find(s=>s.id===activeDiagnosticId);
  if(!session)return;
  const readiness=dvCalcReadiness(session);
  const productCtx=productContext||{name:gv('f-name'),url:gv('f-url'),description:'',kpis:gv('f-kpis'),
    problem:gv('f-problem'),icp:gv('f-icp'),
    industry:seg.industry,productType:seg.productType,measurementModelName:'',frameworks:[]};
  if(!_diagSignal)_diagSignal=startAiGen('Your diagnostic analysis is running. Leaving now discards it — you\'ll need to re-run from scratch.');
  // Phase 5 (v8.117): attempt marker, stamped onto the overlay once it's
  // created below (inside the lock callback, after acquisition confirmed).
  const _attempt=newGenAttempt();
  // Phase 5: withGenerationLock wraps callAPI through the productLeakAnalysis
  // push and sessionStoreSave().
  try{
    await withGenerationLock(async (_lock) => {
  // Lock confirmed — show the real loading overlay now (button was
  // already disabled immediately in dvAnalyze(), before the lock check).
  dvShowAnalyzeLoading(true);
  var _dvOverlay=document.getElementById('dv-analyze-overlay');
  if(_dvOverlay) _dvOverlay.setAttribute('data-gen-attempt',_attempt.id);
  // Phase 5 (v8.117): local helper for the self-attribute marker check —
  // NOT the standard getIfCurrentAttempt helper, which checks DESCENDANTS
  // via querySelector and would never match an attribute set directly on
  // the container itself (confirmed via the same querySelector-scope
  // issue caught and fixed in kpi-tree.js's generateConfirmed()).
  function _dvOverlayStillCurrent(){
    var el=document.getElementById('dv-analyze-overlay');
    return !!(el&&el.getAttribute('data-gen-attempt')===_attempt.id);
  }
  try{
    const promptTxt=buildProductLeakPrompt(productCtx,session.tree.nsm,stagesWithEvidence,readiness,changedMetrics);
    const txt=await callAPI(
      'You are a senior product growth diagnostic consultant. Respond ONLY with valid strict JSON. No markdown, no backticks, no preamble. Never use em dashes (—) in your output; use a hyphen (-) or rewrite the phrase.',
      promptTxt,6000,_diagSignal,null,'diagnostic-leak'
    );
    const clean=txt.replace(/```json|```/g,'').trim();
    let parsed;
    try{parsed=JSON.parse(clean);}catch(pe){throw new Error('Analysis response could not be parsed. Please try again.');}
    // Build run metadata
    const _runTs=Date.now();
    const _runId='run-'+_runTs;
    const _runBottleneck=parsed.primaryBottleneckMetric||'Unknown';
    // Auto-generate runLabel: "{bottleneck} · {Mon DD}"
    // If another run exists for the same bottleneck metric on the same date,
    // add time suffix to all same-day runs for that metric (retroactively, unless user renamed)
    const _runDate=new Date(_runTs);
    const _runDateStr=_runDate.toLocaleString('en-US',{month:'short',day:'numeric'});
    const _runTimeStr=_runDate.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false});
    // Find existing runs for same metric
    const _sameDateRuns=productLeakAnalysis.filter(function(r){
      if(r.primaryBottleneckMetric!==_runBottleneck)return false;
      const rd=new Date(r.runTimestamp);
      const rdStr=rd.toLocaleString('en-US',{month:'short',day:'numeric'});
      return rdStr===_runDateStr;
    });
    // Retroactively add time suffix to existing same-day same-metric runs (if not custom-named)
    if(_sameDateRuns.length>0){
      _sameDateRuns.forEach(function(r){
        if(!r.runCustomName){
          const rd=new Date(r.runTimestamp);
          const rt=rd.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false});
          r.runLabel=r.primaryBottleneckMetric+' · '+_runDateStr+', '+rt;
        }
      });
    }
    // Label for this new run
    var _runLabel;
    if(_sameDateRuns.length>0){
      // Same metric, same day — include time
      _runLabel=_runBottleneck+' · '+_runDateStr+', '+_runTimeStr;
    } else {
      // Check if any run exists for this metric on a different day
      const _anyOtherDay=productLeakAnalysis.some(function(r){
        return r.primaryBottleneckMetric===_runBottleneck;
      });
      if(_anyOtherDay){
        _runLabel=_runBottleneck+' · '+_runDateStr;
      } else {
        _runLabel=_runBottleneck+' · '+_runDateStr;
      }
    }
    // Attach run metadata to parsed result and append
    parsed.runId=_runId;
    parsed.runLabel=_runLabel;
    parsed.runTimestamp=_runTs;
    parsed.runCustomName=false;
    parsed.evidenceSnapshot=evSnap||{};
    // v9.11 (Outcome Pulse Iteration Loop): explicit provenance marker, added
    // for symmetry with the new outcome-pulse-sourced synthetic runs
    // (outcome-pulse.js). Every run-source READ elsewhere must still default
    // missing source to 'diagnostic' — legacy saved sessions have runs with
    // no source field at all, predating this change.
    parsed.source='diagnostic';
    productLeakAnalysis.push(parsed);
    // New run becomes active; reset selection state
    if(typeof _laActiveRunId!=='undefined') _laActiveRunId=_runId;
    leakSelectedIds=new Set();
    // Phase 5 (v8.117): marker-guarded via the local self-attribute helper above.
    if(_dvOverlayStillCurrent()){dvShowAnalyzeLoading(false);}
    endAiGen();
    // Phase 5: checkpoint immediately before the save.
    _lock.throwIfLost();
    if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
      const _ok=await sessionStoreSave(_activeSessionId);
      if(_ok&&typeof _activeSessionIsShared!=='undefined'&&_activeSessionIsShared&&typeof _lsEmitContentEvent==='function'){
        await _lsEmitContentEvent(_activeSessionId,'la','diagnostic_generated',null,null);
      }
    }
    // Reveal Product Leak Analysis tab and navigate
    revealAndSwitchTab('la');
  }catch(err){
    // Phase 5 (v8.117): marker-guarded — a stale attempt's failure must
    // not tear down a newer attempt's own loading overlay.
    if(_dvOverlayStillCurrent()){dvShowAnalyzeLoading(false);}
    if(err.name==='AbortError'){
      endAiGen();
      // Phase 5: rethrow rather than return — see pi-planning.js for the
      // full rationale (adversarial review Finding 1).
      throw err;
    }
    if(err.message==='generation_lock_lost'){
      endAiGen();
      throw err;
    }
    endAiGen();
    const errEl=document.getElementById('dv-analyze-error');
    if(errEl){errEl.textContent='Error: '+err.message;errEl.style.display='block';}
  }
    });
  }catch(lockErr){
    // Phase 5 (v8.117): since the overlay is only ever created/stamped
    // INSIDE the lock callback now, a pre-flight rejection
    // (generation_lock_not_acquired/unknown/already_running_locally)
    // never created an overlay for THIS attempt at all — calling
    // dvShowAnalyzeLoading(false) unconditionally here would tear down
    // whatever overlay happens to exist right now, which could belong to
    // a genuinely different, currently-running attempt. Only the button-
    // disable state set in dvAnalyze() (before the lock check) needs
    // resetting here — but since that was done via direct DOM manipulation
    // rather than dvShowAnalyzeLoading's own button logic, re-query and
    // reset those specific buttons directly instead.
    var _lockErrBtn=document.getElementById('diag-run-btn');
    if(_lockErrBtn){_lockErrBtn.disabled=false;_lockErrBtn.innerHTML='<i class="ti ti-microscope" style="font-size:12px;" aria-hidden="true"></i> Run Diagnostics';}
    var _lockErrRefineBtn=document.getElementById('diag-refine-btn');
    if(_lockErrRefineBtn){_lockErrRefineBtn.disabled=false;_lockErrRefineBtn.style.opacity='';_lockErrRefineBtn.style.pointerEvents='';}
    var _lockErrRefineSend=document.getElementById('diag-refine-send');
    if(_lockErrRefineSend){_lockErrRefineSend.disabled=false;}
  }
}

const DV_ANALYZE_HEADS=[
  'Mapping your metric evidence...',
  'Identifying the primary growth leak...',
  'Scoring evidence strength per stage...',
  'Pinpointing the bottleneck metric...',
  'Designing prioritized experiments...',
  'Building your diagnostic report...'
];
const DV_ANALYZE_SUBS=[
  'Cross-referencing your KPI tree with available data.',
  'Looking for where growth is most likely leaking.',
  'Moderate evidence is still diagnostic evidence.',
  'One bottleneck usually drives the cascade.',
  'Experiments are linked to your KPI tree metrics.',
  'Almost there — your analysis is nearly ready.'
];

function dvShowAnalyzeLoading(show){
  const btn=document.getElementById('diag-run-btn');
  const refineBtn=document.getElementById('diag-refine-btn');
  const refineSend=document.getElementById('diag-refine-send');
  const layout=document.getElementById('out-body');
  if(show){
    if(btn){btn.disabled=true;btn.innerHTML=`<span class="dv-spin"></span> Analyzing...`;}
    if(refineBtn){refineBtn.disabled=true;refineBtn.style.opacity='0.45';refineBtn.style.pointerEvents='none';}
    if(refineSend){refineSend.disabled=true;}
    if(!document.getElementById('dv-analyze-overlay')&&layout){
      const overlay=document.createElement('div');
      overlay.id='dv-analyze-overlay';
      overlay.className='dv-analyze-overlay';
      let hi=0;
      overlay.innerHTML=`
        <div class="dv-analyze-loader">
          <div class="spin" style="width:48px;height:48px;border-color:rgba(95,30,190,0.15);border-top-color:var(--purple);"></div>
          <div class="dv-al-head" id="dv-al-head">${DV_ANALYZE_HEADS[0]}</div>
          <div class="dv-al-sub" id="dv-al-sub">${DV_ANALYZE_SUBS[0]}</div>
          <div class="dv-al-steps" id="dv-al-steps">
            ${DV_ANALYZE_HEADS.map((h,i)=>`<div class="ls${i===0?' act':''}" id="dvals${i}"><div class="ls-dot"></div>${h}</div>`).join('')}
          </div>
        </div>`;
      layout.appendChild(overlay);
      let stepIdx=0;
      overlay._hT=setInterval(()=>{
        hi=(hi+1)%DV_ANALYZE_HEADS.length;
        const hEl=document.getElementById('dv-al-head');
        const sEl=document.getElementById('dv-al-sub');
        if(hEl)hEl.textContent=DV_ANALYZE_HEADS[hi];
        if(sEl)sEl.textContent=DV_ANALYZE_SUBS[hi%DV_ANALYZE_SUBS.length];
      },3200);
      overlay._sT=setInterval(()=>{
        const cur=document.getElementById('dvals'+stepIdx);
        if(cur){cur.classList.remove('act');cur.classList.add('done');}
        stepIdx=Math.min(stepIdx+1,DV_ANALYZE_HEADS.length-1);
        const nxt=document.getElementById('dvals'+stepIdx);
        if(nxt)nxt.classList.add('act');
      },2800);
    }
  }else{
    const overlay=document.getElementById('dv-analyze-overlay');
    if(overlay){clearInterval(overlay._hT);clearInterval(overlay._sT);overlay.remove();}
    if(btn){
      btn.disabled=false;
      btn.innerHTML=`<i class="ti ti-microscope" style="font-size:12px;" aria-hidden="true"></i> Run Diagnostics`;
    }
    if(refineBtn){refineBtn.disabled=false;refineBtn.style.opacity='';refineBtn.style.pointerEvents='';}
    if(refineSend){refineSend.disabled=false;}
  }
}

function dvShowNoEvidenceWarning(){
  const existing=document.getElementById('dv-no-ev-modal');
  if(existing)existing.remove();
  const modal=document.createElement('div');
  modal.id='dv-no-ev-modal';
  modal.className='dv-modal-overlay';
  modal.innerHTML=`<div class="dv-modal">
    <div class="dv-modal-icon"><i class="ti ti-alert-triangle" aria-hidden="true"></i></div>
    <div class="dv-modal-title">Add metric evidence first</div>
    <div class="dv-modal-body">The product leak analysis needs at least some metric values, trends, instrumentation status, or notes to identify where the product may be leaking growth.<br><br>You do not need to complete every metric. Add evidence to one or more metrics, then run the analysis.</div>
    <div class="dv-modal-footer"><button class="dv-modal-ok" onclick="document.getElementById('dv-no-ev-modal').remove()">Got it</button></div>
  </div>`;
  document.body.appendChild(modal);
}
