import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Rx from 'rxjs';
import { Buffer } from 'buffer';
import chalk from 'chalk';

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v7';
import { generateRandomSeed } from '@midnight-ntwrk/wallet-sdk-hd';

import {
  createWallet,
  createProviders,
  createInitialPrivateState,
  getCompiledContract,
  zkConfigPath,
} from './utils.js';

async function main() {
  console.log();
  console.log(chalk.blue.bold('━'.repeat(60)));
  console.log(chalk.blue.bold('🗳️  Voting Contract Deployment (v3 — Preprod)'));
  console.log(chalk.blue.bold('━'.repeat(60)));
  console.log();

  if (!fs.existsSync(path.join(zkConfigPath, 'contract', 'index.js'))) {
    console.error(chalk.red('Contract not compiled! Run: npm run compile'));
    process.exit(1);
  }

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    // 1. Wallet setup
    console.log(chalk.gray('─── Step 1: Wallet Setup ───────────────────────────────────────\n'));
    const choice = await rl.question('  [1] Create new wallet\n  [2] Restore from seed\n  > ');

    const seed =
      choice.trim() === '2'
        ? (await rl.question('\n  Enter your 64-character seed: ')).trim()
        : toHex(Buffer.from(generateRandomSeed()));

    if (choice.trim() !== '2') {
      console.log(`\n  ${chalk.yellow('⚠️  SAVE THIS SEED')} (you'll need it later):`);
      console.log(chalk.white(`  ${seed}\n`));
    }

    console.log(chalk.gray('  Creating wallet...'));
    const walletCtx = await createWallet(seed);

    console.log(chalk.gray('  Syncing with network...'));
    const state = await Rx.firstValueFrom(
      walletCtx.wallet.state().pipe(Rx.throttleTime(5000), Rx.filter((s) => s.isSynced)),
    );

    const address = walletCtx.unshieldedKeystore.getBech32Address();
    const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;

    console.log(chalk.cyan(`\n  Wallet Address: ${address}`));
    console.log(chalk.cyan(`  Balance: ${balance.toLocaleString()} tNight\n`));

    // 2. Fund wallet if needed
    if (balance === 0n) {
      console.log(chalk.gray('─── Step 2: Fund Your Wallet ───────────────────────────────────\n'));
      console.log(chalk.yellow('  Visit: https://faucet.preprod.midnight.network/'));
      console.log(chalk.white(`  Address: ${address}\n`));
      console.log(chalk.gray('  Waiting for funds...'));

      await Rx.firstValueFrom(
        walletCtx.wallet.state().pipe(
          Rx.throttleTime(10000),
          Rx.filter((s) => s.isSynced),
          Rx.map((s) => s.unshielded.balances[unshieldedToken().raw] ?? 0n),
          Rx.filter((b) => b > 0n),
        ),
      );
      console.log(chalk.green('  Funds received!\n'));
    }

    // 3. Register for DUST
    console.log(chalk.gray('─── Step 3: DUST Token Setup ───────────────────────────────────\n'));
    const dustState = await Rx.firstValueFrom(
      walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)),
    );

    if (dustState.dust.walletBalance(new Date()) === 0n) {
      const nightUtxos = dustState.unshielded.availableCoins.filter(
        (c: any) => !c.meta?.registeredForDustGeneration,
      );
      if (nightUtxos.length > 0) {
        console.log(chalk.gray('  Registering for DUST generation...'));
        const recipe = await walletCtx.wallet.registerNightUtxosForDustGeneration(
          nightUtxos,
          walletCtx.unshieldedKeystore.getPublicKey(),
          (payload) => walletCtx.unshieldedKeystore.signData(payload),
        );
        await walletCtx.wallet.submitTransaction(await walletCtx.wallet.finalizeRecipe(recipe));
      }

      console.log(chalk.gray('  Waiting for DUST tokens...'));
      await Rx.firstValueFrom(
        walletCtx.wallet.state().pipe(
          Rx.throttleTime(5000),
          Rx.filter((s) => s.isSynced),
          Rx.filter((s) => s.dust.walletBalance(new Date()) > 0n),
        ),
      );
    }
    console.log(chalk.green('  DUST tokens ready!\n'));

    // 4. Deploy contract
    console.log(chalk.gray('─── Step 4: Deploy Contract ────────────────────────────────────\n'));
    console.log(chalk.gray('  Setting up providers...'));
    const providers = await createProviders(walletCtx);

    const initialPrivateState = createInitialPrivateState(seed);

    const compiledContract = await getCompiledContract();

    console.log(chalk.blue('  Deploying voting-v3 contract (30-60 seconds)...\n'));
    const deployed = await deployContract(providers, {
      compiledContract,
      privateStateId: 'votingPrivateState',
      initialPrivateState,
    });

    const contractAddress = deployed.deployTxData.public.contractAddress;

    console.log();
    console.log(chalk.green.bold('━'.repeat(60)));
    console.log(chalk.green.bold('🎉 VOTING CONTRACT DEPLOYED!'));
    console.log(chalk.green.bold('━'.repeat(60)));
    console.log();
    console.log(chalk.cyan.bold('📍 Contract Address:'));
    console.log(chalk.white(`   ${contractAddress}`));
    console.log();

    const deploymentInfo = {
      contractAddress,
      seed,
      network: 'preprod',
      contractVersion: 'v3',
      deployedAt: new Date().toISOString(),
    };

    fs.writeFileSync('deployment.json', JSON.stringify(deploymentInfo, null, 2));
    console.log(chalk.gray('  Saved to deployment.json\n'));

    console.log(chalk.yellow.bold('📝 Next Steps:'));
    console.log(chalk.cyan('   1. Start the CLI:'));
    console.log(chalk.white('      npm run cli'));
    console.log(chalk.cyan('   2. Register voters (creator only — paste commitment hex)'));
    console.log(chalk.cyan('   3. Start voting (sets proposal + opens voting)'));
    console.log(chalk.cyan('   4. Voters cast anonymous votes'));
    console.log();

    await walletCtx.wallet.stop();
    console.log(chalk.gray('─── Deployment Complete! ───────────────────────────────────────\n'));
  } finally {
    rl.close();
  }
}

main().catch(console.error);
