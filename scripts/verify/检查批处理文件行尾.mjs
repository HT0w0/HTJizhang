/**
 * 检查所有 .bat 文件的行尾是不是 Windows 的 CRLF。
 *
 * 为什么需要这个检查：.bat 文件用 Unix 换行（LF）保存时，cmd.exe 的解析器
 * 会把每一行开头的字符当成上一行的行尾吃掉——`echo` 变成 `ho`、
 * `%ERRORLEVEL%` 变成 `ERRORLEVEL:`，整个脚本静默失效：
 * **不报错、不提示，只是什么都不发生。**
 *
 * 实测（2026-10-03）：双击启动HT记账.bat 后黑窗口一闪而过、软件窗口不出现、
 * 数据库也没建出来。查了半天才发现是行尾问题。
 *
 * 这类问题的危险之处在于它是「静默」的：用户看到的是「双击了没反应」，
 * 完全不知道发生了什么。所以必须有自动化检查挡住它。
 *
 * 用法：node scripts/verify/检查批处理文件行尾.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 项目根目录 = 本文件所在目录往上两级（scripts/verify/ → scripts/ → 项目根）。
//
// ⚠️ 这里**不能**写死绝对路径。这个仓库是公开的，别人会克隆到自己的目录下；
// 原先写死成 `D:\Claude Code\记账APP`，别人在自己的目录里跑 `npm run check:bat`
// 会直接抛 ENOENT「找不到目录」。
// 尤其难堪的是：这个脚本查的是「别的脚本会不会静默失效」，它自己反倒先坏了，
// 会让人对整套检查失去信任。所以宁可多写两行推导，也不留一个本机路径。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 不检查的目录：第三方依赖与构建产物。 */
const SKIP_DIRS = new Set(['node_modules', 'out', 'release', '.git', '.superpowers'])

function findBatFiles(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      findBatFiles(full, found)
    } else if (entry.toLowerCase().endsWith('.bat')) {
      found.push(full)
    }
  }
  return found
}

/**
 * 找出所有「LF 结尾但不是 CRLF」的行号。
 *
 * 只看 \n 前面是不是 \r —— 不能简单地统计 \r\n 的数量，
 * 因为混用行尾（一部分 CRLF、一部分 LF）同样会让 cmd 解析错乱。
 */
function findLfLines(text) {
  const bad = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    // 最后一段是文件末尾的空串，不算一行
    if (i === lines.length - 1 && line === '') return
    if (!line.endsWith('\r')) bad.push(i + 1)
  })
  return bad
}

const files = findBatFiles(ROOT)

if (files.length === 0) {
  console.log('\n没有找到任何 .bat 文件\n')
  process.exit(0)
}

console.log('\n【批处理文件行尾检查】\n')

let failed = 0
for (const file of files) {
  const rel = relative(ROOT, file)
  const text = readFileSync(file, 'utf8')

  if (text.includes('\n') && !text.includes('\r\n')) {
    console.log(`  ✗ ${rel} —— 全部是 LF 行尾，cmd 执行会出错`)
    console.log(`     修法：sed -i 's/\\r$//; s/$/\\r/' "${rel}"`)
    failed += 1
    continue
  }

  const lfLines = findLfLines(text)
  if (lfLines.length > 0) {
    console.log(`  ✗ ${rel} —— 混用行尾，第 ${lfLines.slice(0, 5).join(', ')} 行是 LF`)
    failed += 1
    continue
  }

  const lineCount = text.split('\r\n').length
  console.log(`  ✓ ${rel} —— 全部 CRLF（${lineCount} 行）`)
}

console.log(
  failed === 0
    ? `\n结果：${files.length}/${files.length} 个文件行尾正确\n`
    : `\n结果：${failed}/${files.length} 个文件行尾有问题 —— 这会静默破坏脚本，必须修\n`
)

process.exitCode = failed === 0 ? 0 : 1
