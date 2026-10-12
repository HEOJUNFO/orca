// Why: Kimi runs hooks with asyncio.create_subprocess_shell, i.e. `%ComSpec% /c "<command>"`
// with AutoRun enabled. The pre-fix POSIX command failed there before reaching any script,
// and Kimi fails open, so no status event was ever sent. This suite runs the registered
// command the way Kimi does and follows the payload to a listener.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { wrapPosixHookCommand } from '../agent-hooks/installer-utils'
import { KimiHookService } from './hook-service'

const PANE_KEY = 'tab-1:leaf-1'
const HOOK_TOKEN = 'kimi-delivery-token'
const PAYLOAD = JSON.stringify({
  session_id: 'kimi-windows-delivery',
  hook_event_name: 'PreToolUse',
  tool_name: 'Shell',
  tool_input: { command: 'echo "café" & echo %PATH% | more' }
})

type HookPost = { url: string | undefined; payload: string | null; paneKey: string | null }

async function startHookListener(): Promise<{ server: Server; port: number; posts: HookPost[] }> {
  const posts: HookPost[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const form = new URLSearchParams(body)
      if (req.headers['x-orca-agent-hook-token'] === HOOK_TOKEN) {
        posts.push({ url: req.url, payload: form.get('payload'), paneKey: form.get('paneKey') })
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
  return { server, port, posts }
}

// Mirrors CPython's shell=True command line on Windows: `{COMSPEC} /c "{command}"`, no `/d`.
function runLikeKimi(command: string, env: NodeJS.ProcessEnv) {
  return runProcess({
    program: process.env.ComSpec ?? 'cmd.exe',
    args: [`/c "${command}"`],
    windowsVerbatimArguments: true,
    env,
    input: PAYLOAD,
    timeoutMs: 15_000
  })
}

function readRegisteredCommand(configPath: string): string {
  const literal = readFileSync(configPath, 'utf8').match(/^command = ("(?:[^"\\]|\\.)*")$/m)?.[1]
  if (!literal) {
    throw new Error('Missing managed Kimi command')
  }
  // Orca writes only \\ \" \n \r \t escapes, which a JSON string decodes identically.
  return String(JSON.parse(literal))
}

describe.skipIf(process.platform !== 'win32')('Kimi hook delivery through cmd.exe', () => {
  let home = ''
  let server: Server | null = null

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-kimi-cmd-'))
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('HOME', home)
    vi.stubEnv('KIMI_CODE_HOME', join(home, '.kimi-code'))
    // Why: cmd's AutoRun commonly targets %USERPROFILE%\.cmd_aliases.cmd; the temp home must
    // carry one or cmd's "not recognized" noise lands on the hook's stderr.
    writeFileSync(join(home, '.cmd_aliases.cmd'), '@rem\r\n', 'utf8')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    server?.close()
    server = null
    if (home) {
      removeTreeSync(home)
      home = ''
    }
  })

  function hookEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const base = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_'))
    )
    return { ...base, USERPROFILE: home, HOME: home, ...extra }
  }

  it('posts the payload from the registered command, where the pre-fix POSIX form never did', async () => {
    expect(new KimiHookService().install().state).toBe('installed')
    const command = readRegisteredCommand(join(home, '.kimi-code', 'config.toml'))

    const listener = await startHookListener()
    server = listener.server
    const inPane = hookEnvironment({
      ORCA_AGENT_HOOK_PORT: String(listener.port),
      ORCA_AGENT_HOOK_TOKEN: HOOK_TOKEN,
      ORCA_PANE_KEY: PANE_KEY
    })

    const result = await runLikeKimi(command, inPane)
    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(listener.posts).toEqual([{ url: '/hook/kimi', payload: PAYLOAD, paneKey: PANE_KEY }])

    const outsideOrca = await runLikeKimi(command, hookEnvironment())
    expect(outsideOrca.timedOut).toBe(false)
    expect(outsideOrca.code).toBe(0)
    expect(listener.posts).toHaveLength(1)

    // The command the pre-fix installer registered on Windows.
    const legacy = wrapPosixHookCommand(
      join(home, '.orca', 'agent-hooks', 'kimi-hook.sh').replaceAll('\\', '/')
    )
    const legacyResult = await runLikeKimi(legacy, inPane)
    expect(legacyResult.code).not.toBe(0)
    expect(legacyResult.stderr).toContain('was unexpected at this time')
    expect(listener.posts).toHaveLength(1)
  }, 60_000)
})
