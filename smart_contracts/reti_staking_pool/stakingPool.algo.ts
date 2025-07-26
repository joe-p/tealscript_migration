import { Contract, GlobalState, Box, uint64, bytes, FixedArray, arc4 } from '@algorandfoundation/algorand-typescript'

import { MAX_STAKERS_PER_POOL } from '../reti_constants/constants.algo'

export type StakedInfo = {
  account: arc4.Address
  balance: uint64
  totalRewarded: uint64
  rewardTokenBalance: uint64
  entryRound: uint64
}

export type ValidatorPoolKey = {
  id: uint64
  poolId: uint64
  poolAppId: uint64
}

export type PoolTokenPayoutRatio = {
  poolPctOfWhole: FixedArray<uint64, 24>
  updatedForPayout: uint64
}

/**
 * StakingPool contract has a new instance deployed per staking pool added by any validator.  A single instance
 * is initially immutably deployed, and the id of that instance is used as a construction parameter in the immutable
 * instance of the master ValidatorRegistry contract.  It then uses that StakingPool instance as a 'factory template'
 * for subsequent pool creations - using the on-chain bytecode of that deployed instance to create a new identical
 * instance.
 *
 * Each instance is explicitly 'linked' to the validator master via its creation parameters.  The validator master
 * contract only allows calls from staking pool contract instances that match data that only the validator master
 * authoritatively has (validator id X, pool Y - has to come from contract address of that pool).  Calls the pools
 * validate coming from the validator are only allowed if it matches the validator id it was created with.
 */
export class StakingPool extends Contract {
  creatingValidatorContractAppId = GlobalState<uint64>({ key: 'creatorApp' })
  validatorId = GlobalState<uint64>({ key: 'validatorId' })
  poolId = GlobalState<uint64>({ key: 'poolId' })
  numStakers = GlobalState<uint64>({ key: 'numStakers' })
  totalAlgoStaked = GlobalState<uint64>({ key: 'staked' })
  minEntryStake = GlobalState<uint64>({ key: 'minEntryStake' })
  lastPayout = GlobalState<uint64>({ key: 'lastPayout' })
  epochNumber = GlobalState<uint64>({ key: 'epochNumber' })
  algodVer = GlobalState<bytes>({ key: 'algodVer' })
  stakers = Box<FixedArray<StakedInfo, typeof MAX_STAKERS_PER_POOL>>({ key: 'stakers' })
  roundsPerDay = GlobalState<uint64>({ key: 'roundsPerDay' })
  binRoundStart = GlobalState<uint64>({ key: 'binRoundStart' })
  stakeAccumulator = GlobalState<arc4.Uint<128>>({ key: 'stakeAccumulator' })
  rewardAccumulator = GlobalState<uint64>({ key: 'rewardAccumulator' })
  weightedMovingAverage = GlobalState<arc4.Uint<128>>({ key: 'ewma' })

  updateApplication(): void {}

  createApplication(creatingContractId: uint64, validatorId: uint64, poolId: uint64, minEntryStake: uint64): void {}

  gas(): void {}

  initStorage(): void {}

  addStake(staker: arc4.Address): uint64 {
    return 0
  }

  removeStake(staker: arc4.Address, amountToUnstake: uint64): void {}

  claimTokens(): void {}

  getStakerInfo(staker: arc4.Address): StakedInfo {
    return {
      account: new arc4.Address(),
      balance: 0,
      totalRewarded: 0,
      rewardTokenBalance: 0,
      entryRound: 0,
    }
  }

  payTokenReward(staker: arc4.Address, rewardToken: uint64, amountToSend: uint64): void {}

  updateAlgodVer(algodVer: arc4.DynamicBytes): void {}

  epochBalanceUpdate(): void {}

  goOnline(
    votePK: bytes,
    selectionPK: bytes,
    stateProofPK: bytes,
    voteFirst: uint64,
    voteLast: uint64,
    voteKeyDilution: uint64,
  ): void {}

  goOffline(): void {}

  linkToNFD(nfdAppId: uint64, nfdName: arc4.DynamicBytes): void {}

  proxiedSetTokenPayoutRatio(poolKey: ValidatorPoolKey): PoolTokenPayoutRatio {
    return {
      poolPctOfWhole: new FixedArray<uint64, 24>(),
      updatedForPayout: 0,
    }
  }

  private isOwnerOrManagerCaller(): boolean {
    return false
  }

  private getFeeSink(): arc4.Address {
    return new arc4.Address()
  }

  private algoSaturationLevel(): uint64 {
    return 0
  }

  private getGoOnlineFee(): uint64 {
    return 0
  }

  private getCurrentOnlineStake(): uint64 {
    return 0
  }

  private checkIfBinClosed(): void {}

  private setRoundsPerDay(): void {}

  private costForBoxStorage(totalNumBytes: uint64): uint64 {
    return 0
  }
}
