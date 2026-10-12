export function normalizePhone(phone) {
  if (typeof phone !== 'string') return ''

  const compact = phone.trim().replace(/[\s().-]/g, '')
  if (/^00\d+$/.test(compact)) return compact.slice(2)
  if (/^\+\d+$/.test(compact)) return compact.slice(1)
  if (/^\d+$/.test(compact)) return compact
  return ''
}

export function isValidPhone(phone) {
  return typeof phone === 'string' && /^[1-9]\d{7,14}$/.test(phone)
}

export function formatE164(phone) {
  const digits = normalizePhone(phone)
  return `+${digits.length === 9 ? `420${digits}` : digits}`
}
