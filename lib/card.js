// Self-contained card injected into the DSH web page by the usage-card host
// plugin (webServer.tapIndex). No build tooling, no client module system:
// plain DOM + fetch of the plugin's /usage-status.json route.
// The card is draggable (grab the title bar) and resizable (drag the
// bottom-right handle); position/size persist in localStorage.
(function () {
  if (window.__dsuCardInstalled) return
  window.__dsuCardInstalled = true

  var CARD_ID = 'dsu-status-card'
  var styleId = 'dsu-status-card-style'
  var LS_KEY = 'dsu-card-geometry'
  var CARD_MIN_W = 170
  var CARD_MIN_H = 96

  // ── geometry persistence ────────────────────────────────────────────────
  function loadGeometry() {
    try {
      var raw = localStorage.getItem(LS_KEY)
      if (!raw) return null
      var g = JSON.parse(raw)
      if (typeof g !== 'object' || g === null) return null
      return {
        left: typeof g.left === 'number' ? g.left : null,
        top: typeof g.top === 'number' ? g.top : null,
        width: typeof g.width === 'number' ? g.width : null,
        height: typeof g.height === 'number' ? g.height : null,
      }
    } catch (e) { return null }
  }
  function saveGeometry(g) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(g)) } catch (e) {}
  }

  function ensureStyle() {
    if (document.getElementById(styleId)) return
    var css = [
      '#' + CARD_ID + '{position:fixed;left:8px;bottom:68px;z-index:1000;box-sizing:border-box;width:252px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#d0d0d0);border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.96));color:var(--dsw-alias-label-primary,#1a1a1a);font:12px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.12);user-select:none;display:none}',
      '#' + CARD_ID + '.dsu-visible{display:block}',
      '#' + CARD_ID + '.dsu-dragging{opacity:.85;transition:none}',
      '#' + CARD_ID + ' .dsu-title{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;margin-bottom:2px;cursor:grab}',
      '#' + CARD_ID + ' .dsu-title:active{cursor:grabbing}',
      '#' + CARD_ID + ' .dsu-title-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#' + CARD_ID + ' .dsu-btn{margin-left:auto;flex:none;width:20px;height:20px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;border-radius:5px;cursor:pointer;color:inherit;opacity:.55;padding:0;pointer-events:auto}',
      '#' + CARD_ID + ' .dsu-btn:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '#' + CARD_ID + ' .dsu-btn svg{width:13px;height:13px;display:block}',
      '#' + CARD_ID + ' .dsu-refresh.dsu-spin svg{animation:dsu-spin .8s linear infinite}',
      '@keyframes dsu-spin{to{transform:rotate(360deg)}}',
      '#' + CARD_ID + ' .dsu-dot{width:8px;height:8px;border-radius:50%;flex:none}',
      '#' + CARD_ID + ' .dsu-dot.peak{background:var(--dsw-alias-state-error-primary,#e5484d)}',
      '#' + CARD_ID + ' .dsu-dot.free{background:var(--dsw-alias-state-success-primary,#30a46c)}',
      '#' + CARD_ID + ' .dsu-body{overflow:auto;max-height:calc(100vh - 90px)}',
      '#' + CARD_ID + ' .dsu-row{display:flex;align-items:center;gap:6px;min-width:0;position:relative}',
      '#' + CARD_ID + ' .dsu-key{opacity:.7;flex:none}',
      '#' + CARD_ID + ' .dsu-val{margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '#' + CARD_ID + ' .dsu-save-anim{position:absolute;right:0;top:-14px;font-weight:700;font-size:12px;color:var(--dsw-alias-state-error-primary,#e5484d);opacity:0;pointer-events:none;white-space:nowrap}',
      '#' + CARD_ID + ' .dsu-row.dsu-anim .dsu-save-anim{animation:dsu-float-up 1.6s ease-out forwards}',
      '@keyframes dsu-float-up{0%{opacity:0;transform:translateY(6px)}15%{opacity:1}60%{opacity:1;transform:translateY(-4px)}100%{opacity:0;transform:translateY(-18px)}}',
      '#' + CARD_ID + ' .dsu-row.dsu-anim .dsu-val{animation:dsu-flash 1.6s ease-out}',
      '@keyframes dsu-flash{0%{color:var(--dsw-alias-state-error-primary,#e5484d)}100%{color:inherit}}',
      '#' + CARD_ID + ' .dsu-resize{position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:se-resize;pointer-events:auto}',
      '#' + CARD_ID + ' .dsu-resize::after{content:"";position:absolute;right:3px;bottom:3px;width:7px;height:7px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;opacity:.45;border-bottom-right-radius:2px}',
      '#' + CARD_ID + ' .dsu-resize:hover::after{opacity:.9}'
    ].join('\n')
    var el = document.createElement('style')
    el.id = styleId
    el.textContent = css
    document.head.appendChild(el)
  }

  function fmtMoney(n) {
    if (typeof n !== 'number' || isNaN(n)) return '—'
    if (n > 0 && n < 0.005) return '¥<0.01'
    return '¥' + n.toFixed(2)
  }

  function fmtBalance(b) {
    if (!b || typeof b.total !== 'number' || isNaN(b.total)) return '—'
    var symbol = b.currency === 'CNY' ? '¥' : (b.currency ? b.currency + ' ' : '')
    return symbol + b.total.toFixed(2)
  }

  // ── drag / resize wiring ────────────────────────────────────────────────
  // Event delegation on the card element itself: survives innerHTML rebuilds
  // in render() because the listener lives on the persistent card node.
  function attachInteractions(card) {
    if (card.__dsuWired) return
    card.__dsuWired = true

    card.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return
      var target = e.target

      // move: grab the title bar
      if (target.closest && target.closest('.dsu-title')) {
        e.preventDefault()
        var startX = e.clientX
        var startY = e.clientY
        var rect = card.getBoundingClientRect()
        var origLeft = rect.left
        var origTop = rect.top
        var moved = false
        card.classList.add('dsu-dragging')

        function onMove(ev) {
          var nl = Math.min(Math.max(origLeft + ev.clientX - startX, 0), window.innerWidth - 40)
          var nt = Math.min(Math.max(origTop + ev.clientY - startY, 0), window.innerHeight - 40)
          card.style.left = nl + 'px'
          card.style.top = nt + 'px'
          card.style.bottom = 'auto'
          moved = true
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
          card.classList.remove('dsu-dragging')
          if (moved) {
            var r = card.getBoundingClientRect()
            var g = currentGeometry(card)
            g.left = r.left
            g.top = r.top
            saveGeometry(g)
          }
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
        return
      }

      // resize: drag the bottom-right handle
      if (target.closest && target.closest('.dsu-resize')) {
        e.preventDefault()
        e.stopPropagation()
        var sX = e.clientX
        var sY = e.clientY
        var sW = card.offsetWidth
        var sH = card.offsetHeight
        card.classList.add('dsu-dragging')

        function rMove(ev) {
          var nw = Math.max(CARD_MIN_W, Math.min(sW + ev.clientX - sX, window.innerWidth - 16))
          var nh = Math.max(CARD_MIN_H, Math.min(sH + ev.clientY - sY, window.innerHeight - 16))
          card.style.width = nw + 'px'
          card.style.height = nh + 'px'
        }
        function rUp() {
          document.removeEventListener('mousemove', rMove)
          document.removeEventListener('mouseup', rUp)
          card.classList.remove('dsu-dragging')
          var g = currentGeometry(card)
          g.width = card.offsetWidth
          g.height = card.offsetHeight
          saveGeometry(g)
        }
        document.addEventListener('mousemove', rMove)
        document.addEventListener('mouseup', rUp)
      }
    })
  }

  function currentGeometry(card) {
    var g = loadGeometry() || {}
    return {
      left: typeof g.left === 'number' ? g.left : null,
      top: typeof g.top === 'number' ? g.top : null,
      width: typeof g.width === 'number' ? g.width : null,
      height: typeof g.height === 'number' ? g.height : null,
    }
  }

  function render(data) {
    var card = document.getElementById(CARD_ID)
    if (!card) return
    if (!data || typeof data !== 'object') { card.classList.remove('dsu-visible'); return }

    var peak = typeof data.peak === 'boolean' ? data.peak : null
    var today = data.today || {}
    var freshSaving = typeof today.freshSaving === 'number' ? today.freshSaving : 0
    var freshCount = typeof today.freshCount === 'number' ? today.freshCount : 0

    card.innerHTML =
      '<div class="dsu-title">' +
      '<span class="dsu-dot ' + (peak === false ? 'free' : 'peak') + '"></span>' +
      '<span class="dsu-title-text">' + (peak === null ? '高峰查询中…' : (peak ? '当前是高峰时段' : '当前是空闲时段')) + '</span>' +
      '<button class="dsu-btn dsu-refresh" title="刷新余额" aria-label="刷新余额">' +
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2v3h-3"/></svg>' +
      '</button>' +
      '</div>' +
      '<div class="dsu-body">' +
      '<div class="dsu-row"><span class="dsu-key">余额</span><span class="dsu-val">' + fmtBalance(data.balance) + '</span></div>' +
      '<div class="dsu-row" id="dsu-row-flash"><span class="dsu-key">今日 Flash</span><span class="dsu-val">' + fmtMoney(today.flash) + '</span>' +
      (freshCount > 0 && freshSaving > 0 ? '<span class="dsu-save-anim">未命中 +¥' + freshSaving.toFixed(2) + '</span>' : '') +
      '</div>' +
      '<div class="dsu-row"><span class="dsu-key">今日 Pro</span><span class="dsu-val">' + fmtMoney(today.pro) + '</span></div>' +
      '</div>' +
      '<div class="dsu-resize" title="拖动调整大小"></div>'

    card.classList.add('dsu-visible')
    attachInteractions(card)

    // Only animate when NEW cache misses just happened (freshCount > 0) — a
    // page load or route return does NOT replay historical misses.
    var flashRow = document.getElementById('dsu-row-flash')
    if (flashRow && freshCount > 0 && freshSaving > 0) {
      flashRow.classList.add('dsu-anim')
      setTimeout(function () { flashRow.classList.remove('dsu-anim') }, 1800)
    }

    var btn = card.querySelector('.dsu-refresh')
    if (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        btn.classList.add('dsu-spin')
        load(function () { btn.classList.remove('dsu-spin') })
      })
    }
  }

  function load(done) {
    fetch('/usage-status.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (data) { render(data); if (done) done() })
      .catch(function () { if (done) done(); var card = document.getElementById(CARD_ID); if (card) card.classList.remove('dsu-visible') })
  }

  function boot() {
    ensureStyle()
    var card = document.createElement('div')
    card.id = CARD_ID
    document.body.appendChild(card)

    // restore persisted geometry
    var g = loadGeometry()
    if (g) {
      if (typeof g.left === 'number' && typeof g.top === 'number') {
        card.style.left = g.left + 'px'
        card.style.top = g.top + 'px'
        card.style.bottom = 'auto'
      }
      if (typeof g.width === 'number') card.style.width = g.width + 'px'
      if (typeof g.height === 'number') card.style.height = g.height + 'px'
    }

    load()
    setInterval(load, 10000)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
