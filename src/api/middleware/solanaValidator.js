import { param } from 'express-validator';

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
    ]
}; 