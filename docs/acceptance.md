# wait_until 验收记录

> 当前记录日期：**2026-11-14（Asia/Shanghai）**。本文记录 **v1.2.0** 的本地验收，优化工作以 `160afe7` 为基础。包版本为 `1.2.0`；源码版本、测试通过和 npm 发布是不同事实，发布状态以对应 tag 工作流与 npm 实际记录为准。

[返回使用说明](../README.md) · [原生工具基线](baseline.md)

## 1.2.0 当前验收

| 检查 | 范围 | 已取得的证据 | 结论 |
| --- | --- | --- | --- |
| 完整单元回归 | A/B/C 行为与混合挂起 I/O 的 job fail-fast 修复 | Node v24.19.0，43 个用例函数，791 条断言通过，0 失败，36587ms | 当前完整单元回归通过 |
| 缺陷回归 | 新增 5 个函数、297 条断言，覆盖挂起 cwd/FS、初扫、模式选择及清理 | 旧冻结实现运行新增集：211 通过、10 失败、22089ms；修复后完整集合通过 | 实际复现旧缺陷，修复后回归通过 |
| 已安装宿主核心服务 | DSH 0.2.2-rc.3，包括真实进程立即/3秒/5秒后失败 | 12 场景、87 断言、0 失败，7256ms，退出码 0 | 具体版本与服务范围通过；不是完整 Desktop/模型会话验收 |
| 1.2.0 包内容与加载 | 最终冻结源码离线打包、解包与模块导入 | 9 个文件逐字节一致，入口与 guard 导入通过，包大小 26239 字节 | 发布候选包验证通过；临时产物已清理 |
| 文档与 CI | 使用契约、文档回链、PR/main Node 20/22/24 工作流 | 静态结构核对、历史正文保留与文档链接检查 | 配置检查通过；远端结果需看实际 workflow run |

### 上一阶段记录

| 阶段 | 当时的证据 | 使用边界 |
| --- | --- | --- |
| A | 405 条断言通过，0 失败 | 修复组合条件、失败模式、退出标记、观察错误与异步预算时的阶段记录 |
| B | 38 个用例函数，494 条断言通过，0 失败，27503ms | 默认策略、文件/日志边界、有限 guard 的阶段记录 |
| C 初次本地回归 | 494 条断言通过，0 失败，27499ms | 混合挂起 I/O 早期失败修复之前；不能冒充 1.2.0 的最终集合 |
| C 初次宿主验证 | 10 场景、60 断言、0 失败，2374ms | 旧脚本范围；当前结果已扩展为 12 场景、87 断言 |
| 旧包验证（包版本 1.1.0） | dry-run 与实际包均 9 文件；包内导入、3 个 guard 行为和逐文件一致性检查通过 | 仅证明当时 1.1.0 工作区打包，不能替代 1.2.0 包验证 |

断言数对应各阶段实际执行，不是永久固定数量。新增集合在旧实现上复现了 8 个挂起 I/O 提前失败断言及 2 个初扫相关断言失败；旧版未通过结果没有被当作当前通过证据。

### 可复现的单元回归

在仓库根目录使用 Node >=20：

```sh
node test/unit.mjs
```

本机 1.2.0 完整单元验证使用已有 Node v24.19.0；Runner 未提供 `node` 的 PATH 映射时，可使用已安装解释器的绝对路径：

```sh
/Users/loong/.nvm/versions/node/v24.19.0/bin/node test/unit.mjs
```

测试使用内存中的 Jobs、FS、Teams 和注册上下文，覆盖结果契约与边界，不证明实际 DSH 服务接口、模块加载、插件管理器或模型行为都已兼容。

2026-11-14 的 1.2.0 完整单元回归输出：

```text
通过断言 791 条；失败 0 条；耗时 36587ms
全部通过
```

### 重要验收语义

- `completed` 只表示等待条件满足；`failed` 也可能来自观察错误。目标是否成功要结合具体状态与 fail-fast 模式。
- `log.matches` 与 `agent.status_changed` 在本次调用内锁存；`file.exists` 保持当前状态，`file.changed` 保持“当前存在且版本相对首轮不同”，首轮缺失后的首次出现也算变化。
- job 调用默认总超时 300 秒、整组 stall 180 秒；非 job 默认 60 秒、stall 关闭。显式参数优先，stall 截止点参与唤醒。
- 整组 stall 表示所有目标没有观察到进展，不是逐个目标检测，也不是已经证明卡死。
- 取消与总 deadline 覆盖异步 I/O 等待；插件返回 `cancelled`，宿主外层可以有不同包装。本机 DSH 0.2.2-rc.3 Native executor 将 caller abort 呈现为 `isError: true`、`error.info.code: ABORTED`，目标 job 仍在运行；这不表示插件取消值未产生，也不表示任务已停止。
- `agent_failed` 只在启用时生效；只有显式 `exit_code_nonzero` 使用完整行 `EXIT=N` 日志约定，真实退出码优先。
- job 失败监视与初扫覆盖工作目录解析之前；事件触发真实状态复查，并以独立采样补充事件漏送。`peek` 不消费正常 probe 的进展状态，确认失败能结束挂起 I/O 的等待，但不停止底层 I/O 或目标，也不会在每次事件到来时重启 I/O。
- `false`、`[]` 或仅 `agent_failed` 不会被该通道升级成 job fail-fast；事件本身不被当作失败。
- 永久读取错误及时返回失败；临时错误保留原因，超时时提示检查错误而非盲目延长等待。
- 日志覆盖/轮转覆盖同尺寸版本变化、缩小和观察到的删除重建；不承诺区分轮询间隙内更大替换与普通追加。
- guard 是有限字面语法识别，复杂替换/分组/heredoc 保守放行；重复短 `job_output` 只有提示词劝阻。
- `output_tail` 是最近相关输出，批量等待不保证合并所有目标日志。

### 1.2.0 宿主核心服务验证

2026-11-14 在已安装 DSH **0.2.2-rc.3** 上完成 1.2.0 独立核心服务验证：**12 个场景、87 条断言、0 失败，7256ms，退出码 0**。使用 Cordis **4.1.0** 与安装包内的 Electron Node **24.21.0**。

在仓库根目录执行的实际命令：

```sh
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  --expose-internals test/host-smoke.mjs \
  --runtime-root "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh"
```

`--runtime-root` 指向包含 `node_modules/@deepseek-ai` 的 DSH 根目录。对于未打包的运行时，脚本接口为 `node test/host-smoke.mjs --runtime-root /absolute/dsh`；上面记录的 Electron 命令才是本机这次实际验证所用命令。

| 证据项 | 范围与结果 |
| --- | --- |
| 服务装配 | 真实 SystemPrompt、ToolsService、Native executor、LocalJobRegistry、LocalFileSystem、SessionProjectionRegistry、WorkingDirectoryService；核心服务没有 mock |
| 注册与输入 | 真实工具 schema、非法输入检查及卸载路径通过 |
| 作业 | 通过有限 Node 子进程验证完成事件、输出 cursor、立即/3秒/5秒后的非零退出码 7 与各自 stderr 证据 |
| guard 管线 | 经过真实 guard/executor 链验证拒绝与放行；bash 测试夹具仅计数和返回固定结果，不执行字符串 shell 命令 |
| 取消 | 分别验证插件 body 的 `cancelled` 与宿主最终包装的 `ABORTED`；被观察 job 在取消等待后仍运行 |
| 文件与日志 | 使用真实文件服务验证 `file.changed`、日志匹配锁存、同尺寸日志重写及总 deadline |
| 清理 | 卸载前活动 job 数为 0（`live_jobs_before_dispose=0`），临时文件已清理 |

### 立即、3 秒与 5 秒失败的本机观测

三个有限真实 Node 进程并行运行，各自独立记录等待开始、进程退出和等待返回时间。每个调用使用 `poll_interval_sec: 10`、`timeout_sec: 15`，并断言等待已在进程退出前开始、退出后 1.5 秒内收到结果。

| 子进程失败时机 | 实际等待 | 插件报告 elapsed | 子进程退出到返回 | stderr 标记 |
| --- | --- | --- | --- | --- |
| 立即 exit 7 | 64ms | 63ms | 0ms | `HOST_EXIT_7_DELAY_0` |
| 约 3 秒后 exit 7 | 3076ms | 3074ms | 1ms | `HOST_EXIT_7_DELAY_3000` |
| 约 5 秒后 exit 7 | 5073ms | 5073ms | 1ms | `HOST_EXIT_7_DELAY_5000` |

这些数字是本机这一次的观测，不是延迟 SLA，也不能外推为所有环境、模型调用或跨网络通信的保证。

验证采用公开 controller attachment 和无 owner 的有限作业生产者，没有修改用户配置或连接模型。它**未覆盖** Agent Teams、真实 owner/session 授权、正在运行的 Desktop profile、模块缓存/热重载、模型是否遵守提示词，以及 token 或墙钟收益。

C 初次验证曾修正测试夹具多行正则缺少 `m` 的问题，其结果已归入上一阶段。当前 1.2.0 使用扩展后的脚本完整重跑。声明兼容范围仍为 `>=0.2.1-rc.1 <0.3.0`，本次只证明上述具体版本与服务边界。

### 1.2.0 冻结源码包验证

使用 **Node v24.19.0 / npm 11.17.0** 对最终冻结源码执行离线打包。`dsh-tool-wait-until-1.2.0.tgz` 包含 **9 个文件**，大小 **26239 字节**；tar 清单、解包文件与工作区发布文件逐字节一致，实际入口和 guard 均可导入。打包期间源码与 HEAD 没有变化，临时目录、缓存及压缩包已经清理。

发布文件为 `LICENSE`、`README.md`、`cordis.patch.yml`、`icon.svg`、`index.js`、`locale/en.json`、`locale/zh.json`、`package.json`、`wait-guard.js`；不包含 `.idea`、测试或验收文档。本节文档回填不改变上述发布内容。

本地候选包 SHA256：`d7b53e678fc98063a9dea6f964148e96e8056b1354b2480fa97ebe856ac33eb2`。这是本地打包证据，实际 npm 发布仍以对应 workflow、版本与 `gitHead` 核对结果为准。

### 上一阶段包内容与加载验证（包版本 1.1.0）

以下为包版本仍是 **1.1.0** 时的历史验证，不是 1.2.0 包的验收结果。使用 **Node v24.19.0 / npm 11.17.0** 完成离线 dry-run 和临时目录实际打包，均为 **9 个文件**：`LICENSE`、`README.md`、`cordis.patch.yml`、`icon.svg`、`index.js`、`locale/en.json`、`locale/zh.json`、`package.json`、`wait-guard.js`。

验证时的 tar 清单与解包内容一致，包含新 guard 模块，不包含 `.idea`、`test` 或 `docs`。解包后的 `index.js` 可导入，3 个包内 guard 行为通过；9 个文件的打包前源文件、打包后源文件和解包文件 SHA256 逐一一致。临时目录已清理，没有执行 `npm publish`。

以下是当时 1.1.0 工作区验证参数的等价 shell 表示，仅用于保留该次过程；当前版本打包应使用 npm 实际返回的包名，不能沿用下面的旧 tar 文件名：

```sh
package_tmp="$(mktemp -d)"
npm pack --json --ignore-scripts --offline --cache "$package_tmp/npm-cache" --dry-run
npm pack --json --ignore-scripts --offline --cache "$package_tmp/npm-cache" --pack-destination "$package_tmp"
tar -tzf "$package_tmp/dsh-tool-wait-until-1.1.0.tgz"
```

当时还将包解开到临时目录，执行包内模块导入和 guard 检查，再清理目录。以上仅证明那次 1.1.0 工作区打包一致性；1.2.0 的独立核验见上一节，未沿用旧包通过结果。

### CI 与发布证据边界

[单测工作流](../.github/workflows/test.yml) 在 pull request 与 push 到 `main` 时运行 Node 20 / 22 / 24 矩阵，直接执行单测，不安装项目依赖、不使用发布凭据，只有仓库读取权限，并设置限时与同分支并发取消。

[发布工作流](../.github/workflows/publish.yml) 继续在 `v*` tag 上执行单测、版本一致性与已发布版本检查。此批仅校正认证顺序注释：有 `NPM_TOKEN` 时先用 token，否则使用 OIDC；没有修改发布行为。

工作流已完成手工结构审查与静态约束核对，未使用 YAML 解析器作验证。远端 CI、tag 发布及 npm 包状态应分别检查其实际运行与版本记录；本文的本地验证不能替代这些发布证据。

---

## 历史报告：watch 插件验收实测报告（独立交叉验收）

> 以下为 **2026-11-04** 的历史归档正文。文中的“当前”、版本、工具名、路径和通过/未通过结论均属于当时环境；不能替代上面的当前批次证据。除新增本节导读外，历史正文保留原文。

> **归档说明（2026-11-04 更新）**
>
> 本报告是插件公开发布前的独立交叉验收记录，正文保留当时原文，未改写。与当前状态的差异如下：
>
> - **工具名**：报告写作时工具名为 `watch`，现已定名为 **`wait_until`**（包名 `dsh-tool-wait-until`）。
> - **源码位置**：当时为 `/Users/loong/dsh-plugins/dsh-tool-watch`，现为 `~/workspace/code/github/dsh-tool-wait-until`。
> - **被测版本**：当时为 v1.0.0 的「修复前版本」。退出码非零未判 `failed` 的问题已在 **1.0.3** 修复并线上验证（同一作业现返回 `failed` + 「退出码 3」+ stderr 尾），报告中标记「未通过」的用例 1a/1e 现已通过。
> - **「需重启 Desktop 生效」**：已通过改名（模块路径变化 → 新的 ESM URL）绕过，当前不再需要重启。
> - 插件已发布到 npm（当前 1.0.5），profile 改为从 npm 安装。

- 实测人：`baseline-prober`（Team Lead：`lead`）
- 实测时间：2026-11-04 01:22:08 – 01:25:19（CST，Asia/Shanghai）
- 环境：macOS 26.6.2 (25G83)；Node v24.19.0（nvm）；DSH Web GUI `http://127.0.0.1:52805`
- 被测插件：`/Users/loong/dsh-plugins/dsh-tool-watch`（v1.0.0）
- 被测版本：**修复前版本**（Lead 已说明：进程退出码非零但无 `EXIT=` 文本的场景可能被判为 completed；修复版需重启 Desktop 生效）。本报告如实记录该已知限制，未将其计入插件新缺陷。
- 计时方法：以 `watch` 返回的插件内部 `elapsed`（毫秒级）为主，外部 `date +%s.%N` 记录 T_BEFORE/T_AFTER 交叉验证。外部窗口包含模型生成下一次工具调用的延迟（实测数秒到数十秒），仅作参考，不用于判定插件耗时。

## 前提确认（两项均已满足）

1. **工具列表已含 `watch`**：当前会话注入的工具清单中已出现 `watch` 完整 schema（name/description/parameters/output），实测期间共成功调用 8 次（1a、1b、1c、1d、1e、用例 2、3、5），无工具缺失错误。
2. **系统提示词已含「# 等待纪律」段落**：当前上下文 developer message 中存在该段落，内容为「bash 中前台 sleep 达到 20 秒会被拒绝；job_output / wait_agent 单次等待超过 120 秒也会被拒绝；改用 watch……」并附 5 条 watch 用法示例，与插件 README 一致。

---

## 概览表

| 用例 | 预期 | 实测 | 结论 |
|---|---|---|---|
| 1 早期失败（`fail_fast:true`） | ≤5s 返回 failed + stderr 尾 | 1a：**1ms 返回 completed**（状态 completed — exit code: 3），stderr 尾正确；1e：**8.7s 返回 completed**（12s 作业失败时刻被唤醒，未等满 60s） | **未通过**（修复前版本已知问题：退出码非零未判 failed；时间/stderr 达标） |
| 1b 补充（EXIT= 文本 + `exit_code_nonzero`） | failed | **3ms 返回 failed**，失败原因「输出 EXIT=3（非零退出）」 | 通过（补充） |
| 2 卡住检测（`stall_after_sec:5`） | 约 5s 返回 stalled，不等满 60s | **5.0s 返回 stalled**，无进展 5s，条件状态 running | **通过** |
| 3 正常完成即时返回（`poll_interval_sec:10`） | 约 10s 返回，被事件唤醒 | **4.4s 返回 completed**（< poll 间隔 10s），output_tail 含 EXIT=0 ok | **通过** |
| 4 拦截规则 | 4a/4b 拒绝且含 watch 示例，4c 放行 | 4a **立即拒绝**（180s sleep，含 5 条示例）；4b **立即拒绝**（job_output 300s）；4c **放行**（SLEEP3_DONE） | **通过** |
| 5 批量 + 结构化返回 | 一次返回含 status/elapsed_ms/elapsed/matched/conditions/output_tail，可单次判定 | **5.5s 返回 completed**，file/ job 两条件均 satisfied，status/elapsed/matched/conditions/output_tail 可见 | **通过**（附 2 条改进建议） |

---

## 用例 1：早期失败（`watch fail_fast:true`）

### 1a 主用例（立即失败作业）

**调用参数**
- 后台启动：`sh -c 'echo "BOOM: bad flag" >&2; exit 3'`（`run_in_background:true`），job id `bash-bdb745f4fd1345b5`
- 等待调用：`watch({conditions:[{kind:"job",id:"bash-bdb745f4fd1345b5"}], fail_fast:true, timeout_sec:60})`

**实际耗时**：**1ms**（插件内部 elapsed；外部窗口 10.51s，T_BEFORE 01:22:11.414 → T_AFTER 01:22:21.924，差值全部为模型生成延迟）

**返回原文**
```
[watch completed] 耗时 1ms
已满足：后台作业 bash-bdb745f4fd1345b5（结束）
- 后台作业 bash-bdb745f4fd1345b5（结束）：satisfied（状态 completed — exit code: 3）

--- 输出尾部 ---
[stderr]
BOOM: bad flag
```

**判定**：**未通过预期**。响应速度（1ms，远小于 5 秒）与 stderr 尾均达标，但 status 为 **completed** 而非 failed——作业 exit code 3 未被识别为失败。这是 Lead 已说明的修复前版本已知问题（当前运行版本未识别退出码；源码 `index.js:321-327` 的 `failedExit` 修复逻辑已存在但需重启 Desktop 生效，未在运行中的进程里生效），不计入插件新缺陷。修复版重启后需用本用例回归。

### 1b 补充用例（写清理由）

**理由**：为区分「fail_fast 机制整体失效」与「修复前版本缺少退出码识别」，补测旧版明确依赖的 `EXIT=N` 文本路径。

**调用参数**
- 后台启动：`sh -c 'echo "EXIT=3: bad flag" >&2; exit 3'`，job id `bash-91a50f7e30ee46f7`
- 等待调用：`watch({conditions:[{kind:"job",id:"bash-91a50f7e30ee46f7"}], fail_fast:["exit_code_nonzero"], timeout_sec:60})`

**实际耗时**：**3ms**

**返回原文**
```
[watch failed] 耗时 3ms
失败原因：后台作业 bash-91a50f7e30ee46f7 输出 EXIT=3（非零退出）
已满足：后台作业 bash-91a50f7e30ee46f7（结束）
- 后台作业 bash-91a50f7e30ee46f7（结束）：failed（状态 completed — exit code: 3）

--- 输出尾部 ---
[stderr]
EXIT=3: bad flag


目标已失败，不必再等：按 output_tail / failure_reason 决策（需要完整日志时用 job_output 读取）。
```

**判定**：**通过（补充验证）**。fail_fast 的文本规则（`exit_code_nonzero` 识别 `EXIT=3`）正常工作，失败原因与 failure_reason 均正确。说明 fail_fast 机制本身未失效，1a 的问题是修复前版本缺少「真实退出码」识别路径。

### 1c / 1d 调整记录（写清理由）

**理由**：原设计为「等待窗口内失败」，但受步骤间模型延迟影响，2 秒/5 秒后失败的作业在 watch 调用前就已结束，elapsed 均为 0ms，无法构成等待窗口。故补 1e（12 秒作业）确保调用时作业仍在运行。

- 1c：`sh -c 'sleep 2; echo "BOOM: bad flag after 2s" >&2; exit 3'`（job `bash-e48245bfc38d429a`），watch 返回 elapsed **0ms**、completed、stderr 尾正确——调用时作业已结束，无效窗口。
- 1d：`sh -c 'sleep 5; echo "BOOM: bad flag after 5s" >&2; exit 3'`（job `bash-ebaab1ae8e514df2`），watch 返回 elapsed **0ms**、completed、stderr 尾正确——同样调用时已结束，无效窗口。

### 1e 决定性用例（等待窗口内失败）

**调用参数**
- 后台启动：`sh -c 'sleep 12; echo "BOOM: bad flag after 12s" >&2; exit 3'`（`run_in_background:true`），job id `bash-374820c718444b19`
- 等待调用：`watch({conditions:[{kind:"job",id:"bash-374820c718444b19"}], fail_fast:true, timeout_sec:60})`（调用时作业仍在运行）

**实际耗时**：**8.7s**（插件内部 elapsed；外部窗口 16.13s，T_BEFORE 01:23:21.880 → T_AFTER 01:23:38.011，差值为模型延迟；8.7s ≪ 60s，证明未等满 timeout）

**返回原文**
```
[watch completed] 耗时 8.7s
已满足：后台作业 bash-374820c718444b19（结束）
- 后台作业 bash-374820c718444b19（结束）：satisfied（状态 completed — exit code: 3）

--- 输出尾部 ---
[stderr]
BOOM: bad flag after 12s
```

**判定**：**部分达标**。事件唤醒达标（8.7s 返回，未等满 60s，说明等待期间作业失败被事件立即唤醒）；但 status 仍为 completed（状态行显示 exit code: 3），未返回 failed——与 1a 同属修复前版本已知问题。修复版预期：同样约 8.7s 返回，但 status=failed、failure_reason=退出码 3。

---

## 用例 2：卡住检测（`stall_after_sec:5`）

**调用参数**
- 后台启动：`sh -c 'sleep 300'`（`run_in_background:true`），job id `bash-e4e04561f19f430b`
- 等待调用：`watch({conditions:[{kind:"job",id:"bash-e4e04561f19f430b"}], stall_after_sec:5, timeout_sec:60, poll_interval_sec:1})`

**实际耗时**：**5.0s**（插件内部 elapsed；外部窗口 10.79s，T_BEFORE 01:23:42.741 → T_AFTER 01:23:53.535，差值为模型延迟）

**返回原文**
```
[watch stalled] 耗时 5.0s
无进展持续 5s
- 后台作业 bash-e4e04561f19f430b（结束）：pending（状态 running）

目标在该窗口内没有任何进展（无新输出、状态未变、文件未更新），可能已卡死：检查进程与日志，必要时先停止再重试。
```

**判定**：**通过**。约 5 秒即返回 `stalled`（未等满 60 秒），`stalled_for_sec=5`，条件快照显示 pending/running，并给出「可能已卡死」提示。测后已 `job_kill` 清理（job 状态 killed），`pgrep -fl 'sleep 300'` 确认无残留进程。

---

## 用例 3：正常完成即时返回（事件唤醒 vs 轮询边界）

**调用参数**
- 后台启动：`sh -c 'sleep 10; echo "EXIT=0 ok"'`（`run_in_background:true`），job id `bash-cbf74c4003df4d4f`
- 等待调用：`watch({conditions:[{kind:"job",id:"bash-cbf74c4003df4d4f"}], poll_interval_sec:10, timeout_sec:60})`

**实际耗时**：**4.4s**（插件内部 elapsed；外部窗口 14.29s，T_BEFORE 01:24:01.897 → T_AFTER 01:24:16.184，差值为模型延迟）

**返回原文**
```
[watch completed] 耗时 4.4s
已满足：后台作业 bash-cbf74c4003df4d4f（结束）
- 后台作业 bash-cbf74c4003df4d4f（结束）：satisfied（状态 completed — exit code: 0）

--- 输出尾部 ---
EXIT=0 ok
```

**判定**：**通过**。关键证据：`poll_interval_sec:10` 下实际 4.4s 返回，**不是 10s 的整数倍轮询边界**（若纯轮询，最早也要到 10s），说明作业完成事件唤醒了等待；status=completed、exit code 0、output_tail 含 `EXIT=0 ok`，一次返回可判定。

---

## 用例 4：拦截规则（第二层行为干预）

### 4a `bash` 前台 `sleep 180` —— 预期拒绝

**调用参数**：`bash({command:"sleep 180"})`（前台）

**实际耗时**：即时拒绝（未等待）

**返回原文**
```
Error: 拒绝了 180 秒的前台 sleep 空等：等待期间既看不到进展，完成或失败时也不会立即返回。改用 watch 工具（事件驱动、可观测、失败与卡住立刻返回）：
watch 用法（条件满足、目标失败或连续无进展时立即返回）：
  watch({conditions:[{kind:"job",id:"<job_id>"}]})                                  // 等后台作业结束
  watch({conditions:[{kind:"file",path:"<path>",until:"exists"}]})                  // 等文件出现
  watch({conditions:[{kind:"file",path:"<path>",until:"changed"}], timeout_sec:900, stall_after_sec:120})  // 等文件持续变化，卡住即返回
  watch({conditions:[{kind:"log",path:"<path>",matches:"/DONE|EXIT=0/"}]})          // 等日志关键字
  watch({conditions:[{kind:"agent",target:"<name>",until:"inactive"}], timeout_sec:600, stall_after_sec:300})  // 等队友
确需节奏控制时，把 sleep 放进 run_in_background 的作业，或写进带实际工作的脚本。
```

**判定**：**通过**。拒绝原因含「watch 替代示例」（5 条完整用例），并给出反例场景的替代做法。

### 4b `job_output` 超长等待 —— 预期拒绝

**调用参数**：`job_output({job_id:"bash-bdb745f4fd1345b5", wait:true, timeout_ms:300000})`（300 秒 > 120 秒阈值）

**实际耗时**：即时拒绝（未等待）

**返回原文**
```
Error: job_output 的单个等待最多 120 秒（本次 300 秒）：超长等待会在作业卡住时白等，也拿不到中间进展。改用 watch 分段等待：
watch 用法（条件满足、目标失败或连续无进展时立即返回）：
  watch({conditions:[{kind:"job",id:"<job_id>"}]})                                  // 等后台作业结束
  watch({conditions:[{kind:"file",path:"<path>",until:"exists"}]})                  // 等文件出现
  watch({conditions:[{kind:"file",path:"<path>",until:"changed"}], timeout_sec:900, stall_after_sec:120})  // 等文件持续变化，卡住即返回
  watch({conditions:[{kind:"log",path:"<path>",matches:"/DONE|EXIT=0/"}]})          // 等日志关键字
  watch({conditions:[{kind:"agent",target:"<name>",until:"inactive"}], timeout_sec:600, stall_after_sec:300})  // 等队友
```

**判定**：**通过**。拒绝原因给出 120 秒阈值、本次数值与 watch 替代示例。

### 4c `bash` 前台 `sleep 3` —— 预期放行（对照）

**调用参数**：`bash({command:"sleep 3 && echo SLEEP3_DONE"})`

**实际耗时**：约 3 秒后正常返回

**返回原文**
```
SLEEP3_DONE
```

**判定**：**通过**。短 sleep 未被误伤，确认拦截规则只针对「空等」路径。

---

## 用例 5：批量 + 结构化返回

**调用参数**
- 临时文件：`/tmp/dsh-watch-accept.txt`（调用前已 `rm -f`，初始不存在）
- 作业 A（负责创建文件）：`sh -c 'sleep 2; echo "FILE-CREATED" > /tmp/dsh-watch-accept.txt'`，job id `bash-36a1ec74769a4151`
- 作业 B（job 条件）：`sh -c 'sleep 1; echo "B-TICK-1"; sleep 8; echo "B-DONE"'`，job id `bash-3abf44d038a041aa`
- 等待调用：`watch({conditions:[{kind:"file",path:"/tmp/dsh-watch-accept.txt",until:"exists"},{kind:"job",id:"bash-3abf44d038a041aa"}], poll_interval_sec:1, timeout_sec:30})`

**实际耗时**：**5.5s**（插件内部 elapsed；外部窗口 33.46s，T_BEFORE 01:24:45.096 → T_AFTER 01:25:18.557，差值为模型延迟）

**返回原文**
```
[watch completed] 耗时 5.5s
已满足：文件 /tmp/dsh-watch-accept.txt（出现）；后台作业 bash-3abf44d038a041aa（结束）
- 文件 /tmp/dsh-watch-accept.txt（出现）：satisfied（文件存在（13 字节））
- 后台作业 bash-3abf44d038a041aa（结束）：satisfied（状态 completed — exit code: 0）

--- 输出尾部 ---
B-TICK-1
B-DONE
```

**临时文件核验**：`/tmp/dsh-watch-accept.txt` 大小 13 字节，内容 `FILE-CREATED`。

**判定**：**通过**。单次返回即可判定：status=completed、elapsed=5.5s、matched（两个条件均满足）、conditions（file 13 字节、job completed exit 0）、output_tail（B-TICK-1/B-DONE）。满足「只凭这一次返回判定结果」的要求。**但注意**：实际等到 file 与 job **两个条件都满足**才返回（5.5s 时作业 B 结束），这与工具 schema 中「任一条件满足即 completed」的描述不一致——见缺陷建议第 2 条。

**字段可见性说明**：结构化 schema（`WATCH_RESULT_SCHEMA`）定义了 `status / elapsed_ms / elapsed / matched / conditions / failure_reason / output_tail / hint` 且 required 含 `status / elapsed_ms / elapsed / matched / conditions`，返回对象（`buildResult`）也确实构造了 `elapsed_ms`。但模型侧看到的文本由 `renderWatchResult` 渲染：status 在 `[watch ...]`、elapsed 为「耗时 5.5s」、matched/conditions/output_tail 均可见，**`elapsed_ms` 没有以字段形式出现在渲染文本中**（仅以可读的 `elapsed` 呈现）。见缺陷建议第 3 条。

---

## 发现的缺陷与改进建议

1. **【已知修复前版本限制，非新缺陷】早期失败未返回 failed**（用例 1a/1e）。当前运行版本对「进程正常退出但退出码非零、且输出无 `EXIT=` 文本」的场景判为 completed；修复版源码已含 `job.detail` 的 `exit code: N` 识别逻辑（`index.js:321-327`），重启 Desktop 后生效。**修复版重启后必须回归 1a/1e**，期望：status=failed，failure_reason 含退出码 3，且仍在 ≤5s / 失败时刻返回。
2. **【中优先级：描述与实现不一致】** 工具 schema 的 `conditions` 描述为「任一条件满足即 completed（fail_fast 命中时任一失败即 failed）。这就是批量等待 wait_all 的用法。」但实现（`index.js:693`）是 `allSatisfied && matched.length === probes.length`——**全部条件满足才返回 completed**（真正的 wait_all）。用例 5 印证：file 约 2s 已出现，但 watch 等到 5.5s 作业 B 结束、两个条件都满足才返回。建议二选一：① 修正描述为「全部条件满足即 completed（批量 wait_all）」；② 若设计意图是「任一满足即返回」，则修改实现。当前描述可能误导模型对批量语义的预期。
3. **【低优先级：渲染字段缺失】** `elapsed_ms` 在结构化结果中存在且为 required，但 `renderWatchResult` 只输出可读的 `elapsed`（如「耗时 5.5s」），模型侧拿不到毫秒精度字段。若验收标准要求模型侧可读 `elapsed_ms`，建议渲染为「耗时 5.5s（5500ms）」或在文本中附 JSON 摘要。
4. **【观察·正向】** 事件驱动能力全部符合预期：作业结束/失败事件唤醒不受 poll 间隔限制（用例 3：4.4s vs poll_interval 10s；1e：8.7s vs timeout 60s）；卡住检测（5.0s vs timeout 60s）；拦截规则正确且带可复制替代示例；批量结构化返回字段齐全、可单次判定。
5. **【环境确认】**「# 等待纪律」系统提示词与 watch 工具均已生效（前提确认项）；`timeout_sec` 范围 1–900、`poll_interval_sec` 范围 0.25–30、`stall_after_sec` 有最小值约束等参数边界与 README 一致（本次未逐项探测边界，仅实测了正常范围）。

---

## 最终结论

**有条件通过（修复前版本）**。

- **通过（4/5）**：用例 2（卡住检测 5.0s 返回 stalled）、用例 3（事件唤醒 4.4s vs poll 10s）、用例 4（拦截规则 3/3）、用例 5（批量 + 结构化返回 5.5s，字段齐全可单次判定）。
- **未通过（1/5，属修复前版本已知问题）**：用例 1 的早期失败判定——1a 1ms 返回 completed（应为 failed）、1e 8.7s 返回 completed（应为 failed）。时间与 stderr 尾达标，但 status 未达预期；1b 补充用例证明 fail_fast 机制本身正常（EXIT= 文本场景 3ms 返回 failed）。该问题需**重启 Desktop 加载修复版后回归 1a/1e**。
- **非阻断问题 2 条**：conditions 的「任一 vs 全部」描述与 wait_all 实现不一致（建议修正描述）；渲染文本未显式输出 elapsed_ms（低优先级）。
- 复测清单：修复版生效后重跑用例 1a、1e（期望 failed + failure_reason + stderr 尾），并回归用例 2/3/4/5 确认无回退。
