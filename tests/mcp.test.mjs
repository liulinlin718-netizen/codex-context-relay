import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { ROOT,childEnv,runtimePath } from '../src/paths.mjs';

/** Real stdio process contract test. No host installation, model calls or sends. */
function startMcp(t) {
  const proc=spawn(process.execPath,[path.join(ROOT,'src','mcp.mjs')],{cwd:ROOT,env:childEnv(),shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const pending=new Map();let sequence=0,stderr='';
  proc.stderr.on('data',chunk=>{stderr+=chunk.toString('utf8')});
  const lines=readline.createInterface({input:proc.stdout,crlfDelay:Infinity});
  lines.on('line',line=>{
    let value;try{value=JSON.parse(line)}catch(e){for(const wait of pending.values())wait.reject(e);pending.clear();return;}
    const wait=pending.get(value.id);if(wait){pending.delete(value.id);clearTimeout(wait.timeout);wait.resolve(value);}
  });
  proc.on('error',e=>{for(const wait of pending.values())wait.reject(e);pending.clear();});
  const exited=new Promise(resolve=>proc.once('exit',(code,signal)=>{
    for(const wait of pending.values()){clearTimeout(wait.timeout);wait.reject(new Error(`MCP exited unexpectedly (${code}/${signal}): ${stderr}`));}pending.clear();resolve({code,signal});
  }));
  function raw(line,id) {
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{pending.delete(id);reject(new Error(`MCP request ${id} timed out: ${stderr}`));},7000);
      pending.set(id,{resolve,reject,timeout});proc.stdin.write(line+'\n');
    });
  }
  function request(method,params={}) {const id=++sequence;return raw(JSON.stringify({jsonrpc:'2.0',id,method,params}),id);}
  async function call(name,args={}) {
    const rpc=await request('tools/call',{name,arguments:args});
    assert.ok(!rpc.error,JSON.stringify(rpc.error));
    return rpc.result;
  }
  t.after(async()=>{
    proc.stdin.end();
    const timer=setTimeout(()=>proc.kill(),1500);
    await exited;clearTimeout(timer);lines.close();
    for(const wait of pending.values())clearTimeout(wait.timeout);
  });
  return {request,raw,call,notify:(method,params={})=>proc.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n')};
}

test('MCP import-open returns its own real selector URL and bad imports leave it recoverable',async t=>{
  const mcp=startMcp(t);
  await mcp.request('initialize',{protocolVersion:'2025-03-26'});
  const opened=await mcp.call('relay_import_open',{text:JSON.stringify({messages:[{role:'user',text:'Independent MCP draft A'}]}),port:6406});
  assert.ok(!opened.isError,JSON.stringify(opened));
  const value=opened.structuredContent;
  assert.match(value.url,/^http:\/\/127\.0\.0\.1:6406\/\?draft=[\da-f-]+$/);
  assert.notEqual(value.draftId,'main');
  const origin=new URL(value.url).origin;
  const {token}=await (await fetch(origin+'/bootstrap')).json();
  const load=async()=> (await fetch(origin+'/api',{method:'POST',headers:{'content-type':'application/json','x-relay-token':token},body:JSON.stringify({action:'draft-load',data:{draftId:value.draftId}})})).json();
  const draft=await load();assert.equal(draft.history.messages[0].text,'Independent MCP draft A');assert.ok(draft.historyId);
  const bad=await mcp.call('relay_import_open',{text:'not json',port:6406});assert.equal(bad.isError,true);
  assert.equal((await load()).revision,draft.revision);
  const reopened=await mcp.call('relay_selector',{draftId:value.draftId,port:6406});assert.equal(reopened.structuredContent.url,value.url);
});

test('real MCP stdio initialize/import/pack/preview/export/readback works without host installation',async t=>{
  const mcp=startMcp(t);
  const initialization=await mcp.request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'context-relay-contract-test',version:'1'}});
  assert.equal(initialization.result.serverInfo.name,'codex-context-relay');
  assert.equal(initialization.result.serverInfo.version,JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).version);
  assert.equal(initialization.result.protocolVersion,'2025-03-26');
  mcp.notify('notifications/initialized');
  const listed=await mcp.request('tools/list');
  for(const expected of ['relay_import','relay_pack','relay_preview','relay_export','relay_selector'])assert.ok(listed.result.tools.some(tool=>tool.name===expected));
  const resource=await mcp.request('resources/read',{uri:'context-relay://schema/v1'});
  assert.deepEqual((await mcp.request('resources/templates/list')).result,{resourceTemplates:[]});
  assert.equal(JSON.parse(resource.result.contents[0].text).properties.schemaVersion.const,'1');
  const imported=await mcp.call('relay_import',{text:fs.readFileSync(path.join(ROOT,'examples/demo-history.json'),'utf8'),sourceUri:'fixture://mcp-history'});
  assert.ok(!imported.isError,JSON.stringify(imported));
  const history=imported.structuredContent.history;
  const selected=await mcp.call('relay_pack',{history,selections:[
    {localId:history.messages[0].localId,start:0,end:14},
    {localId:history.messages[1].localId,start:0,end:16},
    {localId:history.messages[0].localId,start:14,end:32},
  ],question:'引用 2 是否违反引用 1？'});
  const pack=selected.structuredContent.pack;
  pack.memory.push({id:'mcp-confirmed',kind:'constraint',text:'引用预算约束',sourceExcerptIds:[pack.excerpts[0].id],status:'user-confirmed',version:1,included:true});
  pack.memory.push({id:'mcp-excluded',kind:'background',text:'UNSELECTED_MCP_BACKGROUND',sourceExcerptIds:[pack.excerpts[1].id],status:'model-proposed',version:1,included:false});
  const preview=await mcp.call('relay_preview',{pack});
  assert.equal(preview.structuredContent.pack.excerpts.length,3);
  assert.equal(preview.structuredContent.pack.memory.length,1);
  assert.ok(!preview.structuredContent.prompt.includes('UNSELECTED_MCP_BACKGROUND'));
  assert.ok(!preview.structuredContent.prompt.includes('UNSELECTED_PRIVATE_MARKER_731'));
  for(const format of ['json','md']) {
    const result=await mcp.call('relay_export',{pack,format});
    assert.ok(!result.isError,JSON.stringify(result));
    const exported=result.structuredContent;
    assert.equal(exported.verified,true);
    assert.equal(path.dirname(exported.path),runtimePath('exports'));
    const reread=await mcp.call('relay_import',{text:fs.readFileSync(exported.path,'utf8')});
    assert.deepEqual(reread.structuredContent.pack,preview.structuredContent.pack);
    assert.equal(exported.prompt,preview.structuredContent.prompt);
  }
  const rejected=await mcp.call('relay_pack',{history,selections:[{localId:history.messages[0].localId,start:-1,end:3}]});
  assert.equal(rejected.isError,true);
  assert.equal(JSON.parse(rejected.content[0].text).error.code,'INVALID_RANGE');
  const recovered=await mcp.call('relay_check_sources',{pack,history});
  assert.ok(recovered.structuredContent.sources.every(x=>x.status==='unchanged'));
  const capabilities=await mcp.call('relay_capabilities');
  assert.equal(capabilities.structuredContent.nativeMessageSelection,false);
  assert.equal(capabilities.structuredContent.nativeComposerChips,false);
});

test('real MCP subprocess rejects malformed JSON-RPC and remains usable after errors',async t=>{
  const mcp=startMcp(t);
  const early=await mcp.request('tools/list');
  assert.equal(early.error.code,-32002);
  assert.equal((await mcp.raw('not-json',null)).error.code,-32700);
  for(const raw of ['null','[]','42','{"jsonrpc":"2.0","id":{},"method":"ping"}']) {
    const invalid=await mcp.raw(raw,null);
    assert.equal(invalid.error.code,-32600);
  }
  await mcp.request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'invalid-input-test',version:'1'}});
  const params=await mcp.request('ping',null);
  assert.equal(params.error.code,-32602);
  assert.deepEqual((await mcp.request('ping')).result,{});
  const noTool=await mcp.request('tools/call',{name:'missing-tool',arguments:{}});
  assert.equal(noTool.error.code,-32602);
  const missingArg=await mcp.call('relay_import',{});
  assert.equal(missingArg.isError,true);
  assert.ok((await mcp.request('tools/list')).result.tools.length>=10);
});
