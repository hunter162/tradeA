import { body, param, query } from 'express-validator';

export const transactionValidators = {
    transfer: [
        body('fromGroup').isString().notEmpty(),
        body('fromAccount').isInt({ min: 1 }),
        body('toGroup').isString().notEmpty(),
        body('toAccount').isInt({ min: 1 }),
        body('amount').isFloat({ min: 0.000001 })
    ],

    batchTransfer: [
        body('fromGroup').isString().notEmpty(),
        body('fromAccount').isInt({ min: 1 }),
        body('transfers').isArray().notEmpty(),
        body('transfers.*.toGroup').isString().notEmpty(),
        body('transfers.*.toAccount').isInt({ min: 1 }),
        body('transfers.*.amount').isFloat({ min: 0.000001 })
    ],

    collectFunds: [
        body('fromGroup').isString().notEmpty(),
        body('accountRange').matches(/^\d+-\d+$/),
        body('toGroup').isString().notEmpty(),
        body('toAccount').isInt({ min: 1 })
    ],

    getHistory: [
        param('groupType').isString().notEmpty(),
        param('accountNumber').isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),
        query('before').optional().isISO8601()
    ],

    // 获取交易列表的验证规则
    list: [
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),
        query('fromDate').optional().isISO8601(),
        query('toDate').optional().isISO8601(),
        query('type').optional().isIn(['transfer', 'swap', 'stake', 'unstake'])
    ],

    // 获取单个交易的验证规则
    getOne: [
        param('signature').isString().notEmpty()
            .matches(/^[1-9A-HJ-NP-Za-km-z]{87,88}$/)
            .withMessage('Invalid Solana transaction signature')
    ],

    // 获取钱包交易历史的验证规则
    getWalletTransactions: [
        param('groupType').isString().notEmpty(),
        param('accountNumber').isInt({ min: 1 }),
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),
        query('fromDate').optional().isISO8601(),
        query('toDate').optional().isISO8601()
    ],

    // 获取代币交易历史的验证规则
    getTokenTransactions: [
        param('mintAddress').isString().notEmpty()
            .matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
            .withMessage('Invalid Solana token mint address'),
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),
        query('fromDate').optional().isISO8601(),
        query('toDate').optional().isISO8601()
    ]
}; 