# LOTUS／agent-memory 使用案例

更新：2026-11-06。本文件是外部使用案例，不定义网关的核心架构或必做路线。通用接入见 [LiteLLM 指南](litellm-integration.md)，原生单行算子见 [LOTUS 用法](lotus.zh-CN.md)，后续案例工作见 [TODO](../TODO.md)。

LiteLLM 和 LOTUS 是独立项目，LOTUS 的模型调用层使用 LiteLLM。研究仓库的维护路径是 `agent-memory → LOTUS → LiteLLM → 网关`；回答／评分另有直接使用 LiteLLM 的路径。网关自身不需要导入这些库。

原生 LOTUS 单行真实测试已经成功，但还没有完成研究仓库 adapter、维护流程与最终报表整条链路的验收。以下配置是方案，不是已完成的集成。

## 使用现有 adapter 配置


建议先在本项目的独立实验入口中配置研究库现有的 `LotusAdapter`，再把 adapter 交给原来的 Memory。复用研究仓库已有 Python 环境，只读导入其源码；结果、缓存与 trace 存入本项目被忽略的目录。第一步只接维护阶段，不同时启动回答和评分。

| 设置 | 选择及含义 |
| --- | --- |
| 客户端模型 | `openai/<网关配置的模型>`；当前观测模型为 `gpt-6-luna`，不是对其他账号的权限承诺 |
| `api_base` | 本机网关地址加 `/v1`，例如 `http://127.0.0.1:8787/v1` |
| 客户端 Key | 独立入口读取网关本地访问 Key，放入该进程的 `OPENAI_API_KEY`；不写进研究仓库或全局 shell |
| 网关 `profile` | 显式 `lotus`；初始化默认仍为 `strict` |
| `lm_num_retries` / `structured_parse_retries` | 均为 0；前者控制模型客户端，后者控制研究库的解析重发 |
| `lm_max_batch_size` / `lm_enable_cache` | 1 / False，先保持串行与可检查的调用记录 |
| `structured_output_transport` | `chat-json-object` |
| 代理 | 研究进程的 `NO_PROXY` 和 `no_proxy` 都包含 `127.0.0.1,::1` |

配置片段如下；这是接入方案，本文没有执行它。先把本地访问 Key 放进该进程环境，勿打印。构造 adapter 本身不调用模型，后续维护操作会调用。

```python
from agent_memory.adapters.lotus import LotusAdapter
from agent_memory.adapters.lotus.context import LotusExecutionConfig

adapter = LotusAdapter(
    model="openai/gpt-6-luna",
    config=LotusExecutionConfig(
        lm_model_kwargs={"api_base": "http://127.0.0.1:8787/v1"},
        lm_num_retries=0,
        lm_max_batch_size=1,
        lm_enable_cache=False,
        structured_parse_retries=0,
        structured_output_transport="chat-json-object",
    ),
)
```

`openai/` 只是选择兼容协议，不是 LiteLLM 的 `chatgpt/` provider，也不决定网关使用订阅还是 API Key。仓库自己的 `responses-json-schema` 当前进入 DeepSeek 专用实现，不能凭名字把它当作通用 Responses 接口。

订阅兼容模式会省略并记录 `temperature`、`max_tokens` 等不支持的参数；实验中不能声称这些限制生效，或声称 `thinking: disabled` 保证关闭推理。网关累计 token 预算也是已观测用量后的停止条件，不是单次生成的硬输出上限。LOTUS 自己的任务指令计入输入；网关不添加 agent 提示词。

### 为什么现成 benchmark CLI 还不能只换模型名

只读检查针对当时研究仓库的当前工作区，包括已有未提交研究改动；文件名和默认值以后可能变化。

| 位置，相对研究仓库 | 已确认行为 | 对方案的影响 |
| --- | --- | --- |
| `src/agent_memory/adapters/lotus/context.py` | 已有 `lm_model_kwargs`、并发、重试和结构化配置透传 | adapter 层无需新增 provider 框架 |
| `src/agent_memory/evaluation/run.py` | 环境检查无条件要求 `DEEPSEEK_API_KEY` | 仅配置网关 Key 不能消除这一检查；不要用假 DeepSeek Key 掩盖它 |
| `src/agent_memory/evaluation/agent_memory_drivers.py` | benchmark 模型重试常量为 2 | 网关零重试不能替客户端取消重试 |
| `src/agent_memory/adapters/lotus/context.py` | 结构化解析默认重试 3 | 外部入口需显式设 0 |
| `src/agent_memory/evaluation/harness.py` | 回答／评分 `parse_attempts` 默认 4 | 将来启用这两个阶段时需显式设 1，不能只设 SDK 零重试 |
| `src/agent_memory/evaluation/trace_metrics.py` | 读取 `completion_tokens_details.reasoning_tokens` | 字段形式匹配，仍需整条 trace／报表验收 |

若以后要求原 benchmark CLI 直接使用，应在其配置入口透传执行设置，并按所选 provider 检查凭证；这是小幅入口改造，仍需要单独授权，不必改查询、维护算法或 LOTUS 依赖。本轮不实施。


## 报表验证的边界


假设服务端返回输入 59、输出 12、总计 71，其中推理 token 为 0。网关把 Responses usage 转成客户端熟悉的 Chat Completions usage；研究仓库的报表读取器已经知道去哪里找推理细分。

**能读这个字段，不等于整条报表链路已经验证过。**此前真实测试验证的是普通 LOTUS，尚未覆盖研究仓库自身的 trace 写入、读取、汇总及最终导出。推理是输出的子集，不能再加到总计里；缺失细分应保留未知，不能当作 0。已测真实样本的推理字段是明确的 0，仍需一个非零的离线样本来证明汇总不遗漏、不重复计算。
