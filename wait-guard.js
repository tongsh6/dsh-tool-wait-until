/**
 * sleep 等待 guard 的有限词法识别，不是 shell 解释器或安全边界。
 * 支持字面量简单命令、引号/转义、重定向、pipeline 与 and/or-list 分组。
 * & 仅后台化其所在命令组；20 秒等拦截阈值由调用方决定。
 * 命令替换、括号/花括号分组、heredoc 等复杂语法保守地不做硬判断。
 */

const SLEEP_UNITS = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }

function tokenizeWaitGuard(command) {
  const tokens = []
  let word = ''
  let active = false
  let quoted = false
  let quote = ''

  const flush = () => {
    if (active) tokens.push({ kind: 'word', value: word })
    word = ''
    active = false
    quoted = false
  }

  for (let i = 0; i < command.length;) {
    const ch = command[i]

    if (quote === "'") {
      if (ch === "'") quote = ''
      else word += ch
      i += 1
      continue
    }

    if (ch === '\\') {
      const next = command[i + 1]
      if (next === undefined) return null
      if (next === '\n') {
        i += 2
        continue
      }
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) {
        word += ch
        active = true
        i += 1
        continue
      }
      word += next
      active = true
      quoted = true
      i += 2
      continue
    }

    if (ch === "'" || ch === '"') {
      if (!quote) {
        quote = ch
        active = true
        quoted = true
        i += 1
        continue
      }
      if (quote === ch) {
        quote = ''
        i += 1
        continue
      }
    }

    if (ch === '`' || (ch === '$' && command[i + 1] === '(')) return null
    if (quote) {
      word += ch
      i += 1
      continue
    }
    if ('(){}'.includes(ch)) return null

    if (ch === '#' && !active) {
      while (i < command.length && command[i] !== '\n') i += 1
      continue
    }
    if (ch === ' ' || ch === '\t') {
      flush()
      i += 1
      continue
    }

    const tail = command.slice(i)
    const redirect = /^(?:&>>|&>|<<<|<<-|<<|>>|<>|>\||<&|>&|<|>)/.exec(tail)?.[0]
    if (redirect) {
      if (redirect === '<<' || redirect === '<<-') return null

      // 紧贴重定向的裸数字是 fd，例如 2>&1，不是命令或参数。
      if (
        (ch === '<' || ch === '>') &&
        active &&
        !quoted &&
        /^\d+$/.test(word)
      ) {
        word = ''
        active = false
      }
      flush()
      tokens.push({ kind: 'redirect', value: redirect })
      i += redirect.length
      continue
    }

    const op = /^(?:&&|\|\||\|&|[;&|\n])/.exec(tail)?.[0]
    if (op) {
      flush()
      tokens.push({ kind: 'op', value: op })
      i += op.length
      continue
    }

    word += ch
    active = true
    i += 1
  }

  if (quote) return null
  flush()
  return tokens
}

/** 返回可确定的前台 sleep 最大秒数；无法可靠分类时返回 0。 */
export function longestSleepSeconds(command) {
  const tokens = tokenizeWaitGuard(command)
  if (tokens === null) return 0

  let words = []
  let groupMax = 0
  let foregroundMax = 0
  let redirectTarget = false
  let expectsRightCommand = false

  const flushCommand = () => {
    const duration =
      words[0] === 'sleep' &&
      /^(\d+(?:\.\d+)?)([smhd]?)$/i.exec(words[1] ?? '')

    if (duration) {
      groupMax = Math.max(
        groupMax,
        Number(duration[1]) * SLEEP_UNITS[duration[2].toLowerCase()],
      )
    }
    words = []
  }

  for (const token of tokens) {
    if (token.kind === 'redirect') {
      redirectTarget = true
      expectsRightCommand = false
      continue
    }
    if (token.kind === 'word') {
      if (redirectTarget) redirectTarget = false
      else words.push(token.value)
      expectsRightCommand = false
      continue
    }

    // &&、||、管道后的换行属于续行，不结束当前命令组。
    if (token.value === '\n' && expectsRightCommand) continue

    flushCommand()
    redirectTarget = false

    if (['&&', '||', '|', '|&'].includes(token.value)) {
      expectsRightCommand = true
      continue
    }

    // & 后台化的是整个 and/or-list（包含其中的 pipeline）。
    expectsRightCommand = false
    if (token.value !== '&') {
      foregroundMax = Math.max(foregroundMax, groupMax)
    }
    groupMax = 0
  }

  flushCommand()
  return Math.max(foregroundMax, groupMax)
}
