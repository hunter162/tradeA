import { body, query, param } from 'express-validator';
import { STRATEGY_TYPES, STRATEGY_STATUSES, EXECUTION_STATUSES, MAX_RETRIES, MIN_INTERVAL } from '../../constants/trade.js';

export const tradeStrategyValidators = {
    // 创建策略的验证规则
    create: [
        body('name').isString().notEmpty().withMessage('Strategy name is required'),
        body('type').isIn(STRATEGY_TYPES).withMessage('Invalid strategy type'),
        body('groupType').isString().notEmpty().withMessage('Group type is required'),
        body('accountRange').matches(/^\d+-\d+$/).withMessage('Invalid account range format'),
        body('token').isString().notEmpty().withMessage('Token is required'),
        body('rules').isObject().withMessage('Rules must be an object'),
        body('rules.buy').optional().isObject(),
        body('rules.buy.price').optional().isFloat({ min: 0 }),
        body('rules.buy.amount').optional().isFloat({ min: 0 }),
        body('rules.sell').optional().isObject(),
        body('rules.sell.price').optional().isFloat({ min: 0 }),
        body('rules.sell.percentage').optional().isFloat({ min: 0, max: 100 }),
        body('rules.interval').optional().isInt({ min: MIN_INTERVAL }),
        body('rules.retries').optional().isInt({ min: 0, max: MAX_RETRIES })
    ],

    // 获取策略列表的验证规则
    list: [
        query('status').optional().isIn(STRATEGY_STATUSES).withMessage('Invalid status'),
        query('page').optional().isInt({ min: 1 }).withMessage('Invalid page number'),
        query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Invalid limit')
    ],

    // 获取单个策略的验证规则
    getStrategy: [
        param('strategyId').isString().notEmpty().withMessage('Strategy ID is required')
    ],

    // 获取策略执行结果的验证规则
    getResults: [
        param('strategyId').isString().notEmpty().withMessage('Strategy ID is required')
    ],

    // 启动策略的验证规则
    startStrategy: [
        param('strategyId').isString().notEmpty().withMessage('Strategy ID is required')
    ],

    // 暂停策略的验证规则
    pause: [
        param('strategyId').isString().notEmpty().withMessage('Strategy ID is required')
    ],

    // 停止策略的验证规则
    stopStrategy: [
        param('strategyId').isString().notEmpty().withMessage('Strategy ID is required')
    ],

    // 删除策略的验证规则
    deleteStrategy: [
        param('strategyId').isString().notEmpty().withMessage('Strategy ID is required')
    ],

    // 获取执行记录的验证规则
    getExecutions: [
        query('strategyId').optional().isString(),
        query('status').optional().isIn(EXECUTION_STATUSES).withMessage('Invalid status'),
        query('page').optional().isInt({ min: 1 }).withMessage('Invalid page number'),
        query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Invalid limit'),
        query('fromDate').optional().isISO8601().withMessage('Invalid from date'),
        query('toDate').optional().isISO8601().withMessage('Invalid to date')
    ]
};