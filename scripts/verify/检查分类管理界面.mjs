/**
 * 第 2 阶段 Task 7 的界面客观验证。
 *
 * 按 CLAUDE.md §九 的做法：启动打包好的生产版本，用 Electron 调试接口（CDP）
 * 在真实渲染进程里读 DOM、读计算样式、驱动真实点击。
 *
 * 踩过的坑（CLAUDE.md §九 有记）：
 * - React 异步渲染，点击后必须等一帧（80ms），带 transition-colors 的等 150ms
 * - innerText 在弹性布局里会把图标和文字拆行，比较前先归一化空白
 * - Tailwind v4 输出 oklch() 不是 rgb()
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE node e2e-task7-ui.mjs
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
const BASE_PORT = 9232
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
 * 这个脚本会在里面建分类、改名、归档，落在真实目录上就动了用户账本。
 * 见 CLAUDE.md §九。
 */
const USER_DATA = join(PROJECT, '.verify-data', '分类管理界面')

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 注入到页面里的辅助函数。注意转义：这是要被求值的源码字符串。 */
const HELPERS = `
window.__T = {
  norm(s) { return String(s || '').replace(/\\s+/g, ' ').trim() },
  all(re) {
    return Array.prototype.slice
      .call(document.querySelectorAll('[data-testid]'))
      .filter(function (e) { return re.test(e.dataset.testid) })
  },
  majors() { return this.all(/^major-[0-9]+$/) },
  children() { return this.all(/^child-[0-9]+$/) },
  archived() { return this.all(/^archived-[0-9]+$/) },
  one(testid) { return document.querySelector('[data-testid="' + testid + '"]') },
  idOf(el) { return Number(el.dataset.testid.match(/([0-9]+)$/)[1]) },
  label(el) { return this.norm(el.innerText) },
  names(list) { return list.map(function (e) { return window.__T.label(e) }) },
  setInput(el, v) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  },
  click(el) { el.click() },
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

async function main() {
  console.log('\n【第 2 阶段 设置页分类管理 — 界面客观验证】\n')

  // 清空隔离目录，保证这次跑在干净的内置分类上（删的不是用户账本）。
  rmSync(USER_DATA, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  console.log(`  · 隔离数据目录：${USER_DATA}\n`)

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
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += String(d)
  })

  try {
    const target = await getTarget(port)
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', reject)
    })
    const cdp = new Cdp(ws)
    await cdp.send('Runtime.enable')
    await sleep(800)

    await cdp.evaluate(HELPERS)

    // ---------- 0. 导航到设置页（真实点击左侧导航） ----------
    const navigated = await cdp.evaluate(`
      (function () {
        var btns = Array.prototype.slice.call(document.querySelectorAll('nav button'))
        var target = btns.find(function (b) { return window.__T.norm(b.innerText).indexOf('设置') >= 0 })
        if (!target) return '没找到设置按钮'
        target.click()
        return 'ok'
      })()
    `)
    check('点左侧导航「设置」能切到设置页', navigated === 'ok', navigated)
    await sleep(400)

    const mounted = await cdp.evaluate(`!!window.__T.one('category-manager')`)
    check('分类管理界面已挂载', mounted === true)

    // ---------- 1. 支出侧 11 个大类 ----------
    const expenseMajors = await cdp.evaluate(`window.__T.names(window.__T.majors())`)
    check(
      '默认显示 11 个支出大类',
      expenseMajors.length === 11,
      `${expenseMajors.length} 个：${expenseMajors.join(' / ')}`
    )

    // ---------- 2. 切到收入侧变成 5 个 ----------
    await cdp.evaluate(`window.__T.click(window.__T.one('kind-tab-income'))`)
    await sleep(350)
    const incomeMajors = await cdp.evaluate(`window.__T.names(window.__T.majors())`)
    check(
      '点「收入分类」后变成 5 个大类',
      incomeMajors.length === 5,
      `${incomeMajors.length} 个：${incomeMajors.join(' / ')}`
    )

    await cdp.evaluate(`window.__T.click(window.__T.one('kind-tab-expense'))`)
    await sleep(350)
    const backToExpense = await cdp.evaluate(`window.__T.names(window.__T.majors())`)
    check('切回支出又变回 11 个', backToExpense.length === 11)

    // ---------- 3. 点「餐饮」，右栏出现 9 个小类 ----------
    const restaurantId = await cdp.evaluate(`
      (function () {
        var found = window.__T.majors().find(function (m) {
          return window.__T.label(m).indexOf('餐饮') >= 0
        })
        if (!found) return -1
        found.click()
        return window.__T.idOf(found)
      })()
    `)
    check('左栏能找到「餐饮」并点中', restaurantId > 0, `id=${restaurantId}`)
    await sleep(350)

    const children = await cdp.evaluate(`window.__T.names(window.__T.children())`)
    check(
      '右栏出现 9 个小类',
      children.length === 9,
      `${children.length} 个：${children.join(' / ')}`
    )
    check(
      '第一个小类是「早餐」',
      children[0] && children[0].indexOf('早餐') >= 0,
      children[0]
    )

    // ---------- 3b. 计算样式真的生效了（不是空壳） ----------
    const style = await cdp.evaluate(`
      (function () {
        var first = window.__T.children()[0]
        var cs = getComputedStyle(first)
        return JSON.stringify({ display: cs.display, paddingLeft: cs.paddingLeft, fontSize: cs.fontSize })
      })()
    `)
    const st = JSON.parse(style)
    check('小类行有真实布局样式（flex + 内边距）', st.display === 'flex' && parseFloat(st.paddingLeft) > 0, style)

    // ---------- 4. 点「早餐」的下移按钮，前两项对调 ----------
    const beforeOrder = children.slice(0, 3)
    const moved = await cdp.evaluate(`
      (function () {
        var first = window.__T.children()[0]
        var id = window.__T.idOf(first)
        var btn = window.__T.one('down-' + id)
        if (!btn) return '没找到下移按钮'
        btn.click()
        return 'ok'
      })()
    `)
    check('点「早餐」的下移按钮', moved === 'ok', moved)
    await sleep(500)

    const afterOrder = await cdp.evaluate(`window.__T.names(window.__T.children())`)
    check(
      '前两项真的对调了（早餐 ↔ 午餐）',
      afterOrder[0].indexOf('午餐') >= 0 && afterOrder[1].indexOf('早餐') >= 0,
      `改前 ${beforeOrder.join(' / ')}  改后 ${afterOrder.slice(0, 3).join(' / ')}`
    )
    check(
      '其余项顺序不变（只动了两项）',
      JSON.stringify(afterOrder.slice(2)) === JSON.stringify(children.slice(2))
    )

    // 恢复原顺序，别把数据改乱
    await cdp.evaluate(`
      (function () {
        var first = window.__T.children()[0]
        window.__T.one('down-' + window.__T.idOf(first)).click()
      })()
    `)
    await sleep(500)
    const restoredOrder = await cdp.evaluate(`window.__T.names(window.__T.children())`)
    check('再点一次能还原顺序', JSON.stringify(restoredOrder) === JSON.stringify(children), restoredOrder[0])

    // ---------- 4b. 一级大类的 ↑↓ 按钮也要能排序（复核发现的漏测点） ----------
    const majorBefore = await cdp.evaluate(`window.__T.names(window.__T.majors())`)
    const majorMoved = await cdp.evaluate(`
      (function () {
        // 挑第二个大类（第一个的 ↑ 是禁用的），点它的 ↑
        var list = window.__T.majors()
        if (list.length < 2) return '大类太少'
        var second = list[1]
        var btn = window.__T.one('major-up-' + window.__T.idOf(second))
        if (!btn) return '大类行上没有上移按钮'
        btn.click()
        return 'ok'
      })()
    `)
    check('点一级大类的 ↑ 按钮', majorMoved === 'ok', majorMoved)
    await sleep(600)

    const majorAfter = await cdp.evaluate(`window.__T.names(window.__T.majors())`)
    const majorErr = await cdp.evaluate(`
      (function () { var b = window.__T.one('error-banner'); return b ? window.__T.label(b) : '' })()
    `)
    check(
      '一级大类的 ↑ 真的把它移到了第一位（没有报错）',
      majorAfter[0] === majorBefore[1] && majorAfter[1] === majorBefore[0],
      `改前 ${majorBefore.slice(0, 2).join(' / ')}  改后 ${majorAfter.slice(0, 2).join(' / ')}`
    )
    check('点大类 ↑ 之后没有出现错误提示', majorErr === '', majorErr)

    // 还原
    await cdp.evaluate(`
      (function () {
        var list = window.__T.majors()
        window.__T.one('major-down-' + window.__T.idOf(list[0])).click()
      })()
    `)
    await sleep(600)
    const majorRestored = await cdp.evaluate(`window.__T.names(window.__T.majors())`)
    check(
      '大类再点一次 ↓ 能还原顺序',
      JSON.stringify(majorRestored) === JSON.stringify(majorBefore),
      majorRestored.slice(0, 2).join(' / ')
    )

    // ---------- 4c. 一级大类也要能改名（产品文档 3.2 举的例子就是改大类） ----------
    const majorRenameOpened = await cdp.evaluate(`
      (function () {
        var m = window.__T.majors().find(function (x) {
          return window.__T.label(x).indexOf('交通') >= 0
        })
        if (!m) return '没找到交通'
        var btn = window.__T.one('major-rename-' + window.__T.idOf(m))
        if (!btn) return '大类行上没有改名按钮'
        btn.click()
        return 'ok'
      })()
    `)
    check('一级大类行上有改名入口', majorRenameOpened === 'ok', majorRenameOpened)
    await sleep(350)

    if (majorRenameOpened === 'ok') {
      await cdp.evaluate(`
        (function () {
          var input = document.querySelector('[data-testid^="major-rename-input-"]')
          window.__T.setInput(input, '出行')
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        })()
      `)
      await sleep(700)
      const renamedMajors = await cdp.evaluate(`window.__T.names(window.__T.majors())`)
      check(
        '把一级大类「交通」改名成「出行」真的生效',
        renamedMajors.some((n) => n.indexOf('出行') >= 0) &&
          !renamedMajors.some((n) => n.indexOf('交通') >= 0),
        renamedMajors.slice(0, 3).join(' / ')
      )
      // 改回去
      await cdp.evaluate(`
        (function () {
          var m = window.__T.majors().find(function (x) {
            return window.__T.label(x).indexOf('出行') >= 0
          })
          window.__T.one('major-rename-' + window.__T.idOf(m)).click()
        })()
      `)
      await sleep(300)
      await cdp.evaluate(`
        (function () {
          var input = document.querySelector('[data-testid^="major-rename-input-"]')
          window.__T.setInput(input, '交通')
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        })()
      `)
      await sleep(700)
    }

    // 回到「餐饮」继续后面的小类测试
    await cdp.evaluate(`
      (function () {
        var m = window.__T.majors().find(function (x) {
          return window.__T.label(x).indexOf('餐饮') >= 0
        })
        if (m) m.click()
      })()
    `)
    await sleep(400)

    // ---------- 5. 重名给出中文提示，且不新增 ----------
    const dup = await cdp.evaluate(`
      (function () {
        var input = window.__T.one('new-child-name')
        window.__T.setInput(input, '午餐')
        window.__T.one('new-child-add').click()
        return 'clicked'
      })()
    `)
    await sleep(600)
    const dupError = await cdp.evaluate(`
      (function () {
        var b = window.__T.one('error-banner')
        return b ? window.__T.label(b) : '（没有错误提示）'
      })()
    `)
    const dupCount = await cdp.evaluate(`window.__T.children().length`)
    check('重名时出现错误提示', dupError.indexOf('已存在') >= 0, dupError)
    check(
      '重名时错误提示是纯中文、没有英文前缀',
      dupError.indexOf('Error') < 0 && dupError.indexOf('invoking') < 0,
      dupError
    )
    check('重名时没有被加进去（仍是 9 个）', dupCount === 9, `${dupCount} 个`)
    check('重名提示出现', dup === 'clicked')

    // ---------- 5b. 空名字时按钮是禁用的 ----------
    const disabledEmpty = await cdp.evaluate(`
      (function () {
        window.__T.setInput(window.__T.one('new-child-name'), '')
        return window.__T.one('new-child-add').disabled
      })()
    `)
    check('名字为空时「添加」按钮被禁用', disabledEmpty === true)

    // ---------- 6. 删除弹确认框且文案讲清后果 ----------
    const deleteText = await cdp.evaluate(`
      (function () {
        var target = window.__T.children().find(function (c) {
          return window.__T.label(c).indexOf('夜宵') >= 0
        })
        if (!target) return '没找到夜宵'
        window.__T.one('delete-' + window.__T.idOf(target)).click()
        return 'ok'
      })()
    `)
    check('点删除按钮', deleteText === 'ok', deleteText)
    await sleep(350)

    const dialogText = await cdp.evaluate(`
      (function () {
        var d = window.__T.one('confirm-dialog')
        return d ? window.__T.label(d) : '（没有确认框）'
      })()
    `)
    check('弹出确认框', dialogText !== '（没有确认框）')
    // 界面这条路径上分类还没有账单，验的是「没有账单」那条分支的措辞。
    // 「有账单 → 账单不会消失」那条分支由 deleteWarning.test.ts 单测覆盖
    // （第 3 阶段有了记账功能后，这里会补上真实账单的端到端验证）。
    check(
      '确认框讲清了当前没有账单受影响',
      dialogText.indexOf('账单') >= 0,
      dialogText.slice(0, 80)
    )
    check('确认框文案提到可以恢复', dialogText.indexOf('恢复') >= 0)

    // ---------- 6b. 点取消不应删除 ----------
    await cdp.evaluate(`window.__T.click(window.__T.one('confirm-cancel'))`)
    await sleep(350)
    const afterCancel = await cdp.evaluate(`window.__T.children().length`)
    check('点「取消」后没有删除（仍是 9 个）', afterCancel === 9, `${afterCancel} 个`)

    // ---------- 7. 确认删除，行消失、已删除计数 +1 ----------
    await cdp.evaluate(`
      (function () {
        var target = window.__T.children().find(function (c) {
          return window.__T.label(c).indexOf('夜宵') >= 0
        })
        window.__T.one('delete-' + window.__T.idOf(target)).click()
      })()
    `)
    await sleep(350)
    await cdp.evaluate(`window.__T.click(window.__T.one('confirm-ok'))`)
    await sleep(600)

    const afterDelete = await cdp.evaluate(`window.__T.names(window.__T.children())`)
    check(
      '确认后「夜宵」从小类列表消失',
      afterDelete.length === 8 && !afterDelete.some((n) => n.indexOf('夜宵') >= 0),
      `${afterDelete.length} 个：${afterDelete.join(' / ')}`
    )

    const archivedRows = await cdp.evaluate(`
      (function () {
        var section = window.__T.one('archived-section')
        if (section) section.open = true
        return window.__T.names(window.__T.archived())
      })()
    `)
    check(
      '「已删除的分类」里能查到「夜宵」',
      archivedRows.some((n) => n.indexOf('夜宵') >= 0),
      archivedRows.join(' / ')
    )

    // ---------- 8. 点恢复，行回到列表 ----------
    await cdp.evaluate(`
      (function () {
        var row = window.__T.archived().find(function (a) {
          return window.__T.label(a).indexOf('夜宵') >= 0
        })
        window.__T.one('restore-' + window.__T.idOf(row)).click()
      })()
    `)
    await sleep(700)
    const afterRestore = await cdp.evaluate(`window.__T.names(window.__T.children())`)
    check(
      '点「恢复」后「夜宵」回到小类列表',
      afterRestore.length === 9 && afterRestore.some((n) => n.indexOf('夜宵') >= 0),
      `${afterRestore.length} 个`
    )

    // ---------- 9. 删整个大类（用界面上的删除按钮，不用 API） ----------
    const majorsBeforeArchive = await cdp.evaluate(`window.__T.majors().length`)
    const majorDialog = await cdp.evaluate(`
      (function () {
        var m = window.__T.majors().find(function (x) {
          return window.__T.label(x).indexOf('餐饮') >= 0
        })
        if (!m) return '没找到餐饮'
        var btn = window.__T.one('major-delete-' + window.__T.idOf(m))
        if (!btn) return '大类行上没有删除按钮'
        btn.click()
        return 'ok'
      })()
    `)
    check('大类行上有删除按钮且能点', majorDialog === 'ok', majorDialog)
    await sleep(350)

    const majorDialogText = await cdp.evaluate(`
      (function () {
        var d = window.__T.one('confirm-dialog')
        return d ? window.__T.label(d) : '（没有确认框）'
      })()
    `)
    check(
      '删整个大类时提示「下面还有 N 个小类，将一起删除」',
      majorDialogText.indexOf('小类') >= 0 && majorDialogText.indexOf('一起删除') >= 0,
      majorDialogText.slice(0, 60)
    )

    await cdp.evaluate(`window.__T.click(window.__T.one('confirm-ok'))`)
    await sleep(800)
    const afterArchiveMajor = await cdp.evaluate(`window.__T.majors().length`)
    check('归档整个「餐饮」后，左栏大类少一个', afterArchiveMajor === majorsBeforeArchive - 1, `${afterArchiveMajor} 个`)

    const archivedAfterMajor = await cdp.evaluate(`
      (function () {
        var section = window.__T.one('archived-section')
        if (section) section.open = true
        return window.__T.names(window.__T.archived())
      })()
    `)
    check(
      '已删除列表里出现「餐饮」并标注含几个小类',
      archivedAfterMajor.some((n) => n.indexOf('餐饮') >= 0 && n.indexOf('小类') >= 0),
      archivedAfterMajor.find((n) => n.indexOf('餐饮') >= 0)
    )

    // ---------- 10. 点「恢复内置分类」把它整棵恢复回来 ----------
    await cdp.evaluate(`window.__T.click(window.__T.one('restore-builtins'))`)
    await sleep(900)
    const afterRestoreBuiltins = await cdp.evaluate(`window.__T.majors().length`)
    check(
      '点「恢复内置分类」后「餐饮」回来了',
      afterRestoreBuiltins === majorsBeforeArchive,
      `${afterRestoreBuiltins} 个`
    )
    const restoredChildren = await cdp.evaluate(`
      (function () {
        var m = window.__T.majors().find(function (x) {
          return window.__T.label(x).indexOf('餐饮') >= 0
        })
        if (!m) return []
        m.click()
        return []
      })()
    `)
    void restoredChildren
    await sleep(400)
    const kidsBack = await cdp.evaluate(`window.__T.children().length`)
    check('恢复后「餐饮」的 9 个小类也一起回来了', kidsBack === 9, `${kidsBack} 个`)

    const noticeText = await cdp.evaluate(`
      (function () { var n = window.__T.one('notice-banner'); return n ? window.__T.label(n) : '' })()
    `)
    check('恢复后给出了中文反馈', noticeText.indexOf('恢复') >= 0, noticeText)

    // ---------- 10b. 归档掉最后一个小类，界面要显示空状态而不是崩掉 ----------
    // （复核指出的验证缺口：原脚本只走 9→8→9，从没走到 0）
    // 全部走真实界面输入框，顺便把小类的「新建 → 删除」整条路径也验了
    await cdp.evaluate(`
      (function () {
        window.__T.setInput(window.__T.one('new-major-name'), '验证用大类')
        window.__T.one('new-major-add').click()
      })()
    `)
    await sleep(700)
    const probeMajor = await cdp.evaluate(`
      (function () {
        var m = window.__T.majors().find(function (x) {
          return window.__T.label(x).indexOf('验证用大类') >= 0
        })
        if (!m) return null
        m.click()
        return window.__T.idOf(m)
      })()
    `)
    check('用界面输入框新建一级大类成功', typeof probeMajor === 'number', `id=${probeMajor}`)
    await sleep(400)

    const freshEmpty = await cdp.evaluate(`
      (function () {
        var el = window.__T.one('children-empty')
        return el ? window.__T.label(el) : '（没有空状态）'
      })()
    `)
    check('刚建好的大类下显示「还没有小类」空状态', freshEmpty.indexOf('还没有小类') >= 0, freshEmpty)

    await cdp.evaluate(`
      (function () {
        window.__T.setInput(window.__T.one('new-child-name'), '唯一的小类')
        window.__T.one('new-child-add').click()
      })()
    `)
    await sleep(700)
    const probeChildren = await cdp.evaluate(`window.__T.children().length`)
    check('用界面输入框新建小类成功', probeChildren === 1, `${probeChildren} 个`)

    // 删掉这唯一的小类，看界面会不会崩
    await cdp.evaluate(`
      (function () {
        var c = window.__T.children()[0]
        window.__T.one('delete-' + window.__T.idOf(c)).click()
      })()
    `)
    await sleep(350)
    await cdp.evaluate(`window.__T.click(window.__T.one('confirm-ok'))`)
    await sleep(700)

    const emptyState = await cdp.evaluate(`
      (function () {
        var el = window.__T.one('children-empty')
        return el ? window.__T.label(el) : '（没有空状态）'
      })()
    `)
    check(
      '最后一个小类被归档后，右栏显示空状态而不是空白或崩溃',
      emptyState.indexOf('还没有小类') >= 0,
      emptyState
    )
    const stillAlive = await cdp.evaluate(`!!window.__T.one('category-manager')`)
    check('空状态下界面仍然正常挂载（没崩）', stillAlive === true)

    // 清理验证数据：删掉这个验证用大类
    await cdp.evaluate(`
      (function () {
        var m = window.__T.majors().find(function (x) {
          return window.__T.label(x).indexOf('验证用大类') >= 0
        })
        if (m) window.__T.one('major-delete-' + window.__T.idOf(m)).click()
      })()
    `)
    await sleep(350)
    await cdp.evaluate(`window.__T.click(window.__T.one('confirm-ok'))`)
    await sleep(700)

    // ---------- 11. 界面数据与数据库最终对得上 ----------
    const finalState = await cdp.evaluate(`
      (function () {
        return JSON.stringify({
          majors: window.__T.majors().length,
          children: window.__T.children().length
        })
      })()
    `)
    const fs = JSON.parse(finalState)
    check('收尾状态正确：11 个支出大类、餐饮下 9 个小类', fs.majors === 11 && fs.children === 9, finalState)

    ws.close()
  } finally {
    child.kill()
    await sleep(800)
    if (stderr.trim() && !stderr.includes('DevTools listening')) {
      console.log('\n--- Electron stderr ---')
      console.log(stderr.trim().split('\n').slice(0, 15).join('\n'))
    }
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
