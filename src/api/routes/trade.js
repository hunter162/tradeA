import { Router } from 'express';
import { asyncHandler } from '../../modules/utils/errors.js';
import { tradeValidators } from '../middleware/tradeValidator.js';
import { validateRequest } from '../middleware/validator.js';

export function createTradeRoutes(tradeController) {
    const router = Router();

    // 买入代币
    router.post('/buy',
        tradeValidators.buy,
        validateRequest,
        asyncHandler(async (req, res) => {
            await tradeController.buyTokens(req, res);
        })
    );

    // 卖出代币
    router.post('/sell',
        tradeValidators.sell,
        validateRequest,
        asyncHandler(async (req, res) => {
            await tradeController.sellTokens(req, res);
        })
    );

    // 获取代币价格
    router.get('/price/:tokenAddress',
        tradeValidators.getPrice,
        validateRequest,
        asyncHandler(async (req, res) => {
            await tradeController.getTokenPrice(req, res);
        })
    );

    // 获取代币余额
    router.get('/balance/:groupType/:accountNumber/:tokenAddress',
        tradeValidators.getBalance,
        validateRequest,
        asyncHandler(async (req, res) => {
            await tradeController.getTokenBalance(req, res);
        })
    );

    // 创建交易记录
    router.post('/',
        tradeValidators.create,
        validateRequest,
        asyncHandler(async (req, res) => {
            await tradeController.createTrade(req, res);
        })
    );

    // 获取交易列表
    router.get('/',
        tradeValidators.list,
        validateRequest,
        asyncHandler(async (req, res) => {
            await tradeController.getTrades(req, res);
        })
    );

    // 获取单个交易详情
    router.get('/:tradeId',
        tradeValidators.getOne,
        validateRequest,
        asyncHandler(async (req, res) => {
            await tradeController.getTrade(req, res);
        })
    );

    // 更新交易状态
    router.put('/:tradeId/status',
        tradeValidators.updateStatus,
        validateRequest,
        asyncHandler(async (req, res) => {
            await tradeController.updateTradeStatus(req, res);
        })
    );

    // 取消交易
    router.post('/:tradeId/cancel',
        tradeValidators.cancel,
        validateRequest,
        asyncHandler(async (req, res) => {
            await tradeController.cancelTrade(req, res);
        })
    );

    return router;
}