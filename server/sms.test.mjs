import test from 'node:test'
import assert from 'node:assert/strict'
import { createTwilioSmsSender, createTwilioVerifySender } from './sms.mjs'

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

test('starts and checks a Twilio Verify SMS without supplying a custom message template', async () => {
  const serviceSid = `VA${'a'.repeat(32)}`
  const requests = []
  const sender = createTwilioVerifySender({
    accountSid: 'AC123',
    authToken: 'secret-token',
    verifyServiceSid: serviceSid,
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return {
        ok: true,
        status: 201,
        json: async () => ({ status: url.endsWith('/VerificationCheck') ? 'approved' : 'pending' }),
      }
    },
  })

  assert.equal(sender.configured, true)
  await sender.send('+420777123456')
  assert.equal(await sender.check('+420777123456', '123456'), true)
  assert.equal(requests[0].url, `https://verify.twilio.com/v2/Services/${serviceSid}/Verifications`)
  assert.equal(requests[1].url, `https://verify.twilio.com/v2/Services/${serviceSid}/VerificationCheck`)
  assert.equal(requests[0].options.headers.Authorization, `Basic ${Buffer.from('AC123:secret-token').toString('base64')}`)
  assert.deepEqual(Object.fromEntries(requests[0].options.body), {
    To: '+420777123456',
    Channel: 'sms',
  })
  assert.deepEqual(Object.fromEntries(requests[1].options.body), {
    To: '+420777123456',
    Code: '123456',
  })
})

test('rejects invalid Verify service IDs and reports Verify API errors', async () => {
  const sender = createTwilioVerifySender({
    accountSid: 'AC123',
    authToken: 'secret-token',
    verifyServiceSid: 'not-a-service-sid',
  })
  assert.equal(sender.configured, false)
  await assert.rejects(sender.send('+420777123456'), /není nakonfigurované/)

  const failingSender = createTwilioVerifySender({
    accountSid: 'AC123',
    authToken: 'secret-token',
    verifyServiceSid: `VA${'b'.repeat(32)}`,
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ message: 'Invalid To number' }),
    }),
  })
  await assert.rejects(failingSender.send('+420777123456'), /Twilio Verify odmítlo požadavek \(400\): Invalid To number/)
})

test('returns false when the Verify code is not approved', async () => {
  const sender = createTwilioVerifySender({
    accountSid: 'AC123',
    authToken: 'secret-token',
    verifyServiceSid: `VA${'c'.repeat(32)}`,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'pending' }),
    }),
  })

  assert.equal(await sender.check('+420777123456', '000000'), false)
  assert.equal(await sender.check('+420777123456', 'invalid'), false)
})
