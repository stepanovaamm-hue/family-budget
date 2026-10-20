const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function extract(name){
  const signature=new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\)\\s*\\{`).exec(html);
  assert(signature,name);
  let end=signature.index+signature[0].length,depth=1;
  while(depth){if(html[end]==='{')depth++;if(html[end]==='}')depth--;end++;assert(end<=html.length,name);}
  return html.slice(signature.index,end);
}
async function main(){
  let callback,localCopy,uid=0,timer=0,active=0,maxActive=0;
  const timers=new Map(),requests=[],statuses=[];
  const clone=value=>JSON.parse(JSON.stringify(value));
  const initial={version:1,selectedMonth:'2026-10',recurring:[],recurringIncome:[],months:{'2026-10':{openingBalance:100,transactions:[
    {id:'first',type:'expense',date:'2026-10-21',plan:20,paid:false,actual:null},
    {id:'second',type:'expense',date:'2026-10-24',plan:30,paid:false,actual:null}
  ]}}};
  const context={state:clone(initial),cloud:{user:{id:'user'},householdId:'family',updatedAt:null},
    uid:()=>`mutation-${++uid}`,realToday:new Date(2026,9,20),localDateKey:()=> '2026-10-20',
    month:()=>context.state.months['2026-10'],parseDate:date=>new Date(date+'T00:00:00'),
    fullDate:new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short'}),
    persistLocal:()=>{localCopy=clone(context.state);},setCloudStatus:(...args)=>statuses.push(args),
    cloudErrorMessage:error=>error.message,showToast(){},render(){},
    preserveDeletionMarkers:()=>false,migrateLegacyMashaSalary:()=>false,ensureMashaSalaryV17:()=>false,
    repairRecurringMoves:()=>false,repairMissingSalarySuppressions:()=>false,ensureRecurringIncomeSchedule:()=>false,
    setTimeout:fn=>{const id=++timer;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)};
  context.cloud.client={from:()=>({upsert:payload=>{
    active++;maxActive=Math.max(maxActive,active);
    return new Promise(resolve=>requests.push({payload,finish:error=>{active--;resolve({error});}}));
  }}),channel:()=>({on:(_type,_filter,fn)=>{callback=fn;return {subscribe:()=>({})};}})};
  vm.createContext(context);
  vm.runInContext('let cloudSaveTimer=null,cloudSaveInFlight=null,cloudSaveQueued=false;const ownCloudWrites=new Set();',context);
  for(const name of ['sharedState','rememberPaymentUpdate','preservePendingPayments','mergeSharedState','save','queueCloudSave','saveCloudState','subscribeCloud','togglePaid'])vm.runInContext(extract(name),context);
  const run=code=>vm.runInContext(code,context);
  const tx=id=>context.month().transactions.find(item=>item.id===id);
  run('subscribeCloud()');
  run("togglePaid('first',true);togglePaid('second',true)");
  assert.equal(timers.size,1,'Clicks are batched into one scheduled save');
  assert(tx('first').paid&&tx('second').paid,'Local feedback is immediate');
  const first=run('saveCloudState({silent:true})');
  assert.equal(requests.length,1);
  assert(!('pendingPaymentUpdates' in requests[0].payload.data),'Local outbox is not shared with another device');
  run("togglePaid('first',false)");
  assert.equal(requests[0].payload.data.months['2026-10'].transactions[0].paid,true,'In-flight batch is immutable');
  const stale={new:{data:clone(initial),updated_by:'other-device',updated_at:'2020-01-01T00:00:00Z'}};
  callback(stale);
  assert.equal(tx('first').paid,false,'Stale incoming state does not undo latest local click');
  assert.equal(tx('second').paid,true,'Other pending confirmations are retained too');
  callback({new:requests[0].payload});
  assert.equal(tx('first').paid,false,'Own echo arriving before acknowledgement is ignored');
  const waiting=run('saveCloudState({silent:true})');
  assert.equal(requests.length,1,'Only one request may be active');
  requests[0].finish(null);await first;await waiting;
  assert(context.state.pendingPaymentUpdates['2026-10|first'],'Old acknowledgement does not erase newer edit');
  assert(localCopy.pendingPaymentUpdates['2026-10|first'],'Unsaved edit survives reload in local storage');
  for(const [id,fn] of [...timers]){timers.delete(id);fn();}
  assert.equal(requests.length,2,'Queued batch follows the first');
  assert.equal(requests[1].payload.data.months['2026-10'].transactions[0].paid,false);
  const second=run('cloudSaveInFlight');requests[1].finish(new Error('offline'));await second;
  await Promise.resolve();
  assert(context.state.pendingPaymentUpdates['2026-10|first'],'Failed request retains pending confirmation');
  assert(statuses.some(([status])=>status==='error'),'Failure is reported');
  const retry=run('saveCloudState()');requests[2].finish(null);await retry;
  assert.equal(Object.keys(context.state.pendingPaymentUpdates).length,0,'Successful retry acknowledges the batch');
  assert.equal(maxActive,1,'Writes never overlap');
  // A delayed whole-document write from another device may arrive after our own acknowledgement.
  context.remote=clone(initial);run('mergeSharedState(remote)');
  assert.equal(tx('second').paid,true,'Confirmed payment revision survives a later stale document');
  const newest=clone(context.state);
  const remoteTx=newest.months['2026-10'].transactions.find(item=>item.id==='second');
  remoteTx.paid=false;remoteTx.actual=null;delete remoteTx.paidDate;
  remoteTx.paymentUpdatedAt='2099-01-01T00:00:00.000Z';remoteTx.paymentUpdateId='newer';
  context.remote=newest;run('mergeSharedState(remote)');
  assert.equal(tx('second').paid,false,'A genuinely newer payment edit from another device is accepted');
  const version=tx('second').paymentUpdateId;
  run("togglePaid('second',false)");
  assert.equal(tx('second').paymentUpdateId,version,'Repeated command is idempotent');
  let saves=0;
  const elements={};
  context.save=()=>saves++;
  context.$=id=>elements[id]??(elements[id]={});
  context.state.activeView='backup';
  context.monthDate=()=>new Date(2026,9,1);
  context.monthFormat=new Intl.DateTimeFormat('ru-RU',{month:'long'});
  context.monthKeyFrom=date=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
  context.generateRecurring=(target,key)=>{if(!target.months[key])target.months[key]={openingBalance:0,transactions:[]};};
  context.sortTx=list=>list;
  context.ledgerMarkup=()=>'';
  for(const name of ['adjacentMonthKey','render','renderNextMonthPreview'])vm.runInContext(extract(name),context);
  run('render();render()');
  assert.equal(saves,0,'Rendering unchanged state does not write back to cloud');
  run('renderNextMonthPreview()');
  assert.equal(saves,1,'Generated new month is saved once');
  run('renderNextMonthPreview()');
  assert.equal(saves,1,'Preview re-render cannot create a save/realtime loop');
  const handlers={};
  context.document={addEventListener:(type,handler)=>{handlers[type]=handler;}};
  const clickSource=html.match(/document\.addEventListener\('click',e=>\{[\s\S]*?\n      \}\);/)[0];
  vm.runInContext(clickSource,context);
  const button={getAttribute:()=> 'false',closest:()=>({dataset:{id:'first'}})};
  const target={closest:selector=>selector==='.toggle-paid'?button:null};
  handlers.click({target,detail:1});
  assert.equal(tx('first').paid,true,'Actual delegated click handler conducts payment');
  handlers.click({target,detail:2});
  assert.equal(tx('first').paid,true,'Second event from double-click does not undo payment');
  vm.runInContext(html.split(/\r?\n/).find(line=>line.includes("document.addEventListener('pointerdown'")),context);
  const row={draggable:true};
  handlers.pointerdown({target:{closest:selector=>selector==='.draggable-expense'?row:button}});
  assert.equal(row.draggable,false,'Payment button cannot start dragging the row');
  handlers.pointerdown({target:{closest:selector=>selector==='.draggable-expense'?row:null}});
  assert.equal(row.draggable,true,'Dragging is still available outside controls');
  console.log('Cloud sync checks passed: batching, serial writes, immutable snapshots, stale echoes, retry, revision merge');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
