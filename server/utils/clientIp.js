export function getClientIp(event) {
  const h = getRequestHeaders(event)
  return h['cf-connecting-ip']
      || (h['x-forwarded-for'] || '').split(',')[0].trim()
      || event.node.req.socket?.remoteAddress
      || 'unknown'
}
