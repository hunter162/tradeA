import { logger } from '../../modules/utils/index.js';
import { CustomError, handleError } from '../../modules/utils/errors.js';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import db from '../../modules/db/index.js';
const { Wallet } = db;

export class WalletController {
    constructor(solanaService, walletService) {
        if (!solanaService || !walletService) {
            throw new Error('Services are required');
        }
        this.solanaService = solanaService;
        this.walletService = walletService;
    }

    async getBatchTokenBalances(req, res){
        try {
            if (!this.walletService) {
                throw new Error('WalletService not initialized');
            }

            const { groupType, accountNumber } = req.params;
            logger.info('获取批量代币余额请求:', {
                groupType: groupType,
                accountNumber: accountNumber
            });
            const tokenInfo = await this.walletService.getWalletTokens(groupType, accountNumber);
            res.json({
                success: true,
                data: tokenInfo
            });
        } catch (error) {
            logger.error('钱包失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }
    // 创建钱包
    async createWallet(req, res) {
        try {
            if (!this.walletService) {
                throw new Error('WalletService not initialized');
            }
            
            const { groupType, accountNumber } = req.body;
            const wallet = await this.walletService.createWallet(groupType, accountNumber);
            res.json({
                success: true,
                data: wallet
            });
        } catch (error) {
            logger.error('创建钱包失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 获取钱包信息
    async getWallet(req, res) {
        try {
            const { groupType, accountNumber } = req.params;
            const wallet = await this.walletService.getWallet(
                groupType,
                parseInt(accountNumber)
            );
            res.json({
                success: true,
                data: wallet
            });
        } catch (error) {
            logger.error('获取钱包失败:', error);
            res.status(404).json({
                success: false,
                error: error.message
            });
        }
    }

    // 获取钱包余额
    async getBalance(req, res) {
        const { groupType, accountNumber } = req.params;
        try {
            // 获取余额 (返回的是 SOL)
            const balance = await this.walletService.getBalance(
                groupType,
                parseInt(accountNumber)
            );

            res.json({
                success: true,
                data: balance.toString() // 直接返回 SOL 值
            });
        } catch (error) {
            logger.error('获取余额失败:', {
                error: error.message,
                groupType,
                accountNumber
            });
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 批量创建钱包
    async batchCreateWallets(req, res) {
        try {
            const { groupType, count } = req.body;

            logger.info('开始批量创建钱包:', {
                groupType,
                count
            });

            const result = await this.walletService.batchCreateWallets(
                groupType,
                parseInt(count)
            );

            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('批量创建钱包失败:', {
                error: error.message,
                stack: error.stack,
                params: req.body
            });

            const response = handleError(error);
            res.status(error instanceof CustomError ? 400 : 500).json(response);
        }
    }

    // 转账
    async transfer(req, res) {
        try {
            const { fromGroup, fromAccount, toGroup, toAccount, amount } = req.body;

            // 验证输入
            if (!fromGroup || !toGroup || !amount) {
                throw new Error('Missing required parameters');
            }

            // 确保账号是数字
            const fromAccNum = parseInt(fromAccount);
            const toAccNum = parseInt(toAccount);

            if (isNaN(fromAccNum) || isNaN(toAccNum)) {
                throw new Error('Account numbers must be integers');
            }

            // 确保金额是有效数字
            const transferAmount = parseFloat(amount);
            if (isNaN(transferAmount) || transferAmount <= 0) {
                throw new Error('Invalid transfer amount');
            }

            // 执行转账
            const result = await this.walletService.transfer(
                fromGroup,
                fromAccNum,
                toGroup,
                toAccNum,
                transferAmount
            );

            res.json({
                success: true,
                data: {
                    signature: result.signature,
                    fromGroup,
                    fromAccount: fromAccNum,
                    toGroup,
                    toAccount: toAccNum,
                    amount: transferAmount
                }
            });
        } catch (error) {
            logger.error('转账失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    async getPrivateKey(req, res) {
        try {
            const { groupType, accountNumber } = req.params;
            
            // 验证必要参数
            if (!groupType || !accountNumber) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required parameters'
                });
            }

            const wallet = await this.walletService.getWalletPrivateKey(
                groupType,
                parseInt(accountNumber)
            );

            res.json({
                success: true,
                data: {
                    groupType,
                    accountNumber: parseInt(accountNumber),
                    publicKey: wallet.publicKey,
                    privateKey: wallet.privateKey  // base64 格式的私钥
                }
            });
        } catch (error) {
            logger.error('获取钱包私钥失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    async batchCreateByCount(req, res) {
        try {
            const { groupType, count } = req.body;
            
            // 验证参数
            if (!groupType || !count) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required parameters'
                });
            }

            // 验证数量是否合法
            const numCount = parseInt(count);
            if (isNaN(numCount) || numCount < 1 || numCount > 100) {
                return res.status(400).json({
                    success: false,
                    error: 'Count must be between 1 and 100'
                });
            }

            const result = await this.walletService.batchCreateWallets(groupType, numCount);
            
            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('批量创建钱包失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 添加导入钱包的控制器方法
    async importWallet(req, res) {
        try {
            const { groupType, accountNumber, privateKey } = req.body;

            // 验证输入
            if (!groupType || !accountNumber || !privateKey) {
                throw new Error('Missing required parameters');
            }

            const accNum = parseInt(accountNumber);
            if (isNaN(accNum)) {
                throw new Error('Invalid account number');
            }

            // 执行导入
            const wallet = await this.walletService.importWallet(
                groupType,
                accNum,
                privateKey
            );

            res.json({
                success: true,
                data: {
                    groupType: wallet.groupType,
                    accountNumber: wallet.accountNumber,
                    publicKey: wallet.publicKey,
                    status: wallet.status
                }
            });
        } catch (error) {
            logger.error('导入钱包失败:', error);
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }

    // 关闭钱包
    async closeWallet(req, res) {
        const { groupType, accountNumber } = req.params;
        const { recipientGroupType, recipientAccountNumber } = req.body;

        try {
            logger.info('开始关闭钱包:', {
                fromWallet: {
                    groupType,
                    accountNumber
                },
                toWallet: {
                    groupType: recipientGroupType,
                    accountNumber: recipientAccountNumber
                }
            });

            const result = await this.walletService.closeWallet(
                groupType,
                parseInt(accountNumber),
                recipientGroupType,
                parseInt(recipientAccountNumber)
            );

            res.json({
                success: true,
                data: {
                    signature: result.signature,
                    fromWallet: {
                        groupType,
                        accountNumber,
                        publicKey: result.fromPublicKey
                    },
                    toWallet: {
                        groupType: recipientGroupType,
                        accountNumber: recipientAccountNumber,
                        publicKey: result.toPublicKey
                    },
                    transferredAmount: result.amount,
                    closedAt: new Date().toISOString()
                }
            });
        } catch (error) {
            logger.error('关闭钱包失败:', {
                error: error.message,
                stack: error.stack,
                fromWallet: {
                    groupType,
                    accountNumber
                },
                toWallet: {
                    groupType: recipientGroupType,
                    accountNumber: recipientAccountNumber
                }
            });

            // 使用统一的错误处理
            const response = handleError(error);
            res.status(error instanceof CustomError ? 400 : 500).json(response);
        }
    }

    // 批量关闭钱包
    async closeBatchWallets(req, res) {
        const { groupType } = req.params;
        const { accountRange, recipientGroupType, recipientAccountNumber } = req.body;

        try {
            logger.info('开始批量关闭钱包:', {
                fromWallets: {
                    groupType,
                    accountRange
                },
                toWallet: {
                    groupType: recipientGroupType,
                    accountNumber: recipientAccountNumber
                }
            });

            const result = await this.walletService.batchCloseWallets(
                groupType,
                accountRange,
                recipientGroupType,
                parseInt(recipientAccountNumber)
            );

            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('批量关闭钱包失败:', {
                error: error.message,
                stack: error.stack,
                fromWallets: {
                    groupType,
                    accountRange
                },
                toWallet: {
                    groupType: recipientGroupType,
                    accountNumber: recipientAccountNumber
                }
            });

            // 使用统一的错误处理
            const response = handleError(error);
            res.status(error instanceof CustomError ? 400 : 500).json(response);
        }
    }

    // 获取代币余额
    async getTokenBalance(req, res) {
        try {
            const { groupType, accountNumber, mintAddress } = req.params;

            logger.info('获取代币余额:', {
                groupType,
                accountNumber,
                mintAddress
            });

            const balance = await this.walletService.getTokenBalance(
                groupType,
                parseInt(accountNumber),
                mintAddress
            );

            res.json({
                success: true,
                data: {
                    groupType,
                    accountNumber: parseInt(accountNumber),
                    mintAddress,
                    balance: balance.toString(),
                    timestamp: new Date().toISOString()
                }
            });
        } catch (error) {
            logger.error('获取代币余额失败:', {
                error: error.message,
                groupType: req.params.groupType,
                accountNumber: req.params.accountNumber,
                mintAddress: req.params.mintAddress
            });

            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    }
} 