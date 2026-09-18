import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {checkedPath, runtimePath, writeText} from './paths.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
const revision = text => text === null ? null : createHash('sha256').update(text).digest('hex');

// On contention, create a new draft instead of waiting or removing another
// writer's lock. A crashed writer cannot block future edits or erase a copy.
export function createDraftRepository(root = runtimePath('app-state')) {
  function filename(id = 'main') {
    if (id !== 'main' && !uuid.test(id)) fail('INVALID_DRAFT_ID', '草稿编号无效。');
    return checkedPath(path.join(root, id === 'main' ? 'draft.json' : `draft-${id}.json`));
  }
  function raw(id) {
    const file = filename(id);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }
  function load(id = 'main') {
    const text = raw(id);
    if (text === null && id !== 'main') fail('DRAFT_MISSING', '这份草稿不存在；请从草稿列表选择。');
    let data;
    try { data = text === null ? {history:null,pack:null,question:''} : JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch { fail('DRAFT_UNREADABLE', '草稿文件损坏，原文件未改动。可下载原始文件备份，再打开其他草稿。'); }
    if(!data||typeof data!=='object'||Array.isArray(data)||!['history','pack','question'].some(key=>Object.hasOwn(data,key)))fail('DRAFT_UNREADABLE','文件不是可读取的草稿；原文件保留，可先下载备份。');
    return {...data, draftId:id, revision:revision(text)};
  }
  function save(data, {draftId = 'main', expectedRevision} = {}) {
    filename(draftId);
    if (expectedRevision !== null && !/^[a-f0-9]{64}$/.test(expectedRevision || '')) fail('DRAFT_VERSION_REQUIRED', '请先读取草稿版本再保存。');
    let lock=checkedPath(`${filename(draftId)}.lock`,{create:true}),fd,contended=false;
    try { fd=fs.openSync(lock,'wx'); }
    catch(error){if(error.code!=='EEXIST')throw error;contended=true;}
    let temp;
    try {
      const branched=contended || revision(raw(draftId))!==expectedRevision;
      const id=branched?randomUUID():draftId;
      const target=filename(id);
      const text=JSON.stringify({...data,savedAt:new Date().toISOString()});
      temp=checkedPath(`${target}.${randomUUID()}.tmp`);
      writeText(temp,text);fs.renameSync(temp,target);
      return {saved:true,draftId:id,revision:revision(text),branched};
    } finally {
      if(temp && fs.existsSync(temp))fs.unlinkSync(temp);
      if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}
    }
  }
  function list() {
    if (!fs.existsSync(root)) return [];
    const ids = fs.readdirSync(root).flatMap(name => name === 'draft.json' ? ['main'] : uuid.test(name.slice(6, -5)) && name.startsWith('draft-') && name.endsWith('.json') ? [name.slice(6, -5)] : []);
    return ids.map(id => {
      try {
        const draft = load(id);
        return {draftId:id, savedAt:draft.savedAt || '', title:(draft.question || draft.history?.title || '未命名草稿').slice(0,100), excerpts:draft.pack?.excerpts?.length || 0};
      } catch { return {draftId:id, title:'无法读取的草稿', unreadable:true, savedAt:''}; }
    }).sort((a,b) => b.savedAt.localeCompare(a.savedAt));
  }
  return {load, save, list, download(id = 'main') {
    let content = raw(id);
    if (content === null) fail('DRAFT_MISSING', '这份草稿不存在。');
    try {
      const data=JSON.parse(content.replace(/^\uFEFF/,''));
      if(data && typeof data==='object' && !Array.isArray(data))content=JSON.stringify({...data,draftFormat:'context-relay-draft/v1'},null,2)+'\n';
    } catch { /* A damaged file is backed up byte-for-byte. */ }
    return {filename:`relay-draft-${id}.json`, content};
  }};
}
