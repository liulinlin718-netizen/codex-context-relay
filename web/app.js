import {createDraftStore} from './draft-store.js';
const $=id=>document.getElementById(id);
let token,history=null,pack=null,preview=null,receipt=null,modelController,exportUrl,selectionCounter=0,selectionQueue=Promise.resolve();
let draftId=new URL(location.href).searchParams.get('draft')||'main',draftRevision=null,draftReady=false;
let threadCursor=null,threadListBusy=false;
const roles={user:'用户原话',assistant:'模型建议',tool:'工具',system:'系统原文',developer:'开发者原文',unknown:'未知角色'};
const stateLabels={prepared:'已准备，尚未发送',submitted:'已提交，等待完成',completed:'已完成',failed:'发送失败',unknown:'交付未知，禁止自动重发'};
function node(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function notice(text=''){$('notice').textContent=text;}
async function api(action,data={},signal){const response=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json','x-relay-token':token},body:JSON.stringify({action,data}),signal});const out=await response.json();if(!response.ok)throw Object.assign(new Error(out.error?.message||'请求失败'),{code:out.error?.code||'HTTP_ERROR'});return out;}
async function run(work){try{await work();}catch(e){notice(`${e.code||'操作失败'} · ${e.message}。当前草稿仍保留。`);}}
const drafts=createDraftStore({save:async snapshot=>{
  const result=await api('draft-save',{...snapshot,draftId,expectedRevision:draftRevision});
  draftId=result.draftId;draftRevision=result.revision;
  const url=new URL(location.href);if(draftId==='main')url.searchParams.delete('draft');else url.searchParams.set('draft',draftId);
  window.history.replaceState(null,'',url);
  $('draft-location').textContent=draftId==='main'?'默认草稿':'独立草稿 · 此地址可恢复';
  if(result.branched)notice('另一窗口已修改原稿；本窗口已另存为独立草稿，两份内容都保留。');
},onStatus:(status,error)=>{$('draft-status').textContent={saving:'正在保存…',saved:'草稿已保存',error:'草稿未保存，请重试'}[status];$('retry-save').hidden=status!=='error';if(error)notice(`保存失败：${error.message}。当前页面保留了修改，请重试保存后再关闭。`);}});
function persist(){if(draftReady)void drafts.update({history,pack,selectionCounter,question:$('question').value});}
$('retry-save').onclick=()=>drafts.flush();
function downloadText(content,filename){const url=URL.createObjectURL(new Blob([content],{type:'application/json;charset=utf-8'}));const link=node('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
async function draftList(host=$('draft-list')){const result=await api('draft-list');host.replaceChildren();for(const item of result.drafts){const row=node('div',undefined,'draft-row');const url=new URL('/',location.href);if(item.draftId!=='main')url.searchParams.set('draft',item.draftId);const link=node('a',`${item.draftId===draftId?'当前 · ':''}${item.title}`);link.href=url;link.target='_blank';link.rel='noopener';row.append(link,node('span',`${item.excerpts||0} 条引用 · ${item.savedAt?new Date(item.savedAt).toLocaleString():''}`,'small'));const backup=node('button','下载完整备份','plain');backup.onclick=()=>run(async()=>{const data=await api('draft-download',{draftId:item.draftId});downloadText(data.content,data.filename)});row.append(backup);host.append(row);}if(!result.drafts.length)host.textContent='暂无保存的草稿。';}
$('draft-library').ontoggle=()=>{if($('draft-library').open)void run(draftList)};
$('refresh-drafts').onclick=()=>run(draftList);
$('boot-retry').onclick=()=>location.reload();
$('boot-drafts').onclick=()=>run(()=>draftList($('boot-draft-list')));
$('boot-new').onclick=()=>run(async()=>{const result=await api('draft-new');location.assign('/?draft='+result.draftId)});
$('boot-backup').onclick=()=>run(async()=>{const data=await api('draft-download',{draftId});downloadText(data.content,data.filename)});
window.addEventListener('beforeunload',event=>{if(drafts.pending()){event.preventDefault();event.returnValue='';}});
function mutate(){preview=null;receipt=null;$('send').disabled=true;$('reconcile').disabled=true;persist();}
function requirePack(){if(!pack?.excerpts.length)throw new Error('请先选择至少一条引用');pack.question=$('question').value;return pack;}
function sameMessage(x,m){
  if(x.sourceKind!==m.sourceKind||x.sourceUri!==m.sourceUri||x.sourceThreadId!==m.threadId||x.sourceTurnId!==m.turnId||x.sourceItemId!==m.messageId)return false;
  return x.sourceItemId!==null ? true : x.sourceLocalId===m.localId&&x.sourceHash===m.clientHash;
}
async function hashHistory(){if(history)for(const m of history.messages)m.clientHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(m.text)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
function addSelection(m,start=0,end=m.text.length){
  const selectedHistory=history;
  selectionQueue=selectionQueue.catch(()=>{}).then(()=>commitSelection(selectedHistory,m,start,end));
  return selectionQueue;
}
async function commitSelection(selectedHistory,m,start,end){
  if(start===end)throw new Error('请先在原文中选中一段文字');
  if(pack?.excerpts.some(x=>sameMessage(x,m)&&x.range.start===start&&x.range.end===end))return notice('这段原文已在引用篮中。');
  const result=await api('pack',{history:selectedHistory,selections:[{localId:m.localId,start,end}],question:$('question').value});
  result.pack.question=$('question').value;
  if(!pack){pack=result.pack;selectionCounter=1;}else {const x=result.pack.excerpts[0];selectionCounter=Math.max(selectionCounter,...pack.excerpts.map(q=>q.selectionOrder))+1;x.selectionOrder=selectionCounter;x.label=`引用 ${x.selectionOrder}`;pack.excerpts.push(x);}
  notice();render();mutate();
}
function removeExcerpt(id){pack.excerpts=pack.excerpts.filter(x=>x.id!==id);pack.memory=pack.memory.filter(m=>!m.sourceExcerptIds.includes(id));if(!pack.excerpts.length){pack=null;selectionCounter=0;$('question').value='';}render();mutate();notice('引用已移除；依赖该引用的背景也已移除，剩余编号不会复用。请检查问题中的引用标号。');}
function renderHistory(){
  $('history-name').textContent=history?.title||(pack?'引用包快照':'尚未导入');
  const host=$('messages');host.replaceChildren();
  if(!history){host.append(node('p',pack?'已载入引用包。点击引用标号可看来源与精确快照；导入对应历史可复检。':'导入历史开始选择，或载入明确标注的演示 fixture。','message muted'));return;}
  for(const m of history.messages){
    const selected=pack?.excerpts.some(x=>sameMessage(x,m));const article=node('article',undefined,`message${selected?' selected':''}`);
    const head=node('div',undefined,'message-head');head.append(node('span',roles[m.role]||m.role,'role'));const label=node('label');const check=node('input');check.type='checkbox';check.checked=!!selected;check.setAttribute('aria-label',`引用整条 ${m.localId}`);label.append(check,document.createTextNode(' 引用整条'));head.append(label);article.append(head);
    const text=node('textarea');text.value=m.text;text.readOnly=true;text.rows=Math.min(10,Math.max(3,Math.ceil(m.text.length/36)));text.setAttribute('aria-label',`原文 ${m.localId}`);article.append(text);
    article.append(node('div',`${m.timestamp||'时间未知'} · 消息 ID ${m.messageId||'未知'} · ${m.sourceKind}`,'message-meta'));
    const btn=node('button','＋ 引用选中片段','range-button');btn.onclick=()=>run(()=>addSelection(m,text.selectionStart,text.selectionEnd));article.append(btn);
    check.onchange=()=>run(async()=>{if(check.checked)await addSelection(m);else {const ids=pack.excerpts.filter(x=>sameMessage(x,m)).map(x=>x.id);for(const id of ids)if(pack)removeExcerpt(id);}});
    host.append(article);
  }
}
function showSource(x){const m=history?.messages.find(m=>sameMessage(x,m));$('source').textContent=`${x.label} · ${roles[x.role]}\n来源：${x.sourceUri||'未知'}\nThread：${x.sourceThreadId||'未知'}\nTurn：${x.sourceTurnId||'未知'}\nMessage：${x.sourceItemId||'未知'}\n时间：${x.timestamp||'未知'}\n范围：${x.range.start}–${x.range.end}（UTF-16）\n原消息 SHA-256：${x.sourceHash}\n选段 SHA-256：${x.excerptHash}\n\n固定引用快照：\n${x.exactText}\n\n${m?'当前已读取的消息：\n'+m.text:'当前没有原消息；保留上述快照，不伪造跳转。'}`;$('source-dialog').showModal();}
function renderExcerpts(){const host=$('excerpts');host.replaceChildren();$('count').textContent=`${pack?.excerpts.length||0} 条引用`;
  if(!pack){host.append(node('p','勾选整条消息，或在原文中选中一段再加入。','muted'));return;}
  for(const x of pack.excerpts){const row=node('article',undefined,'excerpt');const h=node('div',undefined,'excerpt-head');const a=node('a',`[${x.label}] · ${roles[x.role]}`);a.href='#';a.onclick=e=>{e.preventDefault();showSource(x)};h.append(a);const del=node('button','移除','plain small');del.setAttribute('aria-label',`移除${x.label}`);del.onclick=()=>removeExcerpt(x.id);h.append(del);row.append(h,node('blockquote',x.exactText),node('div',`${x.sourceItemId||'消息 ID 未知'} · ${x.range.start}–${x.range.end} · ${x.sourceUri||'来源未知'}`,'small'));host.append(row);}
}
function addMemory(suggestion){requirePack();pack.memory.push({id:`memory-${crypto.randomUUID()}`,kind:'background',text:suggestion?.text||pack.excerpts[0].exactText,sourceExcerptIds:suggestion?.sourceExcerptIds||[pack.excerpts[0].id],status:suggestion?'model-proposed':'user-confirmed',version:1,included:!suggestion});renderMemories();mutate();}
function renderMemories(){const host=$('memories');host.replaceChildren();if(!pack)return;
  for(const m of pack.memory){const row=node('div',undefined,'memory');const check=node('input');check.type='checkbox';check.checked=m.included;check.setAttribute('aria-label',`确认发送背景 ${m.id}`);check.onchange=()=>{m.included=check.checked;if(check.checked)m.status='user-confirmed';m.version++;renderMemories();mutate()};row.append(check);const body=node('div');const text=node('textarea');text.value=m.text;text.rows=2;text.setAttribute('aria-label',`背景正文 ${m.id}`);text.oninput=()=>{m.text=text.value;m.version++;m.status='user-confirmed';mutate()};body.append(text);const controls=node('div',undefined,'memory-controls');const kind=node('select');for(const [v,t]of Object.entries({background:'背景',constraint:'约束',decision:'决定','open-question':'未决问题'})){const o=node('option',t);o.value=v;kind.append(o)}kind.value=m.kind;kind.onchange=()=>{m.kind=kind.value;m.version++;mutate()};controls.append(kind);const refs=node('select');refs.multiple=true;refs.size=Math.min(3,pack.excerpts.length);refs.setAttribute('aria-label',`背景来源 ${m.id}`);for(const x of pack.excerpts){const o=node('option',x.label);o.value=x.id;o.selected=m.sourceExcerptIds.includes(x.id);refs.append(o)}refs.onchange=()=>{m.sourceExcerptIds=[...refs.selectedOptions].map(o=>o.value);m.version++;mutate()};controls.append(refs,node('span',`${m.status==='model-proposed'?'模型提议 · 待确认':'用户确认'} / v${m.version}`,'small'));body.append(controls);row.append(body);const del=node('button','×','plain');del.setAttribute('aria-label',`删除背景 ${m.id}`);del.onclick=()=>{pack.memory=pack.memory.filter(q=>q.id!==m.id);renderMemories();mutate()};row.append(del);host.append(row);}
}
function render(){renderHistory();renderExcerpts();renderMemories();$('question').value=pack?.question||$('question').value;}
async function applyImport(result){if(result.draft){({history,pack,selectionCounter}=result.draft);$('question').value=result.draft.question;}else if(result.pack){pack=result.pack;history=null;selectionCounter=Math.max(...pack.excerpts.map(x=>x.selectionOrder));$('question').value=pack.question;}else history=result.history;await hashHistory();render();mutate();notice(result.fixture?'当前是离线演示 fixture，不是宿主对话，也没有真实模型输出。':(result.history?.warnings||[]).join(' '));}
$('file').onchange=()=>run(async()=>{const f=$('file').files[0];if(!f)return;try{const result=await api('import',{text:await f.text(),sourceUri:`user-selected-file:${f.name}`});await selectionQueue.catch(()=>{});if((result.pack||result.draft)&&(pack?.excerpts.length||$('question').value)&&!confirm('载入此文件会替换当前引用、背景和问题。继续？'))return;await applyImport(result);}finally{$('file').value='';}});
$('demo').onclick=()=>run(async()=>{if(pack?.excerpts.length&&!confirm('载入演示会替换当前引用和背景。继续？'))return;const result=await api('demo');await selectionQueue.catch(()=>{});pack=null;selectionCounter=0;$('question').value='';await applyImport(result)});
$('add-memory').onclick=()=>run(()=>addMemory());
$('question').oninput=()=>{if(pack)pack.question=$('question').value;mutate()};
$('preview').onclick=()=>run(async()=>{requirePack();const mentioned=[...pack.question.matchAll(/引用\s*(\d+)/g)].map(x=>Number(x[1]));if(mentioned.some(n=>!pack.excerpts.some(x=>x.selectionOrder===n)))throw new Error('问题指向了已移除的引用，请修改标号后预览');preview=await api('preview',{pack});$('prompt').textContent=preview.prompt;$('export-result').textContent='';$('receipt').textContent='';receipt=null;for(const id of ['copy','export-json','export-md','prepare-send'])$(id).disabled=false;$('send').disabled=true;$('reconcile').disabled=true;$('preview-dialog').showModal();});
$('close-preview').onclick=()=>$('preview-dialog').close();$('close-source').onclick=()=>$('source-dialog').close();
$('copy').onclick=()=>run(async()=>{await navigator.clipboard.writeText($('prompt').textContent);$('export-result').textContent='正文已复制。请在 Codex 粘贴并发送；本操作没有自动转发。';});
for(const [id,format]of [['export-json','json'],['export-md','md']])$(id).onclick=()=>run(async()=>{const r=await api('export',{pack:preview.pack,format,download:true});if(exportUrl)URL.revokeObjectURL(exportUrl);exportUrl=URL.createObjectURL(new Blob([r.content],{type:format==='json'?'application/json':'text/markdown;charset=utf-8'}));const a=node('a','保存文件');a.href=exportUrl;a.download=r.filename;$('export-result').replaceChildren(document.createTextNode(`已校验 · ${r.bytes} bytes · 本地副本：${r.path} `),a);a.click();});
$('verify').onclick=()=>run(async()=>{requirePack();if(!history)throw new Error('请先导入相应原历史；引用快照仍保留');const r=await api('sources',{pack,history});notice(r.sources.map(x=>`${x.label}：${{unchanged:'原文一致',changed:'原文已变化，固定快照保留',missing:'无法定位，固定快照保留'}[x.status]}`).join('；'));});
$('capabilities').onclick=()=>run(async()=>{const c=await api('capabilities');notice(`伴随选择器；原生消息多选／composer 引用未接入。配置连接：${c.configuredBridge}；模型：${c.modelProvider||'未配置'}。全部受控产物：${c.storage.runtime}`);});
function showConnection(c){
  $('capabilities').textContent=c.mode;
  $('connection-status').textContent=[c.reason,c.readVerified?`已读取指定对话：${c.readThreadId}`:'尚未验证指定对话的完整历史。',c.error?`${c.error.code} · ${c.error.message}`:''].filter(Boolean).join('\n');
}
$('connect').onclick=()=>run(async()=>{const threadId=$('source-thread').value.trim();showConnection(await api('bridge-probe',threadId?{threadId}:{}));});
async function listThreads(append=false){
  if(threadListBusy)return;threadListBusy=true;$('list-threads').disabled=true;$('more-threads').disabled=true;
  const cursor=append?threadCursor:null;
  try{
    const r=await api('threads',{cursor});
    if(!append)$('threads').replaceChildren(node('option','选择已有对话，或直接填写 ID'));
    $('threads').options[0].value='';
    const ids=new Set([...$('threads').options].map(o=>o.value));
    for(const t of r.data||[]){if(!t.id||ids.has(t.id))continue;ids.add(t.id);const o=node('option',`${t.name||t.preview||'已有对话'} · ${t.id}`);o.value=t.id;$('threads').append(o)}
    threadCursor=r.nextCursor&&r.nextCursor!==cursor?r.nextCursor:null;
    $('more-threads').hidden=!threadCursor;
    const count=$('threads').options.length-1;
    $('connection-status').textContent=count?`已列出 ${count} 个已有对话${threadCursor?'；可继续加载。':'。'} 选择或填写 ID 后再读取。`:'该连接没有列出可见对话。可直接填写已知 ID；独立 profile 不会自动读取桌面历史。';
  }finally{threadListBusy=false;$('list-threads').disabled=false;$('more-threads').disabled=false;}
}
$('list-threads').onclick=()=>run(()=>listThreads());
$('more-threads').onclick=()=>run(()=>listThreads(true));
$('threads').onchange=()=>{if($('threads').value)$('source-thread').value=$('threads').value;};
$('source-thread').oninput=()=>{$('threads').value='';};
$('read-thread').onclick=()=>run(async()=>{const threadId=$('source-thread').value.trim();if(!threadId)throw new Error('请选择已有对话或填写明确的已有对话 ID');let result;try{result=await api('thread-read',{threadId});}catch(e){showConnection({mode:'export-only',reason:e.message,readVerified:false});throw e;}await selectionQueue.catch(()=>{});await applyImport(result);if(result.connection)showConnection(result.connection);});
function showReceipt(r){receipt=r;if(r.preview)$('prompt').textContent=r.preview;$('receipt').textContent=`${stateLabels[r.status]||r.status}\n目标：${r.targetThreadId}\n回合：${r.turnId||'尚无回合 ID'}\n${r.note||''}${r.error?'\n'+r.error.code+' · '+r.error.message:''}\n回执：${r.id}`;$('send').disabled=!(r.status==='prepared'||r.status==='failed'&&!r.deliveryAttempted);$('reconcile').disabled=!['submitted','unknown'].includes(r.status);}
$('prepare-send').onclick=()=>run(async()=>{const targetThreadId=$('target').value.trim();if(!targetThreadId)throw new Error('请填写明确的已有目标 ID');const r=await api('prepare',{pack:preview.pack,targetThreadId});showReceipt(r);});
$('target').oninput=()=>{receipt=null;$('send').disabled=true;$('reconcile').disabled=true;$('receipt').textContent='目标已变化，请重新准备转发。';};
$('send').onclick=()=>run(async()=>{$('send').disabled=true;showReceipt(await api('send',{receiptId:receipt.id}));});
$('reconcile').onclick=()=>run(async()=>{showReceipt(await api('reconcile',{receiptId:receipt.id}));});
$('generate').onclick=()=>run(async()=>{const requestPack=structuredClone(requirePack());modelController=new AbortController();$('generate').disabled=true;$('cancel-model').disabled=false;$('model-result').textContent='正在请求真实后端…';try{const r=await api('model',{pack:requestPack,operation:$('operation').value},modelController.signal);$('model-result').textContent=`${r.provider} / ${r.model}\n\n${r.answer}\n\n冲突：\n${(r.conflicts||[]).map(x=>x.text).join('\n')||'未返回冲突'}\n\n背景建议待确认：${r.suggestions?.length||0} 条`;
if(JSON.stringify(pack)===JSON.stringify(requestPack)){for(const s of r.suggestions||[])addMemory(s);}else{$('model-result').textContent+='\n\n当前引用或背景已变化；这份回答基于请求时的原稿，以下建议未写入：\n'+(r.suggestions||[]).map(s=>s.text).join('\n');}
}catch(e){$('model-result').textContent=`${e.code||e.name} · ${e.message}。没有生成替代答案。`;throw e;}finally{$('generate').disabled=false;$('cancel-model').disabled=true;modelController=null;}});
$('cancel-model').onclick=()=>modelController?.abort();
$('refresh-receipts').onclick=()=>run(async()=>{const list=await api('receipts');const host=$('receipts');host.replaceChildren();for(const r of list){const b=node('button',`${stateLabels[r.status]||r.status} · ${r.targetThreadId||r.target?.threadId||r.id}`);b.onclick=()=>{$('preview-dialog').showModal();showReceipt(r);preview=null;$('copy').disabled=true;$('export-json').disabled=true;$('export-md').disabled=true;$('prepare-send').disabled=true;};host.append(b)}if(!list.length)host.textContent='暂无发送回执。';});
await run(async()=>{try{({token}=await (await fetch('/bootstrap')).json());const draft=await api('draft-load',{draftId});draftRevision=draft.revision;history=draft.history;pack=draft.pack;$('question').value=draft.question??pack?.question??'';selectionCounter=Math.max(draft.selectionCounter||0,...(pack?.excerpts.map(x=>x.selectionOrder)||[0]));await hashHistory();render();draftReady=true;document.querySelector('main').inert=false;$('draft-location').textContent=draftId==='main'?'默认草稿':'独立草稿 · 此地址可恢复';if(pack||draft.question)$('draft-status').textContent='已恢复草稿';}catch(error){$('boot-error').hidden=false;$('boot-message').textContent=error.message;throw error;}});
