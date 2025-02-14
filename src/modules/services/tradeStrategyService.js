import { createClient } from 'redis';
import { logger } from '../utils/index.js';
import db from '../db/index.js';
import { ErrorCodes } from '../../constants/errorCodes.js';
import { v4 as uuidv4 } from 'uuid';
import { RedisService } from './redisService.js';

const TRADE_QUEUE = 'trade:queue';
const STRATEGY_KEY_PREFIX = 'trade:strategy:';

export class TradeStrategyService {
    constructor(solanaService, redisService) {
        this.solanaService = solanaService;
        this.redisService = redisService;
        this.QUEUE_KEY = 'trade:strategy:queue';
        this.LOCK_KEY_PREFIX = 'trade:strategy:lock:';
        this.STRATEGY_KEY = 'trade:strategy:';
    }

    async initialize() {
        try {
            // 1. 恢复未完成的策略
            const activeStrategies = await db.models.TradeStrategy.findAll({
                where: {
                    status: 'ACTIVE'
                }
            });

            // 2. 重新加入队列
            for (const strategy of activeStrategies) {
                await this.queueStrategy(strategy);
            }

            logger.info('交易策略服务初始化完成', {
                activeStrategies: activeStrategies.length
            });
        } catch (error) {
            logger.error('交易策略服务初始化失败:', error);
            throw error;
        }
    }

    async createStrategy(params) {
        const transaction = await db.sequelize.transaction();
        
        try {
            const batchId = uuidv4();
            
            const strategy = await db.models.TradeStrategy.create({
                ...params,
                batchId,
                status: 'pending'
            }, { transaction });

            await transaction.commit();
            
            // 发送到 Redis 队列
            await this.queueStrategy(strategy);
            
            return strategy;
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    }

    async executeStrategy(strategy) {
        const lockKey = `${this.LOCK_KEY_PREFIX}${strategy.id}`;

        try {
            // 1. 获取锁
            const locked = await this.redisService.set(
                lockKey,
                'locked',
                'NX',
                'EX',
                60 // 1分钟锁
            );

            if (!locked) {
                logger.warn('策略正在执行中:', strategy.id);
                return;
            }

            // 2. 执行策略
            if (strategy.type === 'SINGLE') {
                await this._executeSingleStrategy(strategy);
            } else {
                await this._executeComboStrategy(strategy);
            }

            // 3. 更新策略状态
            await this._updateStrategyStatus(strategy);

            // 4. 检查是否需要继续执行
            if (strategy.status === 'ACTIVE') {
                await this.queueStrategy(strategy);
            }

        } catch (error) {
            logger.error('执行交易策略失败:', {
                strategyId: strategy.id,
                error: error.message
            });
            await this._handleExecutionError(strategy, error);
        } finally {
            // 释放锁
            await this.redisService.del(lockKey);
        }
    }

    async generateTasks(strategy) {
        const accounts = this._parseAccountRange(strategy.accountRange);
        const tasks = [];

        for (const account of accounts) {
            if (strategy.tradeType === 'buy' || strategy.tradeType === 'buy_and_sell') {
                tasks.push(this._createBuyTask(strategy, account));
            }
            
            if (strategy.tradeType === 'sell' || strategy.tradeType === 'buy_and_sell') {
                tasks.push(this._createSellTask(strategy, account));
            }
        }

        return tasks;
    }

    _parseAccountRange(range) {
        const [start, end] = range.split('-').map(Number);
        return Array.from(
            { length: end - start + 1 },
            (_, i) => start + i
        );
    }

    _createBuyTask(strategy, accountNumber) {
        return {
            strategyId: strategy.id,
            type: 'buy',
            groupType: strategy.groupType,
            accountNumber,
            tokenAddress: strategy.tokenAddress,
            params: {
                amount: strategy.params.buyAmount,
                slippage: strategy.params.slippage,
                usePriorityFee: strategy.params.usePriorityFee,
                priorityFeeSol: strategy.params.priorityFeeSol
            }
        };
    }

    _createSellTask(strategy, accountNumber) {
        return {
            strategyId: strategy.id,
            type: 'sell', 
            groupType: strategy.groupType,
            accountNumber,
            tokenAddress: strategy.tokenAddress,
            params: {
                percentage: strategy.params.sellPercentage,
                slippage: strategy.params.slippage,
                usePriorityFee: strategy.params.usePriorityFee,
                priorityFeeSol: strategy.params.priorityFeeSol
            }
        };
    }

    // 获取策略详情
    async getStrategy(strategyId) {
        try {
            // 先从缓存获取
            const cached = await this.redisService?.get(this.STRATEGY_KEY + strategyId);
            if (cached) {
                return JSON.parse(cached);
            }

            // 从数据库获取
            const strategy = await db.models.TradeStrategy.findByPk(strategyId);
            if (strategy) {
                await this._cacheStrategy(strategy);
            }
            return strategy;
        } catch (error) {
            logger.error('获取策略失败:', error);
            throw error;
        }
    }

    // 更新策略状态
    async updateStrategyStatus(strategyId, status, metadata = {}) {
        try {
            const strategy = await db.models.TradeStrategy.findByPk(strategyId);
            if (!strategy) {
                throw new Error('Strategy not found');
            }

            await strategy.update({
                status,
                metadata: { ...strategy.metadata, ...metadata },
                lastExecutionTime: new Date()
            });

            await this._cacheStrategy(strategy);

            logger.info('更新策略状态成功:', {
                strategyId,
                status,
                metadata
            });

            return strategy;
        } catch (error) {
            logger.error('更新策略状态失败:', error);
            throw error;
        }
    }

    // 获取待执行的策略列表
    async getPendingStrategies() {
        try {
            return await db.models.TradeStrategy.findAll({
                where: {
                    status: 'pending',
                    nextExecutionTime: {
                        [db.Sequelize.Op.lte]: new Date()
                    }
                },
                order: [['nextExecutionTime', 'ASC']]
            });
        } catch (error) {
            logger.error('获取待执行策略失败:', error);
            throw error;
        }
    }

    // 缓存策略
    async _cacheStrategy(strategy) {
        try {
            if (this.redisService?.isReady) {
                await this.redisService.set(
                    this.STRATEGY_KEY + strategy.id,
                    JSON.stringify(strategy),
                    { EX: 300 } // 5分钟过期
                );
            }
        } catch (error) {
            logger.warn('缓存策略失败:', error);
        }
    }

    // 将策略加入队列
    async queueStrategy(strategy) {
        const message = {
            strategyId: strategy.id,
            batchId: strategy.batchId,
            type: strategy.type,
            round: 0
        };

        await this.redisService.lpush(TRADE_QUEUE, JSON.stringify(message));
        
        logger.info('策略已加入队列:', {
            strategyId: strategy.id,
            batchId: strategy.batchId
        });
    }

    // 获取策略状态
    async getStrategyStatus(batchId) {
        const strategy = await db.models.TradeStrategy.findOne({
            where: { batchId },
            include: [{
                model: db.models.TradeExecution,
                as: 'executions'
            }]
        });

        if (!strategy) {
            throw new Error('Strategy not found');
        }

        return {
            strategy: strategy.toJSON(),
            executions: strategy.executions.map(e => e.toJSON())
        };
    }

    // 暂停策略
    async pauseStrategy(batchId) {
        const strategy = await db.models.TradeStrategy.findOne({
            where: { batchId }
        });

        if (!strategy) {
            throw new Error('Strategy not found');
        }

        await strategy.update({ status: 'paused' });
        
        // 从队列中移除
        await this.redisService.lrem(TRADE_QUEUE, 0, strategy.id);
    }

    // 恢复策略
    async resumeStrategy(batchId) {
        const strategy = await db.models.TradeStrategy.findOne({
            where: { batchId }
        });

        if (!strategy) {
            throw new Error('Strategy not found');
        }

        await strategy.update({ status: 'running' });
        
        // 重新加入队列
        await this.queueStrategy(strategy);
    }

    // ... 继续补充其他方法
} 