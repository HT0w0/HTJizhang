/**
 * 第 3 阶段「记一笔」的界面客观验证。
 *
 * 按 CLAUDE.md §九：真启动打包版本，用 Electron 调试接口（CDP）
 * 在真实渲染进程里读 DOM、驱动真实点击。
 *
 * 踩过的坑（§九 有完整版）：点击后必须等一帧，带 transition-colors 的要等过 150ms；
 * innerText 在弹性布局里会拆行，比较前归一化空白。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE node scripts/verify/检查记账页.mjs
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
const BASE_PORT = 9242
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
 * 用 --user-data-dir 把 Electron 的 userData 整个挪到项目下的临时目录，
 * 脚本清空的、读的、Electron 写的都是这里 —— 用户账本
 * （%APPDATA%\HTJizhang）一根汗毛都不会动。见 CLAUDE.md §九。
 */
const USER_DATA = join(PROJECT, '.verify-data', '记账页')

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
  // 按正则精确匹配 testid。**不要用前缀匹配**：
  // 「pick-major-grid」这个容器也以「pick-major-」开头，会被一起算进来，
  // 于是 11 个大类被数成 12 个。
  byRe(re) {
    return Array.prototype.slice
      .call(document.querySelectorAll('[data-testid]'))
      .filter(function (e) { return re.test(e.dataset.testid) })
  },
  pickMajors() { return this.byRe(/^pick-major-[0-9]+$/) },
  label(el) { return window.__T.norm(el && el.innerText) },
  click(el) { if (el) el.click() },
  setInput(el, v) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  },
  enter(el) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  },
  activeIs(t) { return document.activeElement && document.activeElement.dataset.testid === t },
  pickLeaves() { return this.byRe(/^pick-leaf-[0-9]+$/) },
  idOf(el) { return Number(el.dataset.testid.match(/([0-9]+)$/)[1]) },
  sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
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

async function main() {
  console.log('\n【第 3 阶段 记一笔 — 界面客观验证】\n')

  // 清掉上一次的残留（这个脚本假定自己是空库起跑的），在隔离目录里删，安全。
  rmSync(USER_DATA, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  console.log(`  · 隔离数据目录：${USER_DATA}\n`)

  // 在主进程里取一次「今天」，后面多处要用同一个值。
  // 必须声明在 try 外面 —— 关掉应用后读数据库那一段还要用它。
  let today = ''

  let session = await launch()
  let { cdp } = session

  try {
    // ---------- 1. 默认停在记账页，光标在金额框 ----------
    const onAddPage = await cdp.evaluate(`!!window.__T.one('amount')`)
    check('打开软件默认就在「记一笔」页', onAddPage === true)
    await sleep(500)
    const focused = await cdp.evaluate(`window.__T.activeIs('amount')`)
    check('光标默认在金额框里（可以一直不碰鼠标）', focused === true)

    // ---------- 2. 支出/收入 切换 ----------
    const tabState = await cdp.evaluate(`
      (function () {
        return JSON.stringify({
          expense: window.__T.one('kind-expense').getAttribute('aria-selected'),
          income: window.__T.one('kind-income').getAttribute('aria-selected')
        })
      })()
    `)
    check('默认选中「支出」', JSON.parse(tabState).expense === 'true', tabState)

    await cdp.evaluate(`window.__T.click(window.__T.one('kind-income'))`)
    await sleep(400)
    const incomeMajors = await cdp.evaluate(`
      (function () {
        var m = window.__T.pickMajors()
        return JSON.stringify({ count: m.length, names: m.map(function (e) { return window.__T.label(e) }) })
      })()
    `)
    const im = JSON.parse(incomeMajors)
    check(
      '切到「收入」后大类换成收入的 5 个',
      im.count === 5 && im.names.join('').indexOf('工资薪酬') >= 0,
      im.names.join(' / ')
    )

    await cdp.evaluate(`window.__T.click(window.__T.one('kind-expense'))`)
    await sleep(400)
    const backCount = await cdp.evaluate(`window.__T.pickMajors().length`)
    check('切回「支出」又变回 11 个大类', backCount === 11, `${backCount} 个`)

    // ---------- 3. 金额输入 ----------
    await cdp.evaluate(`window.__T.setInput(window.__T.one('amount'), '28.5')`)
    await sleep(250)
    const shown = await cdp.evaluate(`window.__T.one('amount').value`)
    check('输入 28.5，框里就是 28.5', shown === '28.5', shown)

    const preview = await cdp.evaluate(`window.__T.label(window.__T.one('amount-preview'))`)
    check('下方实时显示「= 28.50 元」', preview.indexOf('28.50') >= 0, preview)

    // ---------- 4. 非法输入直接被挡掉 ----------
    await cdp.evaluate(`window.__T.setInput(window.__T.one('amount'), 'abc')`)
    await sleep(250)
    const afterAbc = await cdp.evaluate(`window.__T.one('amount').value`)
    check('输入字母不会进入金额框', afterAbc === '28.5', `框里还是「${afterAbc}」`)

    await cdp.evaluate(`window.__T.setInput(window.__T.one('amount'), '1.2.3')`)
    await sleep(250)
    const afterDots = await cdp.evaluate(`window.__T.one('amount').value`)
    check('输入两个小数点不会进入金额框', afterDots === '28.5', `框里还是「${afterDots}」`)

    // ---------- 5. 全角数字 ----------
    await cdp.evaluate(`window.__T.setInput(window.__T.one('amount'), '２８')`)
    await sleep(250)
    const fullWidthPreview = await cdp.evaluate(`window.__T.label(window.__T.one('amount-preview'))`)
    check('全角数字「２８」被识别成 28 元', fullWidthPreview.indexOf('28.00') >= 0, fullWidthPreview)

    // 回到 28.5 继续
    await cdp.evaluate(`window.__T.setInput(window.__T.one('amount'), '28.5')`)
    await sleep(250)

    // ---------- 6. 没选分类就保存 ----------
    const saveDisabledBefore = await cdp.evaluate(`window.__T.one('save').disabled`)
    check('没选分类时保存按钮是禁用的', saveDisabledBefore === true)

    // ---------- 7. 选分类 ----------
    const restaurantId = await cdp.evaluate(`
      (function () {
        var m = window.__T.pickMajors().find(function (e) {
          return window.__T.label(e).indexOf('餐饮') >= 0
        })
        if (!m) return -1
        m.click()
        return window.__T.idOf(m)
      })()
    `)
    check('点中「餐饮」大类', restaurantId > 0, `id=${restaurantId}`)
    await sleep(450)

    const leaves = await cdp.evaluate(`
      (function () {
        return JSON.stringify(window.__T.pickLeaves().map(function (e) { return window.__T.label(e) }))
      })()
    `)
    const leafNames = JSON.parse(leaves)
    check('出现 9 个小类，第一个是「早餐」', leafNames.length === 9 && leafNames[0].indexOf('早餐') >= 0, leafNames.join(' / '))

    const lunchId = await cdp.evaluate(`
      (function () {
        var l = window.__T.pickLeaves().find(function (e) {
          return window.__T.label(e).indexOf('午餐') >= 0
        })
        if (!l) return -1
        l.click()
        return window.__T.idOf(l)
      })()
    `)
    check('点中小类「午餐」', lunchId > 0, `id=${lunchId}`)
    await sleep(400)

    const saveEnabled = await cdp.evaluate(`window.__T.one('save').disabled`)
    check('金额和分类都填好后，保存按钮可点', saveEnabled === false)

    // ---------- 8. 填备注、选支付方式、记录当前日期 ----------
    await cdp.evaluate(`window.__T.setInput(window.__T.one('note'), '公司楼下快餐')`)
    await cdp.evaluate(`window.__T.click(window.__T.one('payment-alipay'))`)
    await sleep(400)
    const dateBeforeSave = await cdp.evaluate(`window.__T.one('date').value`)
    check('日期默认是今天', /^\d{4}-\d{2}-\d{2}$/.test(dateBeforeSave), dateBeforeSave)

    // ---------- 9. 保存 ----------
    await cdp.evaluate(`window.__T.click(window.__T.one('save'))`)
    await sleep(1000)

    const toast = await cdp.evaluate(`
      (function () { var t = window.__T.one('save-toast'); return t ? window.__T.label(t) : '（没有确认条）' })()
    `)
    check('保存后出现确认条', toast.indexOf('已记下') >= 0, toast)
    check('确认条里带分类名和金额', toast.indexOf('餐饮') >= 0 && toast.indexOf('28.50') >= 0, toast)

    const usageAfter = await cdp.evaluate(`window.ht.categories.usage()`)
    check(
      '数据库里真的多了一笔（不是只显示了一下）',
      usageAfter[lunchId] === 1,
      `午餐名下 ${usageAfter[lunchId] ?? 0} 笔`
    )

    // ---------- 10. 保存后清空了哪些、保留了哪些 ----------
    const afterSave = await cdp.evaluate(`
      (function () {
        var chosen = window.__T.pickLeaves().filter(function (e) {
          return e.getAttribute('aria-pressed') === 'true'
        })
        return JSON.stringify({
          amount: window.__T.one('amount').value,
          note: window.__T.one('note').value,
          date: window.__T.one('date').value,
          payment: window.__T.one('payment-alipay').getAttribute('aria-pressed'),
          selectedLeaves: chosen.length
        })
      })()
    `)
    const a = JSON.parse(afterSave)
    check('金额已清空', a.amount === '', `「${a.amount}」`)
    check('备注已清空', a.note === '', `「${a.note}」`)
    check('分类已清空（防止忘了改就静默记错）', a.selectedLeaves === 0, `${a.selectedLeaves} 个选中`)
    check('日期保留了', a.date === dateBeforeSave, a.date)
    check('支付方式保留了（支付宝）', a.payment === 'true', `aria-pressed=${a.payment}`)

    const refocused = await cdp.evaluate(`window.__T.activeIs('amount')`)
    check('保存后光标回到金额框（可以接着记下一笔）', refocused === true)

    // ---------- 11. 回车也能保存 ----------
    await cdp.evaluate(`
      (function () {
        var m = window.__T.pickMajors().find(function (e) {
          return window.__T.label(e).indexOf('餐饮') >= 0
        })
        m.click()
      })()
    `)
    await sleep(400)
    const breakfastId = await cdp.evaluate(`
      (function () {
        var l = window.__T.pickLeaves().find(function (e) {
          return window.__T.label(e).indexOf('早餐') >= 0
        })
        l.click()
        return window.__T.idOf(l)
      })()
    `)
    await sleep(350)
    await cdp.evaluate(`window.__T.setInput(window.__T.one('amount'), '8')`)
    await sleep(250)
    await cdp.evaluate(`window.__T.enter(window.__T.one('amount'))`)
    await sleep(1000)

    const usageAfterEnter = await cdp.evaluate(`window.ht.categories.usage()`)
    check(
      '在金额框按回车也能保存',
      usageAfterEnter[breakfastId] === 1,
      `早餐名下 ${usageAfterEnter[breakfastId] ?? 0} 笔`
    )

    // ---------- 12. 连点两下只记一笔 ----------
    await cdp.evaluate(`
      (function () {
        var m = window.__T.pickMajors().find(function (e) {
          return window.__T.label(e).indexOf('餐饮') >= 0
        })
        m.click()
      })()
    `)
    await sleep(400)
    const dinnerId = await cdp.evaluate(`
      (function () {
        var l = window.__T.pickLeaves().find(function (e) {
          return window.__T.label(e).indexOf('晚餐') >= 0
        })
        l.click()
        return window.__T.idOf(l)
      })()
    `)
    await sleep(350)
    await cdp.evaluate(`window.__T.setInput(window.__T.one('amount'), '66')`)
    await sleep(250)
    // 同一帧内点两下
    await cdp.evaluate(`
      (function () {
        var b = window.__T.one('save')
        b.click()
        b.click()
      })()
    `)
    await sleep(1200)

    const usageAfterDouble = await cdp.evaluate(`window.ht.categories.usage()`)
    check(
      '连点两下保存只记一笔（重复记账当场看不出来，必须挡住）',
      usageAfterDouble[dinnerId] === 1,
      `晚餐名下 ${usageAfterDouble[dinnerId] ?? 0} 笔`
    )

    // ---------- 13. 就地新建小类并自动选中 ----------
    await cdp.evaluate(`
      (function () {
        var m = window.__T.pickMajors().find(function (e) {
          return window.__T.label(e).indexOf('餐饮') >= 0
        })
        m.click()
      })()
    `)
    await sleep(450)
    await cdp.evaluate(`window.__T.click(window.__T.one('pick-leaf-create'))`)
    await sleep(350)
    const hasInput = await cdp.evaluate(`!!window.__T.one('pick-leaf-create-input')`)
    check('点「＋ 新建」出现输入框', hasInput === true)

    await cdp.evaluate(`window.__T.setInput(window.__T.one('pick-leaf-create-input'), '下午茶')`)
    await sleep(250)
    await cdp.evaluate(`window.__T.enter(window.__T.one('pick-leaf-create-input'))`)
    await sleep(1100)

    const newLeaf = await cdp.evaluate(`
      (function () {
        var l = window.__T.pickLeaves().find(function (e) {
          return window.__T.label(e).indexOf('下午茶') >= 0
        })
        if (!l) return JSON.stringify({ found: false })
        return JSON.stringify({ found: true, pressed: l.getAttribute('aria-pressed'), id: window.__T.idOf(l) })
      })()
    `)
    const nl = JSON.parse(newLeaf)
    check('新建的小类出现在列表里', nl.found === true)
    check('新建完自动选中了它（不用再点一次）', nl.pressed === 'true', `aria-pressed=${nl.pressed}`)

    // ---------- 14. 新建重名给中文提示 ----------
    await cdp.evaluate(`window.__T.click(window.__T.one('pick-leaf-create'))`)
    await sleep(300)
    await cdp.evaluate(`window.__T.setInput(window.__T.one('pick-leaf-create-input'), '午餐')`)
    await sleep(250)
    await cdp.evaluate(`window.__T.enter(window.__T.one('pick-leaf-create-input'))`)
    await sleep(900)
    const dupErr = await cdp.evaluate(`
      (function () { var e = window.__T.one('pick-error'); return e ? window.__T.label(e) : '（没有提示）' })()
    `)
    check('新建重名小类给中文提示', dupErr.indexOf('已存在') >= 0, dupErr)
    check('重名提示里没有英文前缀', dupErr.indexOf('Error') < 0, dupErr)

    // ---------- 15. 数据库写入失败时保留已填内容 ----------
    // 用错误金额触发失败路径：金额框已经挡住非法输入，所以直接调 API 相关路径验证不了；
    // 这里改成验证「金额被清空后点保存给中文提示且不丢备注」
    await cdp.evaluate(`
      (function () {
        window.__T.setInput(window.__T.one('note'), '这段备注不能丢')
        window.__T.setInput(window.__T.one('amount'), '')
      })()
    `)
    await sleep(300)
    const disabledNoAmount = await cdp.evaluate(`window.__T.one('save').disabled`)
    check('金额为空时保存按钮禁用（点不了就不会误记）', disabledNoAmount === true)

    await cdp.evaluate(`window.__T.click(window.__T.one('save'))`)
    await sleep(400)
    const noteKept = await cdp.evaluate(`window.__T.one('note').value`)
    check('保存没成功时（金额为空），已填的备注不会丢', noteKept === '这段备注不能丢', `「${noteKept}」`)

    // ---------- 16. 保存按钮禁用时必须说清「还差什么」 ----------
    const hintNoAmount = await cdp.evaluate(`window.__T.label(window.__T.one('save-hint'))`)
    check('金额为空时，按钮下方说清「还差一步：请输入金额」', hintNoAmount.indexOf('请输入金额') >= 0, hintNoAmount)

    // 先把分类清掉：切到「收入」再切回「支出」，切收支会清空已选分类
    await cdp.evaluate(`window.__T.click(window.__T.one('kind-income'))`)
    await sleep(400)
    await cdp.evaluate(`window.__T.click(window.__T.one('kind-expense'))`)
    await sleep(400)

    await cdp.evaluate(`window.__T.setInput(window.__T.one('amount'), '50')`)
    await sleep(300)
    const hintNoCategory = await cdp.evaluate(`window.__T.label(window.__T.one('save-hint'))`)
    check(
      '金额填了、分类没选时，说清「还差一步：请选择分类」',
      hintNoCategory.indexOf('请选择分类') >= 0,
      hintNoCategory
    )

    // ---------- 17. 真正的写入失败：已填内容必须保住 ----------
    // 这一条之前是空转的（把金额清空再看备注有没有变 —— 无论错误处理写没写对都会过）。
    // 改成走真实失败路径：选好分类后，在别处把该分类归档掉，
    // 再点保存 —— 仓储层会以「所选的分类已被删除」拒绝写入。
    await cdp.evaluate(`
      (function () {
        var m = window.__T.pickMajors().find(function (e) {
          return window.__T.label(e).indexOf('餐饮') >= 0
        })
        m.click()
      })()
    `)
    await sleep(400)
    const doomedId = await cdp.evaluate(`
      (function () {
        var l = window.__T.pickLeaves().find(function (e) {
          return window.__T.label(e).indexOf('夜宵') >= 0
        })
        l.click()
        return window.__T.idOf(l)
      })()
    `)
    await sleep(400)
    await cdp.evaluate(`
      (function () {
        window.__T.setInput(window.__T.one('amount'), '88.88')
        window.__T.setInput(window.__T.one('note'), '这笔一定会失败')
      })()
    `)
    await sleep(300)

    // 在后台把该分类归档掉（模拟「在设置页删了它，记账页还没刷新」）
    await cdp.evaluate(`window.ht.categories.archive(${doomedId})`)
    await sleep(300)

    await cdp.evaluate(`window.__T.click(window.__T.one('save'))`)
    await sleep(1300)

    const failErr = await cdp.evaluate(`
      (function () { var e = window.__T.one('add-error'); return e ? window.__T.label(e) : '（没有提示）' })()
    `)
    const failState = await cdp.evaluate(`
      JSON.stringify({
        amount: window.__T.one('amount').value,
        note: window.__T.one('note').value
      })
    `)
    const f = JSON.parse(failState)
    check('分类在别处被删后保存，给出中文错误提示', failErr.indexOf('分类') >= 0, failErr)
    check('写入失败时金额没被清空', f.amount === '88.88', `「${f.amount}」`)
    check('写入失败时备注没被清空', f.note === '这笔一定会失败', `「${f.note}」`)

    // 恢复：把夜宵还回来
    await cdp.evaluate(`window.ht.categories.restore(${doomedId})`)
    await sleep(300)

    // ---------- 18. 手动改过的日期，保存后要跳回今天 ----------
    // 用户确认的取舍：日期只保留「今天」。补记一笔旧账后如果日期一直留着，
    // 后面每一笔都会被静默记到那个旧日期，而那种错当场看不出来。
    await cdp.evaluate(`window.__T.setInput(window.__T.one('amount'), '')`)
    await cdp.evaluate(`
      (function () {
        var m = window.__T.pickMajors().find(function (e) {
          return window.__T.label(e).indexOf('居住') >= 0
        })
        m.click()
      })()
    `)
    await sleep(450)
    const rentId = await cdp.evaluate(`
      (function () {
        var l = window.__T.pickLeaves().find(function (e) {
          return window.__T.label(e).indexOf('房租') >= 0
        })
        l.click()
        return window.__T.idOf(l)
      })()
    `)
    await sleep(400)

    today = await cdp.evaluate(`window.ht.transactions.today()`)
    await cdp.evaluate(`window.__T.setInput(window.__T.one('amount'), '1234.56')`)
    await sleep(250)

    // 手动把日期改成很久以前
    await cdp.evaluate(`
      (function () {
        var d = window.__T.one('date')
        window.__T.setInput(d, '2020-01-15')
        d.dispatchEvent(new Event('change', { bubbles: true }))
      })()
    `)
    await sleep(400)
    const dateSetBack = await cdp.evaluate(`window.__T.one('date').value`)
    check('能把日期手动改成过去的某一天', dateSetBack === '2020-01-15', dateSetBack)

    await cdp.evaluate(`window.__T.click(window.__T.one('save'))`)
    await sleep(1300)

    const dateAfterBackdatedSave = await cdp.evaluate(`window.__T.one('date').value`)
    check(
      '补记一笔旧账后，日期自动跳回今天（不会把旧日期带到后面每一笔）',
      dateAfterBackdatedSave === today,
      `保存后日期是 ${dateAfterBackdatedSave}，今天是 ${today}`
    )

    // 再记一笔今天的，确认落在今天
    await cdp.evaluate(`
      (function () {
        var m = window.__T.pickMajors().find(function (e) {
          return window.__T.label(e).indexOf('餐饮') >= 0
        })
        m.click()
      })()
    `)
    await sleep(450)
    await cdp.evaluate(`
      (function () {
        var l = window.__T.pickLeaves().find(function (e) {
          return window.__T.label(e).indexOf('早餐') >= 0
        })
        l.click()
      })()
    `)
    await sleep(400)
    await cdp.evaluate(`window.__T.setInput(window.__T.one('amount'), '9.9')`)
    await sleep(250)
    await cdp.evaluate(`window.__T.click(window.__T.one('save'))`)
    await sleep(1300)

    // ---------- 19. 在设置页新建的大类，切回记账页要能看到 ----------
    // 复核发现的严重问题：四个页面常驻挂载，只在挂载时拉一次数据的话，
    // 设置页新建的分类在记账页根本看不到 —— 而大类只能从设置页创建。
    await cdp.evaluate(`
      (function () {
        var btns = Array.prototype.slice.call(document.querySelectorAll('nav button'))
        var t = btns.find(function (b) { return window.__T.norm(b.innerText).indexOf('设置') >= 0 })
        t.click()
      })()
    `)
    await sleep(600)
    await cdp.evaluate(`
      (function () {
        window.__T.setInput(window.__T.one('new-major-name'), '宠物')
        window.__T.one('new-major-add').click()
      })()
    `)
    await sleep(1200)

    await cdp.evaluate(`
      (function () {
        var btns = Array.prototype.slice.call(document.querySelectorAll('nav button'))
        var t = btns.find(function (b) { return window.__T.norm(b.innerText).indexOf('记一笔') >= 0 })
        t.click()
      })()
    `)
    await sleep(1000)
    const seesNewMajor = await cdp.evaluate(`
      JSON.stringify(window.__T.pickMajors().map(function (e) { return window.__T.label(e) }))
    `)
    check(
      '在设置页新建的「宠物」大类，切回记账页立刻能看到（不用重启软件）',
      seesNewMajor.indexOf('宠物') >= 0,
      seesNewMajor
    )

    // ---------- 20. 记账页自己的错误提示与设置页的不会互相干扰 ----------
    const crossPageOk = await cdp.evaluate(`
      (function () {
        var addErr = document.querySelectorAll('[data-testid="add-error"]').length
        var settingsErr = document.querySelectorAll('[data-testid="error-banner"]').length
        return JSON.stringify({ addErr: addErr, settingsErr: settingsErr })
      })()
    `)
    check('记账页与设置页的错误条标识不再重名', JSON.parse(crossPageOk).addErr <= 1, crossPageOk)

    session.ws.close()
  } finally {
    session.child.kill()
    await sleep(1500)
  }

  // ---------- 21. 直接读数据库文件，确认日期真的按预期存了 ----------
  {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(USER_DATA, 'ht-jizhang.db'), { readOnly: true })
    const rows = db
      .prepare('SELECT occurred_on, amount_fen FROM transactions ORDER BY id')
      .all()
    db.close()

    const byAmount = new Map(rows.map((r) => [r.amount_fen, r.occurred_on]))
    check(
      '补记的那笔（1234.56 元）存的是手动选的 2020-01-15',
      byAmount.get(123456) === '2020-01-15',
      `实际存的是 ${byAmount.get(123456)}`
    )
    check(
      '紧接着记的那笔（9.9 元）存的是今天，没有被上一笔的旧日期带跑',
      byAmount.get(990) === today,
      `实际存的是 ${byAmount.get(990)}，今天是 ${today}`
    )
    const allLocalDateFormat = rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.occurred_on))
    check('所有日期都是 YYYY-MM-DD 的本地日期串，没有时间戳混进来', allLocalDateFormat)
  }

  // ---------- 16. 重开软件，数据还在（真的落库了） ----------
  session = await launch()
  cdp = session.cdp
  try {
    const usageAfterRestart = await cdp.evaluate(`window.ht.categories.usage()`)
    const total = Object.values(usageAfterRestart).reduce((n, v) => n + v, 0)
    const rows = Object.entries(usageAfterRestart)
      .map(([id, n]) => `${id}:${n}`)
      .join(' ')
    check(
      '重开软件后，刚才记的 5 笔还在（真的落库了，不是只存在内存里）',
      total === 5,
      `共 ${total} 笔 —— ${rows}`
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
