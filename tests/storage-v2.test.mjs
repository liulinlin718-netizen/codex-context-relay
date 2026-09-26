import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createDraftRepository} from '../src/drafts.mjs';
import {importHistory, createPack, validatePack} from '../src/core.mjs';
import {ROOT, checkedPath, runtimePath, writeText, childEnv} from '../src/paths.mjs';

function fixture(t, name = 'case') {
  const root = checkedPath(runtimePath('tests', `storage-v2-${name}-${randomUUID()}`));
  t.after(() => { if (fs.existsSync(checkedPath(root))) fs.rmSync(root, {recursive:true}); });
  return {root, repo:createDraftRepository(root)};
}
function data(count = 2, size = 100, selected = count) {
  const history = importHistory({title:'Storage contract fixture', messages:Array.from({length:count}, (_, index) => ({id:`fixture-${index}`, role:index % 2 ? 'assistant' : 'user', text:`${index}:` + 'x'.repeat(size)}))}, {sourceUri:'fixture://storage-v2'});
  const pack = createPack(history, history.messages.slice(0,selected).map(m => ({localId:m.localId})), {question:'Original fixture question'});
  pack.memory = [{id:'memory-fixture',kind:'background',text:'Unconfirmed fixture context',sourceExcerptIds:[pack.excerpts[0].id],status:'model-proposed',version:1,included:false}];
  return {history, pack, question:pack.question, selectionCounter:selected};
}
function monitorWrites(t) {
  const paths = new Map(), writes = [], renames = [];
  const open = fs.openSync.bind(fs), write = fs.writeFileSync.bind(fs), rename = fs.renameSync.bind(fs);
  t.mock.method(fs, 'openSync', (file, ...args) => { const fd = open(file, ...args); paths.set(fd, String(file)); return fd; });
  t.mock.method(fs, 'writeFileSync', (target, content, ...args) => { const result = write(target, content, ...args); writes.push({path:typeof target === 'number' ? paths.get(target) : String(target), bytes:Buffer.byteLength(content)}); return result; });
  t.mock.method(fs, 'renameSync', (from, to) => { const result = rename(from, to); renames.push({from:String(from), to:String(to)}); return result; });
  return {writes, renames};
}
function manifest(root, id = 'main') { return JSON.parse(fs.readFileSync(path.join(root, id === 'main' ? 'draft.json' : `draft-${id}.json`), 'utf8')); }

test('v2 real disk writes: immutable history/excerpts are written once; twenty question patches only write small manifests', t => {
  const {root, repo} = fixture(t, 'io'), input = data(1000, 444, 2), io = monitorWrites(t);
  let saved = repo.save(input, {expectedRevision:null});
  const historyWrites = io.writes.filter(x => x.path.includes(`${path.sep}histories${path.sep}`));
  const excerptWrites = io.writes.filter(x => x.path.includes(`${path.sep}excerpts${path.sep}`));
  assert.equal(historyWrites.length, 1); assert.equal(excerptWrites.length, 1);
  const same = repo.putHistory(input.history); assert.equal(same.historyId, saved.historyId);
  const start = io.writes.length, renameStart = io.renames.length;
  for (let i = 0; i < 20; i++) saved = repo.patch({question:`Question edit ${i}`}, {expectedRevision:saved.revision});
  const updates = io.writes.slice(start);
  assert.equal(updates.length, 40, 'Each patch writes one revision snapshot and one atomic current manifest.');
  assert.equal(io.renames.length - renameStart, 40);
  assert.ok(updates.every(x => !/[\\/](histories|excerpts|memories)[\\/]/.test(x.path)));
  assert.ok(updates.every(x => x.bytes < 16000));
  assert.equal(repo.load().question, 'Question edit 19');
  const disk = manifest(root);
  assert.equal(disk.storageFormat, 'context-relay-storage/v2'); assert.equal(Object.hasOwn(disk, 'history'), false);
  assert.equal(Object.hasOwn(disk.pack, 'excerpts'), false); assert.equal(Object.hasOwn(disk.pack, 'memory'), false);
  const report = {evidence:'real-project-local-filesystem-fixture',messageCount:input.history.messages.length,questionUpdates:20,historyWrites:historyWrites.length,historyBytes:historyWrites[0].bytes,excerptWrites:excerptWrites.length,excerptBytes:excerptWrites[0].bytes,patchWriteCount:updates.length,patchWrittenBytes:updates.reduce((sum,x)=>sum+x.bytes,0),largestManifestBytes:Math.max(...updates.map(x=>x.bytes)),atomicRenames:40};
  t.mock.restoreAll();
  writeText(runtimePath('validation', 'storage-v2-io-latest.json'), JSON.stringify(report, null, 2)+'\n');
});

test('history ID reloads after restart; display order and memory patches preserve protocol labels and exact bodies', t => {
  const {root, repo} = fixture(t), input = data();
  const {historyId} = repo.putHistory(input.history);
  let saved = repo.save({historyId,pack:input.pack,question:input.question}, {expectedRevision:null});
  const before = manifest(root), order = input.pack.excerpts.map(x=>x.id).reverse();
  const memory = [{...input.pack.memory[0],text:'User confirmed revision',status:'user-confirmed',included:true,version:2}];
  saved = repo.patch({question:'Changed question',memory,excerptOrder:order,selectionCounter:8}, {expectedRevision:saved.revision});
  const restarted = createDraftRepository(root), restored = restarted.load();
  assert.deepEqual(restarted.getHistory(historyId), input.history);
  assert.deepEqual(restored.excerptOrder, order);
  assert.deepEqual(restored.pack.excerpts, input.pack.excerpts); validatePack(restored.pack);
  assert.deepEqual(restored.pack.memory, memory); assert.equal(restored.pack.question, 'Changed question');
  assert.equal(restored.selectionCounter, 8);
  assert.equal(manifest(root).pack.excerptsId, before.pack.excerptsId);
  assert.equal(manifest(root).historyId, before.historyId);
});

test('stale patches branch from their exact base without mixing another window question, memory or order', t => {
  const {repo} = fixture(t), input = data();
  const initial = repo.save(input, {expectedRevision:null});
  const order = input.pack.excerpts.map(x=>x.id).reverse();
  const changedMemory = [{...input.pack.memory[0],text:'Window A only'}];
  const a = repo.patch({question:'Window A',memory:changedMemory,excerptOrder:order}, {expectedRevision:initial.revision});
  const b = repo.patch({question:'Window B'}, {expectedRevision:initial.revision});
  assert.equal(a.branched, false); assert.equal(b.branched, true); assert.notEqual(a.draftId, b.draftId);
  assert.equal(repo.load().question, 'Window A'); assert.deepEqual(repo.load().pack.memory, changedMemory);
  const isolated = repo.load(b.draftId);
  assert.equal(isolated.question, 'Window B'); assert.deepEqual(isolated.pack.memory, input.pack.memory);
  assert.deepEqual(isolated.excerptOrder, input.pack.excerpts.map(x=>x.id));
});

test('legacy read is write-free; successful migration archives original bytes and stale legacy patch remains recoverable', t => {
  const {root, repo} = fixture(t), input = data();
  const bytes = '\uFEFF'+JSON.stringify({...input,draftFormat:'context-relay-draft/v1'},null,2);
  const file = path.join(root,'draft.json'); writeText(file, bytes);
  const old = repo.load(); assert.equal(old.historyId, null); assert.equal(fs.existsSync(path.join(root,'objects')), false);
  const saved = repo.save({...old,question:'Migrated'}, {expectedRevision:old.revision});
  assert.match(saved.historyId, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(path.join(root,'objects','revisions',`${old.revision}.json`),'utf8'), bytes);
  const recovered = repo.patch({question:'Other old window'}, {expectedRevision:old.revision});
  assert.equal(recovered.branched, true); assert.equal(repo.load().question, 'Migrated');
  assert.equal(repo.load(recovered.draftId).question, 'Other old window');
});

test('failed migration never replaces legacy bytes and can retry after the storage failure is corrected', t => {
  const {root, repo} = fixture(t), input = data();
  const file = path.join(root,'draft.json'), original = JSON.stringify(input); writeText(file, original);
  const before = repo.load(); const actualRename = fs.renameSync.bind(fs);
  const trap = t.mock.method(fs,'renameSync',(from,to)=>{if(String(to)===file)throw Object.assign(new Error('fixture disk failure'),{code:'ENOSPC'});return actualRename(from,to);});
  assert.throws(()=>repo.save({...before,question:'attempted'},{expectedRevision:before.revision}),{code:'ENOSPC'});
  assert.equal(fs.readFileSync(file,'utf8'),original); assert.equal(fs.existsSync(file+'.lock'),false);
  trap.mock.restore();
  const retry = repo.save({...before,question:'recovered'},{expectedRevision:before.revision});
  assert.equal(retry.branched,false); assert.equal(repo.load().question,'recovered');
});

test('missing/corrupt snapshots, invalid patches and unknown bases preserve the existing manifest', t => {
  const {root, repo} = fixture(t), input = data(); const saved = repo.save(input,{expectedRevision:null});
  const file = path.join(root,'draft.json'), original = fs.readFileSync(file,'utf8');
  for (const changes of [{historyId:'x'}, {question:null}, {selectionCounter:0}, {excerptOrder:[]}, {excerptOrder:[input.pack.excerpts[0].id,input.pack.excerpts[0].id]}, {memory:[{...input.pack.memory[0],sourceExcerptIds:['unknown']}]}]) {
    assert.throws(()=>repo.patch(changes,{expectedRevision:saved.revision})); assert.equal(fs.readFileSync(file,'utf8'),original);
  }
  assert.throws(()=>repo.patch({question:'missing base'},{expectedRevision:'f'.repeat(64)}),{code:'DRAFT_BASE_MISSING'});
  const record = manifest(root), snapshot = path.join(root,'objects','histories',record.historyId+'.json');
  const historyBytes = fs.readFileSync(snapshot); fs.writeFileSync(snapshot,'corrupt fixture object');
  assert.throws(()=>repo.patch({question:'not persisted'},{expectedRevision:saved.revision}),{code:'SNAPSHOT_CORRUPT'});
  assert.throws(()=>repo.putHistory(input.history),{code:'SNAPSHOT_CORRUPT'});
  assert.equal(fs.readFileSync(file,'utf8'),original); assert.equal(fs.readFileSync(snapshot,'utf8'),'corrupt fixture object');
  fs.writeFileSync(snapshot,historyBytes); fs.unlinkSync(checkedPath(snapshot));
  assert.throws(()=>repo.load(),{code:'SNAPSHOT_MISSING'});
  assert.equal(fs.readFileSync(file,'utf8'),original);
  for (const id of ['../outside','',null,'x'.repeat(64),[saved.historyId]]) assert.throws(()=>repo.getHistory(id),{code:'INVALID_SNAPSHOT_ID'});
  assert.throws(()=>repo.patch({question:'array revision'},{expectedRevision:[saved.revision]}),{code:'DRAFT_VERSION_REQUIRED'});
});

test('a large self-contained backup restores to another repository with no old history ID dependency', t => {
  const first = fixture(t,'large'), second = fixture(t,'restored'), input = data(15,899990);
  let saved = first.repo.save(input,{expectedRevision:null});
  const order = input.pack.excerpts.map(x=>x.id).reverse();
  saved = first.repo.patch({question:'Large backup recovery',excerptOrder:order},{expectedRevision:saved.revision});
  const backup = JSON.parse(first.repo.download().content);
  assert.ok(Buffer.byteLength(JSON.stringify(backup)) > 24*1024*1024);
  assert.equal(backup.draftFormat,'context-relay-draft/v1'); assert.equal(Object.hasOwn(backup,'historyId'),false);
  const restored = second.repo.save(backup,{expectedRevision:null});
  const result = second.repo.load(restored.draftId);
  assert.deepEqual(result.history,input.history); assert.deepEqual(result.pack.excerpts,input.pack.excerpts);
  assert.deepEqual(result.pack.memory,input.pack.memory); assert.deepEqual(result.excerptOrder,order);
  assert.equal(result.question,'Large backup recovery');
  assert.ok(fs.statSync(path.join(first.root,'draft.json')).size < 8192);
});

test('real concurrent processes keep both edits from the same revision', async t => {
  const {root, repo} = fixture(t,'process-cas'), input = data();
  const saved = repo.save(input,{expectedRevision:null});
  const moduleURL = new URL('../src/drafts.mjs',import.meta.url).href;
  const start = question => new Promise((resolve,reject)=>{
    const source = `import {createDraftRepository} from ${JSON.stringify(moduleURL)}; const repo=createDraftRepository(${JSON.stringify(root)});process.stdout.write(JSON.stringify(repo.patch({question:${JSON.stringify(question)}},{expectedRevision:${JSON.stringify(saved.revision)}})));`;
    const child = spawn(process.execPath,['--input-type=module','-e',source],{cwd:ROOT,env:childEnv(),windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let out='',err=''; child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);
    child.on('close',code=>code===0?resolve(JSON.parse(out)):reject(new Error(`fixture child failed: ${err}`)));
  });
  const results = await Promise.all([start('Process A'),start('Process B')]);
  assert.equal(new Set(results.map(x=>x.draftId)).size,2);
  assert.equal(results.filter(x=>x.branched).length,1);
  assert.deepEqual(new Set(results.map(x=>repo.load(x.draftId).question)),new Set(['Process A','Process B']));
});
