import { describe, it, expect, vi } from 'vitest'
import { prisma } from '@/lib/prisma'
import { CALL_ANSWERED, CALL_POSTED } from '@/lib/calls'
import { createChapter, createCoordinator, createMember, createSkill } from '@/test/factories'
import { clientAs } from '@/test/rpc'

const call = (requestId: number, chapterIds: number[], skillIds: number[] = []) => ({
  title: 'Can anyone proofread?',
  body: 'Two pages, before Friday',
  chapterIds,
  skillIds,
  requestId,
})

const notes = (volunteerId: number, type: string) =>
  prisma.notification.findMany({ where: { volunteerId, type }, orderBy: { id: 'asc' } })

async function setup() {
  const [uk, de] = [await createChapter(), await createChapter()]
  const coordinator = await createCoordinator(uk)
  const asker = await createMember(uk, { name: 'Ada Asker' })
  const taker = await createMember(uk, { name: 'Tom Taker' })
  const helper = await createMember(uk, { name: 'Hal Helper' })
  return { uk, de, coordinator, c: clientAs(coordinator), asker, taker, helper }
}

describe('a request sent as a call', () => {
  it("goes only to the request's chapter, and only while it waits for help", async () => {
    const { uk, de, c, asker } = await setup()
    const asked = await clientAs(asker).requests.ask({ title: 'Proofread the flyer' })
    for (const chapterIds of [[], [de.id], [uk.id, de.id]]) {
      await expect(c.calls.send(call(asked.id, chapterIds))).rejects.toMatchObject({
        message: "A chapter's request can only be sent to that chapter",
      })
    }
    // Global requests go wherever the coordinator chooses.
    const global = await clientAs(asker).requests.ask({ title: 'Anywhere', global: true })
    await c.calls.send(call(global.id, [uk.id, de.id]))
    await c.calls.send(call(global.id, []))

    await prisma.workItem.update({ where: { id: asked.id }, data: { status: 'completed' } })
    await expect(c.calls.send(call(asked.id, [uk.id]))).rejects.toMatchObject({
      message: 'That request is not waiting for help',
    })
    const project = await prisma.workItem.create({
      data: { type: 'PROJECT', status: 'in_progress', title: 'Ordinary' },
    })
    const ordinary = await prisma.workItem.create({
      data: { type: 'TASK', status: 'not_started', title: 'Not a request', parentId: project.id },
    })
    await expect(c.calls.send(call(ordinary.id, []))).rejects.toMatchObject({
      message: 'That request is not waiting for help',
    })
  })

  it('is answered by taking the request, then by helping on it, and tells the sender', async () => {
    const { uk, coordinator, c, asker, taker, helper } = await setup()
    const skill = await createSkill()
    const asked = await clientAs(asker).requests.ask({ title: 'Run a stall', helpersWanted: 1 })
    await prisma.volunteerSkill.create({ data: { volunteerId: taker.id, skillId: skill.id } })
    const { id: callId } = await c.calls.send(call(asked.id, [uk.id], [skill.id]))

    const [posted] = await notes(taker.id, CALL_POSTED)
    expect(posted.link).toBe('/calls')
    const forTaker = async () => (await clientAs(taker).calls.forMe()).find((x) => x.id === callId)!
    expect((await forTaker()).request).toMatchObject({
      taskId: asked.id,
      title: 'Run a stall',
      canTake: true,
      canHelp: false,
      mine: false,
    })

    // A written answer is not how this call is answered.
    await expect(clientAs(taker).calls.respond({ callId, message: 'I can' })).rejects.toMatchObject(
      { message: 'Answer this call by taking its request' },
    )

    expect(await clientAs(taker).calls.takeRequest({ callId })).toMatchObject({
      message: 'The request is yours',
      projectId: asked.projectId,
      taskId: asked.id,
    })
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: asked.id } })).assigneeId).toBe(
      taker.id,
    )
    expect((await forTaker()).request).toMatchObject({ mine: true, canTake: false })
    await vi.waitFor(async () => expect(await notes(asker.id, 'request_taken')).toHaveLength(1))
    expect(await notes(coordinator.id, CALL_ANSWERED)).toEqual([
      expect.objectContaining({ body: "Took 'Run a stall'" }),
    ])
    await expect(clientAs(taker).calls.withdraw({ callId })).rejects.toMatchObject({
      message: 'Your answer stands while you are on its request',
    })

    const forHelper = (await clientAs(helper).calls.forMe()).find((x) => x.id === callId)!
    expect(forHelper.request).toMatchObject({ canTake: false, canHelp: true })
    expect(await clientAs(helper).calls.takeRequest({ callId })).toMatchObject({
      message: "You're helping on it",
    })
    expect((await c.calls.responses({ callId })).map((r) => [r.name, r.message])).toEqual([
      ['Tom Taker', "Took 'Run a stall'"],
      ['Hal Helper', "Helping on 'Run a stall'"],
    ])

    // Full now: nobody else is needed, so it is no longer offered, and is not sent again.
    const late = await createMember(uk)
    expect((await clientAs(late).calls.forMe()).map((x) => x.id)).not.toContain(callId)
    await expect(clientAs(late).calls.takeRequest({ callId })).rejects.toMatchObject({
      message: 'This request needs nobody else now',
    })
    await expect(c.calls.send(call(asked.id, [uk.id]))).rejects.toMatchObject({
      message: 'That request is not waiting for help',
    })
    // Those who answered still see it, closed.
    expect((await forTaker()).open).toBe(false)
  })

  it('leaves plain calls as they were, and cannot be taken without a request', async () => {
    const { uk, c, taker } = await setup()
    const { id: callId } = await c.calls.send({
      title: 'Photos',
      body: 'Of your events',
      chapterIds: [uk.id],
      skillIds: [],
    })
    expect((await clientAs(taker).calls.forMe()).find((x) => x.id === callId)?.request).toBeNull()
    await expect(clientAs(taker).calls.takeRequest({ callId })).rejects.toMatchObject({
      message: 'This call carries no request',
    })
    await clientAs(taker).calls.respond({ callId, message: 'Yes' })
    await clientAs(taker).calls.withdraw({ callId })
  })

  it('lets someone taken off the request withdraw, and rewrites the answer if they come back', async () => {
    const { uk, c, asker, taker } = await setup()
    const asked = await clientAs(asker).requests.ask({ title: 'Count leaflets' })
    const { id: callId } = await c.calls.send(call(asked.id, [uk.id]))
    // Released, as the nudge job or chapter staff would.
    const release = () =>
      prisma.workItem.update({
        where: { id: asked.id },
        data: { assigneeId: null, status: 'not_started' },
      })
    await clientAs(taker).calls.takeRequest({ callId })
    await release()
    await clientAs(taker).calls.takeRequest({ callId })
    expect((await c.calls.responses({ callId })).map((r) => r.message)).toEqual([
      "Took 'Count leaflets'",
    ])
    await release()
    await clientAs(taker).calls.withdraw({ callId })
    expect(await c.calls.responses({ callId })).toEqual([])
  })

  it('cannot be taken while started by nobody, and is closed, answers kept, when the request goes', async () => {
    const { uk, c, coordinator, asker, taker, helper } = await setup()
    const asked = await clientAs(asker).requests.ask({ title: 'Odd one' })
    const { id: callId } = await c.calls.send(call(asked.id, [uk.id]))
    await prisma.workItem.update({ where: { id: asked.id }, data: { status: 'in_progress' } })
    expect((await clientAs(helper).calls.forMe()).map((x) => x.id)).not.toContain(callId)
    await expect(c.calls.send(call(asked.id, [uk.id]))).rejects.toMatchObject({
      message: 'That request is not waiting for help',
    })
    await prisma.workItem.update({ where: { id: asked.id }, data: { status: 'not_started' } })
    await clientAs(taker).calls.takeRequest({ callId })
    await clientAs(asker).projects.deleteTask({ projectId: asked.projectId, taskId: asked.id })
    expect(await prisma.call.findUniqueOrThrow({ where: { id: callId } })).toMatchObject({
      requestId: null,
      closedAt: expect.any(Date),
    })
    expect(await clientAs(coordinator).calls.responses({ callId })).toHaveLength(1)
  })
})
