import test from 'node:test';
import assert from 'node:assert/strict';
import {createDraftStore,captureDraft,draftChanges} from '../web/draft-store.js';

test('rapid edits keep snapshots immutable and never announce a stale save as current', async () => {
  const writes = [], states = [], resolvers = [];
  const store = createDraftStore({save: data => { writes.push(data); return new Promise(resolve => resolvers.push(resolve)); }, onStatus: state => states.push(state)});
  const first = {question:'first', selections:[1]};
  store.update(first);
  first.selections.push(99);
  store.update({question:'intermediate', selections:[1,2]});
  store.update({question:'latest', selections:[1,2,3]});
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].selections, [1]);
  resolvers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 2);
  assert.equal(writes[1].question, 'latest');
  assert.equal(states.includes('saved'), false);
  assert.equal(store.pending(), true);
  resolvers.shift()();
  await store.flush();
  assert.equal(store.pending(), false);
  assert.equal(states.at(-1), 'saved');
});

test('question, background and order updates stay small while immutable excerpts survive queued edits',async()=>{
  const excerpt={id:'a',exactText:'x'.repeat(1000000),selectionOrder:1};
  const other={id:'b',exactText:'other',selectionOrder:2};
  const pack={schemaVersion:'1',packId:'pack',createdAt:'now',question:'',excerpts:[excerpt,other],memory:[{id:'m',sourceExcerptIds:['a'],text:'background',status:'user-confirmed',included:true}]};
  const first=captureDraft({historyId:'history-id',pack,question:'first',selectionCounter:2});
  pack.question='second';
  const second=captureDraft({historyId:'history-id',pack,question:'second',selectionCounter:2});
  assert.strictEqual(first.pack.excerpts[0],second.pack.excerpts[0]);
  assert.deepEqual(draftChanges(first,second),{question:'second'});
  pack.memory[0].text='edited';pack.memory[0].sourceExcerptIds.push('b');
  const third=captureDraft({historyId:'history-id',pack,excerptOrder:['b','a'],question:'second',selectionCounter:2});
  assert.equal(first.pack.memory[0].text,'background');assert.deepEqual(first.pack.memory[0].sourceExcerptIds,['a']);
  assert.equal(first.pack.excerpts[0].id,'a');
  const patch=draftChanges(second,third);assert.deepEqual(patch.excerptOrder,['b','a']);assert.equal(patch.memory[0].text,'edited');
  assert.ok(JSON.stringify(patch).length<1000);
  pack.excerpts.push({id:'c',exactText:'new'});
  assert.equal(draftChanges(third,captureDraft({historyId:'history-id',pack})),null);
  assert.equal(draftChanges(third,captureDraft({historyId:'different',pack})),null);
});

test('a failed save remains dirty and retry writes the latest edit without clearing it', async () => {
  let failed = true;
  const writes = [], states = [];
  const store = createDraftStore({save: async data => { if (failed) throw new Error('disk full'); writes.push(data); }, onStatus: state => states.push(state)});
  await store.update({question:'do not lose this question', pack:null});
  assert.equal(store.pending(), true);
  assert.equal(states.at(-1), 'error');
  failed = false;
  await store.flush();
  assert.deepEqual(writes, [{question:'do not lose this question', pack:null}]);
  assert.equal(store.pending(), false);
});
