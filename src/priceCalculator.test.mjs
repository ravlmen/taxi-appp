import test from 'node:test'
import assert from 'node:assert/strict'

import { calculateRidePrice } from './priceCalculator.mjs'

test('calculates the fare using the 80 CZK boarding fee and 32 CZK per kilometre', () => {
  assert.equal(calculateRidePrice(10), 400)
  assert.equal(calculateRidePrice(0), 80)
  assert.equal(calculateRidePrice(1), 112)
  assert.equal(calculateRidePrice(2), 144)
  assert.equal(calculateRidePrice(15.8), 586)
})

test('rejects invalid route distances', () => {
  assert.throws(() => calculateRidePrice(-1), RangeError)
  assert.throws(() => calculateRidePrice(Number.NaN), RangeError)
})
