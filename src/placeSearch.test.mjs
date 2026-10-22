import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchPlaceSuggestions } from './placeSearch.mjs'

const results = [
  {
    name: 'Třebechovice pod Orebem',
    label: 'Třebechovice pod Orebem, Česko',
    type: 'regional.municipality',
    position: { lon: 15.982253, lat: 50.2000918 },
  },
  {
    name: 'Nádraží',
    label: 'Nádraží, Třebechovice pod Orebem, Česko',
    type: 'poi',
    position: { lon: 15.981, lat: 50.201 },
  },
]

test('requests Mapy.com suggestions for both addresses and places', async (t) => {
  let requestedUrl
  t.mock.method(globalThis, 'fetch', async (url) => {
    requestedUrl = new URL(url)
    return Response.json({ items: results })
  })

  const suggestions = await fetchPlaceSuggestions('Třebechovice nádraží', new AbortController().signal)

  assert.equal(requestedUrl.pathname, '/api/places/suggest')
  assert.equal(requestedUrl.searchParams.get('query'), 'Třebechovice nádraží')
  assert.equal(suggestions.length, 2)
  assert.deepEqual(suggestions.map(({ type }) => type), ['address', 'place'])
  assert.equal(suggestions[0].address, 'Třebechovice pod Orebem, Česko')
  assert.equal(suggestions[0].lat, 50.2000918)
  assert.equal(suggestions[0].lon, 15.982253)
})

test('filters duplicate, malformed and out-of-country suggestions', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    items: [
      results[0],
      results[0],
      { ...results[0], label: 'Foreign', position: { lon: 13.4, lat: 52.5 } },
      { ...results[0], position: { lon: null, lat: null } },
      { ...results[0], label: '' },
    ],
  }))

  const suggestions = await fetchPlaceSuggestions('Třebechovice', new AbortController().signal)

  assert.equal(suggestions.length, 1)
  assert.equal(suggestions[0].address, 'Třebechovice pod Orebem, Česko')
})

test('reports service errors and malformed responses', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(
    { error: 'Vyhledávání přes Mapy.com není nakonfigurované.' },
    { status: 503 },
  ))
  await assert.rejects(
    fetchPlaceSuggestions('Praha', new AbortController().signal),
    /není nakonfigurované/,
  )

  mock.mock.mockImplementation(async () => Response.json({ error: 'invalid' }))
  await assert.rejects(
    fetchPlaceSuggestions('Praha', new AbortController().signal),
    /neplatné výsledky/,
  )
})

test('keeps cancellation distinct from service failures', async (t) => {
  const controller = new AbortController()
  controller.abort()
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    signal.throwIfAborted()
  })

  await assert.rejects(
    fetchPlaceSuggestions('Praha', controller.signal),
    { name: 'AbortError' },
  )
})
