import 'dotenv/config';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';
import { Buffer } from 'buffer';
import * as crypto from 'node:crypto';

import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import {
  persistentHash,
  CompactTypeVector,
  CompactTypeBytes,
} from '@midnight-ntwrk/compact-runtime';

const bytes32Type = new CompactTypeBytes(32);
const vec2Bytes32Type = new CompactTypeVector(2, bytes32Type);

export function derivePublicKeyJS(sk: Uint8Array): Uint8Array {
  const prefix = new Uint8Array(32);
  prefix.set(new TextEncoder().encode('pvs:v3:pk:'));
  return persistentHash(vec2Bytes32Type, [prefix, sk]);
}

export function deriveCommitmentJS(pk: Uint8Array): Uint8Array {
  const prefix = new Uint8Array(32);
  prefix.set(new TextEncoder().encode('pvs:v3:vc:'));
  return persistentHash(vec2Bytes32Type, [prefix, pk]);
}

// @ts-expect-error Required for wallet sync via GraphQL subscriptions
globalThis.WebSocket = WebSocket;

setNetworkId('preprod');

export const CONFIG = {
  indexer: 'https://indexer.preprod.midnight.network/api/v3/graphql',
  indexerWS: 'wss://indexer.preprod.midnight.network/api/v3/graphql/ws',
  node: 'https://rpc.preprod.midnight.network',
  proofServer: process.env.PROOF_SERVER_URL || 'http://127.0.0.1:6300',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'voting');

const contractPath = path.join(zkConfigPath, 'contract', 'index.js');

let _votingModule: any;
export async function getVotingModule() {
  if (!_votingModule) {
    try {
      _votingModule = await import(pathToFileURL(contractPath).href);
    } catch {
      console.error('Contract not compiled! Run: npm run compile');
      process.exit(1);
    }
  }
  return _votingModule;
}
export { _votingModule as VotingModule };

// ─── Private State ─────────────────────────────────────────────────────────────

export type VotePrivateState = {
  readonly voterSecret: Uint8Array;
  pendingCommitment: Uint8Array | null;
};

export function createInitialPrivateState(walletSeed: string): VotePrivateState {
  const voterSecret = new Uint8Array(
    crypto.createHash('sha256').update(walletSeed).digest(),
  );
  return { voterSecret, pendingCommitment: null };
}

const ensureUint8Array = (v: Uint8Array | Record<string, number>): Uint8Array =>
  v instanceof Uint8Array ? v : new Uint8Array(Object.values(v));

// ─── Witnesses ─────────────────────────────────────────────────────────────────

export const witnesses = {
  voterSecret: ({
    privateState,
  }: {
    privateState: VotePrivateState;
  }): [VotePrivateState, Uint8Array] => {
    return [privateState, ensureUint8Array(privateState.voterSecret as any)];
  },

  voterCommitmentToRegister: ({
    privateState,
  }: {
    privateState: VotePrivateState;
  }): [VotePrivateState, Uint8Array] => {
    if (privateState.pendingCommitment) {
      return [privateState, ensureUint8Array(privateState.pendingCommitment as any)];
    }
    const sk = ensureUint8Array(privateState.voterSecret as any);
    const pk = derivePublicKeyJS(sk);
    const commitment = deriveCommitmentJS(pk);
    return [{ ...privateState, pendingCommitment: commitment }, commitment];
  },

  findVoterPath: (
    context: { privateState: VotePrivateState; ledger: any },
    commitment: Uint8Array,
  ): [VotePrivateState, any] => {
    const treePath = context.ledger.voters.findPathForLeaf(commitment);
    if (!treePath) {
      throw new Error('Voter commitment not found in MerkleTree — not registered or tree out of sync');
    }
    return [context.privateState, treePath];
  },
};

// ─── Compiled Contract ─────────────────────────────────────────────────────────

let _compiledContract: any;
export async function getCompiledContract() {
  if (!_compiledContract) {
    const mod = await getVotingModule();
    _compiledContract = CompiledContract.make('voting', mod.Contract).pipe(
      CompiledContract.withWitnesses(witnesses),
      CompiledContract.withCompiledFileAssets(zkConfigPath),
    );
  }
  return _compiledContract;
}

// ─── Wallet ────────────────────────────────────────────────────────────────────

export function deriveKeys(seed: string) {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Invalid seed');
  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (result.type !== 'keysDerived') throw new Error('Key derivation failed');
  hdWallet.hdWallet.clear();
  return result.keys;
}

export async function createWallet(seed: string) {
  const keys = deriveKeys(seed);
  const networkId = getNetworkId();
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);

  const walletConfig = {
    networkId,
    indexerClientConnection: { indexerHttpUrl: CONFIG.indexer, indexerWsUrl: CONFIG.indexerWS },
    provingServerUrl: new URL(CONFIG.proofServer),
    relayURL: new URL(CONFIG.node.replace(/^http/, 'ws')),
  };

  const shieldedWallet = ShieldedWallet(walletConfig).startWithSecretKeys(shieldedSecretKeys);
  const unshieldedWallet = UnshieldedWallet({
    networkId,
    indexerClientConnection: walletConfig.indexerClientConnection,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
  }).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));
  const dustWallet = DustWallet({
    ...walletConfig,
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
  }).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust);

  const wallet = new WalletFacade(shieldedWallet, unshieldedWallet, dustWallet);
  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

// ─── Transaction Signing (workaround for wallet SDK signRecipe bug) ────────────

export function signTransactionIntents(
  tx: { intents?: Map<number, any> },
  signFn: (payload: Uint8Array) => ledger.Signature,
  proofMarker: 'proof' | 'pre-proof',
): void {
  if (!tx.intents || tx.intents.size === 0) return;
  for (const segment of tx.intents.keys()) {
    const intent = tx.intents.get(segment);
    if (!intent) continue;
    const cloned = ledger.Intent.deserialize<
      ledger.SignatureEnabled,
      ledger.Proofish,
      ledger.PreBinding
    >('signature', proofMarker, 'pre-binding', intent.serialize());
    const sigData = cloned.signatureData(segment);
    const signature = signFn(sigData);
    if (cloned.fallibleUnshieldedOffer) {
      const sigs = cloned.fallibleUnshieldedOffer.inputs.map(
        (_: any, i: number) => cloned.fallibleUnshieldedOffer!.signatures.at(i) ?? signature,
      );
      cloned.fallibleUnshieldedOffer = cloned.fallibleUnshieldedOffer.addSignatures(sigs);
    }
    if (cloned.guaranteedUnshieldedOffer) {
      const sigs = cloned.guaranteedUnshieldedOffer.inputs.map(
        (_: any, i: number) => cloned.guaranteedUnshieldedOffer!.signatures.at(i) ?? signature,
      );
      cloned.guaranteedUnshieldedOffer = cloned.guaranteedUnshieldedOffer.addSignatures(sigs);
    }
    tx.intents.set(segment, cloned);
  }
}

// ─── Providers ─────────────────────────────────────────────────────────────────

export async function createProviders(
  walletCtx: Awaited<ReturnType<typeof createWallet>>,
) {
  const state = await Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)),
  );

  const walletProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      const signFn = (payload: Uint8Array) => walletCtx.unshieldedKeystore.signData(payload);
      signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
      if (recipe.balancingTransaction) signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
      return walletCtx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'voting-private-state',
      walletProvider,
    }),
    publicDataProvider: indexerPublicDataProvider(CONFIG.indexer, CONFIG.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(CONFIG.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

export const Phase = { REGISTRATION: 0n, VOTING: 1n, CLOSED: 2n } as const;

export function phaseName(phase: bigint | number): string {
  const p = BigInt(phase);
  switch (p) {
    case Phase.REGISTRATION: return 'REGISTRATION';
    case Phase.VOTING: return 'VOTING';
    case Phase.CLOSED: return 'CLOSED';
    default: return `UNKNOWN(${p})`;
  }
}
