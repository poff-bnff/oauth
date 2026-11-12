/**
 * fiona/xapiAccountReport.js
 *
 * Read-only probe (mode `xapiAccount` of POST /api/sync/fiona, with `userIds` and "probe": true): the untouched XAPI record
 * GET /account/details/MyPoff/{userId}/ of a few accounts, for the owner of an account to see what Fiona holds about them. It
 * holds personal data (name, contact details), so the mode refuses to run without "probe": true and answers for at most 3 ids.
 */
const PROVIDER = 'MyPoff'
const MAX_IDS = 3

const asList = value => (Array.isArray(value) ? value : [])
const usable = value => value !== null && value !== undefined && String(value).trim() !== '' && Number(value) !== 0
const isNoAccount = err => [400, 404].includes(err?.statusCode ?? err?.status ?? err?.response?.status)

export async function xapiAccountReport ({ userIds = [], xapi } = {}) {
  const ids = [...new Set(asList(userIds).filter(usable).map(id => String(id).trim()))].slice(0, MAX_IDS)
  const accounts = []
  for (const id of ids) {
    try {
      accounts.push({ userId: id, found: true, record: await xapi.getRaw(`/account/details/${PROVIDER}/${encodeURIComponent(id)}/`) })
    } catch (err) {
      accounts.push(isNoAccount(err) ? { userId: id, found: false } : { userId: id, found: null, error: String(err?.message || err) })
    }
  }
  return { accounts }
}
