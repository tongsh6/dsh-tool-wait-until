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

export const name = 'tool-wait-until'

/** 激活所需的服务；fs / agentTeams 通过 ctx.get 可选访问。 */
export const inject = ['tools', 'jobs', 'workingDirectory']

// ---------------------------------------------------------------------------
// 参数默认值与边界
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_SEC = 60
const MIN_TIMEOUT_SEC = 1
const MAX_TIMEOUT_SEC = 900

const DEFAULT_POLL_SEC = 2
const MIN_POLL_SEC = 0.25
const MAX_POLL_SEC = 30

const MIN_STALL_SEC = 5

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
  return { enabled: true, simple, textRules }
}

// ---------------------------------------------------------------------------
// 条件探针
// ---------------------------------------------------------------------------

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
    return {
      text: truncateTail(renderChunks(read.chunks), maxBytes),
      output: truncateTail(output, maxBytes),
      stderr: truncateTail(stderr, maxBytes),
    }
  } catch {
    return { text: '', output: '', stderr: '' }
  }
}

/** 作业条件：等待 settle，同时做早期失败判定。 */
function createJobProbe(ctx, condition, caller, failFast, tailBytes) {
  let lastTotal = -1
  let lastStatus
  let window = { text: '', output: '', stderr: '' }
  return {
    label: condition.label,
    describe: () => `后台作业 ${condition.id}（${condition.until === 'failed' ? '失败' : '结束'}）`,
    async poll() {
      let job
      try {
        job = ctx.jobs.get(condition.id, caller)
      } catch (error) {
        return { fatal: `无法读取后台作业 ${condition.id}：${describeError(error)}` }
      }
      const total = job.output.total
      const progressed = total !== lastTotal || job.status !== lastStatus
      lastTotal = total
      lastStatus = job.status
      if (progressed) window = readJobWindow(ctx, condition.id, caller, tailBytes)

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
          } else {
            const exit = /EXIT=(-?\d+)/.exec(window.text)
            if (exit !== null && Number(exit[1]) !== 0) {
              fail = { reason: `后台作业 ${job.id} 输出 EXIT=${exit[1]}（非零退出）`, tail: window.text }
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
    },
  }
}

/** 队友条件：等待成员变为 inactive / failed，或出现状态变化。 */
function createAgentProbe(ctx, condition, callerAgent) {
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
      const detail = watched
        .map((member) => `${member.name}=${member.status}${member.diagnostics.length === 0 ? '' : `（diagnostics: ${member.diagnostics.join('; ')}）`}`)
        .join(', ')
      const failedMember = watched.find((member) => member.status === 'failed')
      const anyFailed = failedMember !== undefined
      let satisfied
      if (condition.until === 'failed') satisfied = anyFailed
      else if (condition.until === 'status_changed') satisfied = progressed
      else satisfied = watched.every((member) => AGENT_INACTIVE.has(member.status))
      const fail = anyFailed
        ? { reason: `队友 ${failedMember.name} 失败：${failedMember.diagnostics.join('; ') || '无 diagnostics'}`, tail: detail }
        : undefined
      return { satisfied, progress: progressed, detail, fail }
    },
  }
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
        return { error: `读取 ${condition.path} 的状态失败：${describeError(error)}` }
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
      else satisfied = exists && baselineVersion !== undefined && version !== baselineVersion
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
  let recentText = ''
  return {
    label: condition.label,
    describe,
    async poll() {
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
        return { error: `读取日志 ${condition.path} 的状态失败：${describeError(error)}` }
      }
      if (info === undefined) {
        readOffset = undefined
        recentText = ''
        return { satisfied: false, progress: false, detail: '日志文件还不存在' }
      }
      const size = info.size ?? 0
      // 首轮（或文件被轮转截断后）读取尾部窗口，让启动前已存在的内容也能命中。
      if (readOffset === undefined || size < readOffset) {
        const from = Math.max(0, size - LOG_WINDOW_BYTES)
        let bytes
        try {
          bytes = await fs.readByteRange(target, { offset: from, length: size - from })
        } catch (error) {
          return { error: `读取日志 ${condition.path} 失败：${describeError(error)}` }
        }
        recentText = decoder.decode(bytes)
        readOffset = size
        const matched = matchesRegex(condition.regex, recentText)
        return {
          satisfied: matched,
          progress: false,
          detail: `日志 ${size} 字节${matched ? '，命中' : '，未命中'}`,
          tail: truncateTail(recentText, DEFAULT_TAIL_BYTES),
        }
      }
      if (size === readOffset) {
        return { satisfied: false, progress: false, detail: `日志无新增（${size} 字节）`, tail: truncateTail(recentText, DEFAULT_TAIL_BYTES) }
      }
      let bytes
      try {
        bytes = await fs.readByteRange(target, { offset: readOffset, length: Math.min(size - readOffset, LOG_WINDOW_BYTES) })
      } catch (error) {
        return { error: `读取日志 ${condition.path} 新增内容失败：${describeError(error)}` }
      }
      const grew = bytes.byteLength
      readOffset += grew
      recentText = truncateTail(`${recentText}${decoder.decode(bytes)}`, LOG_WINDOW_BYTES)
      const matched = matchesRegex(condition.regex, recentText)
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
  failed: '目标已失败，不必再等：按 output_tail / failure_reason 决策（需要完整日志时用 job_output 读取）。',
  stalled: '目标在该窗口内没有任何进展（无新输出、状态未变、文件未更新），可能已卡死：检查进程与日志，必要时先停止再重试。',
  timeout: '本次是超时，不是失败：条件在 timeout_sec 内仍未满足。可增大 timeout_sec 再次 wait_until，或先检查目标与日志。',
  cancelled: '等待已被调用方取消，目标仍在运行（没有被停止）。',
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
  if (input.tail !== undefined && input.tail !== '') value.output_tail = truncateTail(input.tail, input.tailBytes ?? DEFAULT_TAIL_BYTES)
  const hint = input.hint ?? STATUS_HINTS[status]
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
  const timeoutMs = clamp(numberOr(args.timeout_sec, DEFAULT_TIMEOUT_SEC), MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC) * 1000
  const pollMs = clamp(numberOr(args.poll_interval_sec, DEFAULT_POLL_SEC), MIN_POLL_SEC, MAX_POLL_SEC) * 1000
  const stallRaw = numberOr(args.stall_after_sec, 0)
  const stallMs = stallRaw <= 0 ? 0 : Math.max(stallRaw, MIN_STALL_SEC) * 1000
  const tailBytes = clamp(numberOr(args.output_tail_bytes, DEFAULT_TAIL_BYTES), MIN_TAIL_BYTES, MAX_TAIL_BYTES)

  const caller = exec.agent?.id
  const callerAgent = exec.agent
  const cwd = await resolveCwd(ctx, exec)

  const probes = conditions.map((condition) => {
    switch (condition.kind) {
      case 'job': return createJobProbe(ctx, condition, caller, failFast, tailBytes)
      case 'agent': return createAgentProbe(ctx, condition, callerAgent)
      case 'file': return createFileProbe(ctx, condition, cwd)
      case 'log': return createLogProbe(ctx, condition, cwd)
      default: throw new Error(`未知的条件类型：${String(condition.kind)}`)
    }
  })

  const rows = probes.map((probe) => ({ condition: probe.describe(), state: 'pending', detail: '尚未检查' }))
  const wake = createWake()
  const disposers = []

  const finish = (status, extra) => buildResult(status, startedAt, { rows: snapshotRows(rows), tailBytes, ...extra })
  const snapshotRows = () => rows.map((row) => ({ condition: row.condition, state: row.state, detail: row.detail }))

  try {
    if (conditions.some((condition) => condition.kind === 'job')) {
      const filter = caller === undefined ? { owners: 'all' } : { owner: caller }
      disposers.push(ctx.jobs.events.subscribe(filter, () => wake.wake()))
    }

    let lastProgressAt = Date.now()
    let latestTail = ''
    const deadline = startedAt + timeoutMs

    for (;;) {
      if (exec.signal.aborted) return finish('cancelled', { tail: latestTail })
      const now = Date.now()
      let progressed = false
      let allSatisfied = true
      const matched = []
      let failure
      let fatal

      for (let index = 0; index < probes.length; index += 1) {
        const probe = probes[index]
        let state
        try {
          state = await probe.poll()
        } catch (error) {
          state = { fatal: `${probe.describe()}：${describeError(error)}` }
        }
        const row = rows[index]
        if (typeof state?.detail === 'string') row.detail = state.detail
        if (typeof state?.tail === 'string' && state.tail.length > 0) latestTail = state.tail
        if (state?.fatal !== undefined) {
          row.state = 'error'
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

      if (fatal !== undefined) return finish('failed', { failureReason: fatal, tail: latestTail, matched })
      if (failure !== undefined) return finish('failed', { failureReason: failure.reason, tail: failure.tail ?? latestTail, matched })
      if (allSatisfied && matched.length === probes.length) return finish('completed', { matched, tail: latestTail })
      if (progressed) lastProgressAt = now

      if (stallMs > 0 && now - lastProgressAt >= stallMs) {
        return finish('stalled', {
          stalledForSec: Math.round((now - lastProgressAt) / 1000),
          tail: latestTail,
          matched,
        })
      }
      const remaining = deadline - now
      if (remaining <= 0) return finish('timeout', { tail: latestTail, matched })
      await waitForSignal(Math.min(pollMs, remaining), wake, exec.signal)
    }
  } finally {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 清理监听器失败不影响已经产出的结果
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
      description: '完成条件。job：settled（默认，结束即可，含失败）/ failed（仅失败）；agent：inactive（默认，全部空闲）/ failed（失败）/ status_changed（任意状态变化）；file：exists（默认，出现）/ changed（版本变化）；log：matches（默认，必须配 matches）。',
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
      description: '要等待的条件。全部条件都满足才返回 completed（即 wait_all 语义）；fail_fast 命中时任一条件失败立即返回 failed。只想要「任一完成就返回」时，把条件拆成多次 wait_until 或配合 timeout_sec 使用。',
      items: CONDITION_SCHEMA,
    },
    fail_fast: {
      oneOf: [
        { type: 'boolean' },
        { type: 'array', items: { type: 'string' } },
      ],
      description: '早期失败检测。true（默认）= job_failed + job_killed + agent_failed；false=关闭；也可给模式数组：job_failed / job_killed / exit_code_nonzero / agent_failed / stderr_matches:/error|failed|Traceback/ / output_matches:/EXIT=[1-9]/。',
    },
    stall_after_sec: {
      type: 'number',
      description: '卡住判定：连续这么多秒没有任何进展信号（作业输出/状态、队友状态、文件版本、日志大小都没变）就返回 stalled。0（默认）=关闭。长等待时建议 120–600。',
    },
    timeout_sec: {
      type: 'number',
      description: `总兜底超时，默认 ${DEFAULT_TIMEOUT_SEC}，范围 ${MIN_TIMEOUT_SEC}–${MAX_TIMEOUT_SEC}。单次建议 30–60 秒，需要更长等待时反复 wait_until 而不是一次等满。`,
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
      description: '最终判定：完成 / 失败 / 卡住 / 超时 / 被取消。超时不是失败。',
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
    output_tail: { type: 'string', description: '相关目标最后输出的尾部（作业输出、日志窗口、成员状态等）。' },
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

const SLEEP_SEGMENT = /(?:^|[;&|]|\n)\s*sleep\s+([0-9]+(?:\.[0-9]+)?)\s*([smhd]?)\b/gi
const SLEEP_UNITS = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }

/**
 * 找出命令里最长的一次前台 sleep（秒）。
 * @param {string} command - bash 命令原文。
 * @returns {number} 最长 sleep 秒数；没有则为 0。
 */
function longestSleepSeconds(command) {
  let longest = 0
  for (const match of command.matchAll(SLEEP_SEGMENT)) {
    const unit = SLEEP_UNITS[(match[2] ?? '').toLowerCase()] ?? 1
    longest = Math.max(longest, Number(match[1]) * unit)
  }
  return longest
}

/** 拦截理由里给出的替代调用示例。 */
const WAIT_UNTIL_USAGE_HINT = `wait_until 用法（条件满足、目标失败或连续无进展时立即返回）：
  wait_until({conditions:[{kind:"job",id:"<job_id>"}]})                                  // 等后台作业结束
  wait_until({conditions:[{kind:"file",path:"<path>",until:"exists"}]})                  // 等文件出现
  wait_until({conditions:[{kind:"file",path:"<path>",until:"changed"}], timeout_sec:900, stall_after_sec:120})  // 等文件持续变化，卡住即返回
  wait_until({conditions:[{kind:"log",path:"<path>",matches:"/DONE|EXIT=0/"}]})          // 等日志关键字
  wait_until({conditions:[{kind:"agent",target:"<name>",until:"inactive"}], timeout_sec:600, stall_after_sec:300})  // 等队友`

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
  // 以单个 & 结尾的是 shell 后台任务，本身不阻塞这次调用。
  if (/(?:^|[^&])&$/.test(command)) return undefined
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
  wait_until({conditions:[{kind:"agent",target:"<name>",until:"inactive"}], timeout_sec:600, stall_after_sec:300})`
  }
  return undefined
}

/** 进入模型系统提示词的等待纪律，放在 jobs 工具说明之后。 */
const WAIT_UNTIL_POLICY = `# 等待纪律
需要等待后台作业、队友、文件或日志时，不要用 sleep 空等或反复轮询：
- bash 中前台 sleep 达到 ${SLEEP_DENY_SEC} 秒会被拒绝；job_output / wait_agent 单次等待超过 ${LONG_WAIT_DENY_MS / 1000} 秒也会被拒绝。
- 改用 wait_until：条件满足、目标失败或连续无进展时立即返回 status / elapsed / failure_reason / output_tail，一次调用即可判定结果，无需再查一次。
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
    description: '事件驱动的等待：等到目标完成、失败或卡住就立刻返回，替代「长超时 + sleep 轮询 + 再查一轮」。适用于后台作业（job_output 的 id）、团队成员、文件出现/变化、日志正则命中。返回统一的 status（completed/failed/stalled/timeout/cancelled）、elapsed、failure_reason、output_tail，一次调用即可判定结果，无需二次查询。作业事件会立即唤醒，不受 poll_interval_sec 限制。',
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
