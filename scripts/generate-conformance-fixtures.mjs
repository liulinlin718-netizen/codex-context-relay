import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importHistory, createPack, validatePack, toMarkdown } from '../src/core.mjs';
import { ROOT, checkedPath, writeText } from '../src/paths.mjs';

const FIXTURE_TIME = '2026-09-25T00:00:00Z';
const definitions = [
  {
    name: 'full-message', format: 'json', sourceUri: 'fixture:conformance/full-message',
    source: { thread: { id: 'fixture-thread', name: 'Synthetic full-message conformance fixture', turns: [{ id: 'fixture-turn', items: [
      { type: 'userMessage', id: 'fixture-user', content: [{ type: 'text', text: '预算上限为每月 300 元。' }] },
      { type: 'agentMessage', id: 'fixture-assistant', text: '建议先用离线导出，再评估同步。' },
    ] }] } },
    choose: history => history.messages.map(m => ({ localId: m.localId })),
    question: '引用 2 是否满足引用 1？',
    memories: pack => [
      { kind: 'constraint', text: pack.excerpts[0].exactText, sourceExcerptIds: [pack.excerpts[0].id], status: 'quoted', included: true },
      { kind: 'decision', text: '本夹具模拟发送者确认：先做离线导出。', sourceExcerptIds: [pack.excerpts[1].id], status: 'user-confirmed', included: true },
    ],
  },
  {
    name: 'partial-message', format: 'json', sourceUri: 'fixture:conformance/partial-message',
    source: { title: 'Synthetic partial-message conformance fixture', threadId: 'fixture-partial-thread', messages: [
      { id: 'fixture-partial-item', role: 'user', text: '未选前文。预算上限为每月 300 元，保留 😀。未选后文。', timestamp: FIXTURE_TIME },
    ] },
    choose: history => { const m = history.messages[0]; return [{ localId: m.localId, start: m.text.indexOf('预算'), end: m.text.indexOf('未选后文') }]; },
    question: '只解释选中的预算条件。',
    memories: pack => [{ kind: 'background', text: '尚未确认的模型提议：未来可能增加预算。', sourceExcerptIds: [pack.excerpts[0].id], status: 'model-proposed', included: false }],
  },
  {
    name: 'unknown-source', format: 'json', sourceUri: null,
    source: { title: 'Synthetic unknown-source conformance fixture', messages: [{ role: 'assistant', text: '尚未确认：是否需要云同步？' }] },
    choose: history => [{ localId: history.messages[0].localId }],
    question: '把这句话作为建议分析，不推断其原始任务。',
    memories: () => [],
  },
  {
    name: 'rollout', format: 'jsonl', sourceUri: 'fixture:conformance/rollout',
    source: [
      { type: 'session_meta', payload: { id: 'fixture-rollout-session', title: 'Synthetic rollout conformance fixture' } },
      { type: 'turn_context', payload: { turn_id: 'fixture-rollout-turn' } },
      { type: 'response_item', timestamp: FIXTURE_TIME, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '先离线验证来源，再考虑转发。' }] } },
      { type: 'response_item', timestamp: '2026-09-25T00:00:01Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '可以先生成可核对的引用包。' }] } },
    ],
    choose: history => history.messages.map(m => ({ localId: m.localId })),
    question: '结合两条引用说明下一步。',
    memories: pack => [{ kind: 'decision', text: '本夹具模拟已确认但本次不发送的背景。', sourceExcerptIds: [pack.excerpts[0].id], status: 'user-confirmed', included: false }],
  },
];

/** Real producer API; only fixture identity/time is made stable for reviewable diffs.
 * Source text, range, provenance and both hashes always come from createPack. */
export function buildConformanceFixtures() {
  return definitions.map(definition => {
    const sourceText = definition.format === 'jsonl'
      ? definition.source.map(row => JSON.stringify(row)).join('\n') + '\n'
      : JSON.stringify(definition.source, null, 2) + '\n';
    const history = importHistory(sourceText, { sourceUri: definition.sourceUri });
    const selections = definition.choose(history);
    const pack = createPack(history, selections, { question: definition.question });
    pack.packId = `fixture-${definition.name}`;
    pack.createdAt = FIXTURE_TIME;
    pack.excerpts.forEach((excerpt, index) => { excerpt.id = `fixture-${definition.name}-excerpt-${index + 1}`; });
    pack.memory = definition.memories(pack).map((memory, index) => ({ id: `fixture-${definition.name}-memory-${index + 1}`, version: 1, ...memory }));
    validatePack(pack);
    return { name: definition.name, format: definition.format, sourceUri: definition.sourceUri, sourceText, selections, pack, markdown: toMarkdown(pack) };
  });
}

export function conformanceFiles() {
  const fixtures = buildConformanceFixtures();
  const files = new Map();
  const manifest = {
    fixtureFormat: 'context-relay-conformance/v1', synthetic: true,
    description: 'Synthetic protocol fixtures, not captured host conversations or model output. Receiver approval must remain a separate explicit action.',
    generatedBy: 'node scripts/generate-conformance-fixtures.mjs',
    cases: fixtures.map(fixture => {
      const source = `${fixture.name}.source.${fixture.format}`;
      const pack = `${fixture.name}.pack.json`;
      const markdown = `${fixture.name}.pack.md`;
      files.set(source, fixture.sourceText);
      files.set(pack, JSON.stringify(fixture.pack, null, 2) + '\n');
      files.set(markdown, fixture.markdown);
      return { name: fixture.name, source, format: fixture.format, sourceUri: fixture.sourceUri, selections: fixture.selections, pack, markdown, receiverApprovalRequired: true };
    }),
  };
  files.set('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.length === 3 && process.argv[2] === '--check';
  if (process.argv.length > 2 && !check) throw new Error('Usage: node scripts/generate-conformance-fixtures.mjs [--check]');
  const directory = checkedPath(path.join(ROOT, 'examples', 'conformance'));
  const files = conformanceFiles();
  for (const [filename, text] of files) {
    const target = checkedPath(path.join(directory, filename));
    if (check) {
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text) throw new Error(`Conformance fixture differs from current producer: ${filename}`);
    } else writeText(target, text);
  }
  process.stdout.write(JSON.stringify({ mode: check ? 'verified' : 'generated', cases: 4, files: files.size, directory, synthetic: true }) + '\n');
}
