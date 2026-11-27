export type Run = { model: string; effort?: string; inTok: number; outTok: number; usd: number }

// One loop in the agent flow: the main session ('main') or an agent it or another spawned.
export type FlowNode = {
  id: string
  parent: string
  label: string
  type: string
  name?: string
  prompt: string
  status: string
  startedAt: number
  endedAt?: number
  doing?: string
  output?: string
  // Context window fill: main from the session, an agent from the agent list.
  ctx?: Ctx
}
export type Ctx = { tokens: number; window: number }
// The main session's window as /context breaks it down (a local estimate): its
// rows, its grid (f: fullness 0-1, n: the row it belongs to), and the
// heaviest entries of each list beneath it.
export type Breakdown = {
  total: number
  window: number
  percent: number
  compactAt?: number
  model: string
  rows: { name: string; tokens: number; color: string; kind: string }[]
  grid: { f: number; n: string }[][]
  lists: Record<string, { name: string; tokens: number }[]>
}
// A message one loop sent another; `to` is the address as written (a name or an id).
export type FlowMsg = { from: string; to: string; text: string; at: number }
// One thing that happened, in order: the browser page animates each new one.
// `agent` is the loop it happened in; `to` the loop it went to (spawn, msg, done);
// `ref` on a result is the seq of the tool event it answers.
export type FlowEvent = {
  seq: number
  at: number
  agent: string
  kind: 'spawn' | 'msg' | 'tool' | 'result' | 'done'
  text: string
  to?: string
  tool?: string
  file?: string
  ok?: boolean
  ms?: number
  ref?: number
}
// A background task that is not an agent: a backgrounded shell command, a
// Monitor or a Workflow. `agent` is the loop that started it.
export type BgTask = {
  id: string
  kind: 'shell' | 'monitor' | 'workflow'
  label: string
  agent: string
  status: string
  startedAt: number
  endedAt?: number
}
export type Flow = {
  nodes: FlowNode[]
  messages: FlowMsg[]
  events: FlowEvent[]
  // Per file path: tool calls that read it and that wrote it.
  files: Record<string, { r: number; w: number }>
  tasks: BgTask[]
  seq: number
  context?: Breakdown
}

declare module 'claude-code' {
  interface PluginState {
    'flightdeck': {
      runs: Shaped<Record<string, Run>>
      lastUsd: number
      flow: Shaped<Flow>
      autoOpened: boolean
    }
  }
}
