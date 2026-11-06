# 配置

`npm start -- --config file.json`。相对路径以配置文件目录为基准；不指定文件时使用当前目录下的报告、数据库和私有授权目录。默认模式为离线。未知字段拒绝启动，不能配置任意上游 URL。

| 字段               | 默认值                 | 含义                                                  |
| ------------------ | ---------------------- | ----------------------------------------------------- |
| upstream           | offline                | offline / chatgpt-subscription / openai-api-key       |
| model              | null                   | 真实模式必须明确设置；离线默认 offline-model          |
| port               | 8787                   | 只监听 127.0.0.1；0 选择临时端口                      |
| fixturePath        | 内置样本               | 离线 fixture，真实模式不读取                          |
| queueCapacity      | 64                     | 等待队列容量，不含执行中的请求                        |
| maxQueueWaitMs     | 60000                  | 排队期限，过期不发送                                  |
| minStartIntervalMs | 离线 0；真实 3000      | 两次启动的最短间隔；不是官方安全阈值                  |
| upstreamTimeoutMs  | 120000                 | 执行、授权准备及读取的总期限                          |
| maxRequests        | null                   | 本次运行尝试数停止条件                                |
| stopAfterTokens    | null                   | 按已返回 usage 决定是否启动下一次；可超过最后一次用量 |
| profile            | strict                 | strict；或显式启用 lotus 特殊省略                     |
| reportPath         | reports/latest.json    | JSON 导出                                             |
| databasePath       | data/gateway.sqlite    | SQLite 历史；测试可用 :memory:                        |
| authPath           | data/auth/session.json | 本工具独立授权文件；不读 Codex 凭证                   |

真实模式同样允许显式 `null` 停止条件；示例配置提供请求及 token 预算。预算按进程计算，重启不会恢复官方额度。并发固定 1，重试固定 0；不实现分钟 token 估算或跨进程统一限流。

环境变量：

- `GATEWAY_LOCAL_API_KEY`：真实服务、客户端与监控共用的本地 Key，至少 16 字符，不含空白或控制字符。
- `OPENAI_API_KEY`：只在 API Key 模式读取，供网关访问官方上游；不会采用客户端传来的 Key。
- 不自动加载 dotenv，不查询 Keychain 或其他工具的配置。

授权目录新建时为 0700，文件为 0600。已有目录权限过宽时拒绝写入，选择独立的私有子目录；不会修改共享目录的权限。授权目录中的 SQLite 锁保护整个订阅服务生命周期，停止进程即释放，崩溃后的系统锁也自动释放；不恢复模型请求。

API Key 模式支持 temperature、top_p、max_tokens、max_completion_tokens。订阅 strict 拒绝这些不支持的字段；lotus 明确省略它们及 thinking，并记录变换。省略不代表请求的实验设置已生效，不保证关闭推理。

监控 `--url` 只接受数字 loopback，不跟随重定向。`--once` 打印一次，`--json` 打印可解析 JSON，`--lang en` 使用英文，`NO_COLOR` 关闭颜色。

## 本机入口

`npm run local -- init --model MODEL [--upstream chatgpt-subscription|openai-api-key]` 只在项目的 `data/local/` 创建配置和本地访问 Key。默认订阅通道，端口 8787、strict、间隔 3000ms、1000 次／100000 已观测 token 停止条件；仍不保证避开官方限额。配置路径以所在配置目录解析；入口不受当前工作目录影响。

`npm run local -- start` 自动向现有网关 CLI 传入配置和本地 Key；`npm run local -- status [--lang zh|en] [--once|--json]` 向现有监控传入地址和同一个 Key。不支持额外 `--url` 覆盖，避免把保存的 Key 发往另一服务。两者通过参数数组启动子进程，保留退出状态，转发停止及终端缩放信号。

文件只创建一次，重复初始化不会修改 mtime 或轮换 Key；部分写入、损坏、symlink、宽松权限或模型／通道冲突均报错，不静默恢复或覆盖。若要手动修改模型、端口、兼容策略等，在服务停止后编辑私有配置，保留 0600 权限。所有文件仍被 `data/` 忽略规则覆盖。
