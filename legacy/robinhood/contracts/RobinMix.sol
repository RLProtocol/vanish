// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MerkleTreeWithHistory} from "./MerkleTreeWithHistory.sol";

interface IVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[8] calldata publicSignals
    ) external view returns (bool);
}

/// @title RobinMix
/// @notice Multi-asset shielded pool for Robinhood Chain (ETH, USDG, Stock Tokens).
///         Deposits must be one of the fixed denominations registered for the asset;
///         withdrawals can be any amount (the remainder stays in the pool as a
///         private change note).
/// @dev    Owner can only register assets/denominations and pause *deposits*.
///         Nothing can stop a note owner from withdrawing.
contract RobinMix is MerkleTreeWithHistory, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    address public constant NATIVE_ETH = address(0);
    int256 public constant MAX_EXT_AMOUNT = 2 ** 248;
    uint256 public constant MAX_FEE = 2 ** 248;

    IVerifier public immutable verifier;

    struct ExtData {
        address recipient;
        int256 extAmount; // >0 deposit, <0 withdrawal, 0 private split/merge
        address relayer;
        uint256 fee;
        address token; // NATIVE_ETH for ETH
        bytes encryptedOutput1;
        bytes encryptedOutput2;
    }

    struct Proof {
        bytes proof; // abi.encode(uint256[2] a, uint256[2][2] b, uint256[2] c)
        bytes32 root;
        bytes32[2] inputNullifiers;
        bytes32[2] outputCommitments;
        uint256 publicAmount;
        bytes32 extDataHash;
    }

    mapping(address => bool) public assetRegistered;
    mapping(address => bool) public depositsPaused;
    mapping(address => mapping(uint256 => bool)) public isDenomination;
    mapping(address => uint256[]) private _denominations;
    address[] private _assets;

    mapping(bytes32 => bool) public nullifierHashes;

    event NewCommitment(bytes32 commitment, uint256 index, bytes encryptedOutput);
    event NewNullifier(bytes32 nullifier);
    event AssetAdded(address indexed token);
    event DenominationAdded(address indexed token, uint256 amount);
    event DepositsPaused(address indexed token, bool paused);

    constructor(IVerifier _verifier, address _hasher, uint32 _levels, address _owner)
        MerkleTreeWithHistory(_levels, _hasher)
        Ownable(_owner)
    {
        verifier = _verifier;
    }

    // ------------------------------------------------------------------ admin

    /// @notice Register an asset (or extend an existing one) with fixed deposit sizes,
    ///         given in the token's smallest unit.
    function addAsset(address token, uint256[] calldata denominations) external onlyOwner {
        if (!assetRegistered[token]) {
            assetRegistered[token] = true;
            _assets.push(token);
            emit AssetAdded(token);
        }
        for (uint256 i = 0; i < denominations.length; i++) {
            uint256 d = denominations[i];
            require(d > 0 && d < uint256(MAX_EXT_AMOUNT), "bad denomination");
            if (!isDenomination[token][d]) {
                isDenomination[token][d] = true;
                _denominations[token].push(d);
                emit DenominationAdded(token, d);
            }
        }
    }

    function setDepositsPaused(address token, bool paused) external onlyOwner {
        require(assetRegistered[token], "unknown asset");
        depositsPaused[token] = paused;
        emit DepositsPaused(token, paused);
    }

    // ------------------------------------------------------------------ views

    function getAssets() external view returns (address[] memory) {
        return _assets;
    }

    function getDenominations(address token) external view returns (uint256[] memory) {
        return _denominations[token];
    }

    function isSpent(bytes32 nullifier) external view returns (bool) {
        return nullifierHashes[nullifier];
    }

    function calculatePublicAmount(int256 extAmount, uint256 fee) public pure returns (uint256) {
        require(fee < MAX_FEE, "invalid fee");
        require(extAmount > -MAX_EXT_AMOUNT && extAmount < MAX_EXT_AMOUNT, "invalid ext amount");
        int256 publicAmount = extAmount - int256(fee);
        return publicAmount >= 0 ? uint256(publicAmount) : FIELD_SIZE - uint256(-publicAmount);
    }

    // ------------------------------------------------------------------ core

    function transact(Proof calldata args, ExtData calldata extData) external payable nonReentrant {
        address token = extData.token;
        require(assetRegistered[token], "unknown asset");

        if (extData.extAmount > 0) {
            require(!depositsPaused[token], "deposits paused");
            require(isDenomination[token][uint256(extData.extAmount)], "amount is not a valid denomination");
            require(extData.fee == 0, "no fee on deposits");
            _pull(token, uint256(extData.extAmount));
        } else {
            require(msg.value == 0, "unexpected ETH");
        }

        _verifyAndRecord(args, extData);

        if (extData.extAmount < 0) {
            require(extData.recipient != address(0), "recipient is zero");
            _send(token, extData.recipient, uint256(-extData.extAmount));
        }
        if (extData.fee > 0) {
            require(extData.relayer != address(0), "relayer is zero");
            _send(token, extData.relayer, extData.fee);
        }
    }

    function _verifyAndRecord(Proof calldata args, ExtData calldata extData) internal {
        require(isKnownRoot(args.root), "invalid merkle root");
        require(!nullifierHashes[args.inputNullifiers[0]], "input already spent");
        require(!nullifierHashes[args.inputNullifiers[1]], "input already spent");
        require(uint256(args.extDataHash) == uint256(keccak256(abi.encode(extData))) % FIELD_SIZE, "invalid ext data hash");
        require(args.publicAmount == calculatePublicAmount(extData.extAmount, extData.fee), "invalid public amount");

        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) =
            abi.decode(args.proof, (uint256[2], uint256[2][2], uint256[2]));
        uint256[8] memory pub = [
            uint256(args.root),
            args.publicAmount,
            uint256(args.extDataHash),
            uint256(uint160(extData.token)), // assetId
            uint256(args.inputNullifiers[0]),
            uint256(args.inputNullifiers[1]),
            uint256(args.outputCommitments[0]),
            uint256(args.outputCommitments[1])
        ];
        require(verifier.verifyProof(a, b, c, pub), "invalid transaction proof");

        nullifierHashes[args.inputNullifiers[0]] = true;
        nullifierHashes[args.inputNullifiers[1]] = true;
        emit NewNullifier(args.inputNullifiers[0]);
        emit NewNullifier(args.inputNullifiers[1]);

        uint32 index = _insert(args.outputCommitments[0], args.outputCommitments[1]);
        emit NewCommitment(args.outputCommitments[0], index, extData.encryptedOutput1);
        emit NewCommitment(args.outputCommitments[1], index + 1, extData.encryptedOutput2);
    }

    function _pull(address token, uint256 amount) internal {
        if (token == NATIVE_ETH) {
            require(msg.value == amount, "wrong ETH amount");
        } else {
            require(msg.value == 0, "unexpected ETH");
            uint256 before = IERC20(token).balanceOf(address(this));
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
            require(IERC20(token).balanceOf(address(this)) - before == amount, "fee-on-transfer tokens unsupported");
        }
    }

    function _send(address token, address to, uint256 amount) internal {
        if (token == NATIVE_ETH) {
            (bool ok,) = payable(to).call{value: amount}("");
            require(ok, "ETH transfer failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
