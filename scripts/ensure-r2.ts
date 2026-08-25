const BUCKET_NAME = 'komari-nodeget-theme-cache'
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim()

if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId))
  throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID')
if (!apiToken)
  throw new Error('CLOUDFLARE_API_TOKEN is required')

const apiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`
const headers = {
  authorization: `Bearer ${apiToken}`,
  'content-type': 'application/json',
}

interface CloudflareError {
  code?: number
  message?: string
}

interface CloudflareEnvelope {
  success?: boolean
  errors?: CloudflareError[]
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as CloudflareEnvelope
    const messages = body.errors?.flatMap(error => error.message ? [error.message] : []) ?? []
    return messages.join('; ') || `HTTP ${response.status}`
  }
  catch {
    return `HTTP ${response.status}`
  }
}

const existing = await fetch(`${apiBase}/${encodeURIComponent(BUCKET_NAME)}`, { headers })
if (existing.ok) {
  console.log(`R2 bucket ${BUCKET_NAME} already exists`)
  process.exit(0)
}
if (existing.status !== 404)
  throw new Error(`Unable to check R2 bucket: ${await responseMessage(existing)}`)

const created = await fetch(apiBase, {
  method: 'POST',
  headers,
  body: JSON.stringify({ name: BUCKET_NAME }),
})
if (!created.ok)
  throw new Error(`Unable to create R2 bucket: ${await responseMessage(created)}`)

console.log(`Created R2 bucket ${BUCKET_NAME}`)

export {}
