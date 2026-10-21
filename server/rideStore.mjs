import Database from 'better-sqlite3'

const rideStatuses = new Set(['pending', 'accepted', 'to_pickup', 'with_customer', 'completed', 'cancelled'])

export function createRideStore(databasePath = ':memory:') {
  const database = new Database(databasePath)
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  database.exec(`
    CREATE TABLE IF NOT EXISTS rides (
      id TEXT PRIMARY KEY,
      payment_session_id TEXT UNIQUE,
      pickup TEXT NOT NULL,
      destination TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      route_geometry TEXT,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      amount_czk INTEGER NOT NULL CHECK (amount_czk >= 0),
      distance_meters REAL,
      payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'card')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'to_pickup', 'with_customer', 'completed', 'cancelled')),
      driver_id TEXT,
      created_at TEXT NOT NULL,
      accepted_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS rides_status_created_idx ON rides(status, created_at);
    CREATE INDEX IF NOT EXISTS rides_driver_created_idx ON rides(driver_id, created_at);
    CREATE TABLE IF NOT EXISTS ride_rejections (
      ride_id TEXT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
      driver_id TEXT NOT NULL,
      rejected_at TEXT NOT NULL,
      PRIMARY KEY (ride_id, driver_id)
    );
  `)

  const rideColumns = new Set(database.pragma('table_info(rides)').map(({ name }) => name))
  if (!rideColumns.has('customer_name')) {
    database.exec("ALTER TABLE rides ADD COLUMN customer_name TEXT NOT NULL DEFAULT ''")
  }
  if (!rideColumns.has('customer_phone')) {
    database.exec("ALTER TABLE rides ADD COLUMN customer_phone TEXT NOT NULL DEFAULT ''")
  }
  if (!rideColumns.has('route_geometry')) {
    database.exec('ALTER TABLE rides ADD COLUMN route_geometry TEXT')
  }
  if (!rideColumns.has('note')) {
    database.exec("ALTER TABLE rides ADD COLUMN note TEXT NOT NULL DEFAULT ''")
  }
  if (!rideColumns.has('offer_driver_id')) {
    database.exec('ALTER TABLE rides ADD COLUMN offer_driver_id TEXT')
    database.exec('ALTER TABLE rides ADD COLUMN offer_eta_minutes INTEGER')
    database.exec('ALTER TABLE rides ADD COLUMN offer_at TEXT')
  }
  if (!rideColumns.has('offer_pickup_fee_czk')) {
    database.exec('ALTER TABLE rides ADD COLUMN offer_pickup_fee_czk INTEGER')
    database.exec('ALTER TABLE rides ADD COLUMN offer_pickup_fee_original_czk INTEGER')
    database.exec('ALTER TABLE rides ADD COLUMN pickup_fee_czk INTEGER NOT NULL DEFAULT 0')
    database.exec('ALTER TABLE rides ADD COLUMN pickup_fee_original_czk INTEGER NOT NULL DEFAULT 0')
  }

  if (!rideColumns.has('paid_at')) {
    database.exec('ALTER TABLE rides ADD COLUMN paid_at TEXT')
    database.exec("UPDATE rides SET paid_at = created_at WHERE payment_method = 'card' AND payment_session_id IS NOT NULL")
  }

  const OFFER_TTL_MS = 3 * 60 * 1000
  database.exec('DROP TABLE IF EXISTS customer_discounts')
  const expireOffers = () => {
    database.prepare(`
      UPDATE rides SET offer_driver_id = NULL, offer_eta_minutes = NULL, offer_at = NULL,
        offer_pickup_fee_czk = NULL, offer_pickup_fee_original_czk = NULL
      WHERE status = 'pending' AND offer_driver_id IS NOT NULL AND offer_at < ?
    `).run(new Date(Date.now() - OFFER_TTL_MS).toISOString())
  }

  const getRideRow = database.prepare(`
    SELECT
      id, payment_session_id AS paymentSessionId, pickup, destination, note,
      route_geometry AS routeGeometry,
      customer_name AS customerName, customer_phone AS customerPhone,
      amount_czk AS amountCzk, distance_meters AS distanceMeters,
      payment_method AS paymentMethod, status, driver_id AS driverId,
      offer_driver_id AS offerDriverId, offer_eta_minutes AS offerEtaMinutes,
      offer_pickup_fee_czk AS offerPickupFeeCzk, offer_pickup_fee_original_czk AS offerPickupFeeOriginalCzk,
      pickup_fee_czk AS pickupFeeCzk, pickup_fee_original_czk AS pickupFeeOriginalCzk,
      paid_at AS paidAt,
      created_at AS createdAt, accepted_at AS acceptedAt, completed_at AS completedAt
    FROM rides WHERE id = ?
  `)
  const getRide = { get: (id) => { expireOffers(); return getRideRow.get(id) } }

  const insertRide = database.prepare(`
    INSERT INTO rides (
      id, payment_session_id, pickup, destination, note, route_geometry, amount_czk, distance_meters,
      customer_name, customer_phone, payment_method, status, created_at
    ) VALUES (
      @id, @paymentSessionId, @pickup, @destination, @note, @routeGeometry, @amountCzk, @distanceMeters,
      @customerName, @customerPhone,
      @paymentMethod, @status, @createdAt
    )
  `)

  const createRide = database.transaction((ride) => {
    insertRide.run({
      ...ride,
      note: ride.note ?? '',
      routeGeometry: ride.routeGeometry ? JSON.stringify(ride.routeGeometry) : null,
    })
    return getRide.get(ride.id)
  })

  return {
    createCashRide(ride) {
      return createRide({ ...ride, paymentSessionId: null, paymentMethod: 'cash', status: 'pending' })
    },

    createCardRide(ride) {
      return createRide({ ...ride, paymentSessionId: null, paymentMethod: 'card', status: 'pending' })
    },

    markRidePaid(id, paymentSessionId, amountCzk) {
      const result = database.prepare(`
        UPDATE rides SET paid_at = ?, payment_session_id = ?
        WHERE id = ? AND payment_method = 'card' AND paid_at IS NULL AND amount_czk = ?
          AND status IN ('accepted', 'to_pickup', 'with_customer', 'completed')
      `).run(new Date().toISOString(), paymentSessionId, id, amountCzk)
      const ride = getRide.get(id)
      return ride ? { ...ride, newlyPaid: result.changes === 1 } : null
    },

    getRide(id) {
      return getRide.get(id)
    },

    allDriversRejected(id, driverIds) {
      if (driverIds.length === 0) return false
      const placeholders = driverIds.map(() => '?').join(', ')
      const result = database.prepare(`
        SELECT COUNT(DISTINCT driver_id) AS count
        FROM ride_rejections
        WHERE ride_id = ? AND driver_id IN (${placeholders})
      `).get(id, ...driverIds)
      return result.count === driverIds.length
    },

    countCompletedRides() {
      return database.prepare("SELECT COUNT(*) AS count FROM rides WHERE status = 'completed'").get().count
    },

    getCompletedRideStatsSince(cutoff) {
      return database.prepare(`
        SELECT COUNT(*) AS completedRides, COALESCE(SUM(amount_czk), 0) AS revenueCzk
        FROM rides
        WHERE status = 'completed' AND completed_at >= ?
      `).get(cutoff)
    },

    countCompletedRidesForCustomerSince(phone, sinceIso) {
      return database.prepare(`
        SELECT COUNT(*) AS count FROM rides
        WHERE customer_phone = ? AND status = 'completed' AND completed_at >= ?
      `).get(phone, sinceIso).count
    },

    listCustomerOverview() {
      return database.prepare(`
        SELECT
          customer_phone AS phone,
          (SELECT r2.customer_name FROM rides r2 WHERE r2.customer_phone = rides.customer_phone
            ORDER BY r2.created_at DESC LIMIT 1) AS name,
          COUNT(*) AS totalRides,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedRides,
          SUM(CASE WHEN status = 'completed' THEN amount_czk ELSE 0 END) AS spentCzk,
          SUM(CASE WHEN status = 'completed' THEN COALESCE(distance_meters, 0) ELSE 0 END) AS distanceMeters,
          MAX(created_at) AS lastRideAt
        FROM rides
        WHERE customer_phone <> ''
        GROUP BY customer_phone
        ORDER BY lastRideAt DESC
        LIMIT 1000
      `).all()
    },

    listCompletedRidesBetween(from, to) {
      return database.prepare(`
        SELECT
          id, pickup, destination, amount_czk AS amountCzk, distance_meters AS distanceMeters,
          payment_method AS paymentMethod, customer_name AS customerName,
          driver_id AS driverId, created_at AS createdAt, completed_at AS completedAt
        FROM rides
        WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?
        ORDER BY completed_at DESC
        LIMIT 5000
      `).all(from, to)
    },

    getCompletedRideStatsByDriverSince(cutoff) {
      return database.prepare(`
        SELECT driver_id AS driverId, COUNT(*) AS completedRides, COALESCE(SUM(amount_czk), 0) AS revenueCzk,
          COALESCE(SUM(distance_meters), 0) AS distanceMeters
        FROM rides
        WHERE status = 'completed' AND completed_at >= ? AND driver_id IS NOT NULL
        GROUP BY driver_id
      `).all(cutoff)
    },

    listAvailableRides(driverId) {
      expireOffers()
      return database.prepare(`
        SELECT
          id, pickup, destination, amount_czk AS amountCzk,
          note, route_geometry AS routeGeometry,
          customer_phone AS customerPhone,
          distance_meters AS distanceMeters, payment_method AS paymentMethod,
          status, created_at AS createdAt
        FROM rides
        WHERE status = 'pending'
          AND offer_driver_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ride_rejections
            WHERE ride_rejections.ride_id = rides.id
              AND ride_rejections.driver_id = ?
          )
        ORDER BY created_at ASC
      `).all(driverId)
    },

    listDriverRides(driverId) {
      return database.prepare(`
        SELECT
          id, pickup, destination, amount_czk AS amountCzk,
          note, route_geometry AS routeGeometry,
          customer_name AS customerName, customer_phone AS customerPhone,
          distance_meters AS distanceMeters, payment_method AS paymentMethod,
          pickup_fee_czk AS pickupFeeCzk, pickup_fee_original_czk AS pickupFeeOriginalCzk,
          paid_at AS paidAt,
          status, created_at AS createdAt, accepted_at AS acceptedAt,
          completed_at AS completedAt
        FROM rides
        WHERE driver_id = ?
        ORDER BY created_at DESC
        LIMIT 100
      `).all(driverId)
    },

    offerRide(id, driverId, etaMinutes, pickupFee = null) {
      expireOffers()
      const result = database.prepare(`
        UPDATE rides SET offer_driver_id = ?, offer_eta_minutes = ?, offer_at = ?,
          offer_pickup_fee_czk = ?, offer_pickup_fee_original_czk = ?
        WHERE id = ? AND status = 'pending' AND driver_id IS NULL AND offer_driver_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM ride_rejections WHERE ride_id = rides.id AND driver_id = ?)
      `).run(
        driverId,
        etaMinutes,
        new Date().toISOString(),
        pickupFee?.amountCzk ?? null,
        pickupFee?.originalAmountCzk ?? null,
        id,
        driverId,
      )
      return result.changes === 1 ? getRide.get(id) : null
    },

    confirmOffer(id) {
      expireOffers()
      const result = database.prepare(`
        UPDATE rides SET status = 'accepted', driver_id = offer_driver_id, accepted_at = ?,
          amount_czk = amount_czk + COALESCE(offer_pickup_fee_czk, 0),
          pickup_fee_czk = COALESCE(offer_pickup_fee_czk, 0),
          pickup_fee_original_czk = COALESCE(offer_pickup_fee_original_czk, 0)
        WHERE id = ? AND status = 'pending' AND driver_id IS NULL AND offer_driver_id IS NOT NULL
      `).run(new Date().toISOString(), id)
      return result.changes === 1 ? getRide.get(id) : null
    },

    declineOffer(id) {
      expireOffers()
      const ride = getRide.get(id)
      if (!ride || ride.status !== 'pending' || !ride.offerDriverId) return false
      database.transaction(() => {
        database.prepare(`
          INSERT OR IGNORE INTO ride_rejections (ride_id, driver_id, rejected_at) VALUES (?, ?, ?)
        `).run(id, ride.offerDriverId, new Date().toISOString())
        database.prepare(`
          UPDATE rides SET offer_driver_id = NULL, offer_eta_minutes = NULL, offer_at = NULL,
            offer_pickup_fee_czk = NULL, offer_pickup_fee_original_czk = NULL
          WHERE id = ?
        `).run(id)
      })()
      return true
    },

    acceptRide(id, driverId) {
      const result = database.prepare(`
        UPDATE rides SET
          status = 'accepted', driver_id = ?, accepted_at = ?
        WHERE id = ? AND status = 'pending' AND driver_id IS NULL
      `).run(driverId, new Date().toISOString(), id)
      return result.changes === 1 ? getRide.get(id) : null
    },

    rejectRide(id, driverId) {
      const ride = database.prepare("SELECT id FROM rides WHERE id = ? AND status = 'pending'").get(id)
      if (!ride) return false
      database.prepare(`
        INSERT OR IGNORE INTO ride_rejections (ride_id, driver_id, rejected_at)
        VALUES (?, ?, ?)
      `).run(id, driverId, new Date().toISOString())
      return true
    },

    updateRideStatus(id, driverId, nextStatus) {
      if (!rideStatuses.has(nextStatus)) return null
      const transitions = {
        to_pickup: ['accepted'],
        with_customer: ['to_pickup'],
        completed: ['with_customer'],
      }
      const allowedPrevious = transitions[nextStatus]
      if (!allowedPrevious) return null
      const placeholders = allowedPrevious.map(() => '?').join(', ')
      const completedAt = nextStatus === 'completed' ? new Date().toISOString() : null
      const result = database.prepare(`
        UPDATE rides SET status = ?, completed_at = COALESCE(?, completed_at)
        WHERE id = ? AND driver_id = ? AND status IN (${placeholders})
      `).run(nextStatus, completedAt, id, driverId, ...allowedPrevious)
      return result.changes === 1 ? getRide.get(id) : null
    },

    close() {
      database.close()
    },
  }
}
