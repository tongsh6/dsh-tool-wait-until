/**
 * @module @local/dsh-tool-wait-until
 *
 * 「空等」消除插件：注册模型可见的 `wait_until` 工具。
 *
 * 设计要点：
 * - 事件驱动：订阅 `jobs.events`，后台作业 settle / 输出增长时立刻唤醒主循环，
 *   不依赖固定 sleep 轮询；文件、日志、队友条件在 poll_interval 上采样。
 * - 早期失败：作业非零退出、stderr/输出命中错误模式、队友 failed，在等待过程中
 *   就判定 failed，不必等条件满足，也不等到超时。
 * - 卡住检测：任一目标的进展信号（作业输出字节数、作业状态、队友状态、文件版本、
 *   日志大小）连续 stall_after_sec 秒没有变化，就返回 stalled，不等到 timeout。
 * - 统一结果：status / elapsed_ms / matched / failure_reason / output_tail，
 *   调用方凭一次返回即可决策，无需二次查询。
 * - 可取消：全程响应 exec.signal，调用方打断时立即返回 cancelled。
 *
 * 本插件保持零依赖：不 import 任何 @deepseek-ai 包（profile 的 node_modules 里
 * 并没有这些包，导入会解析失败），工具 schema 直接手写标准 JSON Schema。
 */

import { longestSleepSeconds } from './wait-guard.js'

export const name = 'tool-wait-until'

/** 激活所需的服务；fs / agentTeams 通过 ctx.get 可选访问。 */
export const inject = ['tools', 'jobs', 'workingDirectory']

// ---------------------------------------------------------------------------
// 参数默认值与边界
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_SEC = 60
const DEFAULT_JOB_TIMEOUT_SEC = 300
const MIN_TIMEOUT_SEC = 1
const MAX_TIMEOUT_SEC = 900

const DEFAULT_POLL_SEC = 2
const MIN_POLL_SEC = 0.25
const MAX_POLL_SEC = 30

const MIN_STALL_SEC = 5
/** 作业条件未显式指定 stall_after_sec 时的默认无进展阈值（秒）。显式传 0 可关闭。 */
const DEFAULT_JOB_STALL_SEC = 180

const DEFAULT_TAIL_BYTES = 4096
const MIN_TAIL_BYTES = 256
const MAX_TAIL_BYTES = 65536

/** 单次读取日志尾部的窗口上限。 */
const LOG_WINDOW_BYTES = 65536

const JOB_SETTLED = new Set(['completed', 'killed', 'failed'])
const AGENT_INACTIVE = new Set(['inactive', 'failed'])
const CONDITION_KINDS = new Set(['job', 'agent', 'file', 'log'])
const SIMPLE_FAIL_FAST = new Set(['job_failed', 'job_killed', 'exit_code_nonzero', 'agent_failed'])
const DEFAULT_FAIL_FAST = ['job_failed', 'job_killed', 'agent_failed']

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function formatElapsed(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.round((ms % 60000) / 1000)
  return `${minutes}m${seconds}s`
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 解析 `/pattern/flags` 或裸字符串形式的正则。
 * @param {string} spec - 正则表达式来源。
 * @param {string} label - 出错信息里指代该来源的名字。
 * @returns {RegExp} 编译后的正则。
 */
function parsePattern(spec, label) {
  if (typeof spec !== 'string' || spec.length === 0) throw new Error(`${label} 必须是非空正则表达式`)
  const wrapped = /^\/([\s\S]*)\/([a-z]*)$/.exec(spec)
  try {
    return wrapped === null ? new RegExp(spec) : new RegExp(wrapped[1], wrapped[2])
  } catch (error) {
    throw new Error(`${label} 不是合法正则：${spec}（${describeError(error)}）`)
  }
}

/** 重置 g/y 状态后测试一次，避免调用方传带 flag 的正则时出现 lastIndex 串扰。 */
function matchesRegex(regex, text) {
  regex.lastIndex = 0
  const matched = regex.test(text)
  regex.lastIndex = 0
  return matched
}

/** 按字节上限保留文本尾部，并在 UTF-8 字符边界上裁剪。 */
function truncateTail(text, maxBytes) {
  if (text.length === 0) return text
  const bytes = encoder.encode(text)
  if (bytes.byteLength <= maxBytes) return text
  return decoder.decode(bytes.subarray(bytes.byteLength - maxBytes)).replace(/^\uFFFD+/, '')
}

/** 把 job 环形缓冲里的 chunk 渲染成可读正文（stderr 单独分段）。 */
function renderChunks(chunks) {
  const visible = chunks.filter((chunk) => chunk.channel !== 'log')
  const out = visible.filter((chunk) => chunk.channel !== 'stderr').map((chunk) => chunk.text).join('')
  const err = visible.filter((chunk) => chunk.channel === 'stderr').map((chunk) => chunk.text).join('')
  if (err.length === 0) return out
  return `${out}${out.length > 0 && !out.endsWith('\n') ? '\n' : ''}[stderr]\n${err}`
}

/**
 * 单个待唤醒槽：事件到达时唤醒当前等待者；没有等待者时记一次「已触发」，
 * 让紧随其后的等待立即返回，避免事件落在等待与检查的缝隙里被丢掉。
 * @returns {{ setPending: (fn: () => void) => void, clearPending: () => void, wake: () => void }}
 */
function createWake() {
  let pending
  let fired = false
  return {
    setPending(fn) {
      if (fired) {
        fired = false
        fn()
        return
      }
      pending = fn
    },
    clearPending() {
      pending = undefined
    },
    wake() {
      const fn = pending
      if (fn === undefined) {
        fired = true
        return
      }
      pending = undefined
      fn()
    },
  }
}

/** 固定时长、事件唤醒、调用方取消三者任一即返回。 */
function waitForSignal(durationMs, wake, signal) {
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      wake.clearPending()
      resolve()
    }
    const onAbort = () => finish()
    timer = setTimeout(finish, durationMs)
    if (signal.aborted) {
      finish()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    wake.setPending(finish)
  })
}

const WAIT_CANCELLED = Symbol('wait_cancelled')
const WAIT_TIMEOUT = Symbol('wait_timeout')
const WAIT_JOB_FAILED = Symbol('wait_job_failed')

/**
 * 异步观察受取消、总截止时间和已确认的作业失败共同约束。
 * 底层 I/O 未必可取消；晚到结果/拒绝会被接收，但不再改变已经返回的判定。
 */
function waitWithinBudget(operation, signal, deadline, failureSignal) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer
    const finish = (value, failed = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      failureSignal?.removeEventListener('abort', onFailure)
      if (failed) reject(value)
      else resolve(value)
    }
    const interruption = () => {
      if (signal.aborted) return WAIT_CANCELLED
      if (Date.now() >= deadline) return WAIT_TIMEOUT
      if (failureSignal?.aborted) return WAIT_JOB_FAILED
      return undefined
    }
    const onAbort = () => finish(WAIT_CANCELLED)
    const onFailure = () => finish(interruption() ?? WAIT_JOB_FAILED)
    const initial = interruption()
    if (initial !== undefined) {
      finish(initial)
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    failureSignal?.addEventListener('abort', onFailure, { once: true })
    timer = setTimeout(() => finish(signal.aborted ? WAIT_CANCELLED : WAIT_TIMEOUT), Math.max(0, deadline - Date.now()))
    Promise.resolve().then(() => {
      const stopped = interruption()
      if (settled || stopped !== undefined) {
        if (stopped !== undefined) finish(stopped)
        return undefined
      }
      return operation()
    }).then((value) => {
      finish(interruption() ?? value)
    }, (error) => {
      const stopped = interruption()
      if (stopped !== undefined) finish(stopped)
      else finish(error, true)
    })
  })
}

/** 读取会话工作目录；没有 workingDirectory 或调用方不是 Agent 时回落到 undefined。 */
async function resolveCwd(ctx, exec) {
  const directory = ctx.get('workingDirectory')
  if (directory === undefined || exec.agent === undefined) return undefined
  try {
    return await directory.ensure(exec.agent)
  } catch {
    return undefined
  }
}

function resolveOptions(cwd) {
  return cwd === undefined ? {} : { cwd }
}

// ---------------------------------------------------------------------------
// 入参归一化
// ---------------------------------------------------------------------------

/**
 * 校验并归一化 conditions。
 * @param {unknown} input - 模型传入的 conditions。
 * @returns {Array<object>} 归一化后的条件数组（保持传入顺序）。
 */
function normalizeConditions(input) {
  if (!Array.isArray(input) || input.length === 0) throw new Error('conditions 必须是非空数组')
  return input.map((raw, index) => {
    const label = `conditions[${index}]`
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} 必须是对象`)
    const kind = raw.kind
    if (typeof kind !== 'string' || !CONDITION_KINDS.has(kind)) {
      throw new Error(`${label}.kind 必须是 job / agent / file / log 之一`)
    }
    if (kind === 'job') {
      if (typeof raw.id !== 'string' || raw.id.length === 0) throw new Error(`${label}（job）必须提供非空 id`)
      const until = raw.until ?? 'settled'
      if (until !== 'settled' && until !== 'failed') throw new Error(`${label}.until 对 job 只能是 settled / failed`)
      return { kind, label, id: raw.id, until }
    }
    if (kind === 'agent') {
      const until = raw.until ?? 'inactive'
      if (until !== 'inactive' && until !== 'failed' && until !== 'status_changed') {
        throw new Error(`${label}.until 对 agent 只能是 inactive / failed / status_changed`)
      }
      if (raw.target !== undefined && (typeof raw.target !== 'string' || raw.target.length === 0)) {
        throw new Error(`${label}.target 必须是非空字符串`)
      }
      return { kind, label, target: raw.target, until }
    }
    if (typeof raw.path !== 'string' || raw.path.length === 0) throw new Error(`${label}（${kind}）必须提供非空 path`)
    if (kind === 'file') {
      const until = raw.until ?? 'exists'
      if (until !== 'exists' && until !== 'changed') throw new Error(`${label}.until 对 file 只能是 exists / changed`)
      return { kind, label, path: raw.path, until }
    }
    const until = raw.until ?? 'matches'
    if (until !== 'matches') throw new Error(`${label}.until 对 log 只能是 matches`)
    if (typeof raw.matches !== 'string' || raw.matches.length === 0) {
      throw new Error(`${label}（log）必须提供非空 matches 正则`)
    }
    return { kind, label, path: raw.path, until, matches: raw.matches, regex: parsePattern(raw.matches, `${label}.matches`) }
  })
}

/**
 * 归一化 fail_fast 配置。
 * @param {unknown} value - true / false / 模式字符串数组 / 省略。
 * @returns {{ enabled: boolean, simple: Set<string>, textRules: Array<object> }}
 */
function normalizeFailFast(value) {
  if (value === false) return { enabled: false, simple: new Set(), textRules: [] }
  const entries = value === undefined || value === true ? DEFAULT_FAIL_FAST : value
  if (!Array.isArray(entries)) throw new Error('fail_fast 必须是布尔值或字符串数组')
  const simple = new Set()
  const textRules = []
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length === 0) throw new Error('fail_fast 的每一项必须是非空字符串')
    const wrapped = /^(stderr_matches|output_matches):([\s\S]+)$/.exec(entry)
    if (wrapped !== null) {
      textRules.push({
        channel: wrapped[1] === 'stderr_matches' ? 'stderr' : 'output',
        label: entry,
        regex: parsePattern(wrapped[2], entry),
      })
      continue
    }
    if (!SIMPLE_FAIL_FAST.has(entry)) {
      throw new Error(`未知的 fail_fast 模式：${entry}。支持 job_failed / job_killed / exit_code_nonzero / agent_failed / stderr_matches:/re/ / output_matches:/re/`)
    }
    simple.add(entry)
  }
  return { enabled: simple.size > 0 || textRules.length > 0, simple, textRules }
}

// ---------------------------------------------------------------------------
// 条件探针
// ---------------------------------------------------------------------------

/** 展示尾部的裁剪不能制造 EXIT 标记；未知的读取起点先跳过首个不完整行。 */
function nonzeroExitMarker(text, startsAtLineBoundary) {
  if (!startsAtLineBoundary) {
    const newline = text.indexOf('\n')
    if (newline < 0) return undefined
    text = text.slice(newline + 1)
  }
  for (const match of text.matchAll(/^[ \t]*EXIT=(-?\d+)[ \t]*\r?$/gm)) {
    const code = Number(match[1])
    if (code !== 0) return code
  }
  return undefined
}

/**
 * 读取作业输出尾部的三份视图：完整正文、stdout 部分、stderr 部分。
 * 用 readAt 读取，不移动模型在 job_output 上的消费游标。
 */
function readJobWindow(ctx, id, caller, maxBytes) {
  try {
    const job = ctx.jobs.get(id, caller)
    const total = job.output.total
    const from = Math.max(0, total - Math.max(maxBytes * 2, 4096))
    const read = ctx.jobs.readAt(id, from, caller)
    const visible = read.chunks.filter((chunk) => chunk.channel !== 'log')
    const output = visible.filter((chunk) => chunk.channel !== 'stderr').map((chunk) => chunk.text).join('')
    const stderr = visible.filter((chunk) => chunk.channel === 'stderr').map((chunk) => chunk.text).join('')
    const startsAtLineBoundary = from === 0 && (job.output.earliest ?? 0) === 0 && read.lossy !== true
    const exitCodeHint = nonzeroExitMarker(output, startsAtLineBoundary) ?? nonzeroExitMarker(stderr, startsAtLineBoundary)
    return {
      exitCodeHint,
      text: truncateTail(renderChunks(read.chunks), maxBytes),
      output: truncateTail(output, maxBytes),
      stderr: truncateTail(stderr, maxBytes),
    }
  } catch {
    return { text: '', output: '', stderr: '' }
  }
}

/** 作业条件：poll 提交进展，peek 只观察；两者复用相同的失败判定。 */
function createJobProbe(ctx, condition, caller, failFast, tailBytes) {
  let lastTotal = -1
  let lastStatus
  let lastWindow = { text: '', output: '', stderr: '' }
  const observe = (commitProgress) => {
    let job
    try {
      job = ctx.jobs.get(condition.id, caller)
    } catch (error) {
      return { fatal: `无法读取后台作业 ${condition.id}：${describeError(error)}` }
    }
    const total = job.output.total
    const progressed = total !== lastTotal || job.status !== lastStatus
    const window = progressed ? readJobWindow(ctx, condition.id, caller, tailBytes) : lastWindow
    if (commitProgress) {
      lastTotal = total
      lastStatus = job.status
      lastWindow = window
    }

    const status = job.status
    const detailText = job.detail ?? ''
    // 平台把「进程正常退出但退出码非零」记成 completed + detail: "exit code: N"，
    // 只有被 kill 或启动失败才是 killed/failed。所以非零退出码必须自己识别，
    // 否则用户抱怨的「脚本报错退出」会伪装成成功。
    const exitMatch = /exit code:\s*(-?\d+)/i.exec(detailText)
    const exitCode = exitMatch === null ? undefined : Number(exitMatch[1])
    const failedExit = exitCode !== undefined && exitCode !== 0
    const failed = status === 'failed' || failedExit
    const killed = status === 'killed'
    const settled = JOB_SETTLED.has(status)
    const detail = `状态 ${status}${job.detail === undefined ? '' : ` — ${job.detail}`}`
    const satisfied = condition.until === 'failed' ? failed : settled

    let fail
    if (failFast.enabled) {
      if (failed && failFast.simple.has('job_failed')) {
        fail = {
          reason: failedExit
            ? `后台作业 ${job.id} 失败：退出码 ${exitCode}`
            : `后台作业 ${job.id} 失败：${job.detail ?? '无 detail'}`,
          tail: window.text,
        }
      } else if (killed && failFast.simple.has('job_killed')) {
        fail = { reason: `后台作业 ${job.id} 被终止：${job.detail ?? '无 detail'}`, tail: window.text }
      } else if (failFast.simple.has('exit_code_nonzero')) {
        if (failedExit) {
          fail = { reason: `后台作业 ${job.id} 退出码 ${exitCode}（非零退出）`, tail: window.text }
        } else if (exitCode === undefined) {
          // 日志标记是显式启用的推断；宿主退出码优先，只认完整标记行。
          const exit = window.exitCodeHint
          if (exit !== undefined) {
            fail = { reason: `后台作业 ${job.id} 输出 EXIT=${exit}（非零退出）`, tail: window.text }
          }
        }
      }
      if (fail === undefined) {
        for (const rule of failFast.textRules) {
          const haystack = rule.channel === 'stderr' ? window.stderr : window.output
          if (matchesRegex(rule.regex, haystack)) {
            fail = { reason: `后台作业 ${job.id} 的${rule.channel === 'stderr' ? ' stderr' : '输出'}命中失败模式 ${rule.label}`, tail: window.text }
            break
          }
        }
      }
    }
    return { satisfied, progress: progressed, detail, tail: window.text, fail }
  }
  return {
    label: condition.label,
    describe: () => `后台作业 ${condition.id}（${condition.until === 'failed' ? '失败' : '结束'}）`,
    poll: () => observe(true),
    peek: () => observe(false),
  }
}

/** 队友条件：等待成员变为 inactive / failed，或出现状态变化。 */
function createAgentProbe(ctx, condition, callerAgent, failFast) {
  const teams = ctx.get('agentTeams')
  const describe = () => `队友 ${condition.target ?? '（任意成员）'}（${
    condition.until === 'failed' ? '失败' : condition.until === 'status_changed' ? '状态变化' : '空闲'
  }）`
  if (teams === undefined || callerAgent === undefined) {
    return {
      label: condition.label,
      describe,
      async poll() {
        return { unsupported: '当前运行环境没有 Agent Teams 服务，agent 条件无法评估（请改用其它条件）' }
      },
    }
  }
  let lastSignature
  let changed = false
  return {
    label: condition.label,
    describe,
    async poll() {
      let members
      try {
        members = teams.listMembers(callerAgent)
      } catch (error) {
        return { fatal: `无法读取团队成员：${describeError(error)}` }
      }
      const peers = members.filter((member) => member.id !== callerAgent.id)
      const watched = condition.target === undefined ? peers : peers.filter((member) => member.name === condition.target)
      if (watched.length === 0) {
        return { fatal: `团队中没有名为 ${String(condition.target)} 的成员` }
      }
      const signature = watched.map((member) => `${member.name}:${member.status}:${member.diagnostics.length}`).join('|')
      const progressed = lastSignature !== undefined && signature !== lastSignature
      lastSignature = signature
      changed ||= progressed
      const detail = watched
        .map((member) => `${member.name}=${member.status}${member.diagnostics.length === 0 ? '' : `（diagnostics: ${member.diagnostics.join('; ')}）`}`)
        .join(', ')
      const failedMember = watched.find((member) => member.status === 'failed')
      const anyFailed = failedMember !== undefined
      let satisfied
      if (condition.until === 'failed') satisfied = anyFailed
      else if (condition.until === 'status_changed') satisfied = changed
      else satisfied = watched.every((member) => AGENT_INACTIVE.has(member.status))
      const fail = anyFailed && failFast.simple.has('agent_failed')
        ? { reason: `队友 ${failedMember.name} 失败：${failedMember.diagnostics.join('; ') || '无 diagnostics'}`, tail: detail }
        : undefined
      return { satisfied, progress: progressed, detail, fail }
    },
  }
}

/** 权限/无效路径不能靠继续等待恢复；其它读取错误保留证据后允许再次观察。 */
function readObservationError(prefix, error) {
  const message = describeError(error)
  const detail = prefix + '：' + message
  const code = typeof error?.code === 'string'
    ? error.code
    : /^(EACCES|EPERM|ENOTDIR|EISDIR|EINVAL)\b/.exec(message)?.[1]
  return ['EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'EINVAL'].includes(code)
    ? { fatal: detail }
    : { error: detail }
}

/** 文件条件：等待出现或版本变化。 */
function createFileProbe(ctx, condition, cwd) {
  const fs = ctx.get('fs')
  const describe = () => `文件 ${condition.path}（${condition.until === 'exists' ? '出现' : '变化'}）`
  if (fs === undefined) {
    return {
      label: condition.label,
      describe,
      async poll() {
        return { unsupported: '当前运行环境没有 fs 服务，file 条件无法评估' }
      },
    }
  }
  let target
  let baselineVersion
  let lastVersion
  let initialized = false
  return {
    label: condition.label,
    describe,
    async poll() {
      if (target === undefined) {
        try {
          target = await fs.resolve(condition.path, resolveOptions(cwd))
        } catch (error) {
          return { fatal: `无法解析路径 ${condition.path}：${describeError(error)}` }
        }
      }
      let info
      try {
        info = await fs.stat(target)
      } catch (error) {
        return readObservationError('读取 ' + condition.path + ' 的状态失败', error)
      }
      const exists = info !== undefined
      const version = exists ? String(info.version) : undefined
      const progressed = initialized && version !== lastVersion
      lastVersion = version
      if (!initialized) {
        initialized = true
        baselineVersion = version
      }
      const detail = exists ? `文件存在（${info.size === undefined ? '大小未知' : `${info.size} 字节`}）` : '文件不存在'
      let satisfied
      if (condition.until === 'exists') satisfied = exists
      else satisfied = exists && version !== baselineVersion
      return { satisfied, progress: progressed, detail }
    },
  }
}

/** 日志条件：等待文件内容命中正则。 */
function createLogProbe(ctx, condition, cwd) {
  const fs = ctx.get('fs')
  const describe = () => `日志 ${condition.path} 匹配 ${condition.matches}`
  if (fs === undefined) {
    return {
      label: condition.label,
      describe,
      async poll() {
        return { unsupported: '当前运行环境没有 fs 服务，log 条件无法评估' }
      },
    }
  }
  let target
  let readOffset
  let lastObservedVersion
  let lastObservedSize
  let recentText = ''
  let matched = false
  return {
    label: condition.label,
    describe,
    async poll() {
      // matches 是本次等待中已经发生的事件，不要求与其它条件同轮命中。
      if (matched) return { satisfied: true, progress: false, detail: '日志已命中', tail: truncateTail(recentText, DEFAULT_TAIL_BYTES) }
      if (target === undefined) {
        try {
          target = await fs.resolve(condition.path, resolveOptions(cwd))
        } catch (error) {
          return { fatal: `无法解析日志路径 ${condition.path}：${describeError(error)}` }
        }
      }
      let info
      try {
        info = await fs.stat(target)
      } catch (error) {
        return readObservationError('读取日志 ' + condition.path + ' 的状态失败', error)
      }
      if (info === undefined) {
        const disappeared = lastObservedSize !== undefined
        readOffset = undefined
        lastObservedVersion = undefined
        lastObservedSize = undefined
        recentText = ''
        return { satisfied: false, progress: disappeared, detail: '日志文件还不存在' }
      }
      const size = info.size ?? 0
      const version = info.version === undefined ? undefined : String(info.version)
      const versionChanged = lastObservedVersion !== undefined && version !== undefined && version !== lastObservedVersion
      // 观察尺寸与已读游标不同：大段追加尚未读完时，也要识别覆盖/截断。
      const reset = readOffset === undefined || size < readOffset ||
        (lastObservedSize !== undefined && size < lastObservedSize) ||
        (versionChanged && lastObservedSize !== undefined && size <= lastObservedSize)
      const resetProgress = readOffset === undefined ||
        (lastObservedSize !== undefined && (versionChanged || size !== lastObservedSize))
      const rememberObservation = () => {
        lastObservedVersion = version
        lastObservedSize = size
      }
      // 首轮、缩小或可识别的覆盖重读尾部；普通追加仍按窗口增量读取。
      if (reset) {
        const from = Math.max(0, size - LOG_WINDOW_BYTES)
        let bytes
        try {
          bytes = await fs.readByteRange(target, { offset: from, length: size - from })
        } catch (error) {
          return readObservationError('读取日志 ' + condition.path + ' 失败', error)
        }
        recentText = decoder.decode(bytes)
        readOffset = size
        rememberObservation()
        matched = matchesRegex(condition.regex, recentText)
        return {
          satisfied: matched,
          progress: resetProgress,
          detail: `日志 ${size} 字节${matched ? '，命中' : '，未命中'}`,
          tail: truncateTail(recentText, DEFAULT_TAIL_BYTES),
        }
      }
      if (size === readOffset) {
        rememberObservation()
        return { satisfied: false, progress: false, detail: `日志无新增（${size} 字节）`, tail: truncateTail(recentText, DEFAULT_TAIL_BYTES) }
      }
      let bytes
      try {
        bytes = await fs.readByteRange(target, { offset: readOffset, length: Math.min(size - readOffset, LOG_WINDOW_BYTES) })
      } catch (error) {
        return readObservationError('读取日志 ' + condition.path + ' 新增内容失败', error)
      }
      const grew = bytes.byteLength
      readOffset += grew
      rememberObservation()
      recentText = truncateTail(`${recentText}${decoder.decode(bytes)}`, LOG_WINDOW_BYTES)
      matched = matchesRegex(condition.regex, recentText)
      return {
        satisfied: matched,
        progress: grew > 0,
        detail: `日志新增 ${grew} 字节${matched ? '，命中' : ''}`,
        tail: truncateTail(recentText, DEFAULT_TAIL_BYTES),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 结果构造
// ---------------------------------------------------------------------------

const STATUS_HINTS = {
  completed: undefined,
  failed: '等待因目标失败或观察错误结束：按 conditions / failure_reason / output_tail 排查（需要完整作业日志时用 job_output 读取）。',
  stalled: '整组目标在该窗口内未观察到进展信号；这不代表进程已卡死。检查状态与日志，或按任务特性调整 stall_after_sec。',
  timeout: '本次是超时，不是失败：条件在 timeout_sec 内仍未满足。可增大 timeout_sec 再次 wait_until，或先检查目标与日志。',
  cancelled: '等待已被调用方取消；本工具没有停止目标或底层 I/O。',
}

/**
 * 组装最终结构化结果。
 * @param {string} status - completed / failed / stalled / timeout / cancelled。
 * @param {number} startedAt - 起始时间戳（毫秒）。
 * @param {object} input - { matched, rows, failureReason, stalledForSec, tail, hint, tailBytes }。
 * @returns {object} 符合 output.schema 的值。
 */
function buildResult(status, startedAt, input) {
  const elapsedMs = Date.now() - startedAt
  const value = {
    status,
    elapsed_ms: elapsedMs,
    elapsed: formatElapsed(elapsedMs),
    matched: input.matched ?? [],
    conditions: input.rows ?? [],
  }
  if (input.failureReason !== undefined) value.failure_reason = truncateTail(input.failureReason, 8192)
  if (input.stalledForSec !== undefined) value.stalled_for_sec = input.stalledForSec
  if (input.suggestedTimeoutSec !== undefined) value.suggested_timeout_sec = input.suggestedTimeoutSec
  if (input.tail !== undefined && input.tail !== '') value.output_tail = truncateTail(input.tail, input.tailBytes ?? DEFAULT_TAIL_BYTES)
  const timeoutHint = input.suggestedTimeoutSec !== undefined
    ? `本次是超时，不是失败：本次已等待约 ${Math.round(elapsedMs / 1000)} 秒，条件仍未满足。建议直接以 timeout_sec: ${input.suggestedTimeoutSec} 再试一次（不要小步递增）；若是长任务也可先检查目标与日志。`
    : undefined
  const hint = input.hint ?? timeoutHint ?? STATUS_HINTS[status]
  if (hint !== undefined) value.hint = hint
  return value
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

/**
 * 执行一次 wait_until：条件驱动返回，带早期失败、卡住检测与统一结果。
 * @param {object} ctx - 插件上下文。
 * @param {object} args - 模型传入的参数。
 * @param {object} exec - 工具执行上下文（提供 agent 与 signal）。
 * @returns {Promise<object>} 结构化结果。
 */
async function runWaitUntil(ctx, args, exec) {
  const startedAt = Date.now()
  const conditions = normalizeConditions(args.conditions)
  const failFast = normalizeFailFast(args.fail_fast)
  const hasJobCondition = conditions.some((condition) => condition.kind === 'job')
  const defaultTimeout = hasJobCondition ? DEFAULT_JOB_TIMEOUT_SEC : DEFAULT_TIMEOUT_SEC
  const timeoutMs = clamp(numberOr(args.timeout_sec, defaultTimeout), MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC) * 1000
  const pollMs = clamp(numberOr(args.poll_interval_sec, DEFAULT_POLL_SEC), MIN_POLL_SEC, MAX_POLL_SEC) * 1000
  // 作业条件默认启用 stall：目标没有新输出/状态变化超过窗口就提前返回，
  // 避免模型靠「小 timeout + 反复重试」试探。显式传 stall_after_sec: 0 可关闭。
  const stallSpecified = args.stall_after_sec !== undefined && args.stall_after_sec !== null
  const stallRaw = stallSpecified ? numberOr(args.stall_after_sec, 0) : hasJobCondition ? DEFAULT_JOB_STALL_SEC : 0
  const stallMs = stallRaw <= 0 ? 0 : Math.max(stallRaw, MIN_STALL_SEC) * 1000
  const tailBytes = clamp(numberOr(args.output_tail_bytes, DEFAULT_TAIL_BYTES), MIN_TAIL_BYTES, MAX_TAIL_BYTES)

  const deadline = startedAt + timeoutMs
  let rows = conditions.map((condition) => ({ condition: condition.label, state: 'pending', detail: '等待解析工作目录' }))
  let latestTail = ''
  const finish = (status, extra = {}) => buildResult(status, startedAt, {
    rows: rows.map((row) => ({ condition: row.condition, state: row.state, detail: row.detail })),
    matched: rows.filter((row) => row.state === 'satisfied').map((row) => row.condition),
    tail: latestTail,
    tailBytes,
    ...extra,
  })
  const timedOut = () => {
    if (rows.some((row) => row.state === 'error')) {
      return finish('timeout', { hint: '等待超时且部分目标读取失败：先查看 conditions.detail 中的错误并检查路径、权限或服务，再决定是否重新等待。' })
    }
    const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
    return finish('timeout', { suggestedTimeoutSec: Math.min(MAX_TIMEOUT_SEC, Math.max(120, elapsedSec * 2)) })
  }

  const caller = exec.agent?.id
  const callerAgent = exec.agent
  const jobProbes = new Map()
  conditions.forEach((condition, index) => {
    if (condition.kind === 'job') jobProbes.set(index, createJobProbe(ctx, condition, caller, failFast, tailBytes))
  })
  const wake = createWake()
  const disposers = []
  const failureController = new AbortController()
  let observedJobFailure
  let closed = false
  const watchesJobFailures = failFast.textRules.length > 0 ||
    ['job_failed', 'job_killed', 'exit_code_nonzero'].some((mode) => failFast.simple.has(mode))

  const finishJobFailure = () => {
    if (exec.signal.aborted) return finish('cancelled')
    if (Date.now() >= deadline) return timedOut()
    const { index, probe, state } = observedJobFailure
    const condition = probe.describe()
    rows[index] = { condition, state: state.fatal === undefined ? 'failed' : 'error', detail: state.fatal ?? state.detail }
    const matched = rows
      .filter((row, rowIndex) => row.state === 'satisfied' || (rowIndex === index && state.satisfied === true))
      .map((row) => row.condition)
    return finish('failed', {
      failureReason: state.fatal ?? state.fail.reason,
      tail: state.fail?.tail ?? state.tail ?? latestTail,
      matched,
    })
  }

  // 作业观察是同步服务读取，不受其它 probe 的异步 I/O 阻塞。
  // peek 不提交进展，避免事件检查抢先消耗主循环的 stall 信号。
  const checkJobFailures = () => {
    if (!watchesJobFailures || closed || observedJobFailure !== undefined ||
        exec.signal.aborted || Date.now() >= deadline) return
    for (const [index, probe] of jobProbes) {
      let state
      try {
        state = probe.peek()
      } catch (error) {
        state = { fatal: probe.describe() + '：' + describeError(error) }
      }
      if (state.fail === undefined && state.fatal === undefined) continue
      observedJobFailure = { index, probe, state }
      failureController.abort()
      wake.wake()
      return
    }
  }

  try {
    if (hasJobCondition) {
      const filter = caller === undefined ? { owners: 'all' } : { owner: caller }
      disposers.push(ctx.jobs.events.subscribe(filter, () => {
        checkJobFailures()
        wake.wake()
      }))
      // 订阅后立即检查，覆盖在调用之前或订阅建立前已失败的作业。
      checkJobFailures()
      if (watchesJobFailures && observedJobFailure === undefined) {
        const timer = setInterval(checkJobFailures, pollMs)
        disposers.push(() => clearInterval(timer))
      }
    }

    const cwd = await waitWithinBudget(() => resolveCwd(ctx, exec), exec.signal, deadline, failureController.signal)
    if (cwd === WAIT_CANCELLED) return finish('cancelled')
    if (cwd === WAIT_TIMEOUT) return timedOut()
    if (cwd === WAIT_JOB_FAILED) return finishJobFailure()

    const probes = conditions.map((condition, index) => {
      switch (condition.kind) {
        case 'job': return jobProbes.get(index)
        case 'agent': return createAgentProbe(ctx, condition, callerAgent, failFast)
        case 'file': return createFileProbe(ctx, condition, cwd)
        case 'log': return createLogProbe(ctx, condition, cwd)
        default: throw new Error('未知的条件类型：' + String(condition.kind))
      }
    })
    rows = probes.map((probe) => ({ condition: probe.describe(), state: 'pending', detail: '尚未检查' }))

    let lastProgressAt = Date.now()
    for (;;) {
      if (exec.signal.aborted) return finish('cancelled')
      if (Date.now() >= deadline) return timedOut()
      if (observedJobFailure !== undefined) return finishJobFailure()
      let progressed = false
      let allSatisfied = true
      const matched = []
      let failure
      let fatal

      for (let index = 0; index < probes.length; index += 1) {
        const probe = probes[index]
        let state
        try {
          state = await waitWithinBudget(() => probe.poll(), exec.signal, deadline, failureController.signal)
        } catch (error) {
          state = { fatal: probe.describe() + '：' + describeError(error) }
        }
        if (state === WAIT_CANCELLED) return finish('cancelled')
        if (state === WAIT_TIMEOUT) return timedOut()
        if (state === WAIT_JOB_FAILED) return finishJobFailure()
        const row = rows[index]
        if (typeof state?.detail === 'string') row.detail = state.detail
        if (typeof state?.tail === 'string' && state.tail.length > 0) latestTail = state.tail
        if (state?.fatal !== undefined) {
          row.state = 'error'
          row.detail = state.fatal
          fatal = state.fatal
          break
        }
        if (state?.unsupported !== undefined) {
          row.state = 'unsupported'
          row.detail = state.unsupported
          fatal = state.unsupported
          break
        }
        if (state?.error !== undefined) {
          row.state = 'error'
          row.detail = state.error
          allSatisfied = false
          continue
        }
        if (state?.progress === true) progressed = true
        if (state?.satisfied === true) {
          row.state = 'satisfied'
          matched.push(probe.describe())
        } else {
          row.state = 'pending'
          allSatisfied = false
        }
        if (state?.fail !== undefined && failFast.enabled) {
          row.state = 'failed'
          failure = state.fail
          break
        }
      }

      const now = Date.now()
      if (exec.signal.aborted) return finish('cancelled')
      if (now >= deadline) return timedOut()
      if (observedJobFailure !== undefined) return finishJobFailure()
      if (fatal !== undefined) return finish('failed', { failureReason: fatal, matched })
      if (failure !== undefined) return finish('failed', { failureReason: failure.reason, tail: failure.tail ?? latestTail, matched })
      if (allSatisfied && matched.length === probes.length) return finish('completed', { matched })
      if (progressed) lastProgressAt = now

      if (stallMs > 0 && now - lastProgressAt >= stallMs) {
        const stalledForSec = Math.round((now - lastProgressAt) / 1000)
        const pendingKinds = conditions
          .map((condition, index) => ({ kind: condition.kind, state: rows[index].state }))
          .filter((row) => row.state === 'pending')
          .map((row) => row.kind)
        const onlyAgent = pendingKinds.length > 0 && pendingKinds.every((kind) => kind === 'agent')
        const hint = onlyAgent
          ? `本次等待连续 ${stalledForSec} 秒未观察到整组目标的新进展，剩余条件均为队友条件；状态不变可能是长任务，并不证明卡死。可检查日志/任务进度，或调整 stall_after_sec / timeout_sec 继续等待。`
          : `本次等待连续 ${stalledForSec} 秒未观察到整组目标的新进展（作业输出/状态、队友状态、文件或日志变化）；这不证明进程卡死。检查状态与日志，或按任务特性调整 stall_after_sec。`
        return finish('stalled', { stalledForSec, tail: latestTail, matched, hint })
      }
      const untilStall = stallMs > 0 ? Math.max(0, lastProgressAt + stallMs - now) : Infinity
      await waitForSignal(Math.min(pollMs, deadline - now, untilStall), wake, exec.signal)
    }
  } finally {
    closed = true
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 清理监听器失败不影响已经产出的结果。
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 工具定义（标准 JSON Schema，零依赖）
// ---------------------------------------------------------------------------

const CONDITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string',
      enum: ['job', 'agent', 'file', 'log'],
      description: '条件类型。job=后台作业；agent=团队成员；file=文件；log=日志文件正则匹配。',
    },
    id: { type: 'string', description: 'kind=job：job_output/job_list 返回的作业 id。' },
    target: { type: 'string', description: 'kind=agent：成员名字（spawn_teammate/list_agents 的名字）；省略表示该会话中任意其他成员。' },
    path: { type: 'string', description: 'kind=file/log：文件路径，相对路径按会话工作目录解析。' },
    until: {
      type: 'string',
      description: '完成条件。job：settled（默认，结束即可，含失败）/ failed（仅失败），fail_fast 命中时优先返回 failed；agent：inactive（默认，全部空闲）/ failed（失败）/ status_changed（观察到任意状态变化，本次调用内保留）；file：exists（默认，当前存在）/ changed（当前存在且版本不同于首次观察，初始缺失后出现也算）；log：matches（默认，必须配 matches，命中事件在本次调用内保留）。',
    },
    matches: { type: 'string', description: 'kind=log：正则表达式，支持 /pattern/flags 或裸正则；匹配日志新增内容或尾部窗口。' },
  },
  required: ['kind'],
}

const WAIT_UNTIL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    conditions: {
      type: 'array',
      description: '要等待的条件，全部满足才返回 completed（wait_all 语义）。log.matches 和 agent.status_changed 保留本次调用内已观察到的事件；file.exists 等状态条件仍反映当前观察。fail_fast 命中时优先返回 failed。',
      items: CONDITION_SCHEMA,
    },
    fail_fast: {
      oneOf: [
        { type: 'boolean' },
        { type: 'array', items: { type: 'string' } },
      ],
      description: '早期失败检测。true（默认）= job_failed + job_killed + agent_failed；false 或 [] 关闭；模式数组只启用列出的项：job_failed / job_killed / exit_code_nonzero / agent_failed / stderr_matches:/error|failed|Traceback/ / output_matches:/EXIT=[1-9]/。job_failed 使用真实作业状态/退出码，不推断输出文本；exit_code_nonzero 优先使用真实退出码，仅在缺失时识别完整行 EXIT=N 的非零标记。观察错误另行报告。',
    },
    stall_after_sec: {
      type: 'number',
      description: `整组无进展判定：任一目标的进展信号会重置整组计时；连续这么多秒未观察到作业输出/状态、队友状态、文件版本或日志变化就返回 stalled，不据此认定进程卡死。未显式指定时：含 job 条件默认 ${DEFAULT_JOB_STALL_SEC} 秒，其它调用关闭；显式传 0 关闭。`,
    },
    timeout_sec: {
      type: 'number',
      description: `总兜底超时：含 job 条件默认 ${DEFAULT_JOB_TIMEOUT_SEC} 秒，其它调用默认 ${DEFAULT_TIMEOUT_SEC} 秒；范围 ${MIN_TIMEOUT_SEC}–${MAX_TIMEOUT_SEC}。全部条件满足、命中 fail_fast 或整组无可观察进展时可提前返回；总预算包含等待中的 I/O，构建类长任务可设 300–600。`,
    },
    poll_interval_sec: {
      type: 'number',
      description: `采样间隔，默认 ${DEFAULT_POLL_SEC}，范围 ${MIN_POLL_SEC}–${MAX_POLL_SEC}。作业事件仍会立即唤醒，不受该间隔限制。`,
    },
    output_tail_bytes: {
      type: 'number',
      description: `返回 output_tail 的字节上限，默认 ${DEFAULT_TAIL_BYTES}。`,
    },
  },
  required: ['conditions'],
}

const WAIT_UNTIL_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      enum: ['completed', 'failed', 'stalled', 'timeout', 'cancelled'],
      description: '最终判定：completed=等待条件满足，不等同于目标执行成功；failed=命中早期失败或发生无法继续的观察错误；stalled=整组无可观察进展；timeout=等待超时；cancelled=等待被取消。后三者均不表示目标已被停止。',
    },
    elapsed_ms: { type: 'integer', description: '本次 wait_until 实际耗时（毫秒）。' },
    elapsed: { type: 'string', description: '实际耗时的可读形式。' },
    matched: { type: 'array', items: { type: 'string' }, description: '已完成/失败的条件描述。' },
    conditions: {
      type: 'array',
      description: '每个条件的最终状态快照。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          condition: { type: 'string', description: '条件描述。' },
          state: { type: 'string', description: 'pending / satisfied / failed / error / unsupported。' },
          detail: { type: 'string', description: '该条件的最近观测细节。' },
        },
        required: ['condition', 'state'],
      },
    },
    failure_reason: { type: 'string', description: 'status=failed 时的失败原因（含早期失败检测命中的模式）。' },
    stalled_for_sec: { type: 'number', description: 'status=stalled 时无进展持续的秒数。' },
    suggested_timeout_sec: { type: 'integer', description: '普通 timeout 时的建议 timeout_sec（约本次已等待时长的 2 倍，最小 120、最大 900）；存在观察错误时省略并提示排查。' },
    output_tail: { type: 'string', description: '最近一个相关目标的输出尾部（作业输出、日志窗口、成员状态等）；不是全部目标的日志集合。' },
    hint: { type: 'string', description: '基于 status 的下一步建议。' },
  },
  required: ['status', 'elapsed_ms', 'elapsed', 'matched', 'conditions'],
}

function renderWaitUntilResult(_args, value) {
  // elapsed 是 elapsed_ms 的可读形式；短耗时下两者同义，避免渲染成「1ms（1ms）」
  const elapsedDetail = value.elapsed_ms >= 1000 ? `（${value.elapsed_ms}ms）` : ''
  const lines = [`[wait_until ${value.status}] 耗时 ${value.elapsed}${elapsedDetail}`]
  if (value.failure_reason !== undefined) lines.push(`失败原因：${value.failure_reason}`)
  if (value.stalled_for_sec !== undefined) lines.push(`无进展持续 ${value.stalled_for_sec}s`)
  if (value.matched.length > 0) lines.push(`已满足：${value.matched.join('；')}`)
  for (const row of value.conditions) {
    lines.push(`- ${row.condition}：${row.state}${row.detail === undefined ? '' : `（${row.detail}）`}`)
  }
  if (value.output_tail !== undefined) lines.push('', '--- 输出尾部 ---', value.output_tail)
  if (value.hint !== undefined) lines.push('', value.hint)
  return [{ type: 'text', text: lines.join('\n') }]
}

// ---------------------------------------------------------------------------
// 行为干预：系统提示词规则 + 「sleep 空等 / 超长等待」拦截
//
// 只提供一个新工具不足以改变行为：模型会凭惯性继续「sleep 180 再查一次」。
// 因此在工具之外再补两层——决策前给规则，决策落地时拦下来并给出替代路径。
// ---------------------------------------------------------------------------

/** 前台 sleep 达到这个秒数就视为空等并拒绝。 */
const SLEEP_DENY_SEC = 20
/** job_output / wait_agent 单次等待超过这个毫秒数就要求改用 wait_until 分段等待。 */
const LONG_WAIT_DENY_MS = 120000

/** 拦截理由里给出的替代调用示例。 */
const WAIT_UNTIL_USAGE_HINT = `wait_until 用法（全部条件满足、命中 fail_fast 或整组无可观察进展时提前返回）：
  wait_until({conditions:[{kind:"job",id:"<job_id>"}]})                                  // 等后台作业结束
  wait_until({conditions:[{kind:"file",path:"<path>",until:"exists"}]})                  // 等文件出现
  wait_until({conditions:[{kind:"file",path:"<path>",until:"changed"}], timeout_sec:900, stall_after_sec:120})  // 等文件相对首次观察发生变化，无可观察进展时提前返回
  wait_until({conditions:[{kind:"log",path:"<path>",matches:"/DONE|EXIT=0/"}]})          // 等日志关键字
  wait_until({conditions:[{kind:"agent",target:"<name>",until:"inactive"}], timeout_sec:600, stall_after_sec:120})  // 等队友`

/**
 * 拦截「用 sleep 空等」的前台 bash 调用。
 * @param {object} execution - 工具执行上下文（含 name / arguments）。
 * @returns {string|undefined} 拒绝原因；undefined 表示放行。
 */
function guardSleepWait(execution) {
  if (execution.name !== 'bash') return undefined
  const args = execution.arguments
  if (args === null || typeof args !== 'object') return undefined
  if (args.run_in_background === true) return undefined
  if (typeof args.command !== 'string') return undefined
  const command = args.command.trim()
  if (command.length === 0) return undefined
  const seconds = longestSleepSeconds(command)
  if (seconds < SLEEP_DENY_SEC) return undefined
  return `拒绝了 ${seconds} 秒的前台 sleep 空等：等待期间既看不到进展，完成或失败时也不会立即返回。改用 wait_until 工具（事件驱动、可观测、失败与卡住立刻返回）：
${WAIT_UNTIL_USAGE_HINT}
确需节奏控制时，把 sleep 放进 run_in_background 的作业，或写进带实际工作的脚本。`
}

/**
 * 拦截 job_output / wait_agent 的超长单次等待。
 * @param {object} execution - 工具执行上下文（含 name / arguments）。
 * @returns {string|undefined} 拒绝原因；undefined 表示放行。
 */
function guardLongToolWait(execution) {
  const args = execution.arguments
  if (args === null || typeof args !== 'object') return undefined
  if (execution.name === 'job_output' && args.wait === true && typeof args.timeout_ms === 'number') {
    if (args.timeout_ms <= LONG_WAIT_DENY_MS) return undefined
    return `job_output 的单个等待最多 ${LONG_WAIT_DENY_MS / 1000} 秒（本次 ${Math.round(args.timeout_ms / 1000)} 秒）：超长等待会在作业卡住时白等，也拿不到中间进展。改用 wait_until 分段等待：
${WAIT_UNTIL_USAGE_HINT}`
  }
  if (execution.name === 'wait_agent') {
    const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 30000
    if (timeout <= LONG_WAIT_DENY_MS) return undefined
    return `wait_agent 的单个等待最多 ${LONG_WAIT_DENY_MS / 1000} 秒（本次 ${Math.round(timeout / 1000)} 秒）：它只回一个布尔值，卡住时要等满窗口且事后还得再查。改用 wait_until 的 agent 条件，卡住即返回并带状态快照：
  wait_until({conditions:[{kind:"agent",target:"<name>",until:"inactive"}], timeout_sec:600, stall_after_sec:120})`
  }
  return undefined
}

/** 进入模型系统提示词的等待纪律，放在 jobs 工具说明之后。 */
const WAIT_UNTIL_POLICY = `# 等待纪律
需要等待后台作业、队友、文件或日志时，不要用 sleep 空等或反复轮询：
- bash 中前台 sleep 达到 ${SLEEP_DENY_SEC} 秒会被拒绝；job_output / wait_agent 单次等待超过 ${LONG_WAIT_DENY_MS / 1000} 秒也会被拒绝。
- 不要在 job_output 上反复轮询（尤其是不带 wait 的短调用）：每次轮询都占一个步骤，也拿不到失败判定。等待作业用 wait_until；要看日志时用 job_output 读一次即可。
- 改用 wait_until：全部条件满足、命中 fail_fast 或整组连续无进展时提前返回 status / elapsed / conditions / failure_reason / output_tail。completed 代表等待条件满足，不等同于目标执行成功。
- timeout_sec 是本次等待的总预算：含作业条件默认 ${DEFAULT_JOB_TIMEOUT_SEC} 秒，其它调用默认 ${DEFAULT_TIMEOUT_SEC} 秒；未返回的底层 I/O 也受等待预算约束。
- 普通 timeout 会给出 suggested_timeout_sec，可按建议值重试，不要 60→90 小步递增；有观察错误时先按 conditions / hint 排查。
- 含作业条件未指定 stall_after_sec 时默认 ${DEFAULT_JOB_STALL_SEC} 秒；任一目标有进展都会重置整组计时。stalled 只代表未观察到进展；agent 条件建议显式设 120 秒以内。
- cancelled 仅结束本次等待，不停止目标或底层 I/O。
${WAIT_UNTIL_USAGE_HINT}
长等待用 timeout_sec + stall_after_sec 分段，而不是一次设 30 分钟。`

/**
 * 注册 `wait_until` 工具、等待纪律提示词，以及两条行为拦截。
 * @param {object} ctx - 插件上下文（tools / jobs / workingDirectory）。
 */
export function apply(ctx) {
  // 第一层：决策前的规则。模型在生成「等 180 秒」这个念头之前就应看到它。
  const prompt = ctx.get('systemPrompt')
  if (prompt !== undefined) {
    ctx.effect(() => prompt.section({
      name: 'tool:wait-until',
      order: prompt.getSectionOrder('TOOL_JOBS') + 50,
      text: WAIT_UNTIL_POLICY,
      interpolate: false,
    }), 'tool-wait-until.policy()')
  }

  // 第二层：决策落地时的硬拦截。即使模型仍决定空等，调用会被拒绝并给出替代路径。
  if (typeof ctx.tools.guard === 'function') {
    ctx.effect(() => ctx.tools.guard(guardSleepWait), 'tool-wait-until.guard.sleep()')
    ctx.effect(() => ctx.tools.guard(guardLongToolWait), 'tool-wait-until.guard.long-wait()')
  }

  // 第三层：替代原语本身——事件驱动的等待。
  ctx.tools.register({
    name: 'wait_until',
    description: '事件驱动的等待：全部条件满足、命中早期失败或整组无可观察进展时提前返回。适用于后台作业（job_output 的 id）、团队成员、文件出现/变化、日志正则命中。返回统一的 status（completed/failed/stalled/timeout/cancelled）、elapsed、conditions、failure_reason、output_tail；completed 表示条件满足，不保证目标执行成功。取消只结束本次等待。作业事件会立即唤醒，不受 poll_interval_sec 限制。',
    parameters: WAIT_UNTIL_PARAMETERS,
    output: {
      schema: WAIT_UNTIL_RESULT_SCHEMA,
      render: renderWaitUntilResult,
    },
    // 等待类工具不独占调度，可以与其它工具并行。
    isConcurrencySafe: () => true,
    // 工具级兜底：略大于最长总超时，避免被调用超时策略先截断。
    timeoutMs: MAX_TIMEOUT_SEC * 1000 + 60000,
    async execute(args, exec) {
      return await runWaitUntil(ctx, args, exec)
    },
  })
}
