import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Encrypter, generateIdentity, identityToRecipient } from 'age-encryption'
import { FakeB2 } from '@/test/fakes/b2'
import {
  B2Reader,
  DEFAULT_BUCKET,
  decryptDump,
  dumpTakenAt,
  newestDump,
  readAgeIdentity,
} from './prod-backup'

const file = (fileName: string, contentLength = 1) => ({ fileName, contentLength })

describe('newestDump', () => {
  it("picks the newest backup-image dump by the time in its name, ignoring the app's old dumps", () => {
    const files = [
      file('backups/actionhub-2026-11-17_030012.dump.age'),
      file('backups/actionhub-2026-11-18_030009.dump.age'),
      file('backups/catalyse-2026-11-19_080000.dump'),
      file('backups/actionhub-2026-11-19_030000.dump.age.part'),
      file('backups/actionhub-2026-11-16_030001.dump.age'),
    ]
    expect(newestDump(files)?.fileName).toBe('backups/actionhub-2026-11-18_030009.dump.age')
    expect(newestDump([file('backups/catalyse-2026-11-19_080000.dump')])).toBeUndefined()
  })

  it('reads the time a dump was taken from its name', () => {
    expect(dumpTakenAt('backups/actionhub-2026-11-18_030009.dump.age')).toEqual(
      new Date('2026-11-18T03:00:09Z'),
    )
    expect(() => dumpTakenAt('backups/catalyse-2026-11-18_030009.dump')).toThrow(
      'Not a backup dump name',
    )
  })
})

describe('B2Reader', () => {
  let b2: FakeB2
  const reader = (bucket = DEFAULT_BUCKET, secret = b2.secret) =>
    new B2Reader(b2.keyId, secret, bucket, b2.fetch)

  beforeEach(() => {
    b2 = new FakeB2(DEFAULT_BUCKET)
    b2.put('backups/actionhub-2026-11-18_030009.dump.age', 'encrypted bytes')
    b2.put('backups/catalyse-2026-11-18_080000.dump', 'old plaintext')
  })

  it('lists the dumps under the backup-image prefix and downloads one, authorising once', async () => {
    const r = reader()
    const files = await r.listDumps()
    expect(files).toEqual([file('backups/actionhub-2026-11-18_030009.dump.age', 15)])
    expect(new TextDecoder().decode(await r.download(files[0]))).toBe('encrypted bytes')
    const auths = b2.requests.filter((q) => q.url.endsWith('b2_authorize_account'))
    expect(auths).toHaveLength(1)
    expect(b2.requests.find((q) => q.url.endsWith('b2_list_file_names'))?.body).toMatchObject({
      bucketId: b2.bucketId,
      prefix: 'backups/actionhub-',
    })
  })

  it('follows the listing across pages', async () => {
    b2.pageSize = 1
    b2.put('backups/actionhub-2026-11-17_030000.dump.age', 'a')
    b2.put('backups/actionhub-2026-11-19_030000.dump.age', 'b')
    const names = (await reader().listDumps()).map((f) => f.fileName)
    expect(names).toEqual([
      'backups/actionhub-2026-11-17_030000.dump.age',
      'backups/actionhub-2026-11-18_030009.dump.age',
      'backups/actionhub-2026-11-19_030000.dump.age',
    ])
  })

  it('looks the bucket up by name when the key is not restricted to one', async () => {
    b2.restrictedTo = null
    expect(await reader().listDumps()).toHaveLength(1)
    await expect(reader('another-bucket').listDumps()).rejects.toThrow(
      'B2 bucket another-bucket not found',
    )
  })

  it('refuses a key restricted to another bucket', async () => {
    await expect(reader('another-bucket').listDumps()).rejects.toThrow(
      `This B2 key is for bucket ${DEFAULT_BUCKET}, not another-bucket`,
    )
  })

  it("reports B2's status and code, never its message or the key", async () => {
    const err = await reader(DEFAULT_BUCKET, 'wrong')
      .listDumps()
      .catch((e: Error) => e)
    expect(String(err)).toBe('Error: B2 authorisation failed: 401 unauthorized')

    b2.failNext(503, 'service_unavailable')
    const quiet = await reader()
      .listDumps()
      .catch((e: Error) => e)
    expect(String(quiet)).toBe('Error: B2 authorisation failed: 503 service_unavailable')
    expect(String(quiet)).not.toContain(b2.keyId)

    b2.failNext(502, undefined, '<html>bad gateway</html>')
    await expect(reader().listDumps()).rejects.toThrow(/^B2 authorisation failed: 502$/)
  })

  it('refuses a download that came back short', async () => {
    await expect(
      reader().download(file('backups/actionhub-2026-11-18_030009.dump.age', 99)),
    ).rejects.toThrow('Download incomplete: got 15 of 99 bytes')
    await expect(
      reader().download(file('backups/actionhub-2026-01-01_000000.dump.age')),
    ).rejects.toThrow('B2 download failed: 404 not_found')
  })
})

describe('readAgeIdentity and decryptDump', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'age-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function encryptTo(identity: string, plaintext: string): Promise<Uint8Array> {
    const e = new Encrypter()
    e.addRecipient(await identityToRecipient(identity))
    return e.encrypt(plaintext)
  }
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

  it('decrypts with an identity file as age-keygen writes it', async () => {
    const other = await generateIdentity()
    const ours = await generateIdentity()
    const path = join(dir, 'key.txt')
    writeFileSync(
      path,
      `# created: 2026-11-18T00:00:00Z\n# public key: ${await identityToRecipient(ours)}\n${other}\n${ours}\n`,
    )
    const identity = readAgeIdentity({ BACKUP_AGE_IDENTITY_FILE: path })!
    expect(identity.source).toBe(path)
    expect(text(await decryptDump(await encryptTo(ours, 'PGDMP...'), identity))).toBe('PGDMP...')
  })

  it('prefers an identity held in BACKUP_AGE_IDENTITY, on one line or several', async () => {
    const ours = await generateIdentity()
    const env = { BACKUP_AGE_IDENTITY: `# preview  ${ours}`, BACKUP_AGE_IDENTITY_FILE: '/nowhere' }
    const identity = readAgeIdentity(env)!
    expect(identity.source).toBe('BACKUP_AGE_IDENTITY')
    expect(text(await decryptDump(await encryptTo(ours, 'PGDMP'), identity))).toBe('PGDMP')
    expect(readAgeIdentity({})).toBeUndefined()
  })

  it('fails without a key, or with the wrong one, and never prints the key', async () => {
    await expect(
      decryptDump(new Uint8Array(), { text: '# public key: age1...', source: 'key.txt' }),
    ).rejects.toThrow('key.txt holds no AGE-SECRET-KEY')

    const wrong = await generateIdentity()
    const err = await decryptDump(await encryptTo(await generateIdentity(), 'x'), {
      text: wrong,
      source: 'BACKUP_AGE_IDENTITY',
    }).catch((e: Error) => e)
    expect(String(err)).toMatch(/^Error: Could not decrypt the dump: /)
    expect(String(err)).not.toContain(wrong)
  })
})
