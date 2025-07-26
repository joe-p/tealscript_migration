import {
  Contract,
  GlobalState,
  Box,
  BoxMap,
  uint64,
  bytes,
  FixedArray,
  arc4,
} from '@algorandfoundation/algorand-typescript'

import { MAX_STAKERS_PER_POOL } from '../reti_constants/constants.algo'

const MAX_NODES = 8
const MAX_POOLS_PER_NODE = 3
const MAX_POOLS_PER_STAKER = 6

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

  updateApplication(): void {}

  createApplication(): void {}

  initStakingContract(approvalProgramSize: uint64): void {}

  loadStakingContractData(offset: uint64, data: bytes): void {}

  finalizeStakingContract(): void {}

  gas(): void {}

  getMbrAmounts(): MbrAmounts {
    return {
      addValidatorMbr: 0,
      addPoolMbr: 0,
      poolInitMbr: 0,
      addStakerMbr: 0,
    }
  }

  getProtocolConstraints(): Constraints {
    return {
      epochPayoutRoundsMin: 0,
      epochPayoutRoundsMax: 0,
      minPctToValidatorWFourDecimals: 0,
      maxPctToValidatorWFourDecimals: 0,
      minEntryStake: 0,
      maxAlgoPerPool: 0,
      maxAlgoPerValidator: 0,
      amtConsideredSaturated: 0,
      maxNodes: 0,
      maxPoolsPerNode: 0,
      maxStakersPerPool: 0,
    }
  }

  getNumValidators(): uint64 {
    return 0
  }

  getValidatorConfig(validatorId: ValidatorIdType): ValidatorConfig {
    return {
      id: 0,
      owner: new arc4.Address(),
      manager: new arc4.Address(),
      nfdForInfo: 0,
      entryGatingType: 0,
      entryGatingAddress: new arc4.Address(),
      entryGatingAssets: new FixedArray<uint64, 4>(),
      gatingAssetMinBalance: 0,
      rewardTokenId: 0,
      rewardPerPayout: 0,
      epochRoundLength: 0,
      percentToValidator: 0,
      validatorCommissionAddress: new arc4.Address(),
      minEntryStake: 0,
      maxAlgoPerPool: 0,
      poolsPerNode: 0,
      sunsettingOn: 0,
      sunsettingTo: 0,
    }
  }

  getValidatorState(validatorId: ValidatorIdType): ValidatorCurState {
    return {
      numPools: 0,
      totalStakers: 0,
      totalAlgoStaked: 0,
      rewardTokenHeldBack: 0,
    }
  }

  getValidatorOwnerAndManager(validatorId: ValidatorIdType): [arc4.Address, arc4.Address] {
    return [new arc4.Address(), new arc4.Address()]
  }

  getPools(validatorId: ValidatorIdType): PoolInfo[] {
    return []
  }

  getPoolAppId(validatorId: uint64, poolId: uint64): uint64 {
    return 0
  }

  getPoolInfo(poolKey: ValidatorPoolKey): PoolInfo {
    return {
      poolAppId: 0,
      totalStakers: 0,
      totalAlgoStaked: 0,
    }
  }

  getCurMaxStakePerPool(validatorId: ValidatorIdType): uint64 {
    return 0
  }

  doesStakerNeedToPayMBR(staker: arc4.Address): boolean {
    return false
  }

  getStakedPoolsForAccount(staker: arc4.Address): ValidatorPoolKey[] {
    return []
  }

  getTokenPayoutRatio(validatorId: ValidatorIdType): PoolTokenPayoutRatio {
    return {
      poolPctOfWhole: new FixedArray<uint64, 24>(),
      updatedForPayout: 0,
    }
  }

  getNodePoolAssignments(validatorId: uint64): NodePoolAssignmentConfig {
    return {
      nodes: new FixedArray<NodeConfig, typeof MAX_NODES>(),
    }
  }

  getNFDRegistryID(): uint64 {
    return 0
  }

  addValidator(nfdName: arc4.DynamicBytes, config: ValidatorConfig): uint64 {
    return 0
  }

  changeValidatorManager(validatorId: ValidatorIdType, manager: arc4.Address): void {}

  changeValidatorSunsetInfo(validatorId: ValidatorIdType, sunsettingOn: uint64, sunsettingTo: ValidatorIdType): void {}

  changeValidatorNFD(validatorId: ValidatorIdType, nfdAppID: uint64, nfdName: arc4.DynamicBytes): void {}

  changeValidatorCommissionAddress(validatorId: ValidatorIdType, commissionAddress: arc4.Address): void {}

  changeValidatorRewardInfo(
    validatorId: ValidatorIdType,
    EntryGatingType: uint64,
    EntryGatingAddress: arc4.Address,
    EntryGatingAssets: FixedArray<uint64, 4>,
    GatingAssetMinBalance: uint64,
    RewardPerPayout: uint64,
  ): void {}

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

  private validateConfig(config: ValidatorConfig): void {}

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
    return 0
  }

  private maxAllowedStake(): uint64 {
    return 0
  }

  private maxAlgoAllowedPerPool(): uint64 {
    return 0
  }

  private getCurrentOnlineStake(): uint64 {
    return 0
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
    return 0
  }

  private costForBoxStorage(totalNumBytes: uint64): uint64 {
    return 0
  }
}
