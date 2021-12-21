import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import {
  Numerical,
  stringifyPubkeysAndBNsInObject,
  toBN,
} from '../utils/types';
import * as anchor from '@project-serum/anchor';
import {
  FarmConfig,
  FixedRateConfig,
  GemFarmClient,
  PeriodConfig,
  RewardType,
  VariableRateConfig,
} from './gem-farm.client';
import { BN } from '@project-serum/anchor';
import { Token } from '@solana/spl-token';
import { ITokenData } from '../utils/account';
import { prepGem } from '../utils/gem-common';
import { assert } from 'chai';

// --------------------------------------- configs

export const defaultFarmConfig = <FarmConfig>{
  minStakingPeriodSec: new BN(0),
  cooldownPeriodSec: new BN(0),
  unstakingFeeLamp: new BN(LAMPORTS_PER_SOL),
};

export const defaultVariableConfig = <VariableRateConfig>{
  amount: new BN(10000), //10k
  durationSec: new BN(100), //at rate 100/s
};

export const defaultFixedConfig = <FixedRateConfig>{
  period1: <PeriodConfig>{
    //per gem per second
    rate: new BN(5),
    //seconds it lasts
    durationSec: new BN(3),
  },
  period2: <PeriodConfig>{
    rate: new BN(10),
    durationSec: new BN(3),
  },
  period3: <PeriodConfig>{
    //setting this to 0 let's us get deterministic test results
    //since the last leg is empty, as long as staking is delayed <6s we don't care
    rate: new BN(0),
    durationSec: new BN(6),
  },
  gemsFunded: new BN(1000),
};

export function totalRewardsPerGem() {
  const p1 = defaultFixedConfig.period1.rate.mul(
    defaultFixedConfig.period1.durationSec
  );
  const p2 = defaultFixedConfig.period2!.rate.mul(
    defaultFixedConfig.period2!.durationSec
  );
  const p3 = defaultFixedConfig.period3!.rate.mul(
    defaultFixedConfig.period3!.durationSec
  );

  return p1.add(p2).add(p3);
}

export function totalDuration() {
  const p1 = defaultFixedConfig.period1.durationSec;
  const p2 = defaultFixedConfig.period2!.durationSec;
  const p3 = defaultFixedConfig.period3!.durationSec;

  return p1.add(p2).add(p3);
}

export function totalRewardsAmount() {
  return defaultFixedConfig.gemsFunded.mul(totalRewardsPerGem());
}

// --------------------------------------- tester class

export class GemFarmTester extends GemFarmClient {
  //farm + bank
  bank!: Keypair;
  farm!: Keypair;
  farmManager!: Keypair;

  //farmer 1 + vault
  farmer1Identity!: Keypair;
  farmer1Vault!: PublicKey;
  farmer2Identity!: Keypair;
  farmer2Vault!: PublicKey;

  //rewards + funder
  reward = 'rewardA'; //todo switch
  rewardMint!: Token;
  rewardSource!: PublicKey;
  rewardSecondMint!: Token;
  funder = this.wallet.payer;

  //gem 1 used by farmer 1 / gem 2 by farmer 2
  gem1Amount!: anchor.BN;
  gem1!: ITokenData;
  gem2Amount!: anchor.BN;
  gem2!: ITokenData;

  constructor() {
    super(
      anchor.Provider.env().connection,
      anchor.Provider.env().wallet as anchor.Wallet
    );
  }

  async prepAccounts(initialFundingAmount: Numerical, reward?: string) {
    this.bank = Keypair.generate();
    this.farm = Keypair.generate();
    this.farmManager = await this.createWallet(100 * LAMPORTS_PER_SOL);

    this.farmer1Identity = await this.createWallet(100 * LAMPORTS_PER_SOL);
    [this.farmer1Vault] = await this.findVaultPDA(
      this.bank.publicKey,
      this.farmer1Identity.publicKey
    );
    this.farmer2Identity = await this.createWallet(100 * LAMPORTS_PER_SOL);
    [this.farmer2Vault] = await this.findVaultPDA(
      this.bank.publicKey,
      this.farmer2Identity.publicKey
    );

    if (reward) this.reward = reward;
    this.rewardMint = await this.createToken(0, this.funder.publicKey);
    this.rewardSource = await this.createAndFundATA(
      this.rewardMint,
      this.funder,
      toBN(initialFundingAmount)
    );
    this.rewardSecondMint = await this.createToken(0, this.funder.publicKey);

    ({ gemAmount: this.gem1Amount, gem: this.gem1 } = await prepGem(
      this,
      this.farmer1Identity
    ));
    ({ gemAmount: this.gem2Amount, gem: this.gem2 } = await prepGem(
      this,
      this.farmer2Identity
    ));
  }

  // --------------------------------------- getters

  async fetchFarm() {
    return this.fetchFarmAcc(this.farm.publicKey);
  }

  async fetchTreasuryBal() {
    return this.fetchTreasuryBalance(this.farm.publicKey);
  }

  // --------------------------------------- callers
  // ----------------- core

  async callInitFarm(farmConfig: FarmConfig) {
    return this.initFarm(
      this.farm,
      this.farmManager,
      this.farmManager,
      this.bank,
      this.rewardMint.publicKey,
      RewardType.Variable,
      this.rewardSecondMint.publicKey,
      RewardType.Variable,
      farmConfig
    );
  }

  async callPayout(destination: PublicKey, lamports: Numerical) {
    return this.payoutFromTreasury(
      this.farm.publicKey,
      this.farmManager,
      destination,
      toBN(lamports)
    );
  }

  // ----------------- farmer

  async callInitFarmer(identity: Keypair) {
    return this.initFarmer(this.farm.publicKey, identity, identity);
  }

  async callStake(identity: Keypair) {
    return this.stake(this.farm.publicKey, identity);
  }

  async callUnstake(identity: Keypair) {
    return this.unstake(this.farm.publicKey, identity);
  }

  async callDeposit(gems: Numerical, identity: Keypair) {
    const isFarmer1 =
      identity.publicKey.toBase58() ===
      this.farmer1Identity.publicKey.toBase58();

    return this.depositGem(
      this.bank.publicKey,
      isFarmer1 ? this.farmer1Vault : this.farmer2Vault,
      identity,
      toBN(gems),
      isFarmer1 ? this.gem1.tokenMint : this.gem2.tokenMint,
      isFarmer1 ? this.gem1.tokenAcc : this.gem2.tokenAcc
    );
  }

  async callWithdraw(gems: Numerical, identity: Keypair) {
    const isFarmer1 =
      identity.publicKey.toBase58() ===
      this.farmer1Identity.publicKey.toBase58();

    return this.withdrawGem(
      this.bank.publicKey,
      isFarmer1 ? this.farmer1Vault : this.farmer2Vault,
      identity,
      toBN(gems),
      isFarmer1 ? this.gem1.tokenMint : this.gem2.tokenMint,
      identity.publicKey
    );
  }

  async callClaimRewards(identity: Keypair) {
    return this.claim(
      this.farm.publicKey,
      identity,
      this.rewardMint.publicKey,
      this.rewardSecondMint.publicKey
    );
  }

  async callFlashDeposit(gems: Numerical) {
    return this.flashDeposit(
      this.farm.publicKey,
      this.farmer1Identity,
      toBN(gems),
      this.gem1.tokenMint,
      this.gem1.tokenAcc
    );
  }

  async callRefreshFarmer(identity: Keypair) {
    return this.refreshFarmer(this.farm.publicKey, identity);
  }

  // ----------------- funder

  async callAuthorize() {
    return this.authorizeFunder(
      this.farm.publicKey,
      this.farmManager,
      this.funder.publicKey
    );
  }

  async callDeauthorize() {
    return this.deauthorizeFunder(
      this.farm.publicKey,
      this.farmManager,
      this.funder.publicKey
    );
  }

  // ----------------- rewards

  async callFundReward(
    varConfig?: VariableRateConfig,
    fixedConfig?: FixedRateConfig
  ) {
    return this.fundReward(
      this.farm.publicKey,
      this.rewardMint.publicKey,
      this.funder,
      this.rewardSource,
      varConfig,
      fixedConfig
    );
  }

  async callCancelReward() {
    return this.cancelReward(
      this.farm.publicKey,
      this.farmManager,
      this.rewardMint.publicKey,
      this.funder.publicKey
    );
  }

  async callLockReward() {
    return this.lockReward(
      this.farm.publicKey,
      this.farmManager,
      this.rewardMint.publicKey
    );
  }

  // --------------------------------------- verifiers

  async verifyFunds(
    funded?: Numerical,
    refunded?: Numerical,
    accrued?: Numerical
  ) {
    let farmAcc = (await this.fetchFarm()) as any;
    let funds = farmAcc[this.reward].funds;

    if (funded) {
      assert(funds.totalFunded.eq(toBN(funded)));
    }
    if (refunded) {
      assert(funds.totalRefunded.eq(toBN(refunded)));
    }
    if (accrued) {
      assert(funds.totalAccruedToStakers.eq(toBN(accrued)));
    }

    return funds;
  }

  async verifyTimes(
    duration?: Numerical,
    rewardEnd?: Numerical,
    lockEnd?: Numerical
  ) {
    let farmAcc = (await this.fetchFarm()) as any;
    let times = farmAcc[this.reward].times;

    if (duration) {
      assert(times.durationSec.eq(toBN(duration)));
    }
    if (rewardEnd) {
      assert(times.rewardEndTs.eq(toBN(rewardEnd)));
    }
    if (lockEnd) {
      assert(times.lockEndTs.eq(toBN(lockEnd)));
    }

    return times;
  }

  async verifyVariableReward(
    rewardRate?: Numerical,
    lastUpdated?: Numerical,
    accruedRewardPerGem?: Numerical
  ) {
    let farmAcc = (await this.fetchFarm()) as any;
    let reward = farmAcc[this.reward].variableRate;

    if (rewardRate) {
      assert(reward.rewardRate.eq(toBN(rewardRate)));
    }
    if (lastUpdated) {
      assert(reward.rewardLastUpdatedTs.eq(toBN(lastUpdated)));
    }
    //todo need to think in which tests this one should be checked
    if (accruedRewardPerGem) {
      assert(reward.accruedRewardPerGem.eq(toBN(accruedRewardPerGem)));
    }

    return reward;
  }

  async verifyFixedReward(
    gemsParticipating?: Numerical,
    gemsMadeWhole?: Numerical
  ) {
    let farmAcc = (await this.fetchFarm()) as any;
    let reward = farmAcc[this.reward].fixedRate;

    if (gemsParticipating) {
      assert(reward.gemsParticipating.eq(toBN(gemsParticipating)));
    }
    if (gemsMadeWhole) {
      assert(reward.gemsMadeWhole.eq(toBN(gemsMadeWhole)));
    }

    return reward;
  }

  async verifyPotContains(pot: PublicKey, amount: Numerical, sign?: string) {
    const rewardsPotAcc = await this.fetchTokenAcc(
      this.rewardMint.publicKey,
      pot
    );
    switch (sign) {
      case 'lt':
        assert(rewardsPotAcc.amount.lt(toBN(amount)));
        break;
      default:
        assert(rewardsPotAcc.amount.eq(toBN(amount)));
    }

    return rewardsPotAcc;
  }

  async verifyFunderAccContains(amount: Numerical, sign?: string) {
    const sourceAcc = await this.fetchTokenAcc(
      this.rewardMint.publicKey,
      this.rewardSource
    );
    switch (sign) {
      case 'gt':
        assert(sourceAcc.amount.gt(toBN(amount)));
        break;
      default:
        assert(sourceAcc.amount.eq(toBN(amount)));
    }

    return sourceAcc;
  }

  async verifyStakedGemsAndFarmers(gems: Numerical, farmers: Numerical) {
    let farmAcc = await this.fetchFarm();
    assert(farmAcc.stakedFarmerCount.eq(toBN(farmers)));
    assert(farmAcc.gemsStaked.eq(toBN(gems)));

    return farmAcc;
  }

  async verifyClaimedRewards(identity: Keypair) {
    const [farmer] = await this.findFarmerPDA(
      this.farm.publicKey,
      identity.publicKey
    );
    const farmerAcc = (await this.fetchFarmerAcc(farmer)) as any;

    const rewardDest = await this.findATA(
      this.rewardMint.publicKey,
      identity.publicKey
    );
    const rewardDestAcc = await this.fetchTokenAcc(
      this.rewardMint.publicKey,
      rewardDest
    );

    //verify reward paid out == reward accrued
    assert(
      farmerAcc[this.reward].paidOutReward.eq(
        farmerAcc[this.reward].accruedReward
      )
    );

    //verify reward paid out = what's actually in the wallet
    assert(rewardDestAcc.amount.eq(farmerAcc[this.reward].paidOutReward));

    return { farmerAcc, rewardDestAcc };
  }

  //todo need to think where this should be used instead of pulling direct
  async verifyFarmerReward(
    identity: Keypair,
    paidOutReward?: Numerical,
    accruedReward?: Numerical,
    lastRecordedAccruedRewardPerGem?: Numerical,
    rewardWhole?: boolean
  ) {
    const [farmer] = await this.findFarmerPDA(
      this.farm.publicKey,
      identity.publicKey
    );
    const farmerAcc = (await this.fetchFarmerAcc(farmer)) as any;
    const reward = farmerAcc[this.reward];

    if (paidOutReward) {
      assert(reward.paidOutReward.eq(toBN(paidOutReward)));
    }
    if (accruedReward) {
      assert(reward.accruedReward.eq(toBN(accruedReward)));
    }
    if (lastRecordedAccruedRewardPerGem) {
      assert(
        reward.lastRecordedAccruedRewardPerGem.eq(
          toBN(lastRecordedAccruedRewardPerGem)
        )
      );
    }
    if (rewardWhole) {
      assert(reward.rewardWhole == rewardWhole);
    }

    return reward;
  }

  async stakeAndVerify(identity: Keypair) {
    const { farmer } = await this.callStake(identity);

    let vaultAcc = await this.fetchVaultAcc(
      identity === this.farmer1Identity ? this.farmer1Vault : this.farmer2Vault
    );
    assert.isTrue(vaultAcc.locked);

    let farmerAcc = await this.fetchFarmerAcc(farmer);
    assert(
      farmerAcc.gemsStaked.eq(
        identity === this.farmer1Identity ? this.gem1Amount : this.gem2Amount
      )
    );

    return farmerAcc;
  }

  async unstakeOnceAndVerify(identity: Keypair) {
    const { farmer, vault } = await this.callUnstake(identity);

    const vaultAcc = await this.fetchVaultAcc(vault);
    assert.isTrue(vaultAcc.locked);

    const farmerAcc = await this.fetchFarmerAcc(farmer);
    assert(farmerAcc.gemsStaked.eq(new BN(0)));

    return farmerAcc;
  }

  async unstakeTwiceAndVerify(identity: Keypair) {
    const { farmer, vault } = await this.callUnstake(identity);

    const vaultAcc = await this.fetchVaultAcc(vault);
    assert.isFalse(vaultAcc.locked);

    const farmerAcc = await this.fetchFarmerAcc(farmer);
    assert(farmerAcc.gemsStaked.eq(new BN(0)));

    return farmerAcc;
  }

  // --------------------------------------- extras

  async printStructs(state?: string) {
    const farmAcc = await this.fetchFarmAcc(this.farm.publicKey);
    console.log(`// --------------------------------------- ${state}`);
    console.log('// --------------------------------------- farm');
    console.log(stringifyPubkeysAndBNsInObject(farmAcc));

    const [farmer1] = await this.findFarmerPDA(
      this.farm.publicKey,
      this.farmer1Identity.publicKey
    );
    const farmer1Acc = await this.fetchFarmerAcc(farmer1);
    console.log('// --------------------------------------- farmer 1');
    console.log(stringifyPubkeysAndBNsInObject(farmer1Acc));

    const [farmer2] = await this.findFarmerPDA(
      this.farm.publicKey,
      this.farmer2Identity.publicKey
    );
    try {
      const farmer2Acc = await this.fetchFarmerAcc(farmer2);
      console.log('// --------------------------------------- farmer 2');
      console.log(stringifyPubkeysAndBNsInObject(farmer2Acc));
    } catch (e) {}
  }

  async mintMoreRewards(amount: number) {
    await this.rewardMint.mintTo(this.rewardSource, this.funder, [], amount);
  }
}