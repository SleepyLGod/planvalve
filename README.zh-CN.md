# ChatGPT Plan Gateway

[English](README.md)

独立 TypeScript 轻量网关：提供兼容 OpenAI 的 Chat Completions 接口、单并发队列、token 记账、SQLite 历史和中英文 TUI。

**当前状态：默认服务使用离线样本。** 独立授权入口已通过两条真实订阅请求；常驻真实服务、凭证续期和多账号切换尚未实现。

## 安装与运行

需要 Node.js 26+、npm；不需要 Docker 或单独数据库服务。默认测试里的 POSIX 终端验收需要 Python 3.9+。只有可选 LOTUS 验收需要已安装的 LOTUS 环境。原始验收平台为 macOS。

```bash
npm ci --ignore-scripts --cache .npm-cache
npm start -- --config gateway.example.json
```

另一个终端进入同一目录：

```bash
npm run status
npm run status -- --lang en
npm run status -- --once --lang en
npm run --silent status -- --json
```

↑↓ 选择、回车查看摘要、R 查看原始字段、Esc 返回、←→ 翻页、Tab 切换历史、Q 退出监控。停止网关本身用 Ctrl-C。

网关只监听 `127.0.0.1:8787`，客户端 base URL 为 `http://127.0.0.1:8787/v1`。SDK 必须填 key 时可用非秘密占位值 `offline-test`；LiteLLM 模型可声明为 `openai/offline-model`，也可直接用普通 OpenAI SDK 或 HTTP。

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"offline-model","messages":[{"role":"user","content":"返回 JSON"}],"response_format":{"type":"json_object"}}'
```

样本固定返回 `{"answer":2}` 和历史用量 58/13/71，不会回答任意新问题，也不会计算新输入的实际 token。

## 能力与边界

支持文本消息、非流式客户端响应、文本／JSON object／JSON schema。并发固定 1，FIFO 排队，重试固定 0；可设置队列容量、等待期限、启动间隔、请求数和已观测 token 停止阈值。阈值不是服务端输出上限。

只转换协议要求的角色，不追加 agent 提示词、文件或历史。用量来自上游事件；未知细分不补零，缓存与推理不重复计入总量。JSON 不修补、不另发修复调用。SQLite 保存最后成功写入的状态，不恢复或重发历史任务。

```bash
npm run probe:live
```

真实入口需要独立登录并授权 ChatGPT 订阅用量，最多顺序发两条模型请求，任意失败即停止。凭证仅在内存中；普通 `npm start` 不会因此变成常驻真实服务。已观测的一次真实测试为：文本 10/5/15，JSON 44/12/56；服务端用量与本次 SQLite 一致。第二条网关耗时约 90 秒，原因尚未核实。

## 检查与可选 LOTUS 验收

```bash
npm run typecheck
npm run build
npm test
```

默认检查只访问本地样本，不发送真实模型请求。终端检查默认使用 `python3`，可用 `GATEWAY_TEST_PYTHON` 指定其他解释器。

```bash
GATEWAY_LOTUS_PYTHON=/path/to/existing/venv/bin/python npm run test:lotus
```

只有需要额外核对外部源码和依赖元数据时，才设置 `GATEWAY_LOTUS_REPO=/path/to/source`。不会安装或修改外部环境。

## 隐私与说明

`data/`、`reports/`、缓存、环境文件、数据库和本机实施记录不提交。注册标识虽然不是 token，也应作为本地私有信息；诊断报告可能包含输出、参数、错误、用量归因及本机路径。Git 忽略规则不能防止显式强制加入文件，推送前仍应检查。

- [配置](docs/configuration.md)、[协议与接口](docs/protocol.md)、[状态界面](docs/status.md)
- [真实小测试](docs/live-probe.md)、[验证范围](docs/offline-verification.md)、[样本来源](fixtures/README.md)
- [排错与限制](docs/troubleshooting.md)、[隐私与安全](SECURITY.md)、[发布检查](docs/privacy-review.md)

当前为私有项目，尚未授予开源许可（UNLICENSED）；各依赖保留自己的许可。
