# Context Relay · 引用接力

**Select exact quotes. Carry confirmed context. Continue the conversation.**

多选一段讨论中的消息或片段，附上确认过的背景，打包给另一个 Agent 接着问。保留原文、角色、出处和引用编号；不把未选中的历史带走。

## 30 秒开始

需要 **Node.js 22+**，没有生产依赖，不需要 npm install。在本目录运行：

```sh
node src/cli.mjs serve
```

打开 [选择器](http://127.0.0.1:6400)，导入 JSON／JSONL 聊天记录或 ContextPack → 勾选消息／选中片段 → 写问题 → 预览、复制或下载。`node src/cli.mjs serve --port 6401` 可更换本机端口（当前 6400–6409）。

- 草稿立即排队保存，只有最新修改落盘才显示“已保存”；失败可重试，尚未保存时关闭页面会提示。
- 多窗口修改发生冲突时自动另存独立草稿，地址随之更新；两份内容都保留。“查看其他草稿”可重新打开、下载完整备份，并从导入入口恢复。完整备份包含原历史，转发给别人请使用引用包。
- 损坏草稿不会被空白页面覆盖；可下载原始文件、打开其他草稿或新建。模型请求后如修改了引用、背景或问题，迟到的建议仅展示，不自动写入。
- 载入另一段历史保留引用篮，可跨历史组合。载入引用包或演示替换现有选择前会确认。
- 下载前回读校验；服务端副本保留在 `.runtime/exports/`。浏览器下载位置由浏览器保存设置决定。
- 所有服务端数据跟随当前目录，放在 `.runtime/`，没有作者电脑路径或父项目脚本依赖。在 D 盘放置项目即可让项目数据留在 D 盘。

## MCP＋Skill：可带走的本地包

**已下载完整发行包：** 直接跳到下方 `configure-plugin.mjs` 命令。包内没有构建脚本，也无需再次打包。`release-manifest.json` 列出随包文件与哈希。

**从源码构建：** 源码中的 `plugin/` 是构建模板，先生成包含运行代码的完整包：

```sh
node scripts/package.mjs
```

输出完整目录位于 `.runtime/releases/<版本-随机ID>/codex-context-relay/`。Windows 可运行 `./scripts/package.ps1`，同时得到保留隐藏 manifest 的 ZIP。**包只收录明确白名单**，附逐文件 SHA-256；不带用户草稿、登录凭据、回执、缓存、浏览器数据或开发日志。

把包复制／解压到希望长期保存的位置，然后在包内运行：

```sh
node scripts/configure-plugin.mjs
```

命令只生成本目录 `.mcp.json` 并更新本地插件 manifest，不安装插件或修改宿主设置。可将生成的 MCP 配置加入支持 stdio 的客户端；Codex 的具体目录、marketplace 文件和安装命令见 [本地插件安装](docs/INTEGRATION.md#local-plugin-installation)。已在独立 Codex CLI 配置中真实安装，并发现 Skill、15 个工具及 schema；桌面用户配置尚未验收。

配置使用当前 Node 和包的实际路径，运行时需要保留解压目录。**移动或更新后应重新配置来源并重新安装插件**，只改源文件不会刷新宿主缓存中的配置。需要保留草稿时，先下载完整备份，再迁到新目录恢复。

调用 `relay_capabilities` 查看能力，`relay_selector` 打开选择器；Skill 引导 `relay_import` → `relay_pack` → `relay_preview` → `relay_export`。`relay_prepare`／`relay_send` 只向已配置并验证的现有任务发送，回执严格区分准备、提交、完成、失败和未知交付。

## 模型与 Codex 连接

离线选择、校验、复制与导出均不需要模型。可选回答／背景建议支持 **external-api** 和 **codex-cli** 两个已实现后端；没有密钥或登录时返回配置错误，不伪造回答。

连接已有宿主时，使用你主动提供的 App Server 地址和已有对话 ID；不查找私有数据库或猜测桌面连接。先只读验证：

```sh
node src/cli.mjs connection --mode host-ws --endpoint ws://127.0.0.1:6401 --thread EXISTING_THREAD_ID
```

把示例地址与 ID 换成实际已授权连接。验证通过后，在同一命令末尾加 `--save` 保存；再重启已运行的选择器／MCP。保存只替换 `bridge`，保留模型配置；验证失败、原配置损坏或验证期间配置被修改都不会覆盖原文件。成功保存会留下旧配置备份。`host-proxy` 使用 `--sock` 指向明确提供的本机连接；独立 profile 可用 `--mode managed-app-server`，它与桌面历史分开。

选择器既能逐页列出对话，也能直接填写已有 ID。`relay_probe` 不带 ID 时只检查连接；指定 `threadId` 才读取该对话并验证。读取分页历史会补齐原文；接口不支持、历史超限或分页不完整时明确失败，当前草稿保留。收件目标总是在发送前单独验证。

恢复到仅导出模式：`node src/cli.mjs connection --mode export-only --save`。这不会删除草稿或回执。`node src/cli.mjs connection --help` 查看参数。
服务端配置文件是 `.runtime/app-config/relay.json`：

```json
{
  "bridge": {"mode": "export-only"},
  "model": {
    "provider": "codex-cli",
    "model": "gpt-6-astra",
    "effort": "ultra",
    "codexCli": {"executable": "codex", "authMode": "chatgpt"}
  }
}
```

CLI 子进程使用当前包 `.runtime/codex-profile/`，不会继承桌面的凭据目录。用户可运行 `node src/cli.mjs login` 正常登录；模型请求使用相应账户额度。外部 API 只读取显式配置的服务端 key 环境变量。[模型配置](docs/MODELS.md) · [App Server 连接与回执](docs/INTEGRATION.md)

## 当前边界

- 选择器是伴随工具；Codex 原生消息多选、右键引用和输入框引用标签尚未接入公开扩展接口。
- “背景记忆”是用户确认的显式内容，不包含宿主隐藏状态。未知来源 ID 保留未知。
- 独立 App Server 不等于桌面当前 server。真实宿主跨任务发送和真实模型推理尚未验收；契约 fixture 不能证明这些能力。
- 本地 MCP 包面向支持 stdio 的宿主，不是已上架的公共远程插件。[官方打包说明](https://developers.openai.com/plugins/build/plugins)
- 草稿、导出和回执是本地明文。宿主桌面自身会话与日志不受此工具控制。

## 开发与验证

在源码目录运行 `node --test tests/*.test.mjs`。覆盖来源与范围、往返、失败和恢复、模型及发送契约、打包白名单、换目录后的 CLI／MCP 流程。发行包仅包含运行必需文件；测试随源码提供，生成的本地验收记录不分发。

`node scripts/demo.mjs` 生成明确标注的离线演示；不调用付费模型、不发送真实任务。更多见 [协议](docs/PROTOCOL.md) 和 [演示步骤](DEMO.md)。

可选浏览器回归的依赖和运行方法见 [开发说明](docs/DEVELOPMENT.md)。
