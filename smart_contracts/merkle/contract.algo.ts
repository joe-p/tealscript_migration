import {
  Contract,
  GlobalState,
  uint64,
  bytes,
  FixedArray,
  assert,
  Txn,
  assertMatch,
  Global,
  op,
  Bytes,
} from '@algorandfoundation/algorand-typescript'

const TREE_DEPTH = 3
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const RIGHT_SIBLING_PREFIX = 170

type Branch = bytes<33>
type Path = FixedArray<Branch, typeof TREE_DEPTH>

export class MerkleTree extends Contract {
  public root = GlobalState<bytes>()

  public size = GlobalState<uint64>()

  private calcInitRoot(): bytes {
    let result = Bytes.fromHex(EMPTY_HASH)

    for (let i: uint64 = 0; i < TREE_DEPTH; i = i + 1) {
      result = op.sha256(op.concat(result, result))
    }

    return result
  }

  private hashConcat(left: bytes, right: bytes): bytes {
    return op.sha256(op.concat(left, right))
  }

  private isRightSibling(elem: Branch): boolean {
    return op.getByte(elem, 0) === RIGHT_SIBLING_PREFIX
  }

  private calcRoot(leaf: bytes, path: Path): bytes {
    let result = leaf

    for (let i: uint64 = 0; i < TREE_DEPTH; i = i + 1) {
      const elem = path[i]

      if (this.isRightSibling(elem)) {
        result = this.hashConcat(result, op.extract(elem, 1, 32))
      } else {
        result = this.hashConcat(op.extract(elem, 1, 32), result)
      }
    }

    return result
  }

  public deleteApplication(): void {
    assertMatch(Txn, { sender: Global.creatorAddress })
  }

  public createApplication(): void {
    this.root.value = this.calcInitRoot()
  }

  public verify(data: bytes, path: Path): void {
    assert(this.root.value === this.calcRoot(op.sha256(data), path))
  }

  public appendLeaf(data: bytes, path: Path): void {
    assert(data !== Bytes(''))
    assert(this.root.value === this.calcRoot(Bytes.fromHex(EMPTY_HASH), path))

    this.root.value = this.calcRoot(op.sha256(data), path)

    this.size.value = this.size.value + 1
  }

  public updateLeaf(oldData: bytes, newData: bytes, path: Path): void {
    assert(newData !== Bytes(''))
    assert(this.root.value === this.calcRoot(op.sha256(oldData), path))

    this.root.value = this.calcRoot(op.sha256(newData), path)
  }
}
