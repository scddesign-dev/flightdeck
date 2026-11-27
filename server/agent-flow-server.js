#!/usr/bin/env node
// Agent flow server: serves the browser page and streams each session's snapshot
// file (written by the agent-flow plugin) to it over server-sent events.
// No dependencies. Usage: node agent-flow-server.js <port> <snapshot dir>
'use strict'
const fs = require('fs')
const path = require('path')
const http = require('http')

const PORT = Number(process.argv[2]) || 4123
const DIR = process.argv[3]
if (!DIR) { console.error('usage: node agent-flow-server.js <port> <snapshot folder>'); process.exit(2) }
const PAGE = path.join(__dirname, 'index.html')
const DAY = 24 * 3600 * 1000
// ponytail: exits after an hour with no page open and no request; /agent-flow restarts it
const IDLE_EXIT_MS = 3600 * 1000
const POLL_MS = 250

let clients = 0
let lastSeen = Date.now()

const fileOf = id => (/^[A-Za-z0-9_-]{1,100}$/.test(id) ? path.join(DIR, `${id}.json`) : null)

function sessions() {
  let names = []
  try { names = fs.readdirSync(DIR).filter(n => n.endsWith('.json')) } catch { return [] }
  const now = Date.now()
  const out = []
  for (const name of names) {
    const file = path.join(DIR, name)
    let st
    try { st = fs.statSync(file) } catch { continue }
    // Snapshots of sessions untouched for a week are deleted; two days are listed.
    if (now - st.mtimeMs > 7 * DAY) { try { fs.unlinkSync(file) } catch {} continue }
    if (now - st.mtimeMs > 2 * DAY) continue
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'))
      out.push({ id: s.session.id, cwd: s.session.cwd, updatedAt: s.updatedAt, agents: s.flow.nodes.length - 1 })
    } catch {}
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

function stream(req, res, file) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  clients++
  let mtime = 0
  const tick = () => {
    let st
    try { st = fs.statSync(file) } catch { return }
    if (st.mtimeMs === mtime) return
    let text
    try { text = fs.readFileSync(file, 'utf8'); JSON.parse(text) } catch { return } // mid-write: next tick
    mtime = st.mtimeMs
    res.write(`data: ${text}\n\n`)
  }
  tick()
  const poll = setInterval(tick, POLL_MS)
  const beat = setInterval(() => res.write(': beat\n\n'), 15000)
  req.on('close', () => { clearInterval(poll); clearInterval(beat); clients--; lastSeen = Date.now() })
}

const server = http.createServer((req, res) => {
  lastSeen = Date.now()
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/ping') return res.end('ok')
  // How many pages are open: a session that starts opens one only when none is.
  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ clients }))
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
    return fs.createReadStream(PAGE).pipe(res)
  }
  if (url.pathname === '/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(sessions()))
  }
  if (url.pathname === '/stream') {
    const file = fileOf(url.searchParams.get('session') || '')
    if (!file) { res.writeHead(400); return res.end('bad session') }
    return stream(req, res, file)
  }
  res.writeHead(404)
  res.end()
})

// Another session already started one: that one serves every session.
server.on('error', err => process.exit(err.code === 'EADDRINUSE' ? 0 : 1))
server.listen(PORT, '127.0.0.1')
setInterval(() => { if (clients === 0 && Date.now() - lastSeen > IDLE_EXIT_MS) process.exit(0) }, 60000).unref()
