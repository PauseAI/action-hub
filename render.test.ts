import { readFileSync } from 'node:fs'
import { createRailwayContext, project, type ServiceNode } from 'railway/iac'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import railway from './.railway/railway'

type EnvVar = { key: string; value?: unknown; sync?: boolean; generateValue?: boolean }
type Service = {
  type: string
  name: string
  region: string
  dockerfilePath: string
  healthCheckPath?: string
  schedule?: string
  envVars: EnvVar[]
}
type Blueprint = {
  services: Service[]
  databases: { name: string; region: string; postgresMajorVersion: string }[]
}

const blueprint = parse(readFileSync('render.yaml', 'utf8')) as Blueprint
const render = (name: string) => blueprint.services.find((s) => s.name === name)!
const keys = (s: Service) => s.envVars.map((v) => v.key).sort()

async function onRailway(address: string): Promise<ServiceNode> {
  const graph = await railway(createRailwayContext({ environment: 'production' }), project)
  return (graph.resources as ServiceNode[]).find((r) => r.address === address)!
}

// The standby only helps if it runs what production runs, so each check reads Railway's side
// from .railway/railway.ts rather than repeating it.
describe('render.yaml', () => {
  it('builds web from the same Dockerfile and health check as production', async () => {
    const railwayWeb = await onRailway('service.web')
    const web = render('actionhub-web')
    expect(web.type).toBe('web')
    expect(web.dockerfilePath).toBe(`./${railwayWeb.build?.dockerfilePath}`)
    expect(web.healthCheckPath).toBe(railwayWeb.deploy?.healthcheckPath)
  })

  it('runs the same cron trigger on the same schedule', async () => {
    const railwayCron = await onRailway('service.Cron for digest')
    const cron = render('actionhub-cron')
    expect(cron.type).toBe('cron')
    expect(cron.dockerfilePath).toBe(`./${railwayCron.build?.dockerfilePath}`)
    expect(cron.schedule).toBe(railwayCron.deploy?.cronSchedule)
  })

  it("declares every one of production's variables, plus the standby's own", async () => {
    const names = async (address: string) => Object.keys((await onRailway(address)).variables!)
    expect(keys(render('actionhub-web'))).toEqual(
      [...(await names('service.web')), 'RAILWAY_ENVIRONMENT_NAME'].sort(),
    )
    expect(keys(render('actionhub-cron'))).toEqual(
      [...(await names('service.Cron for digest')), 'CRON_URL'].sort(),
    )
  })

  it('holds no values: each variable is entered, generated or referenced', () => {
    for (const service of blueprint.services) {
      for (const v of service.envVars) {
        expect(v, `${service.name} ${v.key}`).not.toHaveProperty('value')
        const entered = v.sync === false
        const derived = v.generateValue === true || 'fromDatabase' in v || 'fromService' in v
        expect(entered || derived, `${service.name} ${v.key}`).toBe(true)
      }
    }
  })

  it('puts everything in Frankfurt, on Postgres 18 as production is', () => {
    const regions = [...blueprint.services, ...blueprint.databases].map((r) => r.region)
    expect(new Set(regions)).toEqual(new Set(['frankfurt']))
    expect(blueprint.databases.map((d) => d.postgresMajorVersion)).toEqual(['18'])
  })
})
