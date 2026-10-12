import { SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE } from '../../shared/single-instance-exit-code'
import {
  brakeForBuild,
  clearServeSupervisorBrake,
  emptyServeSupervisorBrake,
  readServeSupervisorBrake,
  recordSupervisedFailure,
  standbyDelayMs,
  writeServeSupervisorBrake,
  type ServeSupervisorBrake
} from './serve-supervisor-brake'
import {
  readServeInstallEvidence,
  serveBuildIdentity,
  SERVE_INSTALL_HOLD_REASON_TEXT,
  type ServeInstallEvidence
} from './serve-install-hold'
import { requestSupervisedServeStop, resetSupervisedServeStop } from './serve-update-supervisor'

export const SERVE_INSTALL_HOLD_POLL_MS = 2_000
/** A hold this long is reported as stuck; it still never times out into a spawn. */
export const SERVE_INSTALL_HOLD_STUCK_MS = 30 * 60_000

type StopListener = () => void

export type SupervisedServeOptions = {
  userDataPath: string
  executable: string
  force: boolean
  /** One full serve attempt: preflight, spawn, and the existing update-aware wait. */
  runOnce: () => Promise<number>
  readInstallEvidence?: (executable: string) => Promise<ServeInstallEvidence>
  buildIdentity?: (executable: string) => string
  readBrake?: (userDataPath: string) => ServeSupervisorBrake | null
  writeBrake?: (userDataPath: string, record: ServeSupervisorBrake) => void
  clearBrake?: (userDataPath: string) => void
  now?: () => number
  random?: () => number
  setTimer?: (callback: () => void, ms: number) => () => void
  onStopSignal?: (listener: StopListener) => () => void
  log?: (line: string) => void
}

export function getServeSuperviseValidationError(input: {
  supervise: boolean
  recipeJson: boolean
  platform?: NodeJS.Platform
}): string | null {
  if (!input.supervise) {
    return null
  }
  if ((input.platform ?? process.platform) === 'win32') {
    return '--supervise is not supported on Windows yet. Run `orca serve` under your own service wrapper instead.'
  }
  if (input.recipeJson) {
    return '--recipe-json starts a detached server and returns; it cannot be combined with --supervise.'
  }
  return null
}

function defaultOnStopSignal(listener: StopListener): () => void {
  const signals: NodeJS.Signals[] =
    process.platform === 'linux' ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM']
  for (const signal of signals) {
    process.on(signal, listener)
  }
  return () => {
    for (const signal of signals) {
      process.off(signal, listener)
    }
  }
}

function defaultSetTimer(callback: () => void, ms: number): () => void {
  const timer = setTimeout(callback, ms)
  return () => clearTimeout(timer)
}

/**
 * `orca serve --supervise`: the restart owner for a service manager. It never exits because its
 * child died; it exits on a stop signal, or with 0 after giving up so the manager stops too.
 */
export async function superviseServeService(options: SupervisedServeOptions): Promise<number> {
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const setTimer = options.setTimer ?? defaultSetTimer
  const readEvidence = options.readInstallEvidence ?? readServeInstallEvidence
  const identify = options.buildIdentity ?? serveBuildIdentity
  const writeBrake = options.writeBrake ?? writeServeSupervisorBrake

  let record = brakeForBuild(
    (options.readBrake ?? readServeSupervisorBrake)(options.userDataPath),
    identify(options.executable)
  )
  if (options.force) {
    ;(options.clearBrake ?? clearServeSupervisorBrake)(options.userDataPath)
    record = emptyServeSupervisorBrake(record.build)
  }
  if (record.gaveUp) {
    log(
      `[serve] Not starting: ${record.gaveUp.reason} Fix the cause, then run \`orca serve --supervise --force\` once, or reinstall Orca.`
    )
    return 0
  }

  resetSupervisedServeStop()
  let stopped = false
  let wake: (() => void) | null = null
  const removeStopListener = (options.onStopSignal ?? defaultOnStopSignal)(() => {
    stopped = true
    requestSupervisedServeStop()
    wake?.()
  })
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolveSleep) => {
      if (stopped) {
        resolveSleep()
        return
      }
      const cancel = setTimer(() => {
        wake = null
        resolveSleep()
      }, ms)
      wake = () => {
        wake = null
        cancel()
        resolveSleep()
      }
    })

  try {
    let standbyAttempt = 0
    const hold: { current: { reason: string; since: number; reportedStuck: boolean } | null } = {
      current: null
    }
    while (!stopped) {
      const evidence = await readEvidence(options.executable)
      if (stopped) {
        break
      }
      if (evidence.kind === 'hold') {
        const held = hold.current
        if (held?.reason !== evidence.reason) {
          hold.current = { reason: evidence.reason, since: now(), reportedStuck: false }
          log(
            `[serve] Waiting before starting Orca serve: ${SERVE_INSTALL_HOLD_REASON_TEXT[evidence.reason]}.`
          )
        } else if (!held.reportedStuck && now() - held.since >= SERVE_INSTALL_HOLD_STUCK_MS) {
          held.reportedStuck = true
          log(
            `[serve] Still waiting after ${SERVE_INSTALL_HOLD_STUCK_MS / 60_000} minutes: ${SERVE_INSTALL_HOLD_REASON_TEXT[evidence.reason]}. Stop the service and start it again once the install is done.`
          )
        }
        await sleep(SERVE_INSTALL_HOLD_POLL_MS)
        continue
      }
      hold.current = null
      record = brakeForBuild(record, identify(options.executable))

      let failure: string
      try {
        const code = await options.runOnce()
        if (stopped) {
          break
        }
        if (code === SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE) {
          // Why not a failure: another Orca serves this profile, so wait for it instead of racing it.
          const delayMs = standbyDelayMs(standbyAttempt++, random)
          log(
            `[serve] Another Orca serves this profile; checking again in ${Math.round(delayMs / 1000)}s.`
          )
          await sleep(delayMs)
          continue
        }
        failure = `exited with code ${code}`
      } catch (error) {
        if (stopped) {
          break
        }
        failure = error instanceof Error ? error.message : String(error)
      }
      standbyAttempt = 0
      const next = recordSupervisedFailure(record, { now: now(), reason: failure, random })
      record = next.record
      writeBrake(options.userDataPath, record)
      if (next.action.kind === 'give-up') {
        log(`[serve] ${next.action.reason}`)
        return 0
      }
      log(
        `[serve] Orca serve ${failure}; restarting in ${Math.max(1, Math.round(next.action.delayMs / 1000))}s.`
      )
      await sleep(next.action.delayMs)
    }
    return 0
  } finally {
    removeStopListener()
  }
}
