import { createClient } from 'redis';
import { logger } from '../utils/index.js';

export class RedisService {
    constructor(config) {
        this.config = config;
        this.client = null;
        this.retryCount = 0;
        this.maxRetries = 3;
        this.retryDelay = 5000;
        this.isReady = false;
        this.reconnectTimer = null;
    }

    async connect() {
        try {
            if (this.client) {
                await this.client.quit();
            }

            // 创建 Redis 客户端
            this.client = createClient({
                url: `redis://${this.config.host}:${this.config.port}`,
                password: this.config.password,
                database: this.config.db,
                retry_strategy: (options) => {
                    if (options.error?.code === 'ECONNREFUSED') {
                        return new Error('Redis server refused connection');
                    }
                    if (options.total_retry_time > 1000 * 60 * 60) {
                        return new Error('Retry time exhausted');
                    }
                    if (options.attempt > this.maxRetries) {
                        return undefined;
                    }
                    return Math.min(options.attempt * 100, 3000);
                },
                socket: {
                    connectTimeout: 10000,
                    keepAlive: 10000,
                    reconnectStrategy: (retries) => {
                        if (retries > this.maxRetries) {
                            return new Error('Max retries reached');
                        }
                        return Math.min(retries * 1000, this.retryDelay);
                    }
                }
            });

            // 错误处理
            this.client.on('error', (err) => {
                logger.error('Redis 连接错误:', {
                    error: err.message,
                    host: this.config.host,
                    port: this.config.port
                });
                this.isReady = false;
                this._handleConnectionError(err);
            });

            // 重连处理
            this.client.on('reconnecting', () => {
                logger.warn('Redis 正在重连...');
            });

            // 就绪处理
            this.client.on('ready', () => {
                logger.info('Redis 已连接');
                this.isReady = true;
                this.retryCount = 0;
                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                }
            });

            // 连接关闭处理
            this.client.on('end', () => {
                logger.warn('Redis 连接已关闭');
                this.isReady = false;
                this._scheduleReconnect();
            });

            await this.client.connect();
            this.isReady = true;
            
            // 测试连接
            await this.ping();
            
            return true;

        } catch (error) {
            logger.error('Redis 连接失败:', {
                error: error.message,
                config: {
                    ...this.config,
                    password: '***'
                }
            });
            
            return this._handleConnectionError(error);
        }
    }

    async _handleConnectionError(error) {
        this.isReady = false;
        
        if (this.retryCount >= this.maxRetries) {
            logger.error('Redis 重连失败次数过多，停止重试');
            throw new Error('Redis connection failed after max retries');
        }

        this.retryCount++;
        logger.warn(`Redis 重连尝试 (${this.retryCount}/${this.maxRetries})`);
        
        return new Promise((resolve) => {
            this.reconnectTimer = setTimeout(async () => {
                try {
                    const result = await this.connect();
                    resolve(result);
                } catch (err) {
                    resolve(false);
                }
            }, this.retryDelay);
        });
    }

    _scheduleReconnect() {
        if (!this.reconnectTimer && this.retryCount < this.maxRetries) {
            this.reconnectTimer = setTimeout(() => {
                this.connect().catch(() => {
                    logger.error('Redis 重连失败');
                });
            }, this.retryDelay);
        }
    }

    async ping() {
        try {
            const result = await this.client.ping();
            return result === 'PONG';
        } catch (error) {
            logger.error('Redis ping 失败:', error);
            return false;
        }
    }

    // 获取所有哈希字段
    async hGetAll(key) {
        try {
            const result = await this.client.hGetAll(key);
            return result;
        } catch (error) {
            logger.error('Redis hGetAll 失败:', {
                error: error.message,
                key
            });
            throw error;
        }
    }

    // 设置哈希字段
    async hSet(key, field, value) {
        try {
            await this.client.hSet(key, field, value);
        } catch (error) {
            logger.error('Redis hSet 失败:', {
                error: error.message,
                key,
                field
            });
            throw error;
        }
    }

    // 删除哈希字段
    async hDel(key, field) {
        try {
            await this.client.hDel(key, field);
        } catch (error) {
            logger.error('Redis hDel 失败:', {
                error: error.message,
                key,
                field
            });
            throw error;
        }
    }

    // 设置键值对
    async set(key, value, options = {}) {
        if (!this.isReady || !this.client) {
            return false;
        }
        try {
            await this.client.set(key, value, options);
            return true;
        } catch (error) {
            logger.warn('Redis set 失败:', {
                error: error.message,
                key
            });
            return false;
        }
    }

    // 获取值
    async get(key) {
        if (!this.isReady || !this.client) {
            return null;
        }
        try {
            return await this.client.get(key);
        } catch (error) {
            logger.warn('Redis get 失败:', {
                error: error.message,
                key
            });
            return null;
        }
    }

    // 删除键
    async del(key) {
        try {
            await this.client.del(key);
        } catch (error) {
            logger.error('Redis del 失败:', {
                error: error.message,
                key
            });
            throw error;
        }
    }

    // 批量设置余额
    async setBatchBalances(balances) {
        try {
            const pipeline = this.client.multi();
            for (const [key, value] of Object.entries(balances)) {
                pipeline.set(`balance:${key}`, value.toString(), {
                    EX: 300 // 5分钟过期
                });
            }
            await pipeline.exec();
        } catch (error) {
            logger.error('批量设置余额失败:', {
                error: error.message,
                count: Object.keys(balances).length
            });
            throw error;
        }
    }

    async cleanup() {
        try {
            if (this.client) {
                await this.client.quit();
                logger.info('Redis 连接已关闭');
            }
        } catch (error) {
            logger.error('Redis 关闭失败:', error);
        }
    }

    // 添加队列相关方法
    async lpush(key, value) {
        try {
            if (!this.isReady || !this.client) {
                return false;
            }
            return await this.client.lPush(key, value);
        } catch (error) {
            logger.error('Redis lpush 失败:', {
                error: error.message,
                key,
                value
            });
            return false;
        }
    }

    async rpush(key, value) {
        try {
            if (!this.isReady || !this.client) {
                return false;
            }
            return await this.client.rPush(key, value);
        } catch (error) {
            logger.error('Redis rpush 失败:', {
                error: error.message,
                key,
                value
            });
            return false;
        }
    }

    async lrem(key, count, value) {
        try {
            if (!this.isReady || !this.client) {
                return false;
            }
            return await this.client.lRem(key, count, value);
        } catch (error) {
            logger.error('Redis lrem 失败:', {
                error: error.message,
                key,
                count,
                value
            });
            return false;
        }
    }

    async brpop(key, timeout) {
        try {
            if (!this.isReady || !this.client) {
                return null;
            }
            return await this.client.brPop(key, timeout);
        } catch (error) {
            logger.error('Redis brpop 失败:', {
                error: error.message,
                key,
                timeout
            });
            return null;
        }
    }

    // 有序集合操作
    async zadd(key, score, member) {
        try {
            if (!this.isReady || !this.client) {
                return false;
            }
            return await this.client.zAdd(key, [{
                score: score,
                value: member
            }]);
        } catch (error) {
            logger.error('Redis zadd 失败:', {
                error: error.message,
                key,
                score,
                member
            });
            return false;
        }
    }

    // 锁相关操作
    async pexpire(key, milliseconds) {
        try {
            if (!this.isReady || !this.client) {
                return false;
            }
            return await this.client.pExpire(key, milliseconds);
        } catch (error) {
            logger.error('Redis pexpire 失败:', {
                error: error.message,
                key,
                milliseconds
            });
            return false;
        }
    }

    // 批量操作
    multi() {
        if (!this.isReady || !this.client) {
            return null;
        }
        return this.client.multi();
    }

    async exec() {
        try {
            if (!this.isReady || !this.client) {
                return null;
            }
            return await this.client.exec();
        } catch (error) {
            logger.error('Redis exec 失败:', {
                error: error.message
            });
            return null;
        }
    }

    // 键模式查询
    async keys(pattern) {
        try {
            if (!this.isReady || !this.client) {
                return [];
            }
            return await this.client.keys(pattern);
        } catch (error) {
            logger.error('Redis keys 失败:', {
                error: error.message,
                pattern
            });
            return [];
        }
    }

    // 添加分布式锁方法
    async acquireLock(lockKey, ttl = 30000) {
        try {
            if (!this.isReady || !this.client) {
                return false;
            }
            const result = await this.client.set(
                `lock:${lockKey}`,
                process.pid.toString(),
                'NX',
                'PX',
                ttl
            );
            return result === 'OK';
        } catch (error) {
            logger.error('获取锁失败:', {
                error: error.message,
                lockKey
            });
            return false;
        }
    }

    async releaseLock(lockKey) {
        try {
            if (!this.isReady || !this.client) {
                return false;
            }
            const script = `
                if redis.call("get", KEYS[1]) == ARGV[1] then
                    return redis.call("del", KEYS[1])
                else
                    return 0
                end
            `;
            const result = await this.client.eval(
                script,
                1,
                `lock:${lockKey}`,
                process.pid.toString()
            );
            return result === 1;
        } catch (error) {
            logger.error('释放锁失败:', {
                error: error.message,
                lockKey
            });
            return false;
        }
    }

    // 添加订阅发布方法
    async publish(channel, message) {
        try {
            if (!this.isReady || !this.client) {
                return false;
            }
            return await this.client.publish(channel, message);
        } catch (error) {
            logger.error('发布消息失败:', {
                error: error.message,
                channel
            });
            return false;
        }
    }

    async subscribe(channel, callback) {
        try {
            if (!this.isReady || !this.client) {
                return false;
            }
            await this.client.subscribe(channel);
            this.client.on('message', (ch, message) => {
                if (ch === channel) {
                    callback(message);
                }
            });
            return true;
        } catch (error) {
            logger.error('订阅频道失败:', {
                error: error.message,
                channel
            });
            return false;
        }
    }

    // 添加缓存方法
    async setCache(key, value, ttl = 300) {
        try {
            if (!this.isReady || !this.client) {
                return false;
            }
            await this.client.set(key, JSON.stringify(value), 'EX', ttl);
            return true;
        } catch (error) {
            logger.error('设置缓存失败:', {
                error: error.message,
                key
            });
            return false;
        }
    }

    async getCache(key) {
        try {
            if (!this.isReady || !this.client) {
                return null;
            }
            const value = await this.client.get(key);
            return value ? JSON.parse(value) : null;
        } catch (error) {
            logger.error('获取缓存失败:', {
                error: error.message,
                key
            });
            return null;
        }
    }

    // 添加优雅关闭方法
    async shutdown() {
        try {
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }
            
            if (this.client) {
                await this.client.quit();
                this.client = null;
            }
            
            this.isReady = false;
            logger.info('Redis 服务已关闭');
        } catch (error) {
            logger.error('Redis 关闭失败:', error);
        }
    }
} 
