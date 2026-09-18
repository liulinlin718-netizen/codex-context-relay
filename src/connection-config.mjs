import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createBridge} from './integrations.mjs';
import {checkedPath, runtimePath} from './paths.mjs';

const failure = (code, message) => Object.assign(new Error(message), {code});
const modes = new Set(['export-only', 'managed-app-server', 'host-ws', 'host-proxy']);
const fields = new Map([['--mode','mode'], ['--endpoint','endpoint'], ['--sock','sock'], ['--thread','threadId'], ['--codex-path','codexPath']]);
const allowed = new Set([...fields.values(), 'save']);
export const connectionHelp = `connection --mode export-only [--save]
connection --mode managed-app-server [--codex-path <executable>] [--thread <existing-id>] [--save]
connection --mode host-ws --endpoint ws://127.0.0.1:6400 --thread <existing-id> [--save]
connection --mode host-proxy --sock <authorized-socket> [--codex-path <executable>] --thread <existing-id> [--save]
Without --save, only the explicit candidate is probed and relay.json is unchanged.
Host configuration can be saved only after the specified existing task is read successfully.
Managed mode uses this copy's independent .runtime/codex-profile; it is not the desktop history.
No task is created and no message is sent. Restart the selector and MCP process after saving.
`;

function validateOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !allowed.has(key))) throw failure('CONNECTION_ARGUMENT', 'Unsupported connection option. Run connection --help.');
  if (!modes.has(options.mode)) throw failure('CONNECTION_ARGUMENT', 'Specify one supported --mode. Run connection --help.');
  for (const field of ['endpoint','sock','threadId','codexPath']) {
    if (options[field] !== undefined && (typeof options[field] !== 'string' || !options[field].trim() || options[field] !== options[field].trim() || /[\x00-\x1f\x7f]/.test(options[field]))) throw failure('CONNECTION_ARGUMENT', 'Connection option values must be nonempty text without control characters or surrounding spaces.');
  }
  if (options.save !== undefined && typeof options.save !== 'boolean') throw failure('CONNECTION_ARGUMENT', 'save must be a boolean.');
  if (options.mode === 'host-ws') {
    let url;
    try { url = new URL(options.endpoint); } catch { throw failure('ENDPOINT_REJECTED', 'Specify an explicit local WebSocket URL on port 6400–6409.'); }
    if (!['ws:','wss:'].includes(url.protocol) || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || Number(url.port) < 6400 || Number(url.port) > 6409 || !url.port || url.username || url.password || url.search || url.hash) throw failure('ENDPOINT_REJECTED', 'Use a local WebSocket URL on port 6400–6409 without URL credentials, query parameters or fragments.');
    if (options.sock !== undefined || options.codexPath !== undefined) throw failure('CONNECTION_ARGUMENT', 'host-ws accepts --endpoint and --thread; --sock and --codex-path do not apply.');
  } else if (options.endpoint !== undefined) throw failure('CONNECTION_ARGUMENT', '--endpoint is only valid for host-ws.');
  if (options.mode === 'host-proxy' && options.sock === undefined) throw failure('SOCKET_REQUIRED', 'Specify the authorized socket with --sock; no paths will be scanned.');
  if (options.mode !== 'host-proxy' && options.sock !== undefined) throw failure('CONNECTION_ARGUMENT', '--sock is only valid for host-proxy.');
  if (options.mode === 'export-only' && (options.codexPath !== undefined || options.threadId !== undefined)) throw failure('CONNECTION_ARGUMENT', 'export-only does not accept a CLI executable or target task.');
  if (options.mode.startsWith('host-') && !options.threadId) throw failure('TARGET_REQUIRED', 'A host connection requires --thread with an existing task ID.');
  return {...options, save:options.save === true};
}

export function parseConnectionArgs(args) {
  if (args.length === 1 && args[0] === '--help') return {help:true};
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    const field = option === '--save' ? 'save' : fields.get(option);
    if (!field || Object.hasOwn(result, field)) throw failure('CONNECTION_ARGUMENT', 'Unknown or repeated connection argument. Run connection --help.');
    if (field === 'save') { result.save = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw failure('CONNECTION_ARGUMENT', 'A connection argument is missing its value. Run connection --help.');
    result[field] = value;
  }
  return validateOptions(result);
}

function readSnapshot(filename) {
  checkedPath(filename);
  let bytes;
  try { bytes = fs.readFileSync(filename); } catch (error) { if (error.code === 'ENOENT') return {bytes:null, config:{}, stamp:null}; throw error; }
  let config;
  try { config = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw failure('CONFIG_CORRUPT', 'Existing relay.json is invalid JSON. It has been left unchanged; repair or back it up before retrying.'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw failure('CONFIG_CORRUPT', 'Existing relay.json must be a JSON object. It has been left unchanged.');
  const stat = fs.statSync(filename);
  return {bytes, config, stamp:[stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')};
}

function sameSnapshot(left, right) { return left.stamp === right.stamp && (left.bytes === null ? right.bytes === null : right.bytes !== null && left.bytes.equals(right.bytes)); }
function assertUnchanged(filename, expected) {
  let current;
  try { current = readSnapshot(filename); } catch (error) { if (error.code === 'CONFIG_CORRUPT') throw failure('CONFIG_CHANGED', 'relay.json changed during validation. The newer file was preserved; inspect it and retry.'); throw error; }
  if (!sameSnapshot(expected, current)) throw failure('CONFIG_CHANGED', 'relay.json changed during validation. The newer file was preserved; inspect it and retry.');
}

function writeExclusive(filename, bytes) {
  const fd = fs.openSync(checkedPath(filename), 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function persist(filename, original, bridge) {
  checkedPath(filename, {create:true});
  const lock = checkedPath(`${filename}.connection.lock`);
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw failure('CONFIG_LOCKED', 'Another connection save is in progress or was interrupted. relay.json was preserved. Confirm no connection command is running before removing relay.json.connection.lock and retrying.'); throw error; }
  let temp;
  let backup = null;
  try {
    fs.writeFileSync(lockFd, JSON.stringify({pid:process.pid, createdAt:new Date().toISOString()}));
    fs.fsyncSync(lockFd);
    assertUnchanged(filename, original);
    if (original.bytes !== null) {
      backup = checkedPath(path.join(path.dirname(filename), `relay.backup-${randomUUID()}.json`));
      writeExclusive(backup, original.bytes);
    }
    temp = checkedPath(`${filename}.${randomUUID()}.tmp`);
    writeExclusive(temp, JSON.stringify({...original.config, bridge}, null, 2) + '\n');
    assertUnchanged(filename, original);
    fs.renameSync(temp, checkedPath(filename));
    temp = null;
    return backup;
  } finally {
    fs.closeSync(lockFd);
    if (temp && fs.existsSync(checkedPath(temp))) fs.unlinkSync(temp);
    fs.unlinkSync(checkedPath(lock));
  }
}

function publicCode(value, fallback) { return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : fallback; }
function summarize(capability, mode, threadId, fixture) {
  const host = mode.startsWith('host-');
  const evidence = fixture ? 'fixture-contract' : 'live';
  const expectedEvidence = capability.evidence === evidence;
  const readVerified = capability.readVerified === true && capability.readThreadId === threadId && Boolean(threadId);
  const verified = capability.connected === true && capability.canRead === true && expectedEvidence && !capability.error && (!threadId || readVerified) && (!host || (capability.mode === 'verified-host-bridge' && readVerified));
  const authCode = capability.auth?.verified ? null : publicCode(capability.auth?.code, 'AUTH_UNVERIFIED');
  return {
    mode:capability.mode === 'verified-host-bridge' ? 'verified-host-bridge' : capability.mode === 'managed-app-server' ? 'managed-app-server' : 'export-only',
    connected:capability.connected === true, canRead:capability.canRead === true,
    readVerified, verified, canSend:verified && capability.canSend === true,
    evidence, authVerified:capability.auth?.verified === true, authCode,
    errorCode:capability.error ? publicCode(capability.error.code, 'CONNECTION_FAILED') : capability.readError ? publicCode(capability.readError.code, 'READ_FAILED') : !expectedEvidence ? 'EVIDENCE_MISMATCH' : null
  };
}

/** Read-only candidate verification. Only an explicit save changes relay.json. */
export async function configureConnection(options, dependencies = {}) {
  options = validateOptions(options);
  const {configPath = runtimePath('app-config', 'relay.json'), bridgeFactory = createBridge, fixture = false} = dependencies;
  if (bridgeFactory !== createBridge && fixture !== true) throw failure('FIXTURE_REQUIRED', 'An injected bridge is allowed only with fixture:true.');
  const filename = checkedPath(configPath);
  const original = readSnapshot(filename);
  const bridgeConfig = {mode:options.mode};
  for (const field of ['endpoint','sock','codexPath']) if (options[field] !== undefined) bridgeConfig[field] = options[field];
  let verification;
  if (options.mode === 'export-only') verification = {mode:'export-only', connected:false, canRead:false, canSend:false, readVerified:false, verified:true, evidence:'offline', authVerified:false, authCode:null, errorCode:null};
  else {
    let bridge;
    try {
      bridge = bridgeFactory({...bridgeConfig, ...(fixture ? {fixture:true} : {})});
      const capability = await bridge.probe(options.threadId ? {threadId:options.threadId} : {});
      verification = summarize(capability, options.mode, options.threadId, fixture);
    } catch (error) {
      verification = {mode:'export-only', connected:false, canRead:false, canSend:false, readVerified:false, verified:false, evidence:fixture ? 'fixture-contract' : 'live', authVerified:false, authCode:null, errorCode:publicCode(error.code, 'CONNECTION_FAILED')};
    } finally { if (bridge) await bridge.close().catch(() => {}); }
  }
  if (options.save && !verification.verified) throw Object.assign(failure('CONNECTION_NOT_VERIFIED', 'Candidate connection did not pass verification. relay.json is unchanged. Check the explicit endpoint/socket and existing task ID, then retry.'), {verification});
  const backupPath = options.save ? persist(filename, original, bridgeConfig) : null;
  let nextStep;
  if (options.save) nextStep = 'Configuration saved. Restart the selector and MCP process to load it.';
  else if (verification.verified) nextStep = 'relay.json is unchanged. Repeat the same command with --save to persist this bridge.';
  else if (verification.errorCode === 'CLI_NOT_FOUND') nextStep = 'relay.json is unchanged. Supply --codex-path with the installed Codex executable, then retry.';
  else nextStep = 'relay.json is unchanged. Check the explicitly provided endpoint/socket and existing task ID, then retry. No addresses or private paths are scanned.';
  return {
    requestedMode:options.mode, saved:options.save, restartRequired:options.save,
    verification, configPath:filename, backupPath, nextStep,
    sendRequirement:options.mode === 'export-only' ? null : verification.authCode === 'NOT_LOGGED_IN' ? options.mode === 'managed-app-server' ? 'Sign in normally with node src/cli.mjs login for this independent profile before sending.' : 'Sign in normally to the explicitly connected host before sending.' : verification.authCode ? 'The connected server must verify ChatGPT login and the OpenAI provider before sending.' : null,
    scope:options.mode === 'managed-app-server' ? "This copy's independent .runtime/codex-profile; not the desktop history." : options.mode === 'export-only' ? 'Offline export and copy remain available.' : 'Only the explicitly authorized host endpoint/socket and specified existing task were checked.'
  };
}
