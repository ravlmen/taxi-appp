import express from 'express'
import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Stripe from 'stripe'
import webpush from 'web-push'
import { DEFAULT_PRICING, calculateRidePrice, parsePricing } from '../src/priceCalculator.mjs'
import { isAllowedAppOrigin as isAllowedOrigin } from './appOrigin.mjs'
import { createDriverStore } from './driverStore.mjs'
import { formatE164, isValidPhone, normalizePhone } from './phone.mjs'
import { createPushStore } from './pushStore.mjs'
import { createRideStore } from './rideStore.mjs'
import { createTwilioSmsSender, createTwilioVerifySender } from './sms.mjs'

const app = express()
const port = Number(process.env.PORT ?? 3000)
const configuredAppUrl = process.env.APP_BASE_URL ?? process.env.RENDER_EXTERNAL_URL
const mapyApiKey = process.env.MAPY_API_KEY?.trim()
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null
const smsSender = createTwilioSmsSender({
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  fromNumber: process.env.TWILIO_FROM_NUMBER,
})
const verifySender = createTwilioVerifySender({
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  verifyServiceSid: process.env.TWILIO_VERIFY_SERVICE_SID,
})
const czechBounds = { minLat: 48.5, maxLat: 51.1, minLon: 12, maxLon: 19 }
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const routeQuotes = new Map()
const quoteLifetimeMs = 10 * 60 * 1000
const databasePath = process.env.DATABASE_PATH ?? path.join(projectRoot, 'data', 'taxi-koblizek.sqlite')
mkdirSync(path.dirname(databasePath), { recursive: true })
const rideStore = createRideStore(databasePath)
const driverStore = createDriverStore(databasePath)
const pushStore = createPushStore(databasePath)
const vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY ?? driverStore.getSetting('vapid_public_key'),
  privateKey: process.env.VAPID_PRIVATE_KEY ?? driverStore.getSetting('vapid_private_key'),
}
if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  const generated = webpush.generateVAPIDKeys()
  vapidKeys.publicKey = generated.publicKey
  vapidKeys.privateKey = generated.privateKey
  driverStore.setSetting('vapid_public_key', generated.publicKey)
  driverStore.setSetting('vapid_private_key', generated.privateKey)
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? 'mailto:taxi@localhost.invalid', vapidKeys.publicKey, vapidKeys.privateKey)
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000
const driverSessions = new Map()
const customerSessions = new Map()
const loginAttempts = new Map()
const customerCodes = new Map()
const customerLoginAttempts = new Map()
const passwordSalt = randomBytes(32)
const isProduction = process.env.NODE_ENV === 'production'
const minimumPasswordLength = Math.max(4, Number.parseInt(process.env.DRIVER_MIN_PASSWORD_LENGTH ?? '', 10) || (isProduction ? 12 : 4))
const pajaCustomerUsername = process.env.PAJA_CUSTOMER_USERNAME ?? 'paja'
const pajaCustomerPassword = process.env.PAJA_CUSTOMER_PASSWORD
const pajaCustomerPhone = normalizePhone(process.env.PAJA_CUSTOMER_PHONE ?? '')
const pajaCustomerName = process.env.PAJA_CUSTOMER_NAME ?? 'Paja'
const configuredDrivers = [
  {
    id: 'driver-1',
    name: process.env.DRIVER_1_NAME ?? 'Řidič 1',
    phone: process.env.DRIVER_1_PHONE,
    username: process.env.DRIVER_1_USERNAME,
    password: process.env.DRIVER_1_PASSWORD,
  },
  {
    id: 'driver-2',
    name: process.env.DRIVER_2_NAME ?? 'Řidič 2',
    phone: process.env.DRIVER_2_PHONE,
    username: process.env.DRIVER_2_USERNAME,
    password: process.env.DRIVER_2_PASSWORD,
  },
  {
    id: 'driver-owner',
    name: process.env.DRIVER_3_NAME ?? 'Majitel',
    phone: process.env.DRIVER_3_PHONE,
    username: process.env.DRIVER_3_USERNAME || (isProduction ? undefined : 'majitel'),
    password: process.env.DRIVER_3_PASSWORD || (isProduction ? undefined : '1611'),
  },
]
const configuredDriverAccounts = configuredDrivers
  .filter(({ username, password }) => username && password?.length >= minimumPasswordLength)
  .map(({ id, name, username, password, phone }) => ({
    id,
    name,
    phone,
    username,
    passwordHash: scryptSync(password, passwordSalt, 64),
    passwordSalt,
  }))
const driverAccounts = [
  ...configuredDriverAccounts,
  ...driverStore.listAccounts().map((account) => ({
    ...account,
    passwordSalt: Buffer.from(account.passwordSalt, 'hex'),
    passwordHash: Buffer.from(account.passwordHash, 'hex'),
  })),
]
const areDriverUsernamesUnique = new Set(
  configuredDriverAccounts.map(({ username }) => username.toLocaleLowerCase('cs-CZ')),
).size === configuredDriverAccounts.length
const areDriverAccountsConfigured = configuredDriverAccounts.some(({ id }) => id === 'driver-owner')
  && areDriverUsernamesUnique
const pajaCustomerPasswordHash = pajaCustomerPassword
  ? scryptSync(pajaCustomerPassword, passwordSalt, 64)
  : null
const isPajaCustomerConfigured = Boolean(
  pajaCustomerPasswordHash && isValidPhone(pajaCustomerPhone) && isValidCustomerName(pajaCustomerName),
)
const passwordForUnknownUser = scryptSync(randomBytes(32), passwordSalt, 64)
const scrypt = (password, salt, keyLength) => new Promise((resolve, reject) => {
  scryptCallback(password, salt, keyLength, (error, derivedKey) => {
    if (error) reject(error)
    else resolve(derivedKey)
  })
})

async function notifyBySms(recipients, message, context) {
  const configuredRecipients = recipients
    .filter(Boolean)
    .map(formatE164)
  if (!smsSender.configured) {
    console.warn(`${context}: SMS nejsou odeslány, Twilio není nakonfigurované.`)
    return false
  }
  if (configuredRecipients.length === 0) {
    console.warn(`${context}: SMS nejsou odeslány, nejsou nastavená telefonní čísla příjemců.`)
    return false
  }

  const results = await Promise.allSettled(
    configuredRecipients.map((phone) => smsSender.send(phone, message)),
  )
  let allSent = true
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      allSent = false
      console.error(`${context}: SMS se nepodařilo odeslat příjemci ${configuredRecipients[index]}:`, result.reason)
    }
  }
  return allSent
}

async function sendPush(subscriptions, payload) {
  const body = JSON.stringify(payload)
  await Promise.allSettled(subscriptions.map(async (subscription) => {
    try {
      if (subscription.endpoint.startsWith('fcm:')) {
        const messaging = await getFirebaseMessaging()
        if (!messaging) return
        await messaging.send({
          token: subscription.endpoint.slice(4),
          notification: { title: payload.title, body: payload.body },
          data: { url: payload.url ?? '/' },
          android: { priority: 'high', notification: { tag: payload.tag, channelId: 'default' } },
        })
        return
      }
      await webpush.sendNotification(subscription, body, { TTL: 3600, urgency: 'high' })
    } catch (error) {
      const code = error?.statusCode ?? error?.code
      if (code === 404 || code === 410 || code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        pushStore.remove(subscription.endpoint)
      } else console.error('Push oznámení se nepodařilo odeslat:', error?.message ?? error)
    }
  }))
}

let firebaseMessagingPromise = null
function getFirebaseMessaging() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return Promise.resolve(null)
  firebaseMessagingPromise ??= (async () => {
    try {
      const { initializeApp, cert } = await import('firebase-admin/app')
      const { getMessaging } = await import('firebase-admin/messaging')
      const credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
      return getMessaging(initializeApp({ credential: cert(credentials) }))
    } catch (error) {
      console.error('Firebase pro push oznámení v aplikaci se nepodařilo spustit:', error?.message ?? error)
      return null
    }
  })()
  return firebaseMessagingPromise
}

const pushToDrivers = (payload) => sendPush(pushStore.list('driver'), payload)
const pushToDriver = (driverId, payload) => sendPush(pushStore.list('driver', driverId), payload)
const pushToCustomer = (phone, payload) => sendPush(pushStore.list('customer', normalizePhone(phone)), payload)

async function notifyDriversOfRide(ride) {
  void pushToDrivers({
    title: 'Nová objednávka – Taxi Koblížek',
    body: `${ride.pickup} → ${ride.destination}, ${ride.amountCzk} Kč`,
    tag: `ride-${ride.id}`,
    url: '/ridic',
  })
  const recipients = driverAccounts.map(({ phone }) => phone)
  const sent = await notifyBySms(
    recipients,
    `Taxi Koblížek: Nová jízda ${ride.pickup} → ${ride.destination}, ${ride.amountCzk} Kč. Otevřete aplikaci řidiče.`,
    `Upozornění řidičům k jízdě ${ride.id}`,
  )
  const missingPhoneCount = configuredDrivers.filter(({ phone }) => !phone).length
  if (missingPhoneCount > 0) {
    console.warn(`Upozornění řidičům k jízdě ${ride.id}: chybí telefonní čísla ${missingPhoneCount} řidičů.`)
    return 'Objednávka je uložená, ale nejsou nastavená telefonní čísla všech řidičů.'
  }
  return sent ? null : 'Objednávka je uložená, ale SMS upozornění řidičům se nepodařilo odeslat.'
}

function normalizePlate(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLocaleUpperCase('cs-CZ') : ''
}

function normalizeCarName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 40) || null : null
}

async function notifyCustomerRideStatus(ride, status, driverName = '', plate = '') {
  if (status !== 'accepted') {
    void pushToCustomer(ride.customerPhone, {
      title: 'Objednávku odmítli všichni řidiči',
      body: 'Zkuste prosím objednávku zadat znovu.',
      tag: `ride-${ride.id}`,
      url: '/',
    })
  }
  const message = status === 'accepted'
    ? `Taxi Koblížek: Vaši jízdu ${ride.pickup} → ${ride.destination} přijal${driverName ? ` ${driverName}` : ''}${plate ? `, SPZ ${plate}` : ''}. Řidič se vám brzy ozve.`
    : `Taxi Koblížek: Vaši jízdu ${ride.pickup} → ${ride.destination} odmítli všichni řidiči. Zadejte prosím novou objednávku.`
  const sent = await notifyBySms(
    [ride.customerPhone],
    message,
    `Upozornění zákazníkovi k jízdě ${ride.id}`,
  )
  return sent ? null : 'Změna stavu je uložená, ale zákaznickou SMS se nepodařilo odeslat.'
}

app.use(express.json({ limit: '10kb' }))

if (!areDriverAccountsConfigured) {
  console.warn(`Přihlášení řidičů není aktivní: nastavte majitelský účet a různá uživatelská jména s hesly dlouhými alespoň ${minimumPasswordLength} znaky.`)
}
if (isProduction && !smsSender.configured && !verifySender.configured) {
  console.warn('SMS nejsou aktivní: nastavte Twilio Verify (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID) nebo Messaging (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER).')
}

function isAllowedAppOrigin(request) {
  return isAllowedOrigin(request.get('origin'), configuredAppUrl, isProduction)
}

function isValidAddress(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200
}

function isValidCoordinate(coordinates) {
  return (
    Number.isFinite(coordinates?.lat)
    && Number.isFinite(coordinates?.lon)
    && coordinates.lat >= czechBounds.minLat
    && coordinates.lat <= czechBounds.maxLat
    && coordinates.lon >= czechBounds.minLon
    && coordinates.lon <= czechBounds.maxLon
  )
}

app.get('/api/places/suggest', async (request, response) => {
  const query = typeof request.query.query === 'string' ? request.query.query.trim() : ''
  if (query.length < 3 || query.length > 150) {
    response.status(400).json({ error: 'Dotaz musí obsahovat 3 až 150 znaků.' })
    return
  }
  if (!mapyApiKey) {
    response.status(503).json({ error: 'Vyhledávání přes Mapy.com není nakonfigurované. Provozovatel musí nastavit MAPY_API_KEY.' })
    return
  }

  const url = new URL('https://api.mapy.com/v1/suggest')
  url.searchParams.set('query', query)
  url.searchParams.set('lang', 'cs')
  url.searchParams.set('limit', '15')
  url.searchParams.set('locality', 'cz')
  url.searchParams.append('type', 'regional')
  url.searchParams.append('type', 'poi')

  let mapyResponse
  try {
    mapyResponse = await fetch(url, {
      headers: { 'X-Mapy-Api-Key': mapyApiKey },
      signal: AbortSignal.timeout(10000),
    })
  } catch (error) {
    console.error('Nepodařilo se spojit s API Mapy.com:', error)
    response.status(error instanceof DOMException && error.name === 'TimeoutError' ? 504 : 502)
      .json({ error: 'Mapy.com teď neodpovídají. Zkuste hledání za chvíli znovu.' })
    return
  }

  if (!mapyResponse.ok) {
    console.error(`API Mapy.com vrátilo stav ${mapyResponse.status}.`)
    const error = mapyResponse.status === 401 || mapyResponse.status === 403
      ? 'API klíč Mapy.com není platný nebo nemá oprávnění. Zkontrolujte MAPY_API_KEY.'
      : mapyResponse.status === 429
        ? 'Byl dosažen limit vyhledávání Mapy.com. Zkuste to prosím později.'
        : 'Vyhledávání přes Mapy.com teď není dostupné.'
    response.status(502).json({ error })
    return
  }

  let result
  try {
    result = await mapyResponse.json()
  } catch (error) {
    console.error('API Mapy.com vrátilo neplatný JSON:', error)
    response.status(502).json({ error: 'Mapy.com vrátily neplatnou odpověď.' })
    return
  }
  if (!result || !Array.isArray(result.items)) {
    console.error('API Mapy.com vrátilo neočekávaný formát výsledků.')
    response.status(502).json({ error: 'Mapy.com vrátily neplatné výsledky.' })
    return
  }
  response.json({ items: result.items })
})

function getDriverSession(request) {
  const cookie = request.get('cookie') ?? ''
  const token = cookie.match(/(?:^|;\s*)taxi_driver_session=([a-f\d]{64})(?:;|$)/i)?.[1]
  if (!token) return null
  const session = driverSessions.get(token)
  if (!session) return null
  if (session.expiresAt <= Date.now()) {
    driverSessions.delete(token)
    return null
  }
  return { ...session, token }
}

function getCookie(request, cookieName) {
  const escapedName = cookieName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return request.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${escapedName}=([a-f\\d]{64})(?:;|$)`, 'i'))?.[1]
}

function isValidCustomerName(name) {
  return typeof name === 'string' && name.trim().length >= 2 && name.length <= 100
}

function getCustomerSession(request) {
  const token = getCookie(request, 'taxi_customer_session')
  if (!token) return null
  const session = customerSessions.get(token)
  if (!session) return null
  if (session.expiresAt <= Date.now()) {
    customerSessions.delete(token)
    return null
  }
  return { ...session, token }
}

function requireDriver(request, response) {
  const session = getDriverSession(request)
  if (!session) {
    response.status(401).json({ error: 'Přihlášení vypršelo. Přihlaste se znovu.' })
    return null
  }
  return session
}

function requireCustomer(request, response) {
  const session = getCustomerSession(request)
  if (!session) {
    response.status(401).json({ error: 'Přihlaste se prosím svým telefonním číslem.' })
    return null
  }
  return session
}

function setDriverSessionCookie(response, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  response.setHeader(
    'Set-Cookie',
    `taxi_driver_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetimeMs / 1000}${secure}`,
  )
}

function setSessionCookie(response, name, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  response.setHeader(
    'Set-Cookie',
    `${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetimeMs / 1000}${secure}`,
  )
}

function getQuote(requestBody) {
  const { quoteId, pickup, destination } = requestBody ?? {}
  if (typeof quoteId !== 'string' || !isValidAddress(pickup) || !isValidAddress(destination)) return null
  const quote = routeQuotes.get(quoteId)
  if (!quote || quote.expiresAt <= Date.now() || quote.pickup !== pickup || quote.destination !== destination) {
    if (quote?.expiresAt <= Date.now()) routeQuotes.delete(quoteId)
    return null
  }
  return { quoteId, quote }
}

function formatApiRide(ride) {
  return {
    id: ride.id,
    pickup: ride.pickup,
    destination: ride.destination,
    note: ride.note,
    routeGeometry: ride.routeGeometry ? JSON.parse(ride.routeGeometry) : null,
    customerName: ride.customerName,
    customerPhone: ride.customerPhone,
    amountCzk: ride.amountCzk,
    pickupFeeCzk: ride.pickupFeeCzk ?? 0,
    pickupFeeOriginalCzk: ride.pickupFeeOriginalCzk ?? 0,
    distanceMeters: ride.distanceMeters,
    paymentMethod: ride.paymentMethod,
    paid: Boolean(ride.paidAt),
    status: ride.status,
    createdAt: ride.createdAt,
    acceptedAt: ride.acceptedAt,
    completedAt: ride.completedAt,
  }
}

function compactRouteGeometry(geometry) {
  const coordinates = geometry.coordinates
  const step = Math.max(1, Math.ceil(coordinates.length / 100))
  const sampled = coordinates.filter((_coordinate, index) => index % step === 0)
  if (sampled.at(-1) !== coordinates.at(-1)) sampled.push(coordinates.at(-1))
  return { type: 'LineString', coordinates: sampled }
}

app.post('/api/routes/quote', async (request, response) => {
  if (!isAllowedAppOrigin(request)) {
    response.status(403).json({ error: 'Požadavek pochází z neznámé adresy.' })
    return
  }

  const { pickup, destination, pickupCoords, destinationCoords } = request.body ?? {}
  if (
    !isValidAddress(pickup)
    || !isValidAddress(destination)
    || !isValidCoordinate(pickupCoords)
    || !isValidCoordinate(destinationCoords)
  ) {
    response.status(400).json({ error: 'Zkontrolujte zadané adresy.' })
    return
  }

  try {
    const routeUrl = new URL(
      `https://router.project-osrm.org/route/v1/driving/${pickupCoords.lon},${pickupCoords.lat};${destinationCoords.lon},${destinationCoords.lat}`,
    )
    routeUrl.searchParams.set('overview', 'full')
    routeUrl.searchParams.set('geometries', 'geojson')
    const routeResponse = await fetch(routeUrl, { signal: AbortSignal.timeout(15000) })
    if (!routeResponse.ok) throw new Error('Plánovač trasy není dostupný.')
    const routeResult = await routeResponse.json()
    const drivingRoute = routeResult.routes?.[0]
    const coordinates = drivingRoute?.geometry?.coordinates
    if (
      routeResult.code !== 'Ok'
      || !Number.isFinite(drivingRoute?.distance)
      || drivingRoute.distance < 0
      || !Number.isFinite(drivingRoute?.duration)
      || !Array.isArray(coordinates)
      || coordinates.length < 2
    ) {
      response.status(422).json({ error: 'Mezi adresami se nepodařilo vypočítat trasu.' })
      return
    }

    const now = Date.now()
    for (const [quoteId, quote] of routeQuotes) {
      if (quote.expiresAt <= now) routeQuotes.delete(quoteId)
    }
    if (routeQuotes.size >= 100) routeQuotes.delete(routeQuotes.keys().next().value)
    const quoteId = randomUUID()
    const fullAmountCzk = calculateRidePrice(drivingRoute.distance / 1000, getPricing())
    const customerSession = getCustomerSession(request)
    const discountInfo = customerSession ? getDiscountInfo(customerSession.phone) : null
    const discountPercent = discountInfo?.percent ?? 0
    const amountCzk = discountPercent
      ? Math.max(1, Math.round(fullAmountCzk * (100 - discountPercent) / 100))
      : fullAmountCzk
    const routeGeometry = compactRouteGeometry(drivingRoute.geometry)
    routeQuotes.set(quoteId, {
      pickup,
      destination,
      amountCzk,
      distanceMeters: drivingRoute.distance,
      pickupCoords,
      destinationCoords,
      routeGeometry,
      expiresAt: now + quoteLifetimeMs,
    })

    response.json({
      quoteId,
      amountCzk,
      originalAmountCzk: fullAmountCzk,
      discountPercent,
      distanceMeters: drivingRoute.distance,
      duration: drivingRoute.duration,
      geometry: routeGeometry,
    })
  } catch (error) {
    console.error('Nepodařilo se vypočítat trasu:', error)
    response.status(502).json({ error: 'Výpočet trasy není dostupný. Zkuste to prosím znovu.' })
  }
})

app.post('/api/rides', async (request, response) => {
  if (!isAllowedAppOrigin(request)) {
    response.status(403).json({ error: 'Požadavek pochází z neznámé adresy.' })
    return
  }
  const customer = requireCustomer(request, response)
  if (!customer) return
  if (!hasOnlineDriver()) {
    response.status(503).json({ error: noDriverMessage })
    return
  }
  const body = request.body ?? {}
  const result = getQuote(body)
  if (!result) {
    response.status(409).json({ error: 'Cenová nabídka vypršela. Přepočítejte prosím trasu.' })
    return
  }
  if (!isValidCustomerName(customer.name)) {
    response.status(400).json({ error: 'Přihlaste se prosím znovu a zadejte své jméno.' })
    return
  }
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 500)) {
    response.status(400).json({ error: 'Poznámka může obsahovat nejvýše 500 znaků.' })
    return
  }
  const paymentMethod = body.paymentMethod === 'card' ? 'card' : 'cash'
  if (paymentMethod === 'card' && !stripe) {
    response.status(503).json({ error: 'Platba kartou zatím není aktivní. Provozovatel musí nastavit Stripe.' })
    return
  }
  const { quoteId, quote } = result
  try {
    const rideInput = {
      id: randomUUID(),
      pickup: quote.pickup,
      destination: quote.destination,
      note: body.note?.trim() ?? '',
      customerName: customer.name,
      customerPhone: customer.phone,
      routeGeometry: quote.routeGeometry,
      amountCzk: quote.amountCzk,
      distanceMeters: quote.distanceMeters,
      createdAt: new Date().toISOString(),
    }
    const ride = paymentMethod === 'card' ? rideStore.createCardRide(rideInput) : rideStore.createCashRide(rideInput)
    routeQuotes.delete(quoteId)
    const notificationWarning = await notifyDriversOfRide(ride)
    response.status(201).json({ ride: formatApiRide(ride), notificationWarning })
  } catch (error) {
    console.error('Nepodařilo se uložit objednávku jízdy:', error)
    response.status(500).json({ error: 'Objednávku se nepodařilo uložit. Zkuste to prosím znovu.' })
  }
})

app.get('/api/rides/:id/status', (request, response) => {
  const customer = requireCustomer(request, response)
  if (!customer) return

  const ride = rideStore.getRide(request.params.id)
  if (!ride || normalizePhone(ride.customerPhone) !== customer.phone) {
    response.status(404).json({ error: 'Objednávka nebyla nalezena.' })
    return
  }

  const rejected = ride.status === 'pending'
    && rideStore.allDriversRejected(ride.id, driverAccounts.map(({ id }) => id))
  const assignedDriver = ride.driverId
    ? driverAccounts.find(({ id }) => id === ride.driverId)
    : null
  const offerDriver = ride.status === 'pending' && ride.offerDriverId
    ? driverAccounts.find(({ id }) => id === ride.offerDriverId)
    : null
  response.json({
    status: rejected ? 'rejected' : ride.status,
    amountCzk: ride.amountCzk,
    pickupFeeCzk: ride.pickupFeeCzk ?? 0,
    pickupFeeOriginalCzk: ride.pickupFeeOriginalCzk ?? 0,
    paymentMethod: ride.paymentMethod,
    paid: Boolean(ride.paidAt),
    driverName: assignedDriver?.name ?? null,
    driverPlate: assignedDriver?.plate || null,
    driverCarName: assignedDriver?.carName || null,
    offer: offerDriver
      ? {
        driverName: offerDriver.name,
        driverPlate: offerDriver.plate || null,
        driverCarName: offerDriver.carName || null,
        etaMinutes: ride.offerEtaMinutes,
        outsidePickupZone: ride.offerPickupFeeOriginalCzk !== null,
        pickupFeeCzk: ride.offerPickupFeeCzk ?? 0,
        pickupFeeOriginalCzk: ride.offerPickupFeeOriginalCzk ?? 0,
        totalAmountCzk: ride.amountCzk + (ride.offerPickupFeeCzk ?? 0),
        paymentMethod: ride.paymentMethod,
      }
      : null,
  })
})

function handleOfferResponse(action) {
  return (request, response) => {
    if (!isAllowedAppOrigin(request)) {
      response.status(403).json({ error: 'Požadavek pochází z neznámé adresy.' })
      return
    }
    const customer = requireCustomer(request, response)
    if (!customer) return
    const ride = rideStore.getRide(request.params.id)
    if (!ride || normalizePhone(ride.customerPhone) !== customer.phone) {
      response.status(404).json({ error: 'Objednávka nebyla nalezena.' })
      return
    }
    const offeredDriverId = ride.offerDriverId
    const done = action === 'confirm' ? rideStore.confirmOffer(ride.id) : rideStore.declineOffer(ride.id)
    if (!done) {
      response.status(409).json({ error: 'Nabídka už není platná. Počkejte na další řidiče.' })
      return
    }
    if (offeredDriverId) {
      void pushToDriver(offeredDriverId, action === 'confirm'
        ? { title: 'Zákazník potvrdil čas', body: `${ride.pickup} → ${ride.destination}. Jízda je vaše.`, tag: `ride-${ride.id}`, url: '/ridic' }
        : { title: 'Zákazník čas odmítl', body: `${ride.pickup} → ${ride.destination}`, tag: `ride-${ride.id}`, url: '/ridic' })
    }
    if (action === 'decline') {
      void pushToDrivers({ title: 'Nová objednávka – Taxi Koblížek', body: `${ride.pickup} → ${ride.destination}, ${ride.amountCzk} Kč`, tag: `ride-${ride.id}`, url: '/ridic' })
    }
    response.json(action === 'confirm'
      ? {
        ok: true,
        amountCzk: done.amountCzk,
        pickupFeeCzk: done.pickupFeeCzk ?? 0,
        pickupFeeOriginalCzk: done.pickupFeeOriginalCzk ?? 0,
        paymentMethod: done.paymentMethod,
        paid: Boolean(done.paidAt),
      }
      : { ok: true })
  }
}

function handlePushSubscribe(ownerType) {
  return (request, response) => {
    if (!isAllowedAppOrigin(request)) {
      response.status(403).json({ error: 'Požadavek pochází z neznámé adresy.' })
      return
    }
    const session = ownerType === 'driver' ? requireDriver(request, response) : requireCustomer(request, response)
    if (!session) return
    const fcmToken = request.body?.fcmToken
    const subscription = typeof fcmToken === 'string' && fcmToken.length >= 20 && fcmToken.length <= 400
      ? { endpoint: `fcm:${fcmToken}` }
      : request.body?.subscription
    const isValid = typeof subscription?.endpoint === 'string'
      && (subscription.endpoint.startsWith('fcm:') || (
        subscription.endpoint.startsWith('https://')
        && subscription.endpoint.length <= 1000
        && typeof subscription.keys?.p256dh === 'string'
        && typeof subscription.keys?.auth === 'string'
      ))
    if (!isValid) {
      response.status(400).json({ error: 'Neplatné přihlášení k oznámením.' })
      return
    }
    pushStore.save(ownerType, ownerType === 'driver' ? session.driverId : normalizePhone(session.phone), subscription)
    response.json({ ok: true })
  }
}

app.get('/api/push/public-key', (_request, response) => {
  response.json({ publicKey: vapidKeys.publicKey })
})
app.post('/api/driver/push-subscription', handlePushSubscribe('driver'))
app.post('/api/customer/push-subscription', handlePushSubscribe('customer'))

app.post('/api/rides/:id/offer/confirm', handleOfferResponse('confirm'))
app.post('/api/rides/:id/offer/decline', handleOfferResponse('decline'))

app.get('/api/customer/session', (request, response) => {
  const customer = getCustomerSession(request)
  response.json({ customer: customer ? { phone: customer.phone, name: customer.name } : null })
})

app.post('/api/customer/password-login', (request, response) => {
  if (!isAllowedAppOrigin(request)) {
    response.status(403).json({ error: 'Požadavek pochází z neznámé adresy.' })
    return
  }
  if (!isPajaCustomerConfigured) {
    response.status(503).json({ error: 'Zákaznický účet Paja není nakonfigurovaný.' })
    return
  }

  const address = request.ip ?? request.socket.remoteAddress ?? 'unknown'
  const attempt = customerLoginAttempts.get(address)
  if (attempt?.blockedUntil > Date.now()) {
    response.status(429).json({ error: 'Příliš mnoho pokusů. Zkuste to znovu za 15 minut.' })
    return
  }

  const { username, password } = request.body ?? {}
  const validInput = typeof username === 'string'
    && username.length <= 100
    && typeof password === 'string'
    && password.length <= 200
  const usernameMatches = validInput
    && username.trim().toLocaleLowerCase('cs-CZ') === pajaCustomerUsername.trim().toLocaleLowerCase('cs-CZ')
  let providedHash
  try {
    providedHash = scryptSync(validInput ? password : '', passwordSalt, 64)
  } catch (error) {
    console.error('Nepodařilo se ověřit přihlášení zákaznického účtu:', error)
    response.status(500).json({ error: 'Přihlášení je dočasně nedostupné.' })
    return
  }
  const passwordMatches = timingSafeEqual(providedHash, pajaCustomerPasswordHash ?? passwordForUnknownUser)
  if (!usernameMatches || !passwordMatches) {
    const failures = (attempt?.failures ?? 0) + 1
    customerLoginAttempts.set(address, {
      failures: failures % 5,
      blockedUntil: failures >= 5 ? Date.now() + 15 * 60 * 1000 : 0,
    })
    response.status(401).json({ error: 'Uživatelské jméno nebo heslo není správné.' })
    return
  }

  customerLoginAttempts.delete(address)
  const now = Date.now()
  const token = randomBytes(32).toString('hex')
  for (const [sessionToken, session] of customerSessions) {
    if (session.expiresAt <= now) customerSessions.delete(sessionToken)
  }
  customerSessions.set(token, {
    phone: pajaCustomerPhone,
    name: pajaCustomerName,
    expiresAt: now + sessionLifetimeMs,
  })
  setSessionCookie(response, 'taxi_customer_session', token)
  response.json({ customer: { phone: pajaCustomerPhone, name: pajaCustomerName } })
})

app.post('/api/customer/request-code', async (request, response) => {
  if (!isAllowedAppOrigin(request)) {
    response.status(403).json({ error: 'Požadavek pochází z neznámé adresy.' })
    return
  }
  if (isProduction && !smsSender.configured && !verifySender.configured) {
    response.status(503).json({ error: 'SMS ověření není nakonfigurované. Provozovatel musí nastavit Twilio.' })
    return
  }

  const phone = normalizePhone(request.body?.phone)
  if (!isValidPhone(phone)) {
    response.status(400).json({ error: 'Zadejte platné telefonní číslo.' })
    return
  }
  const now = Date.now()
  const ip = request.ip ?? request.socket.remoteAddress ?? 'unknown'
  const ipAttempt = customerLoginAttempts.get(ip)
  if (ipAttempt?.blockedUntil > now) {
    response.status(429).json({ error: 'Příliš mnoho pokusů. Zkuste to znovu za 15 minut.' })
    return
  }

  const existing = customerCodes.get(phone)
  if (existing?.nextAllowedAt > now) {
    response.status(429).json({ error: 'Nový kód si můžete vyžádat za chvíli.' })
    return
  }
  const challenge = {
    expiresAt: now + 5 * 60 * 1000,
    nextAllowedAt: now + 60 * 1000,
    attempts: 0,
  }
  if (verifySender.configured) {
    try {
      await verifySender.send(formatE164(phone))
    } catch (error) {
      console.error('Nepodařilo se odeslat ověřovací SMS:', error)
      response.status(502).json({ error: 'Ověřovací SMS se nepodařilo odeslat. Zkuste to prosím později.' })
      return
    }
    customerCodes.set(phone, { ...challenge, provider: 'verify' })
    response.json({ accepted: true, message: 'Ověřovací kód jsme odeslali SMS.' })
    return
  }

  const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0')
  if (smsSender.configured) {
    try {
      await smsSender.send(formatE164(phone), `Taxi Koblížek: Váš ověřovací kód je ${code}. Platí 5 minut.`)
    } catch (error) {
      console.error('Nepodařilo se odeslat ověřovací SMS:', error)
      response.status(502).json({ error: 'Ověřovací SMS se nepodařilo odeslat. Zkuste to prosím později.' })
      return
    }
    customerCodes.set(phone, { ...challenge, code, provider: 'messaging' })
    response.json({ accepted: true, message: 'Ověřovací kód jsme odeslali SMS.' })
    return
  }

  customerCodes.set(phone, { ...challenge, code, provider: 'local' })
  response.json({
    accepted: true,
    devCode: code,
    message: 'Vývojový režim: testovací kód se neposílá SMS, zobrazí se pouze tady v aplikaci.',
  })
})

app.post('/api/customer/verify-code', async (request, response) => {
  if (!isAllowedAppOrigin(request)) {
    response.status(403).json({ error: 'Požadavek pochází z neznámé adresy.' })
    return
  }
  if (isProduction && !smsSender.configured && !verifySender.configured) {
    response.status(503).json({ error: 'SMS ověření není nakonfigurované. Přihlášení přes kód není dostupné.' })
    return
  }

  const phone = normalizePhone(request.body?.phone)
  const code = request.body?.code
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : ''
  if (!isValidCustomerName(name)) {
    response.status(400).json({ error: 'Zadejte prosím své jméno (alespoň 2 znaky).' })
    return
  }
  const challenge = customerCodes.get(phone)
  if (
    !isValidPhone(phone)
    || typeof code !== 'string'
    || !/^\d{6}$/.test(code)
    || !challenge
    || challenge.expiresAt <= Date.now()
  ) {
    if (challenge?.expiresAt <= Date.now()) customerCodes.delete(phone)
    response.status(400).json({ error: 'Kód vypršel nebo není platný. Vyžádejte si nový.' })
    return
  }

  let codeMatches
  if (challenge.provider === 'verify') {
    try {
      codeMatches = await verifySender.check(formatE164(phone), code)
    } catch (error) {
      console.error('Nepodařilo se ověřit Twilio Verify kód:', error)
      response.status(502).json({ error: 'Ověřovací kód se nepodařilo ověřit. Zkuste to prosím později.' })
      return
    }
  } else {
    codeMatches = code === challenge.code
  }

  if (!codeMatches) {
    challenge.attempts += 1
    if (challenge.attempts >= 5) customerCodes.delete(phone)
    const address = request.ip ?? request.socket.remoteAddress ?? 'unknown'
    const failedAttempts = customerLoginAttempts.get(address)?.failures ?? 0
    const failures = failedAttempts + 1
    customerLoginAttempts.set(address, {
      failures: failures % 5,
      blockedUntil: failures >= 5 ? Date.now() + 15 * 60 * 1000 : 0,
    })
    response.status(401).json({ error: 'Ověřovací kód není správný.' })
    return
  }

  customerCodes.delete(phone)
  const now = Date.now()
  customerLoginAttempts.delete(request.ip ?? request.socket.remoteAddress ?? 'unknown')
  const token = randomBytes(32).toString('hex')
  for (const [sessionToken, session] of customerSessions) {
    if (session.expiresAt <= now) customerSessions.delete(sessionToken)
  }
  customerSessions.set(token, { phone, name, expiresAt: now + sessionLifetimeMs })
  setSessionCookie(response, 'taxi_customer_session', token)
  response.json({ customer: { phone, name } })
})

app.post('/api/customer/profile', (request, response) => {
  if (!isAllowedAppOrigin(request)) {
    response.status(403).json({ error: 'Požadavek pochází z neznámé adresy.' })
    return
  }
  const customer = requireCustomer(request, response)
  if (!customer) return
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : ''
  if (!isValidCustomerName(name)) {
    response.status(400).json({ error: 'Zadejte prosím své jméno (alespoň 2 znaky).' })
    return
  }
  customerSessions.get(customer.token).name = name
  response.json({ customer: { phone: customer.phone, name } })
})

app.post('/api/customer/logout', (request, response) => {
  if (!isAllowedAppOrigin(request)) {
    response.status(403).json({ error: 'Požadavek pochází z neznámé adresy.' })
    return
  }
  const customer = getCustomerSession(request)
  if (customer) customerSessions.delete(customer.token)
  response.setHeader('Set-Cookie', 'taxi_customer_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
  response.status(204).end()
})

app.get('/api/driver/session', (request, response) => {
  if (!areDriverAccountsConfigured) {
    response.status(503).json({ error: `Přihlášení řidičů není nastavené. V Renderu nastavte DRIVER_3_USERNAME a DRIVER_3_PASSWORD (heslo alespoň ${minimumPasswordLength} znaků).` })
    return
  }
  const session = getDriverSession(request)
  const driver = session && driverAccounts.find((account) => account.id === session.driverId)
  response.json({ driver: driver ? { id: driver.id, name: driver.name } : null })
})

app.post('/api/driver/login', async (request, response) => {
  if (!isAllowedAppOrigin(request)) {
    response.status(403).json({ error: 'Požadavek pochází z neznámé adresy.' })
    return
  }
  if (!areDriverAccountsConfigured) {
    response.status(503).json({ error: `Přihlášení řidičů není nastavené. V Renderu nastavte DRIVER_3_USERNAME a DRIVER_3_PASSWORD (heslo alespoň ${minimumPasswordLength} znaků).` })
    return
  }

  const address = request.ip ?? request.socket.remoteAddress ?? 'unknown'
  const now = Date.now()
  const attempt = loginAttempts.get(address)
  if (attempt?.blockedUntil > now) {
    response.status(429).json({ error: 'Příliš mnoho pokusů. Zkuste to znovu za 15 minut.' })
    return
  }
  if (attempt?.blockedUntil) loginAttempts.delete(address)

  const { username, password } = request.body ?? {}
  const normalizedUsername = typeof username === 'string'
    ? username.trim().toLocaleLowerCase('cs-CZ')
    : ''
  const validInput = typeof username === 'string'
    && username.length <= 100
    && typeof password === 'string'
    && password.length <= 200
  const account = validInput
    ? driverAccounts.find((candidate) => candidate.username.toLocaleLowerCase('cs-CZ') === normalizedUsername)
      ?? driverStore.findEmployeeByUsername(normalizedUsername)
    : null
  const accountSalt = account?.passwordSalt
    ? Buffer.isBuffer(account.passwordSalt) ? account.passwordSalt : Buffer.from(account.passwordSalt, 'hex')
    : passwordSalt
  let providedHash
  try {
    providedHash = await scrypt(
      validInput ? password : '',
      accountSalt,
      64,
    )
  } catch (error) {
    console.error('Nepodařilo se ověřit přihlašovací údaje řidiče:', error)
    response.status(500).json({ error: 'Přihlášení je dočasně nedostupné.' })
    return
  }
  const expectedHash = account?.passwordHash
    ? Buffer.isBuffer(account.passwordHash) ? account.passwordHash : Buffer.from(account.passwordHash, 'hex')
    : passwordForUnknownUser
  const passwordMatches = timingSafeEqual(providedHash, expectedHash)
  if (!account || !passwordMatches) {
    const failures = (attempt?.failures ?? 0) + 1
    loginAttempts.set(address, {
      failures: failures % 5,
      blockedUntil: failures >= 5 ? now + 15 * 60 * 1000 : 0,
    })
    response.status(401).json({ error: 'Uživatelské jméno nebo heslo není správné.' })
    return
  }

  loginAttempts.delete(address)
  const token = randomBytes(32).toString('hex')
  for (const [sessionToken, session] of driverSessions) {
    if (session.expiresAt <= now) driverSessions.delete(sessionToken)
  }
  driverSessions.set(token, { driverId: account.id, expiresAt: now + sessionLifetimeMs })
  setDriverSessionCookie(response, token)
  response.json({ driver: { id: account.id, name: account.name } })
})

app.post('/api/driver/logout', (request, response) => {
  if (!isAllowedAppOrigin(request)) {
    response.status(403).json({ error: 'Požadavek pochází z neznámé adresy.' })
    return
  }
  const session = getDriverSession(request)
  if (session) {
    driverSessions.delete(session.token)
    driverLastSeen.delete(session.driverId)
  }
  response.setHeader('Set-Cookie', 'taxi_driver_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
  response.status(204).end()
})

const driverLastSeen = new Map()
const driverOnlineWindowMs = 20 * 1000
const noDriverMessage = 'Teď není dostupné žádné vozidlo. Zkuste to prosím za chvíli.'

function hasOnlineDriver() {
  const cutoff = Date.now() - driverOnlineWindowMs
  return [...driverLastSeen.values()].some((seenAt) => seenAt >= cutoff)
}

app.get('/api/availability', (_request, response) => {
  response.json({ available: hasOnlineDriver() })
})

app.get('/api/driver/rides', (request, response) => {
  const session = requireDriver(request, response)
  if (!session) return
  driverLastSeen.set(session.driverId, Date.now())
  response.json({
    available: rideStore.listAvailableRides(session.driverId).map(formatApiRide),
    assigned: rideStore.listDriverRides(session.driverId).map(formatApiRide),
  })
})

const DEFAULT_DISCOUNT_TIERS = [
  { rides: 5, percent: 5 },
  { rides: 10, percent: 10 },
  { rides: 15, percent: 15 },
]
const DISCOUNT_WINDOW_DAYS = 90

function parseDiscountTiers(value) {
  if (!Array.isArray(value) || value.length > 10) return null
  const tiers = value.map((tier) => ({ rides: Number(tier?.rides), percent: Number(tier?.percent) }))
  if (!tiers.every(({ rides, percent }) => Number.isInteger(rides) && rides >= 1 && rides <= 1000
    && Number.isInteger(percent) && percent >= 1 && percent <= 90)) return null
  if (new Set(tiers.map(({ rides }) => rides)).size !== tiers.length) return null
  return tiers.sort((a, b) => a.rides - b.rides)
}

function getDiscountTiers() {
  try {
    const stored = driverStore.getSetting('discount_tiers')
    return stored === null ? DEFAULT_DISCOUNT_TIERS : parseDiscountTiers(JSON.parse(stored)) ?? DEFAULT_DISCOUNT_TIERS
  } catch {
    return DEFAULT_DISCOUNT_TIERS
  }
}

function getDiscountInfo(phone) {
  const since = new Date(Date.now() - DISCOUNT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const ridesInWindow = rideStore.countCompletedRidesForCustomerSince(phone, since)
  const tiers = getDiscountTiers()
  const loyaltyPercent = tiers.filter(({ rides }) => ridesInWindow >= rides).reduce((max, { percent }) => Math.max(max, percent), 0)
  const nextTier = tiers.find(({ rides, percent }) => rides > ridesInWindow && percent > loyaltyPercent) ?? null
  return {
    percent: loyaltyPercent,
    ridesInWindow,
    windowDays: DISCOUNT_WINDOW_DAYS,
    tiers: tiers.map(({ rides, percent }) => ({ rides, percent })),
    nextTier: nextTier ? { rides: nextTier.rides, percent: nextTier.percent, remaining: nextTier.rides - ridesInWindow } : null,
  }
}

app.get('/api/discount', (request, response) => {
  const customer = requireCustomer(request, response)
  if (!customer) return
  response.json(getDiscountInfo(customer.phone))
})

app.get('/api/driver/discount-tiers', (request, response) => {
  const session = requireDriver(request, response)
  if (!session) return
  if (session.driverId !== 'driver-owner') {
    response.status(403).json({ error: 'Slevy může spravovat pouze majitel.' })
    return
  }
  response.json({ tiers: getDiscountTiers(), windowDays: DISCOUNT_WINDOW_DAYS })
})

app.put('/api/driver/discount-tiers', (request, response) => {
  if (!isAllowedAppOrigin(request)) {
    response.status(403).json({ error: 'Požadavek pochází z neznámé adresy.' })
    return
  }
  const session = requireDriver(request, response)
  if (!session) return
  if (session.driverId !== 'driver-owner') {
    response.status(403).json({ error: 'Slevy může spravovat pouze majitel.' })
    return
  }
  const tiers = parseDiscountTiers(request.body?.tiers)
  if (!tiers) {
    response.status(400).json({ error: 'Zadejte stupně slevy: počet jízd 1–1000 (bez opakování) a sleva 1–90 %.' })
    return
  }
  driverStore.setSetting('discount_tiers', JSON.stringify(tiers))
  response.json({ tiers, windowDays: DISCOUNT_WINDOW_DAYS })
})

function getPricing() {
  try {
    return parsePricing(JSON.parse(driverStore.getSetting('pricing') ?? 'null')) ?? DEFAULT_PRICING
  } catch {
    return DEFAULT_PRICING
  }
}

app.get('/api/pricing', (_request, response) => {
  response.json(getPricing())
})

app.put('/api/driver/pricing', (request, response) => {
  if (!isAllowedAppOrigin(request)) {
    response.status(403).json({ error: 'Požadavek pochází z neznámé adresy.' })
    return
  }
  const session = requireDriver(request, response)
  if (!session) return
  if (session.driverId !== 'driver-owner') {
    response.status(403).json({ error: 'Ceník může měnit pouze majitel.' })
    return
  }
  const pricing = parsePricing(request.body)
  if (!pricing || pricing.pricePerKmCzk <= 0) {
    response.status(400).json({ error: 'Zadejte nástupné (0–10 000 Kč) a cenu za km (nad 0 až 1 000 Kč).' })
    return
  }
  driverStore.setSetting('pricing', JSON.stringify(pricing))
  response.json(pricing)
})

app.get('/api/driver/stats', (request, response) => {
  const session = requireDriver(request, response)
  if (!session) return
  if (session.driverId !== 'driver-owner') {
    response.status(403).json({ error: 'Statistiky jízd jsou dostupné pouze majiteli.' })
    return
  }
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const byDriver = new Map(rideStore.getCompletedRideStatsByDriverSince(cutoff).map((row) => [row.driverId, row]))
  response.json({
    completedRides: rideStore.countCompletedRides(),
    last30Days: rideStore.getCompletedRideStatsSince(cutoff),
    drivers: driverAccounts.map(({ id, name, plate }) => ({
      id,
      name,
      plate: plate || null,
      completedRides: byDriver.get(id)?.completedRides ?? 0,
      revenueCzk: byDriver.get(id)?.revenueCzk ?? 0,
      distanceKm: Math.round(((byDriver.get(id)?.distanceMeters ?? 0) / 1000) * 10) / 10,
    })),
  })
})

app.get('/api/driver/customers', (request, response) => {
  const session = requireDriver(request, response)
  if (!session) return
  if (session.driverId !== 'driver-owner') {
    response.status(403).json({ error: 'Přehled zákazníků je dostupný pouze majiteli.' })
    return
  }
  response.json({
    customers: rideStore.listCustomerOverview().map((customer) => ({
      name: customer.name,
      phone: customer.phone,
      totalRides: customer.totalRides,
      completedRides: customer.completedRides,
      spentCzk: customer.spentCzk,
      distanceKm: Math.round((customer.distanceMeters / 1000) * 10) / 10,
      lastRideAt: customer.lastRideAt,
    })),
  })
})

app.get('/api/driver/completed-rides', (request, response) => {
  const session = requireDriver(request, response)
  if (!session) return
  if (session.driverId !== 'driver-owner') {
    response.status(403).json({ error: 'Report jízd je dostupný pouze majiteli.' })
    return
  }
  const from = new Date(String(request.query.from ?? ''))
  const to = new Date(String(request.query.to ?? ''))
  const maxRangeMs = 366 * 24 * 60 * 60 * 1000
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to - from > maxRangeMs) {
    response.status(400).json({ error: 'Zadejte platné období Od – Do (nejvýše 1 rok).' })
    return
  }
  const rides = rideStore.listCompletedRidesBetween(from.toISOString(), to.toISOString()).map((ride) => {
    const rideDriver = driverAccounts.find(({ id }) => id === ride.driverId)
    return {
      id: ride.id,
      pickup: ride.pickup,
      destination: ride.destination,
      amountCzk: ride.amountCzk,
      distanceKm: Math.round(((ride.distanceMeters ?? 0) / 1000) * 10) / 10,
      paymentMethod: ride.paymentMethod,
      customerName: ride.customerName,
      driverId: ride.driverId,
      driverName: rideDriver?.name ?? 'Neznámý řidič',
      driverPlate: rideDriver?.plate || null,
      completedAt: ride.completedAt,
    }
  })
  response.json({
    rides,
    totals: {
      count: rides.length,
      revenueCzk: rides.reduce((sum, ride) => sum + ride.amountCzk, 0),
      distanceKm: Math.round(rides.reduce((sum, ride) => sum + ride.distanceKm, 0) * 10) / 10,
    },
  })
})

app.get('/api/driver/employees', (request, response) => {
  const session = requireDriver(request, response)
  if (!session) return
  if (session.driverId !== 'driver-owner') {
    response.status(403).json({ error: 'Správa zaměstnanců je dostupná pouze majiteli.' })
    return
  }
  response.json({ employees: driverStore.listEmployees() })
})

app.post('/api/driver/employees', async (request, response) => {
  if (!isAllowedAppOrigin(request)) {
    response.status(403).json({ error: 'Požadavek pochází z neznámé adresy.' })
    return
  }
  const session = requireDriver(request, response)
  if (!session) return
  if (session.driverId !== 'driver-owner') {
    response.status(403).json({ error: 'Správa zaměstnanců je dostupná pouze majiteli.' })
    return
  }

  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : ''
  const code = request.body?.code
  const minimumCodeLength = minimumPasswordLength
  if (name.length < 2 || name.length > 60 || typeof code !== 'string'
    || code.length < minimumCodeLength || code.length > 200) {
    response.status(400).json({
      error: `Zadejte jméno dlouhé 2 až 60 znaků a heslo dlouhé alespoň ${minimumCodeLength} znaků.`,
    })
    return
  }

  const usernameKey = name.toLocaleLowerCase('cs-CZ')
  if (driverAccounts.some(({ username: existingUsername }) => existingUsername.toLocaleLowerCase('cs-CZ') === usernameKey)
    || driverStore.findEmployeeByUsername(usernameKey)) {
    response.status(409).json({ error: 'Zaměstnanec s tímto jménem už existuje.' })
    return
  }

  const salt = randomBytes(16)
  let passwordHash
  try {
    passwordHash = await scrypt(code, salt, 64)
  } catch (error) {
    console.error('Nepodařilo se zabezpečit heslo zaměstnance:', error)
    response.status(500).json({ error: 'Účet zaměstnance se nepodařilo vytvořit.' })
    return
  }

  const employee = {
    id: `employee-${randomUUID()}`,
    name,
    phone: null,
    plate: normalizePlate(request.body?.plate).slice(0, 15) || null,
    carName: normalizeCarName(request.body?.carName),
    usernameKey,
    passwordSalt: salt.toString('hex'),
    passwordHash: passwordHash.toString('hex'),
    createdAt: new Date().toISOString(),
  }
  try {
    driverStore.createEmployee(employee)
  } catch (error) {
    if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      response.status(409).json({ error: 'Zaměstnanec s tímto jménem už existuje.' })
      return
    }
    throw error
  }
  driverAccounts.push({
    id: employee.id,
    name: employee.name,
    plate: employee.plate,
    carName: employee.carName,
    username: employee.usernameKey,
    passwordSalt: salt,
    passwordHash,
  })
  response.status(201).json({
    employee: { id: employee.id, name: employee.name, plate: employee.plate, carName: employee.carName, username: employee.usernameKey },
  })
})

app.put('/api/driver/employees/:id', async (request, response) => {
  if (!isAllowedAppOrigin(request)) {
    response.status(403).json({ error: 'Požadavek pochází z neznámé adresy.' })
    return
  }
  const session = requireDriver(request, response)
  if (!session) return
  if (session.driverId !== 'driver-owner') {
    response.status(403).json({ error: 'Správa zaměstnanců je dostupná pouze majiteli.' })
    return
  }
  const account = driverAccounts.find(({ id }) => id === request.params.id)
  if (!account || !request.params.id.startsWith('employee-')) {
    response.status(404).json({ error: 'Zaměstnanec nebyl nalezen.' })
    return
  }

  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : ''
  const code = typeof request.body?.code === 'string' && request.body.code !== '' ? request.body.code : null
  const minimumCodeLength = minimumPasswordLength
  if (name.length < 2 || name.length > 60
    || (code !== null && (code.length < minimumCodeLength || code.length > 200))) {
    response.status(400).json({
      error: `Zadejte jméno dlouhé 2 až 60 znaků a nové heslo (volitelné) dlouhé alespoň ${minimumCodeLength} znaků.`,
    })
    return
  }

  const usernameKey = name.toLocaleLowerCase('cs-CZ')
  const plate = normalizePlate(request.body?.plate).slice(0, 15) || null
  const carName = normalizeCarName(request.body?.carName)
  if (driverAccounts.some(({ id, username }) => id !== account.id && username.toLocaleLowerCase('cs-CZ') === usernameKey)) {
    response.status(409).json({ error: 'Zaměstnanec s tímto jménem už existuje.' })
    return
  }

  let salt
  let passwordHash
  if (code !== null) {
    salt = randomBytes(16)
    try {
      passwordHash = await scrypt(code, salt, 64)
    } catch (error) {
      console.error('Nepodařilo se zabezpečit heslo zaměstnance:', error)
      response.status(500).json({ error: 'Účet se nepodařilo upravit.' })
      return
    }
  }
  try {
    driverStore.updateEmployee({
      id: account.id,
      name,
      plate,
      carName,
      usernameKey,
      passwordSalt: salt?.toString('hex'),
      passwordHash: passwordHash?.toString('hex'),
    })
  } catch (error) {
    if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      response.status(409).json({ error: 'Zaměstnanec s tímto jménem už existuje.' })
      return
    }
    throw error
  }
  account.name = name
  account.plate = plate
  account.carName = carName
  account.username = usernameKey
  if (passwordHash) {
    account.passwordSalt = salt
    account.passwordHash = passwordHash
  }
  response.json({ employee: { id: account.id, name, plate, carName, username: usernameKey } })
})

app.delete('/api/driver/employees/:id', (request, response) => {
  if (!isAllowedAppOrigin(request)) {
    response.status(403).json({ error: 'Požadavek pochází z neznámé adresy.' })
    return
  }
  const session = requireDriver(request, response)
  if (!session) return
  if (session.driverId !== 'driver-owner') {
    response.status(403).json({ error: 'Správa zaměstnanců je dostupná pouze majiteli.' })
    return
  }
  if (!driverStore.deleteEmployee(request.params.id)) {
    response.status(404).json({ error: 'Zaměstnanec nebyl nalezen.' })
    return
  }
  const index = driverAccounts.findIndex(({ id }) => id === request.params.id)
  if (index !== -1) driverAccounts.splice(index, 1)
  response.json({ ok: true })
})

app.post('/api/driver/rides/:id/accept', async (request, response) => {
  if (!isAllowedAppOrigin(request)) {
    response.status(403).json({ error: 'Požadavek pochází z neznámé adresy.' })
    return
  }
  const session = requireDriver(request, response)
  if (!session) return
  const etaMinutes = Number(request.body?.etaMinutes)
  if (!Number.isInteger(etaMinutes) || etaMinutes < 1 || etaMinutes > 180) {
    response.status(400).json({ error: 'Zadejte, za kolik minut tam budete (1 až 180).' })
    return
  }
  const outsidePickupZone = request.body?.outsidePickupZone === true
  if (request.body?.outsidePickupZone !== undefined && typeof request.body.outsidePickupZone !== 'boolean') {
    response.status(400).json({ error: 'Označte, zda je nástupní adresa v nástupní zóně.' })
    return
  }
  const pickupFeeInput = Number(request.body?.pickupFeeCzk)
  if (outsidePickupZone && (!Number.isInteger(pickupFeeInput) || pickupFeeInput < 1 || pickupFeeInput > 10000)) {
    response.status(400).json({ error: 'Zadejte částku za přistavení vozidla (1 až 10 000 Kč).' })
    return
  }
  const pendingRide = rideStore.getRide(request.params.id)
  let pickupFee = null
  if (outsidePickupZone && pendingRide) {
    const discountPercent = getDiscountInfo(normalizePhone(pendingRide.customerPhone)).percent
    pickupFee = {
      originalAmountCzk: pickupFeeInput,
      amountCzk: discountPercent ? Math.max(1, Math.round(pickupFeeInput * (100 - discountPercent) / 100)) : pickupFeeInput,
    }
  }
  const ride = rideStore.offerRide(request.params.id, session.driverId, etaMinutes, pickupFee)
  if (!ride) {
    response.status(409).json({ error: 'Tuto jízdu už nabídl jiný řidič nebo už není volná.' })
    return
  }
  const driver = driverAccounts.find(({ id }) => id === session.driverId)
  const totalAmountCzk = ride.amountCzk + (pickupFee?.amountCzk ?? 0)
  const pickupFeeText = pickupFee
    ? ` Nástupní adresa je mimo region taxi (Třebechovice pod Orebem, Pohoří u Dobrušky). Přistavení vozidla ${pickupFee.amountCzk} Kč${pickupFee.amountCzk !== pickupFee.originalAmountCzk ? ` po slevě (původně ${pickupFee.originalAmountCzk} Kč)` : ''}, celkem ${totalAmountCzk} Kč.`
    : ''
  void pushToCustomer(ride.customerPhone, {
    title: `Řidič ${driver?.name ?? ''} přijede za ${etaMinutes} min`.replace('  ', ' '),
    body: `${driver?.carName ? `${driver.carName}. ` : ''}${driver?.plate ? `SPZ ${driver.plate}. ` : ''}${pickupFee ? `Přistavení vozidla ${pickupFee.amountCzk} Kč, celkem ${totalAmountCzk} Kč. ` : ''}Otevřete aplikaci a potvrďte ${pickupFee ? 'nabídku' : 'čas'}.`,
    tag: `ride-${ride.id}`,
    url: '/',
  })
  const notificationWarning = await notifyBySms(
    [ride.customerPhone],
    `Taxi Koblížek: Řidič${driver?.name ? ` ${driver.name}` : ''}${driver?.carName ? `, ${driver.carName}` : ''}${driver?.plate ? `, SPZ ${driver.plate}` : ''} k vám přijede za ${etaMinutes} min.${pickupFeeText} Potvrďte nebo odmítněte to v aplikaci.`,
    `Nabídka času zákazníkovi k jízdě ${ride.id}`,
  ) ? null : 'Čas je odeslaný zákazníkovi v aplikaci, ale SMS se nepodařilo odeslat.'
  response.json({ ride: formatApiRide(ride), notificationWarning })
})

app.post('/api/driver/rides/:id/reject', async (request, response) => {
  if (!isAllowedAppOrigin(request)) {
    response.status(403).json({ error: 'Požadavek pochází z neznámé adresy.' })
    return
  }
  const session = requireDriver(request, response)
  if (!session) return
  if (!rideStore.rejectRide(request.params.id, session.driverId)) {
    response.status(409).json({ error: 'Tato jízda už není dostupná.' })
    return
  }
  const rejectedForEveryone = rideStore.allDriversRejected(
    request.params.id,
    driverAccounts.map(({ id }) => id),
  )
  let notificationWarning = null
  if (rejectedForEveryone) {
    const ride = rideStore.getRide(request.params.id)
    notificationWarning = await notifyCustomerRideStatus(ride, 'rejected')
  }
  response.json({ rejectedForEveryone, notificationWarning })
})

app.post('/api/driver/rides/:id/status', (request, response) => {
  if (!isAllowedAppOrigin(request)) {
    response.status(403).json({ error: 'Požadavek pochází z neznámé adresy.' })
    return
  }
  const session = requireDriver(request, response)
  if (!session) return
  const ride = rideStore.updateRideStatus(request.params.id, session.driverId, request.body?.status)
  if (!ride) {
    response.status(409).json({ error: 'Stav jízdy už nelze změnit. Obnovte seznam jízd.' })
    return
  }
  if (ride.status === 'to_pickup') {
    void pushToCustomer(ride.customerPhone, { title: 'Řidič vyrazil k vám', body: 'Brzy bude na místě.', tag: `ride-${ride.id}`, url: '/' })
  }
  response.json({ ride: formatApiRide(ride) })
})

app.get('/api/payments/status', (_request, response) => {
  response.json({ enabled: Boolean(stripe) })
})

app.post('/api/rides/:id/payment', async (request, response) => {
  if (!stripe) {
    response.status(503).json({ error: 'Platba kartou zatím není aktivní. Provozovatel musí nastavit Stripe.' })
    return
  }
  if (!isAllowedAppOrigin(request)) {
    response.status(403).json({ error: 'Požadavek na platbu pochází z neznámé adresy.' })
    return
  }
  const customer = requireCustomer(request, response)
  if (!customer) return
  const ride = rideStore.getRide(request.params.id)
  if (!ride || normalizePhone(ride.customerPhone) !== customer.phone) {
    response.status(404).json({ error: 'Objednávka nebyla nalezena.' })
    return
  }
  if (ride.paymentMethod !== 'card' || ride.paidAt) {
    response.status(409).json({ error: 'Tato jízda už je zaplacená nebo se platí hotově.' })
    return
  }
  if (!['accepted', 'to_pickup', 'with_customer', 'completed'].includes(ride.status)) {
    response.status(409).json({ error: 'Zaplatit lze až po potvrzení nabídky řidiče.' })
    return
  }

  try {
    const baseUrl = request.get('origin')
    const description = ride.pickupFeeCzk > 0
      ? `${ride.pickup} → ${ride.destination} (vč. přistavení vozidla ${ride.pickupFeeCzk} Kč)`
      : `${ride.pickup} → ${ride.destination}`
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      locale: 'cs',
      payment_method_types: ['card'],
      client_reference_id: ride.id,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'czk',
          unit_amount: ride.amountCzk * 100,
          product_data: {
            name: 'Jízda Taxi Koblížek',
            description: description.slice(0, 500),
          },
        },
      }],
      metadata: { rideId: ride.id },
      success_url: `${baseUrl}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?payment=cancelled`,
    })
    if (!checkoutSession.url) throw new Error('Stripe nevytvořil platební stránku.')
    response.json({ url: checkoutSession.url })
  } catch (error) {
    console.error('Nepodařilo se vytvořit Stripe Checkout Session:', error)
    response.status(502).json({ error: 'Platbu se nepodařilo připravit. Zkuste to prosím znovu.' })
  }
})

app.get('/api/payments/session', async (request, response) => {
  if (!stripe) {
    response.status(503).json({ error: 'Ověření platby zatím není dostupné.' })
    return
  }

  const sessionId = request.query.session_id
  if (typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
    response.status(400).json({ error: 'Platební relace není platná.' })
    return
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId)
    const rideId = session.metadata?.rideId
    if (
      session.status !== 'complete'
      || session.payment_status !== 'paid'
      || session.currency !== 'czk'
      || !Number.isInteger(session.amount_total)
      || typeof rideId !== 'string'
    ) {
      response.status(402).json({ error: 'Platba ještě nebyla potvrzena.' })
      return
    }
    const amountCzk = session.amount_total / 100
    const ride = rideStore.markRidePaid(rideId, session.id, amountCzk)
    if (!ride || !ride.paidAt || ride.paymentSessionId !== session.id) {
      response.status(409).json({ error: 'Platbu se nepodařilo přiřadit k jízdě. Kontaktujte prosím provozovatele.' })
      return
    }
    if (ride.newlyPaid && ride.driverId) {
      void pushToDriver(ride.driverId, {
        title: 'Zákazník zaplatil kartou',
        body: `${ride.pickup} → ${ride.destination}, ${amountCzk} Kč`,
        tag: `ride-${ride.id}`,
        url: '/ridic',
      })
    }
    response.json({ paid: true, rideId: ride.id, amountCzk })
  } catch (error) {
    console.error('Nepodařilo se ověřit Stripe Checkout Session:', error)
    response.status(502).json({ error: 'Stav platby se nepodařilo ověřit.' })
  }
})

app.use(express.static(path.join(projectRoot, 'dist')))
app.use((_request, response) => {
  response.sendFile(path.join(projectRoot, 'dist', 'index.html'))
})

app.listen(port, () => {
  console.info(`Taxi Koblížek server naslouchá na portu ${port}.`)
  if (!stripe) console.warn('Platby kartou jsou vypnuté: není nastaven STRIPE_SECRET_KEY.')
})
