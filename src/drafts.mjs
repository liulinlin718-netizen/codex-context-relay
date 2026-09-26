import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {checkedPath, runtimePath} from './paths.mjs';
import {validatePack} from './core.mjs';
import {createSnapshotStore, snapshotHash} from './history-store.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const format = 'context-relay-storage/v2';
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const revision = text => text === null ? null : snapshotHash(text);
const questionText = value => { if (typeof value !== 'string' || value.length > 100000) fail('INVALID_QUESTION', '问题必须是长度不超过 100000 的文本。'); return value; };

// Large bodies are immutable objects; small manifests and revision snapshots
// preserve the existing conflict-as-independent-copy contract.
export function createDraftRepository(root = runtimePath('app-state')) {
  root = checkedPath(root);
  const snapshots = createSnapshotStore(path.join(root, 'objects'));
  function filename(id = 'main') {
    if (id !== 'main' && (typeof id !== 'string' || !uuid.test(id))) fail('INVALID_DRAFT_ID', '草稿编号无效。');
    return checkedPath(path.join(root, id === 'main' ? 'draft.json' : `draft-${id}.json`));
  }
  function raw(id) { const file = filename(id); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; }
  function parse(text) {
    let data;
    try { data = JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch { fail('DRAFT_UNREADABLE', '草稿文件损坏，原文件未改动。可下载原始文件备份，再打开其他草稿。'); }
    if (!object(data) || (!Object.hasOwn(data, 'storageFormat') && !['history','pack','question'].some(key => Object.hasOwn(data, key)))) fail('DRAFT_UNREADABLE', '文件不是可读取的草稿；原文件保留，可先下载备份。');
    if (Object.hasOwn(data, 'storageFormat') && data.storageFormat !== format) fail('DRAFT_UNREADABLE', '草稿存储版本不受支持；原文件保留。');
    return data;
  }
  function validateHistory(history) {
    if (!object(history) || !Array.isArray(history.messages) || history.messages.some(m => !object(m) || typeof m.text !== 'string' || typeof m.role !== 'string' || typeof m.localId !== 'string')) fail('INVALID_HISTORY', '草稿历史的消息字段不完整。');
    return history;
  }
  function putHistory(history) { return {historyId:snapshots.put('histories', validateHistory(history))}; }
  function getHistory(historyId) { return validateHistory(snapshots.get('histories', historyId)); }
  function checkCounter(value, minimum = 0) {
    if (!Number.isSafeInteger(value) || value < minimum) fail('INVALID_COUNTER', 'Selection counter must be a safe integer at least as large as every existing reference number.');
    return value;
  }
  function checkOrder(order, original) {
    if (!Array.isArray(order) || order.length !== original.length || new Set(order).size !== order.length || order.some(id => typeof id !== 'string' || !original.includes(id))) fail('INVALID_EXCERPT_ORDER', '引用排序必须是现有引用 ID 的完整排列，不能新增、删除或重复。');
    return [...order];
  }
  function checkRecord(data) {
    if (!object(data) || data.storageFormat !== format || (data.historyId !== null && (typeof data.historyId !== 'string' || !hash.test(data.historyId))) || (data.pack !== null && !object(data.pack))) fail('DRAFT_UNREADABLE', '草稿索引字段损坏；原文件未修改。');
    questionText(data.question);
    if (data.pack) {
      const p = data.pack;
      if (p.schemaVersion !== '1' || typeof p.packId !== 'string' || !p.packId || typeof p.createdAt !== 'string' || typeof p.excerptsId !== 'string' || !hash.test(p.excerptsId) || typeof p.memoryId !== 'string' || !hash.test(p.memoryId) || !Array.isArray(p.excerptOrder) || !p.excerptOrder.length || p.excerptOrder.length > 200 || p.excerptOrder.some(id => typeof id !== 'string' || !id) || new Set(p.excerptOrder).size !== p.excerptOrder.length || !Number.isSafeInteger(p.maxSelectionOrder) || p.maxSelectionOrder < 1) fail('DRAFT_UNREADABLE', '草稿引用索引损坏；原文件未修改。');
      snapshots.verify('excerpts', p.excerptsId); snapshots.verify('memories', p.memoryId);
    }
    checkCounter(data.selectionCounter, data.pack?.maxSelectionOrder || 0);
    if (data.historyId) snapshots.verify('histories', data.historyId);
    return data;
  }
  function fromFull(data) {
    if (!object(data)) fail('DRAFT_UNREADABLE', '草稿内容必须是对象。');
    let historyId = data.historyId ?? null;
    if (data.history !== undefined && data.history !== null) {
      const stored = putHistory(data.history).historyId;
      if (historyId && stored !== historyId) fail('HISTORY_MISMATCH', 'historyId 与提供的历史不一致，草稿未保存。');
      historyId = stored;
    } else if (data.history === null && historyId) fail('HISTORY_MISMATCH', '清空历史时不能同时指定 historyId。');
    let historyTitle = '';
    if (historyId) { const history = getHistory(historyId); historyTitle = typeof history.title === 'string' ? history.title.slice(0,100) : ''; }
    const question = questionText(data.question ?? data.pack?.question ?? '');
    let pack = null;
    if (data.pack) {
      const value = validatePack({...data.pack, question});
      const ids = value.excerpts.map(x => x.id);
      pack = {schemaVersion:value.schemaVersion, packId:value.packId, createdAt:value.createdAt, excerptsId:snapshots.put('excerpts', value.excerpts), memoryId:snapshots.put('memories', value.memory), excerptOrder:checkOrder(data.excerptOrder ?? ids, ids), maxSelectionOrder:Math.max(...value.excerpts.map(x => x.selectionOrder))};
    }
    if (!pack && data.excerptOrder !== undefined) checkOrder(data.excerptOrder, []);
    return {storageFormat:format, historyId, historyTitle, pack, question, selectionCounter:checkCounter(data.selectionCounter ?? pack?.maxSelectionOrder ?? 0, pack?.maxSelectionOrder || 0), ...(typeof data.savedAt === 'string' ? {savedAt:data.savedAt} : {})};
  }
  function recordFromText(text) { const data = parse(text); return data.storageFormat === format ? checkRecord(data) : fromFull(data); }
  function fullPack(record) {
    if (!record.pack) return null;
    const p = record.pack, original = snapshots.get('excerpts', p.excerptsId);
    if (!Array.isArray(original)) fail('DRAFT_UNREADABLE', '引用快照不是数组。');
    checkOrder(p.excerptOrder, original.map(x => x.id));
    // Display order is separate from protocol order and stable quote labels.
    return validatePack({schemaVersion:p.schemaVersion, packId:p.packId, createdAt:p.createdAt, excerpts:original, memory:snapshots.get('memories', p.memoryId), question:record.question});
  }
  function hydrated(record) {
    checkRecord(record);
    return {history:record.historyId ? getHistory(record.historyId) : null, historyId:record.historyId, pack:fullPack(record), excerptOrder:record.pack ? [...record.pack.excerptOrder] : [], question:record.question, selectionCounter:record.selectionCounter, ...(record.savedAt ? {savedAt:record.savedAt} : {})};
  }
  function load(id = 'main') {
    const text = raw(id);
    if (text === null && id !== 'main') fail('DRAFT_MISSING', '这份草稿不存在；请从草稿列表选择。');
    if (text === null) return {history:null,historyId:null,pack:null,excerptOrder:[],question:'',selectionCounter:0,draftId:id,revision:null};
    const data = parse(text);
    if (data.storageFormat === format) return {...hydrated(data), draftId:id, revision:revision(text)};
    // Read v1 without migrating or writing files. Its first successful save
    // archives the exact v1 bytes before atomically replacing the manifest.
    if (data.history) validateHistory(data.history);
    if (data.pack) validatePack(data.pack);
    const ids = (data.pack?.excerpts || []).map(x => x.id);
    return {...data, history:data.history || null, historyId:null, pack:data.pack || null, excerptOrder:checkOrder(data.excerptOrder ?? ids, ids), question:questionText(data.question ?? data.pack?.question ?? ''), selectionCounter:checkCounter(data.selectionCounter ?? Math.max(0,...(data.pack?.excerpts || []).map(x => x.selectionOrder)), Math.max(0,...(data.pack?.excerpts || []).map(x => x.selectionOrder))), draftId:id, revision:revision(text)};
  }
  function expected(value) { if (value !== null && (typeof value !== 'string' || !hash.test(value))) fail('DRAFT_VERSION_REQUIRED', '请先读取草稿版本再保存。'); }
  function commit(record, {draftId = 'main', expectedRevision} = {}) {
    filename(draftId); expected(expectedRevision); checkRecord(record);
    const lock = checkedPath(`${filename(draftId)}.lock`, {create:true});
    let fd, temp, contended = false;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; contended = true; }
    try {
      const current = raw(draftId), branched = contended || revision(current) !== expectedRevision;
      if (current !== null) {
        // A known hash never licenses replacing an unreadable current file.
        try { recordFromText(current); snapshots.putRaw('revisions', current); }
        catch (error) { if (!branched) throw error; }
      }
      const id = branched ? randomUUID() : draftId;
      const value = {...record, savedAt:new Date().toISOString()}, text = JSON.stringify(value);
      const nextRevision = snapshots.putRaw('revisions', text), target = filename(id);
      temp = checkedPath(`${target}.${randomUUID()}.tmp`);
      const writer = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(writer, text, 'utf8'); fs.fsyncSync(writer); } finally { fs.closeSync(writer); }
      fs.renameSync(temp, target); temp = undefined;
      return {saved:true, draftId:id, revision:nextRevision, branched, historyId:value.historyId};
    } finally {
      if (temp && fs.existsSync(checkedPath(temp))) fs.unlinkSync(temp);
      if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(checkedPath(lock)); }
    }
  }
  function save(data, options = {}) { filename(options.draftId); expected(options.expectedRevision); return commit(fromFull(data), options); }
  function patch(changes, {draftId = 'main', expectedRevision} = {}) {
    filename(draftId); expected(expectedRevision);
    if (!object(changes) || !Object.keys(changes).length || Object.keys(changes).some(key => !['question','selectionCounter','memory','excerptOrder'].includes(key))) fail('INVALID_DRAFT_PATCH', '仅支持问题、引用计数、背景及现有引用排序的小更新。');
    const current = raw(draftId); let base;
    if (expectedRevision === null) base = fromFull({history:null,pack:null,question:''});
    else {
      let text;
      if (revision(current) === expectedRevision) text = current;
      else {
        try { text = snapshots.readRaw('revisions', expectedRevision); }
        catch (error) { if (error.code === 'SNAPSHOT_MISSING') fail('DRAFT_BASE_MISSING', '原草稿版本快照不存在，未混入其他窗口内容。请保留当前修改并从完整备份恢复。'); throw error; }
      }
      base = recordFromText(text);
    }
    const record = {...base, pack:base.pack ? {...base.pack} : null};
    if (Object.hasOwn(changes, 'question')) record.question = questionText(changes.question);
    if (Object.hasOwn(changes, 'selectionCounter')) record.selectionCounter = checkCounter(changes.selectionCounter, record.pack?.maxSelectionOrder || 0);
    if (Object.hasOwn(changes, 'excerptOrder')) {
      if (!record.pack) fail('INVALID_EXCERPT_ORDER', '没有可排序的引用。');
      record.pack.excerptOrder = checkOrder(changes.excerptOrder, record.pack.excerptOrder);
    }
    if (Object.hasOwn(changes, 'memory')) {
      if (!record.pack) fail('INVALID_DRAFT_PATCH', '没有引用包时不能保存背景。');
      const pack = validatePack({...fullPack(record), memory:changes.memory});
      record.pack.memoryId = snapshots.put('memories', pack.memory);
    }
    return commit(record, {draftId, expectedRevision});
  }
  function list() {
    if (!fs.existsSync(root)) return [];
    const ids = fs.readdirSync(root).flatMap(name => name === 'draft.json' ? ['main'] : name.startsWith('draft-') && name.endsWith('.json') && uuid.test(name.slice(6,-5)) ? [name.slice(6,-5)] : []);
    return ids.map(id => {
      try {
        const data = parse(raw(id));
        if (data.storageFormat === format) { checkRecord(data); return {draftId:id, savedAt:data.savedAt || '', title:(data.question || data.historyTitle || '未命名草稿').slice(0,100), excerpts:data.pack?.excerptOrder.length || 0}; }
        return {draftId:id, savedAt:data.savedAt || '', title:(data.question || data.history?.title || '未命名草稿').slice(0,100), excerpts:data.pack?.excerpts?.length || 0};
      } catch { return {draftId:id, title:'无法读取的草稿', unreadable:true, savedAt:''}; }
    }).sort((a,b) => b.savedAt.localeCompare(a.savedAt));
  }
  function download(id = 'main') {
    let content = raw(id);
    if (content === null) fail('DRAFT_MISSING', '这份草稿不存在。');
    let data;
    try { data = parse(content); } catch { return {filename:`relay-draft-${id}.json`, content}; }
    // A v2 backup must be self-contained; never label unresolved references as complete.
    if (data.storageFormat === format) data = hydrated(checkRecord(data));
    const {historyId, ...complete} = data;
    content = JSON.stringify({...complete, draftFormat:'context-relay-draft/v1'}, null, 2) + '\n';
    return {filename:`relay-draft-${id}.json`, content};
  }
  return {load, save, patch, list, download, putHistory, getHistory};
}
