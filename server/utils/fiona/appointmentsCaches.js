/**
 * fiona/appointmentsCaches.js
 *
 * The Strapi reads that GET /api/my/appointments repeated on every page view (2026-11-12: Strapi was overloaded): the full user
 * (every relation of it), the full person (92 fields) and the active guestbooks. Kept in memory for a few minutes; the Fiona
 * side (cards, guestbook accreditation lists, profile slugs, the login search) has its own caches in fiona/myAppointments.js
 * and fiona/loginAppointments.js. A user, person or guestbook change in Strapi reaches this page within these times.
 */
import { createLoaderCache } from './loaderCache.js'

export const USER_TTL_MS = 2 * 60 * 1000
export const PERSON_TTL_MS = 5 * 60 * 1000
export const GUESTBOOKS_TTL_MS = 10 * 60 * 1000

export const userCache = createLoaderCache({ ttlMs: USER_TTL_MS, maxEntries: 500 })
export const personCache = createLoaderCache({ ttlMs: PERSON_TTL_MS, maxEntries: 1000 })
export const guestbookCache = createLoaderCache({ ttlMs: GUESTBOOKS_TTL_MS, maxEntries: 1 })

export function clearAppointmentsCaches () {
  userCache.clear()
  personCache.clear()
  guestbookCache.clear()
}
