import { Router } from 'express';
import { asyncHandler } from '../../modules/utils/errors.js';
import { tradeStrategyValidators } from '../middleware/tradeStrategyValidator.js';
import { validateRequest } from '../middleware/validator.js';

export function createTradeStrategyRoutes(tradeStrategyController) {
    const router = Router();

    // 获取执行记录 (放在具体策略路由前面,避免路径冲突)
    router.get('/executions',
        tradeStrategyValidators.getExecutions,
        validateRequest,
        asyncHandler(async (req, res) => {
            await tradeStrategyController.getExecutions(req, res);
        })
    );

    // 创建策略
    router.post('/',
        tradeStrategyValidators.create,
        validateRequest,
        asyncHandler(async (req, res) => {
            await tradeStrategyController.createStrategy(req, res);
        })
    );

    // 获取策略列表
    router.get('/',
        tradeStrategyValidators.list,
        validateRequest,
        asyncHandler(async (req, res) => {
            await tradeStrategyController.getStrategies(req, res);
        })
    );

    // 获取单个策略详情
    router.get('/:strategyId',
        tradeStrategyValidators.getStrategy,
        validateRequest,
        asyncHandler(async (req, res) => {
            await tradeStrategyController.getStrategy(req, res);
        })
    );

    // 获取策略执行结果
    router.get('/:strategyId/results',
        tradeStrategyValidators.getResults,
        validateRequest,
        asyncHandler(async (req, res) => {
            await tradeStrategyController.getStrategyResults(req, res);
        })
    );

    // 启动策略
    router.post('/:strategyId/start',
        tradeStrategyValidators.startStrategy,
        validateRequest,
        asyncHandler(async (req, res) => {
            await tradeStrategyController.startStrategy(req, res);
        })
    );

    // 暂停策略
    router.post('/:strategyId/pause',
        tradeStrategyValidators.pause,
        validateRequest,
        asyncHandler(async (req, res) => {
            await tradeStrategyController.pauseStrategy(req, res);
        })
    );

    // 停止策略
    router.post('/:strategyId/stop',
        tradeStrategyValidators.stopStrategy,
        validateRequest,
        asyncHandler(async (req, res) => {
            await tradeStrategyController.stopStrategy(req, res);
        })
    );

    // 删除策略
    router.delete('/:strategyId',
        tradeStrategyValidators.deleteStrategy,
        validateRequest,
        asyncHandler(async (req, res) => {
            await tradeStrategyController.deleteStrategy(req, res);
        })
    );

    return router;
}