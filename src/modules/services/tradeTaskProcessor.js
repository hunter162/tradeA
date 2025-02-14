import { logger } from '../utils/index.js';
import { TradeLockManager } from './tradeLockManager.js';
import { TradeErrorHandler } from './tradeErrorHandler.js';
import { STRATEGY_STATUS } from '../constants/index.js';
import { v4 as uuidv4 } from 'uuid';

export class TradeStrategyService {
  constructor(redisService, dbService) {
    this.redis = redisService;
    this.db = dbService;
    this.lockManager = new TradeLockManager(redisService);
    this.errorHandler = new TradeErrorHandler(redisService, dbService);

    this.QUEUE_KEY = 'trade:strategy:queue';
    this.STRATEGY_KEY_PREFIX = 'trade:strategy:';
    this.LOCK_KEY_PREFIX = 'trade:strategy:lock:';
  }

  async initialize() {
    try {
      // 1. 恢复未完成的策略
      const activeStrategies = await this.db.models.TradeStrategy.findAll({
        where: {
          status: STRATEGY_STATUS.ACTIVE
        }
      });

      // 2. 重新加入队列
      for (const strategy of activeStrategies) {
        await this.queueStrategy(strategy);
      }

      logger.info('Trade strategy service initialized', {
        activeStrategies: activeStrategies.length
      });
    } catch (error) {
      logger.error('Failed to initialize trade strategy service:', error);
      throw error;
    }
  }

  async createStrategy(params) {
    const transaction = await this.db.sequelize.transaction();

    try {
      // 1. 验证策略参数
      this.validateStrategyParams(params);

      // 2. 生成策略ID和批次号
      const strategyId = uuidv4();
      const batchId = `batch_${Date.now()}_${strategyId}`;

      // 3. 创建策略记录
      const strategy = await this.db.models.TradeStrategy.create({
        id: strategyId,
        batchId,
        ...params,
        status: STRATEGY_STATUS.PENDING,
        metadata: {
          createdAt: new Date(),
          lastExecutionTime: null
        }
      }, { transaction });

      // 4. 缓存策略数据
      await this._cacheStrategy(strategy);

      // 5. 提交事务
      await transaction.commit();

      // 6. 加入执行队列
      await this.queueStrategy(strategy);

      logger.info('Strategy created successfully', {
        strategyId,
        batchId
      });

      return strategy;

    } catch (error) {
      await transaction.rollback();
      logger.error('Failed to create strategy:', error);
      throw error;
    }
  }

  async updateStrategy(strategyId, updates) {
    const transaction = await this.db.sequelize.transaction();

    try {
      // 1. 获取策略并加锁
      const lockKey = `${this.LOCK_KEY_PREFIX}${strategyId}`;
      const locked = await this.lockManager.acquireLock(lockKey);
      if (!locked) {
        throw new Error('Strategy is currently locked');
      }

      try {
        // 2. 更新数据库
        const [updatedCount, [updatedStrategy]] = await this.db.models.TradeStrategy.update(
            {
              ...updates,
              metadata: {
                ...updates.metadata,
                lastUpdatedAt: new Date()
              }
            },
            {
              where: { id: strategyId },
              returning: true,
              transaction
            }
        );

        if (updatedCount === 0) {
          throw new Error('Strategy not found');
        }

        // 3. 更新缓存
        await this._cacheStrategy(updatedStrategy);

        // 4. 如果状态变更，处理相关逻辑
        if (updates.status) {
          await this._handleStatusChange(updatedStrategy, updates.status);
        }

        await transaction.commit();
        return updatedStrategy;

      } finally {
        await this.lockManager.releaseLock(lockKey);
      }

    } catch (error) {
      await transaction.rollback();
      logger.error('Failed to update strategy:', error);
      throw error;
    }
  }

  async getStrategy(strategyId) {
    try {
      // 1. 先从缓存获取
      const cached = await this.redis.get(`${this.STRATEGY_KEY_PREFIX}${strategyId}`);
      if (cached) {
        return JSON.parse(cached);
      }

      // 2. 从数据库获取
      const strategy = await this.db.models.TradeStrategy.findByPk(strategyId, {
        include: [{
          model: this.db.models.TradeExecution,
          as: 'executions',
          limit: 10,
          order: [['createdAt', 'DESC']]
        }]
      });

      if (strategy) {
        // 3. 更新缓存
        await this._cacheStrategy(strategy);
      }

      return strategy;

    } catch (error) {
      logger.error('Failed to get strategy:', error);
      throw error;
    }
  }

  async deleteStrategy(strategyId) {
    const transaction = await this.db.sequelize.transaction();

    try {
      // 1. 获取锁
      const lockKey = `${this.LOCK_KEY_PREFIX}${strategyId}`;
      const locked = await this.lockManager.acquireLock(lockKey);
      if (!locked) {
        throw new Error('Strategy is currently locked');
      }

      try {
        // 2. 检查是否有正在执行的任务
        const activeExecutions = await this.db.models.TradeExecution.count({
          where: {
            strategyId,
            status: 'processing'
          }
        });

        if (activeExecutions > 0) {
          throw new Error('Cannot delete strategy with active executions');
        }

        // 3. 删除策略
        await this.db.models.TradeStrategy.destroy({
          where: { id: strategyId },
          transaction
        });

        // 4. 清除相关数据
        await this._cleanupStrategyData(strategyId, transaction);

        // 5. 提交事务
        await transaction.commit();

        logger.info('Strategy deleted successfully', { strategyId });

      } finally {
        await this.lockManager.releaseLock(lockKey);
      }

    } catch (error) {
      await transaction.rollback();
      logger.error('Failed to delete strategy:', error);
      throw error;
    }
  }

  async queueStrategy(strategy) {
    try {
      const message = {
        strategyId: strategy.id,
        batchId: strategy.batchId,
        type: strategy.type,
        round: 0
      };

      await this.redis.lpush(this.QUEUE_KEY, JSON.stringify(message));

      logger.info('Strategy queued successfully', {
        strategyId: strategy.id,
        batchId: strategy.batchId
      });

    } catch (error) {
      logger.error('Failed to queue strategy:', error);
      throw error;
    }
  }

  async checkDataConsistency(strategyId) {
    try {
      const [dbStrategy, cachedStrategy] = await Promise.all([
        this.db.models.TradeStrategy.findByPk(strategyId),
        this.redis.get(`${this.STRATEGY_KEY_PREFIX}${strategyId}`)
            .then(JSON.parse)
      ]);

      if (!this._areStrategiesEqual(dbStrategy, cachedStrategy)) {
        logger.warn('Strategy data inconsistency detected', { strategyId });
        await this._cacheStrategy(dbStrategy);
        return false;
      }

      return true;

    } catch (error) {
      logger.error('Failed to check data consistency:', error);
      return false;
    }
  }

  validateStrategyParams(params) {
    // 基本参数验证
    if (!params.name || typeof params.name !== 'string') {
      throw new Error('Invalid strategy name');
    }

    if (!params.type || !['single', 'combo'].includes(params.type)) {
      throw new Error('Invalid strategy type');
    }

    if (!params.groupType || typeof params.groupType !== 'string') {
      throw new Error('Invalid group type');
    }

    if (!params.accountRange || !/^\d+-\d+$/.test(params.accountRange)) {
      throw new Error('Invalid account range format');
    }

    // 交易规则验证
    if (!params.rules || typeof params.rules !== 'object') {
      throw new Error('Invalid trading rules');
    }

    // 验证买入规则
    if (params.rules.buy) {
      if (typeof params.rules.buy.amount !== 'number' || params.rules.buy.amount <= 0) {
        throw new Error('Invalid buy amount');
      }
    }

    // 验证卖出规则
    if (params.rules.sell) {
      if (typeof params.rules.sell.percentage !== 'number' ||
          params.rules.sell.percentage <= 0 ||
          params.rules.sell.percentage > 100) {
        throw new Error('Invalid sell percentage');
      }
    }
  }

  async _cacheStrategy(strategy) {
    try {
      await this.redis.set(
          `${this.STRATEGY_KEY_PREFIX}${strategy.id}`,
          JSON.stringify(strategy),
          'EX',
          300 // 5分钟缓存
      );
    } catch (error) {
      logger.warn('Failed to cache strategy:', error);
    }
  }

  async _handleStatusChange(strategy, newStatus) {
    switch (newStatus) {
      case STRATEGY_STATUS.ACTIVE:
        await this.queueStrategy(strategy);
        break;
      case STRATEGY_STATUS.PAUSED:
        // 清除队列中的任务
        await this.redis.lrem(this.QUEUE_KEY, 0, strategy.id);
        break;
      case STRATEGY_STATUS.COMPLETED:
        // 清理相关数据
        await this._cleanupStrategyData(strategy.id);
        break;
    }
  }

  async _cleanupStrategyData(strategyId, transaction) {
    const multi = this.redis.multi();

    // 清除缓存
    multi.del(`${this.STRATEGY_KEY_PREFIX}${strategyId}`);

    // 清除队列中的任务
    multi.lrem(this.QUEUE_KEY, 0, strategyId);

    await multi.exec();

    // 清除执行记录
    if (transaction) {
      await this.db.models.TradeExecution.destroy({
        where: { strategyId },
        transaction
      });
    }
  }

  _areStrategiesEqual(s1, s2) {
    if (!s1 || !s2) return false;

    const keys = ['status', 'rules', 'currentRound', 'totalRounds'];
    return keys.every(k => JSON.stringify(s1[k]) === JSON.stringify(s2[k]));
  }
}