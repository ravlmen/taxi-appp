import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRideStore } from './rideStore.mjs'

function makeRide(overrides = {}) {
  return {
    id: 'ride-1',
    pickup: 'Praha',
    destination: 'Brno',
    note: 'Prosím zavolejte po příjezdu.',
    routeGeometry: { type: 'LineString', coordinates: [[14.4, 50.1], [14.5, 50.2]] },
    customerName: 'Jana Nová',
    customerPhone: '+420 777 111 222',
    amountCzk: 500,
    distanceMeters: 120000,
    createdAt: '2026-10-09T12:00:00.000Z',
    ...overrides,
  }
}

test('driver offers an arrival time and the customer confirms or declines it', () => {
  const store = createRideStore()
  try {
    store.createCashRide(makeRide())
    assert.equal(store.offerRide('ride-1', 'driver-1', 7).offerEtaMinutes, 7)
    assert.equal(store.offerRide('ride-1', 'driver-2', 5), null)
    assert.equal(store.listAvailableRides('driver-2').length, 0)
    assert.equal(store.declineOffer('ride-1'), true)
    assert.equal(store.getRide('ride-1').status, 'pending')
    assert.equal(store.listAvailableRides('driver-1').length, 0)
    assert.equal(store.offerRide('ride-1', 'driver-1', 3), null)
    assert.equal(store.listAvailableRides('driver-2').length, 1)
    store.offerRide('ride-1', 'driver-2', 4)
    const accepted = store.confirmOffer('ride-1')
    assert.equal(accepted.status, 'accepted')
    assert.equal(accepted.driverId, 'driver-2')
    assert.equal(store.confirmOffer('ride-1'), null)
  } finally {
    store.close()
  }
})

test('out-of-zone pickup fee is added only after the customer confirms the offer', () => {
  const store = createRideStore()
  try {
    store.createCashRide(makeRide())
    const offered = store.offerRide('ride-1', 'driver-1', 7, { amountCzk: 180, originalAmountCzk: 200 })
    assert.equal(offered.offerPickupFeeCzk, 180)
    assert.equal(offered.offerPickupFeeOriginalCzk, 200)
    assert.equal(offered.amountCzk, 500)
    assert.equal(store.declineOffer('ride-1'), true)
    const declined = store.getRide('ride-1')
    assert.equal(declined.offerPickupFeeCzk, null)
    assert.equal(declined.amountCzk, 500)
    store.offerRide('ride-1', 'driver-2', 5, { amountCzk: 150, originalAmountCzk: 150 })
    const accepted = store.confirmOffer('ride-1')
    assert.equal(accepted.amountCzk, 650)
    assert.equal(accepted.pickupFeeCzk, 150)
    assert.equal(accepted.pickupFeeOriginalCzk, 150)
  } finally {
    store.close()
  }
})

test('in-zone offer keeps the original ride price', () => {
  const store = createRideStore()
  try {
    store.createCashRide(makeRide())
    store.offerRide('ride-1', 'driver-1', 7)
    const accepted = store.confirmOffer('ride-1')
    assert.equal(accepted.amountCzk, 500)
    assert.equal(accepted.pickupFeeCzk, 0)
  } finally {
    store.close()
  }
})

test('persists a cash ride for both driver accounts to see', () => {
  const store = createRideStore()
  try {
    const ride = store.createCashRide(makeRide())
    assert.equal(ride.status, 'pending')
    assert.equal(ride.paymentMethod, 'cash')
    const availableRide = store.listAvailableRides('driver-1')[0]
    assert.deepEqual(JSON.parse(availableRide.routeGeometry), makeRide().routeGeometry)
    assert.equal(availableRide.note, 'Prosím zavolejte po příjezdu.')
    assert.equal(availableRide.customerName, undefined)
    assert.equal(availableRide.customerPhone, '+420 777 111 222')
    const secondDriverRide = store.listAvailableRides('driver-2')[0]
    assert.equal(secondDriverRide.customerPhone, '+420 777 111 222')
    const assignedRide = store.acceptRide('ride-1', 'driver-1')
    assert.equal(assignedRide.customerPhone, '+420 777 111 222')
    assert.equal(assignedRide.note, 'Prosím zavolejte po příjezdu.')
    assert.equal(store.listDriverRides('driver-1')[0].note, 'Prosím zavolejte po příjezdu.')
  } finally {
    store.close()
  }
})

test('uses an empty note for rides created without an optional note', () => {
  const store = createRideStore()
  try {
    const ride = store.createCashRide(makeRide({ note: undefined }))
    assert.equal(ride.note, '')
  } finally {
    store.close()
  }
})

test('adds the optional note column to an existing ride database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'taxi-ride-store-'))
  const databasePath = join(directory, 'rides.sqlite')
  const legacyDatabase = new Database(databasePath)
  legacyDatabase.exec(`
    CREATE TABLE rides (
      id TEXT PRIMARY KEY,
      payment_session_id TEXT UNIQUE,
      pickup TEXT NOT NULL,
      destination TEXT NOT NULL,
      route_geometry TEXT,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      amount_czk INTEGER NOT NULL,
      distance_meters REAL,
      payment_method TEXT NOT NULL,
      status TEXT NOT NULL,
      driver_id TEXT,
      created_at TEXT NOT NULL,
      accepted_at TEXT,
      completed_at TEXT
    );
    INSERT INTO rides (
      id, pickup, destination, customer_name, customer_phone, amount_czk,
      payment_method, status, created_at
    ) VALUES ('legacy-ride', 'Praha', 'Brno', 'Jana', '+420777111222', 500, 'cash', 'pending', '2026-10-09');
  `)
  legacyDatabase.close()

  try {
    const store = createRideStore(databasePath)
    try {
      assert.equal(store.getRide('legacy-ride').note, '')
      const ride = store.createCashRide(makeRide({ id: 'new-ride', note: 'Vchod zezadu.' }))
      assert.equal(ride.note, 'Vchod zezadu.')
    } finally {
      store.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('assigns a ride to the first driver who accepts it', () => {
  const store = createRideStore()
  try {
    store.createCashRide(makeRide())
    assert.equal(store.acceptRide('ride-1', 'driver-1').driverId, 'driver-1')
    assert.equal(store.acceptRide('ride-1', 'driver-2'), null)
    assert.equal(store.listAvailableRides('driver-2').length, 0)
  } finally {
    store.close()
  }
})

test('rejection hides an unclaimed ride only from that driver', () => {
  const store = createRideStore()
  try {
    store.createCashRide(makeRide())
    assert.equal(store.rejectRide('ride-1', 'driver-1'), true)
    assert.equal(store.listAvailableRides('driver-1').length, 0)
    assert.equal(store.listAvailableRides('driver-2').length, 1)
  } finally {
    store.close()
  }
})

test('a ride is rejected for the customer only after all drivers skip it', () => {
  const store = createRideStore()
  try {
    store.createCashRide(makeRide())
    assert.equal(store.allDriversRejected('ride-1', ['driver-1', 'driver-2']), false)
    store.rejectRide('ride-1', 'driver-1')
    assert.equal(store.allDriversRejected('ride-1', ['driver-1', 'driver-2']), false)
    store.rejectRide('ride-1', 'driver-2')
    assert.equal(store.allDriversRejected('ride-1', ['driver-1', 'driver-2']), true)
  } finally {
    store.close()
  }
})

test('driver status transitions require ownership and valid order', () => {
  const store = createRideStore()
  try {
    store.createCashRide(makeRide())
    store.acceptRide('ride-1', 'driver-1')
    assert.equal(store.updateRideStatus('ride-1', 'driver-2', 'to_pickup'), null)
    assert.equal(store.updateRideStatus('ride-1', 'driver-1', 'with_customer'), null)
    assert.equal(store.updateRideStatus('ride-1', 'driver-1', 'to_pickup').status, 'to_pickup')
    assert.equal(store.updateRideStatus('ride-1', 'driver-1', 'with_customer').status, 'with_customer')
    assert.equal(store.countCompletedRides(), 0)
    assert.equal(store.updateRideStatus('ride-1', 'driver-1', 'completed').status, 'completed')
    assert.equal(store.countCompletedRides(), 1)
  } finally {
    store.close()
  }
})

test('completed ride count includes all drivers and persists with the ride database', () => {
  const store = createRideStore()
  try {
    store.createCashRide(makeRide({ id: 'ride-1' }))
    store.createCashRide(makeRide({ id: 'ride-2' }))
    store.acceptRide('ride-1', 'driver-1')
    store.updateRideStatus('ride-1', 'driver-1', 'to_pickup')
    store.updateRideStatus('ride-1', 'driver-1', 'with_customer')
    store.updateRideStatus('ride-1', 'driver-1', 'completed')
    store.acceptRide('ride-2', 'driver-2')
    assert.equal(store.countCompletedRides(), 1)
  } finally {
    store.close()
  }
})

test('last-30-day owner stats count and sum only recently completed rides', () => {
  const directory = mkdtempSync(join(tmpdir(), 'taxi-ride-stats-'))
  const databasePath = join(directory, 'rides.sqlite')
  const store = createRideStore(databasePath)
  try {
    for (const [id, amountCzk] of [['old-completed', 700], ['recent-completed', 1300], ['still-active', 9000]]) {
      store.createCashRide(makeRide({ id, amountCzk }))
    }
    for (const id of ['old-completed', 'recent-completed']) {
      store.acceptRide(id, 'driver-1')
      store.updateRideStatus(id, 'driver-1', 'to_pickup')
      store.updateRideStatus(id, 'driver-1', 'with_customer')
      store.updateRideStatus(id, 'driver-1', 'completed')
    }
    store.acceptRide('still-active', 'driver-2')

    const completionTimes = new Database(databasePath)
    completionTimes.prepare('UPDATE rides SET completed_at = ? WHERE id = ?').run(
      new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
      'old-completed',
    )
    completionTimes.prepare('UPDATE rides SET completed_at = ? WHERE id = ?').run(
      new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      'recent-completed',
    )
    completionTimes.close()

    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    assert.deepEqual(store.getCompletedRideStatsSince(cutoff), { completedRides: 1, revenueCzk: 1300 })
    assert.equal(store.countCompletedRides(), 2)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('card ride is paid only after the customer confirms the offer', () => {
  const store = createRideStore()
  try {
    const ride = store.createCardRide(makeRide({ id: 'ride-card-1', note: 'Vchod je ze dvora.' }))
    assert.equal(ride.paymentMethod, 'card')
    assert.equal(ride.paidAt, null)
    assert.equal(store.listAvailableRides('driver-1')[0].note, 'Vchod je ze dvora.')
    assert.equal(store.markRidePaid('ride-card-1', 'cs_test_early', 500).newlyPaid, false)
    store.offerRide('ride-card-1', 'driver-1', 6, { amountCzk: 100, originalAmountCzk: 100 })
    store.confirmOffer('ride-card-1')
    assert.equal(store.markRidePaid('ride-card-1', 'cs_test_wrong', 500).newlyPaid, false)
    const paid = store.markRidePaid('ride-card-1', 'cs_test_example', 600)
    assert.equal(paid.newlyPaid, true)
    assert.equal(paid.paymentSessionId, 'cs_test_example')
    assert.ok(paid.paidAt)
    assert.equal(store.markRidePaid('ride-card-1', 'cs_test_example', 600).newlyPaid, false)
  } finally {
    store.close()
  }
})
