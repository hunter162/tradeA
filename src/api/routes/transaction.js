import { Router } from 'express';
import { asyncHandler } from '../../modules/utils/errors.js';
import { transactionValidators } from '../middleware/transactionValidator.js';
import { validateRequest } from '../middleware/validator.js';

export function createTransactionRoutes(transactionController) {
    const router = Router();

    // 获取交易历史
    router.get('/',
        transactionValidators.list,
        validateRequest,
        asyncHandler(async (req, res) => {
            await transactionController.getTransactions(req, res);
        })
    );

    // 获取单个交易详情
    router.get('/:signature',
        transactionValidators.getOne,
        validateRequest,
        asyncHandler(async (req, res) => {
            await transactionController.getTransaction(req, res);
        })
    );

    // 获取钱包的交易历史
    router.get('/wallet/:groupType/:accountNumber',
        transactionValidators.getWalletTransactions,
        validateRequest,
        asyncHandler(async (req, res) => {
            await transactionController.getWalletTransactions(req, res);
        })
    );

    // 获取代币的交易历史
    router.get('/token/:mintAddress',
        transactionValidators.getTokenTransactions,
        validateRequest,
        asyncHandler(async (req, res) => {
            await transactionController.getTokenTransactions(req, res);
        })
    );
    router.get('/token/:mintAddress',
        transactionValidators.getTokenTransactions,
        validateRequest,
        asyncHandler(async (req, res) => {
            await transactionController.getTokenTransactions(req, res);
        })
    );

    return router;
} 