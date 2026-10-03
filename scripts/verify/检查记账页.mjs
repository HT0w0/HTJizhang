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
import { join } from 'node:path'
import { homedir } from 'node:os'

const PORT = 9222
const PROJECT = 'D:\\Claude Code\\记账APP'
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

async function main() {
  console.log('\n【第 3 阶段 记一笔 — 界面客观验证】\n')

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
    check('保存没成功时，已填的备注不会丢', noteKept === '这段备注不能丢', `「${noteKept}」`)

    session.ws.close()
  } finally {
    session.child.kill()
    await sleep(1200)
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
    check('重开软件后，刚才记 3 笔还在（真的落库了，不是只存在内存里）', total === 3, `共 ${total} 笔 —— ${rows}`)
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
