// --- Backend Example (Node.js/Express) ---
// Ensure you have @solana/web3.js and express, bs58 installed
// npm install express @solana/web3.js bs58 body-parser
const express = require('express');
const bodyParser = require('body-parser');
const { Connection, Keypair, VersionedTransaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');

const app = express();
app.use(bodyParser.json());

const SOLANA_RPC_ENDPOINT = 'https://api.devnet.solana.com'; // Match your frontend
const connection = new Connection(SOLANA_RPC_ENDPOINT);

// SECURELY load your fee paymaster's private key.
// NEVER hardcode it directly in production code. Use environment variables or a secret manager.
const FEE_PAYMASTER_PRIVATE_KEY_BS58 = process.env.FEE_PAYMASTER_SOLANA_PRIVATE_KEY;
if (!FEE_PAYMASTER_PRIVATE_KEY_BS58) {
  throw new Error("FEE_PAYMASTER_SOLANA_PRIVATE_KEY environment variable not set!");
}
const feePayerKeypair = Keypair.fromSecretKey(bs58.decode(FEE_PAYMASTER_PRIVATE_KEY_BS58));

app.post('/sign-and-send-solana', async (req, res) => {
  const { serializedTransaction } = req.body;

  if (!serializedTransaction) {
    return res.status(400).json({ error: 'Missing serializedTransaction' });
  }

  try {
    // 1. Deserialize the transaction
    const transaction = VersionedTransaction.deserialize(Buffer.from(serializedTransaction, 'base64'));

    // 2. Sign the transaction with the feePayer's Keypair
    //    The transaction already has the user's signature (added on the frontend).
    //    The feePayer (this backend wallet) must be the first signer if it's the payerKey.
    //    The `sign` method on VersionedTransaction takes an array of signers.
    //    Since the user's signature is already on it, we just need the fee payer's.
    transaction.sign([feePayerKeypair]); // The feePayerKeypair signs its part

    // 3. Send and confirm the transaction
    //    Using sendAndConfirmTransaction for simplicity here.
    //    For production, you might want more robust error handling and retry mechanisms.
    const signature = await connection.sendTransaction(transaction, {
        // skipPreflight: true, // Optional: useful for testing, but be cautious in prod
    });

    console.log('Transaction sent from backend, signature:', signature);

    // Optional: Confirm transaction (can take time)
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight
    }, 'confirmed'); // Or 'processed' or 'finalized'

    console.log('Transaction confirmed from backend, signature:', signature);
    res.json({ transactionSignature: signature });

  } catch (error) {
    console.error('Backend - Error processing transaction:', error);
    res.status(500).json({ error: error.message || 'Failed to sign or send transaction' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
  console.log(`Fee Payer Address: ${feePayerKeypair.publicKey.toBase58()}`);
});