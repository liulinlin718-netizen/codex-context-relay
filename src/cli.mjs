import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {dispatch,closeBridge} from './service.mjs';
import {startServer} from './server.mjs';
import {storageReport,ROOT} from './paths.mjs';
import {modelChildEnv,loginInstructions} from './models.mjs';
import {configureConnection,parseConnectionArgs,connectionHelp} from './connection-config.mjs';

const [command='help',...args]=process.argv.slice(2);
const json=value=>process.stdout.write(JSON.stringify(value,null,2)+'\n');
async function readPack(filename){if(!filename)throw new Error('Specify an explicit ContextPack file.');const r=await dispatch('import',{text:fs.readFileSync(filename,'utf8'),sourceUri:path.resolve(filename)});if(!r.pack)throw new Error('Expected a ContextPack JSON/Markdown file.');return r.pack;}
try {
  switch(command){
    case 'connection': {const options=parseConnectionArgs(args);if(options.help)process.stdout.write(connectionHelp);else {const result=await configureConnection(options);json(result);if(!result.verification.verified)process.exitCode=1;}break;}
    case 'serve': {const p=args.indexOf('--port');const app=await startServer({port:p<0?6400:Number(args[p+1])});process.on('SIGINT',async()=>{await app.close();process.exit(0)});process.on('SIGTERM',async()=>{await app.close();process.exit(0)});break;}
    case 'doctor': json({storage:storageReport(),capabilities:await dispatch('capabilities'),bridge:await dispatch('bridge-probe')});await closeBridge();break;
    case 'import': json(await dispatch('import',{text:fs.readFileSync(args[0],'utf8'),sourceUri:path.resolve(args[0])}));break;
    case 'preview': {const r=await dispatch('preview',{pack:await readPack(args[0])});process.stdout.write(r.prompt+'\n');break;}
    case 'export': json(await dispatch('export',{pack:await readPack(args[0]),format:args[1]||'json'}));break;
    case 'prepare': json(await dispatch('prepare',{pack:await readPack(args[0]),targetThreadId:args[1]}));await closeBridge();break;
    case 'send': json(await dispatch('send',{receiptId:args[0]}));await closeBridge();break;
    case 'reconcile': json(await dispatch('reconcile',{receiptId:args[0]}));await closeBridge();break;
    case 'receipts': json(await dispatch('receipts'));await closeBridge();break;
    case 'model': json(await dispatch('model',{pack:await readPack(args[0]),operation:args[1]||'answer'}));break;
    case 'login': {
      const cli=process.env.RELAY_CODEX_PATH||'codex';
      // No credential values are read or copied. This changes only the spawned CLI environment.
      const proc=spawn(cli,loginInstructions(cli).args,{cwd:ROOT,env:modelChildEnv(),shell:false,stdio:'inherit',windowsHide:true});
      proc.on('error',e=>{process.stderr.write(`${e.code}: Codex CLI unavailable.\n`);process.exitCode=1;});proc.on('exit',code=>{process.exitCode=code??1;});break;
    }
    default: process.stdout.write('Context Relay 0.2\nserve [--port 6400] | doctor | import <history> | preview <pack> | export <pack> [json|md]\nprepare <pack> <existing-thread-id> | send <receipt-id> | reconcile <receipt-id> | receipts\nmodel <pack> [answer|suggest] | login | connection --help\nRequires Node.js 22+. Data stays under this copy of the project in .runtime/.\n');
  }
}catch(e){json({error:{code:e.code||'FAILED',message:e.message},...(e.code==='CONNECTION_NOT_VERIFIED'&&e.verification?{verification:e.verification}:{})});await closeBridge().catch(()=>{});process.exitCode=1;}
