Below are links to a TEALScript contract and the location for a desired Algorand TypeScript contract. `tealscript-migration.md` is the migration guide for converting the TEALScript contract to TypeScript. Can you convert the TEALScript contract to TypeScript using the migration guide? Once done, test to make sure it builds with `algokit project run lint` and then `algokit project run build`.

The source code for Alogrand TypeScript, docs, and examples can be found at: <https://github.com/algorandfoundation/puya-ts>

TEALScript Contract: `tealscript/reti/stakingPool.algo.ts.tealscript` (note it imports from `tealscript/reti/constants.algo.ts.tealscript`)
Algorand TypeScript Contract: `smart_contracts/reti/stakingPool.algo.ts` (also include constants.algo.ts)

You MUST preserve all comments as much as possible. This is especially true for header typedoc comments, which should never be removed.
