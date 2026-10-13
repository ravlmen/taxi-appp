import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import { test } from 'node:test'
import { createDriverStore } from './driverStore.mjs'
import { createRideStore } from './rideStore.mjs'

test('employee accounts persist without exposing their credential hashes', () => {
  const store = createDriverStore()
  const passwordSalt = randomBytes(16).toString('hex')
  const passwordHash = scryptSync('bezpecny-kod-123', passwordSalt, 64).toString('hex')
  const employee = {
    id: 'employee-test',
    name: 'Jan Novák',
    usernameKey: 'jan novák',
    passwordSalt,
    passwordHash,
    createdAt: new Date().toISOString(),
  }

  assert.deepEqual(store.createEmployee(employee), {
    id: 'employee-test',
    name: 'Jan Novák',
    username: 'jan novák',
  })
  assert.deepEqual(store.listEmployees(), [{
    id: 'employee-test',
    name: 'Jan Novák',
    plate: null,
    carName: null,
    username: 'jan novák',
  }])
  assert.deepEqual(store.findEmployeeByUsername('jan novák'), {
    id: 'employee-test',
    name: 'Jan Novák',
    phone: null,
    plate: null,
    carName: null,
    username: 'jan novák',
    passwordSalt,
    passwordHash,
  })
})

test('duplicate normalized employee login names are rejected', () => {
  const store = createDriverStore()
  const passwordSalt = randomBytes(16).toString('hex')
  const employee = {
    id: 'employee-first',
    name: 'Jan Novák',
    usernameKey: 'jan novák',
    passwordSalt,
    passwordHash: scryptSync('bezpecny-kod-123', passwordSalt, 64).toString('hex'),
    createdAt: new Date().toISOString(),
  }

  store.createEmployee(employee)
  assert.throws(() => store.createEmployee({
    ...employee,
    id: 'employee-second',
  }), /UNIQUE constraint failed/)
})

test('a created employee can see and accept rides as an independent driver', () => {
  const employees = createDriverStore()
  const rides = createRideStore()
  const passwordSalt = randomBytes(16)
  const employee = {
    id: 'employee-driver-test',
    name: 'Řidič Test',
    usernameKey: 'řidič test',
    passwordSalt: passwordSalt.toString('hex'),
    passwordHash: scryptSync('bezpecny-kod-123', passwordSalt, 64).toString('hex'),
    createdAt: new Date().toISOString(),
  }

  try {
    employees.createEmployee(employee)
    rides.createCashRide({
      id: 'employee-ride-test',
      pickup: 'Praha',
      destination: 'Brno',
      customerName: 'Testovací zákazník',
      customerPhone: '+420777111222',
      amountCzk: 500,
      distanceMeters: 12000,
      createdAt: new Date().toISOString(),
    })

    assert.equal(rides.listAvailableRides(employee.id).length, 1)
    assert.equal(rides.acceptRide('employee-ride-test', employee.id).driverId, employee.id)
    assert.equal(rides.listDriverRides(employee.id).length, 1)
    assert.equal(rides.listAvailableRides('another-driver').length, 0)
  } finally {
    employees.close()
    rides.close()
  }
})
