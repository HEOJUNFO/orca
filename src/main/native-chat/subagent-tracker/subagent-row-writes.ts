// Writing a group's row: one dedupe and one refusal rule for every agent.

import { subagentGroupJournalBody } from '../agent-session-journal/journal-subagent-group-body'
import type { StructuredAgentSessionSinkAdmission } from '../agent-session-wire/structured-agent-session-event-sink'
import type { SubagentGroup, SubagentRowBody, SubagentRowPort } from './subagent-tracker-types'

/** The row a group's listed children make; null once it lists none. */
export function subagentGroupRow(group: SubagentGroup<unknown>): SubagentRowBody {
  const agents = [...group.entries.values()].flatMap((tracked) =>
    tracked.listed ? [tracked.entry] : []
  )
  const body = subagentGroupJournalBody(group.groupId, agents)
  return { body: agents.length > 0 ? body : null, serialized: JSON.stringify(body) }
}

/** Writes each group whose row changed. The dedupe advances only once a revision is both queued and
 *  published, so a refused one is written again by the next write of that group; the first refusal
 *  is handed back after every group was tried. */
export function writeSubagentRows<Placement>(
  groups: Iterable<SubagentGroup<Placement>>,
  port: SubagentRowPort<Placement>
): StructuredAgentSessionSinkAdmission | null {
  let refused: StructuredAgentSessionSinkAdmission | null = null
  for (const group of groups) {
    const row = subagentGroupRow(group)
    const { serialized } = row
    if (serialized === group.lastSerialized) {
      // A duplicate delivery must not burn a revision.
      continue
    }
    // A group that lost its last child removes its row.
    const admission = port.write(group, row)
    group.lastSerialized = admission.accepted ? serialized : null
    refused ??= admission.accepted ? null : admission
  }
  return refused
}
