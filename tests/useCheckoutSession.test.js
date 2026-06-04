import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { useCheckoutSession } from '../pages/checkout/composables/useCheckoutSession.js'

const NOW = new Date('2026-06-02T12:00:00.000Z').getTime()
const MIN = 60 * 1000

function makeSession(overrides = {}) {
  const cart = ref({
    items: [{ productId: 1 }],
    expiresAt: new Date(NOW + 30 * MIN).toISOString(),
    ...(overrides.cart || {})
  })
  const route = { query: overrides.query || {} }
  const runtime = { public: { url: overrides.url ?? 'http://localhost:3000' } }
  return { session: useCheckoutSession({ cart, route, runtime }), cart }
}

describe('useCheckoutSession', () => {
  beforeEach(() => { vi.setSystemTime(NOW) })
  afterEach(() => { vi.useRealTimers() })

  describe('sessionRemainingSeconds', () => {
    it('calculates from cart.expiresAt', () => {
      const { session } = makeSession()
      expect(session.sessionRemainingSeconds.value).toBe(30 * 60)
    })

    it('returns 0 when cart has no items', () => {
      const { session } = makeSession({ cart: { items: [] } })
      expect(session.sessionRemainingSeconds.value).toBe(0)
    })

    it('clamps to 0 when already expired', () => {
      const { session } = makeSession({ cart: { expiresAt: new Date(NOW - MIN).toISOString() } })
      expect(session.sessionRemainingSeconds.value).toBe(0)
    })

    it('returns exact 0 at boundary', () => {
      const { session } = makeSession({ cart: { expiresAt: new Date(NOW).toISOString() } })
      expect(session.sessionRemainingSeconds.value).toBe(0)
    })

    it('uses secondsRemaining fallback when no expiresAt', () => {
      const { session } = makeSession({ cart: { secondsRemaining: 900, expiresAt: null } })
      expect(session.sessionRemainingSeconds.value).toBe(900)
    })

    it('falls back to 1800 when no expiresAt and no secondsRemaining', () => {
      const { session } = makeSession({ cart: {} })
      expect(session.sessionRemainingSeconds.value).toBe(1800)
    })

    it('preview overrides cart.expiresAt', () => {
      const { session } = makeSession()
      session.setSessionPreview(300)
      expect(session.sessionRemainingSeconds.value).toBe(300)
    })

    it('preview of 0 gives 0 remaining', () => {
      const { session } = makeSession()
      session.setSessionPreview(0)
      expect(session.sessionRemainingSeconds.value).toBe(0)
    })
  })

  describe('sessionDisplay', () => {
    it('formats MM:SS with zero padding', () => {
      const { session } = makeSession({ cart: { expiresAt: new Date(NOW + 30 * MIN).toISOString() } })
      expect(session.sessionDisplay.value).toBe('30:00')
    })

    it('formats sub-minute correctly', () => {
      const { session } = makeSession({ cart: { expiresAt: new Date(NOW + 45 * 1000).toISOString() } })
      expect(session.sessionDisplay.value).toBe('00:45')
    })

    it('formats mixed minutes and seconds', () => {
      const { session } = makeSession({ cart: { expiresAt: new Date(NOW + 4 * MIN + 30 * 1000).toISOString() } })
      expect(session.sessionDisplay.value).toBe('04:30')
    })

    it('shows 00:00 when expired', () => {
      const { session } = makeSession({ cart: { expiresAt: new Date(NOW - MIN).toISOString() } })
      expect(session.sessionDisplay.value).toBe('00:00')
    })
  })

  describe('sessionBannerTone', () => {
    it('normal above 270s', () => {
      const { session } = makeSession({ cart: { expiresAt: new Date(NOW + 271 * 1000).toISOString() } })
      expect(session.sessionBannerTone.value).toBe('normal')
    })

    it('yellow at exactly 270s', () => {
      const { session } = makeSession({ cart: { expiresAt: new Date(NOW + 270 * 1000).toISOString() } })
      expect(session.sessionBannerTone.value).toBe('yellow')
    })

    it('yellow between 106s and 270s', () => {
      const { session } = makeSession({ cart: { expiresAt: new Date(NOW + 200 * 1000).toISOString() } })
      expect(session.sessionBannerTone.value).toBe('yellow')
    })

    it('pink at exactly 105s', () => {
      const { session } = makeSession({ cart: { expiresAt: new Date(NOW + 105 * 1000).toISOString() } })
      expect(session.sessionBannerTone.value).toBe('pink')
    })

    it('pink between 31s and 105s', () => {
      const { session } = makeSession({ cart: { expiresAt: new Date(NOW + 60 * 1000).toISOString() } })
      expect(session.sessionBannerTone.value).toBe('pink')
    })

    it('warning at exactly 30s', () => {
      const { session } = makeSession({ cart: { expiresAt: new Date(NOW + 30 * 1000).toISOString() } })
      expect(session.sessionBannerTone.value).toBe('warning')
    })

    it('warning below 30s', () => {
      const { session } = makeSession({ cart: { expiresAt: new Date(NOW + 10 * 1000).toISOString() } })
      expect(session.sessionBannerTone.value).toBe('warning')
    })

    it('normal when cart is empty', () => {
      const { session } = makeSession({ cart: { items: [] } })
      expect(session.sessionBannerTone.value).toBe('normal')
    })
  })

  describe('showSessionWarningModal', () => {
    it('shows between 1s and 30s remaining', () => {
      const { session } = makeSession({ cart: { expiresAt: new Date(NOW + 20 * 1000).toISOString() } })
      expect(session.showSessionWarningModal.value).toBeTruthy()
    })

    it('shows at exactly 1s remaining', () => {
      const { session } = makeSession({ cart: { expiresAt: new Date(NOW + 1000).toISOString() } })
      expect(session.showSessionWarningModal.value).toBeTruthy()
    })

    it('does not show at exactly 0s remaining', () => {
      const { session } = makeSession({ cart: { expiresAt: new Date(NOW).toISOString() } })
      expect(session.showSessionWarningModal.value).toBeFalsy()
    })

    it('does not show above 30s', () => {
      const { session } = makeSession({ cart: { expiresAt: new Date(NOW + 31 * 1000).toISOString() } })
      expect(session.showSessionWarningModal.value).toBeFalsy()
    })

    it('does not show when already expired (sessionExpired=true)', () => {
      const { session } = makeSession({ cart: { expiresAt: new Date(NOW + 20 * 1000).toISOString() } })
      session.sessionExpired.value = true
      expect(session.showSessionWarningModal.value).toBeFalsy()
    })

    it('does not show after dismissed', () => {
      const { session } = makeSession({ cart: { expiresAt: new Date(NOW + 20 * 1000).toISOString() } })
      session.dismissSessionWarning()
      expect(session.showSessionWarningModal.value).toBeFalsy()
    })

    it('does not show when cart has no items', () => {
      const { session } = makeSession({ cart: { items: [], expiresAt: new Date(NOW + 20 * 1000).toISOString() } })
      expect(session.showSessionWarningModal.value).toBeFalsy()
    })
  })

  describe('setSessionPreview', () => {
    it('sets sessionExpired=true when seconds is 0', () => {
      const { session } = makeSession()
      session.setSessionPreview(0)
      expect(session.sessionExpired.value).toBe(true)
    })

    it('does not set sessionExpired when seconds > 0', () => {
      const { session } = makeSession()
      session.setSessionPreview(30)
      expect(session.sessionExpired.value).toBe(false)
    })

    it('dismisses warning when preview > 30s', () => {
      const { session } = makeSession()
      session.setSessionPreview(300)
      expect(session.sessionWarningDismissed.value).toBe(true)
    })

    it('does not dismiss warning when preview <= 30s', () => {
      const { session } = makeSession()
      session.setSessionPreview(30)
      expect(session.sessionWarningDismissed.value).toBe(false)
    })

    it('overrides cart expiresAt and updates tone immediately', () => {
      const { session } = makeSession()
      session.setSessionPreview(90)
      expect(session.sessionRemainingSeconds.value).toBe(90)
      expect(session.sessionBannerTone.value).toBe('pink')
    })
  })

  describe('dismissSessionWarning', () => {
    it('sets sessionWarningDismissed to true', () => {
      const { session } = makeSession()
      expect(session.sessionWarningDismissed.value).toBe(false)
      session.dismissSessionWarning()
      expect(session.sessionWarningDismissed.value).toBe(true)
    })
  })
})
