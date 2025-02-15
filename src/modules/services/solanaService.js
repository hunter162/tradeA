import pkg from '@project-serum/anchor';
const { BN } = pkg;

import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    clusterApiUrl,
    Transaction as SolanaTransaction,
    SystemProgram
} from "@solana/web3.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import { Wallet } from "@coral-xyz/anchor";
import pumpPkg from 'pumpdotfun-sdk';

const { DEFAULT_DECIMALS, MPL_TOKEN_METADATA_PROGRAM_ID } = pumpPkg;
import { CustomPumpSDK } from './customPumpSDK.js';
import { logger } from '../utils/index.js';
import { PinataService } from './pinataService.js';
import { config } from '../../config/index.js';
import path from 'path';
import FormData from 'form-data';
import fetch from 'node-fetch';
import fs from 'fs';
import {
    getAssociatedTokenAddress,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { JitoService } from './jitoService.js';
import bs58 from 'bs58';
import { SOLANA_CONFIG } from '../../config/solana.js';
import { RedisService } from './redisService.js';
import db from '../db/index.js';
import { ErrorCodes, SolanaServiceError, handleError } from '../utils/errors.js';
import { AccountLayout } from "@solana/spl-token";
import { WebSocketManager } from './webSocketManager.js';
import { CustomError } from '../utils/errors.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Metadata } = require('@metaplex-foundation/mpl-token-metadata');
const { TokenMetadataProgram } = require('@metaplex-foundation/mpl-token-metadata');

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

export class SolanaService {
    constructor(config) {
        // 初始化 RPC 节点池
        this.endpoints = process.env.SOLANA_RPC_ENDPOINTS
            ? JSON.parse(process.env.SOLANA_RPC_ENDPOINTS)
            : ['https://api.mainnet-beta.solana.com'];

        // 记录节点状态
        this.nodeStats = new Map(this.endpoints.map(endpoint => [
            endpoint,
            {
                latency: 0,
                successRate: 1,
                errorCount: 0,
                lastCheck: Date.now()
            }
        ]));

        // 初始化连接
        this.currentEndpoint = this.endpoints[0];
        this.connection = new Connection(this.currentEndpoint);

        logger.info('初始化 Solana RPC 节点池:', {
            totalEndpoints: this.endpoints.length,
            currentEndpoint: this.currentEndpoint.replace(/api-key=([^&]+)/, 'api-key=***')
        });

        // 创建 WebSocket 管理器
        this.wsManager = new WebSocketManager(this.currentEndpoint);

        // 其他初始化...
        this.sdk = null;
        this.walletService = null;
        this.redis = null;
        this.tokenSubscriptionService = null;

        // 记录每个节点的状态
        this.endpointStats = new Map(this.endpoints.map(endpoint => [endpoint, {
            successCount: 0,
            errorCount: 0,
            lastError: null,
            lastSuccess: null,
            avgLatency: 0,
            isRateLimited: false
        }]));

        this.subscriptions = new Map();
        this.retryCount = 0;
        this.maxRetries = 3;
        this.rpcStats = new Map();
        this.lastHealthCheck = 0;
        this.healthCheckInterval = 30000; // 30秒检查一次

        // 调整超时设置
        this.timeoutSettings = {
            requestTimeout: 10000,     // 单次请求超时：10秒
            confirmTimeout: 30000,     // 交易确认超时：30秒
            retryDelay: 1000          // 重试延迟：1秒
        };

        logger.info('初始化 Solana 服务:', {
            totalEndpoints: this.endpoints.length,
            currentEndpoint: this.currentEndpoint.replace(/api-key=([^&]+)/, 'api-key=***')
        });

        // 保存活跃订阅
        this.activeSubscriptions = new Map();
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

    async createConnection() {
        try {
            const endpoint = this.getNextEndpoint();

            // 使用更短的超时时间
            this.connection = new Connection(endpoint, {
                ...SOLANA_CONFIG.connectionConfig,
                wsEndpoint: endpoint.replace('https', 'wss'),
                confirmTransactionInitialTimeout: this.timeoutSettings.confirmTimeout,
                httpHeaders: {
                    'Cache-Control': 'no-cache'
                }
            });

            logger.info('创建 Solana 连接:', {
                endpoint: endpoint.replace(/api-key=([^&]+)/, 'api-key=***'),
                timeout: this.timeoutSettings.confirmTimeout
            });

            return true;
        } catch (error) {
            logger.error('创建连接失败:', error);
            return false;
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

    async getBalance(publicKey) {
        try {
            const pubKey = typeof publicKey === 'string'
                ? new PublicKey(publicKey)
                : publicKey;

            // 从缓存获取余额
            if (this.redis) {
                const cachedBalance = await this.redis.get(
                    CACHE_KEYS.BALANCE_SOL(pubKey.toString())
                );
                if (cachedBalance) {
                    // 缓存中存储的是 SOL，直接返回
                    const balanceInSOL = parseFloat(cachedBalance);
                    logger.debug('使用缓存的余额:', {
                        publicKey: pubKey.toString(),
                        balanceInSOL,
                        balanceInLamports: balanceInSOL * LAMPORTS_PER_SOL
                    });
                    return balanceInSOL;
                }
            }

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
                    { EX: 60 }
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
    // 订阅代币余额变化
    async subscribeToTokenBalance(publicKey, tokenAddress) {
        try {
            if (!this.wsManager) {
                logger.warn('WebSocket 管理器未初始化');
                return;
            }

            const tokenAccount = await this.findAssociatedTokenAddress(
                new PublicKey(tokenAddress),
                publicKey
            );

            const subscription = await this.wsManager.subscribeToAccount(
                tokenAccount,
                async (accountInfo) => {
                    try {
                        const tokenAccountInfo = AccountLayout.decode(accountInfo.data);
                        const newBalance = tokenAccountInfo.amount;

                        // 更新缓存
                        if (this.redis) {
                            try {
                                await this.redis.set(
                                    CACHE_KEYS.TOKEN_BALANCE(publicKey.toString(), tokenAddress),
                                    JSON.stringify({
                                        amount: newBalance.toString(),
                                        // 其他字段需要从代币元数据获取
                                    }),
                                    { EX: 60 }
                                );
                            } catch (cacheError) {
                                logger.warn('更新代币余额缓存失败:', cacheError);
                            }
                        }

                        // 发送余额变化事件
                        this.emit('tokenBalanceChange', {
                            publicKey: publicKey.toString(),
                            tokenAddress,
                            tokenAccount: tokenAccount.toString(),
                            oldBalance: null, // 可以从缓存获取旧余额
                            newBalance: newBalance.toString(),
                            timestamp: Date.now()
                        });
                    } catch (error) {
                        logger.error('处理代币余额更新失败:', error);
                    }
                }
            );

            logger.info('已订阅代币余额变化:', {
                publicKey: publicKey.toString(),
                tokenAddress,
                tokenAccount: tokenAccount.toString(),
                subscriptionId: subscription.id
            });

            return subscription;
        } catch (error) {
            logger.error('订阅代币余额变化失败:', {
                error: error.message,
                publicKey: publicKey.toString(),
                tokenAddress
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

    async buyTokens({ groupType, accountNumber, tokenAddress, amountSol, slippage, usePriorityFee, options }) {
        try {
            // 1. 获取钱包
            const wallet = await this.walletService.getWalletKeypair(groupType, accountNumber);
            if (!wallet) {
                throw new Error(`Wallet not found: ${groupType}-${accountNumber}`);
            }

            // 2. 转换参数
            const buyAmountSol = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));
            const slippageBasisPoints = BigInt(Math.floor(slippage * 100));

            logger.info('开始购买代币:', {
                wallet: wallet.publicKey.toString(),
                tokenAddress,
                amountSol,
                slippage
            });

            // 3. 直接使用 SDK 的 buy 方法
            const result = await this.sdk.buy(
                wallet,  // Keypair
                new PublicKey(tokenAddress),  // PublicKey
                buyAmountSol,  // BigInt
                slippageBasisPoints,  // BigInt
                usePriorityFee ? await this.calculatePriorityFee() : undefined,
                'confirmed'  // commitment
            );

            logger.info('代币购买成功:', {
                signature: result.signature,
                tokenAddress,
                amountSol,
                wallet: wallet.publicKey.toString()
            });

            return result;
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

    async sellTokens(groupType, accountNumber, tokenAddress, percentage, options = {}) {
        try {
            logger.info('开始卖出代币:', {groupType, accountNumber, tokenAddress})
            // 1. Get wallet keypair
            const keypair = await this.walletService.getWalletKeypair(groupType, accountNumber);
            logger.info("keypair",keypair);
            if (!keypair) {
                throw new Error('Failed to get wallet keypair');
            }
            logger.info('开始卖出代币2:', {groupType, accountNumber, tokenAddress})
            // 2. Get token info and balance
            const tokenInfo = await this.getTokenInfo(tokenAddress);
            if (!tokenInfo) {
                throw new Error(`Token ${tokenAddress} not found`);
            }

            // 3. Calculate sell amount based on percentage
            const tokenAccount = await getAssociatedTokenAddress(
                new PublicKey(tokenAddress),
                keypair.publicKey
            );

            const tokenBalance = await this.connection.getTokenAccountBalance(tokenAccount);
            if (!tokenBalance?.value) {
                throw new Error('Failed to get token balance');
            }

            const sellAmount = BigInt(Math.floor(
                Number(tokenBalance.value.amount) * (percentage / 100)
            ));

            if (sellAmount <= 0n) {
                throw new Error('Invalid sell amount');
            }

            // 4. Call SDK's sell method
            const result = await this.sdk.sell(
                keypair, // Pass the Keypair directly
                new PublicKey(tokenAddress),
                sellAmount,
                BigInt(options.slippage || 100), // 1% default slippage
                options.priorityFeeSol ? {
                    tipAmountSol: options.priorityFeeSol
                } : undefined,
                {
                    usePriorityFee: options.usePriorityFee,
                    priorityType: options.priorityType,
                    deadline: options.deadline || 60
                }
            );

            logger.info('代币卖出成功:', {
                signature: result.signature,
                wallet: keypair.publicKey.toString(),
                token: tokenAddress,
                amount: sellAmount.toString(),
                percentage: `${percentage}%`
            });

            return result;

        } catch (error) {
            logger.error('卖出代币失败:', {
                error: error.message,
                tokenAddress,
                params: {
                    groupType,
                    accountNumber,
                    percentage,
                    options
                },
                stack: error.stack
            });
            throw error;
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

        this.initializeConnection(nextRpc.endpoint);
        this.currentEndpoint = nextRpc.endpoint;

        logger.info('切换到新的 RPC 节点', {
            endpoint: nextRpc.endpoint,
            latency: `${nextRpc.latency}ms`,
            reason: 'performance'
        });
    }

    // 修改 withRetry 方法
    async withRetry(operation, maxRetries = 3) {
        let lastError;
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                logger.warn(`操作失败，尝试重试 (${i + 1}/${maxRetries}):`, error);
                if (i < maxRetries - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
                    await this.createConnection(); // 切换节点重试
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

    // 批量订阅余额变动
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
            // 将 SOL 转换为 lamports
            const amountInLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
            const estimatedFee = 5000; // 预估交易费用 (lamports)
            const totalRequired = amountInLamports + estimatedFee;

            // 检查余额
            const balanceCheck = await this.checkBalance(fromWallet.publicKey, amountSol + (estimatedFee / LAMPORTS_PER_SOL));

            if (!balanceCheck.hasEnoughBalance) {
                throw new Error(`Insufficient balance. Need ${(Math.abs(balanceCheck.difference) / LAMPORTS_PER_SOL).toFixed(9)} more SOL`);
            }

            // 创建转账交易
            const transaction = new SolanaTransaction();

            // 获取最新的 blockhash
            const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();

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
                    { EX: 60 }
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
            const { blockhash } = await this.connection.getLatestBlockhash();
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

    // 修改 createAndBuy 方法，直接使用 SDK 的 createToken 方法，但添加模拟步骤

    async createAndBuy({ groupType, accountNumber, metadata, solAmount, options = {} }) {
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

            // 1. 获取钱包
            const wallet = await this.walletService.getWalletKeypair(groupType, accountNumber);
            if (!wallet) {
                throw new Error(`Wallet not found: ${groupType}-${accountNumber}`);
            }

            // 2. 生成 mint keypair
            const mint = Keypair.generate();
            logger.info('生成 mint keypair:', {
                mint: mint.publicKey.toString()
            });

            // 3. 转换 SOL 金额为 lamports
            const lamports = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL));

            // 4. 执行创建和购买操作
            const result = await this.sdk.createAndBuy(
                wallet,    // creator keypair
                mint,      // mint keypair
                metadata,  // token metadata
                lamports,  // buy amount in lamports
                {
                    ...options,
                    slippageBasisPoints: BigInt(options.slippageBasisPoints || 100)
                }
            );

            // 确保结果包含必要的字段
            if (!result || !result.signature) {
                throw new Error('Invalid response from createAndBuy operation');
            }

            // 构建统一的返回结果
            const mintAddress = mint.publicKey.toString();

            // 5. 创建代币数据记录
            const tokenData = {
                mint: mintAddress,
                owner: wallet.publicKey.toString(),
                name: metadata.name,
                symbol: metadata.symbol,
                description: metadata.description || '',
                image: metadata.image || '',
                external_url: metadata.external_url || '',
                creatorPublicKey: wallet.publicKey.toString(),
                groupType,
                accountNumber,
                metadata: metadata,
                uri: result.metadata?.uri || '',
                status: 'active'
            };

            // 6. 保存到数据库
            const savedToken = await db.models.Token.create(tokenData);

            // 7. 记录交易
            await db.models.Transaction.create({
                signature: result.signature,
                mint: mintAddress,
                owner: wallet.publicKey.toString(),
                type: 'create_and_buy',
                amount: solAmount.toString(),
                status: 'success',
                raw: {
                    ...result,
                    solAmount: solAmount.toString(),
                    metadata,
                    timestamp: new Date().toISOString()
                }
            });

            // 8. 设置代币跟踪
            if (this.redis) {
                const tokenBalanceKey = CACHE_KEYS.TOKEN_BALANCE(wallet.publicKey.toString(), mintAddress);
                await this.redis.set(tokenBalanceKey, result.tokenAmount || '0', { EX: 60 });
            }

            // 9. 订阅代币余额变动
            await this.setupTokenTracking(
                wallet.publicKey.toString(),
                mintAddress,
                result.tokenAmount || '0'
            );

            logger.info('代币创建和购买成功:', {
                mint: mintAddress,
                owner: wallet.publicKey.toString(),
                signature: result.signature,
                solAmount: solAmount.toString()
            });

            return {
                success: true,
                signature: result.signature,
                mint: mintAddress,
                owner: wallet.publicKey.toString(),
                solAmount: solAmount.toString(),
                tokenAmount: result.tokenAmount || '0',
                metadata: {
                    name: metadata.name,
                    symbol: metadata.symbol,
                    uri: result.metadata?.uri || ''
                }
            };

        } catch (error) {
            logger.error('创建和购买代币失败:', {
                error: error.message,
                stack: error.stack,
                groupType,
                accountNumber,
                metadata: metadata ? {
                    name: metadata.name,
                    symbol: metadata.symbol
                } : null
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

                        // 更新数据库
                        await this.updateTokenBalanceDB(owner, mint, newBalance);

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

    // 获取代币余额（带缓存）
    async getTokenBalance(owner, mint) {
        try {
            // 1. 尝试从缓存获取
            const cachedBalance = await this.getCachedTokenBalance(owner, mint);
            if (cachedBalance !== null) {
                return cachedBalance;
            }

            // 2. 从链上获取
            const tokenAccount = await this.findAssociatedTokenAddress(owner, mint);
            const accountInfo = await this.connection.getAccountInfo(tokenAccount);

            if (!accountInfo) {
                return BigInt(0);
            }

            const balance = await this.parseTokenAccountData(accountInfo.data);

            // 3. 更新缓存
            await this.cacheTokenBalance(owner, mint, balance);

            // 4. 确保有订阅
            await this.setupTokenSubscription(owner, mint);

            return balance;
        } catch (error) {
            logger.error('获取代币余额失败:', {
                error: error.message,
                owner,
                mint
            });
            throw error;
        }
    }

    // 清理方法
    async cleanup() {
        try {
            // 清理所有 WebSocket 订阅
            for (const [key, subId] of this.activeSubscriptions.entries()) {
                try {
                    await this.wsManager.unsubscribeFromAccount(subId);
                    logger.debug('清理订阅成功:', { key, subscriptionId: subId });
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
    async subscribeToBalanceChanges(accounts) {
        try {
            const subscriptions = [];
            for (const wallet of accounts) {
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
                totalCount: accounts.length
            });

            return subscriptions;
        } catch (error) {
            logger.error('批量订阅失败:', {
                error: error.message,
                accountCount: accounts.length
            });
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
            logger.info('获取代币价格:', { tokenAddress });

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
                    { EX: 60 } // 缓存1分钟
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
    updateNodeStats(endpoint, { latency, success, error }) {
        const stats = this.nodeStats.get(endpoint);
        if (!stats) return;

        if (success) {
            stats.latency = (stats.latency * 0.7) + (latency * 0.3); // 加权平均延迟
            stats.successRate = (stats.successRate * 0.9) + 0.1; // 逐渐提升成功率
            stats.errorCount = Math.max(0, stats.errorCount - 1); // 减少错误计数
        } else {
            stats.errorCount++;
            stats.successRate = Math.max(0.1, stats.successRate * 0.8); // 降低成功率但保持最小值
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
                const { blockhash, lastValidBlockHeight } =
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

                logger.info('交易已发送，等待确认...', { signature });

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
            // 1. 设置初始缓存
            if (this.redis) {
                const tokenBalanceKey = CACHE_KEYS.TOKEN_BALANCE(ownerAddress, mintAddress);
                await this.redis.set(tokenBalanceKey, initialBalance, { EX: 60 });
            }

            // 2. 设置 WebSocket 订阅
            const subscriptionId = await this.setupTokenSubscription(ownerAddress, mintAddress);

            // 3. 验证订阅是否成功
            if (!subscriptionId) {
                throw new Error('Failed to setup token subscription');
            }

            // 4. 添加到活跃订阅列表
            const subscriptionKey = `${ownerAddress}:${mintAddress}`;
            this.activeSubscriptions.set(subscriptionKey, {
                id: subscriptionId,
                owner: ownerAddress,
                mint: mintAddress,
                lastUpdate: Date.now()
            });

            logger.info('代币跟踪设置成功:', {
                owner: ownerAddress,
                mint: mintAddress,
                subscriptionId,
                initialBalance
            });

            return true;
        } catch (error) {
            logger.error('设置代币跟踪失败:', {
                error: error.message,
                owner: ownerAddress,
                mint: mintAddress
            });

            // 5. 重试逻辑
            return await this.retrySetupTracking(ownerAddress, mintAddress, initialBalance);
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

    // 修改: 改进 WebSocket 订阅处理
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

                        // 更新数据库
                        await this.updateTokenBalanceDB(owner, mint, newBalance);

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
                logger.warn('代币元数据不存在:', { tokenAddress });
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
                    logger.warn('Bonding curve 账户不存在:', { tokenAddress });
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
}