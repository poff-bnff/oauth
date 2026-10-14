// Which email addresses cannot be used to reach a buyer.
//
// Smart-ID, Mobile-ID and ID-card logins create accounts whose email is `<personal code>@eesti.ee`.
// Nothing sent there is ever delivered (the eesti.ee mail server refuses our mail provider), so such
// an address is no better than none: the order confirmation and the passes would vanish.
//
// Shared by pages and server. Strapi (web2021) carries an identical copy of this rule — keep them in
// step.
export function isUndeliverableEmail (email) {
  const normalized = String(email ?? '').trim().toLowerCase()
  if (!normalized) return true
  return normalized.endsWith('@eesti.ee')
}
