const windows = new Map() // key -> { count, resetAt }

export function hitLimit(key, max, windowMs) {
  const now = Date.now()
  let w = windows.get(key)
  if (!w || now >= w.resetAt) { w = { count: 0, resetAt: now + windowMs }; windows.set(key, w) }
  w.count++
  return { exceeded: w.count > max, retryAfter: Math.ceil((w.resetAt - now) / 1000) }
}

// Sweep expired windows every 5 min so the Map stays bounded.
// .unref() so the interval doesn't prevent the process from exiting gracefully.
setInterval(() => {
  const now = Date.now()
  for (const [k, w] of windows) if (now >= w.resetAt) windows.delete(k)
}, 5 * 60 * 1000).unref?.()
