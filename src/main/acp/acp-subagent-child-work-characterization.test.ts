// Golden host child records, strip Stop targets and journal subagent rows for scripted Grok
// subagent sequences, so moving them onto the shared tracker changes only what it means to.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _internals } from '../agent-hooks/server'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { summarizeSubagents } from '../native-chat/subagent-tracker/subagent-child-work-characterization.test-fixture'
import { grokSubagentRig } from './acp-subagent-child-work-characterization.test-fixture'

beforeEach(() => _internals.resetCachesForTests())
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close()
  }
  await closeProviderTimelineRigs()
})

const grok = () => grokSubagentRig((close) => cleanup.push(close))

describe('Grok subagent child work (characterization)', () => {
  it('a. one subagent starts, reports tokens and completes', async () => {
    const g = await grok()
    await g.spawn('sub-1', 'Count note lines')
    await g.record('spawned')
    await g.progress('sub-1', 1_200)
    await g.record('tokens')
    await g.finish('sub-1', 'completed', 1_500)
    await g.record('completed')
    await g.endTurn()
    await g.record('turn ended')
    expect(g.steps).toMatchSnapshot()
  })

  it('b. two subagents with the same label, one fails', async () => {
    const g = await grok()
    await g.spawn('sub-1', 'Audit')
    await g.spawn('sub-2', 'Audit')
    await g.record('both spawned')
    await g.progress('sub-1', 100)
    await g.progress('sub-2', 200)
    await g.record('tokens')
    await g.finish('sub-1', 'failed')
    await g.record('first fails')
    await g.finish('sub-2', 'completed')
    await g.record('second completes')
    expect(g.steps).toMatchSnapshot()
  })

  it('c. a subagent outlives the parent turn that spawned it', async () => {
    const g = await grok()
    await g.spawn('sub-1', 'List folder files')
    await g.record('spawned')
    await g.endTurn()
    await g.record('parent turn ended')
    await g.progress('sub-1', 900)
    await g.record('tokens after turn')
    await g.finish('sub-1', 'completed')
    await g.record('completed later')
    expect(g.steps).toMatchSnapshot()
  })

  describe('e. a per-subagent Stop Grok answers', () => {
    it('cancelled, then subagent_finished cancelled', async () => {
      const g = await grok()
      await g.spawn('sub-1', 'Audit')
      await g.spawn('sub-2', 'Audit')
      await g.record('both spawned')
      g.agent.on('_x.ai/subagent/cancel', (frame) =>
        g.agent.reply(frame, {
          result: { subagentId: 'sub-1', cancelled: true, outcome: { kind: 'cancelled' } }
        })
      )
      await g.stopRow('sub-1')
      await g.finish('sub-1', 'cancelled')
      await g.record('finished cancelled')
      expect(g.steps).toMatchSnapshot()
    })

    it('already_finished with a status', async () => {
      const g = await grok()
      await g.spawn('sub-1', 'Audit')
      await g.record('spawned')
      g.agent.on('_x.ai/subagent/cancel', (frame) =>
        g.agent.reply(frame, {
          result: {
            subagentId: 'sub-1',
            cancelled: false,
            outcome: { kind: 'already_finished', status: 'completed' }
          }
        })
      )
      await g.stopRow('sub-1')
      expect(g.steps).toMatchSnapshot()
    })
  })

  it('f. the provider session ends with a subagent still working', async () => {
    const g = await grok()
    await g.spawn('sub-1', 'Audit')
    await g.record('spawned')
    g.rig.child().exit()
    await g.record('provider exited')
    expect(g.steps).toMatchSnapshot()
  })

  it('g. 66 subagents spawned in one turn', async () => {
    const g = await grok()
    for (let n = 1; n <= 66; n++) {
      await g.spawn(`sub-${n}`, `Worker ${n}`)
    }
    expect(summarizeSubagents(await g.read())).toMatchSnapshot()
  })
})
