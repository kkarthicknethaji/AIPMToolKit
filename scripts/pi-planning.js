// PI PLANNING — pi-planning.js
// Owns: piOnTabEnter, sprint board render, squad builder, drag-drop,
//       right panel, dependency management, piGenerate, piRegenerate

// ── Multi-release-plan helpers ──
function piGetActivePlan(){
  return (typeof piPlans!=='undefined'&&Array.isArray(piPlans))?piPlans.find(function(p){return p.id===_piActivePlanId;}):undefined;
}
function piComputeEndDate(plan){
  if(!plan||!plan.startDate||!plan.sprintCount||!plan.sprintDuration)return null;
  var start=new Date(plan.startDate);
  start.setDate(start.getDate()+(plan.sprintCount*plan.sprintDuration)-1);
  return start;
}
function piLatestEndDateAcrossPlans(){
  if(typeof piPlans==='undefined'||!Array.isArray(piPlans)||piPlans.length===0)return null;
  var max=null;
  piPlans.forEach(function(p){
    var end=piComputeEndDate(p);
    if(end&&(!max||end>max))max=end;
  });
  return max;
}
function piFmtShortDate(d){
  if(!d)return'';
  try{return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});}catch(e){return'';}
}

// ── Tab entry ──
function piOnTabEnter(){
  // Defensive self-heal - session-store.js already defaults _piActivePlanId
  // on load, but re-entering this tab after in-memory-only state changes
  // (e.g. a plan was just created this session) must self-heal too.
  if(!_piActivePlanId&&Array.isArray(piPlans)&&piPlans.length>0){
    _piActivePlanId=piPlans[0].id;
  }
  piCheckStaleness();
  piRenderLeftPanel();
  if(!Array.isArray(piPlans)||piPlans.length===0){
    piRenderEmpty();
    return;
  }
  const activePlan=piGetActivePlan();
  if(activePlan&&Array.isArray(activePlan.sprints)&&activePlan.sprints.length>0){
    piRenderBoard();
  } else {
    piRenderEmpty();
  }
}

function piCheckStaleness(){
  const piPlan=piGetActivePlan();
  if(!piPlan)return;
  const currentHash=piComputeHash();
  if(piPlan.piScVersion&&currentHash!==piPlan.piScVersion){
    piShowStaleBanner();
  } else {
    piHideStaleBanner();
  }
}

function piComputeHash(){
  const piPlan=piGetActivePlan();
  return piComputeHashFor(piPlan?piPlan.submittedFeatureIds:null);
}
function piComputeHashFor(submittedFeatureIds){
  // Hash submitted feature IDs + story counts so stale only fires when submitted features change
  if(submittedFeatureIds&&submittedFeatureIds.length){
    return submittedFeatureIds.map(fid=>{
      const f=scCanvas.find(x=>x.id===fid);
      return fid+':'+(f&&f.stories?f.stories.length:0);
    }).join('|');
  }
  // Fallback before first PI
  if(!scCanvas||scCanvas.length===0)return'empty';
  return scCanvas.map(f=>f.id).join('|');
}

// ── Left panel ──
function piRenderLeftPanel(){
  const lp=document.getElementById('pi-left');
  if(!lp)return;
  const hasPlans=Array.isArray(piPlans)&&piPlans.length>0;
  const _collapseBtnHtml=`<button class="collapse-btn" id="pi-collapse-btn" onclick="piToggleLeftPanel()" title="Toggle panel">
        ${lp.classList.contains('pi-left-collapsed')
          ?'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/><polyline points="3 18 9 12 3 6"/></svg>'
          :'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/><polyline points="21 18 15 12 21 6"/></svg>'
        }
      </button>`;
  if(!hasPlans){
    lp.innerHTML=`
      <div class="ph"><div class="ph-text"><div class="ph-title">Release Planning</div><div class="ph-sub">Create release plans from your backlog.</div></div>${_collapseBtnHtml}</div>
      <div class="pi-left-scroll">
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;height:100%;color:var(--t3);padding:24px;">
          <i class="ti ti-rocket" style="font-size:22px;margin-bottom:8px;" aria-hidden="true"></i>
          <div style="font-size:11px;line-height:1.6;">No release plans yet.<br>Configure your first release in the main panel.</div>
        </div>
      </div>
      <div class="pi-left-footer"><button class="pi-add-plan-btn" onclick="piStartNewPlanDraft()">+ New Release Plan</button></div>`;
    return;
  }
  const n=piPlans.length;
  lp.innerHTML=`
    <div class="ph"><div class="ph-text"><div class="ph-title">Release Planning</div><div class="ph-sub">${n} release plan${n!==1?'s':''}</div></div>${_collapseBtnHtml}</div>
    <div class="pi-left-scroll">
      ${piPlans.map(function(p){
        const storyCount=Object.keys(p.storyAssignments||{}).length;
        const end=piComputeEndDate(p);
        const active=p.id===_piActivePlanId;
        const _canEditPlanName=(typeof canEditSession!=='function')||canEditSession();
        return `<div class="pi-plan-card${active?' active':''}" onclick="piSelectPlan('${e(p.id)}')" id="pi-plan-card-${e(p.id)}">
          <div class="pi-plan-card-title-row">
            <div class="pi-plan-card-title" id="pi-plan-name-${e(p.id)}">${e(p.name||'Untitled')}</div>
            ${(active&&_canEditPlanName)?`<button type="button" class="pi-plan-rename-btn" onclick="event.stopPropagation();piRenamePlan('${e(p.id)}')" title="Rename" aria-label="Rename release plan"><i class="ti ti-pencil" style="font-size:10px;" aria-hidden="true"></i></button>`:''}
          </div>
          <div class="pi-plan-card-meta">${p.sprintCount||0} sprints &middot; ${storyCount} stor${storyCount!==1?'ies':'y'} &middot; ${piFormatDate(p.startDate)} – ${end?piFormatDate(end.toISOString().split('T')[0]):'—'}</div>
        </div>`;
      }).join('')}
    </div>
    <div class="pi-left-footer"><button class="pi-add-plan-btn" onclick="piStartNewPlanDraft()">+ New Release Plan</button></div>`;
}

function piSelectPlan(planId){
  _piActivePlanId=planId;
  piRenderLeftPanel();
  const plan=piGetActivePlan();
  if(plan&&Array.isArray(plan.sprints)&&plan.sprints.length>0){piRenderBoard();piCheckStaleness();}
  else piRenderEmpty();
}

function piRenamePlan(planId){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const plan=(typeof piPlans!=='undefined'&&Array.isArray(piPlans))?piPlans.find(function(p){return p.id===planId;}):null;
  if(!plan)return;
  const nameEl=document.getElementById('pi-plan-name-'+planId);
  if(!nameEl||nameEl.tagName==='INPUT')return;
  const oldName=plan.name||'';
  const inp=document.createElement('input');
  inp.type='text';
  inp.className='pi-plan-card-title pi-plan-rename-input';
  inp.id='pi-plan-name-'+planId;
  inp.value=oldName;
  inp.maxLength=60;
  inp.setAttribute('aria-label','Rename release plan');
  nameEl.replaceWith(inp);
  inp.focus();inp.select();
  function commit(){
    const newName=inp.value.trim()||oldName;
    plan.name=newName;
    piRenderLeftPanel();
    const toolbarBadge=document.querySelector('.pi-name-badge');
    if(toolbarBadge&&plan.id===_piActivePlanId)toolbarBadge.textContent=newName;
    if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId)sessionStoreSave(_activeSessionId);
  }
  inp.addEventListener('blur',commit);
  inp.addEventListener('keydown',function(ev){
    if(ev.key==='Enter'){ev.preventDefault();inp.blur();}
    else if(ev.key==='Escape'){inp.value=oldName;inp.blur();}
  });
}

function piStartNewPlanDraft(){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  _piActivePlanId=null;
  _piDraftSquads=null;
  _piDraftRemarksOpen=false;
  piRenderLeftPanel();
  piRenderEmpty();
}

// ── Working squads array - the active plan's own squads[], or (while
// drafting a brand-new plan, before it's ever been generated) a transient
// in-memory draft array seeded with one default squad, matching the
// existing default-squad-on-first-render behavior. ──
let _piDraftSquads=null;
let _piDraftRemarksOpen=false;
function piGetSquads(){
  const plan=piGetActivePlan();
  if(plan){
    if(!Array.isArray(plan.squads))plan.squads=[];
    return plan.squads;
  }
  if(!Array.isArray(_piDraftSquads)){
    const _sqName=(typeof appSettings!=='undefined'?appSettings.defaultSquadName:'Squad')||'Squad';
    const _sqCap=(typeof appSettings!=='undefined'?appSettings.defaultSquadCapacity:80)||80;
    _piDraftSquads=[{name:_sqName+' 1',capacity:_sqCap}];
  }
  return _piDraftSquads;
}

function piRenderSquadRows(){
  const squads=piGetSquads();
  if(squads.length===0){
    return`<div class="rp-squad-row" style="color:var(--label);font-size:10px;">No squads yet - add one below.</div>`;
  }
  return squads.map((s,i)=>`<div class="rp-squad-row">
    <input class="rp-squad-name" value="${e(s.name)}" placeholder="Squad name" onchange="piUpdateSquad(${i},'name',this.value)">
    <input class="rp-squad-cap-input" type="number" min="10" max="500" value="${s.capacity||80}" onchange="piUpdateSquad(${i},'capacity',+this.value)" title="Total story points this squad can deliver in the release">
    <span class="rp-squad-cap-unit">pts</span>
    <button class="rp-squad-remove-q" onclick="piRemoveSquad(${i})" aria-label="Remove squad">&#x2715;</button>
  </div>`).join('');
}

// ── Capacity summary - shown below squad table, refreshes on every squad change ──
function piRenderCapSummary(){
  const squads=piGetSquads();
  const totalCap=squads.reduce((a,s)=>a+(s.capacity||0),0);
  return `Total capacity: <strong>${totalCap} pts</strong> across ${squads.length} squad${squads.length!==1?'s':''}`;
}
function _piRefreshCapSummary(){
  const el=document.getElementById('pi-cap-summary');
  if(el)el.innerHTML=piRenderCapSummary();
}

function piCalcCapacity(s){
  // Direct capacity field — user sets total PI points for the squad
  return s.capacity||80;
}

function piAddSquad(){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const squads=piGetSquads();
  const _sqName=(typeof appSettings!=='undefined'?appSettings.defaultSquadName:'Squad')||'Squad';
  const _sqCap=(typeof appSettings!=='undefined'?appSettings.defaultSquadCapacity:80)||80;
  squads.push({name:_sqName+' '+(squads.length+1),capacity:_sqCap});
  const tbody=document.getElementById('pi-squad-tbody');
  if(tbody)tbody.innerHTML=piRenderSquadRows();
  _piRefreshCapSummary();
  const genBtn=document.getElementById('pi-gen-btn');
  if(genBtn)genBtn.disabled=false;
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId)sessionStoreSave(_activeSessionId);
}

function piRemoveSquad(idx){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const squads=piGetSquads();
  squads.splice(idx,1);
  const tbody=document.getElementById('pi-squad-tbody');
  if(tbody)tbody.innerHTML=piRenderSquadRows();
  _piRefreshCapSummary();
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId)sessionStoreSave(_activeSessionId);
}

function piUpdateSquad(idx,field,val){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const squads=piGetSquads();
  if(!squads[idx])return;
  squads[idx][field]=val;
  const tbody=document.getElementById('pi-squad-tbody');
  if(tbody)tbody.innerHTML=piRenderSquadRows();
  _piRefreshCapSummary();
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId)sessionStoreSave(_activeSessionId);
}

function piToggleRemarksBox(){
  _piDraftRemarksOpen=!_piDraftRemarksOpen;
  const box=document.getElementById('pi-remarks-box');
  if(box)box.style.display=_piDraftRemarksOpen?'block':'none';
  const btn=document.getElementById('pi-remarks-toggle-btn');
  if(btn)btn.style.display=_piDraftRemarksOpen?'none':'flex';
}

// ── Empty / config-form state - used both for the very first plan and for
// drafting any additional plan. Editing config of an already-generated
// plan is out of scope; this form only ever creates a NEW plan. ──
function piRenderEmpty(){
  const main=document.getElementById('pi-main');
  if(!main)return;
  const _canEditPi=(typeof canEditSession!=='function')||canEditSession();
  const piName='Release '+((typeof piPlans!=='undefined'&&Array.isArray(piPlans))?piPlans.length+1:1);
  const _latestEnd=piLatestEndDateAcrossPlans();
  let defaultStart;
  if(_latestEnd){
    const d=new Date(_latestEnd);
    d.setDate(d.getDate()+1);
    defaultStart=d.toISOString().split('T')[0];
  } else {
    defaultStart=new Date().toISOString().split('T')[0];
  }
  const sprintCount=(typeof appSettings!=='undefined'?appSettings.defaultSprints:6)||6;
  const sprintDur=((typeof appSettings!=='undefined'?appSettings.defaultSprintDur:2)*7)||14;
  const backlogStories=(typeof piBacklogStoryIds!=='undefined'?piBacklogStoryIds:[]).map(id=>piFindStory(id)).filter(Boolean);
  // Always render the tray container (matching piRenderBoard()'s own
  // consistent behavior) - hiding it entirely at 0 stories made it look
  // like the tray had vanished rather than simply being empty right now.
  const trayHtml=`<div class="pi-backlog-resize-handle"></div>
      <div class="pi-backlog-tray" id="pi-backlog-tray">
        <div class="pi-backlog-hdr">Stories waiting in backlog (${backlogStories.length})</div>
        <div class="pi-backlog-cards">${backlogStories.map(s=>{
          const shortId=s.id?s.id.replace(/[^a-z0-9]/gi,'').substring(0,6).toUpperCase():'';
          return`<div class="pi-backlog-card" title="${e(s.title||s.statement||'')}"><span class="pi-card-id" style="display:block;margin-bottom:3px;">${e(shortId)}</span>${e((s.title||s.statement||'').substring(0,55))}…</div>`;
        }).join('')}</div>
      </div>`;
  main.innerHTML=`
    <div class="pi-main-content" id="pi-main-content">
      <div style="padding:20px 24px;overflow-y:auto;flex:1;display:flex;align-items:center;justify-content:center;">
      <div class="rp-config-card" style="max-width:480px;">
        <input type="text" class="rp-name-input" id="pi-name-input" value="${e(piName)}" maxlength="60" ${_canEditPi?'':'readonly'}>
        <div class="rp-name-hint">Name this release plan.</div>
        <div class="rp-meta-row">
          <div class="rp-meta-field">
            <div class="rp-meta-label">Starts</div>
            <input type="date" class="rp-meta-input" id="pi-start-date" value="${e(defaultStart)}" ${_canEditPi?'onchange="piValidateStartDate()" onblur="piValidateStartDate()"':'readonly'}>
            <div class="rp-inline-err" id="pi-start-err"></div>
          </div>
          <div class="rp-meta-field">
            <div class="rp-meta-label">Sprints</div>
            <input type="number" class="rp-meta-input" id="pi-sprint-count" min="1" max="20" value="${sprintCount}" ${_canEditPi?'':'readonly'}>
          </div>
          <div class="rp-meta-field">
            <div class="rp-meta-label">Duration (weeks)</div>
            <input type="number" class="rp-meta-input" id="pi-sprint-dur-weeks" min="1" max="6" value="${Math.round(sprintDur/7)||2}" ${_canEditPi?'':'readonly'}>
          </div>
        </div>
        <div class="rp-divider-quiet"></div>
        <div class="rp-section-quiet">Squad Capacity</div>
        <div class="rp-squad-list" id="pi-squad-tbody">${piRenderSquadRows()}</div>
        ${_canEditPi?`<a class="rp-add-squad-q" href="javascript:void(0)" onclick="piAddSquad()">+ Add squad</a>`:''}
        <div class="rp-total-cap" id="pi-cap-summary">${piRenderCapSummary()}</div>
        <div class="rp-divider-quiet"></div>
        <button type="button" class="rp-remarks-toggle" id="pi-remarks-toggle-btn" onclick="piToggleRemarksBox()"><i class="ti ti-plus" style="font-size:10px;" aria-hidden="true"></i> Additional Remarks</button>
        <div class="rp-remarks-box" id="pi-remarks-box" style="display:${_piDraftRemarksOpen?'block':'none'};">
          <textarea class="f-textarea" id="pi-known-deps" rows="2" placeholder="e.g. Payments infra migration must complete before checkout redesign." maxlength="1000" ${_canEditPi?'':'readonly'}></textarea>
        </div>
        ${_canEditPi?`<div class="rp-cta-wrap">
          <button class="gen-btn" id="pi-gen-btn" onclick="piGenerate()" ${piGetSquads().length===0?'disabled':''}>
            <i class="ti ti-calendar-event" style="font-size:13px;" aria-hidden="true"></i> Generate Release Plan
          </button>
          <div class="rp-cta-sub" id="pi-gen-subtext">Sequences backlog stories across sprints and squads.</div>
        </div>`:''}
      </div>
      </div>
      ${trayHtml}
    </div>`;
}

function piValidateStartDate(){
  const inp=document.getElementById('pi-start-date');
  if(!inp)return;
  const latestEnd=piLatestEndDateAcrossPlans();
  if(latestEnd&&inp.value&&new Date(inp.value)<=latestEnd){
    piShowStartDateConflictError(latestEnd);
  } else {
    piClearStartDateConflictError();
  }
}

function piShowStartDateConflictError(conflictEndDate){
  const inp=document.getElementById('pi-start-date');
  const errEl=document.getElementById('pi-start-err');
  const btn=document.getElementById('pi-gen-btn');
  const sub=document.getElementById('pi-gen-subtext');
  if(inp)inp.classList.add('rp-err');
  if(errEl)errEl.textContent='After '+piFmtShortDate(conflictEndDate);
  if(btn)btn.disabled=true;
  if(sub)sub.textContent='Fix the start date above to continue.';
}

function piClearStartDateConflictError(){
  const inp=document.getElementById('pi-start-date');
  const errEl=document.getElementById('pi-start-err');
  const btn=document.getElementById('pi-gen-btn');
  const sub=document.getElementById('pi-gen-subtext');
  if(inp)inp.classList.remove('rp-err');
  if(errEl)errEl.textContent='';
  if(btn)btn.disabled=piGetSquads().length===0;
  if(sub)sub.textContent='Sequences backlog stories across sprints and squads.';
}

// ── v8.98 Deterministic PI Engine ──
// Replaces AI-side graph traversal, cycle detection, arithmetic, and capacity
// bin-packing with real algorithms. The AI (buildPIGeneratePrompt) now only
// supplies per-story semantic subscores + reasoning and dependency edges —
// everything below is pure JS, runs the same way every time, and cannot
// silently mis-report a cycle or over-allocate a squad.

const PI_TIER_RANK={'Must Have':3,'Should Have':2,'Could Have':1};

function piDiagnosticBoost(story){
  if(story.origin!=='diagnostic')return 0;
  const sevW={Critical:4,High:3,Medium:2,Low:1}[story.severity]||0;
  const evM={Strong:1.5,Moderate:1.0,Weak:0.5}[story.evidenceStrength]||0;
  return sevW*evM;
}

function piComputeScore(scoreFields,diagnosticBoost,points){
  const p=points||3;
  const align=scoreFields.piGoalAlignment||1;
  const val=scoreFields.businessValue||1;
  const time=scoreFields.timeCriticality||1;
  const risk=scoreFields.riskReduction||1;
  return (2*align+val+time+risk+diagnosticBoost)/p;
}

// Builds a "blocks" adjacency map (fromId -> [toId,...]) from a flat edge list,
// restricted to known story IDs only (defends against fabricated/invented IDs).
function piBuildBlocksGraph(edges,knownIds){
  const graph={};
  knownIds.forEach(id=>{graph[id]=[];});
  (edges||[]).forEach(edge=>{
    if(!edge||!edge.fromId||!edge.toId)return;
    if(!graph.hasOwnProperty(edge.fromId)||!knownIds.has(edge.toId))return;
    if(graph[edge.fromId].indexOf(edge.toId)===-1)graph[edge.fromId].push(edge.toId);
  });
  return graph;
}

// Detects cycles via 3-color DFS (white/gray/black). Returns a Set of every
// story ID that participates in at least one cycle — these are excluded from
// escalation/sequencing entirely and backlogged directly, per the "do not
// attempt to resolve" rule carried over from the original prompt design.
function piDetectCycles(graph){
  const WHITE=0,GRAY=1,BLACK=2;
  const color={};
  Object.keys(graph).forEach(id=>{color[id]=WHITE;});
  const cyclic=new Set();
  function visit(id,stack){
    color[id]=GRAY;
    stack.push(id);
    (graph[id]||[]).forEach(next=>{
      if(color[next]===GRAY){
        // Found a cycle — mark every node currently on the stack from next's
        // first occurrence onward as cyclic.
        const idx=stack.indexOf(next);
        for(let i=idx;i<stack.length;i++)cyclic.add(stack[i]);
        cyclic.add(next);
      }else if(color[next]===WHITE){
        visit(next,stack);
      }
    });
    stack.pop();
    color[id]=BLACK;
  }
  Object.keys(graph).forEach(id=>{if(color[id]===WHITE)visit(id,[]);});
  return cyclic;
}

// Memoized post-order walk: effective_tier/effective_score of a story =
// max(own, effective value of every story it directly or transitively
// blocks). Cyclic stories are excluded (scored standalone, tier as-is) —
// caller must filter them out before sequencing.
function piEscalate(graph,ownTier,ownScore,cyclicIds){
  const effTier={},effScore={};
  function resolve(id){
    if(effTier.hasOwnProperty(id))return;
    if(cyclicIds.has(id)){effTier[id]=ownTier[id];effScore[id]=ownScore[id];return;}
    let bestTier=ownTier[id],bestScore=ownScore[id];
    (graph[id]||[]).forEach(child=>{
      if(cyclicIds.has(child))return;
      resolve(child);
      if(PI_TIER_RANK[effTier[child]]>PI_TIER_RANK[bestTier])bestTier=effTier[child];
      if(effScore[child]>bestScore)bestScore=effScore[child];
    });
    effTier[id]=bestTier;effScore[id]=bestScore;
  }
  Object.keys(graph).forEach(resolve);
  return{effTier,effScore};
}

// Deterministic capacity-aware sequencing + mandatory backfill. Squad
// "relevance" is intentionally NOT modeled — squads carry only {name,
// capacity} in this app's data model, so assignment is pure load-balancing:
// each ready story goes to whichever squad has the most remaining capacity
// in the current sprint that can still fit it. Per-sprint working capacity
// per squad = squad.capacity / sprintCount (the original prompt's own
// "target pts per sprint" pacing, now enforced exactly rather than aimed for).
function piSequence(rankedIds,effTier,effScore,blockersOf,pointsOf,squads,sprintCount){
  const assignment={}; // storyId -> {sprint, squad}
  const assignedSprintOf={};
  const perSprintCap=squads.map(s=>Math.max(1,Math.round((s.capacity||0)/sprintCount)));
  const unassigned=new Set(rankedIds);

  function isReady(id,sprint){
    return (blockersOf[id]||[]).every(b=>!assignedSprintOf.hasOwnProperty(b)||assignedSprintOf[b]<=sprint);
  }
  function tryAssign(id,sprint,remaining){
    const pts=pointsOf[id]||3;
    let bestIdx=-1,bestRemaining=-1;
    squads.forEach((sq,i)=>{
      if(remaining[i]>=pts&&remaining[i]>bestRemaining){bestRemaining=remaining[i];bestIdx=i;}
    });
    if(bestIdx===-1)return false;
    remaining[bestIdx]-=pts;
    assignment[id]={sprint,squad:squads[bestIdx].name};
    assignedSprintOf[id]=sprint;
    unassigned.delete(id);
    return true;
  }

  for(let sprint=1;sprint<=sprintCount;sprint++){
    const remaining=perSprintCap.slice();
    // Priority pass — ranked order (tier desc, then effective score desc)
    rankedIds.forEach(id=>{
      if(!unassigned.has(id))return;
      if(!isReady(id,sprint))return;
      tryAssign(id,sprint,remaining);
    });
    // Backfill pass — any squad with leftover room takes the next ready,
    // unassigned story regardless of tier, so no usable capacity sits idle.
    let filled=true;
    while(filled){
      filled=false;
      for(const id of rankedIds){
        if(!unassigned.has(id))continue;
        if(!isReady(id,sprint))continue;
        if(tryAssign(id,sprint,remaining)){filled=true;break;}
      }
    }
  }
  return{assignment,backlogIds:Array.from(unassigned)};
}

// ── Generate ──
// Carries the confirmed direction through the modal's own confirmed
// re-entry call (mirrors the pre-existing _pgRegenConfirmed pattern) - true
// when the user chose "Yes, include backlog" on the Case 3 modal.
let _pgRegenIncludeBacklog=false;

function piGetStoryEngineRecord(storyId){
  if(typeof scCanvas!=='undefined'){
    for(const f of scCanvas){
      if(!f.stories)continue;
      const st=f.stories.find(s=>s.id===storyId);
      if(st){
        return {
          id:st.id,title:st.statement||st.title||'',points:st.points||3,
          cap:f.cap||'',name:f.name,stage:f.stage||'',
          priority:st.priority||'Should Have',
          origin:f.origin||'kpi',
          diagnosticContext:f.origin==='diagnostic'?(f.diagnosticContext||null):null,
          intakeBriefId:f.intakeBriefId||null,
          rqNumber:f.rqNumber||null
        };
      }
    }
  }
  if(typeof piStoryPool!=='undefined'&&piStoryPool[storyId])return piStoryPool[storyId];
  return null;
}

// ── Case 3 confirm modal - reuses the same modal component family as the
// pre-existing regen-confirm modal. Cancel / Yes(secondary) / No(primary),
// in that exact order. ──
function piShowBacklogIncludeModal(activePlan){
  const backlogCount=(typeof piBacklogStoryIds!=='undefined'?piBacklogStoryIds.length:0);
  const overlay=document.createElement('div');
  overlay.id='pi-regen-overlay-1';
  overlay.className='modal-overlay';
  overlay.innerHTML=`<div class="modal" style="max-width:420px;;position:relative;">
    <button onclick="document.getElementById('pi-regen-overlay-1').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:16px 44px 14px 16px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:500;color:var(--t1);">Regenerate ${e(activePlan.name||'this plan')}?</div>
    </div>
    <div class="modal-body">${backlogCount} stor${backlogCount!==1?'ies':'y'} are waiting in the backlog tray. Do you want to include them in ${e(activePlan.name||'this plan')}'s regeneration?</div>
    <div class="modal-footer">
      <button class="modal-cancel-btn" onclick="document.getElementById('pi-regen-overlay-1').remove()">Cancel</button>
      <button class="modal-confirm-btn-secondary" onclick="document.getElementById('pi-regen-overlay-1').remove();_pgRegenIncludeBacklog=true;_pgRegenConfirmed=true;piGenerate();">Yes</button>
      <button class="modal-confirm-btn" onclick="document.getElementById('pi-regen-overlay-1').remove();_pgRegenIncludeBacklog=false;_pgRegenConfirmed=true;piGenerate();">No</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const _escR1=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_escR1,true);}};
  document.addEventListener('keydown',_escR1,true);
  trapFocus(overlay);
}

// ── Scoped badge clear (regenerate path) - replaces the old, global
// scClearPIPlannedBadges() call for this codepath. scClearPIPlannedBadges()
// (feature-canvas.js) unconditionally resets EVERY feature's piPlanned/
// piSprintAssigned and every story's _inPIPlan flag across the whole
// session — fine in the single-plan model, but with multiple plans it
// would visibly wipe badges belonging to sibling plans that aren't being
// regenerated at all. feature-canvas.js is out of scope for this task, so
// rather than adding a scoping parameter there, this narrower replacement
// lives here and only touches stories that belong to the plan actually
// being regenerated. ──
function piClearPlanBadgesScoped(plan){
  if(!plan)return;
  const ids=new Set(Object.keys(plan.storyAssignments||{}));
  if(typeof scCanvas!=='undefined'){
    scCanvas.forEach(f=>{
      if(!f.stories)return;
      f.stories.forEach(st=>{
        if(ids.has(st.id))st._inPIPlan=false;
      });
    });
    if(typeof newScRender==='function')newScRender();
  }
}

function piCheckRegenerateOverlap(activePlan,newSprintCount,newSprintDuration){
  const hypotheticalEnd=piComputeEndDate(Object.assign({},activePlan,{sprintCount:newSprintCount,sprintDuration:newSprintDuration}));
  const conflict=(typeof piPlans!=='undefined'?piPlans:[]).find(function(p){
    return p.id!==activePlan.id && hypotheticalEnd && new Date(p.startDate)<=hypotheticalEnd;
  });
  return conflict||null;
}

// ── Generate ──
async function piGenerate(){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const key=getKey();
  if(aiGenInFlight.active){showToast("Still working on your last request. Hang tight, this won't take long.",'info');return;}

  const activePlan=piGetActivePlan();
  const isDrafting=!activePlan; // Case 1: no active plan (or it points at a plan that no longer exists)
  // Adoption Readiness (v9.21, §1.10/§2.5) — captured BEFORE any mutation so
  // the post-regeneration modal only ever fires when a readinessPlan
  // genuinely pre-existed this specific regenerate call.
  const _rpBeforeRegen=(!isDrafting&&typeof rcFindPlan==='function')?rcFindPlan(activePlan.id):null;

  const squads=piGetSquads();
  if(squads.length===0){showToast('Add at least one squad before generating.','warn');return;}

  // ── Case 1 only: read the config form and run the sequential-release
  // check BEFORE the selected-stories guard, per spec. ──
  let draftName,draftStartDate,draftSprintCount,draftSprintDuration,draftKnownDeps;
  if(isDrafting){
    draftName=document.getElementById('pi-name-input')?document.getElementById('pi-name-input').value.trim()||'Release Plan':'Release Plan';
    const startDateEl=document.getElementById('pi-start-date');
    draftStartDate=startDateEl?startDateEl.value:new Date().toISOString().split('T')[0];
    const sprintCountInp=document.getElementById('pi-sprint-count');
    draftSprintCount=sprintCountInp?Math.max(1,Math.min(20,+sprintCountInp.value||6)):6;
    const sprintDurWeeksInp=document.getElementById('pi-sprint-dur-weeks');
    draftSprintDuration=sprintDurWeeksInp?Math.max(1,Math.min(6,+sprintDurWeeksInp.value||2))*7:14;
    const knownDepsEl=document.getElementById('pi-known-deps');
    draftKnownDeps=knownDepsEl?knownDepsEl.value:'';

    const _latestEnd=piLatestEndDateAcrossPlans();
    if(_latestEnd&&new Date(draftStartDate)<=_latestEnd){
      piShowStartDateConflictError(_latestEnd);
      return;
    }
  }

  const _isConfirmedRegen = !!_pgRegenConfirmed;
  _pgRegenConfirmed = false;
  const _includeBacklogInRegen = !!_pgRegenIncludeBacklog;
  _pgRegenIncludeBacklog = false;

  // ── Case 2 / Case 3 - Regenerate branching on the active plan. ──
  if(!isDrafting){
    const backlogNonEmpty=(typeof piBacklogStoryIds!=='undefined'&&piBacklogStoryIds.length>0);
    if(backlogNonEmpty && !_isConfirmedRegen){
      piShowBacklogIncludeModal(activePlan);
      return;
    }
  }

  // ── Build the story pool to sequence ──
  let selectedStories;
  let _claimedBacklogIds=[]; // backlog ids that will be removed from piBacklogStoryIds on success
  if(isDrafting){
    _claimedBacklogIds=(typeof piBacklogStoryIds!=='undefined'?piBacklogStoryIds.slice():[]);
    selectedStories=_claimedBacklogIds.map(piGetStoryEngineRecord).filter(Boolean);
    if(selectedStories.length===0){
      showToast('No stories waiting in the backlog. Send stories from Story Canvas first.','info');
      return;
    }
  } else {
    const existingIds=Array.from(new Set(Object.keys(activePlan.storyAssignments||{})));
    let poolIds=existingIds;
    if(_includeBacklogInRegen){
      _claimedBacklogIds=(typeof piBacklogStoryIds!=='undefined'?piBacklogStoryIds.slice():[]);
      poolIds=Array.from(new Set(poolIds.concat(_claimedBacklogIds)));
    }
    selectedStories=poolIds.map(piGetStoryEngineRecord).filter(Boolean);
    if(selectedStories.length===0){
      showToast('No stories to regenerate.','info');
      return;
    }
  }

  // v8.133 fix (item 3): courtesy pre-check, before any confirm modal.
  if(typeof _lsPeekIfLocked==='function' && typeof _activeSessionId!=='undefined' && _activeSessionId){
    const _peek=await _lsPeekIfLocked(_activeSessionId);
    if(_peek.locked){
      showToast(_peek.holderName+' is already generating on this session. Try again in a moment.','warn');
      return;
    }
  }

  // ── Regenerate-overlap guard (Case 2/3 only) - the active plan's config
  // never changes on regenerate (no config form for an existing plan), so
  // this is really just re-confirming the plan's own dates still clear
  // every sibling plan's start date; hard block, no override. ──
  if(!isDrafting){
    const _overlapConflict=piCheckRegenerateOverlap(activePlan,activePlan.sprintCount,activePlan.sprintDuration);
    if(_overlapConflict){
      showToast('Regenerating '+ (activePlan.name||'this plan') +' would end after '+(_overlapConflict.name||'another plan')+' starts ('+piFormatDate(_overlapConflict.startDate)+'). Adjust dates before regenerating.','error');
      return;
    }
  }

  // Phase 5 (v8.117): immediate visual acknowledgment — disable the
  // button synchronously before any async work (including the lock
  // check). The rich loader is deliberately NOT shown until the lock is
  // confirmed acquired (inside withGenerationLock's callback below) —
  // showing "Generating PI Plan..." before the lock check even runs would
  // misleadingly claim generation started when the app is still only
  // checking whether it's allowed to start.
  const btn=document.getElementById('pi-gen-btn');
  if(btn){btn.disabled=true;btn.innerHTML='<div class="cc-spin-sm"></div> Generating…';}

  const piName=isDrafting?draftName:(activePlan.name||'Release Plan');
  const startDate=isDrafting?draftStartDate:activePlan.startDate;
  const sprintCount=isDrafting?draftSprintCount:activePlan.sprintCount;
  const sprintDuration=isDrafting?draftSprintDuration:activePlan.sprintDuration;
  const knownDeps=isDrafting?draftKnownDeps:'';
  const _scPi=typeof sessionContext!=='undefined'?sessionContext:null;
  const _piProb=(_scPi&&_scPi.productProfile&&_scPi.productProfile.problem)||'';
  const piGoal=(typeof piInputs!=='undefined'&&piInputs.piGoal)||_piProb;
  const _pcPi=(typeof getFullProductCtx==='function')?getFullProductCtx():getProductCtx();
  const productName=_pcPi.name;
  const industry=_pcPi.industry;

  // Compute squad capacities - snapshot, decoupled from the plan's live squads[] via spread
  const squadsCapped=squads.map(s=>({...s,capacity:piCalcCapacity(s)}));

  // Phase 5 (v8.117): attempt marker for this call. PI generation runs
  // 2-4 minutes — the longest-running generation in the app — making it
  // the single most likely case for a user to navigate away mid-call, or
  // for a slow lock-check to resolve well after the user has moved on.
  // Every later write below is guarded against this marker.
  const _attempt=newGenAttempt();

  // Phase 5: withGenerationLock wraps the ENTIRE workflow below — callAPI,
  // parse, validate, the deterministic scoring/sequencing engine, and the
  // sessionStoreSave() calls inside it — not just the callAPI() line. A
  // lock scoped only to the network call would release before this
  // function's own apply/save steps finish, letting a second person start
  // generating against stale data. See api.js for the full rationale.
  try{
    await withGenerationLock(async (_lock) => {
  // Phase 5 fix (v8.118): the destructive wipe (scClearPIPlannedBadges,
  // piPlan=null, piScVersion=null) now happens HERE — after the lock is
  // confirmed acquired, not before this whole withGenerationLock() call
  // even started. If the lock check above had failed instead, execution
  // would never reach this line at all, and the user's existing PI plan
  // would be left completely untouched — exactly the fix this bug needed.
  if(!isDrafting){
    // Scoped wipe - only touches the plan actually being regenerated, never
    // a sibling plan's badges/sprint board. See piClearPlanBadgesScoped()
    // above for why this replaces scClearPIPlannedBadges() here.
    piClearPlanBadgesScoped(activePlan);
    // Item 8: pause (not clear) any pending manual-edit notification —
    // this real regeneration is about to replace the data wholesale, so a
    // stale manual-edit timer firing mid-generation would be redundant at
    // best, confusing at worst. Cleared for good on success (below), or
    // resumed if this attempt doesn't complete (outer catch).
    if(typeof _lsPauseManualEditForRegeneration==='function')_lsPauseManualEditForRegeneration('pi');
  }
  // Lock confirmed — show the real loader now, marker-stamped.
  var piMainLoader=document.getElementById('pi-main');
  if(piMainLoader){piMainLoader.innerHTML=markGenAttempt(_attempt,`<div class="pi-empty">
    <div class="pi-empty-icon"><div class="cc-spin" style="width:32px;height:32px;border-width:3px;"></div></div>
    <div class="pi-empty-title">Generating Release Plan…</div>
    <div class="pi-empty-sub">AI is analysing dependencies, then sequencing across sprints and squads. This takes 2–4 minutes.</div>
  </div>`);}
  try{
    const sys=(typeof SYS_PI!=='undefined'?SYS_PI:'');
    const _piDocRes=(typeof buildDocContext==='function')?buildDocContext('pi',piGoal):{text:'',truncated:false};
    const _piDocCtx=_piDocRes.text;
    _fireDocTruncatedToast(_piDocRes.truncated);
    // v8.98: prompt no longer takes squads/sprintCount/sprintDuration — the AI
    // does not sequence or assign squads/sprints, so it doesn't need them.
    const usr=buildPIGeneratePrompt(
      productName,industry,piGoal,selectedStories,knownDeps,startDate,
      _pcPi.problem||'',_pcPi.kpis||'',
      (typeof piInputs!=='undefined'&&piInputs.constraints)||'',
      _piDocCtx
    );
    const _signal=startAiGen(`Your Release Plan is being scored and sequenced for ${selectedStories.length} stor${selectedStories.length!==1?'ies':'y'}. This can take 2–4 minutes. Leaving now discards it, you'll need to regenerate from scratch.`);
    // v8.98: token budget shrunk — AI now emits 4 semantic subscores + reasoning
    // + dependency edges only, no sequencing/score-arithmetic/tier output.
    const _piTok=Math.min(10000,Math.max(3000,selectedStories.length*120+1500));
    const txt=await callAPI(sys,usr,_piTok,_signal,undefined,'pi-generate');
    const clean=txt.replace(/```json|```/g,'').trim();
    let parsed;
    try{parsed=JSON.parse(clean);}
    catch(pe){
      const s=clean.indexOf('{');const l=clean.lastIndexOf('}');
      if(s>=0&&l>s)try{parsed=JSON.parse(clean.substring(s,l+1));}catch(pe2){throw new Error('Could not parse release plan response.');}
      else throw new Error('Could not parse release plan response.');
    }
    if(!parsed||!parsed.storyScores)throw new Error('Invalid release plan response — missing storyScores.');

    // ── Validate AI response before the deterministic engine ever touches it ──
    const _knownIds=new Set(selectedStories.map(s=>s.id));
    const _missing=selectedStories.filter(s=>!parsed.storyScores.hasOwnProperty(s.id));
    if(_missing.length>0)throw new Error('AI response is missing scores for '+_missing.length+' of '+selectedStories.length+' stories — please regenerate.');

    // ── Deterministic engine: diagnostic boost, composite score, dependency
    // graph + cycle detection, tier escalation, capacity sequencing + backfill ──
    const pointsOf={},ownTier={},ownScore={},scoreFieldsById={};
    selectedStories.forEach(s=>{
      const sf=parsed.storyScores[s.id]||{};
      scoreFieldsById[s.id]=sf;
      pointsOf[s.id]=s.points||3;
      ownTier[s.id]=s.priority||'Should Have';
      ownScore[s.id]=piComputeScore(sf,piDiagnosticBoost(s),s.points||3);
    });

    const _rawDeps=(parsed.dependencies||[]).filter(d=>d&&d.fromId&&d.toId&&_knownIds.has(d.fromId)&&_knownIds.has(d.toId));
    const graph=piBuildBlocksGraph(_rawDeps,_knownIds);
    const cyclicIds=piDetectCycles(graph);
    const{effTier,effScore}=piEscalate(graph,ownTier,ownScore,cyclicIds);

    const blockersOf={};
    _knownIds.forEach(id=>{blockersOf[id]=[];});
    Object.keys(graph).forEach(from=>{
      graph[from].forEach(to=>{if(!cyclicIds.has(from)&&!cyclicIds.has(to))blockersOf[to].push(from);});
    });

    const rankedIds=selectedStories.map(s=>s.id).filter(id=>!cyclicIds.has(id)).sort((a,b)=>{
      const rt=PI_TIER_RANK[effTier[b]]-PI_TIER_RANK[effTier[a]];
      if(rt!==0)return rt;
      return effScore[b]-effScore[a];
    });

    const{assignment,backlogIds}=piSequence(rankedIds,effTier,effScore,blockersOf,pointsOf,squadsCapped,sprintCount);

    // Assemble storyAssignments in the exact shape existing downstream code expects
    const _assignments={};
    Object.keys(assignment).forEach(id=>{
      const sf=scoreFieldsById[id]||{};
      const story=selectedStories.find(s=>s.id===id);
      const breakdown={
        piGoalAlignment:sf.piGoalAlignment||1,
        alignmentReason:sf.alignmentReason||'',
        businessValue:sf.businessValue||1,
        timeCriticality:sf.timeCriticality||1,
        riskReduction:sf.riskReduction||1,
        diagnosticBoost:piDiagnosticBoost(story),
        score:Math.round(ownScore[id]*100)/100
      };
      if(sf.vocSupport)breakdown.vocSupport=sf.vocSupport;
      if(sf.docConflict)breakdown.docConflict=sf.docConflict;
      _assignments[id]={sprint:assignment[id].sprint,squad:assignment[id].squad,points:pointsOf[id],status:'planned',scoreBreakdown:breakdown};
    });

    const backlogNotes={};
    backlogIds.forEach(id=>{backlogNotes[id]='Did not fit within available squad capacity, or a dependency could not be scheduled within this release.';});
    cyclicIds.forEach(id=>{backlogNotes[id]='Dependency cycle detected — excluded pending PM review.';});
    const backlogStoryIds=backlogIds.concat(Array.from(cyclicIds));

    // Build sprint date ranges
    const sprints=piComputeSprints(sprintCount,sprintDuration,startDate);

    // dependencies carried forward in {fromId,toId,source,external} shape —
    // matches every other consumer of piPlan.dependencies in this file
    // (piHasIncomingDep, piGetStoryDeps, piLinkDep, piRemoveDep all read
    // .fromId/.toId/.external, not .from/.to/.type).
    const _piDeps=_rawDeps.map(d=>({fromId:d.fromId,toId:d.toId,source:d.source||'ai',external:false}));

    // Carry story notes from SC to PI plan assignments
    if(typeof scCanvas!=='undefined'){
      scCanvas.forEach(f=>{
        if(!f.stories)return;
        f.stories.forEach(st=>{
          if(st.notes&&_assignments[st.id])_assignments[st.id].note=st.notes;
        });
      });
    }
    // Carry story dependencies from SC into PI deps — fixed to .fromId/.toId
    // shape (was .from/.to, which no downstream consumer actually reads —
    // pre-existing mismatch, corrected here since this block is being rewritten).
    if(typeof scCanvas!=='undefined'){
      scCanvas.forEach(f=>{
        if(!f.stories)return;
        f.stories.forEach(st=>{
          if(!st.dependencies||!st.dependencies.length)return;
          st.dependencies.forEach(dep=>{
            const exists=_piDeps.some(d=>d.fromId===st.id&&d.toId===dep.storyId);
            if(!exists)_piDeps.push({fromId:st.id,toId:dep.storyId,source:'sc',external:false});
          });
        });
      });
    }
    // Build scPiSelectedIds from story-level flags for PI left panel summary
    if(typeof scPiSelectedIds!=='undefined'){
      scPiSelectedIds=new Set();
      scCanvas.forEach(f=>{if(f.stories&&f.stories.some(s=>s._stagedForPI))scPiSelectedIds.add(f.id);});
    }
    const _newSubmittedFeatureIds=Array.from(typeof scPiSelectedIds!=='undefined'?scPiSelectedIds:[]);
    let piPlan;
    if(isDrafting){
      piPlan={
        id:'rp-'+((typeof crypto!=='undefined'&&crypto.randomUUID)?crypto.randomUUID():(Date.now()+'-'+Math.random().toString(36).slice(2))),
        createdAt:Date.now(),
        name:piName,
        startDate,sprintCount,sprintDuration,
        sprints,
        storyAssignments:_assignments,
        dependencies:_piDeps,
        externalDeps:[],
        businessValueBullets:parsed.businessValueBullets||[],
        businessValueOneLiner:parsed.businessValueOneLiner||'',
        backlogNotes,
        submittedFeatureIds:_newSubmittedFeatureIds,
        submittedStoryIds:selectedStories.map(s=>s.id),
        squads:squadsCapped,
        piScVersion:piComputeHashFor(_newSubmittedFeatureIds)
      };
      if(!Array.isArray(piPlans))piPlans=[];
      piPlans.push(piPlan);
      _piActivePlanId=piPlan.id;
    } else {
      // Regenerate in place - keep id/createdAt, replace generated fields.
      piPlan=activePlan;
      piPlan.name=piName;
      piPlan.startDate=startDate;
      piPlan.sprintCount=sprintCount;
      piPlan.sprintDuration=sprintDuration;
      piPlan.sprints=sprints;
      piPlan.storyAssignments=_assignments;
      piPlan.dependencies=_piDeps;
      piPlan.externalDeps=piPlan.externalDeps||[];
      piPlan.businessValueBullets=parsed.businessValueBullets||[];
      piPlan.businessValueOneLiner=parsed.businessValueOneLiner||'';
      piPlan.backlogNotes=backlogNotes;
      piPlan.submittedFeatureIds=_newSubmittedFeatureIds;
      piPlan.submittedStoryIds=selectedStories.map(s=>s.id);
      piPlan.squads=squadsCapped;
      piPlan.piScVersion=piComputeHashFor(_newSubmittedFeatureIds);
    }

    // Claimed backlog stories no longer sit in the shared backlog tray.
    if(_claimedBacklogIds.length&&typeof piBacklogStoryIds!=='undefined'){
      piBacklogStoryIds=piBacklogStoryIds.filter(id=>_claimedBacklogIds.indexOf(id)===-1);
    }
    // Stories that didn't fit this generation (capacity/cycle) return to the
    // SAME shared, global backlog tray - there is only ever one backlog tray
    // in this app, never a plan-scoped one, so every view (config form,
    // sprint board) always shows the identical set of unclaimed stories.
    if(typeof piBacklogStoryIds==='undefined'||!Array.isArray(piBacklogStoryIds))piBacklogStoryIds=[];
    backlogStoryIds.forEach(function(id){if(piBacklogStoryIds.indexOf(id)===-1)piBacklogStoryIds.push(id);});

    // Item 12: stamp piSubmitted only for features referenced by THIS plan
    // (old or new) - never resets a sibling plan's feature flags.
    if(typeof scCanvas!=='undefined'){
      scCanvas.forEach(f=>{
        if(_newSubmittedFeatureIds.includes(f.id)){
          f.piSubmitted=true;
          f.piSubmittedStoryCount=f.stories?f.stories.length:0;
        } else if(!isDrafting && (activePlan.submittedFeatureIds||[]).includes(f.id)){
          f.piSubmitted=false;
          f.piSubmittedStoryCount=0;
        }
      });
    }

    // Apply PI planned badges to Story Canvas
    scApplyPIPlannedBadges(piPlan.storyAssignments);
  piUpdateTabBadge();

    // Adoption Readiness (v9.21, §1.10) — extend the REAL regen path, don't
    // replace it: recompute the readinessPlan's Release-Plan-derived fields
    // and unfreeze it, then show the post-regeneration modal (§2.5) only
    // when one already existed before this call.
    if(_rpBeforeRegen&&typeof rcApplyRegenerationEffect==='function'){
      rcApplyRegenerationEffect(_rpBeforeRegen,piPlan);
      if(typeof rcShowPostRegenModal==='function')rcShowPostRegenModal(piPlan,_rpBeforeRegen);
    }
    // Adoption Readiness (v9.21, §2.3) — first-time sprint-planning-complete
    // confirmation. Fires only on the incomplete->complete transition, once
    // per plan (piPlan._rcCompletionNotified guards re-firing on later
    // visits/regenerations of an already-complete plan).
    if(piPlanSprintComplete(piPlan)&&!piPlan._rcCompletionNotified){
      piPlan._rcCompletionNotified=true;
      if(typeof rcShowReleaseCompleteModal==='function')rcShowReleaseCompleteModal(piPlan);
    }

    // Clear in-flight guard before switching tab — switchTab calls blockIfGenerating
    // which would show the "Hold on" modal if aiGenInFlight is still active.
    endAiGen();

    // Reveal PI tab — piOnTabEnter (called by revealAndSwitchTab) handles piRenderBoard + piCheckStaleness
    revealAndSwitchTab('pi');
    piRenderLeftPanel();
    // Phase 5: checkpoint immediately before the save — per the second
    // adversarial review round, checking lock-lost status only AFTER this
    // whole function returns would be too late; the save would already
    // have happened. Throws generation_lock_lost if the lock was lost
    // mid-generation, which the outer catch (added below) surfaces as a
    // toast without a second, duplicate "PI plan generation failed" toast.
    _lock.throwIfLost();
    if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
      const _ok=await sessionStoreSave(_activeSessionId);
      if(_ok&&typeof _activeSessionIsShared!=='undefined'&&_activeSessionIsShared&&typeof _lsEmitContentEvent==='function'){
        await _lsEmitContentEvent(_activeSessionId,'pi','pi_plan_generated',null,null);
      }
      // Item 8: the regeneration's own event is now durably emitted (or
      // this was a private session with nothing to clear) — fully
      // discard the paused manual-edit state rather than let it resume.
      if(typeof _lsClearManualEditAfterRegeneration==='function')_lsClearManualEditAfterRegeneration('pi');
    }
  }catch(err){
    if(err.name==='AbortError'){
      endAiGen();
      // Phase 5 (v8.117): re-query fresh and check the marker before
      // resetting — if the user has since navigated to a different view,
      // don't reset a #pi-main that no longer belongs to this attempt.
      var _abortMainArea=getIfCurrentAttempt('pi-main',_attempt);
      if(_abortMainArea)piRenderEmpty();
      if(btn){btn.disabled=piGetSquads().length===0;btn.innerHTML='<i class="ti ti-calendar-event" style="font-size:13px;" aria-hidden="true"></i> Regenerate';}
      // Phase 5: rethrow rather than silently return. Per adversarial
      // review, a silent return here made withGenerationLock() see this as
      // a NORMAL SUCCESSFUL completion (fn() resolved without throwing) —
      // indistinguishable from a real generation succeeding. That meant
      // the outer lock-error catch (which resets UI state set BEFORE
      // withGenerationLock was ever called) never ran on abort. Rethrowing
      // preserves this function's own abort-specific cleanup above (which
      // still runs first) while also letting the wrapper's own finally
      // release the DB lock through the normal error path, and letting
      // the outer catch below run its (harmless, idempotent) UI reset too.
      throw err;
    }
    if(err.message==='generation_lock_lost'){
      // Toast already shown by withGenerationLock() itself — avoid a
      // second, confusing "PI plan generation failed" toast on top of it.
      var _llMainArea=getIfCurrentAttempt('pi-main',_attempt);
      if(_llMainArea)piRenderEmpty();
      throw err; // propagate to outer catch for the shared btn/loader reset
    }
    // v8.98 fix: this branch was never resetting #pi-main, so any non-abort
    // failure (timeout, parse error, invalid structure) left the "Generating…"
    // spinner on screen indefinitely even though the toast below fired.
    // Phase 5 (v8.117): marker-guarded — a stale failure must not reset a
    // #pi-main that a different, newer action now owns.
    var _errMainArea=getIfCurrentAttempt('pi-main',_attempt);
    if(_errMainArea)piRenderEmpty();
    showToast('Release plan generation failed: '+err.message,'error');
  }finally{
    if(btn){btn.disabled=piGetSquads().length===0;btn.innerHTML='<i class="ti ti-calendar-event" style="font-size:13px;" aria-hidden="true"></i> Regenerate';}
    endAiGen();
  }
    });
  }catch(lockErr){
    // Phase 5 fix (v8.118): REAL BUG, found via live testing and confirmed
    // via debug logging that piPlan itself was NEVER touched by a rejected
    // lock (the wipe genuinely never runs — see the lock-gated wipe
    // above). The bug was here instead: this catch UNCONDITIONALLY called
    // piRenderEmpty(), which renders the "Configure your squads..." EMPTY
    // STATE regardless of whether piPlan still has real, intact data —
    // meaning a rejected regenerate attempt made an EXISTING, untouched
    // plan visually disappear from the screen, even though the underlying
    // data was completely safe in memory (confirmed live: renavigating
    // away and back to the PI tab correctly showed the intact board,
    // proving the data itself was always fine — only the immediate
    // post-rejection view was wrong). Fixed, per explicit direction to
    // make this foolproof rather than a hand-picked subset: call
    // piOnTabEnter() directly — the SAME function that runs on every
    // normal navigation to this tab (piCheckStaleness + piRenderLeftPanel
    // + the piPlan-conditional board/empty render) — rather than
    // reimplementing a narrower version of its logic here. This
    // guarantees the rejection path can never drift out of sync with
    // normal navigation's behavior, since there is only one function
    // making this decision now, not two similar-but-separate ones.
    var _lockErrMainArea=document.getElementById('pi-main');
    if(_lockErrMainArea&&typeof piOnTabEnter==='function'){
      piOnTabEnter();
    }
    if(btn){btn.disabled=piGetSquads().length===0;btn.innerHTML='<i class="ti ti-calendar-event" style="font-size:13px;" aria-hidden="true"></i> Regenerate';}
    endAiGen();
    // Item 8: this regeneration attempt didn't complete successfully —
    // resume any manual-edit state that was paused at the wipe point, so
    // its own notification can still eventually fire rather than being
    // lost because a regeneration attempt failed. No-op if nothing was
    // ever paused (e.g. the lock was rejected before the wipe even ran).
    if(typeof _lsResumeManualEditAfterFailedRegeneration==='function')_lsResumeManualEditAfterFailedRegeneration('pi');
  }
}

// §9.3 — standalone "Brief" filter (Option A, confirmed decision). PI Canvas
// has never had an Origin-style filter to nest a "Requirement Agent" value
// under (unlike CC/FC), so this is a flat list of finalized RQs, no
// nesting/parent-child mechanic. VIEW-ONLY: narrows which story cards render
// on the board/backlog — never touches piPlan.storyAssignments, sprint
// capacity, or readiness-check logic, all of which read the underlying
// data (piPlan.storyAssignments) directly, never the rendered DOM subset
// (confirmed via piRenderBoard()'s capacity/warning computation, which
// iterates Object.entries(piPlan.storyAssignments) unconditionally, before
// any filter is applied to what's rendered).
let piBriefFilter=new Set();
function _piStoryPassesBriefFilter(story){
  if(!piBriefFilter.size)return true;
  const feat=scCanvas.find(f=>f.stories&&f.stories.some(st=>st.id===story.id));
  return !!(feat&&feat.intakeBriefId&&piBriefFilter.has(feat.intakeBriefId));
}
function piToggleBriefFilter(convId){
  if(piBriefFilter.has(convId))piBriefFilter.delete(convId);else piBriefFilter.add(convId);
  const btn=document.getElementById('pi-brief-filter-btn');
  if(btn)btn.classList.toggle('active',piBriefFilter.size>0);
  piRenderBoard();
}
function piClearBriefFilter(){
  piBriefFilter=new Set();
  const btn=document.getElementById('pi-brief-filter-btn');
  if(btn)btn.classList.remove('active');
  piRenderBoard();
}
function piToggleBriefFilterDrop(evt){
  if(evt)evt.stopPropagation();
  const drop=document.getElementById('pi-brief-filter-drop');
  if(!drop)return;
  const isOpen=drop.classList.contains('open');
  if(isOpen){
    drop.classList.remove('open');
    document.removeEventListener('mousedown',_piBriefFilterDropOutside);
  } else {
    drop.classList.add('open');
    setTimeout(()=>document.addEventListener('mousedown',_piBriefFilterDropOutside),0);
  }
}
function _piBriefFilterDropOutside(ev){
  const drop=document.getElementById('pi-brief-filter-drop');
  if(!drop){document.removeEventListener('mousedown',_piBriefFilterDropOutside);return;}
  if(!drop.contains(ev.target)){
    drop.classList.remove('open');
    document.removeEventListener('mousedown',_piBriefFilterDropOutside);
  }
}
// Flat popover HTML — one row per finalized RA conversation, no Origin
// wrapper. Only rendered (button + popover) when at least one finalized
// conversation exists — matches every other filter's "nothing to filter to
// yet" convention in this app.
function _piBriefFilterBtnHtml(){
  const convs=(typeof raConversations!=='undefined'?raConversations:[]).filter(function(c){return c.status==='finalized';});
  if(!convs.length)return'';
  return `<div class="sc-export-wrap" style="position:relative;">
    <button class="cc-tb-btn${piBriefFilter.size>0?' active':''}" id="pi-brief-filter-btn" onclick="piToggleBriefFilterDrop(event)" style="display:flex;align-items:center;gap:4px;"><i class="ti ti-filter" style="font-size:10px;" aria-hidden="true"></i> Brief <i class="ti ti-chevron-down" style="font-size:10px;" aria-hidden="true"></i></button>
    <div class="cc-export-drop" id="pi-brief-filter-drop">
      <div style="padding:8px 12px 4px;font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--label);">Requirement Briefs</div>
      ${convs.map(function(c){
        const cnt=(typeof scCanvas!=='undefined'?scCanvas.filter(f=>f.intakeBriefId===c.id).reduce((a,f)=>a+(f.stories?f.stories.length:0),0):0);
        const checked=piBriefFilter.has(c.id);
        return `<label class="fc-filter-row"><input type="checkbox" onchange="piToggleBriefFilter('${e(c.id)}')" ${checked?'checked':''}> ${e(c.rqNumber||'')} &mdash; ${e(c.title||'Untitled')} <span style="margin-left:auto;font-size:9px;color:var(--t3);">${cnt}</span></label>`;
      }).join('')}
      <div style="border-top:1px solid var(--divider);margin:4px 0;"></div>
      <div style="padding:4px 12px 8px;"><button onclick="piClearBriefFilter()" style="font-size:10px;color:var(--purple);background:none;border:none;cursor:pointer;font-family:var(--font);padding:0;">Clear all filters</button></div>
    </div>
  </div>`;
}

function piGetSelectedStories(){
  // v7.16: reads _stagedForPI flags (stories staged for PI send in Story Canvas)
  const stories=[];
  if(typeof scCanvas==='undefined')return stories;
  scCanvas.forEach(f=>{
    if(!f.stories||f.stories.length===0)return;
    f.stories.filter(st=>st._inSC&&(st._inPIPlan||st._stagedForPI)).forEach(st=>{
      stories.push({
        id:st.id,title:st.statement||st.title||'',points:st.points||3,
        cap:f.cap||'',name:f.name,stage:f.stage||'',
        priority:st.priority||'Should Have',
        origin:f.origin||'kpi',
        diagnosticContext:f.origin==='diagnostic'?(f.diagnosticContext||null):null,
        // v9.16 (Requirement Agent provenance) — denormalized from the
        // feature onto the story so PI Canvas can trace a story back to the
        // intake conversation/RQ number that generated its feature, without
        // a cross-canvas lookup. null for every non-RA feature (unchanged
        // behavior for existing KPI-linked/PI-first stories).
        intakeBriefId:f.intakeBriefId||null,
        rqNumber:f.rqNumber||null
      });
    });
  });
  return stories;
}

function piGetAllStories(){
  const stories=[];
  scCanvas.forEach(f=>{
    if(f.stories&&f.stories.length>0){
      f.stories.forEach(st=>{
        stories.push({
          id:st.id,title:st.statement||st.title||'',points:st.points||3,
          cap:f.cap||'',name:f.name,stage:f.stage||'',
          // v9.16 — priority/origin were silently dropped here (hand-
          // whitelisted, pre-existing bug, independent of the RA feature)
          // even though piGetSelectedStories() already carried both;
          // fixed alongside the new intakeBriefId/rqNumber fields below.
          priority:st.priority||'Should Have',
          origin:f.origin||'kpi',
          intakeBriefId:f.intakeBriefId||null,
          rqNumber:f.rqNumber||null
        });
      });
    }
  });
  return stories;
}

function piComputeSprints(count,durationDays,startDateStr){
  const sprints=[];
  let current=new Date(startDateStr);
  for(let i=0;i<count;i++){
    const start=new Date(current);
    const end=new Date(current);
    end.setDate(end.getDate()+durationDays-1);
    const _piMonths3=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const fmt=d=>d.getDate()+' '+_piMonths3[d.getMonth()];
    sprints.push({id:i+1,label:'Sprint '+(i+1),dateRange:fmt(start)+' – '+fmt(end)});
    current.setDate(current.getDate()+durationDays);
  }
  return sprints;
}

// ── Regenerate - invoked from the sprint board's kebab menu. piGenerate()
// itself now owns all of the branching (silent regen when the backlog is
// empty, Yes/No/Cancel modal when it isn't) - this is just the entry point. ──
function piConfirmRegenerate(){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  // Adoption Readiness (v9.21, §2.4) — conditional copy branch. If this
  // Release Plan has no readinessPlan yet, behavior is completely
  // unchanged (direct regenerate, no extra modal). If one exists, show the
  // Adoption-Readiness-aware warning first; piGenerate() runs from there.
  const activePlan=piGetActivePlan();
  const existingRp=(activePlan&&typeof rcFindPlan==='function')?rcFindPlan(activePlan.id):null;
  if(activePlan&&existingRp&&typeof rcShowRegenReadinessWarningModal==='function'){
    rcShowRegenReadinessWarningModal(activePlan,existingRp);
    return;
  }
  piGenerate();
}

// ── Board toolbar kebab menu - replaces the old standalone Export button.
// Uses the generic _uiRowMenuToggle(triggerEl, menuHtml) helper already used
// by Outcome Pulse / Home / Team Management. ──
function piPlanMenuHtml(){
  const activePlan=piGetActivePlan();
  const _readinessReady=!!(activePlan&&piPlanSprintComplete(activePlan));
  const readinessItem=_readinessReady
    ?`<div class="tm-menu-item" role="menuitem" style="color:var(--purple);font-weight:700;" onclick="_uiRowMenuClose();piOpenReadinessPlan();"><i class="ti ti-checklist" aria-hidden="true"></i> Readiness Plan</div>`
    :`<div class="tm-menu-item" role="menuitem" tabindex="-1" aria-disabled="true" style="color:var(--label);cursor:not-allowed;" title="Complete sprint planning to enable.">Readiness Plan</div>`;
  return `<div class="tm-menu-static" role="menu">
    <div class="tm-menu-item" role="menuitem" onclick="_uiRowMenuClose();piConfirmRegenerate();"><i class="ti ti-refresh" aria-hidden="true"></i> Regenerate</div>
    <div class="tm-menu-item" role="menuitem" onclick="_uiRowMenuClose();piExportDocx();"><i class="ti ti-download" aria-hidden="true"></i> Export</div>
    <div style="height:1px;background:var(--divider);margin:4px 0;"></div>
    ${readinessItem}
  </div>`;
}

// ── Adoption Readiness entry point (v9.22) — creates the readinessPlan (if
// none exists yet for this Release Plan) and switches into the Adoption
// Readiness tab, per ADOPTION_READINESS_SPEC.md §2.2. ──
function piOpenReadinessPlan(){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const activePlan=piGetActivePlan();
  if(!activePlan||!piPlanSprintComplete(activePlan))return;
  if(typeof rcNavigateToPlan==='function')rcNavigateToPlan(activePlan.id);
}

// ── Sprint board ──
function piRenderBoard(){
  const main=document.getElementById('pi-main');
  const piPlan=piGetActivePlan();
  // v9.01.01 fix: extended guard to also require a genuine sprints array
  // (not just any truthy piPlan) -- centralizing this here protects all 7
  // call sites of this function uniformly, rather than needing to fix each
  // one individually. Strictly safer than before: this only ever turns an
  // existing "do nothing" case into a broader "do nothing," never removes
  // a previously-safe path.
  if(!main||!piPlan||!Array.isArray(piPlan.sprints)||piPlan.sprints.length===0)return;

  const squads=piGetSquads();
  const squadColors=['#5F1EBE','#185FA5','#0F6E56','#C8870A','#A32D2D','#534AB7','#075B5B','#7D3C98'];
  const squadColorMap={};
  squads.forEach((s,i)=>{squadColorMap[s.name]=squadColors[i%squadColors.length];});

  // Check capacity
  const capacityWarnings=piCheckCapacity(squads,squadColorMap);

  // Count assigned stories per sprint per squad for capacity bars
  const sprintSquadPts={};
  piPlan.sprints.forEach(sp=>{sprintSquadPts[sp.id]={};squads.forEach(sq=>{sprintSquadPts[sp.id][sq.name]=0;});});
  Object.entries(piPlan.storyAssignments||{}).forEach(([sid,asgn])=>{
    if(asgn&&asgn.sprint&&sprintSquadPts[asgn.sprint]&&asgn.squad){
      sprintSquadPts[asgn.sprint][asgn.squad]=(sprintSquadPts[asgn.sprint][asgn.squad]||0)+(asgn.points||0);
    }
  });

  const unsavedHtml=''; // Unsaved banner removed per feedback

  // Toolbar
  const warnHtml=capacityWarnings.length>0?`<span class="pi-warn-badge"><i class="ti ti-alert-triangle" style="font-size:10px;" aria-hidden="true"></i> ${capacityWarnings[0]}</span>`:'';
  const totalPts=Object.values(piPlan.storyAssignments||{}).reduce((a,v)=>a+(v&&v.points||0),0);
  const toolbarHtml=`<div class="pi-toolbar">
    <div class="pi-toolbar-l">
      <span class="pi-name-badge">${e(piPlan.name)}</span>
      <span class="pi-summary-badge">${piPlan.sprintCount} sprints &middot; ${totalPts} pts</span>
      ${warnHtml}
    </div>
    <div class="pi-toolbar-r">
      ${_piBriefFilterBtnHtml()}
      <button class="tm-dots" onclick="_uiRowMenuToggle(this,piPlanMenuHtml())" aria-label="Plan actions" aria-haspopup="true" aria-expanded="false"><i class="ti ti-dots-vertical" aria-hidden="true"></i></button>
    </div>
  </div>`;

  // Stale banner placeholder
  const staleBannerHtml=`<div class="pi-stale-banner" id="pi-stale-banner" style="display:none;">
    <span class="pi-stale-banner-msg">Stories changed for features in this plan. Regenerate from the menu to update.</span>
    <button class="pi-stale-dismiss" onclick="piHideStaleBanner()">Dismiss</button>
  </div>`;

  // Build sprint columns
  let boardHtml='<div class="pi-board" id="pi-board">';
  piPlan.sprints.forEach(sprint=>{
    const stories=piGetStoriesForSprint(sprint.id);
    // Capacity bar
    const barSegments=squads.map((sq,i)=>{
      const pts=sprintSquadPts[sprint.id][sq.name]||0;
      const cap=sq.capacity||1;
      const pct=Math.min(100,Math.round(pts/cap*100));
      return`<div class="pi-cap-bar-seg" style="width:${pct}%;background:${squadColors[i%squadColors.length]};opacity:0.7;" title="${sq.name}: ${pts}/${sq.capacity} pts"></div>`;
    }).join('');
    const _sprintEmpty=stories.length===0;
    boardHtml+=`<div class="pi-sprint-col${_sprintEmpty?' pi-sprint-empty':''}" id="pi-col-${sprint.id}" ondragover="piDragOver(event)" ondrop="piDrop(event,${sprint.id})">
      <div class="pi-sprint-hdr">
        <div class="pi-sprint-num">${e(sprint.label)}</div>
        <div class="pi-sprint-dates">${e(sprint.dateRange)}</div>
      </div>
      <div class="pi-cap-bar">${barSegments}</div>
      <div class="pi-sprint-cards" id="pi-cards-${sprint.id}">
        ${stories.filter(_piStoryPassesBriefFilter).map(s=>piRenderStoryCard(s,squadColorMap)).join('')}
        <div class="pi-drop-zone" ondragover="piDragOver(event)" ondrop="piDrop(event,${sprint.id})">Drop here</div>
      </div>
    </div>`;
  });
  boardHtml+='</div>';

  // Backlog tray
  const backlogStories=piGetBacklogStories().filter(_piStoryPassesBriefFilter);
  const backlogHtml=`<div class="pi-backlog-resize-handle" id="pi-backlog-resize" onmousedown="piBacklogResizeStart(event)" title="Drag to resize"></div>
  <div class="pi-backlog-tray" id="pi-backlog-tray" ondragover="piDragOver(event)" ondrop="piDropToBacklog(event)">
    <div class="pi-backlog-hdr">Backlog tray (${backlogStories.length} stories)</div>
    <div class="pi-backlog-cards">${backlogStories.map(s=>{const shortId=s.id?s.id.replace(/[^a-z0-9]/gi,'').substring(0,6).toUpperCase():'';const _canEditPiBl=(typeof canEditSession!=='function')||canEditSession();return`<div class="pi-backlog-card" draggable="${_canEditPiBl}" ${_canEditPiBl?`ondragstart="piDragStart(event,'${e(s.id)}')"`:''} onclick="piOpenBacklogPanel('${e(s.id)}')" title="${e(s.statement||s.title||'')}" style="cursor:${_canEditPiBl?'pointer':'not-allowed'};"><div class="pi-card-hdr-row"><span class="pi-card-id" style="display:block;">${e(shortId)}</span>${_canEditPiBl?`<button type="button" class="pi-card-remove" onclick="event.stopPropagation();event.preventDefault();piRemoveStoryFromBacklog('${e(s.id)}')" title="Move to Story Canvas" aria-label="Remove Story from Release Backlog">✕</button>`:''}</div>${e((s.statement||s.title||'').substring(0,55))}…</div>`;}).join('')}</div>
  </div>`;

  main.innerHTML=`<div class="pi-main-content" id="pi-main-content">${unsavedHtml+toolbarHtml+staleBannerHtml+boardHtml+backlogHtml}</div>`;

  // Re-check staleness
  piCheckStaleness();
}

function piRenderStoryCard(story,squadColorMap){
  const piPlan=piGetActivePlan();
  const asgn=(piPlan&&piPlan.storyAssignments&&piPlan.storyAssignments[story.id])||{};
  const pts=asgn.points||story.points||3;
  const squad=asgn.squad||'—';
  const isManual=asgn.manuallyMoved;
  const isCarryForward=story.carryForward;
  const isBlocked=piIsBlocked(story.id);
  const titleTrunc=(story.statement||story.title||'').substring(0,120);
  // Feature badge colour
  const feat=scCanvas.find(f=>f.stories&&f.stories.some(st=>st.id===story.id));
  const featOrigin=(feat&&feat.origin==='pi')?'pi-origin':'';
  const deps=piGetDepsForStory(story.id);
  const blocksDep=deps.find(d=>d.direction==='blocks'&&!d.external);
  // Short story ID derived from full ID
  const shortId=story.id?story.id.replace(/[^a-z0-9]/gi,'').substring(0,6).toUpperCase():'';
  const stmtShort=(story.statement||story.title||'').substring(0,100);
  const userPts=asgn.userSetPoints;
  const ptsDisplay=userPts?pts+' pts':'~'+pts+' pts';
  const ptsColor=userPts?'color:var(--green);font-weight:700;':'color:var(--t3);';
  const squadColor=squadColorMap&&squad&&squadColorMap[squad]?squadColorMap[squad]:'var(--divider)';
  const dorVal=story.dor||'READY';
  const dorClass=dorVal==='READY'?'pi-card-dor-ready':dorVal==='IN REVIEW'?'pi-card-dor-review':'pi-card-dor-blocked';
  // v9.08: draggable set conditionally — this is the one entry point
  // deliberately using a disabled-not-hidden treatment, per product
  // decision, since removing drag handles while leaving cards visible
  // would look broken rather than intentionally locked.
  const _canEditPiCard=(typeof canEditSession!=='function')||canEditSession();
  return`<div class="pi-story-card${isBlocked?' blocked':''}${isManual?' manually-moved':''}" 
    draggable="${_canEditPiCard}" 
    ${_canEditPiCard?`ondragstart="piDragStart(event,'${e(story.id)}');this.dataset.dragged='1';"`:''}
    onclick="if(!this.dataset.dragged)piOpenRightPanel('${e(story.id)}');delete this.dataset.dragged;"
    ondragend="delete this.dataset.dragged;"
    id="pi-card-${e(story.id)}"
    style="cursor:${_canEditPiCard?'pointer':'not-allowed'};border-left-color:${squadColor};">
    <div class="pi-card-hdr-row">
      <span class="pi-card-id">${e(shortId)}</span>
      ${_canEditPiCard?`<button class="pi-card-remove" onclick="event.stopPropagation();piRemoveStoryFromSprint('${e(story.id)}')" title="Move to backlog">&#x2715;</button>`:''}
    </div>
    <div class="pi-card-title">${e(stmtShort)}</div>
    <div class="pi-card-meta-row">
      ${squad&&squad!=='—'?`<span class="pi-card-squad-badge" style="background:${squadColor};">${e(squad.substring(0,10))}</span>`:''}
      <span class="pi-card-dor-badge ${dorClass}">${e(dorVal)}</span>
      <span class="pi-card-pts" style="${ptsColor}">${e(ptsDisplay)}</span>
    </div>
  </div>`;
}

function piGetStoriesForSprint(sprintId){
  const piPlan=piGetActivePlan();
  const stories=[];
  Object.entries((piPlan&&piPlan.storyAssignments)||{}).forEach(([sid,asgn])=>{
    if(asgn&&asgn.sprint===sprintId){
      const story=piFindStory(sid);
      if(story)stories.push(story);
    }
  });
  return stories;
}

function piGetBacklogStories(){
  const ids=(typeof piBacklogStoryIds!=='undefined'&&Array.isArray(piBacklogStoryIds))?piBacklogStoryIds:[];
  return ids.map(id=>piFindStory(id)).filter(Boolean);
}

function piFindStory(storyId){
  for(const f of scCanvas){
    if(f.stories){const st=f.stories.find(s=>s.id===storyId);if(st)return{...st,featureId:f.id};}
  }
  // Also check piStoryPool (standalone stories — PI demo board and future use)
  if(typeof piStoryPool!=='undefined'&&piStoryPool[storyId])return piStoryPool[storyId];
  return null;
}

// ── Cross-plan dependency lookups - a story's dependencies may live in a
// DIFFERENT plan's dependencies[] than the one currently being viewed
// (e.g. a Release 2 story blocked by a Release 1 story), so these search
// across every plan in piPlans, not just the active one. ──
function piFindOwningPlan(storyId){
  if(typeof piPlans==='undefined'||!Array.isArray(piPlans))return null;
  return piPlans.find(function(p){return p.storyAssignments&&p.storyAssignments.hasOwnProperty(storyId);})||null;
}

function piIsBlocked(storyId){
  if(typeof piPlans==='undefined'||!Array.isArray(piPlans))return false;
  return piPlans.some(function(p){return p.dependencies&&p.dependencies.some(d=>d.toId===storyId&&!d.external);});
}

function piGetDepsForStory(storyId){
  if(typeof piPlans==='undefined'||!Array.isArray(piPlans))return[];
  const deps=[];
  piPlans.forEach(function(p){
    (p.dependencies||[]).forEach(function(d){
      if(d.fromId===storyId||d.toId===storyId){
        const otherId=d.fromId===storyId?d.toId:d.fromId;
        const owningPlan=piFindOwningPlan(otherId);
        deps.push(Object.assign({},d,{
          direction:d.fromId===storyId?(d.direction||'blocks'):'blocked-by',
          _ownerPlanId:p.id,
          _ownerPlanName:p.name,
          _otherPlanName:owningPlan?owningPlan.name:null
        }));
      }
    });
  });
  return deps;
}

function piCheckCapacity(squads,squadColorMap){
  const piPlan=piGetActivePlan();
  const warnings=[];
  if(!piPlan||!piPlan.sprints)return warnings;
  // Per-sprint, per-squad check
  piPlan.sprints.forEach(sprint=>{
    squads.forEach(sq=>{
      const pts=Object.values(piPlan.storyAssignments||{}).filter(a=>a&&a.sprint===sprint.id&&a.squad===sq.name).reduce((sum,a)=>sum+(a.points||0),0);
      if(pts>sq.capacity){
        warnings.push(`Sprint ${sprint.id}: ${sq.name} +${pts-sq.capacity} pts over`);
      }
    });
  });
  // PI-level total check: total assigned vs total squad capacity
  const totalAssigned=Object.values(piPlan.storyAssignments||{}).reduce((a,v)=>a+(v&&v.points||0),0);
  const totalCapacity=squads.reduce((a,sq)=>a+(sq.capacity||0),0);
  if(totalCapacity>0&&totalAssigned>totalCapacity){
    warnings.unshift(`Over capacity: ${totalAssigned} pts planned, ${totalCapacity} pts available (+${totalAssigned-totalCapacity} pts)`);
  }
  return warnings;
}

// ── Drag and drop ──
let piDraggingId=null;

function piDragStart(evt,storyId){
  // v9.08: per product decision, drag-and-drop uses a disabled state
  // rather than hiding the card entirely — removing drag handles while
  // keeping the card visible would look like something is broken, not
  // intentionally locked. Preventing drag start here is the actual
  // enforcement; the card's own render sets draggable=false to match.
  if(typeof canEditSession==='function'&&!canEditSession()){evt.preventDefault();return;}
  piDraggingId=storyId;
  evt.dataTransfer.effectAllowed='move';
  const card=document.getElementById('pi-card-'+storyId);
  if(card)card.classList.add('dragging');
}

function piDragOver(evt){
  evt.preventDefault();
  evt.dataTransfer.dropEffect='move';
  const col=evt.currentTarget.closest('.pi-sprint-col');
  if(col)col.style.borderColor='var(--purple)';
}

// Adoption Readiness (v9.21, §1.9 step 3) — freeze enforcement for the
// Release Plan while its Readiness Plan is finalized. Regenerate remains
// the explicit unfreeze path (§1.10/§2.4/§2.5), so this check must never
// gate piConfirmRegenerate()/piGenerate() itself, only board-edit mutators.
// Guarded: piDrop, piMoveToPrint (covers piUpdateAssignmentSprint and
// piMoveBacklogToSprint, which delegate to it), piDropToBacklog,
// piRemoveStoryFromSprint, piSavePoints, piUpdateAssignment, piLinkDep,
// piRemoveDep, piSyncNewStories, piSetStartDate. Deliberately NOT guarded:
// piSaveNote and piSavePointsBacklog, since neither changes sprint
// membership or release scope (note text and backlog-only point edits
// don't feed Adoption Readiness's story/feature counts or lineage).
function piIsPlanFrozenByReadiness(plan){
  if(!plan)return false;
  const rp=(typeof rcFindPlan==='function')?rcFindPlan(plan.id):null;
  return !!(rp&&rp.status==='finalized');
}

function piDrop(evt,targetSprint){
  evt.preventDefault();
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const piPlan=piGetActivePlan();
  if(piIsPlanFrozenByReadiness(piPlan)){showToast('This release plan is frozen by its finalized Readiness Plan. Regenerate to unlock it.','warn');return;}
  const storyId=piDraggingId;
  piDraggingId=null;
  if(!storyId)return;
  // Reset border highlights
  document.querySelectorAll('.pi-sprint-col').forEach(c=>c.style.borderColor='');
  const card=document.getElementById('pi-card-'+storyId);
  if(card)card.classList.remove('dragging');
  if(!piPlan)return;

  const prev=piPlan.storyAssignments[storyId];
  const prevSprint=prev?prev.sprint:null;
  if(prevSprint===targetSprint)return;

  // Check dependency conflict
  const blocking=piGetBlockingConflict(storyId,targetSprint);
  if(blocking){
    piShowDepConflict(storyId,targetSprint,blocking);
    return;
  }

  piMoveToPrint(storyId,targetSprint,true);
}

function piMoveToPrint(storyId,targetSprint,manual){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const piPlan=piGetActivePlan();
  if(!piPlan)return;
  if(piIsPlanFrozenByReadiness(piPlan)){showToast('This release plan is frozen by its finalized Readiness Plan. Regenerate to unlock it.','warn');return;}
  if(!piPlan.storyAssignments[storyId]){
    piPlan.storyAssignments[storyId]={sprint:targetSprint,squad:'',points:3,status:'planned'};
  } else {
    piPlan.storyAssignments[storyId].sprint=targetSprint;
  }
  if(manual)piPlan.storyAssignments[storyId].manuallyMoved=true;
  if(typeof piBacklogStoryIds!=='undefined'&&Array.isArray(piBacklogStoryIds))piBacklogStoryIds=piBacklogStoryIds.filter(id=>id!==storyId);
  // Adoption Readiness (v9.21, §2.3) — same first-time sprint-planning-complete
  // check as piGenerate(), reachable from manual drag/drop and sprint-select
  // mutators (piDrop, piUpdateAssignmentSprint, piMoveBacklogToSprint all
  // delegate here), since a PM can complete planning manually without ever
  // regenerating.
  if(typeof piPlanSprintComplete==='function'&&piPlanSprintComplete(piPlan)&&!piPlan._rcCompletionNotified){
    piPlan._rcCompletionNotified=true;
    if(typeof rcShowReleaseCompleteModal==='function')rcShowReleaseCompleteModal(piPlan);
  }
  piRenderBoard();
  piUpdateTabBadge();
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    // v8.141 (item 8): mark only once the save has actually resolved
    // successfully — chained via .then(), not called from this function's
    // own top level, so a tab-switch flush can never fire before the
    // underlying data is genuinely durable.
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('pi'); });
  }
}

// ── Drop story back to backlog tray ──
function piDropToBacklog(evt){
  evt.preventDefault();
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const piPlan=piGetActivePlan();
  const storyId=piDraggingId;
  piDraggingId=null;
  document.querySelectorAll('.pi-sprint-col').forEach(c=>c.style.borderColor='');
  if(!storyId||!piPlan)return;
  if(piIsPlanFrozenByReadiness(piPlan)){showToast('This release plan is frozen by its finalized Readiness Plan. Regenerate to unlock it.','warn');return;}
  // Only move if currently assigned to a sprint
  if(!piPlan.storyAssignments||!piPlan.storyAssignments[storyId])return;
  piRemoveStoryFromSprint(storyId);
  piUpdateTabBadge();
}

function piRemoveStoryFromSprint(storyId){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const piPlan=piGetActivePlan();
  if(!piPlan)return;
  if(piIsPlanFrozenByReadiness(piPlan)){showToast('This release plan is frozen by its finalized Readiness Plan. Regenerate to unlock it.','warn');return;}
  if(piPlan.storyAssignments[storyId])delete piPlan.storyAssignments[storyId];
  if(typeof piBacklogStoryIds==='undefined'||!Array.isArray(piBacklogStoryIds))piBacklogStoryIds=[];
  if(!piBacklogStoryIds.includes(storyId))piBacklogStoryIds.push(storyId);
  piRenderBoard();
  // v8.141 fix (bundled with item 8): confirmed missing entirely — this
  // edit was never persisted at all, same class of gap as item 7's three
  // functions. Added here, plus the same mark-after-success chaining.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('pi'); });
  }
}

// ── Remove story from backlog (v9.03: FIX 1.2 + FIX 1.1 async safety) ──
function piRemoveStoryFromBacklog(storyId){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  if(typeof piBacklogStoryIds==='undefined'||!Array.isArray(piBacklogStoryIds))return;
  // FIX 1.3: Idempotence guard — prevent duplicate saves/events on rapid clicks
  if(piBacklogStoryIds.indexOf(storyId)===-1)return;

  // Snapshot current state for revert if save fails
  var oldBacklogIds=piBacklogStoryIds.slice();
  
  // FIX 10.1 (v9.04): Find ORIGINAL story in scCanvas (not copy from piFindStory)
  // piFindStory returns a shallow copy via spread operator, so mutations don't persist
  var story=null;
  var featureId=null;
  if(typeof scCanvas!=='undefined'&&Array.isArray(scCanvas)){
    for(var i=0;i<scCanvas.length;i++){
      var f=scCanvas[i];
      if(f.stories&&Array.isArray(f.stories)){
        for(var j=0;j<f.stories.length;j++){
          if(f.stories[j].id===storyId){
            story=f.stories[j];
            featureId=f.id;
            break;
          }
        }
        if(story)break;
      }
    }
  }
  // Fallback: if not found in scCanvas, check piStoryPool (stories created in PI)
  if(!story&&typeof piStoryPool!=='undefined'&&piStoryPool[storyId]){
    story=piStoryPool[storyId];
  }
  if(!story)return; // Story not found
  
  var oldInPIPlan=story._inPIPlan;
  var oldStagedForPI=story._stagedForPI;
  
  // ── Mutate state optimistically ──
  piBacklogStoryIds=piBacklogStoryIds.filter(function(id){
    return id!==storyId;
  });
  story._inPIPlan=false;
  story._stagedForPI=false;
  
  // ── Render immediately ──
  piRenderBoard();
  piUpdateTabBadge(); // Show unsaved indicator
  
  // ── FIX 1.1: Persist with proper async value capture ──
  var saveSessionId=_activeSessionId;
  var wasSharedSession=(typeof _activeSessionIsShared!=='undefined'&&_activeSessionIsShared);
  
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&saveSessionId){
    sessionStoreSave(saveSessionId).then(function(ok){
      if(!ok){
        // REVERT on save failure
        piBacklogStoryIds=oldBacklogIds;
        story._inPIPlan=oldInPIPlan;
        story._stagedForPI=oldStagedForPI;
        piRenderBoard();
        piUpdateTabBadge();
        
        // Show error to user
        if(typeof showToast==='function'){
          showToast('Failed to save backlog removal. Changes reverted. Please try again.','error');
        }
        return false;
      }
      
      // ── Save succeeded — now emit live-sync event ──
      try {
        if(typeof _lsMarkManualEdit==='function'){
          _lsMarkManualEdit('pi');
        }
      } catch(e){
        console.warn('[PI] Manual edit marker failed:',e);
      }
      
      if(wasSharedSession&&typeof _lsEmitContentEvent==='function'){
        try {
          var emitted=_lsEmitContentEvent(
            saveSessionId,
            'pi',
            'pi_plan_updated',
            null,
            null
          );
          if(emitted&&typeof emitted.catch==='function'){
            emitted.catch(function(e){
              console.warn('[PI] Live-sync event emission failed:',e);
            });
          }
        } catch(e){
          console.warn('[PI] Live-sync event emission failed:',e);
        }
      }
      
      // FIX 10.2 (v9.04): Refresh Story Canvas to reflect updated badge state
      // The story object was mutated (._inPIPlan=false), now SC needs to re-render
      // Works for both private AND shared sessions (user requested both)
      try {
        if(typeof newScRender==='function'){
          newScRender();
        }
      } catch(e){
        console.warn('[PI→SC] Story Canvas refresh failed:',e);
        // Don't block on SC render failure — save already persisted
      }
      
      return true;
    }).catch(function(e){
      console.warn('[PI] Backlog removal save threw exception:',e);
      
      // Revert on exception
      piBacklogStoryIds=oldBacklogIds;
      story._inPIPlan=oldInPIPlan;
      story._stagedForPI=oldStagedForPI;
      piRenderBoard();
      piUpdateTabBadge();
      
      if(typeof showToast==='function'){
        showToast('Failed to save backlog removal. Changes reverted. Please try again.','error');
      }
    });
  }
}

function piGetBlockingConflict(storyId,targetSprint){
  const piPlan=piGetActivePlan();
  // Searches across every plan's dependencies (a blocker may live in a
  // different release plan than the one being viewed).
  const blockers=[];
  (typeof piPlans!=='undefined'&&Array.isArray(piPlans)?piPlans:[]).forEach(function(p){
    (p.dependencies||[]).forEach(function(d){
      if(d.toId===storyId&&!d.external)blockers.push(d);
    });
  });
  for(const dep of blockers){
    const owningPlan=piFindOwningPlan(dep.fromId);
    const blockerAsgn=owningPlan&&owningPlan.storyAssignments[dep.fromId];
    if(!blockerAsgn)continue;
    // Sprint numbers are only comparable within the same plan's timeline -
    // a blocker in a different plan is treated as an unconditional conflict.
    const sameplan=piPlan&&owningPlan&&owningPlan.id===piPlan.id;
    if((sameplan&&blockerAsgn.sprint>targetSprint)||!sameplan){
      const blocker=piFindStory(dep.fromId);
      return{blocker,blockerSprint:blockerAsgn.sprint,blockerPlanName:owningPlan.name,crossPlan:!sameplan};
    }
  }
  return null;
}

function piShowDepConflict(storyId,targetSprint,conflict){
  const overlay=document.createElement('div');
  overlay.id='pi-dep-conflict-overlay';
  overlay.className='modal-overlay';
  overlay.innerHTML=`<div class="modal" style="max-width:380px;;position:relative;">
    <button onclick="document.getElementById('pi-dep-conflict-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:16px 44px 14px 16px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:500;color:var(--t1);">Dependency conflict</div>
    </div>
    <div class="modal-body">This story depends on "${e((conflict.blocker&&conflict.blocker.statement||'a story').substring(0,60))}" which is in Sprint ${conflict.blockerSprint}. Moving here may break this dependency.</div>
    <div class="modal-footer">
      <button class="modal-cancel-btn" onclick="document.getElementById('pi-dep-conflict-overlay').remove()">Keep as-is</button>
      <button class="modal-confirm-btn" onclick="document.getElementById('pi-dep-conflict-overlay').remove();piMoveToPrint('${e(storyId)}',${targetSprint},true);piMoveToPrint('${e(conflict.blocker&&conflict.blocker.id||'')}',${targetSprint},true)">Move blocker too</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const _escDep=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_escDep,true);}};
  document.addEventListener('keydown',_escDep,true);
  trapFocus(overlay);
}

// ── Stale banner ──
function piShowStaleBanner(){
  const b=document.getElementById('pi-stale-banner');
  if(b)b.style.display='';
}
function piHideStaleBanner(){
  const b=document.getElementById('pi-stale-banner');
  if(b)b.style.display='none';
}

function piSyncNewStories(){
  // Additive sync — add new stories to backlog only
  const piPlan=piGetActivePlan();
  if(!piPlan)return;
  if(piIsPlanFrozenByReadiness(piPlan))return;
  const currentHash=piComputeHash();
  const prevIds=(piPlan.piScVersion||'').split('|');
  const currentIds=scCanvas.map(f=>f.id);
  const newFeatureIds=currentIds.filter(id=>!prevIds.includes(id));
  const newStories=[];
  scCanvas.filter(f=>newFeatureIds.includes(f.id)&&f.stories).forEach(f=>{
    f.stories.forEach(st=>newStories.push(st.id));
  });
  if(typeof piBacklogStoryIds==='undefined'||!Array.isArray(piBacklogStoryIds))piBacklogStoryIds=[];
  newStories.forEach(id=>{if(!piBacklogStoryIds.includes(id))piBacklogStoryIds.push(id);});
  piPlan.piScVersion=currentHash;
  piHideStaleBanner();
  piRenderBoard();
}

// ── Right panel ──
let piRPStoryId=null;

function piOpenRightPanel(storyId){
  // Toggle-close: clicking the already-open story closes the panel
  if(piRPStoryId===storyId){piCloseRightPanel();return;}
  piRPStoryId=storyId;
  let panel=document.getElementById('pi-right-panel');
  if(!panel){
    panel=document.createElement('div');
    panel.id='pi-right-panel';
    panel.className='pi-right-panel';
    const piMain=document.getElementById('pi-main');
    if(piMain)piMain.appendChild(panel);
    else document.body.appendChild(panel);
  }
  panel.classList.add('open');
  piRenderRightPanel(storyId);
}

function piCloseRightPanel(){
  const panel=document.getElementById('pi-right-panel');
  if(panel)panel.classList.remove('open');
  piRPStoryId=null;
}

// Story Statement+AC / shared-sections body — identical between the sprint
// right panel and the backlog panel, factored out so a future tweak doesn't
// have to be made in both places (and can't quietly drift between them).
function piRenderStoryBodyHtml(story){
  if((story.storyType||'traditional')==='traditional'){
    return `<div class="pi-rp-section">
        <div class="pi-rp-section-lbl">Story Statement</div>
        <div class="pi-rp-story-stmt">${e(story.statement||story.title||'')}</div>
      </div>
      ${story.scenarios&&story.scenarios.length>0?`<div class="pi-rp-section">
        <details class="pi-rp-ac-details">
          <summary class="pi-rp-section-lbl pi-rp-ac-summary">Acceptance Criteria <span class="pi-rp-ac-count">${story.scenarios.length} scenario${story.scenarios.length!==1?'s':''}</span></summary>
          ${story.scenarios.map(sc=>`<div class="pi-rp-ac-row"><div class="pi-rp-ac-name">${e(sc.name||'')}</div><div class="pi-rp-ac-line"><span class="pi-rp-ac-kw">Given</span> ${e(sc.given||'')}</div><div class="pi-rp-ac-line"><span class="pi-rp-ac-kw">When</span> ${e(sc.when||'')}</div><div class="pi-rp-ac-line"><span class="pi-rp-ac-kw">Then</span> ${e(sc.then||'')}</div></div>`).join('')}
        </details>
      </div>`:''}`;
  }
  return (typeof scGetStorySections==='function'?scGetStorySections(story):[]).map((sec,si)=>`<div class="pi-rp-section">
        <div class="pi-rp-section-lbl">${e(sec.label)}</div>
        ${si===0?`<div class="pi-rp-story-stmt">${sec.html}</div>`:sec.html}
      </div>`).join('');
}

function piRenderRightPanel(storyId){
  const panel=document.getElementById('pi-right-panel');
  if(!panel)return;
  const piPlan=piGetActivePlan();
  const shortId=storyId?storyId.replace(/[^a-z0-9]/gi,'').substring(0,6).toUpperCase():'';
  const story=piFindStory(storyId);
  if(!story){panel.innerHTML='<div class="pi-rp-scroll"><p style="padding:20px;color:var(--t3);">Story not found.</p></div>';return;}
  const asgn=(piPlan&&piPlan.storyAssignments&&piPlan.storyAssignments[storyId])||{sprint:1,squad:'',points:3};
  const feat=scCanvas.find(f=>f.stories&&f.stories.some(st=>st.id===storyId));
  const squads=piGetSquads();
  const deps=piGetDepsForStory(storyId);
  const note=(asgn.note)||'';
  const allStories=piPlan?Object.keys(piPlan.storyAssignments):[];
  // v9.08.02: computed once per panel render.
  const _canEditPiRp=(typeof canEditSession!=='function')||canEditSession();

  panel.innerHTML=`
    <div class="pi-rp-hdr" style="position:relative;">
      <div class="pi-rp-breadcrumb">
        ${feat?`<span>${e(feat.cap||feat.name||'')}</span><span style="color:var(--label)">›</span>`:''}
        <span>Sprint ${asgn.sprint||'—'}</span>
      </div>
      <div style="display:flex;align-items:baseline;gap:6px;padding-right:32px;">
        <span class="pi-card-id">${e(shortId)}</span>
        <div class="pi-rp-title" style="flex:1;min-width:0;">${e((story.title||story.statement||'').substring(0,80))}</div>
      </div>
      <button class="pi-rp-close" onclick="piCloseRightPanel()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="pi-rp-scroll">
      ${piRenderStoryBodyHtml(story)}
      <div class="pi-rp-section">
        <div class="pi-rp-section-lbl">Planning</div>
        <div class="pi-rp-planning-row">
          <div class="pi-rp-field"><div class="pi-rp-field-lbl">Points</div>
            <span class="pi-rp-pts-badge${asgn.userSetPoints?' pi-rp-pts-user-set':''}${_canEditPiRp?'':' pi-rp-pts-badge-disabled'}" id="pi-rp-pts-${storyId}" ${_canEditPiRp?`onclick="piEditPoints('${e(storyId)}')" title="Click to edit"`:''}>${asgn.userSetPoints?(asgn.points||3)+' pts':'~'+(asgn.points||3)+' pts'}</span>
          </div>
          <div class="pi-rp-field"><div class="pi-rp-field-lbl">Squad</div>
            <select class="pi-rp-select" onchange="piUpdateAssignment('${e(storyId)}','squad',this.value)" ${_canEditPiRp?'':'disabled'}>
              <option value="">— Assign squad —</option>
              ${squads.map(sq=>`<option value="${e(sq.name)}" ${asgn.squad===sq.name?'selected':''}>${e(sq.name)}</option>`).join('')}
            </select>
          </div>
          <div class="pi-rp-field"><div class="pi-rp-field-lbl">Sprint</div>
            <select class="pi-rp-select" onchange="piUpdateAssignmentSprint('${e(storyId)}',+this.value)" ${_canEditPiRp?'':'disabled'}>
              ${piPlan.sprints.map(sp=>`<option value="${sp.id}" ${asgn.sprint===sp.id?'selected':''}>${e(sp.label)}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>
      <div class="pi-rp-section">
        <div class="pi-rp-section-lbl">Dependencies</div>
        ${deps.length===0?'<div style="font-size:11px;color:var(--label);">No dependencies.</div>':''}
        ${deps.map(d=>{
          const otherId=d.direction==='blocks'?d.toId:d.fromId;
          const otherPlan=piFindOwningPlan(otherId);
          const otherSprint=otherPlan&&otherPlan.storyAssignments[otherId]?otherPlan.storyAssignments[otherId].sprint:'?';
          const crossPlanTag=(otherPlan&&piPlan&&otherPlan.id!==piPlan.id)?` <span class="pi-rp-dep-plan-tag">in ${e(otherPlan.name||'another plan')}</span>`:'';
          return `<div class="pi-rp-dep-row">
          <span class="pi-rp-dep-dir">${d.direction==='blocks'?'&#128279; This blocks':'&#9940; Blocked by'}</span>
          <span class="pi-rp-dep-name">${e((piFindStory(otherId)||{statement:otherId}).statement||'').substring(0,50)}${crossPlanTag}</span>
          <span class="pi-rp-dep-sprint">S${otherSprint}</span>
          <span class="pi-rp-dep-source ${d.source||'ai'}">${d.source==='user'?'user set':'AI inferred'}</span>
          ${_canEditPiRp?`<button class="pi-rp-dep-remove" onclick="piRemoveDep('${e(storyId)}','${e(d.fromId||'')}','${e(d.toId||'')}')">&#x2715;</button>`:''}
        </div>`;
        }).join('')}
        <div id="pi-rp-dep-form-${storyId}"></div>
        ${_canEditPiRp?`<button class="pi-rp-add-dep-link" onclick="piShowAddDepForm('${e(storyId)}')">+ Add Dependency</button>`:''}
      </div>
      <div class="pi-rp-section">
        <div class="pi-rp-section-lbl">Note <span style="font-size:9px;color:var(--label);">${RELEASE_EXPORT_NOTE_LABEL}</span></div>
        <textarea class="pi-rp-note-area" id="pi-rp-note-${storyId}" maxlength="300" ${_canEditPiRp?`onblur="piSaveNote('${e(storyId)}',this.value)"`:'readonly'}>${e(note)}</textarea>
        <div class="pi-rp-counter" id="pi-rp-note-count-${storyId}">${note.length} / 300</div>
      </div>
    </div>
    <div class="pi-rp-footer">
      <div id="pi-rp-remove-confirm-${storyId}" style="margin-bottom:6px;display:none;"></div>
      ${_canEditPiRp?`<button class="pi-rp-remove-link" onclick="piShowRemoveConfirm('${e(storyId)}')"><i class="ti ti-trash" style="font-size:10px;" aria-hidden="true"></i> Remove from Release?</button>`:''}
    </div>`;
  // Wire note counter
  const noteArea=document.getElementById('pi-rp-note-'+storyId);
  if(noteArea){noteArea.oninput=function(){const c=document.getElementById('pi-rp-note-count-'+storyId);if(c)c.textContent=this.value.length+' / 300';};}
}

function piEditPoints(storyId){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const piPlan=piGetActivePlan();
  const asgn=piPlan&&piPlan.storyAssignments&&piPlan.storyAssignments[storyId];
  if(!asgn)return;
  const badge=document.getElementById('pi-rp-pts-'+storyId);
  if(!badge)return;
  const current=asgn.points||3;
  badge.outerHTML=`<input class="pi-rp-pts-input" id="pi-rp-pts-${storyId}" type="number" min="1" max="20" value="${current}" onblur="piSavePoints('${storyId}',+this.value)" onkeydown="if(event.key==='Enter')this.blur()">`;
  const inp=document.getElementById('pi-rp-pts-'+storyId);
  if(inp){inp.focus();inp.select();}
}

function piSavePoints(storyId,pts){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const piPlan=piGetActivePlan();
  if(piIsPlanFrozenByReadiness(piPlan)){showToast('This release plan is frozen by its finalized Readiness Plan. Regenerate to unlock it.','warn');return;}
  if(!piPlan||!piPlan.storyAssignments[storyId])return;
  piPlan.storyAssignments[storyId].points=Math.max(1,Math.min(20,pts||3));
  piPlan.storyAssignments[storyId].userSetPoints=true;
  // Refresh board capacity bars without full re-render
  piRenderBoard();
  piOpenRightPanel(storyId);
  // v8.133 fix (item 7): confirmed live — this edit was never persisted at
  // all, for anyone, shared or not. Matches the exact save-guard already
  // used by every other manual-edit function in this file.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('pi'); });
  }
}

function piUpdateAssignment(storyId,field,value){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const piPlan=piGetActivePlan();
  if(!piPlan||!piPlan.storyAssignments[storyId])return;
  if(piIsPlanFrozenByReadiness(piPlan)){showToast('This release plan is frozen by its finalized Readiness Plan. Regenerate to unlock it.','warn');return;}
  piPlan.storyAssignments[storyId][field]=value;
  if(typeof piPlanSprintComplete==='function'&&piPlanSprintComplete(piPlan)&&!piPlan._rcCompletionNotified){
    piPlan._rcCompletionNotified=true;
    if(typeof rcShowReleaseCompleteModal==='function')rcShowReleaseCompleteModal(piPlan);
  }
  piRenderBoard();
  piOpenRightPanel(storyId);
  // v8.133 fix (item 7): see piSavePoints() above for the full rationale.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('pi'); });
  }
}

function piUpdateAssignmentSprint(storyId,newSprint){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const conflict=piGetBlockingConflict(storyId,newSprint);
  if(conflict){piShowDepConflict(storyId,newSprint,conflict);return;}
  piMoveToPrint(storyId,newSprint,false);
  piOpenRightPanel(storyId);
}

function piSaveNote(storyId,note){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const piPlan=piGetActivePlan();
  if(!piPlan||!piPlan.storyAssignments[storyId])return;
  piPlan.storyAssignments[storyId].note=note;
  // v8.133 fix (item 7): see piSavePoints() above for the full rationale.
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('pi'); });
  }
}


function piShowAddDepForm(storyId){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const container=document.getElementById('pi-rp-dep-form-'+storyId);
  if(!container)return;
  const allOtherStories=piGetAllStories().filter(s=>s.id!==storyId).sort((a,b)=>(a.id||'').localeCompare(b.id||''));
  container.innerHTML=`<div class="pi-rp-add-dep-form">
    <div class="pi-rp-dir-toggle">
      <button class="pi-rp-dir-btn active" id="dep-dir-blocks-${e(storyId)}" onclick="piSetDepDir('blocks','${e(storyId)}')">This Blocks &rarr;</button>
      <button class="pi-rp-dir-btn" id="dep-dir-blocked-${e(storyId)}" onclick="piSetDepDir('blocked-by','${e(storyId)}')">&#8592; Blocked By</button>
      <button class="pi-rp-dir-btn" id="dep-dir-external-${e(storyId)}" onclick="piSetDepDir('external','${e(storyId)}')">&#9881; External</button>
    </div>
    <div id="dep-story-select-${e(storyId)}">
      <div style="position:relative;margin-bottom:6px;">
        <input type="text" id="pi-dep-search-${e(storyId)}" placeholder="Search stories…" oninput="piFilterDepSearch('${e(storyId)}')" autocomplete="off"
          style="width:100%;height:28px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);box-sizing:border-box;"/>
        <div id="pi-dep-list-drop-${e(storyId)}" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid var(--divider);border-radius:5px;max-height:160px;overflow-y:auto;z-index:20;box-shadow:0 4px 12px rgba(0,0,0,0.08);">
          ${allOtherStories.map(s=>{const _owningPlan=piFindOwningPlan(s.id);const _planTag=_owningPlan?` &middot; ${e(_owningPlan.name||'')}`:'';return`<div class="nsc-dep-option" data-id="${e(s.id)}" onclick="piSelectDepStory('${e(storyId)}','${e(s.id)}','${e((s.title||s.statement||'').substring(0,60)).replace(/'/g,"&#39;")}')" style="padding:6px 10px;font-size:10px;cursor:pointer;border-bottom:1px solid var(--divider);color:var(--t2);">[${e(s.id)}] ${e((s.title||s.statement||'').substring(0,55))}${_planTag}</div>`;}).join('')||'<div style="padding:8px 10px;font-size:10px;color:var(--label);">No other stories yet.</div>'}
        </div>
      </div>
      <div id="pi-dep-selected-${e(storyId)}" style="font-size:10px;color:var(--purple);margin-bottom:6px;min-height:16px;"></div>
    </div>
    <div style="display:flex;gap:6px;align-items:center;">
      <button class="cc-btn-primary" style="width:auto;padding:5px 12px;font-size:11px;" onclick="piLinkDep('${e(storyId)}')">Link &#10003;</button>
      <button class="pi-rp-cancel" onclick="document.getElementById('pi-rp-dep-form-${e(storyId)}').innerHTML=''">Cancel</button>
    </div>
  </div>`;
  container._currentDir='blocks';
}

function piSetDepDir(dir,storyId){
  const container=document.getElementById('pi-rp-dep-form-'+storyId);
  if(container)container._currentDir=dir;
  ['blocks','blocked','external'].forEach(d=>{
    const btn=document.getElementById('dep-dir-'+d+'-'+storyId);
    if(btn)btn.classList.toggle('active',d===dir||(dir==='blocked-by'&&d==='blocked'));
  });
  const sel=document.getElementById('dep-story-select-'+storyId);
  if(sel){
    if(dir==='external'){
      sel.innerHTML=`<textarea class="pi-rp-note-area" id="dep-ext-desc-${e(storyId)}" placeholder="Describe the external dependency..." rows="2" maxlength="300"></textarea>`;
    } else {
      const allOtherStories=piGetAllStories().filter(s=>s.id!==storyId);
      sel.innerHTML=`<div style="position:relative;margin-bottom:6px;">
        <input type="text" id="pi-dep-search-${e(storyId)}" placeholder="Search stories…" oninput="piFilterDepSearch('${e(storyId)}')" autocomplete="off"
          style="width:100%;height:28px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);box-sizing:border-box;"/>
        <div id="pi-dep-list-drop-${e(storyId)}" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid var(--divider);border-radius:5px;max-height:160px;overflow-y:auto;z-index:20;box-shadow:0 4px 12px rgba(0,0,0,0.08);">
          ${allOtherStories.map(s=>{const _owningPlan=piFindOwningPlan(s.id);const _planTag=_owningPlan?` &middot; ${e(_owningPlan.name||'')}`:'';return`<div class="nsc-dep-option" data-id="${e(s.id)}" onclick="piSelectDepStory('${e(storyId)}','${e(s.id)}','${e((s.title||s.statement||'').substring(0,60)).replace(/'/g,"&#39;")}')" style="padding:6px 10px;font-size:10px;cursor:pointer;border-bottom:1px solid var(--divider);color:var(--t2);">[${e(s.id)}] ${e((s.title||s.statement||'').substring(0,55))}${_planTag}</div>`;}).join('')||'<div style="padding:8px 10px;font-size:10px;color:var(--label);">No stories yet.</div>'}
        </div>
      </div>
      <div id="pi-dep-selected-${e(storyId)}" style="font-size:10px;color:var(--purple);margin-bottom:6px;min-height:16px;"></div>`;
    }
  }
}

// ── PI dep search state ──
let _piDepSelectedId='';
let _piDepSelectedTitle='';

function piFilterDepSearch(storyId){
  const inp=document.getElementById('pi-dep-search-'+storyId);
  const drop=document.getElementById('pi-dep-list-drop-'+storyId);
  if(!inp||!drop)return;
  const q=inp.value.trim().toLowerCase();
  drop.style.display='block';
  Array.from(drop.querySelectorAll('.nsc-dep-option')).forEach(opt=>{
    opt.style.display=opt.textContent.toLowerCase().includes(q)||!q?'':'none';
  });
}

function piSelectDepStory(storyId,targetId,targetTitle){
  _piDepSelectedId=targetId;
  _piDepSelectedTitle=targetTitle;
  const inp=document.getElementById('pi-dep-search-'+storyId);
  const drop=document.getElementById('pi-dep-list-drop-'+storyId);
  const sel=document.getElementById('pi-dep-selected-'+storyId);
  if(inp)inp.value='';
  if(drop)drop.style.display='none';
  if(sel)sel.textContent='Selected: ['+targetId+'] '+targetTitle;
}

function piLinkDep(storyId){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const piPlan=piGetActivePlan();
  const container=document.getElementById('pi-rp-dep-form-'+storyId);
  const dir=container&&container._currentDir||'blocks';
  if(!piPlan)return;
  if(piIsPlanFrozenByReadiness(piPlan)){showToast('This release plan is frozen by its finalized Readiness Plan. Regenerate to unlock it.','warn');return;}
  if(!piPlan.dependencies)piPlan.dependencies=[];
  if(dir==='external'){
    const desc=document.getElementById('dep-ext-desc-'+storyId);
    if(desc&&desc.value){
      if(!piPlan.externalDeps)piPlan.externalDeps=[];
      piPlan.externalDeps.push({storyId,description:desc.value});
    }
  }else{
    const targetId=_piDepSelectedId;
    if(!targetId){showToast('Select a story first.','warn');return;}
    const fromId=dir==='blocks'?storyId:targetId;
    const toId=dir==='blocks'?targetId:storyId;
    piPlan.dependencies.push({fromId,toId,direction:'blocks',source:'user',external:false});
    _piDepSelectedId='';
    _piDepSelectedTitle='';
  }
  container.innerHTML='';
  piRenderRightPanel(storyId);
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('pi'); });
  }
}

function piRemoveDep(storyId,fromId,toId){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const piPlan=piGetActivePlan();
  if(!piPlan||!piPlan.dependencies)return;
  if(piIsPlanFrozenByReadiness(piPlan)){showToast('This release plan is frozen by its finalized Readiness Plan. Regenerate to unlock it.','warn');return;}
  piPlan.dependencies=piPlan.dependencies.filter(d=>!(d.fromId===fromId&&d.toId===toId));
  piRenderBoard();
  piRenderRightPanel(storyId);
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId).then(function(ok){ if(ok&&typeof _lsMarkManualEdit==='function')_lsMarkManualEdit('pi'); });
  }
}

function piShowRemoveConfirm(storyId){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const container=document.getElementById('pi-rp-remove-confirm-'+storyId);
  if(!container)return;
  container.style.display='block';
  container.innerHTML=`<div class="pi-rp-confirm-strip">
    <span class="pi-rp-confirm-note">Story moves to Backlog Tray. You can re-plan it from there.</span>
    <button class="pi-rp-cancel" onclick="document.getElementById('pi-rp-remove-confirm-${storyId}').style.display='none';document.getElementById('pi-rp-remove-confirm-${storyId}').innerHTML=''">Cancel</button>
    <button class="pi-rp-confirm-yes" onclick="piRemoveStoryFromSprint('${e(storyId)}');piCloseRightPanel()">Yes, Remove</button>
  </div>`;
}

// ── Highlight feature (called from Story Canvas) ──
function piHighlightFeature(featureId){}

// ── Export DOCX (triggers export-pi-docx.js) ──
function piExportDocx(){
  if(typeof buildAndDownloadPIDocx==='function'){
    buildAndDownloadPIDocx();
  } else {
    showToast('Release Canvas export module not loaded.','error');
  }
}

// ── Backlog story right panel — same as piOpenRightPanel but without sprint assignment ──
function piOpenBacklogPanel(storyId){
  // Toggle-close: clicking the already-open story closes the panel
  if(piRPStoryId===storyId){piCloseRightPanel();return;}
  piRPStoryId=storyId;
  let panel=document.getElementById('pi-right-panel');
  if(!panel){
    panel=document.createElement('div');
    panel.id='pi-right-panel';
    panel.className='pi-right-panel';
    const piMain=document.getElementById('pi-main');
    if(piMain)piMain.appendChild(panel);
    else document.body.appendChild(panel);
  }
  panel.classList.add('open');
  const piPlan=piGetActivePlan();
  const story=piFindStory(storyId);
  if(!story){panel.innerHTML='<div class="pi-rp-scroll"><p style="padding:20px;color:var(--t3);">Story not found.</p></div>';return;}
  const feat=scCanvas.find(f=>f.stories&&f.stories.some(st=>st.id===storyId));
  const asgn=(piPlan&&piPlan.storyAssignments&&piPlan.storyAssignments[storyId])||{points:story.points||3};
  const note=(asgn.note)||'';
  const squads=piGetSquads();
  const shortId=storyId?storyId.replace(/[^a-z0-9]/gi,'').substring(0,6).toUpperCase():'';
  // v9.08.02: computed once per backlog panel render.
  const _canEditPiBlRp=(typeof canEditSession!=='function')||canEditSession();
  panel.innerHTML=`
    <div class="pi-rp-hdr" style="position:relative;">
      <div class="pi-rp-breadcrumb">
        ${feat?`<span>${e(feat.cap||feat.name||'')}</span><span style="color:var(--label)">›</span>`:''}
        <span style="color:var(--amber);font-weight:600;">Backlog</span>
      </div>
      <div style="display:flex;align-items:baseline;gap:6px;padding-right:32px;">
        <span class="pi-card-id">${e(shortId)}</span>
        <div class="pi-rp-title" style="flex:1;min-width:0;">${e((story.title||story.statement||'').substring(0,80))}</div>
      </div>
      <button class="pi-rp-close" onclick="piCloseRightPanel()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="pi-rp-scroll">
      ${piRenderStoryBodyHtml(story)}
      <div class="pi-rp-section">
        <div class="pi-rp-section-lbl">Planning</div>
        <div class="pi-rp-planning-row" style="align-items:center;gap:12px;">
          <div class="pi-rp-field"><div class="pi-rp-field-lbl">Points</div>
            <span class="pi-rp-pts-badge${asgn.userSetPoints?' pi-rp-pts-user-set':''}${_canEditPiBlRp?'':' pi-rp-pts-badge-disabled'}" id="pi-rp-pts-${storyId}" ${_canEditPiBlRp?`onclick="piEditPointsBacklog('${e(storyId)}')" title="Click to edit"`:''}>${asgn.userSetPoints?(asgn.points||3)+' pts':'~'+(asgn.points||3)+' pts'}</span>
          </div>
          <div class="pi-rp-field"><div class="pi-rp-field-lbl">Move to Sprint</div>
            <select class="pi-rp-select" onchange="piMoveBacklogToSprint('${e(storyId)}',+this.value)" ${_canEditPiBlRp?'':'disabled'}>
              <option value="">— Assign to sprint —</option>
              ${piPlan&&piPlan.sprints?piPlan.sprints.map(sp=>`<option value="${sp.id}">${e(sp.label)}</option>`).join(''):''}
            </select>
          </div>
        </div>
      </div>
      <div class="pi-rp-section">
        <div class="pi-rp-section-lbl">Note</div>
        <textarea class="pi-rp-note-area" id="pi-rp-note-bl-${storyId}" maxlength="300" ${_canEditPiBlRp?`onblur="piSaveNote('${e(storyId)}',this.value)"`:'readonly'}>${e(note)}</textarea>
      </div>
    </div>`;
}

function piMoveBacklogToSprint(storyId, sprintId){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const piPlan=piGetActivePlan();
  if(!sprintId||!piPlan)return;
  piMoveToPrint(storyId, sprintId, true);
  piCloseRightPanel();
  if(!_isDemoSession&&typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId)sessionStoreSave(_activeSessionId);
}

// ── Edit points in backlog right panel ──
function piEditPointsBacklog(storyId){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const piPlan=piGetActivePlan();
  const asgn=(piPlan&&piPlan.storyAssignments&&piPlan.storyAssignments[storyId])||{points:3};
  const badge=document.getElementById('pi-rp-pts-'+storyId);
  if(!badge)return;
  const current=asgn.points||3;
  badge.outerHTML=`<input class="pi-rp-pts-input" id="pi-rp-pts-${storyId}" type="number" min="1" max="20" value="${current}" onblur="piSavePointsBacklog('${storyId}',+this.value)" onkeydown="if(event.key==='Enter')this.blur()">`;
  const inp=document.getElementById('pi-rp-pts-'+storyId);
  if(inp){inp.focus();inp.select();}
}

function piSavePointsBacklog(storyId,pts){
  if(typeof canEditSession==='function'&&!canEditSession())return;
  const piPlan=piGetActivePlan();
  if(!piPlan)return;
  if(!piPlan.storyAssignments)piPlan.storyAssignments={};
  if(!piPlan.storyAssignments[storyId])piPlan.storyAssignments[storyId]={points:3};
  piPlan.storyAssignments[storyId].points=Math.max(1,Math.min(20,pts||3));
  piPlan.storyAssignments[storyId].userSetPoints=true;
  // Re-open backlog panel to show updated value
  piOpenBacklogPanel(storyId);
}

// ── piToggleLeftPanel for PI left panel collapse ──
// ── PI tab badge ──
function piUpdateTabBadge(){
  const badge=document.getElementById('pi-tab-badge');
  if(!badge)return;
  const piPlan=piGetActivePlan();
  const total=piPlan?Object.keys(piPlan.storyAssignments||{}).length:0;
  badge.textContent=total;
  badge.classList.toggle('on',total>0);
}

function piToggleLeftPanel(){
  const lp=document.getElementById('pi-left');
  if(!lp)return;
  const isCollapsed=lp.classList.toggle('pi-left-collapsed');
  // Update collapse button chevron — no separate IDs, update innerHTML directly
  const btn=document.getElementById('pi-collapse-btn');
  if(btn){
    btn.innerHTML=isCollapsed
      ?'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/><polyline points="3 18 9 12 3 6"/></svg>'
      :'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/><polyline points="21 18 15 12 21 6"/></svg>';
  }
}

// ── piSetStartDate - persist selected date to state. Only relevant while
// editing an already-generated plan's config elsewhere in the app; the
// config-form's own Starts field uses piValidateStartDate() instead. ──
function piSetStartDate(val){
  if(!val)return;
  const piPlan=piGetActivePlan();
  if(piPlan&&piIsPlanFrozenByReadiness(piPlan)){showToast('This release plan is frozen by its finalized Readiness Plan. Regenerate to unlock it.','warn');return;}
  if(piPlan)piPlan.startDate=val;
  const inp=document.getElementById('pi-start-date');
  if(inp)inp.value=val;
}

// ── piFormatDate — format YYYY-MM-DD as "DD Mon YYYY" ──
function piFormatDate(dateStr){
  if(!dateStr)return'—';
  try{
    const d=new Date(dateStr+'T00:00:00');
    return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  }catch(e){return dateStr;}
}

// ── Backlog tray drag-to-resize ──
function piBacklogResizeStart(e){
  e.preventDefault();
  const tray=document.getElementById('pi-backlog-tray');
  if(!tray)return;
  const startY=e.clientY;
  const startH=tray.offsetHeight;
  function onMove(ev){
    const delta=startY-ev.clientY; // dragging up = increase height
    const newH=Math.max(60,Math.min(400,startH+delta));
    tray.style.height=newH+'px';
  }
  function onUp(){
    document.removeEventListener('mousemove',onMove);
    document.removeEventListener('mouseup',onUp);
  }
  document.addEventListener('mousemove',onMove);
  document.addEventListener('mouseup',onUp);
}
