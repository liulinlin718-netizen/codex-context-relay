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

### 明确类型与通用历史的映射边界

App Server 与 rollout 使用各自规范字段，不能让通用别名覆盖已知角色和来源：

| 字段 | App Server | rollout |
| --- | --- | --- |
| role | 由 item.type 判定 user/assistant/tool | response_item.payload.role；缺失为 unknown |
| threadId / turnId | thread.id / turn.id | 最近的 session_meta.payload.id / turn_context.payload.turn_id |
| messageId | item.id | response_item.payload.id；缺失仍为 null |
| timestamp | item.timestamp；缺失为 null | response_item 行 timestamp；缺失为 null |
| sourceUri / sourceKind | 调用方传入 sourceUri / app-server | 调用方传入 sourceUri / codex-rollout |

消息上额外提供的非空 `role/threadId/turnId/messageId/sourceUri/sourceKind/timestamp/createdAt` 必须与上述字段一致，否则整个导入以 `HISTORY_PROVENANCE_CONFLICT` 失败，不返回部分历史、不改写原输入或已保存引用。相同别名可保留；空别名视为未知。时间别名可用表示同一时刻的时区格式。规范字段未知时，别名不能补造它；请修正明确格式的输入，或明确选择通用 `{messages:[...]}` 格式。每次新的 session_meta 都清除此前的 turnId，避免把旧 session 的 turn 归给新消息。

通用 `{messages}` 仍保留原有别名映射：消息自己的 threadId 优先于文档 threadId，messageId 优先于 id，sourceUri 优先于调用方/文档默认值，timestamp 优先于 createdAt。它们是提供材料者的声明，不表示已核验的宿主身份；`sourceKind` 也不是认证标志。冲突检查只保证映射一致，不证明输入真实。

## 包与引用

顶层必须有 `schemaVersion:'1'`、`packId`、`createdAt`、`excerpts`、`memory`、`question`。未知字段、畸形类型及不符合 schema 的数据一律拒绝；不“尽力修复”导入的包。

| 实际 JSON 字段 | 内容 |
| --- | --- |
| schemaVersion / packId / createdAt | 协议版本字符串 "1"、包标识、包创建时间 |
| excerpts | 至少一段选中原文；角色、范围、来源与两个哈希都在每段内部 |
| memory | 有版本和引用关联的背景；保留各自 status 与 included，不等于全部已确认 |
| question | 接收方需要回答的问题，可为空字符串 |

`items`、`background`、`provenance` 不是顶层字段或兼容别名。准确结构以 [ContextPack schema](../schemas/context-pack.schema.json) 为准。`sourceThreadId/sourceTurnId/sourceItemId/sourceUri/timestamp` 允许 null；消费者必须保留这些未知值，不得为了通过自身校验而填入虚构 ID。

每个 excerpt 保存 `id`、`label`、`selectionOrder`、`sourceLocalId`、`sourceThreadId`、`sourceTurnId`、`sourceItemId`、`sourceUri`、`sourceKind`、`role`、`timestamp`、`exactText`、`sourceHash`、`excerptHash`、`sourceLength` 和 `range:{start,end,unit:'utf16'}`。固定原文不得用摘要覆盖。sourceKind 为 imported-transcript/app-server/codex-rollout；role 为 user/assistant/tool/system/developer/unknown。

`createPack(history,[{localId,start?,end?}],{question,memory})` 按选择顺序新建标签；不传范围表示全文。包导入、导出和转发不会重新编号。删除引用 2 后可以保留引用 1、引用 3，标签与 selectionOrder 必须仍一致、唯一、递增。重复完全相同的范围被拒绝；可保留同消息的多个不同范围。

哈希检查可发现正文损坏、错误范围及 Markdown/数据分歧，但不提供数字签名或来源真实性认证。若有人同时重写正文、所有哈希及来源字段，协议不能证明篡改；真实性仍取决于取得材料的渠道。片段包为最小化不包含未选择的全文，故仅在重新提供来源时才能复核 `sourceHash`。

`sourceHash = SHA256(完整原消息可选文本视图的 UTF-8)`；`excerptHash = SHA256(exactText 的 UTF-8)`。全文引用的两个值相等，局部引用通常不同。没有完整来源时仍可验证 excerptHash，但必须把 sourceHash 标为尚未复核，不能用片段内容重算并覆盖它。`sourceLength` 和 range 均按 UTF-16 单元计数；它们不是 UTF-8 字节数。

## 背景与冲突

背景结构是 `{id,kind,text,sourceExcerptIds,status,version,included}`。kind 为 background/constraint/decision/open-question；version 是从 1 开始的整数。sourceExcerptIds 必须全部指向当前包内引用，删除来源后必须修复或删除背景，不能输出失联背景。

status 为 quoted/user-confirmed/model-proposed。quoted 文本必须逐字包含于某个关联引用；用户改写的背景用 user-confirmed；model-proposed 必须 included:false，直到用户确认。`renderPrompt` 仅包含 included 背景。核心保留互相矛盾的背景及各自来源和版本，不悄悄合并、覆盖或宣称已解决冲突。

核心 `toMarkdown` 是完整包的无损往返，因此调用者传入的 excluded 背景也会保留在 canonical 数据里。本产品分享/导出入口应先构造只含 included 背景的包；编辑草稿可保留所有背景。不要将草稿导出混同于最小分享包。

导入和校验不是批准动作。发送者的 `user-confirmed` 只描述该背景的状态，不替代接收工具对整包材料的采用审批；ContextPack 本身没有 `approved` 字段。消费者若有独立 approved 状态，应在导入后保持 false，直到接收者明确批准。

## JSON、Markdown 与实际发送正文

JSON 使用 UTF-8，读回后调用 `validatePack`。Markdown 是人类可读 `renderPrompt(pack)`，后接 `<!-- context-pack:v1 canonical-data -->` 与 base64url 编码的 JSON，再接结束标记。`fromMarkdown` 必须同时通过 schema、不变量、编码校验，并逐字比较可读正文与 canonical 包重新生成的正文。单独修改可读正文或隐藏数据会拒绝；应导入 JSON，在编辑器明确修改字段后重新导出。

`renderPrompt` 仅包含选中的 exactText、每段来源、勾选背景与问题，无任何未选历史。所有引用原文逐行用 `>` 标记为数据，且正文明确不提升其中内容为 system/developer 指令。角色仍原样展示，转发作为一个普通用户输入，不伪造 assistant 消息历史。

## 来源复核与恢复

`checkSources(pack,history)` 返回每段 `{excerptId,label,status,reason}`，从不修改包：

- unchanged：有明确范围的来源文本 hash 和角色均匹配，选段也相同。
- changed：在相同 source URI、kind、thread、turn 中唯一定位到宿主 item ID，但正文或角色已变；保留原快照。
- missing：找不到来源、ID 定位歧义，或无法确认无 ID 来源。没有宿主 ID 时，只有相同导入定位、明确来源与全文 hash 全匹配才确认 unchanged；不凭 null ID、相同角色或相同序号猜测 changed。完全没有可识别来源时，即使文字相同也为 missing。

再次提供未改动来源可恢复 unchanged。编号、原文、背景和问题在失败/恢复中不改变。

## 可运行的一致性样本

[examples/conformance/manifest.json](../examples/conformance/manifest.json) 索引四类合成样本，每类包含原始 `.source.json` 或 `.source.jsonl`、`.pack.json`、`.pack.md`。manifest 保存导入 sourceUri 与选择范围，可重新构造同一选择。所有内容都是 fixture，没有读取真实宿主、调用模型或自动批准背景。

| 样本 | 需要保留的区别 |
| --- | --- |
| [full-message](../examples/conformance/full-message.pack.json) | App Server 风格全文，两个角色、已知来源、两个哈希相等；quoted 与模拟发送者确认的背景 |
| [partial-message](../examples/conformance/partial-message.pack.json) | 含 emoji 的 UTF-16 片段，sourceHash 不等于 excerptHash；model-proposed 背景保持 included:false |
| [unknown-source](../examples/conformance/unknown-source.pack.json) | 来源 ID、URI 和时间为 null；不能根据相同文字认定来源存在 |
| [rollout](../examples/conformance/rollout.pack.json) | sourceKind=codex-rollout、真实输入提供的 session/turn，缺失 item ID 保留 null；未勾选背景不进入提问正文 |

从源码目录运行：

```sh
node scripts/generate-conformance-fixtures.mjs
node scripts/generate-conformance-fixtures.mjs --check
node --test tests/core.test.mjs tests/conformance.test.mjs
```

生成器实际调用 importHistory → createPack → validatePack → toMarkdown，只将合成 fixture 的包/引用标识与创建时间固定以便审阅差异；原文、范围、来源和两个哈希不手工替换。背景明确附加后再次校验。`--check` 只读核对已有文件与当前生产者是否一致。消费方应使用同一组包验证正常导入、篡改拒绝、背景不自动批准、失败后恢复；Relay 测试通过不代表外部消费者已经通过验收。

## 宿主边界

MCP/Skill 负责显式导入、校验、预览与导出；薄选择器提供多选，不是 Codex 原生消息气泡菜单。未核验到公开的消息多选按钮、右键引用或 composer chip 注入合同。复制到 Codex 是降级入口。managed App Server 是独立 profile 的连接，不等于桌面当前宿主；第三方插件也不天然拥有 `mcp__codex_app__` 工具。

只有具备已核验连接、可见目标与实际发送回执的适配器，才能宣称发送结果。ContextPack 编码本身不会提供宿主权限，也不会运行模型。
