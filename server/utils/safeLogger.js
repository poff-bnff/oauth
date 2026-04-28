import { randomUUID } from 'node:crypto'

function resolveRequestId(event) {
  const headerRequestId = getHeader(event, 'x-request-id') || getHeader(event, 'x-correlation-id')
  if (headerRequestId) {
    event.context.requestId = headerRequestId
    return headerRequestId
  }

  if (event.context.requestId) {
    return event.context.requestId
  }

  const generatedRequestId = randomUUID()
  event.context.requestId = generatedRequestId
  return generatedRequestId
}

export function logOperational(event, { route, status, errorCode = null }) {
  const entry = {
    route,
    status,
    requestId: resolveRequestId(event),
    errorCode
  }

  if (status >= 500) {
    console.error(JSON.stringify(entry))
    return
  }

  if (status >= 400) {
    console.warn(JSON.stringify(entry))
    return
  }

  console.info(JSON.stringify(entry))
}
