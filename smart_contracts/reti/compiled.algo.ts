import { StakingPool } from './stakingPool.algo'
import { ValidatorRegistry } from './validatorRegistry.algo'
import { compileArc4 } from '@algorandfoundation/algorand-typescript/arc4'

export function stakingPool() {
  return compileArc4(StakingPool)
}
export function registry() {
  return compileArc4(ValidatorRegistry)
}
