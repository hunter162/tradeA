import { logger } from '../utils/index.js';
import crypto from 'crypto';

export class TradeErrorHandler {
    constructor(redisService, dbService) {
        this.redis = redisService;
        this.db = dbService;
        this.RETRY_QUEUE = 'trade:retry_queue';
        this.REVIEW_QUEUE = 'trade:review_queue';
        this.ERROR_LOG = 'trade:error_log';

        // Define retry policies for different error types
        this.retryPolicies = new Map([
            ['NetworkError', { maxRetries: 3, delay: 5000, exponential: true }],
            ['ValidationError', { maxRetries: 0, requiresReview: true }],
            ['InsufficientFundsError', { maxRetries: 2, delay: 10000, requiresReview: true }],
            ['TransactionError', { maxRetries: 2, delay: 15000 }],
            ['RateLimitError', { maxRetries: 5, delay: 30000, exponential: true }]
        ]);
    }

    async handleError(error, task) {
        try {
            const errorType = this._classifyError(error);
            const policy = this.retryPolicies.get(errorType) || this.retryPolicies.get('TransactionError');

            // Log error details
            await this._logError(task, error, errorType);

            // Check if task has exceeded global retry limit
            if (task.retryCount >= 5) {
                return this.recordFailure(task, error, 'Exceeded global retry limit');
            }

            // Handle based on policy
            if (!policy.maxRetries || task.retryCount >= policy.maxRetries) {
                if (policy.requiresReview) {
                    return this.queueForReview(task, error);
                }
                return this.recordFailure(task, error);
            }

            return this.retryTask(task, error, policy);

        } catch (err) {
            logger.error('Error in error handler', { originalError: error, handlerError: err });
            return this.recordFailure(task, error, 'Error handler failure');
        }
    }

    async retryTask(task, error, policy) {
        const retryCount = task.retryCount + 1;
        const delay = policy.exponential
            ? policy.delay * Math.pow(2, retryCount - 1)
            : policy.delay;

        const nextRetryTime = new Date(Date.now() + delay);

        try {
            // Update task in database
            await this.db.models.TradeTask.update({
                retryCount,
                lastError: error.message,
                errorDetails: JSON.stringify(error),
                nextRetryTime,
                status: 'retry_pending'
            }, {
                where: { id: task.id }
            });

            // Add to retry queue
            await this.redis.zadd(
                this.RETRY_QUEUE,
                Date.now() + delay,
                JSON.stringify({
                    taskId: task.id,
                    retryCount,
                    originalError: error.message
                })
            );

            logger.info('Task queued for retry', {
                taskId: task.id,
                retryCount,
                nextRetryTime
            });

            return true;

        } catch (err) {
            logger.error('Failed to queue task for retry', {
                taskId: task.id,
                error: err
            });
            return false;
        }
    }

    async queueForReview(task, error) {
        try {
            // Update task status
            await this.db.models.TradeTask.update({
                status: 'review_required',
                reviewReason: error.message,
                errorDetails: JSON.stringify(error)
            }, {
                where: { id: task.id }
            });

            // Add to review queue
            const reviewItem = {
                taskId: task.id,
                strategyId: task.strategyId,
                error: error.message,
                timestamp: Date.now(),
                retryCount: task.retryCount,
                type: task.type
            };

            await this.redis.rpush(
                this.REVIEW_QUEUE,
                JSON.stringify(reviewItem)
            );

            logger.info('Task queued for review', {
                taskId: task.id,
                error: error.message
            });

            return true;

        } catch (err) {
            logger.error('Failed to queue task for review', {
                taskId: task.id,
                error: err
            });
            return false;
        }
    }

    async recordFailure(task, error, reason = '') {
        try {
            // Update task status
            await this.db.models.TradeTask.update({
                status: 'failed',
                lastError: error.message,
                errorDetails: JSON.stringify(error),
                failureReason: reason || error.message
            }, {
                where: { id: task.id }
            });

            // Log failure details
            const failureLog = {
                taskId: task.id,
                strategyId: task.strategyId,
                error: error.message,
                timestamp: Date.now(),
                retryCount: task.retryCount,
                reason
            };

            await this.redis.rpush(
                this.ERROR_LOG,
                JSON.stringify(failureLog)
            );

            logger.error('Task failed permanently', {
                taskId: task.id,
                error: error.message,
                reason
            });

            return true;

        } catch (err) {
            logger.error('Failed to record task failure', {
                taskId: task.id,
                error: err
            });
            return false;
        }
    }

    _classifyError(error) {
        // Network related errors
        if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET' ||
            error.code === 'ETIMEDOUT' || error.message.includes('network')) {
            return 'NetworkError';
        }

        // Validation errors
        if (error.name === 'ValidationError' || error.message.includes('invalid') ||
            error.message.includes('validation')) {
            return 'ValidationError';
        }

        // Insufficient funds
        if (error.message.includes('insufficient funds') ||
            error.message.includes('insufficient balance')) {
            return 'InsufficientFundsError';
        }

        // Rate limiting
        if (error.message.includes('rate limit') || error.code === 429) {
            return 'RateLimitError';
        }

        // Default to transaction error
        return 'TransactionError';
    }

    async _logError(task, error, errorType) {
        const errorLog = {
            taskId: task.id,
            strategyId: task.strategyId,
            errorType,
            message: error.message,
            stack: error.stack,
            timestamp: Date.now(),
            retryCount: task.retryCount
        };

        await this.redis.rpush(
            this.ERROR_LOG,
            JSON.stringify(errorLog)
        );

        // If it's a critical error, also log to database
        if (errorType === 'ValidationError' || task.retryCount >= 2) {
            await this.db.models.ErrorLog.create(errorLog);
        }
    }

    generateErrorHash(error) {
        const errorString = `${error.message}:${error.code}:${error.stack}`;
        return crypto.createHash('sha256').update(errorString).digest('hex');
    }
}