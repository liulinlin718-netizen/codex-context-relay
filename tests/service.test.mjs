import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { dispatch } from '../src/service.mjs';
import { startServer } from '../src/server.mjs';
import { ROOT, runtimePath } from '../src/paths.mjs';
import { fromMarkdown } from '../src/core.mjs';

const demoText=fs.readFileSync(path.join(ROOT,'examples','demo-history.json'),'utf8');
async function prepare() {
  const {history}=await dispatch('import',{text:demoText,sourceUri:'fixture://service-test'});
  const {pack}=await dispatch('pack',{history,selections:[
    {localId:history.messages[0].localId,start:0,end:14},
    {localId:history.messages[1].localId,start:0,end:16},
    {localId:history.messages[0].localId,start:14,end:32},
  ],question:'引用 2 是否违反引用 1？'});
  pack.memory.push({id:'confirmed-context',kind:'constraint',text:'确认预算约束',sourceExcerptIds:[pack.excerpts[0].id],status:'user-confirmed',version:2,included:true});
  pack.memory.push({id:'excluded-context',kind:'background',text:'DO_NOT_EXPORT_UNCHECKED_BACKGROUND',sourceExcerptIds:[pack.excerpts[1].id],status:'user-confirmed',version:1,included:false});
  return {history,pack};
}

test('service import → select → preview → export → readback shares only selected material',async()=>{
  const {pack}=await prepare();
  const snapshot=JSON.stringify(pack);
  const preview=await dispatch('preview',{pack});
  assert.equal(preview.pack.memory.length,1);
  assert.ok(!preview.prompt.includes('DO_NOT_EXPORT_UNCHECKED_BACKGROUND'));
  assert.ok(!preview.prompt.includes('UNSELECTED_PRIVATE_MARKER_731'));
  for(const format of ['json','md']) {
    const exported=await dispatch('export',{pack,format});
    assert.equal(exported.verified,true);
    assert.equal(path.dirname(exported.path),runtimePath('exports'));
    const text=fs.readFileSync(exported.path,'utf8');
    assert.equal(Buffer.byteLength(text),exported.bytes);
    const imported=await dispatch('import',{text});
    assert.deepEqual(imported.pack,preview.pack);
    assert.equal(imported.pack.excerpts.length,3);
    assert.equal(imported.pack.excerpts[1].role,'assistant');
    assert.ok(!JSON.stringify(imported.pack).includes('DO_NOT_EXPORT_UNCHECKED_BACKGROUND'));
    assert.ok(!JSON.stringify(imported.pack).includes('UNSELECTED_PRIVATE_MARKER_731'));
    assert.equal(exported.prompt,preview.prompt);
    if(format==='md')assert.deepEqual(fromMarkdown(text),preview.pack);
  }
  assert.equal(JSON.stringify(pack),snapshot,'Sharing must not mutate the editing draft');
});

test('imported packId is data and cannot redirect export outside the exports directory',async()=>{
  const {pack}=await prepare();
  pack.packId='../service-test-escape/rogue-pack';
  const result=await dispatch('export',{pack,format:'json'});
  assert.equal(path.dirname(result.path),runtimePath('exports'));
  assert.match(path.basename(result.path),/^context-pack-[a-f0-9-]+\.json$/);
  assert.equal(JSON.parse(fs.readFileSync(result.path,'utf8')).packId,pack.packId);
});

test('failed validation leaves the caller draft intact and valid material can be retried',async()=>{
  const {history,pack}=await prepare();
  const bad=structuredClone(pack);bad.excerpts[0].exactText='tampered';
  const snapshot=JSON.stringify(bad);
  await assert.rejects(dispatch('export',{pack:bad,format:'json'}),{code:'INVALID_RANGE'});
  assert.equal(JSON.stringify(bad),snapshot);
  await assert.rejects(dispatch('import',{text:'not a transcript'}),{code:'INVALID_HISTORY'});
  await assert.rejects(dispatch('export',{pack,format:'exe'}),{code:'INVALID_FORMAT'});
  const verified=await dispatch('sources',{pack,history});
  assert.ok(verified.sources.every(x=>x.status==='unchanged'));
  assert.equal((await dispatch('export',{pack,format:'json'})).verified,true);
});

test('draft high-water mark rejects malformed counters before touching the shared draft',async()=>{
  const {pack}=await prepare();
  for(const selectionCounter of [-1,0,2,1.5,'3',NaN]) {
    await assert.rejects(dispatch('draft-save',{pack,selectionCounter}),{code:'INVALID_COUNTER'});
  }
  // Deliberately do not save a valid draft: browser QA owns the shared editing draft.
});

test('complete backup restores private working history while export remains selection-only',async()=>{
  const {history,pack}=await prepare();
  const restored=await dispatch('import',{text:JSON.stringify({draftFormat:'context-relay-draft/v1',history,pack,question:pack.question,selectionCounter:12})});
  assert.deepEqual(restored.draft.history,history);
  assert.deepEqual(restored.draft.pack,pack);
  assert.equal(restored.draft.selectionCounter,12);
  assert.equal(restored.draft.pack.memory.length,2);
  const preview=await dispatch('preview',{pack:restored.draft.pack});
  assert.ok(!preview.prompt.includes('DO_NOT_EXPORT_UNCHECKED_BACKGROUND'));
  await assert.rejects(dispatch('import',{text:JSON.stringify({draftFormat:'context-relay-draft/v1',history:{messages:[{text:42}]}})}),{code:'INVALID_HISTORY'});
});

function request(port,requestPath,headers={},chunks=[]) {
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:requestPath,method:chunks.length?'POST':'GET',headers,agent:false},res=>{
      const parts=[];res.on('data',part=>parts.push(part));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(parts).toString('utf8'))}));
    });
    req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('HTTP test timeout')));
    void(async()=>{for(const chunk of chunks){req.write(chunk);await new Promise(resolve=>setTimeout(resolve,15));}req.end();})();
  });
}

test('real loopback HTTP preserves Chinese/emoji across byte splits and recovers after malformed requests',async t=>{
  let app,port;
  for(const candidate of [6409,6408]) {
    try {app=await startServer({port:candidate,quiet:true});port=candidate;break;}
    catch(e){if(e.code!=='EADDRINUSE')throw e;}
  }
  assert.ok(app,'One of the reserved test ports 6408–6409 must be available');
  t.after(()=>app.close());
  const bootstrap=await request(port,'/bootstrap');
  const headers={'content-type':'application/json','x-relay-token':bootstrap.body.token,origin:`http://127.0.0.1:${port}`};
  const original='预算😀：保持中文与 emoji 原文，网络分块不能破坏它。';
  const payload=Buffer.from(JSON.stringify({action:'import',data:{text:JSON.stringify({messages:[{role:'user',text:original}]}),sourceUri:'fixture://chunked-http'}}));
  const boundaries=[];
  for(let i=0;i<payload.length;i++)if(payload[i]>127)boundaries.push(i+1);
  const chunks=[];let last=0;
  for(const end of boundaries){chunks.push(payload.subarray(last,end));last=end;}
  chunks.push(payload.subarray(last));
  const imported=await request(port,'/api',headers,chunks);
  assert.equal(imported.status,200);
  assert.equal(imported.body.history.messages[0].text,original);
  const denied=await request(port,'/api',{'content-type':'application/json'},[Buffer.from('{}')]);
  assert.equal(denied.status,403);
  const bad=await request(port,'//[');
  assert.equal(bad.status,400);
  assert.equal(bad.body.error.code,'INVALID_URL');
  const alive=await request(port,'/bootstrap');
  assert.equal(alive.status,200);
  assert.equal(alive.body.token,bootstrap.body.token);
});
