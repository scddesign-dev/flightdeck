import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Flow, Run } from '../types'
import {
  MAIN, addAgent, addMessage, bgTaskOf, emptyFlow, parseNotifications, setContext, setOutput, setStatuses, snapshot, trimBreakdown,
  taskEnd, taskStart, toolEnd, toolStart,
} from './flow'

// The browser view: a local server streams each session's snapshot file to the page.
// ponytail: fixed port; make it a userConfig option if it ever clashes
const FLOW_PORT = 4123
const FLOW_URL = `http://127.0.0.1:${FLOW_PORT}/`

// Per loop: model and effort of its last request, tokens and cost summed over all of them.
const runs = atom({ plugin: 'flightdeck', key: 'runs' } as const, {}, { shape: 'runs-2' })
// Session cost total at the last step end; each step is charged the change since.
const lastUsd = atom({ plugin: 'flightdeck', key: 'lastUsd' } as const, 0)
// Who spawned whom, the messages between them, what each is doing and returned.
const flow = atom({ plugin: 'flightdeck', key: 'flow' } as const, emptyFlow(0), { shape: 'flow-3' })
// Whether this session already auto-opened the browser view: kept in session state,
// so a /reload-plugins does not open it again.
const autoOpened = atom({ plugin: 'flightdeck', key: 'autoOpened' } as const, false)

const slash = (p: string) => p.replace(/\\/g, '/')

// Snapshots live in this plugin's data folder, which every session shares.
async function liveDir($: EngineInterface) {
  return `${slash((await $.process.hookEnv()).CLAUDE_PLUGIN_DATA ?? '')}/live`
}

let timersStarted = false
let writeQueued = false

// Changes the flow and queues the snapshot the browser page reads.
async function editFlow($: EngineInterface, fn: (f: Flow) => Flow) {
  await update($, flow, fn)
  queueSnapshot($)
}

// ponytail: at most one snapshot write per 300 ms; the last change always lands
function queueSnapshot($: EngineInterface) {
  if (writeQueued) return
  writeQueued = true
  $.clock.after(300, () => {
    writeQueued = false
    void writeSnapshot($).catch(err => $.ui.log(`flightdeck: snapshot not written: ${String(err)}`, { to: 'debug' }))
  })
}

async function writeSnapshot($: EngineInterface) {
  const [id, cwd, f, all, now, dir] = await Promise.all([$.session.id(), $.session.cwd(), read($, flow), read($, runs), $.clock.now(), liveDir($)])
  await $.fs.write(`${dir}/${id}.json`, snapshot(f, all, { id, cwd }, now))
}

// The command that starts the server detached, so it outlives this session and
// serves them all; Node.js must be on the PATH.
export function serverArgv(platform: string, script: string, dir: string): string[] {
  if (platform === 'windows') {
    const q = (s: string) => s.replace(/'/g, "''")
    return ['powershell.exe', '-NoProfile', '-Command',
      `Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList '"${q(script)}"','${FLOW_PORT}','"${q(dir)}"'`]
  }
  return ['sh', '-c', 'nohup node "$0" "$1" "$2" >/dev/null 2>&1 &', script, String(FLOW_PORT), dir]
}

// The command that opens a URL in the default browser. WSL reaches the Windows one.
export function openArgv(platform: string, url: string): string[] {
  if (platform === 'windows' || platform === 'wsl') return ['rundll32.exe', 'url.dll,FileProtocolHandler', url]
  if (platform === 'macos') return ['open', url]
  return ['xdg-open', url]
}

// Starts the browser view's server unless one answers already, then opens the page;
// with onlyIfNoPage, only when no page is open (one page serves every session).
async function openFlow($: EngineInterface, onlyIfNoPage = false) {
  const { platform = 'unknown' } = await $.session.info()
  const up = () => $.http.fetch(`${FLOW_URL}ping`).then(r => r.ok, () => false)
  if (!(await up())) {
    await $.process.run(serverArgv(platform, slash(`${$.plugin.root}/server/flightdeck-server.js`), await liveDir($)))
    let i = 0
    while (!(await up())) {
      if (++i > 30) throw new Error(`the server did not answer on port ${FLOW_PORT}; is Node.js 18 or later on your PATH?`)
      await new Promise<void>(r => $.clock.after(100, () => r()))
    }
  }
  await writeSnapshot($)
  if (onlyIfNoPage) {
    // An answer that is not the count (an older server) counts as no page open.
    const open = await $.http.fetch(`${FLOW_URL}status`)
      .then(r => Number((JSON.parse(r.text) as { clients?: unknown }).clients) || 0)
      .catch(() => 0)
    if (open > 0) return
  }
  const id = await $.session.id()
  await $.process.run(openArgv(platform, `${FLOW_URL}?session=${id}`))
}

// An interactive session opens the view on its first turn, once: a page the person
// closes stays closed until they run /flightdeck. A person is at a terminal, the
// desktop app or an editor by then; `claude -p` and SDK runs draw nowhere, and a
// hosted session's machine has no browser of the person's.
async function autoOpen($: EngineInterface) {
  if (await read($, autoOpened)) return
  await update($, autoOpened, () => true)
  if ((await $.session.surfaces()).length === 0 || (await $.session.info()).isHosted) return
  await openFlow($, true).catch(err => $.ui.log(`flightdeck: did not auto-open: ${String(err)}`, { to: 'debug' }))
}

// Registers the command and starts the poll once per module load: from session.start,
// or from the first turn after a /reload-plugins, which loads the module without a
// session.start.
function startTimers($: EngineInterface) {
  if (timersStarted) return
  timersStarted = true
  $.command.register({ name: 'flightdeck', description: 'Open the live agent graph in your browser: agents, tool calls, messages, timeline, files' })
    .catch(err => $.ui.log(`flightdeck: /flightdeck was not registered: ${String(err)}`))
  // ponytail: 2s poll of the agent list and the session's context fill; both are
  // local reads, no model request. Switch to events if one lands for status changes
  $.clock.every(2000, async () => {
    const [all, usage, now, f] = await Promise.all([$.agent.list(), $.session.usage(), $.clock.now(), read($, flow)])
    let next = setContext(setStatuses(f, all, now), usage.context)
    // The /context breakdown, re-estimated locally (`summary`: no requests) when
    // the window's fill moved, or once if this flow has none yet.
    const ctx = (g: typeof f) => g.nodes.find(n => n.id === MAIN)?.ctx
    if (!f.context || ctx(next) !== ctx(f)) {
      const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
      if (b) next = { ...next, context: trimBreakdown(b) }
    }
    if (next !== f) await editFlow($, () => next)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    startTimers($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    startTimers($)
    if (e.agentId === undefined) void autoOpen($)
    return next(e)
  })

  on('command.run', { command: 'flightdeck' }, async $ => {
    startTimers($)
    try {
      await openFlow($)
    } catch (err) {
      return { text: `Flightdeck could not start: ${String(err)}` }
    }
    return { text: `Flightdeck opened in your browser: ${FLOW_URL}` }
  })

  on('agent.spawn', async ($, e, next) => {
    const res = await next(e)
    if (res.agentId) {
      const now = await $.clock.now()
      const a = { id: res.agentId, parent: e.parentAgentId, description: e.description, type: e.subagentType, name: e.name, prompt: e.prompt }
      await editFlow($, f => addAgent(f, a, now))
    }
    return res
  })

  on('session.send', async ($, e, next) => {
    const now = await $.clock.now()
    await editFlow($, f => addMessage(f, { from: e.agentId ?? MAIN, to: e.to, text: e.text, at: now }))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    const started = await $.clock.now()
    let ref = 0
    await editFlow($, f => {
      const g = toolStart(f, id, e.tool, e as unknown as Record<string, unknown>, started)
      ref = g.seq
      return g
    })
    const res = await next(e)
    const now = await $.clock.now()
    const ok = res.deny === undefined && !res.isError
    const input = e as unknown as Record<string, unknown>
    // A backgrounded shell, Monitor or Workflow starts a task; TaskStop kills one.
    const bg = ok ? bgTaskOf(e.tool, input, res.result, id, now) : undefined
    const stopped = ok && e.tool === 'TaskStop' ? (res.result as { task_id?: string } | undefined)?.task_id : undefined
    await editFlow($, f => {
      let g = toolEnd(f, id, e.tool, ref, ok, now - started, now)
      if (bg) g = taskStart(g, bg)
      if (stopped) g = taskEnd(g, stopped, 'killed', now)
      return g
    })
    return res
  })

  // A background task's completion notification ends it.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      const done = parseNotifications(e.text)
      if (done.length) {
        const now = await $.clock.now()
        await editFlow($, f => done.reduce((g, d) => taskEnd(g, d.id, d.status, now), f))
      }
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    startTimers($)
    const res = yield* next(e)
    const u = res.usage
    // ponytail: cost is the session total's change since the last step end, so two
    // agents finishing at the same instant can swap cents; the total stays exact.
    const total = (await $.session.usage()).cost?.usd ?? 0
    let usd = 0
    await update($, lastUsd, prev => {
      usd = Math.max(0, total - (prev ?? 0))
      return total
    })
    const id = e.agentId ?? MAIN
    await update($, runs, all => {
      const was = all[id]
      const run: Run = {
        model: e.model,
        effort: e.effort === undefined ? undefined : String(e.effort),
        inTok: (was?.inTok ?? 0) + (u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0),
        outTok: (was?.outTok ?? 0) + (u?.output_tokens ?? 0),
        usd: (was?.usd ?? 0) + usd,
      }
      return { ...all, [id]: run }
    })
    queueSnapshot($)
    return res
  })

  // A subagent's answer is its output to whoever spawned it.
  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId !== undefined) {
      const id = e.agentId
      const now = await $.clock.now()
      await editFlow($, f => setOutput(f, id, res.text ?? e.answer, now))
    }
    return res
  })
}
