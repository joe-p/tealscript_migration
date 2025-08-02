import { uint64, gtxn, Contract } from '@algorandfoundation/algorand-typescript'
import { Address } from '@algorandfoundation/algorand-typescript/arc4'
import {
  ValidatorIdType,
  ValidatorConfig,
  PoolTokenPayoutRatio,
  ValidatorCurState,
  ValidatorPoolKey,
} from './validatorRegistry.algo'

export class StakingPoolABI extends Contract {
  payTokenReward(staker: Address, rewardToken: uint64, amountToSend: uint64): void {}
  goOffline(): void {}
  // @ts-expect-error interface only
  addStake(stakedAmountPayment: gtxn.PaymentTxn, staker: Address): uint64 {}
}

export class ValidatorRegistryABI extends Contract {
  // @ts-expect-error interface only
  getValidatorConfig(validatorId: ValidatorIdType): ValidatorConfig {}
  // @ts-expect-error interface only
  setTokenPayoutRatio(validatorId: ValidatorIdType): PoolTokenPayoutRatio {}
  // @ts-expect-error interface only
  getValidatorState(validatorId: ValidatorIdType): ValidatorCurState {}
  // @ts-expect-error interface only
  getPoolAppId(validatorId: uint64, poolId: uint64): uint64 {}
  stakeRemoved(
    poolKey: ValidatorPoolKey,
    staker: Address,
    amountRemoved: uint64,
    rewardRemoved: uint64,
    stakerRemoved: boolean,
  ): void {}
  stakeUpdatedViaRewards(
    poolKey: ValidatorPoolKey,
    algoToAdd: uint64,
    rewardTokenAmountReserved: uint64,
    validatorCommission: uint64,
    saturatedBurnToFeeSink: uint64,
  ): void {}
  // @ts-expect-error interface only
  getValidatorOwnerAndManager(validatorId: ValidatorIdType): [Address, Address] {}
}
