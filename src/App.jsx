import { useCallback, useEffect, useId, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'
import { DEFAULT_PRICING } from './priceCalculator.mjs'
import { isNativeApp, requestNativePermission, subscribeToPush } from './pushClient.js'
import DriverApp from './DriverApp.jsx'
import { fetchPlaceSuggestions } from './placeSearch.mjs'

const navItems = [
  { label: 'Objednat', icon: '⌖' },
  { label: 'Jízdy', icon: '↗' },
  { label: 'Platby', icon: '▤' },
  { label: 'Profil', icon: '◉' },
]

let lastGeocodingRequestAt = Number.NEGATIVE_INFINITY
let geocodingQueue = Promise.resolve()
const placeSuggestionCache = new Map()

function fetchGeocoding(url, signal) {
  const request = geocodingQueue.then(async () => {
    if (signal?.aborted) throw new DOMException('Vyhledávání bylo zrušeno.', 'AbortError')
    const delay = Math.max(0, 1000 - (performance.now() - lastGeocodingRequestAt))
    if (delay > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', abort)
          resolve()
        }, delay)
        const abort = () => {
          clearTimeout(timer)
          reject(new DOMException('Vyhledávání bylo zrušeno.', 'AbortError'))
        }
        signal?.addEventListener('abort', abort, { once: true })
      })
    }
    if (signal?.aborted) throw new DOMException('Vyhledávání bylo zrušeno.', 'AbortError')
    lastGeocodingRequestAt = performance.now()

    try {
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
        : AbortSignal.timeout(12000)
      return await fetch(url, {
        headers: { 'Accept-Language': 'cs' },
        signal: requestSignal,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new Error('Vyhledávání adresy vypršelo. Zkuste to prosím znovu.')
      }
      throw new Error('Nepodařilo se spojit se službou adres. Zkontrolujte připojení a zkuste to znovu.')
    }
  })
  geocodingQueue = request.then(() => undefined, () => undefined)
  return request
}

function AddressAutocomplete({ value, onChange, onSelect, label, disabled, className = '' }) {
  const id = useId()
  const [isOpen, setIsOpen] = useState(false)
  const [suggestions, setSuggestions] = useState([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const blurTimerRef = useRef(null)
  const searchDebounceTimerRef = useRef(null)
  const searchRequestIdRef = useRef(0)
  const searchControllerRef = useRef(null)

  const searchAddresses = async (searchValue = value) => {
    clearTimeout(searchDebounceTimerRef.current)
    searchDebounceTimerRef.current = null
    const query = searchValue.trim()
    searchControllerRef.current?.abort()
    searchControllerRef.current = null
    const requestId = ++searchRequestIdRef.current

    if (query.length < 3) {
      setIsOpen(true)
      setSuggestions([])
      setIsSearching(false)
      setSearchError('Zadejte alespoň 3 znaky pro vyhledání adresy nebo místa přes Mapy.com.')
      return
    }

    const cacheKey = query.toLocaleLowerCase('cs-CZ')
    if (placeSuggestionCache.has(cacheKey)) {
      const cached = placeSuggestionCache.get(cacheKey)
      setSuggestions(cached)
      setIsSearching(false)
      setActiveIndex(0)
      setSearchError(cached.length ? '' : 'Mapy.com nenašly odpovídající adresu ani místo.')
      setIsOpen(true)
      return
    }

    const controller = new AbortController()
    searchControllerRef.current = controller
    setIsOpen(true)
    setIsSearching(true)
    setSuggestions([])
    setSearchError('')

    try {
      const found = await fetchPlaceSuggestions(query, controller.signal)
      if (requestId !== searchRequestIdRef.current || controller.signal.aborted) return
      placeSuggestionCache.set(cacheKey, found)
      if (placeSuggestionCache.size > 50) placeSuggestionCache.delete(placeSuggestionCache.keys().next().value)
      setSuggestions(found)
      if (found.length === 0) setSearchError('Mapy.com nenašly odpovídající adresu ani místo.')
      setActiveIndex(0)
    } catch (error) {
      if (requestId !== searchRequestIdRef.current || controller.signal.aborted) return
      setSuggestions([])
      setSearchError(error instanceof Error ? error.message : 'Vyhledávání přes Mapy.com se nepodařilo.')
    } finally {
      if (requestId === searchRequestIdRef.current) {
        searchControllerRef.current = null
        setIsSearching(false)
      }
    }
  }

  useEffect(() => () => {
    clearTimeout(blurTimerRef.current)
    clearTimeout(searchDebounceTimerRef.current)
    searchControllerRef.current?.abort()
  }, [])

  const selectSuggestion = (suggestion) => {
    clearTimeout(searchDebounceTimerRef.current)
    searchRequestIdRef.current += 1
    searchControllerRef.current?.abort()
    searchControllerRef.current = null
    onSelect(suggestion.address, { lat: suggestion.lat, lon: suggestion.lon })
    setSuggestions([])
    setIsSearching(false)
    setSearchError('')
    setIsOpen(false)
  }

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      clearTimeout(searchDebounceTimerRef.current)
      searchRequestIdRef.current += 1
      searchControllerRef.current?.abort()
      searchControllerRef.current = null
      setIsOpen(false)
      setSuggestions([])
      setIsSearching(false)
      setSearchError('')
      return
    }
    if (event.key === 'ArrowDown' && suggestions.length) {
      event.preventDefault()
      setActiveIndex((index) => (index + 1) % suggestions.length)
    } else if (event.key === 'ArrowUp' && suggestions.length) {
      event.preventDefault()
      setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length)
    } else if (event.key === 'Enter' && isOpen && suggestions.length) {
      event.preventDefault()
      selectSuggestion(suggestions[activeIndex] ?? suggestions[0])
    } else if (event.key === 'Enter' && value.trim().length >= 3) {
      event.preventDefault()
      void searchAddresses()
    }
  }

  return (
    <div className={`address-autocomplete address-field ${className}${isOpen && suggestions.length ? ' has-suggestions' : ''}`}>
      <span className={`route-indicator ${className.includes('destination') ? 'destination-indicator' : 'pickup-indicator'}`} />
      <span className="address-label">{label}</span>
      <input
        type="text"
        aria-label={label === 'Odkud' ? 'Místo vyzvednutí' : 'Cílová adresa'}
        aria-autocomplete="list"
        aria-expanded={isOpen && (isSearching || suggestions.length > 0 || Boolean(searchError))}
        aria-controls={`${id}-suggestions`}
        aria-activedescendant={isOpen && suggestions.length ? `${id}-option-${activeIndex}` : undefined}
        autoComplete="off"
        value={value}
        onFocus={() => {
          clearTimeout(blurTimerRef.current)
          if (suggestions.length || isSearching || searchError) setIsOpen(true)
        }}
        onBlur={() => {
          const wasWaitingToSearch = searchDebounceTimerRef.current !== null
          clearTimeout(searchDebounceTimerRef.current)
          searchDebounceTimerRef.current = null
          if (wasWaitingToSearch) setIsSearching(false)
          blurTimerRef.current = setTimeout(() => {
            setIsOpen(false)
          }, 120)
        }}
        onChange={(event) => {
          clearTimeout(searchDebounceTimerRef.current)
          searchDebounceTimerRef.current = null
          const nextValue = event.target.value
          searchRequestIdRef.current += 1
          searchControllerRef.current?.abort()
          searchControllerRef.current = null
          onChange(nextValue)
          setSuggestions([])
          setSearchError('')
          setActiveIndex(0)
          if (nextValue.trim().length >= 3) {
            setIsOpen(true)
            setIsSearching(true)
            searchDebounceTimerRef.current = setTimeout(() => {
              searchDebounceTimerRef.current = null
              void searchAddresses(nextValue)
            }, 400)
          } else {
            clearTimeout(searchDebounceTimerRef.current)
            setIsOpen(false)
            setIsSearching(false)
          }
        }}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        required
        placeholder="Adresa, nádraží, škola, podnik…"
      />
      {isOpen && (isSearching || suggestions.length > 0 || searchError) && (
        <div className="address-suggestions">
          {isSearching && (
            <div className="suggestion-message">
              {suggestions.length
                ? 'Hledám další shody přes Mapy.com…'
                : 'Hledám adresy a místa přes Mapy.com…'}
            </div>
          )}
          {!isSearching && searchError && <div className="suggestion-message">{searchError}</div>}
          {suggestions.length > 0 && (
            <div id={`${id}-suggestions`} role="listbox" aria-label={`Návrhy pro ${label}`}>
              {suggestions.map((suggestion, index) => (
                <button
                  className={`address-suggestion${index === activeIndex ? ' is-active' : ''}`}
                  id={`${id}-option-${index}`}
                  key={suggestion.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectSuggestion(suggestion)}
                >
                  <span className="suggestion-pin" aria-hidden="true">⌖</span>
                  <span className="suggestion-copy"><strong>{suggestion.address}</strong><small>{suggestion.type === 'place' ? 'Bod zájmu · Mapy.com' : 'Adresa nebo lokalita · Mapy.com'}</small></span>
                </button>
              ))}
            </div>
          )}
          {(isSearching || suggestions.length > 0 || searchError) && (
            <a className="mapy-attribution" href="https://mapy.com/" target="_blank" rel="noreferrer">
              <img src="https://api.mapy.com/img/api/logo.svg" alt="" />
              <span>Hledají Mapy.com · © Seznam.cz a.s. a další</span>
            </a>
          )}
        </div>
      )}
    </div>
  )
}

function PragueMap({ pickupCoords, destinationCoords, route, pickup, destination, onLocate, isLocating }) {
  const mapElementRef = useRef(null)
  const mapInstanceRef = useRef(null)
  const routeLayerRef = useRef(null)
  const pickupMarkerRef = useRef(null)
  const destinationMarkerRef = useRef(null)

  useEffect(() => {
    if (!mapElementRef.current) return undefined

    const map = L.map(mapElementRef.current, { zoomControl: false, scrollWheelZoom: false })
      .setView([49.8, 15.5], 7)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map)
    mapInstanceRef.current = map

    const resizeObserver = new ResizeObserver(() => map.invalidateSize())
    resizeObserver.observe(mapElementRef.current)

    return () => {
      resizeObserver.disconnect()
      map.remove()
      mapInstanceRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return

    routeLayerRef.current?.remove()
    pickupMarkerRef.current?.remove()
    destinationMarkerRef.current?.remove()

    const createMarker = (coords, color, label) => L.circleMarker([coords.lat, coords.lon], {
      radius: 9,
      color: '#ffffff',
      weight: 4,
      fillColor: color,
      fillOpacity: 1,
    }).addTo(map).bindTooltip(label, { direction: 'top', offset: [0, -8] })

    if (pickupCoords) pickupMarkerRef.current = createMarker(pickupCoords, '#72b83c', pickup)
    if (destinationCoords) destinationMarkerRef.current = createMarker(destinationCoords, '#edae38', destination)

    if (route) {
      routeLayerRef.current = L.geoJSON(route.geometry, {
        style: { color: '#78b841', weight: 6, opacity: 0.9 },
      }).addTo(map)
      map.fitBounds(routeLayerRef.current.getBounds(), { padding: [36, 36], maxZoom: 15 })
    } else if (pickupCoords && destinationCoords) {
      map.fitBounds(L.latLngBounds(
        [pickupCoords.lat, pickupCoords.lon],
        [destinationCoords.lat, destinationCoords.lon],
      ), { padding: [36, 36], maxZoom: 15 })
    } else if (pickupCoords) {
      map.setView([pickupCoords.lat, pickupCoords.lon], 14)
    }
  }, [pickupCoords, destinationCoords, route, pickup, destination])

  return (
    <div className="map-art">
      <div className="leaflet-map" ref={mapElementRef} aria-label="Interaktivní mapa trasy" />
      <button className="locate-button" type="button" aria-label="Najít moji polohu" title="Najít moji polohu" onClick={onLocate} disabled={isLocating}>{isLocating ? '…' : '⌖'}</button>
      <div className="map-zoom" aria-label="Přiblížení mapy">
        <button type="button" aria-label="Přiblížit mapu" title="Přiblížit" onClick={() => mapInstanceRef.current?.zoomIn()}>+</button>
        <button type="button" aria-label="Oddálit mapu" title="Oddálit" onClick={() => mapInstanceRef.current?.zoomOut()}>−</button>
      </div>
    </div>
  )
}

function formatCustomerPhone(phone) {
  const digits = String(phone).replace(/\D/g, '')
  const international = digits.length === 9 ? `420${digits}` : digits
  if (international.startsWith('420') && international.length === 12) {
    return `+420 ${international.slice(3).replace(/(\d{3})(?=\d)/g, '$1 ')}`
  }
  return `+${international}`
}

function CustomerLogin({ onAuthenticated }) {
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [ownerPassword, setOwnerPassword] = useState('')
  const [code, setCode] = useState('')
  const [devCode, setDevCode] = useState('')
  const [isCodeRequested, setIsCodeRequested] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const typedLogin = phone.trim()
  const isOwnerLogin = /\p{L}/u.test(typedLogin) && !/\d/.test(typedLogin)
  const isPajaLogin = typedLogin.toLocaleLowerCase('cs-CZ') === 'paja'
  const staffUsername = typedLogin.toLocaleLowerCase('cs-CZ') === 'koblizek' ? 'majitel' : typedLogin

  const signInPajaCustomer = async (event) => {
    event.preventDefault()
    setIsSubmitting(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/customer/password-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: typedLogin, password: ownerPassword }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Přihlášení zákaznického účtu se nepodařilo.')
      onAuthenticated(result.customer, true)
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Přihlášení zákaznického účtu se nepodařilo.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const signInOwner = async (event) => {
    event.preventDefault()
    setIsSubmitting(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/driver/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: staffUsername, password: ownerPassword }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Přihlášení majitele se nepodařilo.')
      window.location.assign('/ridic')
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Přihlášení majitele se nepodařilo.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const requestCode = async (event) => {
    event.preventDefault()
    setIsSubmitting(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/customer/request-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Kód se nepodařilo připravit.')
      setDevCode(result.devCode ?? '')
      setIsCodeRequested(true)
      setNotice(result.message ?? 'Ověřovací kód byl odeslán.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Kód se nepodařilo připravit.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const verifyCode = async (event) => {
    event.preventDefault()
    setIsSubmitting(true)
    setError('')
    try {
      const response = await fetch('/api/customer/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code, name }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Kód se nepodařilo ověřit.')
      onAuthenticated(result.customer)
    } catch (verificationError) {
      setError(verificationError instanceof Error ? verificationError.message : 'Kód se nepodařilo ověřit.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="customer-login-shell">
      <section className="customer-login-card">
        <a className="customer-login-brand" href="/" aria-label="Taxi Koblížek">
          <img src="/taxi-koblizek-logo.png" alt="" />
          <span><strong>Taxi Koblížek</strong><small>Jízda s úsměvem</small></span>
        </a>
        <p className="section-eyebrow">Rychle a bezpečně</p>
        <h1>{isCodeRequested ? 'Ověřte své číslo' : isPajaLogin ? 'Přihlášení zákazníka' : isOwnerLogin ? 'Přihlášení personálu' : 'Přihlášení zákazníka'}</h1>
        <p className="customer-login-intro">
          {isCodeRequested
            ? `Zadejte šestimístný kód pro číslo ${phone}.`
            : isPajaLogin
              ? 'Zadejte heslo ke svému zákaznickému účtu.'
            : isOwnerLogin
              ? `Zadejte heslo pro účet „${typedLogin}“.`
            : 'Přihlaste se telefonním číslem. Po ověření ho už nebudete muset zadávat u každé jízdy.'}
        </p>

        {isCodeRequested ? (
          <form className="customer-login-form" onSubmit={verifyCode}>
            <label>
              <span>Ověřovací kód</span>
              <input
                autoComplete="one-time-code"
                autoFocus
                inputMode="numeric"
                maxLength={6}
                pattern="[0-9]{6}"
                required
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
              />
            </label>
            {devCode && (
              <p className="customer-dev-code" role="status">
                Testovací režim — SMS se neposílá. Kód pro vyzkoušení: <strong>{devCode}</strong>
              </p>
            )}
            <button className="submit-button" type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Ověřuji…' : 'Ověřit a pokračovat'} <span aria-hidden="true">→</span>
            </button>
            <button
              className="outline-button"
              type="button"
              disabled={isSubmitting}
              onClick={() => {
                setIsCodeRequested(false)
                setCode('')
                setDevCode('')
                setError('')
              }}
            >
              Změnit telefonní číslo
            </button>
          </form>
        ) : (
          <form className="customer-login-form" onSubmit={isPajaLogin ? signInPajaCustomer : isOwnerLogin ? signInOwner : requestCode}>
            {!isOwnerLogin && (
              <label>
                <span>Vaše jméno</span>
                <input
                  autoComplete="name"
                  autoFocus
                  required
                  minLength={2}
                  maxLength={100}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Jméno a příjmení"
                />
              </label>
            )}
            <label>
              <span>{isOwnerLogin ? 'Přihlašovací jméno' : 'Telefonní číslo'}</span>
              <input
                autoComplete={isOwnerLogin ? 'username' : 'tel'}
                inputMode={isOwnerLogin ? 'text' : 'tel'}
                maxLength={30}
                required
                type="text"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="+420 777 123 456"
              />
              {!isOwnerLogin && <small>České 9místné číslo nebo mezinárodní číslo. Ověření proběhne SMS kódem.</small>}
            </label>
            {isOwnerLogin ? (
              <>
                <label>
                  <span>Heslo</span>
                  <input
                    autoComplete="current-password"
                    required
                    type="password"
                    value={ownerPassword}
                    onChange={(event) => setOwnerPassword(event.target.value)}
                    placeholder="Zadejte heslo"
                  />
                </label>
                <button className="submit-button" type="submit" disabled={isSubmitting}>
                  {isSubmitting ? 'Přihlašuji…' : 'Přihlásit se'} <span aria-hidden="true">→</span>
                </button>
                <button className="outline-button" type="button" onClick={() => { setPhone(''); setOwnerPassword(''); setError('') }}>
                  Zpět k přihlášení zákazníka
                </button>
              </>
            ) : (
              <button className="submit-button" type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Posílám kód…' : 'Pokračovat telefonem'} <span aria-hidden="true">→</span>
              </button>
            )}
          </form>
        )}

        {error && <p className="error-message" role="alert">{error}</p>}
        {notice && !devCode && <p className="notice-message" role="status">{notice}</p>}
        <a
          className="customer-terms-link"
          href="https://www.taxikoblizek.cz/vseobecne-obchodni-podminky-vop-pro-uzivani-mobilni-aplikace-a-prepravnich-sluzeb/"
        >
          Všeobecné obchodní podmínky
        </a>
      </section>
    </main>
  )
}

function App() {
  const [pricing, setPricing] = useState(DEFAULT_PRICING)
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/pricing', { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((result) => { if (result) setPricing(result) })
      .catch(() => {})
    return () => controller.abort()
  }, [])
  const BOARDING_FEE_CZK = pricing.boardingFeeCzk
  const PRICE_PER_KM_CZK = pricing.pricePerKmCzk
  const [activeScreen, setActiveScreen] = useState('Objednat')
  const [pickup, setPickup] = useState('')
  const [destination, setDestination] = useState('')
  const [orderNote, setOrderNote] = useState('')
  const [customerSession, setCustomerSession] = useState(null)
  const [isCheckingCustomerSession, setIsCheckingCustomerSession] = useState(true)
  const authenticateCustomer = (customer, openProfile = false) => {
    setCustomerSession(customer)
    if (openProfile) setActiveScreen('Profil')
  }
  const [isDriverAvailable, setIsDriverAvailable] = useState(true)
  useEffect(() => {
    if (!customerSession) return undefined
    let cancelled = false
    const check = () => fetch('/api/availability')
      .then((response) => (response.ok ? response.json() : null))
      .then((result) => { if (!cancelled && result) setIsDriverAvailable(Boolean(result.available)) })
      .catch(() => {})
    void check()
    const interval = window.setInterval(check, 10000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [customerSession])
  const [discountInfo, setDiscountInfo] = useState(null)
  useEffect(() => {
    if (!customerSession) return undefined
    let cancelled = false
    fetch('/api/discount')
      .then((response) => (response.ok ? response.json() : null))
      .then((result) => { if (!cancelled && result) setDiscountInfo(result) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [customerSession])
  const [trips, setTrips] = useState(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem('taxi-active-trip') ?? 'null')
      return saved?.id ? [saved] : []
    } catch {
      return []
    }
  })
  useEffect(() => {
    const active = trips.find((trip) => ['pending', 'rejected', 'accepted', 'to_pickup', 'with_customer'].includes(trip.status))
    if (active) window.localStorage.setItem('taxi-active-trip', JSON.stringify(active))
    else window.localStorage.removeItem('taxi-active-trip')
  }, [trips])
  const [paymentChoice, setPaymentChoice] = useState('cash')
  const [paymentGatewayStatus, setPaymentGatewayStatus] = useState('checking')
  const [isStartingPayment, setIsStartingPayment] = useState(false)
  const [customerNotificationPermission, setCustomerNotificationPermission] = useState(
    () => (isNativeApp() ? 'default' : 'Notification' in window && window.isSecureContext ? window.Notification.permission : 'unsupported'),
  )
  const [profileEmail, setProfileEmail] = useState('')
  const [profileEmailDraft, setProfileEmailDraft] = useState('')
  const [profileNameDraft, setProfileNameDraft] = useState('')
  const [isEditingProfile, setIsEditingProfile] = useState(false)
  const profile = {
    name: customerSession?.name ?? '',
    phone: customerSession ? formatCustomerPhone(customerSession.phone) : '',
    email: profileEmail,
  }
  const [pickupCoords, setPickupCoords] = useState(null)
  const [destinationCoords, setDestinationCoords] = useState(null)
  const [route, setRoute] = useState(null)
  const [isLocating, setIsLocating] = useState(false)
  const [mapMessage, setMapMessage] = useState('')
  const [estimatedDistance, setEstimatedDistance] = useState(null)
  const [estimatedPrice, setEstimatedPrice] = useState(null)
  const [estimatedDiscount, setEstimatedDiscount] = useState(0)
  const [estimatedOriginalPrice, setEstimatedOriginalPrice] = useState(null)
  const [isCalculating, setIsCalculating] = useState(false)
  const [notice, setNotice] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('payment') === 'success' && params.has('session_id')) return 'Ověřuji platbu kartou…'
    if (params.get('payment') === 'cancelled') return 'Platba byla zrušena. Jízda nebyla objednána.'
    return ''
  })
  const [calculationError, setCalculationError] = useState('')
  const rideStatusesRef = useRef(new Map())
  const routeControllerRef = useRef(null)

  useEffect(() => {
    for (const trip of trips) {
      if (trip.status && !rideStatusesRef.current.has(trip.id)) {
        rideStatusesRef.current.set(trip.id, trip.status)
      }
    }
  }, [trips])

  const enableCustomerNotifications = async () => {
    if (isNativeApp()) {
      try {
        const ok = await requestNativePermission('customer')
        setCustomerNotificationPermission(ok ? 'granted' : 'denied')
        setNotice(ok ? 'Oznámení jsou zapnutá.' : 'Oznámení se nepodařilo zapnout. Povolte je v nastavení telefonu.')
      } catch (nativeError) {
        console.error('Nepodařilo se zapnout zákaznická oznámení:', nativeError)
        setNotice('Oznámení se nepodařilo zapnout.')
      }
      return
    }
    if (!('Notification' in window) || !window.isSecureContext) {
      setCustomerNotificationPermission('unsupported')
      setNotice('Oznámení prohlížeče vyžadují zabezpečené připojení HTTPS. Stav objednávky uvidíte v aplikaci Jízdy.')
      return
    }
    try {
      const permission = await window.Notification.requestPermission()
      setCustomerNotificationPermission(permission)
      if (permission === 'granted') {
        const subscribed = await subscribeToPush('customer').catch(() => false)
        setNotice(subscribed
          ? 'Oznámení jsou zapnutá, přijdou i při zavřené aplikaci.'
          : 'Oznámení jsou zapnutá, ale jen při otevřené aplikaci.')
      } else {
        setNotice('Oznámení jsou zablokovaná. Stav jízdy můžete sledovat v části Jízdy.')
      }
    } catch (permissionError) {
      console.error('Nepodařilo se zapnout zákaznická oznámení:', permissionError)
      setNotice('Oznámení se nepodařilo zapnout. Zkontrolujte oprávnění prohlížeče a připojení HTTPS.')
    }
  }

  const trackedRideIds = trips.map(({ id }) => id).join(',')

  useEffect(() => {
    if (!customerSession || !trackedRideIds) return undefined
    let isPolling = false
    const refreshStatuses = async () => {
      if (isPolling) return
      isPolling = true
      try {
        const ids = trackedRideIds.split(',')
        const updates = await Promise.all(ids.map(async (id) => {
          const response = await fetch(`/api/rides/${encodeURIComponent(id)}/status`)
          const result = await response.json()
          if (!response.ok) throw new Error(result.error ?? 'Stav objednávky se nepodařilo načíst.')
          return { id, ...result }
        }))
        for (const update of updates) {
          const previousStatus = rideStatusesRef.current.get(update.id)
          if (previousStatus && previousStatus !== update.status
            && ['accepted', 'rejected'].includes(update.status)) {
            const title = update.status === 'accepted' ? 'Řidič přijal vaši objednávku' : 'Objednávku odmítli všichni řidiči'
            const body = update.status === 'accepted'
              ? `Řidič${update.driverName ? ` ${update.driverName}` : ''}${update.driverPlate ? `, SPZ ${update.driverPlate}` : ''} se brzy ozve.`
              : 'Zkuste prosím objednávku zadat znovu.'
            setNotice(`${title}. ${body}`)
            if (customerNotificationPermission === 'granted' && !isNativeApp()) {
              const notification = new window.Notification(title, { body, icon: '/taxi-koblizek-logo.png', tag: `ride-${update.id}` })
              notification.onclick = () => {
                window.focus()
                notification.close()
              }
            }
          }
          rideStatusesRef.current.set(update.id, update.status)
        }
        setTrips((currentTrips) => currentTrips.map((trip) => {
          const update = updates.find(({ id }) => id === trip.id)
          if (!update) return trip
          const offerChanged = JSON.stringify(trip.offer ?? null) !== JSON.stringify(update.offer ?? null)
          const updatedPrice = Number.isInteger(update.amountCzk) ? `${update.amountCzk} Kč` : trip.price
          const updatedPickupFee = update.pickupFeeCzk ?? trip.pickupFeeCzk ?? 0
          return trip.status !== update.status || trip.driverName !== update.driverName || trip.driverPlate !== update.driverPlate || offerChanged
            || trip.price !== updatedPrice || (trip.pickupFeeCzk ?? 0) !== updatedPickupFee
            || trip.paid !== update.paid || trip.paymentType !== update.paymentMethod
            ? { ...trip, status: update.status, driverName: update.driverName, driverPlate: update.driverPlate, driverCarName: update.driverCarName, offer: update.offer ?? null, price: updatedPrice, pickupFeeCzk: updatedPickupFee, paid: update.paid, paymentType: update.paymentMethod }
            : trip
        }))
      } catch (error) {
        console.error('Nepodařilo se obnovit stav objednávky:', error)
      } finally {
        isPolling = false
      }
    }
    void refreshStatuses()
    const interval = window.setInterval(() => void refreshStatuses(), 5000)
    return () => window.clearInterval(interval)
  }, [customerSession, trackedRideIds, customerNotificationPermission])

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/customer/session', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Stav přihlášení se nepodařilo ověřit.')
        return response.json()
      })
      .then(({ customer }) => setCustomerSession(customer))
      .catch((error) => {
        if (!controller.signal.aborted) console.error('Nepodařilo se ověřit zákaznické přihlášení:', error)
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsCheckingCustomerSession(false)
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const paymentResult = params.get('payment')
    const sessionId = params.get('session_id')

    if (paymentResult === 'success' && sessionId) {
      fetch(`/api/payments/session?session_id=${encodeURIComponent(sessionId)}`)
        .then(async (response) => {
          const result = await response.json()
          if (!response.ok) throw new Error(result.error ?? 'Platbu se nepodařilo ověřit.')
          if (!result.paid || !Number.isInteger(result.amountCzk)) throw new Error('Platba ještě nebyla potvrzena.')

          setTrips((currentTrips) => currentTrips.map((trip) => (trip.id === result.rideId
            ? { ...trip, paid: true, price: `${result.amountCzk} Kč` }
            : trip)))
          setNotice(`Platba ${result.amountCzk} Kč proběhla. Řidič je na cestě k vám.`)
        })
        .catch((error) => {
          setNotice(error instanceof Error ? error.message : 'Platbu se nepodařilo ověřit.')
        })
        .finally(() => {
          window.history.replaceState({}, '', window.location.pathname)
        })
    } else if (paymentResult === 'cancelled') {
      window.history.replaceState({}, '', window.location.pathname)
    }

    fetch('/api/payments/status')
      .then((response) => {
        if (!response.ok) throw new Error('Platební služba není dostupná.')
        return response.json()
      })
      .then(({ enabled }) => setPaymentGatewayStatus(enabled ? 'ready' : 'not-configured'))
      .catch(() => setPaymentGatewayStatus('unavailable'))
  }, [])

  const saveProfile = async (event) => {
    event.preventDefault()
    try {
      const response = await fetch('/api/customer/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: profileNameDraft }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Profil se nepodařilo uložit.')
      setCustomerSession(result.customer)
      setProfileEmail(profileEmailDraft.trim())
      setIsEditingProfile(false)
      setNotice('Profil byl uložen.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Profil se nepodařilo uložit.')
    }
  }

  const signOutCustomer = async () => {
    try {
      const response = await fetch('/api/customer/logout', { method: 'POST' })
      if (!response.ok) throw new Error('Odhlášení se nepodařilo. Zkuste to znovu.')
      setCustomerSession(null)
      setTrips([])
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Odhlášení se nepodařilo.')
    }
  }

  const updatePickup = (value, coordinates = null) => {
    setPickup(value)
    setPickupCoords(coordinates)
    setRoute(null)
    setMapMessage('')
    setEstimatedDistance(null)
    setEstimatedPrice(null)
    setCalculationError('')
  }

  const updateDestination = (value, coordinates = null) => {
    setDestination(value)
    setDestinationCoords(coordinates)
    setRoute(null)
    setMapMessage('')
    setEstimatedDistance(null)
    setEstimatedPrice(null)
    setCalculationError('')
  }

  const locateMe = () => {
    if (!navigator.geolocation) {
      const message = 'Tento prohlížeč nepodporuje zjištění polohy.'
      setMapMessage(message)
      setCalculationError(message)
      return
    }

    setIsLocating(true)
    setMapMessage('')
    setCalculationError('')
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      try {
        const response = await fetchGeocoding(
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${coords.latitude}&lon=${coords.longitude}`,
        )
        if (!response.ok) throw new Error('Adresu vaší polohy se nepodařilo načíst.')
        const result = await response.json()
        if (!result.display_name || result.address?.country_code?.toLowerCase() !== 'cz') {
          throw new Error('Místo vyzvednutí musí být v České republice.')
        }
        updatePickup(result.display_name, { lat: coords.latitude, lon: coords.longitude })
        setMapMessage('Místo vyzvednutí nastaveno podle vaší polohy.')
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Polohu se nepodařilo načíst.'
        setMapMessage(message)
        setCalculationError(message)
      } finally {
        setIsLocating(false)
      }
    }, (error) => {
      const message = error.code === error.PERMISSION_DENIED
        ? 'Povolte přístup k poloze v nastavení prohlížeče.'
        : error.code === error.TIMEOUT
          ? 'Zjištění polohy vypršelo. Zkuste to znovu.'
          : 'Polohu se nepodařilo zjistit. Zkuste to znovu.'
      setMapMessage(message)
      setCalculationError(message)
      setIsLocating(false)
    }, { enableHighAccuracy: true, timeout: 10000 })
  }

  const getRideEstimate = useCallback(async () => {
    if (!pickupCoords || !destinationCoords) {
      setCalculationError('Vyberte místo vyzvednutí i cílovou adresu z nabídky pro Českou republiku.')
      return null
    }

    routeControllerRef.current?.abort()
    const controller = new AbortController()
    routeControllerRef.current = controller
    setIsCalculating(true)
    setCalculationError('')
    setMapMessage('')
    setRoute(null)
    setEstimatedDistance(null)
    setEstimatedPrice(null)

    try {
      const pickupLocation = pickupCoords
      const destinationLocation = destinationCoords
      let routeResponse
      try {
        routeResponse = await fetch('/api/routes/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pickup,
            destination,
            pickupCoords: pickupLocation,
            destinationCoords: destinationLocation,
          }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
        })
      } catch (error) {
        if (controller.signal.aborted) throw error
        if (error instanceof DOMException && error.name === 'TimeoutError') {
          throw new Error('Výpočet trasy vypršel. Zkontrolujte připojení a zkuste to znovu.')
        }
        throw new Error('K plánovači tras se nepodařilo připojit. Zkontrolujte připojení a zkuste to znovu.')
      }
      if (!routeResponse.ok) {
        const result = await routeResponse.json()
        throw new Error(result.error ?? 'Nepodařilo se vypočítat trasu. Zkuste to prosím znovu.')
      }
      const routeResult = await routeResponse.json()
      if (controller.signal.aborted) return null
      const routeCoordinates = routeResult.geometry?.coordinates
      const hasValidGeometry = Array.isArray(routeCoordinates)
        && routeCoordinates.length >= 2
        && routeCoordinates.every((coordinate) => (
          Array.isArray(coordinate)
          && coordinate.length >= 2
          && Number.isFinite(coordinate[0])
          && Number.isFinite(coordinate[1])
        ))
      if (
        !routeResult.quoteId
        || !Number.isFinite(routeResult.distanceMeters)
        || !Number.isInteger(routeResult.amountCzk)
        || !Number.isFinite(routeResult.duration)
        || !hasValidGeometry
      ) {
        throw new Error('Mezi zadanými místy se nepodařilo najít trasu pro auto.')
      }
      const distance = routeResult.distanceMeters / 1000
      const price = routeResult.amountCzk
      setRoute({
        geometry: routeResult.geometry,
        duration: routeResult.duration,
        quoteId: routeResult.quoteId,
        from: pickup,
        to: destination,
      })
      setEstimatedDistance(distance)
      setEstimatedPrice(price)
      setEstimatedDiscount(Number.isInteger(routeResult.discountPercent) ? routeResult.discountPercent : 0)
      setEstimatedOriginalPrice(Number.isInteger(routeResult.originalAmountCzk) ? routeResult.originalAmountCzk : price)
      return { distance, price, quoteId: routeResult.quoteId }
    } catch (error) {
      if (controller.signal.aborted) return null
      const message = error instanceof Error ? error.message : 'Cenu se nepodařilo vypočítat.'
      setCalculationError(message)
      return null
    } finally {
      if (routeControllerRef.current === controller) {
        routeControllerRef.current = null
        setIsCalculating(false)
      }
    }
  }, [pickup, destination, pickupCoords, destinationCoords])

  useEffect(() => {
    if (!pickupCoords || !destinationCoords) return undefined
    const timer = window.setTimeout(() => {
      if (!routeControllerRef.current) void getRideEstimate()
    }, 0)
    return () => {
      window.clearTimeout(timer)
      routeControllerRef.current?.abort()
    }
  }, [pickupCoords, destinationCoords, getRideEstimate])

  const submitBooking = async (event) => {
    event.preventDefault()
    setNotice('')

    const estimate = route?.from === pickup && route?.to === destination && estimatedPrice !== null
      ? { distance: estimatedDistance, price: estimatedPrice, quoteId: route.quoteId }
      : await getRideEstimate()
    if (!estimate) return

    if (paymentChoice === 'card' && paymentGatewayStatus !== 'ready') {
      setNotice('Platba kartou zatím není aktivní.')
      return
    }

    setIsStartingPayment(true)
    try {
      const response = await fetch('/api/rides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteId: estimate.quoteId,
          pickup,
          destination,
          note: orderNote,
          paymentMethod: paymentChoice === 'card' ? 'card' : 'cash',
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Objednávku se nepodařilo odeslat.')
      const newTrip = {
        id: result.ride.id,
        from: result.ride.pickup,
        to: result.ride.destination,
        customerName: result.ride.customerName,
        customerPhone: result.ride.customerPhone,
        note: result.ride.note,
        paymentMethod: result.ride.paymentMethod === 'card' ? 'Karta · Stripe' : undefined,
        paymentType: result.ride.paymentMethod,
        paid: result.ride.paid,
        time: 'Právě teď',
        price: `${result.ride.amountCzk} Kč`,
        status: 'pending',
      }
      setOrderNote('')
      rideStatusesRef.current.set(newTrip.id, 'pending')
      setTrips((currentTrips) => [newTrip, ...currentTrips])
      setNotice(result.notificationWarning
        ? `${result.notificationWarning} Objednávka je uložená a její stav se bude aktualizovat v aplikaci.`
        : 'Objednávka byla odeslána řidičům. Jakmile ji někdo přijme, ozve se vám.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Objednávku se nepodařilo odeslat.')
    } finally {
      setIsStartingPayment(false)
    }
  }

  const [isRespondingToOffer, setIsRespondingToOffer] = useState(false)
  useEffect(() => {
    if (customerSession && (customerNotificationPermission === 'granted' || isNativeApp())) void subscribeToPush('customer').catch(() => {})
  }, [customerSession, customerNotificationPermission])
  const respondToOffer = async (rideId, action) => {
    setIsRespondingToOffer(true)
    try {
      const response = await fetch(`/api/rides/${encodeURIComponent(rideId)}/offer/${action}`, { method: 'POST' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Odpověď se nepodařilo odeslat.')
      setTrips((currentTrips) => currentTrips.map((trip) => (trip.id === rideId
        ? {
          ...trip,
          offer: null,
          ...(action === 'confirm' ? {
            status: 'accepted',
            driverName: trip.offer?.driverName,
            driverPlate: trip.offer?.driverPlate,
            driverCarName: trip.offer?.driverCarName,
            ...(Number.isInteger(result.amountCzk) ? { price: `${result.amountCzk} Kč`, pickupFeeCzk: result.pickupFeeCzk ?? 0 } : {}),
          } : {}),
        }
        : trip)))
      setNotice(action === 'confirm'
        ? (result.pickupFeeCzk > 0 ? `Nabídku jste potvrdili. Celková cena je ${result.amountCzk} Kč včetně přistavení vozidla ${result.pickupFeeCzk} Kč.` : 'Čas jste potvrdili.')
        : 'Nabídku jste odmítli. Hledáme dalšího řidiče.')
      if (action === 'confirm' && result.paymentMethod === 'card' && !result.paid) await startCardPayment(rideId)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Odpověď se nepodařilo odeslat.')
    } finally {
      setIsRespondingToOffer(false)
    }
  }

  const [isStartingRidePayment, setIsStartingRidePayment] = useState(false)
  const startCardPayment = async (rideId) => {
    setIsStartingRidePayment(true)
    try {
      const response = await fetch(`/api/rides/${encodeURIComponent(rideId)}/payment`, { method: 'POST' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Platbu se nepodařilo připravit.')
      const checkoutUrl = new URL(result.url)
      if (checkoutUrl.origin !== 'https://checkout.stripe.com') throw new Error('Platební brána vrátila neplatný odkaz.')
      window.location.assign(checkoutUrl.href)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Platbu se nepodařilo připravit.')
      setIsStartingRidePayment(false)
    }
  }

  const swapRoute = () => {
    setPickup(destination)
    setPickupCoords(destinationCoords)
    setDestination(pickup)
    setDestinationCoords(pickupCoords)
    setRoute(null)
    setMapMessage('')
    setEstimatedDistance(null)
    setEstimatedPrice(null)
    setCalculationError('')
  }

  const renderPanel = () => {
    if (activeScreen === 'Jízdy') {
      return (
        <section className="content-card">
          <p className="section-eyebrow">Vaše cesty</p>
          <h1>Historie jízd</h1>
          <div className="history-list">
            {trips.map((trip) => (
              <article className="history-item" key={trip.id}>
                <span className="history-icon">↗</span>
                <div className="history-route">
                  <strong>{trip.from}</strong>
                  <span>{trip.to}</span>
                  <small>{trip.time}{trip.paymentMethod ? ` · ${trip.paymentMethod}` : ''}</small>
                  {trip.note && <small>Poznámka: {trip.note}</small>}
                  {trip.status === 'pending' && <small className="ride-status-pending">Čeká na odpověď řidičů</small>}
                  {trip.status === 'accepted' && <small className="ride-status-accepted">Přijal{trip.driverName ? ` ${trip.driverName}` : ''} vaši jízdu</small>}
                  {['accepted', 'to_pickup', 'with_customer'].includes(trip.status) && trip.driverName && trip.status !== 'accepted' && (
                    <small className="ride-status-accepted">Řidič: <strong>{trip.driverName}</strong></small>
                  )}
                  {['accepted', 'to_pickup', 'with_customer'].includes(trip.status) && trip.driverPlate && (
                    <small className="ride-status-accepted">SPZ vozidla: <strong>{trip.driverPlate}</strong></small>
                  )}
                  {trip.status === 'rejected' && <small className="ride-status-rejected">Všichni řidiči objednávku odmítli</small>}
                  {trip.status === 'to_pickup' && <small className="ride-status-accepted">Řidič jede pro vás</small>}
                  {trip.status === 'with_customer' && <small className="ride-status-accepted">Jízda právě probíhá</small>}
                  {trip.status === 'completed' && <small>Jízda dokončena</small>}
                  {trip.status === 'pending' && customerNotificationPermission !== 'granted' && (
                    <button className="ride-notification-button" type="button" onClick={() => void enableCustomerNotifications()}>
                      Zapnout upozornění
                    </button>
                  )}
                </div>
                <strong className="history-price">{trip.price}</strong>
              </article>
            ))}
          </div>
        </section>
      )
    }

    if (activeScreen === 'Platby') {
      return (
        <section className="content-card">
          <p className="section-eyebrow">Bezpečné online placení</p>
          <h1>Platby</h1>
          <div className="wallet-card">
            <span>Platba kartou</span>
            <strong>Stripe Checkout</strong>
            <small>
              {paymentGatewayStatus === 'ready' && 'Platba proběhne ihned při objednání.'}
              {paymentGatewayStatus === 'checking' && 'Ověřuji dostupnost platební brány…'}
              {paymentGatewayStatus === 'not-configured' && 'Brána čeká na nastavení klíče Stripe provozovatelem.'}
              {paymentGatewayStatus === 'unavailable' && 'Platební server není dostupný.'}
            </small>
          </div>
          <p className="payment-description">Údaje o kartě zadáte na zabezpečené stránce Stripe. Taxi Koblížek je neukládá. Platba se strhne hned po potvrzení na platební stránce.</p>
          <button className="outline-button" type="button" onClick={() => setActiveScreen('Objednat')}>Zpět k objednávce</button>
          {notice && <p className="notice-message" role="status">{notice}</p>}
        </section>
      )
    }

    if (activeScreen === 'Profil') {
      return (
        <section className="content-card">
          <p className="section-eyebrow">Váš účet</p>
          <h1>Můj profil</h1>
          <div className="profile-hero">
            <span className="profile-avatar">{profile.name.charAt(0)}</span>
            <strong>{profile.name}</strong>
            <span className="profile-badge"><span aria-hidden="true">✓</span> Ověřený telefon</span>
          </div>
          {isEditingProfile ? (
            <form className="profile-form" onSubmit={saveProfile}>
              <label className="profile-input"><span>Jméno</span><input required minLength={2} maxLength={100} autoComplete="name" value={profileNameDraft} onChange={(event) => setProfileNameDraft(event.target.value)} /></label>
              <label className="profile-input"><span>Telefon 🔒</span><input type="tel" readOnly value={profile.phone} /></label>
              <small className="contact-privacy-note">Ověřené telefonní číslo nelze upravit. Pro změnu se odhlaste a přihlaste novým číslem.</small>
              <label className="profile-input"><span>E-mail</span><input type="email" placeholder="jmeno@email.cz" value={profileEmailDraft} onChange={(event) => setProfileEmailDraft(event.target.value)} /></label>
              <button className="submit-button profile-save" type="submit">Uložit profil <span aria-hidden="true">→</span></button>
              <button className="outline-button" type="button" onClick={() => setIsEditingProfile(false)}>Zrušit</button>
            </form>
          ) : (
            <>
              <div className="profile-details">
                <div className="profile-row"><span className="profile-row-icon" aria-hidden="true">☎</span><div><span>Telefon</span><strong>{profile.phone}</strong></div></div>
                <div className="profile-row"><span className="profile-row-icon" aria-hidden="true">✉</span><div><span>E-mail</span><strong>{profile.email || 'Nezadáno'}</strong></div></div>
              </div>
              <button className="outline-button profile-edit-button" type="button" onClick={() => { setProfileEmailDraft(profile.email); setProfileNameDraft(profile.name); setIsEditingProfile(true); setNotice('') }}>Upravit profil</button>
              <button className="profile-logout-button" type="button" onClick={signOutCustomer}>Odhlásit se</button>
              <a
                className="customer-terms-link"
                href="https://www.taxikoblizek.cz/vseobecne-obchodni-podminky-vop-pro-uzivani-mobilni-aplikace-a-prepravnich-sluzeb/"
              >
                Všeobecné obchodní podmínky
              </a>
              <p><strong>VŠEOBECNÉ OBCHODNÍ PODMÍNKY (VOP) PRO UŽÍVÁNÍ MOBILNÍ APLIKACE A PŘEPRAVNÍCH SLUŽEB</strong></p>
            </>
          )}
          {notice && <p className="notice-message" role="status">{notice}</p>}
        </section>
      )
    }

    const activeTrip = trips.find((trip) => ['pending', 'rejected', 'accepted', 'to_pickup', 'with_customer'].includes(trip.status))
    if (activeTrip) {
      return (
        <section className="booking-panel active-ride-panel">
          {activeTrip.status === 'pending' && activeTrip.offer ? (
            <div className="active-ride-card">
              <h1>Řidič vám nabízí odvoz</h1>
              <p>Řidič: <strong>{activeTrip.offer.driverName}</strong></p>
              {activeTrip.offer.driverCarName && <p>Auto: <strong>{activeTrip.offer.driverCarName}</strong></p>}
              {activeTrip.offer.driverPlate && <p>SPZ vozidla: <strong>{activeTrip.offer.driverPlate}</strong></p>}
              <p className="active-ride-eta">Přijede za <strong>{activeTrip.offer.etaMinutes} min</strong></p>
              {activeTrip.offer.outsidePickupZone && (
                <div className="pickup-zone-warning" role="alert">
                  <strong>Nástupní adresa je mimo region taxi</strong>
                  <p>Naše taxi působí v oblasti Třebechovice pod Orebem a Pohoří u Dobrušky. Za přistavení vozidla na vaši adresu bude celková cena navýšena o {activeTrip.offer.pickupFeeCzk} Kč.</p>
                  <dl className="pickup-fee-breakdown">
                    <div><dt>Jízda</dt><dd>{activeTrip.offer.totalAmountCzk - activeTrip.offer.pickupFeeCzk} Kč</dd></div>
                    <div>
                      <dt>Přistavení vozidla</dt>
                      <dd>
                        {activeTrip.offer.pickupFeeOriginalCzk !== activeTrip.offer.pickupFeeCzk && <s>{activeTrip.offer.pickupFeeOriginalCzk} Kč</s>}
                        {' '}{activeTrip.offer.pickupFeeCzk} Kč
                      </dd>
                    </div>
                    {activeTrip.offer.pickupFeeOriginalCzk !== activeTrip.offer.pickupFeeCzk && (
                      <div className="pickup-fee-discount">Na přistavení je uplatněna vaše sleva za počet jízd.</div>
                    )}
                    <div className="pickup-fee-total"><dt>Celkem k zaplacení</dt><dd>{activeTrip.offer.totalAmountCzk} Kč</dd></div>
                  </dl>
                </div>
              )}
              {activeTrip.offer.paymentMethod === 'card' && (
                <p className="card-after-confirm-note">Po potvrzení vás přesměrujeme na zabezpečenou platbu kartou{activeTrip.offer.totalAmountCzk ? ` (${activeTrip.offer.totalAmountCzk} Kč)` : ''}.</p>
              )}
              <p className="active-ride-route"><strong>{activeTrip.from}</strong> → <strong>{activeTrip.to}</strong></p>
              <div className="active-ride-buttons">
                <button className="submit-button" type="button" disabled={isRespondingToOffer || isStartingRidePayment} onClick={() => void respondToOffer(activeTrip.id, 'confirm')}>
                  {activeTrip.offer.paymentMethod === 'card'
                    ? `Potvrdit a zaplatit ${activeTrip.offer.totalAmountCzk} Kč`
                    : activeTrip.offer.outsidePickupZone ? `Potvrdit čas a cenu ${activeTrip.offer.totalAmountCzk} Kč` : 'Potvrdit čas'}
                </button>
                <button className="outline-button" type="button" disabled={isRespondingToOffer} onClick={() => void respondToOffer(activeTrip.id, 'decline')}>Odmítnout</button>
              </div>
              {notice && <p className="notice-message" role="status">{notice}</p>}
            </div>
          ) : activeTrip.status === 'pending' || activeTrip.status === 'rejected' ? (
            <div className="active-ride-card">
              <span className="active-ride-spinner" aria-hidden="true" />
              <h1>Čekejte na přijetí objednávky</h1>
              <p>Objednávku jsme odeslali řidičům. Jakmile ji někdo přijme, uvidíte jeho jméno, auto a SPZ vozidla.</p>
              <p className="active-ride-route"><strong>{activeTrip.from}</strong> → <strong>{activeTrip.to}</strong></p>
              {customerNotificationPermission !== 'granted' && customerNotificationPermission !== 'unsupported' && (
                <button className="ride-notification-button" type="button" onClick={() => void enableCustomerNotifications()}>
                  Zapnout upozornění na přijetí jízdy
                </button>
              )}
            </div>
          ) : (
            <div className="active-ride-card">
              <h1>{activeTrip.status === 'with_customer' ? 'Jízda právě probíhá' : 'Objednávka byla přijata'}</h1>
              {activeTrip.driverName && <p>Řidič: <strong>{activeTrip.driverName}</strong></p>}
              {activeTrip.driverCarName && <p>Auto: <strong>{activeTrip.driverCarName}</strong></p>}
              {activeTrip.driverPlate && <p>SPZ vozidla: <strong>{activeTrip.driverPlate}</strong></p>}
              {activeTrip.paymentType === 'card' && !activeTrip.paid ? (
                <div className="ride-payment-due" role="alert">
                  <strong>Zbývá zaplatit kartou: {activeTrip.price}</strong>
                  {activeTrip.pickupFeeCzk > 0 && <p>Částka zahrnuje přistavení vozidla {activeTrip.pickupFeeCzk} Kč.</p>}
                  <button className="submit-button" type="button" disabled={isStartingRidePayment} onClick={() => void startCardPayment(activeTrip.id)}>
                    {isStartingRidePayment ? 'Připravuji platbu…' : `Zaplatit ${activeTrip.price}`}
                  </button>
                </div>
              ) : activeTrip.paymentType === 'card' && activeTrip.paid ? (
                <p>Zaplaceno kartou: <strong>{activeTrip.price}</strong></p>
              ) : null}
              {activeTrip.status === 'accepted' && <p>Řidič je na cestě k vám.</p>}
              <p className="active-ride-route"><strong>{activeTrip.from}</strong> → <strong>{activeTrip.to}</strong></p>
              {notice && <p className="notice-message" role="status">{notice}</p>}
            </div>
          )}
        </section>
      )
    }

    return (
      <section className="booking-panel">
        <div className="booking-heading">
          <div><p className="section-eyebrow">Taxi Koblížek · po celé ČR</p><h1>Kam vás odvezeme?</h1></div>
          <div className="booking-account">
            <span>{formatCustomerPhone(customerSession.phone)}</span>
            <button type="button" onClick={signOutCustomer}>Odhlásit</button>
          </div>
        </div>

        {!isDriverAvailable && (
          <div className="no-driver-banner" role="alert">
            <p>Teď není dostupné žádné vozidlo. Zkuste to prosím za chvíli, nebo volejte na tel.</p>
            <a className="no-driver-call" href="tel:+420777182346">📞 777 182 346</a>
          </div>
        )}

        <form className={`booking-form${isDriverAvailable ? '' : ' is-locked'}`} onSubmit={submitBooking}>
          <fieldset className="booking-lock" disabled={!isDriverAvailable}>
          {discountInfo && (discountInfo.percent > 0 || discountInfo.nextTier || discountInfo.tiers?.length > 0) && (
            <div className="loyalty-box">
              {discountInfo.percent > 0 && <strong>Vaše sleva: {discountInfo.percent} %</strong>}
              {discountInfo.tiers?.length > 0 && (
                <ul className="loyalty-tiers">
                  {discountInfo.tiers.map((tier) => {
                    const remaining = tier.rides - discountInfo.ridesInWindow
                    return (
                      <li key={tier.rides} className={remaining <= 0 ? 'is-reached' : ''}>
                        {remaining <= 0
                          ? `Sleva ${tier.percent} % (${tier.rides} jízd za ${discountInfo.windowDays} dní) ✓`
                          : `Ještě ${remaining} ${remaining === 1 ? 'jízda' : remaining < 5 ? 'jízdy' : 'jízd'} do slevy ${tier.percent} %`}
                      </li>
                    )
                  })}
                </ul>
              )}
              <small>Jízdy za posledních {discountInfo.windowDays} dní: {discountInfo.ridesInWindow}</small>
            </div>
          )}
          <div className="route-fields">
            <AddressAutocomplete
              label="Odkud"
              value={pickup}
              onChange={updatePickup}
              onSelect={updatePickup}
              disabled={isCalculating || isStartingPayment}
            />
            <div className="route-connector" />
            <AddressAutocomplete
              className="destination-field"
              label="Kam"
              value={destination}
              onChange={updateDestination}
              onSelect={updateDestination}
              disabled={isCalculating || isStartingPayment}
            />
          </div>
          {(!pickupCoords || !destinationCoords) && (
            <p className="address-selection-hint">Hledejte adresu nebo místo, například nádraží, školu či nemocnici, a vyberte návrh.</p>
          )}
          <button className="swap-route" type="button" aria-label="Prohodit místa" onClick={swapRoute} disabled={isCalculating || isStartingPayment}>↕</button>
          {isCalculating && <p role="status">Počítám trasu a cenu…</p>}

          <div className="vehicle-heading">
            <h2>Kontakt na vás</h2>
            <span className="fare-rate">{BOARDING_FEE_CZK} Kč nástup + {PRICE_PER_KM_CZK} Kč/km</span>
          </div>
          <div className="contact-fields">
            <small className="contact-privacy-note">{customerSession.name} · ověřený telefon {formatCustomerPhone(customerSession.phone)} uvidí pouze řidič, který jízdu přijme.</small>
          </div>

          <label className="profile-input order-note-field">
            <span>Poznámka k jízdě <small>(nepovinné)</small></span>
            <textarea
              value={orderNote}
              onChange={(event) => setOrderNote(event.target.value)}
              placeholder="Doplňující informace k jízdě"
              maxLength={500}
              rows={3}
              disabled={isStartingPayment}
            />
            <small className="order-note-hint">{orderNote.length}/500 znaků · Poznámku uvidí řidič.</small>
          </label>

          {estimatedDistance !== null && !calculationError && (
            <div className="estimate-detail"><span>⌁&nbsp; {estimatedDistance.toFixed(1)} km po silnici</span><span>Asi {Math.max(1, Math.round((route?.duration ?? 0) / 60))} min</span></div>
          )}
          {calculationError && <p className="error-message" role="alert">{calculationError}</p>}

          <fieldset className="payment-options" disabled={isCalculating || isStartingPayment}>
            <legend>Způsob platby</legend>
            <label className={`payment-option${paymentChoice === 'card' ? ' is-selected' : ''}${paymentGatewayStatus === 'ready' ? '' : ' is-disabled'}`}>
              <input
                type="radio"
                name="payment-choice"
                value="card"
                checked={paymentChoice === 'card'}
                onChange={() => setPaymentChoice('card')}
                disabled={paymentGatewayStatus !== 'ready'}
              />
              <span>
                <strong>Platební karta</strong>
                <small>
                  {paymentGatewayStatus === 'ready' && 'Bezpečně přes Stripe · zaplatíte po potvrzení řidičem'}
                  {paymentGatewayStatus === 'checking' && 'Ověřuji dostupnost platební brány…'}
                  {paymentGatewayStatus === 'not-configured' && 'Zatím není aktivní · použijte hotovost'}
                  {paymentGatewayStatus === 'unavailable' && 'Platební server není dostupný'}
                </small>
              </span>
              <span className="radio-indicator" />
            </label>
            <label className={paymentChoice === 'cash' ? 'payment-option is-selected' : 'payment-option'}>
              <input
                type="radio"
                name="payment-choice"
                value="cash"
                checked={paymentChoice === 'cash'}
                onChange={() => setPaymentChoice('cash')}
              />
              <span><strong>Hotově</strong><small>Platba řidiči při jízdě</small></span>
              <span className="radio-indicator" />
            </label>
          </fieldset>

          <div className="booking-footer">
            <div className="total-price"><span>{estimatedPrice === null ? 'Sazba za jízdu' : 'Celková cena'}</span><strong className={estimatedPrice === null ? 'rate-total' : undefined}>{estimatedPrice === null ? `${BOARDING_FEE_CZK} Kč + ${PRICE_PER_KM_CZK} Kč/km` : `${estimatedPrice} Kč`}</strong></div>
            {estimatedPrice !== null && estimatedDiscount > 0 && (
              <p className="discount-note">
                Původní cena <s>{estimatedOriginalPrice ?? estimatedPrice} Kč</s> · sleva {estimatedDiscount} % · cena po slevě <strong>{estimatedPrice} Kč</strong>
              </p>
            )}
            <button type="submit" className="submit-button" disabled={isCalculating || isStartingPayment || !isDriverAvailable}>
              {isCalculating ? 'Počítám…' : isStartingPayment ? 'Odesílám…' : 'Objednat jízdu'} <span aria-hidden="true">→</span>
            </button>
          </div>
          {notice && <p className="notice-message" role="status">{notice}</p>}
          {trips.some((trip) => trip.status === 'pending') && customerNotificationPermission !== 'granted' && (
            <button className="ride-notification-button" type="button" onClick={() => void enableCustomerNotifications()}>
              Zapnout upozornění na přijetí jízdy
            </button>
          )}
          </fieldset>
        </form>
        <div className="trust-note"><span aria-hidden="true">✦</span> Pohodlně, spolehlivě a za férovou cenu</div>
      </section>
    )
  }

  if (isCheckingCustomerSession) {
    return <main className="customer-login-shell"><p className="driver-loading">Ověřuji přihlášení…</p></main>
  }
  if (!customerSession) return <CustomerLogin onAuthenticated={authenticateCustomer} />

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setActiveScreen('Objednat') }} aria-label="Taxi Koblížek – domů">
          <img className="brand-emblem" src="/taxi-koblizek-logo.png" alt="" />
          <span className="brand-copy"><span className="brand-name">Taxi <strong>Koblížek</strong></span><small>Jízda s úsměvem</small></span>
        </a>
        <button className="topbar-location" type="button" onClick={locateMe} aria-label="Nastavit místo vyzvednutí podle aktuální polohy"><span className="online-dot" /><span>Celá ČR</span></button>
        <button className="account-button" type="button" aria-label="Otevřít profil" onClick={() => setActiveScreen('Profil')}><span>{profile.name.charAt(0)}</span></button>
      </header>

      {activeScreen === 'Objednat' && (
        <section className="map-stage" aria-label="Mapa a trasa">
          <div className={`map-status${mapMessage ? ' map-message' : ''}`} role={mapMessage ? 'status' : undefined}>
            {mapMessage || <><span className="online-dot" />{route ? `${estimatedDistance.toFixed(1)} km · trasa autem` : 'Mapa OpenStreetMap · vyhledávání Mapy.com'}</>}
          </div>
          <PragueMap
            pickupCoords={pickupCoords}
            destinationCoords={destinationCoords}
            route={route}
            pickup={pickup}
            destination={destination}
            onLocate={locateMe}
            isLocating={isLocating}
          />
        </section>
      )}

      <div className="panel-area">{renderPanel()}</div>

      <nav className="bottom-nav" aria-label="Hlavní navigace">
        {navItems.map((item) => (
          <button key={item.label} type="button" className={`nav-item${activeScreen === item.label ? ' active' : ''}`} onClick={() => { setActiveScreen(item.label); setNotice('') }}>
            <span className="nav-icon" aria-hidden="true">{item.icon}</span><span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="demo-note">Taxi Koblížek · objednávky dostanou přihlášení řidiči</div>
    </main>
  )
}

export default function AppEntry() {
  return window.location.pathname === '/ridic' ? <DriverApp /> : <App />
}
