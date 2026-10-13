const { expect } = require("chai");
const { ethers } = require("hardhat");
const { poseidonContract } = require("circomlibjs");
const { initPoseidon, Keypair, Utxo } = require("../src/lib/crypto");
const { prepareTransaction } = require("../src/lib/transaction");
const { RobinMixClient } = require("../src/lib/client");

const ETH = ethers.ZeroAddress;
const e = (v) => ethers.parseEther(v);
const usd = (v) => ethers.parseUnits(v, 6);

describe("RobinMix", function () {
  let pool, usdg, stock, owner, alice, bob, relayer;

  before(async () => {
    await initPoseidon();
  });

  beforeEach(async () => {
    [owner, alice, bob, relayer] = await ethers.getSigners();
    const hasher = await new ethers.ContractFactory(poseidonContract.generateABI(2), poseidonContract.createCode(2), owner).deploy();
    const verifier = await (await ethers.getContractFactory("Groth16Verifier")).deploy();
    pool = await (await ethers.getContractFactory("RobinMix")).deploy(verifier, hasher, 20, owner.address);

    const Mock = await ethers.getContractFactory("MockERC20");
    usdg = await Mock.deploy("Global Dollar", "USDG", 6);
    stock = await Mock.deploy("NVIDIA • Robinhood Token", "NVDA", 18);

    await pool.addAsset(ETH, [e("0.01"), e("0.1"), e("0.5"), e("1")]);
    await pool.addAsset(await usdg.getAddress(), [usd("10"), usd("100"), usd("500"), usd("1000")]);
    await pool.addAsset(await stock.getAddress(), [e("1"), e("10"), e("50"), e("100")]);

    await usdg.mint(alice.address, usd("10000"));
    await stock.mint(alice.address, e("1000"));
  });

  const client = (signer = alice, keypair = new Keypair()) =>
    new RobinMixClient({ poolAddress: pool.target, runner: signer, keypair });

  it("deposits a fixed ETH denomination and withdraws a custom amount, keeping private change", async () => {
    const c = client();
    await c.deposit({ token: ETH, amount: e("0.5"), signer: alice });
    expect((await c.balance(ETH)).total).to.equal(e("0.5"));

    const before = await ethers.provider.getBalance(bob.address);
    await c.withdraw({ token: ETH, amount: e("0.1337"), recipient: bob.address, signer: alice });
    expect((await ethers.provider.getBalance(bob.address)) - before).to.equal(e("0.1337"));
    expect((await c.balance(ETH)).total).to.equal(e("0.3663"));

    // spend the change note in full via a relayer that takes a fee
    const relBefore = await ethers.provider.getBalance(relayer.address);
    await c.withdraw({ token: ETH, amount: e("0.3653"), fee: e("0.001"), relayer: relayer.address, recipient: bob.address, signer: alice });
    expect((await ethers.provider.getBalance(relayer.address)) - relBefore).to.equal(e("0.001"));
    expect((await c.balance(ETH)).total).to.equal(0n);
    expect(await ethers.provider.getBalance(pool.target)).to.equal(0n);
  });

  it("rejects deposits that are not a registered denomination", async () => {
    const c = client();
    await expect(c.deposit({ token: ETH, amount: e("0.2"), signer: alice })).to.be.rejectedWith(/not an allowed denomination/);

    // bypassing the client: a valid proof for 0.2 ETH is still refused on-chain
    await c.sync();
    const out = new Utxo({ amount: e("0.2"), keypair: c.keypair });
    const tx = await prepareTransaction({ tree: c.tree, token: ETH, outputs: [out], extAmount: e("0.2") });
    await expect(pool.connect(alice).transact(tx.args, tx.extData, { value: e("0.2") })).to.be.revertedWith("amount is not a valid denomination");
  });

  it("handles USDG (6 decimals) with custom withdrawals", async () => {
    const c = client();
    await c.deposit({ token: usdg.target, amount: usd("100"), signer: alice });
    await c.withdraw({ token: usdg.target, amount: usd("12.34"), recipient: bob.address, signer: alice });
    expect(await usdg.balanceOf(bob.address)).to.equal(usd("12.34"));
    expect((await c.balance(usdg.target)).total).to.equal(usd("87.66"));
  });

  it("handles stock tokens with share denominations and fractional withdrawals", async () => {
    const c = client();
    await c.deposit({ token: stock.target, amount: e("10"), signer: alice });
    await c.deposit({ token: stock.target, amount: e("1"), signer: alice });
    await c.withdraw({ token: stock.target, amount: e("10.5"), recipient: bob.address, signer: alice });
    expect(await stock.balanceOf(bob.address)).to.equal(e("10.5"));
    expect((await c.balance(stock.target)).total).to.equal(e("0.5"));
  });

  it("merges notes automatically when a withdrawal needs more than two", async () => {
    const c = client();
    for (let i = 0; i < 3; i++) await c.deposit({ token: ETH, amount: e("0.01"), signer: alice });
    let merges = 0;
    await c.withdraw({ token: ETH, amount: e("0.025"), recipient: bob.address, signer: alice, onMerge: () => merges++ });
    expect(merges).to.equal(1);
    expect((await c.balance(ETH)).total).to.equal(e("0.005"));
  });

  it("keeps each user's notes private to their key", async () => {
    const a = client(alice);
    const b = client(bob);
    await a.deposit({ token: ETH, amount: e("1"), signer: alice });
    expect((await b.balance(ETH)).total).to.equal(0n);
    await expect(b.withdraw({ token: ETH, amount: e("0.5"), recipient: bob.address, signer: bob })).to.be.rejectedWith(/insufficient/);
  });

  it("prevents double spends", async () => {
    const c = client();
    await c.deposit({ token: ETH, amount: e("0.1"), signer: alice });
    const [note] = await c.getUnspent(ETH);
    const mk = () =>
      prepareTransaction({ tree: c.tree, token: ETH, inputs: [note], extAmount: -e("0.1"), recipient: bob.address, keypair: c.keypair });
    const tx1 = await mk();
    const tx2 = await mk();
    await pool.connect(alice).transact(tx1.args, tx1.extData);
    await expect(pool.connect(alice).transact(tx2.args, tx2.extData)).to.be.revertedWith("input already spent");
  });

  it("cannot withdraw a different asset than the note holds", async () => {
    const c = client();
    await c.deposit({ token: stock.target, amount: e("1"), signer: alice });
    await usdg.mint(pool.target, usd("5000")); // other depositors' USDG sitting in the pool
    const [note] = await c.getUnspent(stock.target);

    const tx = await prepareTransaction({ tree: c.tree, token: stock.target, inputs: [note], extAmount: -e("1"), recipient: bob.address, keypair: c.keypair });
    // swap the token in extData -> hash mismatch
    const forged = { ...tx.extData, token: usdg.target };
    await expect(pool.connect(alice).transact(tx.args, forged)).to.be.revertedWith("invalid ext data hash");

    // re-labelling the note as USDG breaks the commitment, so no proof can be built
    const relabeled = new Utxo({ amount: note.amount, blinding: note.blinding, keypair: note.keypair, index: note.index, assetId: BigInt(usdg.target) });
    await expect(
      prepareTransaction({ tree: c.tree, token: usdg.target, inputs: [relabeled], extAmount: -e("1"), recipient: bob.address, keypair: c.keypair }),
    ).to.be.rejectedWith(/commitment mismatch/);
  });

  it("binds recipient and fee to the proof (front-running protection)", async () => {
    const c = client();
    await c.deposit({ token: ETH, amount: e("0.1"), signer: alice });
    const [note] = await c.getUnspent(ETH);
    const tx = await prepareTransaction({ tree: c.tree, token: ETH, inputs: [note], extAmount: -e("0.1"), recipient: bob.address, keypair: c.keypair });
    const stolen = { ...tx.extData, recipient: relayer.address };
    await expect(pool.connect(relayer).transact(tx.args, stolen)).to.be.revertedWith("invalid ext data hash");
  });

  it("owner can pause deposits but never withdrawals", async () => {
    const c = client();
    await c.deposit({ token: ETH, amount: e("0.1"), signer: alice });
    await pool.setDepositsPaused(ETH, true);
    await expect(c.deposit({ token: ETH, amount: e("0.1"), signer: alice })).to.be.rejectedWith(/deposits paused/);
    await c.withdraw({ token: ETH, amount: e("0.1"), recipient: bob.address, signer: alice });
    await expect(pool.connect(alice).setDepositsPaused(ETH, false)).to.be.reverted;
  });
});
