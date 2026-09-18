import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import readline from 'node:readline';
import {buildRelease} from '../scripts/package.mjs';
import {ROOT, checkedPath, childEnv, runtimePath, writeText} from '../src/paths.mjs';

function listFiles(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), {withFileTypes:true}).flatMap(entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(root, relative) : [relative];
  }).sort();
}

test('allowlisted release survives relocation and runs real CLI, stdio MCP and recoverable draft flow', async t => {
  const workspace = runtimePath('validation', `portable-${randomUUID()}`);
  const stage = path.join(workspace, 'stage', 'codex-context-relay');
  buildRelease(stage);
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'release-manifest.json'), 'utf8'));
  assert.deepEqual(listFiles(stage), [...manifest.files.map(file => file.path), 'release-manifest.json'].sort());
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(path.join(stage, file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    assert.ok(!bytes.includes(Buffer.from(ROOT)), file.path);
    assert.doesNotMatch(bytes.toString('utf8'), /[A-Z]:[/\\]Users[/\\][^\s'"`]+/i, file.path);
  }
  assert.ok(!fs.existsSync(path.join(stage, '.runtime')));
  assert.ok(!fs.existsSync(path.join(stage, '.mcp.json')), 'No author-machine config may ship');
  const relocated = checkedPath(path.join(workspace, '用户 空格 renamed', 'codex-context-relay'), {create:true});
  // Both resolved endpoints are verified inside the owning project before move.
  fs.renameSync(checkedPath(stage), relocated);
  const env = {...childEnv()};
  delete env.RELAY_PROJECT_ROOT;
  const invoke = (...args) => {
    const result = spawnSync(process.execPath, args, {cwd:ROOT, env, encoding:'utf8', shell:false, windowsHide:true, timeout:15000});
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return JSON.parse(result.stdout);
  };
  const setup = invoke(path.join(relocated, 'scripts/configure-plugin.mjs'));
  assert.equal(setup.pluginRoot, relocated);
  const doctor = invoke(path.join(relocated, 'src/cli.mjs'), 'doctor');
  assert.equal(doctor.storage.root, relocated);
  assert.equal(doctor.storage.codexHome, path.join(relocated, '.runtime', 'codex-profile'));
  const demo = invoke(path.join(relocated, 'scripts/demo.mjs'));
  assert.equal(demo.normal.roundtrip, true);
  assert.equal(demo.delivery.attempted, false);

  const config = JSON.parse(fs.readFileSync(path.join(relocated, '.mcp.json'), 'utf8')).mcpServers['context-relay'];
  assert.deepEqual(config.args, [path.join(relocated, 'src/mcp.mjs')]);
  const proc = spawn(config.command, config.args, {cwd:ROOT, env, stdio:['pipe','pipe','pipe'], shell:false, windowsHide:true});
  t.after(() => proc.kill());
  let sequence = 0, stderr = '';
  const pending = new Map();
  proc.stderr.on('data', chunk => stderr += chunk);
  readline.createInterface({input:proc.stdout}).on('line', line => {
    const result = JSON.parse(line), waiter = pending.get(result.id);
    if (waiter) { clearTimeout(waiter.timer); pending.delete(result.id); result.error ? waiter.reject(new Error(JSON.stringify(result.error))) : waiter.resolve(result.result); }
  });
  function rpc(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timeout: ${stderr}`)), 10000);
      pending.set(id, {resolve,reject,timer});
      proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    });
  }
  async function tool(name, args = {}) {
    const result = await rpc('tools/call', {name,arguments:args});
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  }
  await rpc('initialize', {protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'relocation-test',version:'1'}});
  const source = JSON.stringify({title:'Independent recipient fixture',messages:[
    {id:'a',role:'user',text:'Keep the budget below 80.'},
    {id:'b',role:'assistant',text:'I suggest a plan costing 120.'},
    {id:'c',role:'user',text:'UNSELECTED_MUST_NOT_TRAVEL'},
  ]});
  const {history} = await tool('relay_import', {text:source,sourceUri:'fixture://independent-client'});
  const {pack} = await tool('relay_pack', {history,selections:history.messages.slice(0,2).map(message => ({localId:message.localId})),question:'Does citation 2 respect citation 1?'});
  pack.memory.push({id:'budget',kind:'constraint',text:'Budget limit: 80',sourceExcerptIds:[pack.excerpts[0].id],status:'user-confirmed',version:1,included:true});
  const preview = await tool('relay_preview', {pack});
  assert.ok(!preview.prompt.includes('UNSELECTED_MUST_NOT_TRAVEL'));
  const exported = await tool('relay_export', {pack,format:'md'});
  assert.ok(exported.path.startsWith(path.join(relocated,'.runtime','exports') + path.sep));
  const received = await tool('relay_import', {text:fs.readFileSync(exported.path,'utf8')});
  assert.deepEqual(received.pack, pack);

  let selector;
  for (const port of [6407,6406]) {
    const result = await rpc('tools/call', {name:'relay_selector',arguments:{port}});
    if (!result.isError) { selector=JSON.parse(result.content[0].text); break; }
    assert.match(result.content[0].text, /EADDRINUSE/);
  }
  assert.ok(selector, 'One selector test port must be free');
  const bootstrap = await (await fetch(`${selector.url}/bootstrap`)).json();
  const call = async (action,data) => {
    const response=await fetch(`${selector.url}/api`, {method:'POST',headers:{'Content-Type':'application/json','x-relay-token':bootstrap.token},body:JSON.stringify({action,data})});
    return {status:response.status,data:await response.json()};
  };
  const initialDraft = (await call('draft-load')).data;
  assert.equal((await call('draft-save',{history,pack,question:pack.question,expectedRevision:initialDraft.revision})).status,200);
  assert.equal((await call('import',{text:'broken json'})).status,400);
  assert.deepEqual((await call('draft-load')).data.pack,pack);
  const download=await call('export',{pack,format:'json',download:true});
  assert.deepEqual(JSON.parse(download.data.content),pack);
  assert.equal(fs.readFileSync(download.data.path,'utf8'),download.data.content);
  writeText(runtimePath('validation','release-portability-latest.json'),JSON.stringify({checkedAt:new Date().toISOString(),relocated,files:manifest.files.length+1,passed:['allowlist+checksums','no local author paths','relocated CLI and demo','generated stdio MCP from unrelated cwd','import/select/context/preview/export/reimport','draft preserved after bad import','browser download bytes match checked file'],notProven:['real model inference','real host installation or delivery','non-Windows execution']},null,2));
  proc.stdin.end();
});
