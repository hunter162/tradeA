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

        body('mainAccountBalance')
            .optional()
            .isFloat({ min: 0 })
            .withMessage('Main account balance must be a non-negative number')
    ]
}; 