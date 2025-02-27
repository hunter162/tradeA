import {body, param} from 'express-validator';

export const solanaValidators = {
    // 获取账户信息的验证规则
    getAccount: [
        param('publicKey').isString().notEmpty()
            .matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
            .withMessage('Invalid Solana public key')
    ],

    // 获取交易信息的验证规则
    getTransaction: [
        param('signature').isString().notEmpty()
            .matches(/^[1-9A-HJ-NP-Za-km-z]{87,88}$/)
            .withMessage('Invalid Solana transaction signature')
    ],

    // 获取代币信息的验证规则
    getToken: [
        param('mintAddress').isString().notEmpty()
            .matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
            .withMessage('Invalid Solana token mint address')
    ],
    batchBuy: [
        body('mainGroup').isString().notEmpty()
            .withMessage('Main group is required'),
        body('mainAccountNumber').isInt({ min: 1 })
            .withMessage('Main account number must be a positive integer'),
        body('tradeGroup').isString().notEmpty()
            .withMessage('Trade group is required'),
        body('makersCount').isInt()
            .custom(value => [4, 50, 100, 500, 1000].includes(value))
            .withMessage('Makers count must be one of: 4, 50, 100, 500, 1000'),
        body('amountStrategy').isString()
            .isIn(['fixed', 'random', 'percentage'])
            .withMessage('Invalid amount strategy'),
        body('amountConfig').isObject()
            .custom((value, { req }) => {
                switch(req.body.amountStrategy) {
                    case 'fixed':
                        return typeof value.fixedAmount === 'number' && value.fixedAmount > 0;
                    case 'random':
                        return typeof value.minAmount === 'number'
                            && typeof value.maxAmount === 'number'
                            && value.minAmount < value.maxAmount
                            && value.minAmount > 0;
                    case 'percentage':
                        return typeof value.percentage === 'number'
                            && value.percentage > 0
                            && value.percentage <= 100;
                    default:
                        return false;
                }
            })
            .withMessage('Invalid amount configuration'),
        body('jitoTipSol').isFloat({ min: 0 })
            .withMessage('Jito tip must be a non-negative number'),
        body('mintAddress').isString()
            .matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
            .withMessage('Invalid Solana token mint address')
    ],
    calculateFees: [
        body('amountStrategy').isString()
            .isIn(['fixed', 'random', 'percentage'])
            .withMessage('Invalid amount strategy'),

        body('amountConfig').isObject()
            .custom((value, { req }) => {
                switch(req.body.amountStrategy) {
                    case 'fixed':
                        return typeof value.fixedAmount === 'number' && value.fixedAmount > 0;
                    case 'random':
                        return typeof value.minAmount === 'number'
                            && typeof value.maxAmount === 'number'
                            && value.minAmount < value.maxAmount
                            && value.minAmount > 0;
                    case 'percentage':
                        return typeof value.percentage === 'number'
                            && value.percentage > 0
                            && value.percentage <= 100;
                    default:
                        return false;
                }
            })
            .withMessage('Invalid amount configuration'),

        body('jitoTipSol').isFloat({ min: 0 })
            .withMessage('Jito tip must be a non-negative number'),

        body('mainAccountBalance')
            .optional()
            .isFloat({ min: 0 })
            .withMessage('Main account balance must be a non-negative number')
    ],
    batchBuyDirect: [
        body('buyerGroup').isString().notEmpty()
            .withMessage('买入钱包所属组(buyerGroup)为必填项'),

        body('accountRange')
            .custom(value => {
                // Check if it's an array
                if (Array.isArray(value)) {
                    return value.length > 0 && value.every(num => Number.isInteger(num) && num > 0);
                }
                // Check if it's a {start, end} object
                else if (typeof value === 'object' && 'start' in value && 'end' in value) {
                    return Number.isInteger(value.start) && Number.isInteger(value.end) &&
                        value.start > 0 && value.end >= value.start;
                }
                return false;
            })
            .withMessage('账户范围必须是数值数组或者{start, end}对象'),

        body('mintAddress').isString()
            .matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
            .withMessage('无效的Solana代币地址'),

        // Amount strategy validation - only one should be provided
        body()
            .custom(body => {
                const strategies = [
                    'fixedAmount' in body,
                    'randomRange' in body,
                    'percentageOfBalance' in body
                ].filter(Boolean);

                return strategies.length === 1;
            })
            .withMessage('必须且只能提供一种金额策略: fixedAmount, randomRange 或 percentageOfBalance'),

        // Fixed amount validation
        body('fixedAmount')
            .optional()
            .isFloat({ min: 0.000001 })
            .withMessage('固定金额必须大于0.000001 SOL'),

        // Random range validation
        body('randomRange')
            .optional()
            .isObject()
            .withMessage('随机范围必须是对象格式'),

        body('randomRange.min')
            .optional()
            .isFloat({ min: 0.000001 })
            .withMessage('最小随机金额必须大于0.000001 SOL'),

        body('randomRange.max')
            .optional()
            .isFloat()
            .withMessage('最大随机金额必须是有效数字'),

        body('randomRange')
            .optional()
            .custom((value) => {
                return value.min < value.max;
            })
            .withMessage('最小随机金额必须小于最大随机金额'),

        // Percentage validation
        body('percentageOfBalance')
            .optional()
            .isFloat({ min: 0.01, max: 100 })
            .withMessage('余额百分比必须在0.01到100之间'),

        // Options validation
        body('options').optional().isObject(),

        body('options.slippage')
            .optional()
            .isInt({ min: 0, max: 10000 })
            .withMessage('滑点必须在0到10000基点之间 (10000 = 100%)'),

        body('options.usePriorityFee')
            .optional()
            .isBoolean()
            .withMessage('usePriorityFee必须是布尔值'),

        body('options.jitoTipSol')
            .optional()
            .isFloat({ min: 0 })
            .withMessage('Jito小费必须是非负数'),

        body('options.bundleSize')
            .optional()
            .isInt({ min: 1, max: 20 })
            .withMessage('Bundle大小必须在1到20之间'),

        body('options.waitBetweenMs')
            .optional()
            .isInt({ min: 0, max: 5000 })
            .withMessage('Bundle间等待时间必须在0到5000毫秒之间'),

        body('options.retryAttempts')
            .optional()
            .isInt({ min: 0, max: 10 })
            .withMessage('重试次数必须在0到10之间')
    ],
    batchSellDirect: [
        body('sellerGroup').isString().notEmpty()
            .withMessage('Seller group is required'),
        body('accountRange')
            .custom(value => {
                // Check if it's an array
                if (Array.isArray(value)) {
                    return value.length > 0 && value.every(num => Number.isInteger(num) && num > 0);
                }
                // Check if it's a {start, end} object
                else if (typeof value === 'object' && 'start' in value && 'end' in value) {
                    return Number.isInteger(value.start) && Number.isInteger(value.end) &&
                        value.start > 0 && value.end >= value.start;
                }
                return false;
            })
            .withMessage('Account range must be an array of numbers or {start, end} object'),
        body('mintAddress').isString()
            .matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
            .withMessage('Invalid Solana token mint address'),
        body('percentage').isFloat({ min: 0.01, max: 100 })
            .withMessage('Percentage must be between 0.01 and 100'),
        body('options').optional().isObject(),
        body('options.slippage')
            .optional()
            .isInt({ min: 0, max: 10000 })
            .withMessage('Slippage must be between 0 and 10000 basis points (10000 = 100%)'),
        body('options.usePriorityFee')
            .optional()
            .isBoolean()
            .withMessage('usePriorityFee must be a boolean'),
        body('options.jitoTipSol')
            .optional()
            .isFloat({ min: 0 })
            .withMessage('Jito tip must be a non-negative number'),
        body('options.bundleSize')
            .optional()
            .isInt({ min: 1, max: 20 })
            .withMessage('Bundle size must be between 1 and 20'),
        body('options.waitBetweenMs')
            .optional()
            .isInt({ min: 0, max: 5000 })
            .withMessage('Wait between bundles must be between 0 and 5000 milliseconds')
    ],
    batchBuyAndSell: [
        body('groupType')
            .isString()
            .notEmpty()
            .withMessage('Group type is required'),

        body('accountNumbers')
            .custom((value) => {
                // 数组形式验证
                if (Array.isArray(value)) {
                    if (value.length === 0) {
                        throw new Error('Account numbers array cannot be empty');
                    }
                    if (value.length > 1000) {
                        throw new Error('Too many accounts (max 1000)');
                    }
                    const isValid = value.every(num =>
                        Number.isInteger(num) && num >= 1 && num <= 1000
                    );
                    if (!isValid) {
                        throw new Error('Account numbers must be integers between 1 and 1000');
                    }
                    return true;
                }

                // 范围对象形式验证
                if (typeof value === 'object' && 'start' in value && 'end' in value) {
                    const start = Number(value.start);
                    const end = Number(value.end);

                    if (!Number.isInteger(start) || !Number.isInteger(end)) {
                        throw new Error('Start and end must be integers');
                    }

                    if (start < 1 || end > 1000) {
                        throw new Error('Account range must be between 1 and 1000');
                    }

                    if (start > end) {
                        throw new Error('Start must be less than or equal to end');
                    }

                    if (end - start > 1000) {
                        throw new Error('Range too large (max 1000 accounts)');
                    }

                    return true;
                }

                throw new Error('Invalid account numbers format');
            })
            .withMessage('Invalid account numbers format or range'),

        body('tokenAddress')
            .isString()
            .matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
            .withMessage('Invalid Solana token address'),

        body('amountStrategy')
            .optional()
            .isString()
            .isIn(['fixed', 'random', 'percentage', 'all'])
            .withMessage('Amount strategy must be one of: fixed, random, percentage, all'),

        // 根据策略验证对应参数
        body()
            .custom((body) => {
                const strategy = body.amountStrategy || 'fixed';

                switch (strategy) {
                    case 'fixed':
                        if (typeof body.amountSol !== 'number' || body.amountSol <= 0) {
                            throw new Error('Fixed strategy requires a valid amountSol value');
                        }
                        break;

                    case 'random':
                        if (!body.amountConfig || !body.amountConfig.minAmount || !body.amountConfig.maxAmount ||
                            body.amountConfig.minAmount >= body.amountConfig.maxAmount) {
                            throw new Error('Random strategy requires valid minAmount and maxAmount');
                        }
                        break;

                    case 'percentage':
                        if (!body.amountConfig || typeof body.amountConfig.percentage !== 'number' ||
                            body.amountConfig.percentage <= 0 || body.amountConfig.percentage > 100) {
                            throw new Error('Percentage strategy requires a valid percentage value (0-100)');
                        }
                        break;
                }

                return true;
            }),

        body('sellPercentage')
            .optional()
            .isFloat({ min: 0, max: 100 })
            .withMessage('Sell percentage must be between 0 and 100'),

        body('slippage')
            .optional()
            .isInt({ min: 0, max: 10000 })
            .withMessage('Slippage must be between 0 and 10000 basis points'),

        body('tipAmountSol')
            .optional()
            .isFloat({ min: 0 })
            .withMessage('Tip amount must be non-negative'),

        body('loopCount')
            .optional()
            .isInt({ min: 1, max: 10 })
            .withMessage('Loop count must be between 1 and 10'),

        body('firstLoopDelay')
            .optional()
            .isInt({ min: 0, max: 300000 })
            .withMessage('First loop delay must be between 0 and 300000 ms'),

        body('options')
            .optional()
            .isObject()
            .withMessage('Options must be an object')
    ]
}; 