import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createBridge} from '../src/integrations.mjs';
import {importHistory,createPack} from '../src/core.mjs';
import {ROOT,checkedPath,runtimePath,childEnv} from '../src/paths.mjs';

// Local process/IPC and transport fixtures only. No Codex, host, login or model
// request occurs. Every child inherits the project's D-drive runtime paths.
const hasKernelGuard=['win32','linux'].includes(process.platform);
const childProgram=String.raw`
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createBridge} from './src/integrations.mjs';
import {importHistory,createPack} from './src/core.mjs';
const options=JSON.parse(process.env.RELAY_LOCK_FIXTURE);
const report=value=>new Promise(resolve=>process.send(value,resolve));
const waitGo=new Promise(resolve=>process.on('message',m=>{if(m.type==='go')resolve();if(m.type==='crash')process.exit(86);}));
class Transport extends EventEmitter {
  async open(){}
  close(){this.closed=true;this.emit('disconnect');}
  notify(){}
  async request(method,params){
    if(method==='initialize'){
      if(options.action==='owner-before'){
        await report({type:'blocked',phase:'before'});return new Promise(()=>{});
      }
      return {userAgent:'fixture-no-real-server'};
    }
    if(method==='thread/list')return {data:[],nextCursor:null};
    if(method==='thread/read'||method==='thread/resume')return {thread:{id:'existing-target',modelProvider:'openai',status:{type:'idle'},turns:[]}};
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='config/read')return {config:{model_provider:'openai'}};
    if(method==='turn/start'){
      fs.appendFileSync(path.join(options.receiptDir,'fixture-submissions.jsonl'),JSON.stringify(params)+'\n');
      await report({type:'blocked',phase:'after'});return new Promise(()=>{});
    }
    throw new Error('Unexpected fixture method '+method);
  }
}
const bridge=createBridge({mode:'managed-app-server',fixture:true,receiptDir:options.receiptDir,transportFactory:()=>new Transport()});
if(options.action.startsWith('owner-')){
  const history=importHistory({messages:[{role:'user',text:'Preserve exact local fixture quote.'}]},{sourceUri:'fixture:lock-recovery'});
  const pack=createPack(history,[{localId:history.messages[0].localId}],{question:'Review quote 1.',memory:[]});
  const receipt=options.receiptId?bridge.receipt(options.receiptId):await bridge.prepare({pack,targetThreadId:'existing-target'});
  await report({type:'prepared',receipt});
  if(options.action==='owner-before-publish'){
    const link=fs.linkSync;fs.linkSync=(from,to)=>{if(to.endsWith('.lock'))process.exit(87);return link(from,to);};
  }
  if(options.action==='owner-after-link'){
    const link=fs.linkSync;fs.linkSync=(from,to)=>{const result=link(from,to);if(to.endsWith('.lock'))process.exit(89);return result;};
  }
  await bridge.send(receipt.id);
}else{
  if(options.action.startsWith('recover-crash-')){
    const unlink=fs.unlinkSync;
    fs.unlinkSync=filename=>{
      if(filename.endsWith('.lock')){
        if(options.action==='recover-crash-after')unlink(filename);
        process.exit(88);
      }
      return unlink(filename);
    };
  }
  await report({type:'ready'});await waitGo;
  try{
    const result=await bridge.recoverReceiptLock(options.receiptId,{expectedLockToken:options.token,confirm:true});
    await report({type:'result',ok:true,result});
  }catch(e){await report({type:'result',ok:false,code:e.code});}
  process.exit(0);
}
`;

function directory(){return checkedPath(runtimePath('test-results','lock-recovery',randomUUID()),{directory:true,create:true});}
function launch(t,options){
  const child=spawn(process.execPath,['--input-type=module','-e',childProgram],{
    cwd:ROOT,env:childEnv({RELAY_LOCK_FIXTURE:JSON.stringify(options)}),shell:false,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']
  });
  let stderr='',ended=false;
  child.stdout.resume();child.stderr.on('data',data=>{stderr=(stderr+data).slice(-4000);});
  const messages=[],waiting=[];
  child.on('message',message=>{
    const index=waiting.findIndex(w=>w.type===message.type);
    if(index>=0)waiting.splice(index,1)[0].resolve(message);else messages.push(message);
  });
  const exited=new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('exit',(code,signal)=>{
      ended=true;resolve({code,signal});
      for(const waiter of waiting.splice(0))waiter.reject(new Error(`Fixture exited before ${waiter.type}: ${code}; ${stderr}`));
    });
  });
  t.after(async()=>{if(!ended)child.kill();await exited;});
  return {child,exited,next(type){
    const index=messages.findIndex(m=>m.type===type);
    if(index>=0)return Promise.resolve(messages.splice(index,1)[0]);
    if(ended)return Promise.reject(new Error(`Fixture already exited before ${type}: ${stderr}`));
    return new Promise((resolve,reject)=>waiting.push({type,resolve,reject}));
  }};
}
class CompletionFixture extends EventEmitter {
  calls=[];count=0;turn=null;
  async open(){}
  notify(){}
  close(){this.closed=true;this.emit('disconnect');}
  async request(method,params){
    this.calls.push(method);
    if(method==='initialize')return {userAgent:'fixture-no-real-server'};
    if(method==='thread/list')return {data:[],nextCursor:null};
    if(method==='thread/read'||method==='thread/resume')return {thread:{id:'existing-target',modelProvider:'openai',status:{type:'idle'},turns:params.includeTurns&&this.turn?[this.turn]:[]}};
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='config/read')return {config:{model_provider:'openai'}};
    if(method==='turn/start'){
      this.count++;return {turn:{id:'fixture-turn',status:'completed',items:[{type:'userMessage',content:params.input}]}};
    }
    throw new Error('Unexpected fixture method '+method);
  }
}
function parentBridge(receiptDir){
  const transport=new CompletionFixture();
  return {transport,bridge:createBridge({mode:'managed-app-server',fixture:true,receiptDir,transportFactory:()=>transport})};
}
async function orphan(t,action='owner-before'){
  const receiptDir=directory(),owner=launch(t,{action,receiptDir});
  const {receipt}=await owner.next('prepared');await owner.next('blocked');
  owner.child.send({type:'crash'});assert.equal((await owner.exited).code,86);
  return {receiptDir,receipt,...parentBridge(receiptDir)};
}

test('lock diagnosis is local, live ownership never expires, and PID reuse is irrelevant',{skip:!hasKernelGuard,timeout:15000},async t=>{
  const receiptDir=directory(),owner=launch(t,{action:'owner-before',receiptDir});
  const {receipt}=await owner.next('prepared');await owner.next('blocked');
  const {bridge,transport}=parentBridge(receiptDir),filename=path.join(receiptDir,receipt.id+'.lock');
  // A deliberately old timestamp must not steal an actually live kernel lock.
  const record=JSON.parse(fs.readFileSync(filename,'utf8'));record.createdAt='2000-01-01T00:00:00Z';fs.writeFileSync(filename,JSON.stringify(record));
  const active=await bridge.diagnoseReceiptLock(receipt.id);
  assert.equal(active.ownerState,'active');assert.equal(active.recoverable,false);assert.equal(active.code,'LOCK_OWNER_ACTIVE');
  await assert.rejects(bridge.recoverReceiptLock(receipt.id,{expectedLockToken:active.lockToken,confirm:true}),{code:'RECEIPT_LOCKED'});
  await assert.rejects(bridge.send(receipt.id),{code:'RECEIPT_LOCKED'});
  assert.equal(transport.calls.length,0);assert.equal(fs.existsSync(filename),true);
  owner.child.send({type:'crash'});await owner.exited;
  // Simulate a recycled PID now naming a live unrelated process. PID is merely
  // diagnostic metadata; acquiring the same kernel guard is the actual proof.
  record.pid=process.pid;fs.writeFileSync(filename,JSON.stringify(record));
  const inactive=await bridge.diagnoseReceiptLock(receipt.id);
  assert.equal(inactive.ownerState,'inactive');assert.equal(inactive.recoverable,true);assert.equal(transport.calls.length,0);
  await bridge.close();
});

test('exited pre-submit owner requires explicit recovery; original receipt sends once',{skip:!hasKernelGuard,timeout:15000},async t=>{
  const f=await orphan(t),file=path.join(f.receiptDir,f.receipt.id+'.json'),original=fs.readFileSync(file,'utf8');
  const diagnostic=await f.bridge.diagnoseReceiptLock(f.receipt.id);
  await assert.rejects(f.bridge.send(f.receipt.id),{code:'RECEIPT_LOCKED'});
  await assert.rejects(f.bridge.recoverReceiptLock(f.receipt.id,{expectedLockToken:diagnostic.lockToken}),{code:'RECOVERY_CONFIRM_REQUIRED'});
  await assert.rejects(f.bridge.recoverReceiptLock(f.receipt.id,{confirm:true}),{code:'LOCK_TOKEN_REQUIRED'});
  await assert.rejects(f.bridge.recoverReceiptLock(f.receipt.id,{confirm:true,expectedLockToken:'0'.repeat(64)}),{code:'LOCK_CHANGED'});
  const restored=await f.bridge.recoverReceiptLock(f.receipt.id,{confirm:true,expectedLockToken:diagnostic.lockToken});
  assert.equal(restored.recovered,true);assert.equal(f.transport.calls.length,0);assert.equal(fs.readFileSync(file,'utf8'),original);
  assert.equal((await f.bridge.diagnoseReceiptLock(f.receipt.id)).code,'NO_LOCK');
  assert.equal((await f.bridge.prepare({pack:f.receipt.pack,targetThreadId:f.receipt.targetThreadId})).id,f.receipt.id);
  const completed=await f.bridge.send(f.receipt.id);assert.equal(completed.status,'completed');assert.equal(completed.preview,f.receipt.preview);assert.equal(completed.bodyHash,f.receipt.bodyHash);
  await f.bridge.send(f.receipt.id);assert.equal(f.transport.count,1);await f.bridge.close();
});

test('two real processes recovering the same generation produce exactly one winner',{skip:!hasKernelGuard,timeout:15000},async t=>{
  const f=await orphan(t),d=await f.bridge.diagnoseReceiptLock(f.receipt.id);
  const options={action:'recover',receiptDir:f.receiptDir,receiptId:f.receipt.id,token:d.lockToken};
  const a=launch(t,options),b=launch(t,options);await Promise.all([a.next('ready'),b.next('ready')]);
  a.child.send({type:'go'});b.child.send({type:'go'});
  const results=await Promise.all([a.next('result'),b.next('result')]);await Promise.all([a.exited,b.exited]);
  assert.equal(results.filter(r=>r.ok).length,1);assert.ok(['RECEIPT_LOCKED','LOCK_CHANGED'].includes(results.find(r=>!r.ok).code));
  assert.equal(f.transport.calls.length,0);assert.equal(f.bridge.receipt(f.receipt.id).deliveryAttempted,false);
  await f.bridge.send(f.receipt.id);assert.equal(f.transport.count,1);await f.bridge.close();
});

test('an old diagnosis cannot remove a later lock generation for the same receipt',{skip:!hasKernelGuard,timeout:15000},async t=>{
  const f=await orphan(t),first=await f.bridge.diagnoseReceiptLock(f.receipt.id);
  await f.bridge.recoverReceiptLock(f.receipt.id,{confirm:true,expectedLockToken:first.lockToken});
  const owner=launch(t,{action:'owner-before',receiptDir:f.receiptDir,receiptId:f.receipt.id});
  const {receipt}=await owner.next('prepared');assert.equal(receipt.id,f.receipt.id);await owner.next('blocked');
  const second=await f.bridge.diagnoseReceiptLock(f.receipt.id);assert.notEqual(second.lockToken,first.lockToken);
  await assert.rejects(f.bridge.recoverReceiptLock(f.receipt.id,{confirm:true,expectedLockToken:first.lockToken}),{code:'RECEIPT_LOCKED'});
  owner.child.send({type:'crash'});await owner.exited;
  await assert.rejects(f.bridge.recoverReceiptLock(f.receipt.id,{confirm:true,expectedLockToken:first.lockToken}),{code:'LOCK_CHANGED'});
  assert.equal((await f.bridge.diagnoseReceiptLock(f.receipt.id)).lockToken,second.lockToken);
  await f.bridge.recoverReceiptLock(f.receipt.id,{confirm:true,expectedLockToken:second.lockToken});
  assert.equal(f.transport.calls.length,0);assert.deepEqual(f.bridge.receipt(f.receipt.id),f.receipt);await f.bridge.close();
});

test('a recoverable owner does not bypass receipt integrity or connection checks',{skip:!hasKernelGuard,timeout:15000},async t=>{
  const f=await orphan(t),file=path.join(f.receiptDir,f.receipt.id+'.json');
  const mismatched=createBridge({mode:'export-only',receiptDir:f.receiptDir});
  await assert.rejects(mismatched.diagnoseReceiptLock(f.receipt.id),{code:'CONNECTION_MISMATCH'});await mismatched.close();
  const diagnostic=await f.bridge.diagnoseReceiptLock(f.receipt.id);
  for(const patch of [{preview:f.receipt.preview+' changed'},{bodyHash:'0'.repeat(64)}]){
    fs.writeFileSync(file,JSON.stringify({...f.receipt,...patch}));
    assert.equal((await f.bridge.diagnoseReceiptLock(f.receipt.id)).code,'RECEIPT_CORRUPT');
    await assert.rejects(f.bridge.recoverReceiptLock(f.receipt.id,{confirm:true,expectedLockToken:diagnostic.lockToken}),{code:'RECEIPT_CORRUPT'});
    assert.equal(fs.existsSync(path.join(f.receiptDir,f.receipt.id+'.lock')),true);
  }
  assert.equal(f.transport.calls.length,0);await f.bridge.close();
});

test('crashes on either side of recovery unlink remain diagnosable without resending',{skip:!hasKernelGuard,timeout:20000},async t=>{
  for(const side of ['before','after']){
    const f=await orphan(t),d=await f.bridge.diagnoseReceiptLock(f.receipt.id);
    const recovering=launch(t,{action:'recover-crash-'+side,receiptDir:f.receiptDir,receiptId:f.receipt.id,token:d.lockToken});
    await recovering.next('ready');recovering.child.send({type:'go'});assert.equal((await recovering.exited).code,88);
    const after=await f.bridge.diagnoseReceiptLock(f.receipt.id);
    if(side==='before'){
      assert.equal(after.recoverable,true);assert.equal(after.lockToken,d.lockToken);
      await f.bridge.recoverReceiptLock(f.receipt.id,{confirm:true,expectedLockToken:after.lockToken});
    }else assert.equal(after.code,'NO_LOCK');
    assert.equal(f.transport.count,0);assert.deepEqual(f.bridge.receipt(f.receipt.id),f.receipt);await f.bridge.close();
  }
});

test('crash before atomic lock publication leaves only ignored staging data',{skip:!hasKernelGuard,timeout:15000},async t=>{
  const receiptDir=directory(),owner=launch(t,{action:'owner-before-publish',receiptDir});
  const {receipt}=await owner.next('prepared');assert.equal((await owner.exited).code,87);
  const {bridge,transport}=parentBridge(receiptDir);
  assert.equal(fs.existsSync(path.join(receiptDir,receipt.id+'.lock')),false);
  assert.ok(fs.readdirSync(receiptDir).some(name=>name.endsWith('.tmp')));
  assert.equal((await bridge.diagnoseReceiptLock(receipt.id)).code,'NO_LOCK');
  assert.equal((await bridge.send(receipt.id)).status,'completed');assert.equal(transport.count,1);await bridge.close();
});

test('crash after atomic publication recovers only the exact same-generation staging twin',{skip:!hasKernelGuard,timeout:15000},async t=>{
  const receiptDir=directory(),owner=launch(t,{action:'owner-after-link',receiptDir});
  const {receipt}=await owner.next('prepared');assert.equal((await owner.exited).code,89);
  const filename=path.join(receiptDir,receipt.id+'.lock'),record=JSON.parse(fs.readFileSync(filename,'utf8'));
  const staging=`${filename}.${record.ownerToken}.tmp`;
  assert.equal(fs.lstatSync(filename).nlink,2);assert.equal(fs.lstatSync(staging).ino,fs.lstatSync(filename).ino);
  const {bridge,transport}=parentBridge(receiptDir),d=await bridge.diagnoseReceiptLock(receipt.id);
  assert.equal(d.recoverable,true);assert.equal(fs.existsSync(staging),true,'Diagnosis must not remove publication evidence');
  await assert.rejects(bridge.send(receipt.id),{code:'RECEIPT_LOCKED'});
  const extra=path.join(receiptDir,'unexpected-alias');fs.linkSync(filename,extra);
  await assert.rejects(bridge.diagnoseReceiptLock(receipt.id),{code:'REPARSE_PATH'});
  await assert.rejects(bridge.recoverReceiptLock(receipt.id,{confirm:true,expectedLockToken:d.lockToken}),{code:'REPARSE_PATH'});
  assert.equal(fs.lstatSync(filename).nlink,3);assert.equal(fs.existsSync(staging),true);fs.unlinkSync(extra);
  // Explicit recovery may crash after removing the verified twin but before
  // unlinking the authoritative lock. The remaining single link is recoverable.
  const recovering=launch(t,{action:'recover-crash-before',receiptDir,receiptId:receipt.id,token:d.lockToken});
  await recovering.next('ready');recovering.child.send({type:'go'});assert.equal((await recovering.exited).code,88);
  assert.equal(fs.existsSync(staging),false);assert.equal(fs.lstatSync(filename).nlink,1);
  const after=await bridge.diagnoseReceiptLock(receipt.id);assert.equal(after.recoverable,true);assert.equal(after.lockToken,d.lockToken);
  await bridge.recoverReceiptLock(receipt.id,{confirm:true,expectedLockToken:after.lockToken});
  assert.deepEqual(bridge.receipt(receipt.id),receipt);assert.equal(transport.calls.length,0);
  assert.equal((await bridge.send(receipt.id)).status,'completed');assert.equal(transport.count,1);await bridge.close();
});

test('durable send intent and unknown outcomes only reconcile; recovery cannot enable resend',{skip:!hasKernelGuard,timeout:15000},async t=>{
  const f=await orphan(t,'owner-after'),file=path.join(f.receiptDir,f.receipt.id+'.json');
  assert.equal(f.bridge.receipt(f.receipt.id).status,'submitted');assert.equal(f.bridge.receipt(f.receipt.id).deliveryAttempted,true);
  for(const status of ['submitted','unknown']){
    const disk=JSON.parse(fs.readFileSync(file,'utf8'));disk.status=status;fs.writeFileSync(file,JSON.stringify(disk));
    const d=await f.bridge.diagnoseReceiptLock(f.receipt.id);assert.equal(d.recoverable,false);assert.equal(d.code,'DELIVERY_REQUIRES_RECONCILE');
    await assert.rejects(f.bridge.recoverReceiptLock(f.receipt.id,{confirm:true,expectedLockToken:d.lockToken}),{code:'DELIVERY_REQUIRES_RECONCILE'});
    await assert.rejects(f.bridge.send(f.receipt.id),{code:'RECEIPT_LOCKED'});
  }
  assert.equal(f.transport.calls.length,0);assert.equal(f.transport.count,0);
  const submissions=fs.readFileSync(path.join(f.receiptDir,'fixture-submissions.jsonl'),'utf8').trim().split('\n');assert.equal(submissions.length,1);
  f.transport.turn={id:'fixture-existing-turn',status:'completed',items:[{id:'fixture-existing-message',type:'userMessage',content:JSON.parse(submissions[0]).input}]};
  assert.equal((await f.bridge.reconcile(f.receipt.id)).status,'completed');assert.equal(f.transport.count,0);
  assert.equal(fs.existsSync(path.join(f.receiptDir,f.receipt.id+'.lock')),true);await f.bridge.close();
});

test('legacy, malformed, foreign-namespace locks and inconsistent intent are conservatively retained',{timeout:10000},async()=>{
  const receiptDir=directory(),{bridge,transport}=parentBridge(receiptDir);
  const h=importHistory({messages:[{role:'user',text:'Local legacy lock fixture.'}]},{sourceUri:'fixture:legacy-lock'});
  const pack=createPack(h,[{localId:h.messages[0].localId}],{question:'Preserve it.',memory:[]});
  const r=await bridge.prepare({pack,targetThreadId:'existing-target'}),lockFile=path.join(receiptDir,r.id+'.lock');
  for(const raw of ['',JSON.stringify({pid:process.pid,createdAt:'2000-01-01'}),JSON.stringify({pid:999999999,createdAt:'2000-01-01'}),JSON.stringify({schemaVersion:2,protocol:'kernel-guard-v1',guardKey:'foreign',ownerToken:randomUUID()})]){
    fs.writeFileSync(lockFile,raw);const d=await bridge.diagnoseReceiptLock(r.id);
    assert.equal(d.recoverable,false);assert.equal(d.ownerState,'unverifiable');assert.equal(d.code,'LOCK_OWNER_UNVERIFIABLE');
    await assert.rejects(bridge.recoverReceiptLock(r.id,{confirm:true,expectedLockToken:d.lockToken}),{code:'LOCK_OWNER_UNVERIFIABLE'});
    assert.equal(fs.readFileSync(lockFile,'utf8'),raw);
  }
  const file=path.join(receiptDir,r.id+'.json');
  for(const patch of [{status:'unknown'},{deliveryAttempted:null},{submittedAt:'2026-09-25T00:00:00Z'},{turnId:'uncertain-turn'}]){
    fs.writeFileSync(file,JSON.stringify({...r,...patch}));const d=await bridge.diagnoseReceiptLock(r.id);
    assert.equal(d.code,'DELIVERY_REQUIRES_RECONCILE');assert.equal(d.recoverable,false);
    await assert.rejects(bridge.recoverReceiptLock(r.id,{confirm:true,expectedLockToken:d.lockToken}),{code:'DELIVERY_REQUIRES_RECONCILE'});
  }
  assert.equal(transport.calls.length,0);await bridge.close();
});
