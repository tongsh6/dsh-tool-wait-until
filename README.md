# dsh-tool-wait-until

[![npm version](https://img.shields.io/npm/v/dsh-tool-wait-until)](https://www.npmjs.com/package/dsh-tool-wait-until)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Event-driven waiting for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).** It gives the model a `wait_until` tool that returns the moment a background job finishes, a teammate goes idle, a file appears, or a log line matches — and fails fast on nonzero exit codes, error patterns and stalls, instead of burning a full timeout. It also **blocks the model's favorite empty-wait paths**: `sleep`-polling in bash and over-long `job_output` / `wait_agent` waits.

```sh
dsh plugin --profile web add dsh-tool-wait-until
```

Requires dsh 0.2.1 or later (declared as `engines.dsh`); verified against 0.2.1-rc.5. In the desktop app, install it from its plugin manager instead.

- **One call, one verdict**: `status` is `completed` / `failed` / `stalled` / `timeout` / `cancelled`, plus `elapsed`, `failure_reason` and `output_tail` — no second query needed.
- **Event-driven**: job settle / output growth wakes the wait immediately, independent of `poll_interval_sec`.
- **Stall detection**: no progress for N seconds returns `stalled` instead of waiting out the timeout. Job conditions default to 180s (`stall_after_sec: 0` disables).
- **Actionable timeout**: a timeout returns `suggested_timeout_sec` (≈2× elapsed, min 120) so the model retries once instead of creeping 60→90→120.
- **Behavior guard**: foreground `sleep >= 20s` and waits over 120s are rejected with a ready-to-use replacement; repeated `job_output` polling is discouraged in the prompt policy.
- **Zero dependencies**, standard JSON Schema, Node 20+.

中文说明见下。

消除 DSH 里「空等」的 Host 插件。它给模型一个**事件驱动**的等待原语 `wait_until`，并**主动拦截**模型最容易走的空等路径（`sleep` 轮询、超长 `job_output` / `wait_agent`、反复轮询 `job_output`）。作业条件默认 180 秒无进展即返回 `stalled`；`timeout` 会顺带给出 `suggested_timeout_sec`，避免模型用 60→90→120 小步试错。

## 要解决的问题

我们实际踩过的现象：

| 现象 | 现有行为 |
| --- | --- |
| 等 teammate | `wait_agent(timeout=30min)` 在对方卡死时等满 30 分钟，且只返回一个布尔值，事后还得查 `list_agents` |
| 等后台脚本 | `job_output(wait:true, timeout=15min)` 在作业卡住时等满上限，等待期间看不到任何进展 |
| 手工轮询 | `sleep 90` → 查文件 → 再估时间 → 再 sleep，一轮往返 1.5 分钟 |
| 等待中不可观测 | 只看得到「在等」，看不到中间日志、产出进度，无法判断「在跑」还是「卡住」 |
| 超时 ≠ 失败 | 超时返回后还要再查一轮才知道是超时、失败还是成功 |

关键观察：**光提供一个新工具不够**。模型在思考里会自己决定「等 180 秒再查」，如果行为不变，工具再好也不会被用。所以本插件做三层：

1. **决策前给规则**：往系统提示词注入「等待纪律」，要求等待一律用 `wait_until`，不许 `sleep` 空等。
2. **决策落地时硬拦截**：注册 `tools.guard`，把 `sleep ≥ 20s` 的前台 bash、超过 120s 的 `job_output` / `wait_agent` 等待直接拒绝，并在拒绝原因里给出可复制的 `wait_until` 替代调用。
3. **替代原语本身**：`wait_until` 工具，条件满足、目标失败或连续无进展时**立即返回结构化结果**。

## wait_until 工具

```js
wait_until({
  conditions: [
    { kind: 'job',   id: '<job_id>' },                    // 后台作业
    { kind: 'agent', target: 'worker' },                   // 团队成员
    { kind: 'file',  path: '/tmp/out.zip', until: 'exists' },
    { kind: 'log',   path: '/tmp/build.log', matches: '/EXIT=0/' },
  ],
  fail_fast: true,          // 或 ['job_failed', 'stderr_matches:/error|failed|Traceback/']
  stall_after_sec: 120,     // 连续 120s 无任何进展 → 立刻返回 stalled
  timeout_sec: 900,         // 总兜底，不是主要判定手段
  poll_interval_sec: 2,
})
```

返回（一次调用即可决策，无需二次查询）：

```json
{
  "status": "failed",
  "elapsed_ms": 1250,
  "elapsed": "1.2s",
  "matched": ["后台作业 bash-xxxx（结束）"],
  "conditions": [{ "condition": "后台作业 bash-xxxx（结束）", "state": "failed", "detail": "状态 completed — exit code: 3" }],
  "failure_reason": "后台作业 bash-xxxx 失败：退出码 3",
  "output_tail": "BOOM: intentional failure\n",
  "hint": "目标已失败，不必再等：按 output_tail / failure_reason 决策……"
}
```

注意上例的 `detail`：平台把「进程退出但退出码非零」记为 `completed`，本插件会识别该退出码并自行判定为 `failed` —— 否则下游会把「脚本报错」当成成功。

`status` 五态：`completed` / `failed` / `stalled` / `timeout` / `cancelled`。**超时不是失败**，单独一态。

多个 `conditions` 是 **wait_all** 语义：全部条件都满足才返回 `completed`；`fail_fast` 命中时任一条件失败立即返回 `failed`。（只想要「任一完成就返回」，请把条件拆成多次 `wait_until`。）

### 条件语义

| kind | 必填 | until | 说明 |
| --- | --- | --- | --- |
| `job` | `id` | `settled`（默认）/ `failed` | 作业结束（含失败）或仅失败 |
| `agent` | — | `inactive`（默认）/ `failed` / `status_changed` | 成员全部空闲 / 任一失败 / 任意状态变化 |
| `file` | `path` | `exists`（默认）/ `changed` | 文件出现 / 版本变化 |
| `log` | `path`, `matches` | `matches` | 日志尾部或新增内容命中正则 |

### fail_fast 模式

- `true`（默认）：`job_failed` + `job_killed` + `agent_failed`
- `false`：关闭
- 数组：`job_failed` / `job_killed` / `exit_code_nonzero` / `agent_failed` / `stderr_matches:/re/` / `output_matches:/re/`

`job_failed` 与 `exit_code_nonzero` 都会识别两种失败信号：平台记录的退出码（`detail: "exit code: N"`，N≠0）和作业输出里的 `EXIT=N`（N≠0）。因此**进程还没退出、但日志已宣布失败**时也能提前返回。

## 事件驱动到什么程度

- 作业条件：订阅 `jobs.events`，作业 settle / 输出增长 / progress 时立刻唤醒主循环，不受 `poll_interval_sec` 限制。
- 卡住提前返回：作业条件未显式设置 `stall_after_sec` 时默认 180 秒无进展即返回 `stalled`（显式传 `0` 关闭），不需要靠「小 timeout + 反复重试」试探。
- 文件 / 日志 / 队友：按 `poll_interval_sec` 采样（默认 2s）。
- 取消：全程响应 `exec.signal`，调用方打断时立即返回 `cancelled`。

## 拦截规则（硬约束）

| 拦截对象 | 条件 | 拒绝原因 |
| --- | --- | --- |
| `bash` | 前台命令里含 `sleep ≥ 20s`（不含 `run_in_background`、不含 `&` 后台） | 给出 5 条 `wait_until` 替代示例 |
| `job_output` | `wait:true` 且 `timeout_ms > 120000` | 要求改用 `wait_until` 分段等待 |
| `wait_agent` | `timeout_ms > 120000` | 要求改用 `wait_until` 的 agent 条件 |

其余调用一律放行。`sleep 3`、后台 `sleep`、普通命令不受影响。

`job_output` 的短轮询（不带 `wait` 的反复调用）不做硬拦截，只在系统提示词里劝阻：每次轮询占一个步骤，且拿不到失败判定；等待作业应使用 `wait_until`，需要日志时读一次即可。

## 文件结构

```
index.js           插件本体（零依赖，不 import 任何 @deepseek-ai 包）
cordis.patch.yml   插入 Loader 的条目（name 必须与 package.json 的 name 一致）
package.json       bundle 清单（dsh.bundle.patch 指向 patch）
locale/            中英文显示元数据（Plugin Manager / Settings 用）
icon.svg           插件图标
test/unit.mjs      本地单测（mock 服务，274 条断言，不依赖运行时）
docs/              仓库内文档，不发布到 npm：改造前基线实测、独立交叉验收报告
```

零依赖的原因：插件运行在宿主进程里，profile 的 `node_modules` 并不保证提供 `@deepseek-ai/dsh-tools` 等包，import 它们会解析失败。工具 schema 直接手写标准 JSON Schema（`parameters` 原样投影给模型，`output.schema` 由 `tools.register` 校验）。

## 本地测试

```bash
node test/unit.mjs
```

覆盖：立即失败、非零退出码识别、完成事件唤醒（poll 间隔 5s 时仍 <1.5s 返回）、卡住检测、作业条件默认 stall、超时（含 `suggested_timeout_sec`）、取消、批量 fail_fast、wait_all 语义、文件出现/变化、日志已命中/新增命中、队友空闲/失败、队友 stalled 语义、参数校验、两条 guard 规则、系统提示词注册、渲染格式。

## 安装

从 npm 安装：

```sh
dsh plugin --profile web add dsh-tool-wait-until
```

桌面应用里也可以直接在插件管理器中搜索安装。要求 dsh 0.2.1 或更高（见 `engines.dsh`），实测版本 0.2.1-rc.5。

**本地开发**时用链接方式安装源码目录，改动即时生效：

```sh
dsh plugin --profile web add link:/path/to/dsh-tool-wait-until
```

安装后 Plugin Manager 会把包写入 profile 的 `package.json` 与 bundle 列表，`cordis.patch.yml` 插入 `tool-wait-until` 条目；卸载时从插件管理器移除即可。

## 已知限制

- 模型在**思考阶段**是否萌生「等 180 秒」的念头无法直接干预；本插件只保证这个念头一旦落成工具调用就会被拦下并改道。
- `agent` 条件依赖 Agent Teams 服务；非 Team 会话调用会立即返回 `failed` 并说明原因，不会空等。
- `agent` 条件没有「活动」信号，只有成员状态与 diagnostics：队友跑长任务时，`stalled` 表示「状态长时间未变化」而非一定卡死，返回提示已改为「可能是长任务」。
- `wait_agent` / `job_output` 的拦截是硬拒绝，模型会消耗一步重试；拒绝原因里已附可直接复制的替代调用。
- 日志跨轮读取按字节窗口进行，多字节字符在窗口边界可能短暂出现替换符，不影响 ASCII 正则（如 `EXIT=0`、`error`）匹配。
- 多 `conditions` 是 `wait_all` 语义（全部满足才 `completed`），`fail_fast` 命中时任一失败即 `failed`。

## 开发注意

DSH 会在宿主进程内缓存已加载的插件模块：只修改本地 link 包的 JS 再重装，运行中的进程仍跑旧代码，需要重启 Desktop 才生效。改动模块路径（改包名或目录）会得到新的 ESM URL，重装后可免重启加载。

发布用 GitHub Actions：推送 `v*` tag 触发 `.github/workflows/publish.yml`，先跑单测、校验 tag 与 `package.json` 版本一致、检查该版本是否已存在，然后发布到 npm。
