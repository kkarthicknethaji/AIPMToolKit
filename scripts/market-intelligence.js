// ── MARKET INTELLIGENCE ──
// Owns: miGenerate, miRenderScreen, miRenderLeftPanel, miRenderMarketSnapshot,
//       miRenderTrends, miRenderCompetitors, miRenderSWOT, miRenderCapabilities,
//       miAlignCapabilities, miGenerateFeatures, miToggleExpansion,
//       miUpdateCheckboxCount, miSendToCanvas, miUndoSend, miDownloadDocx

let miGenerating=false; // guard — prevents switchTab from overwriting loader

// ── Toast helper ──
function miShowToast(msg, linkLabel, linkAction){
  let t=document.getElementById('mi-toast');
  if(!t){
    t=document.createElement('div');
    t.id='mi-toast';
    t.className='mi-toast';
    document.body.appendChild(t);
  }
  t.innerHTML=msg+(linkLabel?` <span class="mi-toast-link" onclick="${linkAction}">${linkLabel}</span>`:'');
  t.classList.add('on');
  setTimeout(()=>t.classList.remove('on'),6000);
}

// ── Main generate function ──
async function miGenerate(){
  const key=getKey();
  if(miGenerating) return; // prevent double-trigger
  if(aiGenInFlight.active){showToast("Still working on your last request. Hang tight, this won't take long.",'info');return;}
  // v8.133 fix (item 3): courtesy pre-check, for consistency with the
  // other four canvases — MI has no confirm dialog to avoid here, but this
  // still avoids transitioning into the loading UI before discovering a
  // conflict that was already knowable.
  if(typeof _lsPeekIfLocked==='function' && typeof _activeSessionId!=='undefined' && _activeSessionId){
    const _peek=await _lsPeekIfLocked(_activeSessionId);
    if(_peek.locked){
      showToast(_peek.holderName+' is already generating on this session. Try again in a moment.','warn');
      return;
    }
  }
  const ctx=productContext||{
    name:document.getElementById('f-name').value.trim(),
    description:document.getElementById('f-desc').value.trim(),
    industry:seg.industry,
    productType:seg.productType,
    icp:document.getElementById('f-icp').value.trim(),
    kpis:document.getElementById('f-kpis').value.trim(),
    problem:document.getElementById('f-problem').value.trim(),
    url:document.getElementById('f-url').value.trim(),
    additionalContext:document.getElementById('f-context')&&document.getElementById('f-context').value.trim()
  };

  if(!ctx.name||!ctx.description){
    showToast('Please fill in Product Name and description before generating Market Intelligence.','warn');
    return;
  }

  miGenerating=true;
  miSelectedCapNames=new Set(); // clear any pending selections from prior generation
  miRenderLeftPanel(); // Immediately disable CTA button
  const miTabBtn=document.getElementById('tab-mi');
  if(miTabBtn) miTabBtn.style.display='';
  // Switch tab directly — bypasses the miGenerated check in switchTab
  const prevTab=curTab;
  curTab='mi';
  ['mm','dd','mi','dv','la','sc'].forEach(id=>{
    const el=document.getElementById('tab-'+id);
    if(el) el.classList.toggle('active',id==='mi');
  });
  const ob=document.getElementById('out-body');
  const scTab=document.getElementById('fc-tab');
  const dvTab=document.getElementById('dv-tab');
  const laTab=document.getElementById('la-tab');
  const miTabEl=document.getElementById('mi-tab');
  const lp=document.getElementById('left-panel');
  if(ob) ob.style.display='none';
  if(scTab) scTab.classList.remove('on');
  if(dvTab) dvTab.classList.remove('on');
  if(laTab) laTab.classList.remove('on');
  if(miTabEl) miTabEl.classList.add('on');
  const diagBar=document.getElementById('diag-action-bar');
  if(diagBar) diagBar.style.display='none';

  // Establish two-column layout skeleton — keeps #mi-left-panel alive throughout generation
  if(miTabEl){
    miTabEl.innerHTML=`<div class="mi-layout"><div class="mi-left" id="mi-left-panel"></div><div class="mi-right mi-right-empty" id="mi-right-loader"></div></div>`;
    miRenderLeftPanel(); // Populates #mi-left-panel — CTA shows disabled state (miGenerating=true)
  }

  // Phase 5 (v8.117): unlike the other 9 wrapped functions, miGenerate()'s
  // tab-switch and two-column layout skeleton (above) are NOT restructured
  // to wait for lock confirmation — the tab genuinely should switch
  // immediately on click (that's real, correct feedback, not a misleading
  // claim that generation has started). Only the RICH stage-by-stage
  // loader content that follows is at risk of the stale-clobber problem
  // (a slow, superseded miGenerate() call writing stage-loader HTML after
  // the user has navigated away from the MI tab, or after a NEWER
  // miGenerate() call has already written its own content) — that part
  // gets the marker treatment below.
  const _attempt=newGenAttempt();

  // Render Direction A loader inside .mi-right only — never touches #mi-left-panel
  const miRightEl=document.getElementById('mi-right-loader');
  if(miRightEl){
    const stages=LOADER_STAGES_MI;

    function buildLoaderHTML(activeIdx){
      const timelineHtml=stages.map((st,i)=>{
        const nodeState=i<activeIdx?'done':i===activeIdx?'active':'pending';
        const nameState=nodeState;
        const connectorState=i<activeIdx?'done':i===activeIdx?'active':'';
        const isLast=i===stages.length-1;
        return`<div class="mi-loader-stage">
          <div class="mi-loader-stage-left">
            <div class="mi-loader-node ${nodeState}"></div>
            ${!isLast?`<div class="mi-loader-connector ${connectorState}"></div>`:''}
          </div>
          <div class="mi-loader-stage-right">
            <div class="mi-loader-stage-name ${nameState}">${st.label}</div>
            ${i===activeIdx?`<div class="mi-loader-submsg" id="mi-load-submsg">${st.messages[0]}</div>`:''}
          </div>
        </div>`;
      }).join('');
      return`<div class="mi-loader">
        <div class="mi-loader-inner">
          <div class="mi-spin"></div>
          <div class="mi-load-stage-label" id="mi-load-title">${stages[activeIdx].label}…</div>
          <div class="mi-loader-timeline">${timelineHtml}</div>
          <div class="mi-load-note">AI-generated from training data · verify statistics independently before client use</div>
        </div>
      </div>`;
    }

    miRightEl.innerHTML=markGenAttempt(_attempt,buildLoaderHTML(0));

    let stageIdx=0, msgIdx=0;
    let miMsgTimer=setInterval(()=>{
      const msgs=stages[stageIdx].messages;
      msgIdx=(msgIdx+1)%msgs.length;
      const el=document.getElementById('mi-load-submsg');
      if(el) el.textContent=msgs[msgIdx];
    },12000);

    window._miLoaderAdvance=function(){
      if(stageIdx>=stages.length-1)return;
      // Phase 5 (v8.117): only advance the on-screen stage loader if this
      // attempt still owns #mi-right-loader — a stale, superseded call's
      // advance should not overwrite whatever a newer call (or the user
      // navigating away and back) has since put there.
      if(!getIfCurrentAttempt('mi-right-loader',_attempt))return;
      if(miMsgTimer)clearInterval(miMsgTimer);
      stageIdx++;
      msgIdx=0;
      // Target mi-right-loader only — preserves #mi-left-panel
      const miRight=document.getElementById('mi-right-loader');
      if(miRight) miRight.innerHTML=markGenAttempt(_attempt,buildLoaderHTML(stageIdx));
      const msgs=stages[stageIdx].messages;
      miMsgTimer=setInterval(()=>{
        msgIdx=(msgIdx+1)%msgs.length;
        const el=document.getElementById('mi-load-submsg');
        if(el)el.textContent=msgs[msgIdx];
      },stageIdx===stages.length-1?4000:12000);
    };

    window._miLoaderClear=function(){
      if(miMsgTimer)clearInterval(miMsgTimer);
      window._miLoaderAdvance=null;
      window._miLoaderClear=null;
    };
  }

  // Phase 5: withGenerationLock wraps the ENTIRE workflow — callAPI, parse,
  // validate, apply to miData/miCapabilities, and sessionStoreSave() — not
  // just the callAPI() line. See api.js for the full rationale; pattern
  // mirrors pi-planning.js's piGenerate() exactly.
  try{
    await withGenerationLock(async (_lock) => {
  try{
    const sys=(typeof SYS_MI!=='undefined'?SYS_MI:'');
    const _miCtxFull=Object.assign({},ctx);
    _miCtxFull.companyStrategy=(typeof sessionContext!=='undefined'&&sessionContext&&sessionContext.companyProfile)?sessionContext.companyProfile.companyStrategy||'':'';
    _miCtxFull.companyContext=(typeof sessionContext!=='undefined'&&sessionContext&&sessionContext.companyProfile)?sessionContext.companyProfile.companyContext||'':'';
    var _miDocRes2=(typeof buildDocContext==='function')?buildDocContext('mi',ctx.name):{text:'',truncated:false};
    _miCtxFull.docContext=_miDocRes2.text;
    _fireDocTruncatedToast(_miDocRes2.truncated);
    const usr=buildMarketIntelPrompt(_miCtxFull, gData);
    // 12000 tokens — enough for full screen JSON without docxSections prose
    const _signal=startAiGen(`Your Market Intelligence report for ${ctx.name||'this product'} is being put together. Leaving now discards it, you'll need to regenerate from scratch.`);
    const txt=await callAPI(sys, usr, 12000, _signal, undefined, 'mi-generate');
    // Advance to finalising stage while parsing
    if(window._miLoaderAdvance) window._miLoaderAdvance();
    const clean=txt.replace(/```json|```/g,'').trim();
    let parsed;
    try{parsed=JSON.parse(clean);}
    catch(e){
      const s=clean.indexOf('{');const l=clean.lastIndexOf('}');
      if(s>=0&&l>s){try{parsed=JSON.parse(clean.substring(s,l+1));}catch(e2){throw new Error('Could not parse Market Intelligence response. Please try again.');}}
      else throw new Error('Could not parse Market Intelligence response. Please try again.');
    }
    if(!parsed||!parsed.capabilities)throw new Error('Incomplete response from AI. Please try again.');

    if(window._miLoaderClear) window._miLoaderClear();
    miData=parsed;
    miGenerated=true;
    miGenerating=false;
    miProductMode=parsed.productMode||'market';
    miCapabilities=parsed.capabilities||[];

    miRenderScreen();
    miRenderLeftPanel();
    // Phase 5: checkpoint immediately before the save — see pi-planning.js
    // for the full rationale (second adversarial review round).
    _lock.throwIfLost();
    if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
      const _ok=await sessionStoreSave(_activeSessionId);
      if(_ok&&typeof _activeSessionIsShared!=='undefined'&&_activeSessionIsShared&&typeof _lsEmitContentEvent==='function'){
        await _lsEmitContentEvent(_activeSessionId,'mi','mi_generated',null,null);
      }
    }
    endAiGen();
  }catch(err){
    if(window._miLoaderClear) window._miLoaderClear();
    miGenerating=false;
    miRenderLeftPanel(); // Restore CTA button from disabled state
    if(err.name==='AbortError'){
      endAiGen();
      // Return to whichever tab the user was on before MI generation started
      switchTab(prevTab);
      // Phase 5: rethrow rather than return — see pi-planning.js for the
      // full rationale (adversarial review Finding 1). A silent return
      // here made withGenerationLock() treat an aborted generation as a
      // normal successful completion.
      throw err;
    }
    if(err.message==='generation_lock_lost'){
      // Toast already shown by withGenerationLock() — avoid a duplicate.
      // Phase 5 (v8.117): marker-guarded — only clear if this attempt
      // still owns the loader area.
      var _llMiTarget=getIfCurrentAttempt('mi-right-loader',_attempt);
      if(_llMiTarget) _llMiTarget.innerHTML='';
      endAiGen();
      throw err;
    }
    endAiGen();
    // Target mi-right-loader only — #mi-left-panel stays intact, CTA restored via miRenderLeftPanel above
    // Phase 5 (v8.117): marker-guarded — a stale failure must not clobber
    // a newer attempt's content or a view the user has since navigated to.
    var _miErrTarget=getIfCurrentAttempt('mi-right-loader',_attempt);
    if(_miErrTarget){
      _miErrTarget.innerHTML=`<div class="mi-error">
        <div class="mi-error-icon"><i class="ti ti-alert-triangle" aria-hidden="true"></i></div>
        <div class="mi-error-msg">Error: ${e(err.message)}</div>
        <button class="mi-error-retry" onclick="miGenerate()"><i class="ti ti-refresh" style="font-size:12px;"></i> Try Again</button>
      </div>`;
    }
  }
    });
  }catch(lockErr){
    // Phase 5: reached in three cases — see pi-planning.js's equivalent
    // catch for the full breakdown (pre-fn lock failure / rethrown
    // AbortError / rethrown lock-lost). The inner catch above already did
    // its own resets in every case that reaches here; this is a final,
    // idempotent safety net so miGenerating never gets stuck true if
    // withGenerationLock() itself throws before the inner try/catch ever runs.
    miGenerating=false;
  }
}

// ── Toggle MI left panel collapse ──
let miLeftCollapsed=false;
function miToggleLeftPanel(){
  miLeftCollapsed=!miLeftCollapsed;
  const left=document.querySelector('.mi-left');
  if(!left)return;
  left.classList.toggle('collapsed',miLeftCollapsed);
  // Re-render left panel so icon direction and visibility update correctly
  miRenderLeftPanel();
}

// ── Section collapse toggle ──
function miToggleSection(sectionId){
  const s=document.getElementById(sectionId);
  if(s) s.classList.toggle('collapsed');
}

// ── Render full screen ──
function miRenderScreen(){
  const tab=document.getElementById('mi-tab');
  if(!tab||!miData)return;
  const mode=miProductMode;
  const isCategory=(mode==='category');
  const productName=miData&&miData.capabilities?((productContext&&productContext.name)||''):'';
  const vertical=(productContext&&productContext.industry)||'';
  const ptype=(productContext&&productContext.productType)||'';
  const now=new Date();
  const monthYear=now.toLocaleString('default',{month:'long',year:'numeric'});

  const titleLabel=isCategory?'Category Intelligence':'Market Intelligence';
  const subtitle=`${vertical}${ptype?' · '+ptype:''} · ${monthYear} · ${isCategory?'Category-Perspective View':'Market-Perspective View'}${gData?' · Aligned against Discovery Map':''}`;

  tab.innerHTML=`
<div class="mi-layout">
  <div class="mi-left" id="mi-left-panel"></div>
  <div class="mi-right">
    <div class="mi-right-content">
      <div class="mi-right-hdr">
        <div class="mi-right-hdr-l">
          <div class="mi-page-title">Market Intelligence</div>
          <div class="mi-page-sub">${e(subtitle)}</div>
        </div>
        <div class="mi-right-hdr-r">
          <div class="mi-export-wrap"><button class="export-cta-btn" onclick="miToggleExportDrop(event)"><i class="ti ti-download" style="font-size:11px;" aria-hidden="true"></i> Export Report<i class="ti ti-chevron-down" style="font-size:10px;" aria-hidden="true"></i></button><div class="mi-export-drop" id="mi-export-drop"><div class="sc-export-opt" onclick="miExportCurrentView()"><i class="ti ti-layout" style="font-size:13px;color:var(--purple);margin-top:1px;flex-shrink:0;" aria-hidden="true"></i><div><div>Current View</div><div class="sc-export-opt-sub">Instant download · 5 sections</div></div></div><div class="sc-export-opt" onclick="miExportFullReport()"><i class="ti ti-files" style="font-size:13px;color:var(--purple);margin-top:1px;flex-shrink:0;" aria-hidden="true"></i><div><div>Full Research Report</div><div class="sc-export-opt-sub">AI-enhanced · 8 sections · ~1 min</div></div></div></div></div>
        </div>
      </div>
      <div class="mi-right-body" id="mi-right-body">
        ${miRenderMarketSnapshot(isCategory)}
        ${miRenderTrends()}
        ${miRenderCompetitors(isCategory)}
        ${miRenderSWOT(isCategory)}
        ${miRenderCapabilities(isCategory)}
      </div>
      <div class="mi-cap-footer" id="mi-cap-footer">${_miCapFooterHtml()}</div>
    </div>
  </div>
</div>`;
  miRenderLeftPanel();
}

// ── Left panel ──
function miRenderLeftPanel(){
  const panel=document.getElementById('mi-left-panel');
  if(!panel)return;
  const ctx=productContext;
  const mode=miProductMode;
  const isCategory=(mode==='category');
  const hasTree=gData&&gData.stages&&gData.stages.length>0;
  const titleLabel=isCategory?'Category Intelligence':'Market Intelligence';

  const fieldHtml=(label,val)=>val?`<div class="fl" style="margin-bottom:0;">
    <label style="font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--label);display:block;margin-bottom:3px;">${label}</label>
    <div style="background:#fff;border:1px solid var(--divider);border-radius:6px;padding:6px 8px;font-size:11px;color:var(--t1);line-height:1.4;word-break:break-word;">${e(val)}</div>
  </div>`:''  ;

  const statusPill=hasTree
    ?`<span class="mi-status-pill mi-status-generated">Generated</span>`
    :`<span class="mi-status-pill mi-status-none">Not generated</span>`;
  const statusDetail=hasTree
    ?'Capability alignment computed automatically.'
    :'Capabilities show without alignment colours. Generate a Discovery Map to enable alignment.';

  panel.innerHTML=`
<div class="ph" style="border-bottom:1px solid var(--divider);">
  <div class="ph-text">
    <div class="ph-eyebrow" style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--blue);margin-bottom:2px;">Research Context</div>
    <div class="ph-title" style="font-size:11px;font-weight:400;color:var(--t3);letter-spacing:0;text-transform:none;">${e(titleLabel)}</div>
  </div>
  <button class="collapse-btn" onclick="miToggleLeftPanel()" title="${miLeftCollapsed?'Expand':'Collapse'} panel">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      ${miLeftCollapsed
        ?'<polyline points="9 18 15 12 9 6"/><polyline points="3 18 9 12 3 6"/>'
        :'<polyline points="15 18 9 12 15 6"/><polyline points="21 18 15 12 21 6"/>'}
    </svg>
  </button>
</div>
<div class="form-scroll">
  ${fieldHtml('Product Name', ctx&&ctx.name)}
  ${fieldHtml('What does this product do?', ctx&&ctx.description)}
  ${fieldHtml('Industry Vertical', ctx&&ctx.industry)}
  ${fieldHtml('Product Type', ctx&&ctx.productType)}
  ${fieldHtml('Current KPIs Being Tracked', ctx&&ctx.kpis)}
  ${fieldHtml('Biggest Known Problem', ctx&&ctx.problem)}
  ${fieldHtml('Primary User / ICP', ctx&&ctx.icp)}
  ${fieldHtml('Product / Company URL', ctx&&ctx.url)}
  ${ctx&&ctx.additionalContext?fieldHtml('Additional Context', ctx.additionalContext):''}
  <div style="border-top:1px solid var(--divider);padding-top:8px;margin-top:2px;">
    <div style="background:#fff;border:1px solid var(--divider);border-radius:7px;padding:8px 10px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px;">
        <span style="font-size:9px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;color:var(--label);">Discovery Map</span>
        ${statusPill}
      </div>
      <div style="font-size:9px;color:var(--t2);line-height:1.4;">${statusDetail}</div>
    </div>
  </div>
</div>`  ;

  // Re-apply collapsed class after re-render (innerHTML wipes it)
  if(miLeftCollapsed) panel.classList.add('collapsed');
}

// ── Section 1: Market Snapshot ──
function miRenderMarketSnapshot(isCategory){
  const snap=(miData.marketSnapshot||[]).slice(0,4);
  const criteria=miData.buyerCriteria||[];
  const sectionTitle=isCategory?'Category Benchmarks':'Market Snapshot';

  const cardsHtml=snap.map(s=>`
    <div class="mi-metric-card">
      <div class="mi-metric-val">${e(s.value||'—')}</div>
      <div class="mi-metric-lbl">${e(s.label||'')}</div>
      <div class="mi-metric-src">${e(s.trend?s.trend+' · ':'')}${e(s.source||'')}${s.year?' '+e(s.year):''}</div>
    </div>`).join('');

  const criteriaHtml=criteria.length?`
    <div class="mi-buyer-criteria">
      <div class="mi-section-sub-title">Top Buyer Criteria</div>
      ${criteria.map((c,i)=>`
        <div class="mi-buyer-row">
          <div class="mi-buyer-rank">${c.rank||i+1}</div>
          <div class="mi-buyer-content">
            <div class="mi-buyer-criterion">${e(c.criterion||'')}</div>
            <div class="mi-buyer-evidence">${e(c.evidence||'')}${c.source?' <span class="mi-src-tag">'+e(c.source)+(c.year?' '+e(c.year):'')+'</span>':''}</div>
            ${c.productRelevance?`<div class="mi-buyer-relevance">${e(c.productRelevance)}</div>`:''}
          </div>
        </div>`).join('')}
    </div>`:'';

  return `<div class="mi-section" id="mi-s1">
    <div class="mi-section-hdr" onclick="miToggleSection('mi-s1')">
      <div class="mi-section-title"><i class="ti ti-chart-bar" aria-hidden="true"></i> 1. ${e(sectionTitle)}</div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="mi-section-meta">Market size · CAGR · Top buyer criteria</span>
        <i class="ti ti-chevron-down mi-section-chevron" aria-hidden="true"></i>
      </div>
    </div>
    <div class="mi-section-body">
      <div class="mi-metrics-row">${cardsHtml}</div>
      ${criteriaHtml}
      <div class="mi-footnote">Research is AI-generated from training data. Verify statistics independently before client use.</div>
    </div>
  </div>`;
}

// ── Section 2: Trends ──
function miRenderTrends(){
  const trends=(miData.trends||[]).sort((a,b)=>{
    const order={ACTIVE:0,PEAKING:1,'TAIL-END':2};
    return (order[a.signal]||99)-(order[b.signal]||99);
  });

  const badgeCls={ACTIVE:'mi-badge-active',PEAKING:'mi-badge-peaking','TAIL-END':'mi-badge-tail'};

  const rowsHtml=trends.map(t=>`
    <div class="mi-trend-row">
      <div class="mi-trend-badges">
        <span class="mi-trend-confidence">${e(t.confidence||'')}</span>
        <span class="mi-trend-badge ${badgeCls[t.signal]||'mi-badge-tail'}">${e(t.signal||'')}</span>
      </div>
      <div class="mi-trend-content">
        <div class="mi-trend-name">${e(t.name||'')}</div>
        <div class="mi-trend-impl">${e(t.implication||'')}${t.source?' <span class="mi-src-tag">'+e(t.source)+'</span>':''}</div>
        ${t.roadmapAction?`<div class="mi-trend-action"><span class="mi-trend-action-lbl">Action:</span> ${e(t.roadmapAction)}</div>`:''}
      </div>
    </div>`).join('');

  return `<div class="mi-section" id="mi-s2">
    <div class="mi-section-hdr" onclick="miToggleSection('mi-s2')">
      <div class="mi-section-title"><i class="ti ti-trending-up" aria-hidden="true"></i> 2. Industry Trends</div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="mi-section-meta">Signal · Timing · Product implication</span>
        <i class="ti ti-chevron-down mi-section-chevron" aria-hidden="true"></i>
      </div>
    </div>
    <div class="mi-section-body">${rowsHtml||'<div class="mi-empty-section">No trend data available.</div>'}</div>
  </div>`;
}

// ── Section 3: Competitive Landscape ──
function miRenderCompetitors(isCategory){
  const competitors=miData.competitors||[];
  const deepDives=miData.competitorDeepDives||[];
  const sectionTitle=isCategory?'Analogous Products & Best Practice':'Competitive Landscape';
  const metaLabel=isCategory?'Category benchmarks · Best practice reference':'Feature parity matrix · Market-perspective only';

  if(!competitors.length){
    return `<div class="mi-section" id="mi-s3">
      <div class="mi-section-hdr" onclick="miToggleSection('mi-s3')"><div class="mi-section-title"><i class="ti ti-tournament" aria-hidden="true"></i> 3. ${e(sectionTitle)}</div><div style="display:flex;align-items:center;gap:8px;"><span class="mi-section-meta">${metaLabel}</span><i class="ti ti-chevron-down mi-section-chevron" aria-hidden="true"></i></div></div>
      <div class="mi-section-body"><div class="mi-empty-section">No competitive data available.</div></div>
    </div>`;
  }

  // Build domain list from all competitors
  const allDomains=[];
  competitors.forEach(comp=>{
    (comp.capabilities||[]).forEach(cap=>{
      if(!allDomains.includes(cap.domain))allDomains.push(cap.domain);
    });
  });

  const statusIcon={present:'<span class="mi-parity-yes">✓ Present</span>',partial:'<span class="mi-parity-partial">~ Partial</span>',gap:'<span class="mi-parity-gap">✗ Gap</span>'};

  // Header row
  let tableHtml=`<table class="mi-comp-table">
    <thead><tr>
      <th class="mi-comp-domain-hdr">Capability</th>
      ${competitors.map(c=>`<th>${e(c.name||'')}</th>`).join('')}
    </tr></thead>
    <tbody>`;

  allDomains.forEach(domain=>{
    tableHtml+=`<tr><td class="mi-comp-domain">${e(domain)}</td>`;
    competitors.forEach(comp=>{
      const cap=(comp.capabilities||[]).find(c=>c.domain===domain);
      tableHtml+=`<td>${cap?statusIcon[cap.status]||e(cap.status):'<span class="mi-parity-unknown">—</span>'}</td>`;
    });
    tableHtml+=`</tr>`;
  });
  tableHtml+=`</tbody></table>`;

  // Deep dives
  let deepDiveHtml='';
  if(deepDives.length){
    deepDiveHtml=`<div class="mi-deep-dives">
      <div class="mi-section-sub-title">${isCategory?'Benchmark Deep Dives':'Competitor Deep Dives'}</div>
      ${deepDives.slice(0,3).map(d=>`
        <div class="mi-deep-dive-card">
          <div class="mi-deep-dive-name">${e(d.name||'')}</div>
          ${d.narrative?`<div class="mi-deep-dive-narrative">${e(d.narrative||'')}</div>`:''}
          <div class="mi-deep-dive-grid">
            ${d.leadAreas?`<div class="mi-dd-kv"><span class="mi-dd-lbl">Leads on</span><span class="mi-dd-val">${e(d.leadAreas)}</span></div>`:''}
            ${d.productAdvantage?`<div class="mi-dd-kv"><span class="mi-dd-lbl">Our edge</span><span class="mi-dd-val">${e(d.productAdvantage)}</span></div>`:''}
            ${d.threat?`<div class="mi-dd-kv mi-dd-threat-kv"><span class="mi-dd-lbl">Threat</span><span class="mi-dd-val">${e(d.threat)}</span></div>`:''}
          </div>
        </div>`).join('')}
    </div>`;
  }

  return `<div class="mi-section" id="mi-s3">
    <div class="mi-section-hdr" onclick="miToggleSection('mi-s3')">
      <div class="mi-section-title"><i class="ti ti-tournament" aria-hidden="true"></i> 3. ${e(sectionTitle)}</div>
      <div style="display:flex;align-items:center;gap:8px;"><span class="mi-section-meta">${metaLabel}</span><i class="ti ti-chevron-down mi-section-chevron" aria-hidden="true"></i></div>
    </div>
    <div class="mi-section-body">
      <div class="mi-comp-table-wrap">${tableHtml}</div>
      ${deepDiveHtml}
    </div>
  </div>`;
}

// ── Section 4: SWOT ──
function miRenderSWOT(isCategory){
  const swot=miData.swot||{};
  const sectionTitle=isCategory?'Category-Perspective SWOT':'Market-Perspective SWOT';

  const quadrant=(label,items,cls)=>{
    if(!items||!items.length)return`<div class="mi-swot-cell ${cls}"><div class="mi-swot-lbl">${label}</div><div class="mi-swot-empty">No data</div></div>`;
    return`<div class="mi-swot-cell ${cls}">
      <div class="mi-swot-lbl">${label}</div>
      <div class="mi-swot-items">
        ${items.map(it=>`<div class="mi-swot-item">
          <span class="mi-swot-dot"></span>
          <span>${e(it.text||'')}${it.researchIdentified?` <span class="mi-research-id-badge">Research-identified</span>`:''}${it.source?` <span class="mi-src-tag">${e(it.source)}</span>`:''}</span>
        </div>`).join('')}
      </div>
    </div>`;
  };

  const synthesisHtml=swot.synthesis?`<div class="mi-swot-synthesis">${e(swot.synthesis)}</div>`:'';

  return `<div class="mi-section" id="mi-s4">
    <div class="mi-section-hdr" onclick="miToggleSection('mi-s4')">
      <div class="mi-section-title"><i class="ti ti-layout-grid" aria-hidden="true"></i> 4. ${e(sectionTitle)}</div>
      <div style="display:flex;align-items:center;gap:8px;"><span class="mi-section-meta">Based on AI training data — not internal product assessment</span><i class="ti ti-chevron-down mi-section-chevron" aria-hidden="true"></i></div>
    </div>
    <div class="mi-section-body">
      <div class="mi-swot-grid">
        ${quadrant('Strengths', swot.strengths, 'mi-swot-s')}
        ${quadrant('Weaknesses', swot.weaknesses, 'mi-swot-w')}
        ${quadrant('Opportunities', swot.opportunities, 'mi-swot-o')}
        ${quadrant('Threats', swot.threats, 'mi-swot-t')}
      </div>
      ${synthesisHtml}
    </div>
  </div>`;
}

function miRenderCapabilities(isCategory){
  const caps=miData.capabilities||[];
  const hasTree=gData&&gData.stages&&gData.stages.length>0;

  const aligned=caps.filter(c=>c.kpiTreeMatch==='aligned');
  const partial=caps.filter(c=>c.kpiTreeMatch==='partial');
  const gaps=caps.filter(c=>c.kpiTreeMatch==='none'||!c.kpiTreeMatch);

  const capRow=(cap,group)=>{
    const isAdded=capStore['mi||capabilities']&&
      (capStore['mi||capabilities'].capabilities||[]).some(c=>c.name===cap.name);
    const isSelected=miSelectedCapNames.has(cap.name);
    let rowCls='mi-cap-row mi-cap-'+group;
    if(isAdded) rowCls+=' mi-cap-sent';

    let icon='<i class="ti ti-circle-dashed" aria-hidden="true"></i>';
    let badge='';
    if(group==='aligned'){
      icon='<i class="ti ti-check" aria-hidden="true"></i>';
      badge='<span class="mi-cap-badge mi-badge-in-tree">In Discovery Map</span>';
    } else if(group==='partial'){
      icon='<i class="ti ti-minus" aria-hidden="true"></i>';
      badge='<span class="mi-cap-badge mi-badge-partial-tree">Partial in Tree</span>';
    }

    const kpiPath=cap.kpiTreePath?`<div class="mi-cap-kpi-path"><i class="ti ti-hierarchy-2" style="font-size:9px;"></i>${e(cap.kpiTreePath)} · ${e(cap.kpiTreeStage||'')}</div>`:'';

    const chkHtml=isAdded
      ?`<div class="mi-cap-chk mi-cap-chk-added" onclick="miRemoveFromCC('${encodeURIComponent(cap.name)}')" title="Added — click to remove"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>`
      :`<div class="mi-cap-chk${isSelected?' mi-cap-chk-checked':''}" onclick="miToggleCapSelect('${encodeURIComponent(cap.name)}')" title="${isSelected?'Deselect':'Select'}"></div>`;

    const rightHtml=isAdded
      ?`<span class="mi-sent-badge"><i class="ti ti-check" aria-hidden="true"></i> Added</span>`
      :`${badge}`;

    return `<div class="${rowCls}" id="mi-cap-${encodeURIComponent(cap.name)}">
      <div class="mi-cap-row-inner">
        <div class="mi-cap-chk-wrap">${chkHtml}</div>
        <div class="mi-cap-icon" style="${isAdded?'opacity:0.4;':''}">${icon}</div>
        <div class="mi-cap-info" style="${isAdded?'opacity:0.6;':''}">
          <div class="mi-cap-name">${e(cap.name)}</div>
          ${kpiPath}
        </div>
        <div class="mi-cap-btns">${rightHtml}</div>
      </div>
    </div>`;
  };

  const groupSection=(title,icon,items,group)=>{
    if(!items.length)return'';
    return`<div class="mi-cap-group">
      <div class="mi-cap-group-title"><i class="${icon}" aria-hidden="true"></i> ${title}</div>
      ${items.map(c=>capRow(c,group)).join('')}
    </div>`;
  };

  const noTreeNotice=!hasTree?`<div class="mi-no-tree-notice"><i class="ti ti-info-circle" aria-hidden="true"></i> Generate a Discovery Map to see capability alignment and metric routing. Alignment colours will appear automatically — no need to regenerate.</div>`:'';
  const legend=hasTree?`<div class="mi-cap-legend">
    <span class="mi-legend-item mi-legend-aligned"><span class="mi-legend-dot"></span> In Discovery Map</span>
    <span class="mi-legend-item mi-legend-partial"><span class="mi-legend-dot"></span> Partial</span>
    <span class="mi-legend-item mi-legend-gap"><span class="mi-legend-dot"></span> Market gap</span>
  </div>`:'';

  return `<div class="mi-section" id="mi-s5">
    <div class="mi-section-hdr" onclick="miToggleSection('mi-s5')">
      <div class="mi-section-title"><i class="ti ti-bulb" aria-hidden="true"></i> 5. Capability Recommendations</div>
      <div style="display:flex;align-items:center;gap:8px;"><span class="mi-section-meta">Select capabilities to add to Capability Canvas</span><i class="ti ti-chevron-down mi-section-chevron" aria-hidden="true"></i></div>
    </div>
    <div class="mi-section-body">
      ${legend}
      ${groupSection('Aligned with Discovery Map','ti ti-check',aligned,'aligned')}
      ${groupSection('Partial in Discovery Map','ti ti-minus',partial,'partial')}
      ${groupSection('Market Gaps — Not in Discovery Map','ti ti-circle-dashed',gaps,'gap')}
      ${noTreeNotice}
    </div>
  </div>`;
}

// ── Refresh capability section only ──
function miRefreshCapSection(){
  const s5=document.getElementById('mi-s5');
  if(!s5||!miData)return;
  const isCategory=(miProductMode==='category');
  s5.outerHTML=miRenderCapabilities(isCategory);
  // Refresh footer — it now lives outside the section
  const footer=document.getElementById('mi-cap-footer');
  if(footer)footer.innerHTML=_miCapFooterHtml();
}

// ── Footer HTML helper ──
function _miCapFooterHtml(){
  const selCount=miSelectedCapNames.size;
  const addedCount=(capStore['mi||capabilities']&&capStore['mi||capabilities'].capabilities)?capStore['mi||capabilities'].capabilities.length:0;
  const allAdded=(miData&&miData.capabilities&&miData.capabilities.length>0&&addedCount>=miData.capabilities.length);
  if(allAdded){
    return`<div class="mi-cap-footer-inner">
      <span class="mi-cap-footer-lbl" style="color:var(--green);"><i class="ti ti-check" style="font-size:10px;" aria-hidden="true"></i> All capabilities added to CC</span>
      <button class="mi-cap-send-btn" onclick="switchTab('cc')"><i class="ti ti-layout-kanban" style="font-size:10px;" aria-hidden="true"></i> Open Capability Canvas</button>
    </div>`;
  }
  // v9.08: the send/add button is a mutation and gets hidden for view-only
  // sessions; the count label still displays as informational context.
  const _canEditMi=(typeof canEditSession!=='function')||canEditSession();
  return`<div class="mi-cap-footer-inner">
    <span class="mi-cap-footer-lbl">${selCount>0?`<strong>${selCount}</strong> selected`:'0 selected'}</span>
    ${_canEditMi?`<button class="mi-cap-send-btn${selCount===0?' mi-cap-send-btn-disabled':''}" ${selCount===0?'disabled':''} onclick="miSendToCC()"><i class="ti ti-layout-kanban" style="font-size:10px;" aria-hidden="true"></i> Add${selCount>0?' '+selCount:''} to Capability Canvas</button>`:''}
  </div>`;
}

// ── Toggle cap selection ──
function miToggleCapSelect(capNameEncoded){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const capName=decodeURIComponent(capNameEncoded);
  // Don't allow selecting already-added caps
  const isAdded=capStore['mi||capabilities']&&
    (capStore['mi||capabilities'].capabilities||[]).some(c=>c.name===capName);
  if(isAdded)return;
  if(miSelectedCapNames.has(capName)) miSelectedCapNames.delete(capName);
  else miSelectedCapNames.add(capName);
  miRefreshCapSection();
}

// ── Add selected caps to Capability Canvas ──
function miSendToCC(){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  if(miSelectedCapNames.size===0)return;
  const caps=miData&&miData.capabilities||[];
  let added=0;
  miSelectedCapNames.forEach(capName=>{
    const cap=caps.find(c=>c.name===capName);
    if(!cap)return;
    // Create capStore entry if absent
    if(!capStore['mi||capabilities']){
      capStore['mi||capabilities']={
        metricName:'MI Capabilities',
        stageLabel:'Market Intelligence',
        stageId:'mi',
        _miCap:true,
        capabilities:[]
      };
    }
    // Avoid duplicates
    if(!capStore['mi||capabilities'].capabilities.some(c=>c.name===capName)){
      capStore['mi||capabilities'].capabilities.push({
        name:capName,
        why:cap.marketEvidence||cap.description||'Market-validated capability',
        subCaps:null,
        featStore:{top:null}
      });
      added++;
    }
  });
  miSelectedCapNames.clear();
  // Reveal CC tab
  const ccTabEl=document.getElementById('tab-cc');
  if(ccTabEl&&ccTabEl.style.display==='none') ccTabEl.style.display='';
  if(typeof ccUpdateTabBadge==='function') ccUpdateTabBadge();
  // Update CC if open — clear stale active metric and rebuild layout
  if(typeof capActiveMetricKey!=='undefined'&&
     (capActiveMetricKey===null||!capStore[capActiveMetricKey])){
    capActiveMetricKey=null;capActiveCapIdx=null;
    capActiveSubCapIdx=null;ccPanelCapKey=null;
    if(typeof ccOpenMetricNav==='function'&&document.getElementById('cc-main')){
      ccOpenMetricNav();
    }
  }
  miRefreshCapSection();
  if(added>0){
    miShowToast(`${added} capabilit${added!==1?'ies':'y'} added to Capability Canvas.`);
    if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId) sessionStoreSave(_activeSessionId);
  }
}

// ── Remove a cap from Capability Canvas ──
function miRemoveFromCC(capNameEncoded){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const capName=decodeURIComponent(capNameEncoded);
  const entry=capStore['mi||capabilities'];
  if(!entry)return;
  const cap=entry.capabilities.find(c=>c.name===capName);
  if(!cap)return;
  const hasFeatures=cap.featStore&&cap.featStore.top&&cap.featStore.top.length>0;
  if(hasFeatures){
    showConfirm(
      `"${capName}" has features generated in Capability Canvas. Removing it will delete those features.`,
      'Remove capability?',
      ()=>_miDoRemove(capName),
      'Remove','danger','Keep it'
    );
  } else {
    _miDoRemove(capName);
  }
}

function _miDoRemove(capName){
  const entry=capStore['mi||capabilities'];
  if(!entry)return;
  entry.capabilities=entry.capabilities.filter(c=>c.name!==capName);
  if(entry.capabilities.length===0) delete capStore['mi||capabilities'];
  if(typeof ccUpdateTabBadge==='function') ccUpdateTabBadge();
  if(typeof capActiveMetricKey!=='undefined'&&capActiveMetricKey==='mi||capabilities'){
    if(!capStore['mi||capabilities']){
      capActiveMetricKey=null;capActiveCapIdx=null;
      capActiveSubCapIdx=null;ccPanelCapKey=null;
    }
    if(typeof ccOpenMetricNav==='function'&&document.getElementById('cc-main')) ccOpenMetricNav();
  }
  miRefreshCapSection();
  miShowToast(`Capability removed from Capability Canvas.`);
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId) sessionStoreSave(_activeSessionId);
}

// ── Flatten all metric names from gData for validation ──
function miFlattenMetrics(){
  const metrics=[];
  if(!gData||!gData.stages)return metrics;
  gData.stages.forEach(st=>{
    (st.l1_metrics||[]).forEach(l1=>{
      if(l1&&l1.name)metrics.push({name:l1.name,stage:st.label,path:l1.name});
      (l1.l2_metrics||[]).forEach(l2=>{
        if(l2&&l2.name)metrics.push({name:l2.name,stage:st.label,path:l1.name+' › '+l2.name});
        (l2.l3_metrics||[]).forEach(l3=>{
          if(l3&&l3.name)metrics.push({name:l3.name,stage:st.label,path:l1.name+' › '+l2.name+' › '+l3.name});
        });
      });
    });
  });
  return metrics;
}

// ── Resolve canvas routing for a capability ──
// Returns {metric, stage, metricPath} — validated against gData or falls back to capability grouping
function miResolveCanvasRoute(cap){
  if(cap.kpiTreeMetric&&gData){
    const flat=miFlattenMetrics();
    const match=flat.find(m=>m.name===cap.kpiTreeMetric);
    if(match){
      return{metric:match.name,stage:match.stage,metricPath:match.path};
    }
  }
  // Fallback — capability as its own group under Market Intelligence stage
  return{metric:cap.name,stage:'Market Intelligence',metricPath:cap.name};
}


// ── Download DOCX — generates prose sections on demand then builds report ──
// ── Export dropdown ──
function miToggleExportDrop(evt){
  evt.stopPropagation();
  const drop=document.getElementById('mi-export-drop');
  if(drop)drop.classList.toggle('open');
}
document.addEventListener('click',function(){
  const d=document.getElementById('mi-export-drop');
  if(d)d.classList.remove('open');
});
function miExportCurrentView(){
  const d=document.getElementById('mi-export-drop');
  if(d)d.classList.remove('open');
  if(!miData){showToast('Generate Market Intelligence first.','info');return;}
  miBuildDocx(miData,productContext||{},'current');
}
function miExportFullReport(){
  const d=document.getElementById('mi-export-drop');
  if(d)d.classList.remove('open');
  miDownloadDocx();
}

async function miDownloadDocx(){
  if(!miData){showToast('Generate Market Intelligence first.','info');return;}
  const key=getKey();

  const btn=document.querySelector('.mi-export-wrap .export-cta-btn');
  if(btn){btn.disabled=true;btn.innerHTML='<i class="ti ti-loader-2 mi-loader-spin" style="font-size:12px;" aria-hidden="true"></i> Preparing report… this may take a minute';}

  try{
    // Generate docx prose sections on demand
    const ctx=productContext||{name:'',industry:'',productType:''};
    const sys=(typeof SYS_MI_DOCX!=='undefined'?SYS_MI_DOCX:'');
    const usr=buildMIDocxPrompt(ctx, miData);
    // v9.01-diag fix: raised from 8000 -- the requested payload (multiple
    // prose paragraphs + several structured arrays covering report
    // sections 6-8) was likely being truncated before the JSON closed,
    // causing JSON.parse to fail and silently default to {} below with
    // no visible error -- exactly matching the reported symptom (sections
    // 6-8 empty, Full Report indistinguishable from Current View).
    const txt=await callAPI(sys, usr, 16000, undefined, undefined, 'mi-docx-gen');
    const clean=txt.replace(/```json|```/g,'').trim();
    let docxSections;
    let parseFailed=false;
    try{docxSections=JSON.parse(clean);}
    catch(e){
      const s=clean.indexOf('{');const l=clean.lastIndexOf('}');
      if(s>=0&&l>s){try{docxSections=JSON.parse(clean.substring(s,l+1));}catch(e2){parseFailed=true;}}
      else parseFailed=true;
    }
    if(!parseFailed && (!docxSections || typeof docxSections!=='object')) parseFailed=true;

    // Lightweight schema check — confirms the required section-6-8 fields
    // are present and non-empty, not just that SOMETHING parsed. Valid-
    // but-incomplete JSON (missing keys, empty arrays/strings) was a real,
    // separate failure mode from truncation — this catches that class too,
    // rather than only handling one specific cause.
    let schemaFailed=false;
    let missingFields=[];
    if(!parseFailed){
      const requiredNonEmptyArrays=['gapMatrix','roadmap','valueAnchors','sources'];
      const requiredNonEmptyStrings=['methodologyNote','limitations'];
      requiredNonEmptyArrays.forEach(function(k){
        if(!Array.isArray(docxSections[k])||docxSections[k].length===0)missingFields.push(k);
      });
      requiredNonEmptyStrings.forEach(function(k){
        if(typeof docxSections[k]!=='string'||docxSections[k].trim().length===0)missingFields.push(k);
      });
      schemaFailed=missingFields.length>0;
    }

    if(parseFailed||schemaFailed){
      // v9.01-diag fix: previously silently defaulted to {} here with NO
      // visible error -- the Full Report would render with sections 6-8
      // empty and no indication anything had gone wrong. Now surfaced
      // exactly like any other generation failure, using the same
      // Retry-toast pattern already used elsewhere in this function.
      console.warn('[MI docx] Full Report generation incomplete.', {parseFailed, schemaFailed, missingFields, responseLength:txt?txt.length:0});
      miShowToast(
        '<i class="ti ti-alert-circle" style="font-size:13px;vertical-align:-2px;" aria-hidden="true"></i> Full Report generation returned incomplete content. ',
        'Retry',
        'miDownloadDocx()'
      );
      if(btn){btn.disabled=false;btn.innerHTML='<i class="ti ti-download" aria-hidden="true"></i> Export Report';}
      return;
    }

    // Merge docxSections into miData for the export function
    const enrichedData={...miData, docxSections:docxSections||{}};
    if(typeof miBuildDocx==='function') miBuildDocx(enrichedData, ctx, 'full');
    else showToast('DOCX export module not loaded.','error');
  }catch(err){
    miShowToast(
      '<i class="ti ti-alert-circle" style="font-size:13px;vertical-align:-2px;" aria-hidden="true"></i> Report download failed — '+e(err.message)+'. ',
      'Retry',
      'miDownloadDocx()'
    );
  }finally{
    if(btn){btn.disabled=false;btn.innerHTML='<i class="ti ti-download" aria-hidden="true"></i> Export Report';}
  }
}

// ── Empty state render (before generation) ──
function miRenderEmpty(){
  const tab=document.getElementById('mi-tab');
  if(!tab)return;
  tab.innerHTML=`
<div class="mi-layout">
  <div class="mi-left" id="mi-left-panel"></div>
  <div class="mi-right mi-right-empty">
    <div class="mi-empty-state">
      <div class="mi-empty-icon"><i class="ti ti-world-search" aria-hidden="true"></i></div>
      <div class="mi-empty-title">Research your market</div>
      <div class="mi-empty-desc">Generate market intelligence to see where the market heads, what competitors do, and which capabilities you need to close the gap.</div>
      <button class="mi-empty-cta" onclick="miGenerate()"><i class="ti ti-world-search" aria-hidden="true"></i> Generate Market Intelligence</button>
      <div class="mi-empty-note">Research is AI-generated from training data. Verify statistics independently before client use.</div>
    </div>
  </div>
</div>`;
  miRenderLeftPanel();
}
