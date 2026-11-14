# dsh-tool-wait-until

[![npm version](https://img.shields.io/npm/v/dsh-tool-wait-until)](https://www.npmjs.com/package/dsh-tool-wait-until)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/tongsh6/dsh-tool-wait-until)
[![DSH Plugin Hub: listed](https://dshpluginhub.ai/badges/plugins/dsh-tool-wait-until.svg)](https://dshpluginhub.ai/plugins/dsh-tool-wait-until)

> **版本说明**：本说明对应 **v1.2.0**。功能契约、实测环境与验证边界见 [验收记录](docs/acceptance.md)；发布状态以对应 tag 工作流和 npm 版本实际记录为准。

**Condition-based waiting for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).** The `wait_until` tool waits for jobs, teammates, files and log matches, then returns structured evidence for the next decision. Job events wake the wait immediately; file, log and teammate conditions are sampled at `poll_interval_sec` (default 2s).

```sh
dsh plugin --profile web add dsh-tool-wait-until
```

Declared compatibility: **Node >=20**, **dsh >=0.2.1-rc.1 <0.3.0**. An independent real-core-service smoke test passed on dsh **0.2.2-rc.3**. The declared range is not proof that every host release was tested; exact coverage is recorded in [acceptance](docs/acceptance.md).

- **Structured results**: `completed` / `failed` / `stalled` / `timeout` / `cancelled`, with condition snapshots, elapsed time and relevant output.
- **Useful defaults**: calls containing a job use a 300s timeout and a 180s group stall window; other calls use a 60s timeout with stall detection disabled unless requested.
- **Bounded waiting**: cancellation and the overall deadline cover awaited I/O; returning does not claim to stop underlying I/O or the watched task. The plugin returns `cancelled`, while a host executor may expose an `ABORTED` wrapper.
- **Behavior guard**: recognizable foreground `sleep >=20s` and `job_output` / `wait_agent` waits over 120s are rejected with alternatives. Repeated short polling is discouraged by the prompt policy.
- **Zero external dependencies**, standard JSON Schema.

## 要解决的问题

这是一个减少 Agent 空等与重复查询的 DSH Host 插件：先通过提示词说明等待规则，再拦截部分明确的空等调用，最后由 `wait_until` 提供统一结果。

[原生工具基线实测](docs/baseline.md) 已确认，原生 `job_output` 在作业完成或失败时能够提前返回。插件的增量价值集中在多类条件的统一判定、整组停滞检测、异步 I/O 的等待预算，以及调用行为约束。

| 等待场景 | 本插件提供的行为 |
| --- | --- |
| 后台作业结束或失败 | 作业事件唤醒，按指定 fail-fast 模式判断失败 |
| 等 teammate | 返回成员状态快照，区分观察到的状态变化与任务是否成功 |
| 等文件或日志 | 按间隔采样，不需要模型反复调用 bash 查询 |
| 连续没有可见进展 | 达到整组 stall 窗口后返回 `stalled`，供调用方判断 |
| 观察失败或等待超时 | 保留错误证据；正常观察超时才提供建议等待窗口 |

## wait_until 工具

```js
wait_until({
  conditions: [
    { kind: 'job', id: '<job_id>' },
    { kind: 'agent', target: 'worker' },
    { kind: 'file', path: '/tmp/out.zip', until: 'exists' },
    { kind: 'log', path: '/tmp/build.log', matches: '/DONE/' },
  ],
  fail_fast: true,
  stall_after_sec: 120, // 整组连续无可见进展的窗口
  timeout_sec: 900,     // 本次调用的总预算
  poll_interval_sec: 2,
})
```

返回示例：

```json
{
  "status": "failed",
  "elapsed_ms": 1250,
  "elapsed": "1.2s",
  "matched": ["后台作业 bash-xxxx（结束）"],
  "conditions": [{ "condition": "后台作业 bash-xxxx（结束）", "state": "failed", "detail": "状态 completed — exit code: 3" }],
  "failure_reason": "后台作业 bash-xxxx 失败：退出码 3",
  "output_tail": "BOOM: intentional failure\n"
}
```

`completed` 表示**等待条件满足**，不保证目标任务成功；例如关闭 fail-fast 后，失败作业也可以满足“已经结束”条件。`failed` 既可能来自目标失败，也可能来自无法继续观察的错误。`stalled` 表示整组在窗口内没有观察到进展，不等于已经证明进程卡死。超时和取消分别使用独立状态。

多个 `conditions` 采用 **wait_all**：当前状态条件需要在检查时仍满足，事件条件在本次调用中一旦观察到即可保留。任一启用的 fail-fast 规则命中会提前返回。当前没有 `wait_any` 接口，拆成多次顺序调用也不等价于“任一完成”。

`output_tail` 是最近的相关输出，批量等待时不保证合并所有目标的日志；需要完整日志时仍应读取相应作业。

### 条件语义

| kind | 必填 | until | 判定与保留方式 |
| --- | --- | --- | --- |
| `job` | `id` | `settled`（默认）/ `failed` | 当前作业已结束（含失败）或已失败；是否提前报失败由 fail-fast 控制 |
| `agent` | — | `inactive`（默认）/ `failed` / `status_changed` | 空闲/失败按当前成员状态判断；`status_changed` 在本次调用中观察到变化后锁存 |
| `file` | `path` | `exists`（默认）/ `changed` | `exists` 按当前存在性判断；`changed` 要求当前存在且版本不同于首轮，首轮缺失后的首次出现也算变化 |
| `log` | `path`, `matches` | `matches` | 尾部或新增内容命中正则后，在本次调用内锁存，不要求与其它条件同轮命中 |

`agent.target` 省略时观察除调用方以外的成员；没有 Agent Teams 服务时立即返回 `failed` 并说明原因。

### 默认等待策略

| 调用情况 | 默认 `timeout_sec` | 默认 `stall_after_sec` |
| --- | --- | --- |
| 条件中包含 job | 300 秒 | 180 秒 |
| 只有 agent / file / log | 60 秒 | 关闭 |
| 显式传入参数 | 使用显式值并按边界归一化 | `0` 关闭；正值最少 5 秒 |

总超时范围为 1–900 秒；采样间隔默认 2 秒，范围 0.25–30 秒。stall 是**整组无进展**：任一被观察目标有新进展都会刷新计时。等待唤醒同时考虑作业事件、采样时间、总 deadline 和 stall 截止点。

正常观察后的 `timeout` 可以返回 `suggested_timeout_sec`（约已等待时长的两倍，最少 120 秒、最多 900 秒）。它只是下一次调用的建议，不会自动重启任务或重复执行作业。如果超时时仍有读取错误，返回错误细节并提示先检查，不盲目建议延长等待。

### fail_fast 模式

- `true`（默认）：`job_failed` + `job_killed` + `agent_failed`。
- `false` 或 `[]`：关闭目标失败的提前返回；无法继续观察的错误仍会返回失败。
- 数组：只启用指定的 `job_failed` / `job_killed` / `exit_code_nonzero` / `agent_failed` / `stderr_matches:/re/` / `output_matches:/re/`。

`job_failed` 根据真实作业状态和已记录的非零退出码判断，不把普通日志里的 `EXIT=N` 当作默认失败证据。**只有显式选择 `exit_code_nonzero` 时**，才在没有真实退出码的情况下读取独占完整行的 `EXIT=N` 标记；任一完整非零标记可触发失败，真实退出码优先。

文本退出标记从保留起始行边界的原始窗口解析，不从展示用的 `output_tail` 截断内容反推。它仍是调用方主动选择的日志约定，不是进程退出状态的替代品。

## 观察、取消与边界

- job 条件订阅 `jobs.events`；文件、日志和队友按采样间隔检查。
- 启用 job 相关 fail-fast 时，监视与初扫在工作目录解析前建立，事件通知后复查真实 job 状态，并按采样间隔独立复查。即使工作目录或文件 I/O 挂起，已确认的 job 失败也可结束本次等待；失败观察不消费正常进展状态，不重启挂起 I/O，也不停止底层 I/O 或目标任务。`false`、`[]` 或仅 `agent_failed` 不会因此升级为 job fail-fast。
- 取消信号与总 deadline 覆盖工作目录解析和异步观察 I/O。插件返回 `cancelled` / `timeout` 表示本次等待结束，不承诺底层 I/O 或目标任务已停止。本机 DSH 0.2.2-rc.3 的 Native executor 会将 caller abort 包装成 `isError: true`、`error.info.code: ABORTED`；不能假设每个宿主外层都直接返回插件的 `cancelled` 对象。
- 权限、无效路径等确定性读取错误返回 `failed`；可恢复错误保留在 `conditions[].detail` 中供后续观察和最终判断。
- 日志支持同尺寸且版本变化的覆盖、缩小和观察到的删除后重建；正常追加继续按有界窗口读取。首次出现和删除也作为可见进展。
- 仅靠文件版本与尺寸，不能保证区分同一轮询间隙内“替换成更大的文件”和“原文件正常追加”。
- 日志按字节窗口读取，多字节字符跨窗口时可能出现替换符；匹配复杂非 ASCII 内容时需要考虑这个限制。
- agent 的进展信号来自成员状态和 diagnostics，无法证明其内部每一步工作是否推进；长任务状态不变不等于卡死。

## 行为拦截

| 拦截对象 | 条件 | 处理 |
| --- | --- | --- |
| `bash` | 可可靠识别的前台字面量 `sleep >=20s` | 拒绝并给出 `wait_until` 示例 |
| `job_output` | `wait:true` 且 `timeout_ms >120000` | 拒绝并给出替代等待方式 |
| `wait_agent` | `timeout_ms >120000` | 拒绝并给出 agent 条件示例 |

sleep guard 理解有限的引号、转义、重定向、管道和 `&&` / `||` 命令组：

```sh
printf '%s\n' 'example; sleep 180' # 放行：只是打印字符串
sleep 90; echo done &            # 拦截：sleep 在前台
sleep 90 && echo done &          # 放行：整个命令组在后台
sleep 90 | cat                  # 拦截：前台管道
sleep 90 | cat &                # 放行：后台管道
sleep 90 2>&1                   # 拦截：重定向不是后台
```

`run_in_background:true` 继续放行。命令替换、括号/花括号分组、heredoc 等复杂语法保守不硬判；它是帮助模型避免常见空等的规则，不是完整 shell 解释器或安全边界。

反复短调用 `job_output` **只有提示词劝阻，没有硬拦截**。模型思考过程、其它形式的轮询或复杂脚本不能由这些规则完全控制。

## 文件结构与文档

```text
index.js                    等待条件、结果、默认策略与宿主注册
wait-guard.js               有限 shell 词法识别，无外部依赖
cordis.patch.yml            Loader 条目
package.json                包清单、版本范围、发布文件清单
locale/、icon.svg           插件管理器显示信息
test/unit.mjs               不依赖 DSH 运行时的内存 mock 回归
test/host-smoke.mjs         已安装 DSH 核心服务验证入口
.github/workflows/test.yml  PR / main 的 Node 版本矩阵单测
.github/workflows/publish.yml  tag 发布前门禁与 npm 发布
docs/                      验收与历史基线，不发布到 npm
```

- [当前验收状态与历史报告](docs/acceptance.md)：A/B/C 批次、验证命令、证据范围和历史宿主实测。
- [原生工具基线](docs/baseline.md)：改造前对照，不代表当前插件行为。

插件运行在宿主进程内，宿主 profile 不保证能解析所有 `@deepseek-ai/*` 包。发布入口保持零外部依赖，只使用标准 JSON Schema 和宿主注入的服务；`wait-guard.js` 随 npm 包一起发布。

## 本地测试与 CI

```sh
node test/unit.mjs
```

覆盖目标失败、fail-fast 选择、退出标记边界、事件锁存、取消和挂起 I/O 的 deadline、混合挂起 I/O 中的 job 提前失败、初扫、清理、整组 stall、文件与日志变化、错误证据以及有限 guard 词法。断言数以当次输出为准；1.2.0 的完整单测、旧实现红验证及真实进程立即/3秒/5秒失败记录见 [验收记录](docs/acceptance.md)。

独立宿主核心服务验证入口为 `test/host-smoke.mjs --runtime-root <DSH根目录>`，根目录应包含 `node_modules/@deepseek-ai`。本机 DSH 0.2.2-rc.3 的实际 Electron Node 命令、真实服务与测试夹具的边界，以及通过结果均记录在验收文档中；没有用该结果声称完整 Desktop、Agent Teams 或模型行为已经通过。

`.github/workflows/test.yml` 在 pull request 和 push 到 `main` 时使用 Node 20 / 22 / 24 运行同一单测，不安装 npm 依赖、不使用发布凭据。设置了任务限时和同分支重复运行取消。真实宿主核心服务验证的环境、命令和结果单独记录，不用 mock 单测代替。

tag 发布仍保留 `.github/workflows/publish.yml` 的单测、版本一致性和已发布版本检查。配置了工作流不等于远端 CI 已执行通过。

## 安装与本地开发

从 npm 安装已发布版本：

```sh
dsh plugin --profile web add dsh-tool-wait-until
```

桌面应用也可以从插件管理器安装。声明的 DSH 范围为 `>=0.2.1-rc.1 <0.3.0`；本版本的实测范围以验收记录为准。

本地源码使用链接方式安装：

```sh
dsh plugin --profile web add link:/path/to/dsh-tool-wait-until
```

插件管理器会把包写入 profile 的 `package.json` 与 bundle 列表，由 `cordis.patch.yml` 加载插件；卸载时从插件管理器移除。

DSH 宿主会缓存已加载模块。源码文件变化不保证运行中的实例立即更新，重新加载或重启后再验证实际行为。历史报告中的改名加载方法是当时的处理记录，不是通用热更新保证。

发布由 `v*` tag 触发：有 `NPM_TOKEN` 时优先使用该凭据，否则使用 OIDC Trusted Publishing。源码说明、tag 工作流状态与 npm 已发布版本分别以实际记录为准。
