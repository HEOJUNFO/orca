import { describe, expect, it } from 'vitest'
import type { NativeChatSubagentEntry } from '../../../shared/native-chat-types'
import type { StructuredAgentSessionSinkAdmission } from '../agent-session-wire/structured-agent-session-event-sink'
import { MAX_SUBAGENTS_PER_GROUP, SubagentTracker } from './subagent-tracker'
import type { JournaledSubagentSource, SubagentReport } from './subagent-tracker-types'

type Write = { groupId: string; agents: NativeChatSubagentEntry[] | null; restated: boolean }

function harness(journaled?: JournaledSubagentSource<string>) {
  const writes: Write[] = []
  let refuse = false
  let clock = 100
  const agentsOf = (body: { blocks: readonly { type: string }[] } | null) => {
    const block = body?.blocks.find((candidate) => candidate.type === 'subagent-group')
    return block && 'agents' in block && Array.isArray(block.agents) ? block.agents : null
  }
  const tracker = new SubagentTracker<string>({
    port: {
      write: (group, { body }): StructuredAgentSessionSinkAdmission => {
        if (refuse) {
          return { accepted: false, reason: 'backpressure' }
        }
        writes.push({ groupId: group.groupId, agents: agentsOf(body), restated: false })
        return { accepted: true }
      },
      restate: (group, { body }) =>
        writes.push({ groupId: group.groupId, agents: agentsOf(body), restated: true })
    },
    ...(journaled ? { journaled } : {}),
    outsideTurn: (groupId) => groupId.startsWith('outside'),
    projectsChildWork: true,
    now: () => clock
  })
  const report = (
    group: string,
    fields: Omit<SubagentReport<string>, 'group' | 'announces'> & { announces?: boolean }
  ) => {
    clock += 10
    return tracker.report({
      announces: true,
      ...fields,
      group: { id: group, placement: () => group }
    })
  }
  const strip = () =>
    tracker.drainChildWork().map(({ id, state, stopAcknowledged, restart }) => ({
      id,
      state,
      ...(stopAcknowledged ? { stopAcknowledged } : {}),
      ...(restart ? { restart } : {})
    }))
  return {
    tracker,
    writes,
    report,
    strip,
    refuse: (value: boolean) => {
      refuse = value
    },
    now: () => clock
  }
}

const many = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) => `c${from + index}`)

describe('SubagentTracker running-tasks projection', () => {
  it('tracks children past what a row lists, and reports them like any other', () => {
    const h = harness()
    for (const id of many(MAX_SUBAGENTS_PER_GROUP + 2)) {
      h.report('turn-1', { id, run: `${id}-r1`, label: 'X', backgrounded: true })
    }
    expect(h.writes.at(-1)?.agents).toHaveLength(MAX_SUBAGENTS_PER_GROUP)
    expect(h.strip()).toHaveLength(MAX_SUBAGENTS_PER_GROUP + 2)
    // Only what the row did not change restates it, so the change rides a row in order.
    expect(h.writes.at(-1)?.restated).toBe(true)

    h.report('turn-1', { id: 'c65', state: 'failed' })
    expect(h.strip()).toEqual([{ id: 'c65', state: 'failed' }])
    expect(h.tracker.locate('c65')).toBeNull()
    expect(h.tracker.has('c65')).toBe(true)
    // A replay of the settled child's start lists it nowhere again.
    h.report('turn-1', { id: 'c65', run: 'c65-r1', label: 'X' })
    expect(h.strip()).toEqual([])
  })

  it('bounds unlisted children by what the host admits live, making room from settled ones', () => {
    const h = harness()
    for (const id of many(MAX_SUBAGENTS_PER_GROUP + 300)) {
      h.report('turn-1', { id, backgrounded: true })
    }
    const unlisted = many(256, MAX_SUBAGENTS_PER_GROUP)
    expect(h.tracker.locate(unlisted.at(-1) ?? '')).not.toBeNull()
    expect(h.tracker.locate(`c${MAX_SUBAGENTS_PER_GROUP + 256}`)).toBeNull()
    // Lost contact keeps a child correctable until room is needed, then it goes first.
    h.report('turn-1', { id: unlisted[0], state: 'unverifiable' })
    h.report('turn-1', { id: 'late', backgrounded: true })
    expect(h.tracker.locate(unlisted[0])).toBeNull()
    expect(h.tracker.has(unlisted[0])).toBe(true)
    expect(h.tracker.locate('late')).not.toBeNull()
  })

  it("keeps an unlisted child's lost contact or acknowledged Stop correctable by its own ending", () => {
    const h = harness()
    for (const id of many(MAX_SUBAGENTS_PER_GROUP + 2)) {
      h.report('turn-1', { id, run: `${id}-r1`, label: 'X', backgrounded: true })
    }
    const [stopped, lost] = [`c${MAX_SUBAGENTS_PER_GROUP}`, `c${MAX_SUBAGENTS_PER_GROUP + 1}`]
    h.tracker.stopAcknowledged(stopped)
    h.report('turn-1', { id: lost, state: 'unverifiable' })
    h.strip()
    h.report('turn-1', { id: stopped, state: 'completed' })
    h.report('turn-1', { id: lost, state: 'failed' })
    expect(h.strip().filter((change) => change.state !== 'working')).toEqual([
      { id: stopped, state: 'completed' },
      { id: lost, state: 'failed' }
    ])
    expect(h.tracker.locate(stopped)).toBeNull()
    expect(h.tracker.locate(lost)).toBeNull()
  })

  it('reports a change only once the row that made it was accepted', () => {
    const h = harness()
    h.refuse(true)
    h.report('turn-1', { id: 'a', run: 'r1', label: 'Audit' })
    expect(h.strip()).toEqual([])
    h.refuse(false)
    h.report('turn-1', { id: 'a', tokens: 5 })
    expect(h.strip()).toEqual([{ id: 'a', state: 'working' }])
  })

  it('does not report an unchanged child again', () => {
    const h = harness()
    h.report('turn-1', { id: 'a', run: 'r1', label: 'Audit', tokens: 5 })
    h.strip()
    h.report('turn-1', { id: 'a', tokens: 5 })
    expect(h.strip()).toEqual([])
  })

  it('writes a refused row again when asked, once the sink drains', () => {
    const h = harness()
    h.report('turn-1', { id: 'a', run: 'r1', label: 'Audit' })
    h.refuse(true)
    h.tracker.stopAcknowledged('a')
    h.refuse(false)
    expect(h.tracker.retryRefused()).toEqual({ accepted: true })
    expect(h.writes.at(-1)?.agents?.[0]).toMatchObject({ state: 'stopped' })
  })

  it('reports a new run of an ended child as a restart', () => {
    const h = harness()
    h.report('turn-1', { id: 'a', run: 'r1', label: 'Audit' })
    h.report('turn-1', { id: 'a', run: 'r1', state: 'completed' })
    h.report('turn-2', { id: 'a', run: 'r2', label: 'Audit' })
    expect(h.strip()).toEqual([
      { id: 'a', state: 'working' },
      { id: 'a', state: 'completed' },
      { id: 'a', state: 'working', restart: true }
    ])
  })

  it('never reports a child an earlier provider process left until it runs here', () => {
    const entry: NativeChatSubagentEntry = { id: 'old', label: 'Old', state: 'working' }
    const h = harness({
      groupOf: (id) => (id === 'old' ? 'turn-0' : null),
      claimGroup: (groupId) =>
        groupId === 'turn-0' ? { entries: [entry], placement: 'turn-0' } : null
    })
    h.report('turn-1', { id: 'old', announces: false, state: 'completed' })
    expect(h.strip()).toEqual([])
    h.report('turn-1', { id: 'old', run: 'r2', label: 'Old' })
    expect(h.strip()).toEqual([{ id: 'old', state: 'working' }])
  })
})

describe('SubagentTracker acknowledged Stop', () => {
  it("reads stopped at once; only the run's own ending replaces it", () => {
    const h = harness()
    h.report('turn-1', { id: 'a', run: 'r1', label: 'Audit', backgrounded: true })
    h.strip()
    h.tracker.stopAcknowledged('a', 'r1')
    const stoppedAt = h.writes.at(-1)?.agents?.[0]?.settledAt
    expect(h.writes.at(-1)?.agents?.[0]).toMatchObject({ state: 'stopped' })
    expect(h.strip()).toEqual([{ id: 'a', state: 'stopped', stopAcknowledged: true }])

    // Lost contact, a late progress tick and the turn's or session's end cannot move it.
    h.report('turn-1', { id: 'a', run: 'r1', state: 'working' })
    h.report('turn-1', { id: 'a', run: 'r1', state: 'unverifiable' })
    h.tracker.settleTurn('turn-1')
    h.tracker.settleSession()
    expect(h.strip()).toEqual([])

    // The run's own ending, written before the Stop reached it, says how it really ended.
    h.report('turn-1', { id: 'a', run: 'r1', state: 'completed' })
    expect(h.writes.at(-1)?.agents?.[0]).toMatchObject({ state: 'completed', settledAt: stoppedAt })
    expect(h.strip()).toEqual([{ id: 'a', state: 'completed' }])
    h.report('turn-1', { id: 'a', run: 'r1', state: 'failed' })
    expect(h.strip()).toEqual([])
  })

  it("the run's own stop confirms it, the unchanged row only restated to carry that", () => {
    const h = harness()
    h.report('turn-1', { id: 'a', run: 'r1', label: 'Audit' })
    h.tracker.stopAcknowledged('a')
    h.strip()
    const writes = h.writes.length
    h.report('turn-1', { id: 'a', run: 'r1', state: 'stopped' })
    expect(h.writes.slice(writes).map((write) => write.restated)).toEqual([true])
    expect(h.strip()).toEqual([{ id: 'a', state: 'stopped' }])
  })

  it('leaves a run started since the Stop was sent alone', () => {
    const h = harness()
    h.report('turn-1', { id: 'a', run: 'r1', label: 'Audit' })
    h.report('turn-2', { id: 'a', run: 'r2', label: 'Audit' })
    h.strip()
    h.tracker.stopAcknowledged('a', 'r1')
    h.tracker.stopAcknowledged('unknown')
    expect(h.strip()).toEqual([])
    expect(h.tracker.locate('a')?.tracked.entry.state).toBe('working')
  })

  it('a new run of a stopped child is working again', () => {
    const h = harness()
    h.report('turn-1', { id: 'a', run: 'r1', label: 'Audit' })
    h.tracker.stopAcknowledged('a', 'r1')
    h.report('turn-2', { id: 'a', run: 'r2', label: 'Audit' })
    h.report('turn-2', { id: 'a', run: 'r2', state: 'unverifiable' })
    expect(h.tracker.locate('a')?.tracked).toMatchObject({
      stopAcknowledged: false,
      entry: { state: 'unverifiable' }
    })
  })
})
