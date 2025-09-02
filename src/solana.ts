import * as web3 from '@solana/web3.js';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import * as nacl from 'tweetnacl';

const payMaster = import.meta.env.VITE_WALLET_PAY_MASTER;
const connection = new web3.Connection(import.meta.env.VITE_SOLANA_RPC_URL || '');

const feePayer = web3.Keypair.fromSecretKey(
    bs58.decode(payMaster || '')
);

export const feePayerHandler = async (serializedTransaction: Uint8Array) => {
    try {
        // Check fee payer balance first - they need to cover ALL costs in gasless mode
        const feePayerBalance = await connection.getBalance(feePayer.publicKey);
        console.log('Fee payer balance:', feePayerBalance, 'lamports (', feePayerBalance / web3.LAMPORTS_PER_SOL, 'SOL)');
        console.log('Fee payer address:', feePayer.publicKey.toBase58());
        
        // Higher minimum balance check for gasless mode (transaction fees + account creation)
        const minimumRequiredBalance = 10000000; // 0.01 SOL in lamports for all costs
        if (feePayerBalance < minimumRequiredBalance) {
            console.error('Fee payer has insufficient balance for gasless transaction!');
            return {
                success: false,
                error: `Fee payer has insufficient balance for gasless transaction. Current: ${feePayerBalance / web3.LAMPORTS_PER_SOL} SOL, Minimum required: ${minimumRequiredBalance / web3.LAMPORTS_PER_SOL} SOL. The fee payer must cover all transaction fees AND token account creation costs.`,
                needsTopUp: true,
                currentBalance: feePayerBalance,
                requiredBalance: minimumRequiredBalance,
                feePayerAddress: feePayer.publicKey.toBase58()
            };
        }
        
        const transaction = web3.VersionedTransaction.deserialize(serializedTransaction);
        
        // Log current signatures and transaction details
        console.log('Original signatures:', transaction.signatures.map(sig => bs58.encode(sig)));
        console.log('FeePayer public key:', feePayer.publicKey.toBase58());
        console.log('Message static account keys:', transaction.message.staticAccountKeys.map(key => key.toBase58()));
        console.log('Required signers count:', transaction.message.header.numRequiredSignatures);
        
        // Find the fee payer's position in the account keys
        const feePayerIndex = transaction.message.staticAccountKeys.findIndex(
            key => key.equals(feePayer.publicKey)
        );
        
        console.log('Fee payer index in account keys:', feePayerIndex);
        
        if (feePayerIndex === -1) {
            throw new Error('Fee payer not found in transaction account keys - gasless transaction setup failed');
        }

        // Create a fresh transaction to ensure proper signing
        const messageToSign = transaction.message.serialize();
        const feePayerSignature = nacl.sign.detached(messageToSign, feePayer.secretKey);
        
        // Clear existing signatures and re-add them in the correct order
        transaction.signatures = new Array(transaction.message.header.numRequiredSignatures).fill(new Uint8Array(64));
        
        // Add fee payer signature at its correct position
        transaction.signatures[feePayerIndex] = Buffer.from(feePayerSignature);
        
        // Copy the user's signature from the original transaction
        const originalSignatures = web3.VersionedTransaction.deserialize(serializedTransaction).signatures;
        if (originalSignatures.length > 0) {
            // Find the user's signature position
            const userSignatureIndex = feePayerIndex === 0 ? 1 : 0;
            if (userSignatureIndex < transaction.signatures.length && originalSignatures.length > userSignatureIndex) {
                transaction.signatures[userSignatureIndex] = originalSignatures[userSignatureIndex];
            }
        }
        
        console.log('Final signatures after proper ordering:', transaction.signatures.map(sig => bs58.encode(sig)));

        // Validate transaction before sending
        console.log('Gasless transaction validation:');
        console.log('- Message payer (fee payer):', transaction.message.staticAccountKeys[0].toBase58());
        console.log('- Number of signatures:', transaction.signatures.length);
        console.log('- Required signers count:', transaction.message.header.numRequiredSignatures);
        console.log('- Fee payer covers all costs including token account creation');
        
        // Get transaction fee estimate
        try {
            const feeForMessage = await connection.getFeeForMessage(transaction.message);
            console.log('Estimated transaction fee:', feeForMessage?.value, 'lamports');
            
            // In gasless mode, add buffer for account creation costs
            const totalEstimatedCost = (feeForMessage?.value || 0) + 5000000; // Add 0.005 SOL buffer for account creation
            
            if (feePayerBalance < totalEstimatedCost) {
                return {
                    success: false,
                    error: `Insufficient balance for gasless transaction. Balance: ${feePayerBalance} lamports, Estimated total cost (fees + account creation): ${totalEstimatedCost} lamports`,
                    needsTopUp: true,
                    currentBalance: feePayerBalance,
                    requiredBalance: totalEstimatedCost,
                    feePayerAddress: feePayer.publicKey.toBase58()
                };
            }
        } catch (feeError) {
            console.warn('Could not estimate transaction fee:', feeError);
        }
        
        const signature = await connection.sendTransaction(transaction, {
            skipPreflight: false,
            maxRetries: 3,
        });

        console.log('Gasless transaction sent from backend, signature:', signature);

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        await connection.confirmTransaction({
            signature,
            blockhash,
            lastValidBlockHeight
        }, 'confirmed');

        console.log('Gasless transaction confirmed from backend, signature:', signature);
        return {
            success: true,
            transactionSignature: signature,
            explorerUrl: `https://solscan.io/tx/${signature}`,
            feePayerBalance: feePayerBalance,
            message: 'Gasless swap completed successfully! Fee payer covered all costs.'
        };

    } catch (error) {
        console.log(`gasless transaction error ====🚀`, error);
        
        // Enhanced error handling for gasless transactions
        if (error instanceof Error) {
            if (error.message.includes('insufficient lamports') || error.message.includes('insufficient funds')) {
                const feePayerBalance = await connection.getBalance(feePayer.publicKey);
                return {
                    success: false,
                    error: `Gasless transaction failed: Fee payer has insufficient funds to cover all costs. The fee payer needs more SOL to cover both transaction fees and token account creation (~0.005-0.01 SOL total). Current fee payer balance: ${feePayerBalance / web3.LAMPORTS_PER_SOL} SOL`,
                    needsTopUp: true,
                    currentBalance: feePayerBalance,
                    feePayerAddress: feePayer.publicKey.toBase58(),
                    requiredBalance: 10000000 // 0.01 SOL
                };
            }
            
            if (error.message.includes('Transaction simulation failed')) {
                return {
                    success: false,
                    error: `Gasless transaction simulation failed: ${error.message}. This usually indicates the fee payer cannot cover all required costs or there's an issue with the transaction setup.`,
                    simulationFailed: true,
                    needsTopUp: true,
                    feePayerAddress: feePayer.publicKey.toBase58()
                };
            }
            
            if (error.message.includes('Signature verification failed')) {
                return {
                    success: false,
                    error: `Gasless transaction signature verification failed. This indicates an issue with transaction signing order or invalid signatures in the gasless setup.`,
                    signatureError: true
                };
            }
        }
        
        return {
            success: false,
            error: `Gasless transaction failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            needsTopUp: false,
            currentBalance: 0,
            requiredBalance: 0
        };
    }
}