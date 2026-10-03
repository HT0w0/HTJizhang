import { describe, expect, it } from 'vitest'
import { fenToYuan, formatYuan, yuanToFen } from './money'

describe('yuanToFen — 元转分', () => {
  it('整数元', () => {
    expect(yuanToFen('12')).toBe(1200)
  })

  it('两位小数', () => {
    expect(yuanToFen('12.34')).toBe(1234)
  })

  it('一位小数按十分位补齐', () => {
    expect(yuanToFen('12.3')).toBe(1230)
  })

  it('小数换算必须精确，不能有浮点误差', () => {
    expect(yuanToFen('0.1')).toBe(10)
    expect(yuanToFen('0.07')).toBe(7)
    expect(yuanToFen('1.10')).toBe(110)
    expect(yuanToFen('0.29')).toBe(29)
  })

  it('可以省略整数部分', () => {
    expect(yuanToFen('.5')).toBe(50)
  })

  it('忽略首尾空格', () => {
    expect(yuanToFen('  12.34  ')).toBe(1234)
  })

  it('容忍从别处粘贴来的标准千分位逗号', () => {
    expect(yuanToFen('1,234.56')).toBe(123456)
    expect(yuanToFen('1,000,000')).toBe(100000000)
    expect(yuanToFen('1,234')).toBe(123400)
  })

  it('拒绝分组位置错误的逗号，绝不静默重新解释', () => {
    // 这些若被放行，用户会得到一个自己没输入过的金额——正是本模块要杜绝的「悄悄算错」
    expect(yuanToFen('1,2,3')).toBeNull()
    expect(yuanToFen('12,34')).toBeNull()
    expect(yuanToFen('1,2345')).toBeNull()
    expect(yuanToFen('1,0.5')).toBeNull()
    expect(yuanToFen(',')).toBeNull()
    expect(yuanToFen('1,')).toBeNull()
    expect(yuanToFen(',123')).toBeNull()
  })

  it('容忍中文全角数字与全角小数点', () => {
    expect(yuanToFen('１２．３')).toBe(1230)
    expect(yuanToFen('９')).toBe(900)
  })

  it('容忍中文全角逗号（中文输入法很容易打出来）', () => {
    expect(yuanToFen('1，234.56')).toBe(123456)
    expect(yuanToFen('1，000')).toBe(100000)
  })

  it('零是合法的换算结果（是否允许记 0 元由表单层判断）', () => {
    expect(yuanToFen('0')).toBe(0)
    expect(yuanToFen('0.00')).toBe(0)
  })

  it('超过两位小数必须拒绝，不做四舍五入', () => {
    expect(yuanToFen('12.345')).toBeNull()
    expect(yuanToFen('0.001')).toBeNull()
  })

  it('负数拒绝', () => {
    expect(yuanToFen('-5')).toBeNull()
    expect(yuanToFen('-0.01')).toBeNull()
  })

  it('空字符串与纯空格拒绝', () => {
    expect(yuanToFen('')).toBeNull()
    expect(yuanToFen('   ')).toBeNull()
  })

  it('非数字内容拒绝', () => {
    expect(yuanToFen('abc')).toBeNull()
    expect(yuanToFen('1e3')).toBeNull()
    expect(yuanToFen('12元')).toBeNull()
    expect(yuanToFen('12.3.4')).toBeNull()
    expect(yuanToFen('+5')).toBeNull()
  })

  it('超出安全整数范围必须拒绝，而不是静默算错', () => {
    expect(yuanToFen('99999999999999999999')).toBeNull()
  })
})

describe('fenToYuan — 分转元', () => {
  it('基本换算', () => {
    expect(fenToYuan(1234)).toBe('12.34')
  })

  it('分位补零', () => {
    expect(fenToYuan(1200)).toBe('12.00')
    expect(fenToYuan(7)).toBe('0.07')
  })

  it('零', () => {
    expect(fenToYuan(0)).toBe('0.00')
  })

  it('负数', () => {
    expect(fenToYuan(-1234)).toBe('-12.34')
    expect(fenToYuan(-7)).toBe('-0.07')
  })
})

describe('formatYuan — 界面展示用（带千分位）', () => {
  it('四位数及以上加千分位', () => {
    expect(formatYuan(123456)).toBe('1,234.56')
    expect(formatYuan(100000000)).toBe('1,000,000.00')
  })

  it('不足一千不加分隔符', () => {
    expect(formatYuan(99999)).toBe('999.99')
    expect(formatYuan(100000)).toBe('1,000.00')
  })

  it('零', () => {
    expect(formatYuan(0)).toBe('0.00')
  })

  it('负数带千分位，负号在最前', () => {
    expect(formatYuan(-123456)).toBe('-1,234.56')
  })
})
