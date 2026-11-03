# watch 插件改造前基线实测报告

- 实测人：`baseline-prober`（Team Lead：`lead`）
- 实测时间：2026-11-04 01:11:26 – 01:13:39（CST，Asia/Shanghai）
- 环境：macOS 26.6.2 (25G83)；Node v24.19.0（nvm）；DSH Web GUI `http://127.0.0.1:52805`
- 被测工具：`job_output`、`wait_agent`、`list_agents`（当前 DSH 会话内的真实工具调用）
- 计时方法：用 `date +%s.%N` 记录「调用前最后时刻 T_BEFORE」与「返回后第一时刻 T_AFTER」。**墙钟差值（window）= T_AFTER − T_BEFORE**，其中包含工具调用往返与模型生成下一次工具调用的延迟（实测非固定，约 2–7 秒），并非纯工具执行时间。因此超时判定标准为：等满超时应使 window ≥ timeout；若 window 明显小于 timeout 且返回内容与事件时刻吻合，则判定「未等满 / 立即返回」。
- 说明：实验 2 的原命令只跑约 3 秒，受步骤间模型延迟影响，3 秒窗口大概率会在调用前结束；为构造确定性的「运行中」观测窗口，将 tick 上界从 3 延长到 10（约 10 秒），其余参数不变，特此注明。

---

## 实验 1：后台作业立即失败 —— `job_output(wait:true, timeout_ms:15000)`

### 1a 作业已完成后再调用

**调用参数**
- 后台命令：`node -e 'console.error("BOOM: intentional failure"); process.exit(3)'`（`run_in_background:true`）
- job id：`bash-ef9dcbcac5a54e43`
- 调用：`job_output(job_id="bash-ef9dcbcac5a54e43", wait=true, timeout_ms=15000)`

**时间线**
| 事件 | 时刻（CST） | epoch |
|---|---|---|
| 作业启动 | 01:11:33.988 | 1793725893.988 |
| job_output 调用前（T_BEFORE） | 01:11:37.465 | 1793725897.465 |
| job_output 返回后（T_AFTER） | 01:11:46.828 | 1793725906.828 |

**实际耗时（秒）**：window = **9.363 秒**。作业在 T_BEFORE 之前已失败完成（启动后随即 exit 3，会话内已收到「finished [status: completed, exit code: 3]」通知），9.36 秒差值主要是模型生成工具调用的延迟。

**返回摘要（原文）**
```
[stderr]
BOOM: intentional failure
[status: completed, exit code: 3]
```

**结论**：**立即返回**（未等满 15 秒）。返回携带 stderr 尾部、`[status: completed]`、退出码 3，单次调用即可判定失败与失败原因。

### 1b 省略说明

实验 1 已立即返回，按任务约定不再做 `timeout_ms=60000` 复测（不浪费 60 秒），故无 1b 数据。

### 1c 补充实验：等待窗口内失败（决定性验证）

1a 因步骤延迟调用时作业已完成，不能证明「等待期间作业失败会立即唤醒」。为此补充：让作业在 8 秒后失败，在作业运行中调用。

**调用参数**
- 后台命令：`node -e 'setTimeout(()=>{console.error("BOOM after 8s: intentional failure"); process.exit(3)},8000)'`（`run_in_background:true`）
- job id：`bash-712ca30a7e0d4638`
- 调用：`job_output(job_id="bash-712ca30a7e0d4638", wait=true, timeout_ms=15000)`

**时间线**
| 事件 | 时刻（CST） | epoch |
|---|---|---|
| 作业启动 | 01:12:00.405 | 1793725920.405 |
| 作业设计失败时刻（启动 + 8s） | 01:12:08.405 | 1793725928.405 |
| job_output 调用前（T_BEFORE，作业已运行 3.14s） | 01:12:03.543 | 1793725923.543 |
| job_output 返回后（T_AFTER） | 01:12:11.911 | 1793725931.911 |

**实际耗时（秒）**：window = **8.368 秒**。调用时距作业失败还剩 4.862 秒；8.368 − 4.862 = 3.506 秒为两次模型延迟之和（T_BEFORE→调用发起、返回→T_AFTER），与「作业失败瞬间唤醒返回」吻合。

**返回摘要（原文）**
```
[stderr]
BOOM after 8s: intentional failure
[status: completed, exit code: 3]
```

**结论**：**在作业失败瞬间返回**（未等满 15 秒）。证明 `job_output(wait:true)` 的等待会被作业完成/失败事件唤醒，而不是固定睡满 timeout。本机当前版本**未复现**用户抱怨的「后台脚本启动即报错仍等满超时」。

---

## 实验 2：后台作业运行中调用 —— 等待中可观测性

**调用参数**
- 后台命令：`node -e 'let i=0; const t=setInterval(()=>{ console.log("tick",++i); if(i>=10){clearInterval(t); console.log("EXIT=0");} },1000)'`（`run_in_background:true`，约 10 秒）
- job id：`bash-fbac749fcc1f42a5`
- 主调用：`job_output(job_id="bash-fbac749fcc1f42a5", wait=true, timeout_ms=2000)`（调用时作业仍在运行）
- 补充调用：作业完成后 `job_output(job_id="bash-fbac749fcc1f42a5", wait=false)`

**时间线**
| 事件 | 时刻（CST） | epoch |
|---|---|---|
| 作业启动 | 01:12:19.604 | 1793725939.604 |
| job_output 调用前（T_BEFORE，作业已运行 4.045s） | 01:12:23.649 | 1793725943.649 |
| job_output 返回后（T_AFTER） | 01:12:35.170 | 1793725955.170 |

**实际耗时（秒）**：window = **11.52 秒**（含模型延迟；返回内容含 tick 8，tick 8 产生于启动 + 8s = 01:12:27.604，说明工具实际在 2 秒超时窗口后返回，与 `timeout_ms=2000` 吻合）。

**返回摘要（原文）**
```
tick 1
tick 2
tick 3
tick 4
tick 5
tick 6
tick 7
tick 8
[status: running]
```

**补充调用返回（增量输出）**
```
tick 9
tick 10
EXIT=0
[status: completed, exit code: 0]
```

**结论**：**超时返回**（约 2 秒后返回）。超时返回时①携带了截至返回时刻**已产生的中间输出**（tick 1–8），②携带 `[status: running]` 状态字段，③可据此判定作业仍在运行。但注意：无法在首个 tick 出现的瞬间被唤醒——只有「超时」或「作业结束」两个交付时机；超时前拿不到任何数据。另外 `job_output` 是**增量输出语义**（第二次调用只返回上次读取后新增的 tick 9–10 + EXIT=0），完整输出需要自行累积。

---

## 实验 3：teammate 状态与 `wait_agent` 语义

**调用参数**
- `list_agents()`（等待前后各一次）
- 主调用：`wait_agent(timeout_ms=10000)`（复测 2 次）
- 参数探测：`wait_agent(timeout_ms=5000)`

**观察 3a：list_agents（等待前）**
```
[
  {"target":"lead","role":"lead","status":"running","model":"deepseek-flash","diagnostics":[]},
  {"target":"baseline-prober","role":"teammate","status":"running","description":"实测现有 job_output / wait_agent 的等待行为，产出基线数据","provider":"spawn","context":"fresh","model":"deepseek-flash","diagnostics":[]}
]
```

**观察 3b：wait_agent 第 1 次**
| 事件 | 时刻（CST） | epoch |
|---|---|---|
| 调用前（T_BEFORE） | 01:12:46.467 | 1793725966.467 |
| 返回后（T_AFTER） | 01:12:56.236 | 1793725976.236 |

- 实际耗时（秒）：window = **9.77 秒**（< 10 秒超时，说明约 7–8 秒时观察到某变化提前返回；变化内容未知）
- 返回摘要（原文）：`{"timedOut":false}`

**观察 3c：参数探测**
- `wait_agent(timeout_ms=5000)` 直接报错：`Error: timeoutMs must be an integer from 10000 through 3600000`
- 即 `wait_agent` 的等待粒度**最小 10 秒**，小于 10 秒无法构造。

**观察 3d：wait_agent 第 2 次**
- 返回摘要（原文）：`{"timedOut":true}`（该次与下次之间总墙钟 17.41 秒，含本调用约 10 秒等待 + 模型延迟，未单独记录前后时刻）

**观察 3e：wait_agent 第 3 次**
| 事件 | 时刻（CST） | epoch |
|---|---|---|
| 调用前（T_BEFORE） | 01:13:23.914 | 1793726003.914 |
| 返回后（T_AFTER） | 01:13:38.576 | 1793726018.576 |

- 实际耗时（秒）：window = **14.66 秒**（14.66 − 模型延迟 ≈ 10 秒等待，即**等满超时**）
- 返回摘要（原文）：`{"timedOut":true}`

**观察 3f：list_agents（等待后）**
- 仍为 `lead: running` / `baseline-prober: running`，与等待前无差异。

**结论**：`wait_agent` 在**无变化窗口中等满 10 秒超时**，返回仅 `{"timedOut":true}`；在有变化时提前返回，返回也仅 `{"timedOut":false}`。**返回值不告诉「谁在跑、谁卡住、最后产出是什么」**，超时后必须再查 `list_agents`/共享任务板才能分辨。用户抱怨的「超时返回后还要再查一轮才能分辨」**成立**；「teammate 卡死时仍等满超时」在本次「无变化窗口」（与卡死等价的可观测行为）中**成立**，且无法区分「卡死」与「正常无进展」。

---

## 基线结论

现有工具在四个维度上的实测表现（本机当前版本）：

1. **早期失败检测（job_output）：好于用户抱怨，未复现「空等」**。已完成作业调用立即返回；等待窗口内 8 秒后失败的作业在失败瞬间被唤醒返回（实测 window 8.37s，未等满 15s），且返回携带 stderr 与 `[status: completed, exit code: 3]`，单次调用即可判定失败（实验 1a/1c）。
2. **卡住检测（wait_agent）：等满超时且语义空洞**。无变化窗口（等价于卡死）下 `wait_agent(10000)` 等满 10 秒返回 `{"timedOut":true}`（另一次 window 9.77s 返回 `{"timedOut":false}`），返回值只有布尔字段，不提供「谁在跑 / 谁卡住 / 最后产出」；超时后必须再查 `list_agents`/任务板，证实「二次查询」问题（实验 3）。
3. **等待中可观测（job_output）：有中间数据，但只能在超时/结束时才交付**。运行中调用 `wait:true, timeout_ms=2000` 会阻塞满 2 秒，返回超时时刻已产生的中间输出（tick 1–8）与 `[status: running]`；无法在首个输出产生时被唤醒，且返回为增量语义，完整输出需自行累积（实验 2）。
4. **结果可判定（两工具不对称）**：`job_output` 返回含 `status` + `exit code` + stderr 尾部，单次调用可判定「成功/失败/运行中」；`wait_agent` 仅有 `timedOut` 布尔值，无法判定成功/失败/超时/卡住，必须二次查询（实验 1/2/3）。
5. **基线与插件机会**：现有组合在「作业完成/失败的事件唤醒」上工作正常（与用户抱怨不完全一致，需以本机实测为准），但缺口在「等待期间的事件级可观测性」与「wait_agent 的状态语义」——没有统一事件流，`wait_agent` 最小等待粒度 10 秒、超时无细节、事后需补查。事件驱动的 `watch` 插件应以「单次调用返回明确状态（成功/失败/超时/卡住 + 进展快照）」作为验收对照。
