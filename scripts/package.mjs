import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ROOT, checkedPath, runtimePath, writeText} from '../src/paths.mjs';

// Exact allowlist: new files must be reviewed before entering a distributable.
export const releaseFiles = [
  'package.json', 'README.md', 'DEMO.md', 'LICENSE',
  'src/cli.mjs', 'src/core.mjs', 'src/integrations.mjs', 'src/mcp.mjs',
  'src/models.mjs', 'src/paths.mjs', 'src/server.mjs', 'src/service.mjs', 'src/drafts.mjs', 'src/connection-config.mjs',
  'web/app.js', 'web/draft-store.js', 'web/index.html', 'web/style.css',
  'schemas/context-pack.schema.json', 'schemas/model-output.schema.json',
  'examples/demo-history.json', 'docs/PROTOCOL.md', 'docs/MODELS.md', 'docs/INTEGRATION.md',
  'scripts/start.ps1', 'scripts/demo.mjs', 'scripts/probe-app-server.mjs',
  'scripts/probe-models.mjs', 'scripts/configure-plugin.mjs',
];

const version=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).version;
export function buildRelease(destination = runtimePath('releases', `${version}-${randomUUID()}`, 'codex-context-relay')) {
  checkedPath(destination);
  if (fs.existsSync(destination)) throw new Error('Release destination already exists; choose a fresh directory.');
  checkedPath(destination, {create:true, directory:true});
  const copy = (source, target) => {
    const original = checkedPath(path.join(ROOT, source));
    if (!fs.lstatSync(original).isFile()) throw new Error(`Release input must be a regular file: ${source}`);
    const output = checkedPath(path.join(destination, target), {create:true});
    fs.copyFileSync(original, output);
  };
  for (const file of releaseFiles) copy(file, file);
  copy('plugin/codex-context-relay/.codex-plugin/plugin.json', '.codex-plugin/plugin.json');
  copy('plugin/codex-context-relay/skills/context-relay/SKILL.md', 'skills/context-relay/SKILL.md');
  const pkg = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'));
  delete pkg.scripts.test;
  delete pkg.scripts.package;
  writeText(path.join(destination, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  const files = [...releaseFiles, '.codex-plugin/plugin.json', 'skills/context-relay/SKILL.md'].sort().map(file => {
    const bytes = fs.readFileSync(path.join(destination, file));
    return {path:file, bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex')};
  });
  const manifest = {name:pkg.name, version:pkg.version, files, runtimeDependencies:['Node.js >=22'],
    setup:'node scripts/configure-plugin.mjs',
    excluded:['credentials', 'drafts', 'receipts', 'exports', 'logs', 'browser data', 'development evidence']};
  writeText(path.join(destination, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return {directory:destination, files:files.length + 1, bytes:files.reduce((n, file) => n + file.bytes, 0), version:pkg.version};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(buildRelease(), null, 2) + '\n');
}
