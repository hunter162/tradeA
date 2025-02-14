import { body, param } from 'express-validator';

export const walletValidators = {
    // ... 其他验证器 ...

    // 关闭钱包验证
    closeWallet: [
        param('groupType').isString().notEmpty()
            .withMessage('Group type is required'),
        param('accountNumber').isInt({ min: 1 })
            .withMessage('Account number must be a positive integer'),
        body('recipientGroupType').isString().notEmpty()
            .withMessage('Recipient group type is required'),
        body('recipientAccountNumber').isInt({ min: 1 })
            .withMessage('Recipient account number must be a positive integer')
    ],

    // 批量关闭钱包验证
    closeBatchWallets: [
        param('groupType').isString().notEmpty()
            .withMessage('Group type is required'),
        body('accountRange').matches(/^\d+-\d+$/)
            .withMessage('Account range must be in format "1-5"'),
        body('recipientGroupType').isString().notEmpty()
            .withMessage('Recipient group type is required'),
        body('recipientAccountNumber').isInt({ min: 1 })
            .withMessage('Recipient account number must be a positive integer')
    ]
}; 