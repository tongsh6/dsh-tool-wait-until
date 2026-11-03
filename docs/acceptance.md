# watch 插件验收实测报告（独立交叉验收）

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
