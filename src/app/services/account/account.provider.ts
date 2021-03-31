import { ProtocolService, UiEventService } from '@airgap/angular-core'
import { AirGapMarketWallet, ICoinProtocol, SerializedAirGapWallet, TezosProtocol } from '@airgap/coinlib-core'
import { TezosProtocolNetwork, TezosProtocolOptions } from '@airgap/coinlib-core/protocols/tezos/TezosProtocolOptions'
import { AirGapWalletStatus } from '@airgap/coinlib-core/wallet/AirGapWallet'
import { Injectable } from '@angular/core'
import { Router } from '@angular/router'
import { PushNotification } from '@capacitor/core'
import { AlertController, LoadingController, PopoverController, ToastController } from '@ionic/angular'
import { Observable, ReplaySubject, Subject } from 'rxjs'
import { auditTime, map, take } from 'rxjs/operators'

import { DelegateAlertAction } from '../../models/actions/DelegateAlertAction'
import { AirGapTipUsAction } from '../../models/actions/TipUsAction'
import { AirGapMarketWalletGroup, SerializedAirGapMarketWalletGroup } from '../../models/AirGapMarketWalletGroup'
import { isType } from '../../utils/utils'
import { DataService } from '../data/data.service'
import { DrawChartService } from '../draw-chart/draw-chart.service'
import { OperationsProvider } from '../operations/operations'
import { PriceService } from '../price/price.service'
import { PushProvider } from '../push/push'
import { ErrorCategory, handleErrorSentry } from '../sentry-error-handler/sentry-error-handler'
import { WalletStorageKey, WalletStorageService } from '../storage/storage'

enum NotificationKind {
  CTA_Tip = 'cta_tip',
  CTA_Delegate = 'cta_delegate'
}

interface CTAInfo {
  kind: NotificationKind
  fromAddress: string
  toAddress: string
  amount: string
  alertTitle: string
  alertDescription: string
}

@Injectable({
  providedIn: 'root'
})
export class AccountProvider {
  private readonly activeGroup$: ReplaySubject<AirGapMarketWalletGroup | null> = new ReplaySubject(1)
  private readonly walletGroups: Map<string | undefined, AirGapMarketWalletGroup> = new Map()

  public walletsHaveLoaded: ReplaySubject<boolean> = new ReplaySubject(1)

  public refreshPageSubject: Subject<void> = new Subject()

  public walletGroups$: ReplaySubject<AirGapMarketWalletGroup[]> = new ReplaySubject(1)
  public wallets$: ReplaySubject<AirGapMarketWallet[]> = new ReplaySubject(1)
  public subWallets$: ReplaySubject<AirGapMarketWallet[]> = new ReplaySubject(1)
  public usedProtocols$: ReplaySubject<ICoinProtocol[]> = new ReplaySubject(1)

  private readonly walletChangedBehaviour: Subject<void> = new Subject()

  get walletChangedObservable() {
    return this.walletChangedBehaviour.asObservable().pipe(auditTime(50))
  }

  private get allWalletGroups(): AirGapMarketWalletGroup[] {
    return Array.from(this.walletGroups.values())
  }

  private get allWallets(): AirGapMarketWallet[] {
    return this.allWalletGroups.reduce((wallets: AirGapMarketWallet[], group: AirGapMarketWalletGroup) => wallets.concat(group.wallets), [])
  }

  constructor(
    private readonly storageProvider: WalletStorageService,
    private readonly pushProvider: PushProvider,
    private readonly drawChartProvider: DrawChartService,
    private readonly popoverController: PopoverController,
    private readonly uiEventService: UiEventService,
    private readonly alertController: AlertController,
    private readonly toastController: ToastController,
    private readonly loadingController: LoadingController,
    private readonly opertaionsProvider: OperationsProvider,
    private readonly dataService: DataService,
    private readonly router: Router,
    private readonly priceService: PriceService,
    private readonly protocolService: ProtocolService
  ) {
    this.loadWalletsFromStorage()
      .then(() => {
        this.walletsHaveLoaded.next(true)
      })
      .catch(console.error)
    this.wallets$.pipe(map(wallets => wallets.filter(wallet => 'subProtocolType' in wallet.protocol))).subscribe(this.subWallets$)
    this.wallets$.pipe(map(wallets => this.getProtocolsFromWallets(wallets))).subscribe(this.usedProtocols$)

    this.pushProvider.notificationCallback = (notification: PushNotification): void => {
      // We need a timeout because otherwise routing might fail

      const env = {
        popoverController: this.popoverController,
        loadingController: this.loadingController,
        uiEventService: this.uiEventService,
        alertController: this.alertController,
        toastController: this.toastController,
        operationsProvider: this.opertaionsProvider,
        dataService: this.dataService,
        router: this.router
      }

      if (notification && isType<CTAInfo>(notification.data)) {
        const tippingInfo: CTAInfo = notification.data

        if (tippingInfo.kind === NotificationKind.CTA_Tip) {
          const originWallet: AirGapMarketWallet = this.getWalletList().find((wallet: AirGapMarketWallet) =>
            wallet.addresses.some((address: string) => address === tippingInfo.fromAddress)
          )
          setTimeout(() => {
            const tipAction: AirGapTipUsAction = new AirGapTipUsAction({
              wallet: originWallet,
              tipAddress: tippingInfo.toAddress,
              amount: tippingInfo.amount,
              alertTitle: tippingInfo.alertTitle,
              alertDescription: tippingInfo.alertDescription,
              ...env
            })

            tipAction.start()
          }, 3500)
        }

        if (tippingInfo.kind === NotificationKind.CTA_Delegate) {
          const originWallet: AirGapMarketWallet = this.getWalletList().find((wallet: AirGapMarketWallet) =>
            wallet.addresses.some((address: string) => address === tippingInfo.fromAddress)
          )
          setTimeout(() => {
            const delegateAlertAction: DelegateAlertAction = new DelegateAlertAction({
              wallet: originWallet,
              delegate: tippingInfo.toAddress,
              alertTitle: tippingInfo.alertTitle,
              alertDescription: tippingInfo.alertDescription,
              ...env
            })

            delegateAlertAction.start()
          }, 3500)
        }
      }
    }
  }

  public getActiveWalletGroupObservable(): Observable<AirGapMarketWalletGroup | undefined> {
    return this.activeGroup$.asObservable()
  }

  public getWalletGroupsObservable(): Observable<AirGapMarketWalletGroup[]> {
    return this.walletGroups$.asObservable().pipe(map((groups: AirGapMarketWalletGroup[]) => this.sortGroupsByLabel(groups)))
  }

  public triggerWalletChanged() {
    this.walletChangedBehaviour.next()
  }

  private getProtocolsFromWallets(wallets: AirGapMarketWallet[]) {
    const protocols: Map<string, ICoinProtocol> = new Map()
    wallets.forEach(wallet => {
      if (!protocols.has(wallet.protocol.identifier)) {
        protocols.set(wallet.protocol.identifier, wallet.protocol)
      }
    })

    return Array.from(protocols.values())
  }

  public hasInactiveWallets(protocol: ICoinProtocol): boolean {
    return this.allWallets.some(
      (wallet: AirGapMarketWallet) => wallet.protocol.identifier === protocol.identifier && wallet.status !== AirGapWalletStatus.ACTIVE
    )
  }

  private async loadWalletsFromStorage() {
    const [rawGroups, rawWallets]: [
      (SerializedAirGapMarketWalletGroup[] | undefined),
      (SerializedAirGapWallet[] | undefined)
    ] = await Promise.all([this.storageProvider.get(WalletStorageKey.WALLET_GROUPS), this.storageProvider.get(WalletStorageKey.WALLET)])

    const groups = rawGroups || []
    let wallets = rawWallets || []

    // migrating double-serialization
    if (!(rawWallets instanceof Array)) {
      try {
        wallets = JSON.parse(rawWallets)
      } catch (e) {
        wallets = []
      }
    }

    // "wallets" can be undefined here
    if (!wallets) {
      wallets = []
    }

    const walletMap: Record<string, SerializedAirGapWallet | undefined> = wallets.reduce(
      (obj: Record<string, SerializedAirGapWallet>, next: SerializedAirGapWallet) =>
        Object.assign(obj, { [this.createWalletIdentifier(next.protocolIdentifier, next.publicKey)]: next }),
      {}
    )

    const walletInitPromises: Promise<void>[] = []

    // read groups
    await Promise.all(
      groups.map(async (group: SerializedAirGapMarketWalletGroup) => {
        const wallets: AirGapMarketWallet[] = (await Promise.all(
          group.wallets.map(async ([protocolIdentifier, publicKey]: [string, string]) => {
            const walletIdentifier: string = this.createWalletIdentifier(protocolIdentifier, publicKey)
            const serializedWallet: SerializedAirGapWallet | undefined = walletMap[walletIdentifier]
            if (serializedWallet === undefined) {
              return undefined
            }
            walletMap[walletIdentifier] = undefined

            const airGapWallet: AirGapMarketWallet = await this.readSerializedWallet(serializedWallet)
            walletInitPromises.push(this.initializeWallet(airGapWallet))

            return airGapWallet
          })
        )).filter((wallet: AirGapMarketWallet | undefined) => wallet !== undefined)

        const walletGroup: AirGapMarketWalletGroup = new AirGapMarketWalletGroup(group.id, group.label, wallets)

        this.walletGroups.set(walletGroup.id, walletGroup)
      })
    )

    // read ungrouped wallets
    const ungroupedWallets: AirGapMarketWallet[] = await Promise.all(
      Object.values(walletMap)
        .filter((serializedWallet: SerializedAirGapWallet | undefined) => serializedWallet !== undefined)
        .map(async (serializedWallet: SerializedAirGapWallet) => {
          const airGapWallet: AirGapMarketWallet = await this.readSerializedWallet(serializedWallet)
          walletInitPromises.push(this.initializeWallet(airGapWallet))

          return airGapWallet
        })
    )

    if (ungroupedWallets.length > 0 && ungroupedWallets.length !== wallets.length) {
      const others: AirGapMarketWalletGroup = new AirGapMarketWalletGroup(undefined, undefined, ungroupedWallets, true)
      this.walletGroups.set(others.id, others)
    }

    Promise.all(walletInitPromises).then(() => {
      this.triggerWalletChanged()
      this.drawChartProvider.drawChart()
    })

    /* Use for Testing of Skeleton
    await new Promise(resolve => {
      setTimeout(() => {
        resolve()
      }, 2000)
    })
    */

    if (this.allWallets.length > 0) {
      this.pushProvider.setupPush()
    }

    this.setActiveGroup(null)
    this.walletGroups$.next(this.allWalletGroups)
    this.pushProvider.registerWallets(this.allWallets)
  }

  private async readSerializedWallet(serializedWallet: SerializedAirGapWallet): Promise<AirGapMarketWallet> {
    const protocol: ICoinProtocol = await this.protocolService.getProtocol(
      serializedWallet.protocolIdentifier,
      serializedWallet.networkIdentifier
    )

    const airGapWallet: AirGapMarketWallet = new AirGapMarketWallet(
      protocol,
      serializedWallet.publicKey,
      serializedWallet.isExtendedPublicKey,
      serializedWallet.derivationPath,
      serializedWallet.masterFingerprint || '',
      serializedWallet.status || AirGapWalletStatus.ACTIVE,
      this.priceService,
      serializedWallet.addressIndex
    )
    // add derived addresses
    airGapWallet.addresses = serializedWallet.addresses

    return airGapWallet
  }

  private async initializeWallet(airGapWallet: AirGapMarketWallet): Promise<void> {
    return new Promise<void>(resolve => {
      // if we have no addresses, derive using webworker and sync, else just sync
      if (airGapWallet.addresses.length === 0 || (airGapWallet.isExtendedPublicKey && airGapWallet.addresses.length < 20)) {
        const airGapWorker = new Worker('./assets/workers/airgap-coin-lib.js')

        airGapWorker.onmessage = event => {
          airGapWallet.addresses = event.data.addresses
          airGapWallet
            .synchronize()
            .then(() => {
              resolve()
            })
            .catch(error => {
              console.error(error)
              resolve()
            })
        }

        airGapWorker.postMessage({
          protocolIdentifier: airGapWallet.protocol.identifier,
          publicKey: airGapWallet.publicKey,
          isExtendedPublicKey: airGapWallet.isExtendedPublicKey,
          derivationPath: airGapWallet.derivationPath,
          addressIndex: airGapWallet.addressIndex
        })
      } else {
        airGapWallet
          .synchronize()
          .then(() => {
            resolve()
          })
          .catch(error => {
            console.error(error)
            resolve()
          })
      }
    })
  }

  public getWalletList(): AirGapMarketWallet[] {
    return this.allWallets
  }

  public setActiveGroup(group: AirGapMarketWalletGroup | undefined | null): void {
    if (group === undefined || group === null) {
      this.activeGroup$.next(null)
      this.wallets$.next(this.allWallets)
    } else if (this.walletGroups.has(group.id)) {
      const _group: AirGapMarketWalletGroup = this.walletGroups.get(group.id)
      const wallets: AirGapMarketWallet[] = _group.wallets

      this.activeGroup$.next(_group)
      this.wallets$.next(wallets)
    }
  }

  public async addWallet(
    walletToAdd: AirGapMarketWallet,
    groupId?: string,
    groupLabel?: string,
    options: { override?: boolean; updateState?: boolean } = {}
  ): Promise<void> {
    const defaultOptions = {
      override: false,
      updateState: true
    }

    const resolvedOptions = {
      ...defaultOptions,
      ...options
    }

    const alreadyExists: boolean = this.walletExists(walletToAdd)
    if (alreadyExists && !resolvedOptions.override) {
      throw new Error('wallet already exists')
    }

    if (!this.walletGroups.has(groupId)) {
      this.walletGroups.set(groupId, new AirGapMarketWalletGroup(groupId, groupLabel, []))
    }

    const walletGroup: AirGapMarketWalletGroup = this.walletGroups.get(groupId)
    if (walletGroup.label !== groupLabel && groupLabel !== undefined) {
      walletGroup.updateLabel(groupLabel)
    }

    const index: number = alreadyExists
      ? walletGroup.wallets.findIndex((wallet: AirGapMarketWallet) => this.isSameWallet(wallet, walletToAdd))
      : -1

    if (index > -1 && walletGroup.wallets[index].status === AirGapWalletStatus.ACTIVE) {
      this.removeWallet(walletToAdd, { updateState: false })
    }

    if (walletToAdd.status === AirGapWalletStatus.ACTIVE) {
      // Register address with push backend
      this.pushProvider.setupPush()
      this.pushProvider.registerWallets([walletToAdd]).catch(handleErrorSentry(ErrorCategory.PUSH))
    }

    if (index === -1) {
      walletGroup.wallets.push(walletToAdd)
    } else {
      walletGroup.wallets[index] = walletToAdd
    }

    walletGroup.updateStatus()

    if (resolvedOptions.updateState) {
      this.setActiveGroup(walletGroup)
      this.walletGroups$.next(this.allWalletGroups)
      this.drawChartProvider.drawChart()

      return this.persist()
    }
  }

  public async activateWallet(
    walletToActivate: AirGapMarketWallet,
    groupId: string,
    options: { updateState?: boolean } = {}
  ): Promise<void> {
    const defaultOptions = {
      updateState: true
    }

    const resolvedOptions = {
      ...defaultOptions,
      ...options
    }

    const walletGroup: AirGapMarketWalletGroup = this.walletGroups.get(groupId)

    const index: number = walletGroup.wallets.findIndex((wallet: AirGapMarketWallet) => this.isSameWallet(wallet, walletToActivate))
    if (index === -1) {
      return
    }

    walletGroup.wallets[index].status = AirGapWalletStatus.ACTIVE

    walletGroup.updateStatus()

    if (resolvedOptions.updateState) {
      this.setActiveGroup(walletGroup)
      this.walletGroups$.next(this.allWalletGroups)
      this.drawChartProvider.drawChart()

      return this.persist()
    }
  }

  public async removeWallet(walletToRemove: AirGapMarketWallet, options: { updateState?: boolean } = {}): Promise<void> {
    const defaultOptions = {
      updateState: true
    }

    const resolvedOptions = {
      ...defaultOptions,
      ...options
    }

    let [groupId, index]: [string | undefined, number | undefined] = this.findWalletGroupIdAndIndex(walletToRemove) || [
      undefined,
      undefined
    ]

    let group: AirGapMarketWalletGroup | undefined
    if (groupId !== undefined && index !== undefined) {
      group = this.walletGroups.get(groupId)
      group.wallets[index].status = AirGapWalletStatus.DELETED
      group.updateStatus()
    }

    // Unregister address from push backend
    this.pushProvider.unregisterWallets([walletToRemove]).catch(handleErrorSentry(ErrorCategory.PUSH))

    if (resolvedOptions.updateState) {
      this.setActiveGroup(group !== undefined && group.status === AirGapWalletStatus.ACTIVE ? group : undefined)
      this.walletGroups$.next(this.allWalletGroups)
      this.drawChartProvider.drawChart()

      return this.persist()
    }
  }

  public async setWalletNetwork(wallet: AirGapMarketWallet, network: TezosProtocolNetwork): Promise<void> {
    await wallet.setProtocol(new TezosProtocol(new TezosProtocolOptions(network)))

    await this.persist()

    this.triggerWalletChanged()
  }

  private async persist(): Promise<void> {
    await Promise.all([
      this.storageProvider.set(
        WalletStorageKey.WALLET_GROUPS,
        this.allWalletGroups
          .filter((group: AirGapMarketWalletGroup) => !group.transient)
          .map((group: AirGapMarketWalletGroup) => group.toJSON())
      ),
      this.storageProvider.set(WalletStorageKey.WALLET, this.allWallets.map((wallet: AirGapMarketWallet) => wallet.toJSON()))
    ])
  }

  public getAccountIdentifier(wallet: AirGapMarketWallet): string {
    return wallet.addressIndex
      ? `${wallet.protocol.identifier}-${wallet.publicKey}-${wallet.protocol.options.network.identifier}-${wallet.addressIndex}`
      : `${wallet.protocol.identifier}-${wallet.publicKey}-${wallet.protocol.options.network.identifier}`
  }

  public walletBySerializerAccountIdentifier(accountIdentifier: string, protocolIdentifier: string): AirGapMarketWallet {
    return this.allWallets.find(wallet => wallet.publicKey.endsWith(accountIdentifier) && wallet.protocol.identifier === protocolIdentifier)
  }

  public walletByPublicKeyAndProtocolAndAddressIndex(
    publicKey: string,
    protocolIdentifier: string,
    addressIndex?: number
  ): AirGapMarketWallet {
    return this.allWallets.find(
      wallet => wallet.publicKey === publicKey && wallet.protocol.identifier === protocolIdentifier && wallet.addressIndex === addressIndex
    )
  }

  public walletExists(testWallet: AirGapMarketWallet): boolean {
    return this.allWallets.some(
      (wallet: AirGapMarketWallet) => this.isSameWallet(wallet, testWallet) && wallet.status === testWallet.status
    )
  }

  public isSameWallet(wallet1: AirGapMarketWallet, wallet2: AirGapMarketWallet) {
    if (!(wallet1 instanceof AirGapMarketWallet) || !(wallet2 instanceof AirGapMarketWallet)) {
      return false
    }

    return (
      wallet1.publicKey === wallet2.publicKey &&
      wallet1.protocol.identifier === wallet2.protocol.identifier &&
      wallet1.addressIndex === wallet2.addressIndex
    )
  }

  public findWalletGroup(testWallet: AirGapMarketWallet): AirGapMarketWalletGroup | undefined {
    for (const group of this.walletGroups.values()) {
      const index: number = group.wallets.findIndex((wallet: AirGapMarketWallet) => this.isSameWallet(wallet, testWallet))
      if (index !== -1) {
        return group
      }
    }

    return undefined
  }

  public findWalletGroupIdAndIndex(testWallet: AirGapMarketWallet): [string, number] | undefined {
    for (const group of this.walletGroups.values()) {
      const index: number = group.wallets.findIndex((wallet: AirGapMarketWallet) => this.isSameWallet(wallet, testWallet))
      if (index !== -1) {
        return [group.id, index]
      }
    }

    return undefined
  }

  public async getCompatibleAndIncompatibleWalletsForAddress(
    address: string
  ): Promise<{
    compatibleWallets: AirGapMarketWallet[]
    incompatibleWallets: AirGapMarketWallet[]
  }> {
    return this.usedProtocols$
      .pipe(
        take(1),
        map(protocols => {
          const compatibleProtocols: Map<string, ICoinProtocol> = new Map()

          protocols.forEach(protocol => {
            const match = address.match(protocol.addressValidationPattern)
            if (match && match.length > 0) {
              compatibleProtocols.set(protocol.identifier, protocol)
            }
          })

          const compatibleWallets: AirGapMarketWallet[] = []
          const incompatibleWallets: AirGapMarketWallet[] = []

          this.allWallets.forEach(wallet => {
            if (compatibleProtocols.has(wallet.protocol.identifier)) {
              compatibleWallets.push(wallet)
            } else {
              incompatibleWallets.push(wallet)
            }
          })

          return {
            compatibleWallets,
            incompatibleWallets
          }
        })
      )
      .toPromise()
  }

  private sortGroupsByLabel(groups: AirGapMarketWalletGroup[]): AirGapMarketWalletGroup[] {
    const othersIndex: number = groups.findIndex((group: AirGapMarketWalletGroup) => group.id === undefined)
    const others: AirGapMarketWalletGroup | undefined = othersIndex > -1 ? groups[othersIndex] : undefined

    const userDefinedGroups: AirGapMarketWalletGroup[] =
      othersIndex > -1 ? groups.slice(0, othersIndex).concat(groups.slice(othersIndex + 1)) : groups

    const sorted: AirGapMarketWalletGroup[] = userDefinedGroups.sort((a: AirGapMarketWalletGroup, b: AirGapMarketWalletGroup) =>
      a.label.localeCompare(b.label)
    )

    return others !== undefined ? [...sorted, others] : sorted
  }

  private createWalletIdentifier(protocolIdentifier: string, publicKey: string): string {
    return `${protocolIdentifier}_${publicKey}`
  }
}
