/**
 * Repeatable integration smoke against explicitly supplied, already installed DSH packages.
 * No model/provider, profile loader, user Session, or running Desktop connection is used.
 *
 * Plain installation:
 *   node test/host-smoke.mjs --runtime-root /absolute/path/to/dsh
 *
 * Desktop ASAR installation (use its executable in Node mode):
 *   ELECTRON_RUN_AS_NODE=1 "/path/to/DeepSeek Harness" --expose-internals \
 *     test/host-smoke.mjs --runtime-root "/path/to/app.asar/dsh"
 *
 * The runtime root must contain node_modules/@deepseek-ai. Nothing is installed.
 * All services are real. Fixtures are finite, unowned job producers and a no-op
 * bash tool body used to test the real guard pipeline without executing shell.
 * A controller is attached through the public JobRegistry API.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const usage = 'Usage: node test/host-smoke.mjs --runtime-root /absolute/path/to/dsh'
if (argv.length === 1 && argv[0] === '--help') {
  console.log(usage)
  process.exit(0)
}
if (argv.length !== 2 || argv[0] !== '--runtime-root' || !path.isAbsolute(argv[1])) {
  console.error(usage)
  process.exit(2)
}

const runtimeRoot = argv[1]
const versions = {}
let assertions = 0
let scenarios = 0

function check(condition, message) {
  assert.ok(condition, message)
  assertions += 1
}

async function scenario(name, run) {
  await run()
  scenarios += 1
  console.log('PASS ' + name)
}

async function loadRuntimePackage(name) {
  const directory = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', name)
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  versions[name] = manifest.version
  return import(pathToFileURL(path.join(directory, manifest.main ?? 'lib/index.js')).href)
}

async function main() {
  const { Context } = await loadRuntimePackage('cordis')
  const ctx = new Context()
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wait-until-host-smoke-'))
  let pluginFiber
  let callSequence = 0
  let jobsBeforeDispose = []
  const startedAt = performance.now()

  // This is a real producer, not a replacement JobRegistry. Settlement and output
  // travel through the installed jobs-local implementation and event hub.
  function timerJob(label, delayMs, action = () => {}) {
    return ctx.jobs.start({
      kind: 'smoke',
      label,
      run(job) {
        let settle
        const done = new Promise(resolve => { settle = resolve })
        const timer = setTimeout(() => {
          try {
            action(job)
            settle({ status: 'completed', detail: 'exit code: 0' })
          } catch (error) {
            settle({ status: 'failed', detail: String(error) })
          }
        }, delayMs)
        return {
          done,
          cancel() {
            clearTimeout(timer)
            settle({ status: 'killed', detail: 'smoke cleanup' })
          },
        }
      },
    })
  }

  // A finite Node child supplies real process exit codes. Electron stays in Node
  // mode; this does not launch a GUI, a DSH profile, or any model operation.
  function processJob(label, source, timing) {
    return ctx.jobs.start({
      kind: 'smoke',
      label,
      run(job) {
        const child = spawn(process.execPath, ['--input-type=commonjs', '-e', source], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        if (timing !== undefined) {
          child.once('spawn', () => { timing.spawned_at_ms = performance.now() })
          child.once('exit', (code, signal) => {
            timing.exited_at_ms = performance.now()
            timing.exit_code = code
            timing.exit_signal = signal
          })
        }
        const done = new Promise(resolve => {
          child.stdout.on('data', chunk => job.append(chunk.toString('utf8'), { channel: 'stdout' }))
          child.stderr.on('data', chunk => job.append(chunk.toString('utf8'), { channel: 'stderr' }))
          child.once('error', error => resolve({ status: 'failed', detail: error.message }))
          child.once('close', (code, signal) => resolve({
            status: signal === null ? 'completed' : 'killed',
            detail: signal === null ? 'exit code: ' + code : 'signal: ' + signal,
          }))
        })
        return { done, cancel() { child.kill('SIGTERM') } }
      },
    })
  }

  async function invoke(args, signal = new AbortController().signal, name = 'wait_until') {
    const batch = await ctx.tools.execute({
      calls: [{
        type: 'tool-call',
        id: 'host-smoke-' + (++callSequence),
        name,
        arguments: JSON.stringify(args),
      }],
      signal,
    })
    check(batch.results.length === 1, 'Native executor must return one correlated result')
    return batch.results[0].result
  }

  function valueOf(result) {
    check(result.isError === false, 'Native pipeline rejected a valid call: ' + JSON.stringify(result.error))
    check(result.value !== undefined, 'Native pipeline must preserve the canonical value')
    return result.value
  }

  async function finishFixture(id) {
    const view = await ctx.jobs.wait(id, 2000)
    check(view.status === 'completed', 'Fixture must finish successfully: ' + view.detail)
  }

  try {
    for (const [name, config] of [
      ['dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false }],
      ['dsh-tools', {}],
      ['dsh-tool-executor-native', {}],
      ['dsh-jobs-local', {}],
      ['dsh-fs-local', {}],
      ['dsh-session-projection', {}],
      ['dsh-working-directory', { defaultDirectory: temporaryDirectory }],
    ]) {
      const module = await loadRuntimePackage(name)
      await ctx.plugin(module.default ?? module, config)
    }
    ctx.jobs.attachController('wait-until-host-smoke')
    const plugin = await import(new URL('../index.js', import.meta.url))
    pluginFiber = await ctx.plugin(plugin)
    const tool = ctx.tools.get('wait_until')

    console.log(JSON.stringify({
      runtime_root: runtimeRoot,
      node: process.versions.node,
      versions,
      services: ['systemPrompt', 'tools', 'jobs', 'fs', 'sessionProjections', 'workingDirectory']
        .map(name => ({ name, implementation: ctx.get(name).constructor.name })),
      fixture_scope: 'unowned jobs; no Agent, Session, profile, model, or existing host connection',
    }))

    await scenario('real plugin loading, schema registration, and Native argument validation', async () => {
      const schema = ctx.tools.schemas().find(entry => entry.name === 'wait_until')
      check(schema !== undefined, 'wait_until must be registered in the real tool registry')
      check(schema.parameters.required.includes('conditions'), 'Model schema must require conditions')
      check(tool.output.schema.properties.status.enum.includes('cancelled'), 'Output schema must include cancelled')
      const invalid = await invoke({ conditions: [{ kind: 'invalid' }] })
      check(invalid.isError === true, 'Invalid conditions must be a normal tool error')
      check(invalid.content.some(block => block.type === 'text' && block.text.includes('conditions')),
        'Invalid-input rendering must retain useful diagnostics')
    })

    await scenario('real Native guard rejects long sleep before a harmless fixture body', async () => {
      let bodyCalls = 0
      ctx.tools.register({
        name: 'bash',
        description: 'Smoke fixture only; never executes shell.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        isConcurrencySafe: () => true,
        async execute() { bodyCalls += 1; return 'fixture-ran' },
      })
      const blocked = await invoke({ command: 'sleep 20' }, undefined, 'bash')
      check(blocked.isError === true, 'Native pipeline must reject a guarded sleep')
      check(bodyCalls === 0, 'Rejected calls must not enter the tool body')
      check(blocked.content.some(block => block.type === 'text' && block.text.includes('wait_until')),
        'Guard rejection must include the replacement tool guidance')
      const allowed = await invoke({ command: 'echo "sleep 20"' }, undefined, 'bash')
      check(allowed.isError === false && allowed.value === 'fixture-ran', 'Echoed sleep text must pass the guard')
      check(bodyCalls === 1, 'Allowed command must reach the harmless fixture once')
    })

    await scenario('real job event wakes before the polling window and preserves unread output', async () => {
      const id = processJob('event wake', "setTimeout(() => console.log('HOST_DONE'), 180)")
      const start = performance.now()
      const response = await invoke({
        conditions: [{ kind: 'job', id }],
        timeout_sec: 4,
        poll_interval_sec: 5,
      })
      const value = valueOf(response)
      check(value.status === 'completed', 'Successful process must complete the wait')
      check(performance.now() - start < 3000, 'Completion must wake before the 4s timer/poll boundary')
      check(value.output_tail.includes('HOST_DONE'), 'Canonical result must include real child output')
      check(response.content.some(block => block.type === 'text' && block.text.includes('[wait_until completed]')),
        'Real Native renderer must expose the completed status')
      check(ctx.jobs.read(id).chunks.some(chunk => chunk.text.includes('HOST_DONE')),
        'Observing through wait_until must not consume the job_output cursor')
    })

    // The three finite processes start together. Each call records its own wait
    // window; all results are drained before assertions or Context teardown.
    const failureDelays = [0, 3000, 5000]
    const failureResults = await Promise.allSettled(failureDelays.map(async delayMs => {
      const timing = {}
      const marker = 'HOST_EXIT_7_DELAY_' + delayMs
      const failureBody = 'console.error(' + JSON.stringify(marker) + '); process.exit(7)'
      const source = delayMs === 0 ? failureBody : 'setTimeout(() => { ' + failureBody + ' }, ' + delayMs + ')'
      const id = processJob('exit seven after ' + delayMs + 'ms', source, timing)
      const waitStartedAt = performance.now()
      const response = await invoke({
        conditions: [{ kind: 'job', id }],
        timeout_sec: 15,
        poll_interval_sec: 10,
        stall_after_sec: 0,
      })
      const waitReturnedAt = performance.now()
      return { id, marker, timing, waitStartedAt, waitReturnedAt, value: valueOf(response) }
    }))
    for (let index = 0; index < failureResults.length; index += 1) {
      const delayMs = failureDelays[index]
      const result = failureResults[index]
      await scenario('real process exit 7 after ' + delayMs + 'ms wakes without a 10s poll', async () => {
        check(result.status === 'fulfilled', 'Failure fixture did not settle: ' + result.reason?.message)
        const { id, marker, timing, waitStartedAt, waitReturnedAt, value } = result.value
        const exitToResultMs = waitReturnedAt - timing.exited_at_ms
        console.log(JSON.stringify({
          case: 'nonzero_exit',
          requested_delay_ms: delayMs,
          job_id: id,
          actual_exit_code: timing.exit_code,
          wait_started_ms: Math.round(waitStartedAt - startedAt),
          process_exited_ms: Math.round(timing.exited_at_ms - startedAt),
          wait_returned_ms: Math.round(waitReturnedAt - startedAt),
          actual_wait_ms: Math.round(waitReturnedAt - waitStartedAt),
          reported_elapsed_ms: value.elapsed_ms,
          exit_to_result_ms: Math.round(exitToResultMs),
          status: value.status,
          failure_reason: value.failure_reason,
          stderr_tail: value.output_tail,
        }))
        check(timing.exit_code === 7 && timing.exit_signal === null, 'Fixture must actually exit with code 7')
        check(timing.exited_at_ms >= waitStartedAt, 'The wait must be active before the exit event')
        check(timing.exited_at_ms - timing.spawned_at_ms >= delayMs - 50,
          'The delayed fixture must remain alive for its declared delay')
        check(value.status === 'failed', 'A real exit code 7 must produce failed')
        check(value.failure_reason.includes('7'), 'Failure must retain the actual exit code')
        check(value.output_tail.includes(marker), 'Failure must retain this process stderr')
        check(exitToResultMs >= 0 && exitToResultMs < 1500,
          'Failure response must follow the real exit event promptly, not wait for the 10s poll')
      })
    }

    await scenario('body cancellation and Native ABORTED preserve the running target', async () => {
      const id = timerJob('cancellation target', 10000)
      const bodyController = new AbortController()
      const bodyTimer = setTimeout(() => bodyController.abort(), 60)
      let value
      try {
        value = await tool.execute({
          conditions: [{ kind: 'job', id }],
          timeout_sec: 3,
          poll_interval_sec: 5,
        }, { signal: bodyController.signal })
      } finally {
        clearTimeout(bodyTimer)
      }
      check(value.status === 'cancelled', 'Registered tool body must return cancelled')
      check(ctx.jobs.get(id).status === 'running', 'Cancelling the wait must not terminate its target')

      const nativeController = new AbortController()
      const nativeTimer = setTimeout(() => nativeController.abort(), 60)
      let response
      try {
        response = await invoke({
          conditions: [{ kind: 'job', id }],
          timeout_sec: 3,
          poll_interval_sec: 5,
        }, nativeController.signal)
      } finally {
        clearTimeout(nativeTimer)
      }
      check(response.isError === true && response.error?.info?.code === 'ABORTED',
        'Installed Native pipeline must report caller cancellation as ABORTED')
      check(ctx.jobs.get(id).status === 'running', 'Native cancellation must also leave the target running')
      ctx.jobs.kill(id, undefined, 'smoke cleanup')
      check((await ctx.jobs.wait(id, 2000)).status === 'killed', 'Explicit fixture cleanup must settle the target')
    })

    await scenario('real filesystem: initially absent file satisfies changed when created', async () => {
      const file = path.join(temporaryDirectory, 'created.txt')
      const target = await ctx.fs.resolve(file)
      check(await ctx.fs.stat(target) === undefined, 'File fixture must initially be absent')
      const waiting = invoke({
        conditions: [{ kind: 'file', path: file, until: 'changed' }],
        timeout_sec: 3,
        poll_interval_sec: 0.25,
      })
      const fixture = timerJob('create fixture', 150, () => fs.writeFileSync(file, 'ready'))
      const value = valueOf(await waiting)
      check(value.status === 'completed', 'First file appearance must satisfy changed')
      check((await ctx.fs.stat(target)).size === 5, 'The real filesystem service must observe the fixture')
      await finishFixture(fixture)
    })

    await scenario('real filesystem and jobs: remembered log match survives wait_all', async () => {
      const log = path.join(temporaryDirectory, 'latched.log')
      fs.writeFileSync(log, 'DONE\n')
      const id = processJob('later completion', "setTimeout(() => console.log('AFTER_LOG'), 180)")
      const value = valueOf(await invoke({
        conditions: [
          { kind: 'log', path: log, matches: '/^DONE$/m' },
          { kind: 'job', id },
        ],
        timeout_sec: 3,
        poll_interval_sec: 0.25,
      }))
      check(value.status === 'completed', 'A pre-existing log match must survive until the job settles')
      check(value.conditions.every(row => row.state === 'satisfied'), 'Both wait_all rows must remain satisfied')
    })

    await scenario('real filesystem: same-size log replacement is reread', async () => {
      const log = path.join(temporaryDirectory, 'replaced.log')
      fs.writeFileSync(log, 'WAITING')
      const waiting = invoke({
        conditions: [{ kind: 'log', path: log, matches: '^READY!!$' }],
        timeout_sec: 3,
        poll_interval_sec: 0.25,
      })
      const fixture = timerJob('rewrite fixture', 150, () => fs.writeFileSync(log, 'READY!!'))
      const value = valueOf(await waiting)
      check(value.status === 'completed', 'Changing the version without changing size must be observed')
      check(value.output_tail.includes('READY!!'), 'Result must contain replacement content')
      await finishFixture(fixture)
    })

    await scenario('real filesystem: missing target respects the total timeout', async () => {
      const start = performance.now()
      const value = valueOf(await invoke({
        conditions: [{ kind: 'file', path: path.join(temporaryDirectory, 'never-created') }],
        timeout_sec: 1,
        poll_interval_sec: 5,
      }))
      check(value.status === 'timeout', 'Missing target must time out')
      check(performance.now() - start < 2500, 'Total deadline must end the wait before the polling interval')
      check(value.conditions[0].detail.length > 0, 'Timeout must preserve a condition diagnostic')
    })

    await scenario('plugin disposal removes its real registry contribution', async () => {
      await pluginFiber.dispose()
      check(!ctx.tools.schemas().some(entry => entry.name === 'wait_until'), 'Disposal must unregister wait_until')
      jobsBeforeDispose = ctx.jobs.list().map(job => ({ id: job.id, status: job.status }))
      check(jobsBeforeDispose.every(job => ['completed', 'failed', 'killed'].includes(job.status)),
        'No producer may remain running before Context disposal')
    })
  } finally {
    try {
      await ctx.fiber.dispose()
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }

  check(!fs.existsSync(temporaryDirectory), 'Smoke must remove its own temporary directory')
  console.log(JSON.stringify({
    status: 'passed',
    scenarios,
    assertions,
    elapsed_ms: Math.round(performance.now() - startedAt),
    temporary_directory_removed: true,
    live_jobs_before_dispose: jobsBeforeDispose.filter(job => !['completed', 'failed', 'killed'].includes(job.status)).length,
    not_covered: [
      'model behavior or token savings',
      'Agent Teams and owned-job/session authorization',
      'running Desktop profile installation, module caching, or hot reload',
    ],
  }))
}

main().catch(error => {
  console.error(JSON.stringify({
    status: 'failed',
    scenarios,
    assertions,
    message: error.message,
    code: error.code,
    stack: error.stack?.split('\n').slice(0,8),
  }))
  process.exitCode = 1
})
