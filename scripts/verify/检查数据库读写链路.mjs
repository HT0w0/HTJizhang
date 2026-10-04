/**
 * 第 2 阶段 Task 6 的端到端验证。
 *
 * 启动打包好的生产版本，通过 Electron 调试接口（CDP）在真实渲染进程里
 * 调用 window.ht.categories.*，确认「界面 → 预加载 → IPC → 数据库」整条链路通了。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE node e2e-task6.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PORT = 9222
const PROJECT = join(import.meta.dirname, '..', '..')
const ELECTRON = join(PROJECT, 'node_modules', 'electron', 'dist', 'electron.exe')
/**
 * 数据目录：**不是**软件真实的数据目录。
 *
 * 用 --user-data-dir 把 Electron 的 userData 整个挪到项目下的临时目录 ——
 * 这条链路验证会在里面建库、写数据，落在真实目录上就动了用户账本。
 * 见 CLAUDE.md §九。
 */
const USER_DATA = join(PROJECT, '.verify-data', '数据库读写链路')

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

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
  throw new Error('等了 30 秒也没等到调试接口，Electron 可能没起来')
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
    if (res.result?.exceptionDetails) {
      throw new Error(
        `页面里执行出错：${JSON.stringify(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails)}`
      )
    }
    return res.result?.result?.value
  }
}

async function main() {
  console.log('\n【第 2 阶段端到端验证】\n')

  // 清空隔离目录，让「首次启动」的语义成立（这里删的不是用户账本）。
  rmSync(USER_DATA, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })

  const before = existsSync(USER_DATA)
  console.log(`隔离数据目录：${USER_DATA}`)
  console.log(`启动前是否存在：${before ? '是' : '否'}\n`)

  const child = spawn(
    ELECTRON,
    [
      join(PROJECT, 'out', 'main', 'index.js'),
      `--user-data-dir=${USER_DATA}`,
      `--remote-debugging-port=${PORT}`
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
    const target = await getTarget()
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', reject)
    })
    const cdp = new Cdp(ws)
    await cdp.send('Runtime.enable')
    await sleep(600)

    // ---- 1. window.ht 存在且带 categories ----
    const shape = await cdp.evaluate(
      `JSON.stringify({
         hasHt: typeof window.ht === 'object' && window.ht !== null,
         platform: window.ht && window.ht.platform,
         hasCategories: !!(window.ht && window.ht.categories),
         methods: window.ht && window.ht.categories ? Object.keys(window.ht.categories).sort() : []
       })`
    )
    const s = JSON.parse(shape)
    check('渲染进程拿得到 window.ht', s.hasHt, `platform=${s.platform}`)
    check(
      'window.ht.categories 的 10 个方法都在',
      s.methods.length === 10,
      s.methods.join(',')
    )

    // ---- 2. 数据库真的建出来了 ----
    const dbFile = join(USER_DATA, 'ht-jizhang.db')
    check('数据库文件已创建', existsSync(dbFile), dbFile)
    if (existsSync(dbFile)) {
      const size = statSync(dbFile).size
      check('数据库文件不是空的', size > 0, `${size} 字节`)
      check(
        '目录里有 WAL 相关文件（说明 WAL 模式真的开着）',
        readdirSync(USER_DATA).some((f) => f.startsWith('ht-jizhang.db-')),
        readdirSync(USER_DATA).join(', ')
      )
    }

    // ---- 3. 通过界面 API 读分类清单 ----
    const tree = await cdp.evaluate('window.ht.categories.list()')
    const majors = tree.filter((n) => n.parentId === null)
    const kids = tree.flatMap((n) => n.children)
    check('界面读到 16 个大类', majors.length === 16, `实际 ${majors.length}`)
    check('界面读到 80 个小类', kids.length === 80, `实际 ${kids.length}`)
    check(
      '支出 11 个大类 / 收入 5 个大类',
      majors.filter((n) => n.kind === 'expense').length === 11 &&
        majors.filter((n) => n.kind === 'income').length === 5
    )

    const restaurant = tree.find((n) => n.name === '餐饮')
    check(
      '「餐饮」下有 9 个小类且顺序正确',
      !!restaurant && restaurant.children.map((c) => c.name).join('|') ===
        '早餐|午餐|晚餐|夜宵|饮料零食|咖啡奶茶|外卖|聚餐请客|买菜食材',
      restaurant ? restaurant.children.map((c) => c.name).join('|') : '没找到餐饮'
    )
    check('内置分类的 isBuiltin 为 true', restaurant?.isBuiltin === true)

    // ---- 4. 写操作能落库 ----
    const created = await cdp.evaluate(
      `window.ht.categories.create({ kind: 'expense', parentId: null, name: '端到端测试类目', icon: '🧪' })`
    )
    check('新建分类成功', created && created.id > 0, `id=${created?.id}`)

    const afterCreate = await cdp.evaluate('window.ht.categories.list()')
    check(
      '新建后大类变成 17 个',
      afterCreate.filter((n) => n.parentId === null).length === 17
    )

    // ---- 5. 失败路径给出干净中文 ----
    const dupMessage = await cdp.evaluate(
      `window.ht.categories.create({ kind: 'expense', parentId: null, name: '餐饮', icon: '🍜' })
         .then(() => '（没有报错，这不对）')
         .catch(e => e.message)`
    )
    check(
      '重名给出中文提示',
      typeof dupMessage === 'string' && dupMessage.includes('已存在'),
      dupMessage
    )
    check(
      '错误信息里没有 Electron 那串英文前缀',
      typeof dupMessage === 'string' && !dupMessage.includes('Error invoking remote method'),
      dupMessage
    )

    // ---- 6. 改名 / 排序 / 归档 / 恢复 ----
    await cdp.evaluate(`window.ht.categories.rename(${created.id}, '端到端改过名')`)
    const renamed = await cdp.evaluate('window.ht.categories.list()')
    check('改名生效', renamed.some((n) => n.name === '端到端改过名'))

    await cdp.evaluate(`window.ht.categories.archive(${created.id})`)
    const afterArchive = await cdp.evaluate('window.ht.categories.list()')
    check('归档生效（列表里没了）', !afterArchive.some((n) => n.id === created.id))

    const archived = await cdp.evaluate('window.ht.categories.listArchived()')
    check('已删除列表里能查到它', archived.some((n) => n.id === created.id))

    await cdp.evaluate(`window.ht.categories.restore(${created.id})`)
    const afterRestore = await cdp.evaluate('window.ht.categories.list()')
    check('恢复生效', afterRestore.some((n) => n.id === created.id))

    // 排序：把 16 个大类顺序倒过来
    const expenseIds = afterRestore.filter((n) => n.kind === 'expense' && n.parentId === null).map((n) => n.id)
    const reversed = [...expenseIds].reverse()
    await cdp.evaluate(
      `window.ht.categories.reorder('expense', null, ${JSON.stringify(reversed)})`
    )
    const afterReorder = await cdp.evaluate('window.ht.categories.list()')
    const nowIds = afterReorder.filter((n) => n.kind === 'expense' && n.parentId === null).map((n) => n.id)
    check('排序真的变了', JSON.stringify(nowIds) === JSON.stringify(reversed))

    // 清掉测试数据，别污染用户的库。
    // 顺序要紧：先归档测试类目，再按「归档之后」的大类列表恢复原顺序。
    await cdp.evaluate(`window.ht.categories.archive(${created.id})`)
    const afterCleanupArchive = await cdp.evaluate('window.ht.categories.list()')
    const cleanOrder = afterCleanupArchive
      .filter((n) => n.kind === 'expense' && n.parentId === null)
      .map((n) => n.id)
    await cdp.evaluate(`window.ht.categories.reorder('expense', null, ${JSON.stringify(cleanOrder)})`)
    const cleaned = await cdp.evaluate('window.ht.categories.list()')
    check(
      '测试数据已清理，支出大类回到 11 个',
      cleaned.filter((n) => n.kind === 'expense' && n.parentId === null).length === 11,
      `实际 ${cleaned.filter((n) => n.kind === 'expense' && n.parentId === null).length}`
    )

    ws.close()
  } finally {
    child.kill()
    await sleep(800)
    if (stderr.trim()) {
      console.log('\n--- Electron 的 stderr（若有内容需留意）---')
      console.log(stderr.trim().split('\n').slice(0, 20).join('\n'))
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
