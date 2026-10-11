// Golden host child records, strip Stop targets and journal subagent rows for scripted Claude
// subagent sequences, so moving them onto the shared tracker changes only what it means to.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  characterizeSubagents,
  summarizeSubagents
} from '../native-chat/subagent-tracker/subagent-child-work-characterization.test-fixture'
import { agentChildWorkStopTargets } from '../../shared/agent-child-work-stop-targets'
import { projectAgentChildWorkViews } from '../../shared/agent-status-child-work-view'
import {
  frame,
  parent,
  producer,
  system,
  toolResult,
  toolUse
} from './claude-child-work-producer-harness.test-fixture'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))
afterEach(() => vi.restoreAllMocks())

const spawn = (n: number, description: string, backgrounded = false) => [
  toolUse(`toolu_${n}`, 'Agent', { description, run_in_background: backgrounded }),
  system('task_started', {
    task_id: `agent-${n}`,
    tool_use_id: `toolu_${n}`,
    task_type: 'local_agent',
    subagent_type: 'general-purpose',
    description,
    is_backgrounded: backgrounded
  })
]
const progress = (n: number, tokens: number) =>
  system('task_progress', {
    task_id: `agent-${n}`,
    last_tool_name: 'Grep',
    usage: { total_tokens: tokens, tool_uses: 1, duration_ms: 10 }
  })
const notification = (n: number, status: string, fields: Record<string, unknown> = {}) =>
  system('task_notification', { task_id: `agent-${n}`, status, ...fields })
const turnEnd = () => frame({ type: 'result', subtype: 'success', is_error: false })

async function claude() {
  const run = await producer()
  const steps: unknown[] = []
  const step = (name: string, ...frames: Record<string, unknown>[]) => {
    for (const message of frames) {
      run.send(message)
    }
    steps.push({ step: name, ...read() })
  }
  const views = () => {
    const records = run.store.getChildren(parent)
    return projectAgentChildWorkViews(
      records,
      records.flatMap((record) => run.store.getAliasesForChild(record.childWorkId))
    )
  }
  const read = () =>
    characterizeSubagents({
      records: run.store.getChildren(parent),
      views: views(),
      rows: [...run.journalItems.values()].map((item) => item.body)
    })
  /** The strip's per-row Stop for one task, as the host resolves it. */
  const stopRow = async (taskId: string) => {
    const outcome = await run.adapter.stopBackgroundTasks({
      sessionId: 'session-1',
      fence: 7,
      taskIds: agentChildWorkStopTargets(views(), taskId)
    })
    const calls = run.claude.connections[0]!.calls.filter((call) => call.subtype === 'stop_task')
    steps.push({ step: `stop ${taskId}`, outcome, calls, ...read() })
  }
  return { ...run, steps, step, read, stopRow }
}

describe('Claude subagent child work (characterization)', () => {
  it('a. one subagent starts, reports tokens and completes', async () => {
    const c = await claude()
    c.step('spawned', ...spawn(1, 'Find flaky tests'))
    c.step('tokens', progress(1, 1_200))
    c.step('spawn result', toolResult('toolu_1', 'Two tests flake'))
    c.step('completed', notification(1, 'completed', { summary: 'Two tests flake' }))
    c.step('turn ended', turnEnd())
    expect(c.steps).toMatchSnapshot()
  })

  it('b. two subagents with the same label, one fails', async () => {
    const c = await claude()
    c.step('both spawned', ...spawn(1, 'Audit'), ...spawn(2, 'Audit'))
    c.step('tokens', progress(1, 100), progress(2, 200))
    c.step('first fails', notification(1, 'failed', { summary: 'Crashed' }))
    c.step('second completes', notification(2, 'completed', { summary: 'Clean' }))
    c.step(
      'spawn results',
      toolResult('toolu_1', 'Crashed', null, true),
      toolResult('toolu_2', 'ok')
    )
    c.step('turn ended', turnEnd())
    expect(c.steps).toMatchSnapshot()
  })

  it('c. a background subagent outlives the turn that spawned it', async () => {
    const c = await claude()
    c.step('spawned in background', ...spawn(1, 'Audit the build', true))
    c.step('launch result', toolResult('toolu_1', 'Async agent launched successfully'))
    c.step(
      'roster lists it',
      system('background_tasks_changed', {
        tasks: [{ task_id: 'agent-1', task_type: 'local_agent', description: 'Audit the build' }]
      })
    )
    c.step('parent turn ended', turnEnd())
    c.step('tokens after turn', progress(1, 900))
    c.step('completed later', notification(1, 'completed', { summary: 'Build is fine' }))
    c.step('roster drops it', system('background_tasks_changed', { tasks: [] }))
    expect(c.steps).toMatchSnapshot()
  })

  it('d1. a foreground subagent whose parent turn ends with no ending of its own', async () => {
    const c = await claude()
    c.step('spawned', ...spawn(1, 'Find flaky tests'))
    c.step('tokens', progress(1, 400))
    c.step('parent turn ended', turnEnd())
    expect(c.steps).toMatchSnapshot()
  })

  it('d2. a foreground spawn result arrives before its task_notification', async () => {
    const c = await claude()
    c.step('spawned', ...spawn(1, 'Find flaky tests'))
    c.step('spawn result first', toolResult('toolu_1', 'Found 2'))
    c.step('notification after', notification(1, 'completed', { summary: 'Found 2' }))
    c.step('turn ended', turnEnd())
    expect(c.steps).toMatchSnapshot()
  })

  describe('e. a per-subagent Stop the CLI acknowledges', () => {
    async function stopped() {
      const c = await claude()
      c.step('spawned in background', ...spawn(1, 'Audit the build', true))
      c.step('launch result', toolResult('toolu_1', 'Async agent launched successfully'))
      c.step('parent turn ended', turnEnd())
      await c.stopRow('agent-1')
      return c
    }

    it('i. and then no further frame', async () => {
      const c = await stopped()
      expect(c.steps).toMatchSnapshot()
    })

    it.each(['killed', 'stopped'])('ii. then a task_notification %s', async (status) => {
      const c = await stopped()
      c.step(`notification ${status}`, notification(1, status, { summary: 'Stopped by user' }))
      expect(c.steps).toMatchSnapshot()
    })

    it('iii. then a completed task_notification the CLI wrote before its ack', async () => {
      const c = await stopped()
      c.step('late completion', notification(1, 'completed', { summary: 'Build is fine' }))
      expect(c.steps).toMatchSnapshot()
    })
  })

  it('f. the provider session ends with a subagent still working', async () => {
    const c = await claude()
    c.step('foreground spawned', ...spawn(1, 'Find flaky tests'))
    c.step('background spawned', ...spawn(2, 'Audit the build', true))
    c.claude.connections[0]!.handlers.onExit?.(new Error('claude exited'))
    await c.adapter.drainObservedExits()
    c.steps.push({ step: 'session ended', ...c.read() })
    expect(c.steps).toMatchSnapshot()
  })

  it('g. 66 subagents spawned in one turn', async () => {
    const c = await claude()
    for (let n = 1; n <= 66; n++) {
      for (const message of spawn(n, `Worker ${n}`, true)) {
        c.send(message)
      }
    }
    expect(summarizeSubagents(c.read())).toMatchSnapshot()
  })
})
