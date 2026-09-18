import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {buildRelease} from '../scripts/package.mjs';
import {ROOT,runtimePath,checkedPath} from '../src/paths.mjs';

function release(){return buildRelease().directory;}
function run(root,args=[]){
  const env={...process.env};delete env.RELAY_PROJECT_ROOT;
  const child=spawnSync(process.execPath,[path.join(root,'scripts/configure-plugin.mjs'),...args],{cwd:ROOT,env,encoding:'utf8',shell:false,windowsHide:true,timeout:15000});
  assert.ifError(child.error);
  return {...child,result:JSON.parse((child.status===0?child.stdout:child.stderr).trim())};
}
const read=(root,file)=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const write=(root,file,data)=>fs.writeFileSync(checkedPath(path.join(root,file)),JSON.stringify(data,null,2)+'\n');

test('configure preserves other servers and own options; repeat setup accepts its mutable manifest',()=>{
  const root=release();
  const original={clientNote:'keep',mcpServers:{other:{command:'unexecuted-example',args:['keep']},'context-relay':{command:'old-node',args:['old-path'],env:{RELAY_EXAMPLE_KEY:'fixture-not-a-secret'},disabled:true,type:'stdio'}}};
  write(root,'.mcp.json',original);
  const first=run(root);assert.equal(first.status,0,first.stderr);assert.equal(first.result.installed,false);
  assert.equal(first.result.version,read(root,'package.json').version);
  const config=read(root,'.mcp.json');
  assert.deepEqual(config.mcpServers.other,original.mcpServers.other);assert.equal(config.clientNote,'keep');
  assert.deepEqual(config.mcpServers['context-relay'].env,original.mcpServers['context-relay'].env);
  assert.equal(config.mcpServers['context-relay'].disabled,true);
  assert.equal(config.mcpServers['context-relay'].command,process.execPath);
  assert.deepEqual(config.mcpServers['context-relay'].args,[path.join(root,'src/mcp.mjs')]);
  assert.ok(!first.stdout.includes('fixture-not-a-secret'));
  const second=run(root);assert.equal(second.status,0,second.stderr);assert.deepEqual(second.result.changedFiles,[]);
  assert.equal(fs.existsSync(path.join(root,'.configure-plugin.lock')),false);
  assert.ok(!fs.readdirSync(root).some(x=>x.endsWith('.tmp')));
});

test('damaged configuration, incomplete source and version mismatch fail without overwriting user config',()=>{
  for(const kind of ['json','missing','integrity','version','inventory']){
    const root=release();const filename=path.join(root,'.mcp.json');
    const bytes=kind==='json'?'{"userSecret":"fixture-unprinted",broken':JSON.stringify({mcpServers:{other:{command:'leave-alone'}}});
    fs.writeFileSync(filename,bytes);
    const manifestBefore=fs.readFileSync(path.join(root,'.codex-plugin/plugin.json'));
    if(kind==='missing')fs.unlinkSync(checkedPath(path.join(root,'schemas/context-pack.schema.json')));
    if(kind==='integrity')fs.appendFileSync(checkedPath(path.join(root,'src/mcp.mjs')),'\n// damaged fixture\n');
    if(kind==='version'){const p=read(root,'package.json');p.version='99.0.0';write(root,'package.json',p);}
    if(kind==='inventory'){const p=read(root,'release-manifest.json');p.files=p.files.filter(x=>x.path!=='src/models.mjs');write(root,'release-manifest.json',p);fs.unlinkSync(checkedPath(path.join(root,'src/models.mjs')));}
    const result=run(root);assert.equal(result.status,1);assert.equal(result.result.error.code,{json:'CONFIG_INVALID',missing:'RELEASE_INCOMPLETE',integrity:'RELEASE_INTEGRITY',version:'RELEASE_VERSION_MISMATCH',inventory:'RELEASE_INCOMPLETE'}[kind]);
    assert.equal(fs.readFileSync(filename,'utf8'),bytes);assert.ok(fs.readFileSync(path.join(root,'.codex-plugin/plugin.json')).equals(manifestBefore));
    assert.ok(!result.stderr.includes('fixture-unprinted'));assert.equal(fs.existsSync(path.join(root,'.configure-plugin.lock')),false);
  }
});

test('an existing setup lock blocks mutation and removal permits explicit recovery',()=>{
  const root=release();const lock=checkedPath(path.join(root,'.configure-plugin.lock'));
  fs.writeFileSync(lock,'fixture: not an active process');
  const blocked=run(root);assert.equal(blocked.status,1);assert.equal(blocked.result.error.code,'CONFIGURE_BUSY');
  assert.equal(fs.existsSync(path.join(root,'.mcp.json')),false);
  fs.unlinkSync(lock);assert.equal(run(root).status,0);
});

test('installed-copy locator follows configured source; a real move requires refreshed source configuration',()=>{
  const source=release();assert.equal(run(source).status,0);
  const cache=checkedPath(runtimePath('onboarding-audit',`安装缓存 ${path.basename(path.dirname(source))}`),{directory:true,create:true});
  for(const record of read(source,'release-manifest.json').files){const target=checkedPath(path.join(cache,record.path),{create:true});fs.copyFileSync(path.join(source,record.path),target);}
  fs.copyFileSync(path.join(source,'release-manifest.json'),path.join(cache,'release-manifest.json'));
  fs.copyFileSync(path.join(source,'.mcp.json'),path.join(cache,'.mcp.json'));
  const located=run(cache,['--locate']);assert.equal(located.status,0,located.stderr);
  assert.equal(located.result.sourceRoot,source);assert.equal(located.result.dataRoot,path.join(source,'.runtime'));assert.equal(located.result.usingSeparateSource,true);
  assert.equal(fs.existsSync(path.join(cache,'.runtime')),false);
  const moved=checkedPath(path.join(path.dirname(source),'搬移 后的包'));
  checkedPath(source);checkedPath(moved);fs.renameSync(source,moved);
  const stale=run(cache,['--locate']);assert.equal(stale.status,1);assert.equal(stale.result.error.code,'MCP_SOURCE_MISSING');
  assert.equal(fs.existsSync(path.join(cache,'.runtime')),false);
  assert.equal(run(moved).status,0);
  // Simulates only the refreshed cached MCP configuration, not a native reinstall.
  fs.copyFileSync(path.join(moved,'.mcp.json'),path.join(cache,'.mcp.json'));
  const recovered=run(cache,['--locate']);assert.equal(recovered.status,0,recovered.stderr);
  assert.equal(recovered.result.sourceRoot,moved);assert.equal(recovered.result.cliEntry,path.join(moved,'src/cli.mjs'));
  assert.equal(fs.existsSync(path.join(cache,'.runtime')),false);
});

test('locator with no local configuration refuses to guess the copy runtime',()=>{
  const root=release();const result=run(root,['--locate']);
  assert.equal(result.status,1);assert.equal(result.result.error.code,'MCP_NOT_CONFIGURED');
  assert.equal(fs.existsSync(path.join(root,'.mcp.json')),false);assert.equal(fs.existsSync(path.join(root,'.runtime')),false);
});
