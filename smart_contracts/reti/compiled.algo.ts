import { uint64, Global } from '@algorandfoundation/algorand-typescript'
import { StakingPool } from './stakingPool.algo'
import { ValidatorRegistry } from './validatorRegistry.algo'
import { compileArc4, Address } from '@algorandfoundation/algorand-typescript/arc4'

export function stakingPool() {
  return compileArc4(StakingPool, {
    templateVars: { NFD_REGISTRY_APP_ID: 0 as uint64, FEE_SINK_ADDR: new Address() },
  })
}
export function registry() {
  return compileArc4(ValidatorRegistry)
}
