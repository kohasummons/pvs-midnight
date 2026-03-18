# PVS — Private Voting System on Midnight

A zero-knowledge private voting smart contract for the Midnight blockchain. Voters are registered by a creator, cast anonymous votes (YES/NO) using ZK proofs, and nullifiers prevent double-voting — all on Preprod testnet.

## Prerequisites

- **Node.js v22+** (`nvm install 22`)
- **Docker** (for the proof server)
- **Compact compiler** — See [Midnight docs](https://docs.midnight.network/) for installation

## Quick Start

```bash
# Install dependencies
npm install

# Compile the Compact contract
npm run compile

# Start the proof server (Docker)
npm run proof-server:start

# Deploy to Preprod
npm run deploy

# Interact via CLI
npm run cli

# Stop proof server when done
npm run proof-server:stop
```

## Project Structure

```
├── contracts/
│   ├── voting.compact             # Voting contract (Compact lang)
│   └── hello-world.compact        # Minimal hello-world example
├── src/
│   ├── deploy.ts                  # Deployment script
│   ├── cli.ts                     # Interactive CLI (creator + voter flows)
│   └── utils.ts                   # Wallet, providers, witnesses, helpers
├── docker-compose.yml             # Proof server config
└── package.json
```

## How It Works

### Contract Phases

| Phase | Description |
|-------|-------------|
| **REGISTRATION** | Creator registers voters by their commitment hash |
| **VOTING** | Registered voters cast anonymous YES/NO votes via ZK proofs |
| **CLOSED** | Creator closes the vote; results are final |

### Privacy Model

- **Voter identity** is never revealed on-chain. Votes are linked to a Merkle proof of registration, not a wallet address.
- **Nullifiers** derived from voter secrets prevent double-voting without revealing who voted.
- **Commitments** (`hash(hash(sk))`) are stored in a Merkle tree — only the tree root is checked during voting.

### Key Circuits

| Circuit | Access | Description |
|---------|--------|-------------|
| `registerVoter` | Creator only | Adds a voter commitment to the Merkle tree |
| `startVoting` | Creator only | Sets proposal title/description, opens voting |
| `vote` | Any registered voter | Casts an anonymous YES or NO vote |
| `closeVoting` | Creator only | Closes the voting phase |

## CLI

The CLI auto-detects your role (creator vs voter) based on your wallet seed.

**Creator menu:**
1. Register self
2. Register another voter (by commitment hex)
3. Start voting (set proposal)
4. Vote YES / NO
5. Close voting
6. View results

**Voter menu:**
1. Show commitment (share with creator for registration)
2. Vote YES / NO
3. View results

## Deployment Flow

1. **Compile** — Generates ZK circuits in `contracts/managed/voting/`
2. **Start proof server** — Required for generating ZK proofs
3. **Deploy** — Creates/restores wallet, funds via faucet, deploys contract
4. **Interact** — Register voters, start proposals, vote, and close via CLI

## Wallet & Funding

- Choose to create a new wallet or restore from a hex seed
- New wallets generate a 64-character hex seed — **save it**
- Fund at: https://faucet.preprod.midnight.network/
- DUST tokens are auto-registered from your tNight balance

## Network

Targets **Preprod** testnet:

- Indexer: `https://indexer.preprod.midnight.network`
- RPC: `https://rpc.preprod.midnight.network`
- Faucet: https://faucet.preprod.midnight.network/

## Commands

| Command | Description |
|---------|-------------|
| `npm run compile` | Compile the Compact contract |
| `npm run deploy` | Deploy contract to Preprod |
| `npm run cli` | Interactive CLI |
| `npm run proof-server:start` | Start proof server (Docker) |
| `npm run proof-server:stop` | Stop proof server |

## License

MIT
