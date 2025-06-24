import { useEffect, useState } from 'react'
import { useLogin, useLogout, usePrivy } from '@privy-io/react-auth'
import { swapHandler } from './solana';
import { useSignMessage } from '@privy-io/react-auth/solana';
import {
    Connection,
    PublicKey,
    TransactionMessage,
    VersionedTransaction,
    TransactionInstruction,
    AddressLookupTableAccount,
} from '@solana/web3.js';

const connection = new Connection(import.meta.env.VITE_SOLANA_RPC_URL || '');
const FEE_PAYER_PUBLIC_KEY_STRING = import.meta.env.VITE_WALLET_PAY_MASTER_PUBLIC_KEY;

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

function App() {
    const { login } = useLogin();
    const { signMessage } = useSignMessage();
    const { logout } = useLogout();
    const { user, ready, authenticated } = usePrivy();
    const handleSocialLogin = async () => {
        if (!authenticated) {
            login({
                loginMethods: ['email'],
                walletChainType: 'solana-only'
            });
        }
    };

    const handleLogout = async () => {
        logout();
    };

    useEffect(() => {
        if (ready && authenticated) {
            handleSocialLogin();
            localStorage.setItem("user", JSON.stringify(user));
        }
    }, [ready, authenticated]);

    const [fromTokenAddress, setFromTokenAddress] = useState('')
    const [toTokenAddress, setToTokenAddress] = useState('')
    const [amount, setAmount] = useState('')
    const [quote, setQuote] = useState<JupiterSwapApiResponse | null>(null);
    const [slippageBps, setSlippageBps] = useState('');  
    const handleSubmit = async () => {
        try {
            if (fromTokenAddress && toTokenAddress && amount) {

                const params = new URLSearchParams({
                    inputMint: fromTokenAddress,
                    outputMint: toTokenAddress,
                    amount: (Number(amount) * 1000000).toString(),
                    slippageBps: slippageBps,
                });
                const quoteResponse = await fetch(`https://quote-api.jup.ag/v6/quote?${params.toString()}`);
                if (!quoteResponse.ok) {
                    throw new Error(`Jupiter quote API error: ${await quoteResponse.text()}`);
                }
                const fetchedQuote = await quoteResponse.json();
                setQuote(fetchedQuote);
                handleSwap(fetchedQuote); // Pass the fresh quote directly
                console.log('Jupiter Quote:', fetchedQuote);

                setFromTokenAddress('')
                setToTokenAddress('')
                setAmount('')
            } else {
                alert('Please fill in all fields')
            }
        } catch (error) {
            console.error('Failed to fetch Jupiter quote:', error);
            setQuote(null);
        }
    }

    const handleSwap = async (freshQuote?: any) => {
        try {
            const privyWalletPublicKey = new PublicKey(user?.wallet?.address || '');
            const feePayerPublicKey = new PublicKey(FEE_PAYER_PUBLIC_KEY_STRING);

            const quoteToUse = freshQuote || quote;

            if (!quoteToUse) {
                throw new Error('No quote available for swap');
            }

            // For gasless transactions, user doesn't need SOL - remove balance check
            console.log("privyWalletPublicKey", privyWalletPublicKey);
            const userBalance = await connection.getBalance(privyWalletPublicKey);
            console.log('User wallet balance:', userBalance, 'lamports (', userBalance / 1000000000, 'SOL)');
            console.log('User wallet address:', privyWalletPublicKey.toBase58());
            console.log('Fee payer will cover all costs including token account rent');

            // 1. Get Jupiter's swap instructions (not full transaction) to have more control
            const swapInstructionsPayload = {
                quoteResponse: quoteToUse,
                userPublicKey: privyWalletPublicKey.toBase58(),
                wrapAndUnwrapSol: true,
            };

            const swapInstructionsResponse = await fetch('https://quote-api.jup.ag/v6/swap-instructions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(swapInstructionsPayload),
            });

            if (!swapInstructionsResponse.ok) {
                throw new Error(`Jupiter swap-instructions API error: ${await swapInstructionsResponse.text()}`);
            }

            const swapInstructionsData = await swapInstructionsResponse.json();
            console.log("swapInstructionsData", swapInstructionsData);

            // 2. Get fresh blockhash
            const { blockhash } = await connection.getLatestBlockhash();

            // 3. Helper function to deserialize instructions and modify for gasless pattern
            const deserializeInstruction = (instruction: any) => {
                return new TransactionInstruction({
                    programId: new PublicKey(instruction.programId),
                    keys: instruction.accounts.map((key: any) => ({
                        pubkey: new PublicKey(key.pubkey),
                        isSigner: key.isSigner,
                        isWritable: key.isWritable,
                    })),
                    data: Buffer.from(instruction.data, "base64"),
                });
            };

            // 4. Modify setup instructions to use fee payer for account creation
            const modifyInstructionForGasless = (instruction: TransactionInstruction) => {
                // Check if this is an account creation instruction (System Program or Associated Token Program)
                const systemProgramId = new PublicKey("11111111111111111111111111111111");
                const associatedTokenProgramId = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
                
                if (instruction.programId.equals(systemProgramId) || instruction.programId.equals(associatedTokenProgramId)) {
                    // For account creation instructions, make sure fee payer is the funding source
                    return new TransactionInstruction({
                        programId: instruction.programId,
                        keys: instruction.keys.map(key => {
                            // If this account is the funding source and it's the user, change to fee payer
                            if (key.pubkey.equals(privyWalletPublicKey) && key.isWritable && key.isSigner) {
                                return {
                                    pubkey: feePayerPublicKey,
                                    isSigner: true,
                                    isWritable: true
                                };
                            }
                            return key;
                        }),
                        data: instruction.data,
                    });
                }
                return instruction;
            };

            // 5. Build all instructions with gasless modifications
            const allInstructions = [];

            // Add compute budget instructions
            if (swapInstructionsData.computeBudgetInstructions) {
                allInstructions.push(...swapInstructionsData.computeBudgetInstructions.map(deserializeInstruction));
            }

            // Add setup instructions with gasless modifications
            if (swapInstructionsData.setupInstructions) {
                swapInstructionsData.setupInstructions.forEach((setupIx: any) => {
                    const instruction = deserializeInstruction(setupIx);
                    const modifiedInstruction = modifyInstructionForGasless(instruction);
                    allInstructions.push(modifiedInstruction);
                });
            }

            // Add the main swap instruction
            if (swapInstructionsData.swapInstruction) {
                allInstructions.push(deserializeInstruction(swapInstructionsData.swapInstruction));
            }

            // Add cleanup instructions
            if (swapInstructionsData.cleanupInstruction) {
                allInstructions.push(deserializeInstruction(swapInstructionsData.cleanupInstruction));
            }

            // 6. Get Address Lookup Table accounts
            const getAddressLookupTableAccounts = async (keys: string[]) => {
                if (!keys || keys.length === 0) return [];

                const addressLookupTableAccountInfos = await connection.getMultipleAccountsInfo(
                    keys.map((key: string) => new PublicKey(key))
                );

                return addressLookupTableAccountInfos.reduce((acc: AddressLookupTableAccount[], accountInfo, index) => {
                    const addressLookupTableAddress = keys[index];
                    if (accountInfo) {
                        try {
                            const addressLookupTableAccount = new AddressLookupTableAccount({
                                key: new PublicKey(addressLookupTableAddress),
                                state: AddressLookupTableAccount.deserialize(accountInfo.data),
                            });
                            acc.push(addressLookupTableAccount);
                        } catch (error) {
                            console.warn(`Failed to create ALT account for ${addressLookupTableAddress}:`, error);
                        }
                    }
                    return acc;
                }, []);
            };

            let addressLookupTableAccounts: AddressLookupTableAccount[] = [];
            try {
                if (swapInstructionsData.addressLookupTableAddresses && swapInstructionsData.addressLookupTableAddresses.length > 0) {
                    addressLookupTableAccounts = await getAddressLookupTableAccounts(swapInstructionsData.addressLookupTableAddresses);
                }
            } catch (error) {
                console.warn('Failed to get ALT accounts, proceeding without them:', error);
            }

            // 7. Create transaction with fee payer as the payer for all costs
            const messageV0 = new TransactionMessage({
                payerKey: feePayerPublicKey, // Fee payer pays for everything
                recentBlockhash: blockhash,
                instructions: allInstructions,
            }).compileToV0Message(addressLookupTableAccounts);

            const transaction = new VersionedTransaction(messageV0);

            console.log('Gasless transaction payer:', transaction.message.staticAccountKeys[0].toBase58());
            console.log('Required signers:', transaction.message.header.numRequiredSignatures);
            console.log('All account keys:', transaction.message.staticAccountKeys.map(key => key.toBase58()));

            // 8. Have the user sign the transaction (they approve but don't pay)
            const serializedMessageToSign = Buffer.from(transaction.message.serialize());

            const signatureFromPrivy = await signMessage({
                message: new Uint8Array(serializedMessageToSign)
            });

            const userSignature = new Uint8Array(signatureFromPrivy);
            transaction.addSignature(privyWalletPublicKey, userSignature);
            
            // 9. Serialize and send to backend for fee payer signing
            const serializedTransaction = transaction.serialize();
            console.log('Serialized transaction type:', typeof serializedTransaction);
            console.log('Serialized transaction length:', serializedTransaction.length);
            
            const backendResponse = await swapHandler(serializedTransaction);
            console.log('Backend response:', backendResponse);
            
            if (backendResponse.success) {
                alert(`Gasless swap successful! 🎉\n\nTransaction signature: ${backendResponse.transactionSignature}\n\nYour tokens have been swapped without you paying any SOL fees!`);
                console.log('Transaction signature:', backendResponse.transactionSignature);
                console.log('Explorer URL:', backendResponse.explorerUrl);
            } else {
                if (backendResponse.needsTopUp) {
                    if (backendResponse.simulationFailed) {
                        alert(`This appears to be a user balance issue, but this should not happen in gasless mode.\n\nError: ${backendResponse.error}\n\nPlease check the transaction setup.`);
                    } else {
                        const currentBalanceSOL = (backendResponse.currentBalance || 0) / 1000000000;
                        const requiredBalanceSOL = (backendResponse.requiredBalance || 0) / 1000000000;
                        const shortfall = requiredBalanceSOL - currentBalanceSOL;
                        alert(`Fee payer needs funding!\n\nCurrent balance: ${currentBalanceSOL.toFixed(6)} SOL\nRequired: ${requiredBalanceSOL.toFixed(6)} SOL\nShortfall: ${shortfall.toFixed(6)} SOL\n\nFee payer address: ${backendResponse.feePayerAddress || 'N/A'}\n\nPlease fund this account before retrying the swap.`);
                    }
                } else {
                    alert(`Gasless swap failed: ${backendResponse.error}`);
                }
                console.error('Swap failed:', backendResponse.error);
            }
        } catch (error) {
            console.error('Gasless swap failed:', error);
            alert(`Error: ${(error as Error).message}`);
        }
    };


    if (!ready) {
        return <div>Loading...</div>;
    }

    return (
        <div className="app">
            <header className="app-header">
                <h1>Web3 App with Privy</h1>
                <p>A clean and simple user interface</p>
                {!authenticated ? (
                    <div>
                        <button onClick={handleSocialLogin}>Login with Email</button>
                    </div>
                ) : (
                    <div>
                        <button onClick={handleLogout}>Logout</button>
                    </div>
                )}
            </header >

            <main className="main-content">
                <div className="form-container">
                    <h3>Enter Your Information to get started</h3>
                    <h5>Main Wallet Address: {user?.wallet?.address}</h5>
                    <h5>USDC Address: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v</h5>
                    <h5>Swap Token Address: 5c74v6Px9RKwdGWCfqLGfEk7UZfE3Y4qJbuYrLbVG63V</h5>
                    <input
                        type="text"
                        placeholder="From Token Address"
                        value={fromTokenAddress}
                        onChange={(e) => setFromTokenAddress(e.target.value)}
                    />
                    <input
                        type="text"
                        placeholder="To Token Address"
                        value={toTokenAddress}
                        onChange={(e) => setToTokenAddress(e.target.value)}
                    />
                    <input
                        type="text"
                        placeholder="500000= 0.5$"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                    />
                    <input
                        type="text"
                        placeholder="Slippage Bps (0.5% = 500, 1% = 1000, 2% = 2000)"
                        value={slippageBps}
                        onChange={(e) => setSlippageBps(e.target.value)}
                    />
                    <button onClick={handleSubmit} className="submit-btn">
                        Swap
                    </button>
                </div>
            </main>
        </div >
    )
}

export default App