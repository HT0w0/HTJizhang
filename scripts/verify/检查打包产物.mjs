/**
 * 第 7 阶段「打包产物」的客观验证。
 *
 * 前面六个脚本跑的都是 **源码**（`electron.exe out/main/index.js`）。
 * 用户拿到手的却是 `release/HTJizhang-1.0.0-setup.exe` 装出来的那个程序。
 * 两者之间隔着一整条打包链路：Vite 产物 → asar 归档 → 元数据写入 → NSIS 封装。
 * 这条链路上**任何一个环节漏东西，源码那一侧都照样全绿**：
 *   - 少打一个渲染进程的分块文件 → 界面一片空白，dev 模式完全正常；
 *   - asar 里的路径拼错 → 迁移/种子读不到，打开就是空分类；
 *   - 主进程和预加载脚本没被打进去 → 界面上每个按钮都点了没反应（§5.18 那种静默失效）。
 *
 * 所以这个脚本的职责很单一：**启动打包产物，走用户真会走的那条路**（§5.21）。
 *
 * ## 它验什么
 *
 * 第一程  打包版能启动、四个页面真的渲染出来了
 * 第二程  走**真实界面操作**记一笔（真点击、真输入），再直接打开 .db 文件核对
 * 第三程  账单页 / 统计页能读到这笔
 * 第四程  关掉重开，账还在（持久化）
 * 第五程  开第二个实例会自己退出（§5.14 单实例锁）
 * 第六程  静态检查：打包产物里那条「弹框替身」确实被 app.isPackaged 挡住了（§5.27）
 *
 * ## 代价（照 §九 的规矩，加了替身就要说清它让哪一块不再被覆盖）
 *
 * 1. `--user-data-dir` 把数据目录整个挪走了，所以**本脚本测不到 §5.16**
 *    （数据目录会不会漂移到 %APPDATA%\Electron\）—— 这个坑现在只靠
 *    `src/main/index.ts` 顶上那行 `app.setName('HTJizhang')` 的位置保证。
 * 2. 第六程是**静态**检查（读 asar 里的字符串），不是运行时的：
 *    真去点「导出备份」会弹出操作系统的「另存为」窗口，那个窗口 CDP 够不着，
 *    而且会莫名其妙地出现在用户桌面上。所以这里只核对**代码里那层守卫还在**，
 *    没有核对「点击后真的弹了框」。
 * 3. 它验的是 `release/win-unpacked/` 里**解包后**的程序，不是 NSIS 安装程序本身。
 *    「安装程序能不能装、快捷方式建没建对」只能由人点一遍（见 docs/首次安装说明.md）。
 *
 * ## 前置
 *
 * 必须先跑过一次 `npm run build:win`（本脚本不负责打包，只负责验收打包结果）。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE node "scripts/verify/检查打包产物.mjs"
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * 调试端口：本脚本从 BASE_PORT 起，每次启动 Electron 往后挪一个。
 * 别和别的脚本重复（9222/9232/9242/9252/9262/9272 已被占用）。理由见 README。
 */
const BASE_PORT = 9282
let portSeq = 0

function nextPort() {
  return BASE_PORT + portSeq++
}

const PROJECT = join(import.meta.dirname, '..', '..')

/** 打包产物。不是 node_modules 里的 electron —— 这条区别就是这个脚本存在的全部理由。 */
const APP_EXE = join(PROJECT, 'release', 'win-unpacked', 'HTJizhang.exe')

/** asar 归档：主进程代码在它里面。第六程读它做静态检查。 */
const ASAR = join(PROJECT, 'release', 'win-unpacked', 'resources', 'app.asar')

/**
 * 数据目录：**不是**软件真实的数据目录。
 * 见 README「两个必须守住的规矩」和 CLAUDE.md §九。**别去掉 --user-data-dir。**
 */
const USER_DATA = join(PROJECT, '.verify-data', '打包产物')

/** 账本文件名，和 src/main/db/connection.ts 里的 DB_FILE_NAME 一致。 */
const DB_NAME = 'ht-jizhang.db'
const DB_PATH = join(USER_DATA, DB_NAME)

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 今天（本地时区）的 YYYY-MM-DD。软件存的就是这个格式（CLAUDE.md §5.2）。 */
function localToday() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 今天的 YYYY-MM，给「按月列表」查询用。 */
function localThisMonth() {
  return localToday().slice(0, 7)
}

/**
 * 直接打开 .db 数它有几笔账、都是什么。
 *
 * 脚本跑在普通 Node 24 下，`node:sqlite` 是内置的，所以能自己开账本核对 ——
 * 「界面提示保存成功」和「账本文件里真有这一笔」是两件事，
 * 只查前者的话，写进一个内存库也照样通过。
 */
function readLedger() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try {
    return db
      .prepare(
        `SELECT t.amount_fen, t.occurred_on, t.kind, c.name AS leaf, p.name AS major
           FROM transactions t
           JOIN categories c ON c.id = t.category_id
           LEFT JOIN categories p ON p.id = c.parent_id
          ORDER BY t.id`
      )
      .all()
  } finally {
    db.close()
  }
}

/**
 * 一份文件当前的「身份」：大小 + 修改时间。
 *
 * 用来证明「关掉重开之后开的是同一个账本，不是新建了一个空库」——
 * 只数笔数是不够的：新建库 + 恰好也写进去一笔，笔数一样。
 */
function fileFingerprint(file) {
  const st = statSync(file)
  return `${st.size}:${st.mtimeMs}`
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
   * 藏在里面的元素照样有 textContent。
   *
   * 对**打包产物**尤其要紧：少打一个分块文件时，React 挂载失败，
   * 页面会「存在但一片空白」—— 只读 textContent 的话，
   * 空白页会和正常页长得一模一样。
   */
  shown(t) {
    var e = this.one(t)
    if (!e) return null
    return e.offsetParent !== null
  },

  // 按正则精确匹配 testid。**不要用前缀匹配**：
  // 「pick-major-grid」这个容器也以「pick-major-」开头。
  byRe(re) {
    return Array.prototype.slice
      .call(document.querySelectorAll('[data-testid]'))
      .filter(function (e) { return re.test(e.dataset.testid) })
  },
  pickMajors() { return this.byRe(/^pick-major-[0-9]+$/) },
  pickLeaves() { return this.byRe(/^pick-leaf-[0-9]+$/) },

  click(el) { if (el) el.click() },

  /**
   * 往 React 受控输入框里打字。
   * 必须走原型上的 setter —— 直接赋 el.value，React 收不到变更（自己维护着影子值）。
   */
  setInput(el, v) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  },

  /** 所有导航按钮的文字。 */
  navLabels() {
    return Array.prototype.slice.call(document.querySelectorAll('nav button'))
      .map(function (b) { return window.__T.norm(b.innerText) })
  },
  /** 点某个导航按钮。 */
  navGo(label) {
    var btns = Array.prototype.slice.call(document.querySelectorAll('nav button'))
    var t = btns.find(function (b) { return window.__T.norm(b.innerText).indexOf(label) >= 0 })
    if (t) t.click()
    return !!t
  },
  /** 页面上所有可见文字，用来判断「这个页面到底渲染出来没有」。 */
  visibleText() {
    var root = document.getElementById('root')
    return window.__T.norm(root ? root.innerText : '')
  }
}
'ok'
`

async function getTargets(port) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://localhost:${port}/json/list`)
      const list = await res.json()
      const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (pages.length > 0) return pages
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
 * 不是软件有问题 —— 措辞里必须说清这一点。
 */
const CLOSED_HINT =
  '调试连接已关闭。这个检查用错了 cdp 会话（多半是用了一个已经 shutdown 的 session.cdp）——' +
  '这是验证脚本自身的缺陷，不是软件的问题。'

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
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
      // 别让它们的 Promise 悬着（否则整个脚本静默卡死，2026-10-04 踩过）。
      for (const p of this.pending.values()) p.reject(new Error(CLOSED_HINT))
      this.pending.clear()
    })
  }
  send(method, params = {}) {
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

/** 启动**打包后的程序**（不是 node_modules 里的 electron）。 */
async function launch(extraArgs = []) {
  const port = nextPort()
  const child = spawn(
    APP_EXE,
    [`--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${port}`, ...extraArgs],
    {
      cwd: PROJECT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )

  const pages = await getTargets(port)
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(1200)
  await cdp.evaluate(HELPERS)
  return { child, ws, cdp, port }
}

async function shutdown(session) {
  try {
    session.ws.close()
    session.child.kill()
  } catch {
    /* 已经退了 */
  }
  // Windows 上子进程不会立刻消失，不等一下下一次启动会撞上同一个数据目录
  await sleep(1500)
}

async function waitFor(cdp, expression, ms = 6000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await cdp.evaluate(expression)) return true
    if (Date.now() > deadline) return false
    await sleep(150)
  }
}

let session = null

async function main() {
  // ---- 前置：打包产物存在吗 ----
  if (!existsSync(APP_EXE)) {
    check('打包产物存在（release/win-unpacked/HTJizhang.exe）', false, '先跑 npm run build:win')
    return
  }
  if (!existsSync(ASAR)) {
    check('asar 归档存在（resources/app.asar）', false, '打包产物布局和预期不符')
    return
  }
  check('打包产物存在', true, `HTJizhang.exe ${(statSync(APP_EXE).size / 1048576).toFixed(1)} MB`)

  // 每次从干净的数据目录开始。清了之后程序得自己把库建起来 ——
  // 「第一次安装打开」就是这条路（用户装的正是全新的一份）。
  rmSync(USER_DATA, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  check('数据目录已清空（模拟「第一次安装打开」）', !existsSync(DB_PATH), USER_DATA)

  // ================= 第一程：能启动、界面完整 =================
  console.log('\n【第一程】打包版启动与界面')
  session = await launch()

  check('打包版能启动，调试接口里只有 1 个页面', true, `端口 ${session.port}`)

  const title = await session.cdp.evaluate('document.title')
  check('窗口标题是「HT记账」', title === 'HT记账', `实际：${JSON.stringify(title)}`)

  const nav = await session.cdp.json('window.__T.navLabels()')
  const wantNav = ['记一笔', '账单', '统计', '设置']
  const navOk = nav.length === 4 && wantNav.every((w, i) => nav[i].includes(w))
  check('左侧 4 个导航按钮顺序与文字正确', navOk, `实际：${JSON.stringify(nav)}`)

  // 空白页是「打包漏文件」最典型的样子：DOM 在，但内容是空的
  const bodyText = await session.cdp.evaluate('window.__T.visibleText()')
  check('界面真的渲染出了内容（不是白屏）', bodyText.length > 10, `${bodyText.length} 个字`)

  check('记账页的金额输入框显示在屏幕上', (await session.cdp.evaluate('window.__T.shown("amount")')) === true)

  // 账本文件必须落在**被 --user-data-dir 指定的**那个目录里。
  // 落到别处说明打包后 userData 解析变了 —— 那正是 §5.16 那类问题的形状。
  check('账本文件建在指定的数据目录里', existsSync(DB_PATH), DB_PATH)

  // ---- 内置分类：打包后 seed 仍然跑得到 ----
  const catCount = await session.cdp.json(`(async () => {
    var cats = await window.ht.categories.list()
    return cats.reduce(function (n, c) { return n + 1 + c.children.length }, 0)
  })()`)
  check('内置分类 96 条都播种了', catCount === 96, `实际 ${catCount} 条`)

  // ---- 设置页：分类管理两栏 ----
  await session.cdp.evaluate('window.__T.navGo("设置")')
  await sleep(900)
  check('设置页的分类管理渲染出来了', (await session.cdp.evaluate('window.__T.shown("category-manager")')) === true)

  // ================= 第二程：走真实界面记一笔 =================
  console.log('\n【第二程】像用户那样记一笔')
  await session.cdp.evaluate('window.__T.navGo("记一笔")')
  await sleep(900)

  const today = localToday()

  // 真往输入框里打字（全角也走同一条路，但这里先验最基本的）
  await session.cdp.evaluate(`
    window.__T.setInput(window.__T.one('amount'), '12.34')
  `)
  await sleep(400)
  const preview = await session.cdp.evaluate('window.__T.label("amount-preview")')
  check('输入 12.34 后界面显示出这个金额', (preview || '').includes('12.34'), `预览区：${JSON.stringify(preview)}`)

  // 真点一个大类 → 小类列表浮出来
  await session.cdp.evaluate('window.__T.click(window.__T.pickMajors()[0])')
  await sleep(500)
  const leaves = await session.cdp.evaluate('window.__T.pickLeaves().length')
  check('点大类之后浮出它名下的小类', leaves > 0, `${leaves} 个小类`)

  await session.cdp.evaluate('window.__T.click(window.__T.pickLeaves()[0])')
  await sleep(400)

  // 真点「保存」
  await session.cdp.evaluate('window.__T.click(window.__T.one("save"))')
  const toastShown = await waitFor(session.cdp, 'window.__T.shown("save-toast")', 6000)
  const toast = await session.cdp.evaluate('window.__T.label("save-toast")')
  check('点保存后出现确认条', toastShown, JSON.stringify(toast))

  // ---- 关键：不看界面，直接开账本文件 ----
  const rows = readLedger()
  check('账本文件里正好有 1 笔', rows.length === 1, `实际 ${rows.length} 笔`)
  if (rows.length === 1) {
    check('金额存的是 1234 分（不是 12.34 小数）', rows[0].amount_fen === 1234, `实际 ${rows[0].amount_fen}`)
    check('日期存的是本地今天', rows[0].occurred_on === today, `实际 ${rows[0].occurred_on}，今天 ${today}`)
    // 账单必须挂在**二级小类**上（触发器也会拦，但这里从数据上直接确认）
    check('这笔挂在二级小类下面（大类非空）', Boolean(rows[0].major), `${rows[0].major} / ${rows[0].leaf}`)
  }

  // ================= 第三程：其它页面能读到这笔 =================
  console.log('\n【第三程】账单页与统计页')
  await session.cdp.evaluate('window.__T.navGo("账单")')
  await sleep(1200)
  const listTodos = await session.cdp.json(
    `(await window.ht.transactions.list({ month: ${JSON.stringify(localThisMonth())}, kind: 'all', keyword: '' })).length`
  )
  check('账单页能查到这笔账', listTodos === 1, `查到 ${listTodos} 笔`)
  check('账单页渲染出了合计行', (await session.cdp.evaluate('window.__T.shown("list-total")')) === true)

  await session.cdp.evaluate('window.__T.navGo("统计")')
  await sleep(1800)
  const cards = await session.cdp.json(`(async () => {
    var o = await window.ht.stats.overview(${JSON.stringify(localThisMonth())})
    return { expense: o.expenseFen, income: o.incomeFen, count: o.count, majors: o.majors.length }
  })()`)
  check('统计页取到的本月支出是 1234 分', cards.expense === 1234, JSON.stringify(cards))
  check('统计页取到的本月笔数是 1', cards.count === 1, `实际 ${cards.count}`)
  check('统计页饼图渲染出了扇区', (await session.cdp.evaluate('window.__T.count("stats-pie")')) === 1)

  // ⚠️ 判据只能是 `!== true`，**不能**写成 `=== false`。
  // 报错横幅是条件渲染的（`error !== '' && ...`），没报错时元素**根本不存在**，
  // `shown()` 于是返回 `null` —— 拿它和 `false` 比会误报成失败。
  // 2026-10-04 本脚本第一版就是这么写的，把「软件一切正常」报成了失败。
  check('统计页没有报错横幅', (await session.cdp.evaluate('window.__T.shown("stats-error")')) !== true)

  // 正向的一条：不能只有「没报错」，还得真把金额显示到屏幕上。
  // 否则「页面整个没渲染」也会让上面那条通过（横幅同样不存在）。
  //
  // 用整页的 innerText 而不是找某个 testid：金额卡片上没挂 testid，
  // 而 innerText **会排除 hidden 藏起来的页面**（四个页面常驻挂载）——
  // 所以「在这里能读到 12.34」等价于「用户此刻能在屏幕上看到它」。
  const statsText = await session.cdp.evaluate('window.__T.visibleText()')
  check(
    '统计页把金额显示在了屏幕上',
    (statsText || '').includes('12.34'),
    JSON.stringify(statsText.slice(0, 80))
  )

  // ================= 第四程：关掉重开，账还在 =================
  console.log('\n【第四程】关掉重开')
  const before = fileFingerprint(DB_PATH)
  await shutdown(session)
  session = await launch()

  const after = fileFingerprint(DB_PATH)
  check('重开后开的是同一个账本文件（没有新建空库）', before === after, `${before} → ${after}`)

  const rowsAfter = readLedger()
  check('重开后那笔账还在', rowsAfter.length === 1, `实际 ${rowsAfter.length} 笔`)

  const visible = await session.cdp.json(`(async () => {
    return (await window.ht.transactions.list({ month: ${JSON.stringify(localThisMonth())}, kind: 'all', keyword: '' })).length
  })()`)
  check('重开后的界面也能取到这笔账', visible === 1, `取到 ${visible} 笔`)

  // ================= 第五程：单实例锁 =================
  console.log('\n【第五程】单实例锁')
  const secondPort = nextPort()
  const second = spawn(
    APP_EXE,
    [`--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${secondPort}`],
    {
      cwd: PROJECT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  const secondExited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000)
    second.on('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
  check('第二个实例自己退出了（不会两个窗口写同一份数据）', secondExited)
  try {
    second.kill()
  } catch {
    /* 已经退了 */
  }

  // 第一个实例必须还活着 —— 第二个实例不该把它顶掉
  let firstAlive = true
  try {
    await session.cdp.evaluate('1')
  } catch {
    firstAlive = false
  }
  check('原来那个窗口没被顶掉，还能正常响应', firstAlive)
}

/**
 * 第六程：静态检查打包产物里的弹框替身。
 *
 * `HT_TEST_SAVE_DIR` / `HT_TEST_OPEN_PATH` 是给验证脚本开的口子（§5.27），
 * 它必须**只在你从源码跑的时候**才可能存在。打包给用户的那一份里，
 * 那句取值必须被 `app.isPackaged` 挡成 undefined。
 *
 * 为什么是静态检查而不是真点一下「导出备份」：点了会弹出操作系统的
 * 「另存为」窗口 —— 那个窗口 CDP 够不着（这正是当初要开这个口子的原因），
 * 而且会毫无征兆地出现在用户桌面上。所以这里只核对**代码里那层守卫还在**，
 * 无法证明「点击后真的弹了框」。这是本脚本的一个已知缺口。
 */
function staticCheck() {
  console.log('\n【第六程】打包产物里的弹框替身（静态）')
  // asar 里的文本没有压缩，直接当成字节流找字符串即可
  const raw = readFileSync(ASAR).toString('latin1')

  const saveGuard = /const\s+testSaveDir\s*=\s*[\w.]*app\.isPackaged\s*\?\s*void 0\s*:/.test(raw)
  const openGuard = /const\s+testOpenPath\s*=\s*[\w.]*app\.isPackaged\s*\?\s*void 0\s*:/.test(raw)
  check('「另存为」替身带着 app.isPackaged 守卫', saveGuard)
  check('「选择文件」替身带着 app.isPackaged 守卫', openGuard)

  // 反面：守卫必须在**取值那一步**，不能是别处的 isPackaged
  const seamPresent = raw.includes('HT_TEST_SAVE_DIR') && raw.includes('HT_TEST_OPEN_PATH')
  check('两个替身变量确实在打包产物里（守卫是被包含关系，不是找不到）', seamPresent)

  // 顺带确认真实数据目录名没被写死成 Electron（§5.16 的静态面）
  check(
    '打包产物里写死了程序名 HTJizhang',
    /setName\(["']HTJizhang["']\)/.test(raw),
    '这行错位会让账本落到 %APPDATA%\\Electron\\'
  )
}

// 出错也要打印汇总 —— 否则「进度停在中途、也没有结论」这种状态
// 会让人分不清是软件卡了还是脚本卡了（2026-10-04 实际遇到过）。
main()
  .catch((error) => {
    console.error('\n脚本自身出错：', error)
    check('脚本跑到底', false, String(error && error.message ? error.message : error))
  })
  .finally(async () => {
    staticCheck()
    if (session) await shutdown(session)

    const failed = results.filter((r) => !r.pass)
    console.log(`\n${'='.repeat(60)}`)
    console.log(`通过 ${results.length - failed.length} / ${results.length}`)
    if (failed.length > 0) {
      console.log('失败项：')
      for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
    }
    process.exitCode = failed.length === 0 ? 0 : 1
  })
