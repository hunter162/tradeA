import { Router } from 'express';
import { SolanaController } from '../controllers/index.js';
import { validateRequest } from '../middleware/validator.js';
import multer from 'multer';
import path from 'path';
import { logger } from '../../modules/utils/index.js';
import express from 'express';
import { body, validationResult } from 'express-validator';
import { SolanaServiceError, handleError, asyncHandler } from '../../modules/utils/errors.js';
import { solanaValidators } from '../middleware/solanaValidator.js';
import { ErrorCodes } from '../../constants/errorCodes.js';
import fs from 'fs';
const router = Router();

// 使用中间件来获取服务实例
const getController = (req, res, next) => {
    const { solanaService } = req.app.locals.services;
    req.solanaController = new SolanaController(solanaService);
    next();
};

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // 确保上传目录存在
        const uploadDir = 'uploads/';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
        files: 1
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Unsupported file type. Please upload JPG, PNG, GIF or WEBP'));
        }
    }
});

// 获取连接状态
router.get('/status', 
    getController,
    (req, res) => req.solanaController.getConnectionStatus(req, res)
);

// 获取当前节点信息
router.get('/endpoint', 
    getController,
    (req, res) => req.solanaController.getCurrentEndpoint(req, res)
);

// 切换节点
router.post('/switch-endpoint',
    getController,
    (req, res) => req.solanaController.switchEndpoint(req, res)
);

// SPL 代币余额
router.get('/tokens/:mintAddress/:ownerAddress/balance', async (req, res) => {
    await req.solanaController.getSPLBalance(req, res);
});

// 创建代币
router.post('/tokens/create', 
    getController,
    validateRequest,
    async (req, res) => {
        await req.solanaController.createToken(req, res);
    }
);

// 买入代币
router.post('/tokens/buy',
    getController,
    validateRequest,
    async (req, res) => {
        await req.solanaController.buyTokens(req, res);
    }
);

// 卖出代币
router.post('/tokens/sell',
    getController,
    validateRequest,
    async (req, res) => {
        await req.solanaController.sellTokens(req, res);
    }
);

// 获取绑定曲线
router.get('/tokens/:mintAddress/curve', async (req, res) => {
    await req.solanaController.getBondingCurve(req, res);
});

// 获取全局状态
router.get('/state', async (req, res) => {
    await req.solanaController.getGlobalState(req, res);
});

// 等待交易确认
router.get('/transactions/:signature/confirm', async (req, res) => {
    await req.solanaController.waitForTransaction(req, res);
});

// 上传文件到本地并同步到 IPFS
// 上传文件到本地并同步到 IPFS
router.post('/upload',
    getController,
    (req, res, next) => {
        upload.single('file')(req, res, (err) => {
            if (err) {
                logger.error('文件上传错误:', {
                    error: err.message,
                    code: err instanceof multer.MulterError ? err.code : 'UNKNOWN'
                });
                return res.status(400).json({
                    success: false,
                    error: err.message
                });
            }
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    error: 'No file uploaded'
                });
            }
            next();
        });
    },
    async (req, res) => {
        try {
            await req.solanaController.uploadFile(req, res);
        } catch (error) {
            // 清理临时文件
            if (req.file?.path) {
                fs.unlink(req.file.path, (unlinkError) => {
                    if (unlinkError) {
                        logger.error('删除临时文件失败:', unlinkError);
                    }
                });
            }
            logger.error('处理上传失败:', {
                error: error.message,
                file: req.file
            });
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
);

// 创建代币验证规则
const createTokenValidation = [
    body('groupType').isString().notEmpty(),
    body('accountNumber').isInt({ min: 1 }),
    body('metadata').isObject(),
    body('metadata.name').isString().notEmpty(),
    body('metadata.symbol').isString().notEmpty(),
    body('metadata.uri').optional().isString(),
    body('metadata.image').optional().isString(),
    body('metadata.description').optional().isString(),
    body('metadata.external_url').optional().isString(),
    body('metadata.attributes').optional().isArray(),
    body('solAmount').isFloat({ min: 0.000001 }),
    body('slippageBasisPoints').optional().isInt({ min: 0, max: 1000 })
];

// 创建并购买代币
router.post('/tokens/create-and-buy',
    async (req, res) => {
        try {
            const {
                groupType,
                accountNumber,
                metadata,
                solAmount,
                slippageBasisPoints = 100,
                usePriorityFee = false,
                priorityFeeSol,
                options={
                    batchTransactions: []
                }
            } = req.body;

            logger.info('创建代币请求:', {
                groupType,
                accountNumber,
                metadata,
                solAmount,
                slippageBasisPoints
            });

            // 参数验证
            if (!groupType || !accountNumber || !metadata || !solAmount) {
                throw new Error('Missing required parameters');
            }

            if (!metadata.name || !metadata.symbol) {
                throw new Error('Token metadata must include name and symbol');
            }
            // 验证批量交易参数
            if (options.batchTransactions && Array.isArray(options.batchTransactions)) {
                // 验证每个批量交易的参数
                options.batchTransactions.forEach((tx, index) => {
                    if (!tx.groupType || !tx.accountNumber || !tx.solAmount) {
                        throw new Error(`Invalid parameters in batch transaction at index ${index}`);
                    }
                });
            }
            const { solanaService } = req.app.locals.services;

            // 构造正确的参数对象
            const params = {
                groupType,
                accountNumber,
                metadata: {
                    name: metadata.name,
                    symbol: metadata.symbol,
                    description: metadata.description || '',
                    image: metadata.image || '',
                    external_url: metadata.external_url || '',
                    attributes: metadata.attributes || []
                },
                solAmount: parseFloat(solAmount),
                options: {
                    slippageBasisPoints: parseInt(slippageBasisPoints),
                    usePriorityFee,
                    priorityFeeSol: priorityFeeSol ? parseFloat(priorityFeeSol) : undefined,
                    batchTransactions: options.batchTransactions.map(tx => ({
                        groupType: tx.groupType,
                        accountNumber: tx.accountNumber,
                        solAmount: parseFloat(tx.solAmount)
                    }))
                }
            };

            const result = await solanaService.createAndBuy(params);

            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('创建和购买代币失败:', {
                error: error.message,
                groupType: req.body.groupType,
                accountNumber: req.body.accountNumber,
                metadata: req.body.metadata
            });
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }
);

// 获取代币信息
router.get('/tokens/:mint', async (req, res) => {
    try {
        // 从 app.locals 获取服务实例
        const { solanaService } = req.app.locals.services;
        
        const { mint } = req.params;
        const tokenInfo = await solanaService.getTokenInfo(mint);
        res.json({
            success: true,
            data: tokenInfo
        });
    } catch (error) {
        handleError(error, res);
    }
});

// 上传代币图片
router.post('/tokens/upload-image',
    getController,
    (req, res, next) => {
        upload.single('image')(req, res, async (err) => {
            if (err instanceof multer.MulterError) {
                logger.error('Multer 错误:', {
                    code: err.code,
                    message: err.message
                });
                return res.status(400).json({
                    success: false,
                    error: err.message
                });
            } else if (err) {
                logger.error('文件上传错误:', { message: err.message });
                return res.status(400).json({
                    success: false,
                    error: err.message
                });
            }

            try {
                await req.solanaController.uploadTokenImage(req, res);
            } catch (error) {
                logger.error('处理上传失败:', {
                    error: error.message,
                    file: req.file
                });

                // 清理临时文件
                if (req.file?.path && fs.existsSync(req.file.path)) {
                    fs.unlink(req.file.path, (unlinkError) => {
                        if (unlinkError) {
                            logger.error('删除临时文件失败:', unlinkError);
                        }
                    });
                }

                if (!res.headersSent) {
                    res.status(500).json({
                        success: false,
                        error: error.message
                    });
                }
            }
        });
    }
);

// 创建代币元数据
router.post('/tokens/metadata',
    getController,
    validateRequest,
    async (req, res) => {
        await req.solanaController.createTokenMetadata(req, res);
    }
);

export function createSolanaRoutes(solanaController) {
    // 获取网络状态
    router.get('/status',
        asyncHandler(async (req, res) => {
            await solanaController.getNetworkStatus(req, res);
        })
    );

    // 获取账户信息
    router.get('/account/:publicKey',
        solanaValidators.getAccount,
        validateRequest,
        asyncHandler(async (req, res) => {
            await solanaController.getAccountInfo(req, res);
        })
    );

    // 获取交易信息
    router.get('/transaction/:signature',
        solanaValidators.getTransaction,
        validateRequest,
        asyncHandler(async (req, res) => {
            await solanaController.getTransaction(req, res);
        })
    );
    router.get('/tokens/:mintAddress/info',
        validateRequest,
        asyncHandler(async (req, res) => {
            await solanaController.getTokenInfo(req, res);
        })
    );
    // 获取代币信息
    router.get('/token/:mintAddress',
        solanaValidators.getToken,
        validateRequest,
        asyncHandler(async (req, res) => {
            await solanaController.getTokenInfo(req, res);
        })
    );

    router.post('/tokens/batch-buy',
        solanaValidators.batchBuy,
        validateRequest,
        async (req, res) => {
            await solanaController.batchBuyTokens(req, res);
        }
    );

    router.post('/calculate-fees',
        solanaValidators.calculateFees,
        validateRequest,
        async (req, res) => {
            await solanaController.calculateFees(req, res);
        }
    );
    router.post('/tokens/batch-buy-direct',
        solanaValidators.batchBuyDirect,
        validateRequest,
        async (req, res) => {
            await solanaController.batchBuyDirect(req, res);
        }
    );
    router.post('/tokens/batch-Sell-direct',
        solanaValidators.batchSellDirect,
        validateRequest,
        async (req, res) => {
            await solanaController.batchSellDirect(req, res);
        }
    );
    router.post('/tokens/batch-buy-sell',
        solanaValidators.batchBuyAndSell,
        validateRequest,
        async (req, res) => {
            await solanaController.batchBuyAndSell(req, res);
        }
    );
    router.post('/batch-transfer',
        solanaValidators.batchDirectTransfer,
        validateRequest,
        async (req, res) => {
            await solanaController.batchDirectTransfer(req, res);
        }
    );
    return router;
}

export default router; 