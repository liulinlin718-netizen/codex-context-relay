import test from 'node:test';
import assert from 'node:assert/strict';
import {createDraftStore} from '../web/draft-store.js';

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
