import config from 'config'

import Event from './event.model'
import { asyncSplit, split } from '../utils'

import type { EventData } from 'web3-eth-contract'
import type { BlockHeader, Eth } from 'web3-eth'
import type { Logger } from '../definitions'
import type { ServiceMethods } from '@feathersjs/feathers'
import type { BlockTracker } from './block-tracker'
import type { EventEmitter } from 'events'

function isAlreadyConfirmedClosure (currentBlockNumber: number) {
  return (event: Event): boolean => event.getConfirmationsCount(currentBlockNumber) > event.targetConfirmation || event.emitted
}

function isConfirmedClosure (currentBlockNumber: number) {
  return (event: Event): boolean => event.getConfirmationsCount(currentBlockNumber) === event.targetConfirmation
}
const NEW_EVENT_EVENT_NAME = 'newEvent'
const NEW_CONFIRMATION_EVENT_NAME = 'newConfirmation'
const INVALID_CONFIRMATION_EVENT_NAME = 'invalidConfirmation'

export class Confirmator {
  private readonly emitter: EventEmitter
  private readonly eth: Eth
  private readonly contractAddress: string
  private readonly blockTracker: BlockTracker
  private readonly logger: Logger

  constructor (emitter: EventEmitter, eth: Eth, contractAddress: string, blockTracker: BlockTracker, logger: Logger) {
    this.emitter = emitter
    this.eth = eth
    this.contractAddress = contractAddress
    this.blockTracker = blockTracker
    this.logger = logger
  }

  /**
   * Retrieves confirmed events and emits them.
   *
   * Before emitting it validates that the Event is still valid on blockchain using the transaction's receipt.
   *
   * @param currentBlock
   */
  public async runConfirmationsRoutine (currentBlock: BlockHeader): Promise<void> {
    const events = await Event.findAll({
      where: {
        contractAddress: this.contractAddress
      }
    })

    const [alreadyConfirmed, awaitingConfirmation] = split(events, isAlreadyConfirmedClosure(currentBlock.number))
    await this.handleAlreadyConfirmed(alreadyConfirmed, currentBlock.number)

    const [valid, invalid] = await asyncSplit(awaitingConfirmation, this.eventHasValidReceipt.bind(this))
    const [toBeEmitted, toBeConfirmed] = split(valid, isConfirmedClosure(currentBlock.number))

    toBeEmitted.forEach(this.confirmEvent.bind(this))
    this.logger.info(`Confirmed ${toBeEmitted.length} events.`)
    await Event.update({ emitted: true }, { where: { id: toBeEmitted.map(e => e.id) } }) // Update DB that events were emitted

    toBeConfirmed.forEach(this.emitNewConfirmationsClosure(currentBlock.number))

    if (invalid.length !== 0) {
      invalid.forEach(e => this.emitter.emit(INVALID_CONFIRMATION_EVENT_NAME, { transactionHash: e.transactionHash }))
      await Event.destroy({ where: { id: invalid.map(e => e.id) } })
    }
  }

  private async eventHasValidReceipt (event: Event): Promise<boolean> {
    const reciept = await this.eth.getTransactionReceipt(event.transactionHash)

    if (reciept.status && reciept.blockNumber === event.blockNumber) {
      return true
    } else {
      this.logger.warn(`Event ${event.event} of transaction ${event.transactionHash} does not have valid receipt!
      Block numbers: ${event.blockNumber} (event) vs ${reciept.blockNumber} (receipt) and receipt status: ${reciept.status} `)
      return false
    }
  }

  private async handleAlreadyConfirmed (events: Event[], currentBlockNumber: number): Promise<void> {
    if (events.length === 0) {
      return // Nothing to handle
    }

    const targetMultiplier = config.get<number>('blockchain.deleteTargetConfirmationsMultiplier')
    const toBeDeleted = events.filter(
      event => event.emitted &&
        event.getConfirmationsCount(currentBlockNumber) >= event.targetConfirmation * targetMultiplier
    )

    this.logger.verbose(`Removing ${toBeDeleted.length} already confirmed events that exceeded number of required configuration * multiplier`)
    await Event.destroy({ where: { id: toBeDeleted.map(e => e.id) } })
  }

  private emitNewConfirmationsClosure (currentBlockNumber: number) {
    return (event: Event): void => {
      const data = {
        event: event.event,
        transactionHash: event.transactionHash,
        confirmations: event.getConfirmationsCount(currentBlockNumber),
        targetConfirmation: event.targetConfirmation
      }
      this.emitter.emit(NEW_CONFIRMATION_EVENT_NAME, data)
    }
  }

  private confirmEvent (data: Event): void {
    // If it was already emitted then ignore this
    if (data.emitted) {
      return
    }

    const event = JSON.parse(data.content) as EventData
    this.logger.debug('Confirming event', event)
    this.blockTracker.setLastProcessedBlockIfHigher(event.blockNumber, event.blockHash)
    this.emitter.emit(NEW_EVENT_EVENT_NAME, event)
  }
}

export class ConfirmatorService implements Partial<ServiceMethods<any>> {
  private readonly eth: Eth
  public events: string[]

  constructor (eth: Eth) {
    this.eth = eth
    this.events = [NEW_CONFIRMATION_EVENT_NAME, INVALID_CONFIRMATION_EVENT_NAME]
  }

  async find (): Promise<object[]> {
    const transactionsToBeConfirmed = await Event.findAll({
      attributes: ['blockNumber', 'transactionHash', 'event', 'targetConfirmation'],
      group: ['transactionHash', 'event']
    })
    const currentBlockNumber = await this.eth.getBlockNumber()

    return transactionsToBeConfirmed.map(event => {
      return {
        event: event.event,
        transactionHash: event.transactionHash,
        confirmations: currentBlockNumber - event.blockNumber,
        targetConfirmation: event.targetConfirmation
      }
    })
  }
}
