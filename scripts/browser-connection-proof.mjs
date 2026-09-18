import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {ROOT, childEnv, checkedPath, runtimePath, writeText} from '../src/paths.mjs';
import {buildRelease} from './package.mjs';

// Optional development dependency; install explicitly before this check.
const {chromium} = await import('playwright');
const browser = process.env.RELAY_BROWSER_EXECUTABLE || undefined;
const runRoot = checkedPath(runtimePath('validation', `browser-release-${randomUUID()}`), {directory:true,create:true});
const release = buildRelease(path.join(runRoot,'包 renamed','codex-context-relay'));
const {startServer} = await import(pathToFileURL(path.join(release.directory,'src/server.mjs')));
const app = await startServer({port:6405, quiet:true});
const context = await chromium.launchPersistentContext(checkedPath(path.join(runRoot,'profile'), {directory:true,create:true}), {
  executablePath:browser, headless:true, viewport:{width:1360,height:1000}, acceptDownloads:true,
  downloadsPath:checkedPath(path.join(runRoot,'downloads'), {directory:true,create:true}), env:childEnv(),
});
const page = context.pages()[0] || await context.newPage();
const errors=[],requests=[];
const report={checkedAt:new Date().toISOString(),release:release.directory,fixture:true,checks:[],notProven:['Real host history, login, model inference or delivery; connection responses below are browser-route fixtures']};
page.on('pageerror',e=>errors.push(e.message));
let listFails=false,readFails=false;
const connection=id=>({mode:'verified-host-bridge',readVerified:true,readThreadId:id,reason:'fixture：明确指定的历史已读取。'});
const historyFor=id=>({threadId:id,title:'连接恢复 fixture',messages:[{localId:'fixture-message',messageId:'fixture-item',threadId:id,turnId:'fixture-turn',sourceKind:'app-server',sourceUri:`app-server:${id}`,role:'user',text:'Fixture budget is 271. Keep this exact source.',timestamp:null}],warnings:[]});
try {
  await page.route('**/api',async route=>{
    const {action,data}=route.request().postDataJSON();
    if(!['bridge-probe','threads','thread-read'].includes(action))return route.continue();
    requests.push({action,data});
    let body,status=200;
    if(action==='bridge-probe')body=data.threadId?connection(data.threadId):{mode:'export-only',readVerified:false,reason:'fixture：握手成功；请指定已有对话 ID。'};
    if(action==='threads'){
      if(listFails){status=400;body={error:{code:'DISCONNECTED_FIXTURE',message:'fixture list interrupted'}};}
      else body=data.cursor?{data:[{id:'page-two',name:'第二页 fixture'},{id:'page-one',name:'重复项'}],nextCursor:null}:{data:[{id:'page-one',name:'第一页 fixture'}],nextCursor:'fixture-next'};
    }
    if(action==='thread-read'){
      if(readFails){status=400;body={error:{code:'HISTORY_INCOMPLETE',message:'fixture：历史项目未完整加载，请恢复连接后重试。'}};}
      else body={history:historyFor(data.threadId),connection:connection(data.threadId)};
    }
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(app.url);
  await page.locator('main:not([inert])').waitFor();
  await page.locator('.connection summary').click();
  writeText(path.join(runRoot,'connection-initial-snapshot.txt'),await page.locator('body').ariaSnapshot());
  await page.locator('#connect').click();
  await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('尚未验证指定对话'));
  assert.deepEqual(requests.at(-1),{action:'bridge-probe',data:{}});
  assert.equal(requests.filter(r=>r.action==='thread-read').length,0);
  report.checks.push('no-ID handshake does not request any history');
  await page.locator('#source-thread').fill('known-id-outside-list');
  await page.locator('#connect').click();
  await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('已读取指定对话：known-id-outside-list'));
  assert.deepEqual(requests.at(-1).data,{threadId:'known-id-outside-list'});
  report.checks.push('probe forwards precisely the explicit thread ID');
  await page.locator('#read-thread').click();
  await page.getByRole('textbox',{name:'原文 fixture-message',exact:true}).waitFor();
  await page.getByRole('checkbox',{name:'引用整条 fixture-message',exact:true}).check();
  await page.waitForFunction(()=>document.querySelectorAll('.excerpt').length===1);
  await page.locator('#question').fill('Does 引用 1 allow 272?');
  await page.getByText('草稿已保存',{exact:true}).waitFor();
  report.checks.push('known ID reads without listing; exact source becomes a saved quote');
  await page.locator('#list-threads').click();
  await page.locator('#more-threads:not([hidden])').waitFor();
  await page.locator('#threads').selectOption('page-one');
  assert.equal(await page.locator('#source-thread').inputValue(),'page-one');
  listFails=true;
  await page.locator('#more-threads').click();
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('DISCONNECTED_FIXTURE'));
  assert.equal(await page.locator('#threads').inputValue(),'page-one');
  assert.equal(await page.locator('.excerpt').count(),1);
  assert.equal(await page.locator('#more-threads').isDisabled(),false);
  report.checks.push('next-page failure preserves prior options, explicit selection and draft');
  listFails=false;
  await page.locator('#more-threads').click();
  await page.waitForFunction(()=>document.querySelector('#more-threads').hidden);
  assert.equal(await page.locator('#threads option').count(),3);
  assert.equal(requests.at(-1).data.cursor,'fixture-next');
  await page.locator('#threads').selectOption('page-two');
  assert.equal(await page.locator('#source-thread').inputValue(),'page-two');
  report.checks.push('pagination retry reuses cursor, deduplicates IDs and selects second-page target');
  readFails=true;
  await page.locator('#read-thread').click();
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('HISTORY_INCOMPLETE'));
  assert.equal(await page.locator('.excerpt').count(),1);
  assert.equal(await page.locator('#question').inputValue(),'Does 引用 1 allow 272?');
  assert.equal(await page.locator('#capabilities').textContent(),'export-only');
  report.checks.push('incomplete history does not replace draft or leave verified badge');
  readFails=false;
  await page.locator('#read-thread').click();
  await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('已读取指定对话：page-two'));
  assert.equal(await page.locator('.excerpt').count(),1);
  await page.getByText('草稿已保存',{exact:true}).waitFor();
  await page.locator('#preview').click();
  await page.locator('#preview-dialog[open]').waitFor();
  assert.ok((await page.locator('#prompt').textContent()).includes('app-server:known-id-outside-list'));
  await page.locator('#close-preview').click();
  report.checks.push('recovered history load preserves earlier exact-source quote and preview');
  await page.reload();
  await page.waitForFunction(()=>document.querySelectorAll('.excerpt').length===1);
  assert.equal(await page.locator('#question').inputValue(),'Does 引用 1 allow 272?');
  await page.locator('.connection summary').click();
  await page.locator('#source-thread').fill('known-id-outside-list');
  await page.locator('#connect').click();
  await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('已读取指定对话：known-id-outside-list'));
  report.checks.push('draft survives reload after connection failure and recovery');
  await page.locator('.connection').screenshot({path:checkedPath(path.join(runRoot,'connection-desktop.png'))});
  await page.setViewportSize({width:390,height:844});
  await page.locator('.connection').scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('.connection').screenshot({path:checkedPath(path.join(runRoot,'connection-mobile.png'))});
  report.checks.push('mobile connection controls fit without horizontal page overflow');
  assert.deepEqual(errors,[]);
  report.requests=requests;report.pageErrors=errors;report.passed=true;
} catch(error){report.passed=false;report.error={message:error.message,stack:error.stack};throw error;}
finally{
  writeText(path.join(runRoot,'report.json'),JSON.stringify(report,null,2)+'\n');
  writeText(runtimePath('validation','browser-connection-latest.json'),JSON.stringify({...report,runRoot},null,2)+'\n');
  await context.close();await app.close();
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,runRoot},null,2));
}