import { useCallback, useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import './DriverApp.css'
import { isNativeApp, requestNativePermission, subscribeToPush } from './pushClient.js'
import { DEFAULT_PRICING, calculateRidePrice } from './priceCalculator.mjs'

const statusLabels = {
  accepted: 'Přijata',
  to_pickup: 'Jedu pro zákazníka',
  with_customer: 'Zákazník jede',
  completed: 'Dokončena',
}

const nextRideStatus = {
  accepted: { status: 'to_pickup', label: 'Vyrážím k zákazníkovi' },
  to_pickup: { status: 'with_customer', label: 'Zákazník nastoupil' },
  with_customer: { status: 'completed', label: 'Dokončit jízdu' },
}

async function readJson(response) {
  if (response.status === 204) return {}
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'Požadavek se nepodařilo dokončit.')
  return result
}

function formatCreatedAt(value) {
  return new Intl.DateTimeFormat('cs-CZ', {
    day: 'numeric',
    month: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function toDateInput(date) {
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat('cs-CZ', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatDateOnly(value) {
  return new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' }).format(new Date(`${value}T00:00:00`))
}

function csvCell(value) {
  const text = String(value ?? '')
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return `"${safe.replace(/"/g, '""')}"`
}

function downloadRidesCsv(rides, from, to) {
  const header = ['Dokončeno', 'Řidič', 'SPZ', 'Odkud', 'Kam', 'Km', 'Platba', 'Cena (Kč)']
  const lines = rides.map((ride) => [
    formatDateTime(ride.completedAt),
    ride.driverName,
    ride.driverPlate ?? '',
    ride.pickup,
    ride.destination,
    String(ride.distanceKm).replace('.', ','),
    ride.paymentMethod === 'card' ? 'Karta' : 'Hotově',
    ride.amountCzk,
  ])
  const csv = [header, ...lines].map((line) => line.map(csvCell).join(';')).join('\r\n')
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `report-jizd-${from}_${to}.csv`
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function formatPhone(value) {
  const digits = value.replace(/\D/g, '')
  if (digits.length === 12 && digits.startsWith('420')) {
    return `+420 ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`
  }
  return `+${digits}`
}

function DriverRideMap({ geometry, pickup, destination }) {
  const mapElementRef = useRef(null)
  const mapRef = useRef(null)
  const routeLayerRef = useRef(null)
  const geometryKey = JSON.stringify(geometry)

  useEffect(() => {
    if (!mapElementRef.current) return undefined
    const map = L.map(mapElementRef.current, { zoomControl: false, scrollWheelZoom: false })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map)
    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !geometryKey || geometryKey === 'null') return

    const routeGeometry = JSON.parse(geometryKey)
    const coordinates = routeGeometry.coordinates
    if (routeGeometry.type !== 'LineString' || !Array.isArray(coordinates) || coordinates.length < 2) return

    routeLayerRef.current?.remove()
    const routeLayer = L.geoJSON(routeGeometry, {
      style: { color: '#78b841', weight: 5, opacity: 0.9 },
      pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
        radius: 7,
        color: '#fff',
        weight: 3,
        fillColor: '#72b83c',
        fillOpacity: 1,
      }),
    }).addTo(map)
    const firstPoint = L.latLng(coordinates[0][1], coordinates[0][0])
    const lastCoordinates = coordinates[coordinates.length - 1]
    const lastPoint = L.latLng(lastCoordinates[1], lastCoordinates[0])
    L.circleMarker(firstPoint, {
      radius: 7,
      color: '#fff',
      weight: 3,
      fillColor: '#72b83c',
      fillOpacity: 1,
    }).addTo(routeLayer)
    L.circleMarker(lastPoint, {
      radius: 7,
      color: '#fff',
      weight: 3,
      fillColor: '#30231c',
      fillOpacity: 1,
    }).addTo(routeLayer)
    routeLayerRef.current = routeLayer
    map.fitBounds(routeLayer.getBounds(), { padding: [16, 16], maxZoom: 15 })
  }, [geometryKey])

  if (!geometry) {
    return <p className="driver-map-unavailable">Mapa není dostupná u této starší objednávky.</p>
  }

  return (
    <div
      className="driver-ride-map"
      ref={mapElementRef}
      role="img"
      aria-label={`Mapa trasy z ${pickup} do ${destination}`}
    />
  )
}

function RideCard({ ride, assigned = false, busy, onAccept, onReject, onAdvance }) {
  const [etaMinutes, setEtaMinutes] = useState('10')
  const [pickupFeeCzk, setPickupFeeCzk] = useState('')
  const etaValue = Number(etaMinutes)
  const feeValue = pickupFeeCzk.trim() === '' ? 0 : Number(pickupFeeCzk)
  const isFeeValid = Number.isInteger(feeValue) && feeValue >= 0 && feeValue <= 10000
  const canSubmitOffer = Number.isInteger(etaValue) && etaValue >= 1 && etaValue <= 180 && isFeeValid
  const mapsUrl = new URL('https://www.google.com/maps/dir/')
  mapsUrl.searchParams.set('api', '1')
  mapsUrl.searchParams.set('origin', ride.pickup)
  mapsUrl.searchParams.set('destination', ride.destination)
  const nextAction = nextRideStatus[ride.status]

  return (
    <article className={`driver-ride-card${assigned ? ' assigned-ride-card' : ' available-ride-card'}`}>
      <div className="driver-ride-heading">
        <div>
          <p className="driver-ride-time">{formatCreatedAt(ride.createdAt)}</p>
          <strong className="driver-ride-price">{ride.amountCzk} Kč</strong>
          {assigned && ride.pickupFeeCzk > 0 && (
            <span className="driver-pickup-fee-note">vč. přistavení {ride.pickupFeeCzk} Kč</span>
          )}
        </div>
        <span className={`driver-ride-status status-${ride.status}`}>
          {statusLabels[ride.status] ?? 'Nová objednávka'}
        </span>
      </div>
      <div className="driver-ride-route">
        <div><span className="driver-route-dot pickup-dot" /><strong>{ride.pickup}</strong></div>
        <div><span className="driver-route-dot destination-dot" /><strong>{ride.destination}</strong></div>
      </div>
      <DriverRideMap geometry={ride.routeGeometry} pickup={ride.pickup} destination={ride.destination} />
      <div className="driver-ride-meta">
        <span>{ride.distanceMeters ? `${(ride.distanceMeters / 1000).toFixed(1)} km` : 'Vzdálenost dle trasy'}</span>
        <span>{ride.paymentMethod === 'card' ? (ride.paid ? 'Zaplaceno kartou' : assigned ? 'Čeká na platbu kartou' : 'Karta – platba po potvrzení') : 'Platba hotově'}</span>
      </div>
      {!assigned && ride.customerPhone && (
        <div className="driver-customer-contact">
          <span>Telefon zákazníka</span>
          <a href={`tel:${ride.customerPhone}`}>{formatPhone(ride.customerPhone)}</a>
          <span className="driver-private-note">Jméno se zobrazí po přijetí jízdy.</span>
        </div>
      )}
      {assigned && ride.customerName && (
        <div className="driver-customer-contact">
          <strong>{ride.customerName}</strong>
          <a href={`tel:${ride.customerPhone}`}>{formatPhone(ride.customerPhone)}</a>
        </div>
      )}
      {ride.note && (
        <div className="driver-order-note">
          <strong>Poznámka zákazníka</strong>
          <p>{ride.note}</p>
        </div>
      )}
      {assigned ? (
        <div className="driver-ride-actions">
          <a className="driver-secondary-action" href={mapsUrl.href} target="_blank" rel="noreferrer">Navigovat</a>
          {nextAction && (
            <button
              className="driver-primary-action"
              type="button"
              onClick={() => onAdvance(ride, nextAction.status)}
              disabled={busy}
            >
              {busy ? 'Ukládám…' : nextAction.label}
            </button>
          )}
        </div>
      ) : (
        <div className="driver-ride-actions driver-eta-actions">
          <label className="driver-eta-field">
            <span>Dorazím za (min)</span>
            <input
              type="number"
              inputMode="numeric"
              min="1"
              max="180"
              value={etaMinutes}
              onChange={(event) => setEtaMinutes(event.target.value)}
              disabled={busy}
            />
          </label>
          <label className="driver-eta-field driver-pickup-fee-field">
            <span>Přistavení vozidla (Kč)</span>
            <input
              type="number"
              inputMode="numeric"
              min="0"
              max="10000"
              value={pickupFeeCzk}
              onChange={(event) => setPickupFeeCzk(event.target.value)}
              placeholder="0 = v nástupní zóně"
              disabled={busy}
            />
            <small>Vyplňte jen mimo nástupní zónu. Zákazník uvidí upozornění, že celková cena bude navýšena o tuto částku (po jeho slevě za počet jízd).</small>
          </label>
          <button
            className="driver-secondary-action"
            type="button"
            onClick={() => onReject(ride)}
            disabled={busy}
          >
            Přeskočit
          </button>
          <button
            className="driver-primary-action"
            type="button"
            onClick={() => onAccept(ride, Number(etaMinutes), feeValue > 0 ? feeValue : null)}
            disabled={busy || !canSubmitOffer}
          >
            {busy ? 'Odesílám…' : feeValue > 0 ? 'Přijmout a odeslat čas + přistavení' : 'Přijmout a odeslat čas'}
          </button>
        </div>
      )}
    </article>
  )
}

export default function DriverApp() {
  const [driver, setDriver] = useState(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [availableRides, setAvailableRides] = useState([])
  const [assignedRides, setAssignedRides] = useState([])
  const [last30DaysStats, setLast30DaysStats] = useState(null)
  const [driverStats, setDriverStats] = useState([])
  const [ownerTab, setOwnerTab] = useState('overview')
  const [reportFrom, setReportFrom] = useState(() => {
    const today = new Date()
    return toDateInput(new Date(today.getFullYear(), today.getMonth(), 1))
  })
  const [reportTo, setReportTo] = useState(() => toDateInput(new Date()))
  const [report, setReport] = useState(null)
  const [customers, setCustomers] = useState(null)
  const [tierDrafts, setTierDrafts] = useState([])
  const [customerSearch, setCustomerSearch] = useState('')
  const [error, setError] = useState('')
  const [isReportLoading, setIsReportLoading] = useState(false)

  const loadReport = useCallback(async (from, to) => {
    if (!from || !to || to < from) {
      setError('Datum „Do“ nesmí být před datem „Od“.')
      return
    }
    setIsReportLoading(true)
    setError('')
    try {
      const start = new Date(`${from}T00:00:00`)
      const end = new Date(`${to}T00:00:00`)
      end.setDate(end.getDate() + 1)
      const query = new URLSearchParams({ from: start.toISOString(), to: end.toISOString() })
      setReport({ ...(await readJson(await fetch(`/api/driver/completed-rides?${query}`))), from, to })
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : 'Report se nepodařilo načíst.')
    } finally {
      setIsReportLoading(false)
    }
  }, [])

  const loadCustomers = useCallback(async () => {
    try {
      const [result, tiersResult] = await Promise.all([
        readJson(await fetch('/api/driver/customers')),
        readJson(await fetch('/api/driver/discount-tiers')),
      ])
      setCustomers(result.customers)
      setTierDrafts(tiersResult.tiers.map(({ rides, percent }) => ({ rides: String(rides), percent: String(percent) })))
    } catch (customersError) {
      setError(customersError instanceof Error ? customersError.message : 'Zákazníky se nepodařilo načíst.')
    }
  }, [])

  const saveTiers = async (event) => {
    event.preventDefault()
    setError('')
    setNotice('')
    try {
      const result = await readJson(await fetch('/api/driver/discount-tiers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tiers: tierDrafts.map(({ rides, percent }) => ({ rides: Number(rides), percent: Number(percent) })) }),
      }))
      setTierDrafts(result.tiers.map(({ rides, percent }) => ({ rides: String(rides), percent: String(percent) })))
      setNotice('Slevy podle počtu jízd byly uloženy.')
    } catch (tiersError) {
      setError(tiersError instanceof Error ? tiersError.message : 'Slevy se nepodařilo uložit.')
    }
  }

  useEffect(() => {
    if (driver?.id !== 'driver-owner' || ownerTab !== 'customers') return undefined
    const timer = window.setTimeout(() => void loadCustomers(), 0)
    return () => window.clearTimeout(timer)
  }, [driver, ownerTab, loadCustomers])

  useEffect(() => {
    if (driver?.id !== 'driver-owner' || ownerTab !== 'rides') return undefined
    const timer = window.setTimeout(() => void loadReport(reportFrom, reportTo), 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driver, ownerTab, loadReport])
  const [priceKm, setPriceKm] = useState('10')
  const [pricing, setPricing] = useState(DEFAULT_PRICING)
  const [pricingForm, setPricingForm] = useState({ boardingFeeCzk: '', pricePerKmCzk: '' })
  const [isPricingSaving, setIsPricingSaving] = useState(false)

  useEffect(() => {
    if (driver?.id !== 'driver-owner' || ownerTab !== 'price') return undefined
    const controller = new AbortController()
    fetch('/api/pricing', { signal: controller.signal })
      .then((response) => response.json())
      .then((result) => {
        setPricing(result)
        setPricingForm({ boardingFeeCzk: String(result.boardingFeeCzk), pricePerKmCzk: String(result.pricePerKmCzk) })
      })
      .catch(() => {})
    return () => controller.abort()
  }, [driver, ownerTab])

  const savePricing = async (event) => {
    event.preventDefault()
    setIsPricingSaving(true)
    setError('')
    setNotice('')
    try {
      const result = await readJson(await fetch('/api/driver/pricing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boardingFeeCzk: pricingForm.boardingFeeCzk.replace(',', '.'),
          pricePerKmCzk: pricingForm.pricePerKmCzk.replace(',', '.'),
        }),
      }))
      setPricing(result)
      setNotice('Ceník byl uložen. Zákazníci ho uvidí hned.')
    } catch (pricingError) {
      setError(pricingError instanceof Error ? pricingError.message : 'Ceník se nepodařilo uložit.')
    } finally {
      setIsPricingSaving(false)
    }
  }
  const [employeeName, setEmployeeName] = useState('')
  const [employeeCode, setEmployeeCode] = useState('')
  const [employeePlate, setEmployeePlate] = useState('')
  const [employeeCarName, setEmployeeCarName] = useState('')
  const [isEmployeeSubmitting, setIsEmployeeSubmitting] = useState(false)
  const [employees, setEmployees] = useState([])
  const [editingEmployee, setEditingEmployee] = useState(null)
  const [createdPasswords, setCreatedPasswords] = useState({})
  const [isCheckingSession, setIsCheckingSession] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [busyRideId, setBusyRideId] = useState('')
  const [notice, setNotice] = useState('')
  const [lastUpdated, setLastUpdated] = useState('')
  const [notificationPermission, setNotificationPermission] = useState(
    () => (isNativeApp() ? 'default' : 'Notification' in window ? window.Notification.permission : 'unsupported'),
  )
  const notifiedRideIds = useRef(new Set())

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/driver/session', { signal: controller.signal })
      .then(readJson)
      .then(({ driver: currentDriver }) => {
        setDriver(currentDriver)
        setError('')
      })
      .catch((sessionError) => {
        if (controller.signal.aborted) return
        setError(sessionError instanceof Error ? sessionError.message : 'Stav přihlášení se nepodařilo ověřit.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsCheckingSession(false)
      })
    return () => controller.abort()
  }, [])

  const refreshRides = useCallback(async () => {
    try {
      const result = await readJson(await fetch('/api/driver/rides'))
      const freshRides = result.available.filter((ride) => !notifiedRideIds.current.has(ride.id))
      for (const ride of freshRides) notifiedRideIds.current.add(ride.id)
      if (notificationPermission === 'granted' && !isNativeApp()) {
        for (const ride of freshRides) {
          const notification = new window.Notification('Nová objednávka – Taxi Koblížek', {
            body: `${ride.pickup} → ${ride.destination} · ${ride.amountCzk} Kč`,
            icon: '/taxi-koblizek-logo.png',
            tag: `ride-${ride.id}`,
          })
          notification.onclick = () => {
            window.focus()
            notification.close()
          }
        }
      }
      setAvailableRides(result.available)
      setAssignedRides(result.assigned)
      if (driver?.id === 'driver-owner') {
        const stats = await readJson(await fetch('/api/driver/stats'))
        setLast30DaysStats(stats.last30Days)
        setDriverStats(stats.drivers ?? [])
      } else {
        setLast30DaysStats(null)
        setDriverStats([])
      }
      setLastUpdated(new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }))
      setError('')
    } catch (loadError) {
      if (loadError instanceof Error && loadError.message.includes('Přihlášení vypršelo')) {
        setDriver(null)
        setAvailableRides([])
        setAssignedRides([])
      } else {
        setError(loadError instanceof Error ? loadError.message : 'Jízdy se nepodařilo načíst.')
      }
    }
  }, [driver, notificationPermission])

  useEffect(() => {
    if (driver && (notificationPermission === 'granted' || isNativeApp())) void subscribeToPush('driver').catch(() => {})
  }, [driver, notificationPermission])

  useEffect(() => {
    if (!driver) return undefined
    const initialRefresh = window.setTimeout(() => void refreshRides(), 0)
    const interval = window.setInterval(() => void refreshRides(), 5000)
    return () => {
      window.clearTimeout(initialRefresh)
      window.clearInterval(interval)
    }
  }, [driver, refreshRides])

  useEffect(() => {
    if (driver?.id !== 'driver-owner' || ownerTab !== 'employees') return undefined
    const controller = new AbortController()
    fetch('/api/driver/employees', { signal: controller.signal })
      .then(readJson)
      .then((result) => setEmployees(result.employees ?? []))
      .catch(() => {})
    return () => controller.abort()
  }, [driver, ownerTab])

  const signIn = async (event) => {
    event.preventDefault()
    setIsSubmitting(true)
    setError('')
    setNotice('')
    try {
      const result = await readJson(await fetch('/api/driver/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }))
      setDriver(result.driver)
      setPassword('')
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Přihlášení se nepodařilo.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const addEmployee = async (event) => {
    event.preventDefault()
    setIsEmployeeSubmitting(true)
    setError('')
    setNotice('')
    try {
      const result = await readJson(await fetch('/api/driver/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: employeeName, code: employeeCode, plate: employeePlate, carName: employeeCarName }),
      }))
      setEmployees((current) => [...current, result.employee])
      setCreatedPasswords((current) => ({ ...current, [result.employee.id]: employeeCode }))
      setEmployeeName('')
      setEmployeeCode('')
      setEmployeePlate('')
      setEmployeeCarName('')
      setNotice('Účet byl vytvořen. Zaměstnanec se může přihlásit v řidičské aplikaci svým jménem a heslem.')
    } catch (employeeError) {
      setError(employeeError instanceof Error ? employeeError.message : 'Účet zaměstnance se nepodařilo vytvořit.')
    } finally {
      setIsEmployeeSubmitting(false)
    }
  }

  const removeEmployee = async (employee) => {
    if (!window.confirm(`Opravdu odebrat účet „${employee.name}“?`)) return
    setError('')
    setNotice('')
    try {
      await readJson(await fetch(`/api/driver/employees/${encodeURIComponent(employee.id)}`, { method: 'DELETE' }))
      setEmployees((current) => current.filter(({ id }) => id !== employee.id))
      setNotice(`Účet „${employee.name}“ byl odebrán.`)
    } catch (employeeError) {
      setError(employeeError instanceof Error ? employeeError.message : 'Účet se nepodařilo odebrat.')
    }
  }

  const startEditEmployee = (employee) => {
    setEditingEmployee({ id: employee.id, name: employee.name, plate: employee.plate ?? '', carName: employee.carName ?? '', code: '' })
    setError('')
    setNotice('')
  }

  const saveEmployee = async (event) => {
    event.preventDefault()
    setError('')
    setNotice('')
    try {
      const result = await readJson(await fetch(`/api/driver/employees/${encodeURIComponent(editingEmployee.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editingEmployee.name, code: editingEmployee.code, plate: editingEmployee.plate, carName: editingEmployee.carName }),
      }))
      setEmployees((current) => current.map((item) => (item.id === result.employee.id ? result.employee : item)))
      if (editingEmployee.code) {
        setCreatedPasswords((current) => ({ ...current, [result.employee.id]: editingEmployee.code }))
      }
      setEditingEmployee(null)
      setNotice('Účet byl upraven.')
    } catch (employeeError) {
      setError(employeeError instanceof Error ? employeeError.message : 'Účet se nepodařilo upravit.')
    }
  }

  const enableNotifications = async () => {
    if (isNativeApp()) {
      try {
        const ok = await requestNativePermission('driver')
        setNotificationPermission(ok ? 'granted' : 'denied')
        setNotice(ok ? 'Oznámení o nových objednávkách jsou zapnutá.' : 'Oznámení se nepodařilo zapnout. Povolte je v nastavení telefonu.')
      } catch (nativeError) {
        console.error('Nepodařilo se zapnout oznámení:', nativeError)
        setNotice('Oznámení se nepodařilo zapnout.')
      }
      return
    }
    if (!('Notification' in window)) {
      setNotice('Tento prohlížeč nepodporuje oznámení. Nechte aplikaci otevřenou, nové jízdy se zobrazí automaticky.')
      setNotificationPermission('unsupported')
      return
    }
    try {
      const permission = await window.Notification.requestPermission()
      setNotificationPermission(permission)
      if (permission === 'granted') {
        const subscribed = await subscribeToPush('driver').catch(() => false)
        setNotice(subscribed
          ? 'Oznámení o nových objednávkách jsou zapnutá, přijdou i při zavřené aplikaci.'
          : 'Oznámení jsou zapnutá, ale jen při otevřené aplikaci (vyžaduje HTTPS).')
      } else {
        setNotice('Oznámení jsou zablokovaná. Povolte je v nastavení prohlížeče.')
      }
    } catch (permissionError) {
      console.error('Nepodařilo se zapnout oznámení:', permissionError)
      setNotice('Oznámení se nepodařilo zapnout. Zkontrolujte oprávnění prohlížeče a připojení HTTPS.')
    }
  }

  const signOut = async () => {
    setError('')
    try {
      const response = await fetch('/api/driver/logout', { method: 'POST' })
      if (!response.ok) throw new Error('Odhlášení se nepodařilo. Zkuste to znovu.')
      setDriver(null)
      setAvailableRides([])
      setAssignedRides([])
      setNotice('Byli jste odhlášeni.')
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : 'Odhlášení se nepodařilo.')
    }
  }

  const performRideAction = async (ride, action, payload, successMessage) => {
    setBusyRideId(ride.id)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`/api/driver/rides/${encodeURIComponent(ride.id)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload ? JSON.stringify(payload) : undefined,
      })
      const result = await readJson(response)
      const actionNotice = action === 'reject' && result.rejectedForEveryone
        ? 'Všichni řidiči objednávku přeskočili. Zákazník bude upozorněn.'
        : successMessage
      setNotice(result.notificationWarning ? `${actionNotice} ${result.notificationWarning}` : actionNotice)
      await refreshRides()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Změnu se nepodařilo uložit.')
      await refreshRides()
    } finally {
      setBusyRideId('')
    }
  }

  return (
    <main className="driver-app-shell">
      <header className="driver-app-header">
        <a className="driver-brand" href="/" aria-label="Taxi Koblížek – zákaznická aplikace">
          <span><strong>Taxi Koblížek</strong><small>Řidičská aplikace</small></span>
        </a>
        {driver && (
          <div className="driver-account">
            <span>{driver.name}</span>
            <button type="button" onClick={signOut}>Odhlásit</button>
          </div>
        )}
      </header>

      {isCheckingSession ? (
        <p className="driver-loading">Ověřuji přihlášení…</p>
      ) : !driver ? (
        <section className="driver-login-panel">
          <p className="driver-eyebrow">Taxi Koblížek</p>
          <h1>Přihlášení řidiče</h1>
          <p className="driver-login-intro">Přihlaste se jménem a kódem, které vám dal majitel. Novou jízdu získá řidič, který ji přijme jako první.</p>
          <form className="driver-login-form" onSubmit={signIn}>
            <label>
              <span>Jméno / uživatelské jméno</span>
              <input
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                required
                spellCheck={false}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            <label>
              <span>Heslo / přihlašovací kód</span>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button className="driver-primary-action" type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Přihlašuji…' : 'Přihlásit se'}
            </button>
          </form>
          {error && <p className="driver-error" role="alert">{error}</p>}
          {notice && <p className="driver-notice" role="status">{notice}</p>}
          <a className="driver-back-link" href="/">Zpět na přihlášení zákazníka</a>
        </section>
      ) : (
        <section className="driver-dashboard">
          <div className="driver-welcome">
            <div className="driver-welcome-top">
              <p className="driver-eyebrow">Řidičský panel</p>
              <span className="driver-online"><span />Přihlášen: {driver.name}</span>
            </div>
            <h1>Vítejte, {driver.name.split(' ')[0]}!</h1>
            <p>Všechny vaše jízdy a nové objednávky přehledně na jednom místě.</p>
            <button className="driver-hero-refresh" type="button" onClick={() => void refreshRides()}>
              <span aria-hidden="true">↻</span> Obnovit objednávky
            </button>
          </div>
            {driver.id === 'driver-owner' && ownerTab === 'price' ? (
              <section className="driver-owner-stats driver-price">
                <p className="driver-eyebrow">Ceník</p>
                <h2>Cena jízdy</h2>
                <p className="driver-owner-stats-intro">Cenu zákazníkovi spočítá aplikace automaticky podle délky trasy.</p>
                <div className="driver-owner-stats-grid">
                  <article className="driver-owner-stat-card">
                    <span>Nástupné</span>
                    <strong>{pricing.boardingFeeCzk} Kč</strong>
                  </article>
                  <article className="driver-owner-stat-card">
                    <span>Cena za km</span>
                    <strong>{pricing.pricePerKmCzk} Kč</strong>
                  </article>
                </div>
                <h3 className="driver-employee-list-title">Upravit ceník</h3>
                <form className="driver-login-form" onSubmit={savePricing}>
                  <label>
                    <span>Nástupné (Kč)</span>
                    <input
                      inputMode="decimal"
                      required
                      value={pricingForm.boardingFeeCzk}
                      onChange={(event) => setPricingForm({ ...pricingForm, boardingFeeCzk: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>Cena za km (Kč)</span>
                    <input
                      inputMode="decimal"
                      required
                      value={pricingForm.pricePerKmCzk}
                      onChange={(event) => setPricingForm({ ...pricingForm, pricePerKmCzk: event.target.value })}
                    />
                  </label>
                  <button className="driver-primary-action" type="submit" disabled={isPricingSaving}>
                    {isPricingSaving ? 'Ukládám…' : 'Uložit ceník'}
                  </button>
                </form>
                {error && <p className="driver-error" role="alert">{error}</p>}
                {notice && <p className="driver-notice" role="status">{notice}</p>}
                <h3 className="driver-employee-list-title">Spočítat cenu</h3>
                <label className="driver-price-calc">
                  <span>Vzdálenost (km)</span>
                  <input
                    inputMode="decimal"
                    value={priceKm}
                    onChange={(event) => setPriceKm(event.target.value.replace(',', '.'))}
                    placeholder="např. 12.5"
                  />
                </label>
                <div className="driver-price-result" role="status">
                  {Number.isFinite(Number(priceKm)) && priceKm.trim() !== '' && Number(priceKm) >= 0
                    ? <>Cena jízdy: <strong>{calculateRidePrice(Number(priceKm), pricing).toLocaleString('cs-CZ')} Kč</strong></>
                    : 'Zadejte vzdálenost v km.'}
                </div>
                <p className="driver-owner-stat-caption">Cena = nástupné + vzdálenost × cena za km, zaokrouhleno na celé koruny.</p>
              </section>
            ) : driver.id === 'driver-owner' && ownerTab === 'employees' ? (
              <section className="driver-owner-stats driver-employees">
                <p className="driver-eyebrow">Tým</p>
                <h2>Zaměstnanci</h2>
                <p className="driver-owner-stats-intro">Zadejte jméno a heslo. Podle nich se zaměstnanec přihlásí do řidičské aplikace.</p>
                <form className="driver-login-form" onSubmit={addEmployee}>
                  <label>
                    <span>Jméno</span>
                    <input
                      autoComplete="off"
                      maxLength={60}
                      minLength={2}
                      required
                      value={employeeName}
                      onChange={(event) => setEmployeeName(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>Heslo</span>
                    <input
                      autoComplete="new-password"
                      minLength={4}
                      required
                      type="password"
                      value={employeeCode}
                      onChange={(event) => setEmployeeCode(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>Název auta (např. Škoda Octavia bílá)</span>
                    <input
                      autoComplete="off"
                      maxLength={40}
                      placeholder="např. Škoda Octavia"
                      value={employeeCarName}
                      onChange={(event) => setEmployeeCarName(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>SPZ vozidla (zákazník ji uvidí po přijetí jízdy)</span>
                    <input
                      autoComplete="off"
                      maxLength={15}
                      placeholder="např. 1AB 2345"
                      value={employeePlate}
                      onChange={(event) => setEmployeePlate(event.target.value)}
                    />
                  </label>
                  <button className="driver-primary-action" type="submit" disabled={isEmployeeSubmitting}>
                    {isEmployeeSubmitting ? 'Vytvářím účet…' : 'Vytvořit přihlášení'}
                  </button>
                </form>
                {error && <p className="driver-error" role="alert">{error}</p>}
                {notice && <p className="driver-notice" role="status">{notice}</p>}
                <h3 className="driver-employee-list-title">Vytvořené účty</h3>
                {employees.length === 0 ? (
                  <p className="driver-owner-stat-caption">Zatím nebyl vytvořen žádný účet.</p>
                ) : (
                  <ul className="driver-employee-list">
                    {employees.map((employee) => (
                      editingEmployee?.id === employee.id ? (
                        <li key={employee.id}>
                          <form className="driver-employee-edit" onSubmit={saveEmployee}>
                            <input
                              aria-label="Jméno"
                              required
                              minLength={2}
                              maxLength={60}
                              value={editingEmployee.name}
                              onChange={(event) => setEditingEmployee({ ...editingEmployee, name: event.target.value })}
                            />
                            <input
                              aria-label="Název auta"
                              maxLength={40}
                              placeholder="Název auta"
                              value={editingEmployee.carName}
                              onChange={(event) => setEditingEmployee({ ...editingEmployee, carName: event.target.value })}
                            />
                            <input
                              aria-label="SPZ"
                              maxLength={15}
                              placeholder="SPZ vozidla"
                              value={editingEmployee.plate}
                              onChange={(event) => setEditingEmployee({ ...editingEmployee, plate: event.target.value })}
                            />
                            <input
                              aria-label="Nové heslo"
                              autoComplete="new-password"
                              minLength={4}
                              placeholder="Nové heslo (nechte prázdné pro zachování)"
                              value={editingEmployee.code}
                              onChange={(event) => setEditingEmployee({ ...editingEmployee, code: event.target.value })}
                            />
                            <div>
                              <button className="driver-primary-action" type="submit">Uložit</button>
                              <button className="driver-employee-remove" type="button" onClick={() => setEditingEmployee(null)}>Zrušit</button>
                            </div>
                          </form>
                        </li>
                      ) : (
                      <li key={employee.id}>
                        <strong>{employee.name}</strong>
                        <span>
                          Heslo: {createdPasswords[employee.id] ?? 'uloženo zabezpečeně, nelze zobrazit'}
                          {' · '}Auto: {employee.carName || 'nezadáno'}
                          {' · '}SPZ: {employee.plate || 'nezadána'}
                        </span>
                        <div className="driver-employee-actions">
                          <button className="driver-employee-edit-button" type="button" onClick={() => startEditEmployee(employee)}>
                            Upravit
                          </button>
                          <button className="driver-employee-remove" type="button" onClick={() => removeEmployee(employee)}>
                            Odebrat
                          </button>
                        </div>
                      </li>
                      )
                    ))}
                  </ul>
                )}
              </section>
            ) : driver.id === 'driver-owner' && ownerTab === 'customers' ? (
              <section className="driver-report" aria-label="Přehled zákazníků">
                <p className="driver-eyebrow">Všichni zákazníci</p>
                <h2>Přehled zákazníků</h2>
                <form className="driver-tier-form" onSubmit={saveTiers}>
                  <h3>Automatické slevy za jízdy (posledních 90 dní)</h3>
                  {tierDrafts.map((tier, index) => (
                    <div className="driver-tier-row" key={index}>
                      <input
                        aria-label="Počet jízd"
                        type="number"
                        required
                        min="1"
                        max="1000"
                        value={tier.rides}
                        onChange={(event) => setTierDrafts(tierDrafts.map((item, i) => (i === index ? { ...item, rides: event.target.value } : item)))}
                      />
                      <span>jízd →</span>
                      <input
                        aria-label="Sleva v procentech"
                        type="number"
                        required
                        min="1"
                        max="90"
                        value={tier.percent}
                        onChange={(event) => setTierDrafts(tierDrafts.map((item, i) => (i === index ? { ...item, percent: event.target.value } : item)))}
                      />
                      <span>%</span>
                      <button className="driver-employee-remove" type="button" onClick={() => setTierDrafts(tierDrafts.filter((_item, i) => i !== index))}>Odebrat</button>
                    </div>
                  ))}
                  <div className="driver-report-actions">
                    <button
                      className="driver-secondary-action"
                      type="button"
                      disabled={tierDrafts.length >= 10}
                      onClick={() => setTierDrafts([...tierDrafts, { rides: '', percent: '' }])}
                    >
                      + Přidat stupeň
                    </button>
                    <button className="driver-primary-action" type="submit">Uložit slevy</button>
                  </div>
                </form>
                <input
                  className="driver-customer-search"
                  type="search"
                  placeholder="Hledat jméno nebo telefon"
                  value={customerSearch}
                  onChange={(event) => setCustomerSearch(event.target.value)}
                />
                {error && <p className="driver-error" role="alert">{error}</p>}
                {notice && <p className="driver-notice" role="status">{notice}</p>}
                {customers === null ? (
                  <p className="driver-empty">Načítám…</p>
                ) : (() => {
                  const term = customerSearch.trim().toLocaleLowerCase('cs-CZ')
                  const visible = customers.filter((customer) => !term
                    || (customer.name ?? '').toLocaleLowerCase('cs-CZ').includes(term)
                    || customer.phone.replace(/\s/g, '').includes(term.replace(/\s/g, '')))
                  return visible.length === 0 ? (
                    <p className="driver-empty">Žádní zákazníci.</p>
                  ) : (
                    <ul className="driver-report-list">
                      {visible.map((customer) => (
                        <li key={customer.phone} className="driver-report-item">
                          <div className="driver-report-item-head">
                            <strong>{customer.name || 'Bez jména'}</strong>
                            <a href={`tel:${customer.phone}`}>{formatPhone(customer.phone)}</a>
                          </div>
                          <p>{customer.completedRides} dokončených jízd z {customer.totalRides} objednávek</p>
                          <small>
                            {customer.distanceKm.toLocaleString('cs-CZ')} km · {customer.spentCzk.toLocaleString('cs-CZ')} Kč · naposledy {formatDateTime(customer.lastRideAt)}
                          </small>
                        </li>
                      ))}
                    </ul>
                  )
                })()}
              </section>
            ) : driver.id === 'driver-owner' && ownerTab === 'rides' ? (
              <section className="driver-report" aria-label="Provedené jízdy">
                <p className="driver-eyebrow">Všichni zaměstnanci</p>
                <h2>Provedené jízdy</h2>
                <form
                  className="driver-report-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void loadReport(reportFrom, reportTo)
                  }}
                >
                  <label>
                    <span>Od</span>
                    <input type="date" required value={reportFrom} max={reportTo || undefined} onChange={(event) => setReportFrom(event.target.value)} />
                  </label>
                  <label>
                    <span>Do</span>
                    <input type="date" required value={reportTo} min={reportFrom || undefined} onChange={(event) => setReportTo(event.target.value)} />
                  </label>
                  <button className="driver-primary-action" type="submit" disabled={isReportLoading}>
                    {isReportLoading ? 'Načítám…' : 'Vytvořit report'}
                  </button>
                </form>
                {error && <p className="driver-error" role="alert">{error}</p>}
                {report && (
                  <>
                    <div className="driver-report-summary">
                      <h3>Report {formatDateOnly(report.from)} – {formatDateOnly(report.to)}</h3>
                      <div className="driver-owner-stats-grid">
                        <article className="driver-owner-stat-card"><span>Jízd</span><strong>{report.totals.count}</strong></article>
                        <article className="driver-owner-stat-card"><span>Ujeto</span><strong>{report.totals.distanceKm.toLocaleString('cs-CZ')} km</strong></article>
                        <article className="driver-owner-stat-card"><span>Tržby</span><strong>{report.totals.revenueCzk.toLocaleString('cs-CZ')} Kč</strong></article>
                      </div>
                      {report.rides.length > 0 && (
                        <table className="driver-report-table">
                          <thead>
                            <tr><th>Řidič</th><th>Jízd</th><th>Km</th><th>Tržby</th></tr>
                          </thead>
                          <tbody>
                            {Object.values(report.rides.reduce((groups, ride) => {
                              const group = groups[ride.driverId] ?? { name: ride.driverName, plate: ride.driverPlate, count: 0, km: 0, revenue: 0 }
                              group.count += 1
                              group.km += ride.distanceKm
                              group.revenue += ride.amountCzk
                              groups[ride.driverId] = group
                              return groups
                            }, {})).map((group) => (
                              <tr key={`${group.name}-${group.plate}`}>
                                <td>{group.name}{group.plate ? ` · ${group.plate}` : ''}</td>
                                <td>{group.count}</td>
                                <td>{(Math.round(group.km * 10) / 10).toLocaleString('cs-CZ')}</td>
                                <td>{group.revenue.toLocaleString('cs-CZ')} Kč</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                    {report.rides.length > 0 && (
                      <div className="driver-report-actions">
                        <button className="driver-secondary-action" type="button" onClick={() => downloadRidesCsv(report.rides, report.from, report.to)}>Stáhnout CSV</button>
                        <button className="driver-secondary-action" type="button" onClick={() => window.print()}>Tisk / PDF</button>
                      </div>
                    )}
                    {report.rides.length === 0 ? (
                      <p className="driver-empty">V tomto období nejsou žádné provedené jízdy.</p>
                    ) : (
                      <ul className="driver-report-list">
                        {report.rides.map((ride) => (
                          <li key={ride.id} className="driver-report-item">
                            <div className="driver-report-item-head">
                              <strong>{ride.amountCzk.toLocaleString('cs-CZ')} Kč</strong>
                              <span>{formatDateTime(ride.completedAt)}</span>
                            </div>
                            <p>{ride.pickup} → {ride.destination}</p>
                            <small>
                              {ride.driverName}{ride.driverPlate ? ` · ${ride.driverPlate}` : ''} · {ride.distanceKm.toLocaleString('cs-CZ')} km · {ride.paymentMethod === 'card' ? 'Karta' : 'Hotově'}
                            </small>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </section>
            ) : driver.id === 'driver-owner' && ownerTab === 'stats' ? (
              <section className="driver-owner-stats">
                <p className="driver-eyebrow">Přehled podnikání</p>
                <h2>Výsledky za posledních 30 dní</h2>
                <p className="driver-owner-stats-intro">Statistiky zahrnují dokončené jízdy všech řidičů.</p>
                <div className="driver-owner-stats-grid">
                  <article className="driver-owner-stat-card">
                    <span>Tržby celkem (30 dní)</span>
                    <strong>{last30DaysStats ? `${last30DaysStats.revenueCzk.toLocaleString('cs-CZ')} Kč` : '…'}</strong>
                  </article>
                  <article className="driver-owner-stat-card">
                    <span>Jízdy celkem</span>
                    <strong>{last30DaysStats?.completedRides ?? '…'}</strong>
                  </article>
                </div>
                <h3 className="driver-employee-list-title">Podle účtů (za 30 dní)</h3>
                {driverStats.length === 0 ? (
                  <p className="driver-owner-stat-caption">Zatím žádné účty.</p>
                ) : (
                  <ul className="driver-account-stats">
                    {driverStats.map((account) => {
                      const share = last30DaysStats?.revenueCzk
                        ? Math.min(100, Math.round((account.revenueCzk / last30DaysStats.revenueCzk) * 100))
                        : 0
                      return (
                        <li key={account.id} className="driver-account-card">
                          <div className="driver-account-head">
                            <span className="driver-account-avatar" aria-hidden="true">
                              {account.name.trim().charAt(0).toLocaleUpperCase('cs-CZ')}
                            </span>
                            <div>
                              <strong>{account.name}</strong>
                              <small>{account.id === 'driver-owner' ? 'Majitel firmy' : 'Zaměstnanec'}</small>
                            </div>
                            {account.plate && <span className="driver-account-plate">{account.plate}</span>}
                          </div>
                          <div className="driver-account-numbers">
                            <div>
                              <span>Jízd</span>
                              <strong>{account.completedRides}</strong>
                            </div>
                            <div>
                              <span>Ujeto</span>
                              <strong>{account.distanceKm.toLocaleString('cs-CZ')} km</strong>
                            </div>
                            <div>
                              <span>Vydělal</span>
                              <strong>{account.revenueCzk.toLocaleString('cs-CZ')} Kč</strong>
                            </div>
                            <div>
                              <span>Ø za jízdu</span>
                              <strong>
                                {account.completedRides
                                  ? `${Math.round(account.revenueCzk / account.completedRides).toLocaleString('cs-CZ')} Kč`
                                  : '–'}
                              </strong>
                            </div>
                          </div>
                          <div className="driver-account-bar" role="img" aria-label={`Podíl na tržbách ${share} %`}>
                            <span style={{ width: `${share}%` }} />
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
                <p className="driver-owner-stat-caption">Tržby jsou součtem cen dokončených jízd, nejde o čistý zisk.</p>
              </section>
            ) : (
              <>
            <div className="driver-summary-grid">
              <article className="driver-summary-card summary-new">
              <span className="driver-summary-icon" aria-hidden="true">↗</span>
              <span>Nové objednávky</span>
              <strong>{availableRides.length}</strong>
            </article>
            <article className="driver-summary-card summary-active">
              <span className="driver-summary-icon" aria-hidden="true">⌖</span>
              <span>Moje aktivní jízdy</span>
              <strong>{assignedRides.filter((ride) => ride.status !== 'completed').length}</strong>
            </article>
          </div>
          <p className="driver-refresh-hint">
            Automatická aktualizace každých 5 sekund.
            {lastUpdated && ` Naposledy aktualizováno v ${lastUpdated}.`}
          </p>
          {notificationPermission === 'unsupported' && (
            <p className="driver-refresh-hint">Oznámení prohlížeče vyžadují HTTPS; nové objednávky se zobrazí v aplikaci každých 5 sekund.</p>
          )}
          {notificationPermission !== 'granted' && notificationPermission !== 'unsupported' && (
            <button className="driver-notification-button" type="button" onClick={() => void enableNotifications()}>
              {notificationPermission === 'denied' ? 'Oznámení jsou blokovaná — povolte je v prohlížeči' : 'Zapnout oznámení o nových objednávkách'}
            </button>
          )}
          {error && <p className="driver-error" role="alert">{error}</p>}
          {notice && <p className="driver-notice" role="status">{notice}</p>}

          <div className="driver-section-heading">
            <div>
              <h2>Nové objednávky</h2>
              <p>Vyberte jízdu, kterou chcete přijmout.</p>
            </div>
            <span>{availableRides.length}</span>
          </div>
          {availableRides.length ? (
            <div className="driver-ride-list">
              {availableRides.map((ride) => (
                <RideCard
                  key={ride.id}
                  ride={ride}
                  busy={busyRideId === ride.id}
                  onAccept={(item, minutes, pickupFee) => void performRideAction(
                    item,
                    'accept',
                    pickupFee ? { etaMinutes: minutes, outsidePickupZone: true, pickupFeeCzk: pickupFee } : { etaMinutes: minutes, outsidePickupZone: false },
                    pickupFee
                      ? `Čas a přistavení vozidla ${pickupFee} Kč (před slevou zákazníka) byly odeslány zákazníkovi. Jízda je vaše, jakmile je potvrdí.`
                      : 'Čas příjezdu byl odeslán zákazníkovi. Jízda je vaše, jakmile ho potvrdí.',
                  )}
                  onReject={(item) => void performRideAction(item, 'reject', null, 'Objednávka byla skryta z vašich volných jízd.')}
                />
              ))}
            </div>
          ) : (
            <p className="driver-empty-state">Zatím nejsou žádné volné jízdy. Nové objednávky se zobrazí automaticky.</p>
          )}

          {assignedRides.some((ride) => ride.status !== 'completed') && (
            <div className="driver-ride-list">
              {assignedRides.filter((ride) => ride.status !== 'completed').map((ride) => (
                <RideCard
                  key={ride.id}
                  ride={ride}
                  assigned
                  busy={busyRideId === ride.id}
                  onAdvance={(item, status) => void performRideAction(item, 'status', { status }, `Stav jízdy: ${statusLabels[status]}.`)}
                />
              ))}
            </div>
          )}
            </>
          )}
          {driver.id === 'driver-owner' && (
            <nav className="driver-bottom-nav" aria-label="Navigace majitelského panelu">
              <button
                className={`driver-bottom-nav-item${ownerTab === 'overview' ? ' active' : ''}`}
                type="button"
                aria-current={ownerTab === 'overview' ? 'page' : undefined}
                onClick={() => setOwnerTab('overview')}
              >
                <span aria-hidden="true">⌂</span>
                Přehled
              </button>
              <button
                className={`driver-bottom-nav-item${ownerTab === 'customers' ? ' active' : ''}`}
                type="button"
                aria-current={ownerTab === 'customers' ? 'page' : undefined}
                onClick={() => setOwnerTab('customers')}
              >
                <span aria-hidden="true">👥</span>
                Zákazníci
              </button>
              <button
                className={`driver-bottom-nav-item${ownerTab === 'rides' ? ' active' : ''}`}
                type="button"
                aria-current={ownerTab === 'rides' ? 'page' : undefined}
                onClick={() => setOwnerTab('rides')}
              >
                <span aria-hidden="true">🧾</span>
                Jízdy
              </button>
              <button
                className={`driver-bottom-nav-item${ownerTab === 'employees' ? ' active' : ''}`}
                type="button"
                aria-current={ownerTab === 'employees' ? 'page' : undefined}
                onClick={() => setOwnerTab('employees')}
              >
                <span aria-hidden="true">👥</span>
                Zaměstnanci
              </button>
              <button
                className={`driver-bottom-nav-item${ownerTab === 'price' ? ' active' : ''}`}
                type="button"
                aria-current={ownerTab === 'price' ? 'page' : undefined}
                onClick={() => setOwnerTab('price')}
              >
                <span aria-hidden="true">💰</span>
                Cena
              </button>
            </nav>
          )}
        </section>
      )}
    </main>
  )
}
