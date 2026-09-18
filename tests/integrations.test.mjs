import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createBridge,AppServerTransport,codexAppServerCommand,codexChildEnv} from '../src/integrations.mjs';
import {importHistory,createPack} from '../src/core.mjs';
import {runtimePath,checkedPath} from '../src/paths.mjs';

// Explicit offline contract fixtures. No test starts Codex or sends a real model turn.
class FixtureTransport extends EventEmitter {
  constructor(state={}){super();this.state=state;this.closed=false;this.calls=[];}
  async open(){}
  notify(method){this.calls.push({method});}
  close(){this.closed=true;this.emit('disconnect');}
  async request(method,params,timeoutMs){
    this.calls.push({method,params,timeoutMs});
    const state=this.state;
    state.requestHook?.(method,params,timeoutMs);
    if(method==='initialize')return {userAgent:'fixture-not-a-real-server'};
    if(method==='thread/list')return {data:state.listData || (state.empty?[]:[this.thread()]),nextCursor:null};
    if(method==='thread/read') {if(state.unreachable)throw Object.assign(new Error('fixture unavailable'),{code:'DISCONNECTED'});if(params.threadId!=='existing-target')throw Object.assign(new Error('fixture missing'),{code:'RPC_REJECTED'});const thread=this.thread();return {thread:{...thread,id:state.readReplyId || thread.id,historyMode:params.includeTurns?(state.fullHistoryMode || thread.historyMode):thread.historyMode,turns:params.includeTurns?thread.turns:[]}};}
    if(method==='thread/turns/list') {
      if(!state.turnPages)throw Object.assign(new Error('fixture paging unsupported'),{code:'RPC_REJECTED'});
      return state.turnPages[params.cursor ?? 'first'];
    }
    if(method==='thread/items/list') {
      if(!state.itemPages?.[params.turnId])throw Object.assign(new Error('fixture item paging unsupported'),{code:'RPC_REJECTED'});
      return state.itemPages[params.turnId][params.cursor ?? 'first'];
    }
    if(method==='account/read')return {account:state.auth==='none'?null:{type:state.auth || 'chatgpt'},requiresOpenaiAuth:true};
    if(method==='config/read')return {config:{model_provider:state.provider || 'openai',...(state.config||{})}};
    if(method==='thread/resume')return {thread:this.thread()};
    if(method==='turn/start') {
      state.sendCount=(state.sendCount||0)+1;
      if(state.beforeStart)state.beforeStart(params);
      if(state.rejectStart)throw Object.assign(new Error('fixture rejection'),{code:'RPC_REJECTED'});
      state.turn={id:'fixture-turn-1',status:state.noComplete?'inProgress':'completed',items:[{id:params.clientUserMessageId,type:'userMessage',content:params.input}]};
      if(state.dropAck)throw Object.assign(new Error('fixture ack lost'),{code:'TIMEOUT'});
      if(state.disconnectAfterAck)setTimeout(()=>this.close(),2);
      if(!state.noComplete)queueMicrotask(()=>this.emit('notification',{method:'turn/completed',params:{threadId:'existing-target',turn:state.turn}}));
      return {turn:{...state.turn,status:'inProgress'}};
    }
    throw new Error(`Unexpected fixture method: ${method}`);
  }
  thread(){return {id:'existing-target',name:'Explicit fixture target',modelProvider:this.state.threadProvider || 'openai',status:{type:this.state.busy?'active':'idle'},historyMode:this.state.historyMode || 'legacy',turns:this.state.turns || (this.state.turn?[this.state.turn]:[])};}
}
function fixture(state={},options={}){
  const transport=new FixtureTransport(state);
  const receiptDir=checkedPath(runtimePath('test-results','bridge',randomUUID()),{directory:true,create:true});
  return {state,transport,receiptDir,bridge:createBridge({mode:'managed-app-server',fixture:true,transportFactory:()=>transport,receiptDir,completionTimeoutMs:20,...options})};
}
function pack(){const h=importHistory({messages:[{role:'user',text:'预算不超过 300 元。'},{role:'assistant',text:'建议花 600 元。'}]},{sourceUri:'fixture://integration-contract'});return createPack(h,[{localId:h.messages[0].localId,start:0,end:h.messages[0].text.length},{localId:h.messages[1].localId,start:0,end:h.messages[1].text.length}],{question:'引用 2 是否违反引用 1？',memory:[]});}

test('default is export-only and never silently starts a server',async()=>{
  const b=createBridge({receiptDir:runtimePath('test-results','bridge',randomUUID())});
  const p=await b.probe();assert.equal(p.mode,'export-only');assert.equal(p.canSend,false);
  const r=await b.prepare({pack:pack(),targetThreadId:'existing-target'});const sent=await b.send(r.id);
  assert.equal(sent.status,'failed');assert.equal(sent.deliveryAttempted,false);await b.close();
});
test('fixture normal path persists before request, preserves preview and completes once',async()=>{
  const f=fixture();const r=await f.bridge.prepare({pack:pack(),targetThreadId:'existing-target'});
  f.state.beforeStart=params=>{const disk=JSON.parse(fs.readFileSync(path.join(f.receiptDir,r.id+'.json'),'utf8'));assert.equal(disk.status,'submitted');assert.equal(disk.deliveryAttempted,true);assert.equal(params.input[0].text,r.preview);assert.equal(params.model,'gpt-6-astra');assert.equal(params.effort,'ultra');};
  const completed=await f.bridge.send(r.id);assert.equal(completed.status,'completed');assert.equal(completed.turnId,'fixture-turn-1');assert.equal(completed.evidence,'fixture-contract');
  await f.bridge.send(r.id);assert.equal(f.state.sendCount,1);assert.ok(f.transport.calls.some(c=>c.method==='initialized'));assert.ok(f.transport.calls.some(c=>c.method==='thread/resume'));await f.bridge.close();
});
test('fixture busy/absent/non-ChatGPT/provider conflict is refused before turn/start',async()=>{
  for(const state of [{busy:true},{auth:'none'},{auth:'apiKey'},{provider:'custom'},{config:{model_providers:{openai:{env_key:'USER_SECRET_NAME'}}}},{threadProvider:'custom'}]){
    const f=fixture(state);const r=await f.bridge.prepare({pack:pack(),targetThreadId:'existing-target'});const result=await f.bridge.send(r.id);
    assert.equal(result.status,'failed');assert.equal(result.deliveryAttempted,false);assert.equal(state.sendCount,undefined);await f.bridge.close();
  }
  const f=fixture();const r=await f.bridge.prepare({pack:pack(),targetThreadId:'absent-target'});assert.equal((await f.bridge.send(r.id)).status,'failed');assert.equal(f.state.sendCount,undefined);await f.bridge.close();
});
test('fixture failed preflight retains draft and supports explicit recovery',async()=>{
  const f=fixture({busy:true});const r=await f.bridge.prepare({pack:pack(),targetThreadId:'existing-target'});
  assert.equal((await f.bridge.send(r.id)).status,'failed');f.state.busy=false;
  const result=await f.bridge.send(r.id);assert.equal(result.status,'completed');assert.equal(result.preview,r.preview);assert.equal(f.state.sendCount,1);await f.bridge.close();
});
test('fixture lost acknowledgement is unknown; read recovery finds exact user input without resending',async()=>{
  const f=fixture({dropAck:true});const p=pack();const r=await f.bridge.prepare({pack:p,targetThreadId:'existing-target'});
  const unknown=await f.bridge.send(r.id);assert.equal(unknown.status,'unknown');assert.equal(unknown.turnId,null);
  await f.bridge.close();
  const resumed=fixture(f.state,{receiptDir:f.receiptDir});
  assert.equal((await resumed.bridge.prepare({pack:p,targetThreadId:'existing-target'})).id,r.id);
  assert.equal((await resumed.bridge.send(r.id)).status,'unknown');assert.equal(f.state.sendCount,1);
  const recovered=await resumed.bridge.reconcile(r.id);assert.equal(recovered.status,'completed');assert.equal(recovered.turnId,'fixture-turn-1');assert.equal(f.state.sendCount,1);await resumed.bridge.close();
});
test('fixture completion timeout persists unknown and target outage does not lose the draft',async()=>{
  const f=fixture({noComplete:true});const r=await f.bridge.prepare({pack:pack(),targetThreadId:'existing-target'});
  assert.equal((await f.bridge.send(r.id)).status,'unknown');f.state.unreachable=true;
  const failed=await f.bridge.reconcile(r.id);assert.equal(failed.status,'unknown');assert.equal(failed.preview,r.preview);
  f.state.unreachable=false;f.state.turn.status='completed';assert.equal((await f.bridge.reconcile(r.id)).status,'completed');assert.equal(f.state.sendCount,1);await f.bridge.close();
});
test('fixture disconnect after acknowledgement remains unknown and is recoverable without resend',async()=>{
  const f=fixture({noComplete:true,disconnectAfterAck:true});const r=await f.bridge.prepare({pack:pack(),targetThreadId:'existing-target'});
  const result=await f.bridge.send(r.id);assert.equal(result.status,'unknown');assert.equal(result.turnId,'fixture-turn-1');
  f.state.turn.status='completed';const recovered=fixture(f.state,{receiptDir:f.receiptDir});assert.equal((await recovered.bridge.reconcile(r.id)).status,'completed');assert.equal(f.state.sendCount,1);await recovered.bridge.close();
});
test('fixture concurrent requests submit at most once and cannot downgrade a reconciled completion',async(t)=>{
  // Freeze the completion clock: OS load must not choose which operation wins.
  // An old send result can legitimately be unknown if its timeout already fired;
  // this test specifically exercises a still-pending waiter after reconciliation.
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture({noComplete:true},{completionTimeoutMs:60});const r=await f.bridge.prepare({pack:pack(),targetThreadId:'existing-target'});
  const waiting=new Promise(resolve=>f.transport.on('newListener',event=>{
    // connect() installs listener 1; waitForTurn() then installs listener 2.
    if(event==='notification' && f.transport.listenerCount('notification')===1)resolve();
  }));
  let returned=false;
  const sending=f.bridge.send(r.id).then(result=>{returned=true;return result;});
  await assert.rejects(f.bridge.send(r.id),{code:'RECEIPT_LOCKED'});
  await Promise.race([waiting,sending.then(()=>{throw new Error('Fixture send finished before its completion waiter was registered');})]);
  assert.equal(returned,false);
  f.state.turn.status='completed';assert.equal((await f.bridge.reconcile(r.id)).status,'completed');
  assert.equal(returned,false);
  t.mock.timers.tick(60); // Deliberately deliver the stale timeout after completion.
  assert.equal((await sending).status,'completed');
  assert.equal(f.bridge.receipt(r.id).status,'completed');assert.equal(f.state.sendCount,1);await f.bridge.close();
});
test('fixture crash after durable intent suppresses resend; stale lock allows read-only recovery',async()=>{
  const f=fixture({dropAck:true});const r=await f.bridge.prepare({pack:pack(),targetThreadId:'existing-target'});await f.bridge.send(r.id);
  const filename=path.join(f.receiptDir,r.id+'.json');const disk=JSON.parse(fs.readFileSync(filename,'utf8'));disk.status='submitted';fs.writeFileSync(filename,JSON.stringify(disk));
  fs.writeFileSync(path.join(f.receiptDir,r.id+'.lock'),'fixture stale process lock');await f.bridge.close();
  const resumed=fixture(f.state,{receiptDir:f.receiptDir});await assert.rejects(resumed.bridge.send(r.id),{code:'RECEIPT_LOCKED'});assert.equal((await resumed.bridge.reconcile(r.id)).status,'completed');assert.equal(f.state.sendCount,1);await resumed.bridge.close();
});
test('fixture no evidence stays unknown; arbitrary assistant text cannot confirm delivery',async()=>{
  const f=fixture({dropAck:true});const r=await f.bridge.prepare({pack:pack(),targetThreadId:'existing-target'});await f.bridge.send(r.id);
  f.state.turn.items=[{type:'agentMessage',text:r.preview}];assert.equal((await f.bridge.reconcile(r.id)).status,'unknown');assert.equal(f.state.sendCount,1);await f.bridge.close();
});
test('fixture explicit RPC refusal records failed and does not repeat a network submission',async()=>{
  const f=fixture({rejectStart:true});const r=await f.bridge.prepare({pack:pack(),targetThreadId:'existing-target'});const result=await f.bridge.send(r.id);
  assert.equal(result.status,'failed');assert.equal(result.deliveryAttempted,true);await f.bridge.send(r.id);assert.equal(f.state.sendCount,1);await f.bridge.close();
});
test('fixture host evidence requires real protocol read, managed never claims desktop',async()=>{
  const managed=fixture();assert.equal((await managed.bridge.probe()).mode,'managed-app-server');await managed.bridge.close();
  const empty=fixture({empty:true},{mode:'host-proxy',sock:'fixture-only.sock'});assert.equal((await empty.bridge.probe()).mode,'export-only');assert.equal((await empty.bridge.probe()).canSend,false);await empty.bridge.close();
  const host=fixture({},{mode:'host-proxy',sock:'fixture-only.sock'});const result=await host.bridge.probe({threadId:'existing-target'});assert.equal(result.mode,'verified-host-bridge');assert.equal(result.evidence,'fixture-contract');assert.equal(result.readVerified,true);assert.equal(result.readThreadId,'existing-target');await host.bridge.close();
});
test('fixture probe without a target never reads arbitrary listed history or retains earlier target proof',async()=>{
  const f=fixture({},{mode:'host-proxy',sock:'fixture-only.sock'});
  const result=await f.bridge.probe();assert.equal(result.connected,true);assert.equal(result.readVerified,false);assert.equal(result.canSend,false);assert.equal(result.mode,'export-only');assert.equal(f.transport.calls.some(c=>c.method==='thread/read'),false);
  assert.equal(f.transport.calls.find(c=>c.method==='thread/list').params.useStateDbOnly,true);
  await f.bridge.read('existing-target');assert.equal(f.bridge.capabilities().readVerified,true);
  const count=f.transport.calls.filter(c=>c.method==='thread/read').length;
  assert.equal((await f.bridge.probe()).readVerified,false);assert.equal(f.transport.calls.filter(c=>c.method==='thread/read').length,count);await f.bridge.close();
});
test('fixture exact target outside the first list page verifies and sends without reading the three inaccessible entries',async()=>{
  const f=fixture({listData:[{id:'inaccessible-1'},{id:'inaccessible-2'},{id:'inaccessible-3'}]},{mode:'host-proxy',sock:'fixture-only.sock'});
  const result=await f.bridge.probe({threadId:'existing-target'});assert.equal(result.readVerified,true);assert.equal(result.canSend,true);
  const r=await f.bridge.prepare({pack:pack(),targetThreadId:'existing-target'});assert.equal((await f.bridge.send(r.id)).status,'completed');
  assert.equal(f.state.sendCount,1);assert.ok(f.transport.calls.filter(c=>c.method==='thread/read').every(c=>c.params.threadId==='existing-target'));await f.bridge.close();
});
test('fixture explicit missing ID or wrong response ID clears old verification rather than borrowing a different target',async()=>{
  const f=fixture({},{mode:'host-proxy',sock:'fixture-only.sock'});await f.bridge.probe({threadId:'existing-target'});
  const missing=await f.bridge.probe({threadId:'absent-target'});assert.equal(missing.connected,true);assert.equal(missing.readVerified,false);assert.equal(missing.readThreadId,null);assert.equal(missing.readError.code,'RPC_REJECTED');assert.equal(missing.canSend,false);
  await f.bridge.read('existing-target');f.state.readReplyId='different-target';await assert.rejects(f.bridge.read('existing-target'),{code:'PROTOCOL_ERROR'});assert.equal(f.bridge.capabilities().readVerified,false);await f.bridge.close();
});
test('fixture disconnect immediately clears explicit read evidence and authentication',async()=>{
  const f=fixture({},{mode:'host-proxy',sock:'fixture-only.sock'});await f.bridge.probe({threadId:'existing-target'});assert.equal(f.bridge.capabilities().canSend,true);
  f.transport.close();const c=f.bridge.capabilities();assert.equal(c.connected,false);assert.equal(c.readVerified,false);assert.equal(c.readThreadId,null);assert.equal(c.readVerifiedAt,null);assert.equal(c.auth,null);assert.equal(c.canSend,false);assert.equal(c.mode,'export-only');
});
test('fixture explicit read is separately verified from a missing ChatGPT login and uses the package version',async()=>{
  const f=fixture({auth:'none',empty:true},{mode:'host-proxy',sock:'fixture-only.sock'});const c=await f.bridge.probe({threadId:'existing-target'});
  assert.equal(c.readVerified,true);assert.equal(c.readThreadId,'existing-target');assert.equal(c.mode,'verified-host-bridge');assert.equal(c.canSend,false);assert.equal(c.auth.code,'NOT_LOGGED_IN');
  assert.match(c.auth.message,/该宿主/);assert.doesNotMatch(c.auth.message,/node src\/cli\.mjs login/);
  const version=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;assert.equal(f.transport.calls.find(c=>c.method==='initialize').params.clientInfo.version,version);
  await f.bridge.read('existing-target');assert.match(f.bridge.capabilities().reason,/已只读核验明确目标 existing-target/);await f.bridge.close();
  const managed=fixture({auth:'none'});assert.match((await managed.bridge.probe()).auth.message,/node src\/cli\.mjs login/);await managed.bridge.close();
});
test('fixture paginated history reads all explicit-target turns and exact items in ascending order',async()=>{
  const first={id:'turn-old',status:'completed',itemsView:'full',items:[{id:'old-user',type:'userMessage',content:[{type:'text',text:'原预算 300 元'}]}]};
  const last={id:'turn-new',status:'completed',itemsView:'summary',items:[{id:'summary-only',type:'agentMessage',text:'不可作为原文的显示摘要'}]};
  const f=fixture({historyMode:'paginated',turnPages:{first:{data:[first],nextCursor:'page-2'},'page-2':{data:[last],nextCursor:null}},itemPages:{'turn-new':{first:{data:[{turnId:'turn-new',item:{id:'new-user',type:'userMessage',content:[{type:'text',text:'确认改为 200 元'}]}}],nextCursor:'items-2'},'items-2':{data:[{turnId:'turn-new',item:{id:'new-assistant',type:'agentMessage',text:'按 200 元继续。'}}],nextCursor:null}}}});
  const thread=await f.bridge.read('existing-target');assert.deepEqual(thread.turns.map(t=>t.id),['turn-old','turn-new']);assert.deepEqual(thread.turns[1].items.map(i=>i.id),['new-user','new-assistant']);assert.ok(thread.turns.every(t=>t.itemsView==='full'));
  const h=importHistory(thread,{sourceUri:'fixture://paged-contract'});assert.deepEqual(h.messages.map(m=>m.text),['原预算 300 元','确认改为 200 元','按 200 元继续。']);
  const pageCalls=f.transport.calls.filter(c=>['thread/turns/list','thread/items/list'].includes(c.method));assert.ok(pageCalls.every(c=>c.params.threadId==='existing-target'&&c.params.sortDirection==='asc'));
  assert.equal(f.transport.calls.find(c=>c.method==='initialize').params.capabilities.experimentalApi,true);assert.equal(f.transport.calls.some(c=>c.method==='thread/read'&&c.params.includeTurns),false);await f.bridge.close();
});
test('fixture legacy summary or notLoaded turns require full item hydration',async()=>{
  for(const itemsView of ['summary','notLoaded']) {
    const turn={id:'partial-turn',status:'completed',itemsView,items:[]};const f=fixture({turns:[turn],itemPages:{'partial-turn':{first:{data:[{turnId:'partial-turn',item:{id:'exact-message',type:'agentMessage',text:'保留完整原文。'}}],nextCursor:null}}}});
    const thread=await f.bridge.read('existing-target');assert.equal(thread.turns[0].items[0].text,'保留完整原文。');assert.equal(thread.turns[0].itemsView,'full');await f.bridge.close();
  }
});
test('fixture item identity may repeat across different turns but not inside one turn',async()=>{
  const item={id:'local-item-1',type:'agentMessage',text:'按回合定位原文。'};
  const turns=[{id:'turn-a',status:'completed',items:[item]},{id:'turn-b',status:'completed',items:[{...item,text:'另一回合的原文。'}]}];
  const f=fixture({turns});assert.equal((await f.bridge.read('existing-target')).turns.length,2);
  f.state.turns=[{...turns[0],items:[item,item]}];await assert.rejects(f.bridge.read('existing-target'),{code:'HISTORY_INCOMPLETE'});await f.bridge.close();
});
test('fixture unsupported pagination, repeated cursor, duplicate source IDs and cross-turn items fail without partial history',async()=>{
  const emptyTurn={id:'one-turn',status:'completed',itemsView:'full',items:[]};
  const states=[
    {historyMode:'paginated'},
    {historyMode:'paginated',turnPages:{first:{data:[],nextCursor:'repeat'},repeat:{data:[],nextCursor:'repeat'}}},
    {historyMode:'paginated',turnPages:{first:{data:[emptyTurn],nextCursor:'duplicate'},duplicate:{data:[emptyTurn],nextCursor:null}}},
    {turns:[{...emptyTurn,itemsView:'summary'}],itemPages:{'one-turn':{first:{data:[{turnId:'wrong-turn',item:{id:'wrong',type:'agentMessage',text:'错误来源'}}],nextCursor:null}}}},
    {turns:[{...emptyTurn,itemsView:'summary'}],itemPages:{'one-turn':{first:{data:[],nextCursor:'repeat'},repeat:{data:[],nextCursor:'repeat'}}}}
  ];
  for(const state of states){const f=fixture(state);await assert.rejects(f.bridge.read('existing-target'),{code:'HISTORY_INCOMPLETE'});assert.equal(f.bridge.capabilities().readVerified,false);await f.bridge.close();}
});
test('fixture history page and byte budgets reject oversized reads instead of returning a truncated source',async()=>{
  const f=fixture({historyMode:'paginated',turnPages:{first:{data:[],nextCursor:'second'},second:{data:[],nextCursor:null}}},{historyLimits:{maxPages:1}});
  await assert.rejects(f.bridge.read('existing-target'),{code:'HISTORY_LIMIT'});assert.equal(f.transport.calls.filter(c=>c.method==='thread/turns/list').length,1);await f.bridge.close();
  const bytes=fixture({},{historyLimits:{maxBytes:1}});await assert.rejects(bytes.bridge.read('existing-target'),{code:'HISTORY_LIMIT'});await bytes.bridge.close();
});
test('fixture metadata and legacy full-history requests share one bounded deadline',async(t)=>{
  let clock=1000;t.mock.method(Date,'now',()=>clock);
  for(const step of [11,6]) {
    const f=fixture({requestHook(method){if(method==='thread/read')clock+=step;}},{historyLimits:{timeoutMs:10}});
    await assert.rejects(f.bridge.read('existing-target'),{code:'HISTORY_LIMIT'});
    const reads=f.transport.calls.filter(c=>c.method==='thread/read');assert.deepEqual(reads.map(c=>c.timeoutMs),step===11?[10]:[10,4]);assert.equal(f.bridge.capabilities().readVerified,false);await f.bridge.close();
  }
});
test('fixture legacy full-history response cannot silently change to an unknown mode',async()=>{
  const f=fixture({fullHistoryMode:'future-unknown'});await assert.rejects(f.bridge.read('existing-target'),{code:'HISTORY_INCOMPLETE'});assert.equal(f.bridge.capabilities().readVerified,false);await f.bridge.close();
});
test('fixture failed paginated recovery stays unknown and succeeds after complete history becomes available without resend',async()=>{
  const f=fixture({dropAck:true});const r=await f.bridge.prepare({pack:pack(),targetThreadId:'existing-target'});assert.equal((await f.bridge.send(r.id)).status,'unknown');
  f.state.historyMode='paginated';const incomplete=await f.bridge.reconcile(r.id);assert.equal(incomplete.status,'unknown');assert.equal(incomplete.error.code,'HISTORY_INCOMPLETE');assert.equal(incomplete.preview,r.preview);
  f.state.turnPages={first:{data:[{...f.state.turn,itemsView:'full'}],nextCursor:null}};assert.equal((await f.bridge.reconcile(r.id)).status,'completed');assert.equal(f.state.sendCount,1);await f.bridge.close();
});
test('preview mismatch and receipt traversal are rejected',async()=>{
  const f=fixture();await assert.rejects(f.bridge.prepare({pack:pack(),targetThreadId:'existing-target',body:'tampered'}),{code:'PREVIEW_MISMATCH'});assert.throws(()=>f.bridge.receipt('../elsewhere'),{code:'BAD_RECEIPT_ID'});await f.bridge.close();
});
test('fixture durable preview tampering is detected before any network submission',async()=>{
  const f=fixture();const r=await f.bridge.prepare({pack:pack(),targetThreadId:'existing-target'});const filename=path.join(f.receiptDir,r.id+'.json');
  const disk=JSON.parse(fs.readFileSync(filename,'utf8'));disk.preview+=' altered';fs.writeFileSync(filename,JSON.stringify(disk));
  const rejected=await f.bridge.send(r.id);assert.equal(rejected.status,'failed');assert.equal(rejected.error.code,'RECEIPT_CORRUPT');assert.equal(f.state.sendCount,undefined);assert.equal(f.transport.calls.length,0);await f.bridge.close();
});
test('child authentication sanitation never changes parent env and stays on D',()=>{
  const before={...process.env};const env=codexChildEnv();for(const k of Object.keys(env))assert.ok(!/(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN)$/.test(k));assert.equal(Object.keys(process.env).length===Object.keys(before).length && Object.keys(before).every(key=>process.env[key]===before[key]),true,'Parent environment must be unchanged (values intentionally excluded)');
  assert.equal(env.CODEX_HOME,runtimePath('codex-profile'));assert.equal(env.CODEX_HOME,env.CODEX_PROJECT_PROFILE_DIR);assert.ok(env.CODEX_SQLITE_HOME.startsWith(env.CODEX_HOME));
  for(const key of ['CODEX_THREAD_ID','CODEX_SESSION_ID','CODEX_INTERNAL_ORIGINATOR_OVERRIDE','CODEX_APP_TOOLS_PIPE_PATH'])assert.equal(Object.hasOwn(env,key),false);
  const cmd=codexAppServerCommand();assert.ok(Array.isArray(cmd.args));assert.ok(cmd.args.includes('cli_auth_credentials_store="file"'));assert.ok(cmd.args.includes('stdio://'));
});
test('JSON-RPC dispatcher times out requests and refuses unsolicited approval requests',async()=>{
  const t=new AppServerTransport({timeoutMs:5});const written=[];t.write=value=>written.push(value);
  const p=t.request('thread/read',{threadId:'fixture'});t.receive(JSON.stringify({id:written[0].id,result:{thread:{id:'fixture'}}}));assert.equal((await p).thread.id,'fixture');
  t.receive(JSON.stringify({id:99,method:'item/commandExecution/requestApproval',params:{}}));assert.equal(written.at(-1).error.code,-32601);
  await assert.rejects(t.request('thread/read'),{code:'TIMEOUT'});t.close();
});
test('WebSocket configuration rejects external hosts, credentials and unallocated ports',async()=>{
  for(const endpoint of ['ws://example.com:6400','ws://127.0.0.1:9999','ws://a:b@127.0.0.1:6400','ws://127.0.0.1:6400?token=secret']){
    const t=new AppServerTransport({mode:'host-ws',endpoint});await assert.rejects(t.open(),{code:'ENDPOINT_REJECTED'});
  }
});
