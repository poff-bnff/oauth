export default defineEventHandler(async (event) => {
  const id = getUserIdFromEvent(event)

  const body = await readMultipartFormData(event)

  console.log('EVENT', event);

  // body.id = id

  console.log('BODYYYY', JSON.stringify(body));

  const user = await setStrapiUser(body)
  return user
})
