# ChatGPT Plan Gateway

[English](README.md)

在自己电脑运行，使用自己的 ChatGPT 订阅或 OpenAI API Key。提供 OpenAI 兼容接口、可配置并发的 FIFO 队列、token 记录、SQLite 历史和中英文终端监控。

普通 OpenAI SDK、LiteLLM 和其他兼容客户端使用同一接口。LOTUS／agent-memory 是可选使用案例，不是网关依赖或核心设计前提。

**当前是原型。**默认离线模拟。两种上游均有离线测试；另行获准的真实验证已覆盖订阅文本／JSON、usage、重启复用授权、令牌续期、原生 LOTUS `sem_map` 和独立 LiteLLM 示例。最新两请求验收实际观察到并发 2、发送间隔 3 秒；默认并发仍为 1。这些是小规模接入验证，真实限流后的恢复和长期运行仍未验证。详见[验收记录](docs/offline-verification.md)，其中也保留了此前测试脚本导致的失败。本项目依据 OpenAI 官方公开文档实现，并非 OpenAI 官方认证产品。

## 先离线运行

需要 Node.js 26+ 和 npm，不需要 Docker、数据库服务或全局工具。终端交互测试另需 Python 3.9+，主要面向 macOS／Linux。

```bash
npm ci --ignore-scripts --cache .npm-cache
npm start
# 另一个终端：
npm run status
# 英文界面：
npm run status -- --lang en
```

只监听 `127.0.0.1:8787`。上下选择，Enter 看详情，R 看原始字段，Esc 返回，左右翻页，Tab 切换历史，Q 仅关闭监控。非交互环境默认打印一次。

```bash
npm run status -- --once
npm run --silent status -- --json
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"offline-model","messages":[{"role":"user","content":"返回 JSON"}],"response_format":{"type":"json_object"}}'
```

模拟样本固定返回 `{"answer":2}`，历史样本用量是输入 58、输出 13、总计 71；不会回答任意问题，也不测量你的真实 prompt 长度。

## 本机日常使用

初始化一次，以后不必手动设置本地访问 Key。下面的初始化只保存本机配置，不登录、不查询模型目录、不调用模型；模型名请选你有权限使用的型号。

```bash
npm run local -- init --model gpt-6-luna
# 日常使用，在两个终端分别运行：
npm run local -- start
npm run local -- status
# 英文／一次打印／JSON：
npm run local -- status --lang en
npm run local -- status --once
npm run --silent local -- status --json
```

配置和随机本地 Key 位于被 Git 忽略的 `data/local/gateway.json`、`data/local/client.key`，权限分别为目录 0700、文件 0600。重复初始化相同模型／通道会原样复用；冲突、损坏或不安全权限会报错，不覆盖文件、不轮换 Key。更改现有模型或端口时编辑私有配置并保留文件权限。

订阅通道复用已保存的独立授权。首次使用其他新电脑，或授权确实失效时，先执行 `npm run auth -- login`；`local start` 不会自动打开网页。普通 `npm start` 仍是离线入口。退出监控不停止网关，网关用 Ctrl-C 停止；不会安装后台服务或开机自启。

API Key 用户可初始化为 `npm run local -- init --model YOUR_MODEL --upstream openai-api-key`，再在服务环境设置自己的 `OPENAI_API_KEY`。本机入口只保存本地访问 Key，不保存上游 API Key，也不改变全局 shell 配置。

客户端示例可直接读取同一份本机连接信息，无须复制 Key：

```bash
node examples/client.mjs --local
python3 -B examples/client.py --local
# 使用已安装 LiteLLM 的现有 Python 环境：
/path/to/existing/venv/bin/python -B examples/litellm_client.py --local
```

**这些客户端命令会实际发送请求**；初始化、启动和监控不会发送模型请求。`--local` 与 `--direct` 不能同时使用。其他客户端需要配置相同的地址、模型和本地 Key；示例演示了如何从私有文件读取，勿打印或上传 Key。

LiteLLM 示例必须显式加 `--local`，复用已有的受保护配置读取函数，打印一份包含文本和 usage 的 JSON。不导入 LOTUS／agent-memory、不读取订阅令牌、不登录、不安装依赖或查询模型目录。LiteLLM 与底层 SDK 均关闭重试，显式传输禁用环境代理和重定向；失败非零退出，不重发。普通 SDK 示例仍支持 `--direct`，这个 LiteLLM 示例只接受 `--local`。

## 选择上游

| 配置 `upstream`        | 用户提供什么              | 消耗什么                         |
| ---------------------- | ------------------------- | -------------------------------- |
| `offline`，默认        | 无                        | 固定模拟数据                     |
| `chatgpt-subscription` | 独立官方 OAuth 授权       | 获准使用的 ChatGPT 计划／credits |
| `openai-api-key`       | `OPENAI_API_KEY` 环境变量 | API 平台 credits／付费余额       |

如果使用底层 `npm start -- --config …` 入口，需要在相应示例配置中选择有权限的模型，并在服务、客户端和监控终端设置同一个独立 `GATEWAY_LOCAL_API_KEY`，至少 16 个字符。它仅保护本地接口，不是上游凭证。不要把密钥写进配置、命令历史、代码或共享聊天。

**使用订阅：**

```bash
npm run auth -- login --config gateway.subscription.example.json
npm run auth -- status --config gateway.subscription.example.json
npm start -- --config gateway.subscription.example.json
# 停止服务后再退出授权：
npm run auth -- logout --config gateway.subscription.example.json
```

登录命令打印官方网页地址，由你手动打开；登录本身不发模型请求。服务启动不会自动打开浏览器、获取模型目录或发送测试。令牌临近过期时，发送前自动续期。账号与凭证只由本工具管理，不读取日常 Codex 配置或凭证。

首版保存一个账号注册，后续登录复用；不同身份不能覆盖。服务持续持有凭证锁，所以登录、退出或启动第二个订阅服务前，先停止现有服务。不做账号池或自动切换。

**使用 API Key：**在服务环境设置 `OPENAI_API_KEY`，然后：

```bash
npm start -- --config gateway.api-key.example.json
```

符合条件的订阅赠送 API credits 和充值余额使用相同 API Key 通道。赠送额度耗尽后，平台可能继续使用已有充值余额；本项目无法判断某次请求具体扣了哪类余额。[官方权益说明](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)

## 接客户端

客户端设置 `base_url=http://127.0.0.1:8787/v1`，Key 使用本地 Key，模型与服务配置一致。`/v1/models` 只列配置的一个模型，不等于已验证账号有模型权限。

示例：[官方 JavaScript SDK](examples/client.mjs)、[官方 Python SDK](examples/client.py)、[LOTUS](examples/lotus.py)。Python 示例使用已有环境；本项目不自动安装 Python 依赖。

```bash
node examples/client.mjs
python3 -B examples/client.py
```

LiteLLM 使用 `openai/<配置的模型>`、同一个本地 `/v1` 地址和本地访问 Key，设置 `num_retries=0` 并排除 loopback 的系统代理。详见 [LiteLLM 接入指南](docs/litellm-integration.md)。

通用兼容策略默认 `strict`。[LOTUS](docs/lotus.zh-CN.md) 和 [agent-memory](docs/agent-memory-example.md) 是可选案例；只有客户端需要省略不支持的默认参数时，才显式选择 `profile: "lotus"`。省略情况会记录，不代表约束生效。

API Key 用户也可以直接调用官方接口：运行示例时加 `--direct`，并设置 `MODEL` 和 `OPENAI_API_KEY`。这会绕过本地网关，因此本项目不提供该调用的限流、历史或实时 TUI；平台账单使用官方 Usage 页面查看。

## 保守、明确的运行规则

- 支持文本消息、一条 completion、非流式客户端响应，以及普通文本／JSON object／JSON schema。未实现工具、图片、embedding 或通用多 provider 框架。
- 订阅模式转换为官方 Responses，`store:false`、`stream:true`，system 转为 developer。API Key 模式直接调用官方 Chat Completions，保留消息角色，支持 `temperature`、`top_p`、`max_tokens`、`max_completion_tokens`。
- 不增加 agent 提示词、项目文件或历史；不自动修 JSON，不隐式缓存去重，不切换计费，不自动重试。调用端自己的重试也须明确配置；示例设为 0。
- `concurrency` 可配置，默认 1；真实模式默认两次实际发送至少间隔 3 秒。可选 `maxRequestsPerMinute` 默认 `null`，通过平滑发送限制速率。例如并发 4、RPM 20 可以让请求重叠执行，同时至少每 3 秒发出一条。这些是本地策略，不是官方安全阈值。请求预算不会并发超发；token 阈值按已观测 usage 停止后续派发，在途请求仍可能使最终用量超出阈值。
- **并发为 1 仍可能触发 RPM／TPM 限制。其他应用可能共享官方限额。我们只控制经过本工具的流量，不能保证避免限流或账号封控。**[官方限流文档](https://developers.openai.com/api/docs/guides/rate-limits)
- 明确临时限流／过载且有可靠等待提示时，未发送任务等待后继续，失败请求不补发。`slow_down` 还会让本次运行的生效间隔翻倍，不改变并发，也不自动加速恢复。额度、余额、权限、未知错误和存储失败保持暂停；未发送任务到期只结束该任务。监控显示错误码与等待依据，等待提示不是额度恢复承诺；重启不恢复官方额度。
- 成功必须有完成状态和有效 usage。Responses 收到终止事件后停止读取，不等待连接自行关闭。细分缺失显示未知，缓存／推理不重复加进总量。账号余额与实际费用保持未知。

## 数据、监控与验证

真实模型和监控接口校验本地 Key、Host／Origin；健康接口只提供健康和模式。服务仅供本机单用户使用，不直接公开端口或通过隧道分享。

授权文件以 `0600` 权限保存，目录 `0700`，原子替换；SQLite 锁防止多个进程抢用同一授权。请求历史不主动保存 prompt／输出正文，错误仅保留机器码，避免服务端错误消息带回正文。但参数值、原始 usage、请求哈希和上游标识仍须视为私有信息。独立 probe 会保存其固定小测试输出。`data/`、`reports/`、缓存和环境文件均被 Git 忽略。[隐私与安全](SECURITY.md)

```bash
npm run typecheck
npm run build
npm test
# 可选，直接验收 LiteLLM，不导入 LOTUS 或 agent-memory：
GATEWAY_LITELLM_PYTHON=/path/to/existing/venv/bin/python npm run test:litellm
# 可选，复用已有 LOTUS 环境，也验收普通官方 Python SDK：
GATEWAY_LOTUS_PYTHON=/path/to/existing/venv/bin/python npm run test:lotus
```

默认测试拦截所有非 loopback 出站连接。CI 配置在 Linux／macOS 上运行同一组离线检查，不使用真实密钥。本地检查与 GitHub 托管 CI 结果分别报告；模拟成功不代表真实长期服务已验证。

- [配置](docs/configuration.md) · [协议](docs/protocol.md) · [终端监控](docs/status.md)
- [授权管理](docs/authorization.md) · [独立两请求 probe](docs/live-probe.md)
- [LiteLLM 接入](docs/litellm-integration.md) · [TODO](TODO.md)
- [跨机器设计](docs/remote-use.md) · [可选研究案例](docs/agent-memory-example.md)
- [验收范围](docs/offline-verification.md) · [排错](docs/troubleshooting.md)
- [fixture 来源](fixtures/README.md) · [发布检查](docs/privacy-review.md)

## 官方依据与许可

[开源／本地应用使用 ChatGPT 计划](https://developers.openai.com/siwc/token-sharing-open-source)、[登录和凭证保存](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[续期和撤销](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)、[推理接口](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)、[错误恢复](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)。资格、地区、政策和额度限制仍适用；付费或远程托管应用另走官方申请流程。公开源码不等于运营共享订阅服务。

[MIT 许可证](LICENSE)，允许包括商用在内的复用。依赖保留各自许可证；上游访问另受其条款和政策约束。
