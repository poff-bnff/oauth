export function checkoutTimeoutSeconds(timeout = '00:30:00') {
  if (typeof timeout === 'number') return Math.max(0, timeout)
  const parts = String(timeout || '00:30:00').split(':').map(part => Number(part) || 0)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 1800
}

export function checkoutCartExpiry(cart) {
  const updatedAt = cart?.cartUpdatedAt || cart?.updated_at || cart?.updatedAt
  const updatedTime = updatedAt ? new Date(updatedAt).getTime() : 0
  if (!updatedTime) return { expiresAt: null, secondsRemaining: 0, timeoutSeconds: checkoutTimeoutSeconds(cart?.cartTimeout) }
  const timeoutSeconds = checkoutTimeoutSeconds(cart?.cartTimeout)
  const expiresAt = new Date(updatedTime + timeoutSeconds * 1000)
  return {
    expiresAt: expiresAt.toISOString(),
    secondsRemaining: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    timeoutSeconds
  }
}

export function checkoutCartExpired(cart) {
  return checkoutCartExpiry(cart).secondsRemaining <= 0
}
