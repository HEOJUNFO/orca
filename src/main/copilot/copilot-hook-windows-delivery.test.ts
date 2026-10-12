// Why: Copilot runs a Windows hook as `<pwsh|powershell> -nop -nol -c <powershell>`. This suite
// runs every registered command that way and follows the payload to a listener, so the
// non-ASCII bytes and the per-event hookEventName are checked end to end.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { createServer, type Server } from 'node:http'
import { lstatSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { readHooksJson } from '../agent-hooks/installer-utils'
import { getWindowsPowerShellExecutablePath } from '../agent-hooks/windows-powershell-hook-launcher'
import { COPILOT_EVENTS } from './copilot-managed-hook-definitions'
import { CopilotHookService } from './hook-service'

const PANE_KEY = 'tab-1:leaf-1'
const HOOK_TOKEN = 'copilot-delivery-token'
const PAYLOAD = JSON.stringify({
  sessionId: 'copilot-windows-delivery',
  prompt: 'café 日本語 😀 "quoted" & echo %PATH% | more ^ <x>'
})

type HookPost = {
  url: string | undefined
  payload: string | null
  paneKey: string | null
  hookEventName: string | null
}

async function startHookListener(): Promise<{
  server: Server
  port: number
  posts: HookPost[]
}> {
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
        posts.push({
          url: req.url,
          payload: form.get('payload'),
          paneKey: form.get('paneKey'),
          hookEventName: form.get('hookEventName')
        })
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

function findPwsh(): string | null {
  const candidates = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe')
  ]
  // lstat: the Store install is an app-execution alias that existsSync cannot follow.
  return candidates.find((candidate) => lstatSync(candidate, { throwIfNoEntry: false })) ?? null
}

const RUNNERS: [string, string][] = [['powershell', getWindowsPowerShellExecutablePath()]]
const pwsh = process.platform === 'win32' ? findPwsh() : null
if (pwsh) {
  RUNNERS.push(['pwsh', pwsh])
}

// Mirrors Copilot's hook spawn: `-nop -nol -c <script>`, payload written to stdin as UTF-8.
function runLikeCopilot(shell: string, command: string, env: NodeJS.ProcessEnv) {
  return runProcess({
    program: shell,
    args: ['-nop', '-nol', '-c', command],
    env,
    input: PAYLOAD,
    timeoutMs: 20_000
  })
}

function readRegisteredCommands(copilotHome: string): Map<string, string> {
  const hooks = readHooksJson(join(copilotHome, 'hooks', 'orca.json'))?.hooks ?? {}
  const commands = new Map<string, string>()
  for (const [eventName, definitions] of Object.entries(hooks)) {
    commands.set(eventName, definitions[0]?.powershell ?? '')
  }
  return commands
}

describe.skipIf(process.platform !== 'win32')('Copilot hook delivery through PowerShell', () => {
  let root = ''
  let server: Server | null = null

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-copilot-cmd-'))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    server?.close()
    server = null
    if (root) {
      removeTreeSync(root)
      root = ''
    }
  })

  function useHome(name: string): string {
    const home = join(root, name)
    mkdirSync(home, { recursive: true })
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('HOME', home)
    vi.stubEnv('COPILOT_HOME', join(home, '.copilot'))
    // Why: cmd's AutoRun commonly targets %USERPROFILE%\.cmd_aliases.cmd; the temp home must
    // carry one or cmd's "not recognized" noise lands on the hook's stderr.
    writeFileSync(join(home, '.cmd_aliases.cmd'), '@rem\r\n', 'utf8')
    return home
  }

  // Why: an inherited ORCA_* var (e.g. ORCA_AGENT_HOOK_ENDPOINT) would post to the live app.
  function hookEnvironment(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const base = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('ORCA_'))
    )
    return { ...base, USERPROFILE: home, HOME: home, ...extra }
  }

  it.each(['user', 'user name'])(
    'posts byte-exact payloads with the event name for every hook (home "%s")',
    async (homeName) => {
      const home = useHome(homeName)
      expect(new CopilotHookService().install().state).toBe('installed')
      const commands = readRegisteredCommands(join(home, '.copilot'))
      expect([...commands.keys()].sort()).toEqual([...COPILOT_EVENTS].sort())
      for (const command of commands.values()) {
        // A space in the profile path is not cmd-safe, so that home exercises the encoded fallback.
        expect(command.includes('-EncodedCommand')).toBe(homeName === 'user name')
      }

      const listener = await startHookListener()
      server = listener.server
      const inPane = hookEnvironment(home, {
        ORCA_AGENT_HOOK_PORT: String(listener.port),
        ORCA_AGENT_HOOK_TOKEN: HOOK_TOKEN,
        ORCA_PANE_KEY: PANE_KEY
      })

      const expected: HookPost[] = []
      for (const [, shell] of RUNNERS) {
        for (const [eventName, command] of commands) {
          const result = await runLikeCopilot(shell, command, inPane)
          expect(result.timedOut, `${shell} ${eventName}`).toBe(false)
          expect(result.code, `${shell} ${eventName}`).toBe(0)
          expect(result.stdout.trim(), `${shell} ${eventName}`).toBe('{}')
          expect(result.stderr, `${shell} ${eventName}`).toBe('')
          expected.push({
            url: '/hook/copilot',
            payload: PAYLOAD,
            paneKey: PANE_KEY,
            hookEventName: eventName
          })
        }
      }
      expect(listener.posts).toEqual(expected)

      // Outside an Orca pane the hook answers and exits without posting or owning stdin.
      for (const [, shell] of RUNNERS) {
        const outside = await runLikeCopilot(shell, commands.get('Stop')!, hookEnvironment(home))
        expect(outside.timedOut).toBe(false)
        expect(outside.code).toBe(0)
        expect(outside.stdout.trim()).toBe('{}')
      }
      expect(listener.posts).toHaveLength(expected.length)
    },
    180_000
  )
})
