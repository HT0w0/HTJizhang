/**
 * 给 README 拍界面截图（开发用的一次性脚本，不是软件的一部分）。
 *
 * 为什么要有它：README 是陌生人了解这个软件的唯一入口，
 * 而一个图形界面的软件，没有截图的说明页几乎等于没说。我（AI）看不到屏幕，
 * 只能靠 Electron 调试接口（CDP）**真的截一张图**下来。
 *
 * 截图里出现的账单是**演示数据**（本脚本灌进去的），不是任何人的真实账本 ——
 * README 里要写明这一点，否则读者会以为作者在晒自己的账。
 *
 * 用法：
 *   npm run build:win          ← 先有打包产物（本脚本直接跑 release 里的程序）
 *   env -u ELECTRON_RUN_AS_NODE node scripts/make-screenshots.mjs
 *
 * 输出：docs/截图/*.png
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PROJECT = join(import.meta.dirname, '..')
const APP_EXE = join(PROJECT, 'release', 'win-unpacked', 'HTJizhang.exe')

/**
 * 数据目录：和验证脚本一样用隔离目录（CLAUDE.md §九）。
 * **绝不能**直接拍 %APPDATA% 里那份 —— 那是用户的真实账本，
 * 拍出来就变成把别人的账贴到 GitHub 上了。
 */
const USER_DATA = join(PROJECT, '.verify-data', '截图')
const OUT_DIR = join(PROJECT, 'docs', '截图')

const PORT = 9292

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
        p.resolve(msg)
      }
    })
  }
  send(method, params = {}) {
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

/** 本地日期字符串，可往前推 N 天（和 src/shared/localDate.ts 同一个格式）。 */
function localDate(daysAgo = 0) {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 当月第 N 天，往前推 monthsAgo 个月。用来把演示数据铺满最近几个月。 */
function monthDay(monthsAgo, day) {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth() - monthsAgo, day)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 演示账本。
 *
 * 刻意做得「像一个真过日子的人的账」：餐饮笔数多、金额小，
 * 房租金额大但一月一笔，收入固定在月初 —— 这样截出来的饼图和排行才像话。
 * 全是随机数的话，图和数字都会长得很奇怪。
 */
const DEMO = [
  // ---- 本月 ----
  [monthDay(0, 2), '餐饮', '早餐', 900, '豆浆油条', 'wechat'],
  [monthDay(0, 2), '交通', '公交地铁', 600, '上班通勤', 'alipay'],
  [monthDay(0, 3), '餐饮', '午餐', 2600, '公司楼下快餐', 'wechat'],
  [monthDay(0, 3), '餐饮', '咖啡奶茶', 1900, '拿铁', 'wechat'],
  [monthDay(0, 4), '购物', '日用百货', 8800, '洗衣液、纸巾', 'alipay'],
  [monthDay(0, 4), '餐饮', '晚餐', 4200, '和同事吃饭', 'wechat'],
  [monthDay(0, 5), '餐饮', '买菜食材', 12600, '周末买菜', 'alipay'],
  [monthDay(0, 5), '娱乐', '电影演出', 7800, '两张电影票', 'wechat'],
  [monthDay(0, 6), '交通', '打车网约车', 3400, '下雨打车回家', 'alipay'],
  [monthDay(0, 6), '餐饮', '外卖', 3800, '午饭外卖', 'wechat'],
  [monthDay(0, 7), '居住', '水电燃气', 18600, '七月水电燃气', 'bank'],
  [monthDay(0, 8), '医疗健康', '药品', 6500, '感冒药', 'alipay'],
  [monthDay(0, 8), '通讯', '手机话费', 5900, '月租', 'bank'],
  // ---- 本月收入 ----
  [monthDay(0, 1), '工资薪酬', '月薪', 1380000, '九月工资', 'bank'],
  [monthDay(0, 9), '投资理财', '利息', 23400, '余额宝收益', 'bank'],
  // ---- 往前几个月：只为把 12 个月趋势图填满 ----
  [monthDay(1, 3), '居住', '房租', 350000, '十月房租', 'bank'],
  [monthDay(1, 3), '餐饮', '买菜食材', 98000, '十月买菜', 'alipay'],
  [monthDay(1, 1), '工资薪酬', '月薪', 1380000, '十月工资', 'bank'],
  [monthDay(2, 4), '居住', '房租', 350000, '九月房租', 'bank'],
  [monthDay(2, 5), '学习教育', '培训课程', 128000, '线上课程', 'alipay'],
  [monthDay(2, 1), '工资薪酬', '月薪', 1340000, '九月工资', 'bank'],
  [monthDay(3, 6), '居住', '房租', 350000, '八月房租', 'bank'],
  [monthDay(3, 8), '购物', '数码电子', 269900, '机械键盘', 'alipay'],
  [monthDay(3, 1), '工资薪酬', '月薪', 1340000, '八月工资', 'bank'],
  [monthDay(4, 4), '居住', '房租', 350000, '七月房租', 'bank'],
  [monthDay(4, 2), '工资薪酬', '月薪', 1340000, '七月工资', 'bank'],
  [monthDay(5, 5), '居住', '房租', 350000, '六月房租', 'bank'],
  [monthDay(5, 2), '工资薪酬', '月薪', 1340000, '六月工资', 'bank']
]

async function main() {
  if (!existsSync(APP_EXE)) {
    console.error(`找不到打包产物：${APP_EXE}\n先跑一次 npm run build:win`)
    process.exitCode = 1
    return
  }

  rmSync(USER_DATA, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(OUT_DIR, { recursive: true })

  const child = spawn(
    APP_EXE,
    [
      `--user-data-dir=${USER_DATA}`,
      `--remote-debugging-port=${PORT}`,
      // 不加这句，缩放 125% 的显示器上截出来的图会比窗口大一圈
      '--force-device-scale-factor=1'
    ],
    {
      cwd: PROJECT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )

  let ws
  try {
    const target = await getTarget()
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', reject)
    })
    const cdp = new Cdp(ws)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    // 截图一律用浅色：README 在浅色底上显示，深色截图会显得脏
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }]
    })
    await sleep(1200)

    // ---- 灌演示数据 ----
    const seeded = await cdp.json(`(async () => {
      var cats = await window.ht.categories.list()
      var byPath = {}
      cats.forEach(function (major) {
        major.children.forEach(function (leaf) {
          // 收支类型**从分类本身读**，不靠分类名去猜 ——
          // 猜错的后果是收入被记成支出，而截图上看不出来（图上只少了一根绿柱）
          byPath[major.name + '/' + leaf.name] = { id: leaf.id, kind: major.kind }
        })
      })
      var demo = ${JSON.stringify(DEMO.map(([d, maj, leaf, fen, note, pay]) => ({ d, maj, leaf, fen, note, pay })))}
      var ok = 0, missing = []
      for (var i = 0; i < demo.length; i++) {
        var r = demo[i]
        var hit = byPath[r.maj + '/' + r.leaf]
        if (!hit) { missing.push(r.maj + '/' + r.leaf); continue }
        await window.ht.transactions.create({
          kind: hit.kind, amountFen: r.fen, categoryId: hit.id, occurredOn: r.d,
          note: r.note, paymentMethod: r.pay
        })
        ok++
      }
      return { ok: ok, missing: missing }
    })()`)
    console.log(`演示数据写入 ${seeded.ok} 笔` + (seeded.missing.length ? `，未找到分类：${seeded.missing.join('、')}` : ''))

    await cdp.evaluate(`location.reload()`)
    await sleep(1500)

    /**
     * 切页、等渲染、截图。
     *
     * height 比真实窗口（780）高：统计页的趋势图在 780 的高度下会被切掉半截，
     * 而一张「图看不到底」的截图放进 README 会让人以为界面装不下。
     * 这里只是把**截图用的视口**调高，软件本身没变（用户真用时往下滚就是了）。
     */
    async function shot(label, file, height = 900, waitMs = 1400) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1180,
        height,
        deviceScaleFactor: 1,
        mobile: false
      })
      await cdp.evaluate(`
        (function () {
          var btns = Array.prototype.slice.call(document.querySelectorAll('nav button'))
          var t = btns.find(function (b) { return b.innerText.indexOf(${JSON.stringify(label)}) >= 0 })
          if (t) t.click()
        })()
      `)
      await sleep(waitMs)
      const res = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(OUT_DIR, file), Buffer.from(res.result.data, 'base64'))
      console.log('  拍下 ' + file)
    }

    await shot('记一笔', '1-记一笔.png', 820)
    await shot('账单', '2-账单.png', 900)
    await shot('统计', '3-统计.png', 1180, 2400)
    await shot('设置', '4-设置.png', 900)
  } finally {
    try {
      ws?.close()
      child.kill()
    } catch {
      /* 已经退了 */
    }
    await sleep(1200)
  }

  console.log('\n截图输出到 ' + OUT_DIR)
}

main().catch((error) => {
  console.error('拍截图时出错：', error)
  process.exitCode = 1
})
