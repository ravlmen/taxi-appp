import test from 'node:test'
import assert from 'node:assert/strict'
import { formatE164, isValidPhone, normalizePhone } from './phone.mjs'

test('normalizes Czech local and international phone numbers', () => {
  for (const input of ['777 123 456', '+420 777 123 456', '00420 777 123 456']) {
    const normalized = normalizePhone(input)
    assert.equal(normalized, input === '777 123 456' ? '777123456' : '420777123456')
    assert.equal(isValidPhone(normalized), true)
  }
  assert.equal(formatE164('777 123 456'), '+420777123456')
  assert.equal(formatE164('+1 (202) 555-0123'), '+12025550123')
})

test('rejects malformed, too short, and overlong phone numbers', () => {
  for (const input of ['1234567', '000000000', '+420abc777123456', '+1234567890123456']) {
    assert.equal(isValidPhone(normalizePhone(input)), false, input)
  }
  assert.equal(normalizePhone('abc +420 777 123 456'), '')
  assert.equal(isValidPhone(''), false)
})
