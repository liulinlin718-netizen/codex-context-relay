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
const errors = [], report = {checkedAt:new Date().toISOString(),release:release.directory,checks:[],simulatedFailures:['One HTTP 507 draft-save response'],notProven:['Real model inference','Real host installation or delivery']};
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(app.url);
  await page.locator('#demo').waitFor();
  writeText(path.join(runRoot,'initial-snapshot.txt'), await page.locator('body').ariaSnapshot());
  await page.locator('#question').fill('Keep my question even before I choose quotes.');
  await page.getByText('草稿已保存', {exact:true}).waitFor();
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#question').value === 'Keep my question even before I choose quotes.');
  report.checks.push('question without quotes survives reload');
  await page.locator('#demo').click();
  await page.getByRole('textbox', {name:'原文 import-m000001',exact:true}).waitFor();
  await page.getByRole('checkbox', {name:'引用整条 import-m000001',exact:true}).check();
  await page.getByRole('checkbox', {name:'引用整条 import-m000002',exact:true}).check();
  await page.waitForFunction(() => document.querySelectorAll('.excerpt').length === 2);
  report.checks.push('two message selections retain both source roles');
  await page.locator('#add-memory').click();
  await page.locator('.memory textarea').fill('Confirmed monthly budget: 300.');
  await page.locator('#question').fill('引用 2 是否违反引用 1？');
  await page.getByText('草稿已保存', {exact:true}).waitFor();
  let failNextSave = true;
  await page.route('**/api', async route => {
    if (failNextSave && route.request().postDataJSON()?.action === 'draft-save') {
      failNextSave = false;
      await route.fulfill({status:507,contentType:'application/json',body:JSON.stringify({error:{code:'DISK_FULL_FIXTURE',message:'Simulated disk full'}})});
    } else await route.continue();
  });
  await page.locator('#question').fill('引用 2 是否违反引用 1？请解释预算。');
  await page.locator('#retry-save:not([hidden])').waitFor();
  assert.equal(await page.locator('.excerpt').count(), 2);
  await page.locator('#retry-save').click();
  await page.getByText('草稿已保存', {exact:true}).waitFor();
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#question').value.includes('请解释预算'));
  assert.equal(await page.locator('.memory').count(), 1);
  report.checks.push('failed save keeps changes and explicit retry persists them');
  await page.locator('#file').setInputFiles({name:'broken.json',mimeType:'application/json',buffer:Buffer.from('{invalid')});
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('INVALID_HISTORY'));
  assert.equal(await page.locator('.excerpt').count(), 2);
  assert.equal(await page.locator('#file').inputValue(), '');
  report.checks.push('invalid import retains selected quotes and resets file input for retry');
  await page.locator('#preview').click();
  await page.locator('#preview-dialog[open]').waitFor();
  const prompt = await page.locator('#prompt').textContent();
  assert.ok(prompt.includes('Confirmed monthly budget: 300.'));
  assert.ok(!prompt.includes('UNSELECTED_PRIVATE_MARKER'));
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-json').click();
  const download = await downloadPromise;
  const downloadPath = checkedPath(path.join(runRoot,'downloads',download.suggestedFilename()));
  await download.saveAs(downloadPath);
  const pack = JSON.parse(fs.readFileSync(downloadPath,'utf8'));
  assert.equal(pack.excerpts.length, 2);
  assert.equal(pack.memory[0].text, 'Confirmed monthly budget: 300.');
  assert.equal(pack.question, '引用 2 是否违反引用 1？请解释预算。');
  report.checks.push('actual browser download contains selected quotes, question and confirmed context');
  await page.locator('#close-preview').click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#demo').click();
  assert.equal(await page.locator('.excerpt').count(), 2);
  assert.equal(await page.locator('#question').inputValue(), pack.question);
  report.checks.push('cancelling demo replacement preserves editing state');

  const second=await context.newPage();second.on('pageerror',error=>errors.push(error.message));
  await second.goto(app.url);
  await second.waitForFunction(()=>document.querySelector('#question').value.includes('请解释预算'));
  await page.locator('.memory textarea').fill('Focused edit must survive without blur.');
  await page.getByText('草稿已保存',{exact:true}).waitFor();
  assert.equal(await page.locator('.memory textarea').evaluate(el=>el===document.activeElement),true);
  await second.locator('#question').fill('Second window: separate question.');
  await second.getByText('草稿已保存',{exact:true}).waitFor();
  assert.ok(new URL(second.url()).searchParams.get('draft'));
  assert.equal(new URL(page.url()).searchParams.get('draft'),null);
  assert.equal(await page.locator('.memory textarea').inputValue(),'Focused edit must survive without blur.');
  assert.equal(await second.locator('.memory textarea').inputValue(),'Confirmed monthly budget: 300.');
  await second.reload();
  await second.waitForFunction(()=>document.querySelector('#question').value==='Second window: separate question.');
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('.memory textarea')?.value==='Focused edit must survive without blur.');
  report.checks.push('two windows retain distinct focused edits and restore their separate saved versions');

  await page.locator('#draft-library summary').click();
  await page.locator('#draft-list a').filter({hasText:'Second window'}).waitFor();
  const draftBackup=page.waitForEvent('download');
  await page.locator('.draft-row').filter({hasText:'Second window'}).getByRole('button',{name:'下载完整备份'}).click();
  const savedBackup=await draftBackup;
  const backupPath=checkedPath(path.join(runRoot,'downloads',savedBackup.suggestedFilename()));
  await savedBackup.saveAs(backupPath);
  const backup=JSON.parse(fs.readFileSync(backupPath,'utf8'));
  assert.equal(backup.question,'Second window: separate question.');
  assert.equal(backup.pack.excerpts.length,2);
  report.checks.push('saved draft list exposes both recoverable copies and actual complete backup download');
  await page.locator('#draft-library summary').click();

  let finishModel;
  const modelGate=new Promise(resolve=>{finishModel=resolve;});
  let startedModel;
  const modelStarted=new Promise(resolve=>{startedModel=resolve;});
  await second.route('**/api',async route=>{
    const body=route.request().postDataJSON();
    if(body?.action!=='model')return route.continue();
    startedModel();await modelGate;
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({provider:'fixture-only',model:'not-a-model',answer:'Delayed lifecycle fixture',suggestions:[{kind:'background',text:'OLD_CONTEXT_MUST_NOT_ENTER_NEW_PACK',sourceExcerptIds:[body.data.pack.excerpts[0].id]}],conflicts:[]})});
  });
  await second.locator('.model-box').first().locator('summary').click();
  await second.locator('#generate').click();await modelStarted;
  await second.locator('#question').fill('Edited while model was running.');
  finishModel();await second.waitForFunction(()=>document.querySelector('#model-result').textContent.includes('以下建议未写入'));
  assert.equal(await second.locator('.memory').count(),1);
  assert.equal(await second.locator('#question').inputValue(),'Edited while model was running.');
  report.simulatedFailures.push('One delayed model response fixture; no real model called');
  report.checks.push('late model suggestions remain tied to the original request and do not mutate a changed draft');
  second.once('dialog',dialog=>dialog.accept());
  await second.locator('#file').setInputFiles(backupPath);
  await second.waitForFunction(()=>document.querySelector('#question').value==='Second window: separate question.');
  assert.equal(await second.locator('.memory textarea').inputValue(),'Confirmed monthly budget: 300.');
  assert.equal(await second.locator('.message').count(),backup.history.messages.length);
  assert.deepEqual(await second.locator('.message textarea').evaluateAll(nodes=>nodes.map(node=>node.value)),backup.history.messages.map(message=>message.text));
  report.checks.push('complete backup import restores question, references, background and original history');
  await second.close();

  await page.screenshot({path:checkedPath(path.join(runRoot,'desktop.png')),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({path:checkedPath(path.join(runRoot,'mobile.png')),fullPage:true});
  report.checks.push('390px layout has no horizontal overflow');

  const draftFile=checkedPath(path.join(release.directory,'.runtime/app-state/draft.json'));
  const brokenDraft='{damaged original; must remain exactly intact';
  writeText(draftFile,brokenDraft);
  await page.reload();await page.locator('#boot-error:not([hidden])').waitFor();
  assert.equal(await page.locator('main').evaluate(el=>el.inert),true);
  const corruptDownload=page.waitForEvent('download');await page.locator('#boot-backup').click();
  const corruptBackup=await corruptDownload;const corruptPath=checkedPath(path.join(runRoot,'downloads','corrupt-original.json'));
  await corruptBackup.saveAs(corruptPath);
  assert.equal(fs.readFileSync(corruptPath,'utf8'),brokenDraft);
  assert.equal(fs.readFileSync(draftFile,'utf8'),brokenDraft);
  report.checks.push('damaged saved draft blocks accidental blank overwrite and downloads exact original bytes');
  await page.locator('#boot-new').click();
  await page.waitForFunction(()=>!document.querySelector('main').inert);
  await page.locator('#question').fill('Recovered with a new independent draft.');
  await page.getByText('草稿已保存',{exact:true}).waitFor();
  assert.ok(new URL(page.url()).searchParams.get('draft'));
  assert.equal(fs.readFileSync(draftFile,'utf8'),brokenDraft);
  report.checks.push('start fresh after damage preserves original bytes and saves the new draft independently');
  assert.deepEqual(errors, []);
} catch (error) {
  report.failure = {message:error.message,stack:error.stack};
  await page.screenshot({path:checkedPath(path.join(runRoot,'failure.png')),fullPage:true}).catch(() => {});
  throw error;
} finally {
  await context.close();
  await app.close();
  const evidence=JSON.stringify({...report,runRoot,errors},null,2);
  writeText(path.join(runRoot,'result.json'),evidence);
  writeText(runtimePath('validation','browser-release-latest.json'),evidence);
}
process.stdout.write(JSON.stringify({...report,runRoot},null,2)+'\n');
