import { logger } from '../utils/index.js';

export class TradeLockManager {
    constructor(redisService) {
        this.redis = redisService;
        this.lockTimeoutMs = 30000; // 30 seconds
        this.renewInterval = 10000;  // 10 seconds
        this._renewIntervals = new Map();
    }

    async acquireLock(lockKey) {
        try {
            const result = await this.redis.set(
                `trade:lock:${lockKey}`,
                process.pid,
                'NX',
                'PX',
                this.lockTimeoutMs
            );

            if (result) {
                logger.info('Lock acquired', { lockKey, pid: process.pid });
                this._startAutoRenew(lockKey);
                return true;
            }

            logger.debug('Failed to acquire lock', { lockKey });
            return false;

        } catch (error) {
            logger.error('Error acquiring lock', { lockKey, error });
            return false;
        }
    }

    async renewLock(lockKey) {
        try {
            const lockPath = `trade:lock:${lockKey}`;
            const currentHolder = await this.redis.get(lockPath);

            if (currentHolder === process.pid.toString()) {
                await this.redis.pexpire(lockPath, this.lockTimeoutMs);
                logger.debug('Lock renewed', { lockKey });
                return true;
            }

            logger.warn('Failed to renew lock - not lock holder', {
                lockKey,
                currentHolder,
                pid: process.pid
            });
            return false;

        } catch (error) {
            logger.error('Error renewing lock', { lockKey, error });
            return false;
        }
    }

    async releaseLock(lockKey) {
        try {
            const lockPath = `trade:lock:${lockKey}`;
            const currentHolder = await this.redis.get(lockPath);

            if (currentHolder === process.pid.toString()) {
                await this.redis.del(lockPath);
                this._stopAutoRenew(lockKey);
                logger.info('Lock released', { lockKey });
                return true;
            }

            logger.warn('Failed to release lock - not lock holder', {
                lockKey,
                currentHolder,
                pid: process.pid
            });
            return false;

        } catch (error) {
            logger.error('Error releasing lock', { lockKey, error });
            return false;
        }
    }

    async checkDeadLock(lockKey) {
        try {
            const lockPath = `trade:lock:${lockKey}`;
            const lockInfo = await this.redis.hgetall(`${lockPath}:info`);

            if (!lockInfo) {
                return false;
            }

            const lockAge = Date.now() - parseInt(lockInfo.createdAt);
            if (lockAge > this.lockTimeoutMs * 2) {
                logger.warn('Potential dead lock detected', {
                    lockKey,
                    lockAge,
                    holder: lockInfo.pid
                });
                return true;
            }

            return false;

        } catch (error) {
            logger.error('Error checking dead lock', { lockKey, error });
            return false;
        }
    }

    async cleanExpiredLocks() {
        try {
            const locks = await this.redis.keys('trade:lock:*');

            for (const lockPath of locks) {
                const lockInfo = await this.redis.hgetall(`${lockPath}:info`);
                if (lockInfo && Date.now() - parseInt(lockInfo.createdAt) > this.lockTimeoutMs) {
                    await this.redis.del(lockPath);
                    await this.redis.del(`${lockPath}:info`);
                    logger.info('Cleaned expired lock', { lockPath });
                }
            }
        } catch (error) {
            logger.error('Error cleaning expired locks', { error });
        }
    }

    _startAutoRenew(lockKey) {
        if (this._renewIntervals.has(lockKey)) {
            return;
        }

        const intervalId = setInterval(async () => {
            try {
                const renewed = await this.renewLock(lockKey);
                if (!renewed) {
                    this._stopAutoRenew(lockKey);
                }
            } catch (error) {
                logger.error('Error in auto-renew', { lockKey, error });
                this._stopAutoRenew(lockKey);
            }
        }, this.renewInterval);

        this._renewIntervals.set(lockKey, intervalId);
    }

    _stopAutoRenew(lockKey) {
        const intervalId = this._renewIntervals.get(lockKey);
        if (intervalId) {
            clearInterval(intervalId);
            this._renewIntervals.delete(lockKey);
            logger.debug('Stopped auto-renew', { lockKey });
        }
    }

    async shutdown() {
        // Clean up all intervals
        for (const [lockKey, intervalId] of this._renewIntervals.entries()) {
            clearInterval(intervalId);
            await this.releaseLock(lockKey);
        }
        this._renewIntervals.clear();
    }
}