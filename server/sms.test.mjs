import test from 'node:test'
import assert from 'node:assert/strict'
import { createTwilioSmsSender } from './sms.mjs'

test('sends SMS through Twilio Messages API using form data and Basic auth', async () => {
  let request
  const sender = createTwilioSmsSender({
    accountSid: 'AC123',
    authToken: 'secret-token',
    fromNumber: '+15005550006',
    fetchImpl: async (url, options) => {
      request = { url, options }
      return { ok: true, status: 201 }
    },
  })

  await sender.send('+420777123456', 'Taxi Koblížek: kód 123456')
  assert.equal(request.url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json')
  assert.equal(request.options.method, 'POST')
  assert.equal(request.options.headers.Authorization, `Basic ${Buffer.from('AC123:secret-token').toString('base64')}`)
  assert.deepEqual(Object.fromEntries(request.options.body), {
    To: '+420777123456',
    From: '+15005550006',
    Body: 'Taxi Koblížek: kód 123456',
  })
})

test('rejects invalid recipients and reports Twilio delivery errors', async () => {
  const sender = createTwilioSmsSender({
    accountSid: 'AC123',
    authToken: 'secret-token',
    fromNumber: '+15005550006',
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ message: 'Invalid To number' }),
    }),
  })

  await assert.rejects(sender.send('not-a-phone', 'text'), /platný formát E\.164/)
  await assert.rejects(sender.send('+420777123456', 'text'), /Twilio odmítlo SMS \(400\): Invalid To number/)
})

test('reports missing provider configuration instead of silently skipping SMS', async () => {
  const sender = createTwilioSmsSender({ accountSid: '', authToken: '', fromNumber: '' })
  assert.equal(sender.configured, false)
  await assert.rejects(sender.send('+420777123456', 'text'), /není nakonfigurované/)
})
