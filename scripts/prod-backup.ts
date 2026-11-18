/**
 * Reads production's nightly dumps, which PauseAI/infra's backup-image service uploads to B2 as
 * `backups/actionhub-<UTC time>.dump.age`: `pg_dump --format=custom` of the whole database,
 * encrypted with age. Reading takes the bucket's read-only key and Action Hub's age identity,
 * both kept in Psono. The identity is read from a file on the developer's machine and is never
 * a deployed variable.
 */

import { readFileSync } from 'node:fs'
import { Decrypter } from 'age-encryption'

export const DEFAULT_BUCKET = 'pauseai-actionhub-backups'

const PREFIX = 'backups/actionhub-'
const DUMP_NAME = /^backups\/actionhub-(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})\.dump\.age$/

/** The service runs daily, so a newest dump older than this means recent runs failed. */
export const STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000

export interface BackupFile {
  fileName: string
  contentLength: number
}

/** When the dump was taken, from its name. */
export function dumpTakenAt(fileName: string): Date {
  const m = DUMP_NAME.exec(fileName)
  if (!m) throw new Error(`Not a backup dump name: ${fileName}`)
  return new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`)
}

/**
 * The dump taken most recently. Names carry the time and sort by it; upload times do not count,
 * since a file copied between buckets gets a new one.
 */
export function newestDump(files: BackupFile[]): BackupFile | undefined {
  return files
    .filter((f) => DUMP_NAME.test(f.fileName))
    .reduce<BackupFile | undefined>((a, b) => (a && a.fileName > b.fileName ? a : b), undefined)
}

interface B2Session {
  apiUrl: string
  downloadUrl: string
  authToken: string
  bucketId: string
}

/**
 * Lists and downloads dumps with B2's native API. Errors give B2's status and code but never its
 * message, which can quote the key ID. `fetchFn` is the network seam; tests pass a fake bucket.
 */
export class B2Reader {
  private session?: Promise<B2Session>

  constructor(
    private readonly keyId: string,
    private readonly secret: string,
    readonly bucket: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async call(what: string, url: string, init: RequestInit): Promise<Response> {
    const res = await this.fetchFn(url, init)
    if (res.ok) return res
    const code = await res
      .json()
      .then((b: { code?: string }) => b.code)
      .catch(() => undefined)
    throw new Error(`B2 ${what} failed: ${res.status}${code ? ` ${code}` : ''}`)
  }

  private authorize(): Promise<B2Session> {
    this.session ??= (async () => {
      const basic = Buffer.from(`${this.keyId}:${this.secret}`).toString('base64')
      const res = await this.call(
        'authorisation',
        'https://api.backblazeb2.com/b2api/v2/b2_authorize_account',
        { headers: { Authorization: `Basic ${basic}` } },
      )
      const auth = (await res.json()) as {
        accountId: string
        apiUrl: string
        downloadUrl: string
        authorizationToken: string
        allowed?: { bucketId?: string | null; bucketName?: string | null }
      }
      const session = {
        apiUrl: auth.apiUrl,
        downloadUrl: auth.downloadUrl,
        authToken: auth.authorizationToken,
      }
      const allowed = auth.allowed
      if (allowed?.bucketId) {
        if (allowed.bucketName !== this.bucket) {
          throw new Error(`This B2 key is for bucket ${allowed.bucketName}, not ${this.bucket}`)
        }
        return { ...session, bucketId: allowed.bucketId }
      }
      const list = await this.call('list buckets', `${auth.apiUrl}/b2api/v2/b2_list_buckets`, {
        method: 'POST',
        headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: auth.accountId, bucketName: this.bucket }),
      })
      const { buckets } = (await list.json()) as { buckets: { bucketId: string }[] }
      if (!buckets.length) throw new Error(`B2 bucket ${this.bucket} not found`)
      return { ...session, bucketId: buckets[0].bucketId }
    })()
    return this.session
  }

  /** Every dump file under the backup-image's prefix for this app. */
  async listDumps(): Promise<BackupFile[]> {
    const s = await this.authorize()
    const files: BackupFile[] = []
    let startFileName: string | null = null
    do {
      const res = await this.call('list files', `${s.apiUrl}/b2api/v2/b2_list_file_names`, {
        method: 'POST',
        headers: { Authorization: s.authToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bucketId: s.bucketId,
          prefix: PREFIX,
          maxFileCount: 1000,
          ...(startFileName ? { startFileName } : {}),
        }),
      })
      const page = (await res.json()) as { files: BackupFile[]; nextFileName: string | null }
      files.push(...page.files.map(({ fileName, contentLength }) => ({ fileName, contentLength })))
      startFileName = page.nextFileName
    } while (startFileName)
    return files
  }

  async download(file: BackupFile): Promise<Uint8Array> {
    const s = await this.authorize()
    const res = await this.call(
      'download',
      `${s.downloadUrl}/file/${this.bucket}/${file.fileName.split('/').map(encodeURIComponent).join('/')}`,
      { headers: { Authorization: s.authToken } },
    )
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length !== file.contentLength) {
      throw new Error(`Download incomplete: got ${bytes.length} of ${file.contentLength} bytes`)
    }
    return bytes
  }
}

/**
 * Decrypts a dump with the age identity file at `identityPath` (as `age-keygen` writes it:
 * comments and one or more `AGE-SECRET-KEY-` lines). The plaintext stays in memory.
 */
export async function decryptDump(
  encrypted: Uint8Array,
  identityPath: string,
): Promise<Uint8Array> {
  const keys = readFileSync(identityPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('AGE-SECRET-KEY-'))
  if (!keys.length) throw new Error(`${identityPath} holds no AGE-SECRET-KEY line`)
  const decrypter = new Decrypter()
  for (const key of keys) decrypter.addIdentity(key)
  try {
    return await decrypter.decrypt(encrypted)
  } catch (err) {
    // age's own messages name the failure (no matching identity, a damaged file), never the key.
    throw new Error(`Could not decrypt the dump: ${err instanceof Error ? err.message : err}`)
  }
}
