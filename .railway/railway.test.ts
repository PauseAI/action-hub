import { createRailwayContext, project, type ServiceNode } from 'railway/iac'
import { describe, expect, it } from 'vitest'

import program from './railway'

// Volumes carry none of a service's fields, so reading them as services only yields undefined.
async function compile(environment: string) {
  const graph = await program(createRailwayContext({ environment }), project)
  return Object.fromEntries((graph.resources as ServiceNode[]).map((r) => [r.address, r]))
}

describe('.railway/railway.ts', () => {
  it('builds web from the Dockerfile with its healthcheck, restart policy and draining', async () => {
    const web = (await compile('production'))['service.web']
    expect(web.source).toMatchObject({ type: 'github', repo: 'PauseAI/action-hub', branch: 'main' })
    expect(web.build).toEqual({ builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' })
    expect(web.deploy).toMatchObject({
      healthcheckPath: '/api/health',
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 3,
      drainingSeconds: 10,
      multiRegionConfig: { 'europe-west4-drams3a': { numReplicas: 1 } },
    })
    expect(web.deploy).not.toHaveProperty('startCommand')
    expect(web.volumeAttachments?.['web-volume']).toMatchObject({
      volume: 'volume.web-volume',
      mountPath: '/data',
    })
  })

  it('runs the cron trigger hourly from Dockerfile.cron and the backup at 03:00', async () => {
    const graph = await compile('production')
    const cron = graph['service.Cron for digest']
    expect(cron.build).toEqual({ builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile.cron' })
    expect(cron.deploy).toMatchObject({ cronSchedule: '0 * * * *', restartPolicyType: 'NEVER' })
    expect(cron.deploy).not.toHaveProperty('startCommand')

    const backup = graph['service.backup']
    expect(backup.source).toMatchObject({ image: 'ghcr.io/pauseai/backup-image:1.0.0' })
    expect(backup.deploy).toMatchObject({ cronSchedule: '0 3 * * *', restartPolicyType: 'NEVER' })
  })

  // A variable on Railway that is missing here plans as a destructive delete.
  it('keeps every production variable, by name only', async () => {
    const graph = await compile('production')
    const names = (address: string) => Object.keys(graph[address].variables ?? {}).sort()
    expect(names('service.web')).toEqual([
      'ADMIN_EMAILS',
      'APP_URL',
      'CRON_SECRET',
      'DATABASE_URL',
      'FROM_EMAIL',
      'GOOGLE_CLIENT_ID',
      'NEXT_PUBLIC_GA_MEASUREMENT_ID',
      'REPLY_TO_EMAIL',
      'RESEND_API_KEY',
      'SENTRY_AUTH_TOKEN',
      'SENTRY_DSN',
    ])
    expect(names('service.Cron for digest')).toEqual(['CRON_HEALTHCHECK_URL', 'CRON_SECRET'])
    expect(names('service.backup')).toEqual([
      'BACKUP_AGE_RECIPIENTS',
      'BACKUP_B2_BUCKET',
      'BACKUP_B2_KEY_ID',
      'BACKUP_B2_REGION',
      'BACKUP_B2_SECRET',
      'BACKUP_HEALTHCHECK_URL',
      'BACKUP_NAME',
      'DATABASE_URL',
    ])
    for (const resource of Object.values(graph)) {
      for (const value of Object.values(resource.variables ?? {})) {
        expect(value).toEqual({ type: 'preserve' })
      }
    }
  })

  it('declares nothing beyond the three services and the web volume', async () => {
    expect(Object.keys(await compile('production')).sort()).toEqual([
      'service.Cron for digest',
      'service.backup',
      'service.web',
      'volume.web-volume',
    ])
  })

  it('refuses any environment but production', async () => {
    await expect(compile('preview')).rejects.toThrow('describes production, not "preview"')
  })
})
