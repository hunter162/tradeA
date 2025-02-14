import {createRequire} from 'module';

const require = createRequire(import.meta.url);
import pkg from 'pumpdotfun-sdk';

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
    Keypair, Transaction
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

// 不继承 PumpSDK，而是作为组合使用
export class CustomPumpSDK extends PumpFunSDK {
    constructor(provider) {
        super(provider);
        this.solanaService = null;
        this.connection = provider.connection;
        this.wsManager = new WebSocketManager(provider.connection.rpcEndpoint);

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

        // 确保使用正确的程序 ID
        this.TOKEN_PROGRAM_ID = TOKEN_PROGRAM_ID;
        this.ASSOCIATED_TOKEN_PROGRAM_ID = ASSOCIATED_TOKEN_PROGRAM_ID;
        this.PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
    }

    setSolanaService(solanaService) {
        this.solanaService = solanaService;
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
                const initialBuyPrice = await globalAccount.getInitialBuyPrice(solAmountLamports);
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
    async createAndBuy(creator, mint, metadata, buyAmountSol, slippageBasisPoints = 500n, priorityFees) {
        try {
            // 1. 获取最优 RPC 节点
            const bestEndpoint = await this.solanaService.getBestNode();
            this.connection = new Connection(bestEndpoint, {
                commitment: 'confirmed',
                confirmTransactionInitialTimeout: 120000,
                wsEndpoint: this.solanaService._getWsEndpoint(bestEndpoint)
            });

            logger.info('使用最优 RPC 节点:', {
                endpoint: bestEndpoint.replace(/api-key=([^&]+)/, 'api-key=***')
            });

            // 2. 创建代币元数据
            let tokenMetadata = await this.createTokenMetadata(metadata);

            // 3. 创建代币
            let transaction = new SolanaTransaction();
            transaction.add(await this.getCreateInstructions(
                creator.publicKey,
                metadata.name,
                metadata.symbol,
                tokenMetadata.metadataUri,
                mint
            ));

            // 4. 如果需要购买，添加购买指令
            if (buyAmountSol > 0) {
                const globalAccount = await this.getGlobalAccount('confirmed');
                const buyAmount = await globalAccount.getInitialBuyPrice(BigInt(buyAmountSol));

                // 处理滑点
                let basisPoints;
                try {
                    if (typeof slippageBasisPoints === 'bigint') {
                        basisPoints = slippageBasisPoints;
                    } else if (typeof slippageBasisPoints === 'number') {
                        basisPoints = BigInt(slippageBasisPoints);
                    } else if (typeof slippageBasisPoints === 'string') {
                        basisPoints = BigInt(parseInt(slippageBasisPoints));
                    } else {
                        basisPoints = BigInt(100); // 默认 1%
                    }
                } catch (error) {
                    logger.warn('转换滑点参数失败，使用默认值:', {
                        slippageBasisPoints,
                        error: error.message
                    });
                    basisPoints = BigInt(100);
                }

                const buyAmountWithSlippage = this.calculateWithSlippageBuy(
                    buyAmount,
                    basisPoints
                );

                const buyTx = await this.getBuyInstructions(
                    creator.publicKey,
                    mint.publicKey,
                    globalAccount.feeRecipient,
                    buyAmount,
                    buyAmountWithSlippage
                );

                transaction.add(buyTx);
            }

            // 6. 添加优先费用（如果有）
            if (priorityFees) {
                const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: priorityFees
                });
                transaction.instructions.unshift(priorityFeeIx);
            }

            // 获取模拟用的 blockhash
            const { value: { blockhash, lastValidBlockHeight }, context: simulationContext } = 
                await this.connection.getLatestBlockhashAndContext('processed');

            logger.info('模拟交易使用的区块信息:', {
                blockhash,
                lastValidBlockHeight,
                slot: simulationContext.slot,
                timestamp: new Date().toISOString()
            });

            transaction.recentBlockhash = blockhash;
            transaction.lastValidBlockHeight = lastValidBlockHeight;
            transaction.feePayer = creator.publicKey;

            // 5. 交易模拟
            logger.info('开始模拟交易...');

            // 编译消息
            const messageV0 = transaction.compileMessage();

            // 正确的模拟交易调用
            const simulation = await this.connection.simulateTransaction(
                transaction,  // 使用完整的 transaction
                [creator, mint],  // 需要提供签名者
                {
                    sigVerify: true,
                    replaceRecentBlockhash: true,
                    commitment: 'processed'
                }
            );

            logger.info('交易模拟结果:', {
                err: simulation.value.err,
                unitsConsumed: simulation.value.unitsConsumed,
                logs: simulation.value.logs?.length || 0,
                timestamp: new Date().toISOString()
            });

            // 5.1 检查模拟结果
            if (simulation.value.err) {
                throw new Error(`交易模拟失败: ${simulation.value.err}`);
            }

            // 5.2 检查计算单元
            const computeUnits = simulation.value.unitsConsumed || 0;
            logger.info('交易模拟成功:', {
                computeUnits,
                logs: simulation.value.logs,
                timestamp: new Date().toISOString()
            });

            // 5.3 检查余额
            const fees = await this.connection.getFeeForMessage(
                messageV0,
                'confirmed'
            );

            const requiredBalance = BigInt(fees.value || 0) + (buyAmountSol);
            const currentBalance = await this.connection.getBalance(creator.publicKey);

            if (BigInt(currentBalance) < requiredBalance) {
                throw new Error(`余额不足. 需要: ${requiredBalance}, 当前: ${currentBalance}`);
            }



            // 获取实际发送用的新 blockhash
            const { value: { blockhash: sendBlockhash, lastValidBlockHeight: sendValidHeight }, context: sendContext } = 
                await this.connection.getLatestBlockhashAndContext('processed');

            logger.info('实际发送交易使用的区块信息:', {
                blockhash: sendBlockhash,
                lastValidBlockHeight: sendValidHeight,
                slot: sendContext.slot,
                commitment: 'processed',
                timestamp: new Date().toISOString()
            });

            transaction.recentBlockhash = sendBlockhash;
            transaction.lastValidBlockHeight = sendValidHeight -150;
            transaction.feePayer = creator.publicKey;

            // 发送交易
            const signature = await this.sendTransactionWithLogs(
                this.connection,
                transaction,
                [creator, mint],
                {
                    skipPreflight: true,
                    preflightCommitment: 'processed',
                    maxRetries: 5,
                    commitment: 'confirmed'
                }
            );

            logger.info('交易已发送并确认:', { 
                signature,
                endpoint: bestEndpoint.replace(/api-key=([^&]+)/, 'api-key=***')
            });

            // 不再需要单独的确认步骤，因为 sendAndConfirmTransaction 已经包含了确认
            
            return {
                signature,
                mint: mint.publicKey,
                creator: creator.publicKey,
                tokenAmount: buyAmountSol.toString(),
                tokenDecimals: 6,
                metadata: tokenMetadata,
                time: Date.now()
            };

        } catch (error) {
            // 更新节点统计信息
            this.solanaService.updateNodeStats(this.currentEndpoint, {
                success: false,
                error: error.message
            });

            logger.error('创建代币失败:', {
                error: error.message,
                creator: creator?.publicKey?.toString(),
                mint: mint?.publicKey?.toString(),
                metadata: {
                    name: metadata?.name,
                    symbol: metadata?.symbol
                }
            });
            throw error;
        }
    }
    async sendTransactionWithLogs(connection, transaction, signers, options) {
        let lastError = null;
        const maxRetries = options.maxRetries || 5;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                logger.info(`尝试发送交易 (${attempt + 1}/${maxRetries})`, {
                    signers: signers.map(s => s.publicKey.toString()),
                    blockhash: transaction.recentBlockhash,
                    attempt: attempt + 1
                });

                const signature = await connection.sendTransaction(transaction, signers, {
                    skipPreflight: options.skipPreflight,
                    preflightCommitment: options.preflightCommitment,
                });

                logger.info(`交易已发送，等待确认... (尝试 ${attempt + 1}/${maxRetries})`, {
                    signature,
                    commitment: options.commitment
                });

                // 等待交易确认
                const confirmation = await connection.confirmTransaction({
                    signature,
                    blockhash: transaction.recentBlockhash,
                    lastValidBlockHeight: transaction.lastValidBlockHeight
                }, options.commitment);

                if (confirmation.value.err) {
                    throw new Error(`Transaction failed: ${confirmation.value.err}`);
                }

                logger.info('交易确认成功', {
                    signature,
                    attempt: attempt + 1,
                    totalAttempts: maxRetries
                });

                return signature;

            } catch (error) {
                lastError = error;
                logger.warn(`交易尝试失败 (${attempt + 1}/${maxRetries})`, {
                    error: error.message,
                    blockhash: transaction.recentBlockhash,
                    isLastAttempt: attempt === maxRetries - 1
                });

                if (attempt < maxRetries - 1) {
                    // 获取新的 blockhash 进行重试
                    const { blockhash, lastValidBlockHeight } =
                        await connection.getLatestBlockhash(options.commitment);
                    transaction.recentBlockhash = blockhash;
                    transaction.lastValidBlockHeight = lastValidBlockHeight;

                    // 等待一段时间后重试
                    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
                } else {
                    throw lastError;
                }
            }
        }

        throw lastError;
    }
    // 使用 BN.js 计算滑点
    _calculateSlippageBN(amount, basisPoints) {
        try {
            const TEN_THOUSAND = new BN(10000);

            // 计算滑点金额
            const slippageAmount = amount.mul(basisPoints).div(TEN_THOUSAND);

            // 返回带滑点的金额
            return amount.add(slippageAmount);
        } catch (error) {
            logger.error('计算滑点失败:', {
                error: error.message,
                amount: amount?.toString(),
                basisPoints: basisPoints?.toString()
            });
            throw new Error(`Failed to calculate slippage: ${error.message}`);
        }
    }

    // 原来的 BigInt 版本保留作为备用
    _calculateSlippage(amount, basisPoints) {
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
    calculateWithSlippageBuy(buyAmount, slippageBasisPoints) {
        try {
            // 确保输入是 BigInt
            const amount = typeof buyAmount === 'bigint' ?
                buyAmount :
                BigInt(buyAmount.toString());

            const basisPoints = typeof slippageBasisPoints === 'bigint' ?
                slippageBasisPoints :
                BigInt(slippageBasisPoints.toString());

            // 使用 BigInt 进行所有计算
            const TEN_THOUSAND = BigInt(10000);
            const slippageAmount = (amount * basisPoints) / TEN_THOUSAND;
            const finalAmount = amount + slippageAmount;

            logger.debug('滑点计算:', {
                originalAmount: amount.toString(),
                slippageBasisPoints: basisPoints.toString(),
                slippageAmount: slippageAmount.toString(),
                finalAmount: finalAmount.toString()
            });

            return finalAmount;
        } catch (error) {
            logger.error('计算滑点失败:', {
                error: error.message,
                buyAmount: typeof buyAmount === 'bigint' ? buyAmount.toString() : buyAmount,
                slippageBasisPoints: typeof slippageBasisPoints === 'bigint' ?
                    slippageBasisPoints.toString() :
                    slippageBasisPoints
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

// 修改 sell 方法
async sell(
    seller, // Keypair
    mint,   // PublicKey
    sellTokenAmount, // bigint
    slippageBasisPoints = 100n, // bigint
    priorityFees, // { tipAmountSol?: number, microLamports?: number }
    options = {} // { usePriorityFee?: boolean, priorityType?: string, deadline?: number }
)
{
    try {
        // 1. 使用 withRetry 包装主要操作以实现 RPC 优选
        return await this.withRetry(async () => {
            // 2. 获取卖出指令
            let sellTx = await super.getSellInstructionsByTokenAmount(
                seller.publicKey,
                mint,
                sellTokenAmount,
                slippageBasisPoints,
                'confirmed'
            );

            // 3. 处理优先上链
            if (options.usePriorityFee) {
                const jitoService = new JitoService(this.connection);
                sellTx = await jitoService.addPriorityFee(sellTx, {
                    type: options.priorityType || 'jito',
                    tipAmountSol: priorityFees?.tipAmountSol
                });
            }
            else if (priorityFees?.microLamports) {
                sellTx.add(
                    ComputeBudgetProgram.setComputeUnitPrice({
                        microLamports: priorityFees.microLamports
                    })
                );
            }

            // 4. 获取最新的 blockhash
            const { blockhash, lastValidBlockHeight } = 
                await this.connection.getLatestBlockhash('confirmed');
            
            sellTx.recentBlockhash = blockhash;
            sellTx.lastValidBlockHeight = lastValidBlockHeight;
            sellTx.feePayer = seller.publicKey;

            // 5. 模拟交易
            logger.info('开始模拟交易...');
            const simulation = await this.connection.simulateTransaction(sellTx, [seller], {
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
                    seller: seller.publicKey.toString()
                });

                // 检查具体错误类型
                if (logs.some(log => log.includes('insufficient funds'))) {
                    throw new Error('Insufficient token balance for transaction');
                }
                throw new Error(`Transaction simulation failed: ${simulation.value.err}`);
            }

            // 7. 计算预估费用
            const estimatedFee = await this.connection.getFeeForMessage(
                sellTx.compileMessage(),
                'confirmed'
            );

            // 8. 检查 SOL 余额是否足够支付费用
            const balance = await this.connection.getBalance(seller.publicKey);
            if (BigInt(balance) < BigInt(estimatedFee.value || 0)) {
                throw new Error(`Insufficient SOL for fees. Required: ${estimatedFee.value}, Current: ${balance}`);
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
            sellTx.recentBlockhash = sendBlockhash;
            sellTx.lastValidBlockHeight = sendValidHeight - 150; // 减少 150 个区块的有效期
            sellTx.feePayer = seller.publicKey;

            // 10. 发送交易
            let signature;
            if (options.usePriorityFee && options.priorityType === 'nozomi') {
                signature = await this.sendTransactionViaNozomi(
                    sellTx,
                    [seller],
                    NOZOMI_CONFIG
                );
            } else {
                signature = await sendAndConfirmTransaction(
                    this.connection,
                    sellTx,
                    [seller],
                    {
                        skipPreflight: false,
                        preflightCommitment: 'processed',
                        maxRetries: 5,
                        commitment: 'confirmed'
                    }
                );
            }

            // 11. 返回结果
            const result = {
                signature,
                txId: signature,
                amount: sellTokenAmount.toString(),
                mint: mint.toString(),
                owner: seller.publicKey.toString(),
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

            logger.info('卖出交易成功:', {
                signature: result.signature,
                seller: seller.publicKey.toString(),
                mint: mint.toString(),
                amount: sellTokenAmount.toString(),
                endpoint: this.connection.rpcEndpoint,
                priorityFee: result.priorityFee,
                simulation: result.simulation
            });

            return result;
        });

    } catch (error) {
        logger.error('❌ 卖出代币失败', {
            error: error.message,
            mint: mint.toString(),
            amount: sellTokenAmount.toString(),
            slippage: `${Number(slippageBasisPoints) / 100}%`,
            time: new Date().toISOString(),
            endpoint: this.connection.rpcEndpoint
        });
        throw error;
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

// 修改滑点计算方法
calculateSlippage(amount, basisPoints)
{
    try {
        // 修改验证逻辑，允许 BigInt 类型
        const basisPointsNum = Number(basisPoints);
        if (isNaN(basisPointsNum) || basisPointsNum < 0 || basisPointsNum > 10000) {
            throw new Error(`Invalid slippage basis points: ${basisPoints}`);
        }

        // 计算滑点金额
        const slippageAmount = (BigInt(amount) * BigInt(basisPointsNum)) / BigInt(10000);
        const finalAmount = BigInt(amount) + slippageAmount;

        logger.debug('📊 滑点计算', {
            originalAmount: amount.toString(),
            slippagePercent: `${basisPointsNum / 100}%`,
            basisPoints: basisPointsNum.toString(),
            slippageAmount: slippageAmount.toString(),
            finalAmount: finalAmount.toString()
        });

        return finalAmount;
    } catch (error) {
        logger.error('计算滑点失败', {
            amount,
            basisPoints,
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