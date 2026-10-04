import { test, expect } from 'vitest'
import { CSV_BOM, buildTransactionsCsv, csvFileName } from './csv'
import type { CsvTransactionRow } from './csv'

/** 一条最普通的账单，测试都在它基础上改一个字段。 */
const row: CsvTransactionRow = {
  occurredOn: '2026-10-04',
  kind: 'expense',
  majorName: '餐饮',
  minorName: '午餐',
  amountFen: 2850,
  note: '公司楼下的面',
  paymentMethod: 'wechat'
}

/** 去掉 BOM 和行尾，方便按「行」断言。 */
function lines(csv: string): string[] {
  return csv.replace(CSV_BOM, '').split('\r\n').filter((l) => l !== '')
}

// ---------------------------------------------------------------------------
// 开头的 BOM —— 不加的话 Excel 打开中文全是乱码
// ---------------------------------------------------------------------------

test('开头有 BOM，否则 Excel 打开后中文会变成乱码', () => {
  expect(buildTransactionsCsv([]).startsWith(CSV_BOM)).toBe(true)
})

test('BOM 真的是 U+FEFF 那一个字符（不是空串、不是别的东西）', () => {
  // ⚠️ 上面那条单独看是**空转的**：CSV_BOM 要是空串，startsWith('') 恒为真，
  // 测试照样绿，而导出的文件照样乱码。所以必须直接查字符码。
  expect(CSV_BOM).toHaveLength(1)
  expect(CSV_BOM.charCodeAt(0)).toBe(0xfeff)
  expect(buildTransactionsCsv([]).charCodeAt(0)).toBe(0xfeff)
})

test('BOM 之后紧接着就是表头（中间不能有空行）', () => {
  expect(lines(buildTransactionsCsv([]))[0]).toBe('日期,收支,大类,小类,金额(元),备注,支付方式')
})

// ---------------------------------------------------------------------------
// 行尾必须是 CRLF
// ---------------------------------------------------------------------------

test('行尾用 CRLF（Excel 和记事本对 LF 的容忍度不一样，CRLF 是 CSV 的标准）', () => {
  const csv = buildTransactionsCsv([row])
  expect(csv).toContain('\r\n')
  // 不能有「光一个 \n 前面不是 \r」的情况
  expect(/[^\r]\n/.test(csv)).toBe(false)
})

// ---------------------------------------------------------------------------
// 字段转义 —— 备注是用户随便打的，逗号引号换行都可能出现
// ---------------------------------------------------------------------------

test('备注里的逗号不会把一行拆成两列（要用引号包起来）', () => {
  const csv = buildTransactionsCsv([{ ...row, note: '面条,加蛋' }])
  expect(lines(csv)[1]).toContain('"面条,加蛋"')
})

test('备注里的双引号要写成两个（CSV 的转义规矩，不翻倍会把后面的字段全吃掉）', () => {
  const csv = buildTransactionsCsv([{ ...row, note: '他说"好吃"' }])
  expect(lines(csv)[1]).toContain('"他说""好吃"""')
})

test('备注里的换行也包得住，不会真的把一行断成两行', () => {
  const csv = buildTransactionsCsv([{ ...row, note: '第一行\n第二行' }])
  expect(lines(csv)).toHaveLength(2)
  expect(lines(csv)[1]).toContain('"第一行\n第二行"')
})

test('普通备注不加多余的引号（满屏引号没法读）', () => {
  const csv = buildTransactionsCsv([row])
  expect(lines(csv)[1]).toContain('公司楼下的面')
  expect(lines(csv)[1]).not.toContain('"')
})

test('分类名里出现逗号也照样包得住', () => {
  const csv = buildTransactionsCsv([{ ...row, note: '', majorName: 'A,B' }])
  expect(lines(csv)[1]).toContain('"A,B"')
})

// ---------------------------------------------------------------------------
// 各列的内容
// ---------------------------------------------------------------------------

test('金额不带千分位 —— 带了 Excel 会把它当成文字，没法求和', () => {
  const csv = buildTransactionsCsv([{ ...row, amountFen: 123456 }])
  expect(lines(csv)[1]).toContain('1234.56')
  expect(lines(csv)[1]).not.toContain('1,234.56')
})

test('金额一律两位小数，7 分钱写成 0.07', () => {
  expect(buildTransactionsCsv([{ ...row, amountFen: 7 }])).toContain('0.07')
})

test('收支列写中文「支出」「收入」，不写 expense/income', () => {
  const csv = buildTransactionsCsv([row, { ...row, kind: 'income' }])
  expect(lines(csv)[1]).toContain('支出')
  expect(lines(csv)[2]).toContain('收入')
})

test('支付方式写中文，不写 wechat', () => {
  expect(buildTransactionsCsv([row])).toContain('微信')
})

test('日期原样写 YYYY-MM-DD，不翻译成「2026年10月4日」（表格要能排序和筛选）', () => {
  expect(lines(buildTransactionsCsv([row]))[1]).toContain('2026-10-04')
})

test('几笔账就几行（加上表头）', () => {
  const csv = buildTransactionsCsv([row, row, row])
  expect(lines(csv)).toHaveLength(4)
})

test('一笔账都没有时，只有表头也不报错（刚装上的软件就是这种状态）', () => {
  expect(lines(buildTransactionsCsv([]))).toHaveLength(1)
})

// ---------------------------------------------------------------------------
// 文件名
// ---------------------------------------------------------------------------

test('导出全部时，文件名里写明「全部」并带上导出日期', () => {
  expect(csvFileName(null, '2026-10-04')).toBe('HT记账-账单-全部-2026-10-04.csv')
})

test('导出某个月时，文件名里就是那个月', () => {
  expect(csvFileName('2026-09', '2026-10-04')).toBe('HT记账-账单-2026-09.csv')
})
