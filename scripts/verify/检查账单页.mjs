/**
 * 第 4 阶段「账单列表 + 编辑 + 删除 + 筛选搜索」的界面客观验证。
 *
 * 按 CLAUDE.md §九：真启动打包版本，用 Electron 调试接口（CDP）
 * 在真实渲染进程里读 DOM、驱动真实点击。
 *
 * 这个脚本要盯住的是**「当场看不出来」的错**：
 *   - 搜索框里的 % 和 _ 被当成通配符 —— 搜「%」把全部账单都搜出来，
 *     用户以为搜到了东西，其实什么都没筛掉；
 *   - 改完一笔账，列表底下的合计没跟着变 —— 数字对不上，月底才发现；
 *   - 翻月跨年翻错（1 月往前是上一年 12 月）；
 *   - 编辑弹窗里的金额框和记账页的金额框重名 —— 验证脚本会以为自己
 *     检查了弹窗，其实抓到的是记账页那个（还藏在 hidden 里）。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE node "scripts/verify/检查账单页.mjs"
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { rmSync } from 'node:fs'

const PORT = 9222
const PROJECT = join(import.meta.dirname, '..', '..')
const ELECTRON = join(PROJECT, 'node_modules', 'electron', 'dist', 'electron.exe')
const USER_DATA = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'HTJizhang')

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const HELPERS = String.raw`
window.__T = {
  norm(s) { return String(s || '').replace(/\s+/g, ' ').trim() },
  one(t) { return document.querySelector('[data-testid="' + t + '"]') },
  count(t) { return document.querySelectorAll('[data-testid="' + t + '"]').length },
  byRe(re) {
    return Array.prototype.slice
      .call(document.querySelectorAll('[data-testid]'))
      .filter(function (e) { return re.test(e.dataset.testid) })
  },
  // 在某个子树里找。编辑弹窗里的 pick-* 标识和记账页重名，必须先框住范围。
  inScope(outer, inner) {
    var root = this.one(outer)
    return root ? root.querySelector('[data-testid="' + inner + '"]') : null
  },
  rows() { return this.byRe(/^list-row-[0-9]+$/) },
  rowIds() { return this.rows().map(function (e) { return Number(e.dataset.testid.slice(9)) }) },
  label(el) { return window.__T.norm(el && el.innerText) },
  // 按标识取值的几个便捷方法。**找不到元素时返回 null 而不是抛错** ——
  // 元素整个不见了（比如标识被改坏）时，抛错会直接中止整个脚本、
  // 把后面还没跑的检查项全遮住；返回 null 只会让对应那条判为失败。
  text(t) { var e = this.one(t); return e ? e.textContent : null },
  val(t) { var e = this.one(t); return e ? e.value : null },
  attr(t, name) { var e = this.one(t); return e ? e.getAttribute(name) : null },
  disabled(t) { var e = this.one(t); return e ? e.disabled : null },
  click(el) { if (el) el.click() },
  setInput(el, v) {
    // 元素不在（标识被改坏）时安静地返回 false，让对应检查项判失败，
    // 而不是抛错把整个脚本拖停 —— 那样后面还没跑的项目就全被遮住了。
    if (!el) return false
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  },
  /**
   * 读出元素的实际渲染颜色，换算成「色相」（0–360 度）。
   *
   * Tailwind v4 输出的是 oklch()，不是 rgb()，所以两种写法都得能认。
   * 用色相判断红/绿最稳：红在 27 度附近、绿在 149 度附近，差得很远；
   * 亮度彩度会随明暗主题变，色相不会 —— 照着 rgb 写断言必然误报（§九）。
   */
  hue(el) {
    var s = getComputedStyle(el).color
    var o = s.match(/oklch\(([^)]+)\)/)
    if (o) return Number(o[1].trim().split(/\s+/)[2])
    var m = s.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/)
    if (!m) return null
    var r = +m[1] / 255, g = +m[2] / 255, b = +m[3] / 255
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
    if (d === 0) return null
    var h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
    h *= 60
    return h < 0 ? h + 360 : h
  },
  sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
}
'ok'
`

async function getTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://localhost:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 还没起来 */
    }
    await sleep(500)
  }
  throw new Error('等了 30 秒也没等到调试接口')
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        p(msg)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    const ex = res.result?.exceptionDetails
    if (ex) throw new Error(`页面执行出错：${ex.exception?.description ?? JSON.stringify(ex)}`)
    return res.result?.result?.value
  }
}

async function launch() {
  const child = spawn(
    ELECTRON,
    [join(PROJECT, 'out', 'main', 'index.js'), `--remote-debugging-port=${PORT}`],
    {
      cwd: PROJECT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  const target = await getTarget()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  await sleep(900)
  await cdp.evaluate(HELPERS)
  return { child, ws, cdp }
}

/** 点左侧导航切页。 */
async function goto(cdp, label) {
  await cdp.evaluate(`
    (function () {
      var btns = Array.prototype.slice.call(document.querySelectorAll('nav button'))
      var t = btns.find(function (b) { return window.__T.norm(b.innerText).indexOf(${JSON.stringify(label)}) >= 0 })
      if (t) t.click()
    })()
  `)
  await sleep(800)
}

/** 往搜索框里打字。查询没有防抖，打一次字就查一次，等一会儿让结果回来。 */
async function search(cdp, text) {
  await cdp.evaluate(`window.__T.setInput(window.__T.one('list-search'), ${JSON.stringify(text)})`)
  await sleep(650)
}

/** 工具：把当前列表的概况取回来，省得每次都写一长串表达式。 */
async function snapshot(cdp) {
  const raw = await cdp.evaluate(`
    (function () {
      return JSON.stringify({
        total: window.__T.label(window.__T.one('list-total')),
        month: window.__T.label(window.__T.one('list-month')),
        rowIds: window.__T.rowIds(),
        summary: window.__T.label(window.__T.one('list-summary')),
        empty: window.__T.label(window.__T.one('list-empty')),
        thisMonthDisabled: window.__T.one('list-this-month')
          ? window.__T.one('list-this-month').disabled
          : null
      })
    })()
  `)
  return JSON.parse(raw)
}

async function main() {
  console.log('\n【第 4 阶段 账单列表 — 界面客观验证】\n')

  // 清掉上一次残留，否则「首次打开」这类检查失去意义（scripts/verify/README.md）
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(join(USER_DATA, `ht-jizhang.db${suffix}`), { force: true })
  }
  console.log(`  · 已清空测试数据库：${join(USER_DATA, 'ht-jizhang.db')}\n`)

  let session = await launch()
  let { cdp } = session

  let today = ''
  let month = ''
  let otherDay = ''
  let prevMonth = ''
  const id = {}

  try {
    // ---------- 0. 造数据 ----------
    // 走界面自己用的那条 IPC 写进去，不是直接改数据库文件。
    const seed = await cdp.evaluate(`
      (async function () {
        var today = await window.ht.transactions.today()
        var month = today.slice(0, 7)
        // 同月但不同的一天。今天是 1 号就退到 2 号，免得两组撞成同一组。
        var otherDay = today.slice(8) === '01' ? month + '-02' : month + '-01'
        // 上个月 10 号
        var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7))
        var t = y * 12 + (m - 1) - 1
        var prevMonth = String(Math.floor(t / 12)).padStart(4, '0') + '-' +
          String((t % 12) + 1).padStart(2, '0')

        var tree = await window.ht.categories.list()
        function leaf(pName, kName) {
          var p = tree.find(function (c) { return c.name === pName })
          if (!p) return null
          var k = p.children.find(function (c) { return c.name === kName })
          return k ? k.id : null
        }
        var ids = {
          lunch: leaf('餐饮', '午餐'),
          taxi: leaf('交通', '打车网约车'),
          salary: leaf('工资薪酬', '月薪'),
          dinner: leaf('餐饮', '晚餐')
        }
        if (!ids.lunch || !ids.taxi || !ids.salary || !ids.dinner) {
          return JSON.stringify({ error: '内置分类没找齐：' + JSON.stringify(ids) })
        }

        async function add(kind, yuan, categoryId, occurredOn, note, paymentMethod) {
          var r = await window.ht.transactions.create({
            kind: kind,
            amountFen: Math.round(yuan * 100),
            categoryId: categoryId,
            occurredOn: occurredOn,
            note: note,
            paymentMethod: paymentMethod
          })
          return r.id
        }

        var tx = {}
        tx.a = await add('expense', 28.5, ids.lunch, today, '公司楼下快餐', 'alipay')
        tx.b = await add('expense', 120, ids.taxi, today, '打车', 'wechat')
        tx.c = await add('income', 8000, ids.salary, today, '十月工资', 'bank')
        tx.d = await add('expense', 66, ids.dinner, otherDay, '折扣100%_优惠', 'cash')
        tx.e = await add('expense', 15, ids.dinner, prevMonth + '-10', '上个月的外卖', 'wechat')

        var restaurant = tree.find(function (c) { return c.name === '餐饮' })

        return JSON.stringify({
          today: today, month: month, otherDay: otherDay, prevMonth: prevMonth,
          ids: ids, tx: tx, lunchIcon: restaurant ? restaurant.icon : ''
        })
      })()
    `)
    const seeded = JSON.parse(seed)
    if (seeded.error) throw new Error(seeded.error)
    today = seeded.today
    month = seeded.month
    otherDay = seeded.otherDay
    prevMonth = seeded.prevMonth
    Object.assign(id, seeded.tx)
    const lunchId = seeded.ids.lunch
    const lunchIcon = seeded.lunchIcon

    check('造好了 5 笔测试账（本月 4 笔、上月 1 笔）', Object.keys(id).length === 5, `本月 ${month}，今天 ${today}`)

    // ---------- 1. 进入账单页的默认状态 ----------
    await goto(cdp, '账单')
    let s = await snapshot(cdp)

    check(
      `打开账单页默认显示本月 ${month.slice(0, 4)}年${Number(month.slice(5))}月`,
      s.month === `${month.slice(0, 4)}年${Number(month.slice(5))}月`,
      s.month
    )
    check('共 4 笔（上个月那笔不在本月列表里）', s.total === '共 4 笔', s.total)
    check('看的本来就是本月时，「回到本月」是灰的', s.thisMonthDisabled === true)
    check('列表里就是本月那 4 笔，上个月那笔没混进来', s.rowIds.length === 4, s.rowIds.join(','))

    // ---------- 2. 按天分组、当天小计 ----------
    const dayGroups = await cdp.evaluate(`JSON.stringify(window.__T.byRe(/^list-day-[0-9]{4}-[0-9]{2}-[0-9]{2}$/).map(function (e) { return e.dataset.testid.slice(9) }))`)
    const days = JSON.parse(dayGroups)
    check('按天分了组，分成两天', days.length === 2, days.join(' / '))
    check('日期从新到旧（今天在前）', days[0] === today && days[1] === otherDay, days.join(' / '))

    const todaySum = await cdp.evaluate(`window.__T.label(window.__T.one('list-day-sum-${today}'))`)
    check(
      '今天的当天小计：支出 148.50、收入 8,000.00',
      todaySum.includes('148.50') && todaySum.includes('8,000.00'),
      todaySum
    )
    const otherSum = await cdp.evaluate(`window.__T.label(window.__T.one('list-day-sum-${otherDay}'))`)
    check('另一天的当天小计：只有支出 66.00，没有收入', otherSum.includes('66.00') && !otherSum.includes('收入'), otherSum)

    // ---------- 3. 一行的内容 ----------
    const rowA = await cdp.evaluate(`window.__T.label(window.__T.one('list-row-${id.a}'))`)
    const rowOk = ['午餐', '餐饮', '公司楼下快餐', '支付宝'].every((w) => rowA.includes(w))
    check('一行里有：小类名、大类名、备注、支付方式', rowOk, rowA)

    // ⚠️ 这条原来只断言「第一个子元素的文字不是空的」，是空转的：
    // 真把图标那一段删掉，children[0] 会变成分类名（「午餐 餐饮」）仍然非空，
    // 检查照样通过 —— 图标没了却报「通过」。改成比对真实的图标字符。
    const rowIcon = await cdp.evaluate(`
      (function () {
        var el = window.__T.one('list-row-${id.a}')
        return window.__T.norm(el.children[0] && el.children[0].textContent)
      })()
    `)
    check(
      '一行里有大类图标，而且就是「餐饮」的图标',
      rowIcon === lunchIcon && lunchIcon !== '',
      `行的第一个元素是「${rowIcon}」，餐饮的图标是「${lunchIcon}」`
    )

    // ---------- 4. 金额的符号与颜色 ----------
    const amtA = await cdp.evaluate(`window.__T.text('list-amount-${id.a}')`)
    const amtC = await cdp.evaluate(`window.__T.text('list-amount-${id.c}')`)
    check('支出金额带负号', amtA.startsWith('-') && amtA.includes('28.50'), amtA)
    check('收入金额带正号', amtC.startsWith('+') && amtC.includes('8,000.00'), amtC)

    const hueA = await cdp.evaluate(`window.__T.hue(window.__T.one('list-amount-${id.a}'))`)
    const hueC = await cdp.evaluate(`window.__T.hue(window.__T.one('list-amount-${id.c}'))`)
    check('支出金额是红的（色相在红色区）', hueA !== null && hueA < 60, `色相 ${hueA}`)
    check('收入金额是绿的（色相在绿色区）', hueC !== null && hueC > 120, `色相 ${hueC}`)

    // ---------- 5. 底部合计 ----------
    check(
      '底部合计：支出 214.50、收入 8,000.00、结余 7,785.50',
      s.summary.includes('214.50') && s.summary.includes('8,000.00') && s.summary.includes('7,785.50'),
      s.summary
    )

    // ---------- 6. 全部 / 支出 / 收入 筛选 ----------
    await cdp.evaluate(`window.__T.click(window.__T.one('list-filter-expense'))`)
    await sleep(600)
    s = await snapshot(cdp)
    check('切到「支出」只剩 3 笔', s.total === '共 3 笔', s.total)
    check('切到「支出」后收入那笔不见了', !s.rowIds.includes(id.c), s.rowIds.join(','))

    // 用户 2026-10-04 拍板：筛成支出时合计只显示支出那一项。
    // 三项都显示的话收入会显示 0.00 —— 明明这个月有收入，用户会读成「我没有收入」。
    const expenseSummary = await cdp.evaluate(`
      JSON.stringify({
        text: window.__T.label(window.__T.one('list-summary')),
        rows: window.__T.byRe(/^list-sum-[^ ]+$/).map(function (e) { return e.dataset.testid.slice(9) })
      })
    `)
    const es = JSON.parse(expenseSummary)
    check(
      '筛成「支出」时，合计里只有支出，没有收入 0.00 和结余',
      es.rows.join(',') === '支出' && !es.text.includes('收入') && !es.text.includes('结余'),
      `${es.rows.join('/')} —— ${es.text}`
    )
    check('筛成「支出」时的合计数字是这个月真实的支出 214.50', es.text.includes('214.50'), es.text)

    await cdp.evaluate(`window.__T.click(window.__T.one('list-filter-income'))`)
    await sleep(600)
    s = await snapshot(cdp)
    check('切到「收入」只剩 1 笔', s.total === '共 1 笔', s.total)
    check('切到「收入」后只剩工资那笔', s.rowIds.length === 1 && s.rowIds[0] === id.c, s.rowIds.join(','))

    await cdp.evaluate(`window.__T.click(window.__T.one('list-filter-all'))`)
    await sleep(600)
    s = await snapshot(cdp)
    check('切回「全部」又是 4 笔', s.total === '共 4 笔', s.total)

    // ---------- 7. 搜索 ----------
    await search(cdp, '快餐')
    s = await snapshot(cdp)
    check('按备注搜「快餐」→ 只中那 1 笔', s.total === '共 1 笔' && s.rowIds[0] === id.a, s.total)

    await search(cdp, '午餐')
    s = await snapshot(cdp)
    check('按分类名搜「午餐」也能搜到（搜索覆盖分类名，不只备注）', s.total === '共 1 笔' && s.rowIds[0] === id.a, s.total)

    await search(cdp, '餐饮')
    s = await snapshot(cdp)
    check('按大类名搜「餐饮」→ 中 2 笔', s.total === '共 2 笔', `${s.total}（${s.rowIds.join(',')}）`)

    // 这一条是重点：LIKE 里的 % 是通配符。不转义的话「%」会把全部 4 笔都搜出来，
    // 用户以为自己搜到了什么，其实什么都没筛掉。
    await search(cdp, '%')
    s = await snapshot(cdp)
    check(
      '搜索框里的 % 按字面找，不是通配符（只中备注里真有 % 的那笔）',
      s.total === '共 1 笔' && s.rowIds[0] === id.d,
      `${s.total}（${s.rowIds.join(',')}）`
    )

    await search(cdp, '_')
    s = await snapshot(cdp)
    check(
      '搜索框里的 _ 按字面找，不是「任意一个字」',
      s.total === '共 1 笔' && s.rowIds[0] === id.d,
      `${s.total}（${s.rowIds.join(',')}）`
    )

    await search(cdp, '100%_')
    s = await snapshot(cdp)
    check('% 和 _ 混在词中间也照样按字面找', s.total === '共 1 笔' && s.rowIds[0] === id.d, s.total)

    await search(cdp, 'zzz不存在')
    s = await snapshot(cdp)
    check('搜不到时显示「没有找到包含…的账单」', s.empty.includes('没有找到包含「zzz不存在」的账单'), s.empty)

    // 清掉搜索，回到全部
    await search(cdp, '')
    s = await snapshot(cdp)
    check('清空搜索框后 4 笔都回来了', s.total === '共 4 笔', s.total)

    // ---------- 8. 点一行打开编辑窗口 ----------
    await cdp.evaluate(`window.__T.click(window.__T.one('list-row-${id.a}'))`)
    await sleep(700)

    const opened = await cdp.evaluate(`!!window.__T.one('edit-dialog')`)
    check('点一行打开了编辑窗口', opened === true)

    // 防重名：四个页面常驻挂载，记账页的金额框一直在文档里。
    // 弹窗里的金额框要是也叫 amount，脚本抓到的会是记账页那个（还藏在 hidden 里）。
    const amountIds = await cdp.evaluate(`
      (function () {
        var addPage = window.__T.one('amount')
        var dialog = window.__T.one('edit-amount')
        return JSON.stringify({
          addCount: window.__T.count('amount'),
          dlgCount: window.__T.count('edit-amount'),
          same: addPage === dialog,
          samePayment: window.__T.one('payment-wechat') === window.__T.one('edit-payment-wechat')
        })
      })()
    `)
    const ai = JSON.parse(amountIds)
    check('弹窗里的金额框和记账页的金额框不是同一个元素', ai.same === false, JSON.stringify(ai))
    check('两个金额框的标识各自唯一（没有重名）', ai.addCount === 1 && ai.dlgCount === 1, JSON.stringify(ai))
    check('弹窗里的支付方式按钮和记账页的也不是同一个元素', ai.samePayment === false)

    const filled = await cdp.evaluate(`
      (function () {
        return JSON.stringify({
          amount: window.__T.val('edit-amount'),
          note: window.__T.val('edit-note'),
          date: window.__T.val('edit-date'),
          expensePressed: window.__T.attr('edit-kind-expense', 'aria-pressed'),
          incomePressed: window.__T.attr('edit-kind-income', 'aria-pressed'),
          alipay: window.__T.attr('edit-payment-alipay', 'aria-pressed'),
          wechat: window.__T.attr('edit-payment-wechat', 'aria-pressed'),
          leafSelected: (function () {
            var el = window.__T.inScope('edit-dialog', 'pick-leaf-${lunchId}')
            return el ? el.getAttribute('aria-pressed') : '没有这个元素'
          })()
        })
      })()
    `)
    const f = JSON.parse(filled)
    check('弹窗里金额是这一笔的 28.50', f.amount === '28.50', f.amount)
    check('弹窗里备注是这一笔的', f.note === '公司楼下快餐', f.note)
    check('弹窗里日期是这一笔的', f.date === today, f.date)
    check('弹窗里「支出」是选中的', f.expensePressed === 'true' && f.incomePressed === 'false', JSON.stringify(f))
    check('弹窗里支付方式是这一笔的支付宝', f.alipay === 'true' && f.wechat === 'false', JSON.stringify(f))
    check('弹窗里分类停在原来那个「午餐」上', f.leafSelected === 'true', String(f.leafSelected))

    // ---------- 9. 改一笔并保存 ----------
    await cdp.evaluate(`
      (function () {
        window.__T.setInput(window.__T.one('edit-amount'), '99.99')
        window.__T.setInput(window.__T.one('edit-note'), '改过的备注')
      })()
    `)
    await sleep(300)
    await cdp.evaluate(`window.__T.click(window.__T.one('edit-save'))`)
    await sleep(1200)

    check('保存后编辑窗口自己关了', (await cdp.evaluate(`!window.__T.one('edit-dialog')`)) === true)

    const afterEdit = await cdp.evaluate(`
      JSON.stringify({
        amount: window.__T.text('list-amount-${id.a}'),
        row: window.__T.label(window.__T.one('list-row-${id.a}')),
        summary: window.__T.label(window.__T.one('list-summary')),
        total: window.__T.label(window.__T.one('list-total'))
      })
    `)
    const ae = JSON.parse(afterEdit)
    check('列表里的金额变成了 99.99', ae.amount.includes('99.99'), ae.amount)
    check('列表里的备注也变了', ae.row.includes('改过的备注'), ae.row)
    check('笔数没变，还是 4 笔', ae.total === '共 4 笔', ae.total)
    check(
      '底下的合计跟着变了：支出 285.99、结余 7,714.01',
      ae.summary.includes('285.99') && ae.summary.includes('7,714.01'),
      ae.summary
    )

    // ---------- 10. 在弹窗里把收支类型切了，但没重选分类 ----------
    await cdp.evaluate(`window.__T.click(window.__T.one('list-row-${id.a}'))`)
    await sleep(700)
    await cdp.evaluate(`window.__T.click(window.__T.one('edit-kind-income'))`)
    await sleep(500)

    const switched = await cdp.evaluate(`
      (function () {
        var el = window.__T.inScope('edit-dialog', 'pick-leaf-${lunchId}')
        return JSON.stringify({
          saveDisabled: window.__T.disabled('edit-save'),
          incomePressed: window.__T.one('edit-kind-income').getAttribute('aria-pressed'),
          oldLeafPressed: el ? el.getAttribute('aria-pressed') : '没有这个元素'
        })
      })()
    `)
    const sw = JSON.parse(switched)
    check('切成收入后，「收入」被选中', sw.incomePressed === 'true', JSON.stringify(sw))
    check('切类型会把原来选的分类清掉（支出分类不能挂在收入账上）', sw.oldLeafPressed !== 'true', String(sw.oldLeafPressed))
    check('没重选分类之前，保存按钮是灰的，点不动', sw.saveDisabled === true)

    await cdp.evaluate(`window.__T.click(window.__T.one('edit-cancel'))`)
    await sleep(600)
    check('点取消后编辑窗口关掉了', (await cdp.evaluate(`!window.__T.one('edit-dialog')`)) === true)

    // ---------- 11. 界面之外的那条防线：直接调 IPC 撞类型不匹配 ----------
    // 界面上有保护（切类型就清分类），但这条规则最终得由数据库层兜住。
    const mismatch = await cdp.evaluate(`
      (async function () {
        try {
          await window.ht.transactions.update({
            id: ${id.a}, kind: 'income', amountFen: 100,
            categoryId: ${lunchId}, occurredOn: '${today}',
            note: '', paymentMethod: 'wechat'
          })
          return '居然成功了'
        } catch (e) { return e.message }
      })()
    `)
    check(
      '绕开界面直接调 IPC，收入挂到支出分类上会被中文拦下',
      mismatch.includes('收入不能记在支出分类下'),
      mismatch
    )

    const untouched = await cdp.evaluate(`window.__T.text('list-amount-${id.a}')`)
    check('被拦下之后，那笔账原样没动', untouched.includes('99.99'), untouched)

    // ---------- 12. 删一笔 ----------
    await cdp.evaluate(`window.__T.click(window.__T.one('list-row-${id.d}'))`)
    await sleep(700)
    await cdp.evaluate(`window.__T.click(window.__T.one('edit-delete'))`)
    await sleep(500)

    const confirmText = await cdp.evaluate(`window.__T.label(window.__T.one('confirm-dialog'))`)
    check('点删除会先弹一个确认框', confirmText.includes('删除这笔账'), confirmText)
    check('确认框里写清了删的是哪一笔', confirmText.includes('晚餐') && confirmText.includes('66.00'), confirmText)
    check('确认框里说了删掉就回不来', confirmText.includes('无法恢复'), confirmText)

    await cdp.evaluate(`window.__T.click(window.__T.one('confirm-cancel'))`)
    await sleep(500)
    const afterCancel = await snapshot(cdp)
    check('点「取消」不删，还是 4 笔', afterCancel.total === '共 4 笔', afterCancel.total)

    await cdp.evaluate(`window.__T.click(window.__T.one('edit-delete'))`)
    await sleep(500)
    await cdp.evaluate(`window.__T.click(window.__T.one('confirm-ok'))`)
    await sleep(1200)

    s = await snapshot(cdp)
    check('确认后那笔没了', !s.rowIds.includes(id.d), s.rowIds.join(','))
    check('笔数变成 3 笔', s.total === '共 3 笔', s.total)
    check(
      '删完合计也更新了：支出 219.99、结余 7,780.01',
      s.summary.includes('219.99') && s.summary.includes('7,780.01'),
      s.summary
    )
    const dayAfterDelete = await cdp.evaluate(`window.__T.byRe(/^list-day-[0-9]{4}-[0-9]{2}-[0-9]{2}$/).length`)
    check('删光某一天之后，那一天的日期分组也一起消失', dayAfterDelete === 1, `${dayAfterDelete} 个分组`)

    const removeMissing = await cdp.evaluate(`
      (async function () {
        try { await window.ht.transactions.remove(999999); return '居然成功了' }
        catch (e) { return e.message }
      })()
    `)
    check(
      '删一笔不存在的账会明说，不装作删成功了',
      removeMissing.includes('这笔账不存在，可能已经被删除了'),
      removeMissing
    )

    // ---------- 13. 翻月 ----------
    await cdp.evaluate(`window.__T.click(window.__T.one('list-prev-month'))`)
    await sleep(700)
    s = await snapshot(cdp)
    const prevLabel = `${prevMonth.slice(0, 4)}年${Number(prevMonth.slice(5))}月`
    check(`往前翻一个月，标题变成 ${prevLabel}`, s.month === prevLabel, s.month)
    check('上个月只有那 1 笔', s.total === '共 1 笔', s.total)
    check('上个月那笔（15.00）在列表里', s.rowIds.length === 1 && s.rowIds[0] === id.e, s.rowIds.join(','))
    check('不是本月了，「回到本月」变回可点', s.thisMonthDisabled === false)

    // 上个月只有支出、没有收入。筛成「收入」之后列表是空的，
    // 这时的空状态**绝不能**说「本月还没有记账」——用户明明记过，只是筛掉了。
    await cdp.evaluate(`window.__T.click(window.__T.one('list-filter-income'))`)
    await sleep(700)
    s = await snapshot(cdp)
    check(
      '筛成「收入」而这个月只有支出时，空状态说的是「没有收入记录」，不是「还没有记账」',
      s.empty.includes('没有收入记录') && !s.empty.includes('还没有记账'),
      s.empty
    )
    check('这种空状态也给了一句下一步该干什么', s.empty.includes('记一笔'), s.empty)

    await cdp.evaluate(`window.__T.click(window.__T.one('list-filter-all'))`)
    await sleep(700)
    s = await snapshot(cdp)
    check('切回「全部」后，上个月那笔又出现了', s.total === '共 1 笔', s.total)

    await cdp.evaluate(`window.__T.click(window.__T.one('list-this-month'))`)
    await sleep(700)
    s = await snapshot(cdp)
    check('点「回到本月」直接跳回本月', s.month === `${month.slice(0, 4)}年${Number(month.slice(5))}月`, s.month)
    check('回到本月后又是 3 笔', s.total === '共 3 笔', s.total)
    check('回到本月后按钮又变灰', s.thisMonthDisabled === true)

    // ---------- 14. 跨年翻月 ----------
    let guard = 0
    let label = (await snapshot(cdp)).month
    while (!/年\s*1\s*月$/.test(label) && guard < 24) {
      await cdp.evaluate(`window.__T.click(window.__T.one('list-prev-month'))`)
      await sleep(280)
      label = (await snapshot(cdp)).month
      guard += 1
    }
    check('一直往前翻能翻到 1 月', /年\s*1\s*月$/.test(label), label)

    const janYear = Number(label.match(/(\d{4})年/)[1])
    await cdp.evaluate(`window.__T.click(window.__T.one('list-prev-month'))`)
    await sleep(600)
    s = await snapshot(cdp)
    check(
      `从 ${janYear} 年 1 月再往前，是 ${janYear - 1} 年 12 月（跨年没翻错）`,
      s.month === `${janYear - 1}年12月`,
      s.month
    )
    check('翻到没有账的月份显示空状态，不是一片空白', s.empty.includes('还没有记账'), s.empty)

    await cdp.evaluate(`window.__T.click(window.__T.one('list-this-month'))`)
    await sleep(700)

    // ---------- 15. 分类被「删除」之后，它名下的老账单还改得动吗 ----------
    // 用户 2026-10-04 拍板：能改，分类保持原样。
    // 归档的分类不出现在选择器里，所以编辑窗必须单独把「原来是哪个分类」告诉用户，
    // 否则他只看到保存失败，既不知道原因，也认不出该不该重选。
    await cdp.evaluate(`(async function () { await window.ht.categories.archive(${lunchId}) })()`)
    await sleep(400)
    // 让列表重新拉一次（切一下筛选就会触发）
    await cdp.evaluate(`window.__T.click(window.__T.one('list-filter-expense'))`)
    await sleep(500)
    await cdp.evaluate(`window.__T.click(window.__T.one('list-filter-all'))`)
    await sleep(700)

    check(
      '分类被删掉后，它名下的老账单照常留在列表里（不会凭空消失）',
      (await cdp.evaluate(`!!window.__T.one('list-row-${id.a}')`)) === true
    )

    await cdp.evaluate(`window.__T.click(window.__T.one('list-row-${id.a}'))`)
    await sleep(700)
    const archivedNotice = await cdp.evaluate(`window.__T.label(window.__T.one('edit-archived-category'))`)
    check(
      '编辑窗里说清了原分类已被删除，并且说出是哪个分类',
      archivedNotice.includes('午餐') && archivedNotice.includes('删除'),
      archivedNotice || '（没有这条提示）'
    )

    await cdp.evaluate(`window.__T.setInput(window.__T.one('edit-amount'), '111.11')`)
    await sleep(300)
    await cdp.evaluate(`window.__T.click(window.__T.one('edit-save'))`)
    await sleep(1200)

    const sd = JSON.parse(
      await cdp.evaluate(`
        JSON.stringify({
          closed: !window.__T.one('edit-dialog'),
          amount: window.__T.text('list-amount-${id.a}'),
          error: window.__T.label(window.__T.one('edit-error'))
        })
      `)
    )
    check(
      '归档分类下的账单，不重选分类也能改（不用被迫把账挪到别的分类下）',
      sd.closed === true && sd.amount !== null && sd.amount.includes('111.11'),
      JSON.stringify(sd)
    )

    // 还原这个分类，免得影响后面「重开软件」那一段
    await cdp.evaluate(`(async function () { await window.ht.categories.restore(${lunchId}) })()`)
    await sleep(400)

    session.ws.close()
  } finally {
    session.child.kill()
    await sleep(1500)
  }

  // ---------- 15. 重开软件，改过和删过的结果都还在 ----------
  session = await launch()
  cdp = session.cdp
  try {
    await goto(cdp, '账单')
    const afterRestart = await snapshot(cdp)
    check('重开软件后，账单页还是 3 笔（改动真的落库了）', afterRestart.total === '共 3 笔', afterRestart.total)

    const persistedAmount = await cdp.evaluate(`window.__T.text('list-amount-${id.a}')`)
    check('重开软件后，改过的 111.11 还在', persistedAmount.includes('111.11'), persistedAmount)

    const deletedGone = await cdp.evaluate(`!window.__T.one('list-row-${id.d}')`)
    check('重开软件后，删掉的那笔没有回来', deletedGone === true)

    const months = await cdp.evaluate(`
      (async function () { return JSON.stringify(await window.ht.transactions.months()) })()
    `)
    const monthsArr = JSON.parse(months)
    check(
      '有账的月份按从新到旧列出来（两个月）',
      monthsArr.length === 2 && monthsArr[0] === month && monthsArr[1] === prevMonth,
      monthsArr.join(', ')
    )
  } finally {
    session.ws.close()
    session.child.kill()
    await sleep(800)
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 项通过`)
  if (failed.length > 0) {
    console.log('失败项：')
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
    process.exitCode = 1
  }
  console.log('')
}

main().catch((e) => {
  console.error('验证脚本自己出错了：', e)
  process.exitCode = 1
})
