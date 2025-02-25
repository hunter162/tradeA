import pkg from '@project-serum/anchor';

const {BN} = pkg;
import {EventEmitter} from 'events';
import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    clusterApiUrl,
    Transaction as SolanaTransaction,
    SystemProgram
} from "@solana/web3.js";
import {AnchorProvider} from "@coral-xyz/anchor";
import {Wallet} from "@coral-xyz/anchor";
import pumpPkg from 'pumpdotfun-sdk';

const {DEFAULT_DECIMALS, MPL_TOKEN_METADATA_PROGRAM_ID} = pumpPkg;
import {CustomPumpSDK} from './customPumpSDK.js';
import {logger} from '../utils/index.js';
import {PinataService} from './pinataService.js';
import {config} from '../../config/index.js';
import path from 'path';
import FormData from 'form-data';
import fetch from 'node-fetch';
import fs from 'fs';
import {
    getAssociatedTokenAddress,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import bs58 from 'bs58';
import {SOLANA_CONFIG} from '../../config/solana.js';
import {RedisService} from './redisService.js';
import db from '../db/index.js';
import {ErrorCodes, SolanaServiceError, handleError} from '../utils/errors.js';
import {AccountLayout} from "@solana/spl-token";
import {WebSocketManager} from './webSocketManager.js';
import {CustomError} from '../utils/errors.js';
import {createRequire} from 'module';

const require = createRequire(import.meta.url);
const {Metadata} = require('@metaplex-foundation/mpl-token-metadata');
const {TokenMetadataProgram} = require('@metaplex-foundation/mpl-token-metadata');

// 打印出 MPL_TOKEN_METADATA_PROGRAM_ID 的值和类型
logger.info('Token Metadata Program ID', {
    value: MPL_TOKEN_METADATA_PROGRAM_ID,
    type: typeof MPL_TOKEN_METADATA_PROGRAM_ID
});

// 使用硬编码的地址（这是 Metaplex 的标准地址）
const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

const CACHE_KEYS = {
    BALANCE_SOL: (pubkey) => `balance:sol:${pubkey}`,
    TOKEN_BALANCE: (pubkey, mint) => `balance:token:${pubkey}:${mint}`
};
const validateBatchResult = (batchResult) => {
    if (!batchResult) throw new Error('Batch result is required');
    if (!batchResult.groupType) throw new Error('groupType is required');
    if (!batchResult.accountNumber) throw new Error('accountNumber is required');
    if (!batchResult.tokenAmount) throw new Error('tokenAmount is required');
    if (!batchResult.solAmount) throw new Error('solAmount is required');
    return true;
};

const validateTransaction = (tx) => {
    if (!tx.signature) throw new Error('Transaction signature is required');
    if (!tx.mint) throw new Error('Transaction mint is required');
    if (!tx.groupType) throw new Error('Transaction groupType is required');
    if (!tx.accountNumber) throw new Error('Transaction accountNumber is required');
    return true;
};

export class SolanaService {
    constructor(config) {
        try {
            // 1. 初始化 RPC 节点池
            this.endpoints = process.env.SOLANA_RPC_ENDPOINTS
                ? JSON.parse(process.env.SOLANA_RPC_ENDPOINTS)
                : ['https://api.mainnet-beta.solana.com'];

            // 验证所有端点
            this.endpoints = this.endpoints.map(endpoint => {
                if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
                    throw new Error(`Invalid endpoint URL: ${endpoint}`);
                }
                return endpoint;
            });

            // 2. 记录节点状态
            this.nodeStats = new Map(this.endpoints.map(endpoint => [
                endpoint,
                {
                    latency: 0,
                    successRate: 1,
                    errorCount: 0,
                    lastCheck: Date.now(),
                    lastError: null,
                    lastSuccess: null
                }
            ]));

            // 3. 初始化节点管理
            this.currentEndpoint = this.endpoints[0];
            this.usedEndpoints = new Set();
            this.availableEndpoints = [...this.endpoints];
            this.retryCount = 0;
            this.maxRetries = config?.maxRetries || 3;

            // 4. 创建初始连接
            this.connection = new Connection(this.currentEndpoint, {
                commitment: "confirmed",
                confirmTransactionInitialTimeout: config?.confirmTimeout || 60000,
                wsEndpoint: this._getWsEndpoint(this.currentEndpoint)
            });

            // 5. 创建 WebSocket 管理器
            this.wsManager = new WebSocketManager(this.currentEndpoint);

            // 6. 初始化基础服务
            this.sdk = null;
            this.walletService = null;
            this.redis = null;
            this.tokenSubscriptionService = null;
            this.pinataService = null;
            this.provider = null;

            // 7. 设置订阅管理
            this.subscriptions = new Map();
            this.activeSubscriptions = new Map();

            // 8. 配置健康检查参数
            this.lastHealthCheck = 0;
            this.healthCheckInterval = config?.healthCheckInterval || 30000; // 30 秒检查一次
            this.timeoutSettings = {
                requestTimeout: config?.requestTimeout || 10000,     // 单次请求超时：10秒
                confirmTimeout: config?.confirmTimeout || 30000,     // 交易确认超时：30秒
                retryDelay: config?.retryDelay || 1000              // 重试延迟：1秒
            };

            // 9. 创建端点性能统计
            this.endpointStats = new Map(this.endpoints.map(endpoint => [endpoint, {
                successCount: 0,
                errorCount: 0,
                lastError: null,
                lastSuccess: null,
                avgLatency: 0,
                isRateLimited: false,
                lastUpdate: Date.now()
            }]));

            // 10. 设置默认配置
            this.defaultConfig = {
                commitment: "confirmed",
                preflightCommitment: "confirmed",
                skipPreflight: false,
                maxRetries: 3,
                minContextSlot: 0
            };

            // 11. 初始化缓存键
            this.CACHE_KEYS = {
                BALANCE_SOL: (pubkey) => `balance:sol:${pubkey}`,
                TOKEN_BALANCE: (pubkey, mint) => `balance:token:${pubkey}:${mint}`,
                TOKEN_METADATA: (mint) => `token:metadata:${mint}`,
                TRANSACTION: (signature) => `tx:${signature}`
            };

            // 12. 记录初始化信息
            logger.info('初始化 Solana 服务:', {
                totalEndpoints: this.endpoints.length,
                currentEndpoint: this.currentEndpoint.replace(/api-key=([^&]+)/, 'api-key=***'),
                wsEnabled: !!this.wsManager,
                timeoutSettings: this.timeoutSettings,
                defaultCommitment: this.defaultConfig.commitment
            });

        } catch (error) {
            logger.error('Solana 服务初始化失败:', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }

        // 13. 设置自动清理间隔
        setInterval(() => {
            this.cleanupStaleSubscriptions();
        }, 300000); // 每5分钟清理一次过期订阅
    }

    async cleanupStaleSubscriptions() {
        try {
            const now = Date.now();
            const staleTimeout = 3600000; // 1小时

            for (const [key, subscription] of this.activeSubscriptions) {
                if (now - subscription.lastUpdate > staleTimeout) {
                    try {
                        await this.wsManager.unsubscribeFromAccount(subscription.id);
                        this.activeSubscriptions.delete(key);
                        logger.debug('清理过期订阅:', {key});
                    } catch (error) {
                        logger.warn('清理订阅失败:', {
                            key,
                            error: error.message
                        });
                    }
                }
            }

            logger.debug('订阅清理完成:', {
                activeCount: this.activeSubscriptions.size
            });
        } catch (error) {
            logger.error('清理过期订阅失败:', {
                error: error.message
            });
        }
    }

    _getWsEndpoint(httpEndpoint) {
        try {
            if (!httpEndpoint) {
                return 'wss://api.mainnet-beta.solana.com';
            }

            const url = new URL(httpEndpoint);

            // 如果已经是 ws/wss，直接返回
            if (url.protocol === 'ws:' || url.protocol === 'wss:') {
                return httpEndpoint;
            }

            // 转换 http -> ws, https -> wss
            const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            url.protocol = wsProtocol;

            // 处理特殊域名
            if (url.hostname === 'mainnet.helius-rpc.com') {
                const apiKey = url.searchParams.get('api-key');
                return `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;
            }

            return url.toString();
        } catch (error) {
            logger.error('解析 WebSocket endpoint 失败:', {
                error: error.message,
                httpEndpoint
            });
            // 返回默认的 WebSocket endpoint
            return 'wss://api.mainnet-beta.solana.com';
        }
    }

    // 添加 setter 方法
    setWalletService(walletService) {
        this.walletService = walletService;
        logger.info('WalletService 已设置到 SolanaService');
    }

    setRedisService(redisService) {
        this.redis = redisService;
    }

    setTokenSubscriptionService(tokenSubscriptionService) {
        this.tokenSubscriptionService = tokenSubscriptionService;
    }

    async initialize() {
        try {
            // 1. 测试所有 RPC 节点并选择最快的
            const bestEndpoint = await this.findBestEndpoint();

            // 2. 创建连接
            this.connection = new Connection(bestEndpoint, {
                commitment: "confirmed",
                confirmTransactionInitialTimeout: 60000,
                wsEndpoint: this._getWsEndpoint(bestEndpoint)
            });

            // 3. 初始化 provider
            this.provider = new AnchorProvider(
                this.connection,
                null,  // 这里不需要钱包
                {
                    commitment: "confirmed",
                    preflightCommitment: "confirmed",
                    skipPreflight: false
                }
            );

            // 4. 初始化 SDK
            const sdkOptions = {
                commitment: "confirmed",
                preflightCommitment: "confirmed",
                skipPreflight: false,
                timeout: 60000,
                retries: 3
            };
            this.sdk = new CustomPumpSDK(this.provider, sdkOptions);
            this.sdk.setSolanaService(this);  // 设置 solanaService 引用

            // 5. 初始化 Pinata 服务
            if (!config.pinata.apiKey || !config.pinata.apiSecret || !config.pinata.jwt) {
                throw new Error('Pinata credentials are required');
            }

            this.pinataService = new PinataService(
                config.pinata.apiKey,
                config.pinata.apiSecret,
                config.pinata.jwt
            );

            logger.info('Solana 服务初始化完成', {
                connection: !!this.connection,
                provider: !!this.provider,
                sdk: !!this.sdk,
                pinataService: !!this.pinataService,
                walletService: !!this.walletService
            });
        } catch (error) {
            logger.error('Solana 服务初始化失败:', error);
            throw error;
        }
    }

    // 找到最快的 RPC 节点
    async findBestEndpoint() {
        const results = await Promise.allSettled(
            this.endpoints.map(async endpoint => {
                const startTime = Date.now();
                try {
                    const connection = new Connection(endpoint);
                    await connection.getLatestBlockhash();
                    const latency = Date.now() - startTime;

                    return {
                        endpoint,
                        latency,
                        status: 'success'
                    };
                } catch (error) {
                    return {
                        endpoint,
                        latency: Infinity,
                        status: 'error',
                        error: error.message
                    };
                }
            })
        );

        // 过滤并排序结果
        const validResults = results
            .filter(r => r.status === 'fulfilled' && r.value.status === 'success')
            .map(r => r.value)
            .sort((a, b) => a.latency - b.latency);

        if (validResults.length === 0) {
            logger.warn('没有可用的 RPC 节点，使用默认节点');
            return this.endpoints[0];
        }

        const bestEndpoint = validResults[0].endpoint;
        logger.info('选择最快的 RPC 节点:', {
            endpoint: bestEndpoint.replace(/api-key=([^&]+)/, 'api-key=***'),
            latency: `${validResults[0].latency}ms`
        });

        return bestEndpoint;
    }

    async createConnection(endpoint) {
        try {
            const rpcEndpoint = endpoint || this.currentEndpoint;
            this.connection = new Connection(rpcEndpoint, {
                commitment: 'confirmed',
                confirmTransactionInitialTimeout: 60000,
                wsEndpoint: this._getWsEndpoint(rpcEndpoint)
            });

            logger.info('创建新的 RPC 连接:', {
                endpoint: rpcEndpoint.replace(/api-key=([^&]+)/, 'api-key=***'),
                timeout: 60000
            });

            return true;
        } catch (error) {
            logger.error('创建 RPC 连接失败:', {
                error: error.message,
                endpoint: (endpoint || this.currentEndpoint).replace(/api-key=([^&]+)/, 'api-key=***')
            });
            throw error;
        }
    }

    async testConnection() {
        return this.checkConnectionHealth();
    }

    // 获取当前连接
    getConnection() {
        if (!this.connection) {
            throw new Error('Solana service not initialized');
        }
        return this.connection;
    }

    // 获取下一个未使用的节点
    getNextEndpoint() {
        // 记录当前节点为已使用
        this.usedEndpoints.add(this.currentEndpoint);

        // 从可用节点中过滤掉已使用的节点
        const remainingEndpoints = this.availableEndpoints.filter(
            endpoint => !this.usedEndpoints.has(endpoint)
        );

        logger.info('节点切换状态:', {
            usedEndpoints: this.usedEndpoints.size,
            remainingEndpoints: remainingEndpoints.length,
            totalEndpoints: this.endpoints.length
        });

        // 如果没有可用节点了，重置状态
        if (remainingEndpoints.length === 0) {
            logger.warn('所有节点都已尝试过，重置节点池');
            this.usedEndpoints.clear();
            this.availableEndpoints = [...this.endpoints];
            return this.availableEndpoints[0];
        }

        // 选择一个新节点
        const newEndpoint = remainingEndpoints[0];
        this.currentEndpoint = newEndpoint;

        logger.info('切换到新节点:', {
            from: Array.from(this.usedEndpoints).map(e => e.replace(/api-key=([^&]+)/, 'api-key=***')),
            to: newEndpoint.replace(/api-key=([^&]+)/, 'api-key=***'),
            remainingCount: remainingEndpoints.length - 1
        });

        return newEndpoint;
    }

    async retryWithFallback(operation, methodName) {
        const maxAttempts = this.endpoints.length;
        let attempts = 0;
        let lastError = null;

        while (attempts < maxAttempts) {
            try {
                return await operation();
            } catch (error) {
                attempts++;
                lastError = handleError(error);  // 转换错误

                // 如果是余额不足，直接返回错误，不需要重试
                if (lastError.code === ErrorCodes.TRANSACTION.INSUFFICIENT_FUNDS) {
                    throw lastError;
                }

                logger.error(`RPC 调用失败 [${methodName}]:`, {
                    error: lastError.toJSON(),
                    attempt: attempts,
                    maxAttempts
                });

                if (attempts === maxAttempts) {
                    // 如果最后一次错误是余额不足，返回该错误
                    if (lastError.code === ErrorCodes.TRANSACTION.INSUFFICIENT_FUNDS) {
                        throw lastError;
                    }
                    // 否则返回所有节点失败错误
                    throw new SolanaServiceError(ErrorCodes.NETWORK.ALL_NODES_FAILED, {
                        attempts,
                        lastError: lastError.toJSON()
                    });
                }

                this.getNextEndpoint();
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }


    async getBalanceUpdate(publicKey) {
        try {
            const pubKey = typeof publicKey === 'string'
                ? new PublicKey(publicKey)
                : publicKey;

            // 从链上获取余额 (lamports)
            const balanceInLamports = await this.connection.getBalance(pubKey);
            // 转换为 SOL
            const balanceInSOL = balanceInLamports / LAMPORTS_PER_SOL;

            logger.info('获取链上余额:', {
                publicKey: pubKey.toString(),
                lamports: balanceInLamports,
                sol: balanceInSOL
            });

            // 缓存 SOL 值
            if (this.redis) {
                await this.redis.set(
                    CACHE_KEYS.BALANCE_SOL(pubKey.toString()),
                    balanceInSOL.toString(),  // 存储 SOL 值
                    {EX: 60}
                );
            }

            return balanceInSOL;
        } catch (error) {
            logger.error('获取余额失败:', {
                error: error.message,
                publicKey: publicKey?.toString?.() || publicKey
            });
            throw error;
        }
    }

    async getBalance(publicKey) {
        try {
            const pubKey = typeof publicKey === 'string'
                ? new PublicKey(publicKey)
                : publicKey;

            // 从链上获取余额 (lamports)
            const balanceInLamports = await this.connection.getBalance(pubKey);
            // 转换为 SOL
            const balanceInSOL = balanceInLamports / LAMPORTS_PER_SOL;

            logger.info('获取链上余额:', {
                publicKey: pubKey.toString(),
                lamports: balanceInLamports,
                sol: balanceInSOL
            });

            // 缓存 SOL 值
            if (this.redis) {
                await this.redis.set(
                    CACHE_KEYS.BALANCE_SOL(pubKey.toString()),
                    balanceInSOL.toString(),  // 存储 SOL 值
                    {EX: 60}
                );
            }

            return balanceInSOL;
        } catch (error) {
            logger.error('获取余额失败:', {
                error: error.message,
                publicKey: publicKey?.toString?.() || publicKey
            });
            throw error;
        }
    }

    async findAssociatedTokenAddress(owner, mint) {
        try {
            // 确保参数是 PublicKey 类型
            const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;
            const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;

            // 获取关联代币账户地址
            const associatedTokenAddress = await getAssociatedTokenAddress(
                mintPubkey,
                ownerPubkey,
                false,
                TOKEN_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
            );

            logger.debug('找到关联代币账户地址:', {
                owner: ownerPubkey.toBase58(),
                mint: mintPubkey.toBase58(),
                associatedAddress: associatedTokenAddress.toBase58()
            });

            return associatedTokenAddress;
        } catch (error) {
            logger.error('查找关联代币账户地址失败', {
                error: error.message,
                owner: typeof owner === 'string' ? owner : owner?.publicKey?.toBase58() || 'invalid owner',
                mint: typeof mint === 'string' ? mint : mint?.toBase58() || 'invalid mint'
            });
            throw error;
        }
    }

    // 修改 getTokenBalance 方法
    async getTokenBalance(owner, mint) {
        try {
            // 1. 确保参数是 PublicKey 类型
            const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) :
                owner instanceof PublicKey ? owner :
                    owner?.publicKey || null;

            const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;

            if (!ownerPubkey || !mintPubkey) {
                throw new Error('Invalid owner or mint address');
            }

            // 2. 获取代币账户地址
            const tokenAccount = await getAssociatedTokenAddress(
                mintPubkey,
                ownerPubkey,
                false,
                TOKEN_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
            );

            // 3. 获取代币账户余额
            try {
                const balance = await this.connection.getTokenAccountBalance(tokenAccount);
                return balance.value.amount;
            } catch (error) {
                if (error.message.includes('could not find account')) {
                    return '0';
                }
                throw error;
            }
        } catch (error) {
            logger.error('获取代币余额失败:', {
                error: error.message,
                owner: typeof owner === 'string' ? owner : owner?.publicKey?.toString() || 'invalid owner',
                mint: typeof mint === 'string' ? mint : mint?.toString() || 'invalid mint'
            });
            throw error;
        }
    }

    async createToken(groupType, accountNumber, metadata, initialBuyAmount, options = {}) {
        try {
            logger.info('开始创建代币:', {
                groupType,
                accountNumber,
                metadata: {
                    name: metadata.name,
                    symbol: metadata.symbol
                },
                initialBuyAmount: `${initialBuyAmount} SOL`
            });

            // 1. 获取钱包
            const wallet = await this.walletService.getWalletKeypair(groupType, accountNumber);
            if (!wallet) {
                throw new Error(`Wallet not found: ${groupType}-${accountNumber}`);
            }

            // 2. 创建 Keypair
            const creator = Keypair.fromSecretKey(
                Buffer.from(wallet.privateKey, 'base64')
            );

            // 3. 生成新的 mint Keypair
            const mint = Keypair.generate();
            logger.debug('Mint keypair:', {
                publicKey: mint.publicKey.toString(),
                hasSecretKey: !!mint.secretKey
            });

            // 4. 检查余额是否足够（包括手续费）
            const requiredAmount = initialBuyAmount + 0.01; // 买入金额 + 预估手续费
            const currentBalance = await this.getBalance(wallet.publicKey);
            if (currentBalance < requiredAmount) {
                throw new Error(`Insufficient balance. Have ${currentBalance} SOL, need ${requiredAmount} SOL`);
            }

            // 5. 创建代币
            const result = await this.sdk.createToken(
                creator,
                null, // mint 参数设为 null，让 SDK 生成新的 mint
                metadata,
                {
                    ...options,
                    initialBuyAmount: BigInt(Math.floor(initialBuyAmount * LAMPORTS_PER_SOL))
                }
            );

            logger.info('代币创建成功:', {
                mint: result.mint.toString(),
                initialBuyAmount: `${initialBuyAmount} SOL`,
                signature: result.signature,
                groupType,
                accountNumber
            });

            return {
                ...result,
                groupType,
                accountNumber
            };
        } catch (error) {
            logger.error('创建代币失败:', {
                error: error.message,
                groupType,
                accountNumber,
                metadata
            });
            throw error;
        }
    }

    async buyTokens({groupType, accountNumber, tokenAddress, amountSol, slippage, usePriorityFee, options}) {
        try {
            // 1. Get wallet
            const wallet = await this.walletService.getWalletKeypair(groupType, accountNumber);
            if (!wallet) {
                throw new Error(`Wallet not found: ${groupType}-${accountNumber}`);
            }

            // 2. Convert parameters
            const buyAmountSol = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));
            const slippageBasisPoints = BigInt(Math.floor(slippage * 100));

            logger.info('开始购买代币:', {
                wallet: wallet.publicKey.toString(),
                tokenAddress,
                amountSol,
                slippage,
            });

            // 3. Execute buy transaction using SDK
            const result = await this.sdk.buy(
                wallet,
                new PublicKey(tokenAddress),
                buyAmountSol,
                slippageBasisPoints,
                usePriorityFee,
                {
                    usePriorityFee: options.usePriorityFee,
                    priorityType: options.priorityType,
                    priorityFeeSol: options.priorityFeeSol,
                    tipAmountSol: options.tipAmountSol,
                    timeout: options.timeout,
                    retryCount: options.retryCount
                }
            );

            // 4. Start database transaction
            const dbTransaction = await db.sequelize.transaction();

            try {
                // 5. Save transaction to database
                const txRecord = await db.models.Transaction.create({
                    signature: result.signature,
                    mint: tokenAddress,
                    owner: wallet.publicKey.toString(),
                    type: 'buy',
                    amount: amountSol.toString(),
                    tokenAmount: result.tokenAmount?.toString(),
                    status: 'success',
                    groupType,
                    accountNumber,
                    raw: {
                        ...result,
                        timestamp: new Date().toISOString()
                    }
                }, {transaction: dbTransaction});

                // 6. Update account balances with transaction
                await this.updateAccountBalances(
                    wallet,
                    new PublicKey(tokenAddress),
                    result.tokenAmount,
                    amountSol,
                    {transaction: dbTransaction}
                );

                // 7. Setup token tracking and WebSocket subscription
                const subscriptionId = await this.subscribeToTokenBalance(
                    wallet.publicKey,
                    tokenAddress
                );

                // 8. Setup token tracking
                await this.setupTokenTracking(
                    wallet.publicKey.toString(),
                    tokenAddress,
                    result.tokenAmount || '0'
                );

                // Commit transaction
                await dbTransaction.commit();

                logger.info('代币购买成功:', {
                    signature: result.signature,
                    tokenAddress,
                    amountSol,
                    wallet: wallet.publicKey.toString(),
                    subscriptionId
                });

                return {
                    ...result,
                    subscriptionId,
                    transactionId: txRecord.id
                };

            } catch (error) {
                // Rollback transaction on error
                await dbTransaction.rollback();
                throw error;
            }

        } catch (error) {
            logger.error('购买代币失败:', {
                error: error.message,
                groupType,
                accountNumber,
                tokenAddress,
                amountSol
            });
            throw error;
        }
    }

    // In SolanaService class
    async sellTokens(groupType, accountNumber, tokenAddress, percentage, options = {}) {
        let keypair;
        let dbTransaction = null;

        try {
            // 1. 清理代币地址
            const cleanTokenAddress = tokenAddress.trim();
            logger.info('开始卖出代币:', {
                groupType,
                accountNumber,
                tokenAddress: cleanTokenAddress,
                percentage,
                options
            });

            // 2. 获取钱包
            keypair = await this.walletService.getWalletKeypair(groupType, accountNumber);
            if (!keypair) {
                throw new Error('Wallet not found');
            }

            // 3. 获取代币信息和余额(复用 getTokenInfo 和 getTokenBalance)
            const [tokenInfo, tokenBalance] = await Promise.all([
                this.getTokenInfo(cleanTokenAddress),
                this.getTokenBalance(keypair.publicKey, cleanTokenAddress)
            ]);

            // 4. 计算卖出数量(使用 BN 进行安全计算)
            const rawBalanceBN = new BN(tokenBalance.toString());
            const precisionBN = new BN(1_000_000);
            const percentageBN = new BN(Math.round((percentage / 100) * 1_000_000));
            const sellAmount = rawBalanceBN.mul(percentageBN).div(precisionBN);

            // 5. 验证卖出数量
            if (sellAmount.lte(new BN(0))) {
                throw new Error('Invalid sell amount (zero or negative)');
            }
            if (sellAmount.gt(rawBalanceBN)) {
                throw new Error(`Insufficient balance. Have: ${rawBalanceBN.toString()}, Need: ${sellAmount.toString()}`);
            }

            // 6. 开始数据库事务
            dbTransaction = await db.sequelize.transaction();

            try {
                // 7. 设置 SDK 参数
                const slippageBasisPoints = options.slippage ?
                    BigInt(Math.round(options.slippage * 100)) : 100n;
                const priorityFees = options.usePriorityFee ? {
                    microLamports: Math.floor(options.priorityFeeSol * 1e6)
                } : undefined;

                // 8. 执行卖出交易(使用 SDK 的 sell 方法)
                const result = await this.sdk.sell(
                    keypair,
                    new PublicKey(cleanTokenAddress),
                    sellAmount,
                    slippageBasisPoints,
                    priorityFees,
                    options
                );

                // 9. 获取新的余额(复用 getTokenBalance)
                const newTokenBalance = await this.getTokenBalance(
                    keypair.publicKey,
                    cleanTokenAddress
                );

                // 10. 记录交易到数据库
                const txRecord = await db.models.Transaction.create({
                    signature: result.signature,
                    mint: cleanTokenAddress,
                    owner: keypair.publicKey.toString(),
                    type: 'sell',
                    amount: sellAmount.toString(),
                    tokenAmount: sellAmount.toString(),
                    status: 'success',
                    groupType,
                    accountNumber,
                    raw: {
                        ...result,
                        requestedPercentage: percentage,
                        timestamp: new Date().toISOString()
                    }
                }, {transaction: dbTransaction});

                // 11. 更新余额(复用 updateAccountBalances)
                await this.updateAccountBalances(
                    keypair,
                    new PublicKey(cleanTokenAddress),
                    newTokenBalance,
                    result.solAmount,
                    {transaction: dbTransaction}
                );

                // 12. 更新代币跟踪(复用 setupTokenTracking)
                await this.setupTokenTracking(
                    keypair.publicKey.toString(),
                    cleanTokenAddress,
                    newTokenBalance
                );

                // 13. 提交事务
                await dbTransaction.commit();

                return {
                    success: true,
                    signature: result.signature,
                    txId: result.txId,
                    transactionId: txRecord.id,
                    requestedPercentage: percentage,
                    actualPercentage: (Number(percentageBN.toString()) * 100) / 1_000_000,
                    amount: sellAmount.toString(),
                    newBalance: newTokenBalance.toString(),
                    owner: keypair.publicKey.toString(),
                    mint: cleanTokenAddress,
                    timestamp: new Date().toISOString()
                };

            } catch (error) {
                // 回滚数据库事务
                if (dbTransaction) await dbTransaction.rollback();
                throw error;
            }

        } catch (error) {
            logger.error('卖出代币失败:', {
                error: error.message,
                tokenAddress,
                percentage,
                stack: error.stack,
                options
            });
            throw error;
        }
    }

    _parseTokenBalance(balance) {
        try {
            if (typeof balance === 'string' || typeof balance === 'number') {
                return BigInt(balance.toString());
            }
            if (balance?.value?.amount) {
                return BigInt(balance.value.amount);
            }
            if (BN.isBN(balance)) {
                return BigInt(balance.toString());
            }
            throw new Error(`Invalid token balance format: ${typeof balance}`);
        } catch (error) {
            logger.error('解析代币余额失败:', {
                balance: balance?.toString?.() || balance,
                type: typeof balance
            });
            throw new Error(`Failed to parse token balance: ${error.message}`);
        }
    }

    async getBondingCurve(mintAddress) {
        try {
            return await this.sdk.getBondingCurveAccount(new PublicKey(mintAddress));
        } catch (error) {
            logger.error(`获取绑定曲线失败: ${error.message}`);
            throw error;
        }
    }

    async getGlobalState() {
        try {
            return await this.sdk.getGlobalState();
        } catch (error) {
            logger.error(`获取全局状态失败: ${error.message}`);
            throw error;
        }
    }

    async waitForTransaction(signature) {
        try {
            await this.connection.confirmTransaction(signature);
            return await this.connection.getTransaction(signature);
        } catch (error) {
            logger.error(`等待交易确认失败: ${error.message}`);
            throw error;
        }
    }

    async initDefaultImage() {
        try {
            const defaultImagePath = path.join(process.cwd(), 'assets', 'default-token.png');
            const pinataResult = await this.pinataService.uploadImage(defaultImagePath);
            if (pinataResult.success) {
                this.defaultImageUrl = pinataResult.imageUrl;
                logger.info('默认图片上传成功', {url: this.defaultImageUrl});
            }
        } catch (error) {
            logger.warn('默认图片初始化失败，使用备用URL', error);
        }
    }

    async testRpcEndpoints() {
        logger.info('开始测试 RPC 节点...');

        const results = await Promise.all(
            this.endpoints.map(async (endpoint) => {
                const startTime = Date.now();
                try {
                    const connection = new Connection(endpoint);

                    // 并行执行多个测试
                    const [
                        {blockhash},
                        version,
                        blockHeight,
                        slot
                    ] = await Promise.all([
                        connection.getLatestBlockhash('processed'),
                        connection.getVersion(),
                        connection.getBlockHeight(),
                        connection.getSlot()
                    ]);

                    const latency = Date.now() - startTime;

                    return {
                        endpoint,
                        latency,
                        status: 'success',
                        blockhash,
                        version: version['solana-core'],
                        blockHeight,
                        slot,
                        timestamp: new Date().toISOString()
                    };
                } catch (error) {
                    logger.error('RPC 节点测试失败', {
                        endpoint,
                        error: error.message
                    });

                    return {
                        endpoint,
                        latency: Infinity,
                        status: 'error',
                        error: error.message,
                        timestamp: new Date().toISOString()
                    };
                }
            })
        );

        // 按延迟排序
        results.sort((a, b) => a.latency - b.latency);

        // 记录详细的测试结果
        logger.info('RPC 节点测试结果:', {
            totalNodes: results.length,
            availableNodes: results.filter(r => r.status === 'success').length,
            bestNode: {
                endpoint: results[0].endpoint,
                latency: `${results[0].latency}ms`,
                blockHeight: results[0].blockHeight,
                version: results[0].version
            },
            allResults: results.map(r => ({
                endpoint: r.endpoint,
                status: r.status,
                latency: r.status === 'success' ? `${r.latency}ms` : 'N/A',
                error: r.error
            }))
        });

        return results;
    }

    async findMetadataAddress(mint) {
        try {
            logger.info('开始查找 Metadata 地址', {
                mint: mint.toBase58(),
                metadataProgramId: TOKEN_METADATA_PROGRAM_ID.toBase58()
            });

            if (!mint) {
                throw new Error('Mint address is required');
            }

            if (!(mint instanceof PublicKey)) {
                throw new Error('Mint must be a PublicKey instance');
            }

            const seeds = [
                Buffer.from('metadata'),
                TOKEN_METADATA_PROGRAM_ID.toBuffer(),
                mint.toBuffer()
            ];

            logger.debug('查找 PDA 的种子', {
                seeds: seeds.map(seed =>
                    Buffer.isBuffer(seed) ? seed.toString('hex') : seed
                )
            });

            const [address] = await PublicKey.findProgramAddress(
                seeds,
                TOKEN_METADATA_PROGRAM_ID
            );

            logger.info('找到 Metadata 地址', {
                metadataAddress: address.toBase58(),
                mint: mint.toBase58(),
                programId: TOKEN_METADATA_PROGRAM_ID.toBase58()
            });

            return address;
        } catch (error) {
            logger.error('查找 Metadata 地址失败', {
                error,
                mint: mint?.toBase58(),
                metadataProgramId: TOKEN_METADATA_PROGRAM_ID?.toBase58()
            });
            throw error;
        }
    }

    async findBondingCurveAddress(mint) {
        try {
            logger.info('开始查找绑定曲线地址', {
                mint: mint.toBase58(),
                programId: this.sdk.program.programId.toBase58()
            });

            const [address] = await PublicKey.findProgramAddress(
                [
                    Buffer.from('bonding-curve'),
                    mint.toBuffer()
                ],
                this.sdk.program.programId
            );

            logger.info('找到绑定曲线地址', {
                bondingCurveAddress: address.toBase58(),
                mint: mint.toBase58()
            });

            return address;
        } catch (error) {
            logger.error('查找绑定曲线地址失败', {
                error,
                mint: mint?.toBase58(),
                programId: this.sdk.program.programId?.toBase58()
            });
            throw error;
        }
    }

    // 修改 switchRpcEndpoint 方法
    async switchRpcEndpoint() {
        try {
            // 重新测试所有节点
            const results = await this.testRpcEndpoints();
            const availableRpcs = results
                .filter(r => r.status === 'success')
                .sort((a, b) => a.latency - b.latency);

            if (availableRpcs.length === 0) {
                throw new Error('没有可用的 RPC 节点');
            }

            // 选择当前节点之外延迟最低的节点
            const nextRpc = availableRpcs.find(r => r.endpoint !== this.currentEndpoint) || availableRpcs[0];

            await this.createConnection(nextRpc.endpoint);
            this.currentEndpoint = nextRpc.endpoint;

            logger.info('切换到新的 RPC 节点', {
                endpoint: nextRpc.endpoint.replace(/api-key=([^&]+)/, 'api-key=***'),
                latency: `${nextRpc.latency}ms`,
                reason: 'performance'
            });

            return nextRpc.endpoint;
        } catch (error) {
            logger.error('切换 RPC 节点失败:', {
                error: error.message,
                currentEndpoint: this.currentEndpoint?.replace(/api-key=([^&]+)/, 'api-key=***')
            });
            throw error;
        }
    }

    // 修改 withRetry 方法
    async withRetry(operation, maxRetries = 3) {
        let lastError = null;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;

                // 检查是否是余额不足错误
                if (error.message.includes('Insufficient balance')) {
                    throw error; // 直接抛出，不需要重试
                }

                logger.warn(`操作失败，尝试重试 (${attempt + 1}/${maxRetries}):`, {
                    error: error.message,
                    attempt: attempt + 1
                });

                if (attempt < maxRetries - 1) {
                    try {
                        // 切换节点
                        await this.switchRpcEndpoint();
                        // 指数退避等待
                        await new Promise(resolve =>
                            setTimeout(resolve, Math.pow(2, attempt) * 1000)
                        );
                    } catch (switchError) {
                        logger.error('切换节点失败:', {
                            error: switchError.message,
                            attempt: attempt + 1
                        });
                        // 继续使用当前节点
                    }
                }
            }
        }
        throw lastError;
    }

    // 添加 RPC 性能测试方法
    async testCurrentRpcPerformance() {
        const endpoint = this.connection.rpcEndpoint;
        const startTime = Date.now();

        try {
            // 执行一系列测试
            const [blockhash, version, blockHeight] = await Promise.all([
                this.connection.getLatestBlockhash('processed'),
                this.connection.getVersion(),
                this.connection.getBlockHeight()
            ]);

            const latency = Date.now() - startTime;

            logger.info('当前 RPC 节点性能', {
                endpoint,
                latency: `${latency}ms`,
                blockHeight,
                version: version['solana-core'],
                blockhash: blockhash.blockhash
            });

            return {
                endpoint,
                latency,
                status: 'success',
                blockHeight,
                version: version['solana-core']
            };
        } catch (error) {
            logger.error('RPC 节点测试失败', {
                endpoint,
                error: error.message,
                duration: `${Date.now() - startTime}ms`
            });

            return {
                endpoint,
                latency: Infinity,
                status: 'error',
                error: error.message
            };
        }
    }

    // 取消单个订阅
    async unsubscribeFromBalance(publicKey) {
        try {
            const subscription = this.subscriptions.get(publicKey);
            if (subscription) {
                await this.connection.removeAccountChangeListener(subscription.id);
                this.subscriptions.delete(publicKey);
                logger.info('取消余额订阅', {publicKey});
            }
        } catch (error) {
            logger.error('取消余额订阅失败:', error);
        }
    }

    // 取消所有订阅
    async unsubscribeAllBalances() {
        try {
            const promises = Array.from(this.subscriptions.entries()).map(
                async ([publicKey, subscription]) => {
                    try {
                        if (this.connection) {
                            await this.connection.removeAccountChangeListener(subscription.id);
                        }
                        this.subscriptions.delete(publicKey);
                    } catch (error) {
                        logger.warn(`取消订阅失败: ${publicKey}`, error);
                    }
                }
            );
            await Promise.all(promises);
            this.subscriptions.clear();
            logger.info('所有订阅已清理');
        } catch (error) {
            logger.error('清理订阅失败:', error);
        }
    }

    // 获取当前所有订阅
    getActiveSubscriptions() {
        return Array.from(this.subscriptions.entries()).map(([publicKey, sub]) => ({
            publicKey,
            groupType: sub.wallet.groupType,
            accountNumber: sub.wallet.accountNumber,
            subscriptionId: sub.id
        }));
    }

    async subscribeToBalance(wallet) {
        try {
            if (!this.connection) {
                await this.createConnection();
            }

            // 如果已经订阅，先取消旧的订阅
            if (this.subscriptions.has(wallet.publicKey)) {
                await this.unsubscribeFromBalance(wallet.publicKey);
            }

            const publicKey = new PublicKey(wallet.publicKey);

            // 先获取初始余额
            const balance = await this.getBalance(publicKey);
            wallet.lastKnownBalance = balance;

            const subscriptionId = this.connection.onAccountChange(
                publicKey,
                async (accountInfo) => {
                    try {
                        const newBalance = accountInfo.lamports / LAMPORTS_PER_SOL;
                        wallet.lastKnownBalance = newBalance;

                        // 更新 Redis 缓存
                        if (this.redis) {
                            await this.redis.setBalance(wallet.publicKey, newBalance);
                        }
                    } catch (error) {
                        logger.error('处理余额变动失败:', error);
                    }
                },
                'confirmed'
            );

            this.subscriptions.set(wallet.publicKey, {
                id: subscriptionId,
                wallet
            });

            logger.info('订阅余额变动成功:', {
                publicKey: wallet.publicKey,
                subscriptionId
            });

            return subscriptionId;
        } catch (error) {
            logger.error('订阅余额变动失败:', error);

            if (this.retryCount < this.maxRetries) {
                this.retryCount++;
                logger.info(`切换节点重试(${this.retryCount}/${this.maxRetries})`);
                await this.createConnection();
                return this.subscribeToBalance(wallet);
            }

            throw error;
        }
    }

    // 转账方法
    async transfer(fromWallet, toAddress, amountSol, options = {}) {
        try {
            const amount = Array.isArray(amountSol) ? amountSol[0] : amountSol;

            const amountInLamports = Math.floor(amount * LAMPORTS_PER_SOL);
            const estimatedFee = 5000; // 预估交易费用 (lamports)
            const totalRequired = amountInLamports + estimatedFee;

            // 检查余额
            const balanceCheck = await this.checkBalance(fromWallet.publicKey,
                amount + (estimatedFee / LAMPORTS_PER_SOL));

            if (!balanceCheck.hasEnoughBalance) {
                throw new Error(`Insufficient balance. Need ${(Math.abs(balanceCheck.difference) / LAMPORTS_PER_SOL).toFixed(9)} more SOL`);
            }

            // 创建转账交易
            const transaction = new SolanaTransaction();

            // 获取最新的 blockhash
            const {blockhash, lastValidBlockHeight} = await this.connection.getLatestBlockhash();

            // 添加转账指令
            transaction.add(
                SystemProgram.transfer({
                    fromPubkey: fromWallet.publicKey,
                    toPubkey: new PublicKey(toAddress),
                    lamports: amountInLamports
                })
            );

            // 设置交易参数
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = fromWallet.publicKey;

            // 签名交易
            transaction.sign(fromWallet);

            // 发送交易
            const signature = await this.connection.sendRawTransaction(
                transaction.serialize(),
                {
                    skipPreflight: false,
                    preflightCommitment: 'confirmed',
                    ...options
                }
            );

            // 等待交易确认
            const confirmation = await this.connection.confirmTransaction({
                signature,
                blockhash,
                lastValidBlockHeight
            });

            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${confirmation.value.err}`);
            }

            // 获取新余额并更新缓存
            const newBalance = await this.connection.getBalance(fromWallet.publicKey);
            await this.updateBalanceCache(fromWallet.publicKey);

            logger.info('转账成功:', {
                from: fromWallet.publicKey.toString(),
                to: toAddress,
                amount: {
                    sol: amountSol,
                    lamports: amountInLamports
                },
                signature,
                confirmation: {
                    blockhash,
                    lastValidBlockHeight
                },
                balance: {
                    before: balanceCheck.balanceInLamports,
                    after: newBalance,
                    difference: newBalance - balanceCheck.balanceInLamports
                }
            });

            return {
                signature,
                blockhash,
                lastValidBlockHeight,
                balanceBefore: balanceCheck.balanceInSOL,
                balanceAfter: newBalance / LAMPORTS_PER_SOL
            };
        } catch (error) {
            logger.error('转账失败:', {
                error: error.message,
                from: fromWallet.publicKey.toString(),
                to: toAddress,
                amount: amountSol,
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    // 检查余额
    async checkBalance(publicKey, requiredSol) {
        try {
            // 获取余额（SOL 单位）
            const balanceInSOL = await this.getBalance(publicKey);

            // 转换为 lamports 进行比较
            const balanceInLamports = Math.floor(balanceInSOL * LAMPORTS_PER_SOL);
            const requiredLamports = Math.floor(requiredSol * LAMPORTS_PER_SOL);

            const hasEnoughBalance = balanceInLamports >= requiredLamports;
            const difference = balanceInLamports - requiredLamports;

            logger.info('钱包余额详情:', {
                publicKey: publicKey.toString(),
                balance: {
                    sol: balanceInSOL,
                    lamports: balanceInLamports
                },
                required: {
                    sol: requiredSol,
                    lamports: requiredLamports
                },
                hasEnoughBalance,
                difference: {
                    sol: difference / LAMPORTS_PER_SOL,
                    lamports: difference
                }
            });

            return {
                hasEnoughBalance,
                balanceInSOL,
                balanceInLamports,
                requiredLamports,
                difference
            };
        } catch (error) {
            logger.error('检查余额失败:', {
                error: error.message,
                publicKey: publicKey.toString(),
                requiredSol
            });
            throw error;
        }
    }

    // 更新余额缓存
    async updateBalanceCache(publicKey) {
        try {
            // 从链上获取余额 (lamports)
            const balanceInLamports = await this.connection.getBalance(
                new PublicKey(publicKey)
            );
            // 转换为 SOL
            const balanceInSOL = balanceInLamports / LAMPORTS_PER_SOL;

            if (this.redis) {
                await this.redis.set(
                    CACHE_KEYS.BALANCE_SOL(publicKey.toString()),
                    balanceInSOL.toString(),  // 存储 SOL 值
                    {EX: 60}
                );

                logger.debug('余额缓存已更新:', {
                    publicKey: publicKey.toString(),
                    balanceInSOL,
                    balanceInLamports
                });
            }

            return balanceInSOL;
        } catch (error) {
            logger.error('更新余额缓存失败:', error);
            throw error;
        }
    }

    // 关闭账户方法
    async closeAccount(fromKeypair, toPublicKey) {
        try {
            // 获取当前余额
            const currentBalance = await this.connection.getBalance(fromKeypair.publicKey);

            // 保留 5000 lamports 作为手续费
            const FEE = 5000;
            const transferAmount = currentBalance - FEE;

            if (transferAmount <= 0) {
                throw new Error(`Insufficient balance for transfer. Have ${currentBalance} lamports, need more than ${FEE} lamports`);
            }

            // 创建关闭账户的交易
            const transaction = new SolanaTransaction().add(
                SystemProgram.transfer({
                    fromPubkey: fromKeypair.publicKey,
                    toPubkey: new PublicKey(toPublicKey),
                    lamports: transferAmount  // 转移余额减去手续费
                })
            );

            // 获取最新的 blockhash
            const {blockhash} = await this.connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = fromKeypair.publicKey;

            // 签名并发送交易
            transaction.sign(fromKeypair);
            const signature = await this.connection.sendRawTransaction(
                transaction.serialize(),
                {
                    skipPreflight: false,
                    preflightCommitment: 'confirmed'
                }
            );

            // 等待交易确认
            await this.connection.confirmTransaction(signature);

            logger.info('账户关闭成功:', {
                fromPublicKey: fromKeypair.publicKey.toString(),
                toPublicKey,
                signature,
                transferAmount,
                fee: FEE
            });

            return signature;
        } catch (error) {
            logger.error('关闭账户失败:', {
                error: error.message,
                fromPublicKey: fromKeypair.publicKey.toString(),
                toPublicKey,
                logs: error.logs || []
            });
            throw error;
        }
    }

    async uploadToIPFS(fileObject) {
        // 1. 验证文件对象
        if (!fileObject || !fileObject.content || !fileObject.name || !fileObject.type) {
            throw new Error('Invalid file object: missing required properties');
        }

        try {
            // 2. 准备上传数据
            const pinataOptions = {
                pinataMetadata: {
                    name: fileObject.name,
                    keyvalues: {
                        type: fileObject.type,
                        size: fileObject.size,
                        uploadTime: new Date().toISOString()
                    }
                }
            };

            // 3. 调用 Pinata API
            const formData = new FormData();
            formData.append('file', fileObject.content, {
                filename: fileObject.name,
                contentType: fileObject.type
            });
            formData.append('pinataOptions', JSON.stringify(pinataOptions));

            const response = await this.pinataService.pinFileToIPFS(formData);

            // 4. 验证响应
            if (!response || !response.IpfsHash) {
                throw new Error('Failed to get IPFS hash from upload service');
            }

            return {
                IpfsHash: response.IpfsHash,
                PinSize: response.PinSize,
                Timestamp: response.Timestamp
            };

        } catch (error) {
            logger.error('上传到 IPFS 失败:', {
                error: error.message,
                pinataService: true,
                filename: fileObject.name
            });
            throw error;
        }
    }

    // 修改模拟方法以支持不同类型的交易
    async simulateTransaction(transaction, signers = []) {
        try {
            logger.simulation('开始模拟交易...', {
                endpoint: this.currentEndpoint.replace(/api-key=([^&]+)/, 'api-key=***')
            });

            const startTime = Date.now();
            const simulation = await this.connection.simulateTransaction(transaction);
            const duration = Date.now() - startTime;

            if (simulation.value.err) {
                throw new SolanaServiceError(ErrorCodes.TRANSACTION.SIMULATION_FAILED, {
                    error: simulation.value.err,
                    logs: simulation.value.logs,
                    duration: `${duration}ms`
                });
            }

            // 记录模拟结果
            logger.simulation('交易模拟成功', {
                computeUnits: simulation.value.unitsConsumed || 0,
                estimatedFee: `${simulation.value.fee / LAMPORTS_PER_SOL} SOL`,
                duration: `${duration}ms`,
                logs: simulation.value.logs,
                accounts: simulation.value.accounts?.map(acc => acc?.pubkey.toString())
            });

            return {
                success: true,
                computeUnits: simulation.value.unitsConsumed || 0,
                logs: simulation.value.logs || [],
                accounts: simulation.value.accounts || [],
                estimatedFee: simulation.value.fee || 0,
                duration
            };
        } catch (error) {
            const serviceError = error instanceof SolanaServiceError
                ? error
                : handleError(error, ErrorCodes.TRANSACTION.SIMULATION_FAILED);

            logger.error('交易模拟失败:', {
                error: {
                    code: serviceError.code,
                    message: serviceError.message,
                    details: serviceError.details
                }
            });

            throw serviceError;
        }
    }

    async updateAccountBalances(wallet, mint, tokenAmount, solAmount) {
        try {
            logger.info('开始更新账户余额:', {
                wallet: wallet.publicKey.toString(),
                mint: mint?.toString(),
                tokenAmount: tokenAmount?.toString(),
                solAmount: solAmount?.toString()
            });

            // 1. 更新 Redis 缓存
            if (this.redis) {
                // 更新代币余额缓存
                if (mint && tokenAmount !== undefined) {
                    const tokenBalanceKey = `token:balance:${wallet.publicKey.toString()}:${mint}`;
                    const tokenBalanceData = {
                        amount: tokenAmount.toString(),
                        lastUpdate: Date.now()
                    };
                    await this.redis.set(
                        tokenBalanceKey,
                        JSON.stringify(tokenBalanceData),
                        'EX',
                        300
                    );
                }

                // 更新 SOL 余额缓存
                if (solAmount !== undefined) {
                    await this.getBalanceUpdate(wallet.publicKey.toString())
                }
                logger.debug('Redis 缓存更新成功');
            }

            // 2. 更新数据库
            if (mint) {
                await db.models.TokenBalance.upsert({
                    owner: wallet.publicKey.toString(),
                    mint: mint.toString(),
                    balance: tokenAmount.toString(),
                    updatedAt: new Date()
                });
            }

            return {
                tokenBalance: tokenAmount?.toString(),
                solBalance: solAmount?.toString(),
                timestamp: Date.now()
            };

        } catch (error) {
            logger.error('更新账户余额失败:', {
                error: error.message,
                wallet: wallet.publicKey.toString(),
                mint: mint?.toString()
            });
        }
    }


    async handleBatchAccounts(batchResults, mint, parentSignature) {
        if (!batchResults?.length) return [];

        const results = [];
        const errors = [];

        for (const batchResult of batchResults) {
            try {
                // Validate batch result
                validateBatchResult(batchResult);

                const batchWallet = await this.walletService.getWalletKeypair(
                    batchResult.groupType,
                    batchResult.accountNumber
                );

                if (!batchWallet) {
                    throw new Error(`Wallet not found: ${batchResult.groupType}-${batchResult.accountNumber}`);
                }

                // Start a database transaction
                const dbTransaction = await db.sequelize.transaction();

                try {
                    // 1. Update balances with transaction
                    await this.updateAccountBalances(
                        batchWallet,
                        new PublicKey(mint),
                        batchResult.tokenAmount,
                        batchResult.solAmount,
                        {transaction: dbTransaction}
                    );

                    // 2. Setup token tracking
                    await this.setupTokenTracking(
                        batchWallet.publicKey.toString(),
                        mint,
                        batchResult.tokenAmount || '0'
                    );

                    // 3. Setup WebSocket subscription
                    const subscriptionId = await this.subscribeToTokenBalance(
                        batchWallet.publicKey,
                        mint
                    );

                    // 4. Record transaction with transaction
                    const txRecord = await db.models.Transaction.create({
                        signature: batchResult.signature,
                        mint: mint,
                        owner: batchWallet.publicKey.toString(),
                        type: 'create_and_buy',
                        amount: batchResult.solAmount.toString(),
                        tokenAmount: batchResult.tokenAmount.toString(),
                        status: 'success',
                        groupType: batchResult.groupType,
                        accountNumber: batchResult.accountNumber,
                        raw: {
                            ...batchResult,
                            parentSignature,
                            subscriptionId,
                            timestamp: new Date().toISOString()
                        }
                    }, {transaction: dbTransaction});

                    // Commit transaction
                    await dbTransaction.commit();

                    results.push({
                        wallet: batchWallet.publicKey.toString(),
                        groupType: batchResult.groupType,
                        accountNumber: batchResult.accountNumber,
                        tokenAmount: batchResult.tokenAmount,
                        solAmount: batchResult.solAmount,
                        subscriptionId,
                        transactionId: txRecord.id
                    });

                } catch (error) {
                    // Rollback transaction on error
                    await dbTransaction.rollback();
                    throw error;
                }

            } catch (error) {
                logger.error('批量账户处理单个记录失败:', {
                    error: error.message,
                    batchResult,
                    mint,
                    stack: error.stack
                });
                errors.push({
                    groupType: batchResult.groupType,
                    accountNumber: batchResult.accountNumber,
                    error: error.message
                });
            }
        }

        // Log summary
        logger.info('批量账户处理完成:', {
            successCount: results.length,
            errorCount: errors.length,
            mint,
            errors: errors.length > 0 ? errors : undefined
        });

        if (results.length === 0 && errors.length > 0) {
            throw new Error(`All batch accounts failed to process: ${errors.map(e => e.error).join(', ')}`);
        }

        return results;
    }

    async subscribeToTokenBalance(publicKey, mint) {
        try {
            if (!this.wsManager) {
                logger.warn('WebSocket 管理器未初始化');
                return null;
            }

            const tokenAccount = await this.findAssociatedTokenAddress(
                publicKey,
                new PublicKey(mint)
            );

            const subscription = await this.wsManager.subscribeToAccount(
                tokenAccount,
                async (accountInfo) => {
                    try {
                        const tokenAccountInfo = AccountLayout.decode(accountInfo.data);
                        const newBalance = tokenAccountInfo.amount;

                        // 更新缓存和数据库
                        await this.updateAccountBalances(
                            {publicKey},
                            new PublicKey(mint),
                            newBalance.toString()
                        );

                        logger.debug('代币余额变动:', {
                            publicKey: publicKey.toString(),
                            mint,
                            newBalance: newBalance.toString()
                        });

                    } catch (error) {
                        logger.error('处理代币余额更新失败:', {
                            error: error.message,
                            publicKey: publicKey.toString(),
                            mint
                        });
                    }
                }
            );

            logger.info('代币余额订阅成功:', {
                publicKey: publicKey.toString(),
                mint,
                subscriptionId: subscription.id
            });

            return subscription.id;
        } catch (error) {
            logger.error('订阅代币余额失败:', {
                error: error.message,
                publicKey: publicKey.toString(),
                mint
            });
            return null;
        }
    }

    async batchUpdateBalances(updates) {
        try {
            const results = await Promise.all(
                updates.map(update =>
                    this.updateAccountBalances(
                        update.wallet,
                        update.mint,
                        update.tokenAmount,
                        update.solAmount
                    )
                )
            );

            logger.info('批量更新余额完成:', {
                count: updates.length,
                success: results.filter(Boolean).length
            });

            return results;
        } catch (error) {
            logger.error('批量更新余额失败:', error);
        }
    }

    async createAndBuy({groupType, accountNumber, metadata, solAmount, options = {}}) {
        let mainSubscriptionId = null;
        let batchResults = [];
        let wallet = null;

        try {
            logger.info('开始创建和购买代币:', {
                groupType,
                accountNumber,
                metadata: {
                    name: metadata.name,
                    symbol: metadata.symbol
                },
                solAmount
            });

            if (options.batchTransactions && options.batchTransactions.length > 4) {
                throw new Error('Maximum 4 batch transactions allowed');
            }

            // 1. 验证输入参数
            if (!solAmount || solAmount <= 0) {
                throw new Error('Invalid SOL amount');
            }

            // 2. 获取钱包
            wallet = await this.walletService.getWalletKeypair(groupType, accountNumber);
            if (!wallet) {
                throw new Error(`Wallet not found: ${groupType}-${accountNumber}`);
            }

            // 3. 获取最佳 RPC 节点
            const bestEndpoint = await this.getBestNode();
            this.connection = new Connection(bestEndpoint, {
                commitment: 'confirmed',
                confirmTransactionInitialTimeout: 60000,
                wsEndpoint: this._getWsEndpoint(bestEndpoint)
            });

            // 4. 检查余额
            const currentBalance = await this.getBalance(wallet.publicKey);
            const requiredBalance = solAmount + 0.01; // 添加一些额外的 SOL 用于手续费
            if (currentBalance < requiredBalance) {
                throw new Error(`Insufficient balance. Required: ${requiredBalance} SOL, Current: ${currentBalance} SOL`);
            }

            // 5. 生成 mint keypair
            const mint = Keypair.generate();
            logger.info('生成 mint keypair:', {
                mint: mint.publicKey.toString()
            });

            // 6. 准备元数据
            const tokenMetadata = {
                name: metadata.name.slice(0, 32), // 限制名称长度
                symbol: metadata.symbol.slice(0, 10), // 限制符号长度
                description: metadata.description?.slice(0, 200),
                image: metadata.image || '',
                external_url: metadata.external_url || '',
                attributes: metadata.attributes || [],
                properties: {
                    creators: [
                        {
                            address: wallet.publicKey.toString(),
                            share: 100
                        }
                    ]
                }
            };

            // 7. 准备批量交易钱包
            let batchWallets = [];
            if (options.batchTransactions?.length > 0) {
                batchWallets = await Promise.all(
                    options.batchTransactions.map(async tx => {
                        const wallet = await this.walletService.getWalletKeypair(
                            tx.groupType,
                            tx.accountNumber
                        );
                        if (!wallet) {
                            throw new Error(`批量交易钱包不存在: ${tx.groupType}-${tx.accountNumber}`);
                        }
                        return {
                            wallet,
                            solAmount: tx.solAmount,
                            groupType: tx.groupType,
                            accountNumber: tx.accountNumber
                        };
                    })
                );
            }

            // 8. 准备 SDK 选项
            const sdkOptions = {
                slippageBasisPoints: options.slippageBasisPoints || 100,
                usePriorityFee: options.usePriorityFee || false,
                priorityFeeSol: options.priorityFeeSol,
                priorityType: options.priorityType || 'Jito',
                tipAmountSol: options.tipAmountSol,
                batchTransactions: batchWallets,

            };

            // 9. 执行创建和购买
            const result = await this.withRetry(async () => {
                return await this.sdk.createAndBuy(
                    wallet,
                    mint,
                    tokenMetadata,
                    solAmount,
                    sdkOptions
                );
            });

            if (!result?.signature || !result?.mint) {
                throw new Error('Invalid response from create and buy operation');
            }

            // 10. 保存代币信息到数据库
            const tokenData = {
                mint: result.mint,
                owner: wallet.publicKey.toString(),
                name: metadata.name,
                symbol: metadata.symbol,
                description: metadata.description || '',
                image: metadata.image || '',
                external_url: metadata.external_url || '',
                creatorPublicKey: wallet.publicKey.toString(),
                groupType,
                accountNumber,
                metadata: tokenMetadata,
                uri: result.metadata?.uri || '',
                status: 'active',
                createdAt: new Date(),
                updatedAt: new Date()
            };

            await db.models.Token.create(tokenData);

            // 11. 记录主交易
            await db.models.Transaction.create({
                signature: result.signature,
                mint: result.mint,
                owner: wallet.publicKey.toString(),
                type: 'create_and_buy',
                amount: solAmount.toString(),
                tokenAmount: result.tokenAmount?.toString(),
                status: 'success',
                raw: {
                    ...result,
                    metadata: tokenMetadata,
                    timestamp: new Date().toISOString()
                }
            });

            // 12. 处理主账户余额和订阅
            await this.updateAccountBalances(
                wallet,
                new PublicKey(result.mint),
                result.tokenAmount,
                solAmount
            );

            mainSubscriptionId = await this.subscribeToTokenBalance(
                wallet.publicKey,
                result.mint
            );

            await this.setupTokenTracking(
                wallet.publicKey.toString(),
                result.mint,
                result.tokenAmount || '0'
            );

            // // 13. 处理批量交易记录和余额
            if (result.batchResults?.length > 0) {
                //     // 记录批量交易到数据库
                //     const batchTransactions = await Promise.all(
                //         result.batchResults.map(batchResult =>
                //             db.models.Transaction.create({
                //                 signature: batchResult.signature,
                //                 mint: result.mint,
                //                 owner: wallet.publicKey.toString(),
                //                 type: 'create_and_buy',
                //                 amount: batchResult.solAmount.toString(),
                //                 tokenAmount: batchResult.tokenAmount.toString(),
                //                 status: 'success',
                //                 groupType: batchResult.groupType,
                //                 accountNumber: batchResult.accountNumber,
                //                 raw: {
                //                     ...batchResult,
                //                     parentSignature: result.signature,
                //                     timestamp: new Date().toISOString()
                //                 }
                //             })
                //         )
                //     );
                //
                //     // 更新批量交易余额
                //     await this.batchUpdateBalances(batchTransactions);

                // 处理批量账户的订阅和追踪
                batchResults = await this.handleBatchAccounts(
                    result.batchResults,
                    result.mint,
                    result.signature
                );
            }

            // 14. 更新 Redis 缓存
            if (this.redis) {
                const tokenInfoKey = `token:${result.mint}`;
                const tokenInfo = {
                    ...tokenData,
                    mainSubscriptionId,
                    batchSubscriptions: batchResults.map(r => ({
                        wallet: r.wallet,
                        subscriptionId: r.subscriptionId
                    })),
                    lastUpdate: Date.now()
                };
                await this.redis.set(tokenInfoKey, JSON.stringify(tokenInfo), 'EX', 3600);
            }

            // 15. 记录完成信息
            logger.info('代币创建和批量购买完成:', {
                mint: result.mint,
                mainSignature: result.signature,
                mainSubscriptionId,
                batchCount: batchResults.length,
                subscribedAccounts: [
                    wallet.publicKey.toString(),
                    ...batchResults.map(r => r.wallet)
                ]
            });

            // 16. 返回结果
            return {
                success: true,
                signature: result.signature,
                mint: result.mint,
                owner: wallet.publicKey.toString(),
                solAmount: solAmount.toString(),
                tokenAmount: result.tokenAmount || '0',
                metadata: {
                    name: metadata.name,
                    symbol: metadata.symbol,
                    uri: result.metadata?.uri || ''
                },
                transaction: {
                    signature: result.signature,
                    timestamp: Date.now(),
                    confirmations: 1
                },
                batchResults: batchResults.map(r => ({
                    signature: r.signature,
                    wallet: r.wallet,
                    groupType: r.groupType,
                    accountNumber: r.accountNumber,
                    tokenAmount: r.tokenAmount,
                    solAmount: r.solAmount
                }))
            };

        } catch (error) {
            logger.error('创建和购买代币失败:', {
                error: error.message,
                stack: error.stack,
                groupType,
                accountNumber,
                metadata: {
                    name: metadata.name,
                    symbol: metadata.symbol
                }
            });

            // 更新交易失败后的余额
            try {
                // 更新主账户余额
                if (wallet) {
                    const currentBalance = await this.getBalance(wallet.publicKey);
                    await this.updateAccountBalances(
                        wallet,
                        null,
                        '0',
                        currentBalance
                    );

                    // 如果有批量交易,也更新他们的余额
                    if (options.batchTransactions?.length > 0) {
                        const batchUpdates = await Promise.all(
                            options.batchTransactions.map(async (tx) => {
                                const batchWallet = await this.walletService.getWalletKeypair(
                                    tx.groupType,
                                    tx.accountNumber
                                );
                                const batchBalance = await this.getBalance(batchWallet.publicKey);
                                return this.updateAccountBalances(
                                    batchWallet,
                                    null,
                                    '0',
                                    batchBalance
                                );
                            })
                        );
                    }
                }
            } catch (balanceError) {
                logger.warn('更新失败后的余额失败:', balanceError);
            }

            // 清理订阅（如果有）
            try {
                if (mainSubscriptionId) {
                    await this.wsManager.unsubscribeFromAccount(mainSubscriptionId);
                }
                // 清理批量交易的订阅
                if (batchResults?.length > 0) {
                    await Promise.all(
                        batchResults.map(r =>
                            r.subscriptionId ?
                                this.wsManager.unsubscribeFromAccount(r.subscriptionId) :
                                Promise.resolve()
                        )
                    );
                }
            } catch (cleanupError) {
                logger.warn('清理订阅失败:', cleanupError);
            }

            // 更新节点统计
            this.updateNodeStats(this.connection.rpcEndpoint, {
                success: false,
                error: error.message
            });

            throw error;
        }
    }

    // 上传元数据到 IPFS
    async uploadMetadataToIPFS(metadata) {
        try {
            logger.info('开始上传元数据到 IPFS:', metadata);

            // 使用 Pinata 服务上传
            const result = await this.pinataService.uploadJSON(metadata);

            if (!result.success) {
                throw new Error('Failed to upload metadata to IPFS');
            }

            logger.info('元数据上传成功:', {
                ipfsHash: result.hash,
                url: result.url
            });

            return {
                IpfsHash: result.hash,
                url: result.url
            };
        } catch (error) {
            logger.error('上传元数据失败:', error);
            throw error;
        }
    }

    // 修改交易确认方法
    async confirmTransaction(signature, commitment = 'confirmed') {
        try {
            // 确保连接存在
            if (!this.connection) {
                await this.createConnection();
            }

            const MAX_RETRIES = 3;
            const RETRY_DELAY = 1000; // 1秒
            const TIMEOUT = 30000; // 30秒超时

            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                try {
                    const startTime = Date.now();

                    // 使用 latestBlockhash 来确认交易
                    const latestBlockhash = await this.connection.getLatestBlockhash();

                    const result = await this.connection.confirmTransaction({
                        signature,
                        blockhash: latestBlockhash.blockhash,
                        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
                    }, commitment);

                    const latency = Date.now() - startTime;

                    logger.info('交易确认成功:', {
                        signature,
                        latency: `${latency}ms`,
                        attempt: attempt + 1
                    });

                    if (result.value.err) {
                        throw new Error(`Transaction failed: ${result.value.err}`);
                    }

                    return result;
                } catch (error) {
                    const isTimeout = error.toString().includes('block height exceeded') ||
                        error.toString().includes('timeout');

                    if (isTimeout && attempt < MAX_RETRIES - 1) {
                        logger.warn(`交易确认超时，尝试重试:`, {
                            signature,
                            attempt: attempt + 1,
                            maxRetries: MAX_RETRIES,
                            error: error.message,
                            nextRetryIn: `${RETRY_DELAY}ms`
                        });

                        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                        continue;
                    }
                    throw error;
                }
            }
        } catch (error) {
            logger.error('确认交易失败:', {
                error: error.message,
                signature,
                commitment
            });
            throw error;
        }
    }

    // 优化健康检查逻辑
    async checkConnectionHealth() {
        const now = Date.now();
        // 如果距离上次检查不到30秒，直接返回
        if (now - this.lastHealthCheck < this.healthCheckInterval) {
            return true;
        }

        try {
            const startTime = Date.now();
            const blockHeight = await this.connection.getBlockHeight();
            const latency = Date.now() - startTime;

            this.lastHealthCheck = now;

            logger.debug('RPC 节点健康检查:', {
                blockHeight,
                latency: `${latency}ms`,
                endpoint: this.currentEndpoint.replace(/api-key=([^&]+)/, 'api-key=***')
            });

            // 如果延迟太高，标记为需要切换节点
            if (latency > 1000) {
                logger.warn('RPC 节点延迟过高', {
                    latency: `${latency}ms`,
                    threshold: '1000ms'
                });
                return false;
            }

            return true;
        } catch (error) {
            logger.error('RPC 节点健康检查失败:', {
                error: error.message,
                endpoint: this.currentEndpoint.replace(/api-key=([^&]+)/, 'api-key=***')
            });
            return false;
        }
    }

    // 解析代币账户数据
    async parseTokenAccountData(data) {
        try {
            const accountInfo = AccountLayout.decode(data);
            return BigInt(accountInfo.amount.toString());
        } catch (error) {
            logger.error('解析代币账户数据失败:', {
                error: error.message
            });
            throw error;
        }
    }

    // 数据库操作方法
    async saveToken(tokenData) {
        try {
            const token = await db.models.Token.create({
                mint: tokenData.mint,
                owner: tokenData.owner,
                name: tokenData.tokenName,
                symbol: tokenData.tokenSymbol,
                metadata: tokenData.metadata,
                uri: tokenData.uri,
                createdAt: new Date(),
                updatedAt: new Date()
            });

            logger.info('代币信息保存成功:', {
                mint: token.mint,
                name: token.name
            });

            return token;
        } catch (error) {
            logger.error('保存代币信息失败:', {
                error: error.message,
                tokenData
            });
            throw error;
        }
    }

    async saveTransaction(txData) {
        try {
            const transaction = await db.models.Transaction.create({
                signature: txData.signature,
                mint: txData.mint,
                owner: txData.owner,
                type: txData.type,
                amount: txData.solAmount,
                status: txData.success ? 'success' : 'failed',
                timestamp: new Date(txData.timestamp),
                raw: txData
            });

            logger.info('交易记录保存成功:', {
                signature: transaction.signature,
                type: transaction.type
            });

            return transaction;
        } catch (error) {
            logger.error('保存交易记录失败:', {
                error: error.message,
                txData
            });
            throw error;
        }
    }

    // 缓存操作方法
    async cacheTokenBalance(owner, mint, balance) {
        try {
            const key = CACHE_KEYS.TOKEN_BALANCE(owner, mint);
            await this.redis.set(key, balance.toString(), {
                EX: 3600 // 1小时过期
            });

            logger.debug('代币余额缓存成功:', {
                owner,
                mint,
                balance: balance.toString()
            });
        } catch (error) {
            logger.error('缓存代币余额失败:', {
                error: error.message,
                owner,
                mint
            });
        }
    }

    async getCachedTokenBalance(owner, mint) {
        try {
            const key = CACHE_KEYS.TOKEN_BALANCE(owner, mint);
            const cachedBalance = await this.redis.get(key);

            if (cachedBalance) {
                logger.debug('从缓存获取代币余额:', {
                    owner,
                    mint,
                    balance: cachedBalance
                });
                return BigInt(cachedBalance);
            }

            return null;
        } catch (error) {
            logger.error('获取缓存余额失败:', {
                error: error.message,
                owner,
                mint
            });
            return null;
        }
    }

    // WebSocket 订阅方法
    async setupTokenSubscription(owner, mint) {
        try {
            const subscriptionKey = `${owner}:${mint}`;

            // 1. 检查现有订阅
            if (this.activeSubscriptions.has(subscriptionKey)) {
                const existing = this.activeSubscriptions.get(subscriptionKey);
                if (Date.now() - existing.lastUpdate < 60000) { // 1分钟内的订阅视为有效
                    return existing.id;
                }
            }

            // 2. 获取代币账户地址
            const tokenAccount = await this.findAssociatedTokenAddress(owner, mint);

            // 3. 设置新的订阅
            const subscriptionId = await this.wsManager.subscribeToAccount(
                tokenAccount,
                async (accountInfo) => {
                    try {
                        // 解析新余额
                        const data = AccountLayout.decode(accountInfo.data);
                        const newBalance = BigInt(data.amount.toString());

                        // 更新缓存
                        await this.updateTokenBalanceCache(owner, mint, newBalance);

                        // 更新最后更新时间
                        const subscription = this.activeSubscriptions.get(subscriptionKey);
                        if (subscription) {
                            subscription.lastUpdate = Date.now();
                            this.activeSubscriptions.set(subscriptionKey, subscription);
                        }

                    } catch (error) {
                        logger.error('处理代币余额更新失败:', {
                            error: error.message,
                            owner,
                            mint
                        });
                    }
                }
            );

            // 4. 保存订阅信息
            this.activeSubscriptions.set(subscriptionKey, {
                id: subscriptionId,
                owner,
                mint,
                lastUpdate: Date.now()
            });

            return subscriptionId;
        } catch (error) {
            logger.error('设置代币订阅失败:', {
                error: error.message,
                owner,
                mint
            });
            throw error;
        }
    }

    async updateTokenBalanceCache(owner, mint, balance) {
        try {
            if (!this.redis) {
                return;
            }

            const cacheKey = `token:balance:${owner}:${mint}`;
            const balanceData = {
                balance: balance.toString(),
                lastUpdate: Date.now()
            };

            await this.redis.set(
                cacheKey,
                JSON.stringify(balanceData),
                'EX',
                300 // 5分钟过期
            );

            logger.debug('代币余额缓存已更新:', {
                owner,
                mint,
                balance: balance.toString()
            });
        } catch (error) {
            logger.error('更新代币余额缓存失败:', {
                error: error.message,
                owner,
                mint,
                balance: balance.toString()
            });
            // 不抛出错误，让流程继续
        }
    }

    // 清理方法
    async cleanup() {
        try {
            // 清理所有 WebSocket 订阅
            for (const [key, subId] of this.activeSubscriptions.entries()) {
                try {
                    await this.wsManager.unsubscribeFromAccount(subId);
                    logger.debug('清理订阅成功:', {key, subscriptionId: subId});
                } catch (error) {
                    logger.error('清理订阅失败:', {
                        error: error.message,
                        key,
                        subscriptionId: subId
                    });
                }
            }

            this.activeSubscriptions.clear();

            // 清理 WebSocket 管理器
            await this.wsManager.cleanup();

            logger.info('SolanaService 清理完成');
        } catch (error) {
            logger.error('SolanaService 清理失败:', {
                error: error.message
            });
            throw error;
        }
    }

    // 订阅账户余额变动
    async subscribeToAccountChanges(publicKey, callback) {
        try {
            logger.info('开始订阅账户余额变动:', {
                publicKey
            });

            // 将字符串转换为 PublicKey 对象
            const accountPubKey = new PublicKey(publicKey);

            // 订阅账户变动
            const subscriptionId = this.connection.onAccountChange(
                accountPubKey,
                (accountInfo) => {
                    const balance = accountInfo.lamports;
                    logger.info('账户余额变动:', {
                        publicKey,
                        newBalance: balance,
                        balanceInSOL: balance / LAMPORTS_PER_SOL
                    });
                    callback(balance);
                },
                'confirmed'
            );

            logger.info('账户订阅成功:', {
                publicKey,
                subscriptionId
            });

            return subscriptionId;
        } catch (error) {
            logger.error('订阅账户变动失败:', {
                error: error.message,
                publicKey
            });
            throw error;
        }
    }

    // 取消账户订阅
    async unsubscribeFromAccount(subscriptionId) {
        try {
            await this.connection.removeAccountChangeListener(subscriptionId);
            logger.info('取消账户订阅成功:', {
                subscriptionId
            });
        } catch (error) {
            logger.error('取消账户订阅失败:', {
                error: error.message,
                subscriptionId
            });
            throw error;
        }
    }

    // 批量订阅账户余额变动
    async subscribeToBalanceChanges(wallets) {
        try {
            logger.info('开始批量订阅余额变动', {
                walletsCount: wallets.length
            });

            const subscriptions = [];
            for (const wallet of wallets) {
                const publicKey = new PublicKey(wallet.publicKey);

                // 如果已经订阅，先取消旧的订阅
                if (this.subscriptions.has(wallet.publicKey)) {
                    await this.unsubscribeFromBalance(wallet.publicKey);
                }

                // 创建新的订阅
                const subscriptionId = this.connection.onAccountChange(
                    publicKey,
                    async (accountInfo) => {
                        try {
                            const newBalance = accountInfo.lamports / LAMPORTS_PER_SOL;

                            // 更新 Redis 缓存
                            if (this.redis) {
                                await this.redis.setBalance(wallet.publicKey, newBalance);
                            }

                            // 记录余额变动
                            if (db && db.BalanceHistory) {
                                await db.BalanceHistory.create({
                                    groupType: wallet.groupType,
                                    accountNumber: wallet.accountNumber,
                                    publicKey: wallet.publicKey,
                                    previousBalance: wallet.lastKnownBalance || 0,
                                    currentBalance: newBalance,
                                    changeAmount: newBalance - (wallet.lastKnownBalance || 0),
                                    transactionType: 'other',
                                    metadata: {
                                        source: 'websocket',
                                        timestamp: new Date().toISOString()
                                    }
                                });
                            }

                            logger.info('检测到余额变动', {
                                publicKey: wallet.publicKey,
                                groupType: wallet.groupType,
                                accountNumber: wallet.accountNumber,
                                newBalance,
                                change: newBalance - (wallet.lastKnownBalance || 0)
                            });
                        } catch (error) {
                            logger.error('处理余额变动失败:', {
                                error,
                                publicKey: wallet.publicKey,
                                groupType: wallet.groupType,
                                accountNumber: wallet.accountNumber
                            });
                        }
                    },
                    'confirmed'
                );

                this.subscriptions.set(wallet.publicKey, {
                    id: subscriptionId,
                    wallet
                });

                subscriptions.push({
                    publicKey: wallet.publicKey,
                    subscriptionId
                });
            }

            logger.info('批量订阅完成', {
                successCount: subscriptions.length,
                totalCount: wallets.length
            });

            return subscriptions;
        } catch (error) {
            logger.error('批量订阅余额变动失败:', error);
            throw error;
        }
    }


    // 通知余额变动
    async notifyBalanceChange(publicKey, newBalance) {
        try {
            // 获取订阅 ID
            const subscriptionId = this.activeSubscriptions.get(publicKey);
            if (subscriptionId) {
                // 触发回调
                this.wsManager.notifyAccountChange(subscriptionId, {
                    lamports: newBalance,
                    owner: publicKey,
                    executable: false,
                    rentEpoch: 0,
                    data: Buffer.alloc(0)
                });

                logger.info('余额变动通知已发送:', {
                    publicKey,
                    newBalance,
                    balanceInSOL: newBalance / LAMPORTS_PER_SOL
                });
            }
        } catch (error) {
            logger.error('发送余额变动通知失败:', {
                error: error.message,
                stack: error.stack,
                publicKey
            });
        }
    }

    // 修改 getTokenPrice 方法，添加缓存检查
    async getTokenPrice(tokenAddress) {
        try {
            logger.info('获取代币价格:', {tokenAddress});

            // 1. 检查缓存
            if (this.redis) {
                const cached = await this.redis.get(`token:price:${tokenAddress}`);
                if (cached) {
                    const parsedCache = JSON.parse(cached);
                    // 如果缓存不超过1分钟，直接返回
                    if (Date.now() - parsedCache.timestamp < 60000) {
                        logger.debug('使用缓存的代币价格:', {
                            tokenAddress,
                            cached: true
                        });
                        return parsedCache;
                    }
                }
            }

            // 2. 验证代币地址
            const mintPubkey = new PublicKey(tokenAddress);

            // 3. 获取代币绑定曲线账户
            const bondingCurve = await this.sdk.getBondingCurveAccount(mintPubkey);
            if (!bondingCurve) {
                throw new Error(`找不到代币的绑定曲线: ${tokenAddress}`);
            }

            // 4. 获取全局状态
            const globalState = await this.sdk.getGlobalState();

            // 5. 计算价格信息
            const currentPrice = bondingCurve.getCurrentPrice();
            const buyPriceImpact = bondingCurve.getBuyPriceImpact();
            const sellPriceImpact = bondingCurve.getSellPriceImpact();
            const liquidity = bondingCurve.getLiquidity();

            // 6. 获取24小时交易量
            const volume24h = await this.getTokenVolume24h(tokenAddress);

            const priceInfo = {
                currentPrice: currentPrice.toString(),
                buyPriceImpact: buyPriceImpact.toString(),
                sellPriceImpact: sellPriceImpact.toString(),
                liquidity: liquidity.toString(),
                volume24h: volume24h.toString(),
                feeBasisPoints: globalState.feeBasisPoints,
                feeRecipient: globalState.feeRecipient.toString(),
                timestamp: Date.now()
            };

            // 7. 更新缓存
            if (this.redis) {
                await this.redis.set(
                    `token:price:${tokenAddress}`,
                    JSON.stringify(priceInfo),
                    {EX: 60} // 缓存1分钟
                );
            }

            logger.info('获取代币价格成功:', {
                tokenAddress,
                currentPrice: priceInfo.currentPrice,
                liquidity: priceInfo.liquidity
            });

            return priceInfo;
        } catch (error) {
            logger.error('获取代币价格失败:', {
                error: error.message,
                tokenAddress,
                stack: error.stack
            });
            throw error;
        }
    }

    // 辅助方法：获取24小时交易量
    async getTokenVolume24h(tokenAddress) {
        try {
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

            // 从数据库获取24小时内的交易
            const transactions = await db.models.Transaction.findAll({
                where: {
                    mint: tokenAddress,
                    status: 'success',
                    createdAt: {
                        [db.Sequelize.Op.gte]: oneDayAgo
                    }
                },
                attributes: ['amount', 'type']
            });

            // 计算总交易量
            const volume = transactions.reduce((sum, tx) => {
                return sum + BigInt(tx.amount);
            }, BigInt(0));

            return volume;
        } catch (error) {
            logger.error('获取24小时交易量失败:', {
                error: error.message,
                tokenAddress
            });
            return BigInt(0);
        }
    }

    // 获取最优节点
    async getBestNode() {
        try {
            // 并发请求所有节点的最新区块高度
            const results = await Promise.allSettled(
                this.endpoints.map(async endpoint => {
                    const startTime = Date.now();
                    try {
                        const connection = new Connection(endpoint);
                        // 获取最新区块高度
                        const slot = await connection.getSlot('finalized');
                        const latency = Date.now() - startTime;

                        return {
                            endpoint,
                            slot,
                            latency,
                            status: 'success'
                        };
                    } catch (error) {
                        return {
                            endpoint,
                            status: 'error',
                            error: error.message
                        };
                    }
                })
            );

            // 过滤并排序结果
            const validResults = results
                .filter(r => r.status === 'fulfilled' && r.value.status === 'success')
                .map(r => r.value)
                .sort((a, b) => {
                    // 首先比较区块高度
                    if (b.slot !== a.slot) {
                        return b.slot - a.slot;  // 区块高度高的优先
                    }
                    // 区块高度相同时比较延迟
                    return a.latency - b.latency;  // 延迟低的优先
                });

            if (validResults.length === 0) {
                logger.warn('没有可用的 RPC 节点，使用默认节点');
                return this.endpoints[0];
            }

            const bestNode = validResults[0];
            logger.info('选择最优节点:', {
                endpoint: bestNode.endpoint.replace(/api-key=([^&]+)/, 'api-key=***'),
                slot: bestNode.slot,
                latency: `${bestNode.latency}ms`,
                totalNodes: validResults.length
            });

            return bestNode.endpoint;
        } catch (error) {
            logger.error('获取最优节点失败:', error);
            return this.endpoints[0];
        }
    }

    // 更新节点状态
    updateNodeStats(endpoint, {success, error, latency}) {
        const stats = this.nodeStats.get(endpoint);
        if (!stats) return;

        if (success) {
            stats.latency = (stats.latency * 0.7) + (latency * 0.3); // 加权平均延迟
            stats.successRate = (stats.successRate * 0.9) + 0.1; // 逐渐提升成功率
            stats.errorCount = Math.max(0, stats.errorCount - 1); // 减少错误计数
        } else {
            stats.errorCount++;
            stats.successRate = Math.max(0.1, stats.successRate * 0.8); // 降低成功率但保持最小值
            if (error) {
                stats.lastError = {
                    message: error,
                    timestamp: Date.now()
                };
            }
        }

        stats.lastCheck = Date.now();
        this.nodeStats.set(endpoint, stats);

        logger.debug('节点状态已更新:', {
            endpoint: endpoint.replace(/api-key=([^&]+)/, 'api-key=***'),
            latency: stats.latency,
            successRate: stats.successRate,
            errorCount: stats.errorCount
        });
    }

    // 发送交易时使用最优节点
    async sendTransaction(transaction, wallet, options = {}) {
        const startTime = Date.now();
        let lastError = null;

        // 获取最快的节点
        const bestEndpoint = await this.getBestNode();
        const connection = new Connection(bestEndpoint, {
            commitment: 'confirmed',
            confirmTransactionInitialTimeout: 120000, // 增加到 120 秒
            wsEndpoint: this._getWsEndpoint(bestEndpoint)
        });

        // 重试配置
        const maxRetries = 3;
        let attempt = 0;

        while (attempt < maxRetries) {
            try {
                logger.info('发送交易...', {
                    attempt: attempt + 1,
                    endpoint: bestEndpoint.replace(/api-key=([^&]+)/, 'api-key=***'),
                    wallet: wallet.publicKey.toString()
                });

                // 1. 获取最新的 blockhash
                const {blockhash, lastValidBlockHeight} =
                    await connection.getLatestBlockhash('confirmed');

                // 2. 设置交易参数
                transaction.recentBlockhash = blockhash;
                transaction.lastValidBlockHeight = lastValidBlockHeight;
                transaction.feePayer = wallet.publicKey;

                // 3. 发送交易
                const signature = await connection.sendTransaction(
                    transaction,
                    [wallet],
                    {
                        skipPreflight: false,
                        maxRetries: 3,
                        preflightCommitment: 'confirmed'
                    }
                );

                logger.info('交易已发送，等待确认...', {signature});

                // 4. 等待交易确认，使用更长的超时时间
                const confirmation = await Promise.race([
                    connection.confirmTransaction({
                        signature,
                        blockhash,
                        lastValidBlockHeight
                    }, 'confirmed'),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Confirmation timeout')), 60000)
                    )
                ]);

                // 5. 检查确认结果
                if (confirmation.value?.err) {
                    throw new Error(`Transaction failed: ${confirmation.value.err}`);
                }

                // 6. 更新节点统计
                this.updateNodeStats(bestEndpoint, {
                    success: true,
                    latency: Date.now() - startTime
                });

                logger.info('交易确认成功', {
                    signature,
                    duration: `${Date.now() - startTime}ms`
                });

                return signature;

            } catch (error) {
                lastError = error;
                attempt++;

                // 更新节点统计
                this.updateNodeStats(bestEndpoint, {
                    success: false,
                    error: error.message
                });

                logger.warn(`交易失败，尝试重试 (${attempt}/${maxRetries})`, {
                    error: error.message,
                    endpoint: bestEndpoint.replace(/api-key=([^&]+)/, 'api-key=***')
                });

                // 如果是最后一次尝试，抛出错误
                if (attempt === maxRetries) {
                    logger.error('交易最终失败', {
                        error: error.message,
                        attempts: attempt,
                        duration: `${Date.now() - startTime}ms`
                    });
                    throw error;
                }

                // 等待后重试，使用递增的等待时间
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
            }
        }

        throw lastError;
    }

    // 新增: 设置代币跟踪（包含缓存和WebSocket）
    async setupTokenTracking(ownerAddress, mintAddress, initialBalance) {
        try {
            // 1. 设置缓存
            if (this.redis) {
                const tokenBalanceKey = `token:balance:${ownerAddress}:${mintAddress}`;
                await this.redis.set(tokenBalanceKey, initialBalance, 'EX', 300); // 5分钟过期
            }

            // 2. 创建 WebSocket 订阅
            const subscriptionId = await this.wsManager.subscribeToAccount(
                new PublicKey(mintAddress),
                async (accountInfo) => {
                    await this.handleTokenBalanceChange(
                        ownerAddress,
                        mintAddress,
                        accountInfo,
                        (balanceInfo) => {
                            logger.info('Token balance updated:', balanceInfo);
                            // 这里可以添加其他处理逻辑
                        }
                    );
                }
            );

            logger.info('代币追踪设置成功:', {
                owner: ownerAddress,
                mint: mintAddress,
                subscriptionId
            });

            return true;
        } catch (error) {
            logger.error('设置代币追踪失败:', {
                error: error.message,
                owner: ownerAddress,
                mint: mintAddress
            });
            return false;
        }
    }

    async handleTokenBalanceChange(ownerAddress, mintAddress, accountInfo, onBalanceChange) {
        try {
            // 1. 解析新余额
            const newBalance = accountInfo.lamports.toString();

            // 2. 更新缓存
            if (this.redis) {
                const tokenBalanceKey = `token:balance:${ownerAddress}:${mintAddress}`;
                await this.redis.set(tokenBalanceKey, newBalance, 'EX', 300);
            }

            // 3. 更新数据库
            await db.models.TokenBalance.upsert({
                owner: ownerAddress,
                mint: mintAddress,
                balance: newBalance,
                lastUpdate: new Date()
            });

            // 4. 使用回调函数通知变化
            if (typeof onBalanceChange === 'function') {
                onBalanceChange({
                    owner: ownerAddress,
                    mint: mintAddress,
                    newBalance,
                    timestamp: Date.now()
                });
            }

            logger.debug('代币余额更新:', {
                owner: ownerAddress,
                mint: mintAddress,
                newBalance
            });
        } catch (error) {
            logger.error('处理代币余额变化失败:', {
                error: error.message,
                owner: ownerAddress,
                mint: mintAddress
            });
        }
    }

    // 新增: 重试设置跟踪
    async retrySetupTracking(ownerAddress, mintAddress, initialBalance, maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                logger.info(`重试设置代币跟踪 (${i + 1}/${maxRetries}):`, {
                    owner: ownerAddress,
                    mint: mintAddress
                });

                // 等待一段时间后重试
                await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));

                const success = await this.setupTokenSubscription(ownerAddress, mintAddress);
                if (success) {
                    return true;
                }
            } catch (error) {
                logger.warn(`重试失败 (${i + 1}/${maxRetries}):`, {
                    error: error.message,
                    owner: ownerAddress,
                    mint: mintAddress
                });
            }
        }

        // 如果所有重试都失败，记录错误但不抛出异常
        logger.error('所有重试都失败:', {
            owner: ownerAddress,
            mint: mintAddress
        });
        return false;
    }

    async getTokenInfo(tokenAddress) {
        try {
            // 1. 验证代币地址
            const mintPubkey = new PublicKey(tokenAddress);

            // 2. 获取代币账户信息
            const mintInfo = await this.connection.getParsedAccountInfo(mintPubkey);
            if (!mintInfo?.value) {
                throw new Error(`Token ${tokenAddress} not found`);
            }

            // 3. 获取代币元数据
            const [metadataPDA] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from('metadata'),
                    new PublicKey(TOKEN_METADATA_PROGRAM_ID).toBuffer(),
                    mintPubkey.toBuffer()
                ],
                new PublicKey(TOKEN_METADATA_PROGRAM_ID)
            );

            const metadataAccount = await this.connection.getAccountInfo(metadataPDA);
            if (!metadataAccount) {
                logger.warn('代币元数据不存在:', {tokenAddress});
                // 如果没有元数据，返回基本信息
                return {
                    address: tokenAddress,
                    mint: mintPubkey.toString(),
                    decimals: mintInfo.value.data.parsed.info.decimals,
                    supply: mintInfo.value.data.parsed.info.supply,
                    metadata: {
                        name: 'Unknown Token',
                        symbol: 'UNKNOWN',
                        uri: '',
                        creators: []
                    }
                };
            }

            // 4. 解析元数据
            let metadata;
            try {
                metadata = this._decodeMetadata(metadataAccount.data);
                logger.debug('解析元数据成功:', {
                    tokenAddress,
                    metadata
                });
            } catch (parseError) {
                logger.error('解析元数据失败:', {
                    error: parseError.message,
                    tokenAddress,
                    data: metadataAccount.data
                });
                // 使用默认元数据
                metadata = {
                    name: 'Unknown Token',
                    symbol: 'UNKNOWN',
                    uri: '',
                    creators: []
                };
            }

            // 5. 获取 Bonding Curve 账户
            let bondingCurveInfo = {
                basePrice: '0',
                currentPrice: '0',
                totalSupply: '0'
            };

            try {
                const bondingCurveAccount = await this.sdk.getBondingCurveAccount(mintPubkey);
                if (bondingCurveAccount) {
                    bondingCurveInfo = {
                        basePrice: bondingCurveAccount.basePrice?.toString() || '0',
                        currentPrice: bondingCurveAccount.getCurrentPrice?.() || '0',
                        totalSupply: bondingCurveAccount.totalSupply?.toString() || '0'
                    };
                } else {
                    logger.warn('Bonding curve 账户不存在:', {tokenAddress});
                }
            } catch (bcError) {
                logger.error('获取 Bonding curve 账户失败:', {
                    error: bcError.message,
                    tokenAddress
                });
            }

            // 6. 返回完整的代币信息
            const tokenInfo = {
                address: tokenAddress,
                mint: mintPubkey.toString(),
                decimals: mintInfo.value.data.parsed.info.decimals,
                supply: mintInfo.value.data.parsed.info.supply,
                metadata: {
                    name: metadata.name || 'Unknown Token',
                    symbol: metadata.symbol || 'UNKNOWN',
                    uri: metadata.uri || '',
                    creators: metadata.creators || []
                },
                bondingCurve: bondingCurveInfo,
                timestamp: new Date().toISOString()
            };

            logger.info('获取代币信息成功:', {
                token: tokenAddress,
                name: tokenInfo.metadata.name,
                symbol: tokenInfo.metadata.symbol,
                bondingCurve: bondingCurveInfo
            });

            return tokenInfo;

        } catch (error) {
            logger.error('获取代币信息失败:', {
                error: error.message,
                token: tokenAddress,
                stack: error.stack
            });
            throw error;
        }
    }

    // 修改元数据解析方法，添加更多的错误检查
    _decodeMetadata(buffer) {
        try {
            if (!buffer || buffer.length < 2) {
                throw new Error('Invalid metadata buffer');
            }

            let offset = 1;

            // 读取名称
            const nameLength = buffer[offset];
            if (offset + 1 + nameLength > buffer.length) {
                throw new Error('Buffer overflow while reading name');
            }
            offset += 1;
            const name = buffer.slice(offset, offset + nameLength).toString('utf8');
            offset += nameLength;

            // 读取符号
            if (offset + 1 > buffer.length) {
                throw new Error('Buffer overflow while reading symbol length');
            }
            const symbolLength = buffer[offset];
            if (offset + 1 + symbolLength > buffer.length) {
                throw new Error('Buffer overflow while reading symbol');
            }
            offset += 1;
            const symbol = buffer.slice(offset, offset + symbolLength).toString('utf8');
            offset += symbolLength;

            // 读取 URI
            if (offset + 1 > buffer.length) {
                throw new Error('Buffer overflow while reading uri length');
            }
            const uriLength = buffer[offset];
            if (offset + 1 + uriLength > buffer.length) {
                throw new Error('Buffer overflow while reading uri');
            }
            offset += 1;
            const uri = buffer.slice(offset, offset + uriLength).toString('utf8');
            offset += uriLength;

            // 读取创建者信息
            const creators = [];
            if (offset < buffer.length) {
                const hasCreators = buffer[offset];
                offset += 1;

                if (hasCreators && offset < buffer.length) {
                    const creatorCount = buffer[offset];
                    offset += 1;

                    for (let i = 0; i < creatorCount && offset + 34 <= buffer.length; i++) {
                        const creator = {
                            address: new PublicKey(buffer.slice(offset, offset + 32)).toString(),
                            verified: buffer[offset + 32] === 1,
                            share: buffer[offset + 33]
                        };
                        creators.push(creator);
                        offset += 34;
                    }
                }
            }

            return {
                name,
                symbol,
                uri,
                creators
            };
        } catch (error) {
            logger.error('解析元数据失败:', {
                error: error.message,
                bufferLength: buffer?.length
            });
            throw error;
        }
    }

    validateBatchResult(batchResult) {
        const errors = [];

        // 数据存在性检查
        if (!batchResult) {
            throw new Error('Batch result is required');
        }

        // 必填字段检查
        if (!batchResult.groupType) errors.push('groupType is required');
        if (!batchResult.accountNumber) errors.push('accountNumber is required');
        if (!batchResult.signature) errors.push('signature is required');  // 增加 signature 检查

        // 金额校验
        if (typeof batchResult.tokenAmount === 'undefined') errors.push('tokenAmount is required');
        if (typeof batchResult.solAmount === 'undefined') errors.push('solAmount is required');

        // 类型和格式校验
        if (batchResult.accountNumber && !Number.isInteger(Number(batchResult.accountNumber))) {
            errors.push('accountNumber must be an integer');
        }

        if (batchResult.solAmount && isNaN(Number(batchResult.solAmount))) {
            errors.push('solAmount must be a number');
        }

        if (errors.length > 0) {
            throw new Error(`Validation errors: ${errors.join(', ')}`);
        }

        return true;
    }

    async updateTokenBalance(owner, mint) {
        try {
            // 1. 获取最新余额
            const balance = await this.getTokenBalance(owner, mint);

            // 2. 更新缓存
            if (this.redis) {
                const cacheKey = `token:balance:${owner}:${mint}`;
                await this.redis.set(cacheKey, balance.toString(), {
                    EX: 300 // 5分钟过期
                });
            }

            // 3. 更新数据库
            await db.models.TokenBalance.upsert({
                owner,
                mint,
                balance: balance.toString(),
                updatedAt: new Date()
            });

            logger.info('代币余额已更新:', {
                owner,
                mint,
                balance: balance.toString()
            });

            return balance;
        } catch (error) {
            logger.error('处理代币余额更新失败:', {
                error: error.message,
                owner,
                mint,
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    async batchBuyByNumber({
                               groupType,
                               accountNumbers, // 4/50/100/500/1000
                               tokenAddress,
                               amountSol,
                               tipAmountSol = 0,
                               options = {}
                           }) {
        try {
            // 验证账户数量
            if (![4, 50, 100, 500, 1000].includes(accountNumbers)) {
                throw new Error('Invalid account numbers. Must be 4, 50, 100, 500, or 1000');
            }

            logger.info('开始批量买入:', {
                groupType,
                accountNumbers,
                tokenAddress,
                amountSol,
                tipAmountSol
            });

            const operations = [];
            // 准备操作数组
            for (let i = 1; i <= accountNumbers; i++) {
                try {
                    const wallet = await this.walletService.getWalletKeypair(groupType, i);
                    if (!wallet) {
                        throw new Error(`Wallet not found: ${groupType}-${i}`);
                    }

                    operations.push({
                        wallet,
                        mint: new PublicKey(tokenAddress),
                        amountSol,
                        tipAmountSol,
                        options
                    });
                } catch (error) {
                    logger.error(`准备账户 ${i} 失败:`, error);
                }
            }

            // 调用 SDK 的批量买入方法
            const results = await this.sdk.batchBuy(operations);

            // 处理结果
            const successful = results.filter(r => r.success);
            const failed = results.filter(r => !r.success);

            // 更新账户余额
            await Promise.all(
                successful.map(result =>
                    this.updateAccountBalances(
                        {publicKey: new PublicKey(result.wallet)},
                        new PublicKey(tokenAddress),
                        result.tokenAmount,
                        amountSol
                    )
                )
            );

            return {
                success: true,
                totalAccounts: accountNumbers,
                successful: successful.length,
                failed: failed.length,
                successfulTransactions: successful,
                failedTransactions: failed
            };

        } catch (error) {
            logger.error('批量买入失败:', {
                error: error.message,
                groupType,
                accountNumbers,
                stack: error.stack
            });
            throw error;
        }
    }

    async batchSellByNumber({
                                groupType,
                                accountNumbers,
                                tokenAddress,
                                percentage,
                                tipAmountSol = 0,
                                options = {}
                            }) {
        try {
            // 验证账户数量和百分比
            if (![4, 50, 100, 500, 1000].includes(accountNumbers)) {
                throw new Error('Invalid account numbers. Must be 4, 50, 100, 500, or 1000');
            }
            if (percentage <= 0 || percentage > 100) {
                throw new Error('Percentage must be between 0 and 100');
            }

            logger.info('开始批量卖出:', {
                groupType,
                accountNumbers,
                tokenAddress,
                percentage,
                tipAmountSol
            });

            const operations = [];
            // 准备操作数组
            for (let i = 1; i <= accountNumbers; i++) {
                try {
                    const wallet = await this.walletService.getWalletKeypair(groupType, i);
                    if (!wallet) {
                        throw new Error(`Wallet not found: ${groupType}-${i}`);
                    }

                    // 获取代币余额
                    const tokenBalance = await this.getTokenBalance(wallet.publicKey, tokenAddress);
                    if (!tokenBalance || tokenBalance === '0') {
                        logger.warn(`账户 ${i} 没有代币余额`);
                        continue;
                    }

                    // 计算卖出数量
                    const sellAmount = BigInt(Math.floor(Number(tokenBalance) * (percentage / 100)));

                    operations.push({
                        wallet,
                        mint: new PublicKey(tokenAddress),
                        tokenAmount: sellAmount,
                        tipAmountSol,
                        options
                    });
                } catch (error) {
                    logger.error(`准备账户 ${i} 失败:`, error);
                }
            }

            // 调用 SDK 的批量卖出方法
            const results = await this.sdk.batchSell(operations);

            // 处理结果
            const successful = results.filter(r => r.success);
            const failed = results.filter(r => !r.success);

            // 更新账户余额
            await Promise.all(
                successful.map(result =>
                    this.updateAccountBalances(
                        {publicKey: new PublicKey(result.wallet)},
                        new PublicKey(tokenAddress),
                        null,  // token 余额会通过 WebSocket 更新
                        null   // SOL 余额会通过 WebSocket 更新
                    )
                )
            );

            return {
                success: true,
                totalAccounts: accountNumbers,
                successful: successful.length,
                failed: failed.length,
                successfulTransactions: successful,
                failedTransactions: failed
            };

        } catch (error) {
            logger.error('批量卖出失败:', {
                error: error.message,
                groupType,
                accountNumbers,
                stack: error.stack
            });
            throw error;
        }
    }

    async batchBuyAndSellByNumber({
                                      groupType,
                                      accountNumbers,
                                      tokenAddress,
                                      amountSol,
                                      tipAmountSol = 0,
                                      options = {}
                                  }) {
        try {
            // 验证账户数量
            if (![4, 50, 100, 500, 1000].includes(accountNumbers)) {
                throw new Error('Invalid account numbers. Must be 4, 50, 100, 500, or 1000');
            }

            logger.info('开始批量买入并卖出:', {
                groupType,
                accountNumbers,
                tokenAddress,
                amountSol,
                tipAmountSol
            });

            const operations = [];
            // 准备操作数组
            for (let i = 1; i <= accountNumbers; i++) {
                try {
                    const wallet = await this.walletService.getWalletKeypair(groupType, i);
                    if (!wallet) {
                        throw new Error(`Wallet not found: ${groupType}-${i}`);
                    }

                    operations.push({
                        wallet,
                        mint: new PublicKey(tokenAddress),
                        amountSol,
                        tipAmountSol,
                        options
                    });
                } catch (error) {
                    logger.error(`准备账户 ${i} 失败:`, error);
                }
            }

            // 调用 SDK 的批量买卖方法
            const results = await this.sdk.batchBuyAndSell(operations);

            // 处理结果
            const successful = results.filter(r => r.success);
            const failed = results.filter(r => !r.success);

            // 更新账户余额
            await Promise.all(
                successful.map(result =>
                    this.updateAccountBalances(
                        {publicKey: new PublicKey(result.wallet)},
                        new PublicKey(tokenAddress),
                        null,  // token 余额会通过 WebSocket 更新
                        null   // SOL 余额会通过 WebSocket 更新
                    )
                )
            );

            return {
                success: true,
                totalAccounts: accountNumbers,
                successful: successful.length,
                failed: failed.length,
                successfulTransactions: successful,
                failedTransactions: failed
            };

        } catch (error) {
            logger.error('批量买入并卖出失败:', {
                error: error.message,
                groupType,
                accountNumbers,
                stack: error.stack
            });
            throw error;
        }
    }

    async generateFixedAmount(amount) {
        try {
            if (typeof amount !== 'number' || amount <= 0) {
                throw new Error('Invalid fixed amount');
            }

            return Array(1).fill(amount);
        } catch (error) {
            logger.error('生成固定金额失败:', {
                error: error.message,
                amount
            });
            throw error;
        }
    }

// 生成随机范围金额
    async generateRandomAmount(min, max, count) {
        try {
            if (min >= max || min <= 0) {
                throw new Error('Invalid range values');
            }

            const amounts = [];
            for (let i = 0; i < count; i++) {
                const random = Math.random() * (max - min) + min;
                amounts.push(Number(random.toFixed(9))); // SOL 精度为9位
            }

            logger.info('生成随机金额:', {
                min,
                max,
                count,
                amounts
            });

            return amounts;
        } catch (error) {
            logger.error('生成随机金额失败:', {
                error: error.message,
                min,
                max,
                count
            });
            throw error;
        }
    }

// 生成百分比金额
    async generatePercentageAmount(balance, percentage, count) {
        try {
            // 输入参数验证
            if (typeof balance !== 'number' || balance < 0) {
                throw new Error('余额必须是非负数');
            }

            if (typeof percentage !== 'number' || percentage <= 0 || percentage > 100) {
                throw new Error('百分比必须在0到100之间');
            }

            if (typeof count !== 'number' || count <= 0) {
                throw new Error('数量必须是正数');
            }

            // 根据百分比计算金额
            const baseAmount = (balance * percentage) / 100;

            // 创建包含计算金额的数组
            const amounts = Array(count).fill(baseAmount);

            // 记录生成的金额信息
            logger.info('生成基于百分比的金额:', {
                balance,           // 原始余额
                percentage,        // 百分比
                baseAmount,        // 基础金额
                count,            // 数量
                amounts           // 生成的金额数组
            });

            return amounts;
        } catch (error) {
            logger.error('生成百分比金额失败:', {
                error: error.message,
                balance,
                percentage,
                count
            });
            throw error;
        }
    }

// 统一的金额生成入口方法
    async generateBuyAmounts({
                                 strategy,
                                 fixedAmount,
                                 minAmount,
                                 maxAmount,
                                 percentage,
                                 count,
                                 balance
                             }) {
        try {
            switch (strategy) {
                case 'fixed':
                    return await this.generateFixedAmount(fixedAmount);

                case 'random':
                    return await this.generateRandomAmount(minAmount, maxAmount, count);

                case 'percentage':
                    return await this.generatePercentageAmount(balance, percentage, count);

                default:
                    throw new Error(`Unknown amount strategy: ${strategy}`);
            }
        } catch (error) {
            logger.error('生成买入金额失败:', {
                error: error.message,
                strategy,
                params: {
                    fixedAmount,
                    minAmount,
                    maxAmount,
                    percentage,
                    count,
                    balance
                }
            });
            throw error;
        }
    }

    async calculateTotalFees({
                                 makersCount,
                                 amountStrategy,
                                 jitoTipSol,
                                 amounts
                             }) {
        try {
            // 1. 计算创建账户费用(最少需要0.00203928 SOL包含租金)
            const CREATE_ACCOUNT_FEE = 0.00203928;
            const totalCreateAccountFee = CREATE_ACCOUNT_FEE * makersCount;

            // 2. 计算gas基础费用(每笔交易0.000005 SOL)
            const GAS_BASE = 0.000005;
            // 需要的交易次数:创建账户 + 转账SOL + 买入token + 转回token + 关闭账户
            const totalTransactions = makersCount * 5;
            const totalGasFee = GAS_BASE * totalTransactions;

            // 3. 计算jito小费(每笔交易都需要)
            const totalJitoTip = jitoTipSol * totalTransactions;

            // 4. 计算优先费用(每笔交易0.000001 SOL)
            const PRIORITY_FEE = 0.000001;
            const totalPriorityFee = PRIORITY_FEE * totalTransactions;

            // 5. 计算总买入金额
            const totalBuyAmount = amounts.reduce((sum, amount) => sum + amount, 0);

            // 6. 计算Pump交易费(1%)
            const PUMP_FEE_PERCENTAGE = 0.01;
            const pumpFee = totalBuyAmount * PUMP_FEE_PERCENTAGE;

            // 总费用(SOL)
            const totalFees = totalCreateAccountFee + totalGasFee + totalJitoTip + totalPriorityFee + pumpFee;

            // 总共需要的金额(SOL)
            const totalRequired = totalFees + totalBuyAmount;

            // 转换为lamports用于链上操作
            const feesInLamports = Math.ceil(totalFees * LAMPORTS_PER_SOL);
            const totalRequiredInLamports = Math.ceil(totalRequired * LAMPORTS_PER_SOL);

            logger.info('费用计算结果:', {
                makersCount,
                fees: {
                    createAccount: totalCreateAccountFee,
                    gas: totalGasFee,
                    jitoTip: totalJitoTip,
                    priority: totalPriorityFee,
                    pump: pumpFee,
                    total: totalFees
                },
                totalBuyAmount,
                totalRequired,
                lamports: {
                    fees: feesInLamports,
                    total: totalRequiredInLamports
                }
            });

            return {
                fees: {
                    createAccountFee: totalCreateAccountFee,
                    gasFee: totalGasFee,
                    jitoTip: totalJitoTip,
                    priorityFee: totalPriorityFee,
                    pumpFee: pumpFee,
                    total: totalFees
                },
                totalBuyAmount,
                totalRequired,
                lamports: {
                    fees: feesInLamports,
                    total: totalRequiredInLamports
                }
            };

        } catch (error) {
            logger.error('计算费用失败:', {
                error: error.message,
                makersCount,
                amounts
            });
            throw error;
        }
    }

// 检查账户余额是否足够
    async checkSufficientBalance(publicKey, requiredAmount) {
        try {
            // requiredAmount 单位是 SOL
            const requiredLamports = Math.ceil(requiredAmount * LAMPORTS_PER_SOL);

            const balance = await this.connection.getBalance(publicKey);
            const balanceInSol = balance / LAMPORTS_PER_SOL;

            const isEnough = balance >= requiredLamports;
            const shortfall = isEnough ? 0 : (requiredLamports - balance) / LAMPORTS_PER_SOL;

            logger.info('余额检查:', {
                publicKey: publicKey.toString(),
                required: {
                    sol: requiredAmount,
                    lamports: requiredLamports
                },
                current: {
                    sol: balanceInSol,
                    lamports: balance
                },
                isEnough,
                shortfall
            });

            return {
                isEnough,
                balance: balanceInSol,
                required: requiredAmount,
                shortfall,
                lamports: {
                    balance,
                    required: requiredLamports
                }
            };

        } catch (error) {
            logger.error('检查余额失败:', {
                error: error.message,
                publicKey: publicKey.toString(),
                requiredAmount
            });
            throw error;
        }
    }
    // Add to SolanaService class in solanaService.js

    // Add to SolanaService class in solanaService.js

    /**
     * 批量买入代币
     * @param {Object} params - 批量买入参数
     * @param {string} params.buyerGroup - 买入钱包所属组 (例如: 'trade')
     * @param {Object|Array} params.accountRange - 账户范围 {start, end} 或 [1, 2, 3, ...]
     * @param {string} params.mintAddress - 要购买的代币地址
     * @param {number} [params.fixedAmount] - 固定金额策略 (SOL)
     * @param {Object} [params.randomRange] - 随机金额范围 {min, max} (SOL)
     * @param {number} [params.percentageOfBalance] - 余额百分比 (1-100)
     * @param {Object} [params.options] - 交易选项
     * @param {number} [params.options.slippage=1000] - 滑点 (基点, 默认10%)
     * @param {boolean} [params.options.usePriorityFee=false] - 是否使用优先费
     * @param {number} [params.options.jitoTipSol=0.001] - Jito小费 (SOL)
     * @param {number} [params.options.bundleSize=5] - 每批次交易数
     * @param {number} [params.options.waitBetweenMs=80] - 批次间等待时间
     * @returns {Promise<Object>} 批量买入结果
     */
    async batchBuy({
                       buyerGroup,
                       accountRange,
                       mintAddress,
                       fixedAmount,
                       randomRange,
                       percentageOfBalance,
                       options = {}
                   }) {
        try {
            // 1. 参数验证和标准化
            if (!buyerGroup) {
                throw new Error('买入钱包所属组(buyerGroup)为必填项');
            }

            if (!accountRange) {
                throw new Error('账户范围(accountRange)为必填项');
            }

            if (!mintAddress) {
                throw new Error('代币地址(mintAddress)为必填项');
            }

            // 确保代币地址有效
            try {
                new PublicKey(mintAddress);
            } catch (error) {
                throw new Error(`无效的代币地址: ${mintAddress}`);
            }

            // 检查至少提供了一种金额策略
            const amountStrategyCount = [
                fixedAmount !== undefined,
                randomRange !== undefined,
                percentageOfBalance !== undefined
            ].filter(Boolean).length;

            if (amountStrategyCount === 0) {
                throw new Error('必须提供一种金额策略: fixedAmount, randomRange 或 percentageOfBalance');
            }

            if (amountStrategyCount > 1) {
                throw new Error('只能提供一种金额策略: fixedAmount, randomRange 或 percentageOfBalance');
            }

            // 标准化选项
            const defaultOptions = {
                slippage: 1000,         // 10%
                usePriorityFee: false,
                jitoTipSol: 0.001,
                bundleSize: 5,
                waitBetweenMs: 80,
                retryAttempts: 3,
                skipPreflight: false
            };

            const txOptions = { ...defaultOptions, ...options };

            // 确保滑点在有效范围内
            if (txOptions.slippage < 0 || txOptions.slippage > 10000) {
                throw new Error('滑点(slippage)必须在0-10000基点范围内');
            }

            // 2. 转换账户范围为账户数组
            let accountNumbers = [];

            if (Array.isArray(accountRange)) {
                // 如果是数组，直接使用
                accountNumbers = accountRange;
            } else if (typeof accountRange === 'object' && 'start' in accountRange && 'end' in accountRange) {
                // 如果是{start, end}对象，生成范围内所有数字
                const { start, end } = accountRange;
                if (typeof start !== 'number' || typeof end !== 'number' || start > end) {
                    throw new Error('账户范围无效: start必须小于等于end');
                }

                for (let i = start; i <= end; i++) {
                    accountNumbers.push(i);
                }
            } else {
                throw new Error('账户范围格式无效，必须是数组或{start, end}对象');
            }

            if (accountNumbers.length === 0) {
                throw new Error('账户范围不能为空');
            }

            logger.info('开始批量买入:', {
                buyerGroup,
                accountCount: accountNumbers.length,
                mintAddress,
                amountStrategy: fixedAmount !== undefined ? 'fixed' :
                    randomRange !== undefined ? 'random' : 'percentage',
                options: {
                    slippage: txOptions.slippage,
                    usePriorityFee: txOptions.usePriorityFee,
                    jitoTipSol: txOptions.jitoTipSol,
                    bundleSize: txOptions.bundleSize
                }
            });

            // 3. 获取所有钱包并检查
            const wallets = [];
            const skippedAccounts = [];

            for (const accountNumber of accountNumbers) {
                try {
                    const wallet = await this.walletService.getWalletKeypair(buyerGroup, accountNumber);
                    if (wallet) {
                        wallets.push({
                            wallet,
                            accountNumber,
                            publicKey: wallet.publicKey.toString()
                        });
                    } else {
                        skippedAccounts.push({
                            accountNumber,
                            reason: '钱包不存在'
                        });
                    }
                } catch (error) {
                    logger.warn(`获取钱包失败: ${buyerGroup}-${accountNumber}`, {
                        error: error.message
                    });
                    skippedAccounts.push({
                        accountNumber,
                        reason: `获取钱包失败: ${error.message}`
                    });
                }
            }

            if (wallets.length === 0) {
                throw new Error('没有有效的钱包可用于交易');
            }

            // 4. 获取所有钱包余额
            const walletBalances = [];

            for (const walletInfo of wallets) {
                try {
                    const balance = await this.getBalance(walletInfo.wallet.publicKey);
                    walletBalances.push({
                        ...walletInfo,
                        balance
                    });
                } catch (error) {
                    logger.warn(`获取钱包余额失败: ${walletInfo.publicKey}`, {
                        error: error.message
                    });
                    skippedAccounts.push({
                        accountNumber: walletInfo.accountNumber,
                        reason: `获取余额失败: ${error.message}`
                    });
                }
            }

            // 5. 确定金额策略并生成金额
            let amountStrategy;
            let amountParams = {};

            if (fixedAmount !== undefined) {
                amountStrategy = 'fixed';
                amountParams.fixedAmount = fixedAmount;
            } else if (randomRange !== undefined) {
                amountStrategy = 'random';
                amountParams.minAmount = randomRange.min;
                amountParams.maxAmount = randomRange.max;
            } else if (percentageOfBalance !== undefined) {
                amountStrategy = 'percentage';
                amountParams.percentage = percentageOfBalance;
            }

            // 为每个钱包生成买入金额
            const walletsWithAmounts = [];

            for (const walletInfo of walletBalances) {
                try {
                    let buyAmount;

                    switch (amountStrategy) {
                        case 'fixed':
                            buyAmount = fixedAmount;
                            break;
                        case 'random':
                            buyAmount = randomRange.min + Math.random() * (randomRange.max - randomRange.min);
                            buyAmount = parseFloat(buyAmount.toFixed(9)); // SOL精度为9位
                            break;
                        case 'percentage':
                            buyAmount = (walletInfo.balance * percentageOfBalance) / 100;
                            buyAmount = parseFloat(buyAmount.toFixed(9));
                            break;
                    }

                    walletsWithAmounts.push({
                        ...walletInfo,
                        buyAmount
                    });
                } catch (error) {
                    logger.warn(`生成买入金额失败: ${walletInfo.publicKey}`, {
                        error: error.message
                    });
                    skippedAccounts.push({
                        accountNumber: walletInfo.accountNumber,
                        reason: `生成买入金额失败: ${error.message}`
                    });
                }
            }

            // 6. 计算每个钱包需要的总费用和验证余额
            const validWallets = [];
            const insufficientFundsWallets = [];

            // 预估费用因子
            const FEE_CONSTANTS = {
                ACCOUNT_FEE: 0.00203928*3,          // 创建账户费用
                TRANSACTION_FEE: 0.000005,        // 交易基础费用
                PRIORITY_FEE: 0.000001,           // 优先费
                PUMP_FEE_PERCENTAGE: 0.01,        // Pump平台费用百分比(1%)
                COMPUTE_UNIT_PRICE: 0.0000000015, // 计算单元价格 (microlamports)
                COMPUTE_UNITS_BUY: 200000,        // 预估的买入操作计算单元
                BUFFER: 0.002                     // 额外缓冲金额
            };

            for (const walletInfo of walletsWithAmounts) {
                try {
                    // 计算滑点成本
                    const slippageCost = (walletInfo.buyAmount * txOptions.slippage) / 10000;

                    // 计算平台费用
                    const pumpFee = walletInfo.buyAmount * FEE_CONSTANTS.PUMP_FEE_PERCENTAGE;

                    // 计算优先费用(如果启用)
                    const priorityFee = txOptions.usePriorityFee ? txOptions.jitoTipSol : 0;

                    // 计算交易基础费用
                    const transactionFee = FEE_CONSTANTS.TRANSACTION_FEE;

                    // 计算计算单元费用
                    const computeUnitFee = FEE_CONSTANTS.COMPUTE_UNIT_PRICE * FEE_CONSTANTS.COMPUTE_UNITS_BUY;

                    // 计算总费用 (不包括账户费用，因为我们使用现有钱包)
                    const totalFees = transactionFee + priorityFee + pumpFee + slippageCost + computeUnitFee + FEE_CONSTANTS.BUFFER;

                    // 计算总需求金额
                    const totalRequired = walletInfo.buyAmount + totalFees;

                    // 验证余额是否足够
                    const hasEnoughBalance = walletInfo.balance >= totalRequired;

                    if (hasEnoughBalance) {
                        validWallets.push({
                            ...walletInfo,
                            totalRequired,
                            fees: {
                                transactionFee,
                                priorityFee,
                                pumpFee,
                                slippageCost,
                                computeUnitFee,
                                buffer: FEE_CONSTANTS.BUFFER,
                                total: totalFees
                            }
                        });
                    } else {
                        insufficientFundsWallets.push({
                            accountNumber: walletInfo.accountNumber,
                            publicKey: walletInfo.publicKey,
                            balance: walletInfo.balance,
                            totalRequired,
                            shortfall: totalRequired - walletInfo.balance,
                            reason: `余额不足: 需要 ${totalRequired.toFixed(9)} SOL, 当前 ${walletInfo.balance.toFixed(9)} SOL`
                        });
                    }
                } catch (error) {
                    logger.warn(`计算费用失败: ${walletInfo.publicKey}`, {
                        error: error.message
                    });
                    skippedAccounts.push({
                        accountNumber: walletInfo.accountNumber,
                        reason: `计算费用失败: ${error.message}`
                    });
                }
            }

            if (validWallets.length === 0) {
                throw new Error('没有有效钱包可用于交易: 所有钱包余额不足或无效');
            }

            // 7. 准备批量买入操作
            const operations = validWallets.map(walletInfo => ({
                wallet: walletInfo.wallet,
                mint: new PublicKey(mintAddress),
                amountSol: walletInfo.buyAmount,
                slippageBasisPoints: txOptions.slippage,
                // 优先上链参数
                priorityFee: txOptions.usePriorityFee ? {
                    microLamports: Math.floor(txOptions.jitoTipSol * 1e6)
                } : undefined,
                // Jito tip金额
                tipAmountSol: txOptions.usePriorityFee ? txOptions.jitoTipSol : 0,
                // 是否使用优先上链
                usePriorityFee: txOptions.usePriorityFee,
                options: {
                    skipPreflight: txOptions.skipPreflight
                }
            }));

            logger.info('准备执行批量买入:', {
                totalWallets: wallets.length,
                validWallets: validWallets.length,
                insufficientFunds: insufficientFundsWallets.length,
                skipped: skippedAccounts.length,
                bundleSize: txOptions.bundleSize,
                usePriorityFee: txOptions.usePriorityFee
            });

            // 8. 执行批量买入
            const batchBuyOptions = {
                bundleMaxSize: txOptions.bundleSize,
                waitBetweenBundles: txOptions.waitBetweenMs,
                retryAttempts: txOptions.retryAttempts,
                skipPreflight: txOptions.skipPreflight,
                usePriorityFee: txOptions.usePriorityFee, // 是否使用优先上链
                normalSubmission: !txOptions.usePriorityFee // 是否使用普通上链
            };

            // 调用SDK的批量买入方法
            const batchResults = await this.sdk.batchBuyDirect(operations, batchBuyOptions);

            // 9. 处理结果
            const successfulTransactions = [];
            const failedTransactions = [];

            for (const result of batchResults) {
                const walletInfo = validWallets.find(w => w.publicKey === result.wallet);

                if (result.success) {
                    successfulTransactions.push({
                        accountNumber: walletInfo?.accountNumber,
                        publicKey: result.wallet,
                        signature: result.signature,
                        buyAmount: parseFloat(result.amountSol),
                        tokenAmount: result.tokenAmount,
                        timestamp: result.timestamp || new Date().toISOString()
                    });

                    // 更新账户余额
                    try {
                        if (walletInfo) {
                            await this.updateAccountBalances(
                                walletInfo.wallet,
                                new PublicKey(mintAddress),
                                result.tokenAmount,
                                walletInfo.buyAmount
                            );

                            // 设置代币订阅
                            await this.setupTokenTracking(
                                result.wallet,
                                mintAddress,
                                result.tokenAmount || '0'
                            );
                        }
                    } catch (error) {
                        logger.warn(`更新账户余额失败: ${result.wallet}`, {
                            error: error.message
                        });
                    }
                } else {
                    failedTransactions.push({
                        accountNumber: walletInfo?.accountNumber,
                        publicKey: result.wallet,
                        error: result.error || '交易失败',
                        buyAmount: parseFloat(result.amountSol)
                    });
                }
            }

            // 10. 返回最终结果
            const finalResult = {
                success: successfulTransactions.length > 0,
                summary: {
                    total: wallets.length,
                    attempted: validWallets.length,
                    successful: successfulTransactions.length,
                    failed: failedTransactions.length,
                    skipped: skippedAccounts.length + insufficientFundsWallets.length
                },
                transactions: {
                    successful: successfulTransactions,
                    failed: failedTransactions
                },
                skippedWallets: [
                    ...skippedAccounts,
                    ...insufficientFundsWallets
                ],
                timestamp: new Date().toISOString()
            };

            logger.info('批量买入完成:', {
                mintAddress,
                totalWallets: wallets.length,
                successful: successfulTransactions.length,
                failed: failedTransactions.length,
                skipped: finalResult.summary.skipped,
                usedPriorityFee: txOptions.usePriorityFee
            });

            return finalResult;
        } catch (error) {
            logger.error('批量买入失败:', {
                error: error.message,
                stack: error.stack,
                buyerGroup,
                mintAddress
            });
            throw error;
        }
    }



    async batchBuyProcess({
                              mainGroup = 'main',           // 主账户组
                              mainAccountNumber,            // 主账户编号
                              tradeGroup = 'trade',        // 交易组名
                              makersCount,                 // makers数量(4/50/100/500/1000)
                              amountStrategy,              // 买入策略 fixed/random/percentage
                              amountConfig,               // 买入金额配置 {fixedAmount?/minAmount?/maxAmount?/percentage?}
                              jitoTipSol,                 // jito小费(SOL)
                              mintAddress,                // 代币地址
                              options = {
                                  slippage: 1000          // 默认滑点为10%（以基点为单位，1000 = 10%）
                              }
                          }) {
        try {
            logger.info('开始批量买入流程:', {
                mainAccount: `${mainGroup}-${mainAccountNumber}`,
                makersCount,
                amountStrategy,
                jitoTipSol,
                slippage: `${options.slippage / 100}%`
            });

            // 确保 options.batchTransactions 是一个数组
            options.batchTransactions = options.batchTransactions || [];
            options = options || {};
            // 确保slippage是数字，默认为1000（10%）
            options.slippage = typeof options.slippage === 'number' ? options.slippage : 1000;
            // 1. 获取主账户信息并检查
            const mainWallet = await this.walletService.getWalletKeypair(mainGroup, mainAccountNumber);
            if (!mainWallet) {
                throw new Error(`Main wallet not found: ${mainGroup}-${mainAccountNumber}`);
            }

            // 2. 确保主钱包的 publicKey 是 PublicKey 实例
            const mainPublicKey = new PublicKey(mainWallet.publicKey);

            // 2. 获取主账户余额
            const mainBalance = await this.getBalance(mainPublicKey);

            // 3. 生成买入金额列表
            const buyAmounts = await this.generateBuyAmounts({
                strategy: amountStrategy,
                ...amountConfig,
                count: makersCount,
                balance: mainBalance
            });
            logger.info("buyAmounts", {buyAmounts});
            // 4. 计算总费用 (包含Pump费用和滑点)
            const feeCalculation = await this.calculateMainAccountFees({
                makersCount,
                amountStrategy,
                jitoTipSol,
                amounts: buyAmounts,
                mainAccountBalance: mainBalance,
                slippage: options.slippage
            });
            const estimatedRent = 0.00203928 * 3 * makersCount; // 约0.002 SOL，根据实际情况调整
            // 5. 检查主账户余额是否足够
            const balanceCheck = await this.checkSufficientBalance(
                mainPublicKey,
                feeCalculation.totalRequired + estimatedRent
            );

            if (!balanceCheck.isEnough) {
                throw new Error(`Insufficient balance: Required ${feeCalculation.totalRequired + estimatedRent} SOL, ` +
                    `have ${balanceCheck.balance} SOL, shortfall ${balanceCheck.shortfall} SOL`);
            }

            // 6. 创建交易组的makers账户
            const createResult = await this.walletService.batchCreateWalletsWithRange(tradeGroup, makersCount);
            if (createResult.meetsRequirements) {
                logger.info("创建钱包成功且满足要求:", {
                    accountRange: createResult.accountRange.range,
                    start: createResult.accountRange.start,
                    end: createResult.accountRange.end
                });
            } else {
                throw new Error(`Maker makers账户 创建失败`);
            }
            // 从买入金额列表中获取单个账户的买入金额
            const buyAmount = buyAmounts[0];

// 费用常量定义
            const FEE_CONSTANTS = {
                GAS_FEE_PER_TX: 0.000005,          // 每笔交易的基础 gas 费用
                PRIORITY_FEE_PER_TX: 0.000001,     // 每笔交易的优先费用
                PUMP_FEE_PERCENTAGE: 0.01,         // Pump 平台费用百分比 (1%)
                ACCOUNT_RENT_EXEMPTION: 0.00203928, // 账户租金豁免金额
                TX_COUNT_PER_ACCOUNT: 3            // 每个账户的预计交易数量
            };

// 计算 slippage 百分比 (将基点转换为小数)
            const slippagePercentage = (options?.slippage || 0) / 10000;

// 计算每个账户的费用明细
            const accountFees = {
                gasFee: FEE_CONSTANTS.GAS_FEE_PER_TX * FEE_CONSTANTS.TX_COUNT_PER_ACCOUNT,
                jitoTip: jitoTipSol * FEE_CONSTANTS.TX_COUNT_PER_ACCOUNT,
                priorityFee: FEE_CONSTANTS.PRIORITY_FEE_PER_TX * FEE_CONSTANTS.TX_COUNT_PER_ACCOUNT,
                pumpFee: buyAmount * FEE_CONSTANTS.PUMP_FEE_PERCENTAGE * 2, // 买入和卖出两次的 pump 费用
                slippageFee: buyAmount * slippagePercentage,
                rentExemption: FEE_CONSTANTS.ACCOUNT_RENT_EXEMPTION * FEE_CONSTANTS.TX_COUNT_PER_ACCOUNT
            };

// 计算总费用
            const totalFees = Object.values(accountFees).reduce((sum, fee) => sum + fee, 0);

// 计算每个账户需要的总金额 (买入金额 + 所有费用)
            const accountTotalAmounts = buyAmount + totalFees;

// 记录详细信息
            logger.info("账户费用计算:", {
                buyAmount,
                fees: accountFees,
                totalFees,
                accountTotalAmounts,
                slippagePercentage: `${slippagePercentage * 100}%`
            });
            const solTransferResult = await this.walletService.oneToMany(
                mainGroup,
                mainAccountNumber,
                tradeGroup,
                createResult.accountRange.range,
                accountTotalAmounts
            );

            // 8. makers账户批量买入token，加入滑点配置
            const operations = await Promise.all(
                Array.from({length: createResult.created}, async (_, i) => {
                    // 获取对应的 maker 钱包
                    const accountNumber = createResult.accountRange.start + i;
                    const wallet = await this.walletService.getWalletKeypair(tradeGroup, accountNumber);
                    if (!wallet) {
                        throw new Error(`Maker wallet not found: ${tradeGroup}-${index + 1}`);
                    }

                    return {
                        wallet,                    // maker 钱包
                        groupType: tradeGroup,     // 交易组名
                        accountNumber: i + 1,   // 账户编号从1开始
                        solAmount: buyAmounts[0],   // 对应的买入金额
                        mint: new PublicKey(mintAddress),
                        tipAmountSol: jitoTipSol,
                        options: {
                            slippageBasisPoints: options.slippage || 1000, // 使用传入的滑点或默认10%
                            priorityFee: true
                        }
                    };
                })
            );
            logger.info("operations:", {operations});

            const buyResults = await this.sdk.batchBuy(operations, {
                bundleMaxSize: 5,         // 指定bundle大小限制
                waitBetweenBundles: 80, // 指定bundle间等待时间
                maxSolAmount: 1000,       // 指定最大SOL数量限制
                retryAttempts: 3          // 指定重试次数
            });

            //9. 关闭makers账户
            const closeResult = await this.walletService.batchCloseWallets(
                tradeGroup,
                createResult.accountRange.range,
                mainGroup,
                mainAccountNumber
            );

            logger.info("buyResults:", {
                type: typeof buyResults,
                isArray: Array.isArray(buyResults),
                value: buyResults
            });
            // 整理执行结果
            const result = {
                mainAccount: {
                    group: mainGroup,
                    accountNumber: mainAccountNumber,
                    publicKey: mainWallet.publicKey.toString()
                },
                makers: {
                    group: tradeGroup,
                    count: makersCount,
                    created: createResult.created,
                    closed: closeResult.summary.closed
                },
                amounts: {
                    buyAmounts,
                    fees: {
                        ...feeCalculation.fees,
                        pumpFeePercentage: '1%',
                        slippagePercentage: `${options.slippage / 100}%`
                    },
                    total: feeCalculation.totalRequired
                },
                transactions: {
                    solTransfer: {
                        successful: solTransferResult.successful?.length || 0,
                        failed: solTransferResult.failed?.length || 0
                    },
                    tokenBuy: {
                        // 检查 buyResults 是否为数组，如果不是则尝试从对象中提取信息
                        successful: Array.isArray(buyResults)
                            ? buyResults.filter(r => r.success).length
                            : (buyResults?.success ? 1 : 0),
                        failed: Array.isArray(buyResults)
                            ? buyResults.filter(r => !r.success).length
                            : (buyResults?.success === false ? 1 : 0)
                    },
                    closeWallets: {
                        // 从 closeResult 中获取关闭钱包的结果统计
                        successful: closeResult.successful.length,
                        failed: closeResult.failed.length,
                        skipped: closeResult.skipped.length,
                        solTransferred: closeResult.summary.solTransferred,
                        tokensTransferred: closeResult.summary.tokensTransferred.length
                    }
                },
                timestamp: new Date().toISOString()
            };
            const slippagePercent = (typeof options.slippage === 'number')
                ? `${(options.slippage / 100).toFixed(2)}%`
                : '10.00%';
            logger.info('批量买入流程完成:', {
                mainAccount: `${mainGroup}-${mainAccountNumber}`,
                makersCount,
                successful: result.transactions.tokenBuy.successful,
                failed: result.transactions.tokenBuy.failed,
                slippage: slippagePercent
            });

            return result;

        } catch (error) {
            logger.error('批量买入流程失败:', {
                error: error.message,
                stack: error.stack,
                mainAccount: `${mainGroup}-${mainAccountNumber}`,
                makersCount,
                slippage: options.slippage
            });
            throw error;
        }
    }

    // solanaService.js 修改 calculateMainAccountFees 方法
    async calculateMainAccountFees({
                                       makersCount,          // makers账户数量
                                       amountStrategy,       // 金额策略
                                       jitoTipSol,          // jito小费
                                       amounts,             // 金额数组
                                       mainAccountBalance,   // 主账户余额
                                       slippage = 1000      // 滑点（基点，默认1000 = 10%）
                                   }) {
        try {
            // 输入参数验证
            if (!makersCount || makersCount <= 0) {
                throw new Error('无效的makers数量');
            }

            if (!Array.isArray(amounts)) {
                throw new Error('金额必须是数组格式');
            }

            // 过滤掉空值并验证金额
            const validAmounts = amounts.filter(amount => amount != null && !isNaN(amount) && amount > 0);
            if (validAmounts.length === 0) {
                throw new Error('没有提供有效的金额');
            }

            // 1. 计算创建账户费用（每个账户最少需要0.00203928 SOL作为租金）
            const CREATE_ACCOUNT_FEE = 0.00203928;
            const totalCreateAccountFee = CREATE_ACCOUNT_FEE * makersCount;

            // 2. 计算基础gas费用（每笔交易0.000005 SOL）
            const GAS_BASE = 0.000005;
            // 交易次数：创建账户 + 转账SOL + 买入代币 + 转回代币 + 关闭账户
            const totalTransactions = makersCount * 5;
            const totalGasFee = GAS_BASE * totalTransactions;

            // 3. 计算Jito小费（每笔交易）
            const jitoTipAmount = jitoTipSol || 0.001; // 如果未提供则默认0.001 SOL
            const totalJitoTip = jitoTipAmount * totalTransactions;

            // 4. 计算优先费用（每笔交易0.000001 SOL）
            const PRIORITY_FEE = 0.000001;
            const totalPriorityFee = PRIORITY_FEE * totalTransactions;

            // 5. 计算总买入金额
            const totalBuyAmount = validAmounts.reduce((sum, amount) => sum + amount, 0);

            // 6. 计算滑点成本
            const slippagePercentage = slippage / 10000; // 将基点转换为百分比
            const slippageCost = totalBuyAmount * slippagePercentage;

            // 7. 计算Pump交易费（1%）
            const PUMP_FEE_PERCENTAGE = 0.01;
            const pumpFee = totalBuyAmount * PUMP_FEE_PERCENTAGE;

            // 计算总费用
            const totalFees = totalCreateAccountFee +
                totalGasFee +
                totalJitoTip +
                totalPriorityFee +
                pumpFee +
                slippageCost;

            // 计算总需求金额
            const totalRequired = totalFees + totalBuyAmount;

            // 转换为lamports用于链上操作
            const feesInLamports = Math.ceil(totalFees * LAMPORTS_PER_SOL);
            const totalRequiredInLamports = Math.ceil(totalRequired * LAMPORTS_PER_SOL);

            // 记录费用计算结果
            logger.info('费用计算结果:', {
                makersCount,
                slippage: `${slippage / 100}%`,
                fees: {
                    createAccount: totalCreateAccountFee, // 创建账户费用
                    gas: totalGasFee,                    // gas费用
                    jitoTip: totalJitoTip,              // jito小费
                    priority: totalPriorityFee,          // 优先费用
                    pump: pumpFee,                       // pump费用
                    slippage: slippageCost,             // 滑点成本
                    total: totalFees                     // 总费用
                },
                totalBuyAmount,                         // 总买入金额
                totalRequired,                          // 总需求金额
                lamports: {                             // lamports单位的费用
                    fees: feesInLamports,
                    total: totalRequiredInLamports
                }
            });

            // 返回计算结果
            return {
                fees: {
                    createAccountFee: totalCreateAccountFee,  // 创建账户费用
                    gasFee: totalGasFee,                     // gas费用
                    jitoTip: totalJitoTip,                   // jito小费
                    priorityFee: totalPriorityFee,           // 优先费用
                    pumpFee: pumpFee,                        // pump费用
                    slippageFee: slippageCost,              // 滑点费用
                    total: totalFees                         // 总费用
                },
                totalBuyAmount,                             // 总买入金额
                totalRequired,                              // 总需求金额
                lamports: {                                 // lamports单位的费用
                    fees: feesInLamports,
                    total: totalRequiredInLamports
                }
            };

        } catch (error) {
            logger.error('费用计算失败:', {
                error: error.message,
                makersCount,
                amountStrategy,
                amounts,
                slippage
            });
            throw error;
        }
    }
    async batchSell({
                        sellerGroup,
                        accountRange,
                        mintAddress,
                        percentage,
                        options = {}
                    }) {
        try {
            // 1. 参数验证和标准化
            if (!sellerGroup) {
                throw new Error('卖出钱包所属组(sellerGroup)为必填项');
            }

            if (!accountRange) {
                throw new Error('账户范围(accountRange)为必填项');
            }

            if (!mintAddress) {
                throw new Error('代币地址(mintAddress)为必填项');
            }

            // 确保代币地址有效
            try {
                new PublicKey(mintAddress);
            } catch (error) {
                throw new Error(`无效的代币地址: ${mintAddress}`);
            }

            // 验证百分比参数
            if (typeof percentage !== 'number' || percentage <= 0 || percentage > 100) {
                throw new Error(`无效的百分比值: ${percentage}，必须在1到100之间`);
            }

            // 标准化选项
            const defaultOptions = {
                slippage: 1000,         // 10%
                usePriorityFee: false,
                jitoTipSol: 0.001,
                bundleSize: 5,
                waitBetweenMs: 80,
                retryAttempts: 3,
                skipPreflight: false
            };

            const txOptions = { ...defaultOptions, ...options };

            // 确保滑点在有效范围内
            if (txOptions.slippage < 0 || txOptions.slippage > 10000) {
                throw new Error('滑点(slippage)必须在0-10000基点范围内');
            }

            // 2. 转换账户范围为账户数组
            let accountNumbers = [];

            if (Array.isArray(accountRange)) {
                // 如果是数组，直接使用
                accountNumbers = accountRange;
            } else if (typeof accountRange === 'object' && 'start' in accountRange && 'end' in accountRange) {
                // 如果是{start, end}对象，生成范围内所有数字
                const { start, end } = accountRange;
                if (typeof start !== 'number' || typeof end !== 'number' || start > end) {
                    throw new Error('账户范围无效: start必须小于等于end');
                }

                for (let i = start; i <= end; i++) {
                    accountNumbers.push(i);
                }
            } else {
                throw new Error('账户范围格式无效，必须是数组或{start, end}对象');
            }

            if (accountNumbers.length === 0) {
                throw new Error('账户范围不能为空');
            }

            logger.info('开始批量卖出:', {
                sellerGroup,
                accountCount: accountNumbers.length,
                mintAddress,
                percentage,
                options: {
                    slippage: txOptions.slippage,
                    usePriorityFee: txOptions.usePriorityFee,
                    jitoTipSol: txOptions.jitoTipSol,
                    bundleSize: txOptions.bundleSize
                }
            });

            // 3. 获取所有钱包并检查
            const wallets = [];
            const skippedAccounts = [];

            for (const accountNumber of accountNumbers) {
                try {
                    const wallet = await this.walletService.getWalletKeypair(sellerGroup, accountNumber);
                    if (wallet) {
                        wallets.push({
                            wallet,
                            accountNumber,
                            publicKey: wallet.publicKey.toString()
                        });
                    } else {
                        skippedAccounts.push({
                            accountNumber,
                            reason: '钱包不存在'
                        });
                    }
                } catch (error) {
                    logger.warn(`获取钱包失败: ${sellerGroup}-${accountNumber}`, {
                        error: error.message
                    });
                    skippedAccounts.push({
                        accountNumber,
                        reason: `获取钱包失败: ${error.message}`
                    });
                }
            }

            if (wallets.length === 0) {
                throw new Error('没有有效的钱包可用于交易');
            }

            // 4. 获取代币余额并筛选有代币的钱包
            const walletsWithBalance = [];
            const insufficientTokenWallets = [];

            for (const walletInfo of wallets) {
                try {
                    // 获取代币余额
                    const tokenBalance = await this.getTokenBalance(
                        walletInfo.wallet.publicKey,
                        mintAddress
                    );

                    // 如果没有余额，记录并跳过
                    if (tokenBalance === '0') {
                        insufficientTokenWallets.push({
                            accountNumber: walletInfo.accountNumber,
                            publicKey: walletInfo.publicKey,
                            reason: '代币余额为0'
                        });
                        continue;
                    }

                    // 计算卖出数量
                    const tokenBalanceBigInt = BigInt(tokenBalance);
                    const sellAmount = (tokenBalanceBigInt * BigInt(Math.floor(percentage * 100))) / BigInt(10000);

                    if (sellAmount <= BigInt(0)) {
                        insufficientTokenWallets.push({
                            accountNumber: walletInfo.accountNumber,
                            publicKey: walletInfo.publicKey,
                            reason: '计算的卖出数量为0'
                        });
                        continue;
                    }

                    // 添加到有效钱包列表
                    walletsWithBalance.push({
                        ...walletInfo,
                        tokenBalance,
                        sellAmount: sellAmount.toString()
                    });

                } catch (error) {
                    logger.warn(`获取代币余额失败: ${walletInfo.publicKey}`, {
                        error: error.message
                    });
                    skippedAccounts.push({
                        accountNumber: walletInfo.accountNumber,
                        reason: `获取代币余额失败: ${error.message}`
                    });
                }
            }

            if (walletsWithBalance.length === 0) {
                throw new Error('没有钱包持有该代币');
            }

            // 5. 准备批量卖出操作
            const operations = walletsWithBalance.map(walletInfo => ({
                wallet: walletInfo.wallet,
                mint: new PublicKey(mintAddress),
                sellAmount: walletInfo.sellAmount,
                percentage,
                slippageBasisPoints: txOptions.slippage,
                tipAmountSol: txOptions.usePriorityFee ? txOptions.jitoTipSol : 0,
                usePriorityFee: txOptions.usePriorityFee,
                options: {
                    skipPreflight: txOptions.skipPreflight
                }
            }));

            logger.info('准备执行批量卖出:', {
                totalWallets: wallets.length,
                walletsWithBalance: walletsWithBalance.length,
                insufficientTokens: insufficientTokenWallets.length,
                skipped: skippedAccounts.length,
                bundleSize: txOptions.bundleSize,
                usePriorityFee: txOptions.usePriorityFee
            });

            // 6. 执行批量卖出
            const batchSellOptions = {
                bundleMaxSize: txOptions.bundleSize,
                waitBetweenBundles: txOptions.waitBetweenMs,
                retryAttempts: txOptions.retryAttempts,
                skipPreflight: txOptions.skipPreflight,
                usePriorityFee: txOptions.usePriorityFee, // 是否使用优先上链
                normalSubmission: !txOptions.usePriorityFee // 是否使用普通上链
            };

            // 调用SDK的批量卖出方法
            const batchResults = await this.sdk.batchSellByPercentage(operations, batchSellOptions);

            // 7. 处理结果
            const successfulTransactions = [];
            const failedTransactions = [];

            for (const result of batchResults) {
                const walletInfo = walletsWithBalance.find(w => w.publicKey === result.wallet);

                if (result.success) {
                    successfulTransactions.push({
                        accountNumber: walletInfo?.accountNumber,
                        publicKey: result.wallet,
                        signature: result.signature,
                        percentage,
                        tokenAmount: result.tokensAmount,
                        timestamp: result.timestamp || new Date().toISOString()
                    });

                    // 更新账户余额
                    try {
                        if (walletInfo) {
                            // 计算剩余代币数量
                            const remainingTokens = BigInt(walletInfo.tokenBalance) - BigInt(result.tokensAmount);

                            await this.updateAccountBalances(
                                walletInfo.wallet,
                                new PublicKey(mintAddress),
                                remainingTokens.toString(),
                                null // 这里SOL金额为null，因为我们不知道确切的SOL收益
                            );
                        }
                    } catch (error) {
                        logger.warn(`更新账户余额失败: ${result.wallet}`, {
                            error: error.message
                        });
                    }
                } else {
                    failedTransactions.push({
                        accountNumber: walletInfo?.accountNumber,
                        publicKey: result.wallet,
                        error: result.error || '交易失败',
                        percentage,
                        tokenAmount: result.tokensAmount
                    });
                }
            }

            // 8. 返回最终结果
            const finalResult = {
                success: successfulTransactions.length > 0,
                summary: {
                    total: wallets.length,
                    attempted: walletsWithBalance.length,
                    successful: successfulTransactions.length,
                    failed: failedTransactions.length,
                    skipped: skippedAccounts.length + insufficientTokenWallets.length
                },
                transactions: {
                    successful: successfulTransactions,
                    failed: failedTransactions
                },
                skippedWallets: [
                    ...skippedAccounts,
                    ...insufficientTokenWallets
                ],
                timestamp: new Date().toISOString()
            };

            logger.info('批量卖出完成:', {
                mintAddress,
                totalWallets: wallets.length,
                successful: successfulTransactions.length,
                failed: failedTransactions.length,
                skipped: finalResult.summary.skipped,
                usedPriorityFee: txOptions.usePriorityFee
            });

            return finalResult;
        } catch (error) {
            logger.error('批量卖出失败:', {
                error: error.message,
                stack: error.stack,
                sellerGroup,
                mintAddress
            });
            throw error;
        }
    }
}