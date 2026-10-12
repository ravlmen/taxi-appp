import { Capacitor } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'

function base64UrlToUint8Array(value) {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(padded)
  return Uint8Array.from(raw, (character) => character.charCodeAt(0))
}

export const isNativeApp = () => Capacitor.isNativePlatform()

export function isPushSupported() {
  if (isNativeApp()) return true
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext
}

async function sendSubscription(role, body) {
  const response = await fetch(`/api/${role}/push-subscription`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return response.ok
}

// Asks for permission in the native app and registers the device token with the server.
async function subscribeNative(role, { askPermission }) {
  let permission = await PushNotifications.checkPermissions()
  if (permission.receive !== 'granted' && askPermission) permission = await PushNotifications.requestPermissions()
  if (permission.receive !== 'granted') return false
  await PushNotifications.removeAllListeners()
  const token = new Promise((resolve, reject) => {
    PushNotifications.addListener('registration', ({ value }) => resolve(value))
    PushNotifications.addListener('registrationError', (error) => reject(new Error(error.error)))
  })
  await PushNotifications.register()
  return sendSubscription(role, { fcmToken: await token })
}

export async function requestNativePermission(role) {
  return subscribeNative(role, { askPermission: true })
}

// Registers the device for push (web push in a browser, FCM in the native app).
export async function subscribeToPush(role) {
  if (isNativeApp()) return subscribeNative(role, { askPermission: false })
  if (!isPushSupported()) return false
  const registration = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  const keyResponse = await fetch('/api/push/public-key')
  if (!keyResponse.ok) return false
  const { publicKey } = await keyResponse.json()
  const subscription = await registration.pushManager.getSubscription()
    ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(publicKey),
    })
  return sendSubscription(role, { subscription: subscription.toJSON() })
}
