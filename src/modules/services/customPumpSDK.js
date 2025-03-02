import {createRequire} from 'module';
import pkg from 'pumpdotfun-sdk';
import {AnchorProvider, BorshCoder, Program} from "@coral-xyz/anchor";
import {logger} from '../utils/index.js';
import { AccountLayout as TokenAccountLayout } from '@solana/spl-token';
import {
    ComputeBudgetProgram,
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    sendAndConfirmTransaction,
    SystemProgram,
    Transaction as SolanaTransaction,
    Transaction
} from '@solana/web3.js';
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    getAssociatedTokenAddress,
    TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import BN from 'bn.js';
import {JitoService} from './jitoService_new.js';
import axios from 'axios';
import {WebSocketManager} from './webSocketManager.js';
import idlModule from 'pumpdotfun-sdk/dist/cjs/IDL/index.js';
import bs58 from "bs58";

const require = createRequire(import.meta.url);
const {PumpFunSDK, GlobalAccount} = pkg;
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
// 自定义日志工具，处理 BigInt 序列化
const customJSONStringify = (data) => {
    return JSON.stringify(data, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
    );
};
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
                                {name: "initialized", type: "bool"},
                                {name: "authority", type: "pubkey"},
                                {name: "feeRecipient", type: "pubkey"},
                                {name: "initialVirtualTokenReserves", type: "u64"},
                                {name: "initialVirtualSolReserves", type: "u64"},
                                {name: "initialRealTokenReserves", type: "u64"},
                                {name: "tokenTotalSupply", type: "u64"},
                                {name: "feeBasisPoints", type: "u64"}
                            ]
                        }
                    },
                    {
                        name: "BondingCurve",
                        type: {
                            kind: "struct",
                            fields: [
                                {name: "virtualTokenReserves", type: "u64"},
                                {name: "virtualSolReserves", type: "u64"},
                                {name: "realTokenReserves", type: "u64"},
                                {name: "realSolReserves", type: "u64"},
                                {name: "tokenTotalSupply", type: "u64"},
                                {name: "complete", type: "bool"}
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
            const {blockhash, lastValidBlockHeight} =
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

            if (options.batchTransactions && options.batchTransactions.length > 4) {
                throw new Error('Maximum 4 batch transactions allowed');
            }

            logger.info('开始创建和购买代币:', {
                creator: creator.publicKey.toString(),
                mint: mint.publicKey.toString(),
                buyAmount: typeof buyAmountSol === 'bigint' ? buyAmountSol.toString() : buyAmountSol
            });

            // 初始化 Jito 服务
            const jitoService = new JitoService(this.connection);
            await jitoService.initialize();

            // 获取最新的 blockhash
            const {blockhash, lastValidBlockHeight} =
                await this.connection.getLatestBlockhash('confirmed');

            // 准备交易数组
            const transactions = [];

            // 1. 创建主交易 (create + buy)
            let mainTransaction = new Transaction();

            // 创建代币元数据
            const tokenMetadata = await this.createTokenMetadata(metadata);

            // 添加创建指令
            const createIx = await this.getCreateInstructions(
                creator.publicKey,
                metadata.name,
                metadata.symbol,
                tokenMetadata.metadataUri,
                mint
            );
            mainTransaction.add(createIx);

            // 转换购买金额为 lamports
            const buyAmountLamports = this._solToLamports(buyAmountSol);
            const globalAccount = await this.getGlobalAccount();
            const slippageBasisPoints = this._ensureBigInt(options.slippageBasisPoints || 100);

            // 如果购买金额大于0，添加购买指令
            if (buyAmountLamports >= (new BN(0))) {
                const initialBuyPriceBigInt = this._ensureBigInt(
                    globalAccount.getInitialBuyPrice(buyAmountLamports)
                );

                const buyAmountWithSlippage = await this.calculateWithSlippageBuy(
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
                // 设置主交易参数
                mainTransaction.recentBlockhash = blockhash;
                mainTransaction.lastValidBlockHeight = lastValidBlockHeight;
                mainTransaction.feePayer = creator.publicKey;
                mainTransaction.add(buyIx);
                const tipAmountSol = options.tipAmountSol;
                const wallet = creator;
                // 添加 Jito tip
                mainTransaction = await jitoService.addTipToTransaction(
                    mainTransaction, {
                        tipAmountSol,
                        wallet
                });

            }


            // 添加主交易到交易数组
            transactions.push({
                transaction: mainTransaction,
                signers: [creator, mint]
            });

            // 2. 处理批量交易
            if (options.batchTransactions?.length > 0) {
                for (const batchTx of options.batchTransactions) {
                    const batchWallet = batchTx.wallet;

                    let batchTransaction = new Transaction();
                    const batchAmountLamports = this._solToLamports(batchTx.solAmount);
                    const batchBuyPriceBigInt = this._ensureBigInt(
                        globalAccount.getInitialBuyPrice(batchAmountLamports)
                    );
                    const batchAmountWithSlippage = await this.calculateWithSlippageBuy(
                        batchBuyPriceBigInt,
                        slippageBasisPoints
                    );

                    const buyIx = await this.getBuyInstructions(
                        batchWallet.publicKey,
                        mint.publicKey,
                        globalAccount.feeRecipient,
                        batchBuyPriceBigInt,
                        batchAmountWithSlippage
                    );
                    batchTransaction.recentBlockhash = blockhash;
                    batchTransaction.lastValidBlockHeight = lastValidBlockHeight;
                    batchTransaction.feePayer = batchWallet.publicKey;

                    batchTransaction.add(buyIx);
                    const wallet = batchWallet;
                    const tipAmountSol = options.jitoTipSol;
                    batchTransaction = await jitoService.addTipToTransaction(
                        batchTransaction, {
                            tipAmountSol,
                            wallet
                    });


                    transactions.push({
                        transaction: batchTransaction,
                        signers: [batchWallet]
                    });
                }
            }

            // 3. 签名所有交易
            const signedTransactions = await Promise.all(
                transactions.map(async ({transaction, signers}) => {
                    // 在签名前验证签名者
                    const validSigners = signers.filter(signer =>
                        signer && signer.publicKey && typeof signer.publicKey.toBase58 === 'function'
                    );

                    if (validSigners.length !== signers.length) {
                        logger.error('检测到无效的签名者:', {
                            预期数量: signers.length,
                            有效数量: validSigners.length
                        });
                        throw new Error('检测到无效的签名者格式');
                    }
                    // 现在使用验证过的签名者进行签名
                    transaction.sign(...validSigners);
                    return transaction;
                })
            );

            // 4. 发送交易bundle
            const bundleResult = await jitoService.sendBundle(signedTransactions);

            // 存储所有签名
            const signatures = signedTransactions.map(tx => {
                const sigBytes = tx.signatures[0].signature;
                if (sigBytes) {
                    // 将签名 Buffer 转换为 base58 字符串
                    return bs58.encode(sigBytes);
                }
                return null;
            });

            // 获取主交易的签名（第一个交易）
            const mainSignature = signatures[0];

            // 5. 获取代币余额
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
            const batchResults = [];
            if (options.batchTransactions?.length > 0) {
                for (let i = 0; i < signatures.length - 1; i++) { // 跳过第一个签名（主交易）
                    const batchTx = options.batchTransactions[i];
                    const batchSignature = signatures[i + 1];

                    if (batchSignature) {
                        // 获取代币余额
                        const batchTokenAccount = await this.findAssociatedTokenAddress(
                            batchTx.wallet.publicKey,
                            mint.publicKey
                        );

                        let batchTokenAmount = '0';
                        try {
                            const balance = await this.connection.getTokenAccountBalance(batchTokenAccount);
                            batchTokenAmount = balance.value.amount;
                        } catch (error) {
                            logger.warn('获取批量交易代币余额失败:', error);
                        }

                        batchResults.push({
                            signature: batchSignature,
                            tokenAmount: batchTokenAmount,
                            solAmount: batchTx.solAmount.toString(),
                            groupType: batchTx.groupType,
                            accountNumber: batchTx.accountNumber,
                            timestamp: Date.now()
                        });
                    }
                }
            }
            // 6. 返回结果
            const result = {
                success: true,
                signature: mainSignature,
                bundleId: bundleResult.bundleId,
                allSignatures: signatures,
                mint: mint.publicKey.toString(),
                creator: creator.publicKey.toString(),
                tokenAmount,
                solAmount: buyAmountSol.toString(),
                metadata: {
                    name: metadata.name,
                    symbol: metadata.symbol,
                    uri: tokenMetadata.metadataUri
                },
                timestamp: Date.now(),
                batchResults: batchResults.length > 0 ? batchResults : undefined
            };

            logger.info('代币创建和购买成功:', {
                signature: mainSignature,
                bundleId: bundleResult.bundleId,
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
                    const {blockhash, lastValidBlockHeight} =
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
    async calculateWithSlippageBuy(tokenAmount, slippageBasisPoints) {
        try {
            // 确保输入在日志记录前是安全的
            const tokenAmountStr = tokenAmount?.toString() || 'undefined';

            logger.info("tokenAmount, slippageBasisPoints", {
                tokenAmount: tokenAmountStr,
                slippageBasisPoints
            });

            // 验证输入
            if (tokenAmount === undefined || tokenAmount === null) {
                logger.error('calculateWithSlippageBuy收到undefined输入', {
                    tokenAmount: 'undefined/null',
                    slippageBasisPoints: slippageBasisPoints?.toString()
                });
                throw new Error('计算滑点时tokenAmount为undefined或null');
            }

            // 确保 tokenAmount 是 BigInt 类型
            let tokenAmountBigInt;

            // 检查 tokenAmount 是否已经是 BigInt
            if (typeof tokenAmount === 'bigint') {
                tokenAmountBigInt = tokenAmount;
            } else {
                // 尝试将 tokenAmount 转换为 BigInt
                try {
                    tokenAmountBigInt = BigInt(tokenAmount);
                } catch (e) {
                    logger.error('无法将 tokenAmount 转换为 BigInt', {
                        tokenAmount: tokenAmountStr,
                        error: e.message
                    });
                    throw new Error(`计算滑点时无法处理 tokenAmount: ${e.message}`);
                }
            }

            logger.info("tokenAmount1, slippageBasisPoints1", {
                tokenAmount: tokenAmountBigInt.toString(),
                slippageBasisPoints
            });

            // 处理滑点参数
            let slippageBigInt;
             // 改进的无效值检查 - 避免使用 isNaN() 于 BigInt
            if (slippageBasisPoints === undefined || slippageBasisPoints === null ||
                (typeof slippageBasisPoints === 'string' && slippageBasisPoints.trim() === '') ||
                (typeof slippageBasisPoints !== 'bigint' && isNaN(Number(slippageBasisPoints)))) {

                logger.error('calculateWithSlippageBuy收到无效滑点', {
                    tokenAmount: tokenAmountBigInt.toString(),
                    slippageBasisPoints: String(slippageBasisPoints)
                });
                // 使用默认值代替抛出错误
                slippageBasisPoints = 1000; // 默认10%
                logger.info('使用默认滑点值(10%/1000基点)');
            }

            // 安全地转换滑点为 BigInt
            try {
                slippageBigInt = BigInt(slippageBasisPoints);
            } catch (e) {
                logger.error('无法将滑点转换为 BigInt', {
                    slippageBasisPoints,
                    error: e.message
                });
                slippageBigInt = BigInt(1000); // 默认使用 10%
                logger.info('使用默认滑点值(10%/1000基点)');
            }

            logger.info("tokenAmount2, slippageBasisPoints2", {
                tokenAmount: tokenAmountBigInt.toString(),
                slippageBasisPoints: slippageBigInt.toString()
            });

            const basisPointsBigInt = BigInt(10000); // 基点总数 (100%)

            // 计算滑点金额 (tokenAmount * slippageBasisPoints / 10000)
            const slippageAmount = (tokenAmountBigInt * slippageBigInt) / basisPointsBigInt;

            // 买入时考虑滑点后的金额 (减少)
            const minimumTokenAmount = tokenAmountBigInt * (BigInt(10000) - slippageBasisPoints) / BigInt(10000);

            logger.info("计算完成，返回调整后金额", {
                originalAmount: tokenAmountBigInt.toString(),
                slippage: slippageBigInt.toString(),
                slippageAmount: slippageAmount.toString(),
                adjustedAmount: minimumTokenAmount.toString()
            });

            // 结果作为 BigInt 返回，不要尝试转换为 number
            return minimumTokenAmount;
        } catch (error) {
            // 捕获所有异常以确保日志记录
            logger.error("calculateWithSlippageBuy发生异常", {
                error: error.message,
                stack: error.stack
            });
            throw error; // 重新抛出以便调用者处理
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
    async sendTx(connection, transaction, feePayer, signers, priorityFees, commitment, finality) {
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
    async findMetadataAddress(mint) {
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
    async findBondingCurveAddress(mint) {
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
    async findAssociatedBondingCurveAddress(owner, mint) {
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
    async validateAndConvertTokenAmount(amount, decimals = 6, type = 'sell') {
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
    async checkBalances(creator, mint, solAmount, isSellingTokens = false) {
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
        const startTime = Date.now();
        let jitoService = null;

        try {
            // 1. 参数验证
            if (!buyer?.publicKey) throw new Error('Invalid buyer wallet');
            if (!mint) throw new Error('Invalid mint address');
            if (typeof buyAmountSol === 'undefined' || buyAmountSol <= 0) {
                throw new Error('Invalid buy amount');
            }

            // 2. 记录交易参数
            logger.info('开始购买代币:', {
                buyer: buyer.publicKey.toString(),
                mint: mint.toString(),
                buyAmountSol: buyAmountSol.toString(),
                slippageBasisPoints: slippageBasisPoints.toString(),
                options: {
                    usePriorityFee: options.usePriorityFee,
                    priorityType: options.priorityType,
                    priorityFeeSol: options.priorityFeeSol,
                    tipAmountSol: options.tipAmountSol
                }
            });

            return await this.withRetry(async () => {
                // 3. 获取购买指令
                let buyTransaction = new Transaction();
                const buyTx = await super.getBuyInstructionsBySolAmount(
                    buyer.publicKey,
                    mint,
                    buyAmountSol,
                    slippageBasisPoints,
                    'confirmed'
                );
                buyTransaction.add(buyTx);

                // 6. 获取最新区块哈希
                const {blockhash, lastValidBlockHeight} =
                    await this.connection.getLatestBlockhash('confirmed');

                // 7. 设置交易参数
                buyTransaction.recentBlockhash = blockhash;
                buyTransaction.feePayer = buyer.publicKey;
                buyTransaction.lastValidBlockHeight = lastValidBlockHeight;

                // 4. 处理优先上链
                if (options.usePriorityFee) {
                    if (options.priorityType === 'Jito') {
                        jitoService = new JitoService(this.connection);
                        await jitoService.initialize();
                        const tipAmountSol = options.jitoTipSol;
                        const wallet = buyer;
                        buyTransaction = await jitoService.addTipToTransaction(buyTransaction, {
                            tipAmountSol,
                            wallet
                        });
                    } else {
                        // 添加常规优先费用指令
                        buyTransaction.add(
                            ComputeBudgetProgram.setComputeUnitPrice({
                                microLamports: options.priorityFeeSol ?
                                    Math.floor(options.priorityFeeSol * LAMPORTS_PER_SOL / 1_000_000) :
                                    100000 // 默认优先费用
                            })
                        );
                    }
                }
                // 8. 模拟交易
                logger.info('开始模拟交易...');
                const simulation = await this.connection.simulateTransaction(
                    buyTransaction,
                    [buyer],
                    {
                        sigVerify: false,
                        commitment: 'confirmed',
                        replaceRecentBlockhash: true
                    }
                );

                // 9. 分析模拟结果
                if (simulation.value.err) {
                    const logs = simulation.value.logs || [];
                    logger.error('交易模拟失败:', {
                        error: simulation.value.err,
                        logs,
                        mint: mint.toString(),
                        buyer: buyer.publicKey.toString()
                    });

                    if (logs.some(log => log.includes('Bonding curve account not found'))) {
                        throw new Error(`Token ${mint.toString()} is not a valid pump token`);
                    }
                    if (logs.some(log => log.includes('insufficient funds'))) {
                        throw new Error('Insufficient funds for transaction');
                    }
                    throw new Error(`Transaction simulation failed: ${simulation.value.err}`);
                }

                // 10. 计算预估费用并检查余额
                const estimatedFee = await this.connection.getFeeForMessage(
                    buyTransaction.compileMessage(),
                    'confirmed'
                );

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

                // 11. 发送交易
                let signature;
                if (options.usePriorityFee && options.priorityType === 'Jito') {
                    const bundleResult = await jitoService.sendBundle([buyTransaction]);
                    const beforeTime = Date.now();

                    // 等待交易确认并获取签名
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    const signatures = await this.connection.getSignaturesForAddress(
                        buyer.publicKey,
                        {limit: 5}
                    );

                    signature = signatures.find(sig =>
                        sig.blockTime * 1000 > beforeTime
                    )?.signature;

                    if (!signature) {
                        throw new Error('Failed to get Jito transaction signature');
                    }

                    logger.info('Jito transaction sent:', {
                        bundleId: bundleResult.bundleId,
                        signature
                    });
                } else {
                    signature = await this.connection.sendTransaction(
                        buyTransaction,
                        [buyer],
                        {
                            skipPreflight: false,
                            preflightCommitment: 'processed',
                            maxRetries: options.retryCount || 5,
                            commitment: 'confirmed'
                        }
                    );
                }

                // 12. 等待交易确认
                const confirmation = await Promise.race([
                    this.connection.confirmTransaction(
                        {
                            signature,
                            blockhash,
                            lastValidBlockHeight
                        },
                        'confirmed'
                    ),
                    new Promise((_, reject) =>
                        setTimeout(
                            () => reject(new Error('Transaction confirmation timeout')),
                            options.timeout || 60000
                        )
                    )
                ]);

                if (confirmation.value.err) {
                    throw new Error(`Transaction failed: ${confirmation.value.err}`);
                }

                // 13. 返回结果
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
                    duration: Date.now() - startTime,
                    priorityFee: options.usePriorityFee ? {
                        type: options.priorityType || 'normal',
                        amount: options.priorityFeeSol || options.tipAmountSol
                    } : undefined,
                    simulation: {
                        computeUnits: simulation.value.unitsConsumed || 0,
                        fee: estimatedFee.value || 0
                    }
                };

                logger.info('购买交易成功:', {
                    signature: result.signature,
                    buyer: buyer.publicKey.toString(),
                    mint: mint.toString(),
                    amount: buyAmountSol.toString(),
                    duration: result.duration
                });

                return result;

            });
        } catch (error) {
            // 清理资源
            if (jitoService) {
                await jitoService.cleanup().catch(e =>
                    logger.warn('清理 Jito service 失败:', e)
                );
            }

            // 记录错误
            logger.error('购买代币失败:', {
                error: error.message,
                stack: error.stack,
                buyer: buyer?.publicKey?.toString(),
                mint: mint?.toString(),
                amount: buyAmountSol?.toString(),
                duration: Date.now() - startTime
            });

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

    // Add to CustomPumpSDK class:
    async initializeAssociatedBondingCurve(user, mint) {
        try {
            logger.info('初始化关联绑定曲线账户', {
                user: user.publicKey.toString(),
                mint: mint.toString()
            });

            // 1. 获取需要的账户地址
            const bondingCurveAddress = await this.findBondingCurveAddress(mint);
            const globalAccount = await this.getGlobalAccount();

            // 2. 生成关联绑定曲线地址
            const [associatedBondingCurveAddress] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from('associated-bonding-curve'),
                    user.publicKey.toBuffer(),
                    mint.toBuffer()
                ],
                this.program.programId
            );

            // 3. 创建初始化指令
            const initInstruction = await this.program.methods
                .initialize()
                .accounts({
                    bondingCurve: bondingCurveAddress,
                    associatedBondingCurve: associatedBondingCurveAddress,
                    user: user.publicKey,
                    payer: user.publicKey,
                    systemProgram: SystemProgram.programId
                })
                .instruction();

            // 4. 创建交易
            const tx = new Transaction();

            // 5. 添加计算预算指令
            tx.add(
                ComputeBudgetProgram.setComputeUnitLimit({
                    units: 400000
                })
            );

            // 6. 添加优先级费用指令
            tx.add(
                ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: 100000 // 增加优先级以确保交易快速处理
                })
            );

            // 7. 添加初始化指令
            tx.add(initInstruction);

            // 8. 获取最新的区块哈希
            const {blockhash, lastValidBlockHeight} =
                await this.connection.getLatestBlockhash('confirmed');

            // 9. 设置交易参数
            tx.recentBlockhash = blockhash;
            tx.lastValidBlockHeight = lastValidBlockHeight;
            tx.feePayer = user.publicKey;

            // 10. 发送交易
            const signature = await this.sendTransactionWithLogs(
                this.connection,
                tx,
                [user],
                {
                    skipPreflight: false,
                    preflightCommitment: 'confirmed',
                    commitment: 'confirmed',
                    maxRetries: 3
                }
            );

            // 11. 日志记录
            logger.info('关联绑定曲线账户初始化成功', {
                signature,
                address: associatedBondingCurveAddress.toString(),
                bondingCurve: bondingCurveAddress.toString(),
                user: user.publicKey.toString()
            });

            // 12. 返回结果
            return {
                success: true,
                signature,
                address: associatedBondingCurveAddress.toString(),
                bondingCurveAddress: bondingCurveAddress.toString(),
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            logger.error('初始化关联绑定曲线账户失败', {
                error: error.message,
                user: user?.publicKey?.toString(),
                mint: mint?.toString(),
                stack: error.stack
            });
            throw error;
        }
    }

    async ensureAssociatedBondingCurveExists(user, mint) {
        try {
            // 基础参数验证和转换
            const userPubkey = this.ensurePublicKey(user);
            const mintPubkey = this.ensurePublicKey(mint);

            logger.info('检查关联绑定曲线账户', {
                user: userPubkey.toString(),
                mint: mintPubkey.toString()
            });

            // 正确生成关联绑定曲线地址 (包含 user 和 mint)
            const [associatedBondingCurveAddress] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from('associated-bonding-curve'),
                    userPubkey.toBuffer(),
                    mintPubkey.toBuffer()
                ],
                this.program.programId
            );
            logger.info('检查是否关联绑定曲线账户aaaaaaaaaaaaaaaaaa', {
                address: associatedBondingCurveAddress.toString()
            });
            // 检查账户是否存在
            const accountInfo = await this.connection.getAccountInfo(associatedBondingCurveAddress);

            if (accountInfo) {
                logger.info('关联绑定曲线账户已存在', {
                    address: associatedBondingCurveAddress.toString(),
                    size: accountInfo.data?.length || 0
                });
                return true;
            }

            logger.info('关联绑定曲线账户不存在，初始化中...', {
                address: associatedBondingCurveAddress.toString()
            });

            // 调用初始化方法
            await this.initializeAssociatedBondingCurve(user, mintPubkey);

            // 等待并验证账户创建
            const maxVerificationRetries = 8;
            let verificationRetry = 0;
            let accountCreated = false;

            while (verificationRetry < maxVerificationRetries && !accountCreated) {
                const waitTime = 4000 + (verificationRetry * 2000);
                logger.info(`等待账户创建验证 (${verificationRetry + 1}/${maxVerificationRetries})...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));

                const updatedInfo = await this.connection.getAccountInfo(
                    associatedBondingCurveAddress,
                    'confirmed'
                );

                if (updatedInfo) {
                    accountCreated = true;
                    logger.info('关联绑定曲线账户创建成功', {
                        address: associatedBondingCurveAddress.toString(),
                        size: updatedInfo.data?.length || 0,
                        owner: updatedInfo.owner?.toString()
                    });
                } else {
                    logger.warn(`账户验证尝试 ${verificationRetry + 1} 失败`, {
                        address: associatedBondingCurveAddress.toString()
                    });
                }

                verificationRetry++;
            }

            if (!accountCreated) {
                throw new Error('关联绑定曲线账户初始化失败');
            }

            return true;

        } catch (error) {
            logger.error('确保关联绑定曲线账户存在失败', {
                error: error.message,
                user: user?.publicKey?.toString() || user?.toString(),
                mint: mint?.toString(),
                stack: error.stack
            });
            throw error;  // 抛出错误以便上层处理
        }
    }

    // customPumpSDK.js (sell 相关部分)
    // In CustomPumpSDK class
    async sell(seller, mint, sellTokenAmount, slippageBasisPoints = 100n, priorityFees, options = {}) {
        let jitoService = null;
        const startTime = Date.now();

        try {
            // 1. 将卖出金额转换为负数 BigInt
            const tokenAmountBigInt = typeof sellTokenAmount === 'bigint' ?
                -sellTokenAmount : -BigInt(sellTokenAmount.toString());
            const slippagePointsBigInt = typeof slippageBasisPoints === 'bigint' ?
                slippageBasisPoints : BigInt(slippageBasisPoints.toString());

            // 2. 创建基础交易实例
            let sellTransaction = new Transaction();

            logger.info('开始卖出代币:', {
                seller: seller.publicKey.toString(),
                mint: mint.toString(),
                amount: tokenAmountBigInt.toString(),
                slippage: slippagePointsBigInt.toString()
            });

            // 3. 检查代币余额
            const tokenBalance = await this.getTokenBalance(seller.publicKey, mint);
            if (BigInt(tokenBalance) < BigInt(sellTokenAmount)) {
                throw new Error(`Insufficient token balance. Required: ${sellTokenAmount}, Available: ${tokenBalance}`);
            }

            return await this.withRetry(async () => {
                // 4. 获取卖出指令并添加到交易中
                const sellIx = await super.getSellInstructionsByTokenAmount(
                    seller.publicKey,
                    mint,
                    sellTokenAmount,
                    slippagePointsBigInt,
                    'confirmed'
                );
                sellTransaction.add(sellIx);

                // 5. 设置基础交易参数
                const {blockhash, lastValidBlockHeight} =
                    await this.connection.getLatestBlockhash('confirmed');
                sellTransaction.recentBlockhash = blockhash;
                sellTransaction.lastValidBlockHeight = lastValidBlockHeight;
                sellTransaction.feePayer = seller.publicKey;

                // 6. 添加优先费用（如果需要）
                if (options.usePriorityFee) {
                    if (options.priorityType === 'Jito') {
                        jitoService = new JitoService(this.connection);
                        await jitoService.initialize();
                        const tipAmountSol = options.jitoTipSol;
                        const wallet = seller;
                        sellTransaction = await jitoService.addTipToTransaction(
                            sellTransaction, {
                            tipAmountSol,
                                wallet
                        });
                    } else {
                        sellTransaction.add(
                            ComputeBudgetProgram.setComputeUnitPrice({
                                microLamports: priorityFees.microLamports
                            })
                        );
                    }
                }

                // 7. 发送交易
                let signature;
                if (options.usePriorityFee && options.priorityType === 'Jito') {
                    const bundleResult = await jitoService.sendBundle([sellTransaction]);
                    const beforeTimestamp = Date.now();

                    await new Promise(resolve => setTimeout(resolve, 2000));

                    const signatures = await this.connection.getSignaturesForAddress(
                        seller.publicKey,
                        {limit: 5}
                    );

                    signature = signatures.find(sig =>
                        sig.blockTime * 1000 > beforeTimestamp
                    )?.signature;

                    if (!signature) {
                        throw new Error('Failed to get Jito transaction signature');
                    }

                    logger.info('Jito transaction sent:', {
                        bundleId: bundleResult.bundleId,
                        signature
                    });
                } else {
                    signature = await sendAndConfirmTransaction(
                        this.connection,
                        sellTransaction,
                        [seller],
                        {
                            skipPreflight: false,
                            preflightCommitment: 'processed',
                            commitment: 'confirmed',
                            maxRetries: 3
                        }
                    );
                }

                // 8. 等待交易确认
                await this.connection.confirmTransaction({
                    signature,
                    blockhash,
                    lastValidBlockHeight
                }, 'confirmed');

                // 9. 返回结果
                const result = {
                    success: true,
                    signature,
                    txId: signature,
                    amount: tokenAmountBigInt.toString(),
                    mint: mint.toString(),
                    owner: seller.publicKey.toString(),
                    timestamp: new Date().toISOString(),
                    duration: Date.now() - startTime
                };

                logger.info('卖出交易成功:', {
                    signature,
                    mint: mint.toString(),
                    amount: tokenAmountBigInt.toString(),
                    duration: result.duration
                });

                return result;
            });
        } catch (error) {
            // 清理 Jito service
            if (jitoService) {
                await jitoService.cleanup().catch(e =>
                    logger.warn('清理 Jito service 失败:', e)
                );
            }

            logger.error('卖出代币失败:', {
                error: error.message,
                stack: error.stack,
                seller: seller?.publicKey?.toString(),
                mint: mint?.toString(),
                amount: sellTokenAmount.toString(),
                duration: Date.now() - startTime
            });

            throw error;
        }
    }



    // 更新 buildSellTransaction 方法
    async buildSellTransaction(seller, mint, amount, slippage, options = {}) {
        try {
            const transaction = new Transaction();

            // Get accounts
            const globalAccount = await this.getGlobalAccount();
            const bondingCurve = await this.findBondingCurveAddress(mint);
            const tokenAccount = await this.findAssociatedTokenAddress(seller, mint);

            // Calculate minimum output
            const calculatedOutput = await this.calculateSellOutput(mint, amount);
            const minOutput = this.calculateMinimumOutput(calculatedOutput, slippage);

            // Add compute budget instruction
            transaction.add(
                ComputeBudgetProgram.setComputeUnitLimit({
                    units: 400000
                })
            );

            // Build sell instruction
            const sellInstruction = await this.program.methods
                .sell(amount, minOutput)
                .accounts({
                    global: globalAccount.address,                  // 添加global账户
                    feeRecipient: globalAccount.feeRecipient,      // 添加feeRecipient账户
                    mint: mint,
                    bondingCurve: bondingCurve,
                    associatedBondingCurve: await this.findAssociatedBondingCurveAddress(seller, mint),
                    associatedUser: tokenAccount,
                    user: seller,
                    systemProgram: SystemProgram.programId,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    eventAuthority: new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'),
                    program: this.program.programId
                })
                .instruction();

            transaction.add(sellInstruction);

            logger.info('卖出交易构建成功:', {
                seller: seller.toString(),
                mint: mint.toString(),
                amount: amount.toString(),
                minOutput: minOutput.toString(),
                feeRecipient: globalAccount.feeRecipient.toString()
            });

            return {
                transaction,
                signers: []
            };
        } catch (error) {
            logger.error('构建卖出交易失败:', {
                error: error.message,
                seller: seller.toString(),
                mint: mint.toString(),
                stack: error.stack
            });
            throw error;
        }
    }

    toBN(value, options = {allowNegative: false, decimals: 0}) {
        try {
            // 处理null/undefined
            if (value === null || value === undefined) {
                throw new Error('Cannot convert null or undefined to BN');
            }

            // 已经是BN实例
            if (BN.isBN(value)) {
                return value;
            }

            // 处理BigInt
            if (typeof value === 'bigint') {
                return new BN(value.toString());
            }

            // 处理数字
            if (typeof value === 'number') {
                // 检查是否为有效数字
                if (!Number.isFinite(value)) {
                    throw new Error('Cannot convert infinite or NaN to BN');
                }

                // 处理小数
                if (options.decimals > 0) {
                    const multiplier = Math.pow(10, options.decimals);
                    value = Math.floor(value * multiplier);
                } else {
                    value = Math.floor(value);
                }

                // 转换为字符串并移除小数点
                const valueStr = value.toString().replace('.', '');
                return new BN(valueStr);
            }

            // 处理字符串
            if (typeof value === 'string') {
                // 移除所有非数字字符(除了负号)
                const cleanStr = options.allowNegative
                    ? value.replace(/[^\d-]/g, '')
                    : value.replace(/[^\d]/g, '');

                if (!cleanStr) {
                    throw new Error('String contains no valid numeric characters');
                }

                // 处理负数
                if (cleanStr.startsWith('-')) {
                    if (!options.allowNegative) {
                        throw new Error('Negative values not allowed');
                    }
                    return new BN(cleanStr);
                }

                return new BN(cleanStr);
            }

            // 处理有toString方法的对象
            if (value && typeof value.toString === 'function') {
                const strValue = value.toString();

                // 递归尝试转换字符串值
                return this.toBN(strValue, options);
            }

            throw new Error(`Cannot convert ${typeof value} to BN`);
        } catch (error) {
            logger.error('BN转换失败:', {
                value: typeof value === 'bigint' ? value.toString() : value,
                type: typeof value,
                error: error.message
            });
            throw error;
        }
    }

    async calculateSellOutput(mint, tokenAmount) {
        try {
            const bondingCurve = await this.findBondingCurveAddress(mint);
            const account = await this.program.account.bondingCurve.fetch(bondingCurve);

            const currentTokenReserves = this.toBN(account.virtualTokenReserves);
            const currentSolReserves = this.toBN(account.virtualSolReserves);
            const sellAmount = this.toBN(tokenAmount);

            // Ensure not selling more than available
            const newTokenReserves = currentTokenReserves.sub(sellAmount);
            if (newTokenReserves.ltn(0)) {
                throw new Error('Insufficient token reserves');
            }

            // Calculate output using bonding curve formula
            const k = currentSolReserves.mul(currentTokenReserves);
            const newSolReserves = k.div(newTokenReserves);
            return newSolReserves.sub(currentSolReserves);
        } catch (error) {
            throw new Error(`Failed to calculate sell output: ${error.message}`);
        }
    }

    calculateMinimumOutput(amount, slippageBasisPoints) {
        try {
            const amountBN = this.toBN(amount);
            const basisPointsBN = this.toBN(slippageBasisPoints);
            const TEN_THOUSAND = new BN(10000);

            // Calculate slippage amount
            const slippageAmount = amountBN.mul(basisPointsBN).div(TEN_THOUSAND);

            // Subtract slippage for minimum output
            const minOutput = amountBN.sub(slippageAmount);

            if (minOutput.ltn(0)) {
                throw new Error('Slippage calculation resulted in negative amount');
            }

            return minOutput;
        } catch (error) {
            throw new Error(`Failed to calculate minimum output: ${error.message}`);
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
    async getGlobalAccount() {
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
    analyzeSimulationError(simulationResult) {
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
    async calculateTransactionFees(amountLamports, options) {
        try {
            // 确保输入是 BigInt
            const amount = BigInt(amountLamports.toString());

            const fees = {
                // 基本交易费 (0.000005 SOL)
                baseFee: BigInt(5000),

                // 优先费用
                priorityFee: options.usePriorityFee ?
                    BigInt(Math.floor(options.jitoTipSol * LAMPORTS_PER_SOL)) :
                    BigInt(0),

                // Pump 费用 (1%)
                pumpFee: amount / BigInt(100),

                // 滑点
                slippage: (amount * BigInt(options.slippage || 1000)) / BigInt(10000),

                // 计算单元费用
                computeUnitFee: BigInt(400000) * BigInt(1),

                // 缓冲金额 (0.002 SOL)
                buffer: BigInt(2000000)
            };

            // 计算总费用
            const totalFees = Object.values(fees).reduce(
                (sum, fee) => sum + BigInt(fee.toString()),
                BigInt(0)
            );

            return {
                ...fees,
                total: totalFees
            };
        } catch (error) {
            logger.error('计算交易费用失败:', {
                error: error.message,
                amountLamports: amountLamports?.toString(),
                options
            });
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
    async validateAndConvertAmount(amount, type = 'buy') {
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
    async waitForTransaction(signature, commitment = 'confirmed', maxRetries = 30) {
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
    async testFullProcess(creator, mint, metadata, initialAmount, secondBuyAmount) {
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
    async subscribeToAccount(publicKey, callback) {
        return this.wsManager.subscribeToAccount(publicKey, callback);
    }

    async unsubscribeFromAccount(publicKey) {
        return this.wsManager.unsubscribeFromAccount(publicKey);
    }

    async cleanup() {
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

    async validateBatchOperation(op, index) {
        try {
            // Check wallet
            if (!op?.wallet?.publicKey) {
                throw new Error('Invalid wallet');
            }

            // Check mint
            if (!op?.mint) {
                throw new Error('Invalid mint address');
            }

            // Check amount - try multiple possible fields
            const solAmount = op.solAmount || op.buyAmount || op.amount;
            if (typeof solAmount !== 'number' || isNaN(solAmount) || solAmount <= 0) {
                throw new Error(`Invalid amount: ${solAmount}`);
            }

            // Validate options
            const options = op.options || {};
            const slippageBasisPoints = options.slippageBasisPoints || 1000;
            if (slippageBasisPoints < 0 || slippageBasisPoints > 10000) {
                throw new Error('Invalid slippage (must be between 0 and 10000)');
            }

            // Return normalized operation object
            return {
                wallet: op.wallet,
                mint: op.mint,
                solAmount: solAmount,
                buyAmountLamports: BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL)),
                tipAmountLamports: op.tipAmountSol ?
                    BigInt(Math.floor(op.tipAmountSol * LAMPORTS_PER_SOL)) :
                    BigInt(0),
                options: {
                    ...options,
                    slippageBasisPoints
                }
            };
        } catch (error) {
            logger.error(`Operation ${index} validation failed:`, {
                error: error.message,
                wallet: op?.wallet?.publicKey?.toString(),
                original: op
            });
            return {
                error: error.message,
                index,
                wallet: op?.wallet?.publicKey?.toString()
            };
        }
    }

    // 1. 初始化批量配置
// 修改现有的 _initializeBatchConfig 方法
    _initializeBatchConfig(options) {
        return {
            bundleMaxSize: Math.min(options.bundleMaxSize || 3, 5),
            maxSolAmount: options.maxSolAmount || 1000,
            retryAttempts: options.retryAttempts || 3,
            confirmationTimeout: options.confirmationTimeout || 30000,
            batchInterval: options.batchInterval || 2000,
            minComputeUnits: 400000,
            reserveAmount: BigInt(100000),
            waitBetweenBundles: options.waitBetweenBundles || 3000,
            // 新增配置参数
            simulationBatchSize: options.simulationBatchSize || 1, // 较小批次大小以避免429错误
            simulationCooldown: options.simulationCooldown || 1000, // 模拟批次之间的冷却时间
            maxSimulationRetries: options.maxSimulationRetries || 3, // 模拟的最大重试次数
            backoffMultiplier: options.backoffMultiplier || 1.5, // 退避时间倍增系数
            initialBackoff: options.initialBackoff || 800, // 初始退避时间
            maxBackoff: options.maxBackoff || 8000, // 最大退避时间
        };
    }

// 2. 初始化Jito服务
    async _initializeJitoService() {
        const jitoService = new JitoService(this.connection);
        await jitoService.initialize();
        return jitoService;
    }

// 3. 获取最新区块哈希
    async _getLatestBlockhash() {
        const {blockhash, lastValidBlockHeight} =
            await this.connection.getLatestBlockhash('confirmed');
        return {blockhash, lastValidBlockHeight};
    }

// 4. 验证操作
    // 4. 验证操作 - 修改处理钱包部分的代码
    async validateOperations(operations, config) {
        const validatedOps = [];
        const invalidResults = [];
        const BATCH_SIZE = 10;

        logger.info('开始批量验证操作:', {
            totalOperations: operations.length,
            batchSize: BATCH_SIZE,
            name: "App",
            timestamp: new Date().toISOString()
        });

        for (let i = 0; i < operations.length; i += BATCH_SIZE) {
            const batch = operations.slice(i, i + BATCH_SIZE);

            const batchResults = await Promise.all(batch.map(async (op, index) => {
                const actualIndex = i + index;
                try {
                    // 基础验证
                    if (!op?.wallet?._keypair?.publicKey) {
                        throw new Error('无效的钱包');
                    }

                    // 正确处理钱包对象 - 从_keypair创建新的Keypair实例
                    if (op.wallet._keypair) {
                        // 不要尝试设置publicKey属性，而是创建一个新的Keypair对象
                        const keypair = Keypair.fromSecretKey(
                            Buffer.from(op.wallet._keypair.secretKey)
                        );

                        // 替换整个wallet对象，而不是修改原始对象
                        op.wallet = keypair;
                    }

                    if (!op?.mint) {
                        throw new Error('无效的铸币地址');
                    }

                    // 验证金额
                    const solAmount = op.solAmount || op.buyAmount;
                    if (typeof solAmount !== 'number' || isNaN(solAmount) || solAmount <= 0) {
                        throw new Error(`无效的金额: ${solAmount}`);
                    }

                    // 验证金额上限
                    if (solAmount > config.maxSolAmount) {
                        throw new Error(`金额超过最大限制 ${config.maxSolAmount} SOL`);
                    }

                    // 转换为 lamports
                    const buyAmountLamports = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL));

                    // 验证 tip 金额
                    const tipAmountLamports = op.tipAmountSol ?
                        BigInt(Math.floor(op.tipAmountSol * LAMPORTS_PER_SOL)) :
                        BigInt(0);

                    // 创建临时交易以估算费用
                    const tempTx = new Transaction();
                    const {blockhash, lastValidBlockHeight} = await this._getLatestBlockhash();
                    tempTx.recentBlockhash = blockhash;
                    tempTx.feePayer = op.wallet.publicKey;
                    tempTx.lastValidBlockHeight = lastValidBlockHeight;

                    // 添加计算预算指令以更准确估算费用
                    tempTx.add(
                        ComputeBudgetProgram.setComputeUnitLimit({
                            units: config.minComputeUnits
                        })
                    );

                    // 动态计算预估费用
                    const estimatedFee = await this.connection.getFeeForMessage(
                        tempTx.compileMessage(),
                        'confirmed'
                    );

                    // 检查余额
                    const balance = await this.connection.getBalance(op.wallet.publicKey);
                    const totalRequired = buyAmountLamports +
                        BigInt(estimatedFee.value || 50000) +
                        tipAmountLamports +
                        config.reserveAmount;

                    logger.info(`操作 ${actualIndex} 账户余额检查:`, {
                        wallet: op.wallet.publicKey.toString(),
                        balance: balance.toString(),
                        required: totalRequired.toString(),
                        buyAmount: buyAmountLamports.toString(),
                        estimatedFee: (estimatedFee.value || 5000).toString(),
                        tipAmount: tipAmountLamports.toString(),
                        reserveAmount: config.reserveAmount.toString(),
                        sufficientBalance: BigInt(balance) >= totalRequired,
                        name: "App",
                        timestamp: new Date().toISOString()
                    });

                    if (BigInt(balance) < totalRequired) {
                        throw new Error(
                            `余额不足 ${op.wallet.publicKey.toString()}. ` +
                            `需要: ${totalRequired.toString()}, ` +
                            `可用: ${balance.toString()}`
                        );
                    }

                    return {
                        status: 'ready',
                        data: {
                            ...op,
                            buyAmountLamports,
                            tipAmountLamports,
                            estimatedFee: BigInt(estimatedFee.value || 5000),
                            index: actualIndex
                        }
                    };
                } catch (error) {
                    logger.error(`操作 ${actualIndex} 验证失败:`, {
                        error: error.message,
                        wallet: op?.wallet?.publicKey?.toString() || 'unknown',
                        operation: typeof op === 'object' ? JSON.stringify(op) : 'invalid',
                        name: "App",
                        timestamp: new Date().toISOString()
                    });

                    // 添加到结果中，记录失败
                    invalidResults.push({
                        success: false,
                        wallet: op?.wallet?.publicKey?.toString() || 'unknown',
                        error: error.message,
                        errorType: 'ValidationError',
                        index: actualIndex,
                        timestamp: new Date().toISOString()
                    });

                    return {
                        status: 'failed',
                        error: error.message,
                        data: op
                    };
                }
            }));

            // 过滤并添加有效操作
            const validOpsInBatch = batchResults
                .filter(result => result.status === 'ready')
                .map(result => result.data);

            validatedOps.push(...validOpsInBatch);

            logger.debug(`批次 ${Math.floor(i / BATCH_SIZE) + 1} 验证结果:`, {
                totalInBatch: batch.length,
                validInBatch: validOpsInBatch.length,
                failedInBatch: batch.length - validOpsInBatch.length
            });

            // 等待一小段时间，避免RPC节点过载
            if (i + BATCH_SIZE < operations.length) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        logger.info('操作验证阶段完成:', {
            totalOperations: operations.length,
            validOperations: validatedOps.length,
            failedOperations: operations.length - validatedOps.length,
            name: "App",
            timestamp: new Date().toISOString()
        });

        return {validatedOps, invalidResults};
    }

// 5. 将操作分组到不同Bundle
    groupIntoWalletBundles(validatedOps, config) {
        // 按钱包分组
        const walletGroups = {};
        validatedOps.forEach(op => {
            const walletKey = op.wallet.publicKey.toString();
            if (!walletGroups[walletKey]) {
                walletGroups[walletKey] = [];
            }
            walletGroups[walletKey].push(op);
        });

        logger.info('开始构建交易包:', {
            totalWallets: Object.keys(walletGroups).length,
            name: "App",
            timestamp: new Date().toISOString()
        });

        // 智能分配交易到不同bundle
        const bundles = [];
        let currentBundle = [];
        const wallets = Object.keys(walletGroups);

        // 先处理每个钱包的第一笔交易
        for (let i = 0; i < wallets.length; i++) {
            const wallet = wallets[i];
            if (walletGroups[wallet].length > 0) {
                currentBundle.push(walletGroups[wallet][0]);
                walletGroups[wallet] = walletGroups[wallet].slice(1);

                logger.debug(`钱包 ${wallet.substring(0, 8)}... 第一笔交易添加到bundle:`, {
                    bundleSize: currentBundle.length,
                    remainingOps: walletGroups[wallet].length
                });

                if (currentBundle.length >= config.bundleMaxSize || i === wallets.length - 1) {
                    if (currentBundle.length > 0) {
                        bundles.push([...currentBundle]);
                        logger.debug(`Bundle ${bundles.length} 创建完成`, {
                            bundleSize: currentBundle.length,
                            walletsInBundle: currentBundle.map(op => op.wallet.publicKey.toString().substring(0, 8) + '...')
                        });
                        currentBundle = [];
                    }
                }
            }
        }

        // 处理剩余交易
        let moreTransactions = true;
        while (moreTransactions) {
            moreTransactions = false;

            for (const wallet of wallets) {
                if (walletGroups[wallet].length > 0) {
                    moreTransactions = true;
                    currentBundle.push(walletGroups[wallet][0]);
                    walletGroups[wallet] = walletGroups[wallet].slice(1);

                    logger.debug(`钱包 ${wallet.substring(0, 8)}... 额外交易添加到bundle:`, {
                        bundleSize: currentBundle.length,
                        remainingOps: walletGroups[wallet].length
                    });

                    if (currentBundle.length >= config.bundleMaxSize) {
                        bundles.push([...currentBundle]);
                        logger.debug(`Bundle ${bundles.length} 创建完成`, {
                            bundleSize: currentBundle.length,
                            walletsInBundle: currentBundle.map(op => op.wallet.publicKey.toString().substring(0, 8) + '...')
                        });
                        currentBundle = [];
                    }
                }
            }

            if (currentBundle.length > 0 && !moreTransactions) {
                bundles.push([...currentBundle]);
                logger.debug(`最终Bundle ${bundles.length} 创建完成`, {
                    bundleSize: currentBundle.length,
                    walletsInBundle: currentBundle.map(op => op.wallet.publicKey.toString().substring(0, 8) + '...')
                });
                currentBundle = [];
            }
        }

        return bundles;
    }

// 6. 构建单个Bundle中的交易
    async buildBundleTransactions(bundle, jitoService, blockhashInfo) {
        const {blockhash, lastValidBlockHeight} = blockhashInfo;
        const signedTransactions = [];
        const failedOps = [];

        logger.info(`构建Bundle中的交易...`, {
            name: "App",
            timestamp: new Date().toISOString()
        });

        const transactionPromises = bundle.map(async (op, index) => {
            try {
                // 构建交易
                let transaction = new Transaction();

                // 添加计算预算指令
                transaction.add(
                    ComputeBudgetProgram.setComputeUnitLimit({
                        units: 400000
                    })
                );

                // 检查并创建ATA账户（如需要）
                const ataAddress = await this.findAssociatedTokenAddress(
                    op.wallet.publicKey,
                    new PublicKey(op.mint)
                );

                const ataAccount = await this.connection.getAccountInfo(ataAddress);
                if (!ataAccount) {
                    const createAtaIx = createAssociatedTokenAccountInstruction(
                        op.wallet.publicKey,
                        ataAddress,
                        op.wallet.publicKey,
                        new PublicKey(op.mint),
                        TOKEN_PROGRAM_ID,
                        ASSOCIATED_TOKEN_PROGRAM_ID
                    );
                    transaction.add(createAtaIx);
                }

                // 构建购买指令
                logger.info('开始获取全局账户', {
                    name: "App",
                    timestamp: new Date().toISOString()
                });

                const globalAccount = await this.getGlobalAccount();
                const initialBuyPrice = globalAccount.getInitialBuyPrice(op.buyAmountLamports);
                const buyAmountWithSlippage = await this.calculateWithSlippageBuy(
                    initialBuyPrice,
                    BigInt(op.options?.slippageBasisPoints || 1000)
                );

                const buyIx = await this.getBuyInstructions(
                    op.wallet.publicKey,
                    new PublicKey(op.mint),
                    globalAccount.feeRecipient,
                    initialBuyPrice,
                    buyAmountWithSlippage
                );

                transaction.add(buyIx);

                // 设置交易参数
                transaction.recentBlockhash = blockhash;
                transaction.feePayer = op.wallet.publicKey;
                transaction.lastValidBlockHeight = lastValidBlockHeight;
                const wallet =  op.wallet;
                // 添加Jito小费（只对第一笔交易添加）
                if (index === 0 && jitoService && op.tipAmountLamports > BigInt(0)) {
                    const tipAmountSol = op.jitoTipSol;
                    transaction = await jitoService.addTipToTransaction(
                        transaction, {
                        tipAmountSol,
                            wallet
                    });
                }

                // 重要: 直接使用wallet对象签名，不尝试进行任何修改
                // wallet对象现在应该已经是一个有效的Keypair对象
                transaction.partialSign(op.wallet);

                // 验证签名是否成功
                const signature = transaction.signatures.find(
                    sig => sig.publicKey.equals(op.wallet.publicKey) && sig.signature !== null
                );

                if (!signature || !signature.signature) {
                    throw new Error(`签名验证失败: ${op.wallet.publicKey.toString()}`);
                }

                return {status: 'success', transaction, originalOp: op};
            } catch (error) {
                logger.error(`Bundle 1, 操作 ${index + 1}: 构建交易失败:`, {
                    error: error.message,
                    wallet: op.wallet.publicKey.toString().substring(0, 8) + '...',
                    mint: op.mint.toString().substring(0, 8) + '...',
                    index: op.index,
                    name: "App",
                    timestamp: new Date().toISOString()
                });

                failedOps.push({
                    success: false,
                    wallet: op.wallet.publicKey.toString(),
                    error: error.message,
                    errorType: 'TransactionBuildError',
                    index: op.index,
                    timestamp: new Date().toISOString()
                });

                return {status: 'failed', error};
            }
        });

        const results = await Promise.all(transactionPromises);
        const successfulBuilds = results.filter(r => r.status === 'success');

        signedTransactions.push(...successfulBuilds.map(r => r.transaction));

        logger.info(`Bundle 1 交易构建结果:`, {
            totalOperations: bundle.length,
            successfulBuilds: successfulBuilds.length,
            failedBuilds: bundle.length - successfulBuilds.length,
            name: "App",
            timestamp: new Date().toISOString()
        });

        return {signedTransactions, failedOps};
    }

// 7. 发送并监控交易包
    async sendAndMonitorBundle(signedTransactions, jitoService, blockhashInfo, config) {
        const results = [];
        const batchStartTime = Date.now();

        if (signedTransactions.length === 0) {
            return results;
        }

        try {
            // 发送bundle
            logger.info(`开始发送交易Bundle (${signedTransactions.length} 笔交易)...`);
            const bundleResult = await jitoService.sendBundle(signedTransactions);

            // 获取所有签名
            const signatures = signedTransactions.map(tx => {
                const sigBytes = tx.signatures[0].signature;
                return bs58.encode(sigBytes);
            });

            logger.debug(`Bundle签名列表:`, {
                signatures: signatures.map(sig => sig.substring(0, 8) + '...')
            });

            // 记录初始结果
            signedTransactions.forEach((tx, txIndex) => {
                const signature = bs58.encode(tx.signatures[0].signature);

                const result = {
                    success: true,
                    wallet: tx.feePayer.toString(),
                    signature,
                    bundleId: bundleResult.bundleId,
                    timestamp: new Date().toISOString(),
                    confirmed: false,
                    confirmationStatus: 'pending'
                };

                results.push(result);
            });

            // 异步检查确认状态
            this._checkTransactionConfirmations(signatures, results, blockhashInfo, config);

            return results;
        } catch (error) {
            // 处理发送失败
            logger.error(`Bundle发送失败:`, {
                error: error.message,
                transactionCount: signedTransactions.length
            });

            signedTransactions.forEach(tx => {
                results.push({
                    success: false,
                    wallet: tx.feePayer.toString(),
                    error: error.message,
                    errorType: 'BundleSendError',
                    timestamp: new Date().toISOString()
                });
            });

            return results;
        }
    }

// 8. 检查交易确认状态
    async _checkTransactionConfirmations(signatures, results, blockhashInfo, config, attempt = 1, maxAttempts = 5) {
        try {
            // 等待一段时间后检查
            await new Promise(resolve => setTimeout(resolve, 2000));

            logger.info(`检查交易的链上确认状态 (尝试 ${attempt}/${maxAttempts})...`);

            // 并行获取所有交易状态
            const confirmationStatuses = await Promise.all(
                signatures.map(async (signature) => {
                    try {
                        const status = await this.connection.getSignatureStatus(signature, {
                            searchTransactionHistory: true
                        });

                        return {
                            signature,
                            confirmed: status?.value?.confirmationStatus === 'confirmed' ||
                                status?.value?.confirmationStatus === 'finalized',
                            status: status?.value?.confirmationStatus || 'unknown',
                            error: status?.value?.err,
                            slot: status?.value?.slot
                        };
                    } catch (error) {
                        const isNotFound = error.message?.includes('not found');

                        return {
                            signature,
                            confirmed: false,
                            status: isNotFound ? 'pending' : 'error',
                            error: error.message
                        };
                    }
                })
            );

            // 更新结果
            confirmationStatuses.forEach(status => {
                const resultIndex = results.findIndex(r => r.signature === status.signature);
                if (resultIndex >= 0) {
                    results[resultIndex].confirmed = status.confirmed;
                    results[resultIndex].confirmationStatus = status.status;
                    results[resultIndex].confirmationError = status.error;

                    logger.debug(`交易 ${status.signature.substring(0, 8)}... 状态:`, {
                        status: status.status,
                        confirmed: status.confirmed,
                        error: status.error ? true : false
                    });
                }
            });

            // 检查是否需要继续等待确认
            const pendingCount = confirmationStatuses.filter(s => !s.confirmed && !s.error).length;
            const confirmed = confirmationStatuses.filter(s => s.confirmed).length;
            const failed = confirmationStatuses.filter(s => s.error).length;

            logger.info(`确认摘要 (尝试 ${attempt}/${maxAttempts}):`, {
                totalTransactions: signatures.length,
                confirmed,
                failed,
                pending: pendingCount
            });

            if (pendingCount > 0 && attempt < maxAttempts) {
                // 递归检查
                setTimeout(() => {
                    this._checkTransactionConfirmations(
                        signatures.filter(sig => {
                            const status = confirmationStatuses.find(s => s.signature === sig);
                            return !status.confirmed && !status.error;
                        }),
                        results,
                        blockhashInfo,
                        config,
                        attempt + 1,
                        maxAttempts
                    );
                }, 2000 * attempt);
            } else if (pendingCount > 0) {
                logger.warn(`${maxAttempts} 次尝试后仍有未确认交易:`, {
                    pendingCount,
                    pendingSignatures: confirmationStatuses
                        .filter(s => !s.confirmed && !s.error)
                        .map(s => s.signature.substring(0, 8) + '...')
                });
            }
        } catch (error) {
            logger.warn(`监控交易确认状态失败:`, {
                error: error.message,
                attempt
            });

            if (attempt < maxAttempts) {
                setTimeout(() => {
                    this._checkTransactionConfirmations(
                        signatures,
                        results,
                        blockhashInfo,
                        config,
                        attempt + 1,
                        maxAttempts
                    );
                }, 2000 * attempt);
            }
        }
    }

// 9. 计算批处理结果
    calculateBatchResults(results, totalOperations, startTime) {
        const successResults = results.filter(r => r.success);
        const failureResults = results.filter(r => !r.success);

        const errorCounts = failureResults.reduce((acc, curr) => {
            if (!acc[curr.errorType]) {
                acc[curr.errorType] = 0;
            }
            acc[curr.errorType]++;
            return acc;
        }, {});

        const stats = {
            totalProcessed: totalOperations,
            successCount: successResults.length,
            failureCount: failureResults.length,
            duration: Date.now() - startTime,
            errorTypes: errorCounts,
            averageTimePerOp: Math.floor((Date.now() - startTime) / totalOperations),
            elapsedTime: `${((Date.now() - startTime) / 1000).toFixed(3)} seconds`,
            successRate: `${(successResults.length / totalOperations * 100).toFixed(2)}%`,
            name: "App",
            timestamp: new Date().toISOString()
        };

        return {
            success: true,
            results: results.map(result => ({
                ...result,
                // 确保所有 BigInt 值都转换为字符串
                amount: result.amount?.toString(),
                fee: result.fee?.toString(),
                tokenBalance: result.tokenBalance?.toString()
            })),
            stats
        };
    }

// 10. 主方法 batchBuy
// Enhanced batchBuy method with simulation checks
    // 替换现有的 batchBuy 方法
    async batchBuy(operations, options = {}) {
        const startTime = Date.now();
        let jitoService = null;
        const results = [];

        try {
            // 1. 配置初始化 - 使用增强的配置
            const config = this._initializeBatchConfig(options);

            logger.info('批量购买开始 - 优化模式:', {
                operationCount: operations?.length,
                timestamp: new Date().toISOString(),
                config: {
                    ...config,
                    reserveAmount: config.reserveAmount.toString()
                },
                name: "OptimizedApp"
            });

            // 2. 初始化Jito服务
            jitoService = await this._initializeJitoService();

            // 3. 带重试的验证与标准化操作
            let validatedResult = null;
            await this._withExponentialBackoff(async () => {
                validatedResult = await this.validateOperations(operations, config);
            }, "validateOperations", config);

            if (!validatedResult) {
                throw new Error("Failed to validate operations after multiple retries");
            }

            const {validatedOps, invalidResults} = validatedResult;
            results.push(...invalidResults);

            // 4. 分组操作到交易包 - 减小每个bundle的大小以降低失败率
            const bundles = this.groupIntoWalletBundles(validatedOps, {
                ...config,
                bundleMaxSize: Math.min(config.bundleMaxSize, 3) // 确保每个bundle不超过3个交易
            });

            logger.info('交易包构建完成:', {
                totalBundles: bundles.length,
                totalTransactions: validatedOps.length,
                bundleSizes: bundles.map(b => b.length),
                name: "OptimizedApp",
                timestamp: new Date().toISOString()
            });

            // 5. 处理每个交易包
            for (let i = 0; i < bundles.length; i++) {
                logger.info(`开始处理Bundle ${i + 1}/${bundles.length}:`, {
                    operationCount: bundles[i].length,
                    bundleIndex: i + 1,
                    totalBundles: bundles.length,
                    name: "OptimizedApp",
                    timestamp: new Date().toISOString()
                });

                // 获取新的区块哈希 - 添加重试逻辑
                let blockhashInfo = null;
                await this._withExponentialBackoff(async () => {
                    blockhashInfo = await this._getLatestBlockhash();
                }, "getLatestBlockhash", config);

                if (!blockhashInfo) {
                    logger.error(`无法获取区块哈希，跳过Bundle ${i + 1}/${bundles.length}`);
                    continue;
                }

                // 构建交易但不签名 - 添加重试逻辑
                let buildResult = null;
                await this._withExponentialBackoff(async () => {
                    buildResult = await this._buildBundleTransactionsWithoutSigning(bundles[i], jitoService, blockhashInfo);
                }, "buildBundleTransactions", config);

                if (!buildResult) {
                    logger.error(`构建交易失败，跳过Bundle ${i + 1}/${bundles.length}`);
                    continue;
                }

                const {unsignedTransactions, failedOps} = buildResult;
                results.push(...failedOps);

                if (unsignedTransactions.length === 0) {
                    logger.warn(`Bundle ${i + 1}/${bundles.length} 没有有效交易，跳过`);
                    continue;
                }

                // 执行预检查和模拟 - 使用较小批次并添加冷却时间
                const simulationResults = [];
                const simulationFailedOps = [];

                // 分批模拟，每批次之间添加冷却时间
                for (let j = 0; j < unsignedTransactions.length; j += config.simulationBatchSize) {
                    const simulationBatch = unsignedTransactions.slice(j, j + config.simulationBatchSize);

                    logger.info(`模拟交易批次 ${Math.floor(j / config.simulationBatchSize) + 1}/${Math.ceil(unsignedTransactions.length / config.simulationBatchSize)}`, {
                        batchSize: simulationBatch.length,
                        totalRemaining: unsignedTransactions.length - j,
                        name: "OptimizedApp",
                    });

                    let batchSimulationResult = null;
                    await this._withExponentialBackoff(async () => {
                        // 为每个交易单独模拟，避免批量请求
                        for (const tx of simulationBatch) {
                            try {
                                const simResult = await this._simulateSingleTransaction(tx.transaction, tx.operation, blockhashInfo);
                                simulationResults.push(simResult);

                                if (!simResult.success) {
                                    simulationFailedOps.push({
                                        success: false,
                                        wallet: tx.operation.wallet.publicKey.toString(),
                                        error: simResult.error,
                                        errorType: 'SimulationError',
                                        index: tx.operation.index,
                                        timestamp: new Date().toISOString()
                                    });
                                }

                                // 短暂等待，避免RPC过载
                                await new Promise(resolve => setTimeout(resolve, 200));
                            } catch (err) {
                                logger.error(`模拟单个交易失败:`, {
                                    error: err.message,
                                    wallet: tx.operation.wallet.publicKey.toString().substring(0, 8) + '...'
                                });

                                simulationFailedOps.push({
                                    success: false,
                                    wallet: tx.operation.wallet.publicKey.toString(),
                                    error: err.message,
                                    errorType: 'SimulationException',
                                    index: tx.operation.index,
                                    timestamp: new Date().toISOString()
                                });
                            }
                        }
                        return true; // 标记成功
                    }, "simulateTransactions", config);

                    // 批次之间添加冷却时间
                    if (j + config.simulationBatchSize < unsignedTransactions.length) {
                        logger.debug(`批次模拟冷却中 (${config.simulationCooldown}ms)...`);
                        await new Promise(resolve => setTimeout(resolve, config.simulationCooldown));
                    }
                }

                results.push(...simulationFailedOps);

                // 过滤掉模拟失败的交易
                const validTransactions = simulationResults
                    .filter(result => result.success)
                    .map(result => result.transaction);

                const validOperations = simulationResults
                    .filter(result => result.success)
                    .map(result => result.operation);

                logger.info(`预检查和模拟结果 (Bundle ${i + 1}/${bundles.length}):`, {
                    totalTransactions: unsignedTransactions.length,
                    validTransactions: validTransactions.length,
                    failedTransactions: unsignedTransactions.length - validTransactions.length,
                    name: "OptimizedApp",
                    timestamp: new Date().toISOString()
                });

                // 如果所有交易都模拟失败，则跳过此bundle
                if (validTransactions.length === 0) {
                    logger.warn(`Bundle ${i + 1}/${bundles.length} 中的所有交易模拟失败，跳过此bundle`, {
                        name: "OptimizedApp",
                        timestamp: new Date().toISOString()
                    });
                    continue;
                }

                // 签名有效的交易
                let signedTransactions = null;
                await this._withExponentialBackoff(async () => {
                    signedTransactions = await this._signTransactions(validTransactions, validOperations);
                }, "signTransactions", config);

                if (!signedTransactions || signedTransactions.length === 0) {
                    logger.error(`签名交易失败，跳过Bundle ${i + 1}/${bundles.length}`);
                    continue;
                }

                // 如果有成功签名的交易，发送并监控
                if (signedTransactions.length > 0) {
                    let bundleResults = null;
                    await this._withExponentialBackoff(async () => {
                        bundleResults = await this._sendAndMonitorBundleWithRetry(
                            signedTransactions, jitoService, blockhashInfo, config
                        );
                    }, "sendAndMonitorBundle", config);

                    if (bundleResults) {
                        results.push(...bundleResults);
                    } else {
                        logger.error(`发送交易束失败，跳过Bundle ${i + 1}/${bundles.length}`);
                    }
                }

                // 两个bundle之间等待更长时间，避免网络拥塞
                if (i < bundles.length - 1) {
                    const waitTime = config.waitBetweenBundles * 2; // 倍增等待时间
                    logger.info(`等待下一个Bundle处理 (${waitTime}ms)...`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                }
            }

            // 6. 计算最终结果
            const batchResults = this.calculateBatchResults(results, operations.length, startTime);

            logger.info('批量购买完成 - 详细统计:', {
                ...batchResults.stats,
                elapsedTime: `${((Date.now() - startTime) / 1000).toFixed(3)} seconds`,
                name: "OptimizedApp",
                timestamp: new Date().toISOString()
            });

            return batchResults;

        } catch (error) {
            logger.error('批量购买处理失败:', {
                error: error.message,
                stack: error.stack,
                duration: `${(Date.now() - startTime) / 1000} seconds`,
                name: "OptimizedApp",
                timestamp: new Date().toISOString()
            });
            throw error;
        } finally {
            if (jitoService) {
                logger.info('开始清理 Jito 服务资源');
                await jitoService.cleanup().catch(e =>
                    logger.warn('清理 Jito service 失败:', e)
                );
                logger.info('Jito 服务资源清理完成');
            }
        }
    }

// 添加在 CustomPumpSDK 类中
    async _sendAndMonitorBundleWithRetry(signedTransactions, jitoService, blockhashInfo, config) {
        const results = [];
        const batchStartTime = Date.now();

        if (signedTransactions.length === 0) {
            return results;
        }

        // 初始化重试计数
        let retryAttempt = 0;
        const maxRetries = config.retryAttempts || 3;
        let backoff = config.initialBackoff || 800;

        while (retryAttempt < maxRetries) {
            try {
                // 发送bundle
                logger.info(`开始发送交易Bundle (${signedTransactions.length} 笔交易)，尝试 ${retryAttempt + 1}/${maxRetries}`);
                const bundleResult = await jitoService.sendBundle(signedTransactions);

                // 获取所有签名
                const signatures = signedTransactions.map(tx => {
                    const sigBytes = tx.signatures[0].signature;
                    return bs58.encode(sigBytes);
                });

                logger.debug(`Bundle签名列表:`, {
                    signatures: signatures.map(sig => sig.substring(0, 8) + '...')
                });

                // 记录初始结果
                signedTransactions.forEach((tx, txIndex) => {
                    const signature = bs58.encode(tx.signatures[0].signature);

                    const result = {
                        success: true,
                        wallet: tx.feePayer.toString(),
                        signature,
                        bundleId: bundleResult.bundleId,
                        timestamp: new Date().toISOString(),
                        confirmed: false,
                        confirmationStatus: 'pending'
                    };

                    results.push(result);
                });

                // 异步检查确认状态
                await this._checkTransactionConfirmations(signatures, results, blockhashInfo, config);

                return results;
            } catch (error) {
                retryAttempt++;
                const isRateLimit = error.message.includes('429') ||
                    error.message.includes('Too Many Requests') ||
                    error.message.includes('rate limit');

                logger.warn(`Bundle发送失败，尝试 ${retryAttempt}/${maxRetries}:`, {
                    error: error.message,
                    isRateLimit,
                    transactionCount: signedTransactions.length
                });

                if (retryAttempt >= maxRetries) {
                    // 记录所有失败的交易
                    signedTransactions.forEach(tx => {
                        results.push({
                            success: false,
                            wallet: tx.feePayer.toString(),
                            error: error.message,
                            errorType: 'BundleSendError',
                            timestamp: new Date().toISOString()
                        });
                    });
                    break;
                }

                // 应用指数退避
                const jitter = Math.random() * 500; // 添加随机抖动
                const waitTime = Math.min(backoff + jitter, config.maxBackoff || 8000);

                logger.info(`等待 ${waitTime.toFixed(0)}ms 后重试发送...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));

                // 增加下次退避时间
                backoff = Math.min(backoff * (config.backoffMultiplier || 1.5), config.maxBackoff || 8000);

                // 对于速率限制错误，可能需要更长的等待时间
                if (isRateLimit) {
                    const extraWait = config.maxBackoff || 8000;
                    logger.warn(`检测到速率限制，额外等待 ${extraWait}ms...`);
                    await new Promise(resolve => setTimeout(resolve, extraWait));
                }

                // 如有必要，获取新的blockhash
                if (error.message.includes('blockhash') || error.message.includes('BlockhashNotFound')) {
                    try {
                        const newBlockhashInfo = await this._getLatestBlockhash();

                        // 更新所有交易的blockhash
                        for (const tx of signedTransactions) {
                            tx.recentBlockhash = newBlockhashInfo.blockhash;
                            tx.lastValidBlockHeight = newBlockhashInfo.lastValidBlockHeight;

                            // 重新签名交易
                            tx.signatures = [];
                            const feePayer = tx.feePayer;
                            for (const signer of tx._signers) {
                                tx.partialSign(signer);
                            }
                        }

                        logger.info(`已更新所有交易的blockhash: ${newBlockhashInfo.blockhash}`);
                    } catch (bhError) {
                        logger.error(`更新blockhash失败: ${bhError.message}`);
                        // 继续重试，即使blockhash更新失败
                    }
                }
            }
        }

        return results;
    }

    // 添加在 CustomPumpSDK 类中
    async _withExponentialBackoff(operation, operationName, config) {
        let backoff = config.initialBackoff || 800;
        let attempts = 0;
        const maxRetries = config.maxSimulationRetries || 3;

        while (attempts < maxRetries) {
            try {
                return await operation();
            } catch (error) {
                attempts++;
                const isRateLimit = error.message.includes('429') ||
                    error.message.includes('Too Many Requests') ||
                    error.message.includes('rate limit');

                if (attempts >= maxRetries) {
                    logger.error(`${operationName} 达到最大重试次数 (${maxRetries})`, {
                        error: error.message,
                        attempts,
                        isRateLimit
                    });

                    // 对于速率限制错误，我们可能需要更长的等待时间
                    if (isRateLimit) {
                        logger.warn(`检测到速率限制，等待较长时间 (${config.maxBackoff * 2}ms) 后继续...`);
                        await new Promise(resolve => setTimeout(resolve, config.maxBackoff * 2));
                    }

                    return null;
                }

                // 应用指数退避
                const jitter = Math.random() * 500; // 添加随机抖动
                const waitTime = Math.min(backoff + jitter, config.maxBackoff || 8000);

                logger.warn(`${operationName} 失败, 重试中... (${attempts}/${maxRetries}) 等待 ${waitTime.toFixed(0)}ms`, {
                    error: error.message,
                    isRateLimit,
                    backoff: waitTime.toFixed(0)
                });

                await new Promise(resolve => setTimeout(resolve, waitTime));

                // 增加下次退避时间
                backoff = Math.min(backoff * (config.backoffMultiplier || 1.5), config.maxBackoff || 8000);
            }
        }

        return null;
    }

// 添加在 CustomPumpSDK 类中
    async _simulateSingleTransaction(transaction, operation, blockhashInfo) {
        const wallet = operation.wallet;

        try {
            // 深度验证链上账户状态
            try {
                const accountValidation = await this._validateAccountsExistence(transaction, wallet);
                if (!accountValidation.isValid) {
                    return {
                        success: false,
                        error: `账户验证失败: ${accountValidation.error}`,
                        transaction,
                        operation
                    };
                }
            } catch (accountError) {
                logger.warn(`账户验证异常，继续模拟: ${accountError.message}`);
                // 账户验证失败不阻止模拟，只记录警告
            }

            // 模拟交易 - 添加错误处理
            let simulation;
            try {
                simulation = await this.connection.simulateTransaction(
                    transaction,
                    [wallet], // Pass wallet as part of an array of signers
                    false     // includeAccounts parameter
                );
                logger.info("simulation", {simulation});
                logger.info('模拟详细结果:', {
                    wallet: wallet.publicKey.toString(),
                    mint: operation.mint.toString(),
                    buyAmount: operation.buyAmountLamports.toString(),
                    logs: simulation.value.logs,
                    err: simulation.value.err,
                    unitsConsumed: simulation.value.unitsConsumed,
                    computeUnits: simulation.value.unitsConsumed || 0,
                    rawResult: JSON.stringify(simulation.value)
                });
            } catch (simError) {
                logger.info("Simulation Error Details:", {
                    message: simError.message,
                    name: simError.name,
                    stack: simError.stack,
                    // For specific Solana error properties
                    code: simError.code,
                    logs: simError.logs,
                    // Stringify the whole error for inspection
                    fullError: JSON.stringify(simError, Object.getOwnPropertyNames(simError))
                });

                // Use console.log as a direct fallback
                console.log("SIMULATION ERROR DETAILS:", {
                    message: simError.message,
                    name: simError.name,
                    stack: simError.stack?.split('\n').slice(0, 3).join('\n')
                });
                // 检查是否是速率限制错误
                if (simError.message.includes('429') ||
                    simError.message.includes('Too Many Requests') ||
                    simError.message.includes('rate limit')) {

                    throw simError; // 重新抛出速率限制错误，让调用者处理重试
                }

                return {
                    success: false,
                    error: `模拟执行异常: ${simError.message}`,
                    transaction,
                    operation
                };
            }

            // 分析模拟结果
            const logs = simulation.value.logs || [];
            const error = simulation.value.err;

            if (error) {
                logger.error('模拟返回错误详情:', {
                    wallet: wallet.publicKey.toString(),
                    error: JSON.stringify(error),
                    errorParsed: this._parseSimulationError(error, logs),
                    operation: {
                        mint: operation.mint.toString(),
                        amount: operation.buyAmountLamports.toString()
                    },
                    allLogs: logs // 输出所有日志，不只是最后几条
                });
                const errorMessage = this._parseSimulationError(error, logs);

                logger.debug(`交易模拟失败:`, {
                    wallet: wallet.publicKey.toString().substring(0, 8) + '...',
                    error: errorMessage,
                    // 只记录关键日志，减少日志量
                    logs: logs.filter(log =>
                        log.includes('Error') ||
                        log.includes('error') ||
                        log.includes('failed')
                    ).slice(-3),
                    timestamp: new Date().toISOString()
                });

                return {
                    success: false,
                    error: errorMessage,
                    transaction,
                    operation
                };
            }

            // 计算并记录计算单元使用情况
            const computeUnits = simulation.value.unitsConsumed || 0;

            // 以更低频率获取费用估算，以避免RPC过载
            let estimatedFee = 5000; // 默认估计值
            try {
                const feeEstimate = await this.connection.getFeeForMessage(
                    transaction.compileMessage(),
                    'confirmed'
                );
                estimatedFee = feeEstimate.value || 5000;
            } catch (feeError) {
                logger.warn(`费用估算失败，使用默认值: ${feeError.message}`);
            }

            logger.debug(`交易模拟成功:`, {
                wallet: wallet.publicKey.toString().substring(0, 8) + '...',
                computeUnits,
                estimatedFee,
                timestamp: new Date().toISOString()
            });

            // 验证余额是否足够
            let balance = 0;
            try {
                balance = await this.connection.getBalance(wallet.publicKey);
            } catch (balanceError) {
                logger.warn(`获取余额失败，跳过余额验证: ${balanceError.message}`);
                // 不阻止交易，继续执行
                return {
                    success: true,
                    transaction,
                    operation,
                    computeUnits,
                    estimatedFee
                };
            }

            const totalRequired = operation.buyAmountLamports +
                BigInt(estimatedFee) +
                BigInt(50000); // 额外安全裕量

            if (BigInt(balance) < totalRequired) {
                const errorMessage = `余额不足，需要: ${totalRequired.toString()}, 当前: ${balance}`;

                logger.warn(`余额检查失败:`, {
                    wallet: wallet.publicKey.toString().substring(0, 8) + '...',
                    required: totalRequired.toString(),
                    balance,
                    timestamp: new Date().toISOString()
                });

                return {
                    success: false,
                    error: errorMessage,
                    transaction,
                    operation
                };
            }

            // 模拟成功
            return {
                success: true,
                transaction,
                operation,
                computeUnits,
                estimatedFee
            };

        } catch (error) {
            // 捕获任何未处理的错误
            logger.error(`交易模拟异常:`, {
                wallet: wallet.publicKey.toString().substring(0, 8) + '...',
                error: error.message,
                timestamp: new Date().toISOString()
            });

            // 重新抛出错误，让调用者处理重试
            throw error;
        }
    }


// 新方法：构建交易但不签名
    // 替换现有的 _buildBundleTransactionsWithoutSigning 方法
    // 替换现有的 _buildBundleTransactionsWithoutSigning 方法
    async _buildBundleTransactionsWithoutSigning(bundle, jitoService, blockhashInfo) {
        const {blockhash, lastValidBlockHeight} = blockhashInfo;
        const unsignedTransactions = [];
        const failedOps = [];

        logger.info(`构建Bundle中的交易 (不签名)...`, {
            name: "OptimizedApp",
            timestamp: new Date().toISOString()
        });

        const transactionPromises = bundle.map(async (op, index) => {
            try {
                // 构建交易
                let transaction = new Transaction();

                // 添加计算预算指令
                transaction.add(
                    ComputeBudgetProgram.setComputeUnitLimit({
                        units: 400000
                    })
                );
                //
                // // 检查并创建ATA账户（如需要）
                // const ataAddress = await this.findAssociatedTokenAddress(
                //     op.wallet.publicKey,
                //     new PublicKey(op.mint)
                // );
                //
                // // 验证ATA账户状态
                // const ataAccount = await this.connection.getAccountInfo(ataAddress);
                // if (!ataAccount) {
                //     const createAtaIx = createAssociatedTokenAccountInstruction(
                //         op.wallet.publicKey,
                //         ataAddress,
                //         op.wallet.publicKey,
                //         new PublicKey(op.mint),
                //         TOKEN_PROGRAM_ID,
                //         ASSOCIATED_TOKEN_PROGRAM_ID
                //     );
                //     transaction.add(createAtaIx);
                //
                //     logger.debug(`为钱包 ${op.wallet.publicKey.toString()} 添加创建ATA指令`, {
                //         mint: op.mint,
                //         ataAddress: ataAddress.toString()
                //     });
                // }
                //
                // // 构建购买指令
                // logger.debug('开始获取全局账户', {
                //     name: "OptimizedApp",
                //     timestamp: new Date().toISOString()
                // });

                const globalAccount = await this.getGlobalAccount();
                const initialBuyPrice = globalAccount.getInitialBuyPrice(op.buyAmountLamports);
                const buyAmountWithSlippage = await this.calculateWithSlippageBuy(
                    initialBuyPrice,
                    BigInt(op.options?.slippageBasisPoints || 1000)
                );
                logger.info("initialBuyPrice,buyAmountWithSlippage:",{initialBuyPrice,buyAmountWithSlippage})
                const buyIx = await this.getBuyInstructions(
                    op.wallet.publicKey,
                    new PublicKey(op.mint),
                    globalAccount.feeRecipient,
                    initialBuyPrice,
                    buyAmountWithSlippage
                );
                logger.info("buyIx",{buyIx})
                transaction.add(buyIx);

                // 设置交易参数
                transaction.recentBlockhash = blockhash;
                transaction.feePayer = op.wallet.publicKey;
                transaction.lastValidBlockHeight = lastValidBlockHeight;
                const tipAmountSol = op.tipAmountLamports
                const wallet = op.wallet;
                // 添加Jito小费（只对第一笔交易添加）
                if (index === 0 && jitoService && op.tipAmountLamports > BigInt(0)) {
                    logger.info("buyIx,transaction",{buyIx,transaction})
                    transaction = await jitoService.addTipToTransaction(
                        transaction, {
                        tipAmountSol,
                        wallet
                    });
                    logger.info("buyIx2,transaction2",{buyIx,transaction})
                }

                return {
                    status: 'success',
                    transaction,
                    operation: op
                };
            } catch (error) {
                logger.error(`Bundle中的操作 ${index + 1}: 构建交易失败:`, {
                    error: error.message,
                    wallet: op.wallet.publicKey.toString().substring(0, 8) + '...',
                    mint: op.mint.toString().substring(0, 8) + '...',
                    index: op.index,
                    name: "OptimizedApp",
                    timestamp: new Date().toISOString()
                });

                failedOps.push({
                    success: false,
                    wallet: op.wallet.publicKey.toString(),
                    error: error.message,
                    errorType: 'TransactionBuildError',
                    index: op.index,
                    timestamp: new Date().toISOString()
                });

                return {status: 'failed', error};
            }
        });

        const results = await Promise.all(transactionPromises);
        const successfulBuilds = results.filter(r => r.status === 'success');

        unsignedTransactions.push(...successfulBuilds.map(r => ({
            transaction: r.transaction,
            operation: r.operation
        })));

        logger.info(`Bundle交易构建结果:`, {
            totalOperations: bundle.length,
            successfulBuilds: successfulBuilds.length,
            failedBuilds: bundle.length - successfulBuilds.length,
            name: "OptimizedApp",
            timestamp: new Date().toISOString()
        });

        return {
            unsignedTransactions,
            failedOps
        };
    }

// 新方法：模拟交易执行
    async _simulateTransactions(unsignedTransactions, bundle, blockhashInfo) {
        const simulationResults = [];
        const simulationFailedOps = [];

        logger.info(`开始模拟交易执行...`, {
            transactionsCount: unsignedTransactions.length,
            name: "App",
            timestamp: new Date().toISOString()
        });

        // 分批进行模拟，避免RPC负载过高
        const BATCH_SIZE = 3;

        for (let i = 0; i < unsignedTransactions.length; i += BATCH_SIZE) {
            const batch = unsignedTransactions.slice(i, i + BATCH_SIZE);

            const simulationPromises = batch.map(async ({transaction, operation}, batchIndex) => {
                const index = i + batchIndex;
                const wallet = operation.wallet;

                try {
                    // 深度验证链上账户状态
                    const accountValidation = await this._validateAccountsExistence(transaction, wallet);
                    if (!accountValidation.isValid) {
                        throw new Error(`账户验证失败: ${accountValidation.error}`);
                    }

                    // 模拟交易
                    const simulation = await this.connection.simulateTransaction(
                        transaction,
                        {
                            sigVerify: false,
                            commitment: 'confirmed',
                            replaceRecentBlockhash: true
                        }
                    );

                    // 分析模拟结果
                    const logs = simulation.value.logs || [];
                    const error = simulation.value.err;

                    if (error) {
                        const errorMessage = this._parseSimulationError(error, logs);

                        logger.warn(`交易模拟失败 (${index + 1}/${unsignedTransactions.length}):`, {
                            wallet: wallet.publicKey.toString().substring(0, 8) + '...',
                            error: errorMessage,
                            logs: logs.slice(-5), // 只记录最后5条日志
                            name: "App",
                            timestamp: new Date().toISOString()
                        });

                        simulationFailedOps.push({
                            success: false,
                            wallet: wallet.publicKey.toString(),
                            error: errorMessage,
                            errorType: 'SimulationError',
                            logs: logs.slice(-5),
                            index: operation.index,
                            timestamp: new Date().toISOString()
                        });

                        return {
                            success: false,
                            error: errorMessage,
                            transaction,
                            operation
                        };
                    }

                    // 计算并记录计算单元使用情况
                    const computeUnits = simulation.value.unitsConsumed || 0;
                    const estimatedFee = await this.connection.getFeeForMessage(
                        transaction.compileMessage(),
                        'confirmed'
                    );

                    logger.debug(`交易模拟成功 (${index + 1}/${unsignedTransactions.length}):`, {
                        wallet: wallet.publicKey.toString().substring(0, 8) + '...',
                        computeUnits,
                        estimatedFee: estimatedFee.value || 0,
                        name: "App",
                        timestamp: new Date().toISOString()
                    });

                    // 验证余额是否足够
                    const balance = await this.connection.getBalance(wallet.publicKey);
                    const totalRequired = operation.buyAmountLamports +
                        BigInt(estimatedFee.value || 5000) +
                        BigInt(50000); // 额外安全裕量

                    if (BigInt(balance) < totalRequired) {
                        const errorMessage = `余额不足，需要: ${totalRequired.toString()}, 当前: ${balance}`;

                        logger.warn(`余额检查失败 (${index + 1}/${unsignedTransactions.length}):`, {
                            wallet: wallet.publicKey.toString().substring(0, 8) + '...',
                            required: totalRequired.toString(),
                            balance,
                            name: "App",
                            timestamp: new Date().toISOString()
                        });

                        simulationFailedOps.push({
                            success: false,
                            wallet: wallet.publicKey.toString(),
                            error: errorMessage,
                            errorType: 'InsufficientBalance',
                            index: operation.index,
                            timestamp: new Date().toISOString()
                        });

                        return {
                            success: false,
                            error: errorMessage,
                            transaction,
                            operation
                        };
                    }

                    // 模拟成功
                    return {
                        success: true,
                        transaction,
                        operation,
                        computeUnits,
                        estimatedFee: estimatedFee.value || 0
                    };

                } catch (error) {
                    logger.error(`交易模拟异常 (${index + 1}/${unsignedTransactions.length}):`, {
                        wallet: wallet.publicKey.toString().substring(0, 8) + '...',
                        error: error.message,
                        name: "App",
                        timestamp: new Date().toISOString()
                    });

                    simulationFailedOps.push({
                        success: false,
                        wallet: wallet.publicKey.toString(),
                        error: error.message,
                        errorType: 'SimulationException',
                        index: operation.index,
                        timestamp: new Date().toISOString()
                    });

                    return {
                        success: false,
                        error: error.message,
                        transaction,
                        operation
                    };
                }
            });

            const batchResults = await Promise.all(simulationPromises);
            simulationResults.push(...batchResults);

            // 避免RPC过载，每批后等待一小段时间
            if (i + BATCH_SIZE < unsignedTransactions.length) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        const successCount = simulationResults.filter(r => r.success).length;

        logger.info(`交易模拟完成:`, {
            totalSimulated: simulationResults.length,
            successfulSimulations: successCount,
            failedSimulations: simulationResults.length - successCount,
            name: "App",
            timestamp: new Date().toISOString()
        });

        return {
            simulationResults,
            simulationFailedOps
        };
    }

// 新方法：验证交易中引用的账户是否存在
    async _validateAccountsExistence(transaction, wallet) {
        try {
            // 获取交易中引用的所有账户
            const message = transaction.compileMessage();
            const accountKeys = message.accountKeys;

            // 特别验证关键账户
            const criticalAccounts = [];

            // 1. 验证绑定曲线账户
            const programId = this.program.programId;
            const bondingCurveAccounts = accountKeys
                .filter(key => {
                    // 查找名称中包含 "bonding-curve" 的账户
                    const seeds = [Buffer.from('bonding-curve')];
                    try {
                        const [derivedAddress] = PublicKey.findProgramAddressSync(
                            seeds,
                            programId
                        );
                        return key.equals(derivedAddress);
                    } catch (e) {
                        return false;
                    }
                });

            if (bondingCurveAccounts.length > 0) {
                criticalAccounts.push({
                    address: bondingCurveAccounts[0].toString(),
                    name: "Bonding Curve Account"
                });
            }

            // 2. 验证全局账户
            const globalAccounts = accountKeys
                .filter(key => {
                    const seeds = [Buffer.from('global')];
                    try {
                        const [derivedAddress] = PublicKey.findProgramAddressSync(
                            seeds,
                            programId
                        );
                        return key.equals(derivedAddress);
                    } catch (e) {
                        return false;
                    }
                });

            if (globalAccounts.length > 0) {
                criticalAccounts.push({
                    address: globalAccounts[0].toString(),
                    name: "Global Account"
                });
            }

            // 3. 验证代币账户
            const tokenAccounts = accountKeys
                .filter(key => {
                    // 这里只能做基础检查，无法确定具体哪个是代币账户
                    // 实际应用中应该有更准确的方法
                    return !key.equals(wallet.publicKey) &&
                        !key.equals(SystemProgram.programId) &&
                        !key.equals(TOKEN_PROGRAM_ID) &&
                        !key.equals(ASSOCIATED_TOKEN_PROGRAM_ID);
                });

            if (tokenAccounts.length > 0) {
                for (const account of tokenAccounts) {
                    const info = await this.connection.getAccountInfo(account);
                    if (!info) {
                        criticalAccounts.push({
                            address: account.toString(),
                            name: "Token Account (Not Found)"
                        });
                    }
                }
            }

            // 记录验证结果
            logger.debug(`账户验证:`, {
                wallet: wallet.publicKey.toString(),
                criticalAccounts,
                totalAccounts: accountKeys.length
            });

            return {
                isValid: true,
                accountsChecked: accountKeys.length,
                criticalAccounts
            };
        } catch (error) {
            logger.error(`账户验证失败:`, {
                error: error.message,
                wallet: wallet.publicKey.toString()
            });

            return {
                isValid: false,
                error: error.message
            };
        }
    }

// 新方法：分析模拟错误
    _parseSimulationError(error, logs) {
        // 如果错误已经是字符串，直接返回
        if (typeof error === 'string') {
            return error;
        }

        // 处理Solana错误对象
        if (error && typeof error === 'object') {
            // 尝试解析常见错误类型
            if (error.InstructionError) {
                const instructionError = error.InstructionError;
                if (Array.isArray(instructionError) && instructionError.length >= 2) {
                    const [index, errorDetails] = instructionError;

                    if (errorDetails === 'Custom') {
                        // 自定义程序错误
                        // 尝试从日志中提取更具体的错误信息
                        const customErrorLogs = logs
                            .filter(log => log.includes('failed:') || log.includes('error:'))
                            .join(' | ');

                        if (customErrorLogs) {
                            return `自定义程序错误 (指令 ${index}): ${customErrorLogs}`;
                        }
                        return `自定义程序错误 (指令 ${index})`;
                    }

                    if (typeof errorDetails === 'object') {
                        // 尝试获取更具体的错误信息
                        if (errorDetails.BorshIoError) {
                            return `Borsh序列化错误 (指令 ${index}): ${errorDetails.BorshIoError}`;
                        }

                        if (errorDetails.AccountNotFound) {
                            return `账户不存在 (指令 ${index})`;
                        }

                        if (errorDetails.InsufficientFunds) {
                            return `资金不足 (指令 ${index})`;
                        }

                        return `指令错误 (指令 ${index}): ${JSON.stringify(errorDetails)}`;
                    }

                    return `指令错误 (指令 ${index}): ${errorDetails}`;
                }
            }
        }

        // 尝试分析日志
        if (logs && logs.length > 0) {
            // 寻找错误相关的日志
            const errorLogs = logs.filter(log =>
                log.includes('Error') ||
                log.includes('error:') ||
                log.includes('failed:') ||
                log.includes('not found')
            );

            if (errorLogs.length > 0) {
                return `日志错误: ${errorLogs.join(' | ')}`;
            }
        }

        // 默认返回
        return JSON.stringify(error);
    }

// 新方法：签名交易
    async _signTransactions(validTransactions, validOperations) {
        const signedTransactions = [];

        logger.info(`开始签名 ${validTransactions.length} 笔交易...`, {
            name: "App",
            timestamp: new Date().toISOString()
        });

        for (let i = 0; i < validTransactions.length; i++) {
            const transaction = validTransactions[i];
            const operation = validOperations[i];

            try {
                // 使用操作中的钱包签名交易
                transaction.partialSign(operation.wallet);

                // 验证签名是否成功
                const signature = transaction.signatures.find(
                    sig => sig.publicKey.equals(operation.wallet.publicKey) && sig.signature !== null
                );

                if (!signature || !signature.signature) {
                    logger.error(`交易签名验证失败:`, {
                        wallet: operation.wallet.publicKey.toString(),
                        name: "App",
                        timestamp: new Date().toISOString()
                    });
                    continue;
                }

                signedTransactions.push(transaction);

            } catch (error) {
                logger.error(`交易签名失败:`, {
                    error: error.message,
                    wallet: operation.wallet.publicKey.toString(),
                    name: "App",
                    timestamp: new Date().toISOString()
                });
            }
        }

        logger.info(`交易签名完成: ${signedTransactions.length}/${validTransactions.length} 笔交易签名成功`, {
            name: "App",
            timestamp: new Date().toISOString()
        });

        return signedTransactions;
    }

// 辅助方法: 计算统计信息
    calculateStats(results, totalOperations, startTime) {
        const successResults = results.filter(r => r.success);
        const failureResults = results.filter(r => !r.success);

        const errorCounts = failureResults.reduce((acc, curr) => {
            if (!acc[curr.errorType]) {
                acc[curr.errorType] = 0;
            }
            acc[curr.errorType]++;
            return acc;
        }, {});

        return {
            totalProcessed: totalOperations,
            successCount: successResults.length,
            failureCount: failureResults.length,
            duration: Date.now() - startTime,
            errorTypes: errorCounts,
            averageTimePerOp: Math.floor((Date.now() - startTime) / totalOperations)
        };
    }

    async buildBuyTransaction(op, blockhash, lastValidBlockHeight, jitoService, addTip = false) {
        try {
            // 创建新交易
            let transaction = new Transaction();

            // 添加计算预算指令
            transaction.add(
                ComputeBudgetProgram.setComputeUnitLimit({
                    units: 400000
                })
            );

            // 检查并创建ATA账户（如需要）
            const ataAddress = await this.findAssociatedTokenAddress(
                op.wallet.publicKey,
                new PublicKey(op.mint)
            );

            const ataAccount = await this.connection.getAccountInfo(ataAddress);
            if (!ataAccount) {
                const createAtaIx = createAssociatedTokenAccountInstruction(
                    op.wallet.publicKey,
                    ataAddress,
                    op.wallet.publicKey,
                    new PublicKey(op.mint),
                    TOKEN_PROGRAM_ID,
                    ASSOCIATED_TOKEN_PROGRAM_ID
                );
                transaction.add(createAtaIx);
            }

            // 构建购买指令
            const globalAccount = await this.getGlobalAccount();
            const initialBuyPrice = globalAccount.getInitialBuyPrice(op.buyAmountLamports);
            const buyAmountWithSlippage = await this.calculateWithSlippageBuy(
                initialBuyPrice,
                BigInt(op.options?.slippageBasisPoints || 1000)
            );

            const buyIx = await this.getBuyInstructions(
                op.wallet.publicKey,
                new PublicKey(op.mint),
                globalAccount.feeRecipient,
                initialBuyPrice,
                buyAmountWithSlippage
            );

            transaction.add(buyIx);

            // 设置交易参数
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = op.wallet.publicKey;
            transaction.lastValidBlockHeight = lastValidBlockHeight;

            // 如果指定了，添加Jito小费
            if (addTip && jitoService && op.tipAmountLamports > BigInt(0)) {
                const tipAmountSol = op.tipAmountLamports;
                const wallet = op.wallet;
                transaction = await jitoService.addTipToTransaction(transaction, {
                    tipAmountSol,
                    wallet
                });
            }

            // 返回未签名的交易
            return transaction;
        } catch (error) {
            logger.error(`交易构建失败:`, {
                error: error.message,
                wallet: op.wallet.publicKey.toString(),
                mint: op.mint.toString()
            });
            throw error;
        }
    }

    // 辅助方法: 发送和确认交易
    async sendAndConfirmTransactions(transactions, params) {
        const {blockhash, lastValidBlockHeight, config, batchStartTime} = params;
        const results = [];
        let retryCount = 0;
        let bundleSent = false;

        while (retryCount < config.retryAttempts && !bundleSent) {
            try {
                const bundleResult = await jitoService.sendBundle(transactions);

                // 确认每个交易
                for (const tx of transactions) {
                    try {
                        const signature = tx.signatures[0].signature;
                        const signatureStr = bs58.encode(signature);

                        await Promise.race([
                            this.connection.confirmTransaction(
                                {
                                    signature: signatureStr,
                                    blockhash,
                                    lastValidBlockHeight
                                },
                                'confirmed'
                            ),
                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error('Confirmation timeout')), config.confirmationTimeout)
                            )
                        ]);

                        results.push({
                            success: true,
                            wallet: tx.feePayer.toString(),
                            signature: signatureStr,
                            bundleId: bundleResult.bundleId,
                            confirmationTime: Date.now() - batchStartTime,
                            timestamp: new Date().toISOString()
                        });

                        bundleSent = true;
                    } catch (error) {
                        logger.warn('交易确认失败:', {
                            error: error.message,
                            wallet: tx.feePayer.toString(),
                            retry: retryCount + 1
                        });

                        if (retryCount === config.retryAttempts - 1) {
                            results.push({
                                success: false,
                                wallet: tx.feePayer.toString(),
                                error: error.message,
                                errorType: 'ConfirmationError',
                                retries: retryCount + 1,
                                timestamp: new Date().toISOString()
                            });
                        }
                    }
                }
            } catch (error) {
                logger.warn('Bundle 发送失败:', {
                    error: error.message,
                    retry: retryCount + 1
                });

                if (retryCount === config.retryAttempts - 1) {
                    transactions.forEach(tx => {
                        results.push({
                            success: false,
                            wallet: tx.feePayer.toString(),
                            error: error.message,
                            errorType: 'BundleSendError',
                            retries: retryCount + 1,
                            timestamp: new Date().toISOString()
                        });
                    });
                }
            }

            retryCount++;
            if (!bundleSent && retryCount < config.retryAttempts) {
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
            }
        }

        return results;
    }

    async batchSell(operations) {
        try {
            logger.info('开始处理批量卖出操作:', {
                operationCount: operations.length
            });

            // 参数验证
            if (!Array.isArray(operations) || operations.length === 0) {
                throw new Error('Invalid operations array');
            }

            const results = [];
            const BUNDLE_MAX_SIZE = 5;
            let currentBundle = [];
            let currentBundleSize = 0;
            let currentBlockhash = null;

            // 创建单个JitoService实例
            const jitoService = new JitoService(this.connection);
            await jitoService.initialize();

            for (const op of operations) {
                try {
                    const {
                        wallet,
                        mint,
                        tokenAmount,
                        tipAmountSol = 0,
                        options = {}
                    } = op;

                    // 验证必要参数
                    if (!wallet?.publicKey || !mint || !tokenAmount) {
                        throw new Error('Missing required parameters');
                    }

                    // 当bundle满了或是新bundle时获取新的blockhash
                    if (currentBundleSize >= BUNDLE_MAX_SIZE || currentBundleSize === 0) {
                        // 处理当前bundle
                        if (currentBundle.length > 0) {
                            const bundleResult = await jitoService.sendBundle(currentBundle);
                            const signatures = await Promise.all(
                                currentBundle.map(tx => tx.signatures[0].signature)
                            );

                            for (let i = 0; i < signatures.length; i++) {
                                results.push({
                                    success: true,
                                    wallet: currentBundle[i].feePayer.toString(),
                                    signature: bs58.encode(signatures[i]),
                                    bundleId: bundleResult.bundleId
                                });
                            }

                            currentBundle = [];
                            currentBundleSize = 0;
                        }

                        // 获取新的blockhash
                        const {blockhash, lastValidBlockHeight} =
                            await this.connection.getLatestBlockhash('confirmed');
                        currentBlockhash = {blockhash, lastValidBlockHeight};
                    }

                    // 获取当前代币余额进行验证
                    const tokenBalance = await this.getTokenBalance(wallet.publicKey, mint);
                    if (BigInt(tokenBalance) < BigInt(tokenAmount)) {
                        throw new Error(`Insufficient token balance. Required: ${tokenAmount}, Available: ${tokenBalance}`);
                    }

                    // 创建卖出交易
                    let sellTransaction = new Transaction();
                    const sellIx = await this.getSellInstructionsByTokenAmount(
                        wallet.publicKey,
                        mint,
                        tokenAmount,
                        BigInt(options.slippageBasisPoints || 100),
                        'confirmed'
                    );
                    sellTransaction.add(sellIx);

                    // 设置交易参数
                    sellTransaction.recentBlockhash = currentBlockhash.blockhash;
                    sellTransaction.feePayer = wallet.publicKey;
                    sellTransaction.lastValidBlockHeight = currentBlockhash.lastValidBlockHeight;

                    // 添加优先费用
                    if (tipAmountSol > 0) {

                        const wallet1 = wallet;
                        sellTransaction = await jitoService.addTipToTransaction(
                            sellTransaction, {
                            tipAmountSol,
                                wallet1
                        });
                    }

                    // 签名交易
                    sellTransaction.sign(wallet);

                    // 添加到当前bundle
                    currentBundle.push(sellTransaction);
                    currentBundleSize++;

                } catch (error) {
                    results.push({
                        success: false,
                        wallet: op.wallet?.publicKey?.toString() || 'unknown',
                        error: error.message
                    });
                }
            }

            // 处理最后一个不完整的bundle
            if (currentBundle.length > 0) {
                try {
                    const bundleResult = await jitoService.sendBundle(currentBundle);
                    const signatures = await Promise.all(
                        currentBundle.map(tx => tx.signatures[0].signature)
                    );

                    for (let i = 0; i < signatures.length; i++) {
                        results.push({
                            success: true,
                            wallet: currentBundle[i].feePayer.toString(),
                            signature: bs58.encode(signatures[i]),
                            bundleId: bundleResult.bundleId
                        });
                    }
                } catch (error) {
                    for (const tx of currentBundle) {
                        results.push({
                            success: false,
                            wallet: tx.feePayer.toString(),
                            error: error.message
                        });
                    }
                }
            }

            // 清理JitoService
            await jitoService.cleanup().catch(e =>
                logger.warn('清理 Jito service 失败:', e)
            );

            return results;

        } catch (error) {
            logger.error('批量卖出处理失败:', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }
    calculateWithSlippageSell(solAmount, slippageBasisPoints) {
        if (solAmount === undefined || solAmount === null) {
            logger.error('calculateWithSlippageSell收到undefined输入', {
                solAmount: 'undefined/null',
                slippageBasisPoints: slippageBasisPoints?.toString()
            });
            throw new Error('计算滑点时solAmount为undefined或null');
        }

        if (slippageBasisPoints === undefined || slippageBasisPoints === null) {
            logger.error('calculateWithSlippageSell收到undefined滑点', {
                solAmount: solAmount.toString()
            });
            throw new Error('计算滑点时slippageBasisPoints为undefined或null');
        }

        try {
            // 您的原有计算逻辑
            const minSolAmount = solAmount - (solAmount * slippageBasisPoints) / BigInt(10000);
            logger.info('calculateWithSlippageSell计算结果:', {
                solAmount: solAmount.toString(),
                slippageBasisPoints: slippageBasisPoints.toString(),
                minSolAmount: minSolAmount.toString()
            });
            return minSolAmount;
        } catch (error) {
            logger.error('calculateWithSlippageSell计算异常:', {
                error: error.message,
                solAmount: solAmount.toString(),
                slippageBasisPoints: slippageBasisPoints.toString()
            });
            throw new Error(`滑点卖出计算失败: ${error.message}`);
        }
    }
    async batchBuyAndSell(operations, options = {}) {

        logger.info("operations",{operations})
        logger.info("options",{options})
        const startTime = Date.now();
        let jitoService = null;
        const results = [];

        try {
            // 检查操作数组
            if (!Array.isArray(operations) || operations.length === 0) {
                throw new Error('Invalid operations array');
            }

            // 格式化操作数组为统一格式
            const normalizedOperations = operations.map(op => {
                // Convert SOL to lamports if amountSol exists
                const buyAmountLamports = op.amountSol
                    ? BigInt(Math.floor(op.amountSol * LAMPORTS_PER_SOL))
                    : undefined;
                logger.info('转换SOL到Lamports:', {
                    originalAmount: op.amountSol,
                    convertedLamports: buyAmountLamports ? buyAmountLamports.toString() : 'undefined'
                });

                return {
                    wallet: op.wallet,
                    mint: op.mint instanceof PublicKey ? op.mint : new PublicKey(op.mint),
                    buyAmountLamports: buyAmountLamports,
                    sellAmount: op.sellAmount ? BigInt(op.sellAmount) : undefined,
                    options: {
                        slippageBasisPoints: op.options?.slippageBasisPoints || 1000
                    }
                };
            });

            // 常量定义
            const FEE_CONSTANTS = {
                // 基础交易费用
                TX_BASE_FEE: BigInt(5000),
                COMPUTE_UNIT_FEE: BigInt(400000) * BigInt(1),
                TOKEN_ACCOUNT_RENT: BigInt(2039280),
                SPL_TOKEN_ACCOUNT_RENT: BigInt(2039280),

                // 平台费率
                BUY_FEE_PERCENTAGE: BigInt(100),  // 买入收1%
                SELL_FEE_PERCENTAGE: BigInt(100), // 卖出收1%

                // 其他费用
                PRIORITY_FEE_BASE: BigInt(1000)
            };

            // 初始化配置
            const config = {
                bundleMaxSize: options.bundleMaxSize || 5,
                waitBetweenBundles: options.waitBetweenBundles || 80,
                retryAttempts: options.retryAttempts || 3,
                skipPreflight: options.skipPreflight || false,
                preflightCommitment: options.preflightCommitment || 'confirmed',
                timeout: options.timeout || 60000,
                usePriorityFee: options.usePriorityFee !== undefined ? options.usePriorityFee : true,
                normalSubmission: options.normalSubmission !== undefined ? options.normalSubmission : false,
                jitoTipSol: options.jitoTipSol || 0.0001,
                jitoTipRequired: options.jitoTipRequired !== undefined ? options.jitoTipRequired : true
            };

            // 初始化Jito服务(如果需要)
            if (!config.normalSubmission) {
                jitoService = new JitoService(this.connection);
                await jitoService.initialize();
            }

            // 获取最新区块哈希
            const { blockhash, lastValidBlockHeight } =
                await this.connection.getLatestBlockhash('confirmed');

            // 计算费用的函数
            const calculateFees = async (op) => {
                // 检查代币账户
                const [hasTokenAccount, rentExemptLamports] = await Promise.all([
                    this.checkTokenAccount(op.wallet.publicKey, op.mint),
                    this.connection.getMinimumBalanceForRentExemption(TokenAccountLayout.span)
                ]);

                // 基础费用结构
                const baseFees = {
                    baseFee: FEE_CONSTANTS.TX_BASE_FEE,
                    computeUnitFee: FEE_CONSTANTS.COMPUTE_UNIT_FEE,
                    tokenAccountFee: hasTokenAccount ? BigInt(0) : BigInt(rentExemptLamports),
                    ataCreationFee: hasTokenAccount ? BigInt(0) : FEE_CONSTANTS.TOKEN_ACCOUNT_RENT,
                    priorityFee: config.usePriorityFee ?
                        BigInt(Math.floor(config.jitoTipSol * LAMPORTS_PER_SOL)) : BigInt(0),
                    buffer: BigInt(1000000)
                };

                // 买入相关费用
                const buyFees = op.buyAmountLamports ? {
                    buyAmount: op.buyAmountLamports,
                    buyPlatformFee: op.buyAmountLamports / FEE_CONSTANTS.BUY_FEE_PERCENTAGE,
                    buySlippage: (op.buyAmountLamports * BigInt(op.options?.slippageBasisPoints || 1000)) / BigInt(10000)
                } : {
                    buyAmount: BigInt(0),
                    buyPlatformFee: BigInt(0),
                    buySlippage: BigInt(0)
                };

                // 卖出相关费用
                const sellFees = op.sellAmount ? {
                    sellAmount: BigInt(op.sellAmount),
                    sellPlatformFee: BigInt(op.sellAmount) / FEE_CONSTANTS.SELL_FEE_PERCENTAGE,
                    sellSlippage: (BigInt(op.sellAmount) * BigInt(op.options?.slippageBasisPoints || 1000)) / BigInt(10000)
                } : {
                    sellAmount: BigInt(0),
                    sellPlatformFee: BigInt(0),
                    sellSlippage: BigInt(0)
                };

                // 合并所有费用
                const fees = {
                    ...baseFees,
                    ...buyFees,
                    ...sellFees
                };

                // 计算总费用
                const totalFees = Object.values(fees).reduce(
                    (sum, fee) => sum + fee,
                    BigInt(0)
                );

                return {
                    fees,
                    totalFees,
                    needsTokenAccount: !hasTokenAccount
                };
            };

            // 处理每个操作的费用
            for (const op of normalizedOperations) {
                try {
                    // 计算费用
                    const { fees, totalFees, needsTokenAccount } = await calculateFees(op);

                    // 计算所需总金额
                    const totalRequired = (op.buyAmountLamports || BigInt(0)) + totalFees;

                    // 检查钱包余额
                    const balance = await this.connection.getBalance(op.wallet.publicKey);

                    if (BigInt(balance) < totalRequired) {
                        const shortfall = totalRequired - BigInt(balance);

                        logger.warn('余额不足:', {
                            wallet: op.wallet.publicKey.toString(),
                            required: {
                                total: totalRequired.toString(),
                                buyAmount: op.buyAmountLamports?.toString() || '0',
                                sellAmount: op.sellAmount?.toString() || '0',
                                fees: {
                                    ...Object.fromEntries(
                                        Object.entries(fees).map(([k, v]) => [k, v.toString()])
                                    ),
                                    total: totalFees.toString()
                                }
                            },
                            balance: balance.toString(),
                            shortfall: shortfall.toString()
                        });

                        results.push({
                            success: false,
                            wallet: op.wallet.publicKey.toString(),
                            error: 'Insufficient balance',
                            details: {
                                required: totalRequired.toString(),
                                balance: balance.toString(),
                                shortfall: shortfall.toString(),
                                fees: Object.fromEntries(
                                    Object.entries(fees).map(([k, v]) => [k, v.toString()])
                                )
                            }
                        });
                        continue;
                    }

                    // 添加费用信息到操作对象
                    op.fees = fees;
                    op.totalRequired = totalRequired;
                    op.needsTokenAccount = needsTokenAccount;

                } catch (error) {
                    logger.error('计算费用失败:', {
                        error: error.message,
                        wallet: op.wallet.publicKey.toString()
                    });
                    results.push({
                        success: false,
                        wallet: op.wallet.publicKey.toString(),
                        error: `Fee calculation failed: ${error.message}`
                    });
                }
            }

            // 过滤出余额充足的操作
            const validOperations = normalizedOperations.filter(op => op.totalRequired);

            if (validOperations.length === 0) {
                return {
                    success: false,
                    results,
                    stats: {
                        totalOperations: operations.length,
                        successful: 0,
                        failed: operations.length,
                        reason: 'No valid operations after fee checks'
                    }
                };
            }

            // 处理交易
            const transactions = [];

            for (const op of validOperations) {
                try {
                    // Log the operation being processed
                    logger.info('开始处理操作:', {
                        wallet: op.wallet.publicKey.toString(),
                        mint: typeof op.mint === 'string' ? op.mint : op.mint.toBase58(),
                        buyAmountLamports: op.buyAmountLamports
                    });

                    let transaction = new Transaction();

                    // 添加计算预算指令
                    transaction.add(
                        ComputeBudgetProgram.setComputeUnitLimit({
                            units: 400000
                        })
                    );

                    // 确保 mint 是有效的 PublicKey
                    const mintPublicKey = op.mint instanceof PublicKey ?
                        op.mint : new PublicKey(op.mint);

                    // 检查 buyAmountLamports 是否存在

                    if (op.buyAmountLamports === undefined || op.buyAmountLamports === null) {
                        throw new Error(`操作中未定义买入金额 (buyAmountLamports): ${op.wallet.publicKey.toBase58()}`);
                    }

                    // 将 lamports 转换为 BigInt，并确保此过程不会出错
                    let buyAmountLamportsBigInt;
                    try {
                        buyAmountLamportsBigInt = BigInt(op.buyAmountLamports);
                        logger.info("买入金额转换为BigInt:", {
                            original: op.buyAmountLamports,
                            bigint: buyAmountLamportsBigInt.toString()
                        });
                    } catch (error) {
                        throw new Error(`无法将买入金额转换为BigInt: ${error.message}, 原始值: ${op.buyAmountLamports}`);
                    }

                    // 获取绑定曲线账户，并确保其存在
                    const bondingCurveAccount = await this.getBondingCurveAccount(mintPublicKey);
                    if (!bondingCurveAccount) {
                        throw new Error(`找不到绑定曲线账户: ${mintPublicKey.toBase58()}`);
                    }

                    // 检查绑定曲线账户是否具有必要的方法
                    if (typeof bondingCurveAccount.getBuyPrice !== 'function') {
                        throw new Error(`绑定曲线账户缺少getBuyPrice方法: ${mintPublicKey.toBase58()}`);
                    }

                    // 获取全局账户
                    const globalAccount = await this.getGlobalAccount();
                    if (!globalAccount) {
                        throw new Error('无法获取全局账户');
                    }
                    logger.info("获取到全局账户:", {
                        feeRecipient: globalAccount.feeRecipient ? globalAccount.feeRecipient.toBase58() : 'undefined',
                        feeBasisPoints: globalAccount.feeBasisPoints
                    });

                    // 计算代币购买价格
                    let tokenAmountToBuy;
                    try {
                        tokenAmountToBuy = bondingCurveAccount.getBuyPrice(buyAmountLamportsBigInt);
                        if (!tokenAmountToBuy) {
                            throw new Error('getBuyPrice返回undefined或null');
                        }
                        logger.info("计算代币购买数量:", {
                            tokenAmountToBuy: tokenAmountToBuy.toString()
                        });
                    } catch (error) {
                        throw new Error(`计算代币购买价格失败: ${error.message}`);
                    }

                    // 计算包含滑点的买入价格
                    let buyAmountWithSlippage;
                    try {
                        // 确保滑点参数有效
                        const slippageBasisPoints = op.options?.slippageBasisPoints !== undefined ?
                            BigInt(op.options.slippageBasisPoints) : BigInt(1000);

                        logger.info("滑点参数:", {
                            slippageBasisPoints: slippageBasisPoints.toString()
                        });

                        buyAmountWithSlippage = await this.calculateWithSlippageBuy(
                            tokenAmountToBuy,
                            slippageBasisPoints
                        );

                        if (!buyAmountWithSlippage) {
                            throw new Error('计算滑点买入价格返回undefined或null');
                        }

                        logger.info("计算滑点后买入价格:", {
                            buyAmountWithSlippage: buyAmountWithSlippage.toString()
                        });
                    } catch (error) {
                        throw new Error(`计算滑点买入价格失败: ${error.message}`);
                    }

                    // 生成买入指令
                    try {
                        const buyIx = await this.getBuyInstructions(
                            op.wallet.publicKey,
                            mintPublicKey,
                            globalAccount.feeRecipient,
                            tokenAmountToBuy,
                            buyAmountWithSlippage
                        );
                        transaction.add(buyIx);
                        logger.info("添加买入指令成功");
                    } catch (error) {
                        throw new Error(`生成买入指令失败: ${error.message}`);
                    }

                    // 计算卖出相关的值
                    let expectedSolReturn, sellAmountWithSlippage;
                    try {
                        // 检查getSellPrice方法是否存在
                        if (typeof bondingCurveAccount.getSellPrice !== 'function') {
                            throw new Error('绑定曲线账户缺少getSellPrice方法');
                        }

                        // 检查feeBasisPoints是否有效
                        if (globalAccount.feeBasisPoints === undefined || globalAccount.feeBasisPoints === null) {
                            throw new Error('全局账户的feeBasisPoints未定义');
                        }

                        expectedSolReturn = bondingCurveAccount.getSellPrice(tokenAmountToBuy, globalAccount.feeBasisPoints);

                        if (!expectedSolReturn) {
                            throw new Error('getSellPrice返回undefined或null');
                        }

                        logger.info("预期SOL返回金额:", {
                            expectedSolReturn: expectedSolReturn.toString()
                        });

                        // 确保滑点参数有效
                        const slippageBasisPoints = op.options?.slippageBasisPoints !== undefined ?
                            BigInt(op.options.slippageBasisPoints) : BigInt(1000);

                        sellAmountWithSlippage = this.calculateWithSlippageSell(
                            expectedSolReturn,
                            slippageBasisPoints
                        );

                        if (!sellAmountWithSlippage) {
                            throw new Error('计算滑点卖出价格返回undefined或null');
                        }

                        logger.info("计算滑点后卖出价格:", {
                            sellAmountWithSlippage: sellAmountWithSlippage.toString()
                        });
                    } catch (error) {
                        throw new Error(`计算卖出相关值失败: ${error.message}`);
                    }

                    // 生成卖出指令
                    try {
                        const sellIx = await this.getSellInstructions(
                            op.wallet.publicKey,
                            mintPublicKey,
                            globalAccount.feeRecipient,
                            tokenAmountToBuy,
                            sellAmountWithSlippage
                        );
                        transaction.add(sellIx);
                        logger.info("添加卖出指令成功");
                    } catch (error) {
                        throw new Error(`生成卖出指令失败: ${error.message}`);
                    }

                    // 设置交易参数
                    try {
                        // 检查blockhash和lastValidBlockHeight是否已定义
                        if (!blockhash) {
                            throw new Error('blockhash未定义');
                        }

                        if (lastValidBlockHeight === undefined || lastValidBlockHeight === null) {
                            throw new Error('lastValidBlockHeight未定义');
                        }

                        transaction.recentBlockhash = blockhash;
                        transaction.feePayer = op.wallet.publicKey;
                        transaction.lastValidBlockHeight = lastValidBlockHeight;

                        logger.info("设置交易参数成功:", {
                            blockhash: blockhash,
                            feePayer: op.wallet.publicKey.toString(),
                            lastValidBlockHeight: lastValidBlockHeight
                        });
                    } catch (error) {
                        throw new Error(`设置交易参数失败: ${error.message}`);
                    }

                    // 模拟交易
                    try {
                        const simulationResult = await this.connection.simulateTransaction(transaction);

                        if (simulationResult.value.err) {
                            throw new Error(`交易模拟失败: ${JSON.stringify(simulationResult.value.err)}`);
                        }

                        // 记录模拟结果
                        logger.info('交易模拟成功:', {
                            wallet: op.wallet.publicKey.toString(),
                            logs: simulationResult.value.logs?.slice(0, 5) // 只记录前5条日志
                        });

                        // 添加到交易列表
                        transactions.push({
                            transaction,
                            operation: op,
                            simulationResult: simulationResult.value
                        });
                    } catch (error) {
                        throw new Error(`交易模拟失败: ${error.message}`);
                    }
                } catch (error) {
                    logger.error('构建交易失败:', {
                        error: error.message,
                        stack: error.stack,
                        wallet: op.wallet.publicKey.toString(),
                        operation: {
                            mint: op.mint instanceof PublicKey ? op.mint.toBase58() : op.mint,
                            buyAmountLamports: op.buyAmountLamports,
                            options: op.options
                        }
                    });
                    // 将失败的操作添加到一个单独的数组中，以便后续处理
                    failedOperations.push({
                        operation: op,
                        error: error.message
                    });
                }
            }

            // 分批处理交易
            const batches = [];
            for (let i = 0; i < transactions.length; i += config.bundleMaxSize) {
                batches.push(transactions.slice(i, i + config.bundleMaxSize));
            }

            // 处理每个批次
            for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
                const batch = batches[batchIndex];

                try {
                    if (config.normalSubmission) {
                        // 普通提交
                        for (const { transaction, operation } of batch) {
                            transaction.sign(operation.wallet);
                            const signature = await this.connection.sendTransaction(
                                transaction,
                                [operation.wallet],
                                {
                                    skipPreflight: config.skipPreflight,
                                    preflightCommitment: config.preflightCommitment,
                                    maxRetries: config.retryAttempts
                                }
                            );
                            await this.connection.confirmTransaction({
                                signature,
                                blockhash,
                                lastValidBlockHeight
                            });

                            results.push({
                                success: true,
                                signature,
                                wallet: operation.wallet.publicKey.toString(),
                                timestamp: new Date().toISOString()
                            });

                            // 在每个交易之间添加等待时间
                            if (batchIndex < batch.length - 1) {
                                await new Promise(resolve =>
                                    setTimeout(resolve, config.waitBetweenBundles)
                                );
                            }
                        }
                    } else {
                        // Jito优先上链
                        const batchTxs = batch.map(({ transaction, operation }) => {
                            transaction.sign(operation.wallet);
                            return transaction;
                        });

                        // 为第一笔交易添加Jito小费
                        if (config.jitoTipRequired && batchTxs.length > 0) {
                            try {
                                const tipAmountSol = config.jitoTipSol;
                                const wallet = batch[0].operation.wallet;  // 获取第一个交易对应的钱包

                                logger.info('准备添加Jito小费:', {
                                    tipAmountSol,
                                    wallet: wallet.publicKey.toString()
                                });

                                batchTxs[0] = await jitoService.addTipToTransaction(
                                    batchTxs[0],
                                    {
                                        tipAmountSol,  // 使用tipAmountSol而不是tipAmount
                                        wallet         // 明确传递钱包参数
                                    }
                                );

                                logger.info('已添加Jito小费并签名成功');
                            } catch (error) {
                                logger.error('添加Jito小费失败:', {
                                    error: error.message,
                                    stack: error.stack
                                });

                                // 错误处理：如果添加小费失败，可以考虑改用普通提交
                                config.normalSubmission = true;
                                logger.info('因小费添加失败，切换到普通提交模式');
                            }
                        }

                        // 发送bundle
                        const bundleResult = await jitoService.sendBundle(batchTxs);

                        // 等待确认
                        for (let i = 0; i < batch.length; i++) {
                            const { operation } = batch[i];
                            const signature = bs58.encode(batchTxs[i].signatures[0].signature);

                            try {
                                await this.connection.confirmTransaction({
                                    signature,
                                    blockhash,
                                    lastValidBlockHeight
                                });

                                results.push({
                                    success: true,
                                    signature,
                                    bundleId: bundleResult.bundleId,
                                    wallet: operation.wallet.publicKey.toString(),
                                    timestamp: new Date().toISOString()
                                });
                            } catch (error) {
                                logger.error('操作失败BBBB:', {
                                    error: error.message,
                                    stack: error.stack
                                });
                                results.push({
                                    success: false,
                                    wallet: operation.wallet.publicKey.toString(),
                                    error: error.message,
                                    timestamp: new Date().toISOString()
                                });
                            }

                            // 在每个交易确认后添加等待时间
                            if (i < batch.length - 1) {
                                await new Promise(resolve =>
                                    setTimeout(resolve, config.waitBetweenBundles)
                                );
                            }
                        }
                    }

                    // 批次间等待
                    if (batchIndex < batches.length - 1) {
                        await new Promise(resolve =>
                            setTimeout(resolve, config.waitBetweenBundles)
                        );
                    }

                } catch (error) {
                    logger.error('操作失败AAAA:', {
                        error: error.message,
                        stack: error.stack
                    });
                    batch.forEach(({ operation }) => {
                        results.push({
                            success: false,
                            wallet: operation.wallet.publicKey.toString(),
                            error: error.message,
                            timestamp: new Date().toISOString()
                        });
                    });
                }
            }

            return {
                success: results.some(r => r.success),
                results,
                stats: {
                    totalOperations: operations.length,
                    successful: results.filter(r => r.success).length,
                    failed: results.filter(r => !r.success).length,
                    duration: `${(Date.now() - startTime) / 1000} seconds`
                }
            };

        } catch (error) {
            logger.error('批量操作失败:', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        } finally {
            if (jitoService) {
                await jitoService.cleanup();
            }
        }
    }

// 辅助方法：检查代币账户是否存在
    async checkTokenAccount(owner, mint) {
        try {
            const ata = await getAssociatedTokenAddress(
                mint,
                owner,
                false,
                TOKEN_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
            );

            const account = await this.connection.getAccountInfo(ata);
            return [!!account, ata];
        } catch (error) {
            logger.error('检查代币账户失败:', {
                error: error.message,
                owner: owner.toString(),
                mint: mint.toString()
            });
            return [false, null];
        }
    }

    async _simulateTransactionSingle(transaction, signers, options = {}) {
        try {
            const startTime = Date.now();

            // 打印完整的交易信息
            const txDetails = {
                feePayer: transaction.feePayer?.toString(),
                recentBlockhash: transaction.recentBlockhash,
                instructions: transaction.instructions.map((ix, index) => ({
                    index,
                    programId: ix.programId.toString(),
                    keys: ix.keys.map(k => ({
                        pubkey: k.pubkey.toString(),
                        isSigner: k.isSigner,
                        isWritable: k.isWritable,
                        // 新增: 尝试识别账户类型
                        accountType: this._identifyAccountType(k.pubkey)
                    })),
                    dataSize: ix.data.length,
                    // 新增: 解码指令数据
                    decodedData: this._tryDecodeInstructionData(ix)
                }))
            };

            logger.info('开始模拟交易 - 完整交易详情:', {
                ...txDetails,
                timestamp: new Date().toISOString(),
                name: "TransactionSimulation"
            });

            // 验证每个账户的状态
            const accountValidations = await Promise.all(
                transaction.instructions.flatMap(ix =>
                    ix.keys.map(async (key) => {
                        const accountInfo = await this.connection.getAccountInfo(key.pubkey);
                        return {
                            pubkey: key.pubkey.toString(),
                            exists: !!accountInfo,
                            space: accountInfo?.data.length || 0,
                            owner: accountInfo?.owner?.toString(),
                            lamports: accountInfo?.lamports || 0,
                            isExecutable: accountInfo?.executable || false,
                            rentEpoch: accountInfo?.rentEpoch,
                            isWritable: key.isWritable,
                            isSigner: key.isSigner
                        };
                    })
                )
            );

            logger.debug('账户验证结果:', {
                accounts: accountValidations,
                timestamp: new Date().toISOString()
            });

            // 检查关键账户
            const criticalAccounts = accountValidations.filter(acc =>
                !acc.exists && (acc.isWritable || acc.isSigner)
            );

            if (criticalAccounts.length > 0) {
                logger.error('发现缺失的关键账户:', {
                    criticalAccounts,
                    timestamp: new Date().toISOString()
                });
            }

            // 验证指令参数
            const instructionValidations = transaction.instructions.map((ix, index) => {
                try {
                    const decoded = this._validateInstructionParameters(ix);
                    return {
                        index,
                        programId: ix.programId.toString(),
                        valid: true,
                        decodedData: decoded
                    };
                } catch (error) {
                    return {
                        index,
                        programId: ix.programId.toString(),
                        valid: false,
                        error: error.message
                    };
                }
            });

            logger.debug('指令验证结果:', {
                instructions: instructionValidations,
                timestamp: new Date().toISOString()
            });

            let validSigners = [];
            if (Array.isArray(signers)) {
                validSigners = signers.filter(signer =>
                    signer && typeof signer === 'object' && signer.publicKey && signer.secretKey
                );
            } else if (signers && signers.publicKey && signers.secretKey) {
                validSigners = [signers];
            }

// 使用正确的参数格式调用simulateTransaction
            const simulation = await this.connection.simulateTransaction(
                transaction,
                validSigners,
                options.commitment || 'processed'
            );

            // 详细分析模拟结果
            const simulationAnalysis = {
                success: !simulation.value.err,
                error: simulation.value.err,
                logs: simulation.value.logs || [],
                unitsConsumed: simulation.value.unitsConsumed || 0,
                accounts: simulation.value.accounts || [],
                returnData: simulation.value.returnData,
                // 新增: 分析程序调用栈
                programInvocations: this._analyzeProgramInvocations(simulation.value.logs || [])
            };

            // 如果模拟失败，生成详细的错误报告
            if (!simulationAnalysis.success) {
                const errorReport = {
                    error: simulation.value.err,
                    errorType: this._identifyErrorType(simulation.value.err),
                    failedInstruction: this._identifyFailedInstruction(simulation.value.logs || []),
                    accountStates: accountValidations,
                    instructions: instructionValidations,
                    logs: simulation.value.logs,
                    programInvocations: simulationAnalysis.programInvocations,
                    timestamp: new Date().toISOString()
                };

                logger.error('交易模拟失败 - 详细错误报告:', errorReport);

                return {
                    success: false,
                    error: errorReport.error,
                    details: errorReport
                };
            }

            // 分析账户状态变化
            const accountChanges = this._analyzeAccountChanges(
                simulation.value.logs || [],
                accountValidations
            );

            // 记录成功结果
            const result = {
                success: true,
                computeUnits: simulationAnalysis.unitsConsumed,
                logs: simulationAnalysis.logs,
                accountChanges,
                programInvocations: simulationAnalysis.programInvocations,
                performance: {
                    duration: Date.now() - startTime,
                    computeUnitsPerMs: Math.round(simulationAnalysis.unitsConsumed / (Date.now() - startTime))
                }
            };

            logger.info('模拟交易成功完成:', {
                ...result,
                timestamp: new Date().toISOString()
            });

            return result;

        } catch (error) {
            // 记录详细的错误信息
            const errorContext = {
                error: error.message,
                code: error.code,
                stack: error.stack,
                transaction: {
                    feePayer: transaction.feePayer?.toString(),
                    instructionCount: transaction.instructions.length,
                    instructions: transaction.instructions.map(ix => ({
                        programId: ix.programId.toString(),
                        keyCount: ix.keys.length,
                        dataSize: ix.data.length
                    }))
                },
                signers: signers.map(s => s.publicKey.toString()),
                options,
                timestamp: new Date().toISOString()
            };

            logger.error('模拟交易失败 - 完整错误上下文:', errorContext);

            return {
                success: false,
                error: error.message,
                context: errorContext
            };
        }
    }

// 辅助方法: 识别账户类型
    _identifyAccountType(pubkey) {
        // 这里可以添加更多的账户类型识别逻辑
        if (pubkey.equals(TOKEN_PROGRAM_ID)) return 'Token Program';
        if (pubkey.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return 'Associated Token Program';
        if (pubkey.equals(SystemProgram.programId)) return 'System Program';
        return 'Unknown';
    }

// 辅助方法: 尝试解码指令数据
    _tryDecodeInstructionData(ix) {
        try {
            // 这里可以添加特定程序的指令解码逻辑
            return {
                raw: Buffer.from(ix.data).toString('hex'),
                decoded: this._coder?.instruction.decode(ix.data, 'hex') || null
            };
        } catch (error) {
            return {
                raw: Buffer.from(ix.data).toString('hex'),
                decodeError: error.message
            };
        }
    }

// 辅助方法: 验证指令参数
    _validateInstructionParameters(ix) {
        // 这里可以添加特定指令的参数验证逻辑
        return {
            programId: ix.programId.toString(),
            keyCount: ix.keys.length,
            dataSize: ix.data.length,
            // 可以添加更多验证...
        };
    }

// 辅助方法: 分析程序调用栈
    _analyzeProgramInvocations(logs) {
        const invocations = [];
        let depth = 0;

        for (const log of logs) {
            if (log.includes('Program invoke')) {
                const program = log.match(/Program (.*?) invoke/)?.[1];
                invocations.push({
                    depth,
                    type: 'invoke',
                    program,
                    timestamp: new Date().toISOString()
                });
                depth++;
            } else if (log.includes('Program return')) {
                depth--;
                invocations.push({
                    depth,
                    type: 'return',
                    timestamp: new Date().toISOString()
                });
            }
        }

        return invocations;
    }

// 辅助方法: 分析账户变化
    _analyzeAccountChanges(logs, initialStates) {
        const changes = [];

        for (const log of logs) {
            if (log.includes('Account ')) {
                const match = log.match(/Account (.*?) balance: (.*)/);
                if (match) {
                    const [_, account, balance] = match;
                    const initialState = initialStates.find(s => s.pubkey === account);

                    changes.push({
                        account,
                        oldBalance: initialState?.lamports || 0,
                        newBalance: parseInt(balance),
                        difference: parseInt(balance) - (initialState?.lamports || 0),
                        timestamp: new Date().toISOString()
                    });
                }
            }
        }

        return changes;
    }

// 辅助方法: 识别错误类型
    _identifyErrorType(error) {
        if (!error) return null;

        if (typeof error === 'object') {
            if (error.InstructionError) return 'InstructionError';
            if (error.TransactionError) return 'TransactionError';
        }

        return 'Unknown';
    }

// 辅助方法: 识别失败的指令
    _identifyFailedInstruction(logs) {
        const failedLog = logs.find(log =>
            log.includes('failed') || log.includes('error')
        );

        if (!failedLog) return null;

        return {
            log: failedLog,
            programId: failedLog.match(/Program (.*?) failed/)?.[1] || 'unknown',
            timestamp: new Date().toISOString()
        };
    }

    async prepareBuyAndSellInstructions(operation) {
        try {
            const {
                wallet,
                mint,
                amountSol,
                sellPercentage,
                globalAccount,
                options = {}
            } = operation;

            const LAMPORTS_PER_SOL = 1000000000;
            let buyInstruction = null;
            let sellInstruction = null;

            // 准备买入指令
            if (amountSol && amountSol > 0) {
                const buyAmountLamports = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));

                // 计算带滑点的买入价格
                const initialBuyPrice = globalAccount.getInitialBuyPrice(buyAmountLamports);
                const buyAmountWithSlippage = await this.calculateWithSlippageBuy(
                    initialBuyPrice,
                    BigInt(options.slippageBasisPoints || 1000)
                );

                // 直接使用 getBuyInstructions 获取买入指令
                buyInstruction = await this.getBuyInstructions(
                    wallet.publicKey,
                    mint,
                    globalAccount.feeRecipient,
                    initialBuyPrice,
                    buyAmountWithSlippage
                );

                logger.debug('买入指令已准备:', {
                    wallet: wallet.publicKey.toString(),
                    mint: mint.toString(),
                    amountSol,
                    buyAmountLamports: buyAmountLamports.toString(),
                    buyAmountWithSlippage: buyAmountWithSlippage.toString()
                });
            }

            // 准备卖出指令
            if (sellPercentage && sellPercentage > 0) {
                // 获取代币余额
                const tokenAccount = await this.findAssociatedTokenAddress(
                    wallet.publicKey,
                    mint
                );
                const balanceResponse = await this.connection.getTokenAccountBalance(tokenAccount);
                const tokenBalance = balanceResponse.value.amount;

                // 计算卖出数量
                const tokenAmountBigInt = BigInt(tokenBalance);
                const sellAmount = (tokenAmountBigInt * BigInt(Math.floor(sellPercentage * 100))) / BigInt(10000);

                if (sellAmount > 0n) {
                    // 直接使用 getSellInstructionsByTokenAmount 获取卖出指令
                    sellInstruction = await this.getSellInstructionsByTokenAmount(
                        wallet.publicKey,
                        mint,
                        sellAmount,
                        BigInt(options.slippageBasisPoints || 1000)
                    );

                    logger.debug('卖出指令已准备:', {
                        wallet: wallet.publicKey.toString(),
                        mint: mint.toString(),
                        sellPercentage,
                        tokenBalance,
                        sellAmount: sellAmount.toString()
                    });
                } else {
                    logger.warn('卖出数量为0，跳过卖出指令:', {
                        wallet: wallet.publicKey.toString(),
                        mint: mint.toString(),
                        tokenBalance,
                        sellPercentage
                    });
                }
            }

            // 检查是否存在有效指令
            if (!buyInstruction && !sellInstruction) {
                throw new Error('No valid buy or sell instruction could be prepared');
            }

            return {
                buyInstruction,
                sellInstruction
            };

        } catch (error) {
            logger.error('准备买卖指令失败:', {
                error: error.message,
                wallet: operation.wallet?.publicKey?.toString(),
                mint: operation.mint?.toString(),
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * 批量直接买入代币
     * @param {Array} operations - 买入操作数组
     * @param {Object} options - 批量处理选项
     * @returns {Promise<Array>} 买入结果数组
     */
    async batchBuyDirect(operations, options = {}) {
        const startTime = Date.now();
        let jitoService = null;
        const results = [];
        const LAMPORTS_PER_SOL = 1000000000;

        try {
            // 1. 初始化配置
            const config = {
                bundleMaxSize: options.bundleMaxSize || 5,
                waitBetweenBundles: options.waitBetweenBundles || 80,
                retryAttempts: options.retryAttempts || 3,
                maxSolAmount: options.maxSolAmount || 1000000,
                skipPreflight: options.skipPreflight || false,
                preflightCommitment: options.preflightCommitment || 'confirmed',
                timeout: options.timeout || 60000,
                usePriorityFee: options.usePriorityFee !== undefined ? options.usePriorityFee : true,
                normalSubmission: options.normalSubmission !== undefined ? options.normalSubmission : false,
                jitoTipSol: options.jitoTipSol || 0.0001
            };

            logger.info('批量买入开始:', {
                operationCount: operations.length,
                submissionMethod: config.normalSubmission ? '普通上链' : '优先上链(Jito)',
                config
            });

            // 2. 验证所有操作
            const validOperations = [];
            const validationFailures = [];
            logger.info("开始验证");


            for (let i = 0; i < operations.length; i++) {
                const op = operations[i];
                logger.info("op", {op})
                try {
                    // 基本验证
                    if (!op.wallet || !op.mint) {
                        throw new Error('Missing required wallet or mint');
                    }

                    const mintPublicKey = op.mint instanceof PublicKey ?
                        op.mint : new PublicKey(op.mint);

                    // 验证费用计算结果存在
                    if (!op.fees || !op.totalRequired) {
                        logger.warn('操作缺少费用计算:', {
                            wallet: op.wallet.publicKey.toString(),
                            fees: !!op.fees,
                            totalRequired: !!op.totalRequired
                        });
                        throw new Error(`Missing fee calculation for wallet ${op.wallet.publicKey.toString()}`);
                    }

                    // 基础交易模拟
                    const transaction = new Transaction();
                    transaction.add(
                        ComputeBudgetProgram.setComputeUnitLimit({
                            units: 400000
                        })
                    );

                    if (config.usePriorityFee) {
                        transaction.add(
                            ComputeBudgetProgram.setComputeUnitPrice({
                                microLamports: config.jitoTipSol ?
                                    Math.floor(config.jitoTipSol * LAMPORTS_PER_SOL / 1_000_000) :
                                    100000
                            })
                        );
                    }
                    let buyAmountLamportsBigInt;
                    if (typeof op.amountLamports === 'bigint') {
                        buyAmountLamportsBigInt = op.amountLamports;
                    } else if (op.amountLamports) {
                        buyAmountLamportsBigInt = BigInt(op.amountLamports.toString());
                    } else if (op.amountSol) {
                        buyAmountLamportsBigInt = BigInt(Math.floor(op.amountSol * LAMPORTS_PER_SOL));
                    } else {
                        throw new Error('No valid amount specified');
                    }

                    if (!amountLamports) {
                        throw new Error('No valid amount specified');
                    }

// // 2. 转换为BigInt
//                     const buyAmountLamportsBigInt = BigInt(amountLamports);

// 3. 获取全局账户并计算初始价格
                    const globalAccount = await this.getGlobalAccount();
                    logger.info("globalAccount:", {globalAccount});

                    const initialBuyPrice = globalAccount.getInitialBuyPrice(buyAmountLamportsBigInt);
                    logger.info("initialBuyPrice:", {initialBuyPrice});

// 4. 计算带滑点的买入金额
                    const buyAmountWithSlippage = await this.calculateWithSlippageBuy(
                        initialBuyPrice,
                        BigInt(op.options?.slippageBasisPoints || 1000)
                    );
                    logger.info("buyAmountWithSlippage:", {buyAmountWithSlippage});

// 5. 构建买入指令
                    const buyIx = await this.getBuyInstructions(
                        op.wallet.publicKey,
                        mintPublicKey,
                        globalAccount.feeRecipient,
                        initialBuyPrice,
                        buyAmountWithSlippage
                    );
                    transaction.add(buyIx);
                    logger.info("transaction:", {transaction});
                    logger.info("模拟交易");
                    let blockhashInfo = await this._getLatestBlockhash();


                    transaction.recentBlockhash = blockhashInfo.blockhash;
                    transaction.feePayer = op.wallet.publicKey;
                    transaction.lastValidBlockHeight = blockhashInfo.lastValidBlockHeight;

                    // 模拟交易
                    const simResult = await this._simulateTransactionSingle(
                        transaction,
                        [op.wallet],
                        {commitment: 'processed'}
                    );

                    logger.info('买入交易模拟结果:', {
                        wallet: op.wallet.publicKey.toString(),
                        mint: mintPublicKey.toString(),
                        amount: op.amountLamports.toString(),
                        success: simResult.success,
                        computeUnits: simResult.computeUnits,
                        logs: simResult.logs,
                        programInvocations: simResult.programInvocations,
                        accountChanges: simResult.accountChanges,
                        performance: simResult.performance,
                        timestamp: new Date().toISOString()
                    });

                    if (!simResult.success) {
                        logger.error('买入交易模拟失败:', {
                            wallet: op.wallet.publicKey.toString(),
                            mint: mintPublicKey.toString(),
                            error: simResult.error,
                            details: simResult.details,  // 包含完整的错误报告
                            timestamp: new Date().toISOString()
                        });
                        throw new Error(`Transaction simulation failed: ${simResult.error}`);
                    }

                    validOperations.push({
                        ...op,
                        mint: mintPublicKey,
                        index: i,
                        globalAccount: globalAccount, // 添加这一行
                        simulationResult: simResult
                    });

                } catch (error) {
                    logger.error("操作验证失败", {
                        error: {
                            message: error.message,
                            name: error.name,
                            stack: error.stack,
                            code: error.code,
                            // 如果是自定义错误，可能有额外属性
                            ...error
                        },
                        context: {
                            wallet: op.wallet?.publicKey?.toString() || 'unknown',
                            mint: op.mint?.toString(),
                            index: i,
                            operationDetails: JSON.stringify(op, (key, value) =>
                                typeof value === 'bigint' ? value.toString() : value
                            )
                        },
                        timestamp: new Date().toISOString(),
                        name: "App"
                    });
                    validationFailures.push({
                        success: false,
                        wallet: op.wallet?.publicKey?.toString() || 'unknown',
                        error: error.message,
                        index: i,
                        timestamp: new Date().toISOString()
                    });
                }
            }

            // 3. 分批处理
            const batches = [];
            let currentBatch = [];
            let currentBatchTotalAmount = BigInt(0);

            for (const op of validOperations) {
                if (currentBatch.length >= config.bundleMaxSize ||
                    currentBatchTotalAmount + op.amountLamports > BigInt(config.maxSolAmount * LAMPORTS_PER_SOL)) {
                    if (currentBatch.length > 0) {
                        batches.push([...currentBatch]);
                        currentBatch = [];
                        currentBatchTotalAmount = BigInt(0);
                    }
                }
                currentBatch.push(op);
                currentBatchTotalAmount += op.amountLamports;
            }

            if (currentBatch.length > 0) {
                batches.push(currentBatch);
            }

            // 4. 初始化Jito服务
            if (!config.normalSubmission) {
                jitoService = new JitoService(this.connection);
                await jitoService.initialize();
            }

            // 5. 处理每个批次
            for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
                const batch = batches[batchIndex];

                logger.info(`处理批次 ${batchIndex + 1}/${batches.length}:`, {
                    operationsInBatch: batch.length
                });

                try {
                    const {blockhash, lastValidBlockHeight} =
                        await this.connection.getLatestBlockhash('confirmed');

                    const transactionsToSign = [];

                    // 构建交易
                    for (const op of batch) {
                        let transaction = new Transaction();

                        // 添加计算预算指令
                        transaction.add(
                            ComputeBudgetProgram.setComputeUnitLimit({
                                units: 400000
                            })
                        );
                        let globalAccount = op.globalAccount;
                        if (!globalAccount) {
                            globalAccount = await this.getGlobalAccount();
                            logger.info('为交易获取全局账户:', {
                                wallet: op.wallet.publicKey.toString()
                            });
                        }
                        // 构建买入指令
                        const buyIx = await this.getBuyInstructions(
                            op.wallet.publicKey,
                            op.mint,
                            globalAccount.feeRecipient,
                            op.buyAmountLamports || op.amountLamports,
                            op.totalRequired
                        );
                        const wallet = op.wallet;
                        const tipAmountSol = config.jitoTipSol;
                        transaction.add(buyIx);
                        transaction.recentBlockhash = blockhash;
                        transaction.feePayer = op.wallet.publicKey;
                        transaction.lastValidBlockHeight = lastValidBlockHeight;

                        // 如果是批次中的第一个交易，且使用 Jito，添加小费
                        if (!config.normalSubmission && transactionsToSign.length === 0) {
                            transaction = await jitoService.addTipToTransaction(
                                transaction, {
                                    tipAmountSol,
                                    wallet
                            });
                        }

                        // 签名交易
                        transaction.sign(op.wallet);
                        transactionsToSign.push(transaction);
                    }

                    // 发送交易包
                    if (transactionsToSign.length > 0) {
                        let batchResults;

                        if (config.normalSubmission) {
                            batchResults = await this.sendNormalTransactions(
                                transactionsToSign,
                                batch,
                                config
                            );
                        } else {
                            const bundleResult = await jitoService.sendBundle(transactionsToSign);

                            // 等待所有交易确认
                            const confirmations = await Promise.allSettled(
                                transactionsToSign.map(async (tx) => {
                                    const signature = bs58.encode(tx.signatures[0].signature);
                                    try {
                                        await this.connection.confirmTransaction(
                                            {
                                                signature,
                                                blockhash,
                                                lastValidBlockHeight
                                            },
                                            'confirmed'
                                        );
                                        return {
                                            success: true,
                                            signature,
                                            bundleId: bundleResult.bundleId
                                        };
                                    } catch (error) {
                                        return {
                                            success: false,
                                            error: error.message,
                                            signature
                                        };
                                    }
                                })
                            );

                            batchResults = confirmations.map(result =>
                                result.status === 'fulfilled' ? result.value : {
                                    success: false,
                                    error: result.reason?.message || 'Transaction failed'
                                }
                            );
                        }

                        // 处理结果
                        for (let i = 0; i < batch.length; i++) {
                            const op = batch[i];
                            const txResult = batchResults[i];

                            if (txResult?.success) {
                                results.push({
                                    success: true,
                                    wallet: op.wallet.publicKey.toString(),
                                    mint: op.mint.toString(),
                                    amountSol: op.amountSol,
                                    signature: txResult.signature,
                                    bundleId: txResult.bundleId,
                                    timestamp: new Date().toISOString()
                                });
                            } else {
                                results.push({
                                    success: false,
                                    wallet: op.wallet.publicKey.toString(),
                                    mint: op.mint.toString(),
                                    amountSol: op.amountSol,
                                    error: txResult?.error || '交易失败',
                                    timestamp: new Date().toISOString()
                                });
                            }
                        }
                    }

                    // 批次间等待
                    if (batchIndex < batches.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, config.waitBetweenBundles));
                    }

                } catch (error) {
                    logger.error(`批次 ${batchIndex + 1} 发送失败:`, {
                        error: error.message,
                        transactionCount: batch.length
                    });

                    // 将整个批次标记为失败
                    for (const op of batch) {
                        results.push({
                            success: false,
                            wallet: op.wallet.publicKey.toString(),
                            mint: op.mint.toString(),
                            amountSol: op.amountSol,
                            error: error.message,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
            }

            // 添加验证失败的结果
            results.push(...validationFailures);

            // 统计信息
            const stats = {
                totalOperations: operations.length,
                successful: results.filter(r => r.success).length,
                failed: results.filter(r => !r.success).length,
                duration: `${(Date.now() - startTime) / 1000} seconds`
            };

            logger.info('批量买入完成:', stats);

            return results;

        } catch (error) {
            logger.error('批量买入失败:', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        } finally {
            // 清理 Jito 服务
            if (jitoService) {
                await jitoService.cleanup().catch(err => {
                    logger.warn('Jito服务清理失败:', {error: err.message});
                });
            }
        }
    }

// 普通上链方法实现
    async sendNormalTransactions(transactions, batch, config) {
        const results = [];

        for (let i = 0; i < transactions.length; i++) {
            const tx = transactions[i];
            const op = batch[i];

            try {
                // 发送单个交易
                const signature = await this.connection.sendRawTransaction(
                    tx.serialize(),
                    {
                        skipPreflight: config.skipPreflight,
                        preflightCommitment: config.preflightCommitment,
                        maxRetries: config.retryAttempts
                    }
                );

                // 等待确认
                await this.connection.confirmTransaction(
                    {
                        signature,
                        blockhash: tx.recentBlockhash,
                        lastValidBlockHeight: tx.lastValidBlockHeight
                    },
                    'confirmed'
                );

                results.push({
                    success: true,
                    signature,
                    timestamp: new Date().toISOString()
                });

            } catch (error) {
                logger.error(`普通上链交易失败:`, {
                    error: error.message,
                    wallet: op.wallet.publicKey.toString(),
                    index: i
                });

                results.push({
                    success: false,
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
            }

            // 交易间短暂等待，避免过载
            if (i < transactions.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        return results;
    }

    async batchSellByPercentage(operations, options = {}) {
        const startTime = Date.now();
        let jitoService = null;
        const results = [];
        const validOperations = [];
        const validationFailures = [];
        const LAMPORTS_PER_SOL = 1000000000;

        logger.info("开始批量卖出操作:", {
            operationsCount: operations?.length,
            options: {
                bundleMaxSize: options.bundleMaxSize,
                waitBetweenBundles: options.waitBetweenBundles,
                usePriorityFee: options.usePriorityFee,
                normalSubmission: options.normalSubmission,
                jitoTipSol: options.jitoTipSol
            }
        });

        try {
            // 1. 初始化配置
            const config = {
                bundleMaxSize: options.bundleMaxSize || 5,
                waitBetweenBundles: options.waitBetweenBundles || 80,
                retryAttempts: options.retryAttempts || 3,
                skipPreflight: options.skipPreflight || false,
                preflightCommitment: options.preflightCommitment || 'confirmed',
                timeout: options.timeout || 60000,
                usePriorityFee: options.usePriorityFee !== undefined ? options.usePriorityFee : true,
                normalSubmission: options.normalSubmission !== undefined ? options.normalSubmission : false,
                jitoTipSol: options.jitoTipSol || 0.0001,
                jitoTipRequired: options.jitoTipRequired !== undefined ? options.jitoTipRequired : true,
                simulationBatchSize: options.simulationBatchSize || 3,
                maxSimulationRetries: options.maxSimulationRetries || 3
            };

            logger.info("配置初始化完成:", {
                config,
                jitoConfig: {
                    tipSol: config.jitoTipSol,
                    tipRequired: config.jitoTipRequired,
                    normalSubmission: config.normalSubmission
                }
            });

            // 2. 验证和处理操作
            for (let i = 0; i < operations.length; i++) {
                const op = operations[i];
                logger.info("处理操作:", {
                    index: i,
                    wallet: op?.wallet?.publicKey?.toString(),
                    mint: op?.mint?.toString(),
                    percentage: op?.percentage
                });

                try {
                    // 基本验证
                    if (!op.wallet || !op.mint) {
                        throw new Error('Missing required wallet or mint');
                    }

                    // 验证百分比
                    const percentage = op.percentage;
                    if (typeof percentage !== 'number' || percentage <= 0 || percentage > 100) {
                        throw new Error(`Invalid percentage: ${percentage}`);
                    }

                    // 确保mint是PublicKey
                    const mintPublicKey = op.mint instanceof PublicKey ? op.mint : new PublicKey(op.mint);

                    // 获取代币账户
                    const tokenAccount = await this.findAssociatedTokenAddress(
                        op.wallet.publicKey,
                        mintPublicKey
                    );

                    // 获取代币余额
                    let tokenBalance;
                    let balanceResponse;
                    try {
                        balanceResponse = await this.connection.getTokenAccountBalance(tokenAccount);
                        tokenBalance = balanceResponse.value.amount;
                    } catch (balanceError) {
                        logger.error("获取代币余额失败:", {
                            error: balanceError.message,
                            tokenAccount: tokenAccount?.toString(),
                            wallet: op?.wallet?.publicKey?.toString(),
                            mint: mintPublicKey.toString()
                        });
                        throw new Error(`Failed to get token balance: ${balanceError.message}`);
                    }

                    if (!tokenBalance) {
                        throw new Error('Invalid token balance response');
                    }

                    // 计算卖出数量
                    const tokenAmountBigInt = BigInt(tokenBalance);
                    const sellAmount = (tokenAmountBigInt * BigInt(Math.floor(percentage * 100))) / BigInt(10000);

                    // 构建交易
                    const sellTx = await this.getSellInstructionsByTokenAmount(
                        op.wallet.publicKey,
                        mintPublicKey,
                        sellAmount,
                        BigInt(options.slippageBasisPoints || 1000)
                    );

                    // 添加计算预算指令
                    if (config.usePriorityFee) {
                        const microLamports = config.jitoTipSol ?
                            Math.floor(config.jitoTipSol * LAMPORTS_PER_SOL / 1_000_000) :
                            100000;

                        sellTx.add(
                            ComputeBudgetProgram.setComputeUnitPrice({
                                microLamports
                            })
                        );
                    }

                    // 模拟交易
                    try {
                        await this.connection.simulateTransaction(sellTx, [op.wallet]);
                    } catch (simError) {
                        throw new Error(`Transaction simulation failed: ${simError.message}`);
                    }

                    validOperations.push({
                        wallet: op.wallet,
                        mint: mintPublicKey,
                        sellAmount,
                        transaction: sellTx,
                        percentage
                    });

                } catch (error) {
                    logger.error("验证操作失败:", {
                        error: error.message,
                        stack: error.stack,
                        operation: {
                            wallet: op?.wallet?.publicKey?.toString() || 'unknown',
                            mint: op?.mint?.toString() || op?.mint,
                            sellAmount: op?.sellAmount,
                            index: i
                        }
                    });

                    validationFailures.push({
                        success: false,
                        wallet: op?.wallet?.publicKey?.toString() || 'unknown',
                        mint: op?.mint?.toString() || op?.mint,
                        error: error.message,
                        index: i
                    });
                }
            }

            // 3. 分批处理
            const batches = [];
            let currentBatch = [];

            for (const op of validOperations) {
                if (currentBatch.length >= config.bundleMaxSize) {
                    batches.push([...currentBatch]);
                    currentBatch = [];
                }
                currentBatch.push(op);
            }

            if (currentBatch.length > 0) {
                batches.push(currentBatch);
            }

            // 4. 初始化Jito服务
            if (!config.normalSubmission) {
                try {
                    jitoService = new JitoService(this.connection);
                    await jitoService.initialize();
                    logger.info("Jito服务初始化成功");
                } catch (jitoError) {
                    logger.error("Jito服务初始化失败:", {
                        error: jitoError.message,
                        stack: jitoError.stack
                    });
                    throw jitoError;
                }
            }

            // 5. 处理每个批次
            for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
                const batch = batches[batchIndex];

                try {
                    const { blockhash, lastValidBlockHeight } =
                        await this.connection.getLatestBlockhash('confirmed');

                    // 准备交易
                    for (const op of batch) {
                        op.transaction.recentBlockhash = blockhash;
                        op.transaction.feePayer = op.wallet.publicKey;
                        op.transaction.lastValidBlockHeight = lastValidBlockHeight;
                        op.transaction.sign(op.wallet);
                    }

                    if (config.normalSubmission) {
                        // 普通上链
                        for (const op of batch) {
                            try {
                                const signature = await this.connection.sendTransaction(
                                    op.transaction,
                                    [op.wallet],
                                    {
                                        skipPreflight: config.skipPreflight,
                                        preflightCommitment: config.preflightCommitment,
                                        maxRetries: config.retryAttempts
                                    }
                                );

                                await this.connection.confirmTransaction({
                                    signature,
                                    blockhash,
                                    lastValidBlockHeight
                                });

                                results.push({
                                    success: true,
                                    signature,
                                    wallet: op.wallet.publicKey.toString(),
                                    mint: op.mint.toString(),
                                    percentage: op.percentage,
                                    tokensAmount: op.sellAmount.toString()
                                });

                            } catch (error) {
                                results.push({
                                    success: false,
                                    wallet: op.wallet.publicKey.toString(),
                                    mint: op.mint.toString(),
                                    error: error.message,
                                    percentage: op.percentage,
                                    tokensAmount: op.sellAmount.toString()
                                });
                            }
                        }
                    } else {
                        // Jito上链
                        const transactions = batch.map(op => op.transaction);

                        // 为第一笔交易添加tip
                        if (transactions.length > 0 && config.jitoTipRequired) {
                            try {
                                const tipAmountLamports = BigInt(Math.floor(config.jitoTipSol * LAMPORTS_PER_SOL));
                                // 直接使用transactions[0]，不需要创建新变量
                                const firstTransaction = transactions[0];
                                const firstSigner = batch[0].wallet;

                                logger.info("准备添加Jito tip:", {
                                    tipAmount: tipAmountLamports.toString(),
                                    wallet: firstSigner.publicKey.toString(),
                                    transactionSignatures: firstTransaction.signatures.length
                                });
                                const wallet = firstSigner;
                                // 添加tip
                                transactions[0] = await jitoService.addTipToTransaction(
                                    firstTransaction, {
                                    tipAmountLamports,
                                        wallet
                                });

                                // 重新签名
                                transactions[0].recentBlockhash = blockhash;
                                transactions[0].feePayer = firstSigner.publicKey;
                                transactions[0].lastValidBlockHeight = lastValidBlockHeight;

                                // 完整签名
                                transactions[0].partialSign(firstSigner);

                                // 验证签名
                                if (!transactions[0].verifySignatures()) {
                                    throw new Error('Transaction signature verification failed after adding tip');
                                }

                                logger.info("成功添加Jito tip交易:", {
                                    tipAmount: tipAmountLamports.toString(),
                                    transactionSignature: transactions[0]?.signatures[0]?.toString()
                                });
                            } catch (tipError) {
                                logger.error("添加Jito tip失败:", {
                                    error: tipError.message,
                                    stack: tipError.stack,
                                    tipAmount: config.jitoTipSol,
                                    batchIndex: batchIndex
                                });
                                throw new Error(`Failed to add Jito tip: ${tipError.message}`);
                            }
                        }
// 验证所有交易的签名
                        for (let i = 0; i < transactions.length; i++) {
                            const tx = transactions[i];
                            const signer = batch[i].wallet;

                            // 确保基本信息正确
                            if (!tx.feePayer.equals(signer.publicKey)) {
                                tx.feePayer = signer.publicKey;
                            }

                            // 验证签名是否存在
                            const hasValidSignature = tx.signatures.some(sig =>
                                sig.publicKey.equals(signer.publicKey) && sig.signature !== null
                            );

                            if (!hasValidSignature) {
                                logger.warn("交易缺少有效签名，重新签名:", {
                                    transactionIndex: i,
                                    wallet: signer.publicKey.toString()
                                });

                                // 重新签名
                                tx.partialSign(signer);
                            }

                            // 最终验证
                            if (!tx.verifySignatures()) {
                                throw new Error(`Transaction ${i} failed signature verification`);
                            }
                        }
                        const bundleResult = await jitoService.sendBundle(transactions);

                        // 等待确认
                        const confirmations = await Promise.allSettled(
                            batch.map(async (op) => {
                                const signature = bs58.encode(op.transaction.signatures[0].signature);
                                try {
                                    await this.connection.confirmTransaction({
                                        signature,
                                        blockhash,
                                        lastValidBlockHeight
                                    });
                                    return {
                                        success: true,
                                        signature,
                                        bundleId: bundleResult.bundleId,
                                        op
                                    };
                                } catch (error) {
                                    return {
                                        success: false,
                                        error: error.message,
                                        signature,
                                        op
                                    };
                                }
                            })
                        );

                        // 处理结果
                        for (const result of confirmations) {
                            if (result.status === 'fulfilled') {
                                const { value } = result;
                                results.push({
                                    success: true,
                                    signature: value.signature,
                                    bundleId: value.bundleId,
                                    wallet: value.op.wallet.publicKey.toString(),
                                    mint: value.op.mint.toString(),
                                    percentage: value.op.percentage,
                                    tokensAmount: value.op.sellAmount.toString()
                                });
                            } else {
                                results.push({
                                    success: false,
                                    error: result.reason.message,
                                    wallet: result.reason.op.wallet.publicKey.toString(),
                                    mint: result.reason.op.mint.toString(),
                                    percentage: result.reason.op.percentage,
                                    tokensAmount: result.reason.op.sellAmount.toString()
                                });
                            }
                        }
                    }

                    // 批次间等待
                    if (batchIndex < batches.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, config.waitBetweenBundles));
                    }

                } catch (error) {
                    logger.error("批次处理失败:", {
                        error: error.message,
                        stack: error.stack,
                        batchIndex: batchIndex,
                        batchSize: batch.length,
                        wallets: batch.map(op => ({
                            wallet: op?.wallet?.publicKey?.toString(),
                            mint: op?.mint?.toString(),
                            sellAmount: op?.sellAmount?.toString()
                        })),
                        config: {
                            normalSubmission: config.normalSubmission,
                            usePriorityFee: config.usePriorityFee,
                            jitoTipSol: config.jitoTipSol,
                            jitoTipRequired: config.jitoTipRequired,
                            bundleMaxSize: config.bundleMaxSize
                        },
                        jitoService: {
                            initialized: !!jitoService,
                            status: jitoService?.status
                        }
                    });

                    // 批次失败处理
                    for (const op of batch) {
                        results.push({
                            success: false,
                            error: error.message,
                            wallet: op.wallet.publicKey.toString(),
                            mint: op.mint.toString(),
                            percentage: op.percentage,
                            tokensAmount: op.sellAmount.toString()
                        });
                    }
                }
            }

            return {
                success: results.some(r => r.success),
                results,
                stats: {
                    totalOperations: operations.length,
                    successful: results.filter(r => r.success).length,
                    failed: results.filter(r => !r.success).length,
                    duration: `${(Date.now() - startTime) / 1000} seconds`,
                    validationFailures: validationFailures.length
                }
            };

        } catch (error) {
            logger.error("批量卖出操作失败:", {
                error: error.message,
                stack: error.stack,
                stats: {
                    totalOperations: operations?.length || 0,
                    validOperations: validOperations?.length || 0,
                    validationFailures: validationFailures?.length || 0,
                    results: results?.length || 0
                },
                config: {
                    bundleMaxSize: config?.bundleMaxSize,
                    waitBetweenBundles: config?.waitBetweenBundles,
                    usePriorityFee: config?.usePriorityFee,
                    normalSubmission: config?.normalSubmission,
                    jitoTipRequired: config?.jitoTipRequired
                },
                duration: `${(Date.now() - startTime) / 1000} seconds`
            });
            throw error;
        } finally {
            if (jitoService) {
                try {
                    await jitoService.cleanup();
                    logger.info("Jito服务清理完成");
                } catch (cleanupError) {
                    logger.error("Jito服务清理失败:", {
                        error: cleanupError.message,
                        stack: cleanupError.stack
                    });
                }
            }
        }
    }
}
