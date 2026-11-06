# LOTUS 本机使用指南

[English](lotus.md)

LOTUS 是客户端示例，不是网关的安装依赖。复用已经安装 LOTUS、LiteLLM 和 pandas 的 Python 环境。下面命令都从网关项目根目录执行，无须修改研究仓库或其依赖。

## 启动网关

新安装时，选一个自己有权限使用的模型，初始化并登录一次：

```bash
npm run local -- init --model YOUR_ELIGIBLE_MODEL
npm run auth -- login
```

已有本机配置和授权时跳过这两步。在私有文件 `data/local/gateway.json` 中设置 `"profile": "lotus"`，保留其他字段和仅本人可读写的权限。初始化默认选择 `strict`，不会自动切换 LOTUS 兼容模式。

```bash
npm run local -- start
# 另一个终端，从同一项目执行：
npm run local -- status
# 英文界面：
# npm run local -- status --lang en
```

启动和监控不调用模型。已保存的授权会复用，需要时在模型请求前续期。Ctrl-C 停止网关，退出监控不会停止网关。

## 跑一行 sem_map

**连接真实订阅网关时，下面命令会发送真实模型请求。**将 Python 路径替换为已有环境。示例自动读取已保存的地址、模型和本地访问 Key，不读取订阅令牌。

```bash
PYTHON_DOTENV_DISABLED=1 LITELLM_LOCAL_MODEL_COST_MAP=True \
NO_PROXY=127.0.0.1,::1 no_proxy=127.0.0.1,::1 \
XDG_CACHE_HOME="$PWD/.client-cache" \
/path/to/existing/venv/bin/python -B <<'PY'
import pandas as pd
import litellm
import lotus
from lotus.models import LM
from lotus.cache import InMemoryCache
from examples.client import local_connection

litellm.telemetry = False
base_url, local_key, model = local_connection()
lm = LM(
    model=f"openai/{model}",
    api_base=base_url,
    api_key=local_key,
    max_batch_size=1,
    num_retries=0,
    cache=InMemoryCache(max_size=1),
)
lotus.settings.configure(lm=lm, enable_cache=False)
frame = pd.DataFrame({"question": ["1+1"]})
mapped = frame.sem_map(
    "Compute {question}; return only a JSON object with integer field answer.",
    suffix="_answer",
    response_format={"type": "json_object"},
)
print(mapped)
print("Token usage:", lm.stats.physical_usage)
PY
```

`openai/` 让 LiteLLM 使用 OpenAI 兼容协议；`api_base` 把请求发到本机网关。最终使用订阅还是 API Key，由网关配置决定。这里没有使用 LiteLLM 的 `chatgpt/` provider。不要把 OAuth 访问／刷新令牌当作本地访问 Key。

命令中明确排除了本机地址，避免系统代理收到本地 Key 和提示词。自己的 LOTUS 进程也应设置相同的代理排除。普通 JavaScript／Python SDK 示例已在本地调用中禁用环境代理和重定向；`--direct` 仍使用官方 SDK 的通常传输方式。

LOTUS 通常会附带 `temperature=0`、`max_tokens=512`。订阅兼容模式会记录并省略这两个不支持的参数，因此**不会执行指定的温度和输出上限**。网关累计 token 预算也是已知用量后的停止条件，不是服务端输出上限。网关不追加 agent 提示词；LOTUS 自身会添加任务格式指令，这部分计入输入 token。

示例设置单并发、禁用 LOTUS 缓存，并关闭客户端重试。网关另有串行队列、启动间隔、每次运行预算和上游出错后暂停。DataFrame 增加行数仍会产生多次调用；join、filter 等算子的调用方式及能力需求可能不同。一次 `sem_map` 成功不代表整个 LOTUS 或 benchmark 全部兼容。LOTUS 估算的金额不等于订阅账单；准确 token 和原始细分以网关监控为准。

## 真实观测，2026-11-06

原生 `sem_map`、一行输入、模型 `gpt-6-luna`、JSON object 模式：

| 项目 | 结果 |
| --- | --- |
| 输出 | `{"answer":2}` |
| 输入／输出／总 token | 59／12／71 |
| 缓存输入／推理输出／缓存写入 token | 0／0／0，均有明确字段 |
| 模型请求／重试 | 1／0 |
| 网关执行时间 | 6.612 秒 |
| 完成事件到记录结束 | 3 毫秒 |

LOTUS 的核心计数、服务端原始 usage、网关转换结果和 SQLite 中的唯一记录一致。原始 usage 及逐项归因已保留；缓存和推理是子集，不重复加入总量。本次复用已有授权，无须登录或刷新，临时网关已停止。此前另一次仅续期验证已成功：1 次刷新、0 次模型调用。

验收使用临时的单请求网关，并在传输层再次限制请求次数；缓存隔离、禁写字节码、禁用 dotenv 自动发现，Python 进程限制网络和写入范围。研究仓库源码／配置哈希、Git 状态和依赖元数据均未变，也没有修改日常本机配置。本指南的日常命令不会自动启用这些验收限制，也没有把服务的生命周期预算设为一条。

本次用量与离线 fixture 的 58／13／71 不同。结果、耗时、账号资格和 token 数都是观测，不是保证；长期运行和完整研究负载仍未验证。私有证据留在忽略的 `reports/` 中，公开文档无须包含凭证、账号 ID 或本机私人路径。
