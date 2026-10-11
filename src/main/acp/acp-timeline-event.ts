import { createHash } from 'node:crypto'
import { MAX_SUBAGENT_FIELD_CHARS } from '../../shared/native-chat-subagent-summary'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { SubagentChildWorkChange } from '../native-chat/subagent-tracker/subagent-tracker-types'

export type AcpTimelineEvent = ProviderTimelineEvent & {
  /** What the running-tasks strip learned with this row, published once it is admitted; never
   *  journaled. */
  subagentChildWork?: readonly SubagentChildWorkChange[]
}

export function acpSubagentIdentity(providerId: string): string {
  return providerId.length <= MAX_SUBAGENT_FIELD_CHARS
    ? providerId
    : `acp-child:${createHash('sha256').update(providerId).digest('hex')}`
}
