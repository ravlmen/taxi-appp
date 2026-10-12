import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAllowedAppOrigin } from './appOrigin.mjs'

test('allows a phone on the private network during development with localhost configured', () => {
  assert.equal(
    isAllowedAppOrigin('http://192.168.1.25:5173', 'http://localhost:5173', false),
    true,
  )
})

test('production only allows the configured app origin', () => {
  assert.equal(isAllowedAppOrigin('https://taxi.example', 'https://taxi.example', true), true)
  assert.equal(isAllowedAppOrigin('http://192.168.1.25:5173', 'https://taxi.example', true), false)
  assert.equal(isAllowedAppOrigin('https://taxi.example', undefined, true), false)
})

test('development does not allow origins outside localhost or the private network', () => {
  assert.equal(isAllowedAppOrigin('https://attacker.example', 'http://localhost:5173', false), false)
  assert.equal(isAllowedAppOrigin('http://8.8.8.8:5173', undefined, false), false)
})
