import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startServer} from '../src/server.mjs';
import {importHistory} from '../src/core.mjs';

test('real HTTP saves a >24MiB complete draft via history references and restores its self-contained backup in bounded requests',async t=>{
  const app=await startServer({port:6404,quiet:true});
  t.after(async()=>{app.server.closeAllConnections();await app.close();});
  const {token}=await (await fetch(app.url+'/bootstrap')).json();
  const requests=[];
  async function api(action,data){
    const body=JSON.stringify({action,data});requests.push({action,bytes:Buffer.byteLength(body)});
    assert.ok(Buffer.byteLength(body)<24*1024*1024,action+' request must remain bounded');
    const response=await fetch(app.url+'/api',{method:'POST',headers:{'content-type':'application/json','x-relay-token':token},body});
    const result=await response.json();assert.equal(response.status,200,JSON.stringify(result.error));return result;
  }
  // Quoted/escaped source makes the obsolete {text: JSON.stringify(backup)}
  // envelope exceed the limit even after removing the history half.
  const source='"'.repeat(450000);
  const history=importHistory({messages:Array.from({length:15},(_,i)=>({id:`large-${i}`,role:i%2?'assistant':'user',text:source}))});
  const imported={history,...await api('history-store',{history})};
  const {pack}=await api('pack',{historyId:imported.historyId,selections:imported.history.messages.map(m=>({localId:m.localId}))});
  const saved=await api('draft-save',{historyId:imported.historyId,pack,question:'before',draftId:randomUUID(),expectedRevision:null});
  const changed=await api('draft-patch',{draftId:saved.draftId,expectedRevision:saved.revision,changes:{question:'after small update'}});
  assert.ok(requests.at(-1).bytes<1024);
  const backup=await api('draft-download',{draftId:saved.draftId});
  assert.ok(Buffer.byteLength(backup.content)>24*1024*1024);
  const parsed=JSON.parse(backup.content);assert.ok(!parsed.historyId);
  // Same two validated stages used by the browser backup import path.
  assert.ok(Buffer.byteLength(JSON.stringify({action:'import',data:{text:JSON.stringify({...parsed,history:null})}}))>24*1024*1024);
  const compact=await api('draft-validate',{...parsed,history:null});
  const stored=await api('history-store',{history:parsed.history});
  const restored=await api('draft-save',{...compact.draft,history:undefined,historyId:stored.historyId,draftId:randomUUID(),expectedRevision:null});
  const loaded=await api('draft-load',{draftId:restored.draftId});
  assert.equal(loaded.question,'after small update');
  assert.equal(loaded.history.messages.length,15);assert.equal(loaded.pack.excerpts.length,15);
  assert.equal(loaded.history.messages[0].text,source);
  assert.deepEqual(loaded.pack.excerpts.map(x=>[x.sourceHash,x.excerptHash,x.label]),pack.excerpts.map(x=>[x.sourceHash,x.excerptHash,x.label]));
  assert.notEqual(restored.draftId,saved.draftId);
  const original=await api('draft-load',{draftId:saved.draftId});assert.equal(original.revision,changed.revision);
});
