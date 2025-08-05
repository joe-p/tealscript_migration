import {
  Box,
  bytes,
  Contract,
  FixedArray,
  Global,
  GlobalState,
  gtxn,
  TemplateVar,
  uint64,
  assert,
  Application,
  assertMatch,
  itxn,
  Txn,
  BigUint,
  ensureBudget,
  clone,
  Bytes,
  op,
  log,
} from '@algorandfoundation/algorand-typescript'
import { ValidatorRegistry } from './validatorRegistry.algo'
import {
  ALGORAND_ACCOUNT_MIN_BALANCE,
  ALGORAND_STAKING_BLOCK_DELAY,
  ASSET_HOLDING_FEE,
  APPROX_AVG_ROUNDS_PER_DAY,
  MAX_STAKERS_PER_POOL,
  MAX_VALIDATOR_SOFT_PCT_OF_ONLINE_1DECIMAL,
  MIN_ALGO_STAKE_PER_POOL,
} from './constants.algo'
import { PoolTokenPayoutRatio, ValidatorPoolKey } from './validatorConfigs.algo'
import {
  abiCall,
  abimethod,
  Address,
  arc4EncodedLength,
  encodeArc4,
  Uint128,
} from '@algorandfoundation/algorand-typescript/arc4'
import { wideRatio } from './utils.algo'

// The data stored 'per-staker' in box storage of each pool
export type StakedInfo = {
  account: Address
  balance: uint64
  totalRewarded: uint64
  rewardTokenBalance: uint64
  entryRound: uint64 // round number of entry (320 added to entry round to accommodate consensus balance delay)
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
  // When created, we track our creating validator contract so that only this contract can call us.  Independent
  // copies of this contract could be created but only the 'official' validator contract would be considered valid
  // and official.  Calls from these pools back to the validator contract are also validated, ensuring the pool
  // calling the validator is one of the pools it created.
  creatingValidatorContractAppId = GlobalState<uint64>({ key: 'creatorApp' })

  // The 'id' of the validator our pool belongs to
  validatorId = GlobalState<uint64>({ key: 'validatorId' })

  // The pool id we were assigned by the validator contract - sequential id per validator
  poolId = GlobalState<uint64>({ key: 'poolId' })

  // number of stakers in THIS pool
  numStakers = GlobalState<uint64>({ key: 'numStakers' })

  // totalAlgoStaked is total amount staked in THIS pool.
  totalAlgoStaked = GlobalState<uint64>({ key: 'staked' })

  minEntryStake = GlobalState<uint64>({ key: 'minEntryStake' })

  // Round number known at time when last epoch payout occurred (internally adjusted to (round-(round%epoch)) for 'bin' comparisons.
  lastPayout = GlobalState<uint64>({ key: 'lastPayout' })

  // Epoch number this staking pool is on, with epoch 1 being the 'first' payout
  epochNumber = GlobalState<uint64>({ key: 'epochNumber' })

  // Version of algod and reti node daemon this pool is connected to - updated automatically by node daemon
  algodVer = GlobalState<bytes>({ key: 'algodVer' })

  // Our 'ledger' of stakers, tracking each staker account and its balance, total rewards, and last entry time
  stakers = Box<FixedArray<StakedInfo, typeof MAX_STAKERS_PER_POOL>>({ key: 'stakers' })

  // --
  // Stake APR calculation values
  roundsPerDay = GlobalState<uint64>({ key: 'roundsPerDay' })

  binRoundStart = GlobalState<uint64>({ key: 'binRoundStart' })

  // stakeAccumulator is the stake adjusted for a 'per day' bin.  It is used to determine a stake added per day (adjusting for
  // stake additions as they occur, but adjusted for time in the day).  The stakeAccumulator and rewardAccumulator together
  // are used to try to calculate a moving average of stake/rewards and APR.
  stakeAccumulator = GlobalState<Uint128>({ key: 'stakeAccumulator' })

  // rewardAccumulator is similar to stakeAccumulator in how it accrues but tracks the rewards as they're determined each
  // epoch.
  rewardAccumulator = GlobalState<uint64>({ key: 'rewardAccumulator' })

  // moving average - calculated based on approximate APR of rewards
  weightedMovingAverage = GlobalState<Uint128>({ key: 'ewma' })

  // ---

  nfdRegistryAppId = TemplateVar<uint64>('NFD_REGISTRY_APP_ID')

  /**
   * Initialize the staking pool w/ owner and manager, but can only be created by the validator contract.
   * @param {uint64} creatingContractId - id of contract that constructed us - the validator application (single global instance)
   * @param {uint64} validatorId - id of validator we're a staking pool of
   * @param {uint64} poolId - which pool id are we
   * @param {uint64} minEntryStake - minimum amount to be in pool, but also minimum amount balance can't go below (without removing all!)
   */
  createApplication(creatingContractId: Application, validatorId: uint64, poolId: uint64, minEntryStake: uint64): void {
    if (creatingContractId === Application(0)) {
      // this is likely initial template setup - everything should basically be zero...
      assert(validatorId === 0)
      assert(poolId === 0)
    } else {
      assert(validatorId !== 0)
      assert(poolId !== 0)
    }
    assert(minEntryStake >= MIN_ALGO_STAKE_PER_POOL, 'staking pool must have minimum entry of 1 algo')
    this.creatingValidatorContractAppId.value = creatingContractId.id
    this.validatorId.value = validatorId
    this.poolId.value = poolId
    this.numStakers.value = 0
    this.totalAlgoStaked.value = 0
    this.minEntryStake.value = minEntryStake
    this.lastPayout.value = Global.round // set to init block to establish baseline
    this.epochNumber.value = 0

    this.setRoundsPerDay()
    this.binRoundStart.value = Global.round - (Global.round % this.roundsPerDay.value) // place at start of bin
    this.stakeAccumulator.value = new Uint128(0)
    this.rewardAccumulator.value = 0
    this.weightedMovingAverage.value = new Uint128(0)
  }

  /**
   * gas is a dummy no-op call that can be used to pool-up resource references and opcode cost
   */
  gas(): void {}

  private costForBoxStorage(totalNumBytes: uint64): uint64 {
    const SCBOX_PERBOX = 2500
    const SCBOX_PERBYTE = 400

    return SCBOX_PERBOX + totalNumBytes * SCBOX_PERBYTE
  }

  /**
   * Called after we're created and then funded, so we can create our large stakers ledger storage
   * Caller has to get MBR amounts from ValidatorRegistry to know how much to fund us to cover the box storage cost
   * If this is pool 1 AND the validator has specified a reward token, opt-in to that token
   * so that the validator can seed the pool with future rewards of that token.
   * @param mbrPayment payment from caller which covers mbr increase of new staking pools' storage
   */
  initStorage(mbrPayment: gtxn.PaymentTxn): void {
    assert(!this.stakers.exists, 'staking pool already initialized')

    // Get the config of our validator to determine if we issue reward tokens
    const validatorConfig = abiCall(ValidatorRegistry.prototype.getValidatorConfig, {
      appId: this.creatingValidatorContractAppId.value,
      args: [this.validatorId.value],
    }).returnValue

    const isTokenEligible = validatorConfig.rewardTokenId !== 0
    const extraMBR = isTokenEligible && this.poolId.value === 1 ? ASSET_HOLDING_FEE : 0
    const PoolInitMbr =
      ALGORAND_ACCOUNT_MIN_BALANCE +
      extraMBR +
      this.costForBoxStorage(7 /* 'stakers' name */ + arc4EncodedLength<StakedInfo>() * MAX_STAKERS_PER_POOL)

    // the pay transaction must exactly match our MBR requirement.
    assertMatch(mbrPayment, { receiver: Global.currentApplicationAddress, amount: PoolInitMbr })
    this.stakers.create()

    if (isTokenEligible && this.poolId.value === 1) {
      // opt ourselves in to the reward token if we're pool 1
      itxn.assetTransfer({
        xferAsset: validatorConfig.rewardTokenId,
        assetReceiver: Global.currentApplicationAddress,
        assetAmount: 0,
      })
    }
  }

  /**
   * Adds stake to the given account.
   * Can ONLY be called by the validator contract that created us
   * Must receive payment from the validator contract for amount being staked.
   *
   * @param {PayTxn} stakedAmountPayment prior payment coming from validator contract to us on behalf of staker.
   * @param {Address} staker - The account adding new stake
   * @throws {Error} - Throws an error if the staking pool is full.
   * @returns {uint64} new 'entry round' round number of stake add
   */
  addStake(stakedAmountPayment: gtxn.PaymentTxn, staker: Address): uint64 {
    assert(this.stakers.exists, 'staking pool must be initialized first')

    // The contract account calling us has to be our creating validator contract
    assert(
      Txn.sender === Application(this.creatingValidatorContractAppId.value).address,
      'stake can only be added via the validator contract',
    )
    assert(staker.native !== Global.zeroAddress)

    // Update APR data
    this.checkIfBinClosed()

    // Verify the payment of stake also came from the validator - as it receives the stake from the staker, holds
    // any MBR (if needed) and then sends the stake on to us in the stakedAmountPayment transaction.
    assertMatch(stakedAmountPayment, {
      sender: Application(this.creatingValidatorContractAppId.value).address,
      receiver: Global.currentApplicationAddress,
      amount: stakedAmountPayment.amount,
    })
    // Stake 'maximums' are handled at the validator level - pre-add - so no checks needed here.

    // See if the account staking is already in our ledger of stakers - if so, they're just adding to their stake
    // track first empty slot as we go along as well.
    const entryRound = Global.round + ALGORAND_STAKING_BLOCK_DELAY
    let firstEmpty = 0

    this.totalAlgoStaked.value += stakedAmountPayment.amount

    const roundsLeftInBin = this.binRoundStart.value + this.roundsPerDay.value - Global.round
    this.stakeAccumulator.value = new Uint128(
      this.stakeAccumulator.value.native + BigUint(stakedAmountPayment.amount) * BigUint(roundsLeftInBin),
    )

    // firstEmpty should represent 1-based index to first empty slot we find - 0 means none were found
    for (let i = 0; i < this.stakers.value.length; i += 1) {
      ensureBudget(300)
      const cmpStaker = clone(this.stakers.value[i])
      if (cmpStaker.account === staker) {
        // We're just adding more stake to their existing stake within a pool
        cmpStaker.balance += stakedAmountPayment.amount
        cmpStaker.entryRound = entryRound

        // Update the box w/ the new data
        this.stakers.value[i] = cmpStaker

        return entryRound
      }
      if (firstEmpty === 0 && cmpStaker.account.native === Global.zeroAddress) {
        firstEmpty = i + 1
      }
    }

    if (firstEmpty === 0) {
      // nothing was found - pool is full and this staker can't fit
      assert(false, 'Staking pool full')
    }
    // This is a new staker to the pool, so first ensure they're adding required minimum, then
    // initialize slot and add to the stakers.
    // our caller will see stakers increase in state and increase in their state as well.
    assert(stakedAmountPayment.amount >= this.minEntryStake.value, 'must stake at least the minimum for this pool')

    assert(this.stakers.value[firstEmpty - 1].account.native === Global.zeroAddress)
    this.stakers.value[firstEmpty - 1] = {
      account: staker,
      balance: stakedAmountPayment.amount,
      totalRewarded: 0,
      rewardTokenBalance: 0,
      entryRound: entryRound,
    }
    this.numStakers.value += 1
    return entryRound
  }

  /**
   * Removes stake on behalf of caller (removing own stake).  If any token rewards exist, those are always sent in
   * full. Also notifies the validator contract for this pools validator of the staker / balance changes.
   *
   * @param {Address} staker - account to remove.  normally same as sender, but the validator owner or manager can also call
   * this to remove the specified staker explicitly. The removed stake MUST only go to the staker of course.  This is
   * so a validator can shut down a poool and refund the stakers.  It can also be used to kick out stakers who no longer
   * meet the gating requirements (determined by the node daemon).
   * @param {uint64} amountToUnstake - The amount of stake to be removed.  Specify 0 to remove all stake.
   * @throws {Error} If the account has insufficient balance or if the account is not found.
   */
  removeStake(staker: Address, amountToUnstake: uint64): void {
    // Staker MUST be the sender
    // UNLESS the sender is owner or manager of validator - then they can have a staker get some (or all) of their stake back
    if (staker.native !== Txn.sender) {
      assert(
        this.isOwnerOrManagerCaller(),
        'If staker is not sender in removeStake call, then sender MUST be owner or manager of validator',
      )
    }
    // Update APR data
    this.checkIfBinClosed()

    for (let i = 0; i < this.stakers.value.length; i += 1) {
      ensureBudget(300)
      const cmpStaker = clone(this.stakers.value[i])
      if (cmpStaker.account === staker) {
        if (amountToUnstake === 0) {
          // specifying 0 for unstake amount is requesting to UNSTAKE ALL
          amountToUnstake = cmpStaker.balance
        }
        if (cmpStaker.balance < amountToUnstake) {
          assert(false, 'Insufficient balance')
        }
        cmpStaker.balance -= amountToUnstake
        this.totalAlgoStaked.value -= amountToUnstake

        let amountRewardTokenRemoved = 0
        if (cmpStaker.rewardTokenBalance > 0) {
          // If and only if this is pool 1 (where the reward token is held - then we can pay it out)
          if (this.poolId.value === 1) {
            const validatorConfig = abiCall(ValidatorRegistry.prototype.getValidatorConfig, {
              appId: this.creatingValidatorContractAppId.value,
              args: [this.validatorId.value],
            }).returnValue

            // ---------
            // SEND THE REWARD TOKEN NOW - it's in our pool
            // ---------
            itxn.assetTransfer({
              xferAsset: validatorConfig.rewardTokenId,
              assetReceiver: staker.native,
              assetAmount: cmpStaker.rewardTokenBalance,
            })
            amountRewardTokenRemoved = cmpStaker.rewardTokenBalance
            cmpStaker.rewardTokenBalance = 0
          } else {
            // If we're in different pool, then we set amountRewardTokenRemoved to amount of reward token to remove
            // but the stakeRemoved call to the validator will see that a pool other than 1 called it, and
            // then issues call to pool 1 to do the token payout via 'payTokenReward' method in our contract
            amountRewardTokenRemoved = cmpStaker.rewardTokenBalance
            cmpStaker.rewardTokenBalance = 0
          }
        }

        // don't let them reduce their balance below the minEntryStake UNLESS they're removing it all!
        assert(
          cmpStaker.balance === 0 || cmpStaker.balance >= this.minEntryStake.value,
          'cannot reduce balance below minimum allowed stake unless all is removed',
        )

        // ---------
        // Pay the staker back
        // ---------
        itxn.payment({
          amount: amountToUnstake,
          receiver: staker.native,
          note: 'unstaked',
        })
        let stakerRemoved = false
        if (cmpStaker.balance === 0) {
          // staker has been 'removed' - zero out record
          this.numStakers.value -= 1
          cmpStaker.account = new Address(Global.zeroAddress)
          cmpStaker.totalRewarded = 0
          cmpStaker.rewardTokenBalance = 0
          stakerRemoved = true
        }
        // Update the box w/ the new staker data
        this.stakers.value[i] = cmpStaker

        const roundsLeftInBin = this.binRoundStart.value + this.roundsPerDay.value - Global.round
        const subtractAmount = BigUint(amountToUnstake * roundsLeftInBin)
        this.stakeAccumulator.value = new Uint128(this.stakeAccumulator.value.native - subtractAmount)

        // Call the validator contract and tell it we're removing stake
        // It'll verify we're a valid staking pool id and update it
        // stakeRemoved(poolKey: ValidatorPoolKey, staker: Address, amountRemoved: uint64, rewardRemoved: uint64, stakerRemoved: boolean): void
        abiCall(ValidatorRegistry.prototype.stakeRemoved, {
          appId: this.creatingValidatorContractAppId.value,
          args: [
            { id: this.validatorId.value, poolId: this.poolId.value, poolAppId: Global.currentApplicationId.id },
            staker,
            amountToUnstake,
            amountRewardTokenRemoved,
            stakerRemoved,
          ],
        })
        return
      }
    }
    assert(false, 'account not found')
  }

  /**
   * Claims all the available reward tokens a staker has available, sending their entire balance to the staker from
   * pool 1 (either directly, or via validator->pool1 to pay it out)
   * Also notifies the validator contract for this pools validator of the staker / balance changes.
   */
  claimTokens(): void {
    // We want to preserve the sanctity that the ONLY account that can call us is the staking account
    // It makes it a bit awkward this way to update the state in the validator, but it's safer
    // account calling us has to be account removing stake
    const staker = Txn.sender

    for (let i = 0; i < this.stakers.value.length; i += 1) {
      ensureBudget(300)
      const cmpStaker = clone(this.stakers.value[i])
      if (cmpStaker.account.native === staker) {
        if (cmpStaker.rewardTokenBalance === 0) {
          return
        }
        let amountRewardTokenRemoved = 0
        // If and only if this is pool 1 (where the reward token is held - then we can pay it out)
        if (this.poolId.value === 1) {
          const validatorConfig = abiCall(ValidatorRegistry.prototype.getValidatorConfig, {
            appId: this.creatingValidatorContractAppId.value,
            args: [this.validatorId.value],
          }).returnValue
          // ---------
          // SEND THE REWARD TOKEN NOW - it's in our pool
          // ---------
          itxn.assetTransfer({
            xferAsset: validatorConfig.rewardTokenId,
            assetReceiver: staker,
            assetAmount: cmpStaker.rewardTokenBalance,
          })
          amountRewardTokenRemoved = cmpStaker.rewardTokenBalance
          cmpStaker.rewardTokenBalance = 0
        } else {
          // If we're in different pool, then we set amountRewardTokenRemoved to amount of reward token to remove
          // but the stakeRemoved call to the validator will see that a pool other than 1 called it, and
          // then issues call to pool 1 to do the token payout via 'payTokenReward' method in our contract
          amountRewardTokenRemoved = cmpStaker.rewardTokenBalance
          cmpStaker.rewardTokenBalance = 0
        }

        // Update the box w/ the new staker balance data (rewardTokenBalance being zeroed)
        this.stakers.value[i] = cmpStaker

        // Call the validator contract and tell it we're removing stake
        // It'll verify we're a valid staking pool id and update it
        // stakeRemoved(poolKey: ValidatorPoolKey, staker: Address, amountRemoved: uint64, rewardRemoved: uint64, stakerRemoved: boolean): void
        abiCall(ValidatorRegistry.prototype.stakeRemoved, {
          appId: this.creatingValidatorContractAppId.value,
          args: [
            { id: this.validatorId.value, poolId: this.poolId.value, poolAppId: Global.currentApplicationId.id },
            new Address(staker),
            0, // no algo removed
            amountRewardTokenRemoved,
            false, // staker isn't being removed.
          ],
        })
        return
      }
    }
    assert(false, 'account not found')
  }

  /**
   * Retrieves the staked information for a given staker.
   *
   * @param {Address} staker - The address of the staker.
   * @returns {StakedInfo} - The staked information for the given staker.
   * @throws {Error} - If the staker's account is not found.
   */
  @abimethod({ readonly: true })
  getStakerInfo(staker: Address): StakedInfo {
    for (let i = 0; i < this.stakers.value.length; i += 1) {
      ensureBudget(200)
      if (this.stakers.value[i].account === staker) {
        return this.stakers.value[i]
      }
    }
    assert(false, 'account not found')
  }

  /**
   * [Internal protocol method] Remove a specified amount of 'community token' rewards for a staker.
   * This can ONLY be called by our validator and only if we're pool 1 - with the token.
   * Note: this can also be called by validator as part of OWNER wanting to send the reward tokens
   * somewhere else (ie if they're sunsetting their validator and need the reward tokens back).
   * It's up to the validator to ensure that the balance in rewardTokenHeldBack is honored.
   * @param staker - the staker account to send rewards to
   * @param rewardToken - id of reward token (to avoid re-entrancy in calling validator back to get id)
   * @param amountToSend - amount to send the staker (there is significant trust here(!) - also why only validator can call us
   */
  payTokenReward(staker: Address, rewardToken: uint64, amountToSend: uint64): void {
    // account calling us has to be our creating validator contract
    assert(
      Txn.sender === Application(this.creatingValidatorContractAppId.value).address,
      'this can only be called via the validator contract',
    )
    assert(this.poolId.value === 1, 'must be pool 1 in order to be called to pay out token rewards')
    assert(rewardToken !== 0, 'can only claim token rewards from validator that has them')

    // Send the reward tokens to the staker
    itxn.assetTransfer({
      xferAsset: rewardToken,
      assetReceiver: staker.native,
      assetAmount: amountToSend,
    })
  }

  /**
   * Update the (honor system) algod version for the node associated to this pool.  The node management daemon
   * should compare its current nodes version to the version stored in global state, updating when different.
   * The reti node daemon composes its own version string using format:
   * {major}.{minor}.{build} {branch} [{commit hash}],
   * ie: 3.22.0 rel/stable [6b508975]
   * [ ONLY OWNER OR MANAGER CAN CALL ]
   * @param {string} algodVer - string representing the algorand node daemon version (reti node daemon composes its own meta version)
   */
  updateAlgodVer(algodVer: string): void {
    assert(this.isOwnerOrManagerCaller(), 'can only be called by owner or manager of validator')
    this.algodVer.value = Bytes(algodVer)
  }

  /**
   * Updates the balance of stakers in the pool based on the received 'rewards' (current balance vs known staked balance)
   * stakers outstanding balance is adjusted based on their % of stake and time in the current epoch - so that balance
   * compounds over time and staker can remove that amount at will.
   * The validator is paid their percentage each epoch payout.
   *
   * Note: ANYONE can call this.
   */
  epochBalanceUpdate(): void {
    // call the validator contract to get our payout config data
    const validatorConfig = abiCall(ValidatorRegistry.prototype.getValidatorConfig, {
      appId: this.creatingValidatorContractAppId.value,
      args: [this.validatorId.value],
    }).returnValue

    // =====
    // Establish base 'epoch' info for future calcs and ensure full Epoch has passed before allowing a new
    // Epoch update to occur.
    // =====
    const epochRoundLength = validatorConfig.epochRoundLength.native
    const curRound = Global.round
    const thisEpochBegin = curRound - (curRound % epochRoundLength)

    // check which epoch we're currently in and if it's outside of last payout epoch.
    const lastPayoutEpoch = this.lastPayout.value - (this.lastPayout.value % epochRoundLength)
    // We've had one payout - so we need to be at least one epoch past the last payout.
    assert(lastPayoutEpoch !== thisEpochBegin, "can't call epochBalanceUpdate in same epoch as prior call")
    // Update APR data
    this.checkIfBinClosed()

    // Update our payout and epoch number - required to match
    this.lastPayout.value = curRound
    this.epochNumber.value += 1

    // Determine Token rewards if applicable
    // =====
    // Do we handle token rewards... ?  if so, we need the app address of pool # 1
    const isTokenEligible = validatorConfig.rewardTokenId !== 0
    let poolOneAppID = Global.currentApplicationId.id
    let poolOneAddress = Global.currentApplicationAddress
    let tokenPayoutRatio: PoolTokenPayoutRatio

    // Call validator to update our token payout ratio (snapshotting % of whole of all pools so token payout can
    // be divided between pools properly)
    if (isTokenEligible) {
      if (this.poolId.value !== 1) {
        // If we're not pool 1 - figure out its address..
        poolOneAppID = abiCall(ValidatorRegistry.prototype.getPoolAppId, {
          appId: this.creatingValidatorContractAppId.value,
          args: [this.validatorId.value, 1],
        }).returnValue

        poolOneAddress = Application(poolOneAppID).address
      }

      // Snapshot the ratio of token stake per pool across the pools so the token rewards across pools
      // can be based on a stable cross-pool ratio.
      if (this.poolId.value === 1) {
        tokenPayoutRatio = abiCall(ValidatorRegistry.prototype.setTokenPayoutRatio, {
          appId: this.creatingValidatorContractAppId.value,
          args: [this.validatorId.value],
        }).returnValue
      } else {
        // This isn't pool 1 - so call pool 1 to then ask IT to call the validator to call setTokenPayoutRatio
        tokenPayoutRatio = abiCall(StakingPool.prototype.proxiedSetTokenPayoutRatio, {
          appId: Application(poolOneAppID),
          args: [{ id: this.validatorId.value, poolId: this.poolId.value, poolAppId: Global.currentApplicationId.id }],
        }).returnValue
      }
    }

    // Get the validator state as well - so we know the total staked for the entire validator, and how much token
    // has been held back
    const validatorState = abiCall(ValidatorRegistry.prototype.getValidatorState, {
      appId: this.creatingValidatorContractAppId.value,
      args: [this.validatorId.value],
    }).returnValue
    const rewardTokenHeldBack = validatorState.rewardTokenHeldBack

    // Determine ALGO rewards if available
    // =====
    // total reward available is current balance - amount staked (so if 100 was staked but balance is 120 - reward is 20)
    // [not counting MBR which should never be counted - it's not payable]
    let algoRewardAvail =
      Global.currentApplicationAddress.balance -
      this.totalAlgoStaked.value -
      Global.currentApplicationAddress.minBalance
    let isPoolSaturated = false
    const algoSaturationAmt = this.algoSaturationLevel()

    // Now verify if our validator has exceeded the saturation level for the 'protocol' (across all pools) - if so,
    // then we want to:
    // 1) not send the validator any rewards
    // 2) send rewards to the stakers, but diminished - just use ratio of amount over the saturation threshold
    // ie: diminishedReward = (algoRewardAvail * algoSaturationLevel [max per validator]) /  totalAlgoStaked [for validator]
    // 3) The excess is sent to the fee sink.
    if (validatorState.totalAlgoStaked > algoSaturationAmt) {
      isPoolSaturated = true
    }

    // if tokens are rewarded by this validator and determine how much we have to hand out
    // we'll track amount we actually assign out and let our validator know, so it can mark that amount
    // as being held back (for tracking what has been assigned for payout)
    let tokenRewardAvail = 0
    let tokenRewardPaidOut = 0
    let validatorCommissionPaidOut = 0
    let excessToFeeSink = 0
    if (isTokenEligible) {
      const tokenRewardBal =
        op.AssetHolding.assetBalance(poolOneAddress, validatorConfig.rewardTokenId)[0] - rewardTokenHeldBack

      // if they have less tokens available then min payout - just ignore and act like no reward is avail
      // leaving tokenRewardAvail as 0
      if (tokenRewardBal >= validatorConfig.rewardPerPayout) {
        // Now - adjust the token rewards to be relative based on this pools stake as % of 'total validator stake'
        // using our prior snapshotted data
        // ignore is because ts thinks tokenPayoutRatio might not be set prior to this call, but it has to be,
        // based on isTokenEligible
        // @ts-expect-error typescript
        const ourPoolPctOfWhole = tokenPayoutRatio.poolPctOfWhole[this.poolId.value - 1]

        // now adjust the total reward to hand out for this pool based on the pools % of the whole
        tokenRewardAvail = wideRatio([validatorConfig.rewardPerPayout, ourPoolPctOfWhole], [1_000_000])
      }
    }
    if (tokenRewardAvail === 0) {
      // no token reward - then algo MUST be paid out as we have to do 'something' !
      // Reward available needs to be at lest 1 algo if an algo reward HAS to be paid out (no token reward)
      // So - we don't ERROR out, but we do exit early.  We still want the 'last payout time and epoch number'
      // to be updated.
      if (algoRewardAvail < 1_000_000) {
        log('!token&&!noalgo to pay')
        return
      }
    }

    if (isPoolSaturated) {
      // see comment where isPoolSaturated is set for changes in rewards...
      // ME-03 [audit]:
      //  make sure reward to stakers isn't more than they would have received normally.
      //  since validator gets nothing and stakers get a reward amount calculated differently we need to make
      //  sure it's always <= reward they would've received had the validator taken their cut.
      const normalValidatorCommission = wideRatio(
        [algoRewardAvail, validatorConfig.percentToValidator.native],
        [1_000_000],
      )
      // diminishedReward = (reward * maxStakePerPool) / stakeForValidator
      let diminishedReward = wideRatio([algoRewardAvail, algoSaturationAmt], [validatorState.totalAlgoStaked])
      // ME-03 [audit] prevents stakers from receiving more reward than would normally be possible
      if (diminishedReward > algoRewardAvail - normalValidatorCommission) {
        diminishedReward = algoRewardAvail - normalValidatorCommission
      }
      // send excess to fee sink...
      excessToFeeSink = algoRewardAvail - diminishedReward
      itxn
        .payment({
          amount: excessToFeeSink,
          receiver: op.Block.blkFeeSink(Txn.firstValid - 1),
          note: 'pool saturated, excess to fee sink',
        })
        .submit()
      // then distribute the smaller reward amount like normal (skipping validator payout entirely)
      algoRewardAvail = diminishedReward
    } else if (validatorConfig.percentToValidator.native !== 0) {
      // determine the % that goes to validator...
      // ie: 100[algo] * 50_000 (5% w/4 decimals) / 1_000_000 == 5 [algo]
      validatorCommissionPaidOut = wideRatio([algoRewardAvail, validatorConfig.percentToValidator.native], [1_000_000])

      // and adjust reward for entire pool accordingly
      algoRewardAvail -= validatorCommissionPaidOut

      // ---
      // pay the validator their cut !
      // if the manager accounts spendable balance is < 1 ALGO then up to 1 ALGO of the reward will be sent
      // there as well to ensure it stays funded.
      // ---
      if (validatorCommissionPaidOut > 0) {
        // Just to make sure the manager account (which triggers the epochBalanceUpdate calls!) doesn't
        // run out of funds - we'll take up to 2.1 ALGO off our commission to keep it running.
        let managerTopOff = 0
        if (
          validatorConfig.manager !== validatorConfig.validatorCommissionAddress &&
          validatorConfig.manager.native.balance - validatorConfig.manager.native.minBalance < 2_100_000
        ) {
          managerTopOff = validatorCommissionPaidOut < 2_100_000 ? validatorCommissionPaidOut : 2_100_000
          itxn.payment({
            amount: managerTopOff,
            receiver: validatorConfig.manager.native,
            note: 'validator reward to manager for funding epoch updates',
          })
        }
        if (validatorCommissionPaidOut - managerTopOff > 0) {
          itxn
            .payment({
              amount: validatorCommissionPaidOut - managerTopOff,
              receiver: validatorConfig.validatorCommissionAddress.native,
              note: 'validator reward',
            })
            .submit()
        }
      }
    }

    // Now we "pay" (but really just update their tracked balance) the stakers the remainder based on their % of
    // pool and time in this epoch.
    // (assuming there is anything to even pay...)

    // We'll track the amount of stake we add to stakers based on payouts
    // If any dust is remaining in account it'll be considered part of reward in next epoch.
    let increasedStake = 0

    /**
     * assume A)lice and B)ob have equal stake... and there is a reward of 100 to divide
     * |------|-------|...
     * A  B
     *        ^ B gets 50% (or 25 of the 50)
     *        at end - we now have 75 'left' - which gets divided across the people at >=100% of epoch time
     *         *        intended result for 100 reward:
     *        if A and B have equal stake... they're each 50% of the 'pool' - call that PP (pool percent)
     *        Time in the epoch - TIE (100% would mean entire epoch - 50% TIE means entered halfway in)
     *        So, we first pay all partials (<100 TIE)
     *        B gets 25....  (100 REWARD * 50 PP (.5) * 50 TIE (.5)) or 25.
     *        -- keep total of stake from each of partial - adding into PartialStake value.
     *        --  we then see that 25 got paid out - so 25 'excess' needs distributed to the 100 TIE stakers on top of their reward.
     *        - reward available is now 75 ALGO to distribute - and PP value is based on percent against new total (TotalStaked-PartialStake)
     *        - so A's PP is now 100% not 50% because their stake is equal to the new reduced stake amount
     *        so A gets 75 (75 REWARD * 100 PP (1) * 100 TIE (1)) or 75
     *        next epoch if nothing else changes - each would get 50% of reward.
     */
    // Iterate all stakers - determine which haven't been for entire epoch - pay them proportionally less for having
    // less time in pool.  We keep track of their stake and then will later reduce the effective 'total staked' amount
    // by that so that the remaining stakers get the remaining reward + excess based on their % of stake against
    // remaining participants.
    if (algoRewardAvail !== 0 || tokenRewardAvail !== 0) {
      let partialStakersTotalStake: uint64 = 0
      const origAlgoReward = algoRewardAvail
      // HI-01 [audit] related fix - using non-changing reward amount for calcing % of total
      const origTokenReward = tokenRewardAvail
      for (let i = 0; i < this.stakers.value.length; i += 1) {
        ensureBudget(400)
        const cmpStaker = clone(this.stakers.value[i])
        if (cmpStaker.account.native !== Global.zeroAddress) {
          if (cmpStaker.entryRound >= thisEpochBegin) {
            // due to 'forward dating' entry time this could be possible
            // in this case it definitely means they get 0%
            partialStakersTotalStake += cmpStaker.balance
          } else {
            // Reward is % of users stake in pool,
            // but we deduct based on time away from our payout time
            const timeInPool = thisEpochBegin - cmpStaker.entryRound
            let timePercentage: uint64
            // get % of time in pool (in tenths precision)
            // ie: 34.7% becomes 347
            if (timeInPool < epochRoundLength) {
              partialStakersTotalStake += cmpStaker.balance
              timePercentage = (timeInPool * 1000) / epochRoundLength

              if (tokenRewardAvail > 0) {
                // calc: (balance * avail reward * percent in tenths) / (total staked * 1000)
                const stakerTokenReward = wideRatio(
                  [cmpStaker.balance, origTokenReward, timePercentage],
                  [this.totalAlgoStaked.value, 1000],
                )

                // reduce the reward available (that we're accounting for) so that the subsequent
                // 'full' pays are based on what's left
                tokenRewardAvail -= stakerTokenReward
                cmpStaker.rewardTokenBalance += stakerTokenReward
                tokenRewardPaidOut += stakerTokenReward
              }
              // calc: (balance * avail reward * percent in tenths) / (total staked * 1000)
              const stakerReward = wideRatio(
                [cmpStaker.balance, origAlgoReward, timePercentage],
                [this.totalAlgoStaked.value, 1000],
              )
              // reduce the reward available (that we're accounting for) so that the subsequent
              // 'full' pays are based on what's left
              algoRewardAvail -= stakerReward
              // instead of sending them algo now - just increase their ledger balance, so they can claim
              // it at any time.
              cmpStaker.balance += stakerReward
              cmpStaker.totalRewarded += stakerReward
              increasedStake += stakerReward
              // Update the box w/ the new data
              this.stakers.value[i] = cmpStaker
            }
          }
        }
      }

      // Reduce the virtual 'total staked in pool' amount based on removing the totals of the stakers we just paid
      // partial amounts.  This is so that all that remains is the stake of the 100% 'time in epoch' people.
      const newPoolTotalStake = this.totalAlgoStaked.value - partialStakersTotalStake

      // It's technically possible for newPoolTotalStake to be 0, if EVERY staker is new then there'll be nothing to
      // hand out this epoch because we'll have reduced the amount to 'count' towards stake by the entire stake
      if (newPoolTotalStake > 0) {
        // Now go back through the list AGAIN and pay out the full-timers their rewards + excess
        for (let i = 0; i < this.stakers.value.length; i += 1) {
          ensureBudget(200)
          const cmpStaker = clone(this.stakers.value[i])
          if (cmpStaker.account.native !== Global.zeroAddress && cmpStaker.entryRound < thisEpochBegin) {
            const timeInPool = thisEpochBegin - cmpStaker.entryRound
            // We're now only paying out people who've been in pool an entire epoch.
            if (timeInPool >= epochRoundLength) {
              // we're in for 100%, so it's just % of stakers balance vs 'new total' for their
              // payment

              // Handle token payouts first - as we don't want to use existing balance, not post algo-reward balance
              if (tokenRewardAvail > 0) {
                const stakerTokenReward = wideRatio([cmpStaker.balance, tokenRewardAvail], [newPoolTotalStake])
                // instead of sending them tokens now - we just update their pending balance
                cmpStaker.rewardTokenBalance += stakerTokenReward
                tokenRewardPaidOut += stakerTokenReward
              }
              if (algoRewardAvail > 0) {
                const stakerReward = wideRatio([cmpStaker.balance, algoRewardAvail], [newPoolTotalStake])
                // instead of sending them algo now - just increase their ledger balance, so they can claim
                // it at any time.
                cmpStaker.balance += stakerReward
                cmpStaker.totalRewarded += stakerReward
                increasedStake += stakerReward
              }

              // Update the box w/ the new data
              this.stakers.value[i] = cmpStaker
            }
          }
        }
      }
    }

    // We've paid out the validator and updated the stakers new balances to reflect the rewards, now update
    // our 'total staked' value as well based on what we paid to validator and updated in staker balances as we
    // determined stake increases
    const roundsLeftInBin = this.binRoundStart.value + this.roundsPerDay.value - Global.round
    this.totalAlgoStaked.value += increasedStake
    this.stakeAccumulator.value = new Uint128(
      this.stakeAccumulator.value.native + BigUint(increasedStake) * BigUint(roundsLeftInBin),
    )
    this.rewardAccumulator.value = this.rewardAccumulator.value + increasedStake

    // Call the validator contract and tell it we've got new stake added
    // It'll verify we're a valid staking pool id and update the various stats, also logging an event to
    // track the data.
    // stakeUpdatedViaRewards(poolKey,algoToAdd,rewardTokenAmountReserved,validatorCommission,saturatedBurnToFeeSink)
    abiCall(ValidatorRegistry.prototype.stakeUpdatedViaRewards, {
      appId: this.creatingValidatorContractAppId.value,
      args: [
        { id: this.validatorId.value, poolId: this.poolId.value, poolAppId: Global.currentApplicationId.id },
        increasedStake,
        tokenRewardPaidOut,
        validatorCommissionPaidOut,
        excessToFeeSink,
      ],
    })
  }

  /**
   * Registers a staking pool key online against a participation key.
   * [ ONLY OWNER OR MANAGER CAN CALL ]
   *
   * @param {PayTxn} feePayment - payment to cover extra fee of going online if offline - or 0 if not renewal
   * @param {bytes} votePK - The vote public key.
   * @param {bytes} selectionPK - The selection public key.
   * @param {bytes} stateProofPK - The state proof public key.
   * @param {uint64} voteFirst - The first vote index.
   * @param {uint64} voteLast - The last vote index.
   * @param {uint64} voteKeyDilution - The vote key dilution value.
   * @throws {Error} Will throw an error if the caller is not the owner or a manager.
   */
  goOnline(
    feePayment: gtxn.PaymentTxn,
    votePK: bytes<32>,
    selectionPK: bytes<32>,
    stateProofPK: bytes<64>,
    voteFirst: uint64,
    voteLast: uint64,
    voteKeyDilution: uint64,
  ): void {
    assert(this.isOwnerOrManagerCaller(), 'can only be called by owner or manager of validator')
    const extraFee = this.getGoOnlineFee()
    assertMatch(feePayment, { receiver: Global.currentApplicationAddress, amount: extraFee })
    itxn
      .keyRegistration({
        voteKey: votePK,
        selectionKey: selectionPK,
        stateProofKey: stateProofPK,
        voteFirst: voteFirst,
        voteLast: voteLast,
        voteKeyDilution: voteKeyDilution,
        fee: extraFee,
      })
      .submit()
  }

  /**
   * Marks a staking pool key OFFLINE.
   * [ ONLY OWNER OR MANAGER CAN CALL ]
   *
   */
  goOffline(): void {
    // we can be called by validator contract if we're being moved (which in turn only is allowed to be called
    // by validator owner or manager), but if not - must be owner or manager
    if (Txn.sender !== Application(this.creatingValidatorContractAppId.value).address) {
      assert(this.isOwnerOrManagerCaller(), 'can only be called by owner or manager of validator')
    }

    itxn.keyRegistration({}).submit()
  }

  // Links the staking pool's account address to an NFD
  // the contract account address must already be set into the NFD's u.cav.algo.a field pending verification
  // [ ONLY OWNER OR MANAGER CAN CALL ]
  linkToNFD(nfdAppId: uint64, nfdName: string): void {
    assert(this.isOwnerOrManagerCaller(), 'can only be called by owner or manager of validator')

    itxn.applicationCall({
      appId: Application(this.nfdRegistryAppId),
      appArgs: ['verify_nfd_addr', nfdName, op.itob(nfdAppId), encodeArc4(Global.currentApplicationAddress)],
      apps: [Application(nfdAppId)],
    })
  }

  /**
   * proxiedSetTokenPayoutRatio is meant to be called by pools != 1 - calling US, pool #1
   * We need to verify that we are in fact being called by another of OUR pools (not us)
   * and then we'll call the validator on their behalf to update the token payouts
   * @param poolKey - ValidatorPoolKey tuple
   */
  proxiedSetTokenPayoutRatio(poolKey: ValidatorPoolKey): PoolTokenPayoutRatio {
    assert(this.validatorId.value === poolKey.id, 'caller must be part of same validator set!')
    assert(this.poolId.value === 1, 'callee must be pool 1')
    assert(poolKey.poolId !== 1, 'caller must NOT be pool 1')

    const callerPoolAppID = abiCall(ValidatorRegistry.prototype.getPoolAppId, {
      appId: this.creatingValidatorContractAppId.value,
      args: [poolKey.id, poolKey.poolId],
    }).returnValue
    assert(callerPoolAppID === poolKey.poolAppId)
    assert(Txn.sender === Application(poolKey.poolAppId).address)

    return abiCall(ValidatorRegistry.prototype.setTokenPayoutRatio, {
      appId: this.creatingValidatorContractAppId.value,
      args: [this.validatorId.value],
    }).returnValue
  }

  private isOwnerOrManagerCaller(): boolean {
    const OwnerAndManager = abiCall(ValidatorRegistry.prototype.getValidatorOwnerAndManager, {
      appId: this.creatingValidatorContractAppId.value,
      args: [this.validatorId.value],
    }).returnValue
    return Txn.sender === OwnerAndManager[0].native || Txn.sender === OwnerAndManager[1].native
  }

  /**
   * Returns the maximum allowed stake per validator based on a percentage of all current online stake before
   * the validator is considered saturated - where rewards are diminished.
   */
  private algoSaturationLevel(): uint64 {
    const online = this.getCurrentOnlineStake()

    return wideRatio([online, MAX_VALIDATOR_SOFT_PCT_OF_ONLINE_1DECIMAL], [1000])
  }

  private getGoOnlineFee(): uint64 {
    // TODO: Add .incentiveEligible to Account
    // this will be needed to determine if our pool is currently NOT eligible and we thus need to pay the fee.
    if (!op.AcctParams.acctIncentiveEligible(Global.currentApplicationAddress)[0]) {
      return Global.payoutsGoOnlineFee
    }
    return 0
  }

  private getCurrentOnlineStake(): uint64 {
    return op.onlineStake()
  }

  /**
   * Checks if the current round is in a 'new calculation bin' (approximately daily)
   */
  private checkIfBinClosed() {
    const currentBinSize = this.roundsPerDay.value
    if (Global.round >= this.binRoundStart.value + currentBinSize) {
      ensureBudget(300)
      const approxRoundsPerYear = BigUint(currentBinSize * 365)
      const avgStake = BigUint(this.stakeAccumulator.value.native / BigUint(currentBinSize))
      if (avgStake !== 0n) {
        // do APR in hundredths (final result), so we multiply by 1,000,000 (*100 for extra precision on low stake)
        // before we divide by avgStake.  We divide by 100 at end so final apr is in hundredths.
        // ie: reward of 100, stake of 1000 - 100/1000 = .1 - *100 = 10% - but w/ int math we can't have
        // decimals, so we do {reward}*10000/{stake} (= 1000, .1, or 10.00%)
        const apr = BigUint(
          (((BigUint(this.rewardAccumulator.value) * 1000000n) / avgStake) *
            (approxRoundsPerYear / BigUint(currentBinSize))) /
            100n,
        ) // scale back down so in hundredths

        let alpha = 10n // .1
        // at 300k algo go to alpha of .9
        if (avgStake > 300000000000n) {
          alpha = 90n // .9
        }
        // If this is first time setting weightedMovingAverage - set to absolute percentage instead
        // of trying to very slowly trend there.
        if (this.weightedMovingAverage.value.native === 0n) {
          this.weightedMovingAverage.value = new Uint128(apr)
        } else {
          this.weightedMovingAverage.value = new Uint128(
            (this.weightedMovingAverage.value.native * (100n - alpha)) / 100n + (apr * alpha) / 100n,
          )
        }
      }

      // Re-calc the avg rounds per day to set new binning numbers
      this.setRoundsPerDay()
      this.stakeAccumulator.value = new Uint128(BigUint(this.totalAlgoStaked.value) * BigUint(this.roundsPerDay.value))
      this.rewardAccumulator.value = 0
      this.binRoundStart.value = Global.round - (Global.round % this.roundsPerDay.value)
    }
  }

  private setRoundsPerDay() {
    // While the average block times could be fetched from prior blocks, it isn't practical as current algorand clients
    // go out of their way to prevent users from even modifying the valid block ranges (particularly to set them 'backwards'
    // which calculating the average block time would require).
    // If implemented, an example implementation might look like:
    if (Txn.firstValid < 12) {
      // must be start of dev/test? - just pick dummy val
      this.roundsPerDay.value = APPROX_AVG_ROUNDS_PER_DAY
      return
    }
    // get average block time - taking time delta between prior 10 blocks [block-11 : block-1]
    const avgBlockTimeTenths = op.Block.blkTimestamp(Txn.firstValid - 1) - op.Block.blkTimestamp(Txn.firstValid - 11)
    if (avgBlockTimeTenths === 0) {
      // if block times are too close together (devmode?), just pick dummy val
      this.roundsPerDay.value = APPROX_AVG_ROUNDS_PER_DAY
      return
    }
    // dividing the diff by 10 would give us avg block time, but because we want block time as integer (with no decimals)
    // we can just take the time as is - thus 25 seconds that would become 2.5 - we leave as '25' - then honoring the
    // decimal later in final calcs.
    this.roundsPerDay.value = (24 * 60 * 60 * 10) / avgBlockTimeTenths
  }
}
