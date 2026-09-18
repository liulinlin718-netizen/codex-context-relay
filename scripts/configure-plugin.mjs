import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {ROOT, checkedPath} from '../src/paths.mjs';

const NAME='codex-context-relay';
const ownConfig=path.join(ROOT,'.mcp.json');
const ownManifest=path.join(ROOT,'.codex-plugin','plugin.json');
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function fail(code,message){throw Object.assign(new Error(message),{code});}
function readObject(filename,label){
  let value;
  try{value=JSON.parse(fs.readFileSync(filename,'utf8').replace(/^\uFEFF/,''));}
  catch{fail('CONFIG_INVALID',`${label} is missing or invalid JSON. Restore that file before retrying; it was not overwritten.`);}
  if(!isObject(value))fail('CONFIG_INVALID',`${label} must be a JSON object; it was not overwritten.`);
  return value;
}
function packageIdentity(root){
  const pkg=readObject(path.join(root,'package.json'),'package.json');
  const manifest=readObject(path.join(root,'.codex-plugin/plugin.json'),'plugin manifest');
  if(pkg.name!==NAME||manifest.name!==NAME)fail('NOT_RELAY_RELEASE','Select the complete extracted Context Relay release. Do not run setup from a source template.');
  if(typeof pkg.version!=='string'||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(pkg.version)||manifest.version!==pkg.version)fail('RELEASE_VERSION_MISMATCH','Package and plugin versions disagree. Restore or rebuild the complete release before configuring it.');
  return {pkg,manifest};
}
function checkRelease(){
  if(Number(process.versions.node.split('.')[0])<22)fail('NODE_VERSION_UNSUPPORTED',`Node.js 22+ is required; this process is ${process.version}. Rerun using Node.js 22 or later.`);
  if(!fs.existsSync(ownManifest))fail('NOT_RELAY_RELEASE','Run setup in the complete extracted release. From source, run node scripts/package.mjs first; downloaded releases already contain the required files.');
  const identity=packageIdentity(ROOT);
  const release=readObject(checkedPath(path.join(ROOT,'release-manifest.json')),'release-manifest.json');
  if(release.name!==NAME||release.version!==identity.pkg.version)fail('RELEASE_VERSION_MISMATCH','Release, package and plugin versions must agree. Re-extract a complete release.');
  if(!Array.isArray(release.files)||release.files.length===0)fail('RELEASE_INCOMPLETE','The release file list is missing. Re-extract a complete release.');
  const seen=new Set();
  for(const record of release.files){
    if(!isObject(record)||typeof record.path!=='string'||path.isAbsolute(record.path)||record.path.includes('\\')||record.path.split('/').some(x=>!x||x==='.'||x==='..')||seen.has(record.path)||!/^[a-f0-9]{64}$/.test(record.sha256)||!Number.isSafeInteger(record.bytes)||record.bytes<0)fail('RELEASE_INCOMPLETE','The release file list is invalid. Re-extract a complete release.');
    seen.add(record.path);
    const filename=checkedPath(path.join(ROOT,record.path));
    if(!fs.existsSync(filename)||!fs.lstatSync(filename).isFile())fail('RELEASE_INCOMPLETE',`Missing release file: ${record.path}. Re-extract the full package before retrying.`);
    // Setup owns this mutable pointer; repeated setup still checks identity/version.
    if(record.path==='.codex-plugin/plugin.json')continue;
    if(record.path==='.mcp.json')fail('RELEASE_INCOMPLETE','A release must not inventory local MCP configuration. Rebuild it from the reviewed package allowlist.');
    const bytes=fs.readFileSync(filename);
    if(bytes.length!==record.bytes||createHash('sha256').update(bytes).digest('hex')!==record.sha256)fail('RELEASE_INTEGRITY',`Release file differs from its manifest: ${record.path}. Restore or rebuild the release; setup did not overwrite local configuration.`);
  }
  for(const required of ['package.json','.codex-plugin/plugin.json','src/mcp.mjs','src/cli.mjs','src/paths.mjs','src/core.mjs','src/service.mjs','src/server.mjs','src/integrations.mjs','src/models.mjs','src/drafts.mjs','src/connection-config.mjs','schemas/context-pack.schema.json','schemas/model-output.schema.json','web/index.html','web/app.js','web/draft-store.js','web/style.css','examples/demo-history.json','scripts/configure-plugin.mjs','skills/context-relay/SKILL.md'])if(!seen.has(required))fail('RELEASE_INCOMPLETE',`Release inventory omits ${required}. Re-extract the complete package.`);
  return identity;
}
function configEntry(config){
  if(!isObject(config.mcpServers))fail('CONFIG_INVALID','.mcp.json must contain a mcpServers object; existing contents were not overwritten.');
  const entry=config.mcpServers['context-relay'];
  if(entry!==undefined&&!isObject(entry))fail('CONFIG_INVALID','The context-relay MCP entry must be an object; existing contents were not overwritten.');
  return entry;
}
function locate(){
  if(!fs.existsSync(ownConfig))fail('MCP_NOT_CONFIGURED','This copy has no .mcp.json. Locate your original extracted release and run its scripts/configure-plugin.mjs. Do not start a plugin-cache copy as a substitute.');
  const entry=configEntry(readObject(checkedPath(ownConfig),'.mcp.json'));
  if(!entry||typeof entry.command!=='string'||!path.isAbsolute(entry.command)||!Array.isArray(entry.args)||entry.args.length!==1||typeof entry.args[0]!=='string'||!path.isAbsolute(entry.args[0]))fail('MCP_CONFIG_UNSUPPORTED','The configured Context Relay entry is not the generated absolute Node/script command. Repair configuration in the original extracted release and reinstall/reload the client configuration.');
  const mcpEntry=path.resolve(entry.args[0]);
  if(path.basename(mcpEntry)!=='mcp.mjs'||path.basename(path.dirname(mcpEntry))!=='src')fail('MCP_CONFIG_UNSUPPORTED','The configured entrypoint must be the original release src/mcp.mjs. Do not guess a different runtime directory.');
  const sourceRoot=path.dirname(path.dirname(mcpEntry));
  const cliEntry=path.join(sourceRoot,'src/cli.mjs');
  if(!fs.existsSync(mcpEntry)||!fs.existsSync(cliEntry))fail('MCP_SOURCE_MISSING',`The configured source directory is unavailable: ${sourceRoot}. Restore it or configure the moved release, update its marketplace source, and reinstall/reload. No plugin-cache fallback was started.`);
  if(!fs.existsSync(entry.command))fail('MCP_NODE_MISSING',`The configured Node executable is unavailable. Rerun setup in ${sourceRoot} using a current Node.js 22+ installation, then reinstall/reload the client configuration.`);
  const {pkg}=packageIdentity(sourceRoot);
  return {located:true,sourceRoot,dataRoot:path.join(sourceRoot,'.runtime'),cliEntry,mcpEntry,nodeExecutable:entry.command,version:pkg.version,configurationRead:ownConfig,configurationCopyRoot:ROOT,usingSeparateSource:sourceRoot!==ROOT,readOnly:true,note:'Use the reported source entrypoint. This lookup does not start a server, install anything, or verify the desktop connection.'};
}
function stagedWrite(filename,bytes){
  const temporary=checkedPath(path.join(path.dirname(filename),`.${path.basename(filename)}.configure-${randomUUID()}.tmp`));
  const fd=fs.openSync(temporary,'wx',0o600);
  let failure;
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}catch(e){failure=e;}
  try{fs.closeSync(fd);}catch(e){failure??=e;}
  if(failure){try{fs.unlinkSync(temporary);}catch{}throw failure;}
  return temporary;
}
function atomicChanges(changes){
  const staged=[];const committed=[];
  try{
    for(const change of changes){checkedPath(change.filename);change.previous=fs.existsSync(change.filename)?fs.readFileSync(change.filename):null;change.temporary=stagedWrite(change.filename,change.bytes);staged.push(change);}
    for(const change of staged){fs.renameSync(change.temporary,change.filename);committed.push(change);}
  }catch{
    let rollbackFailed=false;
    for(const change of committed.reverse())try{if(change.previous===null)fs.unlinkSync(change.filename);else fs.renameSync(stagedWrite(change.filename,change.previous),change.filename);}catch{rollbackFailed=true;}
    fail(rollbackFailed?'CONFIGURE_PARTIAL_WRITE':'CONFIGURE_WRITE_FAILED',rollbackFailed?'A configuration write and rollback failed. Keep this package in place and inspect its .mcp.json and plugin manifest before retrying.':'Configuration could not be saved; previous contents were retained. Check directory/file permissions and retry.');
  }finally{for(const change of staged)if(fs.existsSync(change.temporary))fs.unlinkSync(change.temporary);}
}
function configure(){
  const {pkg,manifest}=checkRelease();
  const lock=checkedPath(path.join(ROOT,'.configure-plugin.lock'));
  let lockFd;
  try{lockFd=fs.openSync(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')fail('CONFIGURE_BUSY','Setup is already running or a previous setup left .configure-plugin.lock. Wait for the active process; inspect a stale lock before removing it.');throw e;}
  try{
    const config=fs.existsSync(ownConfig)?readObject(checkedPath(ownConfig),'.mcp.json'):{mcpServers:{}};
    const existing=configEntry(config)||{};
    if(existing.url!==undefined||(existing.type!==undefined&&existing.type!=='stdio'))fail('MCP_CONFIG_UNSUPPORTED','The existing context-relay entry uses another transport. Keep it under a different server name before configuring this local stdio entry.');
    config.mcpServers['context-relay']={...existing,command:process.execPath,args:[path.join(ROOT,'src/mcp.mjs')]};
    manifest.mcpServers='./.mcp.json';
    const candidates=[{filename:ownConfig,bytes:Buffer.from(JSON.stringify(config,null,2)+'\n')},{filename:ownManifest,bytes:Buffer.from(JSON.stringify(manifest,null,2)+'\n')}];
    const changes=candidates.filter(x=>!fs.existsSync(x.filename)||!fs.readFileSync(x.filename).equals(x.bytes));
    atomicChanges(changes);
    return {configured:true,version:pkg.version,pluginRoot:ROOT,dataRoot:path.join(ROOT,'.runtime'),mcpConfig:ownConfig,nodeExecutable:process.execPath,changedFiles:changes.map(x=>path.relative(ROOT,x.filename)),installed:false,next:['Keep this extracted directory in place.','Add/reload this MCP configuration in your client, or follow docs/INTEGRATION.md to install the local plugin.','After moving the directory or changing Node, rerun setup in the source release and reinstall/reload cached client configuration.','Call relay_capabilities to verify the actual data root, then relay_selector to start selecting explicit history.'],note:'Other MCP servers and existing context-relay options (including env) were preserved. No global configuration changed.'};
  }finally{fs.closeSync(lockFd);fs.unlinkSync(lock);}
}

try{
  const args=process.argv.slice(2);
  if(args.some(x=>!['--locate','--help'].includes(x))||args.length>1)fail('INVALID_ARGUMENT','Usage: node scripts/configure-plugin.mjs [--locate|--help]');
  if(args[0]==='--help')process.stdout.write('configure-plugin: validate the complete extracted release and update only its local Context Relay MCP entry.\n--locate: read the configured source runtime and data directory, including from an installed cache; no writes or startup.\n');
  else process.stdout.write(JSON.stringify(args[0]==='--locate'?locate():configure(),null,2)+'\n');
}catch(e){process.stderr.write(JSON.stringify({error:{code:e.code||'CONFIGURE_FAILED',message:e.message}})+'\n');process.exitCode=1;}
