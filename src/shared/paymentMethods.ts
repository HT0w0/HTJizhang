/**
 * 支付方式。
 *
 * id 是存进数据库的值，纯 ASCII 且**一经发布不可更改**——
 * 改界面文字、加新方式都不能动老 id，否则历史账单会对不上。
 * 中文名是对外的显示，可以改。
 */
export type PaymentMethod = 'wechat' | 'alipay' | 'bank' | 'cash' | 'other'

/** 界面上的显示顺序：按日常使用频率排，最常用的在最前。 */
export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  'wechat',
  'alipay',
  'bank',
  'cash',
  'other'
]

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  wechat: '微信',
  alipay: '支付宝',
  bank: '银行卡',
  cash: '现金',
  other: '其他'
}

export function paymentMethodLabel(id: PaymentMethod): string {
  return PAYMENT_METHOD_LABELS[id]
}

/** 校验一个字符串是不是合法的支付方式 id。 */
export function isPaymentMethod(value: string): value is PaymentMethod {
  return (PAYMENT_METHODS as readonly string[]).includes(value)
}
