import { logger } from '../utils/index.js';
import db from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';

export class TradeTaskService {
    constructor(redisService) {
        this.redis = redisService;
        this.TASK_QUEUE_KEY = 'trade:tasks';
        this.MAX_RETRIES = 3;
        this.RETRY_DELAY = 60000; // 1分钟
        this.RETRY_QUEUE = 'trade:retry_queue';
        this.FAILED_QUEUE = 'trade:failed_queue';
    }

    // 创建交易任务
    async createTask(strategyId, type, accountNumber, params) {
        try {
            const task = await db.models.TradeTask.create({
                id: uuidv4(),
                strategyId,
                type,
                accountNumber,
                params,
                status: 'pending'
            });

            // 添加到任务队列
            await this._addToQueue(task);

            logger.info('创建交易任务成功:', {
                taskId: task.id,
                strategyId,
                type,
                accountNumber
            });

            return task;
        } catch (error) {
            logger.error('创建交易任务失败:', error);
            throw error;
        }
    }

    // 更新任务状态
    async updateTaskStatus(taskId, status, result = null, error = null) {
        try {
            const task = await db.models.TradeTask.findByPk(taskId);
            if (!task) {
                throw new Error('Task not found');
            }

            const updates = {
                status,
                result,
                error: error?.message
            };

            if (status === 'failed' && task.retryCount < this.MAX_RETRIES) {
                updates.retryCount = task.retryCount + 1;
                updates.nextRetryTime = new Date(Date.now() + this.RETRY_DELAY);
                updates.status = 'pending';
            }

            await task.update(updates);

            logger.info('更新任务状态:', {
                taskId,
                status,
                retryCount: updates.retryCount
            });

            return task;
        } catch (error) {
            logger.error('更新任务状态失败:', error);
            throw error;
        }
    }

    // 获取待执行的任务
    async getPendingTasks() {
        try {
            return await db.models.TradeTask.findAll({
                where: {
                    status: 'pending',
                    nextRetryTime: {
                        [db.Sequelize.Op.or]: {
                            [db.Sequelize.Op.lte]: new Date(),
                            [db.Sequelize.Op.is]: null
                        }
                    }
                },
                order: [['createdAt', 'ASC']]
            });
        } catch (error) {
            logger.error('获取待执行任务失败:', error);
            throw error;
        }
    }

    // 添加任务到队列
    async _addToQueue(task) {
        try {
            if (this.redis?.isReady) {
                await this.redis.rPush(this.TASK_QUEUE_KEY, JSON.stringify({
                    id: task.id,
                    type: task.type,
                    params: task.params
                }));
            }
        } catch (error) {
            logger.warn('添加任务到队列失败:', error);
        }
    }

    async executeTask(task) {
        try {
            // 执行任务
            const result = await this._doExecuteTask(task);
            await this._recordSuccess(task, result);
            return result;

        } catch (error) {
            return this._handleTaskError(task, error);
        }
    }

    async _handleTaskError(task, error) {
        // 更新任务状态
        task.retryCount = (task.retryCount || 0) + 1;
        task.lastError = error.message;
        
        // 检查是否可以重试
        if (task.retryCount < this.MAX_RETRIES) {
            // 计算延迟时间(指数退避)
            const delay = this.RETRY_DELAY * Math.pow(2, task.retryCount - 1);
            
            // 加入重试队列
            await this.redis.zadd(
                this.RETRY_QUEUE,
                Date.now() + delay,
                JSON.stringify({
                    task,
                    retryCount: task.retryCount,
                    error: error.message
                })
            );

            logger.info('Task queued for retry:', {
                taskId: task.id,
                retryCount: task.retryCount,
                delay
            });

            return {
                status: 'retry_pending',
                retryCount: task.retryCount,
                nextRetryTime: new Date(Date.now() + delay)
            };

        } else {
            // 超过重试次数,标记为失败
            await this._recordFailure(task, error);
            
            // 加入失败队列
            await this.redis.rpush(
                this.FAILED_QUEUE,
                JSON.stringify({
                    task,
                    error: error.message,
                    retryCount: task.retryCount
                })
            );

            return {
                status: 'failed',
                error: error.message,
                retryCount: task.retryCount
            };
        }
    }

    async _recordSuccess(task, result) {
        await db.models.TradeTask.update({
            status: 'completed',
            result: result,
            completedAt: new Date()
        }, {
            where: { id: task.id }
        });
    }

    async _recordFailure(task, error) {
        await db.models.TradeTask.update({
            status: 'failed', 
            error: error.message,
            failedAt: new Date()
        }, {
            where: { id: task.id }
        });
    }

    // 处理重试队列
    async processRetryQueue() {
        while (true) {
            try {
                // 获取到期的重试任务
                const now = Date.now();
                const tasks = await this.redis.zrangebyscore(
                    this.RETRY_QUEUE,
                    0,
                    now
                );

                for (const taskStr of tasks) {
                    const { task } = JSON.parse(taskStr);
                    
                    // 重新执行任务
                    await this.executeTask(task);
                    
                    // 从重试队列移除
                    await this.redis.zrem(this.RETRY_QUEUE, taskStr);
                }

                // 等待一段时间再检查
                await new Promise(resolve => setTimeout(resolve, 1000));

            } catch (error) {
                logger.error('Error processing retry queue:', error);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }
} 