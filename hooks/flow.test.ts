import { expect, test } from 'claude-code/testing'

import {
  MAX_EVENTS, MAX_FILES, MAX_NODES, MAX_TASKS, addAgent, addMessage, bgTaskOf, describeCall, emptyFlow,
  parseNotifications, resolveTo, setContext, setOutput, setStatuses, snapshot, taskEnd, taskStart, toolEnd, toolStart,
} from './flow'

const spawn = (id: string, parent?: string, name?: string) =>
  ({ id, parent, description: `task ${id}`, type: 'general-purpose', name, prompt: `do ${id}` })

test('a message resolves its target by SendMessage name or id', () => {
  let f = addAgent(emptyFlow(0), spawn('a1', undefined, 'researcher'), 1)
  f = addMessage(f, { from: 'main', to: 'researcher', text: 'look at X', at: 2 })
  expect(resolveTo(f, 'researcher')).toBe('a1')
  expect(resolveTo(f, 'a1')).toBe('a1')
  expect(resolveTo(f, 'nobody')).toBeUndefined()
  // The event names the resolved loop, so the page can draw the edge.
  expect(f.events.at(-1)).toMatchObject({ kind: 'msg', agent: 'main', to: 'a1', text: 'look at X' })
})

test('spawns, tool calls, results and outputs become numbered events', () => {
  let f = addAgent(emptyFlow(0), spawn('a', undefined, 'finder'), 1)
  f = addAgent(f, spawn('b', 'a'), 2)
  f = toolStart(f, 'b', 'Grep', { pattern: 'findCallers' }, 3)
  const ref = f.seq
  f = toolEnd(f, 'b', 'Grep', ref, false, 40, 4)
  f = setOutput(f, 'b', 'found 4', 5)
  expect(f.events.map(e => `${e.seq}:${e.kind}:${e.agent}>${e.to ?? ''}`)).toEqual([
    '1:spawn:main>a', '2:spawn:a>b', '3:tool:b>', '4:result:b>', '5:done:b>a',
  ])
  expect(f.events[3]).toMatchObject({ ref: 3, ok: false, ms: 40 })
  expect(f.nodes.find(n => n.id === 'b')).toMatchObject({ status: 'completed', output: 'found 4', doing: undefined })
})

test('a tool call sets the doing-now line while it runs', () => {
  const f = toolStart(addAgent(emptyFlow(0), spawn('a'), 1), 'a', 'Bash', { command: 'npm test' }, 2)
  expect(f.nodes[1]!.doing).toBe('Bash npm test')
})

test('the file heatmap counts reads and writes per path, capped', () => {
  let f = emptyFlow(0)
  f = toolStart(f, 'main', 'Read', { file_path: 'a.ts' }, 1)
  f = toolStart(f, 'main', 'Edit', { file_path: 'a.ts' }, 2)
  f = toolStart(f, 'main', 'Edit', { file_path: 'a.ts' }, 3)
  f = toolStart(f, 'main', 'NotebookEdit', { notebook_path: 'n.ipynb' }, 4)
  f = toolStart(f, 'main', 'Bash', { command: 'ls' }, 5)
  expect(f.files).toEqual({ 'a.ts': { r: 1, w: 2 }, 'n.ipynb': { r: 0, w: 1 } })
  for (let i = 0; i < MAX_FILES + 5; i++) f = toolStart(f, 'main', 'Read', { file_path: `f${i}` }, 6)
  expect(Object.keys(f.files).length).toBe(MAX_FILES)
  // The most touched file stays.
  expect(f.files['a.ts']).toEqual({ r: 1, w: 2 })
})

test('events keep the newest MAX_EVENTS; seq keeps counting', () => {
  let f = emptyFlow(0)
  for (let i = 0; i < MAX_EVENTS + 10; i++) f = toolStart(f, 'main', 'Bash', { command: 'x' }, i)
  expect(f.events.length).toBe(MAX_EVENTS)
  expect(f.seq).toBe(MAX_EVENTS + 10)
  expect(f.events[0]!.seq).toBe(11)
})

test('output ends a running agent; the agent list wins after that', () => {
  let f = addAgent(emptyFlow(0), spawn('a'), 1)
  f = setOutput(f, 'a', 'found 3 files', 9)
  expect(f.nodes[1]).toMatchObject({ status: 'completed', output: 'found 3 files', endedAt: 9 })
  f = setStatuses(f, [{ id: 'a', status: 'failed' }], 10)
  expect(f.nodes[1]!.status).toBe('failed')
  // Unchanged statuses keep the same object, so nothing is written.
  expect(setStatuses(f, [{ id: 'a', status: 'failed' }], 11)).toBe(f)
})

test('an agent that answered and sits idle (resumable) counts as finished; resumed, it is live again', () => {
  let f = addAgent(emptyFlow(0), spawn('a'), 1)
  f = setOutput(f, 'a', 'done', 2)
  f = setStatuses(f, [{ id: 'a', status: 'idle' }], 3)
  expect(f.nodes[1]).toMatchObject({ status: 'completed', endedAt: 2 })
  // Idle seen before the answer arrives: the answer still finishes it.
  let g = addAgent(emptyFlow(0), spawn('b'), 1)
  g = setStatuses(g, [{ id: 'b', status: 'idle' }], 2)
  g = setOutput(g, 'b', 'done', 3)
  expect(g.nodes[1]!.status).toBe('completed')
  // A SendMessage resumes it: running again, then a second answer finishes it.
  f = setStatuses(f, [{ id: 'a', status: 'running' }], 4)
  expect(f.nodes[1]).toMatchObject({ status: 'running', endedAt: undefined })
  f = setOutput(f, 'a', 'again', 5)
  expect(f.nodes[1]!.status).toBe('completed')
  // A snapshot from 0.2.0 holds answered agents stuck at 'idle': the next poll finishes them.
  const stuck: typeof f = { ...f, nodes: f.nodes.map(n => (n.id === 'a' ? { ...n, status: 'idle', endedAt: undefined } : n)) }
  expect(setStatuses(stuck, [{ id: 'a', status: 'idle' }], 6).nodes[1]).toMatchObject({ status: 'completed', endedAt: 6 })
  // ...and so does one the agent list has since dropped.
  expect(setStatuses(stuck, [], 7).nodes[1]).toMatchObject({ status: 'completed', endedAt: 7 })
})

test('past the cap the oldest finished agents leave, never main or live ones', () => {
  let f = emptyFlow(0)
  f = addAgent(f, spawn('done1'), 1)
  f = setOutput(f, 'done1', 'x', 2)
  for (let i = 0; i < MAX_NODES; i++) f = addAgent(f, spawn(`live${i}`), 3 + i)
  expect(f.nodes.length).toBe(MAX_NODES)
  expect(f.nodes[0]!.id).toBe('main')
  expect(f.nodes.some(n => n.id === 'done1')).toBe(false)
})

test('a tool call becomes a short doing-now line', () => {
  expect(describeCall('Bash', { command: 'npm   test\n --silent' })).toBe('Bash npm test --silent')
  expect(describeCall('Read', { file_path: 'a.ts' })).toBe('Read a.ts')
  expect(describeCall('TodoWrite', { todos: [] })).toBe('TodoWrite')
})

test('a backgrounded Bash, Monitor or Workflow becomes a task; anything else does not', () => {
  expect(bgTaskOf('Bash', { command: 'npm   test', description: 'Run tests', run_in_background: true }, { backgroundTaskId: 'b1' }, 'main', 5))
    .toEqual({ id: 'b1', kind: 'shell', label: 'Run tests', agent: 'main', status: 'running', startedAt: 5 })
  // No description: the command, on one line.
  expect(bgTaskOf('Bash', { command: 'npm\n test' }, { backgroundTaskId: 'b2' }, 'a1', 5)?.label).toBe('npm test')
  expect(bgTaskOf('Monitor', { description: 'watch log' }, { taskId: 'm1' }, 'main', 5)?.kind).toBe('monitor')
  expect(bgTaskOf('Workflow', {}, { taskId: 'w1', workflowName: 'review-changes' }, 'main', 5)).toMatchObject({ kind: 'workflow', label: 'review-changes' })
  // A foreground Bash and other tools start none.
  expect(bgTaskOf('Bash', { command: 'ls' }, { stdout: '' }, 'main', 5)).toBeUndefined()
  expect(bgTaskOf('TaskUpdate', {}, { taskId: 't1' }, 'main', 5)).toBeUndefined()
})

test('a task ends once, by id; unknown ids leave the flow alone', () => {
  let f = taskStart(emptyFlow(0), bgTaskOf('Bash', { command: 'x' }, { backgroundTaskId: 'b1' }, 'main', 1)!)
  expect(taskEnd(f, 'agent-xyz', 'completed', 2)).toBe(f)
  f = taskEnd(f, 'b1', 'failed', 3)
  expect(f.tasks[0]).toMatchObject({ status: 'failed', endedAt: 3 })
  // A second notification for the same task changes nothing.
  expect(taskEnd(f, 'b1', 'completed', 4)).toBe(f)
})

test('an agent ending closes its still-running tasks as ended; a waiting one keeps them', () => {
  const task = (id: string, agent: string) => ({ id, kind: 'shell' as const, label: id, agent, status: 'running', startedAt: 0 })
  let f = addAgent(emptyFlow(0), spawn('a1'), 1)
  f = addAgent(f, spawn('a2'), 1)
  f = addAgent(f, spawn('a3'), 1)
  for (const t of [task('s1', 'a1'), task('s2', 'a1'), task('s3', 'a2'), task('s4', 'main'), task('s5', 'a3')]) f = taskStart(f, t)
  f = taskEnd(f, 's2', 'completed', 2)
  // a1 and a3 answer; a3 left background work running, so the agent list says it waits.
  f = setOutput(f, 'a1', 'done', 5)
  f = setOutput(f, 'a3', 'done, sleep left running', 5)
  // An answer alone ends nothing.
  expect(f.tasks.map(t => t.status)).toEqual(['running', 'completed', 'running', 'running', 'running'])
  f = setStatuses(f, [{ id: 'a1', status: 'completed' }, { id: 'a2', status: 'running' }, { id: 'a3', status: 'waiting' }], 6)
  expect(f.tasks.map(t => `${t.id}:${t.status}`)).toEqual(['s1:ended', 's2:completed', 's3:running', 's4:running', 's5:running'])
  expect(f.tasks[0]!.endedAt).toBe(6)
  // A killed agent ends its tasks; so does one gone from the list after answering.
  f = setStatuses(f, [{ id: 'a2', status: 'killed' }], 7)
  expect(f.tasks.find(t => t.id === 's3')!.status).toBe('ended')
  f = setStatuses(f, [{ id: 'a3', status: 'completed' }], 8)
  expect(f.tasks.find(t => t.id === 's5')!.status).toBe('ended')
  // Main's tasks end only by notification or TaskStop.
  expect(f.tasks.find(t => t.id === 's4')!.status).toBe('running')
  // Nothing left to end: the same object, so nothing is written.
  expect(setStatuses(f, [{ id: 'a1', status: 'completed' }], 9)).toBe(f)
})

test('past MAX_TASKS finished tasks leave first', () => {
  let f = taskStart(emptyFlow(0), { id: 'old', kind: 'shell', label: 'x', agent: 'main', status: 'running', startedAt: 0 })
  f = taskStart(f, { id: 'done', kind: 'shell', label: 'x', agent: 'main', status: 'running', startedAt: 0 })
  f = taskEnd(f, 'done', 'completed', 1)
  for (let i = 0; i < MAX_TASKS; i++) f = taskStart(f, { id: `t${i}`, kind: 'shell', label: 'x', agent: 'main', status: 'running', startedAt: 2 })
  expect(f.tasks.length).toBe(MAX_TASKS)
  expect(f.tasks.some(t => t.id === 'done')).toBe(false)
})

test('a task notification gives each task id and status', () => {
  const text = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>\n'
    + '<task-notification><task-id>b2</task-id><output-file>x</output-file><status>failed</status></task-notification>'
  expect(parseNotifications(text)).toEqual([{ id: 'b1', status: 'completed' }, { id: 'b2', status: 'failed' }])
  expect(parseNotifications('hello')).toEqual([])
})

test('the snapshot carries the session, the flow and the runs', () => {
  const f = addAgent(emptyFlow(0), spawn('a'), 1)
  const s = JSON.parse(snapshot(f, { a: { model: 'm', inTok: 1, outTok: 2, usd: 0.5 } }, { id: 'sid', cwd: 'C:/r' }, 9))
  expect(s).toMatchObject({ v: 1, session: { id: 'sid', cwd: 'C:/r' }, updatedAt: 9, runs: { a: { usd: 0.5 } } })
  expect(s.flow.nodes.length).toBe(2)
})

test('the agent list records each agent context fill; unchanged readings write nothing', () => {
  let f = addAgent(emptyFlow(0), spawn('a'), 1)
  f = setStatuses(f, [{ id: 'a', status: 'running', tokenCount: 50_000, contextWindowSize: 200_000 }], 2)
  expect(f.nodes[1]!.ctx).toEqual({ tokens: 50_000, window: 200_000 })
  expect(setStatuses(f, [{ id: 'a', status: 'running', tokenCount: 50_000, contextWindowSize: 200_000 }], 3)).toBe(f)
  // No window reported (no model yet): the last reading stays.
  expect(setStatuses(f, [{ id: 'a', status: 'running', tokenCount: 9 }], 4)).toBe(f)
  // Dropped from the list: the last reading stays too.
  expect(setStatuses(f, [], 5).nodes[1]!.ctx).toEqual({ tokens: 50_000, window: 200_000 })
})

test('the session context fill lands on main; no reading yet or unchanged writes nothing', () => {
  const f = setContext(emptyFlow(0), { tokens: 120_000, window: 200_000 })
  expect(f.nodes[0]!.ctx).toEqual({ tokens: 120_000, window: 200_000 })
  expect(setContext(f, { tokens: 120_000, window: 200_000 })).toBe(f)
  expect(setContext(f, { window: 200_000 })).toBe(f)
})

test('a stopped or failed task wins over the loop status, answered or not', () => {
  let f = addAgent(emptyFlow(0), spawn('a'), 1)
  f = setOutput(f, 'a', 'partial', 2)
  f = setStatuses(f, [{ id: 'a', status: 'idle', taskStatus: 'killed' }], 3)
  expect(f.nodes[1]).toMatchObject({ status: 'killed', endedAt: 2 })
  const g = setStatuses(addAgent(emptyFlow(0), spawn('b'), 1), [{ id: 'b', status: 'completed', taskStatus: 'failed' }], 4)
  expect(g.nodes[1]).toMatchObject({ status: 'failed', endedAt: 4 })
})
