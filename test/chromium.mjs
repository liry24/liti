import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { stopProcess as stop } from './stop-process.ts'
const wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay))
export const chromiumProbe = async (origin, directory) => {
    const profile = await mkdtemp(join(directory, 'chromium-profile-'))
    const configHome = join(directory, 'chromium-config')
    await mkdir(configHome, { recursive: true })
    const executable = process.env.CHROMIUM_PATH ?? 'chromium'
    const versionDetails = { executable }
    const started = performance.now()
    const browser = spawn(
        executable,
        [
            '--headless',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--remote-debugging-port=0',
            `--user-data-dir=${profile}`,
            'about:blank',
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, XDG_CONFIG_HOME: configHome } },
    )
    let browserLogs = ''
    let browserOutput = ''
    let portState = { error: 'not-read' }
    browser.stdout.on('data', (chunk) => {
        browserOutput = (browserOutput + String(chunk)).slice(-16_384)
    })
    browser.stderr.on('data', (chunk) => {
        browserLogs = (browserLogs + String(chunk)).slice(-16_384)
    })
    const browserFailure = async (message, cause) => {
        const [profileEntries, processStatus] = await Promise.all([
            readdir(profile).then(
                (entries) => entries.slice(0, 20),
                (error) => ({ error: error.code }),
            ),
            readFile(`/proc/${browser.pid}/status`, 'utf8').then(
                (status) => status.split('\n').filter((line) => /^(Name|State|Threads|VmRSS):/.test(line)),
                (error) => ({ error: error.code }),
            ),
        ])
        const state = {
            executable,
            version: versionDetails,
            elapsedMs: Math.round(performance.now() - started),
            pid: browser.pid,
            exit: browser.exitCode,
            signal: browser.signalCode,
            portState,
            profileEntries,
            processStatus,
        }
        return new Error(
            `${message}\nChromium startup state: ${JSON.stringify(state)}${browserOutput ? `\nChromium stdout (bounded tail):\n${browserOutput}` : ''}${browserLogs ? `\nChromium stderr (bounded tail):\n${browserLogs}` : ''}`,
            { cause },
        )
    }
    let socket
    let browserError
    browser.on('error', (error) => {
        browserError = error
    })
    try {
        let debuggingPort
        // Hosted runners can still be flushing package installs while Chromium creates its profile.
        for (let attempt = 0; attempt < 600; attempt++) {
            const content = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then(
                (value) => {
                    portState = { content: value.slice(0, 300) }
                    return value
                },
                (error) => {
                    portState = { error: error.code }
                    return ''
                },
            )
            if (content) {
                debuggingPort = Number(content.split('\n')[0])
                break
            }
            if (browserError)
                throw await browserFailure(
                    'Chromium is required for the browser probe; set CHROMIUM_PATH or use --ssr-only for explicitly limited coverage.',
                    browserError,
                )
            if (browser.exitCode !== null || browser.signalCode !== null)
                throw await browserFailure(
                    `Chromium exited before its debugging endpoint started (exit=${browser.exitCode}, signal=${browser.signalCode}).`,
                )
            await wait(50)
        }
        if (!debuggingPort) throw await browserFailure('Chromium debugging endpoint did not start.')
        console.log(
            'Public data Chromium ready:',
            JSON.stringify({ version: versionDetails, elapsedMs: Math.round(performance.now() - started) }),
        )
        const page = await fetch(`http://127.0.0.1:${debuggingPort}/json/new?about:blank`, {
            method: 'PUT',
            signal: AbortSignal.timeout(15_000),
        })
            .then((response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`)
                return response.json()
            })
            .catch(async (error) => {
                throw await browserFailure('Chromium debugging endpoint could not open a page.', error)
            })
        socket = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Chromium CDP socket did not open.')), 15_000)
            socket.addEventListener(
                'open',
                () => {
                    clearTimeout(timer)
                    resolve()
                },
                { once: true },
            )
            socket.addEventListener(
                'error',
                () => {
                    clearTimeout(timer)
                    reject(new Error('Chromium CDP socket failed to open.'))
                },
                { once: true },
            )
        })
        let id = 0
        const pending = new Map()
        const diagnostics = []
        const recordDiagnostic = (item) => {
            diagnostics.push(item)
            if (diagnostics.length > 20) diagnostics.shift()
        }
        socket.addEventListener('message', (event) => {
            const message = JSON.parse(String(event.data))
            if (message.method === 'Log.entryAdded')
                recordDiagnostic({
                    kind: 'browser-log',
                    level: message.params.entry.level,
                    text: message.params.entry.text,
                })
            if (message.method === 'Runtime.exceptionThrown')
                recordDiagnostic({
                    kind: 'exception',
                    text:
                        message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text,
                })
            if (message.method === 'Network.loadingFailed')
                recordDiagnostic({
                    kind: 'request-failed',
                    error: message.params.errorText,
                    canceled: message.params.canceled,
                    blockedReason: message.params.blockedReason,
                    cors: message.params.corsErrorStatus,
                })
            if (!message.id) return
            const request = pending.get(message.id)
            pending.delete(message.id)
            clearTimeout(request?.timer)
            if (message.error) request?.reject(new Error(JSON.stringify(message.error)))
            else request?.resolve(message.result)
        })
        const rejectPending = (error) => {
            for (const request of pending.values()) {
                clearTimeout(request.timer)
                request.reject(error)
            }
            pending.clear()
        }
        socket.addEventListener('close', () => rejectPending(new Error('Chromium CDP socket closed.')))
        socket.addEventListener('error', () => rejectPending(new Error('Chromium CDP socket failed.')))
        const send = (method, params = {}) =>
            new Promise((resolve, reject) => {
                if (socket.readyState !== WebSocket.OPEN) {
                    reject(new Error('Chromium CDP socket is not open.'))
                    return
                }
                const requestId = ++id
                const timer = setTimeout(() => {
                    pending.delete(requestId)
                    reject(new Error(`Chromium CDP ${method} timed out.`))
                }, 15_000)
                pending.set(requestId, { resolve, reject, timer })
                socket.send(JSON.stringify({ id: requestId, method, params }))
            })
        await send('Page.enable')
        await send('Runtime.enable')
        await send('Log.enable')
        await send('Network.enable')
        await send('Page.navigate', { url: origin })
        for (let attempt = 0; attempt < 600; attempt++) {
            const result = await send('Runtime.evaluate', {
                expression: 'window.__litiProbe',
                returnByValue: true,
            })
            if (result.result?.value?.done) return { ...result.result.value, browserDiagnostics: diagnostics }
            await wait(100)
        }
        throw new Error('Public data browser probe did not complete.')
    } finally {
        socket?.close()
        await stop(browser)
    }
}
