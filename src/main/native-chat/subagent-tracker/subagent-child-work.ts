// The running-tasks strip's view of the tracker's children: what changed since it last reported
// each one, and how a change reads as the host's child-work evidence. The strip, the sidebar and a
// per-subagent Stop all read the records this evidence builds, so they follow the same entry the row
// shows, including a child the row has no room to list.

import type {
  AgentChildWorkEvidence,
  AgentChildWorkEvidenceHandle
} from '../../../shared/agent-status-child-work-evidence'
import type { AgentChildWorkOutcome } from '../../../shared/agent-status-child-work'
import { isTerminalSubagentState } from '../../../shared/native-chat-subagent-summary'
import { boundSubagentField } from '../agent-session-journal/journal-subagent-group-body'
import type { NativeChatSubagentState } from '../../../shared/native-chat-types'
import type {
  SubagentChildWorkChange,
  SubagentGroup,
  TrackedSubagent
} from './subagent-tracker-types'

/** The change to report for this child, or null when the strip already shows it. A child an
 *  earlier provider process left is no live work of this one: that session's end settled it.
 *  `label` is the name its row shows. */
function subagentChildWorkChange(
  id: string,
  tracked: TrackedSubagent,
  label: string
): {
  change: SubagentChildWorkChange
  published: NonNullable<TrackedSubagent['published']>
} | null {
  if (tracked.inherited) {
    return null
  }
  const { entry } = tracked
  const ended = isTerminalSubagentState(entry.state)
  const key = JSON.stringify([
    tracked.run,
    label,
    entry.state,
    entry.tokens ?? null,
    tracked.backgrounded,
    tracked.stopAcknowledged
  ])
  if (tracked.published?.key === key) {
    return null
  }
  return {
    published: { key, ended },
    change: {
      id,
      run: tracked.run,
      label,
      state: entry.state,
      ...(entry.tokens !== undefined ? { tokens: entry.tokens } : {}),
      backgrounded: tracked.backgrounded,
      stopAcknowledged: tracked.stopAcknowledged,
      restart: !ended && tracked.published?.ended === true
    }
  }
}

/** Appends the changes a written group's children make for the strip; how many it appended. */
export function projectSubagentChildWork(
  group: SubagentGroup<unknown>,
  into: SubagentChildWorkChange[]
): number {
  const before = into.length
  let listed = 0
  for (const [id, tracked] of group.entries) {
    // Clipped as the row clips it, so the strip names a child exactly as its row does.
    const label = tracked.listed
      ? boundSubagentField(tracked.entry.label, listed++)
      : tracked.entry.label
    const projected = subagentChildWorkChange(id, tracked, label)
    if (projected) {
      into.push(projected.change)
      group.entries.set(id, { ...tracked, published: projected.published })
    }
  }
  return into.length - before
}

function outcomeOf(state: NativeChatSubagentState): AgentChildWorkOutcome {
  switch (state) {
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'cancelled'
    case 'unverifiable':
      return 'unknown'
    case 'completed':
    case 'idle':
    case 'working':
      return 'succeeded'
  }
}

/** The evidence one change is, under the handle and Stop the agent gives it. */
export function subagentChildWorkEvidence(
  change: SubagentChildWorkChange,
  observedAt: number,
  agent: { handle: AgentChildWorkEvidenceHandle; stoppable: boolean }
): AgentChildWorkEvidence {
  const tokens = change.tokens !== undefined ? { totalTokens: change.tokens } : {}
  if (isTerminalSubagentState(change.state)) {
    return {
      type: 'ended',
      observedAt,
      handle: agent.handle,
      outcome: outcomeOf(change.state),
      ...(change.stopAcknowledged ? { basis: 'stop-acknowledged' as const } : {}),
      ...tokens
    }
  }
  return {
    type: 'live',
    observedAt,
    child: {
      handle: agent.handle,
      kind: 'agent',
      residency: change.backgrounded ? 'background' : 'foreground',
      state: 'working',
      description: change.label,
      ...tokens,
      stoppable: agent.stoppable
    },
    ...(change.restart ? { restart: true as const } : {})
  }
}
