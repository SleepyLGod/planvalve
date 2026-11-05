# 协议与实现边界

HTTP 入口 → 校验/转换 → 单 FIFO 队列 → 官方 OpenAI JS SDK → 自定义 mock fetch → 本地 SSE fixture → 终止状态及 usage → 输出校验 → Chat Completions。

模块按职责划分：config 读取设置，compatibility 处理消息/JSON schema/usage，queue 控制时序，mock 提供响应，sdk 隔离 SDK 默认环境，gateway 组织 HTTP 与账本，cli 负责启动及报告。SQLite 保存历史，独立监控客户端只读查询状态；不包含插件框架、数据库服务、鉴权系统、Tailscale 或 agent 执行能力。

- `/healthz` 仅存活信息；`/v1/models` 默认仅 offline-model；独立 probe 返回本次实际选择的模型。
- `/v1/chat/completions` 支持 system/developer/user/assistant 的字符串消息，客户端 stream=false、n=1；system 只改变角色为 developer，不追加内容。
- 支持文本、json_object、json_schema。JSON schema 使用 Ajv 的 Draft 7 校验；不支持的 schema/format/关键词明确拒绝，不静默假装已校验。JSON 语法不修补。
- 请求正文上限 1 MiB；fixture 输出文本上限约 2 MiB 字符。本地 fixture 是拥有者提供的受信任测试材料，不是远程报文入口。
- 模拟请求地址使用 offline.invalid，但 SDK 的 fetch 完全被内存实现取代，地址不会解析或连接；默认路径没有真实传输；独立 probe 可显式注入固定官方地址的传输，要求 maxRequests 为 1 或 2，不能通过常规配置启用。SDK 构造在同步的空环境边界内完成，随后恢复原环境引用，不读取或复制主机凭证默认值。
- 完成必须是 response.completed 且 status=completed；从 delta 累积文本，兼容最终 output=[] 和缺少 Content-Type。终止后仍读取完流；done 文本不一致则报错。
- raw usage 先于 JSON 结果校验记录，失败结果也不会抹去已取得的用量。input/output/total 非负且相加一致才纳入可靠总量。只有细分缺失时成功但标 partial，字段省略而非零。
- 归一化为 prompt_tokens、completion_tokens、total_tokens、prompt_tokens_details.cached_tokens、completion_tokens_details.reasoning_tokens。额外 attribution/cache-write 留在原始 usage 中。
- 排队取消/过期不占模拟上游次数；已开始的客户端断开不触发补发，继续收尾记账。断流/绝对超时为 unknown，并暂停后续发送。正常失败为 failed；没有失败修复或重试。
- 未发送时检查请求数和已观测 token 预算。队列满、过期和预算耗尽有明确错误码。SDK retry 提示头不能替代发送器本身的停止控制。
- SQLite 保存各运行及请求的最后成功写入状态；记录包含模型和输出格式，不保存消息/结果正文。完成记录持久化成功后才返回成功；存储写入失败则暂停并返回 storage_unavailable。
- 运行时队列、当前预算保持进程内语义；SQLite 的历史记录不自动恢复为待执行任务。CLI 的 JSON 快照继续保留为导出。

HTTP 网关离线通过，不等于已经接入真实订阅，更不等于所有 agent-memory benchmark 在不改配置的情况下兼容。当前 mock 输出和 usage 不随输入变化。

## 只读状态接口

只在现有 loopback HTTP 服务内提供：

- `GET /_gateway/status`：mode、asOf、runId、startedAt；queue 包含 concurrency/running/waiting/capacity/paused/closed 及期限设置；budget 包含请求与 token 的 used/limit/remaining；usage 包含核心总量及 cached/reasoning/cacheWrite 的 knownTokens、unknownRequests；storage 标记健康状态。总计只累加可靠核心 usage，细分不重复计入。
- `GET /_gateway/requests?run_id=...&limit=50&before=...`：run_id 可省略以查询全部历史；limit 为 1–200，before 为正整数数据库游标，最新优先。返回 items 与 nextCursor（无后续页为 null）。读操作不更新数据库或 JSON 快照。
- `GET /_gateway/requests/:id`：返回单条完整账本记录，额外包含 cursor、runId、historical、lastKnownState；不存在返回 404。旧运行状态必须按最后已知状态解释。

监控使用同一组只读接口；不会进入模型队列。TUI 每次查询完成后等待一秒刷新，不并发轮询；断连保留带时间的旧快照。Node 原生 http/https 直接访问数字 loopback，避免宿主全局 fetch 代理设置改变连接路径；不跟随任何重定向。
