import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.env.RELAY_PROJECT_ROOT && path.resolve(process.env.RELAY_PROJECT_ROOT).toLowerCase() !== ROOT.toLowerCase()) throw new Error('RELAY_PROJECT_ROOT must match this project directory.');
export function checkedPath(candidate, {directory = false, create = false} = {}) {
  const full = path.resolve(candidate);
  const relative = path.relative(ROOT, full);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Object.assign(new Error('Output must remain inside this project directory.'), {code:'PATH_OUTSIDE_PROJECT'});
  let cursor = full;
  while (true) {
    let stat;try {stat=fs.lstatSync(cursor)} catch(e){if(e.code!=='ENOENT')throw e;}
    if (stat?.isSymbolicLink() || (stat?.isFile() && stat.nlink>1)) throw Object.assign(new Error('Symlink/junction/hardlink output is not allowed.'), {code:'REPARSE_PATH'});
    if (stat && fs.realpathSync.native(cursor).toLowerCase() !== cursor.toLowerCase()) throw new Error('Output ancestor realpath differs from requested path.');
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  if (create) fs.mkdirSync(directory ? full : path.dirname(full), {recursive:true});
  if (fs.existsSync(full)) {
    const actual = fs.realpathSync.native(full);
    if (actual.toLowerCase() !== full.toLowerCase()) throw new Error('Output realpath differs from requested path.');
  }
  return full;
}
export function runtimePath(...parts) { return checkedPath(path.join(ROOT, '.runtime', ...parts)); }
export function writeText(filename, text) { checkedPath(filename,{create:true}); fs.writeFileSync(filename,text,'utf8'); return filename; }
export function readJSON(filename) { return JSON.parse(fs.readFileSync(filename,'utf8').replace(/^\uFEFF/,'')); }
export function childEnv(extra = {}) {
  const env = {...process.env,...extra};
  const directories = {TEMP:'temp',TMP:'temp',TMPDIR:'temp',APPDATA:'appdata/roaming',LOCALAPPDATA:'appdata/local',XDG_CACHE_HOME:'xdg/cache',XDG_STATE_HOME:'xdg/state',XDG_DATA_HOME:'xdg/data',XDG_CONFIG_HOME:'xdg/config',npm_config_cache:'npm/cache',PYTHONPYCACHEPREFIX:'python/pycache',PLAYWRIGHT_BROWSERS_PATH:'playwright/browsers',PROJECT_BROWSER_PROFILE_DIR:'browser-profiles'};
  for (const [key, value] of Object.entries(directories)) env[key] = checkedPath(runtimePath(value),{directory:true,create:true});
  // The host's profile belongs to the host. Relocating this tool must not reuse
  // an inherited desktop or another project's login/storage directory.
  const profile = runtimePath('codex-profile');
  env.CODEX_PROJECT_PROFILE_DIR = checkedPath(profile,{directory:true,create:true});
  env.CODEX_HOME = env.CODEX_PROJECT_PROFILE_DIR;
  env.CODEX_SQLITE_HOME = checkedPath(path.join(profile,'sqlite'),{directory:true,create:true});
  // ChatGPT authentication must never silently inherit API billing credentials.
  for (const key of Object.keys(env)) if (/^(CODEX_API_KEY|CODEX_ACCESS_TOKEN|OPENAI_API_KEY|OPENAI_ACCESS_TOKEN|OPENAI_AUTH_TOKEN|AZURE_OPENAI_API_KEY)$/i.test(key)) delete env[key];
  return env;
}
export function storageReport() {
  const env = childEnv();
  return {root:checkedPath(ROOT),runtime:runtimePath(),codexHome:env.CODEX_HOME,sqliteHome:env.CODEX_SQLITE_HOME,temp:env.TEMP,browserProfile:env.PROJECT_BROWSER_PROFILE_DIR,scope:'Project-controlled artifacts only; host desktop storage is outside this process.'};
}
