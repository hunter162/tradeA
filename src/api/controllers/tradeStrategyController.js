import { logger } from '../../modules/utils/index.js';
import db from '../../modules/db/index.js';
import { STRATEGY_TYPES } from '../../constants/trade.js';

export class TradeStrategyController {
    constructor(tradeTaskGenerator) {
        this.generator = tradeTaskGenerator;
    }

    // 验证策略是否存在的辅助方法
    async validateStrategyExists(strategyId) {
        const strategy = await db.models.TradeStrategy.findByPk(strategyId);
        if (!strategy) {
            throw new Error('Strategy not found');
        }
        return strategy;
    }

    // 验证策略参数的辅助方法
    validateStrategy(strategy) {
        if (!strategy.name || typeof strategy.name !== 'string') {
            throw new Error('Invalid strategy name');
        }

        if (!strategy.type || !STRATEGY_TYPES.includes(strategy.type)) {
            throw new Error('Invalid strategy type');
        }

        if (!strategy.groupType || typeof strategy.groupType !== 'string') {
            throw new Error('Invalid group type');
        }

        if (!strategy.accountRange || !/^\d+-\d+$/.test(strategy.accountRange)) {
            throw new Error('Invalid account range format');
        }

        if (!strategy.token || typeof strategy.token !== 'string') {
            throw new Error('Invalid token');
        }

        if (!strategy.rules || typeof strategy.rules !== 'object') {
            throw new Error('Invalid rules');
        }
    }

    // 创建新策略
    async createStrategy(req, res) {
        try {
            const strategy = req.body;

            // 1. 验证策略参数
            this.validateStrategy(strategy);

            // 2. 保存策略到数据库
            const savedStrategy = await db.models.TradeStrategy.create(strategy);

            // 3. 生成交易任务
            const batchId = await this.generator.addStrategy(savedStrategy);

            res.json({
                success: true,
                data: {
                    strategy: savedStrategy,
                    batchId
                }
            });
        } catch (error) {
            logger.error('创建交易策略失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 获取策略列表
    async getStrategies(req, res) {
        try {
            const { status, page = 1, limit = 10 } = req.query;

            const where = {};
            if (status) {
                where.status = status;
            }

            const strategies = await db.models.TradeStrategy.findAndCountAll({
                where,
                limit: parseInt(limit),
                offset: (page - 1) * limit,
                order: [['createdAt', 'DESC']]
            });

            res.json({
                success: true,
                data: {
                    items: strategies.rows,
                    total: strategies.count,
                    page: parseInt(page),
                    limit: parseInt(limit)
                }
            });
        } catch (error) {
            logger.error('获取策略列表失败:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }

    // 获取单个策略
    async getStrategy(req, res) {
        try {
            const { strategyId } = req.params;
            const strategy = await this.validateStrategyExists(strategyId);

            res.json({
                success: true,
                data: strategy
            });
        } catch (error) {
            logger.error('获取策略详情失败:', error);
            res.status(error.message === 'Strategy not found' ? 404 : 500).json({
                success: false,
                error: error.message
            });
        }
    }

    // 获取策略执行结果
    async getStrategyResults(req, res) {
        try {
            const { strategyId } = req.params;
            await this.validateStrategyExists(strategyId);

            const tasks = await db.models.TradeTask.findAll({
                where: { strategyId },
                order: [['createdAt', 'DESC']]
            });

            const summary = {
                total: tasks.length,
                completed: tasks.filter(t => t.status === 'completed').length,
                failed: tasks.filter(t => t.status === 'failed').length,
                pending: tasks.filter(t => t.status === 'pending').length
            };

            res.json({
                success: true,
                data: {
                    tasks,
                    summary
                }
            });
        } catch (error) {
            logger.error('获取策略结果失败:', error);
            res.status(error.message === 'Strategy not found' ? 404 : 500).json({
                success: false,
                error: error.message
            });
        }
    }

    // 启动策略
    async startStrategy(req, res) {
        try {
            const { strategyId } = req.params;
            await this.validateStrategyExists(strategyId);

            await db.models.TradeStrategy.update(
                { status: 'active' },
                { where: { id: strategyId } }
            );

            // 重新生成交易任务
            await this.generator.regenTasks(strategyId);

            res.json({
                success: true,
                message: 'Strategy started successfully'
            });
        } catch (error) {
            logger.error('启动策略失败:', error);
            res.status(error.message === 'Strategy not found' ? 404 : 500).json({
                success: false,
                error: error.message
            });
        }
    }

    // 暂停策略
    async pauseStrategy(req, res) {
        try {
            const { strategyId } = req.params;
            await this.validateStrategyExists(strategyId);

            await db.models.TradeStrategy.update(
                { status: 'paused' },
                { where: { id: strategyId } }
            );

            res.json({
                success: true,
                message: 'Strategy paused successfully'
            });
        } catch (error) {
            logger.error('暂停策略失败:', error);
            res.status(error.message === 'Strategy not found' ? 404 : 500).json({
                success: false,
                error: error.message
            });
        }
    }

    // 停止策略
    async stopStrategy(req, res) {
        try {
            const { strategyId } = req.params;
            await this.validateStrategyExists(strategyId);

            await db.models.TradeStrategy.update(
                { status: 'stopped' },
                { where: { id: strategyId } }
            );

            // 取消未执行的任务
            await this.generator.cancelTasks(strategyId);

            res.json({
                success: true,
                message: 'Strategy stopped successfully'
            });
        } catch (error) {
            logger.error('停止策略失败:', error);
            res.status(error.message === 'Strategy not found' ? 404 : 500).json({
                success: false,
                error: error.message
            });
        }
    }

    // 删除策略
    async deleteStrategy(req, res) {
        try {
            const { strategyId } = req.params;
            await this.validateStrategyExists(strategyId);

            // 先取消所有任务
            await this.generator.cancelTasks(strategyId);

            // 然后删除策略
            await db.models.TradeStrategy.destroy({
                where: { id: strategyId }
            });

            res.json({
                success: true,
                message: 'Strategy deleted successfully'
            });
        } catch (error) {
            logger.error('删除策略失败:', error);
            res.status(error.message === 'Strategy not found' ? 404 : 500).json({
                success: false,
                error: error.message
            });
        }
    }

    // 获取执行记录
    async getExecutions(req, res) {
        try {
            const { strategyId, status, page = 1, limit = 10, fromDate, toDate } = req.query;

            const where = {};
            if (strategyId) {
                await this.validateStrategyExists(strategyId);
                where.strategyId = strategyId;
            }
            if (status) {
                where.status = status;
            }
            if (fromDate && toDate) {
                where.createdAt = {
                    [db.Sequelize.Op.between]: [fromDate, toDate]
                };
            }

            const executions = await db.models.TradeTask.findAndCountAll({
                where,
                limit: parseInt(limit),
                offset: (page - 1) * limit,
                order: [['createdAt', 'DESC']],
                include: [{
                    model: db.models.TradeStrategy,
                    attributes: ['name', 'type']
                }]
            });

            res.json({
                success: true,
                data: {
                    items: executions.rows,
                    total: executions.count,
                    page: parseInt(page),
                    limit: parseInt(limit)
                }
            });
        } catch (error) {
            logger.error('获取执行记录失败:', error);
            res.status(error.message === 'Strategy not found' ? 404 : 500).json({
                success: false,
                error: error.message
            });
        }
    }
}