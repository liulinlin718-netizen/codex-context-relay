import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {importHistory,createPack,validatePack,renderPrompt,checkSources,fromMarkdown} from '../src/core.mjs';
import {dispatch} from '../src/service.mjs';
import {createBridge} from '../src/integrations.mjs';
import {ROOT,runtimePath,writeText} from '../src/paths.mjs';

const history=importHistory(fs.readFileSync(path.join(ROOT,'examples/demo-history.json'),'utf8'),{sourceUri:'fixture:examples/demo-history.json'});
const [user,assistant]=history.messages;
function select(message,text){const start=message.text.indexOf(text);assert.ok(start>=0);return {localId:message.localId,start,end:start+text.length};}
const pack=createPack(history,[select(user,'预算上限是每月 300 元。'),select(assistant,'建议使用每月 499 元的托管检索服务，并开启整段历史自动同步。'),select(user,'先做本地离线导出，不接入自动云同步。')],{question:'引用 2 是否违反引用 1 和引用 3？请保留引用编号逐条说明。'});
pack.memory=[{id:'memory-budget',kind:'constraint',text:'每月预算不超过 300 元。',sourceExcerptIds:[pack.excerpts[0].id],status:'user-confirmed',version:1,included:true},{id:'memory-local',kind:'decision',text:'第一版先用本地离线导出。',sourceExcerptIds:[pack.excerpts[2].id],status:'user-confirmed',version:1,included:true},{id:'memory-omitted',kind:'background',text:'UNCHECKED_BACKGROUND_MUST_NOT_TRAVEL',sourceExcerptIds:[pack.excerpts[0].id],status:'user-confirmed',version:1,included:false}];
validatePack(pack);
const json=await dispatch('export',{pack,format:'json'});const md=await dispatch('export',{pack,format:'md'});
const received=JSON.parse(fs.readFileSync(json.path,'utf8'));assert.deepEqual(received,fromMarkdown(fs.readFileSync(md.path,'utf8')));
const prompt=renderPrompt(received);assert.ok(!prompt.includes('UNSELECTED_PRIVATE_MARKER'));assert.ok(!prompt.includes('UNCHECKED_BACKGROUND'));assert.equal(received.excerpts.length,3);assert.equal(received.memory.length,2);
writeText(runtimePath('demo','receiver-prompt.md'),prompt);writeText(runtimePath('demo','context-pack.json'),JSON.stringify(received,null,2));writeText(runtimePath('demo','context-pack.md'),fs.readFileSync(md.path,'utf8'));
const changed=structuredClone(history);changed.messages[0].text+='（原消息后来发生变化）';
const bridge=createBridge({mode:'export-only',receiptDir:runtimePath('demo','receipts')});
const prepared=await bridge.prepare({pack:received,targetThreadId:'demo-target-not-connected'});
const failed=await bridge.send(prepared.id);assert.equal(failed.status,'failed');assert.deepEqual(pack.excerpts.map(x=>x.exactText),received.excerpts.map(x=>x.exactText));
await bridge.close();
const report={recordedAt:new Date().toISOString(),evidence:'offline-fixture; deterministic live execution; no model or host delivery',normal:{excerpts:3,roles:received.excerpts.map(x=>x.role),confirmedBackgrounds:2,roundtrip:true,unselectedMaterialExcluded:true},sourceChanged:checkSources(pack,changed),sourceRestored:checkSources(pack,history),delivery:{status:failed.status,attempted:failed.deliveryAttempted,target:failed.targetThreadId,receiptId:failed.id},recovery:{draftPreserved:true,json:json.path,markdown:md.path,prompt:runtimePath('demo','receiver-prompt.md')}};
writeText(runtimePath('demo','report.json'),JSON.stringify(report,null,2));process.stdout.write(JSON.stringify(report,null,2)+'\n');
