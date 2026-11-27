// Flightdeck: what the hooks record about agents, for the browser view.
// Pure functions only, so each is testable without the engine.
import type { BgTask, Ctx, Flow, FlowEvent, FlowMsg, FlowNode, Run } from '../types'

export const MAIN = 'main'
// ponytail: fixed caps keep the state and the snapshot small; finished agents past
// MAX_NODES leave oldest first, add folding if sessions routinely run more
export const MAX_NODES = 40
export const MAX_EVENTS = 400
const MAX_MESSAGES = 200
const MAX_PROMPT = 1500
const MAX_OUTPUT = 3000
const MAX_TEXT = 400
export const MAX_FILES = 200
const LIVE = new Set(['pending', 'running', 'waiting', 'idle'])
// Tools whose file path counts as a write in the file heatmap; the rest are reads.
const WRITES = new Set(['Edit', 'Write', 'NotebookEdit'])

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export const emptyFlow = (now: number): Flow => ({
  nodes: [{ id: MAIN, parent: '', label: 'main', type: 'session', prompt: '', status: 'running', startedAt: now }],
  messages: [],
  events: [],
  files: {},
  tasks: [],
  seq: 0,
})

const withMain = (f: Flow, now: number): Flow => (f.nodes.some(n => n.id === MAIN) ? f : { ...f, nodes: [...emptyFlow(now).nodes, ...f.nodes] })

const patch = (f: Flow, id: string, fn: (n: FlowNode) => FlowNode): Flow => ({
  ...f,
  nodes: f.nodes.map(n => (n.id === id ? fn(n) : n)),
})

// Appends an event with the next sequence number; the page animates the ones it
// has not seen yet by that number.
const push = (f: Flow, ev: Omit<FlowEvent, 'seq'>): Flow => {
  const seq = f.seq + 1
  return { ...f, seq, events: [...f.events, { ...ev, seq }].slice(-MAX_EVENTS) }
}

// Keeps the newest MAX_NODES: finished agents leave first, main never does.
function trim(nodes: FlowNode[]): FlowNode[] {
  let out = nodes
  while (out.length > MAX_NODES) {
    const i = out.findIndex(n => n.id !== MAIN && !LIVE.has(n.status))
    out = out.filter((_, j) => j !== (i >= 0 ? i : 1))
  }
  return out
}

export function addAgent(
  f: Flow,
  a: { id: string; parent?: string; description: string; type: string; name?: string; prompt: string },
  now: number,
): Flow {
  const base = withMain(f, now)
  const node: FlowNode = {
    id: a.id,
    parent: a.parent ?? MAIN,
    label: a.name ?? a.description ?? a.type,
    type: a.type,
    name: a.name,
    prompt: clip(a.prompt, MAX_PROMPT),
    status: 'running',
    startedAt: now,
  }
  const g = { ...base, nodes: trim([...base.nodes.filter(n => n.id !== a.id), node]) }
  return push(g, { at: now, agent: node.parent, kind: 'spawn', to: a.id, text: clip(a.prompt, MAX_TEXT) })
}

export const addMessage = (f: Flow, m: FlowMsg): Flow => {
  const text = clip(m.text, MAX_TEXT)
  const g = { ...f, messages: [...f.messages, { ...m, text }].slice(-MAX_MESSAGES) }
  return push(g, { at: m.at, agent: m.from, kind: 'msg', to: resolveTo(f, m.to) ?? m.to, text })
}

export const setDoing = (f: Flow, id: string, doing: string): Flow => patch(f, id, n => ({ ...n, doing: clip(doing, 80) }))

const fileOf = (input: Record<string, unknown>) =>
  [input.file_path, input.notebook_path].find(v => typeof v === 'string') as string | undefined

// A tool call starting: the agent's "doing now", an event, and a heatmap count.
// The new event's seq is f.seq afterwards; its result event refers to it.
export function toolStart(f: Flow, id: string, tool: string, input: Record<string, unknown>, now: number): Flow {
  const file = fileOf(input)
  const line = describeCall(tool, input)
  let g = setDoing(f, id, line)
  if (file) {
    const was = g.files[file] ?? { r: 0, w: 0 }
    const files = { ...g.files, [file]: WRITES.has(tool) ? { ...was, w: was.w + 1 } : { ...was, r: was.r + 1 } }
    // ponytail: past MAX_FILES the least touched file leaves; fine for one session
    const keys = Object.keys(files)
    if (keys.length > MAX_FILES) {
      const touches = (k: string) => files[k]!.r + files[k]!.w
      delete files[keys.reduce((a, b) => (touches(a) <= touches(b) ? a : b))]
    }
    g = { ...g, files }
  }
  return push(g, { at: now, agent: id, kind: 'tool', tool, text: clip(line, MAX_TEXT), file })
}

// A tool call answered: whether it failed and how long it took, tied to its start.
export const toolEnd = (f: Flow, id: string, tool: string, ref: number, ok: boolean, ms: number, now: number): Flow =>
  push(f, { at: now, agent: id, kind: 'result', tool, ok, ms, ref, text: '' })

export const setOutput = (f: Flow, id: string, output: string, now: number): Flow => {
  const g = patch(f, id, n => ({ ...n, output: clip(output, MAX_OUTPUT), endedAt: now, doing: undefined, status: n.status === 'running' || n.status === 'idle' ? 'completed' : n.status }))
  const parent = g.nodes.find(n => n.id === id)?.parent ?? MAIN
  return push(g, { at: now, agent: id, kind: 'done', to: parent, text: clip(output, MAX_TEXT) })
}

// A subagent's own task notifications go to that agent, never through the main
// session's prompt, so its tasks are closed when it has really ended (setStatuses):
// status 'ended', outcome not reported. An answer alone does not end them: an agent
// that answered with background work still running waits on it, and resumes.
export function endAgentTasks(f: Flow, agent: string, now: number): Flow {
  if (agent === MAIN || !f.tasks.some(t => t.agent === agent && t.status === 'running')) return f
  return { ...f, tasks: f.tasks.map(t => (t.agent === agent && t.status === 'running' ? { ...t, status: 'ended', endedAt: now } : t)) }
}

// Statuses from $.agent.list(); an agent no longer listed keeps its last status.
// An agent that is finished by that status (completed, failed, killed; listed or no
// longer listed) ends its tasks; one waiting on its own background work keeps them.
// A background agent that answered stays listed as 'idle' while SendMessage can
// resume it: after its answer that is finished, not live; a resume reports 'running'.
// Each listed agent's context fill comes along; one with no window keeps its last.
// A stopped (TaskStop) or failed task shows only in taskStatus; that wins.
type Listed = { id: string; status: string; taskStatus?: string; tokenCount?: number; contextWindowSize?: number }
export function setStatuses(f: Flow, list: readonly Listed[], now: number): Flow {
  const by = new Map(list.map(a => [a.id, a]))
  let changed = false
  const nodes = f.nodes.map(n => {
    const a = by.get(n.id)
    const listed = a?.taskStatus === 'killed' || a?.taskStatus === 'failed' ? a.taskStatus : a?.status
    // Listed idle, or dropped from the list while idle: an answered agent is finished.
    const s = (listed ?? n.status) === 'idle' && n.output !== undefined ? 'completed' : listed
    const ctx = a?.contextWindowSize ? { tokens: a.tokenCount ?? 0, window: a.contextWindowSize } : n.ctx
    const newStatus = !!s && s !== n.status, newCtx = !sameCtx(ctx, n.ctx)
    if (!newStatus && !newCtx) return n
    changed = true
    const g = newCtx ? { ...n, ctx } : n
    return newStatus ? { ...g, status: s, endedAt: LIVE.has(s) ? undefined : (n.endedAt ?? now) } : g
  })
  const g = changed ? { ...f, nodes } : f
  return g.nodes.reduce((h, n) => (LIVE.has(n.status) ? h : endAgentTasks(h, n.id, now)), g)
}

const sameCtx = (a?: Ctx, b?: Ctx) => a?.tokens === b?.tokens && a?.window === b?.window

// The session's context fill ($.session.usage().context) on main; no reading
// yet (a fresh or just compacted window) keeps the last one.
export function setContext(f: Flow, c: { tokens?: number; window: number }): Flow {
  if (c.tokens === undefined || !c.window) return f
  const ctx = { tokens: c.tokens, window: c.window }
  return sameCtx(ctx, f.nodes.find(n => n.id === MAIN)?.ctx) ? f : patch(f, MAIN, n => ({ ...n, ctx }))
}

// The node a message's `to` names: an agent's id or its SendMessage name.
export const resolveTo = (f: Flow, to: string) => f.nodes.find(n => n.id === to || n.name === to)?.id

// A short "doing now" line from a tool call's arguments.
export function describeCall(tool: string, input: Record<string, unknown>): string {
  const arg = ['command', 'file_path', 'pattern', 'description', 'url', 'prompt', 'query', 'skill']
    .map(k => input[k])
    .find(v => typeof v === 'string') as string | undefined
  return arg ? `${tool} ${arg.replace(/\s+/g, ' ')}` : tool
}

// --- background tasks ------------------------------------------------------------

// ponytail: the newest MAX_TASKS; finished ones leave first
export const MAX_TASKS = 30
const BG_TOOLS: Record<string, BgTask['kind']> = { Bash: 'shell', Monitor: 'monitor', Workflow: 'workflow' }

// The background task a tool call started, from its input and result; undefined
// when it started none (a foreground Bash, any other tool).
export function bgTaskOf(tool: string, input: Record<string, unknown>, result: unknown, agent: string, now: number): BgTask | undefined {
  const kind = BG_TOOLS[tool]
  const r = (result ?? {}) as Record<string, unknown>
  const id = r.backgroundTaskId ?? r.taskId
  if (!kind || typeof id !== 'string') return undefined
  const label = [input.description, r.workflowName, input.name, input.command]
    .find(v => typeof v === 'string' && v.trim() !== '') as string | undefined
  return { id, kind, label: clip((label ?? tool).replace(/\s+/g, ' '), 120), agent, status: 'running', startedAt: now }
}

export function taskStart(f: Flow, t: BgTask): Flow {
  let tasks = [...f.tasks.filter(x => x.id !== t.id), t]
  while (tasks.length > MAX_TASKS) {
    const i = tasks.findIndex(x => x.status !== 'running')
    tasks = tasks.filter((_, j) => j !== (i >= 0 ? i : 0))
  }
  return { ...f, tasks }
}

// Ends a task this flow knows; any other id (an agent's) leaves the flow as it was.
export function taskEnd(f: Flow, id: string, status: string, now: number): Flow {
  if (!f.tasks.some(t => t.id === id && t.status === 'running')) return f
  return { ...f, tasks: f.tasks.map(t => (t.id === id ? { ...t, status, endedAt: now } : t)) }
}

// The task ids and statuses a task notification's text reports.
export function parseNotifications(text: string): { id: string; status: string }[] {
  const out: { id: string; status: string }[] = []
  for (const block of text.split('</task-notification>')) {
    const id = /<task-id>([^<]+)<\/task-id>/.exec(block)?.[1]?.trim()
    const status = /<status>([^<]+)<\/status>/.exec(block)?.[1]?.trim()
    if (id && status) out.push({ id, status })
  }
  return out
}

// What the browser page reads: the flow plus each loop's model, effort and cost.
export const snapshot = (f: Flow, runs: Record<string, Run>, session: { id: string; cwd: string }, now: number) =>
  JSON.stringify({ v: 1, session, updatedAt: now, flow: f, runs })
