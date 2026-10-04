/**
 * 第 5 阶段「统计页」的界面客观验证。
 *
 * 按 CLAUDE.md §九：真启动打包版本，用 Electron 调试接口（CDP）
 * 在真实渲染进程里读 DOM、驱动真实点击。
 *
 * 这个脚本要盯住的是**「当场看不出来」的错**：
 *   - 趋势图缺了没有账的月份（SQL 的 GROUP BY 只返回有数据的月份），
 *     柱子会整体错位 —— 用户看到的是「3 月的柱子长在 6 月的位置上」，
 *     图还是画出来了，没有任何报错；
 *   - 饼图的扇区数量和实际大类对不上（数据映射写错，少一块没人发现）；
 *   - 图例的百分比加起来不是 100%（分母取错）；
 *   - 归档分类之后统计数字变小（CLAUDE.md §5.11）；
 *   - 只有收入的那个月，饼图区说成「还没有记账」（用户明明记了）；
 *   - 统计页和账单页的月份标识重名 —— 验证脚本会以为自己检查了统计页，
 *     其实抓到的是账单页那个（CLAUDE.md §七的警告）。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE node "scripts/verify/检查统计页.mjs"
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 调试端口：本脚本从 BASE_PORT 起，每次启动 Electron 往后挪一个。
 *
 * 五个脚本原先都用 9222，串起来跑会撞：前一个实例刚被 kill，Windows 上
 * 子进程要过一会儿才真消失，新实例**照样**打印「DevTools listening on 9222」
 * 并成功启动 —— 两个进程共存，于是 /json/list 这次答的是谁完全不确定。
 * 实测出现过一次无规律的 95/96，单独重跑 9 遍都复现不出来。
 *
 * 每个脚本用一段互不相同的端口，脚本内每次重启再 +1，从根上避开这件事。
 * 起始端口别和别的脚本重复（9222 / 9232 / 9242 / 9252 / 9262）。
 */
const BASE_PORT = 9262
let portSeq = 0

/** 取下一个调试端口。每次启动 Electron 都用一个新的。 */
function nextPort() {
  return BASE_PORT + portSeq++
}
const PROJECT = join(import.meta.dirname, '..', '..')
const ELECTRON = join(PROJECT, 'node_modules', 'electron', 'dist', 'electron.exe')
/**
 * 数据目录：**不是**软件真实的数据目录。
 *
 * 用 --user-data-dir 把 Electron 的 userData 整个挪到项目下的临时目录 ——
 * 这个脚本启动前会清空数据，落在真实目录上就会把用户账本清掉（CLAUDE.md §九）。
 * **别把这行去掉。**
 */
const USER_DATA = join(PROJECT, '.verify-data', '统计页')

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
  /**
   * 按 CSS 选择器数元素。
   *
   * ⚠️ 别拿上面的 count() 来数 svg 元素 —— 那个是专门数 data-testid 的，
   * 传 'path.recharts-sector' 进去会变成 [data-testid="path.recharts-sector"]，
   * 永远返回 0。**这种错最阴**：检查项照常「通过」，其实什么都没看。
   * 实测踩过一次（「没有支出时饼图不画扇区」一直是空转的）。
   */
  svg(selector) { return document.querySelectorAll(selector).length },
  byRe(re) {
    return Array.prototype.slice
      .call(document.querySelectorAll('[data-testid]'))
      .filter(function (e) { return re.test(e.dataset.testid) })
  },
  text(t) { var e = this.one(t); return e ? e.textContent : null },
  label(t) { return this.norm(this.text(t)) },
  click(el) { if (el) el.click() },
  sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) },

  /** 所有 data-testid 里出现两次以上的（四个页面常驻挂载，重名是常态风险）。 */
  duplicatedTestIds() {
    var seen = {}, dup = []
    Array.prototype.slice.call(document.querySelectorAll('[data-testid]')).forEach(function (e) {
      var t = e.dataset.testid
      seen[t] = (seen[t] || 0) + 1
    })
    Object.keys(seen).forEach(function (t) { if (seen[t] > 1) dup.push(t + '×' + seen[t]) })
    return dup
  },

  /** 色相（0–360）。Tailwind v4 输出 oklch()，SVG 的 fill 输出 rgb()，两种都得认。 */
  hueOf(value) {
    var s = String(value || '')
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
  hue(t) {
    var e = this.one(t)
    return e ? this.hueOf(getComputedStyle(e).color) : null
  },

  /**
   * 饼图的每一块。返回按 x 排好的 fill 颜色（十六进制或 rgb 都归一成 rgb）。
   * 数量对不上就说明数据映射错了 —— 少一块或多一块，界面上不会有任何提示。
   */
  pieSlices() {
    return Array.prototype.slice
      .call(document.querySelectorAll('path.recharts-sector'))
      .map(function (p, i) { return { i: i, fill: getComputedStyle(p).fill } })
  },

  /** 图例前面的小圆点颜色（HTML 的 span，取 backgroundColor 而不是 color）。 */
  legendColors() {
    return this.byRe(/^stats-pie-legend-[0-9]+$/).map(function (li) {
      var dot = li.querySelector('span')
      return dot ? getComputedStyle(dot).backgroundColor : null
    })
  },

  /**
   * 柱状图的柱子。
   *
   * ⚠️ Recharts **不会**给金额为 0 的月份画柱子（Rectangle 宽或高为 0 时直接不渲染），
   * 所以柱子的数量 = 有数据的月份数，不是 12。想让「没账的月份也占一格」这件事
   * 被发现，靠的是下面的**刻度对齐**检查，不是数柱子。
   *
   * 高度和横坐标都用 getBBox() 量实际画出来的几何 —— 只看属性的话，
   * 一个没画出来的柱子看起来也是「存在」的。
   */
  bars() {
    return Array.prototype.slice
      .call(document.querySelectorAll('path.recharts-rectangle'))
      .map(function (p) {
        var b = p.getBBox()
        return {
          fill: getComputedStyle(p).fill,
          x: Math.round(b.x * 10) / 10,
          cx: Math.round((b.x + b.width / 2) * 10) / 10,
          h: Math.round(b.height * 10) / 10
        }
      })
  },

  /**
   * 横轴上的月份标签，带每个标签的中心横坐标。
   *
   * 不能用 '.recharts-xAxis text' 找 —— 实测 Recharts 3.10 把刻度文字
   * 渲染在 svg 根下面，并不在 .recharts-xAxis 这个 <g> 里面（那里只有一堆空的
   * <g class="recharts-cartesian-axis-tick">）。所以按「文本以『月』结尾」筛，
   * 纵轴的纯数字标签自然被排除掉。
   */
  axisTicks() {
    return Array.prototype.slice
      .call(document.querySelectorAll('.recharts-surface text'))
      .filter(function (t) { return /月$/.test((t.textContent || '').trim()) })
      .map(function (t) {
        var b = t.getBBox()
        return {
          label: (t.textContent || '').trim(),
          cx: Math.round((b.x + b.width / 2) * 10) / 10
        }
      })
  },

  /** 纵轴上的刻度文字（纯数字那些），用来验证单位是「元」不是「分」。 */
  yAxisLabels() {
    return Array.prototype.slice
      .call(document.querySelectorAll('.recharts-surface text'))
      .map(function (t) { return (t.textContent || '').trim() })
      .filter(function (s) { return /^[0-9][0-9,]*$/.test(s) })
  },

  /** 某个大类的排名行有没有展开。 */
  rankExpanded(id) { return this.count('stats-rank-children-' + id) === 1 }
}
'ok'
`

async function getTarget(port) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://localhost:${port}/json/list`)
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
  /**
   * 求值并解析成 JSON。
   *
   * 里面那层 `await` 不能省：表达式经常是一个 async 立即执行函数，
   * 直接 JSON.stringify(那个 Promise) 得到的是 "{}" —— 不报错，
   * 但后面所有断言都会读到一堆 undefined。
   */
  async json(expression) {
    const raw = await this.evaluate(`(async () => JSON.stringify(await (${expression})))()`)
    return raw === undefined ? undefined : JSON.parse(raw)
  }
}

async function launch() {
  const port = nextPort()
  const child = spawn(
    ELECTRON,
    [
      join(PROJECT, 'out', 'main', 'index.js'),
      `--user-data-dir=${USER_DATA}`,
      `--remote-debugging-port=${port}`
    ],
    {
      cwd: PROJECT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  const target = await getTarget(port)
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
  // 切过去之后要等：取数走一次 IPC，图表还要按容器尺寸重画一遍。
  await sleep(900)
}

/**
 * 轮询等一个条件成立，最多等 ms 毫秒；等不到返回 false。
 *
 * 图表要在 ResponsiveContainer 量到容器尺寸之后才画得出来，而这个时间不固定：
 * 页面第一次显示、以及从隐藏切回可见（四个页面常驻挂载，切页只是 hidden 切换）
 * 都要重新量一次。固定 sleep 要么不够（读到空图），要么白等。
 *
 * 等不到不让脚本崩，只让对应检查项判失败 —— 崩掉会把后面还没跑的检查全遮住。
 */
async function waitFor(cdp, expression, ms = 4000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await cdp.evaluate(expression)) return true
    if (Date.now() > deadline) return false
    await sleep(150)
  }
}

/**
 * 等到页面「不再变了」：连续两次采样（间隔 180ms）拿到完全一样的指纹。
 *
 * 为什么需要它：从隐藏切回可见时（四个页面常驻挂载，切页只是 hidden 切换），
 * Recharts 的容器先重新量到尺寸、把 <svg> 挂上去，**饼图的扇区要再晚一个渲染批次
 * 才出现**。只在「<svg> 有尺寸」时返回，会正好卡在这两步之间 ——
 * 读到的是一张「有画布、没内容」的图，检查项随机失败或随机通过。
 * 实测过：这个中间态确实能被抓到（扇区数读到 0，而图例里明明有一条）。
 *
 * 指纹里带上 svg 元素个数（扇区多一个就变）和正文长度（数据到了就变）。
 * 等不到也不让脚本崩 —— 返回 false，后面的断言照样跑，失败时看得出是哪一条。
 */
async function waitStable(cdp, ms = 4000) {
  // main 取不到时要给空串兜底。**不能直接 .innerText** —— 页面还没挂载时
  // main 是 null，整句话就在「等稳定」这一步抛出去，脚本一项检查都跑不成，
  // 屏幕上只剩一个 TypeError。那样看起来像「环境问题」，
  // 实际上把 52 项检查全遮住了（第 5 阶段复核实测命中：机器上有残留的
  // electron 进程时，脚本连到了状态异常的实例，就在这行崩掉）。
  const fingerprint = `(function () {
    var m = document.querySelector('main')
    return document.querySelectorAll('svg *').length + '/' +
      document.querySelectorAll('[data-testid]').length + '/' +
      window.__T.norm(m ? m.innerText : '').length
  })()`
  const deadline = Date.now() + ms
  let previous = null
  while (Date.now() < deadline) {
    const current = await cdp.evaluate(fingerprint)
    if (previous !== null && current === previous) return true
    previous = current
    await sleep(180)
  }
  return false
}

/** 切到统计页，并等图表真的画完（不然下面的断言读到的可能是一张空图）。 */
async function gotoStats(cdp) {
  await goto(cdp, '统计')
  const sized = await waitFor(
    cdp,
    `(function () {
      var e = document.querySelector('.recharts-surface')
      if (!e) return false
      var r = e.getBoundingClientRect()
      return r.width > 100 && r.height > 100
    })()`
  )
  await waitStable(cdp)
  return sized
}

/**
 * 在统计页往前翻 n 个月。
 *
 * 每翻一次都要等取数回来 —— 连点的话中间那几次的响应可能后到，
 * 界面会停在某个中间月份上，后面的断言就全部对不上了。
 */
async function statsPrev(cdp, n) {
  for (let i = 0; i < n; i += 1) {
    await cdp.evaluate(`window.__T.click(window.__T.one('stats-prev-month'))`)
    await sleep(650)
  }
}

/** 统计页当前显示的月份。 */
async function shownMonth(cdp) {
  return await cdp.evaluate(`window.__T.label('stats-month')`)
}

/** 把「2026-10」写成界面上的「2026年10月」。 */
function displayMonth(month) {
  return `${month.slice(0, 4)}年${Number(month.slice(5))}月`
}

/** rgb() 字符串的色相。用来按颜色把柱状图的支出柱和收入柱分开。 */
function hueOfRgb(value) {
  const m = String(value).match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/)
  if (!m) return null
  const r = +m[1] / 255
  const g = +m[2] / 255
  const b = +m[3] / 255
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const d = mx - mn
  if (d === 0) return null
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  h *= 60
  return h < 0 ? h + 360 : h
}

async function main() {
  console.log('\n【第 5 阶段 统计页 — 界面客观验证】\n')

  rmSync(USER_DATA, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  console.log(`  · 隔离数据目录（已清空）：${USER_DATA}\n`)

  const session = await launch()
  const { cdp } = session

  try {
    // ---------- 0. 造数据 ----------
    // 走界面自己用的那条 IPC 写进去，不是直接改数据库文件。
    //
    // 数据造得有讲究：最近几个月的金额**逐月递增**，
    // 这样一旦趋势图缺了没有账的月份（柱子整体错位），
    // 递增的规律立刻就断了 —— 平的数字是看不出错位的。
    const seeded = await cdp.json(`
      (async function () {
        var today = await window.ht.transactions.today()
        var y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7))

        // 往回数 n 个月，返回 'YYYY-MM'
        function back(n) {
          var t = y * 12 + (m - 1) - n
          return String(Math.floor(t / 12)).padStart(4, '0') + '-' +
            String((t % 12) + 1).padStart(2, '0')
        }

        var months = {
          this0: back(0), prev1: back(1), prev2: back(2),
          onlyIncome3: back(3), negative4: back(4), empty6: back(6)
        }

        var tree = await window.ht.categories.list()
        function leaf(pName, kName) {
          var p = tree.find(function (c) { return c.name === pName })
          if (!p) return null
          var k = p.children.find(function (c) { return c.name === kName })
          return k ? k.id : null
        }
        var ids = {
          lunch: leaf('餐饮', '午餐'),
          dinner: leaf('餐饮', '晚餐'),
          taxi: leaf('交通', '打车网约车'),
          salary: leaf('工资薪酬', '月薪'),
          restaurant: (tree.find(function (c) { return c.name === '餐饮' }) || {}).id
        }
        if (!ids.lunch || !ids.dinner || !ids.taxi || !ids.salary || !ids.restaurant) {
          return { error: '内置分类没找齐：' + JSON.stringify(ids) }
        }

        async function add(kind, yuan, categoryId, month, day) {
          var r = await window.ht.transactions.create({
            kind: kind,
            amountFen: Math.round(yuan * 100),
            categoryId: categoryId,
            occurredOn: month + '-' + day,
            note: '',
            paymentMethod: 'wechat'
          })
          return r.id
        }

        // 本月：餐饮 120 + 交通 180 = 支出 300；收入 8000
        await add('expense', 120, ids.lunch, months.this0, '03')
        await add('expense', 180, ids.taxi, months.this0, '05')
        await add('income', 8000, ids.salary, months.this0, '05')
        // 上月：支出 200、收入 500
        await add('expense', 200, ids.dinner, months.prev1, '10')
        await add('income', 500, ids.salary, months.prev1, '10')
        // 上上月：支出 100
        await add('expense', 100, ids.lunch, months.prev2, '10')
        // 三个月前：只有收入 500（一笔支出都没有）
        await add('income', 500, ids.salary, months.onlyIncome3, '10')
        // 四个月前：支出 500、收入 100（结余是负数）
        await add('expense', 500, ids.lunch, months.negative4, '10')
        await add('income', 100, ids.salary, months.negative4, '10')
        // 六个月前：一笔都没有

        return { months: months, ids: ids }
      })()
    `)
    if (seeded.error) throw new Error(seeded.error)
    const M = seeded.months
    const ids = seeded.ids

    check(
      '造好了 5 个月的测试账（含一个「只有收入」和一个「结余为负」的月）',
      typeof M.this0 === 'string' && M.this0.length === 7,
      `本月 ${M.this0}`
    )

    // ---------- 1. 本月的统计 ----------
    await gotoStats(cdp)

    check('打开统计页默认显示本月', (await shownMonth(cdp)) === displayMonth(M.this0), await shownMonth(cdp))

    // 三张卡片。金额和刚写进去的账必须对得上 —— 这是用户唯一会认真看的数字。
    const cards = await cdp.json(`({
      expense: window.__T.label('stats-card-expense'),
      income: window.__T.label('stats-card-income'),
      net: window.__T.label('stats-card-net'),
      netHue: window.__T.hue('stats-card-net'),
      total: window.__T.label('stats-total')
    })`)
    check('支出卡片是 120 + 180 = 300.00 元', cards.expense.indexOf('300.00') >= 0, cards.expense)
    check('收入卡片是 8,000.00 元', cards.income.indexOf('8,000.00') >= 0, cards.income)
    check('结余卡片是 8,000 − 300 = 7,700.00 元', cards.net.indexOf('7,700.00') >= 0, cards.net)
    // 产品设计文档 §3.4：结余「正数绿色、负数红色」。负数那条在第 7 组，
    // 这里管正数 —— 两条都钉住，才不会哪天把颜色改成一律灰的而没人发现。
    //
    // 判据必须是**绿附近的一个区间**，不能只写 hue > 120：
    // 中性灰用的是 slate 系（蓝灰），色相 255~257 —— 比绿(152)还大。
    // 只判下界的话，把结余改成灰的这条检查照样绿（实测踩过，见开发记录）。
    check(
      '结余为正时是绿色的（和收入一个颜色）',
      cards.netHue !== null && cards.netHue > 100 && cards.netHue < 200,
      `色相 ${cards.netHue}`
    )
    check('「共 3 笔」统计的是支出 + 收入两边的总笔数', cards.total === '共 3 笔', cards.total)
    // 正常取到数时**不能**出现「数据过期」那条提示（误报会让用户以为统计坏了）。
    //
    // ⚠️ 这条只钉住了「不该有时没有」这一半。另一半「取数失败时标题不能跟着翻月走」
    // 没能自动化：`window.ht` 是 contextBridge 暴露的，在渲染进程里**只读**，
    // 脚本没法把它换成会 reject 的假实现来制造失败。那一半靠
    // `staleStatsNotice` 的单测 + `StatsPage` 里「标题取 overview.month」那行保证。
    // 记在这里，免得以后有人以为这块已经测到了。
    check(
      '正常取到数时不显示「数据过期」提示（不能误报）',
      (await cdp.evaluate(`window.__T.count('stats-stale')`)) === 0
    )

    // 上面那条只盯住了「稳定下来之后没有」。用户 2026-10-04 报的是另一种：
    // **翻月的那一瞬间先闪一下「取不到 X 月的统计」，几十毫秒后才正常** ——
    // 等页面稳定再 count，读的时候提示早没了，所以那条检查一直是绿的。
    //
    // 抓「一闪而过」只能用 MutationObserver：从装上到断开之间**只要出现过一次**
    // 就记下来，不管它存在了多久。这是本项目第二条「检查一直在空转」的教训
    // （第一条是 README 里 count/svg 那个）。
    await cdp.evaluate(`(function () {
      var main = document.querySelector('main')
      window.__staleSeen = false
      window.__staleMutations = 0
      function scan() {
        window.__staleMutations += 1
        if (document.querySelector('[data-testid="stats-stale"]')) window.__staleSeen = true
      }
      window.__staleObserver = new MutationObserver(scan)
      window.__staleObserver.observe(main, { childList: true, subtree: true, characterData: true })
      scan()
      return true
    })()`)
    await cdp.evaluate(`window.__T.click(window.__T.one('stats-prev-month'))`)
    await waitStable(cdp)
    await sleep(400)
    const flash = await cdp.json(`(function () {
      window.__staleObserver.disconnect()
      return { seen: window.__staleSeen, mutations: window.__staleMutations }
    })()`)
    // 先确认观察器真的在看：若 mutations 是 0，下一条检查是**空转**的
    // （它必然通过，因为什么都没观察到）。
    check(
      '翻月时观察器确实捕捉到了界面变化（否则下一条是空转的）',
      flash.mutations > 0,
      `观察到 ${flash.mutations} 次 DOM 变更`
    )
    check(
      '翻月时不闪「取不到…的统计」（正在加载 ≠ 取不到）',
      flash.seen === false,
      `观察器期间出现过该提示：${flash.seen}`
    )

    // 翻回本月，后面的断言（饼图、排行、趋势）都按 2026-10 写。
    await cdp.evaluate(`window.__T.click(window.__T.one('stats-this-month'))`)
    await waitStable(cdp)
    check(
      '翻月再翻回本月，月份和数字都回来了',
      (await cdp.evaluate(`window.__T.label('stats-month')`)) === '2026年10月' &&
        (await cdp.evaluate(`window.__T.text('stats-card-expense')`)).indexOf('300.00') >= 0,
      await cdp.evaluate(`window.__T.label('stats-month')`)
    )

    // ---------- 2. 饼图 ----------
    const slices = await cdp.json(`window.__T.pieSlices()`)
    check('饼图真的画出来了（不是一片空白）', Array.isArray(slices) && slices.length > 0, `${slices?.length} 块`)
    check(
      '饼图的块数 = 有支出的分类数（本月是餐饮、交通两个大类）',
      slices.length === 2,
      `${slices.length} 块`
    )

    const legend = await cdp.json(`
      window.__T.byRe(/^stats-pie-legend-[0-9]+$/).map(function (li) {
        return {
          id: Number(li.dataset.testid.replace('stats-pie-legend-', '')),
          label: window.__T.norm(li.innerText)
        }
      })
    `)
    check('图例有两条，分别是餐饮和交通', legend.length === 2, legend.map((l) => l.label).join(' / '))
    check(
      '图例上的占比是 60% 和 40%（180 / 300、120 / 300）',
      legend.some((l) => l.label.indexOf('60%') >= 0) && legend.some((l) => l.label.indexOf('40%') >= 0),
      legend.map((l) => l.label).join(' / ')
    )

    const legendColors = await cdp.json(`window.__T.legendColors()`)
    check(
      '图例的颜色和饼图每一块的颜色一一对应（不是各取各的色）',
      legendColors.length === slices.length && legendColors.every((c, i) => c === slices[i].fill),
      `图例 ${legendColors.join(',')} / 扇区 ${slices.map((s) => s.fill).join(',')}`
    )

    const percents = legend.map((l) => Number((l.label.match(/([\d.]+)%/) || [])[1] ?? NaN))
    const sum = percents.reduce((a, b) => a + b, 0)
    check(
      `图例上的占比加起来是 100%（实际 ${sum}%）`,
      Math.abs(sum - 100) < 0.5,
      percents.join(' + ')
    )

    // ---------- 3. 排行 ----------
    const rank = await cdp.json(`
      window.__T.byRe(/^stats-rank-row-[0-9]+$/).map(function (row) {
        var id = row.dataset.testid.replace('stats-rank-row-', '')
        return {
          id: Number(id),
          name: window.__T.norm(row.innerText),
          amount: window.__T.label('stats-rank-amount-' + id),
          percent: window.__T.label('stats-rank-percent-' + id)
        }
      })
    `)
    check('排行有两条，和饼图的块数一致', rank.length === 2, rank.map((r) => r.name).join(' / '))
    check(
      '排行第一名是花得最多的那个（交通 180 元）',
      rank[0].name.indexOf('交通') >= 0 && rank[0].amount === '180.00',
      `${rank[0].name} ${rank[0].amount}`
    )
    check(
      '排行按金额从大到小（不是按分类原始顺序）',
      rank[0].amount === '180.00' && rank[1].amount === '120.00',
      rank.map((r) => r.amount).join(' > ')
    )
    // 排行榜和饼图必须是同一个分母。两处各算一次的话，会出现
    // 「饼图写 60%、排行写 37.5%」这种对不上、且用户完全无法解释的数字。
    const percentNumber = (s) => Number((String(s).match(/([\d.]+)%?/) || [])[1] ?? NaN)
    check(
      '排行的百分比和饼图图例的百分比一致（同一个分母，没各算一次）',
      JSON.stringify(rank.map((r) => percentNumber(r.percent))) ===
        JSON.stringify(legend.map((l) => percentNumber(l.label))),
      `排行 ${rank.map((r) => r.percent).join(',')} / 饼图 ${legend.map((l) => l.label).join(',')}`
    )

    // 点开下钻看小类
    await cdp.evaluate(`window.__T.click(window.__T.one('stats-rank-row-${rank[0].id}'))`)
    await sleep(300)
    const kids = await cdp.json(`
      window.__T.byRe(/^stats-rank-minor-[0-9]+$/).map(function (row) {
        var id = row.dataset.testid.replace('stats-rank-minor-', '')
        return { id: Number(id), label: window.__T.norm(row.innerText), amount: window.__T.label('stats-rank-minor-amount-' + id) }
      })
    `)
    check('点排行的一行能展开它名下的小类', kids.length === 1, kids.map((k) => k.label).join(' / '))
    check(
      '展开的小类金额之和 = 上面那个大类的金额（120+180 里交通只有打车 180）',
      kids.reduce((a, k) => a + Number(k.amount.replace(/,/g, '')), 0) === Number(rank[0].amount.replace(/,/g, '')),
      `${kids.map((k) => k.amount).join(' + ')} vs ${rank[0].amount}`
    )
    await cdp.evaluate(`window.__T.click(window.__T.one('stats-rank-row-${rank[0].id}'))`)
    await sleep(300)
    check(
      '再点一下收起来（小类不在了）',
      (await cdp.evaluate(`window.__T.count('stats-rank-minor-${kids[0]?.id}')`)) === 0
    )

    // ---------- 4. 趋势图 ----------
    const ticks = await cdp.json(`window.__T.axisTicks()`)
    check('趋势图横轴有 12 个月份标签', ticks.length === 12, ticks.map((t) => t.label).join(' '))
    check(
      '横轴最后一个标签是当前月（趋势图是「以看的这个月收尾」）',
      ticks.length === 12 && ticks[11].label === `${Number(M.this0.slice(5))}月`,
      ticks[11]?.label
    )

    const bars = await cdp.json(`window.__T.bars()`)
    // 支出 #dc2626（红）、收入 #16a34a（绿）。按色相分，不写死 rgb 字符串 ——
    // 色值将来微调一下，写死的断言就会误报，而红绿的区别是色相上的。
    const expenseBars = bars
      .filter((b) => {
        const h = hueOfRgb(b.fill)
        return h !== null && h < 20
      })
      .sort((a, b) => a.cx - b.cx)
    const incomeBars = bars
      .filter((b) => {
        const h = hueOfRgb(b.fill)
        return h !== null && h > 100 && h < 180
      })
      .sort((a, b) => a.cx - b.cx)

    // 造的数据：第 8 个月支出 500、第 9 个月只有收入、第 10 个月支出 100、
    // 第 11 个月支出 200、第 12 个月（本月）支出 300。
    // Recharts 不给 0 值的月份画柱子，所以支出柱是 4 根、收入柱是 4 根。
    check('支出柱 4 根（只有有支出的月份才画柱子）', expenseBars.length === 4, `${expenseBars.length} 根`)
    check('收入柱 4 根（有收入的月份，和支出柱并排）', incomeBars.length === 4, `${incomeBars.length} 根`)

    /**
     * 找到离某根柱子最近的横轴刻度，返回刻度序号。
     *
     * 这一条是整个趋势图里**最重要**的检查。趋势图最隐蔽的错法是：
     * 数据库只返回「有账的月份」，图少画了几格 —— 柱子整体左移，
     * 用户看到的是「8 月的柱子长在 10 月的位置上」，图照样画得出来，
     * 没有任何报错。按刻度反查序号能当场抓住这种错位。
     */
    const slotOf = (bar) => {
      let best = -1
      let bestGap = Infinity
      ticks.forEach((t, i) => {
        const gap = Math.abs(t.cx - bar.cx)
        if (gap < bestGap) {
          bestGap = gap
          best = i
        }
      })
      return best
    }

    check(
      '⚠️ 支出柱对准第 8/10/11/12 个月的刻度（月份和柱子是对齐的，没有整体错位）',
      JSON.stringify(expenseBars.map(slotOf)) === JSON.stringify([7, 9, 10, 11]),
      `落在刻度 ${expenseBars.map(slotOf).join(',')} 上`
    )
    check(
      '收入柱对准第 8/9/11/12 个月的刻度',
      JSON.stringify(incomeBars.map(slotOf)) === JSON.stringify([7, 8, 10, 11]),
      `落在刻度 ${incomeBars.map(slotOf).join(',')} 上`
    )

    // 高度要和金额成正比：500 元那根最高，然后是 300、200、100。
    const eh = expenseBars.map((b) => b.h)
    const ih = incomeBars.map((b) => b.h)
    check(
      '柱子高度和金额成正比：500 元 > 300 元 > 200 元 > 100 元',
      eh[0] > eh[3] && eh[3] > eh[2] && eh[2] > eh[1],
      `高度 ${eh.join(' / ')}`
    )
    check('收入柱最后一个月份最高（8,000 元）', ih[3] > ih[2] && ih[3] > ih[1] && ih[3] > ih[0], `高度 ${ih.join(' / ')}`)

    const yLabels = await cdp.json(`window.__T.yAxisLabels()`)
    check(
      '纵轴刻度写的是「元」不是「分」（写成分的话数字会大 100 倍：8,000 变成 800000）',
      yLabels.indexOf('8,000') >= 0 && yLabels.every((s) => s !== '800000'),
      yLabels.join(' / ')
    )

    // ---------- 5. 只有收入的那个月 ----------
    await statsPrev(cdp, 3)
    check('往前翻 3 个月翻对了', (await shownMonth(cdp)) === displayMonth(M.onlyIncome3), await shownMonth(cdp))

    const onlyIncome = await cdp.json(`({
      expense: window.__T.label('stats-card-expense'),
      income: window.__T.label('stats-card-income'),
      pieEmpty: window.__T.label('stats-pie-empty'),
      rankEmpty: window.__T.label('stats-ranking-empty'),
      sectors: window.__T.svg('path.recharts-sector')
    })`)
    check(
      '只有收入的月份：支出卡片是 0.00、收入卡片是 500.00',
      onlyIncome.expense.indexOf('0.00') >= 0 && onlyIncome.income.indexOf('500.00') >= 0,
      `${onlyIncome.expense} / ${onlyIncome.income}`
    )
    check('没有支出时饼图不画扇区', onlyIncome.sectors === 0, `${onlyIncome.sectors} 块`)
    check(
      '⚠️ 只有收入的月份**绝不能说「还没有记账」**（用户明明记了工资）',
      onlyIncome.pieEmpty.length > 0 && onlyIncome.pieEmpty.indexOf('还没有记账') < 0,
      onlyIncome.pieEmpty
    )
    check(
      '并且要说清为什么图是空的（因为统计的是支出）',
      onlyIncome.pieEmpty.indexOf('支出') >= 0,
      onlyIncome.pieEmpty
    )
    check(
      '排行的空状态说的是同一件事（两处不能一个说没记账、一个说没支出）',
      onlyIncome.rankEmpty.indexOf('没有支出') >= 0,
      onlyIncome.rankEmpty
    )

    // ---------- 6. 一笔账都没有的月份 ----------
    await statsPrev(cdp, 3)
    check('再往前翻 3 个月（六个月前，一笔账都没有）', (await shownMonth(cdp)) === displayMonth(M.empty6), await shownMonth(cdp))

    const empty = await cdp.json(`({
      expense: window.__T.label('stats-card-expense'),
      net: window.__T.label('stats-card-net'),
      tip: window.__T.label('stats-pie-empty'),
      total: window.__T.label('stats-total'),
      body: window.__T.norm(document.body.innerText),
      axis: window.__T.axisTicks().length,
      sectors: window.__T.svg('path.recharts-sector')
    })`)
    check(
      '一笔账都没有的月份：卡片显示 0.00 而不是空白或 NaN',
      empty.expense.indexOf('0.00') >= 0 && empty.net.indexOf('0.00') >= 0,
      `${empty.expense} / ${empty.net}`
    )
    check('页面上任何地方都没有出现 NaN', empty.body.indexOf('NaN') < 0)
    check('「共 0 笔」', empty.total === '共 0 笔', empty.total)
    check('空月份说「还没有记账」，并指路去记一笔', empty.tip.indexOf('还没有记账') >= 0 && empty.tip.indexOf('记一笔') >= 0, empty.tip)
    // 趋势图是「最近 12 个月」，本月没账不代表前 11 个月没账 —— 图还得画出来。
    check('即使看的月份一笔账都没有，趋势图仍然画出 12 个月的横轴', empty.axis === 12, `${empty.axis} 个标签`)

    // ---------- 7. 结余为负 ----------
    await cdp.evaluate(`window.__T.click(window.__T.one('stats-this-month'))`)
    await sleep(600)
    await statsPrev(cdp, 4)
    check('翻到四个月前', (await shownMonth(cdp)) === displayMonth(M.negative4), await shownMonth(cdp))

    const negative = await cdp.json(`({
      expense: window.__T.label('stats-card-expense'),
      income: window.__T.label('stats-card-income'),
      net: window.__T.label('stats-card-net'),
      hue: window.__T.hue('stats-card-net')
    })`)
    check(
      '结余为负时显示 −400.00（收入 100、支出 500）',
      negative.expense.indexOf('500.00') >= 0 &&
        negative.income.indexOf('100.00') >= 0 &&
        negative.net.indexOf('-400.00') >= 0,
      `${negative.expense} / ${negative.income} / ${negative.net}`
    )
    check(
      '结余为负时是红色的（和支出一个颜色，不是和收入一样的绿）',
      negative.hue !== null && negative.hue < 40,
      `色相 ${negative.hue}`
    )

    // ---------- 8. 归档分类 —— 统计数字不能变小（§5.11）----------
    await cdp.evaluate(`window.__T.click(window.__T.one('stats-this-month'))`)
    await sleep(600)
    const beforeArchive = await cdp.json(`({
      expense: window.__T.label('stats-card-expense'),
      legend: window.__T.count('stats-pie-legend-${ids.restaurant}')
    })`)
    check('归档前：餐饮在饼图图例里', beforeArchive.legend === 1, `图例 ${beforeArchive.legend} 条`)

    await cdp.evaluate(`window.ht.categories.archive(${ids.restaurant})`)
    await sleep(400)
    // 切走再切回来，强制统计页重新取数
    await goto(cdp, '记一笔')
    await gotoStats(cdp)

    const afterArchive = await cdp.json(`({
      expense: window.__T.label('stats-card-expense'),
      legend: window.__T.count('stats-pie-legend-${ids.restaurant}'),
      sectors: window.__T.svg('path.recharts-sector'),
      legendAll: window.__T.byRe(/^stats-pie-legend-[0-9]+$/).map(function (li) {
        return window.__T.norm(li.innerText)
      })
    })`)
    check(
      '⚠️ 归档「餐饮」之后支出总额**一点都没变**（变了就是统计漏掉了历史账单）',
      afterArchive.expense === beforeArchive.expense,
      `归档前 ${beforeArchive.expense} → 归档后 ${afterArchive.expense}`
    )
    check(
      '归档的分类仍然出现在饼图上（历史账单不会凭空消失）',
      afterArchive.legend === 1 && afterArchive.sectors === 2,
      `图例 ${afterArchive.legend} 条 / 扇区 ${afterArchive.sectors} 块 / 图例内容 ${afterArchive.legendAll.join(' | ')}`
    )

    await cdp.evaluate(`window.ht.categories.restore(${ids.restaurant})`)
    await sleep(400)

    // ---------- 9. 统计页的月份和账单页各管各的 ----------
    // 先在统计页往前翻 2 个月（从本月翻到上上月）
    await statsPrev(cdp, 2)
    const statsMonth = await shownMonth(cdp)

    // 再切到账单页。账单页第一次被显示时才会去问「今天几号」，
    // 所以必须真的切过去，它的月份切换器才会出现。
    await goto(cdp, '账单')
    const listMonth = await cdp.evaluate(`window.__T.label('list-month')`)
    check(
      '在统计页翻了月份，账单页不受影响（各管各的）',
      statsMonth === displayMonth(M.prev2) && listMonth === displayMonth(M.this0),
      `统计页 ${statsMonth} / 账单页 ${listMonth}`
    )

    const bothMonths = await cdp.json(`({
      statsCount: window.__T.count('stats-month'),
      listCount: window.__T.count('list-month')
    })`)
    check(
      '统计页和账单页各有一个月份切换器，标识不重名（重名会让验证脚本抓错元素）',
      bothMonths.statsCount === 1 && bothMonths.listCount === 1,
      `stats-month ×${bothMonths.statsCount} / list-month ×${bothMonths.listCount}`
    )

    await cdp.evaluate(`window.__T.click(window.__T.one('list-prev-month'))`)
    await sleep(650)
    await gotoStats(cdp)
    check(
      '反过来也一样：在账单页翻了月份，统计页仍然停在原来那个月',
      (await shownMonth(cdp)) === statsMonth,
      `统计页 ${await shownMonth(cdp)}`
    )
    check(
      '统计页的月份没被账单页带跑，账单页自己确实翻了',
      (await cdp.evaluate(`window.__T.label('list-month')`)) !== displayMonth(M.this0)
    )

    // ---------- 10. 标识唯一性 ----------
    const dups = await cdp.json(`window.__T.duplicatedTestIds()`)
    check(
      '整个页面上没有任何重复的 data-testid（四个页面常驻挂载，重名是最难查的一类错）',
      dups.length === 0,
      dups.join(', ')
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
