/**
 * 本地单测：不依赖 DSH 运行时，用最小 mock 验证 wait_until 的核心行为、拦截规则与参数校验。
 * 运行：node test/unit.mjs
 */

import { apply, inject, name } from '../index.js'

let passed = 0
const failures = []

function check(condition, label, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(detail === undefined ? label : `${label} —— ${detail}`)
}

function equal(actual, expected, label) {
  check(Object.is(actual, expected), label, `期望 ${String(expected)}，实际 ${String(actual)}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// mock 服务
// ---------------------------------------------------------------------------

function createMockJobs() {
  const listeners = new Set()
  const records = new Map()
  const notify = () => {
    for (const listener of [...listeners]) listener({ type: 'output' })
  }
  return {
    events: {
      subscribe(_filter, listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    get(id) {
      const record = records.get(id)
      if (record === undefined) throw new Error(`作业 ${id} 不存在`)
      const total = record.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
      return {
        id,
        kind: 'bash',
        label: record.label ?? 'mock job',
        owner: 'session-1',
        status: record.status,
        ...(record.detail === undefined ? {} : { detail: record.detail }),
        startedAt: 0,
        ...(record.status === 'running' ? {} : { finishedAt: 1 }),
        output: { total, earliest: 0 },
      }
    },
    readAt(id) {
      const record = records.get(id)
      if (record === undefined) throw new Error(`作业 ${id} 不存在`)
      return { chunks: [...record.chunks], next: 0, lossy: false }
    },
    __seed(id, record) {
      records.set(id, { status: 'running', chunks: [], ...record })
      notify()
    },
    __update(id, patch) {
      Object.assign(records.get(id), patch)
      notify()
    },
  }
}

function createMockFs() {
  const files = new Map()
  const encode = (text) => new TextEncoder().encode(text)
  return {
    async resolve(path) {
      return { targetKey: path, displayPath: path }
    },
    async stat(target) {
      const file = files.get(target.displayPath)
      if (file === undefined) return undefined
      return { version: file.version, type: 'file', size: encode(file.text).byteLength }
    },
    async readByteRange(target, range) {
      const file = files.get(target.displayPath)
      if (file === undefined) throw new Error(`文件 ${target.displayPath} 不存在`)
      return encode(file.text).subarray(range.offset, range.offset + range.length)
    },
    __set(path, text) {
      files.set(path, { version: `v${Date.now()}-${Math.random()}`, text })
    },
    __remove(path) {
      files.delete(path)
    },
  }
}

function createMockTeams(members) {
  return {
    listMembers() {
      return members.map((member) => ({ id: member.id, name: member.name, role: member.role ?? 'teammate', status: member.status, diagnostics: member.diagnostics ?? [] }))
    },
  }
}

/**
 * 组装一个最小 Cordis 上下文，跑 apply 并捕获注册结果。
 * @param {object} options - { jobs, fs, teams, cwd }。
 * @returns {{tool: object, guards: Function[], sections: object[]}}
 */
function createHarness(options = {}) {
  const registered = []
  const guards = []
  const sections = []
  const ctx = {
    get(service) {
      if (service === 'systemPrompt') {
        return {
          section(definition) {
            sections.push(definition)
            return () => {}
          },
          getSectionOrder() {
            return 1600
          },
        }
      }
      if (service === 'workingDirectory') return { ensure: async () => options.cwd ?? '/tmp' }
      if (service === 'fs') return options.fs
      if (service === 'agentTeams') return options.teams
      return undefined
    },
    effect(fn) {
      return fn()
    },
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
      guard(guard) {
        guards.push(guard)
        return () => {}
      },
    },
    jobs: options.jobs,
  }
  apply(ctx)
  const tool = registered.find((definition) => definition.name === 'wait_until')
  return { tool, guards, sections }
}

async function runWaitUntil(harness, args, options = {}) {
  const controller = options.controller ?? new AbortController()
  const startedAt = Date.now()
  const result = await harness.tool.execute(args, {
    agent: options.noAgent === true ? undefined : { id: options.agentId ?? 'session-1' },
    signal: controller.signal,
  })
  return { result, elapsedMs: Date.now() - startedAt }
}

// 输出结构断言：required 字段齐全、枚举合法、类型正确。
function assertShape(result, label) {
  const required = ['status', 'elapsed_ms', 'elapsed', 'matched', 'conditions']
  for (const key of required) check(Object.hasOwn(result, key), `${label}: 缺少字段 ${key}`)
  check(['completed', 'failed', 'stalled', 'timeout', 'cancelled'].includes(result.status), `${label}: status 非法`, String(result.status))
  check(typeof result.elapsed_ms === 'number' && result.elapsed_ms >= 0, `${label}: elapsed_ms 非法`)
  check(typeof result.elapsed === 'string' && result.elapsed.length > 0, `${label}: elapsed 非法`)
  check(Array.isArray(result.matched), `${label}: matched 非数组`)
  check(Array.isArray(result.conditions), `${label}: conditions 非数组`)
  for (const row of result.conditions) {
    check(typeof row.condition === 'string', `${label}: condition 描述非字符串`)
    check(typeof row.state === 'string', `${label}: condition.state 非字符串`)
  }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

async function testImmediateFailure() {
  const jobs = createMockJobs()
  jobs.__seed('job-bad', { status: 'running', chunks: [] })
  const harness = createHarness({ jobs })
  setTimeout(() => {
    jobs.__update('job-bad', { status: 'failed', detail: 'exit code: 3', chunks: [{ at: 0, text: 'BOOM: intentional failure\n', channel: 'stderr' }] })
  }, 80)
  const { result, elapsedMs } = await runWaitUntil(harness, {
    conditions: [{ kind: 'job', id: 'job-bad' }],
    fail_fast: true,
    timeout_sec: 10,
    poll_interval_sec: 1,
  })
  assertShape(result, '立即失败')
  equal(result.status, 'failed', '立即失败：status 应为 failed')
  check(elapsedMs < 1500, '立即失败：应在事件到达后立刻返回', `实际 ${elapsedMs}ms`)
  check(typeof result.failure_reason === 'string' && result.failure_reason.includes('失败'), '立即失败：failure_reason 应说明失败')
  check(typeof result.output_tail === 'string' && result.output_tail.includes('BOOM'), '立即失败：output_tail 应包含 stderr 内容', JSON.stringify(result.output_tail))
}

async function testCompletionWakesImmediately() {
  const jobs = createMockJobs()
  jobs.__seed('job-ok', { status: 'running', chunks: [{ at: 0, text: 'working\n' }] })
  const harness = createHarness({ jobs })
  setTimeout(() => {
    jobs.__update('job-ok', { status: 'completed', detail: 'exit code: 0', chunks: [{ at: 0, text: 'working\n', channel: 'stdout' }, { at: 9, text: 'DONE\n', channel: 'stdout' }] })
  }, 120)
  const { result, elapsedMs } = await runWaitUntil(harness, {
    conditions: [{ kind: 'job', id: 'job-ok' }],
    fail_fast: true,
    timeout_sec: 10,
    poll_interval_sec: 5,
  })
  assertShape(result, '完成唤醒')
  // poll_interval 是 5 秒；事件驱动必须在 500ms 内返回，而不是等 5 秒。
  check(elapsedMs < 1500, '完成唤醒：应被作业事件立即唤醒', `实际 ${elapsedMs}ms`)
  equal(result.status, 'completed', '完成唤醒：status 应为 completed')
  check(result.output_tail.includes('DONE'), '完成唤醒：output_tail 应包含最终输出')
}

async function testNonZeroExitIsFailure() {
  // 平台把「进程退出但退出码非零」记为 completed + detail: "exit code: N"；
  // wait_until 必须把它识别成 failed，否则用户的「脚本报错」会伪装成完成。
  const jobs = createMockJobs()
  jobs.__seed('job-exit3', {
    status: 'completed',
    detail: 'exit code: 3',
    chunks: [{ at: 0, text: 'BOOM: missing flag --foo\n', channel: 'stderr' }],
  })
  const harness = createHarness({ jobs })
  const { result, elapsedMs } = await runWaitUntil(harness, {
    conditions: [{ kind: 'job', id: 'job-exit3' }],
    fail_fast: true,
    timeout_sec: 10,
    poll_interval_sec: 1,
  })
  assertShape(result, '非零退出')
  equal(result.status, 'failed', '非零退出：status 应为 failed 而不是 completed')
  check(elapsedMs < 1000, '非零退出：已结束的作业应在首轮立即返回', `实际 ${elapsedMs}ms`)
  check(typeof result.failure_reason === 'string' && result.failure_reason.includes('3'), '非零退出：原因应含退出码', JSON.stringify(result.failure_reason))
  check(result.output_tail.includes('BOOM'), '非零退出：应附 stderr 尾部')

  // fail_fast 关闭时，非零退出仍算「条件满足」，但不应误报为 failed。
  const relaxed = await runWaitUntil(harness, {
    conditions: [{ kind: 'job', id: 'job-exit3' }],
    fail_fast: false,
    timeout_sec: 10,
    poll_interval_sec: 1,
  })
  equal(relaxed.result.status, 'completed', '关闭 fail_fast 后非零退出应按条件满足返回 completed')
}

async function testWaitAllSemantics() {
  // 多个 conditions 是 wait_all：全部满足才 completed，部分满足应继续等到 timeout。
  const jobs = createMockJobs()
  jobs.__seed('job-forever', { status: 'running', chunks: [{ at: 0, text: 'running\n' }] })
  const fs = createMockFs()
  fs.__set('/tmp/ready.txt', 'ready')
  const harness = createHarness({ jobs, fs })
  const { result } = await runWaitUntil(harness, {
    conditions: [
      { kind: 'file', path: '/tmp/ready.txt', until: 'exists' },
      { kind: 'job', id: 'job-forever' },
    ],
    fail_fast: true,
    timeout_sec: 1,
    poll_interval_sec: 0.25,
  })
  assertShape(result, 'wait_all')
  equal(result.status, 'timeout', 'wait_all：部分条件满足时应超时，而不是 completed')
  const fileRow = result.conditions.find((row) => row.condition.includes('文件'))
  const jobRow = result.conditions.find((row) => row.condition.includes('后台作业'))
  equal(fileRow.state, 'satisfied', 'wait_all：文件条件应记为 satisfied')
  equal(jobRow.state, 'pending', 'wait_all：作业条件应仍为 pending')
}

async function testStall() {
  const jobs = createMockJobs()
  jobs.__seed('job-hang', { status: 'running', chunks: [{ at: 0, text: 'starting\n' }] })
  const harness = createHarness({ jobs })
  const { result, elapsedMs } = await runWaitUntil(harness, {
    conditions: [{ kind: 'job', id: 'job-hang' }],
    fail_fast: true,
    stall_after_sec: 5,
    timeout_sec: 60,
    poll_interval_sec: 0.25,
  })
  assertShape(result, '卡住检测')
  equal(result.status, 'stalled', '卡住检测：status 应为 stalled')
  check(elapsedMs >= 4500 && elapsedMs < 9000, '卡住检测：应在 stall 窗口附近返回', `实际 ${elapsedMs}ms`)
  check(typeof result.stalled_for_sec === 'number' && result.stalled_for_sec >= 5, '卡住检测：应给出无进展秒数')
  check(typeof result.output_tail === 'string' && result.output_tail.includes('starting'), '卡住检测：应附最后产出')
}

async function testTimeout() {
  const jobs = createMockJobs()
  jobs.__seed('job-slow', { status: 'running', chunks: [{ at: 0, text: 'still going\n' }] })
  const harness = createHarness({ jobs })
  const { result, elapsedMs } = await runWaitUntil(harness, {
    conditions: [{ kind: 'job', id: 'job-slow' }],
    fail_fast: true,
    timeout_sec: 1,
    poll_interval_sec: 0.25,
  })
  assertShape(result, '超时')
  equal(result.status, 'timeout', '超时：status 应为 timeout')
  check(elapsedMs >= 900 && elapsedMs < 3000, '超时：应在 timeout_sec 附近返回', `实际 ${elapsedMs}ms`)
  check(typeof result.hint === 'string', '超时：应给出下一步建议')
}

async function testCancelled() {
  const jobs = createMockJobs()
  jobs.__seed('job-long', { status: 'running', chunks: [] })
  const harness = createHarness({ jobs })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 150)
  const { result, elapsedMs } = await runWaitUntil(harness, {
    conditions: [{ kind: 'job', id: 'job-long' }],
    fail_fast: true,
    timeout_sec: 30,
    poll_interval_sec: 1,
  }, { controller })
  assertShape(result, '取消')
  equal(result.status, 'cancelled', '取消：status 应为 cancelled')
  check(elapsedMs < 2000, '取消：应被 signal 立即唤醒', `实际 ${elapsedMs}ms`)
}

async function testBatchFailFast() {
  const jobs = createMockJobs()
  jobs.__seed('job-fast', { status: 'running', chunks: [] })
  jobs.__seed('job-never', { status: 'running', chunks: [] })
  const harness = createHarness({ jobs })
  setTimeout(() => {
    jobs.__update('job-fast', { status: 'failed', detail: 'exit code: 2', chunks: [{ at: 0, text: 'fatal: bad flag\n', channel: 'stderr' }] })
  }, 100)
  const { result, elapsedMs } = await runWaitUntil(harness, {
    conditions: [{ kind: 'job', id: 'job-fast' }, { kind: 'job', id: 'job-never' }],
    fail_fast: true,
    timeout_sec: 20,
    poll_interval_sec: 1,
  })
  assertShape(result, '批量 fail_fast')
  equal(result.status, 'failed', '批量 fail_fast：任一失败应立即 failed，不等其它条件')
  check(elapsedMs < 2000, '批量 fail_fast：应立即返回', `实际 ${elapsedMs}ms`)
}

async function testFileExists() {
  const fs = createMockFs()
  const harness = createHarness({ fs })
  setTimeout(() => fs.__set('/tmp/artifact.zip', 'content'), 120)
  const { result, elapsedMs } = await runWaitUntil(harness, {
    conditions: [{ kind: 'file', path: '/tmp/artifact.zip', until: 'exists' }],
    timeout_sec: 5,
    poll_interval_sec: 0.25,
  })
  assertShape(result, '文件出现')
  equal(result.status, 'completed', '文件出现：status 应为 completed')
  check(elapsedMs < 2000, '文件出现：应尽快返回', `实际 ${elapsedMs}ms`)
}

async function testFileChanged() {
  const fs = createMockFs()
  fs.__set('/tmp/progress.bin', 'partial')
  const harness = createHarness({ fs })
  setTimeout(() => fs.__set('/tmp/progress.bin', 'partial more'), 120)
  const { result } = await runWaitUntil(harness, {
    conditions: [{ kind: 'file', path: '/tmp/progress.bin', until: 'changed' }],
    timeout_sec: 5,
    poll_interval_sec: 0.25,
  })
  assertShape(result, '文件变化')
  equal(result.status, 'completed', '文件变化：status 应为 completed')
}

async function testLogMatchesExisting() {
  const fs = createMockFs()
  fs.__set('/tmp/build.log', 'compile ok\nEXIT=0\n')
  const harness = createHarness({ fs })
  const { result, elapsedMs } = await runWaitUntil(harness, {
    conditions: [{ kind: 'log', path: '/tmp/build.log', matches: '/EXIT=0/' }],
    timeout_sec: 5,
    poll_interval_sec: 0.25,
  })
  assertShape(result, '日志已命中')
  equal(result.status, 'completed', '日志已命中：应立即 completed')
  check(elapsedMs < 1000, '日志已命中：首轮即返回', `实际 ${elapsedMs}ms`)
}

async function testLogMatchesNewContent() {
  const fs = createMockFs()
  fs.__set('/tmp/build.log', 'line 0\n')
  const harness = createHarness({ fs })
  setTimeout(() => fs.__set('/tmp/build.log', 'line 0\nline 1\nFAILED\n'), 300)
  const { result } = await runWaitUntil(harness, {
    conditions: [{ kind: 'log', path: '/tmp/build.log', matches: '/FAILED|EXIT=[1-9]/' }],
    timeout_sec: 5,
    poll_interval_sec: 0.25,
  })
  assertShape(result, '日志新增命中')
  equal(result.status, 'completed', '日志新增命中：status 应为 completed')
}

async function testAgentInactive() {
  const teams = createMockTeams([{ id: 'session-1', name: 'lead', role: 'lead', status: 'running' }, { id: 'session-2', name: 'worker', status: 'running' }])
  const harness = createHarness({ teams })
  setTimeout(() => {
    teams.listMembers = () => [
      { id: 'session-1', name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
      { id: 'session-2', name: 'worker', role: 'teammate', status: 'inactive', diagnostics: [] },
    ]
  }, 150)
  const { result } = await runWaitUntil(harness, {
    conditions: [{ kind: 'agent', target: 'worker', until: 'inactive' }],
    timeout_sec: 5,
    poll_interval_sec: 0.25,
  })
  assertShape(result, '队友空闲')
  equal(result.status, 'completed', '队友空闲：status 应为 completed')
}

async function testAgentFailed() {
  const teams = createMockTeams([{ id: 'session-1', name: 'lead', role: 'lead', status: 'running' }, { id: 'session-2', name: 'worker', status: 'running' }])
  const harness = createHarness({ teams })
  setTimeout(() => {
    teams.listMembers = () => [
      { id: 'session-1', name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
      { id: 'session-2', name: 'worker', role: 'teammate', status: 'failed', diagnostics: ['model request failed'] },
    ]
  }, 150)
  const { result } = await runWaitUntil(harness, {
    conditions: [{ kind: 'agent', target: 'worker', until: 'inactive' }],
    fail_fast: true,
    timeout_sec: 5,
    poll_interval_sec: 0.25,
  })
  assertShape(result, '队友失败')
  equal(result.status, 'failed', '队友失败：fail_fast 应立即 failed')
  check(result.failure_reason.includes('worker'), '队友失败：failure_reason 应点名成员')
}

async function testValidation() {
  const harness = createHarness({ jobs: createMockJobs() })
  const cases = [
    [{ conditions: [] }, '空 conditions 应被拒绝'],
    [{ conditions: [{ kind: 'nope' }] }, '非法 kind 应被拒绝'],
    [{ conditions: [{ kind: 'job' }] }, 'job 缺少 id 应被拒绝'],
    [{ conditions: [{ kind: 'log', path: '/tmp/x' }] }, 'log 缺少 matches 应被拒绝'],
    [{ conditions: [{ kind: 'file' }] }, 'file 缺少 path 应被拒绝'],
    [{ conditions: [{ kind: 'job', id: 'j' }], fail_fast: ['nope'] }, '非法 fail_fast 应被拒绝'],
  ]
  for (const [args, label] of cases) {
    let threw = false
    try {
      await runWaitUntil(harness, args)
    } catch {
      threw = true
    }
    check(threw, label)
  }
}

async function testMissingJobIsFatal() {
  const harness = createHarness({ jobs: createMockJobs() })
  const { result, elapsedMs } = await runWaitUntil(harness, {
    conditions: [{ kind: 'job', id: 'job-does-not-exist' }],
    timeout_sec: 30,
    poll_interval_sec: 1,
  })
  assertShape(result, '作业不存在')
  equal(result.status, 'failed', '作业不存在：应立即 failed 而不是空等')
  check(elapsedMs < 1000, '作业不存在：应立即返回', `实际 ${elapsedMs}ms`)
  check(result.failure_reason.includes('job-does-not-exist'), '作业不存在：原因应含作业 id')
}

function testGuards() {
  const harness = createHarness({ jobs: createMockJobs() })
  equal(harness.guards.length, 2, '应注册两条拦截规则')
  const [sleepGuard, longWaitGuard] = harness.guards

  const bash = (command, extra = {}) => sleepGuard({ name: 'bash', arguments: { command, description: 'x', ...extra } })
  check(typeof bash('sleep 180') === 'string', 'sleep 180 应被拒绝')
  check(typeof bash('cd /tmp && sleep 90 && ls') === 'string', '链式 sleep 90 应被拒绝')
  check(typeof bash('sleep 3') === 'undefined', 'sleep 3 属正常节奏，应放行')
  check(typeof bash('sleep 180', { run_in_background: true }) === 'undefined', '后台 sleep 应放行')
  check(typeof bash('sleep 90 &') === 'undefined', 'shell 后台 sleep 应放行')
  check(typeof bash('ffmpeg -i a.mp4 b.mp4') === 'undefined', '普通命令应放行')
  check(typeof bash('sleep 1m && echo ok') === 'string', 'sleep 1m 应被识别为 60 秒并拒绝')

  const jobOutput = (wait, timeout_ms) => longWaitGuard({ name: 'job_output', arguments: { job_id: 'j', wait, timeout_ms } })
  check(typeof jobOutput(true, 1800000) === 'string', 'job_output 30 分钟等待应被拒绝')
  check(typeof jobOutput(true, 60000) === 'undefined', 'job_output 60 秒等待应放行')
  check(typeof jobOutput(false, 1800000) === 'undefined', 'job_output 非等待调用应放行')

  const waitAgent = (timeout_ms) => longWaitGuard({ name: 'wait_agent', arguments: { timeout_ms } })
  check(typeof waitAgent(1800000) === 'string', 'wait_agent 30 分钟等待应被拒绝')
  check(typeof waitAgent(30000) === 'undefined', 'wait_agent 默认 30 秒应放行')

  check(typeof longWaitGuard({ name: 'wait_until', arguments: {} }) === 'undefined', 'wait_until 自身不应被拦截')
}

function testPromptPolicy() {
  const harness = createHarness({ jobs: createMockJobs() })
  equal(harness.sections.length, 1, '应注册一段系统提示词')
  const policy = harness.sections[0]
  check(policy.name === 'tool:wait-until', '提示词 section 名应为 tool:wait-until')
  check(policy.interpolate === false, '提示词应关闭插值')
  check(policy.text.includes('wait_until'), '提示词应提到 wait_until')
  check(policy.text.includes('sleep'), '提示词应提到 sleep')
}

function testMeta() {
  equal(name, 'tool-wait-until', '插件名应为 tool-wait-until')
  check(JSON.stringify(inject) === JSON.stringify(['tools', 'jobs', 'workingDirectory']), 'inject 应声明工具与作业服务')
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

const startedAt = Date.now()
const cases = [
  testMeta,
  testImmediateFailure,
  testCompletionWakesImmediately,
  testNonZeroExitIsFailure,
  testBatchFailFast,
  testWaitAllSemantics,
  testFileExists,
  testFileChanged,
  testLogMatchesExisting,
  testLogMatchesNewContent,
  testAgentInactive,
  testAgentFailed,
  testValidation,
  testMissingJobIsFatal,
  testCancelled,
  testTimeout,
  testStall,
  testGuards,
  testPromptPolicy,
]

for (const testCase of cases) {
  try {
    await testCase()
    process.stdout.write(`✓ ${testCase.name}\n`)
  } catch (error) {
    failures.push(`${testCase.name} 抛出异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.stdout.write(`✗ ${testCase.name}\n`)
  }
}

const totalMs = Date.now() - startedAt
process.stdout.write(`\n通过断言 ${passed} 条；失败 ${failures.length} 条；耗时 ${totalMs}ms\n`)
if (failures.length > 0) {
  process.stdout.write('\n失败明细：\n')
  for (const failure of failures) process.stdout.write(`- ${failure}\n`)
  process.exit(1)
}
process.stdout.write('全部通过\n')
