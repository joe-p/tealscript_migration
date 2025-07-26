Below are links to a TEALScript contract and the location for a desired Algorand TypeScript contract. `tealscript-migration.md` is the migration guide for converting the TEALScript contract to TypeScript. Can you convert the TEALScript contract to TypeScript using the migration guide? Once done, test to make sure it builds with `algokit project run lint` and then `algokit project run build`.

The source code for Alogrand TypeScript, docs, and examples can be found at: <https://github.com/algorandfoundation/puya-ts>

This is the REAL implementation. DO NOT omit any functionality.

You MUST preserve all comments as much as possible. This is especially true for header typedoc comments, which should never be removed.

Do the migration in the following steps:

1. For EVERY contract listed below, first implement the class with empty methods. The method signatures should match the TEALScript contract, but at this step DO NOT implement any logic. Just create the class and methods. You can also implement any constants. DO NOT implement any logic until ALL contracts have been scaffolded.
2. Next, implement the logic for each method according to the TEALScript contract and the migration guide.

Contracts:

TEALScript Contract: `tealscript/reti/constants.algo.ts.tealscript`
Algorand TypeScript Contract: `smart_contracts/reti_constants/constants.algo.ts`

TEALScript Contract: `tealscript/reti/stakingPool.algo.ts.tealscript`
Algorand TypeScript Contract: `smart_contracts/reti_staking_pool/stakingPool.algo.ts`

TEALScript Contract: `tealscript/reti/validatorRegistry.algo.ts.tealscript`
Algorand TypeScript Contract: `smart_contracts/reti_validator_registry/validatorRegistry.algo.ts`
