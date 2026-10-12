import type { SessionOptionValue } from '../../shared/native-chat-session-options'
import type { TuiAgent } from '../../shared/tui-agent'
import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import type { AgentLaunchRuntime } from '../../shared/agent-launch-runtime'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import { resolveBareAgentLaunchCommand } from './runtime-agent-launch-resolution'
import {
  buildExecutionHostAgentStartupPlan,
  planExecutionHostStartupWithPromptCandidate
} from '../opencode/opencode-model-startup-plan'
import { agentPromptRidesLaunchCommand } from '../../shared/tui-agent-startup'
import {
  launchHostProvesAgentInFront,
  nameLocalTypedLineShell
} from './agent-launch-typed-line-shell'
import { resolveTerminalStartupCwd } from '../../shared/terminal-startup-cwd'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import { agentStartedTelemetry } from '../agent-launch/agent-started-telemetry'
import { terminalShellOverrideRefusal } from './terminal-shell-override-host-support'
import {
  resolveLocalLaunchScopeRuntime,
  resolveLocalProjectRuntimeForWorktreeId
} from '../local-project-runtime-resolution'
import {
  agentLaunchPlatformForScope,
  resolveAgentLaunchRuntime
} from './agent-launch-scope-runtime'
import { resolveQoderTerminalCommand } from './qoder-terminal-command-resolution'
import { isWslShellName } from '../../shared/local-windows-terminal-runtime'

type AgentTerminalPlanHost = {
  store: RuntimeStore | null | undefined
  hostIdentity: string
  toSessionOptions: (
    preferences: AgentLaunchPreferences | undefined
  ) => Record<string, SessionOptionValue> | undefined
}

/**
 * Every host terminal create passes here. An agent create — requested, typed bare, or brought with
 * the caller's own command — gets the workspace's one runtime fact, which its spawn's PTY shell
 * comes from; a plain terminal keeps the spawn's own shell rule.
 */
export async function resolveAgentTerminalCreateOptions(
  workspace: TerminalWorkspaceLaunchScope,
  opts: TerminalCreateOptions,
  host: AgentTerminalPlanHost
): Promise<TerminalCreateOptions> {
  const store = host.store ?? undefined
  // Why: raw shell commands like `codex exec` must remain user-authored shell.
  // Only unmanaged, repo-backed, bare agent launches get Settings defaults.
  const callerSuppliedLaunch =
    opts.env ||
    opts.launchConfig ||
    opts.launchAgent ||
    opts.startupCommandDelivery ||
    opts.claudeAgentTeamsSourceCommand
  const plannedAgent =
    opts.startupAgent ??
    (!callerSuppliedLaunch && store && opts.command && workspace.repo
      ? resolveBareAgentLaunchCommand({
          command: opts.command,
          settings: store.getSettings(),
          platform: agentLaunchPlatformForScope(store, workspace),
          isRemote: Boolean(workspace.connectionId)
        })
      : null)
  const launchAgent = plannedAgent ?? opts.launchAgent
  // Before any early return: a host that cannot apply the requested shell must refuse rather than
  // spawn another one. Judged against the runtime this PTY's shell will come from.
  const shellRefusal = terminalShellOverrideRefusal({
    shellOverride: opts.shellOverride,
    connectionId: workspace.connectionId,
    platform: process.platform,
    projectRuntime:
      opts.shellOverride && store
        ? launchAgent
          ? resolveLocalLaunchScopeRuntime(store, workspace)
          : resolveLocalProjectRuntimeForWorktreeId(store, workspace.id)
        : undefined,
    cwd: resolveTerminalStartupCwd(workspace.path, opts.cwd) ?? workspace.path,
    workspacePath: workspace.path
  })
  if (shellRefusal) {
    throw shellRefusal
  }
  if (opts.startupAgent) {
    // Why: falling through unresolved would spawn a bare shell that can only time out waiting for
    // an agent. A caller-supplied launch contradicts the agent: `command` would be overwritten,
    // `resumeProviderSession` would pair resume identity with a fresh launch.
    if (callerSuppliedLaunch || opts.command || opts.resumeProviderSession) {
      throw new Error(
        `startupAgent ${opts.startupAgent} cannot combine with a caller-supplied launch.`
      )
    }
    if (!store) {
      throw new Error('runtime_unavailable')
    }
  }
  if (!launchAgent || !store) {
    return opts
  }
  const runtime =
    opts.launchRuntime ?? resolveAgentLaunchRuntime(store, workspace, opts.shellOverride)
  const launch = plannedAgent
    ? await buildRuntimeAgentTerminalStartupOptions(
        workspace,
        opts,
        plannedAgent,
        store.getSettings(),
        runtime,
        host
      )
    : opts
  if (!launch.launchAgent) {
    return launch
  }
  return {
    ...(await resolveQoderLaunchCommand(launch, workspace, runtime)),
    launchRuntime: runtime
  }
}

async function buildRuntimeAgentTerminalStartupOptions(
  workspace: TerminalWorkspaceLaunchScope,
  opts: TerminalCreateOptions,
  agent: TuiAgent,
  settings: ReturnType<RuntimeStore['getSettings']>,
  runtime: AgentLaunchRuntime,
  host: AgentTerminalPlanHost
): Promise<TerminalCreateOptions> {
  // Why: `workspace.repo` is display metadata and may be a row from another host; the launch
  // shape must match the PTY route this scope already resolved.
  const isRemote = Boolean(workspace.connectionId)
  // A prompt this launch command cannot carry has nowhere to go from here — the create returns
  // options, not a live PTY — so refuse rather than spawn the agent and drop the text.
  if (opts.startupPrompt && !agentPromptRidesLaunchCommand(agent)) {
    throw new Error(`Agent ${agent} does not take a startup prompt on its launch command.`)
  }
  const startup = {
    inputs: resolveAgentStartupPlanInputs({
      agent,
      settings,
      platform: runtime.platform,
      isRemote,
      ...(opts.agentArgs !== undefined ? { agentArgs: opts.agentArgs } : {}),
      ...(opts.extraAgentArgs ? { extraAgentArgs: opts.extraAgentArgs } : {}),
      shell: runtime.quotingShell,
      sessionOptions: host.toSessionOptions(opts.launchPreferences)
    }),
    prompt: opts.startupPrompt ?? '',
    cwd: resolveTerminalStartupCwd(workspace.path, opts.cwd) ?? workspace.path,
    hostIdentity: host.hostIdentity
  }
  const { plan: startupPlan, promptCarried } =
    opts.promptCarry === 'argv'
      ? {
          plan: await buildExecutionHostAgentStartupPlan(startup),
          promptCarried: startup.prompt.trim() !== ''
        }
      : await planExecutionHostStartupWithPromptCandidate({
          ...startup,
          host: {
            shellName: nameLocalTypedLineShell({
              isRemote,
              ...(runtime.ptyShellOverride ? { shellOverride: runtime.ptyShellOverride } : {})
            }),
            provesAgentInFront: launchHostProvesAgentInFront({
              isRemote,
              launchPlatform: runtime.platform
            })
          }
        })
  if (!startupPlan) {
    // Why: an explicit agent that yields no plan would otherwise spawn a bare
    // shell that never reaches agent readiness.
    if (opts.startupAgent) {
      throw new Error(`Could not build launch command for ${opts.startupAgent}.`)
    }
    return opts
  }
  if (opts.startupPrompt) {
    opts.onStartupPromptCarry?.(promptCarried)
  }
  const startupCommandDelivery =
    startupPlan.startupCommandDelivery ??
    (opts.codexNoPromptShellWait && agent === 'codex' && !startup.prompt.trim()
      ? 'shell-ready'
      : undefined)

  return {
    ...opts,
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    launchAgent: agent,
    startupCommandDelivery,
    // A bare command the user typed stays out of launch accounting, as before.
    ...(opts.startupAgent
      ? { telemetry: agentStartedTelemetry(agent, opts.launchSource, opts.requestKind) }
      : {})
  }
}

/** Qoder ships under two command names; the launch runs whichever its execution host has. */
function resolveQoderLaunchCommand(
  launch: TerminalCreateOptions,
  workspace: TerminalWorkspaceLaunchScope,
  runtime: AgentLaunchRuntime
): Promise<TerminalCreateOptions> {
  return resolveQoderTerminalCommand(launch, {
    connectionId: workspace.connectionId,
    context: workspace.connectionId
      ? undefined
      : isWslShellName(runtime.ptyShellOverride)
        ? { wslDistro: runtime.wslDistro, wslDefault: true }
        : {},
    shell: runtime.quotingShell
  })
}
