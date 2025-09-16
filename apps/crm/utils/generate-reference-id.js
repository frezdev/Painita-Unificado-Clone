export const generateReferenceId = async ({customer_id = '', amount = 0}) => {
  const timestamp = Date.now()
  return Buffer.from(`${timestamp}:${customer_id}:${amount}`).toString('base64').replace('==', '')
}