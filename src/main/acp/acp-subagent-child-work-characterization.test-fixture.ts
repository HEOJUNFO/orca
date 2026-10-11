// A scripted Grok chat behind the real host and a real hook server, read the way the subagent
// characterization reads every agent.

import { AgentHookServer } from '../agent-hooks/server'
import type { AgentStatusStructuredSessionSubject } from '../../shared/agent-status-subject'
import type { StructuredAgentSessionStatusSink } from '../native-chat/agent-session-wire/structured-agent-session-status-ownership'
import {
  CALLER,
  envelope
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { characterizeSubagents } from '../native-chat/subagent-tracker/subagent-child-work-characterization.test-fixture'
import type { FakeFrame } from './acp-scripted-agent.test-support'
import { PROVIDER_SESSION, replyChunk } from './acp-structured-adapter.test-support'
import { openAttachedHostRig, promptIdOf, send } from './acp-structured-host.test-support'

export async function grokSubagentRig(onCleanup: (close: () => Promise<unknown>) => void) {
  const server = new AgentHookServer()
  let parent: AgentStatusStructuredSessionSubject | undefined
  const sink: StructuredAgentSessionStatusSink = {
    publish: (summary, subject) => {
      server.ingestStructuredStatus(summary, subject)
      parent = subject
    },
    forget: (subject) => server.dropStructuredStatus(subject),
    publishChildWork: (subject, evidence, provider) =>
      server.ingestStructuredChildWork(subject, evidence, provider),
    readChildWork: (subject) => server.getStructuredChildWorkViews(subject)
  }
  const hosted = await openAttachedHostRig({}, sink)
  let prompt: FakeFrame | undefined
  onCleanup(async () => {
    const open = prompt
    if (open) {
      // Only teardown's own cancel ends the scripted prompt.
      hosted.rig
        .child()
        .agent.on('session/cancel', () =>
          hosted.rig.child().agent.reply(open, { stopReason: 'cancelled' })
        )
    }
    await hosted.host.close(SESSION, 'user-close')
  })
  await send(hosted.host, 'Delegate work')
  const opened = await hosted.rig.frame('session/prompt')
  prompt = opened
  const agent = hosted.rig.child().agent
  agent.notify('session/update', replyChunk(promptIdOf(opened), 'Delegating'))
  await hosted.rows()

  const notify = async (update: Record<string, unknown>) => {
    agent.notify('_x.ai/session/update', { sessionId: PROVIDER_SESSION, update, _meta: {} })
    await hosted.rows()
  }
  const read = async () => {
    const rows = await hosted.rows()
    return characterizeSubagents({
      records: parent ? server.getStructuredChildWork(parent) : [],
      views: parent ? server.getStructuredChildWorkViews(parent) : [],
      rows: rows.map((row) => row.body)
    })
  }
  const steps: unknown[] = []
  const record = async (name: string, extra: Record<string, unknown> = {}) => {
    steps.push({ step: name, ...extra, ...(await read()) })
  }
  /** The strip's per-row Stop, through the host's own background-task cancel. */
  const stopRow = async (taskId: string) => {
    const fields = { turnId: 'background-tasks', scope: 'background-tasks' as const, taskId }
    const answer = await hosted.host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', fields),
      ...fields
    })
    await record(`stop ${taskId}`, { outcome: answer.ok ? answer.value : answer })
  }
  return {
    ...hosted,
    agent,
    prompt: opened,
    steps,
    read,
    record,
    stopRow,
    spawn: (id: string, label: string) =>
      notify({
        sessionUpdate: 'subagent_spawned',
        subagent_id: id,
        parent_prompt_id: promptIdOf(opened),
        description: label
      }),
    progress: (id: string, tokens: number) =>
      notify({ sessionUpdate: 'subagent_progress', subagent_id: id, tokens_used: tokens }),
    finish: (id: string, status: string, tokens?: number) =>
      notify({
        sessionUpdate: 'subagent_finished',
        subagent_id: id,
        status,
        ...(tokens === undefined ? {} : { tokens_used: tokens })
      }),
    endTurn: async () => {
      agent.reply(opened, { stopReason: 'end_turn' })
      await hosted.rows()
    }
  }
}
