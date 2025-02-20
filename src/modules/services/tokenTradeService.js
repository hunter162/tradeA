import { logger } from '../utils/index.js';
import db from '../db/index.js';
import {Keypair, PublicKey} from '@solana/web3.js';
import {CustomPumpSDK} from "./customPumpSDK.js";
import {AnchorProvider, Wallet} from "@coral-xyz/anchor";

export class TokenTradeService {
    constructor(solanaService, redisService) {
        if (!solanaService) {
            throw new Error('SolanaService is required');
        }
        this.solanaService = solanaService;
        this.redisService = redisService; // 不强制要求 Redis
        
        logger.info('TokenTradeService 初始化完成');
    }

    // 修改使用 Redis 的方法，添加检查
    async _checkRedis() {
        try {
            if (!this.redisService?.client?.isReady) {
                return false;
            }
            return await this.redisService.ping();
        } catch (error) {
            logger.warn('Redis 不可用:', error.message);
            return false;
        }
    }

    // 修改余额缓存方法
    async updateBalanceCache(wallet, tokenAddress) {
        try {
            // 先检查 Redis 连接
            const isRedisAvailable = await this._checkRedis();
            if (!isRedisAvailable) {
                logger.warn('Redis 服务不可用，跳过缓存更新');
                return null;
            }

            const cacheKey = `token:balance:${wallet.publicKey}:${tokenAddress}`;
            const balance = await this.solanaService.getTokenBalance(
                wallet.publicKey,
                tokenAddress
            );
            
            await this.redisService.set(cacheKey, balance.toString(), { EX: 60 });
            
            logger.info('余额缓存已更新:', {
                wallet: wallet.publicKey,
                token: tokenAddress,
                balance: balance.toString()
            });
            
            return balance;
        } catch (error) {
            logger.error('更新余额缓存失败:', {
                error: error.message,
                wallet: wallet?.publicKey,
                token: tokenAddress
            });
            return null;
        }
    }

    // 修改代币信息获取方法
    async getTokenInfo(tokenAddress) {
        try {
            const cacheKey = `token:info:${tokenAddress}`;
            
            // 检查 Redis 连接
            const isRedisAvailable = await this._checkRedis();
            
            // 1. 检查缓存
            if (isRedisAvailable) {
                const cached = await this.redisService.get(cacheKey);
                if (cached) {
                    return JSON.parse(cached);
                }
            }

            // 2. 从链上获取
            const tokenInfo = await this.solanaService.getTokenInfo(tokenAddress);
            if (!tokenInfo) {
                throw new Error('Token not found');
            }
            
            // 3. 更新缓存
            if (isRedisAvailable) {
                await this.redisService.set(
                    cacheKey,
                    JSON.stringify(tokenInfo),
                    { EX: 300 }
                );
            }
            
            return tokenInfo;
        } catch (error) {
            logger.error('获取代币信息失败:', {
                error: error.message,
                tokenAddress
            });
            throw error;
        }
    }

    // 保存交易记录
    async saveTradeTransaction(params) {
        try {
            const {
                signature,
                mint,
                owner,
                type,
                amount,
                tokenAmount,
                tokenDecimals,
                metadata = {}
            } = params;

            // 添加验证
            if (!tokenAmount || !tokenDecimals) {
                logger.warn('Missing tokenAmount or tokenDecimals:', {
                    tokenAmount,
                    tokenDecimals
                });
            }

            const transaction = await db.models.Transaction.create({
                signature,
                mint,
                owner,
                type,
                amount: amount.toString(),
                tokenAmount: tokenAmount?.toString() || '0',
                tokenDecimals: tokenDecimals || 9,
                status: 'success',
                raw: metadata
            });

            logger.info('交易记录已保存:', {
                signature,
                type,
                mint,
                owner,
                tokenAmount: transaction.tokenAmount,
                tokenDecimals: transaction.tokenDecimals
            });

            return transaction;
        } catch (error) {
            logger.error('保存交易记录失败:', {
                error: error.message,
                params
            });
            throw error;
        }
    }

    // 保存失败的交易
    async saveFailedTransaction(params) {
        try {
            const {
                signature,
                mint,
                owner,
                type,
                amount,
                error
            } = params;

            await db.models.Transaction.create({
                signature,
                mint,
                owner,
                type,
                amount: amount?.toString(),
                status: 'failed',
                error: error.message,
                raw: error
            });

            logger.info('失败交易已记录:', {
                signature,
                type,
                error: error.message
            });
        } catch (dbError) {
            logger.error('保存失败交易记录时出错:', {
                error: dbError.message,
                originalError: error.message
            });
        }
    }

    // In TokenTradeService class (tokenTradeService.js)
// In TokenTradeService class (tokenTradeService.js)
    async sellTokens(groupType, accountNumber, tokenAddress, percentage, options = {}) {
        try {
            // 1. 获取钱包
            const keypair = await this.solanaService.walletService.getWalletKeypair(groupType, accountNumber);
            if (!keypair) {
                throw new Error('Wallet not found');
            }

            // 2. 获取代币信息和余额
            const [tokenInfo, tokenBalance] = await Promise.all([
                this.getTokenInfo(tokenAddress),
                this.solanaService.getTokenBalance(
                    keypair.publicKey.toString(),
                    tokenAddress
                )
            ]);

            // 3. 计算卖出数量
            const rawBalance = BigInt(tokenBalance.value.amount);
            const percentageBN = BigInt(Math.floor(percentage * 100));
            const sellAmount = (rawBalance * percentageBN) / BigInt(10000);

            logger.info('计算卖出数量:', {
                tokenAddress,
                rawBalance: rawBalance.toString(),
                percentage,
                sellAmount: sellAmount.toString(),
                decimals: tokenBalance.value.decimals
            });

            // 4. 验证数量
            if (sellAmount <= 0n) {
                throw new Error('Invalid sell amount');
            }

            const validation = await this.validateTokenBalance(
                keypair,
                tokenAddress,
                sellAmount
            );

            if (!validation.isValid) {
                throw new Error(
                    `Insufficient balance. Available: ${validation.available}, Required: ${validation.required}`
                );
            }

            // 5. 创建 SDK 实例
            const sdk = new CustomPumpSDK(this.solanaService.connection);
            sdk.setSolanaService(this.solanaService);

            // 6. 执行卖出
            const result = await sdk.sell(
                keypair,
                new PublicKey(tokenAddress),
                sellAmount,
                {
                    ...options,
                    slippageBasisPoints: options.slippage ? BigInt(options.slippage * 100) : 100n,
                    decimals: tokenInfo.decimals
                }
            );

            // 7. 验证结果
            if (!result || !result.signature) {
                throw new Error('Transaction failed: No signature received');
            }

            // 8. 保存交易记录
            await this.saveTradeTransaction({
                signature: result.signature,
                mint: tokenAddress,
                owner: keypair.publicKey.toString(),
                type: 'sell',
                amount: sellAmount.toString(),
                tokenAmount: sellAmount.toString(),
                tokenDecimals: tokenInfo.decimals,
                metadata: {
                    percentage,
                    options,
                    rawBalance: rawBalance.toString(),
                    validation
                }
            });

            // 9. 更新余额缓存
            await this.updateBalanceCache(keypair, tokenAddress);

            return {
                success: true,
                signature: result.signature,
                amount: sellAmount.toString(),
                owner: keypair.publicKey.toString(),
                mint: tokenAddress,
                tokenDecimals: tokenInfo.decimals
            };

        } catch (error) {
            logger.error('卖出代币失败:', {
                error: error.message,
                params: {
                    groupType,
                    accountNumber,
                    tokenAddress,
                    percentage,
                    options
                },
                stack: error.stack
            });

            // 保存失败记录
            await this.saveFailedTransaction({
                mint: tokenAddress,
                owner: keypair?.publicKey?.toString(),
                type: 'sell',
                error
            });

            throw error;
        }
    }

} 