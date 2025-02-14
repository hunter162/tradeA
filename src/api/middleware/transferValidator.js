import { body } from 'express-validator';

export const transferValidators = {
    // 1对多转账验证
    oneToMany: [
        body('fromGroupType').isString().notEmpty()
            .withMessage('fromGroupType is required'),
        body('fromAccountNumber').isInt({ min: 1 })
            .withMessage('fromAccountNumber must be a positive integer'),
        body('toGroupType').isString().notEmpty()
            .withMessage('toGroupType is required'),
        body('toAccountRange').matches(/^\d+-\d+$/)
            .withMessage('toAccountRange must be in format "1-5"'),
        body('amount').optional().isFloat({ min: 0.000001 })
            .withMessage('amount must be greater than 0.000001')
    ],

    // 多对一转账验证
    manyToOne: [
        body('fromGroupType').isString().notEmpty()
            .withMessage('fromGroupType is required'),
        body('fromAccountRange').matches(/^\d+-\d+$/)
            .withMessage('fromAccountRange must be in format "1-5"'),
        body('toGroupType').isString().notEmpty()
            .withMessage('toGroupType is required'),
        body('toAccountNumber').isInt({ min: 1 })
            .withMessage('toAccountNumber must be a positive integer')
    ],

    // 多对多转账验证
    manyToMany: [
        body('transfers').isArray().notEmpty()
            .withMessage('transfers array is required'),
        body('transfers.*.fromGroup').isString().notEmpty()
            .withMessage('fromGroup is required for each transfer'),
        body('transfers.*.fromAccount').isInt({ min: 1 })
            .withMessage('fromAccount must be a positive integer'),
        body('transfers.*.toGroup').isString().notEmpty()
            .withMessage('toGroup is required for each transfer'),
        body('transfers.*.toAccount').isInt({ min: 1 })
            .withMessage('toAccount must be a positive integer'),
        body('transfers.*.amount').isFloat({ min: 0.000001 })
            .withMessage('amount must be greater than 0.000001')
    ],

    // 单笔转账验证
    transfer: [
        body('fromGroup').isString().notEmpty()
            .withMessage('fromGroup is required'),
        body('fromAccount').isInt({ min: 1 })
            .withMessage('fromAccount must be a positive integer'),
        body('toGroup').isString().notEmpty()
            .withMessage('toGroup is required'),
        body('toAccount').isInt({ min: 1 })
            .withMessage('toAccount must be a positive integer'),
        body('amount').isFloat({ min: 0.000001 })
            .withMessage('amount must be greater than 0.000001')
    ]
}; 