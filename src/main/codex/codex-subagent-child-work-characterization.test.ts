// Golden host child records, strip Stop targets and journal subagent rows for scripted Codex
// subagent sequences, so moving them onto the shared tracker changes only what it means to.

import { describe, expect, it } from 'vitest'
import { agentChildWorkStopTargets } from '../../shared/agent-child-work-stop-targets'
import { createAgentChildWorkAdmission } from '../../shared/agent-status-child-work-admission'
import { reconcileAgentChildWorkEvidence } from '../../shared/agent-status-child-work-reconciliation'
import { projectAgentChildWorkViews } from '../../shared/agent-status-child-work-view'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { createAgentStatusStore } from '../../shared/agent-status-store'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  characterizeSubagents,
  summarizeSubagents
} from '../native-chat/subagent-tracker/subagent-child-work-characterization.test-fixture'
import {
  adapterFor,
  fakeCodex,
  identityFor,
  THREAD_ID
} from './codex-structured-session-adapter-fixture'

const parent = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'folder'
  },
  'session-1'
)

type Frame = { method: string; params: Record<string, unknown> }

const turn = (
  method: 'turn/started' | 'turn/completed',
  threadId: string,
  id: string,
  status = 'completed'
): Frame => ({ method, params: { threadId, turn: { id, status } } })
const spawned = (child: string, name: string, parentTurn = 'p1'): Frame => ({
  method: 'item/started',
  params: {
    threadId: THREAD_ID,
    turnId: parentTurn,
    item: {
      type: 'subAgentActivity',
      id: `spawn-${child}`,
      kind: 'started',
      agentThreadId: child,
      agentPath: `/root/${name}`
    }
  }
})
const tokens = (threadId: string, totalTokens: number): Frame => ({
  method: 'thread/tokenUsage/updated',
  params: { threadId, tokenUsage: { total: { totalTokens } } }
})
const says = (threadId: string, turnId: string, text: string): Frame => ({
  method: 'item/completed',
  params: { threadId, turnId, item: { type: 'agentMessage', id: `msg-${text}`, text } }
})

async function codex() {
  const fake = fakeCodex()
  const store = createAgentStatusStore({ epoch: 'epoch-1', mode: 'authority' })
  expect(store.applyMutation({ parent: { subject: parent } })).not.toBeNull()
  let minted = 0
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: () => `child-${++minted}`
  })
  const adapter = adapterFor(fake, {}, [], {
    onChildWorkEvidence: (_sessionId, evidence) =>
      reconcileAgentChildWorkEvidence({ store, admission, parent, provider: 'codex', evidence })
  })
  // The journal's latest body per item, in first-write order.
  const rows = new Map<string, AgentJournalItemBody>()
  const journal: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => void rows.set(agentJournalItemKey(identity), body),
    appendTombstone: () => {},
    publish: () => {}
  }
  await adapter.acquire({
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-9',
    events: journal
  })
  const connection = () => fake.connections[0]!
  const records = () => store.getChildren(parent)
  const views = () =>
    projectAgentChildWorkViews(
      records(),
      records().flatMap((record) => store.getAliasesForChild(record.childWorkId))
    )
  const read = () =>
    characterizeSubagents({ records: records(), views: views(), rows: [...rows.values()] })
  const steps: unknown[] = []
  const step = (name: string, ...frames: Frame[]) => {
    for (const frame of frames) {
      connection().handlers.onNotification?.(frame.method, frame.params)
    }
    steps.push({ step: name, ...read() })
  }
  const stopRow = async (taskId: string) => {
    const outcome = await adapter.stopBackgroundTasks({
      sessionId: 'session-1',
      fence: 7,
      taskIds: agentChildWorkStopTargets(views(), taskId)
    })
    const calls = connection().calls.filter((call) => call.method === 'turn/interrupt')
    steps.push({ step: `stop ${taskId}`, outcome, calls, ...read() })
  }
  return { adapter, connection, steps, step, read, stopRow }
}

describe('Codex subagent child work (characterization)', () => {
  it('a. one subagent starts, reports tokens and completes', async () => {
    const c = await codex()
    c.step('parent turn', turn('turn/started', THREAD_ID, 'p1'))
    c.step('spawned', spawned('thread-a', 'review'), turn('turn/started', 'thread-a', 'a1'))
    c.step('tokens', tokens('thread-a', 1_200))
    c.step('replied', says('thread-a', 'a1', 'Looks good'))
    c.step('completed', turn('turn/completed', 'thread-a', 'a1'))
    c.step('parent turn ended', turn('turn/completed', THREAD_ID, 'p1'))
    expect(c.steps).toMatchSnapshot()
  })

  it('b. two subagents with the same label, one fails', async () => {
    const c = await codex()
    c.step('parent turn', turn('turn/started', THREAD_ID, 'p1'))
    c.step(
      'both spawned',
      spawned('thread-a', 'audit'),
      turn('turn/started', 'thread-a', 'a1'),
      spawned('thread-b', 'audit'),
      turn('turn/started', 'thread-b', 'b1')
    )
    c.step('tokens', tokens('thread-a', 100), tokens('thread-b', 200))
    c.step('first fails', turn('turn/completed', 'thread-a', 'a1', 'failed'))
    c.step('second completes', turn('turn/completed', 'thread-b', 'b1'))
    c.step('parent turn ended', turn('turn/completed', THREAD_ID, 'p1'))
    expect(c.steps).toMatchSnapshot()
  })

  it('c. a subagent outlives the parent turn that spawned it', async () => {
    const c = await codex()
    c.step('parent turn', turn('turn/started', THREAD_ID, 'p1'))
    c.step('spawned', spawned('thread-a', 'review'), turn('turn/started', 'thread-a', 'a1'))
    c.step('parent turn ended', turn('turn/completed', THREAD_ID, 'p1'))
    c.step('tokens after turn', tokens('thread-a', 900))
    c.step('completed later', turn('turn/completed', 'thread-a', 'a1'))
    expect(c.steps).toMatchSnapshot()
  })

  it('e. a per-subagent Stop: turn/interrupt answered, then the child turn ends interrupted', async () => {
    const c = await codex()
    c.step('parent turn', turn('turn/started', THREAD_ID, 'p1'))
    c.step('spawned', spawned('thread-a', 'review'), turn('turn/started', 'thread-a', 'a1'))
    c.step('parent turn ended', turn('turn/completed', THREAD_ID, 'p1'))
    await new Promise((resolve) => setImmediate(resolve))
    await c.stopRow('thread-a')
    c.step('child turn interrupted', turn('turn/completed', 'thread-a', 'a1', 'interrupted'))
    expect(c.steps).toMatchSnapshot()
  })

  it('f. the provider session ends with a subagent still working', async () => {
    const c = await codex()
    c.step('parent turn', turn('turn/started', THREAD_ID, 'p1'))
    c.step('spawned', spawned('thread-a', 'review'), turn('turn/started', 'thread-a', 'a1'))
    c.connection().handlers.onExit?.(new Error('provider exited'))
    c.steps.push({ step: 'provider exited', ...c.read() })
    expect(c.steps).toMatchSnapshot()
  })

  it('g. 66 subagents spawned in one turn', async () => {
    const c = await codex()
    const frames: Frame[] = [turn('turn/started', THREAD_ID, 'p1')]
    for (let n = 1; n <= 66; n++) {
      frames.push(
        spawned(`thread-${n}`, `worker-${n}`),
        turn('turn/started', `thread-${n}`, `t${n}`)
      )
    }
    c.step('spawned', ...frames)
    expect(summarizeSubagents(c.read())).toMatchSnapshot()
  })
})
