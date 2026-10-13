pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "./merkleproof.circom";
include "./keypair.circom";

/*
  Multi-asset JoinSplit (Tornado Nova model, extended with an asset id).

  Note (UTXO) = { amount, pubkey, blinding, assetId }
  commitment  = Poseidon(amount, pubkey, blinding, assetId)
  nullifier   = Poseidon(commitment, merklePath, Poseidon(privKey, commitment, merklePath))

  Balance rule:  sum(inAmount) + publicAmount == sum(outAmount)   (mod p)
    publicAmount > 0  -> deposit
    publicAmount < 0  -> withdrawal (encoded as p - amount)
    publicAmount = 0  -> private split / merge

  All inputs and outputs are bound to the single public `assetId`,
  so value can never move between assets inside the pool.
*/
template Transaction(levels, nIns, nOuts) {
    // ---- public ----
    signal input root;
    signal input publicAmount;
    signal input extDataHash;
    signal input assetId;
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];

    // ---- private: inputs ----
    signal input inAmount[nIns];
    signal input inPrivateKey[nIns];
    signal input inBlinding[nIns];
    signal input inPathIndices[nIns];
    signal input inPathElements[nIns][levels];

    // ---- private: outputs ----
    signal input outAmount[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];

    component inKeypair[nIns];
    component inSignature[nIns];
    component inCommitmentHasher[nIns];
    component inNullifierHasher[nIns];
    component inTree[nIns];
    component inCheckRoot[nIns];
    component inAmountCheck[nIns];
    var sumIns = 0;

    for (var tx = 0; tx < nIns; tx++) {
        inKeypair[tx] = Keypair();
        inKeypair[tx].privateKey <== inPrivateKey[tx];

        inCommitmentHasher[tx] = Poseidon(4);
        inCommitmentHasher[tx].inputs[0] <== inAmount[tx];
        inCommitmentHasher[tx].inputs[1] <== inKeypair[tx].publicKey;
        inCommitmentHasher[tx].inputs[2] <== inBlinding[tx];
        inCommitmentHasher[tx].inputs[3] <== assetId;

        inSignature[tx] = Signature();
        inSignature[tx].privateKey <== inPrivateKey[tx];
        inSignature[tx].commitment <== inCommitmentHasher[tx].out;
        inSignature[tx].merklePath <== inPathIndices[tx];

        inNullifierHasher[tx] = Poseidon(3);
        inNullifierHasher[tx].inputs[0] <== inCommitmentHasher[tx].out;
        inNullifierHasher[tx].inputs[1] <== inPathIndices[tx];
        inNullifierHasher[tx].inputs[2] <== inSignature[tx].out;
        inNullifierHasher[tx].out === inputNullifier[tx];

        inTree[tx] = MerkleProof(levels);
        inTree[tx].leaf <== inCommitmentHasher[tx].out;
        inTree[tx].pathIndices <== inPathIndices[tx];
        for (var i = 0; i < levels; i++) {
            inTree[tx].pathElements[i] <== inPathElements[tx][i];
        }

        // Zero-amount (dummy) inputs don't need to exist in the tree.
        inCheckRoot[tx] = ForceEqualIfEnabled();
        inCheckRoot[tx].in[0] <== root;
        inCheckRoot[tx].in[1] <== inTree[tx].root;
        inCheckRoot[tx].enabled <== inAmount[tx];

        inAmountCheck[tx] = Num2Bits(248);
        inAmountCheck[tx].in <== inAmount[tx];

        sumIns += inAmount[tx];
    }

    component outCommitmentHasher[nOuts];
    component outAmountCheck[nOuts];
    var sumOuts = 0;

    for (var tx = 0; tx < nOuts; tx++) {
        outCommitmentHasher[tx] = Poseidon(4);
        outCommitmentHasher[tx].inputs[0] <== outAmount[tx];
        outCommitmentHasher[tx].inputs[1] <== outPubkey[tx];
        outCommitmentHasher[tx].inputs[2] <== outBlinding[tx];
        outCommitmentHasher[tx].inputs[3] <== assetId;
        outCommitmentHasher[tx].out === outputCommitment[tx];

        // 248-bit range check prevents field-overflow value creation.
        outAmountCheck[tx] = Num2Bits(248);
        outAmountCheck[tx].in <== outAmount[tx];

        sumOuts += outAmount[tx];
    }

    // No double spend within one transaction.
    component sameNullifiers[nIns * (nIns - 1) / 2];
    var index = 0;
    for (var i = 0; i < nIns - 1; i++) {
        for (var j = i + 1; j < nIns; j++) {
            sameNullifiers[index] = IsEqual();
            sameNullifiers[index].in[0] <== inputNullifier[i];
            sameNullifiers[index].in[1] <== inputNullifier[j];
            sameNullifiers[index].out === 0;
            index++;
        }
    }

    sumIns + publicAmount === sumOuts;

    // Bind extDataHash (recipient, relayer, fee, ...) to the proof.
    signal extDataSquare <== extDataHash * extDataHash;
}

component main {public [root, publicAmount, extDataHash, assetId, inputNullifier, outputCommitment]} = Transaction(20, 2, 2);
