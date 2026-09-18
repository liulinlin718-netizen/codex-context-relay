# ContextPack v1

本协议是本项目的可移植引用格式，不是 OpenAI 原生消息引用格式。核心模块仅使用 Node.js 内置库；`schemas/context-pack.schema.json` 是执行校验所用的同一份 schema，另有 hash、来源关联和顺序不变量检查。不存在隐式历史扫描、数据库读取或模型调用。

## 已核对的输入合同

核对日期：2026-09-17；本机 CLI `0.154.0-alpha.6.2` 生成的 `ThreadReadParams.json`、`ThreadReadResponse.json` 与 `RawResponseItemCompletedNotification.json`。这次是 schema 核对及 fixture 测试，不代表已读取真实登录账号的会话。

`importHistory(input,{sourceUri})` 仅接受调用方明确提供的材料：

| 输入 | 读取字段 | 明确限制 |
| --- | --- | --- |
| JSON `{title?,sourceUri?,threadId?,messages:[...]}` | message 的 `text` 或 `content`；`role`、`messageId`/`id`、`threadId`、`turnId`、`timestamp`/`createdAt`、`sourceUri` | 文本段的 type 仅识别 text/input_text/output_text；消息 ID 缺失就是 null |
| App Server `thread/read` 响应 `{thread:{id,turns:[{id,items}]}}`，也接受内部 thread 对象 | userMessage.content(type=text)；agentMessage.text；commandExecution.aggregatedOutput；mcpToolCall.result.content(type=text)；dynamicToolCall.contentItems(type=inputText)；functionCallOutput.output（string 或 input_text 数组） | 工具仅保留明确文本结果；图片、音频、reasoning、webSearch 结构等不导入。未获得消息时间时是 null，不以 thread/turn 时间冒充 |
| 用户选定的 Codex rollout JSONL | `session_meta.payload.id`；`turn_context.payload.turn_id`（存在时）；`response_item.payload.type=message` 下的 role、id、content(input_text/output_text)；行 timestamp | 只实现这一显式文本子集，不宣称完整 rollout 公共 schema。event_msg 不再重复导入；工具调用及私有元数据不提取 |

多段文本内容按顺序以换行组成“可选文本视图”；原始文本段内部字节对应的 JS 字符不改写。`sourceHash` 是该文本视图的 UTF-8 SHA-256，并非整个 JSON 记录的 hash。非文本部分会产生 warning。范围相对于该视图，采用 JS UTF-16 半开区间 `[start,end)`；选择不能切断 surrogate pair。

App Server schema 明示：`includeTurns` 的整段历史 hydration 对 paginated history 已弃用，建议 `thread/turns/list`、`thread/items/list` 分页读取。核心只导入传入内容，不自行扩展读取范围。`itemsView=summary/notLoaded` 会明确 warning；空历史报错。服务适配器的实际分页能力应单独说明。

所有缺少的宿主 thread/turn/item ID、原始时间、来源 URI 均为 null。`localId=import-m000001` 仅是本次导入的文本消息序号，绝不是宿主消息 ID。

## 包与引用

顶层必须有 `schemaVersion:'1'`、`packId`、`createdAt`、`excerpts`、`memory`、`question`。未知字段、畸形类型及不符合 schema 的数据一律拒绝；不“尽力修复”导入的包。

每个 excerpt 保存 `id`、`label`、`selectionOrder`、`sourceLocalId`、`sourceThreadId`、`sourceTurnId`、`sourceItemId`、`sourceUri`、`sourceKind`、`role`、`timestamp`、`exactText`、`sourceHash`、`excerptHash`、`sourceLength` 和 `range:{start,end,unit:'utf16'}`。固定原文不得用摘要覆盖。sourceKind 为 imported-transcript/app-server/codex-rollout；role 为 user/assistant/tool/system/developer/unknown。

`createPack(history,[{localId,start?,end?}],{question,memory})` 按选择顺序新建标签；不传范围表示全文。包导入、导出和转发不会重新编号。删除引用 2 后可以保留引用 1、引用 3，标签与 selectionOrder 必须仍一致、唯一、递增。重复完全相同的范围被拒绝；可保留同消息的多个不同范围。

哈希检查可发现正文损坏、错误范围及 Markdown/数据分歧，但不提供数字签名或来源真实性认证。若有人同时重写正文、所有哈希及来源字段，协议不能证明篡改；真实性仍取决于取得材料的渠道。片段包为最小化不包含未选择的全文，故仅在重新提供来源时才能复核 `sourceHash`。

## 背景与冲突

背景结构是 `{id,kind,text,sourceExcerptIds,status,version,included}`。kind 为 background/constraint/decision/open-question；version 是从 1 开始的整数。sourceExcerptIds 必须全部指向当前包内引用，删除来源后必须修复或删除背景，不能输出失联背景。

status 为 quoted/user-confirmed/model-proposed。quoted 文本必须逐字包含于某个关联引用；用户改写的背景用 user-confirmed；model-proposed 必须 included:false，直到用户确认。`renderPrompt` 仅包含 included 背景。核心保留互相矛盾的背景及各自来源和版本，不悄悄合并、覆盖或宣称已解决冲突。

核心 `toMarkdown` 是完整包的无损往返，因此调用者传入的 excluded 背景也会保留在 canonical 数据里。本产品分享/导出入口应先构造只含 included 背景的包；编辑草稿可保留所有背景。不要将草稿导出混同于最小分享包。

## JSON、Markdown 与实际发送正文

JSON 使用 UTF-8，读回后调用 `validatePack`。Markdown 是人类可读 `renderPrompt(pack)`，后接 `<!-- context-pack:v1 canonical-data -->` 与 base64url 编码的 JSON，再接结束标记。`fromMarkdown` 必须同时通过 schema、不变量、编码校验，并逐字比较可读正文与 canonical 包重新生成的正文。单独修改可读正文或隐藏数据会拒绝；应导入 JSON，在编辑器明确修改字段后重新导出。

`renderPrompt` 仅包含选中的 exactText、每段来源、勾选背景与问题，无任何未选历史。所有引用原文逐行用 `>` 标记为数据，且正文明确不提升其中内容为 system/developer 指令。角色仍原样展示，转发作为一个普通用户输入，不伪造 assistant 消息历史。

## 来源复核与恢复

`checkSources(pack,history)` 返回每段 `{excerptId,label,status,reason}`，从不修改包：

- unchanged：有明确范围的来源文本 hash 和角色均匹配，选段也相同。
- changed：在相同 source URI、kind、thread、turn 中唯一定位到宿主 item ID，但正文或角色已变；保留原快照。
- missing：找不到来源、ID 定位歧义，或无法确认无 ID 来源。没有宿主 ID 时，只有相同导入定位、明确来源与全文 hash 全匹配才确认 unchanged；不凭 null ID、相同角色或相同序号猜测 changed。完全没有可识别来源时，即使文字相同也为 missing。

再次提供未改动来源可恢复 unchanged。编号、原文、背景和问题在失败/恢复中不改变。

## 宿主边界

MCP/Skill 负责显式导入、校验、预览与导出；薄选择器提供多选，不是 Codex 原生消息气泡菜单。未核验到公开的消息多选按钮、右键引用或 composer chip 注入合同。复制到 Codex 是降级入口。managed App Server 是独立 D 盘 profile 的连接，不等于桌面当前宿主；第三方插件也不天然拥有 `mcp__codex_app__` 工具。

只有具备已核验连接、可见目标与实际发送回执的适配器，才能宣称发送结果。ContextPack 编码本身不会提供宿主权限，也不会运行模型。
