import { body, param, query } from 'express-validator';

export const tradeValidators = {
    // 创建交易的验证规则
    create: [
        body('fromGroupType').isString().notEmpty(),
        body('fromAccountNumber').isInt({ min: 1 }),
        body('toGroupType').isString().notEmpty(),
        body('toAccountNumber').isInt({ min: 1 }),
        body('amount').isFloat({ min: 0.000001 }),
        body('tokenAddress').optional().isString(),
        body('metadata').optional().isObject()
    ],

    // 获取交易列表的验证规则
    list: [
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),
        query('status').optional().isIn(['pending', 'completed', 'failed', 'cancelled']),
        query('fromDate').optional().isISO8601(),
        query('toDate').optional().isISO8601()
    ],

    // 获取单个交易的验证规则
    getOne: [
        param('tradeId').isString().notEmpty()
    ],

    // 更新交易状态的验证规则
    updateStatus: [
        param('tradeId').isString().notEmpty(),
        body('status').isIn(['completed', 'failed', 'cancelled']),
        body('reason').optional().isString()
    ],

    // 取消交易的验证规则
    cancel: [
        param('tradeId').isString().notEmpty(),
        body('reason').optional().isString()
    ],

    // 买入代币的验证规则
    buy: [
        body('groupType').isString().notEmpty(),
        body('accountNumber').isInt({ min: 1 }),
        body('tokenAddress').isString().notEmpty(),
        body('amountSol').isFloat({ min: 0.000001 }),
        body('slippage').optional().isFloat({ min: 0, max: 100 }),
        body('usePriorityFee').optional().isBoolean(),
        body('options').optional().isObject()
    ],

    // 卖出代币的验证规则
    sell: [
        body('groupType').isString().notEmpty(),
        body('accountNumber').isInt({ min: 1 }),
        body('tokenAddress').isString().notEmpty(),
        body('percentage').isFloat({ min: 0, max: 100 }),
        body('usePriorityFee').optional().isBoolean(),
        body('options').optional().isObject()
    ],

    // 获取代币价格的验证规则
    getPrice: [
        param('tokenAddress').isString().notEmpty()
            .matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
            .withMessage('Invalid token address format')
    ],

    // 创建交易策略的验证规则
    createStrategy: [
        body('name').isString().notEmpty(),
        body('type').isString().isIn(['limit', 'market', 'stop_loss', 'trailing_stop']),
        body('conditions').isArray().notEmpty(),
        body('conditions.*.type').isString().isIn(['price', 'time', 'volume']),
        body('conditions.*.operator').isString().isIn(['>', '>=', '=', '<=', '<']),
        body('conditions.*.value').exists(),
        body('actions').isArray().notEmpty(),
        body('actions.*.type').isString().isIn(['buy', 'sell']),
        body('actions.*.params').isObject(),
        body('status').optional().isIn(['active', 'paused']),
        body('metadata').optional().isObject()
    ],

    // 获取交易执行记录的验证规则
    getExecutions: [
        query('strategyId').optional().isString(),
        query('status').optional().isIn(['pending', 'completed', 'failed']),
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),
        query('fromDate').optional().isISO8601(),
        query('toDate').optional().isISO8601()
    ],

    // 获取代币余额的验证规则
    getBalance: [
        param('groupType').isString().notEmpty(),
        param('accountNumber').isInt({ min: 1 }),
        param('tokenAddress').isString().notEmpty()
            .matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
            .withMessage('Invalid token address format')
    ]
};