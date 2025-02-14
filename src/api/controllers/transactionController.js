import { logger } from '../../modules/utils/index.js';

export class TransactionController {
    constructor(solanaService, walletService) {
        if (!solanaService || !walletService) {
            throw new Error('Services are required');
        }
        this.solanaService = solanaService;
        this.walletService = walletService;
    }

    // 单笔转账
    async transfer(req, res) {
        try {
            const { fromGroup, fromAccount, toGroup, toAccount, amount } = req.body;
            const result = await this.walletService.transfer(
                fromGroup,
                parseInt(fromAccount),
                toGroup,
                parseInt(toAccount),
                parseFloat(amount)
            );
            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('转账失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 批量转账
    async batchTransfer(req, res) {
        try {
            const { fromGroup, fromAccount, transfers } = req.body;
            // transfers 格式: [{ toGroup, toAccount, amount }]
            const results = [];
            
            for (const transfer of transfers) {
                try {
                    const result = await this.walletService.transfer(
                        fromGroup,
                        parseInt(fromAccount),
                        transfer.toGroup,
                        parseInt(transfer.toAccount),
                        parseFloat(transfer.amount)
                    );
                    results.push({
                        status: 'success',
                        data: result
                    });
                } catch (error) {
                    results.push({
                        status: 'failed',
                        error: error.message
                    });
                }
            }

            res.json({
                success: true,
                data: {
                    total: transfers.length,
                    successful: results.filter(r => r.status === 'success').length,
                    results
                }
            });
        } catch (error) {
            logger.error('批量转账失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 归集资金
    async collectFunds(req, res) {
        try {
            const { fromGroup, accountRange, toGroup, toAccount } = req.body;
            const result = await this.walletService.collectFunds(
                fromGroup,
                accountRange,
                toGroup,
                parseInt(toAccount)
            );
            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('归集资金失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 获取交易历史
    async getTransactionHistory(req, res) {
        try {
            const { groupType, accountNumber } = req.params;
            const { limit = 10, before } = req.query;

            const history = await this.walletService.getTransactionHistory(
                groupType,
                parseInt(accountNumber),
                {
                    limit: parseInt(limit),
                    before: before ? new Date(before) : undefined
                }
            );

            res.json({
                success: true,
                data: history
            });
        } catch (error) {
            logger.error('获取交易历史失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 获取交易状态
    async getTransactionStatus(req, res) {
        try {
            const { signature } = req.params;
            const status = await this.walletService.getTransactionStatus(signature);
            res.json({
                success: true,
                data: status
            });
        } catch (error) {
            logger.error('获取交易状态失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }
} 