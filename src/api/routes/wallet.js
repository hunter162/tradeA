import { Router } from 'express';
import { asyncHandler } from '../../modules/utils/errors.js';
import { walletValidators } from '../middleware/walletValidator.js';
import { validateRequest } from '../middleware/validator.js';
import { logger } from '../../modules/utils/index.js';

export function createWalletRoutes(walletController) {
    const router = Router();

    // 创建单个钱包
    router.post('/',
        walletValidators.create,
        validateRequest,
        asyncHandler(async (req, res) => {
            await walletController.createWallet(req, res);
        })
    );

    // 批量创建钱包 - 支持两种路径
    router.post(['/batch', '/batch/count'],
        walletValidators.batchCreate,
        validateRequest,
        asyncHandler(async (req, res) => {
            await walletController.batchCreateWallets(req, res);
        })
    );

    // 获取钱包列表
    router.get('/',
        asyncHandler(async (req, res) => {
            await walletController.getWallets(req, res);
        })
    );

    // 获取钱包余额
    router.get('/:groupType/:accountNumber/balance',
        walletValidators.getBalance,
        validateRequest,
        asyncHandler(async (req, res) => {
            await walletController.getBalance(req, res);
        })
    );

    router.get('/:groupType/:accountNumber',
        asyncHandler(async (req, res) => {
            await walletController.getWallet(req, res);
        })
    );

    // 获取代币余额
    router.get('/:groupType/:accountNumber/tokens/:mintAddress/balance',
        walletValidators.getTokenBalance,
        validateRequest,
        asyncHandler(async (req, res) => {
            await walletController.getTokenBalance(req, res);
        })
    );

    // 批量获取代币余额
    router.get('/:groupType/:accountNumber/tokens/balances',
        walletValidators.getBatchTokenBalances,
        validateRequest,
        asyncHandler(async (req, res) => {
            await walletController.getBatchTokenBalances(req, res);
        })
    );

    // 订阅代币余额
    router.post('/:groupType/:accountNumber/tokens/subscribe',
        walletValidators.subscribeTokens,
        validateRequest,
        asyncHandler(async (req, res) => {
            await walletController.subscribeTokens(req, res);
        })
    );

    // 关闭钱包
    router.post('/:groupType/:accountNumber/close',
        walletValidators.close,
        validateRequest,
        asyncHandler(async (req, res) => {
            await walletController.closeWallet(req, res);
        })
    );

    // 批量关闭钱包
    router.post('/:groupType/close-batch',
        walletValidators.closeBatchWallets,
        validateRequest,
        asyncHandler(async (req, res) => {
            await walletController.closeBatchWallets(req, res);
        })
    );

    // 获取完整的 SOL 余额
    router.get('/:groupType/:accountNumber/full-balance',
        walletValidators.getBalance,
        validateRequest,
        asyncHandler(async (req, res) => {
            const { groupType, accountNumber } = req.params;

            const balance = await walletController.getFullBalance(
                groupType,
                parseInt(accountNumber)
            );

            res.json({
                success: true,
                data: balance
            });
        })
    );

    // 获取私钥
    router.get('/:groupType/:accountNumber/private-key',
        walletValidators.getPrivateKey,
        validateRequest,
        asyncHandler(async (req, res) => {
            await walletController.getPrivateKey(req, res);
        })
    );

    // 导入钱包
    router.post('/import',
        walletValidators.import,
        validateRequest,
        asyncHandler(async (req, res) => {
            await walletController.importWallet(req, res);
        })
    );

    // 转账
    router.post('/transfer',
        walletValidators.transfer,
        validateRequest,
        asyncHandler(async (req, res) => {
            await walletController.transfer(req, res);
        })
    );

    return router;
} 