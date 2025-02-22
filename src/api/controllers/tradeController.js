import { logger } from '../../modules/utils/index.js';
import db from '../../modules/db/index.js';

export class TradeController {
    constructor(solanaService, walletService, tokenTradeService) {
        if (!solanaService || !walletService || !tokenTradeService) {
            throw new Error('Required services are missing');
        }
        this.solanaService = solanaService;
        this.walletService = walletService;
        this.tokenTradeService = tokenTradeService;
    }

    // 初始化服务
    async initialize() {
        await this.solanaService.initialize();
    }

    // 创建交易
    async createTrade(req, res) {
        try {
            const tradeData = req.body;
            const trade = await db.models.Trade.create(tradeData);

            res.json({
                success: true,
                data: trade
            });
        } catch (error) {
            logger.error('创建交易失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 获取交易列表
    async getTrades(req, res) {
        try {
            const { status, page = 1, limit = 10 } = req.query;

            const where = {};
            if (status) where.status = status;

            const trades = await db.models.Trade.findAndCountAll({
                where,
                limit: parseInt(limit),
                offset: (page - 1) * limit,
                order: [['createdAt', 'DESC']]
            });

            res.json({
                success: true,
                data: {
                    items: trades.rows,
                    total: trades.count,
                    page: parseInt(page),
                    limit: parseInt(limit)
                }
            });
        } catch (error) {
            logger.error('获取交易列表失败:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }

    // 获取单个交易
    async getTrade(req, res) {
        try {
            const { tradeId } = req.params;
            const trade = await db.models.Trade.findByPk(tradeId);

            if (!trade) {
                return res.status(404).json({
                    success: false,
                    error: 'Trade not found'
                });
            }

            res.json({
                success: true,
                data: trade
            });
        } catch (error) {
            logger.error('获取交易详情失败:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }

    // 更新交易状态
    async updateTradeStatus(req, res) {
        try {
            const { tradeId } = req.params;
            const { status, reason } = req.body;

            await db.models.Trade.update(
                { status, reason },
                { where: { id: tradeId } }
            );

            res.json({
                success: true,
                message: 'Trade status updated successfully'
            });
        } catch (error) {
            logger.error('更新交易状态失败:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }

    // 取消交易
    async cancelTrade(req, res) {
        try {
            const { tradeId } = req.params;
            const { reason } = req.body;

            await db.models.Trade.update(
                {
                    status: 'cancelled',
                    reason
                },
                { where: { id: tradeId } }
            );

            res.json({
                success: true,
                message: 'Trade cancelled successfully'
            });
        } catch (error) {
            logger.error('取消交易失败:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }

    // 买入代币
    async buyTokens(req, res) {
        try {
            const {
                groupType,
                accountNumber,
                tokenAddress,
                amountSol,
                slippage = 1.0,
                usePriorityFee = false,
                options = {}
            } = req.body;

            logger.info('收到买入请求:', {
                groupType,
                accountNumber,
                tokenAddress,
                amountSol,
                slippage,
                usePriorityFee
            });

            const result = await this.solanaService.buyTokens({
                groupType,
                accountNumber,
                tokenAddress,
                amountSol: parseFloat(amountSol),
                slippage: parseFloat(slippage),
                usePriorityFee,
                options
            });

            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('买入代币失败:', {
                error: error.message,
                stack: error.stack,
                params: req.body
            });

            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 卖出代币
    async sellTokens(req, res) {
        try {
            const {
                groupType,
                accountNumber,
                tokenAddress,
                percentage,
                slippage = 1.0,          // 默认滑点 1%
                usePriorityFee = false,  // 是否使用优先费
                priorityFeeSol,          // 优先费用金额(SOL)
                priorityType = 'Jito',   // 优先费类型: 'jito' 或 'nozomi'
                skipPreflight = false,   // 是否跳过预检
                maxRetries = 3,          // 最大重试次数
                options = {}             // 其他选项
            } = req.body;

            // 1. 验证必要参数
            if (!groupType || typeof groupType !== 'string') {
                throw new Error('Invalid group type');
            }

            if (!accountNumber || typeof accountNumber !== 'number') {
                throw new Error('Invalid account number');
            }

            if (!tokenAddress || typeof tokenAddress !== 'string') {
                throw new Error('Invalid token address');
            }

            if (!percentage || typeof percentage !== 'number' || percentage <= 0 || percentage > 100) {
                throw new Error('Invalid percentage (must be between 0 and 100)');
            }

            // 2. 验证优先费用
            if (usePriorityFee && priorityFeeSol) {
                if (typeof priorityFeeSol !== 'number' || priorityFeeSol < 0) {
                    throw new Error('Invalid priority fee amount');
                }
            }

            // 3. 验证滑点
            if (typeof slippage !== 'number' || slippage < 0 || slippage > 100) {
                throw new Error('Invalid slippage (must be between 0 and 100)');
            }

            // 4. 记录请求信息
            logger.info('收到卖出请求:', {
                groupType,
                accountNumber,
                tokenAddress: tokenAddress.toString(),
                percentage,
                slippage,
                usePriorityFee,
                priorityType,
                priorityFeeSol
            });

            // 5. 合并所有选项
            const tradeOptions = {
                ...options,
                slippage,                // 滑点百分比
                usePriorityFee,         // 是否使用优先费
                priorityFeeSol,         // 优先费金额
                priorityType,           // 优先费类型
                skipPreflight,         // 是否跳过预检
                maxRetries            // 最大重试次数
            };

            // 6. 调用 tokenTradeService 执行卖出
            const result = await this.tokenTradeService.sellTokens(
                groupType,
                accountNumber,
                tokenAddress,
                percentage,
                tradeOptions
            );

            // 7. 根据结果构造响应
            res.json({
                success: true,
                data: {
                    ...result,
                    requestParams: {
                        groupType,
                        accountNumber,
                        tokenAddress,
                        percentage,
                        slippage,
                        usePriorityFee,
                        priorityType,
                        priorityFeeSol
                    }
                }
            });

        } catch (error) {
            // 8. 错误处理和日志记录
            logger.error('卖出代币失败:', {
                error: error.message,
                params: {
                    groupType: req.body.groupType,
                    accountNumber: req.body.accountNumber,
                    tokenAddress: req.body.tokenAddress,
                    percentage: req.body.percentage
                },
                stack: error.stack
            });

            // 9. 返回错误响应
            res.status(400).json({
                success: false,
                error: error.message,
                errorCode: error.code || 'SELL_ERROR',
                requestParams: {
                    groupType: req.body.groupType,
                    accountNumber: req.body.accountNumber,
                    tokenAddress: req.body.tokenAddress,
                    percentage: req.body.percentage
                }
            });
        }
    }

    // 获取代币价格信息
    async getTokenPrice(req, res) {
        try {
            const { tokenAddress } = req.params;
            const priceInfo = await this.solanaService.getTokenPrice(tokenAddress);
            res.json({
                success: true,
                data: {
                    tokenAddress,
                    currentPrice: priceInfo.currentPrice,
                    priceImpact: priceInfo.priceImpact,
                    liquidity: priceInfo.liquidity,
                    volume24h: priceInfo.volume24h
                }
            });
        } catch (error) {
            logger.error('获取代币价格失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 获取代币余额
    async getTokenBalance(req, res) {
        try {
            const { groupType, accountNumber, tokenAddress } = req.params;
            const balance = await this.solanaService.getTokenBalance(
                groupType,
                parseInt(accountNumber),
                tokenAddress
            );
            res.json({
                success: true,
                data: {
                    groupType,
                    accountNumber,
                    tokenAddress,
                    balance
                }
            });
        } catch (error) {
            logger.error('获取代币余额失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }
}