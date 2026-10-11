import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import { subagentChildWorkEvidence } from '../native-chat/subagent-tracker/subagent-child-work'
import { acpSubagentIdentity, type AcpTimelineEvent } from './acp-timeline-event'
import { createHash } from 'node:crypto'
import { AGENT_CHILD_WORK_ID_MAX_LENGTH } from '../../shared/agent-status-child-work-value-guards'

export function isAcpSubagentChildWorkEvent(event: AcpTimelineEvent): boolean {
  return event.type === 'session.ended' || (event.subagentChildWork?.length ?? 0) > 0
}

/** The tracker's changes this admitted row carried, never the translator's potentially newer
 *  roster. */
export function acpSubagentChildWork(
  event: AcpTimelineEvent,
  observedAt: number,
  stoppable: boolean
): AgentChildWorkEvidence[] {
  if (event.type === 'session.ended') {
    return [{ type: 'session-ended', observedAt }]
  }
  return (event.subagentChildWork ?? []).map((change) => {
    const identity = acpSubagentIdentity(change.id)
    const handle = {
      idKind: 'task_id' as const,
      id: identity,
      // Invocation fences are smaller than aliases; keep the roster's full stable handle.
      ...(identity.length > AGENT_CHILD_WORK_ID_MAX_LENGTH
        ? { runId: `acp-child:${createHash('sha256').update(identity).digest('hex')}` }
        : {})
    }
    // A hashed handle cannot address the provider's cancellation API.
    return subagentChildWorkEvidence(change, observedAt, {
      handle,
      stoppable: stoppable && identity === change.id
    })
  })
}
