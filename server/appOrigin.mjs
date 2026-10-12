import { isIP } from 'node:net'

export function isAllowedAppOrigin(requestOrigin, configuredAppUrl, isProduction) {
  if (!requestOrigin) return false

  if (configuredAppUrl) {
    try {
      if (new URL(configuredAppUrl).origin === requestOrigin) return true
    } catch {
      return false
    }
    if (isProduction) return false
  }

  if (requestOrigin === 'http://localhost:5173' || requestOrigin === 'http://127.0.0.1:5173') return true

  try {
    const origin = new URL(requestOrigin)
    const octets = origin.hostname.split('.').map(Number)
    const isPrivateIPv4 = isIP(origin.hostname) === 4 && (
      octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
    )
    return origin.origin === requestOrigin
      && origin.protocol === 'http:'
      && origin.port === '5173'
      && isPrivateIPv4
  } catch {
    return false
  }
}
