import { logger } from '../../modules/utils/index.js';

export class TransferController {
    constructor(solanaService, walletService, transferService) {
        if (!solanaService || !walletService || !transferService) {
            throw new Error('Services are required');
        }
        this.solanaService = solanaService;
        this.walletService = walletService;
        this.transferService = transferService;
    }

    // 1对多转账
    async oneToMany(req, res) {
        try {
            const {
                fromGroupType,
                fromAccountNumber,
                toGroupType,
                toAccountRange,
                amount // 可选
            } = req.body;

            logger.info('收到1对多转账请求:', {
                fromGroupType,
                fromAccountNumber,
                toGroupType,
                toAccountRange,
                amount
            });

            const result = await this.walletService.oneToMany(
                fromGroupType,
                parseInt(fromAccountNumber),
                toGroupType,
                toAccountRange,
                amount ? parseFloat(amount) : null
            );

            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('1对多转账失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 多对一转账（归集）
    async manyToOne(req, res) {
        try {
            const { fromGroupType, fromAccountRange, toGroupType, toAccountNumber } = req.body;

            logger.info('收到多对一归集请求:', {
                fromGroupType,
                fromAccountRange,
                toGroupType,
                toAccountNumber
            });

            const result = await this.transferService.manyToOne(
                fromGroupType,
                fromAccountRange,
                toGroupType,
                parseInt(toAccountNumber)
            );

            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('多对一归集失败:', {
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

    // 多对多转账
    async manyToMany(req, res) {
        try {
            const { transfers } = req.body;

            const result = await this.walletService.manyToMany(transfers);

            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('多对多转账失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }
} 