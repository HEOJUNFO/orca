import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { ProviderTimelineJoin } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { SubagentTracker } from '../native-chat/subagent-tracker/subagent-tracker'
import type { SubagentGroup } from '../native-chat/subagent-tracker/subagent-tracker-types'
import type { AcpTimelineEvent } from './acp-timeline-event'
import type { AcpSubagentUpdate } from './acp-dialects/acp-dialect'

/** The group a subagent reported outside any turn belongs to. */
const OUTSIDE_TURN = 'thread'

/** One roster row per spawning turn, revised in place, plus each completed subagent's reply as its
 *  own row, filed under its id so it opens beneath its roster entry. The rows follow the shared
 *  subagent tracker's rules; this module only reads the dialect's updates. Lives as long as the
 *  provider child: a subagent an earlier run spawned is not known here, and its row is that run's.
 *  The tracker's changes for the running-tasks strip ride the rows, so the host records each one
 *  only once the row that made it is admitted. */
export class AcpSubagentTimeline {
  /** Row events the tracker wrote during the current `translate`. */
  private written: AcpTimelineEvent[] = []
  private readonly results = new Map<string, string>()
  /** The time of the updates being translated: when they were observed. */
  private at = 0
  private readonly tracker = new SubagentTracker<ProviderTimelineJoin>({
    // The host admits the events later and retries a refused one itself.
    outsideTurn: (groupId) => groupId === OUTSIDE_TURN,
    port: {
      write: (group, { body }) => this.writeRow(group, body),
      restate: (group, { body }) => this.writeRow(group, body)
    },
    projectsChildWork: true,
    now: () => this.at,
    onEvict: (group) => {
      for (const id of group.entries.keys()) {
        this.results.delete(id)
      }
    }
  })
  private disposed = false

  /** Known children include recently evicted outcomes, so they cannot become background tasks. */
  has(id: string): boolean {
    return this.tracker.has(id)
  }

  /** Retention is not observable through the update API, so expose what it holds. */
  retentionSizes(): { groups: number; settledIdentities: number; replies: number } {
    return { ...this.tracker.sizes(), replies: this.results.size }
  }

  /** The journal owns session-end settlement; no later frame may reacquire working ownership. */
  dispose(): void {
    this.disposed = true
    this.tracker.dispose()
    this.results.clear()
    this.written = []
  }

  translate(
    updates: AcpSubagentUpdate[],
    join: ProviderTimelineJoin,
    at: number
  ): AcpTimelineEvent[] {
    if (this.disposed) {
      return []
    }
    const replies: AcpTimelineEvent[] = []
    // One revision per changed row; replies are cached before the batch releases settled rows, so a
    // released row's replies go with it. A child no row lists has no entry to open one beneath.
    return this.rows(() => {
      for (const update of updates) {
        this.apply(update, join, at)
        const located = this.tracker.locate(update.id)
        if (
          update.result &&
          located?.tracked.listed &&
          located.tracked.entry.state === 'completed'
        ) {
          replies.push(...this.reply(update.id, located.group, update.result))
        }
      }
      return replies
    })
  }

  /** The agent acknowledged a Stop of this subagent: it reads stopped until its own ending says
   *  how it really ended. */
  stopAcknowledged(id: string, at: number): AcpTimelineEvent[] {
    if (this.disposed) {
      return []
    }
    return this.rows(() => {
      this.at = at
      this.tracker.stopAcknowledged(id)
      return []
    })
  }

  /** The rows `change` wrote, then its own events. The strip's changes ride the last row, so the
   *  host records them once every row they follow is admitted. */
  private rows(change: () => AcpTimelineEvent[]): AcpTimelineEvent[] {
    this.written = []
    let after: AcpTimelineEvent[] = []
    this.tracker.batch(() => {
      after = change()
    })
    const rows = this.written
    this.written = []
    const subagentChildWork = this.tracker.drainChildWork()
    const last = rows.pop()
    if (last) {
      rows.push(subagentChildWork.length > 0 ? { ...last, subagentChildWork } : last)
    }
    return [...rows, ...after]
  }

  private writeRow(
    group: SubagentGroup<ProviderTimelineJoin>,
    body: AgentJournalMessageItem | null
  ): { accepted: true } {
    if (body) {
      this.written.push(this.rowEvent(group, body))
    }
    return { accepted: true }
  }

  private rowEvent(
    group: SubagentGroup<ProviderTimelineJoin>,
    body: AgentJournalMessageItem
  ): AcpTimelineEvent {
    return { type: 'item.update', item: `subagents:${group.groupId}`, body, join: group.placement }
  }

  private reply(
    id: string,
    group: SubagentGroup<ProviderTimelineJoin>,
    text: string
  ): AcpTimelineEvent[] {
    const bounded = boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
    if (this.results.get(id) === bounded) {
      return []
    }
    this.results.set(id, bounded)
    return [
      {
        type: 'item.update',
        item: `subagent-result:${id}`,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: bounded }] },
        producer: { agentId: id, producerKind: 'agent' },
        join: group.placement
      }
    ]
  }

  private apply(update: AcpSubagentUpdate, join: ProviderTimelineJoin, at: number): void {
    const turn = update.turn ?? join.turn
    const placement: ProviderTimelineJoin = {
      ...(join.thread === undefined ? {} : { thread: join.thread }),
      ...(turn === undefined ? {} : { turn })
    }
    this.at = at
    this.tracker.report({
      id: update.id,
      group: { id: turn ?? OUTSIDE_TURN, placement: () => placement },
      announces: update.knownOnly !== true,
      ...(update.label !== undefined ? { label: update.label } : {}),
      ...(update.state !== undefined ? { state: update.state } : {}),
      ...(update.tokens !== undefined ? { tokens: update.tokens } : {}),
      // A subagent the provider runs outlives the prompt turn that spawned it.
      backgrounded: true
    })
  }
}
