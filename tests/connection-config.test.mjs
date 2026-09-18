import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {configureConnection, parseConnectionArgs} from '../src/connection-config.mjs';
import {checkedPath, runtimePath, childEnv, ROOT} from '../src/paths.mjs';

const root = checkedPath(runtimePath('validation', `connection-fixtures-${randomUUID()}`), {directory:true, create:true});
const candidate = {mode:'host-ws', endpoint:'ws://127.0.0.1:6408', threadId:'fixture-existing-september'};
function file(name, bytes) {
  const filename = checkedPath(path.join(root, name, 'relay.json'), {create:true});
  if (bytes !== undefined) fs.writeFileSync(filename, bytes);
  return filename;
}
function fixture(capability = {}, onProbe) {
  const calls = [];
  return {
    fixture:true, calls,
    bridgeFactory(config) {
      calls.push({config});
      return {
        async probe(options) { calls.push({probe:options}); await onProbe?.(); return {mode:'verified-host-bridge', connected:true, canRead:true, canSend:true, readVerified:true, readThreadId:options.threadId, auth:{verified:true}, evidence:'fixture-contract', ...capability}; },
        async close() { calls.push({closed:true}); }
      };
    }
  };
}

test('fixture: default validation reads only selected ID and leaves existing configuration byte-for-byte unchanged', async () => {
  const original = '{"model":{"provider":"external-api","keyEnv":"PRIVATE_SERVER_KEY"},"bridge":{"mode":"export-only"}}\n';
  const configPath = file('read-only', original);
  const dependencies = fixture({untrustedHistory:'PRIVATE_TRANSCRIPT', auth:{verified:true, token:'DO_NOT_LOG'}});
  const result = await configureConnection(candidate, {configPath, ...dependencies});
  assert.equal(result.saved, false);
  assert.equal(result.verification.verified, true);
  assert.equal(result.verification.evidence, 'fixture-contract');
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(dependencies.calls[1], {probe:{threadId:candidate.threadId}});
  assert.deepEqual(dependencies.calls.at(-1), {closed:true});
  assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ['relay.json']);
  for (const secret of ['PRIVATE_SERVER_KEY','PRIVATE_TRANSCRIPT','DO_NOT_LOG']) assert.ok(!JSON.stringify(result).includes(secret));
  const absent = file('read-only-without-config');
  await configureConnection(candidate, {configPath:absent, ...fixture()});
  assert.equal(fs.existsSync(absent), false);
});

test('fixture: explicit host save preserves other fields, backs up exact bytes and requires process restart', async () => {
  const previous = {model:{provider:'codex-cli', effort:'ultra', model:'gpt-6-astra'}, userSetting:{color:'blue'}, bridge:{mode:'export-only'}};
  const original = '\uFEFF' + JSON.stringify(previous, null, 4);
  const configPath = file('save-preservation', original);
  const result = await configureConnection({...candidate, save:true}, {configPath, ...fixture()});
  assert.equal(result.saved, true);
  assert.equal(result.restartRequired, true);
  assert.match(result.nextStep, /Restart/);
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), original);
  const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(current.model, previous.model);
  assert.deepEqual(current.userSetting, previous.userSetting);
  assert.deepEqual(current.bridge, {mode:'host-ws', endpoint:candidate.endpoint});
  assert.ok(!Object.hasOwn(current.bridge, 'fixture'));
  assert.ok(!Object.hasOwn(current.bridge, 'threadId'));
  assert.ok(!fs.readdirSync(path.dirname(configPath)).some(name => /\.tmp$|\.lock$/.test(name)));
});

test('fixture: failed verification retains prior bytes and a later verified retry saves successfully', async () => {
  const original = '{"model":{"provider":"codex-cli"},"bridge":{"mode":"export-only"}}';
  const configPath = file('failure-recovery', original);
  const failed = fixture({connected:false, canRead:false, error:{code:'CONNECTION_ERROR', message:'SECRET_DETAIL'}});
  const diagnosis = await configureConnection(candidate, {configPath, ...failed});
  assert.equal(diagnosis.verification.errorCode, 'CONNECTION_ERROR');
  assert.ok(!JSON.stringify(diagnosis).includes('SECRET_DETAIL'));
  await assert.rejects(configureConnection({...candidate, save:true}, {configPath, ...failed}), error => error.code === 'CONNECTION_NOT_VERIFIED' && error.verification.errorCode === 'CONNECTION_ERROR' && !JSON.stringify(error.verification).includes('SECRET_DETAIL'));
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ['relay.json']);
  const recovered = await configureConnection({...candidate, save:true}, {configPath, ...fixture()});
  assert.equal(recovered.saved, true);
  assert.equal(fs.readFileSync(recovered.backupPath, 'utf8'), original);
});

test('fixture: wrong target or incomplete history cannot qualify a host save', async () => {
  for (const [name, capability] of [
    ['wrong-target', {readThreadId:'another-fixture-thread'}],
    ['incomplete-history', {mode:'export-only', readVerified:false, readError:{code:'HISTORY_INCOMPLETE'}}],
    ['wrong-evidence', {evidence:'live'}]
  ]) {
    const configPath = file(name, '{}');
    await assert.rejects(configureConnection({...candidate, save:true}, {configPath, ...fixture(capability)}), {code:'CONNECTION_NOT_VERIFIED'});
    assert.equal(fs.readFileSync(configPath, 'utf8'), '{}');
  }
});

test('fixture: corrupt JSON and non-object configuration are never replaced or probed', async () => {
  for (const [name, original] of [['bad-json','{"model":"BROKEN'], ['array','[]'], ['null','null']]) {
    const configPath = file(name, original);
    const dependencies = fixture();
    await assert.rejects(configureConnection({...candidate, save:true}, {configPath, ...dependencies}), {code:'CONFIG_CORRUPT'});
    assert.equal(fs.readFileSync(configPath, 'utf8'), original);
    assert.equal(dependencies.calls.length, 0);
  }
});

test('fixture: a valid or corrupt edit made during verification wins over this save', async () => {
  for (const [name, newer] of [['concurrent-valid','{"model":{"newSetting":"keep this"}}'], ['concurrent-corrupt','{"leave-partial-edit']]) {
    const configPath = file(name, '{"bridge":{"mode":"export-only"}}');
    const dependencies = fixture({}, () => fs.writeFileSync(configPath, newer));
    await assert.rejects(configureConnection({...candidate, save:true}, {configPath, ...dependencies}), {code:'CONFIG_CHANGED'});
    assert.equal(fs.readFileSync(configPath, 'utf8'), newer);
    assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ['relay.json']);
  }
});

test('fixture: a file created during first verification is preserved', async () => {
  const configPath = file('concurrent-create');
  const newer = '{"model":{"provider":"external-api"}}';
  await assert.rejects(configureConnection({...candidate, save:true}, {configPath, ...fixture({}, () => fs.writeFileSync(configPath, newer))}), {code:'CONFIG_CHANGED'});
  assert.equal(fs.readFileSync(configPath, 'utf8'), newer);
});

test('fixture: interrupted save lock preserves configuration and explicit lock recovery permits retry', async () => {
  const configPath = file('lock-recovery', '{}');
  const lock = checkedPath(`${configPath}.connection.lock`);
  fs.writeFileSync(lock, 'fixture interrupted writer');
  await assert.rejects(configureConnection({...candidate, save:true}, {configPath, ...fixture()}), {code:'CONFIG_LOCKED'});
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{}');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'fixture interrupted writer');
  // The test owns this synthetic lock; product commands never remove another writer's lock.
  fs.unlinkSync(checkedPath(lock));
  assert.equal((await configureConnection({...candidate, save:true}, {configPath, ...fixture()})).saved, true);
});

test('fixture: managed validation accepts an empty independent profile without claiming desktop verification', async () => {
  const configPath = file('managed-empty');
  const dependencies = fixture({mode:'managed-app-server', readVerified:false, readThreadId:null, canSend:false, auth:{verified:false, code:'NOT_LOGGED_IN'}});
  const result = await configureConnection({mode:'managed-app-server', codexPath:'fixture-codex', save:true}, {configPath, ...dependencies});
  assert.equal(result.saved, true);
  assert.equal(result.verification.mode, 'managed-app-server');
  assert.equal(result.verification.canSend, false);
  assert.equal(result.verification.authCode, 'NOT_LOGGED_IN');
  assert.match(result.sendRequirement, /node src\/cli\.mjs login/);
  assert.match(result.scope, /independent.*not the desktop/);
  assert.deepEqual(dependencies.calls[1], {probe:{}});
});

test('offline: export-only restore needs no bridge and preserves model configuration', async () => {
  const configPath = file('offline-recovery', '{"bridge":{"mode":"host-ws"},"model":{"model":"keep-model"}}');
  const dependencies = fixture();
  const result = await configureConnection({mode:'export-only', save:true}, {configPath, ...dependencies});
  assert.equal(result.verification.evidence, 'offline');
  assert.equal(dependencies.calls.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {bridge:{mode:'export-only'}, model:{model:'keep-model'}});
});

test('argument validation rejects omissions, credentials, unsupported combinations and duplicate flags before any bridge', async () => {
  const badArgs = [[], ['--mode'], ['--mode','unknown'], ['--mode','export-only','--oops'], ['--mode','export-only','--save','--save'],
    ['--mode','host-ws','--endpoint','ws://127.0.0.1:6408'], ['--mode','host-proxy','--thread','existing'],
    ['--mode','host-ws','--endpoint','ws://user:secret@127.0.0.1:6408','--thread','existing'],
    ['--mode','host-ws','--endpoint','ws://example.com:6408','--thread','existing'],
    ['--mode','host-ws','--endpoint','ws://127.0.0.1:6410','--thread','existing'],
    ['--mode','host-ws','--endpoint','ws://127.0.0.1:6408?token=secret','--thread','existing'],
    ['--mode','managed-app-server','--endpoint','ws://127.0.0.1:6408'], ['--mode','export-only','--thread','existing'], ['--mode','export-only','--codex-path','codex']];
  for (const args of badArgs) assert.throws(() => parseConnectionArgs(args), error => Boolean(error.code) && !error.message.includes('secret'));
  assert.deepEqual(parseConnectionArgs(['--help']), {help:true});
  assert.deepEqual(parseConnectionArgs(['--mode','host-proxy','--sock','explicit-socket','--thread','existing','--codex-path','installed-cli']), {mode:'host-proxy', sock:'explicit-socket', threadId:'existing', codexPath:'installed-cli', save:false});
  const dependencies = fixture();
  await assert.rejects(configureConnection({mode:'host-ws', endpoint:candidate.endpoint}, {configPath:file('missing-target'), ...dependencies}), {code:'TARGET_REQUIRED'});
  assert.equal(dependencies.calls.length, 0);
});

test('injection is explicit fixture only and output paths must stay within this project', async () => {
  await assert.rejects(configureConnection(candidate, {configPath:file('unmarked-fixture'), bridgeFactory:fixture().bridgeFactory}), {code:'FIXTURE_REQUIRED'});
  await assert.rejects(configureConnection({mode:'export-only'}, {configPath:path.join(ROOT,'..','outside-relay.json')}), {code:'PATH_OUTSIDE_PROJECT'});
});

test('actual CLI help and malformed commands finish without connecting or echoing supplied secrets', () => {
  for (const [args, expectedStatus] of [[['connection','--help'],0], [['connection'],1], [['connection','--mode','host-ws','--endpoint','ws://private:SECRET_SENTINEL@127.0.0.1:6408','--thread','existing'],1]]) {
    const result = spawnSync(process.execPath, ['src/cli.mjs', ...args], {cwd:ROOT, env:childEnv(), encoding:'utf8', timeout:10000, windowsHide:true});
    assert.equal(result.status, expectedStatus, result.stderr);
    assert.ok(!result.stdout.includes('SECRET_SENTINEL'));
    assert.equal(result.stderr, '');
    if (expectedStatus === 0) assert.match(result.stdout, /Without --save/);
    else assert.ok(JSON.parse(result.stdout).error.code);
  }
});
