import { Buffer } from 'node:buffer'

export function createTwilioSmsSender({ accountSid, authToken, fromNumber, fetchImpl = fetch }) {
  const configured = Boolean(
    accountSid
    && authToken
    && typeof fromNumber === 'string'
    && /^\+[1-9]\d{7,14}$/.test(fromNumber),
  )

  return {
    configured,
    async send(to, body) {
      if (!configured) throw new Error('Twilio SMS není nakonfigurované.')
      if (!/^\+[1-9]\d{7,14}$/.test(to)) throw new Error('Telefonní číslo SMS příjemce nemá platný formát E.164.')
      if (typeof body !== 'string' || body.trim().length === 0 || body.length > 1600) {
        throw new Error('Text SMS je prázdný nebo příliš dlouhý.')
      }

      const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64')
      const payload = new URLSearchParams({ To: to, From: fromNumber, Body: body })
      const response = await fetchImpl(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: payload,
          signal: AbortSignal.timeout(10000),
        },
      )

      if (!response.ok) {
        const result = await response.json()
        throw new Error(`Twilio odmítlo SMS (${response.status}): ${result.message ?? 'neznámá chyba'}`)
      }
    },
  }
}

export function createTwilioVerifySender({ accountSid, authToken, verifyServiceSid, fetchImpl = fetch }) {
  const configured = Boolean(
    accountSid
    && authToken
    && typeof verifyServiceSid === 'string'
    && /^VA[a-f\d]{32}$/i.test(verifyServiceSid),
  )

  async function request(path, payload) {
    if (!configured) throw new Error('Twilio Verify není nakonfigurované.')
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64')
    const response = await fetchImpl(
      `https://verify.twilio.com/v2/Services/${encodeURIComponent(verifyServiceSid)}/${path}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(payload),
        signal: AbortSignal.timeout(10000),
      },
    )

    const result = await response.json()
    if (!response.ok) {
      throw new Error(`Twilio Verify odmítlo požadavek (${response.status}): ${result.message ?? 'neznámá chyba'}`)
    }
    return result
  }

  return {
    configured,
    async send(to) {
      if (!/^\+[1-9]\d{7,14}$/.test(to)) throw new Error('Telefonní číslo SMS příjemce nemá platný formát E.164.')
      await request('Verifications', { To: to, Channel: 'sms' })
    },
    async check(to, code) {
      if (!/^\+[1-9]\d{7,14}$/.test(to)) throw new Error('Telefonní číslo SMS příjemce nemá platný formát E.164.')
      if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false
      const result = await request('VerificationCheck', { To: to, Code: code })
      return result.status === 'approved'
    },
  }
}
