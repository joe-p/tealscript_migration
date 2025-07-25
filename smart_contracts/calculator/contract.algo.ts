import { Contract } from '@algorandfoundation/algorand-typescript'

export class Calculator extends Contract {
  public hello(name: string): string {
    return `Hello, ${name}`
  }
}
