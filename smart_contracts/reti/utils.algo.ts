import { uint64 } from '@algorandfoundation/algorand-typescript'

export function wideRatio(numerators: uint64[], denominators: uint64[]): uint64 {
  const n: uint64 = numerators[numerators.length - 1]
  const d: uint64 = denominators[denominators.length - 1]

  return n / d
}
