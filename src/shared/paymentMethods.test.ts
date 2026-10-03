import { test, expect } from 'vitest'
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  paymentMethodLabel,
  isPaymentMethod
} from './paymentMethods'

test('一共五个支付方式，顺序固定', () => {
  expect(PAYMENT_METHODS).toEqual(['wechat', 'alipay', 'bank', 'cash', 'other'])
})

test('每个都有中文名，且没有空字符串', () => {
  for (const m of PAYMENT_METHODS) {
    expect(PAYMENT_METHOD_LABELS[m]).toBeTruthy()
    expect(PAYMENT_METHOD_LABELS[m].trim()).not.toBe('')
  }
})

test('中文名符合用户确认的清单', () => {
  expect(paymentMethodLabel('wechat')).toBe('微信')
  expect(paymentMethodLabel('alipay')).toBe('支付宝')
  expect(paymentMethodLabel('bank')).toBe('银行卡')
  expect(paymentMethodLabel('cash')).toBe('现金')
  expect(paymentMethodLabel('other')).toBe('其他')
})

test('isPaymentMethod 认得合法值', () => {
  expect(isPaymentMethod('wechat')).toBe(true)
  expect(isPaymentMethod('cash')).toBe(true)
})

test('isPaymentMethod 拒绝非法值（不能把乱码当支付方式存进库）', () => {
  expect(isPaymentMethod('微信')).toBe(false)
  expect(isPaymentMethod('')).toBe(false)
  expect(isPaymentMethod('WECHAT')).toBe(false)
  expect(isPaymentMethod('credit')).toBe(false)
})

test('中文名互不重复（否则用户看到两个一样的按钮）', () => {
  const labels = PAYMENT_METHODS.map((m) => PAYMENT_METHOD_LABELS[m])
  expect(new Set(labels).size).toBe(labels.length)
})
