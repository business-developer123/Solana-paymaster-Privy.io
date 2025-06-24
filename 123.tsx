// --- React Component (e.g., SolanaSwapComponent.tsx) ---
import React, { useState, useEffect } from 'react';
import { useSolanaWallets } from '@privy-io/react-auth/solana';
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  TransactionInstruction, // Import this
} from '@solana/web3.js';
import bs58 from 'bs58';

// --- Jupiter API ---
// You'll typically use their SDK or a fetch wrapper.
// This is a conceptual representation.
// import { Jupiter, RouteInfo, SwapMode } from '@jup-ag/api'; // Example import

// Your RPC endpoint
const SOLANA_RPC_URL = 'https://api.devnet.solana.com'; // Or your preferred RPC (e.g., Helius, Triton)
const connection = new Connection(SOLANA_RPC_URL);

// PUBLIC KEY of your fee paymaster wallet (from backend)
const FEE_PAYER_PUBLIC_KEY_STRING = 'YOUR_FEE_PAYMASTER_WALLET_PUBLIC_KEY';

// Example: USDC to SOL on Devnet
const INPUT_MINT_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
const OUTPUT_MINT_ADDRESS = 'So11111111111111111111111111111111111111112'; // SOL

interface JupiterSwapApiResponse {
  computeUnitLimit?: number;
  setupTransaction?: string; // Base64 encoded, optional
  swapTransaction: string;  // Base64 encoded
  cleanupTransaction?: string; // Base64 encoded, optional
  // For /swap-instructions, it might return instructions directly
  // and address lookup table accounts
  instructions?: {
    computeBudgetInstructions: any[]; // from @solana/web3.js TransactionInstruction
    setupInstructions: any[];
    swapInstruction: any;
    cleanupInstructions: any[];
  };
  addressLookupTableAddresses?: string[];
}


function SolanaSwapWithJupiter() {
  const { wallets, ready, connectWallet, signMessage } = useSolanaWallets(); // use signMessage from here
  const [isLoading, setIsLoading] = useState(false);
  const [amount, setAmount] = useState('0.01'); // Example: 0.01 USDC
  const [quote, setQuote] = useState<any | null>(null); // To store Jupiter quote

  const privyWallet = wallets.find(wallet => wallet.walletClientType === 'privy' && wallet.isConnected);

  // Function to fetch quote from Jupiter
  const fetchJupiterQuote = async () => {
    if (!privyWallet) return;
    setIsLoading(true);
    try {
      // Convert amount to smallest unit (e.g., lamports for SOL, or smallest unit for USDC)
      // This depends on the input token's decimals. For USDC (6 decimals):
      const inputAmountInSmallestUnit = Math.round(parseFloat(amount) * Math.pow(10, 6));

      // --- Replace with actual Jupiter SDK/API call for /quote ---
      const params = new URLSearchParams({
        inputMint: INPUT_MINT_ADDRESS,
        outputMint: OUTPUT_MINT_ADDRESS,
        amount: inputAmountInSmallestUnit.toString(),
        slippageBps: '50', // 0.5% slippage
        // onlyDirectRoutes: 'false',
        // asLegacyTransaction: 'false', // Important for VersionedTransactions
      });
      const quoteResponse = await fetch(`https://quote-api.jup.ag/v6/quote?${params.toString()}`);
      if (!quoteResponse.ok) {
        throw new Error(`Jupiter quote API error: ${await quoteResponse.text()}`);
      }
      const fetchedQuote = await quoteResponse.json();
      setQuote(fetchedQuote); // Assuming 'fetchedQuote' is the direct response or relevant part
      console.log('Jupiter Quote:', fetchedQuote);
      // --- End Jupiter quote call ---
    } catch (error) {
      console.error('Failed to fetch Jupiter quote:', error);
      alert(`Error fetching quote: ${error.message}`);
      setQuote(null);
    } finally {
      setIsLoading(false);
    }
  };


  const handleSwap = async () => {
  const handleSwap = async () => {
    if (!privyWallet || !quote) {
      alert('Privy wallet not connected or no quote available!');
      return;
    }
    setIsLoading(true);

    try {
      const privyWalletPublicKey = new PublicKey(privyWallet.address);
      const feePayerPublicKey = new PublicKey(FEE_PAYER_PUBLIC_KEY_STRING);

      // 1. Get Swap Transaction/Instructions from Jupiter
      // This uses the quote obtained earlier.
      // --- Replace with actual Jupiter SDK/API call for /swap or /swap-instructions ---
      const swapPayload = {
        quoteResponse: quote,
        userPublicKey: privyWalletPublicKey.toBase58(),
        wrapAndUnwrapSol: true,
        // feeAccount: "YOUR_PLATFORM_FEE_ACCOUNT_IF_ANY" // Optional platform fee
        // asLegacyTransaction: false, // Ensure VersionedTransaction parts are returned
        computeUnitPriceMicroLamports: 'auto', // Or a specific value
      };

      const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(swapPayload),
      });
      if (!swapResponse.ok) {
        throw new Error(`Jupiter swap API error: ${await swapResponse.text()}`);
      }
      const jupiterSwapData: JupiterSwapApiResponse = await swapResponse.json();
      // --- End Jupiter swap call ---

      // 2. Get the latest blockhash
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

      // 3. Deserialize instructions from Jupiter's response
      //    Jupiter's /swap endpoint returns base64 encoded serialized transactions.
      //    We need to deserialize the main swapTransaction.
      //    If setup/cleanup transactions are present, they might need to be handled too,
      //    potentially as separate transactions or combined if possible (more complex).
      //    For simplicity, focusing on the main `swapTransaction`.

      //    A more robust approach is to use Jupiter's /swap-instructions endpoint
      //    which gives you raw instructions. If using /swap and it gives a full transaction,
      //    we need to extract its message and rebuild with our feePayer.

      //    Let's assume jupiterSwapData.swapTransaction is a base64 string of a VersionedTransaction
      const swapTransactionBuf = Buffer.from(jupiterSwapData.swapTransaction, 'base64');
      const versionedJupiterTx = VersionedTransaction.deserialize(swapTransactionBuf);

      // Extract instructions from Jupiter's transaction message
      const jupiterInstructions = versionedJupiterTx.message.compiledInstructions.map(ix => new TransactionInstruction({
          programId: versionedJupiterTx.message.staticAccountKeys[ix.programIdIndex],
          keys: ix.accountKeyIndexes.map(keyIndex => ({
              pubkey: versionedJupiterTx.message.staticAccountKeys[keyIndex],
              isSigner: versionedJupiterTx.message.isAccountSigner(keyIndex),
              isWritable: versionedJupiterTx.message.isAccountWritable(keyIndex),
          })),
          data: Buffer.from(ix.data),
      }));

      // If Jupiter provides compute budget instructions separately (e.g. from /swap-instructions)
      // you would add them here. The /swap endpoint's transaction should already include them.
      // Example:
      // const computeBudgetProgramId = new PublicKey("ComputeBudget111111111111111111111111111111");
      // const setComputeUnitLimitIx = new TransactionInstruction({ ... }); // From jupiterSwapData.instructions.computeBudgetInstructions
      // const setComputeUnitPriceIx = new TransactionInstruction({ ... });

      const allInstructions = [
        // ...(jupiterSwapData.instructions?.computeBudgetInstructions || []), // If using /swap-instructions
        // ...(jupiterSwapData.instructions?.setupInstructions || []),
        ...jupiterInstructions, // Instructions from the core swap
        // ...(jupiterSwapData.instructions?.cleanupInstructions || []),
      ];


      // 4. Create the transaction message with YOUR feePayer
      const messageV0 = new TransactionMessage({
        payerKey: feePayerPublicKey, // Your fee paymaster wallet
        recentBlockhash: blockhash,
        instructions: allInstructions,
      }).compileToV0Message(
        // Pass Address Lookup Tables if Jupiter provides them (from /swap or /swap-instructions)
        // await getAddressLookupTableAccounts(jupiterSwapData.addressLookupTableAddresses || [])
      );

      const transaction = new VersionedTransaction(messageV0);

      // 5. Have the user (Privy Wallet) sign the transaction's *message*
      const serializedMessageToSign = Buffer.from(transaction.message.serialize());

      // Use the signMessage hook from useSolanaWallets
      const signatureFromPrivy = await signMessage(bs58.encode(serializedMessageToSign));
      // The hook expects a Uint8Array or string. bs58 encode is common for Solana messages.
      // If it expects raw bytes: await signMessage(serializedMessageToSign);
      // If it expects base64: await signMessage(serializedMessageToSign.toString('base64'));
      // Check Privy's exact expectation for `signMessage` payload.
      // The documentation for sponsored tx shows `provider.request({method: 'signMessage', params: {message: serializedMessage}})`
      // where serializedMessage was `Buffer.from(transaction.message.serialize()).toString('base64')`.
      // So, let's assume base64 for the direct hook too, or use the provider method.

      // Alternative using the provider directly (closer to Privy's sponsored tx guide):
      // const privyProvider = await privyWallet.getProvider();
      // const { signature: base64UserSignature } = await privyProvider.request({
      //   method: 'signMessage',
      //   params: { message: serializedMessageToSign.toString('base64') }
      // });
      // const userSignature = Buffer.from(base64UserSignature, 'base64');

      // Assuming `signMessage` hook returns base64 string signature:
      const userSignature = Buffer.from(signatureFromPrivy, 'base64');


      // 6. Add the user's signature to the transaction
      transaction.addSignature(privyWalletPublicKey, userSignature);

      // 7. Serialize the transaction to send to your backend
      const serializedTransaction = Buffer.from(transaction.serialize()).toString('base64');

      // 8. Send to your backend
      const backendResponse = await fetch('YOUR_BACKEND_ENDPOINT/sign-and-send-solana', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serializedTransaction }),
      });

      if (!backendResponse.ok) {
        const errorData = await backendResponse.json();
        throw new Error(errorData.error || 'Backend signing failed');
      }

      const { transactionSignature } = await backendResponse.json();
      alert(`Swap submitted! Signature: ${transactionSignature}`);
      console.log('Transaction signature:', transactionSignature);

      // Optional: Monitor transaction confirmation
      await connection.confirmTransaction({ signature: transactionSignature, blockhash, lastValidBlockHeight });
      console.log('Transaction confirmed!');


    } catch (error) {
      console.error('Swap failed:', error);
      alert(`Error: ${(error as Error).message}`);
    } finally {
      setIsLoading(false);
    }
  };

 

  if (!ready) return <p>Loading Privy...</p>;

  return (
    <div>
      {!privyWallet ? (
        <button onClick={connectWallet}>Connect Privy Wallet</button>
      ) : (
        <div>
          <p>Privy Wallet: {privyWallet.address}</p>
          <div>
            <label>
              Amount to swap (USDC):
              <input type="text" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <button onClick={fetchJupiterQuote} disabled={isLoading}>
              {isLoading && !quote ? 'Fetching Quote...' : 'Get Jupiter Quote'}
            </button>
          </div>
          {quote && (
            <div>
              <p>
                Will receive approx: {parseFloat(quote.outAmount) / Math.pow(10, 9)} SOL {/* Assuming SOL (9 decimals) */}
                (Route: {quote.routePlan?.map((r:any) => r.swapInfo.label).join(' -> ')})
              </p>
              <button onClick={handleSwap} disabled={isLoading}>
                {isLoading ? 'Processing Swap...' : 'Perform Swap with Jupiter'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SolanaSwapWithJupiter;