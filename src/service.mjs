import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {importHistory,createPack,validatePack,toMarkdown,fromMarkdown,renderPrompt,checkSources} from './core.mjs';
import {ROOT,runtimePath,writeText,readJSON,storageReport} from './paths.mjs';
import {createDraftRepository} from './drafts.mjs';

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
  if (data.excerptOrder!==undefined) {
    const ids=(data.pack?.excerpts||[]).map(x=>x.id),order=data.excerptOrder;
    if(!Array.isArray(order)||order.length!==ids.length||new Set(order).size!==order.length||order.some(id=>typeof id!=='string'||!ids.includes(id)))error('INVALID_EXCERPT_ORDER','展示顺序必须是现有引用 ID 的完整唯一排列。');
  }
  return draftWithCounter({...('historyId' in data?{historyId:data.historyId}:{}),...('history' in data?{history:data.history||null}:{}),...('excerptOrder' in data?{excerptOrder:data.excerptOrder}:{}),pack:data.pack||null,question:data.question??data.pack?.question??'',selectionCounter:data.selectionCounter});
}
function importMaterial(data) {
  if (typeof data.text !== 'string') error('INVALID_INPUT','需要完整文件内容。');
  const text=data.text.replace(/^\uFEFF/,'');
  let parsed,parsedJSON=false;try {parsed=JSON.parse(text);parsedJSON=true;} catch {}
  if(parsedJSON){
    if(parsed?.draftFormat==='context-relay-draft/v1')return {draft:normalizedDraft(parsed)};
    if(parsed?.schemaVersion)return {pack:validatePack(parsed)};
    return {history:importHistory(text,{sourceUri:data.sourceUri||null})};
  }
  // JSONL contents are data even when a message quotes the Markdown marker.
  // Only a line-level Markdown envelope selects the Markdown decoder.
  if(/^<!-- context-pack:v1 canonical-data -->\s*$/m.test(text))return {pack:fromMarkdown(text)};
  return {history:importHistory(text,{sourceUri:data.sourceUri||null})};
}
export function createDispatcher({drafts=createDraftRepository(),bridgeProvider=getBridge}={}) {
const referencedHistory=data=>data.historyId?drafts.getHistory(data.historyId):data.history;
const storedHistory=history=>({history,...drafts.putHistory(history)});
async function dispatcher(action, data={}, {signal}={}) {
  switch(action) {
    case 'capabilities': return {mode:'export-only',nativeMessageSelection:false,nativeComposerChips:false,selector:'companion-local',storage:storageReport(),configuredBridge:loadConfig().bridge?.mode || 'export-only',modelProvider:loadConfig().model?.provider || null};
    case 'demo': return {...storedHistory(importHistory(fs.readFileSync(path.join(ROOT,'examples/demo-history.json'),'utf8'),{sourceUri:'fixture:examples/demo-history.json'})),fixture:true};
    case 'import': return importMaterial(data);
    case 'history-import': {
      const imported=importMaterial(data);
      if(imported.history)return storedHistory(imported.history);
      if(imported.draft?.history)imported.draft.historyId=drafts.putHistory(imported.draft.history).historyId;
      return imported;
    }
    case 'history-store': {normalizedDraft({history:data.history});return drafts.putHistory(data.history);}
    case 'draft-validate': return {draft:normalizedDraft(data)};
    case 'import-open':
    case 'thread-open': {
      const imported=action==='import-open'?importMaterial(data):await dispatcher('thread-read',data,{signal});
      const draft=normalizedDraft(imported.draft||{history:imported.history||null,pack:imported.pack||null});
      const saved=drafts.save(draft,{draftId:randomUUID(),expectedRevision:null});
      return {...saved,selectorPath:`/?draft=${saved.draftId}`};
    }
    case 'pack': return {pack:createPack(referencedHistory(data),data.selections,{question:data.question || '',memory:data.memory || []})};
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
    case 'draft-load': { const draft=drafts.load(data.draftId);return {...normalizedDraft(draft),history:draft.history||null,draftId:draft.draftId,revision:draft.revision}; }
    case 'draft-list': return {drafts:drafts.list()};
    case 'draft-new': return drafts.save({history:null,pack:null,question:'',selectionCounter:0},{draftId:randomUUID(),expectedRevision:null});
    case 'draft-download': return drafts.download(data.draftId);
    case 'draft-save': {
      const draft=normalizedDraft(data);
      return drafts.save(draft,{draftId:data.draftId,expectedRevision:data.expectedRevision});
    }
    case 'draft-patch': return drafts.patch(data.changes,{draftId:data.draftId,expectedRevision:data.expectedRevision});
    case 'sources': return {sources:checkSources(data.pack,referencedHistory(data))};
    case 'bridge-probe': return (await bridgeProvider()).probe({threadId:data.threadId});
    case 'threads': return (await bridgeProvider()).list({limit:100,cursor:data.cursor||null});
    case 'history-thread-read': {const result=await dispatcher('thread-read',data,{signal});return {...result,...storedHistory(result.history)};}
    case 'thread-read': {
      const bridge=await bridgeProvider();
      const thread=await bridge.read(data.threadId);
      return {history:importHistory(thread,{sourceUri:`app-server:${data.threadId}`}),connection:bridge.capabilities()};
    }
    case 'prepare': return (await bridgeProvider()).prepare({pack:sharingPack(data.pack),targetThreadId:data.targetThreadId});
    case 'send': return (await bridgeProvider()).send(data.receiptId);
    case 'reconcile': return (await bridgeProvider()).reconcile(data.receiptId);
    case 'receipt-lock-diagnose': return (await bridgeProvider()).diagnoseReceiptLock(data.receiptId);
    case 'receipt-lock-recover': return (await bridgeProvider()).recoverReceiptLock(data.receiptId,{expectedLockToken:data.expectedLockToken,confirm:data.confirm});
    case 'receipts': return (await bridgeProvider()).receipts();
    case 'model': {
      const {generate}=await import('./models.mjs');
      return generate({pack:sharingPack(data.pack),operation:data.operation||'answer',signal,timeoutMs:loadConfig().model?.timeoutMs||120000},loadConfig().model || {});
    }
    default: error('UNKNOWN_ACTION',`Unknown action: ${action}`);
  }
}
return dispatcher;
}
export const dispatch=createDispatcher();
