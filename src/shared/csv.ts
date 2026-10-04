/**
 * 导出成 CSV 表格（可以用 Excel 打开）的纯逻辑。
 *
 * 不碰数据库、不碰文件系统（CLAUDE.md §5.15），所以能直接单测。
 * 真正去查库、去写文件的是 src/main/db/backup.ts。
 *
 * 这里每一处看起来「多余」的讲究，都是 Excel 的脾气：
 * 少了 BOM，中文全是乱码；金额带千分位，Excel 就把它当文字而不是数字……
 * 用户看到乱码只会以为软件坏了，不会想到是编码问题。
 */
import { fenToYuan } from './money'
import { paymentMethodLabel, isPaymentMethod } from './paymentMethods'
import type { CategoryKind } from './types'

/**
 * 字节顺序标记。
 *
 * ⚠️ **必须写在文件最开头**，否则 Excel 会按本机默认编码去猜，
 * 中文界面上导出的中文内容就会变成「鍚嶇О」这样的乱码。
 * 这是 Excel 的毛病（它打开无 BOM 的 UTF-8 文件时按 GBK 猜），
 * 但用户看到的是我们的文件坏了 —— 所以得我们迁就它。
 *
 * 副作用：用记事本或 VS Code 打开时，开头会多一个看不见的字符。
 * 这是正常的，不要「修」它。
 */
export const CSV_BOM = '﻿'

/** 表头。改这里就等于改导出的列，测试会跟着一起钉住。 */
export const CSV_HEADER = ['日期', '收支', '大类', '小类', '金额(元)', '备注', '支付方式'] as const

/** 表格里的一行。刻意用「名字」而不是 id —— 用户拿着表看不懂 17 是什么。 */
export interface CsvTransactionRow {
  /** 本地日期 YYYY-MM-DD。原样写进表格，不翻译成「2026年10月4日」。 */
  readonly occurredOn: string
  readonly kind: CategoryKind
  readonly majorName: string
  readonly minorName: string
  /** 金额，单位「分」。 */
  readonly amountFen: number
  readonly note: string
  readonly paymentMethod: string
}

/**
 * 把一个字段转成能安全放进 CSV 的形式。
 *
 * 规矩来自 CSV 格式本身（RFC 4180）：字段里出现逗号、双引号或换行时，
 * 整个字段要用双引号包起来；而字段里本来的双引号要写成两个。
 *
 * **双引号翻倍那一步漏了的话**，后果不是「多一个引号」那么轻 ——
 * 一个备注里写了 `他说"好吃"`，后面的字段会被整体错位到下一行，
 * 整张表的列从此对不上，而用户完全不知道是从哪一行开始错的。
 */
export function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/**
 * 把账单拼成一份完整的 CSV 文本（含 BOM）。
 *
 * 行尾用 CRLF：CSV 的标准写法，Excel 和记事本都认。
 * 一笔账都没有时也返回表头 —— 用户拿到一个空文件会以为是导出失败了。
 */
export function buildTransactionsCsv(rows: readonly CsvTransactionRow[]): string {
  const lines = [CSV_HEADER.join(',')]

  for (const row of rows) {
    lines.push(
      [
        row.occurredOn,
        row.kind === 'expense' ? '支出' : '收入',
        row.majorName,
        row.minorName,
        // 用 fenToYuan 而不是 formatYuan：后者带千分位（1,234.56），
        // Excel 会把这个字段当成文字，用户就没法在表格里求和了。
        fenToYuan(row.amountFen),
        row.note,
        isPaymentMethod(row.paymentMethod) ? paymentMethodLabel(row.paymentMethod) : row.paymentMethod
      ]
        .map(escapeCsvField)
        .join(',')
    )
  }

  return CSV_BOM + lines.join('\r\n') + '\r\n'
}

/**
 * 导出 CSV 时的默认文件名。
 *
 * 带「HT记账」前缀是为了用户下载文件夹里一眼能找到；
 * 带日期是为了连着导两次时邮箱/文件夹里不会互相覆盖。
 *
 * month 为 null 表示导出全部账单，文件名里写明「全部」——
 * 用户过阵子翻到两个文件，得能一眼看出哪个是全量、哪个是某个月的。
 */
export function csvFileName(month: string | null, today: string): string {
  return month === null
    ? `HT记账-账单-全部-${today}.csv`
    : `HT记账-账单-${month}.csv`
}
