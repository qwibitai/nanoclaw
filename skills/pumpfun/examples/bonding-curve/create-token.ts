/**
 * PumpFun: Create Token on Bonding Curve
 *
 * This example demonstrates how to create a new token with a bonding curve.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import * as fs from 'fs';

// Program IDs
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// Configuration
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

// PDA derivation functions
function getGlobalPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global')],
    PUMP_PROGRAM_ID
  );
}

function getBondingCurvePDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
}

function getAssociatedBondingCurvePDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('associated-bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
}

function getMetadataPDA(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    METADATA_PROGRAM_ID
  );
}

// Build create instruction data
function buildCreateInstructionData(
  name: string,
  symbol: string,
  uri: string
): Buffer {
  const nameBuffer = Buffer.from(name);
  const symbolBuffer = Buffer.from(symbol);
  const uriBuffer = Buffer.from(uri);

  // Discriminator for 'create' instruction (first 8 bytes of sha256("global:create"))
  const discriminator = Buffer.from([0x18, 0x1e, 0xc8, 0x28, 0x05, 0x1c, 0x07, 0x77]);

  const data = Buffer.alloc(
    8 + 4 + nameBuffer.length + 4 + symbolBuffer.length + 4 + uriBuffer.length
  );

  let offset = 0;

  // Write discriminator
  discriminator.copy(data, offset);
  offset += 8;

  // Write name (length-prefixed)
  data.writeUInt32LE(nameBuffer.length, offset);
  offset += 4;
  nameBuffer.copy(data, offset);
  offset += nameBuffer.length;

  // Write symbol (length-prefixed)
  data.writeUInt32LE(symbolBuffer.length, offset);
  offset += 4;
  symbolBuffer.copy(data, offset);
  offset += symbolBuffer.length;

  // Write URI (length-prefixed)
  data.writeUInt32LE(uriBuffer.length, offset);
  offset += 4;
  uriBuffer.copy(data, offset);

  return data;
}

// Load wallet from file
function loadWallet(path: string): Keypair {
  const secretKey = JSON.parse(fs.readFileSync(path, 'utf-8'));
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

// Main create token function
async function createToken(
  connection: Connection,
  payer: Keypair,
  name: string,
  symbol: string,
  uri: string
): Promise<{ mint: PublicKey; signature: string }> {
  console.log('\n=== Creating Token on PumpFun ===');
  console.log('Name:', name);
  console.log('Symbol:', symbol);
  console.log('URI:', uri);

  // Generate new mint keypair
  const mint = Keypair.generate();
  console.log('\nMint address:', mint.publicKey.toString());

  // Derive PDAs
  const [global] = getGlobalPDA();
  const [bondingCurve] = getBondingCurvePDA(mint.publicKey);
  const [associatedBondingCurve] = getAssociatedBondingCurvePDA(mint.publicKey);
  const [metadata] = getMetadataPDA(mint.publicKey);

  console.log('Bonding curve:', bondingCurve.toString());
  console.log('Associated bonding curve:', associatedBondingCurve.toString());

  // Build instruction data
  const data = buildCreateInstructionData(name, symbol, uri);

  // Build instruction
  const instruction = new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: mint.publicKey, isSigner: true, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: true },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: global, isSigner: false, isWritable: false },
      { pubkey: METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });

  // Build and send transaction
  const tx = new Transaction().add(instruction);
  tx.feePayer = payer.publicKey;

  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  console.log('\nSending transaction...');

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [payer, mint],
    { commitment: 'confirmed' }
  );

  console.log('\n=== Token Created Successfully ===');
  console.log('Signature:', signature);
  console.log('Mint:', mint.publicKey.toString());
  console.log('\nView on Solscan:');
  console.log(`https://solscan.io/token/${mint.publicKey.toString()}`);

  return {
    mint: mint.publicKey,
    signature,
  };
}

// Example usage
async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');

  // Load wallet
  const walletPath = process.env.WALLET_PATH || './keypair.json';
  const wallet = loadWallet(walletPath);
  console.log('Wallet:', wallet.publicKey.toString());

  // Check balance
  const balance = await connection.getBalance(wallet.publicKey);
  console.log('Balance:', balance / 1e9, 'SOL');

  if (balance < 0.05 * 1e9) {
    throw new Error('Insufficient balance. Need at least 0.05 SOL');
  }

  // Create token
  const result = await createToken(
    connection,
    wallet,
    'My Test Token',
    'MTT',
    'https://arweave.net/your-metadata-uri'
  );

  console.log('\nResult:', result);
}

// Run
main().catch(console.error);
