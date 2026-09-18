# 可选模型后端

引用选择、编号、来源、背景快照、预览及导出均不依赖模型。模型只能提供单独的回答、背景建议与冲突提示，不会替换 `exactText` 或自动确认背景。默认使用 `gpt-6-astra` / `ultra`；后端不自动换模型、重试或回退。模型权限与额度由实际账户决定。

## 共用接口

```js
import { generate, probeModels } from './src/models.mjs';
const result = await generate({
  pack, operation: 'answer', // 或 suggest
  signal: abortController.signal,
  timeoutMs: 120000,
}, serverSideConfig);
// {provider, model, answer, suggestions:[{text,sourceExcerptIds}],
//  conflicts:[{text,sourceExcerptIds}], usage?:{input_tokens,output_tokens,...}}
```

`schemas/model-output.schema.json` 约束模型正文。发送时动态加入本包引用 ID 的枚举；接收时再次检查字段、引用 ID、重复 ID 及 `[引用 N]` 标签。未选背景不会传给模型；输入包不原地修改。建议只有用户确认后才能由调用方加入新的背景版本。所有错误均为带 `code` 的异常，原包仍可导出。

## external-api

配置保存在服务端，例如 `.runtime/model.config.json`（不要提交真实凭据）：

```json
{
  "provider": "external-api",
  "model": "gpt-6-astra",
  "effort": "ultra",
  "externalApi": {
    "baseURL": "https://api.openai.com/v1",
    "style": "responses",
    "keyEnv": "RELAY_MODEL_API_KEY",
    "structuredOutput": "json-schema"
  }
}
```

由服务进程正常获取用户明确配置的 `RELAY_MODEL_API_KEY`，不要把值写入 JSON、前端、URL、fixture 或日志。`style` 支持 `responses` / `chat-completions`；`structuredOutput` 支持 `json-schema`、`json-object`、`prompt`，应按所选服务实际能力配置。后两种模式仍会在本地严格验收结果，不自动猜测服务能力。请求仅发送已选原文、已包含的背景和问题；禁止重定向携带凭据。远程端点要求 HTTPS；本地调试 HTTP 只允许 6400–6409。

Responses 发送 `text.format`，Chat Completions 发送 `response_format`。二者均发送显式模型及推理等级；如果兼容服务不支持该模型或参数，会返回可见错误，不静默省略或降级。[OpenAI 结构化输出文档](https://developers.openai.com/api/docs/guides/structured-outputs)

Responses 响应只要含有 `status` 字段，就必须为 `completed`；`queued`、`in_progress`、`null` 和其他非完成值均返回 `MODEL_INCOMPLETE`，即使附带合法 answer 也不接受、不自动轮询或重试。为兼容部分非标准端点，完全省略 status 时继续按内容 schema 验收；显式 null 不属于省略。Chat Completions 仍要求 `finish_reason: stop`。失败保留引用包，后续明确发起的新请求只有满足相应完成条件才返回回答。

## codex-cli：ChatGPT 登录额度

```json
{
  "provider": "codex-cli",
  "model": "gpt-6-astra",
  "effort": "ultra",
  "codexCli": {"executable": "codex", "authMode": "chatgpt"}
}
```

每次调用先核验本机 `exec --help` 所需参数，再执行 `login status`。只有明确的 ChatGPT 登录状态才继续；未登录、API-key/access-token 登录、未知状态和冲突 provider 配置都会拒绝调用。本机已验证的版本为 `0.154.0-alpha.6.2`。

调用采用原生可执行文件、参数数组、`shell:false` 及 stdin。核心参数为 `exec --json --output-schema <本题临时schema> --ephemeral -C <本题> --sandbox read-only --ignore-user-config -`，另显式设置模型、推理等级、file 凭据存储、ChatGPT 登录方式、官方 provider、包内 sqlite/log 位置。模型输入指示禁止工具、文件读取和命令执行。程序要求 JSONL 中同时有最终 `agent_message` 与 `turn.completed`，且退出码为 0；启动成功不等于回答成功。[Codex 非交互模式文档](https://learn.chatgpt.com/docs/non-interactive-mode)

适配器仅修改 CLI **子进程环境副本**，剥离 `CODEX_API_KEY`、`OPENAI_API_KEY`、`CODEX_ACCESS_TOKEN`、`OPENAI_ACCESS_TOKEN`、`OPENAI_AUTH_TOKEN`、`AZURE_OPENAI_API_KEY`、以 API_KEY/ACCESS_TOKEN/AUTH_TOKEN/BEARER_TOKEN 结尾的鉴权变量、配置的外部 keyEnv，以及 API 地址覆盖变量；也剥离宿主会话 ID、内部 originator、app-tools pipe 与 browser-use 变量。父进程与 external-api 配置保持独立，绝不静默切换 API 计费。

`CODEX_PROJECT_PROFILE_DIR` 显式映射到子进程 `CODEX_HOME`，`CODEX_SQLITE_HOME` 指向其 `sqlite` 子目录。所有 profile、临时 schema、缓存和日志均限定当前包目录，拒绝 junction/symlink。临时 schema 在成功、失败及取消后删除。只读检查本题 config，不读取 `auth.json` 或私有数据库；正常登录由 CLI 自己处理，不复制 C 盘凭据。profile 中的 provider 覆盖配置会保守拒绝，用户应整理独立 profile；不会替用户修改配置。宿主桌面自身存储不在这些设置的控制范围内。

## 运行与恢复

在当前包目录中执行：

```powershell
node scripts/probe-models.mjs
```

默认仅探测，不发模型请求。2026-09-17 实测结果：所需 CLI 参数均存在；当前包的独立 profile 返回 **Not logged in / MODEL_AUTH_REQUIRED**。报告写入 `.runtime/validation/model-probe.json`。

用户需要使用 ChatGPT 额度时，可单独正常登录（会显示 CLI 的设备登录流程）：

```powershell
node scripts/probe-models.mjs --login-device
node scripts/probe-models.mjs
```

要执行真实请求，先审核引用包和服务端配置，再由用户显式运行（会消耗相应账户额度/API credits）：

```powershell
node scripts/probe-models.mjs --config .runtime/model.config.json
node scripts/probe-models.mjs --execute --config .runtime/model.config.json --pack .runtime/exports/demo-pack.json --operation answer
```

`--execute` 成功后正文写 `.runtime/exports/model-answer.json`，provider、model、用量与耗时写 `.runtime/validation/model-execution.json`。失败不保存未经验证的正文或原始服务错误，不自动重试。`inferenceExecuted:null` 表示失败请求是否实际推理未知，不能据此认为没有消费。

| 错误 | 恢复动作 |
| --- | --- |
| MODEL_NOT_CONFIGURED / MODEL_KEY_MISSING | 配置明确后端及服务端环境变量；仍可离线导出 |
| MODEL_AUTH_REQUIRED / MODEL_AUTH_MODE_MISMATCH | 用当前包的独立 profile 正常 ChatGPT 登录并重新 probe |
| MODEL_AUTH_CONFIG_CONFLICT | 修正本题 provider/auth 配置；API 计费用 external-api |
| MODEL_CLI_NOT_FOUND / MODEL_CLI_UNSUPPORTED | 选择已安装原生 CLI 可执行文件并核验 help |
| MODEL_RATE_LIMITED / MODEL_QUOTA_EXCEEDED | 检查实际账户额度，条件恢复后显式重试 |
| MODEL_TIMEOUT / MODEL_CANCELLED | 原包保留；CLI 子进程终止，API 请求取消；显式重新调用 |
| MODEL_MALFORMED_OUTPUT / MODEL_SCHEMA_MISMATCH / MODEL_INCOMPLETE | 不接受部分结果；检查服务结构输出能力或重新请求 |
| MODEL_NETWORK_ERROR / MODEL_REQUEST_REJECTED / MODEL_CLI_EXIT | 检查连接、模型权限或参数；没有自动切换后端 |

## 验证边界

`node --test tests/models.test.mjs` 的全部网络、进程和回答均是明确标注的 **契约 fixture**，覆盖两个 API 风格、三种结构模式、原文不变、引用校验、认证隔离、缺 key/登录、限额、非零退出、JSONL、不完整回答、取消、timeout 与后续恢复。fixture 不能证明真实模型效果。本轮仅运行了真实 CLI help 与 login-status 探测，未登录、未发实际模型请求，external-api 凭据、网络、模型可用性和真实回答质量均未实测。
