import { AlgorandClient } from '@algorandfoundation/algokit-utils/types/algorand-client'
import { StakingPoolClient } from '../smart_contracts/artifacts/reti/StakingPoolClient.ts'
import { describe, expect, it } from 'vitest'
import stakingPoolTealScript from './StakingPoolTEALScript.arc56.json'
import { AppClient } from '@algorandfoundation/algokit-utils/types/app-client'

describe('StakingPoolClient', () => {
  it('bytecode is smaller or equal to TEALScript', async () => {
    const algorand = AlgorandClient.defaultLocalNet()
    const defaultSender = await algorand.account.localNetDispenser()

    const puyaClient = new StakingPoolClient({
      appId: 0n,
      defaultSender,
      algorand,
    }).appClient

    const puyaResult = await puyaClient.compile({
      deployTimeParams: { NFD_REGISTRY_APP_ID: 0, FEE_SINK_ADDR: algorand.account.random().publicKey },
    })

    const tealScriptClient = new AppClient({
      appId: 0n,
      // @ts-expect-error: JSON error
      appSpec: stakingPoolTealScript,
      algorand,
      defaultSender,
    })

    const tealScriptResult = await tealScriptClient.compile({
      deployTimeParams: { nfdRegistryAppId: 0, feeSinkAddr: algorand.account.random().publicKey },
    })

    const tealscriptSize = tealScriptResult.approvalProgram.length
    const puyaSize = puyaResult.approvalProgram.length

    console.debug('Puya bytecode size:', puyaSize)
    console.debug('TealScript bytecode size:', tealscriptSize)

    // Print percetnage
    console.debug(
      `Puya bytecode is ${((puyaSize / tealscriptSize) * 100).toFixed(2)}% of TealScript bytecode (NOTE: Some TEALScript code has not been converted yet)`,
    )

    expect(puyaSize).toBeLessThanOrEqual(tealscriptSize)
  })
})
