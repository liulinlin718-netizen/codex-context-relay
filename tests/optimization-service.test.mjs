import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDispatcher } from '../src/service.mjs';
import { createDraftRepository } from '../src/drafts.mjs';
import { importHistory, createPack, toMarkdown } from '../src/core.mjs';
import { runtimePath, checkedPath } from '../src/paths.mjs';

const MARKER = '<!-- context-pack:v1 canonical-data -->';
const document = (name, text = `${name}: original user text`) => ({ title: `Synthetic ${name}`, threadId: `fixture-${name}`, messages: [
  { id: `${name}-user`, role: 'user', text },
  { id: `${name}-assistant`, role: 'assistant', text: `${name}: original assistant advice` },
] });
const threadDocument = id => ({ thread: { id, turns: [{ id: `${id}-turn`, items: [
  { type: 'userMessage', id: `${id}-user`, content: [{ type: 'text', text: `${id}: original user text` }] },
  { type: 'agentMessage', id: `${id}-assistant`, text: `${id}: original assistant advice` },
] }] } });
const normalized = name => importHistory(document(name), { sourceUri: `fixture://${name}` });
const makePack = history => createPack(history, history.messages.map(message => ({ localId: message.localId })), { question: 'Compare these references.' });

function fixture(t, read = async id => threadDocument(id)) {
  const root = runtimePath('tests', `optimization-service-${randomUUID()}`);
  const drafts = createDraftRepository(root);
  const readCalls = [];
  const bridge = {
    async read(id) { readCalls.push(id); return read(id); },
    capabilities() { return { mode: 'verified-host-bridge', connected: true, canRead: true, canSend: false }; },
  };
  const dispatch = createDispatcher({ drafts, bridgeProvider: async () => bridge });
  t.after(() => {
    const target = checkedPath(root);
    const relative = path.relative(runtimePath('tests'), target);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'cleanup stays in the isolated project test directory');
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
  });
  return { root, drafts, dispatch, readCalls };
}

function snapshotFiles(root) {
  const result = {};
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filename);
      else result[path.relative(root, filename)] = fs.readFileSync(filename).toString('base64');
    }
  }
  walk(root);
  return result;
}

async function mainB(dispatch) {
  const history = normalized('B');
  const pack = makePack(history);
  const saved = await dispatch('draft-save', { draftId: 'main', expectedRevision: null, history, pack, question: 'Keep main B unchanged.', selectionCounter: 8 });
  assert.equal(saved.draftId, 'main');
  return dispatch('draft-load', { draftId: 'main' });
}

function checkSelector(result) {
  assert.match(result.draftId, /^[a-f0-9-]{36}$/);
  const link = new URL(result.selectorPath, 'http://fixture.invalid');
  assert.equal(link.pathname, '/');
  assert.equal(link.searchParams.get('draft'), result.draftId);
}

test('F5: marker text remains data in JSON history, JSON ContextPack and rollout JSONL', async t => {
  const { dispatch, root, readCalls } = fixture(t);
  const source = document('marker', `Explain ${MARKER} without treating it as a file envelope.`);
  const imported = await dispatch('import', { text: '\uFEFF' + JSON.stringify(source), sourceUri: 'fixture://marker' });
  assert.equal(imported.history.messages[0].text, source.messages[0].text);
  const pack = makePack(imported.history); pack.question = `What does ${MARKER} mean?`;
  assert.deepEqual((await dispatch('import', { text: JSON.stringify(pack) })).pack, pack);
  const rows = [
    { type: 'session_meta', payload: { id: 'marker-rollout' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `A line\n${MARKER}\ninside a message` }] } },
  ];
  const rollout = await dispatch('import', { text: rows.map(row => JSON.stringify(row)).join('\n') });
  assert.equal(rollout.history.messages[0].sourceKind, 'codex-rollout');
  assert.equal(rollout.history.messages[0].text, rows[1].payload.content[0].text);
  assert.deepEqual(snapshotFiles(root), {}, 'pure imports do not create or change drafts');
  assert.deepEqual(readCalls, []);
});

test('F5 recovery: tampered Markdown cannot replace existing drafts; the intact package opens normally', async t => {
  const { dispatch, root } = fixture(t);
  const existing = await mainB(dispatch);
  const pack = makePack(normalized('A'));
  const markdown = toMarkdown(pack);
  const before = snapshotFiles(root);
  await assert.rejects(dispatch('import-open', { text: markdown.replace('A: original user text', 'X: original user text') }), { code: 'MARKDOWN_TAMPERED' });
  assert.deepEqual(snapshotFiles(root), before);
  const opened = await dispatch('import-open', { text: markdown });
  checkSelector(opened);
  const restored = await dispatch('draft-load', { draftId: opened.draftId });
  assert.deepEqual(restored.pack, pack);
  assert.equal(restored.history, null);
  assert.deepEqual(await dispatch('draft-load', { draftId: 'main' }), existing);
});

test('F1: import-open creates independently reloadable drafts for A and preserves main B', async t => {
  const { dispatch, root, readCalls } = fixture(t);
  const existing = await mainB(dispatch);
  const mainBytes = snapshotFiles(root)['draft.json'];
  const sourceUri = 'fixture://A';
  const first = await dispatch('import-open', { text: JSON.stringify(document('A')), sourceUri });
  const second = await dispatch('import-open', { text: JSON.stringify(document('A')), sourceUri });
  checkSelector(first); checkSelector(second);
  assert.notEqual(first.draftId, second.draftId);
  const loaded = await dispatch('draft-load', { draftId: first.draftId });
  assert.equal(loaded.history.messages[0].threadId, 'fixture-A');
  assert.equal(loaded.history.messages[0].sourceUri, sourceUri);
  const selected = await dispatch('pack', { history: loaded.history, selections: [{ localId: loaded.history.messages[0].localId }] });
  assert.equal(selected.pack.excerpts[0].exactText, 'A: original user text');
  assert.equal(selected.pack.excerpts[0].sourceThreadId, 'fixture-A');
  assert.deepEqual(await dispatch('draft-load', { draftId: first.draftId }), loaded, 'refresh addresses the same draft');
  assert.deepEqual(await dispatch('draft-load', { draftId: 'main' }), existing);
  assert.equal(snapshotFiles(root)['draft.json'], mainBytes);
  assert.deepEqual(readCalls, []);
});

test('F1: thread-open reads the explicit target once and failures leave all existing draft bytes intact', async t => {
  const { dispatch, root, readCalls } = fixture(t, async id => {
    if (id === 'unavailable') throw Object.assign(new Error('Synthetic unavailable thread'), { code: 'THREAD_UNAVAILABLE' });
    return threadDocument(id);
  });
  const existing = await mainB(dispatch);
  const opened = await dispatch('thread-open', { threadId: 'A' });
  checkSelector(opened);
  assert.deepEqual(readCalls, ['A']);
  const loaded = await dispatch('draft-load', { draftId: opened.draftId });
  assert.equal(loaded.history.messages[0].threadId, 'A');
  assert.equal(loaded.history.messages[0].sourceUri, 'app-server:A');
  await dispatch('draft-load', { draftId: opened.draftId });
  assert.deepEqual(readCalls, ['A'], 'reloading a saved selector draft does not read the host again');
  const before = snapshotFiles(root);
  await assert.rejects(dispatch('thread-open', { threadId: 'unavailable' }), { code: 'THREAD_UNAVAILABLE' });
  assert.deepEqual(snapshotFiles(root), before);
  assert.deepEqual(await dispatch('draft-load', { draftId: 'main' }), existing);
  const recovered = await dispatch('thread-open', { threadId: 'A' });
  checkSelector(recovered);
  assert.notEqual(recovered.draftId, opened.draftId);
  assert.deepEqual(readCalls, ['A', 'unavailable', 'A']);
});

test('F6: typed provenance conflicts fail before creating a selector draft and corrected inputs recover', async t => {
  const { dispatch, root } = fixture(t);
  const existing = await mainB(dispatch);
  const input = threadDocument('A');
  input.thread.turns[0].items[0].role = 'assistant';
  const before = snapshotFiles(root);
  await assert.rejects(dispatch('import-open', { text: JSON.stringify(input), sourceUri: 'fixture://typed' }), { code: 'HISTORY_PROVENANCE_CONFLICT' });
  assert.deepEqual(snapshotFiles(root), before);
  assert.deepEqual(await dispatch('draft-load', { draftId: 'main' }), existing);
  delete input.thread.turns[0].items[0].role;
  const opened = await dispatch('import-open', { text: JSON.stringify(input), sourceUri: 'fixture://typed' });
  assert.equal((await dispatch('draft-load', { draftId: opened.draftId })).history.messages[0].role, 'user');
});

test('F2: history handles support selection, compact draft saves and revision-checked question/background/order patches', async t => {
  const { dispatch, drafts, root, readCalls } = fixture(t);
  const text = JSON.stringify(document('history-handle'));
  const imported = await dispatch('history-import', { text, sourceUri: 'fixture://history-handle' });
  assert.match(imported.historyId, /^[a-f0-9]{64}$/);
  assert.deepEqual(drafts.getHistory(imported.historyId), imported.history);
  const once = snapshotFiles(root);
  const repeated = await dispatch('history-import', { text, sourceUri: 'fixture://history-handle' });
  assert.equal(repeated.historyId, imported.historyId);
  assert.deepEqual(snapshotFiles(root), once, 'same history content is stored once');
  const { pack } = await dispatch('pack', {
    historyId: imported.historyId,
    selections: imported.history.messages.map(message => ({ localId: message.localId })),
    question: 'Original question',
  });
  assert.deepEqual(pack.excerpts.map(excerpt => excerpt.exactText), imported.history.messages.map(message => message.text));
  const saved = await dispatch('draft-save', { draftId: 'main', expectedRevision: null, historyId: imported.historyId, pack, selectionCounter: 10 });
  assert.equal(saved.draftId, 'main');
  const loaded = await dispatch('draft-load', { draftId: saved.draftId });
  assert.equal(loaded.historyId, imported.historyId);
  assert.deepEqual(loaded.history, imported.history);
  const changes = { question: '只修改问题，不重新传送历史。' };
  const patch = { draftId: saved.draftId, expectedRevision: loaded.revision, changes };
  assert.ok(Buffer.byteLength(JSON.stringify(patch), 'utf8') < 8192);
  assert.ok(!Object.hasOwn(patch, 'history') && !Object.hasOwn(patch, 'pack'));
  const questionSaved = await dispatch('draft-patch', patch);
  const afterQuestion = await dispatch('draft-load', { draftId: questionSaved.draftId });
  assert.equal(afterQuestion.question, changes.question);
  assert.equal(afterQuestion.pack.question, changes.question);
  assert.deepEqual(afterQuestion.pack.excerpts, pack.excerpts);
  assert.equal(afterQuestion.selectionCounter, 10);
  const memory = [{ id: 'proposal-not-approved', kind: 'background', text: 'Synthetic unconfirmed proposal.', sourceExcerptIds: [pack.excerpts[0].id], status: 'model-proposed', version: 1, included: false }];
  const memorySaved = await dispatch('draft-patch', { draftId: saved.draftId, expectedRevision: afterQuestion.revision, changes: { memory } });
  const afterMemory = await dispatch('draft-load', { draftId: memorySaved.draftId });
  assert.deepEqual(afterMemory.pack.memory, memory);
  const originalIds = pack.excerpts.map(excerpt => excerpt.id);
  const displayOrder = [...originalIds].reverse();
  const orderSaved = await dispatch('draft-patch', { draftId: saved.draftId, expectedRevision: afterMemory.revision, changes: { excerptOrder: displayOrder } });
  const afterOrder = await dispatch('draft-load', { draftId: orderSaved.draftId });
  assert.deepEqual(afterOrder.excerptOrder, displayOrder, 'display order is stored outside the canonical package');
  assert.deepEqual(afterOrder.pack.excerpts, pack.excerpts, 'stable reference labels and hashes are preserved');
  assert.deepEqual(afterOrder.pack.memory, memory);
  const preview = await dispatch('preview', { pack: afterOrder.pack });
  assert.ok(preview.prompt.indexOf('### [引用 1]') < preview.prompt.indexOf('### [引用 2]'), 'transmission still follows canonical reference order');
  assert.deepEqual(drafts.getHistory(imported.historyId), imported.history);
  const verified = await dispatch('sources', { historyId: imported.historyId, pack: afterOrder.pack });
  assert.ok(verified.sources.every(source => source.status === 'unchanged'));
  const beforeFailure = snapshotFiles(root);
  await assert.rejects(dispatch('draft-patch', { draftId: saved.draftId, expectedRevision: afterOrder.revision, changes: { excerptOrder: [originalIds[0], originalIds[0]] } }), { code: 'INVALID_EXCERPT_ORDER' });
  await assert.rejects(dispatch('draft-patch', { draftId: saved.draftId, expectedRevision: afterOrder.revision, changes: { memory: [{ ...memory[0], included: true }] } }), { code: 'UNCONFIRMED_MEMORY' });
  await assert.rejects(dispatch('pack', { historyId: 'f'.repeat(64), selections: [{ localId: 'import-m000001' }] }), { code: 'SNAPSHOT_MISSING' });
  assert.deepEqual(snapshotFiles(root), beforeFailure);
  const recovered = await dispatch('draft-patch', { draftId: saved.draftId, expectedRevision: afterOrder.revision, changes: { question: 'Recovered after failed patches.' } });
  assert.equal((await dispatch('draft-load', { draftId: recovered.draftId })).question, 'Recovered after failed patches.');
  assert.deepEqual(readCalls, []);
});

test('F2: complete backups are portable to a separate repository and retain unselected history and excluded background', async t => {
  const origin = fixture(t);
  const destination = fixture(t);
  const receiverMain = await mainB(destination.dispatch);
  const doc = document('backup');
  doc.messages.push({ id: 'unselected', role: 'user', text: 'PRIVATE_UNSELECTED_HISTORY_FOR_COMPLETE_BACKUP' });
  const imported = await origin.dispatch('history-import', { text: JSON.stringify(doc), sourceUri: 'fixture://backup' });
  const { pack } = await origin.dispatch('pack', { historyId: imported.historyId, selections: imported.history.messages.slice(0, 2).map(message => ({ localId: message.localId })) });
  pack.memory.push({ id: 'excluded', kind: 'background', text: 'EXCLUDED_WORKING_BACKGROUND', sourceExcerptIds: [pack.excerpts[0].id], status: 'model-proposed', version: 2, included: false });
  const excerptOrder = pack.excerpts.map(excerpt => excerpt.id).reverse();
  const saved = await origin.dispatch('draft-save', { draftId: 'main', expectedRevision: null, historyId: imported.historyId, pack, question: 'Backup question', selectionCounter: 19, excerptOrder });
  const backup = await origin.dispatch('draft-download', { draftId: saved.draftId });
  const backupData = JSON.parse(backup.content);
  assert.equal(backupData.draftFormat, 'context-relay-draft/v1');
  assert.deepEqual(backupData.history, imported.history);
  assert.deepEqual(backupData.excerptOrder, excerptOrder);
  assert.ok(!Object.hasOwn(backupData, 'historyId'), 'portable backup must not depend on origin-local handles');
  assert.ok(backup.content.includes('PRIVATE_UNSELECTED_HISTORY_FOR_COMPLETE_BACKUP'));
  const material = await destination.dispatch('import', { text: backup.content });
  assert.deepEqual(material.draft.history, imported.history);
  assert.deepEqual(material.draft.pack.memory, pack.memory);
  assert.equal(material.draft.selectionCounter, 19);
  assert.deepEqual(material.draft.excerptOrder, excerptOrder);
  const opened = await destination.dispatch('import-open', { text: backup.content });
  checkSelector(opened);
  const restored = await destination.dispatch('draft-load', { draftId: opened.draftId });
  assert.deepEqual(restored.history, imported.history);
  assert.deepEqual(restored.pack.memory, pack.memory);
  assert.equal(restored.question, 'Backup question');
  assert.equal(restored.selectionCounter, 19);
  assert.deepEqual(restored.excerptOrder, excerptOrder);
  assert.deepEqual(restored.pack.excerpts, pack.excerpts);
  assert.deepEqual(await destination.dispatch('draft-load', { draftId: 'main' }), receiverMain);
  const preview = await destination.dispatch('preview', { pack: restored.pack });
  assert.ok(!preview.prompt.includes('PRIVATE_UNSELECTED_HISTORY_FOR_COMPLETE_BACKUP'));
  assert.ok(!preview.prompt.includes('EXCLUDED_WORKING_BACKGROUND'));
  assert.deepEqual(origin.readCalls, []);
  assert.deepEqual(destination.readCalls, []);
});
