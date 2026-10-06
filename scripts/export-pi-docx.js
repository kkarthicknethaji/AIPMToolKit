// PI DOCX Export — export-pi-docx.js
// Structure: Cover → PI at a Glance → Squad Capacity →
//            Dependencies → Sprint Plan (H2/sprint, H3/cap, story table) →
//            Prototype Plan (one block per unique feature, whole-plan deduped) →
//            Unplanned Backlog → Story Notes

var piExportInFlight=false;
function piSyncExportBtn(){
  var btn=document.getElementById('pi-export-btn');
  if(!btn)return;
  btn.disabled=!!piExportInFlight;
  btn.innerHTML=piExportInFlight?
    '<i class="ti ti-loader-2" style="font-size:11px;animation:spin 1s linear infinite;" aria-hidden="true"></i> Exporting\u2026':
    '<i class="ti ti-download" style="font-size:11px;" aria-hidden="true"></i> Export';
}
async function buildAndDownloadPIDocx(){
  const piPlan=(typeof piGetActivePlan==='function')?piGetActivePlan():null;
  if(!piPlan){showToast('Generate a release plan first.','info');return;}
  if(piExportInFlight)return;
  piExportInFlight=true;piSyncExportBtn();
  try{
    // Lazy-load docx from CDN
    if(typeof docx==='undefined'||!docx.Document){
      await new Promise((res,rej)=>{
        const s=document.createElement('script');
        s.src='https://cdn.jsdelivr.net/npm/docx@7.8.2/build/index.js';
        s.onload=res;s.onerror=()=>rej(new Error('Could not load docx library.'));
        document.head.appendChild(s);
      });
    }
    const {Document,Packer,Paragraph,TextRun,Table,TableRow,TableCell,
      HeadingLevel,AlignmentType,BorderStyle,WidthType,ShadingType,
      VerticalAlign,PageBreak,ImageRun}=docx;

    const _pcPi=getProductCtx();
    const productName=_pcPi.name;
    const industry=_pcPi.industry;
    const _scPi=typeof sessionContext!=='undefined'?sessionContext:null;
    const piGoal=(typeof piInputs!=='undefined'&&piInputs.piGoal)||(_scPi&&_scPi.productProfile&&_scPi.productProfile.problem)||'';
    const squadList=piGetSquads();

    // ── helpers ──
    const NAVY='003087',PURPLE='5F1EBE',GREY='5C5B57',WHITE='FFFFFF',AMBER='C8870A';
    const bdr=c=>({style:BorderStyle.SINGLE,size:1,color:c||'CCCCCC'});
    const bdrs=c=>({top:bdr(c),bottom:bdr(c),left:bdr(c),right:bdr(c)});
    const gap=(n=80)=>new Paragraph({spacing:{before:n,after:0},children:[new TextRun('')]});
    const h2=(t)=>new Paragraph({heading:HeadingLevel.HEADING_2,spacing:{before:240,after:60},children:[new TextRun({text:t,font:'Arial',size:26,bold:true,color:NAVY})]});
    const h3=(t)=>new Paragraph({heading:HeadingLevel.HEADING_3,spacing:{before:180,after:40},children:[new TextRun({text:t,font:'Arial',size:22,bold:true,color:PURPLE})]});
    const body=(t)=>new Paragraph({spacing:{before:30,after:30},children:[new TextRun({text:t,font:'Arial',size:20,color:'2C2C2C'})]});
    const bul=(t)=>new Paragraph({spacing:{before:16,after:16},numbering:{reference:'bullets',level:0},children:[new TextRun({text:t,font:'Arial',size:20,color:'2C2C2C'})]});
    // Sentence-splitter with abbreviation protection (e.g./i.e.) and short-fragment
    // merging — same logic as prototype-canvas.js's _pcForceBulletList, kept local
    // here since this file doesn't share scope with that module.
    const _splitSentences=(text)=>{
      const protected_=String(text||'')
        .replace(/\be\.g\./gi,function(m){return m[0]==='E'?'E§g§':'e§g§';})
        .replace(/\bi\.e\./gi,function(m){return m[0]==='I'?'I§e§':'i§e§';});
      const frags=protected_.split(/\.\s+/);
      const result=[];let current='';
      frags.forEach(function(frag,i){
        const piece=frag.trim();
        if(!piece)return;
        const withPeriod=(i<frags.length-1)?piece+'.':piece;
        if(current.length>0&&current.length<20){current+=' '+withPeriod;}
        else{if(current)result.push(current);current=withPeriod;}
      });
      if(current)result.push(current);
      return result.map(function(s){return s.replace(/E§g§/g,'E.g.').replace(/e§g§/g,'e.g.').replace(/I§e§/g,'I.e.').replace(/i§e§/g,'i.e.');});
    };
    const cell=(t,w,bg,bold,color)=>{
      return new TableCell({
        borders:bdrs('DDDDDD'),
        shading:bg?{fill:bg,type:ShadingType.CLEAR}:undefined,
        width:w?{size:w,type:WidthType.DXA}:undefined,
        margins:{top:80,bottom:80,left:120,right:120},
        verticalAlign:VerticalAlign.TOP,
        children:[new Paragraph({spacing:{before:0,after:0},children:[new TextRun({text:String(t||''),font:'Arial',size:18,bold:!!bold,color:color||'2C2C2C'})]})]
      });
    };
    const hcell=(t,w)=>cell(t,w,NAVY,true,WHITE);

    // ── Yield to browser before heavy synchronous document build ──
    // Lets "Exporting…" state paint before blocking main thread
    await new Promise(function(r){setTimeout(r,0);});

    // ── Section 1 — PI at a Glance ──
    const s1=[
      h2('1. Release at a Glance'),
      body('Product: '+productName+(industry?' · '+industry:'')),
      body('Release: '+piPlan.name+' · '+piPlan.sprintCount+' sprints · '+piPlan.sprintDuration+' days each'),
      gap(20),
    ];
    if(piGoal){
      s1.push(new Paragraph({spacing:{before:0,after:20},children:[new TextRun({text:'Release Goal:',font:'Arial',size:20,bold:true,color:NAVY})]}));
      s1.push(body(piGoal));
      s1.push(gap(10));
    }
    if(piPlan.businessValueOneLiner){
      s1.push(new Paragraph({spacing:{before:0,after:8},children:[new TextRun({text:'Business value:',font:'Arial',size:20,bold:true,color:NAVY})]}));
      s1.push(body(piPlan.businessValueOneLiner));
      s1.push(gap(10));
    }
    if(piPlan.businessValueBullets&&piPlan.businessValueBullets.length>0){
      piPlan.businessValueBullets.forEach(b=>s1.push(bul(b)));
      s1.push(gap(20));
    }
    // Sprint summary table
    const sprintTableRows=[
      new TableRow({children:[hcell('Sprint',1400),hcell('Dates',2400),hcell('Squads',1800),hcell('Stories',1200),hcell('Points',1200),hcell('Primary capability',3360)]})
    ];
    piPlan.sprints.forEach(sp=>{
      const stories=Object.entries(piPlan.storyAssignments||{}).filter(([,a])=>a&&a.sprint===sp.id);
      const pts=stories.reduce((s,[,a])=>s+(a.points||0),0);
      const squadsInSprint=[...new Set(stories.map(([,a])=>a.squad).filter(Boolean))].join(', ');
      // Find most common capability in this sprint
      const capCounts={};
      stories.forEach(([sid])=>{const f=scCanvas.find(f=>f.stories&&f.stories.some(st=>st.id===sid));if(f)capCounts[f.cap||f.name]=(capCounts[f.cap||f.name]||0)+1;});
      const primaryCap=Object.entries(capCounts).sort((a,b)=>b[1]-a[1])[0];
      sprintTableRows.push(new TableRow({children:[
        cell(sp.label,1400),cell(sp.dateRange,2400),cell(squadsInSprint||'—',1800),
        cell(String(stories.length),1200),cell(String(pts)+' pts',1200),cell(primaryCap?primaryCap[0]:'—',3360)
      ]}));
    });
    s1.push(new Table({width:{size:11360,type:WidthType.DXA},columnWidths:[1400,2400,1800,1200,1200,3360],rows:sprintTableRows}));
    s1.push(gap(40));s1.push(new Paragraph({children:[new PageBreak()]}));

    // ── Section 2 — Squad Capacity ──
    const s2=[h2('2. Squad Capacity')];
    if(squadList.length>0){
      const totalCap=squadList.reduce((a,s)=>a+s.capacity,0);
      const totalAlloc=Object.values(piPlan.storyAssignments||{}).reduce((a,v)=>a+(v&&v.points||0),0);
      const squadRows=[new TableRow({children:[hcell('Squad',2000),hcell('Devs',1000),hcell('Duration',1400),hcell('Availability',1600),hcell('Capacity (pts)',1800),hcell('Allocated',1800),hcell('Headroom',1760)]})];
      squadList.forEach(sq=>{
        const alloc=Object.values(piPlan.storyAssignments||{}).filter(a=>a&&a.squad===sq.name).reduce((s,a)=>s+(a.points||0),0);
        const headroom=sq.capacity-alloc;
        squadRows.push(new TableRow({children:[
          cell(sq.name,2000),cell(String(sq.devs||3),1000),cell(piPlan.sprintDuration+'d',1400),
          cell((sq.availability||80)+'%',1600),cell(String(sq.capacity)+' pts',1800),
          cell(String(alloc)+' pts',1800),cell((headroom>=0?'+':'')+headroom+' pts',1760,headroom<0?'FCEBEB':null)
        ]}));
      });
      squadRows.push(new TableRow({children:[
        cell('Total',2000,null,true),cell('',1000),cell('',1400),cell('',1600),
        cell(String(totalCap)+' pts',1800,null,true),cell(String(totalAlloc)+' pts',1800,null,true),
        cell((totalCap-totalAlloc>=0?'+':'')+(totalCap-totalAlloc)+' pts',1760,null,true)
      ]}));
      s2.push(new Table({width:{size:11360,type:WidthType.DXA},columnWidths:[2000,1000,1400,1600,1800,1800,1760],rows:squadRows}));
    }
    s2.push(gap(40));s2.push(new Paragraph({children:[new PageBreak()]}));

    // ── Section 3 — Dependencies ──
    const s3=[h2('3. Dependencies')];
    const deps=piPlan.dependencies||[];
    const extDeps=piPlan.externalDeps||[];
    if(deps.length===0&&extDeps.length===0){
      s3.push(body('No dependencies declared for this release.'));
    } else {
      if(deps.length>0){
        s3.push(h3('Internal dependencies'));
        const depRows=[new TableRow({children:[hcell('Story (from)',3600),hcell('Sprint',1000),hcell('',600),hcell('Story (to)',3600),hcell('Sprint',1000),hcell('Source',1560)]})];
        deps.forEach(d=>{
          const fromStory=piFindStory(d.fromId);const toStory=piFindStory(d.toId);
          const fromSprint=(piPlan.storyAssignments[d.fromId]||{}).sprint;const toSprint=(piPlan.storyAssignments[d.toId]||{}).sprint;
          depRows.push(new TableRow({children:[
            cell((fromStory&&(fromStory.statement||fromStory.title)||d.fromId||'').substring(0,60),3600),
            cell(fromSprint?'S'+fromSprint:'—',1000),cell('blocks',600,null,true),
            cell((toStory&&(toStory.statement||toStory.title)||d.toId||'').substring(0,60),3600),
            cell(toSprint?'S'+toSprint:'—',1000),cell(d.source||'AI inferred',1560)
          ]}));
        });
        s3.push(new Table({width:{size:11360,type:WidthType.DXA},columnWidths:[3600,1000,600,3600,1000,1560],rows:depRows}));
        s3.push(gap(20));
      }
      if(extDeps.length>0){
        s3.push(h3('External dependencies'));
        const extRows=[new TableRow({children:[hcell('Story',4800),hcell('Sprint',1200),hcell('External dependency',5360)]})];
        extDeps.forEach(d=>{
          const story=piFindStory(d.storyId);const sprint=(piPlan.storyAssignments[d.storyId]||{}).sprint;
          extRows.push(new TableRow({children:[cell((story&&(story.statement||story.title)||d.storyId||'').substring(0,60),4800),cell(sprint?'S'+sprint:'—',1200),cell(d.description||'',5360)]}));
        });
        s3.push(new Table({width:{size:11360,type:WidthType.DXA},columnWidths:[4800,1200,5360],rows:extRows}));
      }
    }
    s3.push(gap(40));s3.push(new Paragraph({children:[new PageBreak()]}));

    // ── Section 4 — Sprint Plan ──
    const s4=[h2('4. Sprint Plan')];
    piPlan.sprints.forEach(sprint=>{
      s4.push(h3('Sprint '+sprint.id+' · '+sprint.dateRange));
      // Group stories by capability
      const storiesInSprint=Object.entries(piPlan.storyAssignments||{}).filter(([,a])=>a&&a.sprint===sprint.id);
      if(storiesInSprint.length===0){s4.push(body('No stories assigned to this sprint.'));return;}
      const byCapability={};
      storiesInSprint.forEach(([sid,asgn])=>{
        const feat=scCanvas.find(f=>f.stories&&f.stories.some(st=>st.id===sid));
        const capName=(feat&&(feat.cap||feat.name))||'Other';
        if(!byCapability[capName])byCapability[capName]=[];
        byCapability[capName].push({sid,asgn,feat});
      });
      Object.entries(byCapability).forEach(([capName,items])=>{
        s4.push(new Paragraph({spacing:{before:120,after:20},children:[new TextRun({text:capName,font:'Arial',size:20,bold:true,color:PURPLE})]}));
        const storyRows=[new TableRow({children:[hcell('Story',7000),hcell('Squad',2000),hcell('Points',1200),hcell('Status',1160)]})];
        items.forEach(({sid,asgn})=>{
          const story=piFindStory(sid);
          const stmt=(story&&(story.statement||story.title||''))||sid;
          const status=story&&story.carryForward?'↩ Carry-forward':'Planned';
          storyRows.push(new TableRow({children:[
            cell(stmt.substring(0,120),7000),
            cell(asgn.squad||'—',2000),
            cell((asgn.points||3)+' pts',1200),
            cell(status,1160)
          ]}));
        });
        s4.push(new Table({width:{size:11360,type:WidthType.DXA},columnWidths:[7000,2000,1200,1160],rows:storyRows}));
        s4.push(gap(16));
      });
      s4.push(gap(20));
    });
    s4.push(new Paragraph({children:[new PageBreak()]}));

    // ── Section 5 — Prototype Plan ──
    // One block per unique feature with a generated prototype, across the
    // ENTIRE PI plan (all sprints combined) — not per-sprint, which is what
    // caused duplicate prototype blocks in v8.85. Features without a
    // generated prototype are skipped entirely; no empty block shown.
    const s5=[h2('5. Prototype Plan')];
    let _protoImagesCaptured=0;
    if(typeof protoStore!=='undefined'){
      const allPlannedFeatIds=new Set();
      Object.keys(piPlan.storyAssignments||{}).forEach(function(sid){
        const feat=scCanvas.find(f=>f.stories&&f.stories.some(st=>st.id===sid));
        if(feat&&feat.id)allPlannedFeatIds.add(feat.id);
      });
      const protoFeats=Array.from(allPlannedFeatIds)
        .map(fid=>scCanvas.find(f=>f.id===fid))
        .filter(function(f){
          if(!f||!protoStore[f.id])return false;
          const _pe=protoStore[f.id];
          const _pv=_pe.variants&&_pe.activeVariantId&&_pe.variants[_pe.activeVariantId];
          return !!(_pv&&_pv.generated&&_pv.designBrief);
        });
      if(protoFeats.length===0){
        s5.push(body('No prototypes have been generated for features in this release plan.'));
      } else {
        // Lazy-load html2canvas once, reused for every feature's capture
        let h2cLoaded=false;
        if(typeof _pcLoadHtml2Canvas==='function'){
          h2cLoaded=await _pcLoadHtml2Canvas();
        }
        for(const f of protoFeats){
          const _pe=protoStore[f.id];
          const _pv=_pe.variants[_pe.activeVariantId];
          const brief=_pv.designBrief;
          s5.push(new Paragraph({spacing:{before:160,after:20},children:[new TextRun({text:'Feature: '+(f.name||'Untitled'),font:'Arial',size:24,bold:true,color:NAVY})]}));
          s5.push(new Paragraph({spacing:{before:0,after:80},children:[new TextRun({text:'Prototype Design Brief',font:'Arial',size:18,bold:true,color:PURPLE})]}));
          if(brief.screenPurpose)s5.push(body('Purpose: '+brief.screenPurpose));
          if(Array.isArray(brief.keyComponents)&&brief.keyComponents.length)s5.push(body('Key components: '+brief.keyComponents.join(', ')));
          if(brief.interactionNotes){
            s5.push(body('Interaction notes:'));
            _splitSentences(brief.interactionNotes).forEach(function(sentence){ s5.push(bul(sentence)); });
          }
          if(brief.edgeCases){
            s5.push(body('Edge cases:'));
            _splitSentences(brief.edgeCases).forEach(function(sentence){ s5.push(bul(sentence)); });
          }
          // Prototype image — capture via existing _pcCaptureWireframeAsPng,
          // same fallback behavior as pcExportPrototype: text note on failure.
          s5.push(gap(10));
          s5.push(new Paragraph({spacing:{before:0,after:20},children:[new TextRun({text:'Prototype Image',font:'Arial',size:18,bold:true,color:PURPLE})]}));
          let imageAdded=false;
          if(h2cLoaded&&_pv.wireframeHTML&&typeof _pcCaptureWireframeAsPng==='function'){
            try{
              const pngDataUrl=await _pcCaptureWireframeAsPng(_pv.wireframeHTML);
              if(pngDataUrl){
                s5.push(new Paragraph({spacing:{before:10,after:10},children:[new ImageRun({data:pngDataUrl,transformation:{width:480,height:360}})]}));
                imageAdded=true;
                _protoImagesCaptured++;
              }
            }catch(ie){console.warn('[PI Export] Wireframe capture failed for',f.name,':',ie.message);}
          }
          if(!imageAdded){
            s5.push(body('Wireframe image unavailable. Open the prototype in Story Canvas to view it.'));
          }
          s5.push(gap(20));
        }
      }
    } else {
      s5.push(body('No prototypes have been generated for features in this release plan.'));
    }
    s5.push(new Paragraph({children:[new PageBreak()]}));

    // ── Section 6 — Unplanned Backlog ──
    const s6=[h2('6. Unplanned Backlog')];
    // backlogNotes is keyed by exactly the story ids that didn't fit this
    // plan's last generation - the plan object itself no longer carries a
    // separate backlogStoryIds field, since there is only one shared,
    // global backlog tray in this app now (piBacklogStoryIds).
    const backlogIds=Object.keys(piPlan.backlogNotes||{});
    if(backlogIds.length===0){
      s6.push(body('All stories are assigned to a sprint.'));
    } else {
      backlogIds.forEach(sid=>{
        const story=piFindStory(sid);const feat=scCanvas.find(f=>f.stories&&f.stories.some(st=>st.id===sid));
        const stmt=(story&&(story.statement||story.title||''))||sid;
        const note=(piPlan.backlogNotes&&piPlan.backlogNotes[sid])||'';
        s6.push(bul(stmt.substring(0,120)+(feat?' ['+feat.name+']':'')+(note?' — '+note:'')));
      });
    }
    s6.push(gap(40));

    // ── Section 7 — Story Notes ──
    const notedStories=Object.entries(piPlan.storyAssignments||{}).filter(([,a])=>a&&a.note);
    const s7=[];
    if(notedStories.length>0){
      s7.push(h2('7. Story Notes'));
      notedStories.forEach(([sid,asgn])=>{
        const story=piFindStory(sid);
        s7.push(new Paragraph({spacing:{before:120,after:6},children:[new TextRun({text:(story&&(story.statement||story.title)||sid).substring(0,80),font:'Arial',size:18,bold:true,color:GREY})]}));
        s7.push(body(asgn.note));
        s7.push(gap(10));
      });
    }

    // ── Build and download ──
    const doc=new Document({
      numbering:{config:[{reference:'bullets',levels:[{level:0,format:'bullet',text:'\u2022',alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:720,hanging:360}}}}]}]},
      styles:{default:{document:{run:{font:'Arial',size:20}}},
        paragraphStyles:[
          {id:'Heading2',name:'Heading 2',basedOn:'Normal',next:'Normal',run:{size:26,bold:true,font:'Arial',color:NAVY},paragraph:{spacing:{before:240,after:60},outlineLevel:1}},
          {id:'Heading3',name:'Heading 3',basedOn:'Normal',next:'Normal',run:{size:22,bold:true,font:'Arial',color:PURPLE},paragraph:{spacing:{before:180,after:40},outlineLevel:2}},
        ]},
      sections:[{
        properties:{page:{size:{width:16838,height:11906},margin:{top:1008,right:1008,bottom:1008,left:1008}}},
        children:[
          new Paragraph({spacing:{before:0,after:20},children:[new TextRun({text:(typeof getOrgName==='function'&&getOrgName()?getOrgName()+' · ':'')+APP_NAME,font:'Arial',size:18,color:GREY})]}),
          new Paragraph({spacing:{before:0,after:10},children:[new TextRun({text:piPlan.name+' — Release Plan',font:'Arial',size:40,bold:true,color:NAVY})]}),
          new Paragraph({spacing:{before:0,after:10},children:[new TextRun({text:productName+' · '+new Date().toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}),font:'Arial',size:22,color:GREY})]}),
          gap(20),new Paragraph({children:[new PageBreak()]}),
          ...s1,...s2,...s3,...s4,...s5,...s6,...s7
        ]
      }]
    });
    const fname=(piPlan.name||'Release-Plan').replace(/\s+/g,'-')+'-'+productName.replace(/\s+/g,'-')+'.docx';
    const blob=await Packer.toBlob(doc);
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download=fname;
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }catch(err){
    showToast('Release export failed: '+err.message,'error');
    console.error('PI DOCX error:',err);
  }finally{
    piExportInFlight=false;piSyncExportBtn();
  }
}
