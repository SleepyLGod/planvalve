# 可配置并发与限流 Implementation Plan

> 实施阶段记录（已完成）。勾选表示各任务已有离线验收证据；当时不提交或推送。后续有界真实验收和私有开发分支保存另行获得授权，结果见[验收记录](../../offline-verification.md)。

**Goal:** 用成熟任务队列支持可配置并发、平滑 RPM 和明确的上游冷却，同时保留准确的请求记录、预算与零自动重试。

**Architecture:** 一个 `p-queue` 管理全部模型任务及其并发槽位；一个短的实际发送临界区控制节奏、冷却、有效凭证和最终预算检查。临界区只等发送资格，不等响应头或模型结果；调用 start 后无条件接管其网络 Promise，取消不能丢掉已启动的请求；任务槽位则一直保留到传输、校验与持久化全部收尾。复用现有协议、SQLite 和 TUI，不加入第二个通用任务队列。

**Tech Stack:** Node.js >=26、TypeScript、现有 OpenAI SDK／SQLite／测试工具；唯一新增运行依赖 `p-queue@10.0.0`，精确锁定、MIT、无运行依赖。

**Spec:** [已确认的需求基线](../specs/2026-11-06-rate-limiting-design.md)。本计划将其中的选型和待定契约落定；下文记录实施约定，任务完成情况与验收结果见末尾。

## 实施阶段约束（历史记录）

- 所有实现、依赖和产物仅在本项目内；保留已有未提交改动，不修改其他仓库、日常 Codex 配置或现有私人配置。
- 默认并发 1；真实模式默认间隔 3000ms、离线默认 0；新增本地 RPM 默认 `null`；自动重试为 0。
- 不登录、不发送真实模型／OAuth 请求；只允许安装项目依赖时访问 npm。全部运行验收启用现有非 loopback 网络拦截。
- 不提交、不 push、不合并、不公开；本机凭证、Key、数据库和报告仍被忽略。不得永久删除文件。
- 不增加预测 TPM、账号池、Redis、动态并发、远程访问、自动续跑或管理接口。预算、节奏与冷却按本次运行计算，不声称重启恢复官方额度。

## Review Focus

1. 首个请求的准备变慢时，后续请求不得扎堆实际发送；由任务 2、3 的回归覆盖。
2. 底层取消收尾较慢时，不得先释放槽位并启动替代请求；由任务 2、3、4 覆盖。
3. 一个刷新等待者超时或服务停止时，不得破坏其他等待者／提前释放授权锁；由任务 2 覆盖。
4. 一个在途请求成功时，不得清除另一个请求建立的冷却／暂停；由任务 3、4 覆盖。
5. 持久化及其通知回调触发暂停／关闭时，不得继续调用 fetch；由任务 3、4 覆盖。

---

## 一、确定的行为与接口

### 配置、时间与预算

- `Config.concurrency: number = 1`，`Config.maxRequestsPerMinute: number | null = null`；非正整数、非安全整数及非有限值拒绝启动。旧配置缺少字段时使用默认值，不重写本机配置，不要求重新初始化。
- 平滑发送间隔为 `max(minStartIntervalMs, RPM === null ? 0 : ceil(60000 / RPM), slowDownIntervalMs)`。例如 20 RPM 至少间隔 3000ms；这是保守的本地上限，不承诺短时突发利用率，也不实现完整的滚动窗口计数器。
- 发送间隔／冷却使用 `performance.now()`。显示日期、OAuth 到期和历史时间仍使用正常 UTC 时间；不得修改全局时钟或第三方包源码。
- `queueCapacity` 只限制等待执行的任务，不含最多 `concurrency` 个已开始任务。排队期限从入队到执行函数开始；随后现有 `upstreamTimeoutMs` 覆盖发送准备、节奏／冷却等待及传输读取。未发送即到期为 `429 dispatch_expired`，只结束该任务，保留冷却且不全局暂停。
- 最终实际发送前同步检查请求预算和已观测 token 阈值，成功写入派发记录并确认仍允许发送后，增加尝试数并立即调用 fetch；中间没有 await。写失败或通知引发关闭时，发送次数与预算增量都必须为 0。
- token 阈值只停止后续派发；已发送的任务继续收尾，最终累计量可能超过阈值。超时无法证明远端未执行，必须记录未知状态并暂停，不能当作没有消耗。

### 队列与发送控制的契约

保留 `src/queue.ts` 的 `Queue`，内部以一个 `PQueue` 替换手写 pump。对网关暴露：

```ts
constructor(config: Pick<Config, "concurrency" | "queueCapacity" | "maxQueueWaitMs">)
submit<T>(execute: () => Promise<T>, signal: AbortSignal): Promise<T>
pause(): void
close(): Promise<void>
stats(): { running: number; waiting: number; paused: boolean; closed: boolean }
```

- 不启用 `p-queue.timeout`、`intervalCap` 或 `interval`。库只拥有任务队列和并发，避免将任务开始误当作发送，也不借其超时提前释放运行槽位。
- 使用独立的排队取消信号移除尚未开始的任务；执行函数开始后解除客户端／排队期限对库信号的转发；发送控制另保留未发送任务的断连取消，实际开始 fetch 后才解除。已发送后的客户端断连沿用当前收集结果与 usage 的行为。
- `pause()` 先停止库派发，再使库中等待任务明确结束为现有 `gateway_paused`；已开始但未发送的任务由发送控制拒绝，已发送任务继续。临时冷却不调用 `pause()`／`clear()`。
- 正常关闭先关闭发送控制、取消未发送工作，再等库任务全部收尾。每条任务的 Promise 必须涵盖最终 SQLite 写入；不得 fire-and-forget 模型任务或吞掉拒绝。

新增 `src/dispatch.ts`，仅保存一个临界区尾 Promise、最后实际发送时间、冷却期限、暂停原因和本次减速间隔；不再保存一份完整请求队列。接口：

```ts
run<T, R>(signal: AbortSignal,
  prepare: (signal: AbortSignal) => Promise<T>,
  start: (prepared: T) => Promise<R>): Promise<R>
apply(decision: RateDecision): RateDecision
pause(reason: string): void
close(): void
snapshot(): DispatchSnapshot
```

- 构造参数取上述两个节奏配置；仅为测试注入内部时钟 `DispatchClock { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> }`，默认使用单调时钟及 Node 可取消定时器。随机延迟生成器亦可在内部测试注入，不进入配置或 HTTP 接口。
- `run` 进入临界区后：检查关闭／暂停 → 等发送间隔与冷却 → 准备有效凭证 → 重查所有发送条件。若准备期间约束改变，重新等待并重新取得凭证，不能握着旧 token 等长冷却。
- 满足条件后调用同步的派发检查／持久化回调，再立即发起 fetch。以包住 Promise 的普通对象把网络结果传出临界区，随后在临界区外 await；不得因 async Promise 展平而把响应头等待串行化。
- 准备或一个等待者失败不能把临界区尾 Promise 留在拒绝态，阻塞后续清理。冷却更新采用 `max`，硬暂停不被成功响应解除；等待到期须重新检查，不依赖定时器恰好准时触发。

### 上游反馈与减速

新增 `src/rate-limit.ts`：纯解析／分类，不管理队列、凭证或 HTTP 服务。`RateDecision` 放入共享类型：

```ts
type RateDecision =
  | { action: "none" }
  | { action: "cooldown"; delayMs: number; reason: string; slowDown: boolean }
  | { action: "pause"; reason: string };
```

- `rateDecision(status: number, code: string | undefined, headers: Record<string, string>, nowWallMs: number): RateDecision`；只接受白名单头：`date`、`retry-after`，以及 requests／tokens／project-tokens 三组 `x-ratelimit-{limit,remaining,reset}-*`。每个值最多 256 个可打印 ASCII 字符，其他响应头不存储。
- 对明确临时错误，429 识别 `rate_limit_exceeded`／`slow_down`，503 识别 `server_is_overloaded`／`subscription_sharing_usage_unavailable`。有有效 `Retry-After` 或明确耗尽桶的有效 reset 才冷却；没有可靠提示则暂停，失败的当前请求照常返回且不重排。
- `Retry-After` 接受非负整数秒数或 IMF-fixdate HTTP 日期；日期优先相对有效响应 `Date` 计算，否则相对接收时本机日期计算。reset 支持按 d／h／m／s／ms 降序组成的时长，允许小数，完整匹配后向上取整毫秒；拒绝重复单位、负数、部分匹配和溢出。
- 多个相关提示取最长时间。有任一可靠提示时仍可冷却，坏字段或缺失 reset 不能覆盖有效 Retry-After／reset；仅无可靠提示时暂停。明确超出定时器范围的等待仍须暂停，不截短。成功响应也检查明确耗尽的桶，延迟后续请求，不改变当前成功结果。
- 上限为 Node 定时器支持的 2147483647ms；不得把更长等待截短发送。临时冷却附加 0–250ms 的正向随机延迟；合计超出支持范围也暂停。
- 订阅用量超限、余额／账单问题、401／403、未知上游错误、断流／超时、缺失有效 usage 和存储失败保留暂停策略，等待头不能覆盖。客户端入参拒绝不进入模型队列。错误分类优先于 HTTP 状态，覆盖 HTTP 200 中的失败事件。
- 收到有效提示的 `slow_down` 后，将本次运行的减速间隔设为 `2 * max(1000, 当前有效间隔)`，并同时满足服务器等待；后续同类反馈继续翻倍，超出定时器范围则暂停。成功不自动降回原速，不改变并发配置；这个倍率是本地策略，不是官方安全阈值。
- 成功响应头已独立表明桶耗尽时立即约束后续派发；终态错误仍可升级为硬暂停，同一条头的冷却不在完成时重复累加。apply 返回最终生效决策，溢出统一进入 pauseSender。保存原始白名单头、请求 ID 和本次决策，保留已有 `retryAfter` 字段；不保存原始错误正文、prompt、输出或凭证。
- 网关集中使用 `pauseSender(reason: string): void`，按发送控制 → 任务队列的顺序同步暂停；存储失败、预算停止及上游硬错误均走此入口，防止只暂停队列却让准备中的任务继续发送。冷却只更新发送控制，不清空任务队列。

### 请求、授权和监控

- `officialUpstream.complete` 内创建请求独立 SDK／fetch 闭包，绑定该次 record、signal、onDispatch；删除当前共享的 `active`／`dispatched` 变量。复用现有 `isolatedSDK` 的同步隔离构造，不增加 AsyncLocalStorage 或插件系统。
- 向上游工厂传入 `DispatchControl`；实际 fetch 由其 `run` 包住，凭证准备在 `prepare` 中，原有同步 `onDispatch` 负责最终预算／记录。离线 fixture 和独立 probe 同样经过这条派发检查，不能绕过次数上限或重试为 0 的限制。
- 共享 OAuth 刷新使用会话及自身有界生命周期，不采用首个模型请求的 signal。`accessToken(signal?)` 中单个调用者只取消自己的等待；网络仍沿用每次 20 秒期限，加一次完整刷新 60 秒总期限，成功轮换只持久化一次。
- `CredentialSource.close(): void | Promise<void>`；真实会话的 close 幂等并返回 Promise：拒绝新等待者，允许已开始的有界刷新完成验证／原子保存，然后关闭会话并释放锁。网关、CLI 和测试均 await 其关闭；没有活动刷新时不产生网络请求。刷新失败沿用原凭证处理，提供脱敏错误而非伪装刷新成功，锁在收尾 finally 中释放。不能为了快关而丢掉刚轮换的 token 或让第二进程提前取得锁。
- 不新增请求状态枚举或数据库表。现有 `queued`／`running` 等保持；为记录追加可选 `rateLimit: { observedAt: string; headers: Record<string,string>; decision: RateDecision }`。SQLite 的 record JSON 兼容旧记录，无需迁移。
- 保留 `StatusSnapshot.queue` 原字段；新增 `preparing`（已开始但未派发）、`inFlight`（已派发且未收尾）。`running` 仍指全部占用任务槽位者，满足 `running = preparing + inFlight <= concurrency`。
- 新增 `StatusSnapshot.dispatch: DispatchSnapshot`：`state` 为 ready／spacing／cooldown／paused／closed，`waitMs`、`reason: string | null`、`effectiveStartIntervalMs`、`maxRequestsPerMinute`；最后观察的头及时间放入可选 `upstreamLimits`，不是余额。旧监控数据缺少新增字段时显示未知，不伪造 0。
- 中英文 TUI、一次打印和 JSON 显示配置间隔、实际生效间隔、实际在途及等待原因；状态查询仍无派发、预算、历史写入或 JSON 快照副作用。

## 二、文件职责

| 文件 | 本轮职责 |
| --- | --- |
| `src/queue.ts`，新增 `src/dispatch.ts`、`src/rate-limit.ts`、`src/transport.ts` | 唯一任务队列、实际发送控制、纯上游反馈解析；小型响应体适配器等待 SDK 未等待的底层取消清理，保持槽位直到真正收尾。 |
| `src/config.ts`、`src/types.ts` | 两个配置字段及兼容的状态／记录类型；不新增环境变量。 |
| `src/upstream.ts`、`src/gateway.ts` | 每请求闭包、全部模式统一派发、最终预算检查及结果／持久化收尾。 |
| `src/auth.ts`、`src/auth-cli.ts`、`src/cli.ts` | 共享刷新等待者隔离、有界关闭、await 关闭调用者。 |
| `src/view.ts`、`src/language.ts` | 原有中英文监控扩展，不重写 UI 或增加框架。 |
| `tests/queue.test.ts`、`tests/dispatch.test.ts`、`tests/rate-limit.test.ts` | 新增三个模块的契约测试；集成继续放入现有 auth／upstream／gateway／status／monitor／view／local 测试。 |
| `package.json`、`package-lock.json`、三份 `gateway.*example.json`、相关 README／docs／TODO | 精确依赖、配置示例和能力／限制说明；不编辑 `data/local/`。 |

## 三、实施任务与验证

### Task 1：建立基线及配置契约

**Files:** `package.json`、`package-lock.json`、`src/config.ts`、`src/types.ts`、`tests/cli.test.ts`。

- [x] 分别运行现有 `npm run typecheck`、`npm run build`、`npm test`，记录实际结果；先区分既有失败与本轮回归，不用真实调用排错。
- [x] 增加配置回归并验证 RED：旧配置得到 `concurrency === 1`、`maxRequestsPerMinute === null`；并发 4、RPM 20 被接受；0、负数、小数、Infinity、非安全整数及非数类型被拒绝。
- [x] 仅安装 `npm install --save-exact --ignore-scripts p-queue@10.0.0`；保留现有依赖和用户改动，检查 lock 无其他版本漂移。补配置和共享类型，使后续任务消费的接口与第一节一致。
- [x] 运行 `node --import ./tests/network-guard.ts --test tests/cli.test.ts` 及类型检查；配置回归全部通过，再进入任务 2。

### Task 2：移除并发状态串台及共享刷新耦合

**Files:** `src/upstream.ts`、`src/auth.ts`、关闭调用者及 `tests/upstream.test.ts`、`tests/auth.test.ts`。

- [x] 写 `request records remain isolated under reversed completion` 并验证 RED：直接并发调用上游完成接口，两请求不同 token usage／请求 ID，故意延迟第一条响应头并逆序完成，断言记录逐条匹配；一条失败不改写另一条记录。此时网关仍使用旧队列，不提前变更调度。
- [x] 刷新测试使用假 OAuth：两个等待者共享一次刷新，首个等待者取消不影响第二个；零等待者时刷新仍可原子保存；close 等待有界刷新收尾且在此之前第二个 AuthStore 仍拿不到锁。临时失败保留凭证，终止失效维持原语义。
- [x] 实现每请求 SDK 闭包、刷新生命周期隔离及可等待的 close，更新所有真实调用者与测试。本任务先保持 `officialUpstream` 原工厂签名，任务 3 再增加发送控制参数；保留原 SDK／网关零重试和 probe 最多两次约束。
- [x] 运行 `node --import ./tests/network-guard.ts --test tests/auth.test.ts tests/upstream.test.ts tests/live-probe.test.ts tests/stream-tail.test.ts`；这些命名为 probe 的测试也只能使用模拟传输。

### Task 3：成熟队列、实际发送控制及并发预算

**Files:** 修改 `src/queue.ts`；新增 `src/dispatch.ts`、`tests/queue.test.ts`、`tests/dispatch.test.ts`；接入 `src/upstream.ts`、`src/gateway.ts`。队列替换与节奏接线放在同一任务，避免中间版本丢掉旧发送间隔。

- [x] 写 `queue bounds execution and settles every waiter` 并先验证 RED：64 个任务分别设并发 1／2／4，以阻塞屏障证明最大执行数恰好达到且不超过配置值；`queueCapacity=2` 满后明确拒绝；FIFO 开始、允许乱序完成。覆盖排队取消／超期、pause 拒绝等待者、close 等待收尾，无悬空 Promise 或重复结算。
- [x] 写 `dispatch paces actual sends with a monotonic clock` 并验证 RED：RPM 20 推导间隔 3000ms，配置间隔 5000ms 时取 5000ms；并发 4 下每次实际发送都满足生效间隔；系统日期跳变不改变间隔／冷却长度。长时间场景使用内部假时钟，不实际等一分钟。
- [x] 覆盖慢凭证、准备期间更新冷却、等待后重新取凭证、一个准备失败不毒化临界区，以及发起 fetch 后第二条可在第一条响应头返回前派发。断言不是伪装成并发的串行请求。
- [x] 集成 RED：并发 4、`maxRequests=1`、慢凭证时 `actualSends === 1`；SQLite 派发写失败或其通知触发关闭时 `actualSends === 0`；token 阈值到达后不再发送，在途 usage 完整收尾。
- [x] 实现第一节 Queue 包装与 DispatchControl 并在同一任务接入所有模式；延迟底层取消期间断言 `maxActive <= concurrency`。最终预算回调同步完成检查、持久化及发送前复查；删除 Queue 的旧 `lastStart` 外部修改路径。先保留所有上游失败的原硬暂停，任务 4 再区分临时冷却。
- [x] 运行 `node --import ./tests/network-guard.ts --test tests/queue.test.ts tests/dispatch.test.ts tests/upstream.test.ts tests/gateway.test.ts tests/status.test.ts tests/stream-tail.test.ts` 及类型检查；现有串行、间隔、超时及完成事件回归同时通过。

### Task 4：官方等待提示、减速及暂停

**Files:** 新增 `src/rate-limit.ts`、`tests/rate-limit.test.ts`，修改 `src/gateway.ts`、`src/upstream.ts` 及其集成测试。

- [x] 按第一节解析表写 RED：秒数／HTTP 日期／组合时长、多桶取最长、零剩余、未知字段、无效／超长／溢出提示、缺失 reset；检查原始白名单头与决策可保留，凭证及错误正文不进入记录。
- [x] 集成 RED：第一条临时失败只发送一次，下一条在提示期限之后发送；订阅用量、余额、权限错误即使有 Retry-After 也保持暂停；HTTP 200 的订阅失败事件同样暂停。
- [x] 覆盖并发响应交错：较早期限不能缩短既有冷却，成功不能解除暂停；slow_down 连续反馈导致间隔翻倍且成功不复原；正向抖动从不使发送提前；溢出明确暂停。
- [x] 实现解析、决策应用及持久化顺序。排队取消／超期、准备中超时、关闭和存储失败都必须终止未发送工作并保留已发送的记录；没有任何自动重新入队分支。
- [x] 运行 `node --import ./tests/network-guard.ts --test tests/rate-limit.test.ts tests/dispatch.test.ts tests/upstream.test.ts tests/gateway.test.ts tests/status.test.ts`。

### Task 5：监控、兼容与本机入口

**Files:** `src/types.ts`、`src/view.ts`、`src/language.ts`；`tests/status.test.ts`、`tests/monitor.test.ts`、`tests/view.test.ts`、`tests/local.test.ts`。

- [x] 先写 RED：准备／在途／等待计数与实际传输一致；中英文均显示冷却倒计时与生效间隔；旧历史／旧状态对象缺少新增字段仍可查看，一次 JSON 可直接解析。
- [x] 验证反复查询状态与退出监控不增加模型次数、不改变预算、不写请求历史；旧本机配置、Key 和授权文件无重写、无重新登录；真实模式原访问保护继续生效。
- [x] 实现状态与 UI 的兼容性扩展，SQLite 只追加 record JSON 字段，不做迁移、不导入旧报告、不重写历史；保留原始 usage 及缺失为未知的语义。
- [x] 运行 `node --import ./tests/network-guard.ts --test tests/status.test.ts tests/monitor.test.ts tests/view.test.ts tests/local.test.ts`。

### Task 6：文档、完整离线验收与交付

**Files:** 中英文 README、三份示例配置、`docs/configuration.md`、`docs/status.md`、`docs/troubleshooting.md`、`docs/offline-verification.md`、`TODO.md`。

- [x] 更新默认值、平滑 RPM 的例子、排队／执行期限边界、slow_down 减速、本次运行预算及在途超额可能；清除本轮涉及文档中仍把单并发写成永久限制的描述。保留 LOTUS 为案例、订阅与 API 限制不同、真实长期运行尚未验收等事实。
- [x] 分别运行类型检查、构建和完整 `npm test`；再通过现有 `GATEWAY_LITELLM_PYTHON`／`GATEWAY_LOTUS_PYTHON` 指定已经安装的 Python 环境运行 `npm run test:litellm`、`npm run test:lotus`。只读复用依赖，不安装／修改外部环境；不可用时如实报告，不能视为该项通过。
- [x] 验收产物仅写忽略的项目内 `reports/`，使用隔离数据库、假凭证和测试配置。再次确认网络拦截覆盖子进程；报告各项实际结果，不把纯库实验或模拟通过称为真实账号长期验证。
- [x] 检查 diff、文档链接和示例 JSON；确认用户既有未提交工作、本机配置及其他仓库未被覆盖。保留全部改动未提交、未推送，交付结果与限制后停止。

## 四、审查依据与交付界限

2026-11-06 的只读复核包括官方文档、sub2api 的职责划分及固定发布版 p-queue 的内存实验：64 任务并发 4 的上限成立；库超时配合忽略取消的底层任务会提前释放槽位；任务开始限速在异步准备后不保证实际发送限速。上述结果只证明选型语义，不证明本计划已实现。

- [p-queue 固定版文档](https://github.com/sindresorhus/p-queue/blob/v10.0.0/readme.md)：不修改第三方源码，不依赖未发布 main 行为。
- [sub2api 并发职责](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/service/concurrency_service.go)：参考槽位与等待分离，不复制代码或引入多实例设施。
- [官方限流](https://developers.openai.com/api/docs/guides/rate-limits)、[订阅错误](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)、[订阅接口限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)：遵循等待与额度处理，零自动重试是本项目的明确选择，3 秒／翻倍策略不代表官方保证。

执行方式：在同一会话按任务逐项实现，最后独立只读审查与统一验收；已完成，实施阶段结束时保持未提交／未推送。后续保存至私有开发分支另行获得授权，不合并 main、不公开。

执行结果：初次调度验收的类型检查、构建通过；完整离线测试 110/110，独立 LiteLLM 12/12，LOTUS／Python SDK 三次模拟验收通过。独立审查的 8 个问题均完成针对性 RED→GREEN；该阶段没有真实调用、提交或推送。后续终态反馈和脱敏修复增加 3 项回归，完整离线测试达到 113/113；另行授权的两请求真实调度验收也已通过。限流恢复及长期运行仍未实测，详见[验收记录](../../offline-verification.md)。
