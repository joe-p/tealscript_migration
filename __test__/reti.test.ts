/* eslint-disable @typescript-eslint/no-explicit-any */

import { AlgorandClient } from '@algorandfoundation/algokit-utils/types/algorand-client'
import { describe, expect, it } from 'vitest'
import stakingPoolTealScript from './StakingPoolTEALScript.arc56.json'
import validatorRegistryTealScript from './ValidatorRegistryTEALScript.arc56.json'
import stakingPoolPuya from '../smart_contracts/artifacts/reti/StakingPool.arc56.json'
import validatorRegistryPuya from '../smart_contracts/artifacts/reti/ValidatorRegistry.arc56.json'
import { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'
import { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'

async function testBytecodeComparison(
  puyaSpec: Arc56Contract,
  tealScriptSpec: Arc56Contract,
  puyaDeployParams: Record<string, any>,
  tealScriptDeployParams: Record<string, any>,
  contractName: string,
) {
  const algorand = AlgorandClient.defaultLocalNet()
  const defaultSender = await algorand.account.localNetDispenser()

  const puyaClient = new AppClient({
    appId: 0n,
    appSpec: puyaSpec,
    algorand,
    defaultSender,
  })

  const puyaResult = await puyaClient.compile({
    deployTimeParams: puyaDeployParams,
  })

  const tealScriptClient = new AppClient({
    appId: 0n,
    appSpec: tealScriptSpec,
    algorand,
    defaultSender,
  })

  const tealScriptResult = await tealScriptClient.compile({
    deployTimeParams: tealScriptDeployParams,
  })

  const tealscriptSize = tealScriptResult.approvalProgram.length
  const puyaSize = puyaResult.approvalProgram.length

  console.debug(`${contractName} - Puya bytecode size:`, puyaSize)
  console.debug(`${contractName} - TealScript bytecode size:`, tealscriptSize)

  // Print percentage
  console.debug(
    `${contractName} - Puya bytecode is ${((puyaSize / tealscriptSize) * 100).toFixed(2)}% of TealScript bytecode (NOTE: Some TEALScript code has not been converted yet)`,
  )

  expect(puyaSize).toBeLessThanOrEqual(tealscriptSize)
}

describe('StakingPoolClient', () => {
  it('bytecode is smaller or equal to TEALScript', async () => {
    const algorand = AlgorandClient.defaultLocalNet()

    await testBytecodeComparison(
      // @ts-expect-error: JSON import
      stakingPoolPuya,
      stakingPoolTealScript,
      { NFD_REGISTRY_APP_ID: 0, FEE_SINK_ADDR: algorand.account.random().publicKey },
      { nfdRegistryAppId: 0, feeSinkAddr: algorand.account.random().publicKey },
      'StakingPool',
    )
  })
})

describe('ValidatorRegistryClient', () => {
  it('bytecode is smaller or equal to TEALScript', async () => {
    await testBytecodeComparison(
      // @ts-expect-error: JSON import
      validatorRegistryPuya,
      validatorRegistryTealScript,
      { NFD_REGISTRY_APP_ID: 0 },
      { nfdRegistryAppId: 0 },
      'ValidatorRegistry',
    )
  })
})
