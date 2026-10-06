// ── DOCX Export — CC Brief, FC Brief, SC Sprint Backlog ──
// All three builders accept a pre-snapshotted data array (captured at click time).
// No DOM reads inside builders. Filter state is baked into the snapshot.
// Tables use WidthType.PERCENTAGE to guarantee no overflow across page sizes.

// ── Shared CDN loader ──
async function _docxLoad(){
  if(typeof docx!=='undefined'&&docx.Document)return;
  await new Promise(function(res,rej){
    var s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/docx@7.8.2/build/index.js';
    s.onload=res;
    s.onerror=function(){rej(new Error('Could not load DOCX library. Check your internet connection.'));};
    document.head.appendChild(s);
  });
}

function _docxTriggerDownload(blob,filename){
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');
  a.href=url;a.download=filename;
  document.body.appendChild(a);a.click();
  setTimeout(function(){URL.revokeObjectURL(url);a.remove();},1000);
}

function _docxOriginLabel(origin){
  if(origin==='market')return'Market intel';
  if(origin==='diagnostic')return'Diagnostics';
  if(origin==='pi')return'Custom plan';
  if(origin==='doc')return'Session doc';
  return'Discovery Map';
}

// ── Outcome Verification Loop (DOCX-1/DOCX-2): build hypothesis display
// lines from a feature's outcomeHypothesis, shared by both the Discovery
// Brief table cell and the Story Canvas detail-section paragraph. ──
function _docxHypothesisLines(feat){
  if(!feat||!feat.outcomeHypothesis||!feat.outcomeHypothesis.primary||!feat.outcomeHypothesis.primary.metric){
    return[{text:'Not set',color:'9a9a96'}];
  }
  var p=feat.outcomeHypothesis.primary;
  var lines=[];
  // v9.10.02 (item 3 fix): only the "Primary:"/"Secondary:" label is
  // bold — the metric name itself is normal weight. Previously the
  // whole line (label + metric) was bolded as one unit.
  lines.push({runs:[{text:'Primary: ',bold:true},{text:p.metric}]});
  var hasBT=p.baseline!==null&&p.baseline!==undefined&&p.target!==null&&p.target!==undefined;
  lines.push({text:hasBT?(p.baseline+' \u2192 '+p.target):'\u2014'});
  var secondary=(feat.outcomeHypothesis.secondary||[]).filter(function(s){return s&&s.metric;});
  secondary.forEach(function(s){
    lines.push({runs:[{text:'Secondary: ',bold:true},{text:s.metric}]});
    var sHasBT=s.baseline!==null&&s.baseline!==undefined&&s.target!==null&&s.target!==undefined;
    lines.push({text:sHasBT?(s.baseline+' \u2192 '+s.target):'\u2014'});
  });
  return lines;
}

// ── Single-paragraph hypothesis line for the Story Canvas detail section
// (DOCX-2) — one prose paragraph with bold "HYPOTHESIS" label, natural
// Word wrap, no forced single-line truncation. Returns null when the
// feature has no hypothesis (paragraph omitted entirely, per agreement). ──
function _docxHypothesisParagraph(feat){
  if(!feat||!feat.outcomeHypothesis||!feat.outcomeHypothesis.primary||!feat.outcomeHypothesis.primary.metric)return null;
  var p=feat.outcomeHypothesis.primary;
  var hasBT=p.baseline!==null&&p.baseline!==undefined&&p.target!==null&&p.target!==undefined;
  var runs=[
    new docx.TextRun({text:'HYPOTHESIS   ',font:'Calibri',size:18,bold:true,color:'5C5B57'}),
    new docx.TextRun({text:'Primary: '+p.metric+' '+(hasBT?(p.baseline+' \u2192 '+p.target):'\u2014'),font:'Calibri',size:18,color:'2C2C2C'})
  ];
  var secondary=(feat.outcomeHypothesis.secondary||[]).filter(function(s){return s&&s.metric;});
  secondary.forEach(function(s){
    var sHasBT=s.baseline!==null&&s.baseline!==undefined&&s.target!==null&&s.target!==undefined;
    runs.push(new docx.TextRun({text:'   \u00b7   Secondary: '+s.metric+' '+(sHasBT?(s.baseline+' \u2192 '+s.target):'\u2014'),font:'Calibri',size:18,color:'2C2C2C'}));
  });
  return new docx.Paragraph({spacing:{before:40,after:80},children:runs});
}

// ── Shared paragraph helpers (all builders use same font stack) ──
function _docxHelpers(){
  var docxLib=docx;
  var P=docxLib.Paragraph,T=docxLib.TextRun,BS=docxLib.BorderStyle;
  var NAVY='003087',PURPLE='5F1EBE',GREY='5C5B57',LIGHT='F4F6FA';
  return{
    gap:function(pts){return new P({spacing:{before:pts||80,after:0},children:[new T('')]});},
    divider:function(){return new P({spacing:{before:60,after:60},border:{bottom:{style:BS.SINGLE,size:1,color:'D0D5E8'}},children:[new T('')]});},
    coverTitle:function(text){return new P({spacing:{before:0,after:40},children:[new T({text:text,font:'Calibri',size:48,bold:true,color:NAVY})]});},
    coverSub:function(text){return new P({spacing:{before:0,after:0},children:[new T({text:text,font:'Calibri',size:22,color:GREY})]});},
    coverMeta:function(text){return new P({spacing:{before:40,after:0},children:[new T({text:text,font:'Calibri',size:16,color:GREY,italics:true})]});},
    h1:function(text,color){return new P({spacing:{before:200,after:60},children:[new T({text:text,font:'Calibri',size:32,bold:true,color:color||NAVY})]});},
    h2:function(text,color){return new P({spacing:{before:160,after:40},children:[new T({text:text,font:'Calibri',size:24,bold:true,color:color||PURPLE})]});},
    h3:function(text,color){return new P({spacing:{before:120,after:30},children:[new T({text:text,font:'Calibri',size:20,bold:true,color:color||GREY})]});},
    body:function(text,opts){return new P({spacing:{before:30,after:30},children:[new T(Object.assign({text:text,font:'Calibri',size:18,color:'2C2C2C'},opts||{}))]});},
    italic:function(text){return new P({spacing:{before:20,after:40},children:[new T({text:text,font:'Calibri',size:18,italics:true,color:GREY})]});},
    NAVY:NAVY,PURPLE:PURPLE,GREY:GREY,LIGHT:LIGHT
  };
}

function _docxTable3Col(rows,colPcts){
  // rows: [{cells:[{text,bold,color,bg} OR {lines:[{text,bold,color} OR {runs:[{text,bold,color}]}],bg}]}]
  // colPcts: [p1,p2,p3] that sum to 100
  // Outcome Verification Loop (DOCX-1): cells may now optionally provide
  // `lines` (an array of {text,bold,color}) instead of a single `text` —
  // each line becomes its own Paragraph, letting a cell stack multiple
  // rows of content (e.g. "Primary: metric" / "baseline -> target" /
  // "Secondary: metric" / "baseline -> target"). Existing single-`text`
  // cells (used by the Capability-level table this same function serves)
  // are unaffected — this is purely additive.
  // v9.10.02 (item 3 fix): a line may ALSO optionally provide `runs` (an
  // array of {text,bold,color}) instead of a single text/bold pair — this
  // lets one line mix bold and normal text together (e.g. bold "Primary: "
  // label followed by a normal-weight metric name), which a single
  // {text,bold} pair can't express since bold applies to the whole run.
  var d=docx,WType=d.WidthType,SType=d.ShadingType;
  var pcts=colPcts||[40,40,20];
  return new d.Table({
    width:{size:100,type:WType.PERCENTAGE},
    columnWidths:undefined,
    rows:rows.map(function(row){
      return new d.TableRow({children:row.cells.map(function(cell,ci){
        var paragraphs;
        if(cell.lines&&cell.lines.length){
          paragraphs=cell.lines.map(function(ln){
            var runs=(ln.runs&&ln.runs.length)
              ?ln.runs.map(function(r){return new d.TextRun({text:r.text||'',font:'Calibri',size:18,bold:!!r.bold,color:r.color||cell.color||'2C2C2C'});})
              :[new d.TextRun({text:ln.text||'',font:'Calibri',size:18,bold:!!ln.bold,color:ln.color||cell.color||'2C2C2C'})];
            return new d.Paragraph({spacing:{before:0,after:20},children:runs});
          });
        } else {
          paragraphs=[new d.Paragraph({spacing:{before:0,after:0},children:[
            new d.TextRun({text:cell.text||'',font:'Calibri',size:18,bold:!!cell.bold,color:cell.color||'2C2C2C'})
          ]})];
        }
        return new d.TableCell({
          width:{size:pcts[ci],type:WType.PERCENTAGE},
          shading:cell.bg?{type:SType.CLEAR,fill:cell.bg}:undefined,
          margins:{top:80,bottom:80,left:120,right:120},
          children:paragraphs
        });
      })});
    })
  });
}

function _docxTable4Col(rows,colPcts){
  var d=docx,WType=d.WidthType,SType=d.ShadingType;
  var pcts=colPcts||[10,55,10,25];
  return new d.Table({
    width:{size:100,type:WType.PERCENTAGE},
    rows:rows.map(function(row){
      return new d.TableRow({children:row.cells.map(function(cell,ci){
        return new d.TableCell({
          width:{size:pcts[ci],type:WType.PERCENTAGE},
          shading:cell.bg?{type:SType.CLEAR,fill:cell.bg}:undefined,
          margins:{top:80,bottom:80,left:120,right:120},
          children:[new d.Paragraph({spacing:{before:0,after:0},children:[
            new d.TextRun({text:cell.text||'',font:'Calibri',size:18,bold:!!cell.bold,color:cell.color||'2C2C2C'})
          ]})]
        });
      })});
    })
  });
}

// ───────────────────────────────────────────────────
// CC BRIEF
// capsSnapshot: [{stageLabel,stageId,stageColor,metricName,cap,origin}]
// ───────────────────────────────────────────────────
async function ccDownloadBriefDOCX(capsSnapshot,productName){
  await _docxLoad();
  // Yield to browser — lets "Exporting…" state paint before blocking main thread
  await new Promise(function(r){setTimeout(r,0);});
  var h=_docxHelpers();
  var children=[];
  var _orgName=typeof getOrgName==='function'?getOrgName():'';
  var LIGHT=h.LIGHT,NAVY=h.NAVY,PURPLE=h.PURPLE,GREY=h.GREY;
  // Cover
  children.push(h.gap(600));
  if(_orgName)children.push(h.coverMeta(_orgName));
  children.push(h.coverTitle(productName));
  children.push(h.coverSub('Capability Brief'));
  children.push(h.coverMeta(new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})));
  children.push(h.gap(400));
  children.push(h.divider());
  // Group by stage then metric
  var stages=[],stageMap={},stageOrder=[];
  capsSnapshot.forEach(function(item){
    var sk=item.stageId||item.stageLabel||'Other';
    if(!stageMap[sk]){stageMap[sk]={label:item.stageLabel||sk,color:item.stageColor||NAVY,metrics:[],metricMap:{}};stageOrder.push(sk);}
    var mk=item.metricName||'';
    if(!stageMap[sk].metricMap[mk]){stageMap[sk].metricMap[mk]=[];stageMap[sk].metrics.push(mk);}
    stageMap[sk].metricMap[mk].push(item);
  });
  stageOrder.forEach(function(sk){
    var st=stageMap[sk];
    var rawColor=st.color;
    var hexColor=/^#[0-9a-fA-F]{6}$/.test(rawColor)?rawColor.slice(1):NAVY;
    children.push(h.gap(120));
    children.push(h.h1(st.label.toUpperCase(),hexColor));
    st.metrics.forEach(function(mk){
      var caps=st.metricMap[mk];
      children.push(h.gap(60));
      children.push(h.h2(mk||'Capabilities',PURPLE));
      // Header row
      var tableRows=[{cells:[
        {text:'Capability',bold:true,bg:LIGHT,color:GREY},
        {text:'Why it matters',bold:true,bg:LIGHT,color:GREY},
        {text:'Origin',bold:true,bg:LIGHT,color:GREY}
      ]}];
      caps.forEach(function(item){
        tableRows.push({cells:[
          {text:item.cap.name||'',bold:false},
          {text:item.cap.why||'',bold:false,color:'5C5B57'},
          {text:_docxOriginLabel(item.origin),bold:false,color:'5C5B57'}
        ]});
      });
      children.push(_docxTable3Col(tableRows,[40,40,20]));
    });
  });
  children.push(h.gap(200));
  children.push(h.divider());
  var doc=new docx.Document({
    sections:[{
      properties:{page:{margin:{top:720,bottom:720,left:900,right:900}}},
      children:children
    }]
  });
  var blob=await docx.Packer.toBlob(doc);
  _docxTriggerDownload(blob,(productName||'Product').replace(/\s+/g,'_')+'_Capability_Brief.docx');
}

// ───────────────────────────────────────────────────
// FC BRIEF
// featuresSnapshot: [{id,name,why,stage,metric,cap,origin}] sorted stage/metric/cap
// ───────────────────────────────────────────────────
async function fcDownloadBriefDOCX(featuresSnapshot,productName){
  // Load docx + html2canvas in parallel (for prototype images)
  await Promise.all([
    _docxLoad(),
    (typeof _pcLoadHtml2Canvas==='function')?_pcLoadHtml2Canvas():Promise.resolve(false)
  ]);
  // Yield to browser — lets "Exporting…" state paint before blocking main thread
  await new Promise(function(r){setTimeout(r,0);});
  var h=_docxHelpers();
  var children=[];
  var _orgName=typeof getOrgName==='function'?getOrgName():'';
  var LIGHT=h.LIGHT,NAVY=h.NAVY,PURPLE=h.PURPLE,GREY=h.GREY;
  // Cover
  children.push(h.gap(600));
  if(_orgName)children.push(h.coverMeta(_orgName));
  children.push(h.coverTitle(productName));
  children.push(h.coverSub('Feature Discovery Brief'));
  children.push(h.coverMeta(new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})));
  children.push(h.gap(400));
  children.push(h.divider());
  // Group stage/metric/cap
  var stageOrder=[],stageMap={};
  featuresSnapshot.forEach(function(f){
    var sk=f.stage||'Other';
    if(!stageMap[sk]){stageMap[sk]={metrics:[],metricMap:{}};stageOrder.push(sk);}
    var mk=f.metric||'';
    if(!stageMap[sk].metricMap[mk]){stageMap[sk].metricMap[mk]={caps:[],capMap:{}};stageMap[sk].metrics.push(mk);}
    var ck=f.cap||'';
    if(!stageMap[sk].metricMap[mk].capMap[ck]){stageMap[sk].metricMap[mk].capMap[ck]=[];stageMap[sk].metricMap[mk].caps.push(ck);}
    stageMap[sk].metricMap[mk].capMap[ck].push(f);
  });
  // Get stage color helper
  var _stageColor=function(sl){
    if(typeof gData==='undefined'||!gData||!Array.isArray(gData.stages))return NAVY;
    var idx=gData.stages.findIndex(function(s){return s&&s.label===sl;});
    if(idx<0)return NAVY;
    if(typeof getStagePaletteHex==='function')return getStagePaletteHex(idx);
    return NAVY;
  };
  for(var si=0;si<stageOrder.length;si++){
    var sk=stageOrder[si];
    var st=stageMap[sk];
    var rawColor=_stageColor(sk);
    var hexColor=/^#[0-9a-fA-F]{6}$/.test(rawColor)?rawColor.slice(1):NAVY;
    children.push(h.gap(120));
    children.push(h.h1(sk.toUpperCase(),hexColor));
    for(var mi=0;mi<st.metrics.length;mi++){
      var mk=st.metrics[mi];
      var metricGrp=st.metricMap[mk];
      children.push(h.gap(60));
      children.push(h.h2(mk||'Features',PURPLE));
      for(var ci=0;ci<metricGrp.caps.length;ci++){
        var ck=metricGrp.caps[ci];
        var capFeats=metricGrp.capMap[ck];
        children.push(h.gap(40));
        children.push(h.h3(ck||'Capability',GREY));
        // Feature table for this cap
        var tableRows=[{cells:[
          {text:'Feature',bold:true,bg:LIGHT,color:GREY},
          {text:'Why it matters',bold:true,bg:LIGHT,color:GREY},
          {text:'Hypothesis',bold:true,bg:LIGHT,color:GREY}
        ]}];
        capFeats.forEach(function(f){
          tableRows.push({cells:[
            {text:f.name||''},
            {text:f.why||'',color:'5C5B57'},
            {lines:_docxHypothesisLines(f),color:'5C5B57'}
          ]});
        });
        children.push(_docxTable3Col(tableRows,[30,40,30]));
        // Prototype images for features in this cap that have generated prototypes
        for(var fi=0;fi<capFeats.length;fi++){
          var feat=capFeats[fi];
          try{
            var _pv=(typeof pcGetActiveVariant==='function')?pcGetActiveVariant(feat.id):null;
            if(_pv&&_pv.generated&&_pv.wireframeHTML&&typeof _pcCaptureWireframeAsPng==='function'){
              var _pngUrl=await _pcCaptureWireframeAsPng(_pv.wireframeHTML);
              if(_pngUrl){
                var _b64=_pngUrl.split(',')[1];
                var _bin=atob(_b64);
                var _bytes=new Uint8Array(_bin.length);
                for(var _bi=0;_bi<_bin.length;_bi++)_bytes[_bi]=_bin.charCodeAt(_bi);
                children.push(h.gap(80));
                children.push(h.body('Prototype: '+feat.name,{bold:true,color:GREY}));
                children.push(new docx.Paragraph({
                  spacing:{before:40,after:40},
                  children:[new docx.ImageRun({data:_bytes,transformation:{width:540,height:405}})]
                }));
              }
            }
          }catch(_pe){console.warn('[FC Export] Prototype capture failed:',feat.name,_pe.message);}
        }
      }
    }
  }
  children.push(h.gap(200));
  children.push(h.divider());
  var doc=new docx.Document({
    sections:[{
      properties:{page:{margin:{top:720,bottom:720,left:900,right:900}}},
      children:children
    }]
  });
  var blob=await docx.Packer.toBlob(doc);
  _docxTriggerDownload(blob,(productName||'Product').replace(/\s+/g,'_')+'_Feature_Brief.docx');
}

// ───────────────────────────────────────────────────
// SC SPRINT BACKLOG
// featuresSnapshot: array of feature objects with .stories
// ───────────────────────────────────────────────────
async function scDownloadSprintDOCX(featuresSnapshot,productName){
  await _docxLoad();
  // Yield to browser — lets "Exporting…" state paint before blocking main thread
  await new Promise(function(r){setTimeout(r,0);});
  var h=_docxHelpers();
  var children=[];
  var _orgName=typeof getOrgName==='function'?getOrgName():'';
  var LIGHT=h.LIGHT,NAVY=h.NAVY,PURPLE=h.PURPLE,GREY=h.GREY,AMBER='C8870A',GREEN='007873';
  var totalStories=featuresSnapshot.reduce(function(a,f){return a+(f.stories?f.stories.length:0);},0);
  // Cover
  children.push(h.gap(600));
  if(_orgName)children.push(h.coverMeta(_orgName));
  children.push(h.coverTitle(productName));
  children.push(h.coverSub('Sprint Backlog'));
  children.push(h.coverMeta('Sprint-ready \u00b7 Gherkin format \u00b7 DoR assessed'));
  children.push(h.coverMeta(new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})));
  children.push(h.gap(300));
  children.push(h.divider());
  children.push(h.body(featuresSnapshot.length+' features \u00b7 '+totalStories+' stories'));
  children.push(h.gap(80));
  // Group by stage/metric/cap
  var grouped={};
  var stageOrder=(typeof gData!=='undefined'&&gData&&Array.isArray(gData.stages))
    ?gData.stages.map(function(s){return s&&s.label;}).filter(Boolean):[];
  featuresSnapshot.forEach(function(feat){
    var st=feat.stage||'Other';
    var mt=feat.metric||'Unknown';
    var cp=feat.cap||'Uncategorised';
    if(!grouped[st])grouped[st]={};
    if(!grouped[st][mt])grouped[st][mt]={};
    if(!grouped[st][mt][cp])grouped[st][mt][cp]=[];
    grouped[st][mt][cp].push(feat);
  });
  var orderedStages=[...stageOrder.filter(function(s){return grouped[s];}),
    ...Object.keys(grouped).filter(function(s){return !stageOrder.includes(s);})];
  // Stage color helper
  var _stageHex=function(sl){
    if(typeof gData==='undefined'||!gData||!Array.isArray(gData.stages))return NAVY;
    var idx=gData.stages.findIndex(function(s){return s&&s.label===sl;});
    if(idx<0)return NAVY;
    if(typeof getStagePaletteHex==='function')return getStagePaletteHex(idx);
    return NAVY;
  };
  orderedStages.forEach(function(stage){
    var rawColor=_stageHex(stage);
    var hexColor=/^#[0-9a-fA-F]{6}$/.test(rawColor)?rawColor.slice(1):NAVY;
    children.push(h.gap(120));
    children.push(h.h1(stage.toUpperCase(),hexColor));
    Object.entries(grouped[stage]).forEach(function(metricEntry){
      var metric=metricEntry[0],caps=metricEntry[1];
      children.push(h.gap(60));
      children.push(h.h2(metric,PURPLE));
      Object.entries(caps).forEach(function(capEntry){
        var cap=capEntry[0],capFeats=capEntry[1];
        children.push(h.gap(40));
        children.push(h.h3(cap,GREY));
        capFeats.forEach(function(feat){
          var stories=feat.stories||[];
          children.push(h.divider());
          children.push(h.h3(feat.name,hexColor));
          if(feat.why)children.push(h.italic(feat.why));
          var _hypPara=_docxHypothesisParagraph(feat);
          if(_hypPara)children.push(_hypPara);
          children.push(h.body(stories.length+' stor'+(stories.length===1?'y':'ies'),''));
          // Summary table
          var tableRows=[{cells:[
            {text:'ID',bold:true,bg:LIGHT,color:GREY},
            {text:'Story',bold:true,bg:LIGHT,color:GREY},
            {text:'Pts',bold:true,bg:LIGHT,color:GREY},
            {text:'Priority',bold:true,bg:LIGHT,color:GREY}
          ]}];
          stories.forEach(function(st){
            tableRows.push({cells:[
              {text:st.id||'',color:PURPLE},
              {text:st.title||''},
              {text:String(st.points||3),color:GREY},
              {text:st.priority||'Should Have',color:GREY}
            ]});
          });
          children.push(_docxTable4Col(tableRows,[10,55,10,25]));
          // Story detail
          stories.forEach(function(st){
            children.push(h.gap(120));
            children.push(new docx.Paragraph({spacing:{before:80,after:30},children:[
              new docx.TextRun({text:st.id+' \u2014 ',font:'Calibri',size:18,bold:true,color:PURPLE}),
              new docx.TextRun({text:st.title||'',font:'Calibri',size:18,bold:true,color:NAVY})
            ]}));
            // DoR badge
            var dorColor=st.dor==='READY'?GREEN:AMBER;
            children.push(new docx.Paragraph({spacing:{before:0,after:20},children:[
              new docx.TextRun({text:(st.points||3)+' pts  \u00b7  ',font:'Calibri',size:16,color:GREY}),
              new docx.TextRun({text:st.priority||'Should Have',font:'Calibri',size:16,color:GREY}),
              new docx.TextRun({text:'  \u00b7  DoR: ',font:'Calibri',size:16,color:GREY}),
              new docx.TextRun({text:st.dor||'NOT READY',font:'Calibri',size:16,bold:true,color:dorColor})
            ]}));
            // User story
            if(st.statement){
              children.push(h.gap(30));
              children.push(new docx.Paragraph({spacing:{before:20,after:20},children:[
                new docx.TextRun({text:st.statement,font:'Calibri',size:18,italics:true,color:'2C2C2C'})
              ]}));
            }
            // ACs
            if(st.scenarios&&st.scenarios.length){
              children.push(h.gap(30));
              children.push(h.body('Acceptance Criteria',{bold:true,color:GREY}));
              st.scenarios.forEach(function(sc,sci){
                if(sci>0)children.push(h.gap(40));
                children.push(new docx.Paragraph({spacing:{before:40,after:20},indent:{left:360},children:[
                  new docx.TextRun({text:'Scenario: '+sc.name,font:'Calibri',size:18,bold:true,color:GREY})
                ]}));
                var lines=[['Given',sc.given],['When',sc.when],['Then',sc.then],['And',sc.and]];
                lines.forEach(function(ln){
                  if(!ln[1]||!ln[1].trim())return;
                  children.push(new docx.Paragraph({spacing:{before:10,after:0},indent:{left:540},children:[
                    new docx.TextRun({text:ln[0].padEnd(5,' ')+'  ',font:'Courier New',size:16,bold:true,color:PURPLE}),
                    new docx.TextRun({text:ln[1],font:'Calibri',size:16,color:'2C2C2C'})
                  ]}));
                });
              });
            }
          });
        });
      });
    });
  });
  children.push(h.gap(200));
  children.push(h.divider());
  var doc=new docx.Document({
    sections:[{
      properties:{page:{margin:{top:720,bottom:720,left:900,right:900}}},
      children:children
    }]
  });
  var blob=await docx.Packer.toBlob(doc);
  _docxTriggerDownload(blob,(productName||'Product').replace(/\s+/g,'_')+'_Sprint_Backlog.docx');
}
