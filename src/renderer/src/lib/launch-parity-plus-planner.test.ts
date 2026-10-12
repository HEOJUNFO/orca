import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  launchWorkspaceState,
  perClientLoader,
  type LaunchStoreHolder
} from '@/lib/launch-parity-renderer.test-fixture'
import type * as HostAgents from '@/lib/launch-agent-in-new-tab-host-agents'
import { getDefaultSettings } from '../../../shared/constants'
import { parseWorkspaceSession } from '../../../shared/workspace-session-schema'
import {
  POSIX_PATH,
  WIN_PATH,
  WSL_PATH
} from '../../../shared/launch-parity-window-cases.test-fixture'
import {
  launchWorkspaceId,
  type LaunchClient,
  type LaunchWorkspace
} from '../../../shared/launch-parity-window-request.test-fixture'

const holder = vi.hoisted((): LaunchStoreHolder => ({ store: null }))
const spies = vi.hoisted(() => ({ route: vi.fn(), rpc: vi.fn() }))
vi.mock('@/store', async () =>
  (await import('@/lib/launch-parity-renderer.test-fixture')).launchStoreModuleMock(holder)
)
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), message: vi.fn(), success: vi.fn() }
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callRuntimeRpc: spies.rpc
}))
// The post-ready paste waits on a pane this suite never mounts.
vi.mock('@/lib/launch-agent-tab-prompt-paste', () => ({
  pasteAgentLaunchPromptOnceReady: () => new Promise(() => {})
}))
// Counts route decisions, so a test can show the launch stopped before one was made.
vi.mock('@/lib/launch-agent-in-new-tab-host-agents', async (importOriginal) => {
  const actual = await importOriginal<typeof HostAgents>()
  return {
    ...actual,
    routeNewTabLaunch: (...args: Parameters<typeof actual.routeNewTabLaunch>) => {
      spies.route()
      return actual.routeNewTabLaunch(...args)
    }
  }
})

const load = perClientLoader(async () => ({
  launch: await import('@/lib/launch-agent-in-new-tab'),
  session: await import('@/lib/workspace-session')
}))

async function seed(
  client: LaunchClient,
  workspace: LaunchWorkspace,
  settings?: Record<string, unknown>
) {
  const modules = await load(client)
  const store = modules.createStore()
  holder.store = store
  store.setState(
    launchWorkspaceState(workspace, { ...getDefaultSettings('/home/alice'), ...settings })
  )
  return { modules, store, worktreeId: launchWorkspaceId(workspace) }
}

/** What the tab-bar "+" menu passes (its search and Quick Launch items pass the same). */
async function plusFromMenu(seeded: Awaited<ReturnType<typeof seed>>) {
  const { modules, store, worktreeId } = seeded
  return modules.launch.launchAgentInNewTab({
    requestId: 'parity-plus',
    agent: 'claude',
    worktreeId,
    groupId: store.getState().activeGroupIdByWorktree[worktreeId],
    launchSource: 'tab_bar_quick_launch'
  })
}

const tabsOf = (seeded: Awaited<ReturnType<typeof seed>>) =>
  seeded.store.getState().tabsByWorktree[seeded.worktreeId] ?? []

// Pins main's current launch behaviour as the convergence parity baseline (row 1 and row 3's window
// route): what C2 must keep, or knowingly change, when "+" and the AI buttons move to the pane trigger.
describe('"+" and AI-button launches at the window planner', () => {
  beforeAll(async () => {
    await load('darwin')
    await load('win32')
  }, 240_000)

  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  // Saved default args are re-tokenized for the shell the window quotes for, before any route.
  it.each([
    { client: 'darwin', path: POSIX_PATH, args: '--x "unterminated', launches: false },
    { client: 'win32', path: WIN_PATH, args: String.raw`--x it\'s`, launches: false },
    { client: 'win32', path: WSL_PATH, args: String.raw`--x it\'s`, launches: true }
  ] as const)(
    'saved args $args at $path: launches=$launches, decided before routing',
    async ({ client, path, args, launches }) => {
      const seeded = await seed(
        client,
        { kind: 'repo', path },
        { agentDefaultArgs: { claude: args } }
      )
      expect((await plusFromMenu(seeded)) !== null).toBe(launches)
      expect(tabsOf(seeded)).toHaveLength(launches ? 1 : 0)
      expect(spies.route).toHaveBeenCalledTimes(launches ? 1 : 0)
    }
  )

  // B6 / D-b: the queued command is not saved, so the tab reopens as a plain shell, with no notice.
  it('a never-mounted "+" tab reopens across a restart as the agent tab with nothing queued', async () => {
    const seeded = await seed('darwin', { kind: 'repo', path: POSIX_PATH })
    await plusFromMenu(seeded)
    const [tab] = tabsOf(seeded)
    expect(seeded.store.getState().pendingStartupByTabId[tab.id]).toBeDefined()
    const written = JSON.stringify(
      seeded.modules.session.buildWorkspaceSessionPayload(seeded.store.getState())
    )
    const parsed = parseWorkspaceSession(JSON.parse(written))
    if (!parsed.ok) {
      throw new Error('the written session does not parse')
    }

    const after = await seed('darwin', { kind: 'repo', path: POSIX_PATH })
    after.store.getState().hydrateWorkspaceSession(parsed.value)

    expect(after.store.getState().pendingStartupByTabId).toEqual({})
    const [restored] = tabsOf(after)
    expect(restored).toMatchObject({ id: tab.id, launchAgent: 'claude', ptyId: null })
    expect(restored.agentLaunchPane).toBeUndefined()
  })

  // The AI buttons that paste their prompt once the agent is ready share this gate (fix checks,
  // PR-page fix, source-control recovery and action dialog, git history, review notes, OpenCode
  // quick commands). With chat off, each starts through the host's agent.launch, without its prompt.
  it('an AI button with chat off starts through the host and keeps its prompt in the window', async () => {
    spies.rpc.mockReturnValue(new Promise(() => {}))
    const seeded = await seed('darwin', { kind: 'repo', path: POSIX_PATH })
    // What source-control recovery passes.
    seeded.modules.launch.launchAgentInNewTab({
      requestId: 'parity-ai-button',
      agent: 'claude',
      worktreeId: seeded.worktreeId,
      prompt: 'fix the failing checks',
      agentArgs: null,
      promptDelivery: 'submit-after-ready',
      launchPlatform: 'darwin',
      launchSource: 'source_control_recovery'
    })
    const [tab] = tabsOf(seeded)
    expect(spies.rpc.mock.calls).toEqual([
      [
        { kind: 'local' },
        'agent.launchReplay',
        {
          agent: 'claude',
          target: { kind: 'existing', worktree: `id:${seeded.worktreeId}` },
          agentArgs: null,
          launchSource: 'source_control_recovery',
          presentation: 'focused',
          operationId: expect.any(String),
          paneKey: `${tab.id}:${tab.agentLaunchPane?.leafId}`
        }
      ]
    ])
    expect(seeded.store.getState().pendingStartupByTabId[tab.id]).toBeUndefined()
  })
})
