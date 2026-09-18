import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {importHistory,createPack,validatePack,toMarkdown,fromMarkdown,renderPrompt,checkSources} from './core.mjs';
import {ROOT,runtimePath,writeText,readJSON,storageReport} from './paths.mjs';
import {createDraftRepository} from './drafts.mjs';

const drafts = createDraftRepository();
const configPath = runtimePath('app-config','relay.json');
export function loadConfig() { return fs.existsSync(configPath) ? readJSON(configPath) : {}; }
export function sharingPack(pack) { validatePack(pack); return validatePack({...pack,memory:pack.memory.filter(m=>m.included)}); }
let bridgePromise;
export async function getBridge() { return bridgePromise ??= import('./integrations.mjs').then(({createBridge})=>createBridge(loadConfig().bridge || {mode:'export-only'})); }
export async function closeBridge() { if (bridgePromise) await (await bridgePromise).close(); }
function error(code,message) { throw Object.assign(new Error(message),{code}); }
function draftWithCounter(draft) {
  const minimum=Math.max(0,...(draft.pack?.excerpts||[]).map(x=>x.selectionOrder));
  const selectionCounter=draft.selectionCounter ?? minimum;
  if(!Number.isSafeInteger(selectionCounter)||selectionCounter<minimum)error('INVALID_COUNTER','Selection counter must be a safe integer at least as large as every existing reference number.');
  return {...draft,selectionCounter};
}
function normalizedDraft(data) {
  if (data.pack) validatePack(data.pack);
  if (data.history && (!Array.isArray(data.history.messages)||data.history.messages.some(m=>!m||typeof m.text!=='string'||typeof m.role!=='string'||typeof m.localId!=='string'))) error('INVALID_HISTORY','草稿历史的消息字段不完整。');
  if (data.question!==undefined && typeof data.question!=='string') error('INVALID_QUESTION','Draft question must be text.');
  return draftWithCounter({history:data.history||null,pack:data.pack||null,question:data.question??data.pack?.question??'',selectionCounter:data.selectionCounter});
}
export async function dispatch(action, data={}, {signal}={}) {
  switch(action) {
    case 'capabilities': return {mode:'export-only',nativeMessageSelection:false,nativeComposerChips:false,selector:'companion-local',storage:storageReport(),configuredBridge:loadConfig().bridge?.mode || 'export-only',modelProvider:loadConfig().model?.provider || null};
    case 'demo': return {history:importHistory(fs.readFileSync(path.join(ROOT,'examples/demo-history.json'),'utf8'),{sourceUri:'fixture:examples/demo-history.json'}),fixture:true};
    case 'import': {
      if (typeof data.text !== 'string') error('INVALID_INPUT','需要完整文件内容。');
      const text=data.text.replace(/^\uFEFF/,'');
      if (text.includes('<!-- context-pack:v1 canonical-data -->')) return {pack:fromMarkdown(text)};
      let parsed;try {parsed=JSON.parse(text)} catch {}
      if (parsed?.draftFormat==='context-relay-draft/v1') return {draft:normalizedDraft(parsed)};
      if (parsed?.schemaVersion) return {pack:validatePack(parsed)};
      return {history:importHistory(text,{sourceUri:data.sourceUri || null})};
    }
    case 'pack': return {pack:createPack(data.history,data.selections,{question:data.question || '',memory:data.memory || []})};
    case 'preview': { const pack=sharingPack(data.pack);return {pack,prompt:renderPrompt(pack)}; }
    case 'export': {
      const pack=sharingPack(data.pack);
      if (!['json','md'].includes(data.format)) error('INVALID_FORMAT','请选择 json 或 md。');
      // Imported pack IDs are data, never path components.
      const basename=`context-pack-${randomUUID()}.${data.format}`;
      const filename=runtimePath('exports',basename);
      const text=data.format==='json'?JSON.stringify(pack,null,2)+'\n':toMarkdown(pack);
      writeText(filename,text);
      // Read the actual artifact back before acknowledging an export.
      const roundtrip=data.format==='json'?validatePack(readJSON(filename)):fromMarkdown(fs.readFileSync(filename,'utf8'));
      if (JSON.stringify(roundtrip)!==JSON.stringify(pack)) error('EXPORT_VERIFICATION','导出回读不一致。');
      return {path:filename,format:data.format,verified:true,packId:pack.packId,bytes:Buffer.byteLength(text),prompt:renderPrompt(pack),...(data.download===true?{filename:basename,content:text}:{})};
    }
    case 'draft-load': { const draft=drafts.load(data.draftId);return {...normalizedDraft(draft),draftId:draft.draftId,revision:draft.revision}; }
    case 'draft-list': return {drafts:drafts.list()};
    case 'draft-new': return drafts.save({history:null,pack:null,question:'',selectionCounter:0},{draftId:randomUUID(),expectedRevision:null});
    case 'draft-download': return drafts.download(data.draftId);
    case 'draft-save': {
      const draft=normalizedDraft(data);
      return drafts.save(draft,{draftId:data.draftId,expectedRevision:data.expectedRevision});
    }
    case 'sources': return {sources:checkSources(data.pack,data.history)};
    case 'bridge-probe': return (await getBridge()).probe({threadId:data.threadId});
    case 'threads': return (await getBridge()).list({limit:100,cursor:data.cursor||null});
    case 'thread-read': {
      const bridge=await getBridge();
      const thread=await bridge.read(data.threadId);
      return {history:importHistory(thread,{sourceUri:`app-server:${data.threadId}`}),connection:bridge.capabilities()};
    }
    case 'prepare': return (await getBridge()).prepare({pack:sharingPack(data.pack),targetThreadId:data.targetThreadId});
    case 'send': return (await getBridge()).send(data.receiptId);
    case 'reconcile': return (await getBridge()).reconcile(data.receiptId);
    case 'receipts': return (await getBridge()).receipts();
    case 'model': {
      const {generate}=await import('./models.mjs');
      return generate({pack:sharingPack(data.pack),operation:data.operation||'answer',signal,timeoutMs:loadConfig().model?.timeoutMs||120000},loadConfig().model || {});
    }
    default: error('UNKNOWN_ACTION',`Unknown action: ${action}`);
  }
}
