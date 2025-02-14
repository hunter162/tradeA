import { logger } from '../utils/index.js';
import { TradeLockManager } from './tradeLockManager.js';
import { TradeErrorHandler } from './tradeErrorHandler.js';
import { EXECUTION_STATUS, STRATEGY_STATUS } from '../constants/index.js';

export class TradeExecutorService {
    constructor(solanaService, redisService, dbService) {
        this.solana = solanaService;
        this.redis = redisService;
        this.db = dbService;
        this.lockManager = new TradeLockManager(redisService);
        this.errorHandler = new TradeErrorHandler(redisService, dbService);

        this.isRunning = false;
        this.TRADE_QUEUE = 'trade:execution:queue';
        this.EXECUTOR_LOCK = 'trade:executor:lock';
        this.EXECUTION_TIMEOUT = 300000; // 5分钟超时
        this.MAX_CONCURRENT_EXECUTIONS = 5;
    }

    async start() {
        if (this.isRunning) {
            logger.warn('Trade executor already running');
            return;
        }

        this.isRunning = true;
        logger.info('Trade executor started');

        try {
            // 恢复未完成的执行
            await this._recoverPendingExecutions();

            // 启动主执行循环
            while (this.isRunning) {
                try {
                    // 获取执行锁
                    const locked = await this._acquireLock();
                    if (!locked) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        continue;
                    }

                    try {
                        // 检查并控制并发执行数量
                        const activeExecutions = await this._getActiveExecutionsCount();
                        if (activeExecutions >= this.MAX_CONCURRENT_EXECUTIONS) {
                            continue;
                        }

                        // 从队列获取任务
                        const message = await this.redis.rpop(this.TRADE_QUEUE);
                        if (!message) {
                            continue;
                        }

                        // 处理消息
                        await this._processMessage(JSON.parse(message));

                    } finally {
                        await this._releaseLock();
                    }

                } catch (error) {
                    logger.error('Error in execution loop:', error);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
        } catch (error) {
            logger.error('Fatal error in executor:', error);
            this.isRunning = false;
            throw error;
        }
    }

    async stop() {
        this.isRunning = false;
        await this.lockManager.shutdown();
        logger.info('Trade executor stopped');
    }

    async _processMessage(message) {
        const { strategyId, batchId, round } = message;
        const executionId = `exec_${Date.now()}_${strategyId}`;

        try {
            // 1. 创建执行记录
            const execution = await this._createExecution(message, executionId);

            // 2. 设置超时检查
            const timeoutId = this._setupExecutionTimeout(executionId);

            try {
                // 3. 获取策略
                const strategy = await this._getStrategy(strategyId);
                if (!strategy) {
                    throw new Error(`Strategy not found: ${strategyId}`);
                }

                // 4. 检查策略状态
                if (strategy.status !== STRATEGY_STATUS.ACTIVE) {
                    logger.info('Strategy not active:', {
                        strategyId,
                        status: strategy.status
                    });
                    return;
                }

                // 5. 执行交易
                if (strategy.type === 'single') {
                    await this._executeSingleTrade(strategy, execution);
                } else {
                    await this._executeComboTrade(strategy, execution);
                }

                // 6. 更新执行状态
                await this._updateExecution(executionId, {
                    status: EXECUTION_STATUS.COMPLETED,
                    completedAt: new Date()
                });

                // 7. 更新策略进度
                await this._updateStrategyProgress(strategy, round);

            } finally {
                clearTimeout(timeoutId);
            }

        } catch (error) {
            logger.error('Execution failed:', {
                executionId,
                error
            });

            // 记录执行失败
            await this._recordExecutionFailure(executionId, error);

            // 错误处理
            await this.errorHandler.handleError(error, message);
        }
    }

    async _executeSingleTrade(strategy, execution) {
        const accounts = this._parseAccountRange(strategy.accountRange);

        for (const accountNumber of accounts) {
            try {
                if (strategy.rules.buy) {
                    await this._executeBuy(strategy, accountNumber, execution);
                } else if (strategy.rules.sell) {
                    await this._executeSell(strategy, accountNumber, execution);
                }
            } catch (error) {
                logger.error('Trade execution failed:', {
                    strategyId: strategy.id,
                    accountNumber,
                    error: error.message
                });
                throw error;
            }
        }
    }

    async _executeComboTrade(strategy, execution) {
        const accounts = this._parseAccountRange(strategy.accountRange);

        for (const accountNumber of accounts) {
            try {
                // 1. 执行买入
                await this._executeBuy(strategy, accountNumber, execution);

                // 2. 等待指定间隔
                await new Promise(resolve =>
                    setTimeout(resolve, strategy.rules.interval * 1000)
                );

                // 3. 执行卖出
                await this._executeSell(strategy, accountNumber, execution);

            } catch (error) {
                logger.error('Combo trade execution failed:', {
                    strategyId: strategy.id,
                    accountNumber,
                    error: error.message
                });
                throw error;
            }
        }
    }

    async _executeBuy(strategy, accountNumber, execution) {
        try {
            const result = await this.solana.buyTokens(
                strategy.groupType,
                accountNumber,
                strategy.token,
                strategy.rules.buy.amount,
                strategy.rules.buy.options
            );

            await this._recordTradeResult(execution.id, {
                type: 'buy',
                accountNumber,
                result
            });

            return result;

        } catch (error) {
            await this._recordTradeError(execution.id, {
                type: 'buy',
                accountNumber,
                error
            });
            throw error;
        }
    }

    async _executeSell(strategy, accountNumber, execution) {
        try {
            const result = await this.solana.sellTokens(
                strategy.groupType,
                accountNumber,
                strategy.token,
                strategy.rules.sell.percentage,
                strategy.rules.sell.options
            );

            await this._recordTradeResult(execution.id, {
                type: 'sell',
                accountNumber,
                result
            });

            return result;

        } catch (error) {
            await this._recordTradeError(execution.id, {
                type: 'sell',
                accountNumber,
                error
            });
            throw error;
        }
    }

    async _createExecution(message, executionId) {
        return await this.db.models.TradeExecution.create({
            id: executionId,
            strategyId: message.strategyId,
            batchId: message.batchId,
            round: message.round,
            status: EXECUTION_STATUS.PROCESSING,
            startedAt: new Date(),
            metadata: message
        });
    }

    async _updateExecution(executionId, updates) {
        await this.db.models.TradeExecution.update(updates, {
            where: { id: executionId }
        });
    }

    async _recordTradeResult(executionId, data) {
        await this.db.models.TradeResult.create({
            executionId,
            ...data,
            timestamp: new Date()
        });
    }

    async _recordTradeError(executionId, data) {
        await this.db.models.TradeError.create({
            executionId,
            ...data,
            timestamp: new Date()
        });
    }

    async _getStrategy(strategyId) {
        // 先从缓存获取
        const cached = await this.redis.get(`strategy:${strategyId}`);
        if (cached) {
            return JSON.parse(cached);
        }

        // 从数据库获取
        const strategy = await this.db.models.TradeStrategy.findByPk(strategyId);
        if (strategy) {
            // 更新缓存
            await this.redis.set(
                `strategy:${strategyId}`,
                JSON.stringify(strategy),
                'EX',
                300 // 5分钟缓存
            );
        }

        return strategy;
    }

    async _updateStrategyProgress(strategy, round) {
        const nextRound = round + 1;

        if (nextRound >= strategy.totalRounds) {
            // 策略完成
            await strategy.update({
                status: STRATEGY_STATUS.COMPLETED,
                currentRound: nextRound,
                completedAt: new Date()
            });
        } else {
            // 继续下一轮
            await strategy.update({
                currentRound: nextRound,
                lastExecutionTime: new Date()
            });

            // 延迟指定时间后加入下一轮任务
            setTimeout(async () => {
                await this.queueStrategy({
                    ...strategy.toJSON(),
                    round: nextRound
                });
            }, strategy.rules.interval * 1000);
        }
    }

    _parseAccountRange(range) {
        const [start, end] = range.split('-').map(Number);
        return Array.from(
            { length: end - start + 1 },
            (_, i) => start + i
        );
    }

    async _acquireLock() {
        return await this.lockManager.acquireLock(this.EXECUTOR_LOCK);
    }

    async _releaseLock() {
        return await this.lockManager.releaseLock(this.EXECUTOR_LOCK);
    }

    _setupExecutionTimeout(executionId) {
        return setTimeout(async () => {
            try {
                await this._handleExecutionTimeout(executionId);
            } catch (error) {
                logger.error('Error handling execution timeout:', error);
            }
        }, this.EXECUTION_TIMEOUT);
    }

    async _handleExecutionTimeout(executionId) {
        const execution = await this.db.models.TradeExecution.findByPk(executionId);
        if (execution && execution.status === EXECUTION_STATUS.PROCESSING) {
            await this._updateExecution(executionId, {
                status: EXECUTION_STATUS.TIMEOUT,
                error: 'Execution timeout'
            });
        }
    }

    async _getActiveExecutionsCount() {
        return await this.db.models.TradeExecution.count({
            where: {
                status: EXECUTION_STATUS.PROCESSING
            }
        });
    }

    async _recoverPendingExecutions() {
        const pendingExecutions = await this.db.models.TradeExecution.findAll({
            where: {
                status: EXECUTION_STATUS.PROCESSING
            }
        });

        for (const execution of pendingExecutions) {
            // 如果执行时间超过超时时间，标记为超时
            if (Date.now() - execution.startedAt > this.EXECUTION_TIMEOUT) {
                await this._updateExecution(execution.id, {
                    status: EXECUTION_STATUS.TIMEOUT,
                    error: 'Execution timeout during recovery'
                });
            } else {
                // 重新加入队列
                await this.redis.lpush(
                    this.TRADE_QUEUE,
                    JSON.stringify(execution.metadata)
                );
            }
        }
    }
}