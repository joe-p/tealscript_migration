import {
  Contract,
  GlobalState,
  BoxMap,
  uint64,
  Account,
  Application,
  bytes,
  assert,
  Txn,
  Global,
  TransactionType,
  assertMatch,
  itxn,
  gtxn,
  clone,
  arc4,
} from '@algorandfoundation/algorand-typescript'

type PluginsKey = {
  application: Application
  allowedCaller: Account
}

type PluginInfo = {
  lastValidRound: uint64
  cooldown: uint64
  lastCalled: uint64
  adminPrivileges: boolean
}

export class AbstractedAccount extends Contract {
  public admin = GlobalState<Account>({ key: 'a' })

  public controlledAddress = GlobalState<Account>({ key: 'c' })

  public plugins = BoxMap<PluginsKey, PluginInfo>({ keyPrefix: 'p' })

  public namedPlugins = BoxMap<bytes, PluginsKey>({ keyPrefix: 'n' })

  private verifyRekeyToAbstractedAccount(): void {
    let rekeyedBack = false

    for (let i = Txn.groupIndex; i < Global.groupSize; i += 1) {
      const txn = gtxn.Transaction(i)

      if (txn.sender === this.controlledAddress.value && txn.rekeyTo === this.controlledAddress.value) {
        rekeyedBack = true
        break
      }

      if (
        txn.type === TransactionType.ApplicationCall &&
        (txn as gtxn.ApplicationCallTxn).appId === Global.currentApplicationId &&
        (txn as gtxn.ApplicationCallTxn).numAppArgs === 1 &&
        (txn as gtxn.ApplicationCallTxn).appArgs(0) === arc4.methodSelector('arc58_verifyAuthAddr()void')
      ) {
        rekeyedBack = true
        break
      }
    }

    assert(rekeyedBack)
  }

  private getAuthAddr(): Account {
    return this.controlledAddress.value === Global.currentApplicationAddress
      ? Global.zeroAddress
      : Global.currentApplicationAddress
  }

  public createApplication(controlledAddress: Account, admin: Account): void {
    assert(controlledAddress === Txn.sender || admin === Txn.sender)

    assert(admin !== controlledAddress)

    this.admin.value = admin
    this.controlledAddress.value =
      controlledAddress === Global.zeroAddress ? Global.currentApplicationAddress : controlledAddress
  }

  public arc58_changeAdmin(newAdmin: Account): void {
    assertMatch(Txn, { sender: this.admin.value })
    this.admin.value = newAdmin
  }

  public arc58_pluginChangeAdmin(plugin: Application, allowedCaller: Account, newAdmin: Account): void {
    assertMatch(Txn, { sender: plugin.address })
    assert(this.controlledAddress.value.authAddress === plugin.address, 'This plugin is not in control of the account')

    const key: PluginsKey = { application: plugin, allowedCaller: allowedCaller }
    assert(
      this.plugins(key).exists && this.plugins(key).value.adminPrivileges,
      'This plugin does not have admin privileges',
    )

    this.admin.value = newAdmin
  }

  public arc58_getAdmin(): bytes {
    return this.admin.value.bytes
  }

  public arc58_verifyAuthAddr(): void {
    assert(this.controlledAddress.value.authAddress === this.getAuthAddr())
  }

  public arc58_rekeyTo(addr: Account, flash: boolean): void {
    assertMatch(Txn, { sender: this.admin.value })

    itxn
      .payment({
        sender: this.controlledAddress.value,
        receiver: addr,
        rekeyTo: addr,
        note: 'rekeying abstracted account',
      })
      .submit()

    if (flash) this.verifyRekeyToAbstractedAccount()
  }

  private pluginCallAllowed(app: Application, caller: Account): boolean {
    const key: PluginsKey = { application: app, allowedCaller: caller }

    return (
      this.plugins(key).exists &&
      this.plugins(key).value.lastValidRound >= Global.round &&
      Global.round - this.plugins(key).value.lastCalled >= this.plugins(key).value.cooldown
    )
  }

  public arc58_rekeyToPlugin(plugin: Application): void {
    const globalAllowed = this.pluginCallAllowed(plugin, Global.zeroAddress)

    if (!globalAllowed)
      assert(this.pluginCallAllowed(plugin, Txn.sender), 'This sender is not allowed to trigger this plugin')

    itxn
      .payment({
        sender: this.controlledAddress.value,
        receiver: this.controlledAddress.value,
        rekeyTo: plugin.address,
        note: 'rekeying to plugin app',
      })
      .submit()

    this.plugins({
      application: plugin,
      allowedCaller: globalAllowed ? Global.zeroAddress : Txn.sender,
    }).value.lastCalled = Global.round

    this.verifyRekeyToAbstractedAccount()
  }

  public arc58_rekeyToNamedPlugin(name: bytes): void {
    this.arc58_rekeyToPlugin(this.namedPlugins(name).value.application)
  }

  public arc58_addPlugin(
    app: Application,
    allowedCaller: Account,
    lastValidRound: uint64,
    cooldown: uint64,
    adminPrivileges: boolean,
  ): void {
    assertMatch(Txn, { sender: this.admin.value })
    const key: PluginsKey = { application: app, allowedCaller: allowedCaller }
    this.plugins(key).value = {
      lastValidRound: lastValidRound,
      cooldown: cooldown,
      lastCalled: 0,
      adminPrivileges: adminPrivileges,
    }
  }

  public arc58_removePlugin(app: Application, allowedCaller: Account): void {
    assertMatch(Txn, { sender: this.admin.value })

    const key: PluginsKey = { application: app, allowedCaller: allowedCaller }
    this.plugins(key).delete()
  }

  public arc58_addNamedPlugin(
    name: bytes,
    app: Application,
    allowedCaller: Account,
    lastValidRound: uint64,
    cooldown: uint64,
    adminPrivileges: boolean,
  ): void {
    assertMatch(Txn, { sender: this.admin.value })
    assert(!this.namedPlugins(name).exists)

    const key: PluginsKey = { application: app, allowedCaller: allowedCaller }
    this.namedPlugins(name).value = clone(key)
    this.plugins(key).value = {
      lastValidRound: lastValidRound,
      cooldown: cooldown,
      lastCalled: 0,
      adminPrivileges: adminPrivileges,
    }
  }

  public arc58_removeNamedPlugin(name: bytes): void {
    assertMatch(Txn, { sender: this.admin.value })

    const app = clone(this.namedPlugins(name).value)
    this.namedPlugins(name).delete()
    this.plugins(app).delete()
  }
}
