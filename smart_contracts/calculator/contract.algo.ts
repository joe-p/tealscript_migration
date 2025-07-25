import { Contract, uint64, assert } from '@algorandfoundation/algorand-typescript'

export class Calculator extends Contract {
  private getSum(a: uint64, b: uint64): uint64 {
    const result: uint64 = a + b
    return result
  }

  private getDifference(a: uint64, b: uint64): uint64 {
    return a >= b ? a - b : b - a
  }

  public doMath(a: uint64, b: uint64, operation: string): uint64 {
    let result: uint64

    if (operation === 'sum') {
      result = this.getSum(a, b)
    } else if (operation === 'difference') {
      result = this.getDifference(a, b)
    } else {
      assert(false, 'Invalid operation')
    }

    return result
  }
}
