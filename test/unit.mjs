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

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function observeWithin(promise, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true, value }), (error) => ({ settled: true, error })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ settled: false }), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}



/** 只在单次执行中推进模型可见的墙钟，真实计时器仍负责测试的兜底与清理。 */
async function runWithControlledClock(harness, args, steps, options = {}) {
  const originalNow = Date.now
  const origin = originalNow()
  let clock = origin
  let settled = false
  const controller = new AbortController()
  let execution
  Date.now = () => clock
  try {
    execution = runWaitUntil(harness, args, { controller }).then((value) => {
      settled = true
      return value
    }, (error) => {
      settled = true
      throw error
    })
    execution.catch(() => {})
    // 先完成第一轮观察，随后每次跳钟都通过事件或一个短采样周期触发重检。
    await sleep(0)
    for (const step of steps) {
      clock = origin + step.ms
      step.change?.()
      options.wake?.()
      await sleep(options.flushMs ?? 0)
      if (step.pending) check(!settled, options.label + '：' + step.ms / 1000 + ' 秒时仍应等待')
    }
    const observed = await observeWithin(execution, 1500)
    check(observed.settled && observed.error === undefined, options.label + '：推进截止点后应返回结构化结果')
    return observed.value?.result
  } finally {
    Date.now = originalNow
    controller.abort()
    if (execution !== undefined) await observeWithin(execution, 1500)
  }
}

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
    __listenerCount() {
      return listeners.size
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
      if (service === 'workingDirectory') return options.workingDirectory ?? { ensure: async () => options.cwd ?? '/tmp' }
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
  equal(result.suggested_timeout_sec, 120, '超时：应给出 suggested_timeout_sec=120')
  check(result.hint.includes('timeout_sec: 120'), '超时：hint 应包含建议值', result.hint)
}

async function testDefaultJobStall() {
  for (const item of [
    { label: 'job 默认 180 秒 stall', args: {}, steps: [{ ms: 179000, pending: true }, { ms: 181000 }], expected: 'stalled' },
    { label: 'job 默认 300 秒 timeout 且显式关闭 stall', args: { stall_after_sec: 0 }, steps: [{ ms: 181000, pending: true }, { ms: 299000, pending: true }, { ms: 301000 }], expected: 'timeout' },
    { label: 'job 显式 timeout 优先', args: { timeout_sec: 1, stall_after_sec: 0 }, steps: [{ ms: 2000 }], expected: 'timeout' },
  ]) {
    const jobs = createMockJobs()
    jobs.__seed('job-default-policy', { status: 'running', chunks: [] })
    const result = await runWithControlledClock(createHarness({ jobs }), {
      conditions: [{ kind: 'job', id: 'job-default-policy' }],
      poll_interval_sec: 0.25,
      ...item.args,
    }, item.steps, {
      label: item.label,
      wake: () => jobs.__update('job-default-policy', {}),
    })
    equal(result?.status, item.expected, item.label + '：策略应生效')
    equal(jobs.__listenerCount(), 0, item.label + '：结束后不保留订阅')
  }

  for (const item of [
    { label: '非 job 默认 60 秒 timeout', args: {}, steps: [{ ms: 59000, pending: true }, { ms: 61000 }] },
    { label: '非 job 默认关闭 stall', args: { timeout_sec: 300 }, steps: [{ ms: 181000, pending: true }, { ms: 301000 }] },
  ]) {
    const fs = createMockFs()
    const result = await runWithControlledClock(createHarness({ fs }), {
      conditions: [{ kind: 'file', path: '/tmp/default-policy-missing.txt' }],
      poll_interval_sec: 0.25,
      ...item.args,
    }, item.steps, { label: item.label, flushMs: 300 })
    equal(result?.status, 'timeout', item.label + '：策略应生效')
  }
}


async function testStallDeadlinePrecedesPollInterval() {
  const jobs = createMockJobs()
  jobs.__seed('job-slow-poll', { status: 'running', chunks: [] })
  const { result, elapsedMs } = await runWaitUntil(createHarness({ jobs }), {
    conditions: [{ kind: 'job', id: 'job-slow-poll' }],
    stall_after_sec: 5,
    poll_interval_sec: 8,
    timeout_sec: 10,
  })
  equal(result.status, 'stalled', 'stall 截止点：应独立于较长 poll 返回')
  check(elapsedMs >= 4500 && elapsedMs < 7000, 'stall 截止点：5 秒窗口不应被 8 秒 poll 推迟', String(elapsedMs))
  equal(jobs.__listenerCount(), 0, 'stall 截止点：结束后应清理订阅')
}

async function testFileChangedFromMissingToPresent() {
  const fs = createMockFs()
  const originalStat = fs.stat.bind(fs)
  let stats = 0
  fs.stat = async (...args) => {
    const result = await originalStat(...args)
    stats += 1
    if (stats === 1) queueMicrotask(() => fs.__set('/tmp/new-file.txt', 'created'))
    return result
  }
  const { result } = await runWaitUntil(createHarness({ fs }), {
    conditions: [{ kind: 'file', path: '/tmp/new-file.txt', until: 'changed' }],
    timeout_sec: 2,
    poll_interval_sec: 0.25,
  })
  equal(result.status, 'completed', '文件 changed：初始不存在时首次出现应算变化')
  check(stats >= 2, '文件 changed：应先观察不存在，再观察出现')
}

async function testLogContentReplacements() {
  for (const item of [
    { label: '同尺寸覆盖', before: 'WAIT\n', after: 'DONE\n' },
    { label: '缩小重写', before: 'waiting for a much longer operation\n', after: 'DONE\n' },
  ]) {
    const fs = createMockFs()
    fs.__set('/tmp/rewrite.log', item.before)
    const originalRead = fs.readByteRange.bind(fs)
    let reads = 0
    fs.readByteRange = async (...args) => {
      const bytes = await originalRead(...args)
      reads += 1
      if (reads === 1) queueMicrotask(() => fs.__set('/tmp/rewrite.log', item.after))
      return bytes
    }
    const { result } = await runWaitUntil(createHarness({ fs }), {
      conditions: [{ kind: 'log', path: '/tmp/rewrite.log', matches: '/^DONE$/m' }],
      timeout_sec: 2,
      poll_interval_sec: 0.25,
    })
    equal(result.status, 'completed', '日志重写：' + item.label + ' 应重新检查内容')
    check(reads >= 2, '日志重写：' + item.label + ' 应实际重读')
  }
}

async function testLogDeleteAndRecreate() {
  const fs = createMockFs()
  fs.__set('/tmp/rotate.log', 'WAIT\n')
  const originalRead = fs.readByteRange.bind(fs)
  const originalStat = fs.stat.bind(fs)
  let reads = 0
  let sawMissing = false
  fs.readByteRange = async (...args) => {
    const bytes = await originalRead(...args)
    reads += 1
    if (reads === 1) queueMicrotask(() => fs.__remove('/tmp/rotate.log'))
    return bytes
  }
  fs.stat = async (...args) => {
    const info = await originalStat(...args)
    if (info === undefined && reads > 0) {
      sawMissing = true
      queueMicrotask(() => fs.__set('/tmp/rotate.log', 'DONE\n'))
    }
    return info
  }
  const { result } = await runWaitUntil(createHarness({ fs }), {
    conditions: [{ kind: 'log', path: '/tmp/rotate.log', matches: '/^DONE$/m' }],
    timeout_sec: 3,
    poll_interval_sec: 0.25,
  })
  equal(result.status, 'completed', '日志轮转：删除后同尺寸重建应重新匹配')
  check(sawMissing, '日志轮转：fixture 应实际观察到文件不存在')
  check(reads >= 2, '日志轮转：应读取新文件内容')
}

async function testLogRewriteWhileCatchingUp() {
  const fs = createMockFs()
  const largeAppend = 'WAIT\n' + 'x'.repeat(100000)
  // 标记处于最后 64 KiB 内，但位于增量读取游标已经越过的区域。
  const replacement = 'x'.repeat(50000) + '\nDONE\n' + 'x'.repeat(largeAppend.length - 50006)
  fs.__set('/tmp/catch-up.log', 'WAIT\n')
  const originalRead = fs.readByteRange.bind(fs)
  let reads = 0
  let rewroteBeforeCaughtUp = false
  fs.readByteRange = async (target, range) => {
    const bytes = await originalRead(target, range)
    reads += 1
    if (reads === 1) {
      queueMicrotask(() => fs.__set('/tmp/catch-up.log', largeAppend))
    } else if (!rewroteBeforeCaughtUp && range.offset > 0 && range.offset + bytes.byteLength < largeAppend.length) {
      rewroteBeforeCaughtUp = true
      queueMicrotask(() => fs.__set('/tmp/catch-up.log', replacement))
    }
    return bytes
  }
  const { result } = await runWaitUntil(createHarness({ fs }), {
    conditions: [{ kind: 'log', path: '/tmp/catch-up.log', matches: '/^DONE$/m' }],
    timeout_sec: 3,
    poll_interval_sec: 0.25,
  })
  equal(replacement.length, largeAppend.length, '日志追读：fixture 必须是同尺寸改写')
  check(rewroteBeforeCaughtUp, '日志追读：应在大增量尚未读完时改写')
  equal(result.status, 'completed', '日志追读：版本变化不能只与 readOffset 比较而漏掉改写')
}


async function testLogPresenceChangesResetStall() {
  for (const scenario of ['appearance', 'deletion']) {
    const fs = createMockFs()
    if (scenario === 'deletion') fs.__set('/tmp/presence.log', 'work\n')
    const steps = scenario === 'appearance'
      ? [
        { ms: 5000, pending: true, change: () => fs.__set('/tmp/presence.log', 'work\n') },
        { ms: 6000, change: () => fs.__set('/tmp/presence.log', 'work\nDONE\n') },
      ]
      : [
        { ms: 5000, pending: true, change: () => fs.__remove('/tmp/presence.log') },
        { ms: 9000, pending: true },
        { ms: 10100 },
      ]
    const label = scenario === 'appearance' ? '日志首次出现算进展' : '日志删除只刷新一次进展'
    const result = await runWithControlledClock(createHarness({ fs }), {
      conditions: [{ kind: 'log', path: '/tmp/presence.log', matches: '/^DONE$/m' }],
      timeout_sec: 20,
      stall_after_sec: 5,
      poll_interval_sec: 0.25,
    }, steps, { label, flushMs: 300 })
    equal(result?.status, scenario === 'appearance' ? 'completed' : 'stalled', label + '：stall 边界应正确')
  }
}

async function testAgentStallSemantics() {
  const teams = createMockTeams([{ id: 'worker', name: 'worker', status: 'running' }])
  const harness = createHarness({ jobs: createMockJobs(), teams })
  const { result, elapsedMs } = await runWaitUntil(harness, {
    conditions: [{ kind: 'agent', target: 'worker', until: 'inactive' }],
    stall_after_sec: 5,
    timeout_sec: 30,
    poll_interval_sec: 0.25,
  })
  assertShape(result, '队友卡住检测')
  equal(result.status, 'stalled', '队友卡住检测：status 应为 stalled')
  check(elapsedMs >= 4500 && elapsedMs < 9000, '队友卡住检测：应在 stall 窗口附近返回', `实际 ${elapsedMs}ms`)
  check(result.hint.includes('长任务'), '队友卡住检测：提示应说明可能是长任务而非卡死', result.hint)
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


async function testLogMatchPersistsUntilOtherConditionsComplete() {
  const jobs = createMockJobs()
  jobs.__seed('job-after-log', { status: 'running', chunks: [] })
  const fs = createMockFs()
  fs.__set('/tmp/ready.log', 'READY\n')
  const originalRead = fs.readByteRange.bind(fs)
  let firstRead = true
  fs.readByteRange = async (...args) => {
    const bytes = await originalRead(...args)
    if (firstRead) {
      firstRead = false
      queueMicrotask(() => jobs.__update('job-after-log', { status: 'completed', detail: 'exit code: 0' }))
    }
    return bytes
  }
  const { result } = await runWaitUntil(createHarness({ jobs, fs }), {
    conditions: [
      { kind: 'job', id: 'job-after-log' },
      { kind: 'log', path: '/tmp/ready.log', matches: '/^READY$/m' },
    ],
    timeout_sec: 2,
    poll_interval_sec: 0.25,
  })
  equal(result.status, 'completed', '日志事件：已发生的命中应保留到其它条件完成')
  equal(result.matched.length, 2, '日志事件：返回应包含两个已满足条件')
  check(result.conditions.every((row) => row.state === 'satisfied'), '日志事件：所有条件都应保持 satisfied')
}

async function testAgentChangesCanCompleteOnDifferentPolls() {
  let samples = 0
  const teams = {
    listMembers() {
      samples += 1
      return [
        { id: 'worker-a', name: 'worker-a', status: samples >= 3 ? 'inactive' : 'running', diagnostics: [] },
        { id: 'worker-b', name: 'worker-b', status: samples >= 5 ? 'inactive' : 'running', diagnostics: [] },
      ]
    },
  }
  const { result } = await runWaitUntil(createHarness({ teams }), {
    conditions: [
      { kind: 'agent', target: 'worker-a', until: 'status_changed' },
      { kind: 'agent', target: 'worker-b', until: 'status_changed' },
    ],
    timeout_sec: 2,
    poll_interval_sec: 0.25,
  })
  equal(result.status, 'completed', '队友变化事件：先后发生的变化都应计入 wait_all')
  equal(result.matched.length, 2, '队友变化事件：返回应保留两个已观察到的变化')
}

async function testFileExistsIsResampledAfterOtherEvents() {
  const jobs = createMockJobs()
  jobs.__seed('job-after-file', { status: 'running', chunks: [] })
  const fs = createMockFs()
  fs.__set('/tmp/transient-ready.txt', 'ready')
  const originalStat = fs.stat.bind(fs)
  let firstStat = true
  fs.stat = async (...args) => {
    const stat = await originalStat(...args)
    if (firstStat) {
      firstStat = false
      fs.__remove('/tmp/transient-ready.txt')
      queueMicrotask(() => jobs.__update('job-after-file', { status: 'completed', detail: 'exit code: 0' }))
    }
    return stat
  }
  const { result } = await runWaitUntil(createHarness({ jobs, fs }), {
    conditions: [
      { kind: 'job', id: 'job-after-file' },
      { kind: 'file', path: '/tmp/transient-ready.txt', until: 'exists' },
    ],
    timeout_sec: 1,
    poll_interval_sec: 0.25,
    stall_after_sec: 0,
  })
  equal(result.status, 'timeout', '文件状态：文件消失后不能沿用第一次 exists 的满足状态')
  equal(result.conditions[0].state, 'satisfied', '文件状态：其它作业已完成')
  equal(result.conditions[1].state, 'pending', '文件状态：文件消失后应重新变为 pending')
}

async function testPendingIoBoundaries() {
  for (const scenario of [
    { label: '工作目录解析期间取消', operation: 'workingDirectory', cancel: true },
    { label: '文件 stat 期间取消', operation: 'stat', cancel: true },
    { label: '文件 stat 超过总 deadline', operation: 'stat', cancel: false },
  ]) {
    const started = deferred()
    const pending = deferred()
    const jobs = createMockJobs()
    jobs.__seed('job-io-boundary', { status: 'running', chunks: [] })
    const fs = createMockFs()
    const enter = () => {
      started.resolve()
      return pending.promise
    }
    if (scenario.operation === 'stat') fs.stat = enter
    const workingDirectory = scenario.operation === 'workingDirectory' ? { ensure: enter } : undefined
    const controller = new AbortController()
    const unhandled = []
    const onUnhandled = (error) => unhandled.push(error)
    process.on('unhandledRejection', onUnhandled)
    let completions = 0
    const execution = runWaitUntil(createHarness({ jobs, fs, workingDirectory }), {
      conditions: [
        { kind: 'job', id: 'job-io-boundary' },
        { kind: 'file', path: '/tmp/pending-io.txt' },
      ],
      timeout_sec: scenario.cancel ? 10 : 1,
      poll_interval_sec: 0.25,
      stall_after_sec: 0,
    }, { controller }).then((value) => {
      completions += 1
      return value
    })
    // 立即接住工具级拒绝；后续仍由 observeWithin 检查，不吞掉测试失败。
    execution.catch(() => {})
    try {
      const entered = await observeWithin(started.promise, 1500)
      check(entered.settled, scenario.label + '：应进入挂起的 IO')
      if (!entered.settled) throw new Error(scenario.label + '：未进入目标 IO')
      if (scenario.cancel) controller.abort()

      // IO 始终未结束；足够的调度余量仍能区分“及时返回”和“等 IO 返回”。
      const observed = await observeWithin(execution, scenario.cancel ? 1500 : 2500)
      check(observed.settled, scenario.label + '：结果必须在 IO 完成前返回')
      check(observed.error === undefined, scenario.label + '：应返回结构化结果而不是拒绝 Promise')
      const snapshot = observed.value === undefined ? undefined : JSON.stringify(observed.value.result)

      // 工具返回后才拒绝底层 IO，检查晚到拒绝的处理与结果稳定性。
      pending.reject(new Error('late mock IO rejection'))
      const final = observed.settled ? observed : await observeWithin(execution, 1500)
      check(final.settled && final.error === undefined, scenario.label + '：执行应能结束')
      if (final.value !== undefined) {
        equal(final.value.result.status, scenario.cancel ? 'cancelled' : 'timeout', scenario.label + '：终态应正确')
        if (!scenario.cancel) {
          check(final.value.elapsedMs >= 800 && final.value.elapsedMs < 2300, scenario.label + '：1 秒 deadline 应覆盖 IO', String(final.value.elapsedMs))
        }
        await sleep(0)
        await sleep(0)
        if (snapshot !== undefined) equal(JSON.stringify(final.value.result), snapshot, scenario.label + '：晚到拒绝不能改写已交付结果')
      }
      equal(unhandled.length, 0, scenario.label + '：不能产生 unhandled rejection')
      equal(completions, 1, scenario.label + '：只交付一次结果')
      equal(jobs.__listenerCount(), 0, scenario.label + '：应清理作业事件订阅')
    } finally {
      pending.resolve(undefined)
      controller.abort()
      await observeWithin(execution, 1500)
      process.removeListener('unhandledRejection', onUnhandled)
    }
  }
}

// 混合条件中的 IO 保持挂起，作业事件由测试明确触发，不依赖毫秒级调度先后。
function createMixedPendingIoFixture(operation, jobFirst) {
  const jobs = createMockJobs()
  const jobId = 'job-mixed-' + operation + (jobFirst ? '-first' : '-last')
  jobs.__seed(jobId, { status: 'running', chunks: [] })
  const fs = createMockFs()
  const path = '/tmp/mixed-pending-io.txt'
  fs.__set(path, 'READY\n')
  const started = deferred()
  const pending = deferred()
  let ioCalls = 0
  const enter = () => {
    ioCalls += 1
    started.resolve()
    return pending.promise
  }
  let workingDirectory
  let releaseValue
  if (operation === 'stat') {
    fs.stat = enter
    releaseValue = { type: 'file', version: 'released-v1', size: 6 }
  } else if (operation === 'read') {
    fs.readByteRange = enter
    releaseValue = new TextEncoder().encode('READY\n')
  } else {
    workingDirectory = { ensure: enter }
    releaseValue = '/tmp'
  }
  const jobCondition = { kind: 'job', id: jobId }
  const ioCondition = operation === 'read'
    ? { kind: 'log', path, matches: '/^READY$/m' }
    : { kind: 'file', path }
  const conditions = jobFirst ? [jobCondition, ioCondition] : [ioCondition, jobCondition]
  const subscribe = jobs.events.subscribe
  let muteEvents = false
  jobs.events.subscribe = (filter, listener) => subscribe(filter, (event) => {
    if (!muteEvents) listener(event)
  })
  return {
    jobs, fs, workingDirectory, conditions, started, pending, jobId,
    jobIndex: jobFirst ? 0 : 1,
    ioIndex: jobFirst ? 1 : 0,
    get ioCalls() { return ioCalls },
    release() { pending.resolve(releaseValue) },
    update(patch, silent = false) {
      muteEvents = silent
      try {
        jobs.__update(jobId, patch)
      } finally {
        muteEvents = false
      }
    },
    fail(silent = false) {
      this.update({
        status: 'completed',
        detail: 'exit code: 7',
        chunks: [{ at: 0, text: 'MIXED_JOB_EXIT_7\n', channel: 'stderr' }],
      }, silent)
    },
  }
}

async function testMixedPendingIoJobFailure() {
  const scenarios = ['stat', 'read', 'cwd'].flatMap((operation) =>
    [true, false].map((jobFirst) => ({ operation, jobFirst, silent: false })))
  scenarios.push(
    { operation: 'stat', jobFirst: false, silent: true },
    { operation: 'cwd', jobFirst: true, silent: true },
  )
  for (const scenario of scenarios) {
    const label = '混合 IO 失败：' + scenario.operation + '，job ' +
      (scenario.jobFirst ? '在前' : '在后') + (scenario.silent ? '，事件未送达' : '')
    const fixture = createMixedPendingIoFixture(scenario.operation, scenario.jobFirst)
    const controller = new AbortController()
    const unhandled = []
    const onUnhandled = (error) => unhandled.push(error)
    process.on('unhandledRejection', onUnhandled)
    let completions = 0
    const execution = runWaitUntil(createHarness(fixture), {
      conditions: fixture.conditions,
      timeout_sec: 10,
      poll_interval_sec: scenario.silent ? 0.25 : 5,
      stall_after_sec: 0,
    }, { controller }).then((value) => {
      completions += 1
      return value
    })
    execution.catch(() => {})
    try {
      const entered = await observeWithin(fixture.started.promise, 1500)
      check(entered.settled, label + '：应进入目标 IO')
      if (!entered.settled) throw new Error(label + '：未进入目标 IO')
      fixture.fail(scenario.silent)

      // 事件路径的轮询周期为 5 秒；1.5 秒余量明确区别事件响应与等待下一次轮询。
      const observed = await observeWithin(execution, 1500)
      check(observed.settled && observed.error === undefined, label + '：IO 仍挂起时应提前返回结构化失败')
      let snapshot
      if (observed.value !== undefined) {
        const result = observed.value.result
        equal(result.status, 'failed', label + '：非零退出应失败')
        check(result.failure_reason?.includes(fixture.jobId) && result.failure_reason.includes('7'), label + '：应保留失败作业和退出码')
        check(result.output_tail?.includes('MIXED_JOB_EXIT_7'), label + '：应附失败作业 stderr 尾部')
        equal(result.conditions.length, 2, label + '：所有条件行都应保留')
        const row = result.conditions[fixture.jobIndex]
        equal(row.state, 'failed', label + '：正确的作业行应标为 failed')
        check(row.condition.includes(fixture.jobId), label + '：作业行应对应失败目标')
        check(/exit code:\s*7/.test(row.detail), label + '：作业行应携带最新退出证据')
        equal(result.conditions[fixture.ioIndex].state, 'pending', label + '：未完成的 IO 条件应保持 pending')
        snapshot = JSON.stringify(result)
      }

      // 先交付结果，再使 IO 拒绝；旧实现未提前返回时也立即取消，避免等完整 timeout。
      if (!observed.settled) controller.abort()
      fixture.pending.reject(new Error('late mixed IO rejection'))
      const final = await observeWithin(execution, 1500)
      check(final.settled && final.error === undefined, label + '：清理后执行应结束')
      await sleep(0)
      await sleep(0)
      if (snapshot !== undefined) equal(JSON.stringify(final.value?.result), snapshot, label + '：晚到拒绝不能改写结果')
      equal(unhandled.length, 0, label + '：晚到拒绝应被消费')
      equal(completions, 1, label + '：只能交付一次结果')
      equal(fixture.jobs.__listenerCount(), 0, label + '：应清理作业订阅')
    } finally {
      fixture.release()
      controller.abort()
      await observeWithin(execution, 1500)
      process.removeListener('unhandledRejection', onUnhandled)
    }
  }
}

async function testMixedInitialJobFailurePrecedesCwd() {
  const label = '混合初始失败应先于工作目录解析'
  const fixture = createMixedPendingIoFixture('cwd', true)
  fixture.conditions = [
    { kind: 'job', id: fixture.jobId },
    { kind: 'agent', target: 'worker' },
  ]
  fixture.teams = createMockTeams([{ id: 'worker-id', name: 'worker', status: 'working' }])
  fixture.fail()
  const controller = new AbortController()
  const execution = runWaitUntil(createHarness(fixture), {
    conditions: fixture.conditions,
    timeout_sec: 10,
    poll_interval_sec: 5,
    stall_after_sec: 0,
  }, { controller })
  execution.catch(() => {})
  try {
    const observed = await observeWithin(execution, 1500)
    check(observed.settled && observed.error === undefined, label + '：应直接返回结构化失败')
    if (observed.value !== undefined) {
      equal(observed.value.result.status, 'failed', label + '：预先非零退出应失败')
      equal(observed.value.result.conditions[0].state, 'failed', label + '：作业行应标为 failed')
      equal(observed.value.result.conditions[1].state, 'pending', label + '：未评估的队友行应保留')
      check(observed.value.result.output_tail?.includes('MIXED_JOB_EXIT_7'), label + '：应附已有 stderr 尾部')
    }
    equal(fixture.ioCalls, 0, label + '：已知作业失败时不应启动 ensure')
  } finally {
    controller.abort()
    fixture.release()
    await observeWithin(execution, 1500)
  }
  equal(fixture.jobs.__listenerCount(), 0, label + '：应清理作业订阅')
}

async function testMixedPendingIoFailFastDisabled() {
  for (const failFast of [false, [], ['agent_failed']]) {
    for (const operation of ['stat', 'read', 'cwd']) {
      for (const jobFirst of [true, false]) {
        const label = '混合 IO 禁用作业失败检测：' + operation + '，job ' +
          (jobFirst ? '在前' : '在后') + '，fail_fast=' + JSON.stringify(failFast)
        const fixture = createMixedPendingIoFixture(operation, jobFirst)
        const controller = new AbortController()
        const execution = runWaitUntil(createHarness(fixture), {
          conditions: fixture.conditions,
          fail_fast: failFast,
          timeout_sec: 10,
          poll_interval_sec: 0.25,
          stall_after_sec: 0,
        }, { controller })
        execution.catch(() => {})
        try {
          const entered = await observeWithin(fixture.started.promise, 1500)
          check(entered.settled, label + '：应进入目标 IO')
          if (!entered.settled) throw new Error(label + '：未进入目标 IO')
          fixture.fail()
          const whilePending = await observeWithin(execution, 250)
          check(!whilePending.settled, label + '：job 失败不能越过尚未满足的 IO 条件')
          fixture.release()
          const completed = await observeWithin(execution, 1500)
          check(completed.settled && completed.error === undefined, label + '：IO 满足后应能结束')
          if (completed.value !== undefined) {
            equal(completed.value.result.status, 'completed', label + '：非零退出按 settled 条件满足')
            equal(completed.value.result.conditions.filter((row) => row.state === 'satisfied').length, 2, label + '：两行都应满足')
          }
          equal(fixture.jobs.__listenerCount(), 0, label + '：应清理作业订阅')
        } finally {
          fixture.release()
          controller.abort()
          await observeWithin(execution, 1500)
        }
      }
    }
  }
}

async function testMixedPendingIoNonfailureEvents() {
  for (const operation of ['stat', 'read', 'cwd']) {
    for (const jobFirst of [true, false]) {
      const label = '混合 IO 普通事件：' + operation + '，job ' + (jobFirst ? '在前' : '在后')
      const fixture = createMixedPendingIoFixture(operation, jobFirst)
      const controller = new AbortController()
      const execution = runWaitUntil(createHarness(fixture), {
        conditions: fixture.conditions,
        timeout_sec: 10,
        poll_interval_sec: 0.25,
        stall_after_sec: 0,
      }, { controller })
      execution.catch(() => {})
      try {
        const entered = await observeWithin(fixture.started.promise, 1500)
        check(entered.settled, label + '：应进入目标 IO')
        if (!entered.settled) throw new Error(label + '：未进入目标 IO')
        fixture.update({ chunks: [{ at: 0, text: 'still working\n', channel: 'stdout' }] })
        check(!(await observeWithin(execution, 250)).settled, label + '：普通输出不能提前结束整组等待')
        equal(fixture.ioCalls, 1, label + '：普通输出不能重启挂起的 IO')
        fixture.update({ status: 'completed', detail: 'exit code: 0' })
        check(!(await observeWithin(execution, 250)).settled, label + '：成功事件不能越过尚未满足的 IO 条件')
        equal(fixture.ioCalls, 1, label + '：成功事件不能重启挂起的 IO')
        fixture.release()
        const completed = await observeWithin(execution, 1500)
        check(completed.settled && completed.error === undefined, label + '：IO 满足后应能结束')
        if (completed.value !== undefined) equal(completed.value.result.status, 'completed', label + '：全部满足后应成功')
        equal(fixture.jobs.__listenerCount(), 0, label + '：应清理作业订阅')
      } finally {
        fixture.release()
        controller.abort()
        await observeWithin(execution, 1500)
      }
    }
  }
}

async function testMixedPendingIoTerminalDecisionsStayFinal() {
  for (const expected of ['cancelled', 'timeout']) {
    const label = '混合 IO 已交付 ' + expected + ' 后发生作业失败'
    const fixture = createMixedPendingIoFixture('stat', false)
    const controller = new AbortController()
    const unhandled = []
    const onUnhandled = (error) => unhandled.push(error)
    process.on('unhandledRejection', onUnhandled)
    let completions = 0
    const execution = runWaitUntil(createHarness(fixture), {
      conditions: fixture.conditions,
      timeout_sec: expected === 'timeout' ? 1 : 10,
      poll_interval_sec: 0.25,
      stall_after_sec: 0,
    }, { controller }).then((value) => {
      completions += 1
      return value
    })
    execution.catch(() => {})
    try {
      const entered = await observeWithin(fixture.started.promise, 1500)
      check(entered.settled, label + '：应进入目标 IO')
      if (!entered.settled) throw new Error(label + '：未进入目标 IO')
      if (expected === 'cancelled') controller.abort()
      const observed = await observeWithin(execution, expected === 'timeout' ? 2500 : 1500)
      check(observed.settled && observed.error === undefined, label + '：应先交付原定终态')
      if (observed.value !== undefined) equal(observed.value.result.status, expected, label + '：终态应正确')
      const snapshot = JSON.stringify(observed.value?.result)
      fixture.fail()
      fixture.pending.reject(new Error('late IO rejection after ' + expected))
      await sleep(0)
      await sleep(0)
      equal(JSON.stringify(observed.value?.result), snapshot, label + '：晚到失败不能改写已交付结果')
      equal(unhandled.length, 0, label + '：晚到 IO 拒绝应被消费')
      equal(completions, 1, label + '：只能交付一次结果')
      equal(fixture.jobs.__listenerCount(), 0, label + '：应清理作业订阅')
    } finally {
      fixture.release()
      controller.abort()
      await observeWithin(execution, 1500)
      process.removeListener('unhandledRejection', onUnhandled)
    }
  }
}

async function testAgentFailFastModes() {
  const modes = [
    { value: true, expected: 'failed' },
    { value: false, expected: 'completed' },
    { value: [], expected: 'completed' },
    { value: ['job_failed'], expected: 'completed' },
    { value: ['agent_failed'], expected: 'failed' },
  ]
  for (const until of ['inactive', 'failed']) {
    for (const mode of modes) {
      const label = '队友模式 until=' + until + ', fail_fast=' + JSON.stringify(mode.value)
      const teams = createMockTeams([{ id: 'worker', name: 'worker', status: 'failed', diagnostics: ['mock failure'] }])
      const { result } = await runWaitUntil(createHarness({ teams }), {
        conditions: [{ kind: 'agent', target: 'worker', until }],
        fail_fast: mode.value,
        timeout_sec: 1,
      })
      equal(result.status, mode.expected, label + '：只执行明确启用的失败检测')
      equal(result.conditions[0].state, mode.expected === 'failed' ? 'failed' : 'satisfied', label + '：条件状态与终态应一致')
      if (mode.expected === 'failed') check(result.failure_reason.includes('worker'), label + '：失败原因应点名成员')
    }
  }
}

async function testExitMarkerEvidence() {
  const cases = [
    { label: '默认模式不推断文本退出码', output: 'EXIT=3\n', mode: true, expected: 'completed' },
    { label: 'job_failed 不推断文本退出码', output: 'EXIT=3\n', mode: ['job_failed'], expected: 'completed' },
    { label: '显式推断支持完整一行', output: 'EXIT=3\n', mode: ['exit_code_nonzero'], expected: 'failed' },
    { label: '显式推断支持行边空格及 CRLF', output: ' \tEXIT=-2 \t\r\n', mode: ['exit_code_nonzero'], expected: 'failed' },
    { label: '先零后非零标记不漏判', output: 'EXIT=0\nEXIT=3\n', mode: ['exit_code_nonzero'], expected: 'failed' },
    { label: '非零标记后的零不撤销失败', output: 'EXIT=3\nEXIT=0\n', mode: ['exit_code_nonzero'], expected: 'failed' },
    { label: '普通说明不作为退出标记', output: 'example: EXIT=3 means failure\n', mode: ['exit_code_nonzero'], expected: 'completed' },
    { label: '标记尾部说明不构成完整一行', output: 'EXIT=3 is an example\n', mode: ['exit_code_nonzero'], expected: 'completed' },
    { label: '较长标识符不作为退出标记', output: 'NOTEXIT=3\n', mode: ['exit_code_nonzero'], expected: 'completed' },
    { label: '真实成功退出码优先于文本', detail: 'exit code: 0', output: 'EXIT=3\n', mode: ['exit_code_nonzero'], expected: 'completed' },
    { label: '真实失败退出码优先于文本', detail: 'exit code: 7', output: 'EXIT=0\n', mode: ['exit_code_nonzero'], expected: 'failed' },
  ]
  for (const item of cases) {
    const jobs = createMockJobs()
    jobs.__seed('job-marker', {
      status: 'completed',
      ...(item.detail === undefined ? {} : { detail: item.detail }),
      chunks: [{ at: 0, text: item.output, channel: 'stdout' }],
    })
    const { result } = await runWaitUntil(createHarness({ jobs }), {
      conditions: [{ kind: 'job', id: 'job-marker' }],
      fail_fast: item.mode,
      timeout_sec: 1,
    })
    equal(result.status, item.expected, '退出证据：' + item.label)
  }

  const jobs = createMockJobs()
  jobs.__seed('job-live-marker', { status: 'running', chunks: [{ at: 0, text: 'EXIT=0\nEXIT=3\n', channel: 'stderr' }] })
  const { result } = await runWaitUntil(createHarness({ jobs }), {
    conditions: [{ kind: 'job', id: 'job-live-marker' }],
    fail_fast: ['exit_code_nonzero'],
    timeout_sec: 1,
    stall_after_sec: 0,
  })
  equal(result.status, 'failed', '退出证据：显式文本推断应在进程退出前识别非零标记')
}


async function testExitMarkerWindowBoundaries() {
  for (const channel of ['stdout', 'stderr']) {
    for (const item of [
      { label: '展示裁剪不能制造完整标记行', output: 'note EXIT=3\n' + 'x'.repeat(249), expected: 'completed' },
      { label: '真实完整标记在展示尾部外仍有效', output: 'EXIT=3\n' + 'x'.repeat(300), expected: 'failed' },
      { label: '读取窗口不能制造完整标记行', output: 'note EXIT=3\n' + 'x'.repeat(4089), expected: 'completed', partialRead: true },
      { label: '读取窗口首个换行之后的完整标记仍有效', output: 'note noise\nEXIT=3\n' + 'x'.repeat(4083), expected: 'failed', partialRead: true },
    ]) {
      const jobs = createMockJobs()
      jobs.__seed('job-marker-boundary', {
        status: 'completed',
        chunks: [{ at: 0, text: item.output, channel }],
      })
      let observedOffset
      // 模拟真实 readAt 的窗口读取；ASCII fixture 的字符位置与字节位置一致。
      jobs.readAt = (_id, offset) => {
        observedOffset = offset
        return {
          chunks: [{ at: offset, text: item.output.slice(offset), channel }],
          next: item.output.length,
          lossy: offset > 0,
        }
      }
      const { result } = await runWaitUntil(createHarness({ jobs }), {
        conditions: [{ kind: 'job', id: 'job-marker-boundary' }],
        fail_fast: ['exit_code_nonzero'],
        output_tail_bytes: 256,
        timeout_sec: 1,
      })
      const label = '退出标记边界 ' + channel + '：' + item.label
      equal(result.status, item.expected, label)
      if (item.partialRead) check(observedOffset > 0, label + ' 应实际从输出中途读取')
    }
  }
}

async function testPermanentFileErrorsFailFast() {
  const codes = ['EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'EINVAL']
  for (const kind of ['file', 'log']) {
    for (const code of codes) {
      const fs = createMockFs()
      fs.__set('/tmp/permanent.log', 'waiting\n')
      let attempts = 0
      fs[kind === 'file' ? 'stat' : 'readByteRange'] = async () => {
        attempts += 1
        throw Object.assign(new Error('mock blocked operation: ' + code), { code })
      }
      const condition = kind === 'file'
        ? { kind, path: '/tmp/permanent.log' }
        : { kind, path: '/tmp/permanent.log', matches: 'READY' }
      const { result } = await runWaitUntil(createHarness({ fs }), {
        conditions: [condition],
        timeout_sec: 1,
        poll_interval_sec: 0.25,
        stall_after_sec: 0,
      })
      const label = '永久文件错误 ' + kind + '/' + code
      equal(result.status, 'failed', label + '：不应重试到 timeout')
      check(typeof result.failure_reason === 'string' && result.failure_reason.includes(code), label + '：应保留真实错误原因')
      equal(attempts, 1, label + '：永久错误只读取一次')
    }
  }
}

async function testFileErrorCodePrecedenceAndPrefixes() {
  for (const item of [
    { label: 'Error 标准前缀', error: new Error('EACCES: denied by mock storage') },
    { label: '字符串标准前缀', error: 'EPERM: denied by mock storage' },
    { label: '永久 code 优先于临时消息', error: Object.assign(new Error('ETIMEDOUT: misleading mock message'), { code: 'EACCES' }) },
  ]) {
    const fs = createMockFs()
    fs.stat = async () => { throw item.error }
    const { result } = await runWaitUntil(createHarness({ fs }), {
      conditions: [{ kind: 'file', path: '/tmp/blocked.txt' }],
      timeout_sec: 1,
      poll_interval_sec: 0.25,
      stall_after_sec: 0,
    })
    equal(result.status, 'failed', '错误分类：' + item.label)
    check(typeof result.failure_reason === 'string' && result.failure_reason.length > 0, '错误分类：' + item.label + ' 应保留原因')
  }

  for (const item of [
    { label: '临时 code 优先于永久消息前缀', error: Object.assign(new Error('EACCES: misleading mock message'), { code: 'ETIMEDOUT' }) },
    { label: '消息中部错误码不当作标准前缀', error: new Error('backend temporarily busy; EACCES is only an example') },
  ]) {
    const fs = createMockFs()
    fs.__set('/tmp/retry-ready.txt', 'ready')
    const originalStat = fs.stat.bind(fs)
    let attempts = 0
    fs.stat = async (...args) => {
      attempts += 1
      if (attempts === 1) throw item.error
      return originalStat(...args)
    }
    const { result } = await runWaitUntil(createHarness({ fs }), {
      conditions: [{ kind: 'file', path: '/tmp/retry-ready.txt' }],
      timeout_sec: 2,
      poll_interval_sec: 0.25,
      stall_after_sec: 0,
    })
    equal(result.status, 'completed', '错误分类：' + item.label + ' 应允许重试恢复')
    check(attempts >= 2, '错误分类：' + item.label + ' 应确实重试')
    equal(result.conditions[0].state, 'satisfied', '错误分类：恢复后不保留过期错误状态')
  }
}

async function testTemporaryFileErrorTimeoutKeepsDiagnostics() {
  const fs = createMockFs()
  let attempts = 0
  fs.stat = async () => {
    attempts += 1
    throw new Error('mock temporary backend busy')
  }
  const { result } = await runWaitUntil(createHarness({ fs }), {
    conditions: [{ kind: 'file', path: '/tmp/temporary.txt' }],
    timeout_sec: 1,
    poll_interval_sec: 0.25,
    stall_after_sec: 0,
  })
  equal(result.status, 'timeout', '持续临时错误：可以重试直到总超时')
  check(attempts >= 2, '持续临时错误：应允许重试')
  check(result.conditions[0].detail.includes('mock temporary backend busy'), '持续临时错误：timeout 快照应保留最后错误原因', result.conditions[0].detail)
  equal(result.suggested_timeout_sec, undefined, '持续临时错误：不能盲目建议加大 timeout')
  check(!/timeout_sec\s*:\s*\d+/.test(result.hint ?? ''), '持续临时错误：hint 不应直接给出更长等待调用', result.hint)
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

  const foregroundCases = [
    ['sleep 180', true],
    ['cd /tmp && sleep 90 && ls', true],
    ['sleep 3', false],
    ['sleep 19', false],
    ['sleep 20', true],
    ['sleep 90 &', false],
    ['sleep 1m && echo ok', true],
    ["printf '%s\\n' 'example; sleep 180'", false],
    ['echo "example; sleep 180"', false],
    ['sleep 90; echo done &', true],
    ['sleep 90 && echo done &', false],
    ['sleep 90 || echo done &', false],
    ['sleep 90 | cat &', false],
    ['sleep 90 | cat', true],
    ['sleep 90 |& cat', true],
    ['sleep 90 & echo done', false],
    ['echo done & sleep 90', true],
    ['sleep 90 &&\n echo done &', false],
    ['sleep 90 2>&1', true],
    ['2>/dev/null sleep 90', true],
    ['sleep 90 &>/dev/null', true],
    ['sleep 90 >out &', false],
    ['sleep 90 2>&1 &', false],
    ['printf x \\; sleep 90', false],
    ["'sleep' \"30\"", true],
    ['sl\\eep 30', true],
    ['sleep 20' + '\\' + '\n0', true],
    ['sleep "\\90"', false],
    ['# sleep 90\necho ok', false],
    ['echo x # ; sleep 90', false],
    ['sleep 2h', true],
    ['sleep .5', false],
    ['(sleep 90) &', false],
    ['{ sleep 90; }', false],
    ['echo $(sleep 90)', false],
    ['echo \u0060sleep 90\u0060', false],
    ["printf '%s' '$(sleep 90)'", false],
    ['cat <<EOF\nsleep 90\nEOF', false],
  ]
  // 只把字符串交给 guard；这里不会执行任何 shell 命令。
  for (const [command, blocked] of foregroundCases) {
    const decision = bash(command)
    equal(typeof decision, blocked ? 'string' : 'undefined', 'guard 词法：' + JSON.stringify(command))
    if (blocked) check(decision.includes('wait_until'), 'guard 拒绝应提供可执行替代：' + JSON.stringify(command))
  }

  const jobOutput = (wait, timeout_ms) => longWaitGuard({ name: 'job_output', arguments: { job_id: 'j', wait, timeout_ms } })
  check(typeof jobOutput(true, 1800000) === 'string', 'job_output 30 分钟等待应被拒绝')
  check(typeof jobOutput(true, 60000) === 'undefined', 'job_output 60 秒等待应放行')
  check(typeof jobOutput(false, 1800000) === 'undefined', 'job_output 非等待调用应放行')

  const waitAgent = (timeout_ms) => longWaitGuard({ name: 'wait_agent', arguments: { timeout_ms } })
  check(typeof waitAgent(1800000) === 'string', 'wait_agent 30 分钟等待应被拒绝')
  check(typeof waitAgent(30000) === 'undefined', 'wait_agent 默认 30 秒应放行')

  check(typeof longWaitGuard({ name: 'wait_until', arguments: {} }) === 'undefined', 'wait_until 自身不应被拦截')
}

async function testRendering() {
  const jobs = createMockJobs()
  jobs.__seed('job-render', { status: 'completed', detail: 'exit code: 0', chunks: [{ at: 0, text: 'ok\n', channel: 'stdout' }] })
  const harness = createHarness({ jobs })
  const { result } = await runWaitUntil(harness, {
    conditions: [{ kind: 'job', id: 'job-render' }],
    fail_fast: true,
    timeout_sec: 5,
    poll_interval_sec: 1,
  })
  const text = harness.tool.output.render({}, result)[0].text
  check(text.includes('[wait_until completed]'), '渲染应含状态行', text)
  // 短耗时只显示可读形式，不应渲染成「1ms（1ms）」这样的重复
  if (result.elapsed_ms < 1000) {
    check(!text.includes(`（${result.elapsed_ms}ms）`), '短耗时不应重复显示毫秒', text)
  } else {
    check(text.includes(`（${result.elapsed_ms}ms）`), '长耗时应附带毫秒', text)
  }
}

function testPromptPolicy() {
  const harness = createHarness({ jobs: createMockJobs() })
  equal(harness.sections.length, 1, '应注册一段系统提示词')
  const policy = harness.sections[0]
  check(policy.name === 'tool:wait-until', '提示词 section 名应为 tool:wait-until')
  check(policy.interpolate === false, '提示词应关闭插值')
  check(policy.text.includes('wait_until'), '提示词应提到 wait_until')
  check(policy.text.includes('sleep'), '提示词应提到 sleep')
  check(policy.text.includes('job_output 上反复轮询'), '提示词应禁止 job_output 轮询')
  check(policy.text.includes('suggested_timeout_sec'), '提示词应说明 timeout 建议值')
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
  testLogMatchPersistsUntilOtherConditionsComplete,
  testAgentChangesCanCompleteOnDifferentPolls,
  testFileExistsIsResampledAfterOtherEvents,
  testPendingIoBoundaries,
  testMixedPendingIoJobFailure,
  testMixedInitialJobFailurePrecedesCwd,
  testMixedPendingIoFailFastDisabled,
  testMixedPendingIoNonfailureEvents,
  testMixedPendingIoTerminalDecisionsStayFinal,
  testAgentFailFastModes,
  testExitMarkerEvidence,
  testExitMarkerWindowBoundaries,
  testPermanentFileErrorsFailFast,
  testFileErrorCodePrecedenceAndPrefixes,
  testTemporaryFileErrorTimeoutKeepsDiagnostics,
  testValidation,
  testMissingJobIsFatal,
  testCancelled,
  testTimeout,
  testDefaultJobStall,
  testStallDeadlinePrecedesPollInterval,
  testFileChangedFromMissingToPresent,
  testLogContentReplacements,
  testLogDeleteAndRecreate,
  testLogRewriteWhileCatchingUp,
  testLogPresenceChangesResetStall,
  testAgentStallSemantics,
  testStall,
  testGuards,
  testRendering,
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
