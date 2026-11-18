/**
 * One B2 bucket behind the native API calls `B2Reader` makes, for its `fetchFn` seam. A test
 * puts files with `put`, makes the next call fail with `failNext`, and reads what the reader
 * asked for in `requests`. Only the key `keyId`/`secret` authorises.
 */
export class FakeB2 {
  readonly keyId = 'fake-key-id'
  readonly secret = 'fake-secret'
  readonly bucketId = 'bucket-1'
  readonly requests: { url: string; authorization: string | null; body?: unknown }[] = []
  /** Page size of b2_list_file_names, so a test can make the listing span pages. */
  pageSize = 1000
  /**
   * The bucket an application key restricted to one bucket names when it authorises; `null`
   * for an unrestricted key, which has to look the bucket up by name.
   */
  restrictedTo: string | null

  private readonly files = new Map<string, Uint8Array>()
  private failures: { status: number; code?: string; message: string }[] = []

  constructor(readonly bucketName = 'pauseai-actionhub-backups') {
    this.restrictedTo = bucketName
  }

  put(fileName: string, bytes: Uint8Array | string): void {
    this.files.set(fileName, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes)
  }

  /** Makes the next call answer `status`, with B2's error body unless `code` is omitted. */
  failNext(status: number, code?: string, message = `${code} (key ${this.keyId})`): void {
    this.failures.push({ status, code, message })
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const authorization = headers.get('authorization')
    this.requests.push({ url, authorization, body })

    const failure = this.failures.shift()
    if (failure) {
      return failure.code
        ? Response.json(
            { status: failure.status, code: failure.code, message: failure.message },
            { status: failure.status },
          )
        : new Response(failure.message, { status: failure.status })
    }

    const path = new URL(url).pathname
    if (path === '/b2api/v2/b2_authorize_account') {
      const expected = `Basic ${Buffer.from(`${this.keyId}:${this.secret}`).toString('base64')}`
      if (authorization !== expected) return b2Error(401, 'unauthorized')
      return Response.json({
        accountId: 'account-1',
        apiUrl: 'https://api.fake-b2',
        downloadUrl: 'https://download.fake-b2',
        authorizationToken: 'token-1',
        allowed: this.restrictedTo
          ? { bucketId: this.bucketId, bucketName: this.restrictedTo }
          : { bucketId: null, bucketName: null },
      })
    }
    if (authorization !== 'token-1') return b2Error(401, 'bad_auth_token')
    if (init?.method === 'POST' && headers.get('content-type') !== 'application/json') {
      return b2Error(400, 'bad_request')
    }
    if (path === '/b2api/v2/b2_list_buckets') {
      const found = body.bucketName === this.bucketName
      return Response.json({ buckets: found ? [{ bucketId: this.bucketId }] : [] })
    }
    if (path === '/b2api/v2/b2_list_file_names') {
      if (body.bucketId !== this.bucketId) return b2Error(400, 'bad_bucket_id')
      const names = [...this.files.keys()]
        .filter(
          (n) => n.startsWith(body.prefix) && (!body.startFileName || n >= body.startFileName),
        )
        .sort()
      const page = names.slice(0, Math.min(this.pageSize, body.maxFileCount))
      return Response.json({
        files: page.map((fileName) => ({
          fileName,
          contentLength: this.files.get(fileName)!.length,
          uploadTimestamp: 0,
        })),
        nextFileName: names[page.length] ?? null,
      })
    }
    const prefix = `/file/${this.bucketName}/`
    if (path.startsWith(prefix)) {
      const bytes = this.files.get(decodeURIComponent(path.slice(prefix.length)))
      return bytes ? new Response(new Uint8Array(bytes)) : b2Error(404, 'not_found')
    }
    return b2Error(404, 'not_found')
  }) as typeof fetch
}

function b2Error(status: number, code: string): Response {
  return Response.json({ status, code, message: code }, { status })
}
