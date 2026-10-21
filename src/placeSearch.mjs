export async function fetchPlaceSuggestions(query, signal) {
  const url = new URL('/api/places/suggest', globalThis.location?.origin ?? 'http://localhost')
  url.searchParams.set('query', query.trim())

  let response
  try {
    response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    })
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error('Vyhledávání přes Mapy.com vypršelo. Zkuste to prosím znovu.')
    }
    throw new Error('Ke službě Mapy.com se nepodařilo připojit. Zkuste to znovu.')
  }
  if (!response.ok) {
    let message = 'Vyhledávání přes Mapy.com teď není dostupné.'
    try {
      const result = await response.json()
      if (typeof result.error === 'string') message = result.error
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
    throw new Error(message)
  }
  const result = await response.json()
  if (!result || !Array.isArray(result.items)) throw new Error('Mapy.com vrátily neplatné výsledky.')

  const seen = new Set()
  return result.items.flatMap((item) => {
    const lat = item?.position?.lat
    const lon = item?.position?.lon
    if (
      typeof item?.label !== 'string'
      || !item.label.trim()
      || !Number.isFinite(lat)
      || !Number.isFinite(lon)
      || lat < 48.5
      || lat > 51.1
      || lon < 12
      || lon > 19
    ) return []
    const id = `${item.type ?? 'location'}-${lat}-${lon}-${item.label}`
    if (seen.has(id)) return []
    seen.add(id)
    return [{
      id,
      type: item.type === 'poi' ? 'place' : 'address',
      address: item.label.trim(),
      lat,
      lon,
    }]
  })
}
