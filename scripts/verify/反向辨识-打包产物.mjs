/**
 * 「检查打包产物.mjs」的反向辨识工具（CLAUDE.md §九）。
 *
 * ## 为什么需要它
 *
 * 一个全绿的检查脚本有两种可能：**软件是对的**，或者**检查根本没在看**。
 * 这两者从输出上长得一模一样。唯一的区分办法是：故意把软件改坏，
 * 看对应的检查项会不会真的变红。变了，说明它在看；不变，说明它是空转的。
 *
 * ## 为什么改的是打包产物、不是源码
 *
 * 改源码要重新跑一遍 `npm run build:win`（约 1 分钟）。而打包后的
 * `resources/app.asar` 里，代码是**明文**存着的（没有压缩），
 * 直接改里面的字节就行 —— 一次辨识从 1 分钟降到几秒。
 *
 * ## 关键约束：替换必须**等长**
 *
 * asar 的文件头里记着每个文件的偏移量和长度。改了长度而不同步更新头部，
 * 后面的文件就会整体错位、整个归档报废（现象是程序根本起不来，
 * 那样「检查变红」证明不了任何事 —— 它红是因为程序坏了，不是因为检查在看）。
 * 所以下面每一处替换都**补空格凑到同样的字节数**。JS 里多余的空格无所谓。
 *
 * 用完自动还原（`finally` 里恢复备份）。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE node "scripts/verify/反向辨识-打包产物.mjs" [seam|single|nav]
 *       不带参数就跑全部三处。
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const PROJECT = join(import.meta.dirname, '..', '..')
const ASAR = join(PROJECT, 'release', 'win-unpacked', 'resources', 'app.asar')
const BACKUP = `${ASAR}.反向辨识备份`
const VERIFY = join(PROJECT, 'scripts', 'verify', '检查打包产物.mjs')

/**
 * 每一处破坏：把 `from` 换成 `to`。
 * `to` 必须和 `from` **字节数完全相同** —— 见文件顶部「关键约束」。
 */
const BREAKS = {
  seam: {
    why: '把「打包版里替身不生效」的守卫去掉（假装它没被 app.isPackaged 挡住）',
    expect: ['替身带着 app.isPackaged 守卫'],
    edits: [['electron.app.isPackaged', 'false' + ' '.repeat(18)]]
  },
  single: {
    why: '假装没真的去抢单实例锁（第二个实例就退不掉了）',
    expect: ['第二个实例自己退出了'],
    edits: [['electron.app.requestSingleInstanceLock()', 'true' + ' '.repeat(36)]]
  },
  nav: {
    why: '改掉左侧导航里「记一笔」的文案（验证读界面文字这条路没瞎）',
    // 「记一笔」和「记两笔」都是 9 个 UTF-8 字节
    expect: ['左侧 4 个导航按钮'],
    edits: [['记一笔', '记两笔']]
  }
}

/** 跑一遍验证脚本，返回「变红了的检查项名字」。 */
function runVerify() {
  const res = spawnSync('node', [VERIFY], {
    cwd: PROJECT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
  const failed = []
  let inFailed = false
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('失败项：')) {
      inFailed = true
      continue
    }
    if (inFailed && line.trim().startsWith('✗')) failed.push(line.trim())
    else if (inFailed && !line.trim().startsWith('✗')) inFailed = false
  }
  const passLine = (out.match(/通过 (\d+) \/ (\d+)/) ?? [])[0] ?? '(没读到汇总)'
  return { failed, passLine, out }
}

/** 按字节等长替换。找不到目标就报错，不静默跳过 —— 静默跳过会让辨识变成空转。 */
function patch(buf, from, to) {
  const a = Buffer.from(from, 'utf8')
  const b = Buffer.from(to, 'utf8')
  if (a.length !== b.length) {
    throw new Error(`替换长度不等：${JSON.stringify(from)} ${a.length} 字节 → ${b.length} 字节`)
  }
  const at = buf.indexOf(a)
  if (at < 0) throw new Error(`打包产物里找不到 ${JSON.stringify(from)} —— 这处辨识是空转的`)

  let count = 0
  let i = 0
  while ((i = buf.indexOf(a, i)) >= 0) {
    b.copy(buf, i)
    i += b.length
    count += 1
  }
  return count
}

const wanted = process.argv[2] ? [process.argv[2]] : Object.keys(BREAKS)
for (const key of wanted) {
  if (!BREAKS[key]) throw new Error(`没有这处破坏：${key}（可选：${Object.keys(BREAKS).join(' / ')}）`)
}

copyFileSync(ASAR, BACKUP)
console.log(`已备份打包产物 → ${BACKUP}\n`)

const summary = []
try {
  for (const key of wanted) {
    const spec = BREAKS[key]
    console.log('='.repeat(60))
    console.log(`【反向辨识】${key} —— ${spec.why}`)

    // 每次从原始产物出发，免得上一处的改动累积到这一处
    copyFileSync(BACKUP, ASAR)
    const buf = readFileSync(ASAR)
    let hits = 0
    for (const [from, to] of spec.edits) hits += patch(buf, from, to)
    writeFileSync(ASAR, buf)
    console.log(`  改了 ${hits} 处字节`)

    const { failed, passLine } = runVerify()
    console.log(`  跑完：${passLine}`)
    for (const f of failed) console.log(`    ${f}`)

    for (const want of spec.expect) {
      const hit = failed.some((f) => f.includes(want))
      console.log(`  ${hit ? '✓' : '✗'} 预期变红的「${want}」${hit ? '确实红了' : '**没红 —— 这条检查是空转的**'}`)
      summary.push({ key, want, hit })
    }
    console.log('')
  }
} finally {
  copyFileSync(BACKUP, ASAR)
  console.log('已还原打包产物')
  const bad = summary.filter((s) => !s.hit)
  console.log(`\n辨识结果：${summary.length - bad.length} / ${summary.length} 处符合预期`)
  process.exitCode = bad.length === 0 ? 0 : 1
}
