/**
 * Reactive session-timer state and pure derived values.
 * Mutating actions (touchCartSession, startSessionClock, etc.) remain in index.vue
 * because they depend on context/fetch/navigation. This composable owns only state + computeds.
 *
 * Usage:
 *   const session = useCheckoutSession({ cart, route, runtime })
 */
export function useCheckoutSession ({ cart, route, runtime }) {
  const sessionNow = ref(Date.now())
  const touchingCartSession = ref(false)
  const sessionExpired = ref(false)
  const sessionWarningDismissed = ref(false)
  const sessionPreviewExpiresAt = ref(null)

  const sessionRemainingSeconds = computed(() => {
    if (!cart.value?.items?.length) return 0
    if (sessionPreviewExpiresAt.value) {
      return Math.max(0, Math.floor((sessionPreviewExpiresAt.value - sessionNow.value) / 1000))
    }
    if (!cart.value.expiresAt) return cart.value.secondsRemaining ?? 1800
    return Math.max(0, Math.floor((new Date(cart.value.expiresAt).getTime() - sessionNow.value) / 1000))
  })

  const sessionDisplay = computed(() => {
    const seconds = sessionRemainingSeconds.value
    const minutes = Math.floor(seconds / 60)
    const rest = seconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
  })

  const sessionBannerTone = computed(() => {
    if (!cart.value?.items?.length) return 'normal'
    if (sessionRemainingSeconds.value <= 30) return 'warning'
    if (sessionRemainingSeconds.value <= 105) return 'pink'
    if (sessionRemainingSeconds.value <= 270) return 'yellow'
    return 'normal'
  })

  const showSessionWarningModal = computed(() =>
    cart.value?.items?.length &&
    sessionRemainingSeconds.value > 0 &&
    sessionRemainingSeconds.value <= 30 &&
    !sessionWarningDismissed.value &&
    !sessionExpired.value
  )

  function setSessionPreview (seconds) {
    sessionNow.value = Date.now()
    sessionPreviewExpiresAt.value = Date.now() + seconds * 1000
    sessionExpired.value = seconds <= 0
    sessionWarningDismissed.value = seconds > 30
  }

  function dismissSessionWarning () {
    sessionWarningDismissed.value = true
  }

  return {
    sessionNow,
    touchingCartSession,
    sessionExpired,
    sessionWarningDismissed,
    sessionPreviewExpiresAt,
    sessionRemainingSeconds,
    sessionDisplay,
    sessionBannerTone,
    showSessionWarningModal,
    setSessionPreview,
    dismissSessionWarning
  }
}
