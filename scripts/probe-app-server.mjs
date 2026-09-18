import {spawnSync} from 'node:child_process';
import {createBridge,codexChildEnv} from '../src/integrations.mjs';
import {ROOT,runtimePath,writeText,storageReport} from '../src/paths.mjs';

// This probe performs no thread/start, thread/resume, turn/start or model request.
const env=codexChildEnv();
const command=process.env.RELAY_CODEX_PATH || 'codex';
const common=['-c','cli_auth_credentials_store="file"','-c',`sqlite_home=${JSON.stringify(env.CODEX_SQLITE_HOME.replaceAll('\\','/'))}`];
function inspect(args) {
  const r=spawnSync(command,[...common,...args],{env,cwd:ROOT,encoding:'utf8',shell:false,windowsHide:true,timeout:10000,maxBuffer:2*1024*1024});
  return {exitCode:r.status,error:r.error?.code||null,stdout:(r.stdout||'').trim()};
}
const inspected={version:inspect(['--version']),appServerHelp:inspect(['app-server','--help']),proxyHelp:inspect(['app-server','proxy','--help'])};
const config={mode:process.env.RELAY_BRIDGE_MODE || 'managed-app-server',codexPath:command,endpoint:process.env.RELAY_APP_SERVER_URL,sock:process.env.RELAY_APP_SERVER_SOCK,timeoutMs:10000};
const bridge=createBridge(config);
let report;
try {
  const capability=await bridge.probe();
  let missingTarget;
  if(capability.canRead)try{await bridge.read('00000000-0000-0000-0000-000000000000');missingTarget={expectedFailure:false};}catch(e){missingTarget={expectedFailure:true,code:e.code,message:e.message};}
  report={generatedAt:new Date().toISOString(),kind:'real-read-only-probe',inspection:inspected,capability,missingTarget,storage:storageReport(),modelRequestExecuted:false,turnStartExecuted:false,desktopHostVerified:capability.mode==='verified-host-bridge',scope:'Only the explicitly configured App Server is inspected. No private database, auth file or desktop history scan.'};
}finally{await bridge.close();}
const filename=runtimePath('validation','app-server-probe.json');writeText(filename,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({reportPath:filename,capability:report.capability,missingTarget:report.missingTarget,version:report.inspection.version.stdout,modelRequestExecuted:false},null,2));
if(!report.capability.connected)process.exitCode=1;
