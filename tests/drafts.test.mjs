import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDraftRepository} from '../src/drafts.mjs';
import {runtimePath, writeText} from '../src/paths.mjs';

function fixture(t) {
  const root=runtimePath('tests',`drafts-${randomUUID()}`);
  t.after(()=>{if(fs.existsSync(root))fs.rmSync(root,{recursive:true});});
  return {root,repo:createDraftRepository(root)};
}
test('two windows that loaded the same revision keep both edits and stable copies', t=>{
  const {repo}=fixture(t), original=repo.load();
  const a=repo.save({question:'A: keep exact budget',history:null,pack:null},{expectedRevision:original.revision});
  const b=repo.save({question:'B: keep rollout date',history:null,pack:null},{expectedRevision:original.revision});
  assert.equal(a.draftId,'main');assert.equal(b.branched,true);assert.notEqual(b.draftId,'main');
  assert.equal(repo.load().question,'A: keep exact budget');
  assert.equal(repo.load(b.draftId).question,'B: keep rollout date');
  const continued=repo.save({question:'B: edited again'},{draftId:b.draftId,expectedRevision:b.revision});
  assert.equal(continued.draftId,b.draftId);assert.equal(continued.branched,false);
  assert.equal(repo.list().length,2);
  assert.equal(JSON.parse(repo.download(b.draftId).content).question,'B: edited again');
});
test('missing version, malformed ids and corrupted originals cannot silently replace files',t=>{
  const {repo,root}=fixture(t);
  assert.throws(()=>repo.save({question:'unguarded'}),{code:'DRAFT_VERSION_REQUIRED'});
  for(const id of ['../outside','draft.json','',null])assert.throws(()=>repo.load(id),{code:'INVALID_DRAFT_ID'});
  assert.throws(()=>repo.load(randomUUID()),{code:'DRAFT_MISSING'});
  const damaged='{original damaged bytes';writeText(path.join(root,'draft.json'),damaged);
  assert.throws(()=>repo.load(),{code:'DRAFT_UNREADABLE'});
  assert.equal(repo.list()[0].unreadable,true);
  assert.equal(repo.download().content,damaged);
  const recovery=repo.save({question:'new contents'},{expectedRevision:null});
  assert.equal(recovery.branched,true);
  assert.equal(repo.download().content,damaged);
});
test('legacy draft loads with a content revision and foreign edits cause branching',t=>{
  const {repo,root}=fixture(t);
  writeText(path.join(root,'draft.json'),JSON.stringify({history:null,pack:null,question:'legacy'}));
  const old=repo.load();assert.match(old.revision,/^[a-f0-9]{64}$/);
  writeText(path.join(root,'draft.json'),JSON.stringify({question:'external editor'}));
  const result=repo.save({question:'browser edit'},{expectedRevision:old.revision});
  assert.equal(result.branched,true);assert.equal(repo.load().question,'external editor');
});

test('an active or abandoned writer lock leads to a recoverable copy without touching the lock',t=>{
  const {repo,root}=fixture(t);
  const saved=repo.save({question:'original'},{expectedRevision:null});
  writeText(path.join(root,'draft.json.lock'),'another process owns this lock');
  const branch=repo.save({question:'new contents'},{expectedRevision:saved.revision});
  assert.equal(branch.branched,true);
  assert.equal(repo.load().question,'original');
  assert.equal(repo.load(branch.draftId).question,'new contents');
  assert.equal(fs.readFileSync(path.join(root,'draft.json.lock'),'utf8'),'another process owns this lock');
});
