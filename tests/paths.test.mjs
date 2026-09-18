import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT,checkedPath,runtimePath,childEnv,writeText} from '../src/paths.mjs';

test('output guard rejects outside-root, sibling-project and traversal paths before writing',()=>{
  for(const target of [path.resolve(ROOT,'../forbidden-context-relay-output'),path.resolve(ROOT,'../forbidden-other-project/test.txt'),path.join(ROOT,'.runtime','..','..','outside.txt')]) {
    assert.throws(()=>checkedPath(target,{create:true}),{code:'PATH_OUTSIDE_PROJECT'});
  }
  assert.equal(checkedPath(runtimePath('validation','a-normal-artifact.txt')),runtimePath('validation','a-normal-artifact.txt'));
});

test('project root cannot be redirected with RELAY_PROJECT_ROOT',()=>{
  const env={...childEnv(),RELAY_PROJECT_ROOT:path.resolve(ROOT,'../forbidden-other-project')};
  const result=spawnSync(process.execPath,['--input-type=module','-e',"await import('./src/paths.mjs')"],{cwd:ROOT,env,shell:false,windowsHide:true,encoding:'utf8'});
  assert.equal(result.status,1);
  assert.match(result.stderr,/RELAY_PROJECT_ROOT must match this project directory/);
});

test('child overrides cannot escape controlled storage or reintroduce API authentication',()=>{
  const keys=['OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','OPENAI_ACCESS_TOKEN','AZURE_OPENAI_API_KEY'];
  const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  const env=childEnv({TEMP:path.resolve(ROOT,'../forbidden-temp'),TMP:path.resolve(ROOT,'../forbidden-temp'),CODEX_HOME:path.resolve(ROOT,'../forbidden-profile'),CODEX_SQLITE_HOME:path.resolve(ROOT,'../forbidden-sqlite'),OPENAI_API_KEY:'fixture-not-secret',CODEX_ACCESS_TOKEN:'fixture-not-secret',codex_api_key:'fixture-not-secret'});
  for(const key of ['TEMP','TMP','TMPDIR','CODEX_HOME','CODEX_SQLITE_HOME','APPDATA','LOCALAPPDATA','XDG_CACHE_HOME','PROJECT_BROWSER_PROFILE_DIR']) {
    assert.equal(checkedPath(env[key]),env[key]);
  }
  for(const key of [...keys,'codex_api_key'])assert.ok(!Object.hasOwn(env,key),`${key} must be absent in the child`);
  for(const key of keys)assert.ok(process.env[key]===before[key],`${key} parent environment changed`);
});

test('junction and hardlink fixtures inside this project cannot be used as output paths',t=>{
  const base=fs.mkdtempSync(checkedPath(runtimePath('validation','paths-test-'),{create:true}));
  const targetDir=path.join(base,'target');fs.mkdirSync(targetDir);
  const targetFile=path.join(targetDir,'original.txt');fs.writeFileSync(targetFile,'original fixture');
  const junction=path.join(base,'junction');const hardlink=path.join(base,'hardlink.txt');
  fs.symlinkSync(targetDir,junction,process.platform==='win32'?'junction':'dir');
  t.after(()=>{if(fs.lstatSync(junction,{throwIfNoEntry:false})?.isSymbolicLink())fs.unlinkSync(junction);if(fs.existsSync(hardlink))fs.unlinkSync(hardlink);});
  assert.throws(()=>checkedPath(path.join(junction,'new-output.txt'),{create:true}),{code:'REPARSE_PATH'});
  assert.equal(fs.existsSync(path.join(targetDir,'new-output.txt')),false);
  fs.linkSync(targetFile,hardlink);
  assert.throws(()=>writeText(hardlink,'modified'),{code:'REPARSE_PATH'});
  assert.equal(fs.readFileSync(targetFile,'utf8'),'original fixture');
});
