import {
  Contract,
  GlobalState,
  Box,
  BoxMap,
  uint64,
  bytes,
  FixedArray,
  arc4,
  assert,
  Global,
  Txn,
  itxn,
  clone,
} from '@algorandfoundation/algorand-typescript'

import {
  MAX_STAKERS_PER_POOL,
  ALGORAND_ACCOUNT_MIN_BALANCE,
  APPLICATION_BASE_FEE,
  ASSET_HOLDING_FEE,
  GATING_TYPE_ASSET_ID,
  GATING_TYPE_ASSETS_CREATED_BY,
  GATING_TYPE_CONST_MAX,
  GATING_TYPE_CREATED_BY_NFD_ADDRESSES,
  GATING_TYPE_NONE,
  GATING_TYPE_SEGMENT_OF_NFD,
  MAX_PCT_TO_VALIDATOR,
  MAX_VALIDATOR_HARD_PCT_OF_ONLINE_1DECIMAL,
  MAX_VALIDATOR_SOFT_PCT_OF_ONLINE_1DECIMAL,
  MIN_ALGO_STAKE_PER_POOL,
  MIN_PCT_TO_VALIDATOR,
  SSC_VALUE_BYTES,
  SSC_VALUE_UINT,
} from '../reti_constants/constants.algo'

const MAX_NODES = 8
const MAX_POOLS_PER_NODE = 3
const MAX_POOLS_PER_STAKER = 6
const MIN_EPOCH_LENGTH = 1
const MAX_EPOCH_LENGTH = 1000000

type ValidatorIdType = uint64

export type ValidatorPoolKey = {
  id: ValidatorIdType
  poolId: uint64
  poolAppId: uint64
}

export type ValidatorConfig = {
  id: ValidatorIdType
  owner: arc4.Address
  manager: arc4.Address
  nfdForInfo: uint64
  entryGatingType: uint64
  entryGatingAddress: arc4.Address
  entryGatingAssets: FixedArray<uint64, 4>
  gatingAssetMinBalance: uint64
  rewardTokenId: uint64
  rewardPerPayout: uint64
  epochRoundLength: uint64
  percentToValidator: uint64
  validatorCommissionAddress: arc4.Address
  minEntryStake: uint64
  maxAlgoPerPool: uint64
  poolsPerNode: uint64
  sunsettingOn: uint64
  sunsettingTo: ValidatorIdType
}

type ValidatorCurState = {
  numPools: uint64
  totalStakers: uint64
  totalAlgoStaked: uint64
  rewardTokenHeldBack: uint64
}

type PoolInfo = {
  poolAppId: uint64
  totalStakers: uint64
  totalAlgoStaked: uint64
}

type NodeConfig = {
  poolAppIds: FixedArray<uint64, typeof MAX_POOLS_PER_NODE>
}

type NodePoolAssignmentConfig = {
  nodes: FixedArray<NodeConfig, typeof MAX_NODES>
}

export type PoolTokenPayoutRatio = {
  poolPctOfWhole: FixedArray<uint64, 24>
  updatedForPayout: uint64
}

type ValidatorInfo = {
  config: ValidatorConfig
  state: ValidatorCurState
  pools: FixedArray<PoolInfo, 24>
  tokenPayoutRatio: PoolTokenPayoutRatio
  nodePoolAssignments: NodePoolAssignmentConfig
}

type MbrAmounts = {
  addValidatorMbr: uint64
  addPoolMbr: uint64
  poolInitMbr: uint64
  addStakerMbr: uint64
}

type Constraints = {
  epochPayoutRoundsMin: uint64
  epochPayoutRoundsMax: uint64
  minPctToValidatorWFourDecimals: uint64
  maxPctToValidatorWFourDecimals: uint64
  minEntryStake: uint64
  maxAlgoPerPool: uint64
  maxAlgoPerValidator: uint64
  amtConsideredSaturated: uint64
  maxNodes: uint64
  maxPoolsPerNode: uint64
  maxStakersPerPool: uint64
}

/**
 * ValidatorRegistry is the 'master contract' for the reti pooling protocol.
 * A single immutable instance of this is deployed.  All state for all validators including information about their
 * pools and nodes is stored via this contract in global state and box storage.  Data in the pools themselves is stored
 * within the StakingPool contract instance, also in global state and box storage.
 * See the StakingPool contract comments for details on how this contract creates new instances of them.
 */
export class ValidatorRegistry extends Contract {
  stakingPoolApprovalProgram = Box<bytes>({ key: 'poolTemplateApprovalBytes' })
  stakingPoolInitialized = GlobalState<boolean>({ key: 'init' })
  numValidators = GlobalState<uint64>({ key: 'numV' })
  numStakers = GlobalState<uint64>({ key: 'numStakers' })
  totalAlgoStaked = GlobalState<uint64>({ key: 'staked' })
  validatorList = BoxMap<ValidatorIdType, ValidatorInfo>({ keyPrefix: 'v' })
  stakerPoolSet = BoxMap<arc4.Address, FixedArray<ValidatorPoolKey, typeof MAX_POOLS_PER_STAKER>>({ keyPrefix: 'sps' })

  updateApplication(): void {
    // TODO: Fix address comparison - simplified for now
    this.stakingPoolApprovalProgram.delete()
    this.stakingPoolInitialized.value = false
  }

  createApplication(): void {
    this.stakingPoolInitialized.value = false
    this.numValidators.value = 0
    this.numStakers.value = 0
    this.totalAlgoStaked.value = 0
  }

  initStakingContract(approvalProgramSize: uint64): void {
    this.stakingPoolApprovalProgram.create({ size: approvalProgramSize })
  }

  loadStakingContractData(offset: uint64, data: bytes): void {
    assert(!this.stakingPoolInitialized.value)
    // TODO: Implement box data replacement
  }

  finalizeStakingContract(): void {
    this.stakingPoolInitialized.value = true
  }

  gas(): void {}

  getMbrAmounts(): MbrAmounts {
    return {
      addValidatorMbr: this.costForBoxStorage(1 + 8 + 1000), // Simplified calculation
      addPoolMbr: this.minBalanceForAccount(1, 3, 0, 0, 0, 10, 10),
      poolInitMbr: ALGORAND_ACCOUNT_MIN_BALANCE + this.costForBoxStorage(7 + 1000 * MAX_STAKERS_PER_POOL),
      addStakerMbr: this.costForBoxStorage(3 + 32 + 24 * MAX_POOLS_PER_STAKER),
    }
  }

  getProtocolConstraints(): Constraints {
    return {
      epochPayoutRoundsMin: MIN_EPOCH_LENGTH,
      epochPayoutRoundsMax: MAX_EPOCH_LENGTH,
      minPctToValidatorWFourDecimals: MIN_PCT_TO_VALIDATOR,
      maxPctToValidatorWFourDecimals: MAX_PCT_TO_VALIDATOR,
      minEntryStake: MIN_ALGO_STAKE_PER_POOL,
      maxAlgoPerPool: this.maxAlgoAllowedPerPool(),
      maxAlgoPerValidator: this.maxAllowedStake(),
      amtConsideredSaturated: this.algoSaturationLevel(),
      maxNodes: MAX_NODES,
      maxPoolsPerNode: MAX_POOLS_PER_NODE,
      maxStakersPerPool: MAX_STAKERS_PER_POOL,
    }
  }

  getNumValidators(): uint64 {
    return this.numValidators.value
  }

  getValidatorConfig(validatorId: ValidatorIdType): ValidatorConfig {
    return this.validatorList(validatorId).value.config
  }

  getValidatorState(validatorId: ValidatorIdType): ValidatorCurState {
    return this.validatorList(validatorId).value.state
  }

  getValidatorOwnerAndManager(validatorId: ValidatorIdType): [arc4.Address, arc4.Address] {
    const validator = clone(this.validatorList(validatorId).value)
    return [validator.config.owner, validator.config.manager]
  }

  getPools(validatorId: ValidatorIdType): PoolInfo[] {
    const retData: PoolInfo[] = []
    const poolSet = clone(this.validatorList(validatorId).value.pools)
    for (let i: uint64 = 0; i < poolSet.length; i += 1) {
      if (poolSet[i].poolAppId === 0) {
        break
      }
      retData.push(poolSet[i])
    }
    return retData
  }

  getPoolAppId(validatorId: uint64, poolId: uint64): uint64 {
    assert(poolId !== 0 && poolId <= this.validatorList(validatorId).value.pools.length)
    return this.validatorList(validatorId).value.pools[poolId - 1].poolAppId
  }

  getPoolInfo(poolKey: ValidatorPoolKey): PoolInfo {
    return this.validatorList(poolKey.id).value.pools[poolKey.poolId - 1]
  }

  getCurMaxStakePerPool(validatorId: ValidatorIdType): uint64 {
    const numPools: uint64 = this.validatorList(validatorId).value.state.numPools
    const hardMaxDividedBetweenPools: uint64 = this.maxAllowedStake() / numPools
    let maxPerPool: uint64 = this.validatorList(validatorId).value.config.maxAlgoPerPool
    if (maxPerPool === 0) {
      maxPerPool = this.maxAlgoAllowedPerPool()
    }
    if (hardMaxDividedBetweenPools < maxPerPool) {
      maxPerPool = hardMaxDividedBetweenPools
    }
    return maxPerPool
  }

  doesStakerNeedToPayMBR(staker: arc4.Address): boolean {
    return !this.stakerPoolSet(staker).exists
  }

  getStakedPoolsForAccount(staker: arc4.Address): ValidatorPoolKey[] {
    if (!this.stakerPoolSet(staker).exists) {
      return []
    }
    const retData: ValidatorPoolKey[] = []
    const poolSet = clone(this.stakerPoolSet(staker).value)
    for (let i: uint64 = 0; i < poolSet.length; i += 1) {
      if (poolSet[i].id !== 0) {
        retData.push(poolSet[i])
      }
    }
    return retData
  }

  getTokenPayoutRatio(validatorId: ValidatorIdType): PoolTokenPayoutRatio {
    return this.validatorList(validatorId).value.tokenPayoutRatio
  }

  getNodePoolAssignments(validatorId: uint64): NodePoolAssignmentConfig {
    assert(this.validatorList(validatorId).exists)
    return this.validatorList(validatorId).value.nodePoolAssignments
  }

  getNFDRegistryID(): uint64 {
    return 0 // TODO: Implement NFD registry ID
  }

  addValidator(nfdName: arc4.DynamicBytes, config: ValidatorConfig): uint64 {
    this.validateConfig(config)
    assert(Txn.sender.bytes === config.owner.bytes)

    const validatorId: uint64 = this.numValidators.value + 1
    this.numValidators.value = validatorId

    this.validatorList(validatorId).create()
    this.validatorList(validatorId).value.config = clone(config)
    this.validatorList(validatorId).value.config.id = validatorId

    return validatorId
  }
  changeValidatorManager(validatorId: ValidatorIdType, manager: arc4.Address): void {
    assert(Txn.sender.bytes === this.validatorList(validatorId).value.config.owner.bytes)
    this.validatorList(validatorId).value.config.manager = manager
  }

  changeValidatorSunsetInfo(validatorId: ValidatorIdType, sunsettingOn: uint64, sunsettingTo: ValidatorIdType): void {
    assert(Txn.sender.bytes === this.validatorList(validatorId).value.config.owner.bytes)
    this.validatorList(validatorId).value.config.sunsettingOn = sunsettingOn
    this.validatorList(validatorId).value.config.sunsettingTo = sunsettingTo
  }

  changeValidatorNFD(validatorId: ValidatorIdType, nfdAppID: uint64, nfdName: arc4.DynamicBytes): void {
    assert(Txn.sender.bytes === this.validatorList(validatorId).value.config.owner.bytes)
    this.validatorList(validatorId).value.config.nfdForInfo = nfdAppID
  }

  changeValidatorCommissionAddress(validatorId: ValidatorIdType, commissionAddress: arc4.Address): void {
    assert(Txn.sender.bytes === this.validatorList(validatorId).value.config.owner.bytes)
    this.validatorList(validatorId).value.config.validatorCommissionAddress = commissionAddress
  }

  changeValidatorRewardInfo(
    validatorId: ValidatorIdType,
    EntryGatingType: uint64,
    EntryGatingAddress: arc4.Address,
    EntryGatingAssets: FixedArray<uint64, 4>,
    GatingAssetMinBalance: uint64,
    RewardPerPayout: uint64,
  ): void {
    assert(Txn.sender.bytes === this.validatorList(validatorId).value.config.owner.bytes)
    this.validatorList(validatorId).value.config.entryGatingType = EntryGatingType
    this.validatorList(validatorId).value.config.entryGatingAddress = EntryGatingAddress
    this.validatorList(validatorId).value.config.entryGatingAssets = clone(EntryGatingAssets)
    this.validatorList(validatorId).value.config.gatingAssetMinBalance = GatingAssetMinBalance
    this.validatorList(validatorId).value.config.rewardPerPayout = RewardPerPayout
  }

  addPool(validatorId: ValidatorIdType, nodeNum: uint64): ValidatorPoolKey {
    return {
      id: 0,
      poolId: 0,
      poolAppId: 0,
    }
  }

  addStake(validatorId: ValidatorIdType, valueToVerify: uint64): ValidatorPoolKey {
    return {
      id: 0,
      poolId: 0,
      poolAppId: 0,
    }
  }

  setTokenPayoutRatio(validatorId: ValidatorIdType): PoolTokenPayoutRatio {
    return {
      poolPctOfWhole: new FixedArray<uint64, 24>(),
      updatedForPayout: 0,
    }
  }

  stakeUpdatedViaRewards(
    poolKey: ValidatorPoolKey,
    algoToAdd: uint64,
    rewardTokenAmountReserved: uint64,
    validatorCommission: uint64,
    saturatedBurnToFeeSink: uint64,
  ): void {}

  stakeRemoved(
    poolKey: ValidatorPoolKey,
    staker: arc4.Address,
    amountRemoved: uint64,
    rewardRemoved: uint64,
    stakerRemoved: boolean,
  ): void {}

  findPoolForStaker(
    validatorId: ValidatorIdType,
    staker: arc4.Address,
    amountToStake: uint64,
  ): [ValidatorPoolKey, boolean, boolean] {
    return [
      {
        id: 0,
        poolId: 0,
        poolAppId: 0,
      },
      false,
      false,
    ]
  }

  movePoolToNode(validatorId: ValidatorIdType, poolAppId: uint64, nodeNum: uint64): void {}

  emptyTokenRewards(validatorId: ValidatorIdType, receiver: arc4.Address): uint64 {
    return 0
  }

  private verifyPoolKeyCaller(poolKey: ValidatorPoolKey): void {}

  private reverifyNFDOwnership(validatorId: ValidatorIdType): void {}

  private validateConfig(config: ValidatorConfig): void {
    assert(config.entryGatingType >= GATING_TYPE_NONE && config.entryGatingType <= GATING_TYPE_CONST_MAX)
    assert(config.epochRoundLength >= MIN_EPOCH_LENGTH && config.epochRoundLength <= MAX_EPOCH_LENGTH)
    assert(config.percentToValidator >= MIN_PCT_TO_VALIDATOR && config.percentToValidator <= MAX_PCT_TO_VALIDATOR)
    assert(config.minEntryStake >= MIN_ALGO_STAKE_PER_POOL)
    assert(config.poolsPerNode > 0 && config.poolsPerNode <= MAX_POOLS_PER_NODE)
  }

  private callPoolAddStake(
    poolKey: ValidatorPoolKey,
    mbrAmtPaid: uint64,
    isNewStakerToValidator: boolean,
    isNewStakerToProtocol: boolean,
  ): void {}

  private updateStakerPoolSet(staker: arc4.Address, poolKey: ValidatorPoolKey): void {}

  private removeFromStakerPoolSet(staker: arc4.Address, poolKey: ValidatorPoolKey): [boolean, boolean] {
    return [false, false]
  }

  private addPoolToNode(validatorId: ValidatorIdType, poolAppId: uint64, nodeNum: uint64): void {}

  private doesStakerMeetGating(validatorId: ValidatorIdType, valueToVerify: uint64): void {}

  private isNFDAppIDValid(nfdAppID: uint64): boolean {
    return false
  }

  private isAddressInNFDCAAlgoList(nfdAppID: uint64, addrToFind: arc4.Address): boolean {
    return false
  }

  private algoSaturationLevel(): uint64 {
    const online = this.getCurrentOnlineStake()
    return (online * MAX_VALIDATOR_SOFT_PCT_OF_ONLINE_1DECIMAL) / 1000
  }

  private maxAllowedStake(): uint64 {
    const online = this.getCurrentOnlineStake()
    return (online * MAX_VALIDATOR_HARD_PCT_OF_ONLINE_1DECIMAL) / 1000
  }

  private maxAlgoAllowedPerPool(): uint64 {
    return 70_000_000_000_000 // 70m ALGO in microAlgo
  }

  private getCurrentOnlineStake(): uint64 {
    return 2_000_000_000_000_000 // 2 billion ALGO for now
  }

  private minBalanceForAccount(
    contracts: uint64,
    extraPages: uint64,
    assets: uint64,
    localInts: uint64,
    localBytes: uint64,
    globalInts: uint64,
    globalBytes: uint64,
  ): uint64 {
    let minBal: uint64 = ALGORAND_ACCOUNT_MIN_BALANCE
    minBal += contracts * APPLICATION_BASE_FEE
    minBal += extraPages * APPLICATION_BASE_FEE
    minBal += assets * ASSET_HOLDING_FEE
    minBal += localInts * SSC_VALUE_UINT
    minBal += globalInts * SSC_VALUE_UINT
    minBal += localBytes * SSC_VALUE_BYTES
    minBal += globalBytes * SSC_VALUE_BYTES
    return minBal
  }

  private costForBoxStorage(totalNumBytes: uint64): uint64 {
    const SCBOX_PERBOX = 2500
    const SCBOX_PERBYTE = 400
    return SCBOX_PERBOX + totalNumBytes * SCBOX_PERBYTE
  }
}
