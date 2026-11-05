# 配置

`npm start -- --config gateway.example.json` 读取 JSON；相对 fixture/report 路径以配置文件目录为基准。不指定文件时使用内置 fixture、端口 8787，报告相对当前目录写到 reports/latest.json，SQLite 数据库位于 data/gateway.sqlite。配置文件中的 databasePath 同样按配置目录解析；:memory: 仅用于临时验证。未知字段拒绝启动，没有真实上游 URL、密钥、OAuth 或网络暴露开关。

| 字段               |              默认值 | 含义                                                      |
| ------------------ | ------------------: | --------------------------------------------------------- |
| port               |                8787 | 仅 loopback；0 可选用临时端口                             |
| fixturePath        |        内置观测样本 | 本地 JSON，不能是 URL                                     |
| queueCapacity      |                  64 | 最多等待的请求数，不含执行中的一个                        |
| maxQueueWaitMs     |               60000 | 等待超时后拒绝，不执行模拟上游                            |
| minStartIntervalMs |                   0 | 两次模拟请求启动的最短间隔；离线默认不人为延迟            |
| upstreamTimeoutMs  |              120000 | 一次模拟执行和读取的绝对期限                              |
| maxRequests        |                null | 可选的每进程尝试次数上限                                  |
| stopAfterTokens    |                null | 可靠累计 token 达阈值后不启动下一次；最后一次可以超过阈值 |
| profile            |              strict | strict 或 lotus                                           |
| reportPath         | reports/latest.json | 本地 JSON 账本                                            |

null 表示离线模拟不设该预算；这不是未来真实接口的预算策略。示例显式设置预算。计时值不能超过 Node 计时器上限，正数预算不能为 0。

strict 拒绝未知参数。lotus 明确省略 temperature、top_p、max_tokens、max_completion_tokens、thinking，并在每条记录中保存请求值和变换说明；省略不代表这些实验条件已被执行，尤其不保证禁用推理。

并发固定 1、重试固定 0。原始 usage 缺失不补零；模型请求仅由内存 fixture 提供。没有改变这些约束的配置。

| 新增字段     | 默认值              | 含义                                  |
| ------------ | ------------------- | ------------------------------------- |
| databasePath | data/gateway.sqlite | SQLite 文件位置；不需要运行数据库服务 |

SQLite 历史按运行 ID 区分；请求数和 token 预算按本次进程计算，不把旧记录计入本次额度。数据库不可写时停止派发，不通过重新发送修复记录。没有历史删除、旧 JSON 导入或跨进程恢复设置。

监控命令不改变网关配置：`--url` 指定数字 loopback origin，`--once` 一次性文本，`--json` 一次性 JSON。非交互终端默认一次性文本；`NO_COLOR` 禁用颜色。并发与重试没有新增可调开关。
