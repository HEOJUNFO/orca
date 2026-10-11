// One normalized reading of what the strip, sidebar and Stop see (the host's child records) beside
// what the journal's subagent rows say, shared by the per-agent characterization tests.

import { agentChildWorkStopTargets } from '../../../shared/agent-child-work-stop-targets'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import type { AgentChildWorkRecord } from '../../../shared/agent-status-child-work'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { isBackgroundTaskBlock, isSubagentGroupBlock } from '../../../shared/native-chat-types'

export type SubagentCharacterizationSource = {
  records: readonly AgentChildWorkRecord[]
  /** The same records as the host projects them for every surface. */
  views: readonly AgentChildWorkView[]
  rows: readonly AgentJournalItemBody[]
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/** Host-minted UUIDs become first-seen ordinals so a snapshot is stable across runs. */
export function withStableUuids<T>(value: T, seen = new Map<string, string>()): T {
  return JSON.parse(
    JSON.stringify(value).replace(UUID, (uuid) => {
      const known = seen.get(uuid) ?? `<uuid-${seen.size + 1}>`
      seen.set(uuid, known)
      return known
    })
  )
}

function rowBlocks(rows: readonly AgentJournalItemBody[]) {
  // Group keys embed per-file frame counters and minted turn ids; their order is what matters.
  const groups = new Map<string, string>()
  const groupRef = (groupId: string) => {
    const known = groups.get(groupId) ?? `group-${groups.size + 1}`
    groups.set(groupId, known)
    return known
  }
  return rows.flatMap((body) =>
    body.kind !== 'message'
      ? []
      : body.blocks.flatMap((block) => {
          if (isSubagentGroupBlock(block)) {
            return [
              {
                group: groupRef(block.groupId),
                agents: block.agents.map(({ id, label, state, tokens }) => ({
                  id,
                  label,
                  state,
                  tokens: tokens ?? null
                }))
              }
            ]
          }
          return isBackgroundTaskBlock(block)
            ? [
                {
                  task: block.taskId,
                  kind: block.kind,
                  label: block.label,
                  state: block.state,
                  tokens: block.tokens ?? null
                }
              ]
            : []
        })
  )
}

export function characterizeSubagents({ records, views, rows }: SubagentCharacterizationSource) {
  const refs = new Map(records.map((record, index) => [record.childWorkId, `#${index + 1}`]))
  const child = (record: AgentChildWorkRecord) => {
    const view = views.find((candidate) => candidate.id === record.childWorkId)
    return {
      ref: refs.get(record.childWorkId),
      kind: record.kind,
      providerId: view?.providerId ?? null,
      label: record.description ?? record.name ?? null,
      state: record.state,
      membership: record.membership,
      outcome: record.outcome ?? null,
      outcomeBasis: record.outcomeBasis ?? null,
      residency: record.residency ?? null,
      stoppable: record.stoppable,
      tokens: record.totalTokens ?? null,
      owner: record.parentChildWorkId ? (refs.get(record.parentChildWorkId) ?? 'gone') : null,
      run: `${record.invocation.invocationId}@${record.invocation.generation}`,
      inView: view !== undefined
    }
  }
  return withStableUuids({
    records: records.map(child),
    stopTargets: agentChildWorkStopTargets(views),
    rows: rowBlocks(rows)
  })
}

export type SubagentCharacterization = ReturnType<typeof characterizeSubagents>

/** For a large fan-out: counts and the tail, not every entry. */
export function summarizeSubagents(reading: SubagentCharacterization) {
  const rowAgents = reading.rows.flatMap((row) => ('agents' in row ? row.agents : []))
  return {
    records: reading.records.length,
    liveRecords: reading.records.filter((record) => record.membership === 'live').length,
    stopTargets: reading.stopTargets.length,
    rowGroups: reading.rows.length,
    rowAgents: rowAgents.length,
    lastRecords: reading.records.slice(-2),
    lastStopTargets: reading.stopTargets.slice(-2),
    lastRowAgents: rowAgents.slice(-2)
  }
}
