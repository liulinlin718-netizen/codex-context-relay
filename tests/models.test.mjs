// All generated answers and transports in this file are CONTRACT FIXTURES.
// No model is called, and fixture success is not evidence of model quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createModelBridge, validateModelOutput, modelChildEnv, assertChatGPTProfileConfig } from '../src/models.mjs';
import { importHistory, createPack } from '../src/core.mjs';
import { ROOT, runtimePath } from '../src/paths.mjs';

const history = importHistory({messages:[{id:'fixture-user',role:'user',text:'Budget 300. Keep selected quotations unchanged.'},{id:'fixture-assistant',role:'assistant',text:'Use a service costing 499.'}]}, {sourceUri:'fixture://models-contract'});
const pack = createPack(history, history.messages.map(item => ({localId:item.localId,start:0,end:item.text.length})), {question:'Does [引用 2] violate [引用 1]?'});
const fixtureAnswer = {answer:'CONTRACT FIXTURE: [引用 2] exceeds [引用 1].', suggestions:[], conflicts:[{text:'Fixture budget conflict.',sourceExcerptIds:pack.excerpts.map(item=>item.id)}]};
const externalConfig = {provider:'external-api', externalApi:{baseURL:'https://fixture.invalid/v1',keyEnv:'RELAY_CONTRACT_KEY',style:'responses',structuredOutput:'json-schema'}};
const codexConfig = {provider:'codex-cli'};
const fixtureEnv = {RELAY_CONTRACT_KEY:'non-secret-contract-marker'};
const responseBody = (value = fixtureAnswer) => ({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}],usage:{input_tokens:10,output_tokens:15}});
const jsonResponse = (data, status=200) => new Response(JSON.stringify(data), {status,headers:{'Content-Type':'application/json'}});
const fixtureHelp = 'Usage: codex exec [OPTIONS] [PROMPT]\n--json --output-schema --ephemeral --sandbox --ignore-user-config --cd stdin';
function cliFixture({login='Logged in using ChatGPT',loginCode=0,execCode=0,stdout,stderr='',hang=false,error=false,help=fixtureHelp}={}) {
  const calls = [];
  const spawnImpl = (executable,args,options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    const call = {executable,args,options,stdin:'',killed:false}; calls.push(call);
    child.stdin.on('data', data => call.stdin += data.toString());
    child.kill = () => { call.killed = true; setImmediate(()=>child.emit('close',null,'SIGTERM')); return true; };
    setImmediate(() => {
      if (error) { child.emit('error',Object.assign(new Error('fixture ENOENT'),{code:'ENOENT'})); return; }
      const isHelp = args.includes('--help'), isLogin = args.includes('status');
      if (hang && !isHelp && !isLogin) return;
      child.stdout.end(isHelp ? help : isLogin ? '' : stdout ?? [
        {type:'thread.started',thread_id:'fixture-thread'},
        {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(fixtureAnswer)}},
        {type:'turn.completed',usage:{input_tokens:20,output_tokens:30}},
      ].map(event=>JSON.stringify(event)).join('\n'));
      child.stderr.end(isLogin ? login : stderr);
      child.emit('close',isHelp ? 0 : isLogin ? loginCode : execCode,null);
    });
    return child;
  };
  return {calls, spawnImpl};
}
function pendingFetch(_url,options) { return new Promise((_resolve,reject) => options.signal.addEventListener('abort',()=>reject(new Error('fixture abort')),{once:true})); }

test('unconfigured backend fails without transport or invented answer',async()=>{
  let called=false;
  await assert.rejects(createModelBridge({fetchImpl:async()=>{called=true;}}).generate({pack},{}),{code:'MODEL_NOT_CONFIGURED'});
  assert.equal(called,false);
});
test('missing API key is explicit and performs no request',async()=>{
  await assert.rejects(createModelBridge({env:{},fetchImpl:()=>assert.fail('No request allowed')}).generate({pack},externalConfig),{code:'MODEL_KEY_MISSING'});
});
test('Responses fixture preserves quotations and maps structured output with default model/effort',async()=>{
  let sent;
  const before=JSON.stringify(pack);
  const bridge=createModelBridge({env:fixtureEnv,fetchImpl:async(url,options)=>{sent={url:String(url),options,body:JSON.parse(options.body)};return jsonResponse(responseBody());}});
  const result=await bridge.generate({pack},externalConfig);
  assert.equal(result.provider,'external-api'); assert.equal(result.model,'gpt-6-astra'); assert.equal(sent.body.reasoning.effort,'ultra');
  assert.equal(sent.url,'https://fixture.invalid/v1/responses'); assert.equal(sent.options.redirect,'error');
  assert.equal(sent.body.text.format.type,'json_schema');
  assert.deepEqual(sent.body.text.format.schema.properties.conflicts.items.properties.sourceExcerptIds.items.enum,pack.excerpts.map(item=>item.id));
  assert.equal(JSON.parse(sent.body.input).contextPack.excerpts[0].exactText,pack.excerpts[0].exactText);
  assert.equal(JSON.stringify(pack),before); assert.equal(result.usage.output_tokens,15);
  // Compatibility is limited to genuinely omitted status, not explicit null.
  const missingStatus=responseBody();delete missingStatus.status;
  assert.equal((await createModelBridge({env:fixtureEnv,fetchImpl:async()=>jsonResponse(missingStatus)}).generate({pack},externalConfig)).answer,fixtureAnswer.answer);
});
for(const style of ['responses','chat-completions']) for(const format of ['json-schema','json-object','prompt']) test(`${style}/${format} contract is configurable without fallback`,async()=>{
  let body;
  const bridge=createModelBridge({env:fixtureEnv,fetchImpl:async(_url,options)=>{body=JSON.parse(options.body);return jsonResponse(style==='responses'?responseBody():{choices:[{finish_reason:'stop',message:{content:JSON.stringify(fixtureAnswer)}}]});}});
  await bridge.generate({pack,operation:'suggest'},{...externalConfig,externalApi:{...externalConfig.externalApi,style,structuredOutput:format}});
  const specified=style==='responses'?body.text?.format:body.response_format;
  assert.equal(specified?.type,format==='prompt'?undefined:format==='json-schema'?'json_schema':'json_object');
  if(style==='chat-completions') assert.equal(body.reasoning_effort,'ultra');
});
test('unknown source, duplicate source and unknown quote label are rejected',()=>{
  assert.throws(()=>validateModelOutput({...fixtureAnswer,suggestions:[{text:'bad',sourceExcerptIds:['not-in-pack']}]},pack),{code:'MODEL_SCHEMA_MISMATCH'});
  assert.throws(()=>validateModelOutput({...fixtureAnswer,suggestions:[{text:'bad',sourceExcerptIds:[pack.excerpts[0].id,pack.excerpts[0].id]}]},pack),{code:'MODEL_SCHEMA_MISMATCH'});
  assert.throws(()=>validateModelOutput({...fixtureAnswer,answer:'[引用 99]'},pack),{code:'MODEL_SCHEMA_MISMATCH'});
});
test('malformed API content, refusal and incomplete output are distinct',async()=>{
  for(const [body,code] of [[{output_text:'not JSON'},'MODEL_MALFORMED_OUTPUT'],[{output:[{content:[{type:'refusal'}]}]},'MODEL_REFUSED'],[{status:'incomplete'},'MODEL_INCOMPLETE'],[{...responseBody(),status:null},'MODEL_INCOMPLETE'],[{...responseBody(),status:'unknown-state'},'MODEL_INCOMPLETE']]) {
    await assert.rejects(createModelBridge({env:fixtureEnv,fetchImpl:async()=>jsonResponse(body)}).generate({pack},externalConfig),{code});
  }
});
for (const status of ['queued','in_progress']) test(`Responses fixture rejects explicit ${status} even with a schema-valid answer; explicit recovery succeeds`, async () => {
  const before=JSON.stringify(pack);
  let calls=0;
  const pending=status==='queued'?{status,output_text:JSON.stringify(fixtureAnswer)}:{...responseBody(),status};
  const bridge=createModelBridge({env:fixtureEnv,fetchImpl:async()=>jsonResponse(++calls===1?pending:responseBody())});
  await assert.rejects(bridge.generate({pack},externalConfig),{code:'MODEL_INCOMPLETE'});
  assert.equal(calls,1,'Incomplete responses must not trigger automatic retry.');
  assert.equal(JSON.stringify(pack),before);
  const recovered=await bridge.generate({pack},externalConfig);
  assert.equal(recovered.answer,fixtureAnswer.answer);
  assert.equal(calls,2);
  assert.equal(JSON.stringify(pack),before);
});
test('API failures redact raw provider body and do not retry',async()=>{
  for(const [status,body,code] of [[401,'credential marker','MODEL_AUTH_REQUIRED'],[429,'insufficient_quota','MODEL_QUOTA_EXCEEDED'],[429,'rate limited','MODEL_RATE_LIMITED'],[400,'unsupported','MODEL_REQUEST_REJECTED']]) {
    let calls=0;
    const bridge=createModelBridge({env:fixtureEnv,fetchImpl:async()=>{calls++;return jsonResponse({error:{message:body}},status);}});
    await assert.rejects(bridge.generate({pack},externalConfig),problem=>{assert.equal(problem.code,code); assert.ok(!problem.message.includes('credential marker'));return true;});
    assert.equal(calls,1);
  }
});
test('API timeout and cancellation preserve pack and allow a separate recovery request',async()=>{
  const bridge=createModelBridge({env:fixtureEnv,fetchImpl:pendingFetch});
  await assert.rejects(bridge.generate({pack,timeoutMs:20},externalConfig),{code:'MODEL_TIMEOUT'});
  const controller=new AbortController();
  const pending=bridge.generate({pack,signal:controller.signal},externalConfig); controller.abort();
  await assert.rejects(pending,{code:'MODEL_CANCELLED'});
  const result=await createModelBridge({env:fixtureEnv,fetchImpl:async()=>jsonResponse(responseBody())}).generate({pack},externalConfig);
  assert.equal(result.answer,fixtureAnswer.answer);
});
test('pre-aborted request never starts transport',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(createModelBridge({env:fixtureEnv,fetchImpl:()=>assert.fail('transport')}).generate({pack,signal:controller.signal},externalConfig),{code:'MODEL_CANCELLED'});
});
test('unsafe endpoint and unknown transport mode are rejected before key leaves server',async()=>{
  for(const api of [{baseURL:'http://example.invalid/v1'},{baseURL:'https://user:password@example.invalid/v1'},{baseURL:'http://localhost:1234/v1'},{structuredOutput:'auto'}]) {
    await assert.rejects(createModelBridge({env:fixtureEnv,fetchImpl:()=>assert.fail('transport')}).generate({pack},{...externalConfig,externalApi:{...externalConfig.externalApi,...api}}),{code:'MODEL_CONFIG_INVALID'});
  }
});
test('CLI fixture verifies ChatGPT, stdin and arrays; schema and runtime stay in project',async()=>{
  const fixture=cliFixture(); const result=await createModelBridge(fixture).generate({pack},codexConfig);
  assert.equal(result.provider,'codex-cli'); assert.equal(result.model,'gpt-6-astra');
  const last=fixture.calls.at(-1), args=last.args, schema=args[args.indexOf('--output-schema')+1];
  assert.equal(last.options.shell,false); assert.equal(last.options.windowsHide,true);assert.equal(last.options.cwd,ROOT);
  assert.equal(args.at(-1),'-');assert.equal(args[args.indexOf('-m')+1],'gpt-6-astra');assert.ok(args.includes('model_reasoning_effort="ultra"'));
  assert.ok(args.includes('--ignore-user-config'));assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
  assert.ok(schema.startsWith(runtimePath('models')));assert.equal(fs.existsSync(schema),false);
  assert.ok(last.stdin.includes(pack.excerpts[0].exactText));assert.ok(!args.some(arg=>arg.includes(pack.excerpts[0].exactText)));
  assert.ok(fixture.calls[1].args.includes('status')); assert.equal(result.usage.input_tokens,20);
});
test('CLI child removes API auth variables and preserves parent environment',()=>{
  const parent={CODEX_API_KEY:'fixture',OPENAI_API_KEY:'fixture',CODEX_ACCESS_TOKEN:'fixture',OPENAI_BASE_URL:'https://fixture.invalid',AZURE_OPENAI_API_KEY:'fixture',RELAY_PRIVATE:'fixture',CODEX_THREAD_ID:'fixture',CODEX_SESSION_ID:'fixture',CODEX_APP_TOOLS_PIPE_PATH:'fixture',CODEX_INTERNAL_ORIGINATOR_OVERRIDE:'fixture'};
  const before=JSON.stringify(parent);const result=modelChildEnv({externalApi:{keyEnv:'RELAY_PRIVATE'}},parent);
  for(const key of Object.keys(parent)) assert.equal(result[key],undefined);
  assert.equal(JSON.stringify(parent),before);assert.equal(result.CODEX_HOME,result.CODEX_PROJECT_PROFILE_DIR);
  assert.ok(result.CODEX_HOME.startsWith(ROOT));assert.ok(result.CODEX_SQLITE_HOME.startsWith(result.CODEX_HOME));assert.notEqual(result.TEMP,result.CODEX_HOME);
});
test('CLI login states refuse unverified auth without executing the model',async()=>{
  for(const [login,loginCode,code] of [['Not logged in',1,'MODEL_AUTH_REQUIRED'],['Logged in using an API key - secret-must-not-surface',0,'MODEL_AUTH_MODE_MISMATCH'],['unexpected status',0,'MODEL_AUTH_MODE_MISMATCH']]) {
    const fixture=cliFixture({login,loginCode});
    await assert.rejects(createModelBridge(fixture).generate({pack},codexConfig),problem=>{assert.equal(problem.code,code);assert.ok(!problem.message.includes('secret-must-not-surface'));return true;});
    assert.equal(fixture.calls.length,2);
  }
});
test('profile auth/provider conflicts fail closed without echoing config values',()=>{
  assertChatGPTProfileConfig('model_provider = "openai"\nforced_login_method = "chatgpt"\ncli_auth_credentials_store = "file" # fixture');
  assertChatGPTProfileConfig('# model_provider = "fixture"\nmodel = "gpt-6-astra"');
  for(const text of ['model_provider="secret-fixture"','"model_provider" = "secret-fixture"',"'forced_login_method' = 'api'",'cli_auth_credentials_store="keyring"','[model_providers.openai]\nbase_url="secret-fixture"','model_providers.openai.base_url="secret-fixture"']) {
    assert.throws(()=>assertChatGPTProfileConfig(text),problem=>{assert.equal(problem.code,'MODEL_AUTH_CONFIG_CONFLICT');assert.ok(!problem.message.includes('secret-fixture'));return true;});
  }
});
test('CLI missing binary, unsupported help and API auth config stop cleanly',async()=>{
  await assert.rejects(createModelBridge(cliFixture({error:true})).generate({pack},codexConfig),{code:'MODEL_CLI_NOT_FOUND'});
  await assert.rejects(createModelBridge(cliFixture({help:'old CLI'})).generate({pack},codexConfig),{code:'MODEL_CLI_UNSUPPORTED'});
  await assert.rejects(createModelBridge(cliFixture()).generate({pack},{...codexConfig,codexCli:{authMode:'api-key'}}),{code:'MODEL_AUTH_CONFIG_CONFLICT'});
});
test('CLI does not equate process exit with completed structured result',async()=>{
  for(const [options,code] of [[{stdout:'not-json'},'MODEL_MALFORMED_OUTPUT'],[{stdout:'{"type":"thread.started"}'},'MODEL_INCOMPLETE'],[{execCode:1,stderr:'generic failure'},'MODEL_CLI_EXIT'],[{execCode:1,stderr:'insufficient_quota'},'MODEL_QUOTA_EXCEEDED'],[{stdout:'{"type":"turn.failed","error":{"message":"rate limit"}}'},'MODEL_RATE_LIMITED']]) {
    await assert.rejects(createModelBridge(cliFixture(options)).generate({pack},codexConfig),{code});
  }
});
test('CLI cancellation kills process, removes schema and a later explicit request recovers',async()=>{
  const fixture=cliFixture({hang:true});
  await assert.rejects(createModelBridge(fixture).generate({pack,timeoutMs:1000},codexConfig),{code:'MODEL_TIMEOUT'});
  const last=fixture.calls.at(-1);assert.equal(last.killed,true);
  assert.equal(fs.existsSync(last.args[last.args.indexOf('--output-schema')+1]),false);
  assert.equal((await createModelBridge(cliFixture()).generate({pack},codexConfig)).answer,fixtureAnswer.answer);
});
test('probe reports configuration without inference',async()=>{
  const fixture=cliFixture();const probe=await createModelBridge(fixture).probeModels(codexConfig);
  assert.equal(probe.inferenceExecuted,false);assert.equal(probe.authMode,'chatgpt');assert.equal(fixture.calls.length,2);
  assert.equal((await createModelBridge({env:{}}).probeModels(externalConfig)).configured,false);
});
