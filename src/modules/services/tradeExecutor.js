import { logger } from '../utils/index.js';

export class TradeExecutor {
    constructor(solanaService, redisClient) {
        this.solanaService = solanaService;
        this.redis = redisClient;
        this.TRADE_QUEUE = 'trade:tasks';
        this.running = false;
    }

    async start() {
        this.running = true;
        while (this.running) {
            try {
                // 从队列获取任务
                const taskData = await this.redis.brpop(this.TRADE_QUEUE, 0);
                if (!taskData) continue;

                const task = JSON.parse(taskData[1]);
                await this.executeTask(task);

            } catch (error) {
                logger.error('执行交易任务失败:', error);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    async stop() {
        this.running = false;
    }

    async executeTask(task) {
        try {
            const { type, groupType, accountNumber, token, params } = task;

            if (type === 'buy') {
                await this.solanaService.buyTokens(
                    groupType,
                    accountNumber,
                    token,
                    params.amount,
                    params.slippage
                );
            } else if (type === 'sell') {
                await this.solanaService.sellTokens(
                    groupType,
                    accountNumber,
                    token,
                    params.percentage,
                    params.slippage
                );
            }

            // 记录执行结果
            await this.recordTaskResult(task, 'success');

        } catch (error) {
            logger.error('执行任务失败:', {
                error: error.message,
                task
            });
            await this.recordTaskResult(task, 'failed', error.message);

            // 检查是否需要重试
            if (task.retries < (task.params.retries || 3)) {
                task.retries = (task.retries || 0) + 1;
                await this.redis.lpush(this.TRADE_QUEUE, JSON.stringify(task));
            }
        }
    }

    async recordTaskResult(task, status, error = null) {
        const result = {
            taskId: task.id,
            strategyId: task.strategyId,
            status,
            error,
            timestamp: Date.now()
        };

        await this.redis.hset(
            `trade:results:${task.strategyId}`,
            task.id,
            JSON.stringify(result)
        );
    }
} 