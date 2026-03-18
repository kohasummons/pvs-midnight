/**
 * Interactive CLI to interact with deployed Voting contract.
 * Auto-detects role (creator vs voter) and shows appropriate menu.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as Rx from 'rxjs';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';

import {
  createWallet,
  createProviders,
  createInitialPrivateState,
  getCompiledContract,
  getVotingModule,
  phaseName,
  derivePublicKeyJS,
  deriveCommitmentJS,
} from './utils.js';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '').trim();
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function computeCommitment(seed: string): { sk: Uint8Array; pk: Uint8Array; commitment: Uint8Array } {
  const sk = new Uint8Array(crypto.createHash('sha256').update(seed).digest());
  const pk = derivePublicKeyJS(sk);
  const commitment = deriveCommitmentJS(pk);
  return { sk, pk, commitment };
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                  Voting Contract CLI                          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  if (!fs.existsSync('deployment.json')) {
    console.error('No deployment.json found! Run `npm run deploy` first.\n');
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync('deployment.json', 'utf-8'));
  console.log(`  Contract: ${deployment.contractAddress}\n`);

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const seed = (await rl.question('  Enter your wallet seed: ')).trim();

    const { pk: myPk, commitment: myCommitment } = computeCommitment(seed);
    console.log(`\n  Your commitment: ${toHex(myCommitment)}`);

    console.log('\n  Connecting to Midnight Preprod...');
    const walletCtx = await createWallet(seed);

    console.log('  Syncing wallet...');
    await Rx.firstValueFrom(walletCtx.wallet.state().pipe(Rx.throttleTime(5000), Rx.filter((s) => s.isSynced)));

    console.log('  Setting up providers...');
    const providers = await createProviders(walletCtx);

    const compiledContract = await getCompiledContract();
    const initialPrivateState = createInitialPrivateState(seed);
    const Voting = await getVotingModule();

    console.log('  Joining contract...');
    const contract = await findDeployedContract(providers, {
      contractAddress: deployment.contractAddress,
      compiledContract,
      privateStateId: 'votingPrivateState',
      initialPrivateState,
    });

    const pubState = await providers.publicDataProvider.queryContractState(deployment.contractAddress);
    let isCreator = false;
    if (pubState) {
      const ls = Voting.ledger(pubState.data);
      const creatorBytes = ls.creator instanceof Uint8Array ? ls.creator : new Uint8Array(Object.values(ls.creator));
      isCreator = toHex(myPk) === toHex(creatorBytes);
    }

    console.log(`  Role: ${isCreator ? 'CREATOR (admin)' : 'VOTER'}`);
    console.log('  Connected!\n');

    let running = true;
    while (running) {
      const dust = (await Rx.firstValueFrom(walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)))).dust.walletBalance(new Date());

      console.log('─────────────────────────────────────────────────────────────────');
      console.log(`  DUST: ${dust.toLocaleString()}`);

      try {
        const state = await providers.publicDataProvider.queryContractState(deployment.contractAddress);
        if (state) {
          const ls = Voting.ledger(state.data);
          console.log(`  Phase: ${phaseName(ls.phase)}`);
          if (ls.proposalTitle?.is_some) console.log(`  Proposal: ${ls.proposalTitle.value}`);
          console.log(`  Yes: ${ls.yesVotes}  No: ${ls.noVotes}`);
        }
      } catch {
        // public state read failed
      }

      console.log('─────────────────────────────────────────────────────────────────');

      let choice: string;

      if (isCreator) {
        choice = await rl.question(
          '  [1] Register self\n  [2] Register other voter\n  [3] Start voting\n  [4] Vote YES\n  [5] Vote NO\n  [6] Close voting\n  [7] View results\n  [8] Exit\n  > ',
        );

        switch (choice.trim()) {
          case '1':
            try {
              console.log('\n  Registering self (this may take 20-30 seconds)...\n');
              const tx = await contract.callTx.registerVoter();
              console.log(`  ✅ Self registered!`);
              console.log(`  Transaction: ${tx.public.txId}`);
              console.log(`  Block: ${tx.public.blockHeight}\n`);
            } catch (e) {
              console.error(`  ❌ Error: ${e instanceof Error ? e.message : e}\n`);
            }
            break;

          case '2':
            try {
              const commitHex = (await rl.question('\n  Paste voter commitment (64-char hex): ')).trim();
              if (commitHex.length < 64) {
                console.error('  ❌ Invalid commitment (must be 64 hex chars)\n');
                break;
              }
              const commitBytes = fromHex(commitHex);
              const ps = await providers.privateStateProvider.get('votingPrivateState');
              if (ps) {
                ps.pendingCommitment = commitBytes;
                await providers.privateStateProvider.set('votingPrivateState', ps);
              }
              console.log('  Registering voter (this may take 20-30 seconds)...\n');
              const tx = await contract.callTx.registerVoter();
              console.log(`  ✅ Voter registered!`);
              console.log(`  Transaction: ${tx.public.txId}`);
              console.log(`  Block: ${tx.public.blockHeight}\n`);
            } catch (e) {
              console.error(`  ❌ Error: ${e instanceof Error ? e.message : e}\n`);
            }
            break;

          case '3':
            try {
              const title = await rl.question('\n  Proposal title: ');
              const description = await rl.question('  Proposal description: ');
              console.log('  Starting voting phase (this may take 20-30 seconds)...\n');
              const tx = await contract.callTx.startVoting(title, description);
              console.log(`  ✅ Voting started!`);
              console.log(`  Transaction: ${tx.public.txId}`);
              console.log(`  Block: ${tx.public.blockHeight}\n`);
            } catch (e) {
              console.error(`  ❌ Error: ${e instanceof Error ? e.message : e}\n`);
            }
            break;

          case '4':
            try {
              console.log('\n  Casting YES vote (this may take 20-30 seconds)...\n');
              const tx = await contract.callTx.vote(Voting.VoteChoice.YES);
              console.log(`  ✅ Vote cast!`);
              console.log(`  Transaction: ${tx.public.txId}`);
              console.log(`  Block: ${tx.public.blockHeight}\n`);
            } catch (e) {
              console.error(`  ❌ Error: ${e instanceof Error ? e.message : e}\n`);
            }
            break;

          case '5':
            try {
              console.log('\n  Casting NO vote (this may take 20-30 seconds)...\n');
              const tx = await contract.callTx.vote(Voting.VoteChoice.NO);
              console.log(`  ✅ Vote cast!`);
              console.log(`  Transaction: ${tx.public.txId}`);
              console.log(`  Block: ${tx.public.blockHeight}\n`);
            } catch (e) {
              console.error(`  ❌ Error: ${e instanceof Error ? e.message : e}\n`);
            }
            break;

          case '6':
            try {
              console.log('\n  Closing voting (this may take 20-30 seconds)...\n');
              const tx = await contract.callTx.closeVoting();
              console.log(`  ✅ Voting closed!`);
              console.log(`  Transaction: ${tx.public.txId}`);
              console.log(`  Block: ${tx.public.blockHeight}\n`);
            } catch (e) {
              console.error(`  ❌ Error: ${e instanceof Error ? e.message : e}\n`);
            }
            break;

          case '7':
            try {
              console.log('\n  Reading contract state from blockchain...');
              const st = await providers.publicDataProvider.queryContractState(deployment.contractAddress);
              if (st) {
                const ls = Voting.ledger(st.data);
                console.log(`  Phase: ${phaseName(ls.phase)}`);
                if (ls.proposalTitle?.is_some) console.log(`  Proposal: ${ls.proposalTitle.value}`);
                if (ls.proposalDescription?.is_some) console.log(`  Description: ${ls.proposalDescription.value}`);
                console.log(`  Yes votes: ${ls.yesVotes}`);
                console.log(`  No votes: ${ls.noVotes}\n`);
              } else {
                console.log('  No state found.\n');
              }
            } catch (e) {
              console.error(`  ❌ Error: ${e instanceof Error ? e.message : e}\n`);
            }
            break;

          case '8':
            running = false;
            break;
        }
      } else {
        choice = await rl.question(
          '  [1] Show my commitment\n  [2] Vote YES\n  [3] Vote NO\n  [4] View results\n  [5] Exit\n  > ',
        );

        switch (choice.trim()) {
          case '1':
            console.log(`\n  Your commitment (send this to the creator):`);
            console.log(`  ${toHex(myCommitment)}\n`);
            break;

          case '2':
            try {
              console.log('\n  Casting YES vote (this may take 20-30 seconds)...\n');
              const tx = await contract.callTx.vote(Voting.VoteChoice.YES);
              console.log(`  ✅ Vote cast!`);
              console.log(`  Transaction: ${tx.public.txId}`);
              console.log(`  Block: ${tx.public.blockHeight}\n`);
            } catch (e) {
              console.error(`  ❌ Error: ${e instanceof Error ? e.message : e}\n`);
            }
            break;

          case '3':
            try {
              console.log('\n  Casting NO vote (this may take 20-30 seconds)...\n');
              const tx = await contract.callTx.vote(Voting.VoteChoice.NO);
              console.log(`  ✅ Vote cast!`);
              console.log(`  Transaction: ${tx.public.txId}`);
              console.log(`  Block: ${tx.public.blockHeight}\n`);
            } catch (e) {
              console.error(`  ❌ Error: ${e instanceof Error ? e.message : e}\n`);
            }
            break;

          case '4':
            try {
              console.log('\n  Reading contract state from blockchain...');
              const st = await providers.publicDataProvider.queryContractState(deployment.contractAddress);
              if (st) {
                const ls = Voting.ledger(st.data);
                console.log(`  Phase: ${phaseName(ls.phase)}`);
                if (ls.proposalTitle?.is_some) console.log(`  Proposal: ${ls.proposalTitle.value}`);
                if (ls.proposalDescription?.is_some) console.log(`  Description: ${ls.proposalDescription.value}`);
                console.log(`  Yes votes: ${ls.yesVotes}`);
                console.log(`  No votes: ${ls.noVotes}\n`);
              } else {
                console.log('  No state found.\n');
              }
            } catch (e) {
              console.error(`  ❌ Error: ${e instanceof Error ? e.message : e}\n`);
            }
            break;

          case '5':
            running = false;
            break;
        }
      }
    }

    await walletCtx.wallet.stop();
    console.log('\n  Goodbye!\n');
  } finally {
    rl.close();
  }
}

main().catch(console.error);
