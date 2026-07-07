// Start permissive; tighten once real traffic is observed.
// NOTE: counters are in-process — valid only while the app runs as a single container.
// If DO ever scales to >1 replica, move to a shared store (Strapi table or Redis).
export const CART_LIMITS = {
  general:             { max: 60, windowMs: 60_000 },   // any cart op: 60/min/IP
  anonCreate:          { max: 10, windowMs: 600_000 },  // anon cart creation: 10/10min/IP
  maxItemsPerCart:     50,
  guestCartTtlMs:      2 * 60 * 60_000,                 // 2 h
  hardDeleteAfterDays: 2,
}
