// dsh-usage-card — pure host plugin.
// 1) registers GET /usage-status.json (peak status + balance + today's spend)
// 2) injects lib/card.js into index.html via webServer.tapIndex
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// DeepSeek official pricing per 1M tokens (CNY), peak/off-peak.
// Peak: Beijing 9:00-12:00, 14:00-18:00. Off-peak otherwise.
const PRICES = {
  flash: { input: { peak: 3.0, off: 1.5 }, read: { peak: 0.1, off: 0.05 }, out: { peak: 9.0, off: 4.5 } },
  pro: { input: { peak: 9.0, off: 4.5 }, read: { peak: 0.3, off: 0.15 }, out: { peak: 27.0, off: 13.5 } },
  other: { input: { peak: 3.0, off: 1.5 }, read: { peak: 0.1, off: 0.05 }, out: { peak: 9.0, off: 4.5 } },
}

const isPeakAt = (timeMs) => {
  const bj = new Date(timeMs + 8 * 3600 * 1000)
  const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  return (mins >= 540 && mins < 720) || (mins >= 840 && mins < 1080)
}

const bucketOf = (model) => {
  const m = String(model || '').toLowerCase()
  if (m.includes('pro')) return 'pro'
  if (m.includes('flash')) return 'flash'
  return 'other'
}

const priceOf = (bucket, kind, peak) => {
  const table = PRICES[bucket]
  if (!table || !table[kind]) return 0
  return peak ? table[kind].peak : table[kind].off
}

export const inject = ['webServer', 'sessionPersistence']

export function apply(ctx) {
  const webServer = ctx.webServer

  // Cache-miss reporting state: fingerprints of usage events already surfaced
  // to the page. The first poll seeds the set (so a page load / route return
  // does NOT replay old misses); only misses that appear AFTER the seed are
  // reported as fresh and trigger the floating "-¥" animation.
  let seeded = false
  const reportedMisses = new Set()
  const MISS_WINDOW_MS = 5 * 60 * 1000 // a miss is "fresh" within 5 min of its event time

  // Pricing per event: the whole request is billed at the rate active when it
  // STARTED (the request/header timestamp), mirroring official behavior.
  // costSince(startMs) sums today's cost per model bucket across both live
  // in-memory sessions and every persisted session on disk, DEDUPLICATING
  // usage events by fingerprint so redundant session copies (fork / restore /
  // shadow files) are never double-counted.
  const costSince = async (startMs) => {
    const acc = { flash: 0, pro: 0, other: 0, total: 0 }
    // cacheReadTokens per request: non-zero means the input hit the context
    // cache; zero means the request was billed at full uncached input price.
    const reqCacheRead = { yes: 0, no: 0 }
    // potential saving if uncached input had hit the cache (input price - read price)
    let missedSaving = 0
    const seen = new Set() // usage event fingerprints across all sources
    const missEvents = [] // { fp, time, saving } for cache-missed requests

    const fold = (events) => {
      let currentModel = null
      let requestPeak = null
      for (const ev of events) {
        if (!ev || typeof ev.time !== 'number' || ev.time < startMs) continue
        if (ev.type === 'request/context' && ev.data && typeof ev.data.model === 'string') {
          currentModel = ev.data.model
        } else if (ev.type === 'request/header' && ev.data && ev.data.header && ev.data.header.config) {
          const cfg = ev.data.header.config
          if (typeof cfg.model === 'string') currentModel = cfg.model
          requestPeak = isPeakAt(ev.time) // rate fixed at request start
        } else if (ev.type === 'assistant/message' && ev.data && ev.data.usage) {
          const u = ev.data.usage
          if (!u) continue
          // Deduplicate: the same usage event may appear in the live session
          // and in one or more persisted copies of the same session.
          const fp = [ev.seq, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens].join(':')
          if (seen.has(fp)) continue
          seen.add(fp)
          const bucket = bucketOf(currentModel)
          const peakFlag = requestPeak === null ? isPeakAt(ev.time) : requestPeak
          const cost =
            (u.inputTokens || 0) * priceOf(bucket, 'input', peakFlag) +
            (u.cacheReadTokens || 0) * priceOf(bucket, 'read', peakFlag) +
            (u.cacheWriteTokens || 0) * priceOf(bucket, 'input', peakFlag) +
            (u.outputTokens || 0) * priceOf(bucket, 'out', peakFlag)
          acc[bucket] += cost
          acc.total += cost

          const uncached = u.inputTokens || 0
          const read = u.cacheReadTokens || 0
          if (uncached > 0) {
            reqCacheRead.no += 1
            const saving = uncached * (priceOf(bucket, 'input', peakFlag) - priceOf(bucket, 'read', peakFlag))
            missedSaving += saving
            missEvents.push({ fp, time: ev.time, saving })
          } else if (read > 0) {
            reqCacheRead.yes += 1
          }
        }
      }
    }

    // 1) live in-memory sessions
    const sessions = ctx.get('sessions')
    if (sessions !== undefined) {
      for (const session of sessions.list()) fold(session.events)
    }

    // 2) persisted sessions on disk (historical sessions not held in memory)
    const persistence = ctx.get('sessionPersistence')
    if (persistence !== undefined) {
      try {
        const headers = await persistence.list()
        for (const header of headers) {
          try {
            const { events } = await persistence.readFrom(header.id, 0)
            fold(events)
          } catch (e) { /* skip unreadable session */ }
        }
      } catch (e) { /* listing failed; live-only */ }
    }

    for (const k of Object.keys(acc)) acc[k] /= 1e6
    missedSaving /= 1e6

    // Which of today's misses are NEW (not yet surfaced)? First poll seeds
    // everything so nothing replays; later polls only report misses that
    // arrived after the seed AND within the freshness window.
    if (!seeded) {
      for (const m of missEvents) reportedMisses.add(m.fp)
      seeded = true
    }
    const now = Date.now()
    let freshSaving = 0
    let freshCount = 0
    for (const m of missEvents) {
      if (reportedMisses.has(m.fp)) continue
      if (now - m.time > MISS_WINDOW_MS) continue // too old to be "just happened"
      reportedMisses.add(m.fp)
      freshSaving += m.saving
      freshCount += 1
    }
    freshSaving /= 1e6

    return { ...acc, cache: reqCacheRead, missedSaving, freshSaving, freshCount }
  }

  const statusJson = async () => {
    const now = Date.now()
    const bj = new Date(now + 8 * 3600 * 1000)
    const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes()
    const peak = (mins >= 540 && mins < 720) || (mins >= 840 && mins < 1080)

    let balance = null
    const credentials = ctx.get('credentials')
    const shell = ctx.get('shell')
    if (credentials !== undefined && shell !== undefined) {
      try {
        const cred = await credentials.resolve('DEEPSEEK_API_KEY')
        if (cred && typeof cred.value === 'string' && cred.value !== '') {
          const spec = shell.resolve({
            command: 'curl -s --max-time 10 https://api.deepseek.com/user/balance -H "Authorization: Bearer $DEEPSEEK_API_KEY"',
            env: { DEEPSEEK_API_KEY: cred.value },
            stdoutMaxBytes: 4096,
          })
          const result = await shell.run(spec)
          if (result.exitCode === 0 && result.stdout.text) {
            const data = JSON.parse(result.stdout.text)
            const info = data && data.balance_infos && data.balance_infos[0]
            if (info) balance = { currency: String(info.currency || 'CNY'), total: Number(info.total_balance) }
          }
        }
      } catch (e) {
        // keep balance null
      }
    }

    let today = { flash: null, pro: null, other: null, total: null }
    try {
      today = await costSince(new Date().setHours(0, 0, 0, 0))
    } catch (e) { /* keep nulls */ }

    return JSON.stringify({ peak, balance, today })
  }

  // 1) JSON route for the injected script
  const disposeRoute = webServer.register({
    kind: 'exact',
    path: '/usage-status.json',
    handler: async (_req, res) => {
      try {
        const body = await statusJson()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(body)
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(String(e && e.message || e))
      }
    },
  })

  // 2) inject the card script into every index.html response
  let script = null
  const disposeTap = webServer.tapIndex((html) => {
    if (script === null) {
      try { script = readFileSync(join(here, 'card.js'), 'utf8') } catch (e) { script = '' }
    }
    if (script === '') return html
    const tag = '<script>' + script.replace(/<\/script>/gi, '<\\/script>') + '</script>'
    if (html.includes('<head>')) return html.replace('<head>', '<head>' + tag)
    return tag + html
  })

  return () => { disposeRoute(); disposeTap() }
}
