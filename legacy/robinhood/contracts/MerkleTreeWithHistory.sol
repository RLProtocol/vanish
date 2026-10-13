// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Poseidon(2) hasher deployed from circomlibjs bytecode (see scripts/deploy.js).
interface IHasher {
    function poseidon(uint256[2] calldata inputs) external pure returns (uint256);
}

/// @notice Incremental Poseidon Merkle tree that inserts leaves in pairs and
///         remembers the last ROOT_HISTORY_SIZE roots, so proofs made against a
///         slightly stale root still verify.
contract MerkleTreeWithHistory {
    uint256 public constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint32 public constant ROOT_HISTORY_SIZE = 100;

    IHasher public immutable hasher;
    uint32 public immutable levels;

    mapping(uint256 => bytes32) public filledSubtrees;
    mapping(uint256 => bytes32) public zeros;
    mapping(uint256 => bytes32) public roots;
    uint32 public currentRootIndex;
    uint32 public nextIndex;

    constructor(uint32 _levels, address _hasher) {
        require(_levels > 1 && _levels <= 32, "levels out of range");
        levels = _levels;
        hasher = IHasher(_hasher);

        // Empty leaf = 0; zeros[i] is the root of an empty subtree of height i.
        bytes32 zero = bytes32(0);
        for (uint32 i = 0; i < _levels; i++) {
            zeros[i] = zero;
            filledSubtrees[i] = zero;
            zero = _hash(IHasher(_hasher), zero, zero);
        }
        roots[0] = zero;
    }

    function hashLeftRight(bytes32 left, bytes32 right) public view returns (bytes32) {
        return _hash(hasher, left, right);
    }

    function _hash(IHasher h, bytes32 left, bytes32 right) private pure returns (bytes32) {
        require(uint256(left) < FIELD_SIZE, "left out of field");
        require(uint256(right) < FIELD_SIZE, "right out of field");
        return bytes32(h.poseidon([uint256(left), uint256(right)]));
    }

    /// @dev Inserts two leaves at nextIndex and nextIndex+1. Returns the first index.
    function _insert(bytes32 leaf1, bytes32 leaf2) internal returns (uint32 index) {
        uint32 _nextIndex = nextIndex;
        require(_nextIndex != uint32(2) ** levels, "Merkle tree is full");

        uint32 currentIndex = _nextIndex / 2;
        bytes32 currentLevelHash = hashLeftRight(leaf1, leaf2);
        bytes32 left;
        bytes32 right;

        for (uint32 i = 1; i < levels; i++) {
            if (currentIndex % 2 == 0) {
                left = currentLevelHash;
                right = zeros[i];
                filledSubtrees[i] = currentLevelHash;
            } else {
                left = filledSubtrees[i];
                right = currentLevelHash;
            }
            currentLevelHash = hashLeftRight(left, right);
            currentIndex /= 2;
        }

        uint32 newRootIndex = (currentRootIndex + 1) % ROOT_HISTORY_SIZE;
        currentRootIndex = newRootIndex;
        roots[newRootIndex] = currentLevelHash;
        nextIndex = _nextIndex + 2;
        return _nextIndex;
    }

    function isKnownRoot(bytes32 root) public view returns (bool) {
        if (root == 0) return false;
        uint32 _currentRootIndex = currentRootIndex;
        uint32 i = _currentRootIndex;
        do {
            if (root == roots[i]) return true;
            if (i == 0) i = ROOT_HISTORY_SIZE;
            i--;
        } while (i != _currentRootIndex);
        return false;
    }

    function getLastRoot() public view returns (bytes32) {
        return roots[currentRootIndex];
    }
}
