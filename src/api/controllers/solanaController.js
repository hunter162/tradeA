import { logger } from '../../modules/utils/index.js';
import fs from 'fs/promises';
import path from 'path';
import db from '../../modules/db/index.js';
const { Token, Transaction } = db.models;


export class SolanaController {
    constructor(solanaService, tokenTradeService) {
        if (!solanaService) {
            throw new Error('SolanaService is required');
        }
        this.solanaService = solanaService;
        this.tokenTradeService = tokenTradeService;
    }

    // 获取连接状态
    async getConnectionStatus(req, res) {
        try {
            const status = await this.solanaService.getConnectionStatus();
            res.json({
                success: true,
                data: status
            });
        } catch (error) {
            logger.error('获取连接状态失败:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }

    // 获取当前节点信息
    async getCurrentEndpoint(req, res) {
        try {
            const endpoint = this.solanaService.getCurrentEndpoint();
            res.json({
                success: true,
                data: {
                    endpoint: endpoint.replace(/api-key=([^&]+)/, 'api-key=***'),
                    index: this.solanaService.currentEndpointIndex
                }
            });
        } catch (error) {
            logger.error('获取节点信息失败:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }

    // 切换节点
    async switchEndpoint(req, res) {
        try {
            await this.solanaService.switchEndpoint();
            const newEndpoint = this.solanaService.getCurrentEndpoint();
            res.json({
                success: true,
                data: {
                    endpoint: newEndpoint.replace(/api-key=([^&]+)/, 'api-key=***'),
                    index: this.solanaService.currentEndpointIndex
                }
            });
        } catch (error) {
            logger.error('切换节点失败:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }

    // 获取 RPC 状态
    async getRpcStatus(req, res) {
        try {
            const results = await this.solanaService.testRpcEndpoints();
            res.json({
                success: true,
                data: {
                    endpoints: results.map(r => ({
                        endpoint: r.endpoint,
                        status: r.status,
                        latency: r.latency,
                        blockHeight: r.blockHeight,
                        version: r.version
                    }))
                }
            });
        } catch (error) {
            logger.error('获取 RPC 状态失败:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }

    // 获取 SPL 代币余额
    async getSPLBalance(req, res) {
        try {
            const { mintAddress, ownerAddress } = req.params;
            const balance = await this.solanaService.getSPLBalance(mintAddress, ownerAddress);
            res.json({
                success: true,
                data: {
                    mint: mintAddress,
                    owner: ownerAddress,
                    balance
                }
            });
        } catch (error) {
            logger.error('获取 SPL 代币余额失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 创建代币
    async createToken(req, res) {
        try {
            const { groupType, accountNumber, metadata, initialBuyAmount, options } = req.body;
            
            const result = await this.solanaService.createToken(
                groupType,
                accountNumber,
                metadata,
                initialBuyAmount,
                options
            );

            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('创建代币失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 创建并买入代币
    async createAndBuyToken(req, res) {
        const transaction = await db.sequelize.transaction();

        try {
            const {
                groupType,
                accountNumber,
                metadata,
                solAmount,
                slippageBasisPoints = 100,
                usePriorityFee = false,
                priorityFeeSol,
                options = {
                    batchTransactions: []
                }
            } = req.body;

            // 1. 基础参数验证
            if (!groupType || !accountNumber || !metadata || !solAmount) {
                throw new Error('Missing required parameters');
            }

            // 2. 验证 metadata
            if (!metadata.name || !metadata.symbol) {
                throw new Error('Token metadata must include name and symbol');
            }

            // 3. 验证优先费
            if (usePriorityFee && priorityFeeSol) {
                if (priorityFeeSol < 0.000001 || priorityFeeSol > 1) {
                    throw new Error('Priority fee must be between 0.000001 and 1 SOL');
                }
            }

            // 4. 验证批量交易参数
            if (options.batchTransactions && Array.isArray(options.batchTransactions)) {
                options.batchTransactions.forEach((tx, index) => {
                    if (!tx.groupType || !tx.accountNumber || !tx.solAmount) {
                        throw new Error(`Invalid parameters in batch transaction at index ${index}`);
                    }
                    if (parseFloat(tx.solAmount) < 0.000001) {
                        throw new Error(`Invalid solAmount in batch transaction at index ${index}`);
                    }
                });
            }

            // 5. 构造服务层参数
            const serviceParams = {
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
                    batchTransactions: options.batchTransactions?.map(tx => ({
                        groupType: tx.groupType,
                        accountNumber: tx.accountNumber,
                        solAmount: parseFloat(tx.solAmount)
                    })) || []
                }
            };

            // 6. 调用服务层创建和购买代币
            logger.info('开始创建和购买代币:', {
                params: serviceParams,
                batchCount: serviceParams.options.batchTransactions.length
            });

            const result = await this.solanaService.createAndBuy(serviceParams);

            // 7. 保存主交易记录
            await this.tokenTradeService.saveTradeTransaction({
                signature: result.signature,
                mint: result.mint,
                owner: result.owner,
                type: 'create_and_buy',
                amount: solAmount,
                tokenAmount: result.tokenAmount,
                tokenDecimals: result.tokenDecimals || 9,
                metadata: {
                    name: metadata.name,
                    symbol: metadata.symbol,
                    uri: metadata.uri,
                    ...result
                }
            }, { transaction });

            // 8. 保存批量交易记录
            if (options.batchTransactions?.length > 0) {
                const batchTransactionResults = result.batchResults || [];
                await Promise.all(batchTransactionResults.map((txResult, index) => {
                    const batchTx = options.batchTransactions[index];
                    return this.tokenTradeService.saveTradeTransaction({
                        signature: txResult.signature,
                        mint: result.mint, // 使用主交易创建的代币地址
                        owner: txResult.owner,
                        type: 'batch_create_and_buy',
                        amount: batchTx.solAmount,
                        tokenAmount: txResult.tokenAmount,
                        tokenDecimals: result.tokenDecimals || 9,
                        metadata: {
                            name: metadata.name,
                            symbol: metadata.symbol,
                            uri: metadata.uri,
                            batchIndex: index,
                            parentSignature: result.signature,
                            ...txResult
                        }
                    }, { transaction });
                }));
            }

            // 9. 更新缓存和订阅
            await Promise.all([
                this.solanaService.updateBalanceCache(result.owner, result.mint),
                this.solanaService.tokenSubscriptionService?.subscribeToTokenBalance(
                    result.owner,
                    result.mint
                )
            ]);

            // 如果有批量交易，也更新它们的缓存和订阅
            if (result.batchResults?.length > 0) {
                await Promise.all(
                    result.batchResults.map(batchTx =>
                        Promise.all([
                            this.solanaService.updateBalanceCache(batchTx.owner, result.mint),
                            this.solanaService.tokenSubscriptionService?.subscribeToTokenBalance(
                                batchTx.owner,
                                result.mint
                            )
                        ])
                    )
                );
            }

            await transaction.commit();

            // 10. 返回成功响应
            res.json({
                success: true,
                data: {
                    ...result,
                    metadata,
                    batchTransactions: result.batchResults
                }
            });

        } catch (error) {
            await transaction.rollback();
            logger.error('创建并买入代币失败:', {
                error: error.message,
                stack: error.stack,
                params: req.body
            });

            // 11. 返回错误响应
            res.status(400).json({
                success: false,
                error: error.message,
                details: error.details || undefined
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
                solAmount, 
                slippageBasisPoints = 100,
                options = {}
            } = req.body;

            const buyOptions = {
                slippageBasisPoints: parseInt(slippageBasisPoints),
                usePriorityFee: options.usePriorityFee || false,
                priorityType: options.priorityType || 'Jito', // 'jito' or 'nozomi'
                priorityFeeSol: options.priorityFeeSol ? parseFloat(options.priorityFeeSol) : undefined,
                tipAmountSol: options.tipAmountSol, // For Jito bundles
                timeout: options.timeout || 60000,
                retryCount: options.retryCount || 3
            };
            if (buyOptions.usePriorityFee && buyOptions.priorityFeeSol) {
                if (buyOptions.priorityFeeSol < 0.000001 || buyOptions.priorityFeeSol > 1) {
                    throw new Error('Priority fee must be between 0.000001 and 1 SOL');
                }
            }
            const result = await this.solanaService.buyTokens(
                groupType,
                accountNumber,
                tokenAddress,
                solAmount,
                BigInt(slippageBasisPoints),
                buyOptions.usePriorityFee,
                buyOptions
            );

            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('买入代币失败:', error);
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
                slippageBasisPoints = 100 
            } = req.body;

            const result = await this.solanaService.sellTokens(
                groupType,
                accountNumber,
                tokenAddress,
                BigInt(slippageBasisPoints)
            );

            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('卖出代币失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 获取绑定曲线
    async getBondingCurve(req, res) {
        try {
            const { mintAddress } = req.params;
            // 获取代币的绑定曲线信息
            const curve = await this.solanaService.getBondingCurve(mintAddress);
            
            // 返回曲线参数
            res.json({
                success: true,
                data: {
                    mintAddress,
                    // 虚拟 SOL 储备
                    virtualSolReserves: curve.virtualSolReserves.toString(),
                    // 虚拟代币储备
                    virtualTokenReserves: curve.virtualTokenReserves.toString(),
                    // 当前价格
                    currentPrice: curve.getCurrentPrice(),
                    // 买入价格影响
                    buyPriceImpact: curve.getBuyPriceImpact(),
                    // 卖出价格影响
                    sellPriceImpact: curve.getSellPriceImpact(),
                    // 流动性指标
                    liquidity: curve.getLiquidity()
                }
            });
        } catch (error) {
            logger.error('获取绑定曲线失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 获取全局状态
    async getGlobalState(req, res) {
        try {
            const state = await this.solanaService.getGlobalState();
            res.json({
                success: true,
                data: state
            });
        } catch (error) {
            logger.error('获取全局状态失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 等待交易确认
    async waitForTransaction(req, res) {
        try {
            const { signature } = req.params;
            const result = await this.solanaService.waitForTransaction(signature);
            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('等待交易确认失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    async uploadFile(req, res) {
        try {
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    error: 'No file uploaded'
                });
            }

            // 获取上传的文件信息
            const file = req.file;
            
            // 上传到 IPFS
            const ipfsResult = await this.solanaService.uploadToIPFS(file.path);

            res.json({
                success: true,
                data: {
                    localPath: file.path,
                    filename: file.originalname,
                    ipfsHash: ipfsResult.IpfsHash,
                    ipfsUrl: `https://gateway.pinata.cloud/ipfs/${ipfsResult.IpfsHash}`
                }
            });
        } catch (error) {
            logger.error('文件上传失败:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }

    // 上传代币图片
    // Updated uploadTokenImage method for SolanaController
    async uploadTokenImage(req, res) {
        try {
            // 1. 检查文件是否存在
            if (!req.file) {
                throw new Error('No image file uploaded');
            }

            // 2. 验证文件格式
            const supportedFormats = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
            if (!supportedFormats.includes(req.file.mimetype)) {
                throw new Error('Unsupported file format. Please upload JPG, PNG, GIF or WEBP');
            }

            // 3. 验证文件大小 (5MB)
            const maxSize = 5 * 1024 * 1024;
            if (req.file.size > maxSize) {
                throw new Error('File size too large. Maximum size is 5MB');
            }

            // 4. 读取文件内容
            const fileContent = await fs.readFile(req.file.path);

            // 5. 准备完整的文件对象
            const fileObject = {
                content: fileContent,           // 文件内容
                path: req.file.path,           // 本地路径
                name: req.file.originalname,    // 原始文件名
                type: req.file.mimetype,       // MIME类型
                size: req.file.size,           // 文件大小
                metadata: {
                    filename: req.file.filename,
                    encoding: req.file.encoding,
                    mimetype: req.file.mimetype,
                    destination: req.file.destination
                }
            };

            // 6. 上传到 IPFS
            const ipfsResult = await this.solanaService.uploadToIPFS(fileObject);

            // 7. 删除临时文件
            try {
                await fs.unlink(req.file.path);
                logger.info('临时文件已删除:', { path: req.file.path });
            } catch (unlinkError) {
                logger.error('删除临时文件失败:', unlinkError);
            }

            // 8. 返回成功响应
            res.json({
                success: true,
                data: {
                    imageUrl: `https://gateway.pinata.cloud/ipfs/${ipfsResult.IpfsHash}`,
                    ipfsHash: ipfsResult.IpfsHash,
                    originalName: req.file.originalname,
                    size: req.file.size,
                    mimetype: req.file.mimetype
                }
            });

        } catch (error) {
            // 9. 错误处理
            logger.error('上传代币图片失败:', {
                error: error.message,
                file: req.file
            });

            // 10. 删除临时文件
            if (req.file?.path) {
                try {
                    await fs.unlink(req.file.path);
                    logger.info('临时文件已删除:', { path: req.file.path });
                } catch (unlinkError) {
                    logger.error('删除临时文件失败:', unlinkError);
                }
            }

            // 11. 返回错误响应
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }
    // 创建代币元数据
    async createTokenMetadata(req, res) {
        try {
            const {
                name,
                symbol,
                description,
                image,
                website,
                twitter,
                telegram,
                discord,
                attributes = []
            } = req.body;

            // 1. 验证必要字段
            if (!name || !symbol || !image) {
                throw new Error('Name, symbol and image are required');
            }

            // 2. 创建元数据对象
            const metadata = {
                name,
                symbol,
                description: description || '',
                image,
                external_url: website || '',
                attributes: [
                    ...attributes,
                    {
                        trait_type: 'Website',
                        value: website || ''
                    },
                    {
                        trait_type: 'Twitter',
                        value: twitter || ''
                    },
                    {
                        trait_type: 'Telegram',
                        value: telegram || ''
                    },
                    {
                        trait_type: 'Discord',
                        value: discord || ''
                    }
                ]
            };

            // 3. 上传元数据到 IPFS
            const result = await this.solanaService.uploadMetadataToIPFS(metadata);

            res.json({
                success: true,
                data: {
                    metadata,
                    metadataUrl: `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`,
                    ipfsHash: result.IpfsHash
                }
            });
        } catch (error) {
            logger.error('创建代币元数据失败:', {
                error: error.message,
                body: req.body
            });
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }
    async batchBuyTokens(req, res) {
        try {
            const {
                mainGroup,
                mainAccountNumber,
                tradeGroup,
                makersCount,
                amountStrategy,
                amountConfig,
                jitoTipSol,
                mintAddress,
                options = {}
            } = req.body;

            logger.info('批量买入请求:', {
                mainGroup,
                mainAccountNumber,
                makersCount,
                amountStrategy
            });

            const result = await this.solanaService.batchBuyProcess({
                mainGroup,
                mainAccountNumber,
                tradeGroup,
                makersCount,
                amountStrategy,
                amountConfig,
                jitoTipSol,
                mintAddress,
                options
            });

            res.json({
                success: true,
                data: {
                    ...result,
                    // 添加UI友好的费用展示
                    fees: {
                        createAccountFee: `${result.amounts.fees.createAccountFee} SOL`,
                        gasFee: `${result.amounts.fees.gasFee} SOL`,
                        jitoTip: `${result.amounts.fees.jitoTip} SOL`,
                        priorityFee: `${result.amounts.fees.priorityFee} SOL`,
                        total: `${result.amounts.fees.total} SOL`
                    },
                    totalRequired: `${result.amounts.total} SOL`,
                    transactions: {
                        ...result.transactions,
                        summary: {
                            total: makersCount * 5, // 5种交易类型
                            successful: result.transactions.tokenBuy.successful,
                            failed: result.transactions.tokenBuy.failed
                        }
                    }
                }
            });

        } catch (error) {
            logger.error('批量买入处理失败:', {
                error: error.message,
                stack: error.stack,
                params: req.body
            });

            res.status(400).json({
                success: false,
                error: error.message,
                code: error.code || 'BATCH_BUY_FAILED'
            });
        }
    }
    // solanaController.js - 添加新方法

    async calculateFees(req, res) {
        try {
            const {
                mainGroup = 'main',
                mainAccountNumber,
                makersCount,           // makers数量
                amountStrategy,        // 买入策略
                amountConfig,         // 买入金额配置
                jitoTipSol
            } = req.body;

            // 1. 验证基本参数
            if (!mainAccountNumber) {
                throw new Error('主账户编号是必需的');
            }

            if (!makersCount || ![4, 50, 100, 500, 1000].includes(makersCount)) {
                throw new Error('makers数量必须是4/50/100/500/1000之一');
            }

            if (!amountStrategy || !['fixed', 'random', 'percentage'].includes(amountStrategy)) {
                throw new Error('无效的买入策略');
            }

            // 2. 验证金额配置
            if (!amountConfig) {
                throw new Error('缺少金额配置');
            }

            switch (amountStrategy) {
                case 'fixed':
                    if (typeof amountConfig.fixedAmount !== 'number' || amountConfig.fixedAmount <= 0) {
                        throw new Error('固定金额必须大于0');
                    }
                    break;
                case 'random':
                    if (!amountConfig.maxAmount || !amountConfig.minAmount ||
                        amountConfig.maxAmount <= amountConfig.minAmount) {
                        throw new Error('随机金额范围无效');
                    }
                    break;
                case 'percentage':
                    if (typeof amountConfig.percentage !== 'number' ||
                        amountConfig.percentage <= 0 ||
                        amountConfig.percentage > 100) {
                        throw new Error('百分比必须在0-100之间');
                    }
                    break;
            }

            logger.info('费用计算请求:', {
                makersCount,
                amountStrategy,
                amountConfig
            });

            // 3. 获取主账户
            const mainAccountWallet = await this.solanaService.walletService.getWallet(
                mainGroup,
                mainAccountNumber
            );

            if (!mainAccountWallet) {
                throw new Error(`未找到主账户: ${mainGroup}-${mainAccountNumber}`);
            }

            // 4. 获取主账户余额
            const mainAccountBalance = await this.solanaService.getBalance(
                mainAccountWallet.publicKey
            );

            // 5. 生成买入金额列表
            let buyAmounts;
            if (amountStrategy === 'percentage' && mainAccountBalance === 0) {
                throw new Error('账户余额为0，无法使用百分比策略');
            }

            buyAmounts = await this.solanaService.generateBuyAmounts({
                strategy: amountStrategy,
                ...amountConfig,
                count: makersCount,
                balance: mainAccountBalance
            });

            // 6. 计算费用明细
            const feeBreakdown = await this.solanaService.calculateMainAccountFees({
                makersCount,
                amountStrategy,
                jitoTipSol,
                amounts: buyAmounts,
                mainAccountBalance
            });

            // 7. 格式化响应数据
            const response = {
                fees: {
                    // 创建账户费用
                    createAccountFee: {
                        sol: feeBreakdown.fees.createAccountFee,
                        description: `创建 ${makersCount} 个账户费用`
                    },
                    // 代币账户创建费用
                    tokenAccountFee: {
                        sol: feeBreakdown.fees.gasFee,
                        description: `创建 ${makersCount} 个代币账户费用`
                    },
                    // Jito小费
                    jitoFees: {
                        sol: feeBreakdown.fees.jitoTip,
                        description: `${makersCount * 5} 笔交易的Jito小费`
                    },
                    // 基础交易费用
                    transactionFees: {
                        sol: feeBreakdown.fees.gasFee,
                        description: `${makersCount * 5} 笔交易的基础费用`
                    },
                    // 优先费用
                    priorityFees: {
                        sol: feeBreakdown.fees.priorityFee,
                        description: `${makersCount * 5} 笔交易的优先费用`
                    },
                    // Pump交易费
                    pumpFees: {
                        sol: feeBreakdown.fees.pumpFee,
                        description: `Pump交易费(1%)`
                    }
                },
                // 买入金额
                buyAmount: {
                    total: feeBreakdown.totalBuyAmount,
                    perAccount: buyAmounts.length > 0 ? buyAmounts[0] : 0,
                    strategy: amountStrategy,
                    config: amountConfig
                },
                // 总费用汇总
                summary: {
                    currentBalance: mainAccountBalance,
                    totalFees: feeBreakdown.fees.total,
                    totalRequired: feeBreakdown.totalRequired,
                    transactionCount: makersCount * 5,
                    averageCostPerTx: feeBreakdown.fees.total / (makersCount * 5),
                    insufficientAmount: mainAccountBalance < feeBreakdown.totalRequired ?
                        feeBreakdown.totalRequired - mainAccountBalance : 0
                },
                // lamports单位的费用
                lamports: feeBreakdown.lamports
            };

            res.json({
                success: true,
                data: response
            });

        } catch (error) {
            logger.error('费用计算失败:', {
                error: error.message,
                stack: error.stack,
                params: req.body
            });

            res.status(400).json({
                success: false,
                error: error.message,
                code: 'FEE_CALCULATION_FAILED'
            });
        }
    }
} 