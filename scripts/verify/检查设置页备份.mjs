/**
 * 第 6 阶段「数据备份」的界面客观验证。
 *
 * 按 CLAUDE.md §九：真启动打包版本，用 Electron 调试接口（CDP）
 * 在真实渲染进程里读 DOM、驱动真实点击。
 *
 * 这个脚本要盯住的是**「当场看不出来」和「一旦错了就丢数据」的错**：
 *   - 恢复是**全软件唯一不可逆**的操作。它出错时用户当场看不出来 ——
 *     账本看着好好的，只是若干个月前的账没了；
 *   - 替换前那份「后悔药」有没有真的写下来、写的是不是**替换前**的内容。
 *     写反了（写成了替换后的）平时完全看不出来，等用户真选错文件想找回时才发现；
 *   - 确认框里有没有写清「备份里几笔 / 当前几笔」——
 *     那是用户判断自己选没选错文件的**唯一依据**；
 *   - 「用户取消」和「选错文件」被说成失败（弹红字），会让用户以为账本出了问题；
 *   - 导出表格时选的是 9 月、导出来的却是全部账单 —— 表格能打开，数字也对，
 *     只是多了一批不该有的行。
 *
 * ## 原生文件框怎么办
 *
 * 「另存为」和「选择文件」是**操作系统的窗口**，CDP 够不着、点不动，
 * 于是导出和恢复这两条路径一步都走不了。所以主进程里有一对只在非打包环境
 * 生效的替身（`HT_TEST_SAVE_DIR` / `HT_TEST_OPEN_PATH`，见 CLAUDE.md §5.27）：
 * 设了就直接用那个路径，不弹框。**它不跳过确认框** —— 恢复照样得看到警告、
 * 点「替换」。打包给用户的那份里这条分支不存在（`app.isPackaged` 挡着）。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE node "scripts/verify/检查设置页备份.mjs"
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * 调试端口：本脚本从 BASE_PORT 起，每次启动 Electron 往后挪一个。
 * 别和别的脚本重复（9222/9232/9242/9252/9262 已被占用）。理由见 README。
 */
const BASE_PORT = 9272
let portSeq = 0

/** 取下一个调试端口。每次启动 Electron 都用一个新的。 */
function nextPort() {
  return BASE_PORT + portSeq++
}

const PROJECT = join(import.meta.dirname, '..', '..')
const ELECTRON = join(PROJECT, 'node_modules', 'electron', 'dist', 'electron.exe')

/**
 * 数据目录：**不是**软件真实的数据目录。
 * 见 README「两个必须守住的规矩」和 CLAUDE.md §九。**别去掉 --user-data-dir。**
 */
const USER_DATA = join(PROJECT, '.verify-data', '设置页备份')

/** 假的「另存为」把文件丢在这个目录里。刻意放在数据目录**外面**，免得和账本文件混在一起。 */
const SAVE_DIR = join(PROJECT, '.verify-data', '设置页备份-导出')

/** 账本文件名，和 src/main/db/connection.ts 里的 DB_FILE_NAME 一致。 */
const DB_NAME = 'ht-jizhang.db'

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 列出某个目录里以某段文字开头、某段文字结尾的文件名。目录不存在时给空数组。 */
function listFiles(dir, prefix = '', suffix = '') {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.filter((n) => n.startsWith(prefix) && n.endsWith(suffix))
}

/**
 * 直接打开一个 .db 数它有几笔账。
 *
 * 脚本跑在普通 Node 24 下，`node:sqlite` 是内置的，所以能自己开备份文件核对 ——
 * 「界面上提示导出成功」和「导出来的文件里真有那几笔账」是两件事，
 * 只查前者的话，写了个空文件也照样通过。
 */
function countTransactions(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare('SELECT count(*) AS n FROM transactions').get().n
  } finally {
    db.close()
  }
}

const HELPERS = String.raw`
window.__T = {
  norm(s) { return String(s || '').replace(/\s+/g, ' ').trim() },
  one(t) { return document.querySelector('[data-testid="' + t + '"]') },
  count(t) { return document.querySelectorAll('[data-testid="' + t + '"]').length },
  text(t) { var e = this.one(t); return e ? e.textContent : null },
  label(t) { return this.norm(this.text(t)) },

  /**
   * 元素是不是**真的显示在屏幕上**，而不只是「存在于 DOM 里」。
   *
   * 必须有这一条：四个页面常驻挂载，非当前的页面被 hidden 藏着 ——
   * 而**藏在里面的元素照样有 textContent**。只读文字的话，
   * 检查会在「用户其实一个字都看不见」的情况下「通过」。
   * 2026-10-04 独立复核就是在恢复提示上抓到这一点的。
   */
  shown(t) {
    var e = this.one(t)
    if (!e) return null
    return e.offsetParent !== null
  },

  click(el) { if (el) el.click() },
  disabled(t) { var e = this.one(t); return e ? !!e.disabled : null },

  /** 下拉框里所有选项的文字，按顺序。 */
  optionTexts(t) {
    var e = this.one(t)
    if (!e) return null
    return Array.prototype.slice.call(e.options).map(function (o) { return o.textContent.trim() })
  },
  optionValues(t) {
    var e = this.one(t)
    if (!e) return null
    return Array.prototype.slice.call(e.options).map(function (o) { return o.value })
  },
  /** 选下拉框里某一项。必须派发 change 事件 —— 直接改 .value React 收不到。 */
  select(t, value) {
    var e = this.one(t)
    if (!e) return false
    e.value = value
    e.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  },

  /** 所有 data-testid 里出现两次以上的（四个页面常驻挂载，重名是常态风险）。 */
  duplicatedTestIds() {
    var seen = {}, dup = []
    Array.prototype.slice.call(document.querySelectorAll('[data-testid]')).forEach(function (e) {
      var t = e.dataset.testid
      seen[t] = (seen[t] || 0) + 1
    })
    Object.keys(seen).forEach(function (t) { if (seen[t] > 1) dup.push(t + '×' + seen[t]) })
    return dup
  }
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

/**
 * 发消息给一个已经关掉的调试连接时会抛出这句话。
 * 出现它就说明**检查脚本自己写错了**（用了一个已经 shutdown 的 cdp 会话），
 * 不是软件有问题 —— 措辞里必须说清这一点，否则下一个看到它的人会去查软件。
 */
const CLOSED_HINT =
  '调试连接已关闭。这个检查用错了 cdp 会话（多半是用了一个已经 shutdown 的 session.cdp）——' +
  '这是验证脚本自身的缺陷，不是软件的问题。'

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    /** 连接关掉之后置 true。见 send() 里的说明。 */
    this.closed = false
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        p.resolve(msg)
      }
    })
    ws.addEventListener('close', () => {
      this.closed = true
      // 连接关了，还在等回复的那些请求永远等不到了：显式拒掉，
      // 别让它们的 Promise 悬着（否则整个脚本静默卡死）。
      for (const p of this.pending.values()) p.reject(new Error(CLOSED_HINT))
      this.pending.clear()
    })
  }
  send(method, params = {}) {
    // 2026-10-04 实际踩过：一条检查误用了**已经 shutdown 的 cdp**，
    // ws.send 把请求发进一个死连接，回包永远不会来，Promise 永不返回 ——
    // 脚本既不报错也不打印结果汇总，就那样静默挂着（现象是「进程还在、日志不动」）。
    // 所以这里必须显式拒掉：错的是脚本，就该立刻说清楚，而不是假装在等。
    if (this.closed || this.ws.readyState !== 1) {
      return Promise.reject(new Error(CLOSED_HINT))
    }
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
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
  async json(expression) {
    const raw = await this.evaluate(`(async () => JSON.stringify(await (${expression})))()`)
    return raw === undefined ? undefined : JSON.parse(raw)
  }
}

/**
 * 启动一份 Electron。
 *
 * env 里额外传的 `HT_TEST_*` 就是弹框替身，见文件顶部的说明。
 */
async function launch(extraEnv = {}) {
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
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ...extraEnv },
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
  await cdp.send('Page.enable')
  await sleep(900)
  await cdp.evaluate(HELPERS)
  return { child, ws, cdp }
}

/**
 * 重新载入界面，并把工具函数重新注入一遍。
 *
 * `window.__T` 挂在 window 上，载入一次就没了 —— 忘了重新注入的话，
 * 后面每条检查都会以「页面执行出错：__T is not defined」收场，
 * 屏幕上只剩一行报错，看不出是哪几项真的失败了。
 */
async function reload(session) {
  await session.cdp.evaluate(`location.reload()`)
  await sleep(1400)
  await session.cdp.evaluate(HELPERS)
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

async function waitFor(cdp, expression, ms = 5000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await cdp.evaluate(expression)) return true
    if (Date.now() > deadline) return false
    await sleep(150)
  }
}

async function shutdown(session) {
  try {
    session.ws.close()
    session.child.kill()
  } catch {
    /* 已经退了 */
  }
  // Windows 上子进程不会立刻消失，不等一下下一次启动会撞上同一个数据目录
  await sleep(1200)
}

/** 通过 IPC 记一笔账。界面上记一笔要走完整表单，这里只关心数据。 */
async function seed(cdp, occurredOn, amountFen, note) {
  return await cdp.json(`(async () => {
    var cats = await window.ht.categories.list()
    var major = cats.find(function (c) { return c.name === '餐饮' })
    var minor = major.children[0]
    return await window.ht.transactions.create({
      kind: 'expense', amountFen: ${amountFen}, categoryId: minor.id,
      occurredOn: ${JSON.stringify(occurredOn)}, note: ${JSON.stringify(note)}, paymentMethod: 'wechat'
    })
  })()`)
}

/** 当前账本里有几笔账（走界面同一条取数链路）。 */
async function txCount(cdp) {
  return await cdp.json(
    `(await window.ht.transactions.list({ month: '2026-09', kind: 'all', keyword: '' })).length` +
      ` + (await window.ht.transactions.list({ month: '2026-10', kind: 'all', keyword: '' })).length`
  )
}

async function main() {
  // 清空隔离目录。**不是**用户的 %APPDATA%\HTJizhang（CLAUDE.md §九）。
  rmSync(USER_DATA, { recursive: true, force: true })
  rmSync(SAVE_DIR, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  // 假的「另存为」会把文件写进这个目录，得先建出来
  mkdirSync(SAVE_DIR, { recursive: true })

  const today = new Date().toISOString().slice(0, 10)
  let session = null

  try {
    // -----------------------------------------------------------------
    // 第一程：导出（备份文件 / 表格）+ 用户取消 + 界面长什么样
    // -----------------------------------------------------------------
    session = await launch({
      HT_TEST_SAVE_DIR: SAVE_DIR,
      // 这一程只验证「取消」，所以选择框的替身返回「用户点了取消」
      HT_TEST_OPEN_PATH: '__cancel__'
    })
    const { cdp } = session

    await goto(cdp, '设置')

    // ---------- 1. 区域与按钮 ----------
    check(
      '设置页有「数据备份」区域',
      (await cdp.evaluate(`window.__T.count('backup-section')`)) === 1
    )

    const buttons = await cdp.json(`({
      exportDb: window.__T.count('export-db'),
      exportCsv: window.__T.count('export-csv'),
      openFolder: window.__T.count('open-folder'),
      restore: window.__T.count('restore-pick'),
      monthSelect: window.__T.count('csv-month')
    })`)
    check(
      '四个动作按钮和一个月份下拉框都在，且各只有一个（重名会让脚本抓错元素）',
      buttons.exportDb === 1 &&
        buttons.exportCsv === 1 &&
        buttons.openFolder === 1 &&
        buttons.restore === 1 &&
        buttons.monthSelect === 1,
      JSON.stringify(buttons)
    )

    const idle = await cdp.json(`({
      exportDb: window.__T.disabled('export-db'),
      restore: window.__T.disabled('restore-pick')
    })`)
    check(
      '闲着的时候按钮不是灰的（灰着＝用户点了没反应，而且看不出为什么）',
      idle.exportDb === false && idle.restore === false,
      JSON.stringify(idle)
    )

    check(
      '一开始没有确认框，也没有任何红字提示（一进来就报错会让人以为账本坏了）',
      (await cdp.evaluate(`window.__T.count('confirm-dialog')`)) === 0 &&
        (await cdp.evaluate(`window.__T.count('backup-error')`)) === 0
    )

    // ---------- 2. 没有账的时候，下拉框只有「全部账单」 ----------
    const emptyOptions = await cdp.json(`window.__T.optionTexts('csv-month')`)
    check(
      '一笔账都没有时，导出范围只有「全部账单」一项（没有可选的月份）',
      Array.isArray(emptyOptions) && emptyOptions.length === 1 && emptyOptions[0] === '全部账单',
      JSON.stringify(emptyOptions)
    )

    // ---------- 3. 记两笔账（分属两个月），下拉框要列出这两个月 ----------
    const sept = await seed(cdp, '2026-09-15', 1234, '九月的账')
    const oct = await seed(cdp, '2026-10-02', 5678, '十月的账')
    check('先记两笔账（分属 9 月和 10 月），后面才有东西可导', !!sept?.id && !!oct?.id)

    await reload(session)
    await goto(cdp, '设置')

    const options = await cdp.json(`window.__T.optionTexts('csv-month')`)
    check(
      '月份下拉框列出了有账的月份，且默认停在「全部账单」（默认成某个月会悄悄少导数据）',
      Array.isArray(options) &&
        options[0] === '全部账单' &&
        options.includes('2026年9月') &&
        options.includes('2026年10月'),
      JSON.stringify(options)
    )
    check(
      '下拉框里没有「2026年8月」这种没记过账的月份（列一堆空月份只会让用户挑错）',
      Array.isArray(options) && !options.includes('2026年8月'),
      JSON.stringify(options)
    )

    // ---------- 4. 导出备份文件 ----------
    await cdp.evaluate(`window.__T.click(window.__T.one('export-db'))`)
    const dbNoticeShown = await waitFor(cdp, `window.__T.count('backup-notice') === 1`, 6000)
    const dbNotice = await cdp.evaluate(`window.__T.text('backup-notice')`)
    check(
      '点「导出备份文件」之后给出提示，并把存到哪儿写出来了（不写路径，用户回头找不到文件）',
      dbNoticeShown && typeof dbNotice === 'string' && dbNotice.includes(SAVE_DIR),
      String(dbNotice)
    )

    const dbFiles = listFiles(SAVE_DIR, 'HT记账-备份-', '.db')
    check(
      '备份文件真的落到磁盘上了，而且文件名是「HT记账-备份-日期」',
      dbFiles.length === 1 && dbFiles[0] === `HT记账-备份-${today}.db`,
      dbFiles.join(', ')
    )
    check(
      '导出来的备份里确实有那 2 笔账（只查「提示成功」的话，导出个空文件也照样通过）',
      dbFiles.length === 1 && countTransactions(join(SAVE_DIR, dbFiles[0])) === 2,
      dbFiles.length === 1 ? `${countTransactions(join(SAVE_DIR, dbFiles[0]))} 笔` : '没有文件'
    )

    // ---------- 5. 导出表格：选哪个月就导哪个月 ----------
    await cdp.evaluate(`window.__T.select('csv-month', '2026-09')`)
    await sleep(200)
    await cdp.evaluate(`window.__T.click(window.__T.one('export-csv'))`)
    await waitFor(cdp, `window.__T.count('backup-notice') === 1`, 6000)
    await sleep(200)

    const septCsv = listFiles(SAVE_DIR, 'HT记账-账单-2026-09', '.csv')
    check(
      '选 9 月导表格，文件名里带的是 9 月',
      septCsv.length === 1,
      listFiles(SAVE_DIR, 'HT记账-账单-', '.csv').join(', ')
    )
    if (septCsv.length === 1) {
      const text = readFileSync(join(SAVE_DIR, septCsv[0]), 'utf8')
      check(
        '选的 9 月，导出来就只有 9 月那笔（多导出一个月的账，表格照样能打开，没人看得出来）',
        text.includes('九月的账') && !text.includes('十月的账'),
        `含九月=${text.includes('九月的账')} 含十月=${text.includes('十月的账')}`
      )
      check(
        '表格开头带 BOM（少了它 Excel 打开中文备注是乱码）',
        text.charCodeAt(0) === 0xfeff,
        `首字符码 ${text.charCodeAt(0)}`
      )
      check(
        '表格第一行是表头，且是中文（用户直接看这一行就知道每列是什么）',
        text.includes('日期') && text.includes('金额(元)'),
        text.slice(1, 60).replace(/\r?\n/g, ' | ')
      )
    }

    // ---------- 6. 切回「全部账单」，两笔都要在 ----------
    await cdp.evaluate(`window.__T.select('csv-month', '')`)
    await sleep(200)
    await cdp.evaluate(`window.__T.click(window.__T.one('export-csv'))`)
    await waitFor(cdp, `window.__T.count('backup-notice') === 1`, 6000)
    await sleep(200)

    const allCsv = listFiles(SAVE_DIR, 'HT记账-账单-全部-', '.csv')
    check(
      '选「全部账单」导表格，两笔账都在',
      allCsv.length === 1 &&
        readFileSync(join(SAVE_DIR, allCsv[0]), 'utf8').includes('九月的账') &&
        readFileSync(join(SAVE_DIR, allCsv[0]), 'utf8').includes('十月的账'),
      allCsv.join(', ')
    )

    // ---------- 7. 用户取消不是错误 ----------
    await cdp.evaluate(`window.__T.click(window.__T.one('restore-pick'))`)
    await sleep(800)
    check(
      '在文件框里点「取消」之后：不弹确认框、界面上不出现任何红字报错',
      (await cdp.evaluate(`window.__T.count('confirm-dialog')`)) === 0 &&
        (await cdp.evaluate(`window.__T.count('backup-error')`)) === 0,
      await cdp.evaluate(`JSON.stringify(window.__T.text('backup-error'))`)
    )
    check(
      '取消之后按钮回到可用状态（一直灰着＝用户以为卡死了）',
      (await cdp.evaluate(`window.__T.disabled('restore-pick')`)) === false
    )
    check(
      '取消之后账本一笔没少',
      (await txCount(cdp)) === 2,
      `现在 ${await txCount(cdp)} 笔`
    )

    await shutdown(session)
    session = null

    // -----------------------------------------------------------------
    // 第二程：完整的恢复流程（点按钮 → 确认框 → 替换 → 重载 → 提示）
    // -----------------------------------------------------------------
    const backupFile = join(SAVE_DIR, `HT记账-备份-${today}.db`)
    session = await launch({ HT_TEST_SAVE_DIR: SAVE_DIR, HT_TEST_OPEN_PATH: backupFile })
    const cdp2 = session.cdp

    // 先多记一笔，让「当前账本」和「备份」的笔数**不一样** ——
    // 两边一样的话，「有没有真的换掉」根本判断不出来。
    await seed(cdp2, '2026-10-03', 999, '备份里没有的一笔')
    const beforeRestore = await txCount(cdp2)
    check(
      '恢复前：当前账本 3 笔、备份里 2 笔，两边不一样（不然「换没换」看不出来）',
      beforeRestore === 3,
      `当前 ${beforeRestore} 笔`
    )

    await goto(cdp2, '设置')
    await cdp2.evaluate(`window.__T.click(window.__T.one('restore-pick'))`)

    const dialogShown = await waitFor(cdp2, `window.__T.count('confirm-dialog') === 1`, 6000)
    check('点「从备份恢复」之后弹出了确认框（恢复不可逆，必须先问一句）', dialogShown)

    const warning = dialogShown
      ? await cdp2.evaluate(`window.__T.text('confirm-dialog')`)
      : ''
    check(
      '确认框里写清了**两边各几笔账**：这是用户判断自己选没选错文件的唯一依据',
      warning.includes('备份里有 2 笔账') && warning.includes('当前账本里有 3 笔账'),
      String(warning).slice(0, 120)
    )
    check(
      '确认框里写明了用哪个文件替换、以及替换前会自动另存一份（这句是用户敢按下去的关键）',
      warning.includes(`HT记账-备份-${today}.db`) && warning.includes('导入前自动备份'),
      String(warning).slice(0, 200)
    )
    // 正文里本来就有「导入」两个字 —— 自动备份的文件名叫「导入前自动备份」。
    // 先把文件名抠掉再判断，否则这条检查会因为文件名而永远失败（第一次跑就是这样）。
    const warningBody = String(warning).replace(/HT记账-导入前自动备份-[\d-]+\.db/g, '〔自动备份文件名〕')
    check(
      '确认框正文说的是「替换」而不是「导入」（「导入」听起来像把备份加进现有账本，会让人丢数据）',
      warningBody.includes('替换') && !warningBody.includes('导入'),
      warningBody.slice(0, 160)
    )
    check(
      '确认框的按钮写的是「替换」而不是「确定」（不可逆的操作，按钮上就要说清干什么）',
      (await cdp2.evaluate(`
        (function () {
          var b = window.__T.one('confirm-ok')
          return b ? window.__T.norm(b.innerText) : null
        })()
      `)) === '替换'
    )

    // 还没点确认 —— 这时候账本必须一个字节都没动
    check(
      '只是弹出确认框、还没点「替换」时，账本一点没变（用户反悔了就该什么都没发生）',
      (await txCount(cdp2)) === 3,
      `当前 ${await txCount(cdp2)} 笔`
    )

    // 记录替换前那一笔的备注，用来验证「后悔药」里装的是**替换前**的内容
    await cdp2.evaluate(`window.__T.click(window.__T.one('confirm-ok'))`)
    // 主进程换库 → 界面 location.reload() → 重新注入工具函数
    await sleep(2600)
    await cdp2.evaluate(HELPERS)

    const afterRestore = await cdp2.json(`({
      当前页: window.__T.norm(
        (document.querySelector('nav button.bg-blue-600') || {}).innerText || ''
      ),
      提示文字: window.__T.text('backup-notice'),
      提示可见: window.__T.shown('backup-notice'),
      哨兵_记账页金额框可见: window.__T.shown('amount')
    })`)

    check(
      '替换之后界面重新载入，并显示「已从…恢复，账本现在是 N 笔」',
      typeof afterRestore.提示文字 === 'string' &&
        afterRestore.提示文字.includes('已从') &&
        afterRestore.提示文字.includes('恢复') &&
        afterRestore.提示文字.includes('2 笔'),
      String(afterRestore.提示文字)
    )

    // ⚠️ 上面那条**只读了文字**，而藏在被 hidden 的设置页里的元素照样有文字。
    // 2026-10-04 独立复核实测：提示确实生成了、也确实写进了 DOM，
    // 但重载后界面落在「记一笔」页，用户一个字都看不见 —— 而这条检查一直「通过」。
    // 下面两条才是「用户到底看见没有」。
    check(
      '这句提示**真的显示在屏幕上**（不是只存在于被隐藏的设置页里）',
      afterRestore.提示可见 === true,
      `可见=${afterRestore.提示可见}，文字=${String(afterRestore.提示文字).slice(0, 30)}`
    )
    check(
      '重载之后停在设置页（否则界面跳回「记一笔」，用户看着提示消失却不知道为什么）',
      afterRestore.当前页.includes('设置'),
      afterRestore.当前页
    )
    // 防空转哨兵：证明 shown() 真的分得清「显示」和「藏着」，
    // 而不是不管问什么都回 true（那样上面那条就白测了）。
    check(
      '哨兵：此刻记账页的金额框是隐藏的（证明「可见性」这条检查不是空转）',
      afterRestore.哨兵_记账页金额框可见 === false,
      String(afterRestore.哨兵_记账页金额框可见)
    )

    await goto(cdp2, '账单')
    const rowsAfter = await cdp2.json(`({
      当前月: (await window.ht.transactions.list({ month: '2026-10', kind: 'all', keyword: '' })).length,
      九月: (await window.ht.transactions.list({ month: '2026-09', kind: 'all', keyword: '' })).length,
      有备份里没有的那笔: (await window.ht.transactions.list({ month: '2026-10', kind: 'all', keyword: '备份里没有的一笔' })).length
    })`)
    check(
      '恢复之后账本真的变成了备份里的内容（当月只剩 1 笔，且那笔「备份里没有的」已经不见了）',
      rowsAfter.当前月 === 1 && rowsAfter.九月 === 1 && rowsAfter.有备份里没有的那笔 === 0,
      JSON.stringify(rowsAfter)
    )

    // ---------- 后悔药：替换前的账本必须被另存下来 ----------
    const autoFiles = listFiles(USER_DATA, 'HT记账-导入前自动备份-', '.db')
    check(
      '数据目录里出现了「导入前自动备份」文件（用户选错文件时唯一的退路）',
      autoFiles.length === 1,
      autoFiles.join(', ')
    )
    check(
      '这份自动备份里装的是**替换前**的 3 笔账，不是替换后的 2 笔（装反了平时完全看不出来，' +
        '等用户真选错文件想找回时才发现已经晚了）',
      autoFiles.length === 1 && countTransactions(join(USER_DATA, autoFiles[0])) === 3,
      autoFiles.length === 1 ? `${countTransactions(join(USER_DATA, autoFiles[0]))} 笔` : '没有文件'
    )
    check(
      '恢复没有把账本文件本身弄坏：账本仍能打开且是 2 笔',
      countTransactions(join(USER_DATA, DB_NAME)) === 2,
      `${countTransactions(join(USER_DATA, DB_NAME))} 笔`
    )

    // 重开一次，确认恢复是**落到磁盘上**的，不只是内存里换了
    await shutdown(session)
    session = await launch({ HT_TEST_SAVE_DIR: SAVE_DIR, HT_TEST_OPEN_PATH: '__cancel__' })
    const persisted = await txCount(session.cdp)
    check(
      '重开软件之后账本仍然是恢复后的 2 笔（换的是磁盘上的文件，不是只换了内存）',
      persisted === 2,
      `${persisted} 笔`
    )

    await shutdown(session)
    session = null

    // -----------------------------------------------------------------
    // 第三程：选错文件
    // -----------------------------------------------------------------
    const wrongFile = join(SAVE_DIR, '风景照.jpg')
    writeFileSync(wrongFile, '这不是数据库，只是一段文字')

    session = await launch({ HT_TEST_SAVE_DIR: SAVE_DIR, HT_TEST_OPEN_PATH: wrongFile })
    const cdp3 = session.cdp
    await goto(cdp3, '设置')

    await cdp3.evaluate(`window.__T.click(window.__T.one('restore-pick'))`)
    const errShown = await waitFor(cdp3, `window.__T.count('backup-error') === 1`, 6000)
    const errText = await cdp3.evaluate(`window.__T.text('backup-error')`)
    check(
      '选了个不是备份的文件：给出中文说明（用户看不懂英文报错）',
      errShown && typeof errText === 'string' && /[一-鿿]/.test(errText) && errText.includes('备份'),
      String(errText)
    )
    check(
      '这条中文里没有 Electron 那串英文前缀（有的话用户完全不知道该怎么办）',
      typeof errText === 'string' && !errText.includes('Error invoking remote method'),
      String(errText).slice(0, 120)
    )
    check(
      '选错文件时**不弹**确认框（弹了就说明程序准备拿这张图片去替换账本了）',
      (await cdp3.evaluate(`window.__T.count('confirm-dialog')`)) === 0
    )
    check('选错文件之后账本一个字节都没动', (await txCount(cdp3)) === 2, `${await txCount(cdp3)} 笔`)

    // -----------------------------------------------------------------
    // 第四程：一个「长得像备份」的外来库
    //
    // 2026-10-04 独立复核抓到的最严重的一条。造一个库：表名对得上、
    // `user_version` 是 0（任何别的软件导出的库都可能长这样），但结构不是我们的。
    // 旧实现里它**骗得过体检**，一路走到「把账本文件换掉」，之后迁移才报
    // 「table categories already exists」—— 此时账本已经是那个外来库了，
    // **用户关掉软件就再也打不开**。产品设计文档 §3.5 承诺「选错文件不会有事」。
    // -----------------------------------------------------------------
    const foreignFile = join(SAVE_DIR, '别家软件的库.db')
    {
      const db = new DatabaseSync(foreignFile)
      db.exec('CREATE TABLE transactions (id INTEGER PRIMARY KEY, occurred_on TEXT)')
      db.exec('CREATE TABLE categories (id INTEGER PRIMARY KEY, label TEXT)')
      db.close()
    }

    await shutdown(session)
    session = await launch({ HT_TEST_SAVE_DIR: SAVE_DIR, HT_TEST_OPEN_PATH: foreignFile })
    const cdp4 = session.cdp
    await goto(cdp4, '设置')

    await cdp4.evaluate(`window.__T.click(window.__T.one('restore-pick'))`)
    const foreignShown = await waitFor(cdp4, `window.__T.count('backup-error') === 1`, 6000)
    const foreignText = await cdp4.evaluate(`window.__T.text('backup-error')`)
    check(
      '「表名对得上、结构不是我们的」外来库：给中文说明，不漏英文的 already exists / no such column',
      foreignShown &&
        typeof foreignText === 'string' &&
        /[一-鿿]/.test(foreignText) &&
        foreignText.includes('备份') &&
        !foreignText.includes('already exists') &&
        !foreignText.includes('no such column'),
      String(foreignText)
    )
    check(
      '这种文件**不弹**确认框（弹了就等于准备拿它替换账本，换完软件就起不来了）',
      (await cdp4.evaluate(`window.__T.count('confirm-dialog')`)) === 0
    )
    check(
      '被它拒绝之后账本还能读、还是 2 笔',
      (await txCount(cdp4)) === 2,
      `${await txCount(cdp4)} 笔`
    )

    // 最关键的一条：**重开软件还能进得去**。旧实现恰恰死在这里 ——
    // 账本文件已经被换成外来库，启动时迁移报错，只弹一个「启动失败」，界面出不来。
    await shutdown(session)
    session = null
    let restartOk = false
    try {
      session = await launch({ HT_TEST_SAVE_DIR: SAVE_DIR, HT_TEST_OPEN_PATH: '__cancel__' })
      restartOk = (await txCount(session.cdp)) === 2
    } catch {
      restartOk = false
    }
    check(
      '重开软件能正常进入界面、账本还是 2 笔（这一条就是「用户会不会再也打不开账本」）',
      restartOk
    )

    // ---------- 标识唯一性 ----------
    // 这一条必须挂在**当下还活着**的那一程上。2026-10-04 踩过：它原先用 cdp3，
    // 而 cdp3 在第四程开头就已经 shutdown 了 —— 请求发进一个死连接，
    // Promise 永不返回，整个脚本静默卡死、连结果汇总都打不出来。
    // （现在那种情况会抛「调试连接已关闭」，见上面的 CLOSED_HINT。）
    const dups = await session.cdp.json(`window.__T.duplicatedTestIds()`)
    check(
      '整个页面上没有任何重复的 data-testid（四个页面常驻挂载，重名是最难查的一类错）',
      dups.length === 0,
      dups.join(', ')
    )
  } finally {
    if (session) await shutdown(session)
    summarize()
  }
}

/**
 * 打印结果汇总。
 *
 * 放在 finally 里调用：中途抛错时也得把**已经跑完的项**打出来，
 * 否则「脚本自己出错了、一项结果都没打印」和「一项都没跑」在屏幕上看不出区别。
 */
function summarize() {
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
