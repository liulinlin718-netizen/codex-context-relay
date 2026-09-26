import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {checkedPath, runtimePath} from './paths.mjs';

const kinds = new Set(['histories', 'excerpts', 'memories', 'revisions']);
const identifier = /^[a-f0-9]{64}$/;
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
export const snapshotHash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Immutable project-local objects. Existing corrupt objects are never repaired silently. */
export function createSnapshotStore(root = runtimePath('app-state', 'objects')) {
  root = checkedPath(root);
  const verified = new Map(); // File fingerprints only; no retained history bodies.
  function filename(kind, id) {
    if (!kinds.has(kind) || typeof id !== 'string' || !identifier.test(id)) fail('INVALID_SNAPSHOT_ID', '快照编号或类型无效。');
    return checkedPath(path.join(root, kind, `${id}.json`));
  }
  function stamp(file) {
    let stat;
    try { stat = fs.statSync(checkedPath(file), {bigint:true}); }
    catch (error) { if (error.code === 'ENOENT') fail('SNAPSHOT_MISSING', '草稿引用的原文快照不存在；原草稿未修改，请从完整备份恢复。'); throw error; }
    if (!stat.isFile()) fail('SNAPSHOT_UNREADABLE', '快照路径不是普通文件。');
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  }
  function remember(file, value) {
    verified.delete(file); verified.set(file, value);
    if (verified.size > 512) verified.delete(verified.keys().next().value);
  }
  function readRaw(kind, id) {
    const file = filename(kind, id), before = stamp(file);
    const bytes = fs.readFileSync(file);
    if (snapshotHash(bytes) !== id || stamp(file) !== before) fail('SNAPSHOT_CORRUPT', '草稿引用的快照已变化或损坏；原文件未修改，请从完整备份恢复。');
    remember(file, before); return bytes.toString('utf8');
  }
  function verify(kind, id) {
    const file = filename(kind, id);
    if (verified.get(file) !== stamp(file)) readRaw(kind, id);
    return id;
  }
  function putRaw(kind, text) {
    if (typeof text !== 'string') fail('INVALID_SNAPSHOT', '快照必须是 JSON 文本。');
    const id = snapshotHash(text), file = filename(kind, id);
    if (fs.existsSync(file)) { verify(kind, id); return id; }
    checkedPath(file, {create:true});
    const temp = checkedPath(`${file}.${randomUUID()}.tmp`); let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      // Concurrent writers of the same content hash contain identical bytes.
      if (fs.existsSync(file)) verify(kind, id);
      else fs.renameSync(temp, checkedPath(file));
      remember(file, stamp(file)); return id;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(checkedPath(temp))) fs.unlinkSync(temp);
    }
  }
  function get(kind, id) {
    try { return JSON.parse(readRaw(kind, id)); }
    catch (error) { if (error instanceof SyntaxError) fail('SNAPSHOT_CORRUPT', '快照不是有效 JSON；原文件未修改。'); throw error; }
  }
  return {put:(kind, value) => putRaw(kind, JSON.stringify(value)), putRaw, get, readRaw, verify};
}
