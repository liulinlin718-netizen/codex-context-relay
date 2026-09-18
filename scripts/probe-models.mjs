import { spawn } from 'node:child_process';
import { generate, probeModels, modelChildEnv, loginInstructions } from '../src/models.mjs';
import { checkedPath, runtimePath, writeText, readJSON, ROOT } from '../src/paths.mjs';

// Default is read-only capability/auth probing. An inference needs --execute AND a pack path.
const args=process.argv.slice(2);
const value=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const recordPath=runtimePath('validation', args.includes('--execute')?'model-execution.json':'model-probe.json');
const record={at:new Date().toISOString(),provider:'unconfigured',model:'gpt-6-astra',inferenceRequested:args.includes('--execute'),inferenceExecuted:false};
try {
  const config=value('--config') ? readJSON(checkedPath(value('--config'))) : {provider:value('--provider')??'codex-cli',model:'gpt-6-astra',effort:'ultra'};
  if(!['external-api','codex-cli'].includes(config.provider)) throw Object.assign(new Error('Choose external-api or codex-cli.'),{code:'MODEL_CONFIG_INVALID'});
  record.provider=config.provider; record.model=config.model??'gpt-6-astra';
  if(args.includes('--login-device')) {
    if(args.includes('--execute')) throw Object.assign(new Error('Login and inference are separate commands; probe after login first.'),{code:'MODEL_CONFIG_INVALID'});
    const info=loginInstructions(config.codexCli?.executable??'codex');
    if(/\.(cmd|bat|ps1)$/i.test(info.executable)) throw new Error('Choose a native Codex executable.');
    const child=spawn(info.executable,info.args,{cwd:ROOT,env:modelChildEnv(config),shell:false,windowsHide:true,stdio:'inherit'});
    process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??1));});
    console.log('Login command finished. Run this script without --login-device to verify actual ChatGPT auth mode.');
  } else if(args.includes('--execute')) {
    if(!value('--pack')) throw Object.assign(new Error('--execute requires --pack <reviewed ContextPack JSON>. It may consume the configured account quota/API credits.'),{code:'MODEL_INVALID_INPUT'});
    const pack=readJSON(checkedPath(value('--pack')));const started=Date.now();
    const result=await generate({pack,operation:value('--operation')??'answer'},config);
    record.inferenceExecuted=true;record.elapsedMs=Date.now()-started;record.status='completed';record.usage=result.usage;
    const output=runtimePath('exports','model-answer.json');writeText(output,JSON.stringify(result,null,2));
    record.output=output;writeText(recordPath,JSON.stringify(record,null,2));console.log(JSON.stringify(record,null,2));
  } else {
    Object.assign(record,await probeModels(config),{status:'probe-complete'});
    writeText(recordPath,JSON.stringify(record,null,2));console.log(JSON.stringify(record,null,2));
  }
} catch(problem) {
  if(args.includes('--execute')) record.inferenceExecuted=null;
  if(problem.details) Object.assign(record,problem.details);
  record.status='blocked';record.code=problem.code??'MODEL_PROBE_FAILED';
  record.message=problem.code?problem.message:'Probe could not launch or parse the provided local configuration. No raw credential/output was logged.';
  record.note='No successful model answer was produced. A failed --execute attempt may have reached the provider; no automatic retry was made.';
  writeText(recordPath,JSON.stringify(record,null,2));console.log(JSON.stringify(record,null,2));process.exitCode=1;
}
