/**
 * fiona/stepTimer.js
 *
 * How long each step of a request took (user read, active guestbooks, the live Fiona read, ...): for the Server-Timing header and
 * for the read-only `timings` probe (see timingLog.js). Names and durations only.
 */
export function createStepTimer ({ now = () => performance.now() } = {}) {
  const startedAt = now()
  const steps = []
  const details = {}

  return {
    /** Runs `fn`, records how long it took (also when it fails) and returns what it returned. */
    async step (name, fn) {
      const stepStart = now()
      let failed = false
      try {
        return await fn()
      } catch (err) {
        failed = true
        throw err
      } finally {
        const entry = { name, ms: Math.round(now() - stepStart) }
        if (failed) entry.failed = true
        steps.push(entry)
      }
    },
    /** Notes something measured during the request (for example the time of each Fiona call) next to the steps. */
    detail (name, value) {
      details[name] = value
    },
    summary () {
      const summary = { total: Math.round(now() - startedAt), steps: [...steps] }
      if (Object.keys(details).length) summary.details = { ...details }
      return summary
    },
    /** A Server-Timing header value: "user;dur=12, guestbooks;dur=3, total;dur=20". */
    serverTiming () {
      const { total, steps: done } = this.summary()
      const token = name => String(name).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'step'
      return [...done.map(step => `${token(step.name)};dur=${step.ms}`), `total;dur=${total}`].join(', ')
    }
  }
}

/** A timer that only runs the step: for callers that were not given one. */
export const noopTimer = {
  step: (name, fn) => fn(),
  detail: () => {},
  summary: () => ({ total: 0, steps: [] }),
  serverTiming: () => ''
}
