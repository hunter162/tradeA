import {createRequire} from 'module';

const require = createRequire(import.meta.url);
import pkg from 'pumpdotfun-sdk';
import {AnchorProvider, BorshCoder, Program} from "@coral-xyz/anchor";
const {PumpFunSDK, GlobalAccount} = pkg;
import {logger} from '../utils/index.js';
import {PinataService} from './pinataService.js';
import {config} from '../../config/index.js';
import fs from 'fs/promises';

import {
    Transaction as SolanaTransaction,
    SystemProgram,
    LAMPORTS_PER_SOL,
    SYSVAR_RENT_PUBKEY,
    PublicKey,
    ComputeBudgetProgram,
    Keypair, Transaction,
    TransactionInstruction
} from '@solana/web3.js';
import {
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction
} from '@solana/spl-token';
import BN from 'bn.js';
import {JitoService, NOZOMI_CONFIG} from './jitoService.js';
import axios from 'axios';
import bs58 from 'bs58';
import {Connection} from '@solana/web3.js';
import WebSocket from 'ws';
import https from 'https';
import {WebSocketManager} from './webSocketManager.js';
import {SolanaService} from './solanaService.js';
import {sendAndConfirmTransaction} from '@solana/web3.js';
import idlModule from 'pumpdotfun-sdk/dist/cjs/IDL/index.js';
const { IDL } = idlModule;
const ACCOUNT_SIZES = {
    BondingCurve: 128,  // 8字节对齐的账户大小
    Global: 128        // 8字节对齐的账户大小
};
// 修改常量设置
const MIN_COMPUTE_UNITS = 200_000;  // 保持计算单元不变
const BASE_PRIORITY_RATE = 1;       // 每个计算单元 1 microLamport

// 添加常量定义
const TOKEN_METADATA_PROGRAM_ID = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

// 添加网络拥堵检测方法
async function getNetworkCongestion() {
    try {
        // 获取最近的区块生产时间
        const slot = await this.connection.getSlot();
        const times = await this.connection.getBlockTime(slot);
        const prevTimes = await this.connection.getBlockTime(slot - 1);

        // 计算区块间隔
        const blockInterval = times - prevTimes;

        // 获取最近交易的确认时间
        const recentPerformanceSamples = await this.connection.getRecentPerformanceSamples(1);
        const avgConfirmationTime = recentPerformanceSamples[0]?.mean || 0;

        // 根据区块间隔和确认时间评估拥堵程度
        if (blockInterval > 0.8 || avgConfirmationTime > 2000) {
            return 'high';        // 高度拥堵
        } else if (blockInterval > 0.6 || avgConfirmationTime > 1000) {
            return 'medium';      // 中度拥堵
        } else {
            return 'low';         // 正常
        }
    } catch (error) {
        logger.warn('获取网络拥堵状态失败，使用默认中等拥堵级别', error);
        return 'medium';
    }
}

// 修改优先费计算
async function calculatePriorityFee() {
    const congestion = await getNetworkCongestion();

    // 根据拥堵程度调整优先费率
    switch (congestion) {
        case 'high':
            return BASE_PRIORITY_RATE * 4;  // 400K
        case 'medium':
            return BASE_PRIORITY_RATE * 2;  // 200K
        case 'low':
            return BASE_PRIORITY_RATE;      // 50K
        default:
            return BASE_PRIORITY_RATE * 2;  // 默认中等
    }
}

// 添加恒定乘积计算器类
class TokenLaunchCalculator {
    constructor(initialSolReserves, initialTokenReserves) {
        this.initialSolReserves = initialSolReserves;
        this.initialTokenReserves = initialTokenReserves;
        this.currentSolReserves = initialSolReserves;
    }

    // 计算买入价格
    calculateBuyPrice(solAmount) {
        // 使用恒定乘积公式: k = sol * token
        const k = this.currentSolReserves.mul(this.initialTokenReserves);
        const newSol = this.currentSolReserves.add(solAmount);
        const newTokens = k.div(newSol);
        return this.initialTokenReserves.sub(newTokens);
    }

    // 计算卖出价格
    calculateSellPrice(tokenAmount) {
        const k = this.currentSolReserves.mul(this.initialTokenReserves);
        const newTokens = this.initialTokenReserves.sub(tokenAmount);
        const newSol = k.div(newTokens);
        return newSol.sub(this.currentSolReserves);
    }
}
class CustomWallet {
    constructor(keypair) {
        this.keypair = keypair;
    }

    get publicKey() {
        return this.keypair.publicKey;
    }

    async signTransaction(tx) {
        tx.partialSign(this.keypair);
        return tx;
    }

    async signAllTransactions(txs) {
        txs.forEach(tx => tx.partialSign(this.keypair));
        return txs;
    }
}
// 不继承 PumpSDK，而是作为组合使用
export class CustomPumpSDK extends PumpFunSDK {
    constructor(options = {}) {
        const connection = options.connection || new Connection(
            options.rpcEndpoint || 'https://api.mainnet-beta.solana.com',
            options.commitment || 'confirmed'
        );
        const tempKeypair = Keypair.generate();
        const wallet = new CustomWallet(tempKeypair);
        console.log('Current IDL:', JSON.stringify(IDL, null, 2));
        // 创建 coder
        const coder = new BorshCoder(IDL);

        // 创建 provider
        const defaultProvider = new AnchorProvider(
            connection,
            wallet,
            {
                commitment: options.commitment || 'confirmed',
                preflightCommitment: options.preflightCommitment || 'confirmed',
                skipPreflight: options.skipPreflight || false
            }
        );
        super(defaultProvider);
        this._coder = coder;
        this.provider = defaultProvider;  //
        this.solanaService = null;
        this.connection = connection;
        this.wsManager = new WebSocketManager(connection.rpcEndpoint);
        logger.info('SDK 初始化:', {
            hasIDL: !!IDL,
            hasAccounts: !!IDL.accounts,
            accountsCount: IDL.accounts?.length,
            hasCoder: !!this._coder,
            hasAccountsCoder: !!this._coder?.accounts
        });

        /** @type {import('@coral-xyz/anchor').Program<import('pumpdotfun-sdk').PumpFun>} */
        this.program;
        // 从环境变量获取 RPC 节点列表并解析 JSON
        try {
            this.rpcEndpoints = process.env.SOLANA_RPC_ENDPOINTS
                ? JSON.parse(process.env.SOLANA_RPC_ENDPOINTS)
                : ['https://api.mainnet-beta.solana.com'];

            // 验证所有端点
            this.rpcEndpoints = this.rpcEndpoints.map(endpoint => {
                if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
                    throw new Error(`Invalid endpoint URL: ${endpoint}`);
                }
                return endpoint;
            });

            logger.info('初始化 RPC 节点列表:', {
                endpoints: this.rpcEndpoints.map(url =>
                    url.replace(/api-key=([^&]+)/, 'api-key=***')
                )
            });
        } catch (error) {
            logger.error('解析 RPC 节点列表失败:', {
                error: error.message,
                raw: process.env.SOLANA_RPC_ENDPOINTS
            });
            // 使用默认节点
            this.rpcEndpoints = ['https://api.mainnet-beta.solana.com'];
        }

        this.currentEndpointIndex = 0;
        this.retryCount = 5;
        this.jitoService = new JitoService(connection);
        // 确保使用正确的程序 ID
        this.TOKEN_PROGRAM_ID = TOKEN_PROGRAM_ID;
        this.ASSOCIATED_TOKEN_PROGRAM_ID = ASSOCIATED_TOKEN_PROGRAM_ID;
        this.PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
    }
    // 在 CustomPumpSDK 类顶部添加账户大小定义

    async sendTransactionViaNozomi(transaction, signers, config) {
        try {
            // 签名交易
            transaction.sign(...signers);

            // 发送到 Nozomi
            const response = await axios.post(
                `${config.URL}/v1/tx`,
                {
                    tx: transaction.serialize().toString('base64'),
                    uuid: config.UUID
                },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data.error) {
                throw new Error(`Nozomi error: ${response.data.error}`);
            }

            return response.data.signature;
        } catch (error) {
            logger.error('Nozomi 发送交易失败:', error);
            throw error;
        }
    }

// 修改 createProgram 方法
    createProgram(provider) {
        if (!provider) {
            throw new Error('Provider is required');
        }

        try {
            // 确保 IDL 包含正确的字段定义
            const idlWithTypes = {
                ...IDL,
                accounts: [
                    {
                        name: "Global",
                        type: {
                            kind: "struct",
                            fields: [
                                { name: "initialized", type: "bool" },
                                { name: "authority", type: "pubkey" },
                                { name: "feeRecipient", type: "pubkey" },
                                { name: "initialVirtualTokenReserves", type: "u64" },
                                { name: "initialVirtualSolReserves", type: "u64" },
                                { name: "initialRealTokenReserves", type: "u64" },
                                { name: "tokenTotalSupply", type: "u64" },
                                { name: "feeBasisPoints", type: "u64" }
                            ]
                        }
                    },
                    {
                        name: "BondingCurve",
                        type: {
                            kind: "struct",
                            fields: [
                                { name: "virtualTokenReserves", type: "u64" },
                                { name: "virtualSolReserves", type: "u64" },
                                { name: "realTokenReserves", type: "u64" },
                                { name: "realSolReserves", type: "u64" },
                                { name: "tokenTotalSupply", type: "u64" },
                                { name: "complete", type: "bool" }
                            ]
                        }
                    }
                ]
            };

            // 使用完整的 IDL 创建 coder
            this._coder = new BorshCoder(idlWithTypes);

            // 设置账户大小计算函数
            if (this._coder.accounts) {
                const accountSizes = {
                    Global: 8 + 1 + 32 + 32 + 8 + 8 + 8 + 8 + 8, // 计算实际大小
                    BondingCurve: 8 + 8 + 8 + 8 + 8 + 1 // 计算实际大小
                };

                this._coder.accounts.size = (accountName) => {
                    return accountSizes[accountName] || 0;
                };
            }

            // 创建程序实例
            const program = new Program(
                idlWithTypes,
                this.PROGRAM_ID,
                provider,
                this._coder
            );

            logger.info('Program created successfully:', {
                programId: this.PROGRAM_ID,
                provider: provider.wallet.publicKey.toString(),
                hasAccounts: !!program.account,
                accountTypes: Object.keys(accountSizes)
            });

            return program;

        } catch (error) {
            logger.error('Failed to create program:', {
                error: error.message,
                provider: provider?.wallet?.publicKey?.toString(),
                stack: error.stack
            });
            throw error;
        }
    }
    setSolanaService(solanaService) {
        this.solanaService = solanaService;
    }
    async createTransaction(signerPublicKey) {
        try {
            const transaction = new Transaction();

            // 设置签名者
            transaction.feePayer = signerPublicKey;

            // 获取最新的 blockhash
            const { blockhash, lastValidBlockHeight } =
                await this.connection.getLatestBlockhash('confirmed');

            transaction.recentBlockhash = blockhash;
            transaction.lastValidBlockHeight = lastValidBlockHeight;

            return transaction;
        } catch (error) {
            logger.error('创建交易失败:', {
                error: error.message,
                signer: signerPublicKey.toString()
            });
            throw error;
        }
    }
    // 切换 RPC 节点
    async switchRpcEndpoint() {
        try {
            this.currentEndpointIndex = (this.currentEndpointIndex + 1) % this.rpcEndpoints.length;
            const newEndpoint = this.rpcEndpoints[this.currentEndpointIndex];

            // 验证端点
            if (!newEndpoint.startsWith('http://') && !newEndpoint.startsWith('https://')) {
                throw new Error(`Invalid endpoint URL: ${newEndpoint}`);
            }

            // 隐藏 api key 用于日志记录
            const logEndpoint = newEndpoint.replace(/api-key=([^&]+)/, 'api-key=***');

            this.connection = new Connection(newEndpoint, 'confirmed');

            logger.info('切换 RPC 节点:', {
                endpoint: logEndpoint,
                index: this.currentEndpointIndex
            });

            return newEndpoint;
        } catch (error) {
            logger.error('切换 RPC 节点失败:', {
                error: error.message,
                index: this.currentEndpointIndex
            });
            throw error;
        }
    }

    // 带重试的 RPC 调用
    async withRetry(operation) {
        let lastError;

        for (let i = 0; i < this.retryCount; i++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                logger.warn(`操作失败,尝试切换节点 (${i + 1}/${this.retryCount}):`, {
                    error: error.message
                });

                if (i < this.retryCount - 1) {
                    await this.switchRpcEndpoint();
                }
            }
        }

        throw lastError;
    }

    // 修改模拟交易方法
    async simulateCreateAndBuy(creator, mint, metadata, solAmount, options = {}) {
        try {
            logger.info('开始模拟创建和购买:', {
                creator: creator.publicKey.toString(),
                solAmount
            });

            // 1. 构建交易
            const {transaction, signers} = await this.buildCreateAndBuyTransaction(
                creator,
                mint,
                metadata,
                solAmount,
                options
            );

            // 2. 获取最新的 blockhash 并设置
            const {blockhash, lastValidBlockHeight} = await this.connection.getLatestBlockhash('confirmed');
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = creator.publicKey;

            // 3. 模拟交易
            const simulation = await this.connection.simulateTransaction(
                transaction,
                signers,
                {
                    sigVerify: false,
                    commitment: 'confirmed',
                    replaceRecentBlockhash: true  // 添加这个选项
                }
            );

            // 4. 计算预估费用
            const estimatedFee = await this.connection.getFeeForMessage(
                transaction.compileMessage(),
                'confirmed'
            );

            // 5. 分析模拟结果
            const analysis = {
                success: !simulation.value.err,
                error: simulation.value.err,
                logs: simulation.value.logs || [],
                computeUnits: simulation.value.unitsConsumed || 0,
                estimatedFee: estimatedFee.value || 0,
            };

            // 6. 检查余额
            const balance = await this.connection.getBalance(creator.publicKey);
            const solAmountLamports = BigInt(solAmount);
            logger.info('余额检查:', {solAmountLamports})
            const feeLamports = BigInt(estimatedFee.value || 0);
            const requiredAmount = solAmountLamports + feeLamports;
            const hasEnoughBalance = BigInt(balance) >= requiredAmount;

            logger.info('模拟结果:', {
                ...analysis,
                hasEnoughBalance,
                currentBalance: balance * LAMPORTS_PER_SOL,
                requiredBalance: Number(requiredAmount) / LAMPORTS_PER_SOL,
                feePayer: creator.publicKey.toString()
            });

            return {
                ...analysis,
                hasEnoughBalance,
                transaction,
                signers,
                requiredAmount: requiredAmount.toString()
            };
        } catch (error) {
            logger.error('模拟失败:', {
                error: error.message,
                stack: error.stack,
                creator: creator?.publicKey?.toString(),
                mint: mint?.publicKey?.toString()
            });
            throw error;
        }
    }

    // 修改构建交易方法
    async buildCreateAndBuyTransaction(creator, mint, metadata, solAmount, options = {}) {
        try {
            // 转换 SOL 到 lamports
            const solAmountLamports = BigInt(Math.floor(Number(solAmount) * Number(LAMPORTS_PER_SOL)));

            logger.info('构建交易入参:', {
                solAmount,                       // 原始 SOL 金额
                solAmountLamports: solAmountLamports.toString(),  // 转换后的 lamports
                creator: creator.publicKey.toString()
            });

            const tokenMetadata = {
                metadataUri: metadata.uri || ''
            };

            const transaction = new SolanaTransaction();
            transaction.feePayer = creator.publicKey;

            // 获取创建指令
            const createTx = await this.getCreateInstructions(
                creator.publicKey,
                metadata.name,
                metadata.symbol,
                tokenMetadata.metadataUri,
                mint
            );

            transaction.add(createTx);

            // 如果需要买入
            if (solAmount > 0) {
                const globalAccount = await this.getGlobalAccount();

                // 使用转换后的 lamports 值
                const initialBuyPrice = globalAccount.getInitialBuyPrice(solAmountLamports);
                const slippagePoints = BigInt(options.slippageBasisPoints || 100);

                logger.info('买入参数:', {
                    lamports: solAmountLamports.toString(),
                    initialPrice: typeof initialBuyPrice === 'object' ?
                        initialBuyPrice.toString() : initialBuyPrice,
                    slippage: slippagePoints.toString()
                });

                const buyAmountWithSlippage = this.calculateWithSlippageBuy(
                    initialBuyPrice,
                    slippagePoints
                );

                const buyTx = await this.getBuyInstructions(
                    creator.publicKey,
                    mint.publicKey,
                    globalAccount.feeRecipient,
                    initialBuyPrice,
                    buyAmountWithSlippage
                );

                transaction.add(buyTx);
            }

            return {
                transaction,
                signers: [creator, mint]
            };
        } catch (error) {
            logger.error('构建交易失败:', {
                error: error.message,
                stack: error.stack,
                solAmount,
                lamports: solAmount ?
                    BigInt(Math.floor(Number(solAmount) * Number(LAMPORTS_PER_SOL))).toString() :
                    'n/a'
            });
            throw error;
        }
    }

    // 修改 createAndBuy 方法
    // 验证指令的工具函数
    validateInstructions(instructions, logger) {
        try {
            // 1. 检查指令数组是否存在
            if (!Array.isArray(instructions)) {
                throw new Error('Instructions must be an array');
            }

            // 2. 检查指令数量
            if (instructions.length > 12) {
                throw new Error(`Too many instructions: ${instructions.length}. Maximum allowed is 12.`);
            }

            // 3. 检查每条指令的数据大小并记录
            const instructionSizes = instructions.map((ix, index) => {
                if (!ix || !ix.data) {
                    throw new Error(`Invalid instruction at index ${index}`);
                }
                return {
                    index,
                    size: ix.data.length,
                    programId: ix.programId?.toBase58()
                };
            });

            // 4. 创建临时交易来计算总大小
            const tempTx = new Transaction().add(...instructions);
            const serializedSize = tempTx.serialize().length;

            // 5. 汇总结果
            const validationResult = {
                instructionCount: instructions.length,
                individualSizes: instructionSizes,
                totalSerializedSize: serializedSize,
                isValid: serializedSize <= 1232,
                warnings: []
            };

            // 6. 添加警告
            if (serializedSize > 1000) {
                validationResult.warnings.push(`Transaction size (${serializedSize} bytes) is close to the limit of 1232 bytes`);
            }

            // 7. 记录详细信息
            logger.debug('指令验证结果:', {
                ...validationResult,
                details: instructionSizes.map(s => `Instruction ${s.index}: ${s.size} bytes (Program: ${s.programId})`)
            });

            if (!validationResult.isValid) {
                throw new Error(`Transaction too large: ${serializedSize} bytes. Maximum allowed is 1232 bytes.`);
            }

            return validationResult;

        } catch (error) {
            logger.error('验证指令失败:', {
                error: error.message,
                instructionCount: instructions?.length
            });
            throw error;
        }
    }

// createAndBuy 方法
    // In CustomPumpSDK class (customPumpSDK.js)
    _convertToBN(value) {
        try {
            if (value === null || value === undefined) {
                throw new Error('Cannot convert null or undefined to BN');
            }

            if (BN.isBN(value)) {
                return value;
            }

            // BigInt 转换
            if (typeof value === 'bigint') {
                return new BN(value.toString());
            }

            // 数字转换
            if (typeof value === 'number') {
                if (!Number.isFinite(value)) {
                    throw new Error('Cannot convert infinite or NaN to BN');
                }
                return new BN(Math.floor(value).toString());
            }

            // 字符串转换
            if (typeof value === 'string') {
                // 移除字符串中的空格和逗号
                const cleanedValue = value.replace(/[\s,]/g, '');
                if (!/^\d+$/.test(cleanedValue)) {
                    throw new Error('String contains invalid characters');
                }
                return new BN(cleanedValue);
            }

            throw new Error(`Unsupported value type: ${typeof value}`);
        } catch (error) {
            logger.error('BN转换失败:', {
                error: error.message,
                value: typeof value === 'bigint' ? value.toString() : value,
                type: typeof value
            });
            throw error;
        }
    }
    _solToLamports(solAmount) {
        try {
            // 确保输入是有效数字
            const amount = Number(solAmount);
            if (!Number.isFinite(amount)) {
                throw new Error('Invalid SOL amount');
            }

            // 转换为 lamports
            const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
            return BigInt(lamports);
        } catch (error) {
            logger.error('SOL转Lamports失败:', {
                error: error.message,
                solAmount
            });
            throw error;
        }
    }
    _ensureBigInt(value) {
        try {
            if (typeof value === 'bigint') {
                return value;
            }
            if (typeof value === 'number') {
                return BigInt(Math.floor(value));
            }
            if (typeof value === 'string') {
                return BigInt(value.replace(/[^\d]/g, ''));
            }
            if (value?.toString) {
                return BigInt(value.toString());
            }
            throw new Error(`Cannot convert ${typeof value} to BigInt`);
        } catch (error) {
            logger.error('BigInt 转换失败:', {
                error: error.message,
                value: typeof value === 'object' ? JSON.stringify(value) : value,
                type: typeof value
            });
            throw error;
        }
    }

    async createAndBuy(creator, mint, metadata, buyAmountSol, options = {}) {
        try {
            // 验证输入参数
            if (!creator?.publicKey) throw new Error('Invalid creator wallet');
            if (!mint?.publicKey) throw new Error('Invalid mint keypair');
            if (!metadata?.name || !metadata?.symbol) throw new Error('Invalid metadata');

            logger.info('开始创建和购买代币:', {
                creator: creator.publicKey.toString(),
                mint: mint.publicKey.toString(),
                buyAmount: typeof buyAmountSol === 'bigint' ? buyAmountSol.toString() : buyAmountSol
            });

            // 1. 创建代币元数据
            const tokenMetadata = await this.createTokenMetadata(metadata);

            // 2. 转换购买金额为 lamports (BigInt)
            const buyAmountLamports = this._solToLamports(buyAmountSol);

            // 3. 构建交易
            const transaction = new SolanaTransaction();

            // 4. 添加创建指令
            const createIx = await this.getCreateInstructions(
                creator.publicKey,
                metadata.name,
                metadata.symbol,
                tokenMetadata.metadataUri,
                mint
            );
            transaction.add(createIx);

            // 5. 如果购买金额大于0，添加购买指令
            if (buyAmountLamports>=(new BN(0))) {
                const globalAccount = await this.getGlobalAccount();

                // 确保使用 BigInt 进行价格计算
                const initialBuyPriceBigInt = this._ensureBigInt(
                    globalAccount.getInitialBuyPrice(buyAmountLamports)
                );

                // 计算带滑点的金额
                const slippageBasisPoints = this._ensureBigInt(options.slippageBasisPoints || 100);
                const buyAmountWithSlippage =await this.calculateWithSlippageBuy(
                    initialBuyPriceBigInt,
                    slippageBasisPoints
                );

                const buyIx = await this.getBuyInstructions(
                    creator.publicKey,
                    mint.publicKey,
                    globalAccount.feeRecipient,
                    initialBuyPriceBigInt,
                     buyAmountWithSlippage
                );
                transaction.add(buyIx);

                logger.debug('购买指令已添加:', {
                    initialPrice: initialBuyPriceBigInt.toString(),
                    withSlippage: buyAmountWithSlippage.toString(),
                    slippage: `${slippageBasisPoints.toString()} basis points`
                });
            }

            // 6. 获取最新的 blockhash
            const { blockhash, lastValidBlockHeight } =
                await this.connection.getLatestBlockhash('confirmed');

            transaction.recentBlockhash = blockhash;
            transaction.lastValidBlockHeight = lastValidBlockHeight;
            transaction.feePayer = creator.publicKey;

            // 7. 发送交易
            const signature = await this.sendTransactionWithLogs(
                this.connection,
                transaction,
                [creator, mint],
                {
                    skipPreflight: false,
                    preflightCommitment: 'confirmed',
                    commitment: 'confirmed',
                    maxRetries: 3
                }
            );

            // 8. 获取代币余额
            const tokenAccount = await this.findAssociatedTokenAddress(
                creator.publicKey,
                mint.publicKey
            );

            let tokenAmount = '0';
            try {
                const balance = await this.connection.getTokenAccountBalance(tokenAccount);
                tokenAmount = balance.value.amount;
            } catch (error) {
                logger.warn('获取代币余额失败:', error);
            }

            // 9. 返回标准化的响应
            const result = {
                success: true,
                signature,
                mint: mint.publicKey.toString(),
                creator: creator.publicKey.toString(),
                tokenAmount,
                solAmount: buyAmountSol.toString(),
                metadata: {
                    name: metadata.name,
                    symbol: metadata.symbol,
                    uri: tokenMetadata.metadataUri
                },
                timestamp: Date.now()
            };

            logger.info('代币创建和购买成功:', {
                signature,
                mint: result.mint,
                tokenAmount
            });

            return result;

        } catch (error) {
            logger.error('代币创建和购买失败:', {
                error: error.message,
                stack: error.stack,
                creator: creator?.publicKey?.toString(),
                mint: mint?.publicKey?.toString()
            });
            throw error;
        }
    }
    async sendTransactionWithLogs(connection, transaction, signers, options) {
        let lastError = null;
        const maxRetries = options.maxRetries || 3;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                logger.info(`尝试发送交易 (${attempt + 1}/${maxRetries})`, {
                    signers: signers.map(s => s.publicKey.toString()),
                    blockhash: transaction.recentBlockhash
                });

                // 发送交易
                const signature = await this.connection.sendTransaction(
                    transaction,
                    signers,
                    {
                        skipPreflight: options.skipPreflight,
                        preflightCommitment: options.preflightCommitment
                    }
                );

                logger.info(`交易已发送，等待确认... (尝试 ${attempt + 1}/${maxRetries})`, {
                    signature,
                    commitment: options.commitment
                });

                // 等待确认
                const confirmation = await this.connection.confirmTransaction(
                    {
                        signature,
                        blockhash: transaction.recentBlockhash,
                        lastValidBlockHeight: transaction.lastValidBlockHeight
                    },
                    options.commitment
                );

                if (confirmation.value.err) {
                    throw new Error(`Transaction failed: ${confirmation.value.err}`);
                }

                logger.info('交易确认成功', {
                    signature,
                    attempt: attempt + 1
                });

                return signature;

            } catch (error) {
                lastError = error;
                logger.warn(`交易尝试失败 (${attempt + 1}/${maxRetries})`, {
                    error: error.message,
                    blockhash: transaction.recentBlockhash
                });

                if (attempt < maxRetries - 1) {
                    // 获取新的 blockhash 进行重试
                    const { blockhash, lastValidBlockHeight } =
                        await connection.getLatestBlockhash(options.commitment);
                    transaction.recentBlockhash = blockhash;
                    transaction.lastValidBlockHeight = lastValidBlockHeight;

                    // 等待后重试
                    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
                }
            }
        }

        throw lastError;
    }
    // 原来的 BigInt 版本保留作为备用
    calculateSlippage(amount, basisPoints) {
        try {
            const amountBN = BigInt(amount.toString());
            const basisPointsBN = BigInt(basisPoints.toString());
            const tenThousand = BigInt(10000);

            const slippageAmount = (amountBN * basisPointsBN) / tenThousand;
            return amountBN + slippageAmount;
        } catch (error) {
            logger.error('计算滑点失败:', {
                error: error.message,
                amount: amount?.toString(),
                basisPoints: basisPoints?.toString()
            });
            throw new Error(`Failed to calculate slippage: ${error.message}`);
        }
    }

    // 辅助函数：确保是 PublicKey 对象
    ensurePublicKey(key) {
        try {
            if (key instanceof PublicKey) {
                return key;
            }
            if (typeof key === 'string') {
                return new PublicKey(key);
            }
            if (key?.publicKey instanceof PublicKey) {
                return key.publicKey;
            }
            if (typeof key?.publicKey === 'string') {
                return new PublicKey(key.publicKey);
            }
            throw new Error('Invalid public key format');
        } catch (error) {
            logger.error('PublicKey 转换失败:', {
                key: typeof key === 'object' ? JSON.stringify(key) : key,
                error: error.message
            });
            throw new Error(`Invalid public key: ${error.message}`);
        }
    }

    // 辅助函数：计算带滑点的购买金额
    async calculateWithSlippageBuy(buyAmount, slippageOptions) {
        try {
            // Extract slippage basis points from options
            let basisPoints;
            if (typeof slippageOptions === 'object') {
                basisPoints = slippageOptions.slippageBasisPoints || 100;
            } else {
                basisPoints = slippageOptions || 100;
            }

            // Ensure buyAmount is BigInt
            const amount = typeof buyAmount === 'bigint' ?
                buyAmount :
                BigInt(buyAmount.toString());

            // Ensure basisPoints is BigInt
            const basisPointsBN = typeof basisPoints === 'bigint' ?
                basisPoints :
                BigInt(basisPoints.toString());

            // Calculate with BigInt
            const TEN_THOUSAND = BigInt(10000);
            const slippageAmount = (amount * basisPointsBN) / TEN_THOUSAND;
            const finalAmount = amount + slippageAmount;

            logger.debug('滑点计算:', {
                originalAmount: amount.toString(),
                slippageBasisPoints: basisPointsBN.toString(),
                slippageAmount: slippageAmount.toString(),
                finalAmount: finalAmount.toString()
            });

            return finalAmount;
        } catch (error) {
            logger.error('计算滑点失败:', {
                buyAmount,
                error: error.message,
                slippageOptions: JSON.stringify(slippageOptions)
            });
            throw new Error(`Failed to calculate slippage: ${error.message}`);
        }
    }

    // 修改 createTokenMetadata 方法
    async createTokenMetadata(metadata) {
        try {
            // 验证必要字段
            if (!metadata.name || !metadata.symbol) {
                throw new Error('Name and symbol are required');
            }

            // 构建元数据
            const metadataBody = {
                name: metadata.name,
                symbol: metadata.symbol,
                description: metadata.description || '',
                image: metadata.image || '',
                external_url: metadata.external_url || '',
                attributes: metadata.attributes || []
            };

            // 使用 PinataService 上传
            if (!this.solanaService.pinataService) {
                throw new Error('PinataService not initialized');
            }

            const pinataResult = await this.solanaService.pinataService.uploadJSON(metadataBody);

            if (!pinataResult.success) {
                throw new Error(`Pinata upload failed: ${pinataResult.error || 'Unknown error'}`);
            }

            logger.info('元数据上传成功:', {
                name: metadata.name,
                symbol: metadata.symbol,
                ipfsHash: pinataResult.hash,
                url: pinataResult.url
            });

            return {
                metadataUri: pinataResult.url,
                ipfsHash: pinataResult.hash,
                name: metadata.name,
                symbol: metadata.symbol
            };

        } catch (error) {
            logger.error('创建代币元数据失败:', {
                error: error.message,
                metadata
            });
            throw error;
        }
    }

    isNodeError(error) {
        return error.message.includes('failed to fetch') ||
            error.message.includes('timeout') ||
            error.message.includes('rate limit');
    }

    // 创建代币的核心方法


// 交易发送方法
async sendTx(connection, transaction, feePayer, signers, priorityFees, commitment, finality)
{
    let signature, currentBlockhash, currentLastValidBlockHeight;

    try {
        // 1. 获取最新的 blockhash
        const {blockhash, lastValidBlockHeight} = await this.getLatestBlockhashWithRetry(commitment);
        currentBlockhash = blockhash;
        currentLastValidBlockHeight = lastValidBlockHeight;
        transaction.recentBlockhash = currentBlockhash;
        transaction.feePayer = feePayer;

        // 2. 如果有优先费用，添加优先费用指令
        if (priorityFees) {
            const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: priorityFees
            });
            transaction.instructions.unshift(priorityFeeIx);
        }

        // 3. 签名交易
        if (signers?.length > 0) {
            transaction.sign(...signers);
        }

        // 4. 发送交易
        signature = await connection.sendRawTransaction(transaction.serialize(), {
            skipPreflight: false,
            preflightCommitment: commitment,
            maxRetries: 3
        });

        // 5. 等待确认，带超时和重试
        let retries = 0;
        const maxRetries = 5;
        const timeout = 30000; // 30 秒超时

        while (retries < maxRetries) {
            try {
                const confirmation = await Promise.race([
                    connection.confirmTransaction({
                        signature,
                        blockhash: currentBlockhash,
                        lastValidBlockHeight: currentLastValidBlockHeight
                    }, finality),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Confirmation timeout')), timeout)
                    )
                ]);

                if (confirmation.value.err) {
                    throw new Error(`Transaction failed: ${confirmation.value.err}`);
                }

                logger.info('交易确认成功:', {
                    signature,
                    retries,
                    blockhash: currentBlockhash
                });

                return {
                    signature,
                    blockhash: currentBlockhash,
                    lastValidBlockHeight: currentLastValidBlockHeight
                };
            } catch (error) {
                retries++;
                logger.warn(`交易确认重试 (${retries}/${maxRetries}):`, {
                    error: error.message,
                    signature,
                    blockhash: currentBlockhash
                });

                if (retries === maxRetries) {
                    throw error;
                }

                // 如果是超时，重新获取 blockhash 并重试
                if (error.message.includes('BlockhashNotFound') || error.message.includes('timeout')) {
                    const {blockhash: newBlockhash, lastValidBlockHeight: newHeight} =
                        await this.getLatestBlockhashWithRetry(commitment);

                    currentBlockhash = newBlockhash;
                    currentLastValidBlockHeight = newHeight;
                    transaction.recentBlockhash = currentBlockhash;
                    transaction.sign(...signers);

                    // 重新发送交易
                    signature = await connection.sendRawTransaction(
                        transaction.serialize(),
                        {
                            skipPreflight: false,
                            preflightCommitment: commitment,
                            maxRetries: 3
                        }
                    );
                }

                await new Promise(resolve => setTimeout(resolve, 2000)); // 等待2秒后重试
            }
        }
    } catch (error) {
        logger.error('发送交易失败:', {
            error: error.message,
            signature,
            blockhash: currentBlockhash
        });
        throw error;
    }
}

// 修改模拟交易方法
    async simulateTransaction(tx, signers) {
        try {
            logger.info('开始模拟交易');

            // 1. 获取最新的 blockhash，避免使用解构赋值
            const blockHashResult = await this.connection.getLatestBlockhash('processed');
            tx.recentBlockhash = blockHashResult.blockhash;

            // 设置交易费用支付者
            if (signers && signers.length > 0) {
                tx.feePayer = signers[0].publicKey;  // 使用第一个签名者作为费用支付者
            }

            // 2. 签名交易（但不发送）
            if (signers?.length > 0) {
                signers.forEach(signer => tx.partialSign(signer));
            }

            // 3. 序列化交易
            const rawTransaction = tx.serialize();

            // 4. 模拟交易
            const simulation = await this.connection.simulateTransaction(tx);

            // 5. 分析模拟结果
            const analysis = this.analyzeSimulationError(simulation);

            logger.info('模拟交易结果', {
                success: !simulation.value.err,
                error: simulation.value.err,
                logs: simulation.value.logs,
                unitsConsumed: simulation.value.unitsConsumed,
                analysis
            });

            return {
                success: !simulation.value.err,
                error: simulation.value.err,
                logs: simulation.value.logs,
                unitsConsumed: simulation.value.unitsConsumed,
                analysis
            };
        } catch (error) {
            logger.error('模拟交易失败', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }
// 修改 findMetadataAddress 方法
async findMetadataAddress(mint)
{
    try {
        logger.debug('查找 Metadata 地址', {
            mint: mint.toBase58()
        });

        // 使用 SDK 中定义的常量
        const seeds = [
            Buffer.from('metadata'),
            new PublicKey(TOKEN_METADATA_PROGRAM_ID).toBuffer(),
            mint.toBuffer()
        ];

        const [address] = await PublicKey.findProgramAddress(
            seeds,
            new PublicKey(TOKEN_METADATA_PROGRAM_ID)  // 使用 Token Metadata Program ID
        );

        logger.debug('找到 Metadata 地址', {
            address: address.toBase58(),
            mint: mint.toBase58()
        });

        return address;
    } catch (error) {
        logger.error('查找 Metadata 地址失败', {
            error: error.message,
            mint: mint?.toBase58(),
            stack: error.stack
        });
        throw error;
    }
}

// 修改 findAssociatedTokenAddress 方法
    async findAssociatedTokenAddress(owner, mint) {
        try {
            // Input validation
            if (!owner) {
                throw new Error('Owner parameter is required');
            }
            if (!mint) {
                throw new Error('Mint parameter is required');
            }

            // Convert owner to PublicKey if it's not already
            let ownerPublicKey;
            try {
                if (owner instanceof PublicKey) {
                    ownerPublicKey = owner;
                } else if (typeof owner === 'string') {
                    ownerPublicKey = new PublicKey(owner);
                } else if (owner?.publicKey instanceof PublicKey) {
                    ownerPublicKey = owner.publicKey;
                } else if (typeof owner?.publicKey === 'string') {
                    ownerPublicKey = new PublicKey(owner.publicKey);
                } else {
                    throw new Error('Invalid owner format');
                }
            } catch (error) {
                throw new Error(`Invalid owner public key: ${error.message}`);
            }

            // Convert mint to PublicKey if it's not already
            let mintPublicKey;
            try {
                if (mint instanceof PublicKey) {
                    mintPublicKey = mint;
                } else if (typeof mint === 'string') {
                    mintPublicKey = new PublicKey(mint);
                } else if (mint?.publicKey instanceof PublicKey) {
                    mintPublicKey = mint.publicKey;
                } else if (typeof mint?.publicKey === 'string') {
                    mintPublicKey = new PublicKey(mint.publicKey);
                } else {
                    throw new Error('Invalid mint format');
                }
            } catch (error) {
                throw new Error(`Invalid mint public key: ${error.message}`);
            }

            logger.debug('查找关联代币账户', {
                owner: ownerPublicKey.toBase58(),
                mint: mintPublicKey.toBase58()
            });

            // Get associated token address with proper parameter order
            const address = await getAssociatedTokenAddress(
                mintPublicKey,             // mint address
                ownerPublicKey,            // owner
                false,                     // allow owner off curve
                TOKEN_PROGRAM_ID,          // token program ID
                ASSOCIATED_TOKEN_PROGRAM_ID // associated token program ID
            );

            logger.debug('找到关联代币账户', {
                address: address.toBase58(),
                owner: ownerPublicKey.toBase58(),
                mint: mintPublicKey.toBase58()
            });

            return address;
        } catch (error) {
            logger.error('查找关联代币账户失败', {
                error: error.message,
                owner: owner?.toString?.() || 'invalid owner',
                mint: mint?.toString?.() || 'invalid mint',
                stack: error.stack
            });
            throw error;
        }
    }

// 修改 findBondingCurveAddress 方法
async findBondingCurveAddress(mint)
{
    try {
        logger.debug('查找绑定曲线地址', {
            mint: mint.toBase58()
        });

        // 使用 SDK 中定义的常量
        const seeds = [
            Buffer.from('bonding-curve'),  // 不需要 utf8 编码
            mint.toBuffer()
        ];

        const [address] = await PublicKey.findProgramAddress(
            seeds,
            this.program.programId
        );

        logger.debug('找到绑定曲线地址', {
            address: address.toBase58(),
            mint: mint.toBase58()
        });

        return address;
    } catch (error) {
        logger.error('查找绑定曲线地址失败', {
            error: error.message,
            mint: mint?.toBase58(),
            stack: error.stack
        });
        throw error;
    }
}

// 添加查找关联绑定曲线地址的方法
async findAssociatedBondingCurveAddress(owner, mint)
{
    try {
        logger.debug('查找关联绑定曲线地址', {
            owner: owner.toBase58(),
            mint: mint.toBase58()
        });

        const [address] = await PublicKey.findProgramAddress(
            [
                Buffer.from('associated-bonding-curve'),
                owner.toBuffer(),
                mint.toBuffer()
            ],
            this.program.programId
        );

        return address;
    } catch (error) {
        logger.error('查找关联绑定曲线地址失败', {
            error,
            owner: owner?.toBase58(),
            mint: mint?.toBase58()
        });
        throw error;
    }
}

// 添加代币单位转换方法
async validateAndConvertTokenAmount(amount, decimals = 6, type = 'sell')
{
    try {
        // 验证输入是否为有效数字
        const amountNum = Number(amount);
        if (isNaN(amountNum) || amountNum <= 0) {
            throw new Error(`Invalid ${type} token amount: ${amount}`);
        }

        // 转换标准单位到原始单位
        const rawAmount = BigInt(Math.floor(amountNum * Math.pow(10, decimals)));

        logger.debug(`💱 ${type.toUpperCase()} 代币金额转换`, {
            original: `${amountNum} tokens`,
            rawAmount: rawAmount.toString(),
            decimals,
            type
        });

        return rawAmount;
    } catch (error) {
        logger.error(`转换 ${type} 代币金额失败`, {
            amount,
            error: error.message
        });
        throw error;
    }
}

// 添加余额检查方法
async checkBalances(creator, mint, solAmount, isSellingTokens = false)
{
    try {
        // 检查 SOL 余额
        const solBalance = await this.connection.getBalance(creator.publicKey);

        if (!isSellingTokens) {
            // 买入时检查 SOL 余额
            const requiredSol = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL));
            if (BigInt(solBalance) < requiredSol) {
                throw new Error(`Insufficient SOL balance. Required: ${solAmount} SOL, Available: ${solBalance / LAMPORTS_PER_SOL} SOL`);
            }
        }

        if (isSellingTokens) {
            // 卖出时检查代币余额
            const tokenAccount = await this.findAssociatedTokenAddress(creator.publicKey, mint);
            const tokenBalance = await this.connection.getTokenAccountBalance(tokenAccount);
            if (!tokenBalance?.value?.uiAmount) {
                throw new Error('Token balance not found');
            }
            logger.info('代币余额检查', {
                balance: tokenBalance.value.uiAmount,
                required: solAmount
            });
            if (BigInt(tokenBalance.value.amount) < BigInt(solAmount)) {
                throw new Error(`Insufficient token balance. Required: ${solAmount}, Available: ${tokenBalance.value.amount}`);
            }
        }

        return true;
    } catch (error) {
        logger.error('余额检查失败', {
            error: error.message,
            creator: creator.publicKey.toBase58(),
            mint: mint.toBase58()
        });
        throw error;
    }
}

// 修改 buy 方法
async buy(buyer, mint, buyAmountSol, slippageBasisPoints = 100n, priorityFees, options = {}) {
    try {
        return await this.withRetry(async () => {
            // 2. 获取购买指令
            let buyTx = await super.getBuyInstructionsBySolAmount(
                buyer.publicKey,
                mint,
                buyAmountSol,
                slippageBasisPoints,
                'confirmed'
            );

            // 3. 处理优先上链
            if (options.usePriorityFee) {
                const jitoService = new JitoService(this.connection);
                buyTx = await jitoService.addPriorityFee(buyTx, {
                    type: options.priorityType || 'jito',
                    tipAmountSol: priorityFees?.tipAmountSol
                });
            }
            else if (priorityFees?.microLamports) {
                buyTx.add(
                    ComputeBudgetProgram.setComputeUnitPrice({
                        microLamports: priorityFees.microLamports
                    })
                );
            }

            // 4. 获取最新的 blockhash
            const { blockhash, lastValidBlockHeight } =
                await this.connection.getLatestBlockhash('confirmed');

            buyTx.recentBlockhash = blockhash;
            buyTx.lastValidBlockHeight = lastValidBlockHeight;
            buyTx.feePayer = buyer.publicKey;

            // 5. 模拟交易
            logger.info('开始模拟交易...');
            const simulation = await this.connection.simulateTransaction(buyTx, [buyer], {
                sigVerify: false,
                commitment: 'confirmed',
                replaceRecentBlockhash: true
            });

            // 6. 分析模拟结果
            if (simulation.value.err) {
                const logs = simulation.value.logs || [];
                logger.error('交易模拟失败:', {
                    error: simulation.value.err,
                    logs: logs,
                    mint: mint.toString(),
                    buyer: buyer.publicKey.toString()
                });

                // 检查具体错误类型
                if (logs.some(log => log.includes('Bonding curve account not found'))) {
                    throw new Error(`Token ${mint.toString()} is not a valid pump token. Please create it first.`);
                }
                if (logs.some(log => log.includes('insufficient funds'))) {
                    throw new Error('Insufficient funds for transaction');
                }
                throw new Error(`Transaction simulation failed: ${simulation.value.err}`);
            }

            // 7. 计算预估费用
            const estimatedFee = await this.connection.getFeeForMessage(
                buyTx.compileMessage(),
                'confirmed'
            );

            // 8. 检查余额是否足够支付费用
            const balance = await this.connection.getBalance(buyer.publicKey);
            const totalRequired = buyAmountSol + BigInt(estimatedFee.value || 0);
            if (BigInt(balance) < totalRequired) {
                throw new Error(`Insufficient balance. Required: ${totalRequired}, Current: ${balance}`);
            }

            logger.info('交易模拟成功:', {
                computeUnits: simulation.value.unitsConsumed || 0,
                estimatedFee: estimatedFee.value || 0,
                logs: simulation.value.logs
            });

            // 9. 获取最新的区块信息用于实际发送
            const { value: { blockhash: sendBlockhash, lastValidBlockHeight: sendValidHeight }, context: sendContext } =
                await this.connection.getLatestBlockhashAndContext('processed');

            logger.info('实际发送交易使用的区块信息:', {
                blockhash: sendBlockhash,
                lastValidBlockHeight: sendValidHeight,
                slot: sendContext.slot,
                commitment: 'processed',
                timestamp: new Date().toISOString()
            });

            // 更新交易的区块信息
            buyTx.recentBlockhash = sendBlockhash;
            buyTx.lastValidBlockHeight = sendValidHeight - 150; // 减少 150 个区块的有效期
            buyTx.feePayer = buyer.publicKey;

            // 10. 发送交易
            let signature;
            if (options.usePriorityFee && options.priorityType === 'nozomi') {
                signature = await this.sendTransactionViaNozomi(
                    buyTx,
                    [buyer],
                    NOZOMI_CONFIG
                );
            } else {
                signature = await sendAndConfirmTransaction(
                    this.connection,
                    buyTx,
                    [buyer],
                    {
                        skipPreflight: false,
                        preflightCommitment: 'processed', // 使用 processed 提交级别
                        maxRetries: 5,
                        commitment: 'confirmed'
                    }
                );
            }

            // 11. 返回结果
            const result = {
                signature,
                txId: signature,
                amount: buyAmountSol.toString(),
                mint: mint.toString(),
                owner: buyer.publicKey.toString(),
                timestamp: new Date().toISOString(),
                slippage: `${Number(slippageBasisPoints) / 100}%`,
                status: 'success',
                endpoint: this.connection.rpcEndpoint,
                priorityFee: options.usePriorityFee ? {
                    type: options.priorityType || 'jito',
                    amount: priorityFees?.tipAmountSol
                } : undefined,
                simulation: {
                    computeUnits: simulation.value.unitsConsumed || 0,
                    fee: estimatedFee.value || 0
                },
                blockInfo: {
                    blockhash: sendBlockhash,
                    lastValidBlockHeight: sendValidHeight - 150,
                    slot: sendContext.slot
                }
            };

            logger.info('购买交易成功:', {
                signature: result.signature,
                buyer: buyer.publicKey.toString(),
                mint: mint.toString(),
                amount: buyAmountSol.toString(),
                endpoint: this.connection.rpcEndpoint,
                priorityFee: result.priorityFee,
                simulation: result.simulation
            });

            return result;
        });
    } catch (error) {
        logger.error('❌ 购买代币失败', {
            error: error.message,
            mint: mint.toString(),
            amount: buyAmountSol.toString(),
            slippage: `${Number(slippageBasisPoints) / 100}%`,
            time: new Date().toISOString(),
            endpoint: this.connection.rpcEndpoint
        });
        throw error;
    }
}

// 添加通过 Nozomi 发送交易的方法
async sendTransactionViaNozomi(transaction, signers, config) {
    try {
        // 签名交易
        transaction.sign(...signers);

        // 发送到 Nozomi
        const response = await axios.post(
            `${config.URL}/v1/tx`,
            {
                tx: transaction.serialize().toString('base64'),
                uuid: config.UUID
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.data.error) {
            throw new Error(`Nozomi error: ${response.data.error}`);
        }

        return response.data.signature;
    } catch (error) {
        logger.error('Nozomi 发送交易失败:', error);
        throw error;
    }
}
    async initializeProvider(seller) {
        try {
            if (!seller || !seller.publicKey) {
                throw new Error('Valid seller is required');
            }

            if (this.provider?.program && this.program) {
                return;
            }

            const provider = new AnchorProvider(
                this.connection,
                new CustomWallet(seller),
                {
                    commitment: 'confirmed',
                    preflightCommitment: 'confirmed',
                    skipPreflight: false
                }
            );

            const program = this.createProgram(provider);

            this.provider = provider;
            this.program = program;

            logger.info('Provider 和程序初始化成功:', {
                wallet: provider.wallet.publicKey.toString(),
                programId: program.programId.toString()
            });

        } catch (error) {
            logger.error('Provider 初始化失败:', {
                error: error.message,
                seller: seller?.publicKey?.toString(),
                stack: error.stack
            });
            throw error;
        }
    }
    async getSellInstructions(seller, mint, tokenAmount, slippageBasisPoints) {
        try {
            // 1. 输入验证
            if (!seller) throw new Error('Seller is required');
            if (!mint) throw new Error('Mint is required');
            if (!tokenAmount) throw new Error('Token amount is required');

            // 2. 初始化provider如果需要
            if (!this.program) {
                await this.initializeProvider(seller);
            }

            if (!this.provider || !this.program) {
                throw new Error('Provider initialization failed');
            }

            logger.info('Program IDL:', {
                instructions: this.program.idl.instructions.map(ix => ix.name)
            });

            // 3. 转换参数为正确类型
            const sellerPubkey = this.ensurePublicKey(seller);
            const mintPubkey = this.ensurePublicKey(mint);

            // 转换token数量为BN
            const amountBN = new BN(tokenAmount.toString());
            const slippageBN = new BN(slippageBasisPoints?.toString() || '100');

            // 4. 获取账户
            const globalAccount = await this.getGlobalAccount();
            if (!globalAccount?.address) {
                throw new Error('Global account not found');
            }

            const bondingCurveAddress = await this.findBondingCurveAddress(mintPubkey);
            if (!bondingCurveAddress) {
                throw new Error('Bonding curve address not found');
            }

            const associatedBondingCurve = await getAssociatedTokenAddress(
                bondingCurveAddress,
                mintPubkey
            );

            const associatedUser = await this.findAssociatedTokenAddress(
                sellerPubkey,
                mintPubkey
            );

            // 5. 计算最小SOL输出
            const calculatedSolOutput = await this.calculateSellSolOutput(mintPubkey, amountBN);
            const solOutputBN = BN.isBN(calculatedSolOutput) ?
                calculatedSolOutput :
                new BN(calculatedSolOutput.toString());

            // 计算带滑点的最小输出
            const minSolOutput = await this.calculateWithSlippageSell(
                solOutputBN,
                slippageBN
            );

            const minSolOutputBN = BN.isBN(minSolOutput) ?
                minSolOutput :
                new BN(minSolOutput.toString());

            // 6. 创建关联绑定曲线账户如果需要
            const instructions = [];

            // 添加计算预算指令
            instructions.push(
                ComputeBudgetProgram.setComputeUnitLimit({
                    units: 400000
                })
            );

            // 检查关联绑定曲线账户是否存在
            const [associatedBondingCurveAddress] = await PublicKey.findProgramAddress(
                [
                    Buffer.from('associated-bonding-curve'),
                    sellerPubkey.toBuffer(),
                    mintPubkey.toBuffer()
                ],
                this.program.programId
            );

            const accountInfo = await this.connection.getAccountInfo(associatedBondingCurveAddress);
            if (!accountInfo) {
                logger.info('Creating associated bonding curve account:', {
                    address: associatedBondingCurveAddress.toString(),
                    mint: mintPubkey.toString(),
                    user: sellerPubkey.toString()
                });

                // 获取metadata地址
                const metadataAddress = await this.findMetadataAddress(mintPubkey);

                // 创建关联账户指令
                const createIx = await this.program.methods
                    .create()
                    .accounts({
                        mint: mintPubkey,
                        mintAuthority: sellerPubkey,
                        bondingCurve: bondingCurveAddress,
                        associatedBondingCurve: associatedBondingCurveAddress,
                        global: globalAccount.address,
                        mplTokenMetadata: new PublicKey(TOKEN_METADATA_PROGRAM_ID),
                        metadata: metadataAddress,
                        user: sellerPubkey,
                        systemProgram: SystemProgram.programId,
                        tokenProgram: TOKEN_PROGRAM_ID,
                        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                        rent: SYSVAR_RENT_PUBKEY,
                        eventAuthority: new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'),
                        program: this.program.programId
                    })
                    .instruction();

                instructions.push(createIx);
            }

            // 7. 创建sell指令
            logger.info('Building sell instruction:', {
                seller: sellerPubkey.toString(),
                mint: mintPubkey.toString(),
                amount: amountBN.toString(),
                minSolOutput: minSolOutputBN.toString()
            });

            const sellInstruction = await this.program.methods
                .sell(amountBN, minSolOutputBN)
                .accounts({
                    global: globalAccount.address,
                    feeRecipient: globalAccount.feeRecipient,
                    mint: mintPubkey,
                    bondingCurve: bondingCurveAddress,
                    associatedBondingCurve: associatedUser,
                    associatedUser: associatedUser,
                    user: sellerPubkey,
                    systemProgram: SystemProgram.programId,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    eventAuthority: new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'),
                    program: this.program.programId
                })
                .instruction();

            instructions.push(sellInstruction);

            logger.debug('Sell instructions created successfully:', {
                instructionCount: instructions.length,
                hasAssociatedAccount: !!accountInfo,
                seller: sellerPubkey.toString(),
                mint: mintPubkey.toString()
            });

            return { instructions, signers: [] };

        } catch (error) {
            logger.error('Failed to create sell instructions:', {
                error: error.message,
                mint: mint?.toString?.(),
                seller: seller?.toString?.(),
                stack: error.stack
            });
            throw error;
        }
    }
    async calculateWithSlippageSell(solOutput, slippageOptions) {
        try {
            // Extract slippage basis points from options
            let basisPoints;
            if (typeof slippageOptions === 'object') {
                basisPoints = slippageOptions.slippageBasisPoints || 100;
            } else {
                basisPoints = slippageOptions || 100;
            }

            // Ensure solOutput is BigInt
            const amount = typeof solOutput === 'bigint' ?
                solOutput :
                BigInt(solOutput.toString());

            // Ensure basisPoints is BigInt
            const basisPointsBN = typeof basisPoints === 'bigint' ?
                basisPoints :
                BigInt(basisPoints.toString());

            // Calculate with BigInt
            // For sells, we subtract the slippage to get the minimum acceptable output
            const TEN_THOUSAND = BigInt(10000);
            const slippageAmount = (amount * basisPointsBN) / TEN_THOUSAND;
            const finalAmount = amount - slippageAmount;  // Subtract for sell operations

            logger.debug('卖出滑点计算:', {
                originalAmount: amount.toString(),
                slippageBasisPoints: basisPointsBN.toString(),
                slippageAmount: slippageAmount.toString(),
                minimumOutput: finalAmount.toString()
            });

            // Ensure the final amount is not negative
            if (finalAmount <= BigInt(0)) {
                throw new Error('Slippage calculation resulted in zero or negative amount');
            }

            return finalAmount;
        } catch (error) {
            logger.error('计算卖出滑点失败:', {
                solOutput: typeof solOutput === 'bigint' ? solOutput.toString() : solOutput,
                error: error.message,
                slippageOptions: JSON.stringify(slippageOptions)
            });
            throw new Error(`Failed to calculate sell slippage: ${error.message}`);
        }
    }


// Then in the sell method:
    // customPumpSDK.js (sell 相关部分)
    // customPumpSDK.js
    async sell(seller, mint, amount, options = {}) {
        try {
            // 1. Basic validation
            if (!seller || !seller.publicKey) {
                throw new Error('Invalid seller wallet');
            }
            if (!mint) {
                throw new Error('Invalid mint address');
            }
            if (!amount || amount <= 0) {
                throw new Error('Invalid amount');
            }

            const amountStr = amount.toString();

            logger.info('Starting sell operation:', {
                seller: seller.publicKey.toString(),
                mint: mint.toString(),
                amount: amountStr,
                options: {
                    ...options,
                    slippageBasisPoints: options.slippageBasisPoints?.toString()
                }
            });

            // 2. Get token account and verify balance
            const tokenAccount = await this.findAssociatedTokenAddress(
                seller.publicKey,
                mint
            );

            const tokenAccountInfo = await this.connection.getAccountInfo(tokenAccount);
            if (!tokenAccountInfo) {
                throw new Error(`Token account ${tokenAccount.toString()} does not exist`);
            }

            const tokenBalance = await this.connection.getTokenAccountBalance(tokenAccount);
            const availableAmount = BigInt(tokenBalance.value.amount);

            if (amount > availableAmount) {
                throw new Error(
                    `Insufficient token balance. Available: ${availableAmount.toString()}, Trying to sell: ${amountStr}`
                );
            }

            // 3. Create transaction
            const transaction = new Transaction();

            // 4. Get instructions and signers
            const { instructions, signers } = await this.getSellInstructions(
                seller,
                mint,
                amount,
                options.slippageBasisPoints || 100n
            );

            // 5. Add all instructions to transaction
            instructions.forEach(instruction => transaction.add(instruction));

            // 6. Get latest blockhash
            const { blockhash, lastValidBlockHeight } =
                await this.connection.getLatestBlockhash('confirmed');

            transaction.recentBlockhash = blockhash;
            transaction.lastValidBlockHeight = lastValidBlockHeight;
            transaction.feePayer = seller.publicKey;

            // 7. Simulate transaction
            logger.info('Simulating transaction...');
            const simulation = await this.connection.simulateTransaction(
                transaction,
                [seller, ...signers],
                {
                    sigVerify: false,
                    commitment: 'confirmed',
                    replaceRecentBlockhash: true
                }
            );

            if (simulation.value.err) {
                const logs = simulation.value.logs || [];
                logger.error('Transaction simulation failed:', {
                    error: simulation.value.err,
                    logs: logs,
                    seller: seller.publicKey.toString(),
                    mint: mint.toString()
                });
                throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
            }

            // 8. Send and confirm transaction
            logger.info('Sending transaction...');
            const signature = await sendAndConfirmTransaction(
                this.connection,
                transaction,
                [seller, ...signers],
                {
                    skipPreflight: false,
                    preflightCommitment: 'confirmed',
                    commitment: 'confirmed',
                    maxRetries: 3
                }
            );

            logger.info('Sell transaction successful:', {
                signature,
                seller: seller.publicKey.toString(),
                amount: amountStr
            });

            return {
                success: true,
                signature,
                amount: amountStr,
                mint: mint.toString(),
                seller: seller.publicKey.toString(),
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            logger.error('Sell operation failed:', {
                error: error.message,
                seller: seller?.publicKey?.toString(),
                mint: mint?.toString(),
                amount: amount?.toString(),
                stack: error.stack
            });
            throw error;
        }
    }
    async calculateSellSolOutput(mint, tokenAmount) {
        try {
            // Get the bonding curve account
            const bondingCurveAddress = await this.findBondingCurveAddress(mint);
            const bondingCurveAccount = await this.program.account.bondingCurve.fetch(bondingCurveAddress);

            if (!bondingCurveAccount) {
                throw new Error('Bonding curve account not found');
            }

            // Convert tokenAmount to BN if it isn't already
            const tokenAmountBN = BN.isBN(tokenAmount) ? tokenAmount : new BN(tokenAmount.toString());

            // Calculate virtual SOL reserves after sale
            const newVirtualTokenReserves = new BN(bondingCurveAccount.virtualTokenReserves.toString())
                .sub(tokenAmountBN);

            const virtualSolReservesBN = new BN(bondingCurveAccount.virtualSolReserves.toString());
            const k = virtualSolReservesBN.mul(new BN(bondingCurveAccount.virtualTokenReserves.toString()));

            // Calculate new SOL reserves using constant product formula
            const newVirtualSolReserves = k.div(newVirtualTokenReserves);

            // Calculate SOL output
            const solOutput = newVirtualSolReserves.sub(virtualSolReservesBN);

            logger.debug('Sell output calculation:', {
                tokenAmount: tokenAmountBN.toString(),
                currentVirtualTokenReserves: bondingCurveAccount.virtualTokenReserves.toString(),
                currentVirtualSolReserves: bondingCurveAccount.virtualSolReserves.toString(),
                calculatedSolOutput: solOutput.toString()
            });

            return solOutput;
        } catch (error) {
            logger.error('Failed to calculate sell output:', {
                error: error.message,
                mint: mint.toString(),
                tokenAmount: tokenAmount.toString()
            });
            throw error;
        }
    }


// 辅助方法：检查账户是否存在
    async checkAccountExists(address) {
        const accountInfo = await this.connection.getAccountInfo(address);
        return accountInfo !== null;
    }

// 辅助方法：获取账户余额
    async getTokenBalance(tokenAccount) {
        try {
            const balance = await this.connection.getTokenAccountBalance(tokenAccount);
            return balance.value;
        } catch (error) {
            logger.error('Failed to get token balance:', error);
            throw error;
        }
    }

    validateTransaction(transaction) {
        try {
            if (!transaction) {
                return {
                    isValid: false,
                    error: 'Transaction is required'
                };
            }

            // 检查必要的字段
            if (!transaction.recentBlockhash) {
                return {
                    isValid: false,
                    error: 'Missing recent blockhash'
                };
            }

            if (!transaction.feePayer) {
                return {
                    isValid: false,
                    error: 'Missing fee payer'
                };
            }

            // 检查指令
            if (!transaction.instructions || transaction.instructions.length === 0) {
                return {
                    isValid: false,
                    error: 'No instructions in transaction'
                };
            }

            // 验证每个指令
            for (let i = 0; i < transaction.instructions.length; i++) {
                const ix = transaction.instructions[i];
                if (!ix || !ix.data) {
                    return {
                        isValid: false,
                        error: `Invalid instruction at index ${i}`
                    };
                }

                if (!ix.programId) {
                    return {
                        isValid: false,
                        error: `Missing program ID at instruction ${i}`
                    };
                }

                if (!ix.keys || ix.keys.length === 0) {
                    return {
                        isValid: false,
                        error: `No keys in instruction ${i}`
                    };
                }
            }

            // 检查交易大小
            const serializedSize = transaction.serialize().length;
            if (serializedSize > 1232) {
                return {
                    isValid: false,
                    error: `Transaction too large: ${serializedSize} bytes`
                };
            }

            // 记录验证信息
            logger.debug('交易验证成功:', {
                numInstructions: transaction.instructions.length,
                serializedSize,
                feePayer: transaction.feePayer.toString(),
                blockhash: transaction.recentBlockhash
            });

            return {
                isValid: true,
                serializedSize,
                numInstructions: transaction.instructions.length
            };

        } catch (error) {
            logger.error('交易验证失败:', {
                error: error.message,
                stack: error.stack
            });

            return {
                isValid: false,
                error: error.message
            };
        }
    }
// 修改 getGlobalAccount 方法
async getGlobalAccount()
{
    try {
        logger.info('开始获取全局账户');

        // 1. 查找全局账户地址
        const [globalAddress] = await PublicKey.findProgramAddress(
            [Buffer.from('global')],
            this.program.programId
        );

        // 2. 获取账户数据
        const accountInfo = await this.connection.getAccountInfo(globalAddress);
        if (!accountInfo) {
            throw new Error('Global account not found');
        }

        // 3. 使用 SDK 的 GlobalAccount 类解析数据
        const globalAccount = GlobalAccount.fromBuffer(accountInfo.data);

        // 4. 添加地址信息
        globalAccount.address = globalAddress;

        logger.debug('全局账户信息', {
            address: globalAddress.toBase58(),
            feeRecipient: globalAccount.feeRecipient.toBase58(),
            initialVirtualTokenReserves: globalAccount.initialVirtualTokenReserves.toString(),
            initialVirtualSolReserves: globalAccount.initialVirtualSolReserves.toString()
        });

        return globalAccount;
    } catch (error) {
        logger.error('获取全局账户失败', {
            error: error.message,
            programId: this.program.programId?.toBase58(),
            stack: error.stack
        });

        // 尝试从父类获取
        try {
            return await super.getGlobalAccount();
        } catch (superError) {
            logger.error('父类获取全局账户也失败', {
                error: superError.message,
                stack: superError.stack
            });
            throw new Error('Failed to get global account');
        }
    }
}

// 添加模拟错误分析方法
analyzeSimulationError(simulationResult)
{
    const analysis = {
        type: 'unknown',
        details: {},
        suggestions: []
    };

    if (!simulationResult.logs) {
        return analysis;
    }

    // 分析日志
    const logs = simulationResult.logs;

    // 检查常见错误模式
    if (logs.some(log => log.includes('insufficient funds'))) {
        analysis.type = 'insufficient_funds';
        analysis.suggestions.push('检查账户余额是否足够');
    }

    if (logs.some(log => log.includes('already in use'))) {
        analysis.type = 'account_in_use';
        analysis.suggestions.push('使用新的账户地址');
    }

    if (logs.some(log => log.includes('invalid program id'))) {
        analysis.type = 'invalid_program';
        analysis.suggestions.push('检查程序ID是否正确');
    }

    // 计算单元分析
    const computeUnits = logs
        .filter(log => log.includes('consumed'))
        .map(log => {
            const match = log.match(/consumed (\d+) of (\d+)/);
            return match ? {used: parseInt(match[1]), total: parseInt(match[2])} : null;
        })
        .filter(Boolean);

    if (computeUnits.length > 0) {
        analysis.details.computeUnits = computeUnits;
        const totalUsed = computeUnits.reduce((sum, cu) => sum + cu.used, 0);
        if (totalUsed > CustomPumpSDK.MIN_COMPUTE_UNITS) {
            analysis.suggestions.push(`增加计算单元限制，当前使用: ${totalUsed}`);
        }
    }

    return analysis;
}

// 添加到 CustomPumpSDK 类中
async calculateTransactionFees(amount, options = {})
{
    try {
        // 1. 基础费用计算
        const baseFees = {
            // 计算单元费用 (200,000 * 1) / 1e9 = 0.0002 SOL
            computeUnitsFee: (CustomPumpSDK.MIN_COMPUTE_UNITS * CustomPumpSDK.BASE_PRIORITY_RATE) / 1e9,

            // 基础交易费
            baseTransactionFee: 0.000005,

            // PumpFun 费用 (1%)
            pumpFunFee: Number(amount) * 0.01
        };

        logger.debug('基础费用明细', {
            computeUnitsFee: baseFees.computeUnitsFee,
            baseTransactionFee: baseFees.baseTransactionFee,
            pumpFunFee: baseFees.pumpFunFee,
            rawAmount: amount
        });

        // 2. 优先通道费用（只在指定时计算）
        const priorityFee = options.type === 'nozomi' ? 0.0001 : 0;

        // 3. 计算总费用
        const totalFees = {
            ...baseFees,
            priorityFee,
            total: baseFees.computeUnitsFee +
                baseFees.baseTransactionFee +
                baseFees.pumpFunFee +
                priorityFee
        };

        logger.info('💰 交易费用明细', {
            amount: `${amount} SOL`,
            computeUnitsFee: `${baseFees.computeUnitsFee} SOL`,
            baseTransactionFee: `${baseFees.baseTransactionFee} SOL`,
            pumpFunFee: `${baseFees.pumpFunFee} SOL`,
            priorityFee: options.type === 'nozomi' ? `${priorityFee} SOL (nozomi)` : 'none',
            totalFees: `${totalFees.total} SOL`
        });

        return totalFees;
    } catch (error) {
        logger.error('计算费用失败', error);
        throw error;
    }
}

// 添加余额检查方法
    async checkBalance(publicKey, requiredAmount) {
        try {
            // 获取账户当前余额
            const balanceResult = await this.connection.getBalance(publicKey, 'confirmed');
            const balanceInSol = balanceResult / LAMPORTS_PER_SOL;

            // 检查余额是否足够
            const sufficient = balanceInSol >= requiredAmount;
            const shortfall = sufficient ? 0 : requiredAmount - balanceInSol;

            logger.info('💳 账户余额检查', {
                account: publicKey.toBase58(),
                balance: `${balanceInSol} SOL`,
                required: `${requiredAmount} SOL`,
                sufficient
            });

            return {
                balance: balanceInSol,
                required: requiredAmount,
                sufficient,
                shortfall
            };
        } catch (error) {
            logger.error('检查余额失败', {
                error: error.message,
                account: publicKey.toBase58()
            });
            throw error;
        }
    }

// 添加金额验证和转换方法
async
validateAndConvertAmount(amount, type = 'buy')
{
    try {
        // 验证输入是否为有效数字
        const amountNum = Number(amount);
        if (isNaN(amountNum) || amountNum <= 0) {
            throw new Error(`Invalid ${type} amount: ${amount}`);
        }

        // 转换 SOL 到 lamports
        const lamports = BigInt(Math.floor(amountNum * LAMPORTS_PER_SOL));

        logger.debug(`💱 ${type.toUpperCase()} 金额转换`, {
            original: `${amount} SOL`,
            lamports: lamports.toString(),
            type
        });

        return lamports;
    } catch (error) {
        logger.error(`转换 ${type} 金额失败`, {
            amount,
            error: error.message
        });
        throw error;
    }
}

// 添加一个辅助方法来等待交易确认
async waitForTransaction(signature, commitment = 'confirmed', maxRetries = 30)
{
    logger.info('等待交易确认...', {signature});

    for (let i = 0; i < maxRetries; i++) {
        try {
            const latestBlockhash = await this.connection.getLatestBlockhash();
            const confirmation = await this.connection.confirmTransaction({
                signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            }, commitment);

            if (confirmation?.value?.err) {
                throw new Error(`Transaction failed: ${confirmation.value.err}`);
            }

            logger.info('交易已确认', {signature, attempts: i + 1});
            return confirmation;
        } catch (error) {
            if (i === maxRetries - 1) {
                throw error;
            }
            logger.warn(`等待交易确认重试 (${i + 1}/${maxRetries})...`, {signature, error: error.message});
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}

// 修改 testFullProcess 方法中的相关部分
async testFullProcess(creator, mint, metadata, initialAmount, secondBuyAmount)
{
    try {
        // 参数验证
        if (!creator || !creator.publicKey) {
            throw new Error('Invalid creator wallet');
        }
        if (!mint || !mint.publicKey) {
            throw new Error('Invalid mint keypair');
        }
        if (!metadata) {
            throw new Error('Metadata is required');
        }

        logger.info('开始完整测试流程', {
            creator: creator.publicKey.toBase58(),
            initialAmount: `${initialAmount} SOL`,
            secondBuyAmount: `${secondBuyAmount} SOL`
        });

        // 1. 创建并首次购买
        const createResult = await this.createAndBuy(
            creator,
            mint,
            metadata,
            initialAmount,
            100n
        );

        // 检查并获取正确的签名
        const firstTxSignature = createResult?.signature || createResult?.txid || createResult?.txId;
        if (!firstTxSignature) {
            logger.error('无法获取第一笔交易的签名', {createResult});
            throw new Error('First transaction signature not found');
        }

        logger.info('第一步：创建和首次购买完成', {
            signature: firstTxSignature,
            mint: createResult.mint
        });

        // 等待 5 秒让链上状态更新
        logger.info('等待链上状态更新 (5秒)...');
        await new Promise(resolve => setTimeout(resolve, 5000));

        // 等待 Bonding curve account 创建完成
        logger.info('等待 Bonding curve account 创建...');
        const bondingCurveAddress = await this.getBondingCurvePDA(mint.publicKey);
        let bondingCurveAccount = null;
        let retries = 0;
        const maxRetries = 15;  // 增加重试次数

        while (!bondingCurveAccount && retries < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // 等待 2 秒
            bondingCurveAccount = await this.getBondingCurveAccount(mint.publicKey, 'confirmed');
            retries++;
            logger.info(`检查 Bonding curve account (${retries}/${maxRetries})...`, {
                address: bondingCurveAddress.toBase58(),
                found: !!bondingCurveAccount
            });
        }

        if (!bondingCurveAccount) {
            throw new Error('Bonding curve account 创建超时');
        }

        logger.info('Bonding curve account 已创建', {
            address: bondingCurveAddress.toBase58(),
            data: bondingCurveAccount
        });

        // 2. 执行第二次购买前，确保代币账户已创建
        const associatedTokenAddress = await this.findAssociatedTokenAddress(
            creator.publicKey,
            mint.publicKey
        );

        // 检查代币账户是否存在
        const tokenAccount = await this.connection.getAccountInfo(associatedTokenAddress);
        if (!tokenAccount) {
            logger.info('创建关联代币账户...');
            const createAtaIx = createAssociatedTokenAccountInstruction(
                creator.publicKey,
                associatedTokenAddress,
                creator.publicKey,
                mint.publicKey,
                this.TOKEN_PROGRAM_ID,
                this.ASSOCIATED_TOKEN_PROGRAM_ID
            );

            const tx = new SolanaTransaction().add(createAtaIx);
            const signature = await this.connection.sendTransaction(tx, [creator]);
            await this.waitForTransaction(signature);
            logger.info('关联代币账户已创建', {address: associatedTokenAddress.toBase58()});
        }

        // 执行第二次购买
        logger.info('开始执行第二次购买...');
        const secondBuyTx = await super.buy(
            creator,
            mint.publicKey,
            BigInt(Math.floor(secondBuyAmount * LAMPORTS_PER_SOL)),
            100n,
            undefined,
            'confirmed',
            'confirmed'
        );

        await this.waitForTransaction(secondBuyTx.signature);
        logger.info('第二次购买完成', {
            signature: secondBuyTx.signature,
            amount: `${secondBuyAmount} SOL`
        });

        // 3. 等待 15 秒后执行全部卖出
        logger.info('等待 15 秒后执行全部卖出...');
        await new Promise(resolve => setTimeout(resolve, 15000));

        // 获取当前代币余额
        const tokenBalance = await this.connection.getTokenAccountBalance(associatedTokenAddress);
        const sellAmount = BigInt(tokenBalance.value.amount);

        const sellTx = await super.sell(
            creator,
            mint.publicKey,
            sellAmount,
            100n,  // 1% 滑点
            undefined,
            'confirmed',
            'confirmed'
        );

        logger.info('第三步：全部卖出完成', {
            signature: sellTx.signature,
            soldAmount: tokenBalance.value.uiAmount,
            timestamp: new Date().toISOString()
        });

        return {
            createAndBuy: {
                signature: firstTxSignature,
                mint: createResult.mint
            },
            secondBuy: secondBuyTx,
            sell: sellTx,
            summary: {
                initialBuy: `${initialAmount} SOL`,
                secondBuy: `${secondBuyAmount} SOL`,
                totalSold: tokenBalance.value.uiAmount,
                duration: `${Date.now() - createResult.time}ms`
            }
        };
    } catch (error) {
        logger.error('❌ 测试流程失败', {
            error: error.message || error,
            creator: creator?.publicKey?.toBase58(),
            mint: mint?.publicKey?.toBase58(),
            stack: error.stack
        });
        throw error;
    }
}

// 使用 WebSocket 管理器的方法
async
subscribeToAccount(publicKey, callback)
{
    return this.wsManager.subscribeToAccount(publicKey, callback);
}

async
unsubscribeFromAccount(publicKey)
{
    return this.wsManager.unsubscribeFromAccount(publicKey);
}

async
cleanup()
{
    return this.wsManager.cleanup();
}

// 添加获取 blockhash 的辅助方法
    async getLatestBlockhashWithRetry(commitment = 'confirmed', maxRetries = 3) {
        let lastError;
        for (let i = 0; i < maxRetries; i++) {
            try {
                const result = await this.connection.getLatestBlockhash(commitment);
                return {
                    blockhash: result.blockhash,
                    lastValidBlockHeight: result.lastValidBlockHeight
                };
            } catch (error) {
                lastError = error;
                logger.warn(`获取 blockhash 失败，重试 (${i + 1}/${maxRetries}):`, {
                    error: error.message
                });
                await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
            }
        }
        throw lastError;
    }
} 