/**
 * Reads production's nightly dumps, which PauseAI/infra's backup-image service uploads to B2 as
 * `backups/actionhub-<UTC time>.dump.age`: `pg_dump --format=custom` of the whole database,
 * encrypted with age. Reading takes the bucket's read-only key and an age identity the dumps are
 * encrypted to: Action Hub's own, kept in Psono and read from a file on a developer's machine,
 * or, in the preview environment, a preview-only identity held in a variable.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Decrypter } from 'age-encryption'
import { logger } from '../lib/logger'

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

export interface AgeIdentity {
  /** The identity as `age-keygen` writes it: comments and one or more `AGE-SECRET-KEY-` keys. */
  text: string
  /** Where it came from, for error messages: a file path or the variable's name. */
  source: string
}

/**
 * The age identity from `BACKUP_AGE_IDENTITY` itself, for an environment that cannot hold a
 * file (a Railway preview, with an identity of its own), or else from the file
 * `BACKUP_AGE_IDENTITY_FILE` names.
 */
export function readAgeIdentity(
  env: Record<string, string | undefined> = process.env,
): AgeIdentity | undefined {
  if (env.BACKUP_AGE_IDENTITY)
    return { text: env.BACKUP_AGE_IDENTITY, source: 'BACKUP_AGE_IDENTITY' }
  const path = env.BACKUP_AGE_IDENTITY_FILE
  return path ? { text: readFileSync(path, 'utf8'), source: path } : undefined
}

/** Decrypts a dump with `identity`. The plaintext stays in memory. */
export async function decryptDump(
  encrypted: Uint8Array,
  identity: AgeIdentity,
): Promise<Uint8Array> {
  const keys = identity.text.split(/\s+/).filter((t) => t.startsWith('AGE-SECRET-KEY-'))
  if (!keys.length) throw new Error(`${identity.source} holds no AGE-SECRET-KEY`)
  const decrypter = new Decrypter()
  for (const key of keys) decrypter.addIdentity(key)
  try {
    return await decrypter.decrypt(encrypted)
  } catch (err) {
    // age's own messages name the failure (no matching identity, a damaged file), never the key.
    throw new Error(`Could not decrypt the dump: ${err instanceof Error ? err.message : err}`)
  }
}

/**
 * Downloads the newest dump with the bucket's read-only key from `env`, warning when it is stale.
 * `fetchFn` is the network seam, as for `B2Reader`.
 */
export async function downloadNewestDump(
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<Uint8Array> {
  const keyId = env.BACKUP_B2_READ_KEY_ID
  const secret = env.BACKUP_B2_READ_SECRET
  if (!keyId || !secret) {
    throw new Error(
      'BACKUP_B2_READ_KEY_ID and BACKUP_B2_READ_SECRET must hold the bucket\'s read-only key (Psono: "actionhub-backup-read"), or pass --file with a dump you downloaded.',
    )
  }
  const b2 = new B2Reader(keyId, secret, env.BACKUP_B2_BUCKET || DEFAULT_BUCKET, fetchFn)

  logger.info(`Listing backups in ${b2.bucket}...`)
  const latest = newestDump(await b2.listDumps())
  if (!latest) throw new Error(`No backups/actionhub-*.dump.age files in ${b2.bucket}.`)
  logger.info(`Latest backup: ${latest.fileName} (${(latest.contentLength / 1024).toFixed(0)} KB)`)
  const age = Date.now() - dumpTakenAt(latest.fileName).getTime()
  if (age > STALE_AFTER_MS) {
    logger.warn(
      `This dump is ${Math.floor(age / 86_400_000)} days old: recent nightly backups may have failed.`,
    )
  }

  logger.info('Downloading...')
  return b2.download(latest)
}

/**
 * Restores the dump into the database at `dbUrl` (a libpq URL), whose public schema the caller
 * has just emptied, feeding pg_restore from memory so the plaintext never touches disk. The
 * dump's own `CREATE SCHEMA public` entry is filtered out of the restore list, since the schema
 * already exists; `pg_restore -l`/`-L` is the documented way to skip entries. A dump piped out of
 * pg_dump has no data offsets, so pg_restore reads it in order, which the filtered list keeps.
 */
export function restoreIntoEmptySchema(dump: Uint8Array, dbUrl: string): void {
  const filtered = pgRestore(['-l'], dump)
    .split('\n')
    .filter((line) => !/ SCHEMA - public /.test(line))
    .join('\n')
  const dir = mkdtempSync(join(tmpdir(), 'restore-dump-'))
  try {
    const listPath = join(dir, 'restore.list')
    writeFileSync(listPath, filtered)
    pgRestore(['--no-owner', '--no-privileges', '--use-list', listPath, '--dbname', dbUrl], dump)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Runs pg_restore with the dump on stdin and returns its output. `-l` exits once it has read the
 * table of contents, so a broken pipe is expected; the exit status decides success.
 */
function pgRestore(args: string[], dump: Uint8Array): string {
  const r = spawnSync('pg_restore', args, {
    input: dump,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  if (r.error && (r.error as NodeJS.ErrnoException).code !== 'EPIPE') throw r.error
  if (r.status !== 0) throw new Error(`pg_restore exited with ${r.status ?? r.signal}`)
  return r.stdout
}
