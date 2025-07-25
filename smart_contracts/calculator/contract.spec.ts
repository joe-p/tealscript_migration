import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { describe, expect, it } from 'vitest'
import { Calculator } from './contract.algo'

describe('Calculator contract', () => {
  const ctx = new TestExecutionContext()
  it('Logs the returned value when sayHello is called', () => {
    const contract = ctx.contract.create(Calculator)

    const result = contract.hello('Sally')

    expect(result).toBe('Hello Sally')
  })
})
