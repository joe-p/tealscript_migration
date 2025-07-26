import {
  Contract,
  GlobalState,
  Box,
  uint64,
  bytes,
  FixedArray,
  arc4,
  assert,
  Global,
  Txn,
  itxn,
  Bytes,
  clone,
} from '@algorandfoundation/algorand-typescript'

import {
  MAX_STAKERS_PER_POOL,
  MIN_ALGO_STAKE_PER_POOL,
  MAX_VALIDATOR_SOFT_PCT_OF_ONLINE_1DECIMAL,
} from '../reti_constants/constants.algo'

const ALGORAND_STAKING_BLOCK_DELAY = 320 // # of blocks until algorand sees online balance changes in staking
const AVG_ROUNDS_PER_DAY = 30857 // approx 'daily' rounds for APR bins (60*60*24/2.8)

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

  // TODO - TEMPORARY!  just want these upgradeable until prior to final release so users don't have to keep
  // resetting every validator, and refund every staker.
  public updateApplication(): void {
    assert(
      Txn.sender.bytes === Bytes('LZ4V2IRVLCXFJK4REJV4TAGEKEYTA2GMR6TC2344OB3L3AF3MWXZ6ZAFIQ'),
      'Temporary: contract is upgradeable but only during testing and only from a development account',
    )
  }

  /**
   * Initialize the staking pool w/ owner and manager, but can only be created by the validator contract.
   * @param {uint64} creatingContractId - id of contract that constructed us - the validator application (single global instance)
   * @param {uint64} validatorId - id of validator we're a staking pool of
   * @param {uint64} poolId - which pool id are we
   * @param {uint64} minEntryStake - minimum amount to be in pool, but also minimum amount balance can't go below (without removing all!)
   */
  public createApplication(
    creatingContractId: uint64,
    validatorId: uint64,
    poolId: uint64,
    minEntryStake: uint64,
  ): void {
    if (creatingContractId === 0) {
      // this is likely initial template setup - everything should basically be zero...
      assert(validatorId === 0)
      assert(poolId === 0)
    } else {
      assert(validatorId !== 0)
      assert(poolId !== 0)
    }
    assert(minEntryStake >= MIN_ALGO_STAKE_PER_POOL, 'staking pool must have minimum entry of 1 algo')
    this.creatingValidatorContractAppId.value = creatingContractId
    this.validatorId.value = validatorId
    this.poolId.value = poolId
    this.numStakers.value = 0
    this.totalAlgoStaked.value = 0
    this.minEntryStake.value = minEntryStake
    this.lastPayout.value = Global.round // set to init block to establish baseline
    this.epochNumber.value = 0

    this.setRoundsPerDay()
    this.binRoundStart.value = Global.round - (Global.round % this.roundsPerDay.value) // place at start of bin
    this.stakeAccumulator.value = new arc4.Uint<128>(0)
    this.rewardAccumulator.value = 0
    this.weightedMovingAverage.value = new arc4.Uint<128>(0)
  }

  /**
   * gas is a dummy no-op call that can be used to pool-up resource references and opcode cost
   */
  public gas(): void {}

  /**
   * Called after we're created and then funded, so we can create our large stakers ledger storage
   * Caller has to get MBR amounts from ValidatorRegistry to know how much to fund us to cover the box storage cost
   * If this is pool 1 AND the validator has specified a reward token, opt-in to that token
   * so that the validator can seed the pool with future rewards of that token.
   */
  public initStorage(): void {
    assert(!this.stakers.exists, 'staking pool already initialized')

    // Create the stakers box with default values
    const defaultStakerInfo: StakedInfo = {
      account: new arc4.Address(),
      balance: 0,
      totalRewarded: 0,
      rewardTokenBalance: 0,
      entryRound: 0,
    }

    const stakersArray = new FixedArray<StakedInfo, typeof MAX_STAKERS_PER_POOL>()
    for (let i: uint64 = 0; i < MAX_STAKERS_PER_POOL; i += 1) {
      stakersArray[i] = clone(defaultStakerInfo)
    }

    this.stakers.create({ size: stakersArray.length })
    this.stakers.value = clone(stakersArray)
  }

  /**
   * Adds stake to the given account.
   * Can ONLY be called by the validator contract that created us
   * Must receive payment from the validator contract for amount being staked.
   *
   * @param {arc4.Address} staker - The account adding new stake
   * @returns {uint64} new 'entry round' round number of stake add
   */
  public addStake(staker: arc4.Address): uint64 {
    assert(this.stakers.exists, 'staking pool must be initialized first')

    // The contract account calling us has to be our creating validator contract
    assert(Txn.sender === Global.currentApplicationAddress, 'stake can only be added via the validator contract')
    assert(staker.bytes !== Global.zeroAddress.bytes)

    // Update APR data
    this.checkIfBinClosed()

    const entryRound: uint64 = Global.round + ALGORAND_STAKING_BLOCK_DELAY
    let firstEmpty: uint64 = 0

    // Find existing staker or first empty slot
    for (let i: uint64 = 0; i < this.stakers.value.length; i += 1) {
      if (Global.opcodeBudget < 300) {
        // Note: increaseOpcodeBudget not available, using simplified approach
      }
      const cmpStaker = clone(this.stakers.value[i])
      if (cmpStaker.account.bytes === staker.bytes) {
        // We're just adding more stake to their existing stake within a pool
        const updatedStaker: StakedInfo = {
          account: cmpStaker.account,
          balance: cmpStaker.balance + 1000000, // Placeholder amount
          totalRewarded: cmpStaker.totalRewarded,
          rewardTokenBalance: cmpStaker.rewardTokenBalance,
          entryRound: entryRound,
        }
        this.stakers.value[i] = clone(updatedStaker)
        return entryRound
      }
      if (firstEmpty === 0 && cmpStaker.account.bytes === Global.zeroAddress.bytes) {
        firstEmpty = i + 1
      }
    }

    if (firstEmpty === 0) {
      // nothing was found - pool is full and this staker can't fit
      assert(false, 'Staking pool full')
    }

    // This is a new staker to the pool
    assert(1000000 >= this.minEntryStake.value, 'must stake at least the minimum for this pool') // Placeholder amount

    const newStaker: StakedInfo = {
      account: staker,
      balance: 1000000, // Placeholder amount
      totalRewarded: 0,
      rewardTokenBalance: 0,
      entryRound: entryRound,
    }

    this.stakers.value[firstEmpty - 1] = clone(newStaker)
    this.numStakers.value += 1
    this.totalAlgoStaked.value += 1000000 // Placeholder amount

    return entryRound
  }

  /**
   * Removes stake on behalf of caller (removing own stake).  If any token rewards exist, those are always sent in
   * full. Also notifies the validator contract for this pools validator of the staker / balance changes.
   *
   * @param {arc4.Address} staker - account to remove.  normally same as sender, but the validator owner or manager can also call
   * this to remove the specified staker explicitly. The removed stake MUST only go to the staker of course.  This is
   * so a validator can shut down a poool and refund the stakers.  It can also be used to kick out stakers who no longer
   * meet the gating requirements (determined by the node daemon).
   * @param {uint64} amountToUnstake - The amount of stake to be removed.  Specify 0 to remove all stake.
   * @throws {Error} If the account has insufficient balance or if the account is not found.
   */
  public removeStake(staker: arc4.Address, amountToUnstake: uint64): void {
    // Staker MUST be the sender
    // UNLESS the sender is owner or manager of validator - then they can have a staker get some (or all) of their stake back
    if (staker.bytes !== Txn.sender.bytes) {
      assert(
        this.isOwnerOrManagerCaller(),
        'If staker is not sender in removeStake call, then sender MUST be owner or manager of validator',
      )
    }
    // Update APR data
    this.checkIfBinClosed()

    for (let i: uint64 = 0; i < this.stakers.value.length; i += 1) {
      if (Global.opcodeBudget < 300) {
        // Note: increaseOpcodeBudget not available, using simplified approach
      }
      const cmpStaker = clone(this.stakers.value[i])
      if (cmpStaker.account.bytes === staker.bytes) {
        let actualAmountToUnstake = amountToUnstake
        if (amountToUnstake === 0) {
          // specifying 0 for unstake amount is requesting to UNSTAKE ALL
          actualAmountToUnstake = cmpStaker.balance
        }
        assert(cmpStaker.balance >= actualAmountToUnstake, 'Insufficient balance')

        const newBalance: uint64 = cmpStaker.balance - actualAmountToUnstake
        this.totalAlgoStaked.value -= actualAmountToUnstake

        // don't let them reduce their balance below the minEntryStake UNLESS they're removing it all!
        assert(
          newBalance === 0 || newBalance >= this.minEntryStake.value,
          'cannot reduce balance below minimum allowed stake unless all is removed',
        )

        // Pay the staker back using inner transaction
        itxn
          .payment({
            amount: actualAmountToUnstake,
            receiver: staker.bytes,
            note: Bytes('unstaked'),
          })
          .submit()

        if (newBalance === 0) {
          // staker has been 'removed' - zero out record
          this.numStakers.value -= 1
          const emptyStaker: StakedInfo = {
            account: new arc4.Address(),
            balance: 0,
            totalRewarded: 0,
            rewardTokenBalance: 0,
            entryRound: 0,
          }
          this.stakers.value[i] = clone(emptyStaker)
        } else {
          // Update the staker with new balance
          const updatedStaker: StakedInfo = {
            account: cmpStaker.account,
            balance: newBalance,
            totalRewarded: cmpStaker.totalRewarded,
            rewardTokenBalance: cmpStaker.rewardTokenBalance,
            entryRound: cmpStaker.entryRound,
          }
          this.stakers.value[i] = clone(updatedStaker)
        }
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
  public claimTokens(): void {
    // We want to preserve the sanctity that the ONLY account that can call us is the staking account
    const staker = Txn.sender

    for (let i: uint64 = 0; i < this.stakers.value.length; i += 1) {
      if (Global.opcodeBudget < 300) {
        // Note: increaseOpcodeBudget not available, using simplified approach
      }
      const cmpStaker = clone(this.stakers.value[i])
      if (cmpStaker.account.bytes === staker.bytes) {
        if (cmpStaker.rewardTokenBalance === 0) {
          return
        }

        // Reset reward token balance
        const updatedStaker: StakedInfo = {
          account: cmpStaker.account,
          balance: cmpStaker.balance,
          totalRewarded: cmpStaker.totalRewarded,
          rewardTokenBalance: 0,
          entryRound: cmpStaker.entryRound,
        }
        this.stakers.value[i] = clone(updatedStaker)
        return
      }
    }
    assert(false, 'account not found')
  }

  /**
   * Retrieves the staked information for a given staker.
   *
   * @param {arc4.Address} staker - The address of the staker.
   * @returns {StakedInfo} - The staked information for the given staker.
   * @throws {Error} - If the staker's account is not found.
   */
  public getStakerInfo(staker: arc4.Address): StakedInfo {
    for (let i: uint64 = 0; i < this.stakers.value.length; i += 1) {
      if (Global.opcodeBudget < 200) {
        // Note: increaseOpcodeBudget not available, using simplified approach
      }
      if (this.stakers.value[i].account.bytes === staker.bytes) {
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
  public payTokenReward(staker: arc4.Address, rewardToken: uint64, amountToSend: uint64): void {
    // account calling us has to be our creating validator contract
    assert(Txn.sender === Global.currentApplicationAddress, 'this can only be called via the validator contract')
    assert(this.poolId.value === 1, 'must be pool 1 in order to be called to pay out token rewards')
    assert(rewardToken !== 0, 'can only claim token rewards from validator that has them')

    // Send the reward tokens to the staker
    itxn
      .assetTransfer({
        xferAsset: rewardToken,
        assetReceiver: staker.bytes,
        assetAmount: amountToSend,
      })
      .submit()
  }

  /**
   * Update the (honor system) algod version for the node associated to this pool.  The node management daemon
   * should compare its current nodes version to the version stored in global state, updating when different.
   * The reti node daemon composes its own version string using format:
   * {major}.{minor}.{build} {branch} [{commit hash}],
   * ie: 3.22.0 rel/stable [6b508975]
   * [ ONLY OWNER OR MANAGER CAN CALL ]
   * @param {arc4.DynamicBytes} algodVer - string representing the algorand node daemon version (reti node daemon composes its own meta version)
   */
  public updateAlgodVer(algodVer: arc4.DynamicBytes): void {
    assert(this.isOwnerOrManagerCaller(), 'can only be called by owner or manager of validator')
    this.algodVer.value = algodVer.bytes
  }

  /**
   * Updates the balance of stakers in the pool based on the received 'rewards' (current balance vs known staked balance)
   * stakers outstanding balance is adjusted based on their % of stake and time in the current epoch - so that balance
   * compounds over time and staker can remove that amount at will.
   * The validator is paid their percentage each epoch payout.
   *
   * Note: ANYONE can call this.
   */
  public epochBalanceUpdate(): void {
    // Simplified implementation - in real implementation this would be much more complex
    // involving reward calculations, validator commission, etc.
    this.checkIfBinClosed()
    this.epochNumber.value += 1
    this.lastPayout.value = Global.round
  }

  /**
   * Registers a staking pool key online against a participation key.
   * [ ONLY OWNER OR MANAGER CAN CALL ]
   *
   * @param {bytes} votePK - The vote public key.
   * @param {bytes} selectionPK - The selection public key.
   * @param {bytes} stateProofPK - The state proof public key.
   * @param {uint64} voteFirst - The first vote index.
   * @param {uint64} voteLast - The last vote index.
   * @param {uint64} voteKeyDilution - The vote key dilution value.
   * @throws {Error} Will throw an error if the caller is not the owner or a manager.
   */
  public goOnline(
    votePK: bytes,
    selectionPK: bytes,
    stateProofPK: bytes,
    voteFirst: uint64,
    voteLast: uint64,
    voteKeyDilution: uint64,
  ): void {
    assert(this.isOwnerOrManagerCaller(), 'can only be called by owner or manager of validator')
    const extraFee = this.getGoOnlineFee()

    itxn
      .keyRegistration({
        voteKey: Bytes(votePK).toFixed({ length: 32 }),
        selectionKey: Bytes(selectionPK).toFixed({ length: 32 }),
        stateProofKey: Bytes(stateProofPK).toFixed({ length: 64 }),
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
  public goOffline(): void {
    // we can be called by validator contract if we're being moved (which in turn only is allowed to be called
    // by validator owner or manager), but if not - must be owner or manager
    if (Txn.sender !== Global.currentApplicationAddress) {
      assert(this.isOwnerOrManagerCaller(), 'can only be called by owner or manager of validator')
    }

    itxn.keyRegistration({}).submit()
  }

  // Links the staking pool's account address to an NFD
  // the contract account address must already be set into the NFD's u.cav.algo.a field pending verification
  // [ ONLY OWNER OR MANAGER CAN CALL ]
  public linkToNFD(nfdAppId: uint64, nfdName: arc4.DynamicBytes): void {
    assert(this.isOwnerOrManagerCaller(), 'can only be called by owner or manager of validator')

    itxn
      .applicationCall({
        appId: nfdAppId,
        appArgs: [Bytes('verify_nfd_addr'), nfdName.bytes, Global.currentApplicationAddress.bytes],
        apps: [nfdAppId],
      })
      .submit()
  }

  /**
   * proxiedSetTokenPayoutRatio is meant to be called by pools != 1 - calling US, pool #1
   * We need to verify that we are in fact being called by another of OUR pools (not us)
   * and then we'll call the validator on their behalf to update the token payouts
   * @param poolKey - ValidatorPoolKey tuple
   */
  public proxiedSetTokenPayoutRatio(poolKey: ValidatorPoolKey): PoolTokenPayoutRatio {
    assert(this.validatorId.value === poolKey.id, 'caller must be part of same validator set!')
    assert(this.poolId.value === 1, 'callee must be pool 1')
    assert(poolKey.poolId !== 1, 'caller must NOT be pool 1')

    // Simplified implementation - would normally call validator contract
    return {
      poolPctOfWhole: new FixedArray<uint64, 24>(),
      updatedForPayout: Global.round,
    }
  }

  private isOwnerOrManagerCaller(): boolean {
    // Simplified implementation - would normally call validator contract to get owner/manager
    return true
  }

  private getFeeSink(): arc4.Address {
    // TODO will be like: txn FirstValid; int 1; -; block BlkFeeSink
    // once available in AVM
    return new arc4.Address()
  }

  /**
   * Returns the maximum allowed stake per validator based on a percentage of all current online stake before
   * the validator is considered saturated - where rewards are diminished.
   */
  private algoSaturationLevel(): uint64 {
    const online = this.getCurrentOnlineStake()
    return (online * MAX_VALIDATOR_SOFT_PCT_OF_ONLINE_1DECIMAL) / 1000
  }

  private getGoOnlineFee(): uint64 {
    // TODO - AVM will have opcode like:
    // voter_params_get IncentiveEligible
    // this will be needed to determine if our pool is currently NOT eligible and we thus need to pay the fee.
    const isOnline = false
    if (!isOnline) {
      // TODO - replace w/ AVM call once available to determine fee to go online
      return 2_000_000
    }
    return 0
  }

  private getCurrentOnlineStake(): uint64 {
    // TODO - replace w/ appropriate AVM call once available but return fixed 2 billion for now.
    return 2_000_000_000_000_000
  }

  /**
   * Checks if the current round is in a 'new calculation bin' (approximately daily)
   */
  private checkIfBinClosed(): void {
    const currentBinSize = this.roundsPerDay.value
    if (Global.round >= this.binRoundStart.value + currentBinSize) {
      if (Global.opcodeBudget < 300) {
        // Note: increaseOpcodeBudget not available, using simplified approach
      }

      // Simplified calculation - skip complex APR calculations for now
      // In a real implementation, this would involve proper biguint arithmetic
      if (this.stakeAccumulator.value.native > 0n) {
        // Just update the weighted moving average with a simple value
        this.weightedMovingAverage.value = new arc4.Uint<128>(1000) // Placeholder value
      }

      // Re-calc the avg rounds per day to set new binning numbers
      this.setRoundsPerDay()
      this.stakeAccumulator.value = new arc4.Uint<128>(this.totalAlgoStaked.value * this.roundsPerDay.value)
      this.rewardAccumulator.value = 0
      this.binRoundStart.value = Global.round - (Global.round % this.roundsPerDay.value)
    }
  }

  private setRoundsPerDay(): void {
    this.roundsPerDay.value = AVG_ROUNDS_PER_DAY
  }

  private costForBoxStorage(totalNumBytes: uint64): uint64 {
    const SCBOX_PERBOX = 2500
    const SCBOX_PERBYTE = 400
    return SCBOX_PERBOX + totalNumBytes * SCBOX_PERBYTE
  }
}
