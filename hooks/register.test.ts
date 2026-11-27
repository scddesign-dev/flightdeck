import { expect, test } from 'claude-code/testing'

import { openArgv, serverArgv } from './register'

// The test runner has timers; the engine's types (no DOM, no Node) do not declare them.
declare function setTimeout(fn: (value?: unknown) => void, ms: number): unknown

const DATA = 'C:/data/agent-flow'
const RUN_OK = { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }

// What every test answers: the session, its clock and this plugin's data folder.
const base = (on: any, platform = 'windows', isHosted = false) => {
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('session.info', () => ({ value: { transcriptPath: '', platform, isHosted } }))
  on('agent.list', () => ({ value: [] }))
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: DATA } }))
  // Timers fire as soon as they are asked: a queued snapshot write lands at once.
  on('clock.after', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name } }))
}
const lastWrite = async (writes: { path: string; text: string }[]) => {
  for (let i = 0; i < 100 && writes.length === 0; i++) await new Promise(r => setTimeout(r, 10))
  await new Promise(r => setTimeout(r, 50))
  return writes.at(-1)!
}

test('spawns, messages, tool calls and outputs reach the snapshot in the data folder', async ($, on) => {
  let t = 1000
  const writes: { path: string; text: string }[] = []
  base(on)
  on('clock.now', () => ({ value: t }))
  on('fs.write', (_, e) => { writes.push(e); return { value: undefined } })
  on('agent.spawn', (_, e) => ({ model: 'claude-haiku-5-5', agentId: e.description === 'Find callers' ? 'a1' : 'a2' }))
  on('session.send', () => ({ isDelivered: true }) as never)
  on('tool.call', (_, e: any) => (e.pattern === 'boom' ? { result: {}, isError: true } : { result: {} }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }))

  const spawn = (description: string, name: string, parentAgentId?: string) =>
    $.agent.spawn({ prompt: `${description} please`, description, subagentType: 'Explore', name, parentAgentId, background: true } as never)
  await spawn('Find callers', 'finder')
  t = 2000
  await spawn('Check tests', 'checker', 'a1')
  t = 3000
  await $.session.send({ to: 'checker', text: 'look in tests/unit', origin: { kind: 'model' }, agentId: 'a1' } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'findCallers', agentId: 'a2' } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'boom', agentId: 'a2' } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'src/a.ts', old_string: 'x', new_string: 'y', agentId: 'a2' } as never)
  t = 4000
  await $.turn.complete({ answer: 'found 4 callers', durationMs: 1, isAborted: false, turnId: 't', reason: 'end_turn', agentId: 'a1' } as never)

  const last = await lastWrite(writes)
  // The engine hands the path on in the platform's own separators.
  expect(last.path.split(String.fromCharCode(92)).join('/')).toBe(`${DATA}/live/sid-1.json`)
  const s = JSON.parse(last.text)
  expect(s.session).toEqual({ id: 'sid-1', cwd: 'C:/repo' })
  const ev = s.flow.events.map((e: any) => `${e.kind}:${e.agent}>${e.to ?? e.tool}${e.ok === false ? '!' : ''}`)
  expect(ev).toEqual([
    'spawn:main>a1', 'spawn:a1>a2', 'msg:a1>a2',
    'tool:a2>Grep', 'result:a2>Grep', 'tool:a2>Grep', 'result:a2>Grep!', 'tool:a2>Edit', 'result:a2>Edit',
    'done:a1>main',
  ])
  expect(s.flow.files).toEqual({ 'src/a.ts': { r: 0, w: 1 } })
  expect(s.flow.nodes.find((n: any) => n.id === 'a1')).toMatchObject({ status: 'completed', output: 'found 4 callers' })
})

test('background tasks start from their tool call and end on a notification or TaskStop', async ($, on) => {
  let t = 1000
  const writes: { path: string; text: string }[] = []
  base(on)
  on('clock.now', () => ({ value: t }))
  on('fs.write', (_, e) => { writes.push(e); return { value: undefined } })
  on('tool.call', (_, e: any) => {
    if (e.tool === 'Bash') return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: e.command === 'npm test' ? 'b1' : 'b2' } } as never
    if (e.tool === 'TaskStop') return { result: { message: 'stopped', task_id: e.task_id, task_type: 'local_bash' } } as never
    return { result: {} } as never
  })
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)

  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run tests', run_in_background: true } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true, agentId: 'a1' } as never)
  t = 5000
  await $.prompt.submit({ text: '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' }, wait: false } as never)
  // The same text typed by the person is not a notification.
  await $.prompt.submit({ text: '<task-notification><task-id>b2</task-id><status>completed</status></task-notification>', origin: { kind: 'user' }, wait: false } as never)
  t = 6000
  const tasks = async () => JSON.parse((await lastWrite(writes)).text).flow.tasks.map((x: any) => `${x.id}:${x.kind}:${x.agent}:${x.status}:${x.label}`)
  expect(await tasks()).toEqual(['b1:shell:main:completed:Run tests', 'b2:shell:a1:running:npm run dev'])
  await $.tool.call({ tool: 'TaskStop', task_id: 'b2' } as never)
  expect(await tasks()).toEqual(['b1:shell:main:completed:Run tests', 'b2:shell:a1:killed:npm run dev'])
})

test('the server starts detached on every platform; quotes in paths survive', () => {
  const win = serverArgv('windows', "C:/Users/O'Neil/p/server/agent-flow-server.js", 'C:/d/live')
  expect(win.slice(0, 3)).toEqual(['powershell.exe', '-NoProfile', '-Command'])
  expect(win[3]).toContain('Start-Process -WindowStyle Hidden')
  expect(win[3]).toContain("O''Neil")
  expect(serverArgv('macos', '/p/s.js', '/d/live')).toEqual(['sh', '-c', 'nohup node "$0" "$1" "$2" >/dev/null 2>&1 &', '/p/s.js', '4123', '/d/live'])
  expect(serverArgv('linux', '/p/s.js', '/d/live')[0]).toBe('sh')
})

test('the page opens in the default browser on every platform', () => {
  const url = 'http://127.0.0.1:4123/?session=s'
  expect(openArgv('windows', url)).toEqual(['rundll32.exe', 'url.dll,FileProtocolHandler', url])
  expect(openArgv('wsl', url)[0]).toBe('rundll32.exe')
  expect(openArgv('macos', url)).toEqual(['open', url])
  expect(openArgv('linux', url)).toEqual(['xdg-open', url])
})

const flowCommand = async ($: any, on: any, serverUp: boolean[], platform = 'windows') => {
  const runs: string[][] = []
  let pings = 0
  base(on, platform)
  on('clock.now', () => ({ value: 1 }))
  on('fs.write', () => ({ value: undefined }))
  on('http.fetch', (_: unknown, e: any) => {
    expect(e.url).toBe('http://127.0.0.1:4123/ping')
    if (!serverUp[Math.min(pings++, serverUp.length - 1)]) return { deny: 'ECONNREFUSED' }
    return { value: { status: 200, ok: true, headers: {}, text: 'ok' } }
  })
  on('process.run', (_: unknown, e: any) => { runs.push([...e.argv]); return RUN_OK })
  const res = await $.command.run({ command: 'agent-flow', args: '' } as never)
  return { res, runs }
}

test('/agent-flow starts the server when none answers, then opens the browser', async ($, on) => {
  const { res, runs } = await flowCommand($, on, [false, false, true], 'macos')
  expect(res.text).toBe('Agent flow opened in your browser: http://127.0.0.1:4123/')
  expect(runs.length).toBe(2)
  expect(runs[0]![0]).toBe('sh')
  expect(runs[0]![3]).toMatch(/\/server\/agent-flow-server\.js$/)
  expect(runs[0]![5]).toBe(`${DATA}/live`)
  expect(runs[1]).toEqual(['open', 'http://127.0.0.1:4123/?session=sid-1'])
})

test('/agent-flow reuses a server that already answers', async ($, on) => {
  const { runs } = await flowCommand($, on, [true])
  expect(runs).toEqual([['rundll32.exe', 'url.dll,FileProtocolHandler', 'http://127.0.0.1:4123/?session=sid-1']])
})

test('/agent-flow says so when the server never answers', async ($, on) => {
  const { res, runs } = await flowCommand($, on, [false])
  expect(res.text).toMatch(/could not start: .*Node\.js/)
  // Only the start was tried: no page opened onto nothing.
  expect(runs.length).toBe(1)
})

// A session's turns, with a server that answers and `pages` browser pages open.
const autoTurns = async ($: any, on: any, opts: { surfaces: string[]; pages: number; hosted?: boolean; turns: (string | undefined)[] }) => {
  const runs: string[][] = []
  base(on, 'windows', !!opts.hosted)
  on('session.surfaces', () => ({ value: opts.surfaces }))
  on('clock.now', () => ({ value: 1 }))
  on('fs.write', () => ({ value: undefined }))
  on('http.fetch', (_: unknown, e: any) => ({ value: { status: 200, ok: true, headers: {}, text: e.url.endsWith('/status') ? JSON.stringify({ clients: opts.pages }) : 'ok' } }))
  on('process.run', (_: unknown, e: any) => { runs.push([...e.argv]); return RUN_OK })
  on('turn.start', (_: unknown, e: any) => ({ text: e.text, turnId: e.turnId }) as never)
  for (const [i, agentId] of opts.turns.entries()) {
    await $.turn.start({ text: 'hi', turnId: `t${i}`, agentId } as never)
    // The open runs in the background of the turn: give it time to land.
    await new Promise(r => setTimeout(r, 60))
  }
  return runs.filter(r => r[0] === 'rundll32.exe')
}
const OPEN = ['rundll32.exe', 'url.dll,FileProtocolHandler', 'http://127.0.0.1:4123/?session=sid-1']

test('the first turn opens the view once; a closed page stays closed', async ($, on) => {
  expect(await autoTurns($, on, { surfaces: ['desktop'], pages: 0, turns: [undefined, undefined, 'a1'] })).toEqual([OPEN])
})

test('a session does not open a second page while one is open', async ($, on) => {
  expect(await autoTurns($, on, { surfaces: ['terminal'], pages: 1, turns: [undefined] })).toEqual([])
})

test('a -p or SDK run, which draws nowhere, opens nothing', async ($, on) => {
  expect(await autoTurns($, on, { surfaces: [], pages: 0, turns: [undefined] })).toEqual([])
})

test('a hosted session opens nothing', async ($, on) => {
  expect(await autoTurns($, on, { surfaces: ['desktop'], pages: 0, hosted: true, turns: [undefined] })).toEqual([])
})

test('a subagent turn does not open the view', async ($, on) => {
  expect(await autoTurns($, on, { surfaces: ['desktop'], pages: 0, turns: ['a1'] })).toEqual([])
})
