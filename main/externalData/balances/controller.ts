import log from 'electron-log'
import { ChildProcess, fork } from 'child_process'

import { CurrencyBalance, TokenBalance } from './scan'
import path from 'path'
import { EventEmitter } from 'stream'

interface WorkerMessage {
  type: string,
  [key: string]: any
}

export enum BalanceSource {
  Known = 'known',
  Scan = 'scan'
}

interface TokenBalanceMessage extends Omit<WorkerMessage, 'type'> {
  type: 'tokenBalances',
  address: Address,
  balances: TokenBalance[],
  source: BalanceSource
}

interface ChainBalanceMessage extends Omit<WorkerMessage, 'type'> {
  type: 'chainBalances',
  address: Address,
  balances: CurrencyBalance[]
}

export default class BalancesWorkerController extends EventEmitter {
  private readonly worker: ChildProcess

  private heartbeat?: NodeJS.Timeout

  constructor () {
    super()
  
    const workerArgs = process.env.NODE_ENV === 'development' ? ['--inspect=127.0.0.1:9230'] : []
    this.worker = fork(path.resolve(__dirname, 'worker.js'), workerArgs)

    log.info('created balances worker, pid:', this.worker.pid)

    this.worker.on('message', (message: WorkerMessage) => {
      log.debug(`balances controller message: ${JSON.stringify(message)}`)

      if (message.type === 'ready') {
        log.info(`balances worker ready, pid: ${this.worker.pid}`)

        this.heartbeat = this.startMessages(this.sendHeartbeat.bind(this), 1000 * 20)

        this.emit('ready')
      }

      if (message.type === 'chainBalances') {
        const { address, balances } = (message as ChainBalanceMessage)
        this.emit('chainBalances', address, balances)
      }

      if (message.type === 'tokenBalances') {
        const { address, balances, source } = (message as TokenBalanceMessage)
        this.emit('tokenBalances', address, balances, source)
      }
    })
  
    this.worker.on('exit', code => {
      log.warn(`balances worker exited with code ${code}, pid: ${this.worker.pid}`)
      this.close()
    })
  
    this.worker.on('error', err => {
      log.warn(`balances worker sent error, pid: ${this.worker.pid}`, err)
      this.close()
    })
  }

  close () {
    this.worker.removeAllListeners()

    if (this.heartbeat) {
      clearTimeout(this.heartbeat)
      this.heartbeat = undefined
    }
  
    const killed = this.worker.killed || this.worker.kill('SIGTERM')

    this.emit('close', killed)
    this.removeAllListeners()

    return killed
  }

  isRunning () {
    return !!this.heartbeat
  }

  updateActiveBalances (address: Address, tokens: Token[]) {
    this.sendCommandToWorker('updateChainBalance', [address])
    this.sendCommandToWorker('fetchTokenBalances', [address, tokens])
    this.sendCommandToWorker('tokenBalanceScan', [address, tokens])
  }

  // sending messages
  private sendCommandToWorker (command: string, args: any[] = []) {
    this.worker.send({ command, args })
  }

  private sendHeartbeat () {
    this.sendCommandToWorker('heartbeat')
  }

  private startMessages (fn: () => void, interval: number | (() => number)) {
    setTimeout(fn, 0)
    return this.scheduleMessage(fn, interval)
  }

  private scheduleMessage (fn: () => void, interval: number | (() => number)) {
    const timeoutInterval = (typeof interval === 'number') ? interval : interval()
  
    return setTimeout(() => {
      fn()
      this.scheduleMessage(fn, interval)
    }, timeoutInterval)
  }
}