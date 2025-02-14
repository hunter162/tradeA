import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import { logger } from '../utils/index.js';
import { ErrorCodes, ErrorMessages } from '../../constants/errorCodes.js';
import { CustomError } from '../utils/errors.js';

export class TokenSubscriptionService {
    constructor(redisService, solanaService) {
        this.redisService = redisService; // 不强制要求 Redis
        this.solanaService = solanaService;
        this.subscriptions = new Map();
        this.SUBSCRIPTION_KEY = 'token:subscriptions';
        this.BALANCE_KEY_PREFIX = 'token:balance:';
        this.BALANCE_TTL = parseInt(process.env.REDIS_BALANCE_TTL || '300'); // 默认5分钟
    }

    async initialize() {
        try {
            // 检查 Redis 是否可用
            const isRedisAvailable = await this._checkRedis();
            
            if (isRedisAvailable) {
                await this._loadExistingSubscriptions();
            } else {
                logger.warn('Redis 不可用，跳过加载现有订阅');
            }

            logger.info('Token 订阅服务初始化完成', {
                subscriptionCount: this.subscriptions.size
            });
        } catch (error) {
            logger.error('Token 订阅服务初始化失败:', error);
            throw error;
        }
    }

    async _checkRedis() {
        try {
            if (!this.redisService?.client?.isReady) {
                return false;
            }
            return await this.redisService.ping();
        } catch (error) {
            logger.warn('Redis 检查失败:', error.message);
            return false;
        }
    }

    async _loadExistingSubscriptions() {
        try {
            // 从 Redis 加载现有订阅
            const existingSubscriptions = await this.redisService.hGetAll(this.SUBSCRIPTION_KEY);
            
            if (existingSubscriptions) {
                for (const [key, value] of Object.entries(existingSubscriptions)) {
                    try {
                        // 解析存储的 JSON 数据
                        const subscriptionData = JSON.parse(value);
                        if (subscriptionData && subscriptionData.owner && subscriptionData.mint) {
                            await this.subscribeToTokenBalance(
                                subscriptionData.owner,
                                subscriptionData.mint
                            );
                        }
                    } catch (parseError) {
                        logger.warn('解析订阅数据失败:', {
                            key,
                            value,
                            error: parseError.message
                        });
                        // 删除无效的数据
                        await this.redisService.hDel(this.SUBSCRIPTION_KEY, key);
                    }
                }
            }
        } catch (error) {
            logger.error('加载现有订阅失败:', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    async init() {
        return this.initialize();
    }

    async subscribeToTokenBalance(owner, mint) {
        try {
            // 验证输入
            if (!owner || !mint || typeof owner !== 'string' || typeof mint !== 'string') {
                throw new Error('Invalid owner or mint address');
            }

            // 验证地址格式
            if (!owner.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/) || 
                !mint.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
                throw new Error('Invalid Solana address format');
            }

            const subscriptionKey = `${owner}:${mint}`;
            
            // 检查是否已经订阅
            if (this.subscriptions.has(subscriptionKey)) {
                logger.debug('已存在的代币余额订阅:', { owner, mint });
                return;
            }

            // 创建订阅
            const ownerPubkey = new PublicKey(owner);
            const mintPubkey = new PublicKey(mint);
            
            const subscriptionId = await this.solanaService.wsManager.subscribeToAccount(
                ownerPubkey,
                async (accountInfo) => {
                    // 更新 Redis 缓存
                    const balanceKey = `${this.BALANCE_KEY_PREFIX}${owner}:${mint}`;
                    await this.redisService.set(balanceKey, accountInfo.lamports.toString(), {
                        EX: this.BALANCE_TTL
                    });

                    logger.debug('代币余额更新:', {
                        owner,
                        mint,
                        balance: accountInfo.lamports.toString()
                    });
                }
            );

            // 保存订阅信息
            this.subscriptions.set(subscriptionKey, subscriptionId);
            await this.redisService.hSet(
                this.SUBSCRIPTION_KEY,
                subscriptionKey,
                JSON.stringify({
                    owner,
                    mint,
                    subscriptionId,
                    timestamp: Date.now()
                })
            );

            logger.info('创建代币余额订阅:', {
                owner,
                mint,
                subscriptionId
            });

            return subscriptionId;
        } catch (error) {
            logger.error('代币余额订阅失败:', {
                error: error.message,
                owner,
                mint
            });
            throw error;
        }
    }

    async unsubscribeFromTokenBalance(owner, mint) {
        try {
            const subscriptionKey = `${owner}:${mint}`;
            const subscriptionId = this.subscriptions.get(subscriptionKey);

            if (!subscriptionId) {
                logger.warn('未找到代币余额订阅:', { owner, mint });
                return;
            }

            // 取消 WebSocket 订阅
            await this.solanaService.wsManager.unsubscribeFromAccount(subscriptionId);

            // 清理订阅信息
            this.subscriptions.delete(subscriptionKey);
            await this.redisService.hDel(this.SUBSCRIPTION_KEY, subscriptionKey);

            logger.info('取消代币余额订阅:', {
                owner,
                mint,
                subscriptionId
            });
        } catch (error) {
            logger.error('取消代币余额订阅失败:', {
                error: error.message,
                owner,
                mint
            });
            throw error;
        }
    }

    async cleanup() {
        try {
            // 清理所有订阅
            for (const [key, subscriptionId] of this.subscriptions.entries()) {
                const [owner, mint] = key.split(':');
                await this.unsubscribeFromTokenBalance(owner, mint);
            }

            logger.info('Token 订阅服务清理完成');
        } catch (error) {
            logger.error('Token 订阅服务清理失败:', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    getCacheKey(ownerAddress, mintAddress) {
        return `token:balance:${ownerAddress}:${mintAddress}`;
    }

    async batchSubscribeToTokenBalances(subscriptions) {
        try {
            logger.info('开始批量订阅代币余额:', {
                accountCount: subscriptions.length
            });

            const results = {
                success: [],
                failed: []
            };

            for (const { ownerAddress, mintAddresses } of subscriptions) {
                for (const mintAddress of mintAddresses) {
                    try {
                        const success = await this.subscribeToTokenBalance(ownerAddress, mintAddress);
                        if (success) {
                            results.success.push({ ownerAddress, mintAddress });
                        } else {
                            results.failed.push({ ownerAddress, mintAddress });
                        }
                    } catch (error) {
                        results.failed.push({ ownerAddress, mintAddress, error: error.message });
                    }
                }
            }

            logger.info('批量订阅完成:', {
                totalAccounts: subscriptions.length,
                successCount: results.success.length,
                failedCount: results.failed.length
            });

            return results;
        } catch (error) {
            logger.error('批量订阅失败:', error);
            throw error;
        }
    }

    // 批量取消订阅
    async batchUnsubscribe(subscriptions) {
        const results = {
            success: [],
            failed: []
        };

        for (const { ownerAddress, mintAddresses } of subscriptions) {
            for (const mintAddress of mintAddresses) {
                try {
                    const key = this.getCacheKey(ownerAddress, mintAddress);
                    const subscription = this.subscriptions.get(key);
                    
                    if (subscription) {
                        await this.solanaService.connection.removeAccountChangeListener(subscription.subscriptionId);
                        this.subscriptions.delete(key);
                        await this.redisService.hDel('token:subscriptions', key);
                        
                        results.success.push({
                            ownerAddress,
                            mintAddress
                        });
                    }
                } catch (error) {
                    results.failed.push({
                        ownerAddress,
                        mintAddress,
                        error: error.message
                    });
                }
            }
        }

        logger.info('批量取消订阅完成:', {
            successCount: results.success.length,
            failedCount: results.failed.length
        });

        return results;
    }

    // 从 Redis 恢复订阅
    async restoreSubscriptions() {
        try {
            const savedSubscriptions = await this.redisService.hGetAll('token:subscriptions');
            
            for (const [key, value] of Object.entries(savedSubscriptions)) {
                const { ownerAddress, mintAddress } = JSON.parse(value);
                await this.subscribeToTokenBalance(ownerAddress, mintAddress);
            }

            logger.info('恢复代币订阅完成:', {
                count: Object.keys(savedSubscriptions).length
            });
        } catch (error) {
            logger.error('恢复代币订阅失败:', {
                error: error.message
            });
        }
    }

    // 取消订阅
    async unsubscribe(key) {
        const subscription = this.subscriptions.get(key);
        if (subscription) {
            await this.solanaService.connection.removeAccountChangeListener(subscription.subscriptionId);
            this.subscriptions.delete(key);
            await this.redisService.hDel('token:subscriptions', key);
        }
    }

    async getTokenBalance(ownerAddress, mintAddress) {
        try {
            // 确保输入是有效的 PublicKey
            const owner = new PublicKey(ownerAddress);
            const mint = new PublicKey(mintAddress);

            // 获取代币账户地址
            const tokenAccount = await getAssociatedTokenAddress(
                mint,
                owner,
                false,
                TOKEN_PROGRAM_ID
            );

            // 获取代币账户信息
            const accountInfo = await this.solanaService.connection.getTokenAccountBalance(tokenAccount);
            
            return accountInfo.value.amount;
        } catch (error) {
            if (error.message.includes('could not find account')) {
                throw new CustomError(
                    ErrorCodes.TOKEN.ACCOUNT_NOT_FOUND,
                    `代币账户不存在: ${mintAddress}`
                );
            }
            if (error.message.includes('Invalid public key')) {
                throw new CustomError(
                    ErrorCodes.TOKEN.INVALID_MINT,
                    `无效的代币地址: ${mintAddress}`
                );
            }
            logger.error('获取代币余额失败:', {
                error: error.message,
                owner: ownerAddress,
                mint: mintAddress
            });
            throw new CustomError(
                ErrorCodes.TOKEN.BALANCE_QUERY_FAILED,
                `获取代币余额失败: ${error.message}`
            );
        }
    }
} 