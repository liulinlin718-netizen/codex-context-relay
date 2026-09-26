import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {ROOT, checkedPath, runtimePath, childEnv} from './paths.mjs';
import {renderPrompt, validatePack} from './core.mjs';

const now = () => new Date().toISOString();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const error = (code, message) => Object.assign(new Error(message), {code});
const publicError = e => ({code:String(e.code || 'BRIDGE_ERROR'), message:String(e.message || 'Bridge operation failed').slice(0,1000)});
const terminal = new Set(['completed','failed','interrupted']);
const packageVersion=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const loginHint = '本工具的独立 profile 尚未登录 ChatGPT。运行 node src/cli.mjs login 正常登录后重新探测；不会复制宿主凭据或切换到 API 计费。';
const hostLoginHint = '明确连接的宿主 App Server 尚未以 ChatGPT 登录。请在该宿主支持的正常登录入口登录后重新探测；本工具的独立 profile 登录不会改变宿主登录态，也不会复制凭据或切换到 API 计费。';

export function codexChildEnv() {
  const env = childEnv();
  // Only this new object is changed. Never log values or mutate process.env.
  for (const key of Object.keys(env)) if (/(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN)$|^(?:OPENAI_BASE_URL|CODEX_BASE_URL)$/i.test(key)) delete env[key];
  for (const key of ['CODEX_THREAD_ID','CODEX_SESSION_ID','CODEX_INTERNAL_ORIGINATOR_OVERRIDE','CODEX_APP_TOOLS_PIPE_PATH']) delete env[key];
  return env;
}

export function codexAppServerCommand(config = {}) {
  const env = codexChildEnv();
  const args = ['-c','cli_auth_credentials_store="file"','-c',`sqlite_home=${JSON.stringify(env.CODEX_SQLITE_HOME.replaceAll('\\','/'))}`];
  if (config.mode === 'host-proxy') {
    if (typeof config.sock !== 'string' || !config.sock.trim()) throw error('SOCKET_REQUIRED','请显式配置授权的 App Server socket；不会扫描宿主目录。');
    args.push('app-server','proxy','--sock',config.sock);
  } else args.push('app-server','--listen','stdio://');
  return {command:config.codexPath || 'codex',args,env,cwd:ROOT};
}

/** Minimal public JSON-RPC transport. Unsupported server requests are rejected, never approved. */
export class AppServerTransport extends EventEmitter {
  constructor(config = {}) { super(); this.config=config; this.pending=new Map(); this.sequence=0; this.closed=false; }
  async open() {
    if (this.config.mode === 'host-ws') {
      const url = new URL(this.config.endpoint || '');
      if (!['ws:','wss:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || Number(url.port)<6400 || Number(url.port)>6409 || !url.port || url.username || url.password || url.search || url.hash) throw error('ENDPOINT_REJECTED','WebSocket 必须是显式的本机 6400–6409 端口 URL，不允许在 URL 内放凭据。');
      this.socket=new WebSocket(url);
      this.socket.addEventListener('message',event=>this.receive(String(event.data)));
      this.socket.addEventListener('close',()=>this.disconnected());
      this.socket.addEventListener('error',()=>this.disconnected(error('CONNECTION_ERROR','App Server WebSocket 连接失败。')));
      await new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>{this.socket.close(); reject(error('TIMEOUT','App Server WebSocket 连接超时。'));},this.config.timeoutMs || 10000);
        this.socket.addEventListener('open',()=>{clearTimeout(timeout);resolve();},{once:true});
        this.socket.addEventListener('error',()=>{clearTimeout(timeout);reject(error('CONNECTION_ERROR','App Server WebSocket 连接失败。'));},{once:true});
      });
      return;
    }
    const {command,args,env,cwd}=codexAppServerCommand(this.config);
    this.child=spawn(command,args,{env,cwd,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.resume(); // CLI diagnostics may contain local paths; never forward raw stderr.
    this.buffer='';
    this.child.stdout.on('data',chunk=>{
      this.buffer+=chunk;
      if(this.buffer.length>16*1024*1024) {this.close();this.disconnected(error('PROTOCOL_LIMIT','App Server 响应超过 16 MiB 限制。'));return;}
      let line; while((line=this.buffer.indexOf('\n'))>=0) {const data=this.buffer.slice(0,line);this.buffer=this.buffer.slice(line+1); if(data.trim())this.receive(data);}
    });
    this.child.stdin.on('error',()=>this.disconnected());
    this.child.on('exit',()=>this.disconnected());
    this.child.on('error',e=>this.disconnected(error(e.code==='ENOENT'?'CLI_NOT_FOUND':'SPAWN_ERROR',e.code==='ENOENT'?'未找到 Codex CLI；配置 codexPath 指向已安装的可执行文件。':'无法启动 App Server。')));
    await new Promise((resolve,reject)=>{this.child.once('spawn',resolve);this.child.once('error',e=>reject(error(e.code==='ENOENT'?'CLI_NOT_FOUND':'SPAWN_ERROR','无法启动指定 Codex CLI。')));});
  }
  write(value) {
    if(this.closed) throw error('DISCONNECTED','App Server 已断开。');
    const text=JSON.stringify(value);
    if(this.socket) {if(this.socket.readyState!==1)throw error('DISCONNECTED','App Server 已断开。');this.socket.send(text);}
    else this.child.stdin.write(text+'\n');
  }
  request(method,params={},timeoutMs=this.config.timeoutMs || 10000) {
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(error('TIMEOUT',`${method} 响应超时；写请求可能已提交。`));},timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try {this.write({jsonrpc:'2.0',id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  notify(method,params={}) {this.write({jsonrpc:'2.0',method,params});}
  receive(text) {
    let data; try {data=JSON.parse(text);}catch {this.disconnected(error('PROTOCOL_ERROR','App Server 返回非 JSON 消息。'));return;}
    if(data.id!==undefined && !data.method) {
      const entry=this.pending.get(data.id);if(!entry)return;clearTimeout(entry.timer);this.pending.delete(data.id);
      if(data.error)entry.reject(Object.assign(error('RPC_REJECTED',`App Server 拒绝请求（${data.error.code ?? 'unknown'}）。`),{rpcCode:data.error.code}));else entry.resolve(data.result);
    } else if(data.id!==undefined && data.method) {
      try {this.write({jsonrpc:'2.0',id:data.id,error:{code:-32601,message:'Context Relay is a reference client and cannot grant approvals or execute tools.'}});}catch{}
      this.emit('serverRequest',{method:data.method,params:data.params});
    } else if(data.method) this.emit('notification',data);
  }
  disconnected(cause=error('DISCONNECTED','App Server 已断开；发送结果需只读核对。')) {
    if(this.closed)return;this.closed=true;
    for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(cause);}this.pending.clear();
    this.child?.stdin.destroy();this.child?.kill();try{this.socket?.close();}catch{}
    this.emit('disconnect',cause);
  }
  close() {this.disconnected();this.child?.stdin.end();this.child?.kill();this.socket?.close();}
}

function writeReceipt(filename,record,{exclusive=false}={}) {
  checkedPath(filename,{create:true});
  if(exclusive) {
    let fd;try {fd=fs.openSync(filename,'wx');fs.writeFileSync(fd,JSON.stringify(record,null,2));fs.fsyncSync(fd);}finally{if(fd!==undefined)fs.closeSync(fd);}return;
  }
  const temp=checkedPath(`${filename}.${crypto.randomUUID()}.tmp`);
  let fd;try {fd=fs.openSync(temp,'wx');fs.writeFileSync(fd,JSON.stringify(record,null,2));fs.fsyncSync(fd);}finally{if(fd!==undefined)fs.closeSync(fd);}
  fs.renameSync(temp,filename);
}

// A file's age or PID cannot prove ownership has expired. These local kernel
// endpoints remain exclusively bound throughout send/recovery and disappear
// when their process exits. Linux's abstract socket has no stale pathname.
// Capture the scope once: a host rename must not change an active owner's key.
// Abstract sockets are network-namespace scoped on Linux, so shared files from
// a different namespace must not be mistaken for an exited local owner.
const lockScope=(()=>{
  if(process.platform==='win32')return ['win32',os.hostname()];
  if(process.platform==='linux'){
    try{return ['linux',os.hostname(),fs.readlinkSync('/proc/self/ns/net')];}catch{return null;}
  }
  return null;
})();
const supportsLockGuard=lockScope!==null;
const lockOwnerToken=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function lockGuardKey(filename) {
  const canonical=process.platform==='win32'?filename.toLowerCase():filename;
  return hash(JSON.stringify([lockScope,canonical]));
}

function publicationTwin(filename) {
  // This is the only permitted two-link state: our exact, complete publication
  // staging file and its authoritative lock, in the same checked directory.
  // Never follow a link, trust a path from JSON, or allow an additional alias.
  try {
    const stat=fs.lstatSync(filename);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==2 || stat.size>4096)return null;
    const record=JSON.parse(fs.readFileSync(filename,'utf8'));
    if(record?.schemaVersion!==2 || record.protocol!=='kernel-guard-v1' || record.guardKey!==lockGuardKey(filename) || typeof record.ownerToken!=='string' || !lockOwnerToken.test(record.ownerToken))return null;
    const staging=`${filename}.${record.ownerToken}.tmp`,other=fs.lstatSync(staging);
    if(!other.isFile() || other.isSymbolicLink() || other.nlink!==2 || other.dev!==stat.dev || other.ino!==stat.ino || !stat.ino)return null;
    return staging;
  }catch{return null;}
}
async function acquireLockGuard(filename) {
  if(!supportsLockGuard)return {supported:false,release:async()=>{}};
  const key=lockGuardKey(filename);
  const address=process.platform==='win32'?`\\\\.\\pipe\\context-relay-lock-${key}`:`\0context-relay-lock-${key}`;
  const server=net.createServer(socket=>socket.destroy());
  await new Promise((resolve,reject)=>{
    server.once('error',e=>reject(error(e.code==='EADDRINUSE'?'RECEIPT_LOCKED':'LOCK_GUARD_UNAVAILABLE',e.code==='EADDRINUSE'?'回执仍有活跃操作；不能恢复或重复发送。':'无法取得本机排他锁证明；保留锁，不自动发送。')));
    server.listen({path:address,exclusive:true},resolve);
  });
  server.unref();
  let released=false;
  return {supported:true,release:async()=>{
    if(released)return;released=true;
    await new Promise(resolve=>server.close(resolve));
  }};
}

function publishReceiptLock(filename,record) {
  // Publish only a complete, durable record. A crash while writing the staging
  // file leaves no malformed authoritative lock and never records send intent.
  const temp=checkedPath(`${filename}.${record.ownerToken}.tmp`);
  let fd;
  try {
    fd=fs.openSync(temp,'wx');fs.writeFileSync(fd,JSON.stringify(record));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.linkSync(temp,filename); // Atomic create-if-absent; never replace a lock.
  } finally {
    if(fd!==undefined)fs.closeSync(fd);
    try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}
  }
}
function busy(thread) {return thread?.status?.type==='active' || thread?.turns?.some(turn=>turn.status==='inProgress');}
function assertIdle(thread) {
  if(busy(thread))throw error('TARGET_BUSY','目标 task 正在运行。请等当前回合结束后再发送；不会主动 steer。');
  if(!['idle','notLoaded'].includes(thread?.status?.type))throw error('TARGET_STATE_UNKNOWN','无法确认目标 task 当前空闲，发送已阻止。');
}
function assertProvider(thread) {if(thread.modelProvider!=='openai')throw error('AUTH_MODE_MISMATCH','目标 task 未使用 OpenAI ChatGPT provider；不自动切换 provider 或 API 计费。');}
function visibleAuth(account,config,{host=false}={}) {
  const type=account?.account?.type || 'none';
  const c=config?.config;
  if(!c)return {type,verified:false,code:'AUTH_UNVERIFIED',message:'无法通过公开 config/read 核验模型 provider；发送已阻止。'};
  const provider=c.model_provider || 'openai';
  const custom=c.model_providers?.[provider];
  const conflict=provider!=='openai' || c.forced_login_method==='api' || custom?.env_key || custom?.experimental_bearer_token || custom?.base_url;
  if(conflict || type!=='chatgpt')return {type,provider,verified:false,code:type==='none'&&!conflict?'NOT_LOGGED_IN':'AUTH_MODE_MISMATCH',message:type==='none'&&!conflict?(host?hostLoginHint:loginHint):'当前连接的登录方式或 provider 配置不是已核验的 ChatGPT 模式。请修正独立 profile / 宿主连接配置；不会回退到 API 计费。'};
  return {type,provider,verified:true,message:'公开 account/read 返回 ChatGPT；provider 配置已核验。额度以实际账号为准。'};
}

/** All writes go to receiptDir under the project. No private session/database reads. */
export function createBridge(config={}) {
  const requested=config.mode || 'export-only';
  if(!['export-only','managed-app-server','host-ws','host-proxy'].includes(requested))throw error('CONFIG_ERROR','未知 bridge mode。');
  if(config.transportFactory && config.fixture!==true)throw error('CONFIG_ERROR','注入 transport 仅供显式标记 fixture 的契约测试。');
  const receiptDir=checkedPath(config.receiptDir || runtimePath('receipts'),{directory:true,create:true});
  const identity=hash(JSON.stringify({mode:requested,endpoint:config.endpoint||null,sock:config.sock||null,profile:runtimePath('codex-profile')}));
  let transport=null,connecting=null,readSequence=0,capability={mode:'export-only',requestedMode:requested,connected:false,canRead:false,canSend:false,readVerified:false,readThreadId:null,readVerifiedAt:null,reason:'尚未探测；可导出或复制到 Codex 提问。',nativeMessageSelection:false,nativeComposer:false,evidence:config.fixture?'fixture-contract':'live'};
  const historyLimits={maxPages:40,maxTurns:2000,maxItems:10000,maxBytes:16*1024*1024,timeoutMs:45000};
  for(const [key,value] of Object.entries(config.historyLimits || {})) {
    if(!Object.hasOwn(historyLimits,key) || !Number.isSafeInteger(value) || value<1 || value>historyLimits[key])throw error('CONFIG_ERROR','历史读取上限必须为受支持范围内的正整数。');
    historyLimits[key]=value;
  }
  const clearReadEvidence=()=>{
    capability={...capability,mode:capability.connected&&requested==='managed-app-server'?'managed-app-server':'export-only',canSend:false,readVerified:false,readThreadId:null,readVerifiedAt:null,readError:null,reason:'目标历史尚未读取或验证已失效；尚未启用发送。'};
    return ++readSequence;
  };
  const finished=new Map();
  const receiptFile=id=>{if(!/^[a-f0-9]{64}$/.test(id))throw error('BAD_RECEIPT_ID','回执 ID 无效。');return checkedPath(path.join(receiptDir,id+'.json'));};
  const receipt=id=>{try {return JSON.parse(fs.readFileSync(receiptFile(id),'utf8'));}catch(e){if(e.code==='ENOENT')throw error('RECEIPT_NOT_FOUND','未找到回执。');throw e;}};
  const save=(r,changes={})=>{
    // A concurrent read-only reconciliation must not be downgraded by an older waiter.
    const persisted=receipt(r.id);
    if(persisted.deliveryAttempted && ['completed','failed'].includes(persisted.status))return structuredClone(persisted);
    Object.assign(r,persisted,changes,{updatedAt:now()});writeReceipt(receiptFile(r.id),r);return structuredClone(r);
  };
  const lockFile=id=>{
    receiptFile(id);const filename=path.join(checkedPath(receiptDir),id+'.lock');
    try{return checkedPath(filename);}catch(e){
      if(e.code!=='REPARSE_PATH')throw e;
      // Permit inspection of this one crash state, not general hardlink I/O.
      // diagnose/send do not remove it; explicit recovery checks it again while
      // holding the kernel guard before deleting only the derived staging twin.
      if(publicationTwin(filename))return filename;
      return checkedPath(filename); // The publisher may just have removed its twin.
    }
  };
  const lockSnapshot=filename=>{
    let raw;
    try{raw=fs.readFileSync(filename,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}
    let record=null;try{record=JSON.parse(raw);}catch{}
    return {token:hash(raw),record};
  };
  const lock=async id=>{
    const filename=lockFile(id),guard=await acquireLockGuard(filename);
    const record={schemaVersion:2,protocol:guard.supported?'kernel-guard-v1':'file-exclusive-v1',guardKey:lockGuardKey(filename),ownerToken:crypto.randomUUID(),pid:process.pid,createdAt:now()};
    let snapshot;
    try {
      publishReceiptLock(filename,record);snapshot=lockSnapshot(filename);
    } catch(e) {
      await guard.release();
      if(e.code==='EEXIST')throw error('RECEIPT_LOCKED','存在遗留或正在处理的回执锁；请先诊断锁。已尝试发送的回执仅可只读核对，不自动重发。');
      throw e;
    }
    return async()=>{
      try {
        // Never unlink another generation, even if an external tool changed it.
        if(lockSnapshot(filename)?.token===snapshot.token)fs.unlinkSync(filename);
      } finally {await guard.release();}
    };
  };
  const recoveryReceipt=id=>{
    const r=receipt(id);
    if(r.id!==id)throw error('RECEIPT_CORRUPT','回执内容与文件标识不一致；保留锁，不能恢复。');
    if(r.connectionId!==identity)throw error('CONNECTION_MISMATCH','请使用回执原连接诊断或恢复锁。');
    return r;
  };
  function lockDiagnosis(r,filename,snapshot,ownerState,guardAvailable) {
    const record=snapshot?.record;
    const recognized=record?.schemaVersion===2 && record.protocol==='kernel-guard-v1' && record.guardKey===lockGuardKey(filename) && typeof record.ownerToken==='string' && lockOwnerToken.test(record.ownerToken);
    if(ownerState!=='active')ownerState=!snapshot?'none':guardAvailable&&recognized?'inactive':'unverifiable';
    const result={receiptId:r.id,status:r.status,deliveryAttempted:r.deliveryAttempted,locked:!!snapshot||ownerState==='active',ownerState,lockToken:snapshot?.token || null,recoverable:false};
    const explain=(code,reason)=>({...result,code,reason});
    // Unknown intent is never converted to a retryable prepared receipt.
    if(r.deliveryAttempted!==false || !['prepared','failed'].includes(r.status) || r.submittedAt || r.turnId || r.delivered)
      return explain('DELIVERY_REQUIRES_RECONCILE','回执已尝试发送或发送意图不明确；只读核对目标历史，不能恢复后重发。');
    if(ownerState==='active')return explain('LOCK_OWNER_ACTIVE','本机内核锁仍由活跃操作持有；不能按时间或 PID 夺锁。');
    if(!snapshot)return explain('NO_LOCK','没有遗留锁；本操作未发送正文。');
    if(!guardAvailable)return explain('LOCK_OWNER_UNVERIFIABLE','当前平台或权限无法核验内核锁所有者；保留锁和回执，不自动发送。');
    if(!recognized)
      return {...explain('LOCK_OWNER_UNVERIFIABLE','旧版、损坏或不同本机命名空间的锁缺少可证明的所有者信息；不会自动删除。请保留回执和锁，停止原发送进程并由维护人员核验，或导出引用包；不要通过改正文绕过去重。'),ownerState:'unverifiable'};
    try {
      validatePack(r.pack);
      if(r.id!==hash(identity+'\n'+r.targetThreadId+'\n'+renderPrompt(r.pack)) || r.preview!==`${renderPrompt(r.pack)}\n\n[Context Relay Receipt: ${r.id}]` || hash(r.preview)!==r.bodyHash)throw new Error('Receipt mismatch');
    } catch {return explain('RECEIPT_CORRUPT','回执原文、标识或哈希不一致；保留锁，先检查原回执，不允许恢复后发送。');}
    return {...explain('LOCK_OWNER_INACTIVE','已在本机取得同一排他内核锁，确认原操作不再持有它；回执未记录发送意图。可明确请求释放遗留锁，再单独确认发送。'),ownerState:'inactive',recoverable:true};
  }
  async function diagnoseReceiptLock(id) {
    recoveryReceipt(id);const filename=lockFile(id);
    let guard;
    try {guard=await acquireLockGuard(filename);}
    catch(e) {
      if(!['RECEIPT_LOCKED','LOCK_GUARD_UNAVAILABLE'].includes(e.code))throw e;
      return lockDiagnosis(recoveryReceipt(id),filename,lockSnapshot(filename),e.code==='RECEIPT_LOCKED'?'active':'unverifiable',false);
    }
    try {const snapshot=lockSnapshot(filename);return lockDiagnosis(recoveryReceipt(id),filename,snapshot,snapshot?'unverifiable':'none',guard.supported);}
    finally {await guard.release();}
  }
  async function recoverReceiptLock(id,{expectedLockToken,confirm=false}={}) {
    if(confirm!==true)throw error('RECOVERY_CONFIRM_REQUIRED','必须明确确认释放遗留锁；恢复不会发送正文。');
    if(typeof expectedLockToken!=='string' || !/^[a-f0-9]{64}$/.test(expectedLockToken))throw error('LOCK_TOKEN_REQUIRED','请先诊断并提供当时的 lockToken；不允许盲目恢复。');
    recoveryReceipt(id);const filename=lockFile(id),guard=await acquireLockGuard(filename);
    try {
      const snapshot=lockSnapshot(filename);
      if(snapshot?.token!==expectedLockToken)throw error('LOCK_CHANGED','锁已消失或发生变化；请重新诊断。未发送正文。');
      const r=recoveryReceipt(id),diagnosis=lockDiagnosis(r,filename,snapshot,'unverifiable',guard.supported);
      if(!diagnosis.recoverable)throw error(diagnosis.code,diagnosis.reason);
      // All cooperating senders/recoverers hold this guard. An exited owner
      // cannot unlock later, and a new sender cannot enter before this unlink.
      const twin=publicationTwin(filename);
      if(twin)fs.unlinkSync(twin);
      checkedPath(filename); // No other hardlink/reparse exception is allowed.
      fs.unlinkSync(filename);
      return {receiptId:id,recovered:true,lockToken:expectedLockToken,status:r.status,deliveryAttempted:false,note:'遗留锁已释放；回执、预览和正文哈希未修改。尚未发送，请另行明确确认发送。'};
    } finally {await guard.release();}
  }
  async function connect() {
    if(requested==='export-only')throw error('EXPORT_ONLY','未配置宿主连接；使用 Markdown/JSON 导出或复制到 Codex 提问。');
    if(transport && !transport.closed)return transport;
    if(connecting)return connecting;
    connecting=(async()=>{
      const t=config.transportFactory?await config.transportFactory(config):new AppServerTransport(config);
      transport=t;
      t.on('notification',notification=>{
        if(transport!==t || t.closed)return;
        if(notification.method==='turn/completed') {const p=notification.params;finished.set(`${p.threadId}:${p.turn?.id}`,p.turn);if(finished.size>128)finished.delete(finished.keys().next().value);}
        if(notification.method==='account/updated')capability={...capability,auth:null,canSend:false,reason:'账号状态已变化；发送前必须重新核验。'};
      });
      t.on('disconnect',()=>{if(transport!==t)return;clearReadEvidence();finished.clear();capability={...capability,mode:'export-only',connected:false,canRead:false,canSend:false,auth:null,reason:'连接已断开；目标读取证据已清除，提交中的回执必须只读核对。'};});
      try {await t.open();const server=await t.request('initialize',{clientInfo:{name:'context_relay',title:'Context Relay',version:packageVersion},capabilities:{experimentalApi:true}});t.notify('initialized');clearReadEvidence();capability={...capability,connected:true,auth:null,serverVersion:server?.userAgent || null};return t;}catch(e){t.close();transport=null;throw e;}
    })();
    try{return await connecting;}finally{connecting=null;}
  }
  async function list({cursor=null,limit=30}={}) {
    const t=await connect();const result=await t.request('thread/list',{cursor,limit:Math.min(100,Math.max(1,Number(limit)||30)),archived:false,useStateDbOnly:true});
    if(!Array.isArray(result?.data))throw error('PROTOCOL_ERROR','thread/list 未返回 data 数组。');
    return {data:result.data,nextCursor:result.nextCursor || null};
  }
  function checkedThread(response,threadId) {
    if(response?.thread?.id!==threadId || !Array.isArray(response.thread.turns))throw error('PROTOCOL_ERROR','thread/read 未返回明确指定目标的历史。');
    return response.thread;
  }
  async function readMetadata(t,threadId) {return checkedThread(await t.request('thread/read',{threadId,includeTurns:false}),threadId);}
  async function read(threadId) {
    clearReadEvidence();
    if(typeof threadId!=='string' || !threadId.trim())throw error('TARGET_REQUIRED','请选择已有 task。');
    const t=await connect();const attempt=clearReadEvidence();
    const budget={pages:0,turns:0,items:0,bytes:0,deadline:Date.now()+historyLimits.timeoutMs};
    const incomplete=message=>error('HISTORY_INCOMPLETE',message+' 未返回部分历史；请导入完整导出文件或检查目标连接。');
    const checkDeadline=()=>{if(Date.now()>=budget.deadline)throw error('HISTORY_LIMIT','历史读取超过时间上限；未返回部分历史。');};
    async function historyRequest(method,params) {
      checkDeadline();
      try {
        const result=await t.request(method,params,Math.min(config.timeoutMs || 10000,Math.max(1,budget.deadline-Date.now())));
        checkDeadline();return result;
      }catch(e){checkDeadline();throw e;}
    }
    function accountBytes(value) {
      budget.bytes+=Buffer.byteLength(JSON.stringify(value),'utf8');
      if(budget.bytes>historyLimits.maxBytes)throw error('HISTORY_LIMIT','历史超过本次读取的字节上限；未返回部分历史。请显式导入所需历史。');
    }
    async function page(method,params) {
      if(++budget.pages>historyLimits.maxPages)throw error('HISTORY_LIMIT','历史读取超过页数上限；未返回部分历史。');
      let result;
      try {result=await historyRequest(method,params);}catch(e){if(e.code==='RPC_REJECTED')throw incomplete(`${method} 被当前 App Server 拒绝或不受支持。`);throw e;}
      if(!Array.isArray(result?.data) || (result.nextCursor!=null && (typeof result.nextCursor!=='string' || !result.nextCursor)))throw incomplete(`${method} 返回无效的分页结构。`);
      accountBytes(result);return result;
    }
    function checkItems(items,seen) {
      if(!Array.isArray(items))throw incomplete('回合缺少 items。');
      for(const item of items) {
        if(!item || typeof item.id!=='string' || !item.id || typeof item.type!=='string' || seen.has(item.id))throw incomplete('历史项目缺少标识或出现重复，无法可靠绑定来源。');
        seen.add(item.id);if(++budget.items>historyLimits.maxItems)throw error('HISTORY_LIMIT','历史项目数量超过上限；未返回部分历史。');
      }
      return items;
    }
    async function fullTurn(turn) {
      if(!turn || typeof turn.id!=='string' || !turn.id || !['completed','failed','interrupted','inProgress'].includes(turn.status))throw incomplete('历史回合缺少标识或有效状态。');
      if(++budget.turns>historyLimits.maxTurns)throw error('HISTORY_LIMIT','历史回合数量超过上限；未返回部分历史。');
      const itemIds=new Set(); // Source identity is thread + turn + item; do not assume global item IDs.
      if(turn.itemsView==null || turn.itemsView==='full')return {...turn,items:checkItems(turn.items,itemIds),itemsView:'full'};
      if(!['summary','notLoaded'].includes(turn.itemsView))throw incomplete('未知 itemsView 不能作为原文。');
      const items=[],cursors=new Set();let cursor=null;
      do {
        const response=await page('thread/items/list',{threadId,turnId:turn.id,limit:100,sortDirection:'asc',cursor});
        const part=response.data.map(entry=>{if(entry?.turnId!==turn.id || !entry.item)throw incomplete('分页项目返回了不同回合。');return entry.item;});
        items.push(...checkItems(part,itemIds));cursor=response.nextCursor ?? null;
        if(cursor!==null && cursors.has(cursor))throw incomplete('项目分页游标重复，停止读取。');
        if(cursor!==null)cursors.add(cursor);
      }while(cursor!==null);
      return {...turn,items,itemsView:'full'};
    }
    try {
      const metadata=checkedThread(await historyRequest('thread/read',{threadId,includeTurns:false}),threadId);accountBytes(metadata);
      const turnIds=new Set(),turns=[];
      const addTurns=async values=>{for(const turn of values){if(turnIds.has(turn?.id))throw incomplete('回合分页出现重复 ID，停止读取。');turnIds.add(turn?.id);turns.push(await fullTurn(turn));}};
      let source=metadata;
      if(metadata.historyMode==='paginated') {
        const cursors=new Set();let cursor=null;
        do {
          const response=await page('thread/turns/list',{threadId,limit:50,sortDirection:'asc',itemsView:'full',cursor});
          await addTurns(response.data);cursor=response.nextCursor ?? null;
          if(cursor!==null && cursors.has(cursor))throw incomplete('回合分页游标重复，停止读取。');
          if(cursor!==null)cursors.add(cursor);
        }while(cursor!==null);
      } else {
        if(metadata.historyMode!=null && metadata.historyMode!=='legacy')throw incomplete('未知 historyMode。');
        source=checkedThread(await historyRequest('thread/read',{threadId,includeTurns:true}),threadId);accountBytes(source);
        if(source.historyMode!=null && source.historyMode!=='legacy')throw incomplete('历史模式在读取中变化或不受支持。');
        await addTurns(source.turns);
      }
      checkDeadline();
      if(transport!==t || t.closed)throw error('DISCONNECTED','历史读取时连接已变化；本次结果未标记为已验证。');
      if(attempt===readSequence)capability={...capability,mode:requested.startsWith('host-')?'verified-host-bridge':'managed-app-server',connected:true,canRead:true,canSend:capability.auth?.verified===true,readVerified:true,readThreadId:threadId,requestedThreadId:threadId,readVerifiedAt:now(),readError:null,error:null,reason:`已只读核验明确目标 ${threadId} 的历史。${capability.auth?.verified?'发送前仍将重新核验目标和账号。':'发送尚需核验 ChatGPT 登录方式。'}`};
      return {...source,turns};
    }catch(e){if(attempt===readSequence){clearReadEvidence();capability={...capability,readError:publicError(e),reason:e.message};}throw e;}
  }
  async function authCheck() {
    const t=await connect();const account=await t.request('account/read',{refreshToken:false});
    let configuration;try{configuration=await t.request('config/read',{includeLayers:false,cwd:ROOT});}catch{return visibleAuth(account,null,{host:requested.startsWith('host-')});}
    return visibleAuth(account,configuration,{host:requested.startsWith('host-')});
  }
  async function probe({threadId}={}) {
    if(requested==='export-only')return {...capability,reason:'未配置连接：可导出 JSON/Markdown，或复制到 Codex 提问（降级入口）。'};
    try {
      const t=await connect();clearReadEvidence();const threads=await list({limit:10});let readError=null;
      let auth;try{auth=await authCheck();}catch{auth={type:'unknown',verified:false,code:'AUTH_UNVERIFIED',message:'无法核验登录方式；发送已阻止。'};}
      capability={...capability,auth};
      if(threadId!==undefined)try{await read(threadId);}catch(e){readError=publicError(e);}
      if(transport!==t || t.closed)throw error('DISCONNECTED','探测期间连接已变化；请重新选择目标验证。');
      const readVerified=threadId!==undefined&&!readError&&capability.readVerified&&capability.readThreadId===threadId;
      const host=requested.startsWith('host-');const mode=host?(readVerified?'verified-host-bridge':'export-only'):'managed-app-server';
      capability={...capability,mode,connected:true,canRead:true,canSend:auth.verified&&readVerified,auth,readVerified,requestedThreadId:threadId??null,readError,error:null,visibleThreadCount:threads.data.length,probedAt:now(),reason:readError?readError.message:!auth.verified?auth.message:!readVerified?'握手与列表读取成功；请明确选择已有 task 后验证其历史，尚未启用发送。':host?'已通过显式宿主连接完成握手，并读取明确指定的目标历史。':'独立 profile managed App Server 与明确目标已核验；不代表已连接当前 Codex 桌面。'};
    } catch(e) {clearReadEvidence();capability={...capability,mode:'export-only',connected:false,canRead:false,canSend:false,error:publicError(e),reason:e.message};}
    return structuredClone(capability);
  }
  async function prepare({pack,targetThreadId,body}={}) {
    validatePack(pack);
    if(typeof targetThreadId!=='string'||!targetThreadId.trim())throw error('TARGET_REQUIRED','请选择已有目标 task。');
    const text=renderPrompt(pack);
    if(body!==undefined && body!==text)throw error('PREVIEW_MISMATCH','发送正文必须与引用包生成的预览相同。请修改引用包后重新准备。');
    const id=hash(identity+'\n'+targetThreadId+'\n'+text);
    const existing=fs.existsSync(receiptFile(id));if(existing)return receipt(id);
    const preview=`${text}\n\n[Context Relay Receipt: ${id}]`;
    const record={schemaVersion:'1',id,packId:pack.packId,connectionId:identity,connectionMode:requested,targetThreadId,turnId:null,status:'prepared',deliveryAttempted:false,preview,bodyHash:hash(preview),pack:structuredClone(pack),createdAt:now(),updatedAt:now(),evidence:config.fixture?'fixture-contract':'live',note:'准备完成；尚未发送。'};
    try {writeReceipt(receiptFile(id),record,{exclusive:true});}catch(e){if(e.code==='EEXIST')return receipt(id);throw e;}
    return structuredClone(record);
  }
  const applyTurn=(r,turn)=>{
    const status=turn.status==='completed'?'completed':terminal.has(turn.status)?'failed':'submitted';
    return save(r,{status,turnId:turn.id,turnStatus:turn.status,delivered:true,error:turn.status==='failed'?{code:'TURN_FAILED',message:'目标 App Server 回合失败；原引用包和回执已保留。'}:null,note:status==='completed'?'已收到真实回合完成证据。':status==='failed'?'已交付，但目标回合失败或被中断。':'已核验目标回合正在运行；不得重复发送。'});
  };
  async function waitForTurn(r,t) {
    const known=finished.get(`${r.targetThreadId}:${r.turnId}`);if(known)return applyTurn(r,known);
    return new Promise(resolve=>{
      let done=false;const finish=(turn,cause)=>{if(done)return;done=true;clearTimeout(timer);t.off('notification',onEvent);t.off('disconnect',onClose);resolve(turn?applyTurn(r,turn):save(r,{status:'unknown',error:publicError(cause),note:'可能已送达；请只读核对已有回合。禁止自动重发。'}));};
      const onEvent=({method,params})=>{if(method==='turn/completed'&&params.threadId===r.targetThreadId&&params.turn?.id===r.turnId)finish(params.turn);};
      const onClose=()=>finish(null,error('DISCONNECTED','连接中断，交付状态未知。'));
      const timer=setTimeout(()=>finish(null,error('TIMEOUT','等待回合完成超时，交付状态未知。')),config.completionTimeoutMs || 45000);
      t.on('notification',onEvent);t.once('disconnect',onClose);if(t.closed)onClose();
    });
  }
  async function send(id) {
    let r=receipt(id);const unlock=await lock(id);
    try {
      r=receipt(id);
      if(r.connectionId!==identity)throw error('CONNECTION_MISMATCH','回执属于另一连接，不能发送。');
      if(r.deliveryAttempted || !['prepared','failed'].includes(r.status))return structuredClone(r);
      try {
        validatePack(r.pack);
        if(r.preview!==`${renderPrompt(r.pack)}\n\n[Context Relay Receipt: ${r.id}]` || hash(r.preview)!==r.bodyHash)throw error('RECEIPT_CORRUPT','回执正文或原引用包已变化；发送已阻止。请重新准备引用包。');
        const c=await probe({threadId:r.targetThreadId});if(!c.canSend)throw error(c.readError?.code || c.auth?.code || c.error?.code || 'BRIDGE_UNVERIFIED',c.reason);
        const t=await connect();const before=await readMetadata(t,r.targetThreadId);assertIdle(before);assertProvider(before);
        const resumed=await t.request('thread/resume',{threadId:r.targetThreadId,excludeTurns:true});
        if(resumed?.thread?.id!==r.targetThreadId)throw error('PROTOCOL_ERROR','thread/resume 返回了不同目标。');
        assertIdle(resumed.thread);assertProvider(resumed.thread);
        // Recheck after resuming. The public protocol has no atomic "start if idle" field.
        const latest=await readMetadata(t,r.targetThreadId);assertIdle(latest);assertProvider(latest);
        const auth=await authCheck();if(!auth.verified)throw error(auth.code,auth.message);
        save(r,{status:'submitted',deliveryAttempted:true,submittedAt:now(),note:'已在本地持久记录发送意图；等待 App Server 回执。',error:null});
        let response;
        try {response=await t.request('turn/start',{threadId:r.targetThreadId,clientUserMessageId:r.id,input:[{type:'text',text:r.preview,text_elements:[]}],model:'gpt-6-astra',effort:'ultra',approvalPolicy:'never',sandboxPolicy:{type:'readOnly'}},config.timeoutMs || 10000);}
        catch(e){return save(r,{status:e.code==='RPC_REJECTED'?'failed':'unknown',error:publicError(e),note:e.code==='RPC_REJECTED'?'App Server 明确拒绝本次请求；保留回执，不自动重试。':'提交结果未知；只读核对目标历史，不自动重发。'});}
        if(!response?.turn?.id)return save(r,{status:'unknown',error:{code:'PROTOCOL_ERROR',message:'turn/start 未提供 turn ID。'},note:'可能已送达；保留回执并只读核对。'});
        save(r,{turnId:response.turn.id,delivered:true,note:'App Server 已接收；等待回合完成。'});
        if(terminal.has(response.turn.status))return applyTurn(r,response.turn);
        return await waitForTurn(r,t);
      }catch(e){return save(r,{status:r.deliveryAttempted?'unknown':'failed',error:publicError(e),note:r.deliveryAttempted?'交付未知；不得自动重发。':'发送前检查失败，未发送正文。修正后可以明确再次发送。'});}
    } finally {await unlock();}
  }
  async function reconcile(id) {
    const r=receipt(id);
    if(r.connectionId!==identity)throw error('CONNECTION_MISMATCH','请使用回执原连接核对。');
    if(!r.deliveryAttempted || ['completed','failed'].includes(r.status))return structuredClone(r);
    try {
      const thread=await read(r.targetThreadId);
      const matches=thread.turns.filter(turn=>r.turnId?turn.id===r.turnId:turn.items?.some(item=>item.type==='userMessage'&&item.content?.some(c=>c.type==='text'&&c.text===r.preview)));
      if(matches.length===1)return applyTurn(r,matches[0]);
      return save(r,{status:'unknown',note:matches.length>1?'发现多个匹配回合，需要人工核对；不重发。':'当前只读历史无法确认是否送达；可能尚未持久化或历史未完整返回。不重发。'});
    }catch(e){return save(r,{status:'unknown',error:publicError(e),note:'目标暂时不可达；引用包和草稿仍在。恢复连接后只读核对。'});}
  }
  return {probe,list,read,prepare,send,reconcile,diagnoseReceiptLock,recoverReceiptLock,receipt,receipts:()=>fs.readdirSync(receiptDir).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).map(name=>receipt(name.slice(0,-5))),close:async()=>{transport?.close();transport=null;},capabilities:()=>structuredClone(capability)};
}
