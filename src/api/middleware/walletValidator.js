import { body, param } from 'express-validator';

export const walletValidators = {
    // 创建钱包的验证规则
    create: [
        body('groupType').isString().notEmpty(),
        body('accountNumber').isInt({ min: 1 })
    ],

    // 获取余额的验证规则
    getBalance: [
        param('groupType').isString().notEmpty(),
        param('accountNumber').isInt({ min: 1 })
    ],

    // 获取代币余额的验证规则
    getTokenBalance: [
        param('groupType').isString().notEmpty(),
        param('accountNumber').isInt({ min: 1 }),
        param('mintAddress').isString().notEmpty()
    ],

    // 批量获取代币余额的验证规则
    getBatchTokenBalances: [
        param('groupType').isString().notEmpty(),
        param('accountNumber').isInt({ min: 1 }),
        body('mintAddresses').isArray().notEmpty()
    ],

    // 订阅代币的验证规则
    subscribeTokens: [
        param('groupType').isString().notEmpty(),
        param('accountNumber').isInt({ min: 1 }),
        body('mintAddresses').isArray().notEmpty()
    ],

    // 关闭钱包的验证规则
    close: [
        param('groupType').isString().notEmpty(),
        param('accountNumber').isInt({ min: 1 }),
        body('recipientGroupType').isString().notEmpty(),
        body('recipientAccountNumber').isInt({ min: 1 })
    ],

    // 批量关闭钱包的验证规则
    closeBatchWallets: [
        param('groupType').isString().notEmpty(),
        body('accountRange').matches(/^\d+-\d+$/).withMessage('Account range must be in format "start-end"'),
        body('recipientGroupType').isString().notEmpty(),
        body('recipientAccountNumber').isInt({ min: 1 })
    ],

    // 批量创建钱包的验证规则
    batchCreate: [
        body('groupType').isString().notEmpty(),
        body('count').isInt({ min: 1, max: 100 })
            .withMessage('Count must be between 1 and 100')
    ],

    // 导入钱包的验证规则
    import: [
        body('groupType').isString().notEmpty()
            .withMessage('Group type is required'),
        body('accountNumber').isInt({ min: 1 })
            .withMessage('Account number must be a positive integer'),
        body('privateKey').isString().notEmpty()
            .withMessage('Private key is required')
            .isBase58()
            .withMessage('Invalid private key format')
    ],

    // 获取私钥的验证规则
    getPrivateKey: [
        param('groupType').isString().notEmpty(),
        param('accountNumber').isInt({ min: 1 })
    ],

    // 转账的验证规则
    transfer: [
        body('fromGroup').isString().notEmpty()
            .withMessage('From group is required'),
        body('fromAccount').isInt({ min: 1 })
            .withMessage('From account must be a positive integer'),
        body('toGroup').isString().notEmpty()
            .withMessage('To group is required'),
        body('toAccount').isInt({ min: 1 })
            .withMessage('To account must be a positive integer'),
        body('amount').isFloat({ min: 0.000001 })
            .withMessage('Amount must be greater than 0.000001 SOL')
    ]
}; 