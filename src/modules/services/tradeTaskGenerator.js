import { Redis } from 'ioredis';
import { logger } from '../utils/index.js';

export class TradeTaskGenerator {
    constructor(redisService) {
        this.redis = redisService;
        this.strategies = new Map();
    }

    // 添加新的交易策略
    async addStrategy(strategy) {
        try {
            // 1. 验证策略
            this.validateStrategy(strategy);
            
            // 2. 保存策略
            await this.redis.hSet(
                'trade:strategies',
                strategy.id,
                JSON.stringify(strategy)
            );
            
            // 3. 生成批次号
            const batchId = `batch_${Date.now()}_${strategy.id}`;
            
            // 4. 解析账号范围
            const accounts = this.parseAccountRange(strategy.accounts.accountRange);
            
            // 5. 生成交易任务
            for (const accountNumber of accounts) {
                if (strategy.rules.buy) {
                    await this.generateBuyTask(strategy, accountNumber, batchId);
                }
                if (strategy.rules.sell) {
                    await this.generateSellTask(strategy, accountNumber, batchId);
                }
            }

            return batchId;
        } catch (error) {
            logger.error('生成交易任务失败:', error);
            throw error;
        }
    }

    // 生成买入任务
    async generateBuyTask(strategy, accountNumber, batchId) {
        const task = {
            id: `buy_${Date.now()}_${accountNumber}`,
            strategyId: strategy.id,
            type: 'buy',
            params: {
                groupType: strategy.accounts.groupType,
                accountNumber,
                token: strategy.token,
                amount: strategy.rules.buy.amount,
                options: {
                    slippage: strategy.rules.buy.slippage,
                    usePriorityFee: strategy.rules.buy.usePriorityFee
                }
            },
            batchId,
            timestamp: Date.now(),
            retryCount: 0
        };

        await this.redis.rPush(QUEUE_KEYS.TRADE_TASKS, JSON.stringify(task));
    }

    // 生成卖出任务
    async generateSellTask(strategy, accountNumber, batchId) {
        const task = {
            id: `sell_${Date.now()}_${accountNumber}`,
            strategyId: strategy.id,
            type: 'sell',
            params: {
                groupType: strategy.accounts.groupType,
                accountNumber,
                token: strategy.token,
                percentage: strategy.rules.sell.percentage,
                options: {
                    slippage: strategy.rules.sell.slippage,
                    usePriorityFee: strategy.rules.sell.usePriorityFee
                }
            },
            batchId,
            timestamp: Date.now(),
            retryCount: 0
        };

        await this.redis.rPush(QUEUE_KEYS.TRADE_TASKS, JSON.stringify(task));
    }
} 