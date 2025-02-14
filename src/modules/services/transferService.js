import { Transaction, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { logger } from '../utils/index.js';
import db from '../db/index.js';  // 修改导入方式

export class TransferService {
    constructor(solanaService, walletService) {
        if (!solanaService || !walletService) {
            throw new Error('Required services not provided');
        }
        this.solanaService = solanaService;
        this.walletService = walletService;
        this.connection = solanaService.connection;
        this.redis = solanaService.redis;
        
        // Solana 交易限制
        this.MAX_TRANSACTION_SIZE = 1232; // bytes
        this.TRANSFER_INSTRUCTION_SIZE = 96; // 每个转账指令大小约 96 bytes
        this.MAX_TRANSFERS_PER_TX = Math.floor(
            (this.MAX_TRANSACTION_SIZE - 100) / this.TRANSFER_INSTRUCTION_SIZE
        ); // 预留 100 bytes 给交易头部
    }

    // 1对多转账
    async oneToMany(fromGroupType, fromAccountNumber, toGroupType, toAccountRange, amount = null) {
        try {
            const sourceWallet = await this.walletService.getWallet(fromGroupType, fromAccountNumber);
            if (!sourceWallet) {
                throw new Error('Source wallet not found');
            }

            const targetWallets = await this._getTargetWallets(toGroupType, toAccountRange);
            if (!targetWallets.length) {
                throw new Error('No target wallets found');
            }

            // 检查源钱包余额
            const balance = await this.connection.getBalance(new PublicKey(sourceWallet.publicKey));
            const sourceBalance = balance / LAMPORTS_PER_SOL;

            // 计算总转账金额
            const totalAmount = amount ? amount * targetWallets.length : sourceBalance * 0.999; // 预留 0.1% 手续费
            
            // 检查余额是否足够
            if (totalAmount + 0.001 > sourceBalance) { // 加上预估手续费
                throw new Error('Insufficient balance including fees');
            }

            // 计算每个目标钱包应收到的金额
            const amounts = this._calculateDistribution(totalAmount, targetWallets.length, amount !== null);

            // 按最大指令数分组
            const walletGroups = this._splitIntoGroups(targetWallets, this.MAX_TRANSFERS_PER_TX);
            const amountGroups = this._splitIntoGroups(amounts, this.MAX_TRANSFERS_PER_TX);

            // 分组发送交易
            const results = await Promise.all(
                walletGroups.map(async (group, index) => {
                    const transaction = new Transaction();
                    const groupAmounts = amountGroups[index];

                    group.forEach((wallet, i) => {
                        transaction.add(
                            SystemProgram.transfer({
                                fromPubkey: new PublicKey(sourceWallet.publicKey),
                                toPubkey: new PublicKey(wallet.publicKey),
                                lamports: Math.floor(groupAmounts[i] * LAMPORTS_PER_SOL)
                            })
                        );
                    });

                    // 发送交易
                    const signature = await this._sendTransaction(transaction, sourceWallet);
                    
                    // 记录转账历史
                    await this._recordTransfers(sourceWallet, group, groupAmounts, signature);

                    return {
                        signature,
                        wallets: group.map((wallet, i) => ({
                            groupType: toGroupType,
                            accountNumber: wallet.accountNumber,
                            publicKey: wallet.publicKey,
                            amount: groupAmounts[i]
                        }))
                    };
                })
            );

            // 发送交易后更新所有相关钱包状态
            const allWallets = [sourceWallet, ...targetWallets];
            await this._updateWalletsState(allWallets);

            return {
                success: true,
                from: {
                    groupType: fromGroupType,
                    accountNumber: fromAccountNumber,
                    publicKey: sourceWallet.publicKey
                },
                transactions: results
            };
        } catch (error) {
            logger.error('1对多转账失败:', error);
            throw error;
        }
    }

    // 多对多转账
    async manyToMany(fromGroupType, fromAccountRange, toGroupType, toAccountRange, amount = null) {
        try {
            const sourceWallets = await this._getSourceWallets(fromGroupType, fromAccountRange);
            const targetWallets = await this._getTargetWallets(toGroupType, toAccountRange);

            if (sourceWallets.length === 0 || targetWallets.length === 0) {
                throw new Error('Invalid wallet range');
            }

            // 检查所有源钱包的余额
            const balances = await this._calculateWalletBalances(sourceWallets);
            const totalBalance = balances.reduce((sum, b) => sum + b, 0);

            // 计算总转账金额
            const totalAmount = amount ? amount * targetWallets.length : totalBalance * 0.999;
            
            // 检查总余额是否足够
            if (totalAmount + (sourceWallets.length * 0.001) > totalBalance) { // 每个源钱包预留 0.001 SOL 手续费
                throw new Error('Insufficient total balance including fees');
            }

            // 计算每个目标钱包应收到的金额
            const amounts = this._calculateDistribution(totalAmount, targetWallets.length, amount !== null);

            // 为每个源钱包分配目标钱包
            const transferPlans = this._createTransferPlans(
                sourceWallets,
                targetWallets,
                amounts,
                balances
            );

            // 执行转账计划
            const results = await Promise.all(
                transferPlans.map(async plan => {
                    // 按最大指令数分组
                    const txGroups = this._splitTransferPlan(plan, this.MAX_TRANSFERS_PER_TX);
                    
                    return await Promise.all(
                        txGroups.map(async group => {
                            const transaction = new Transaction();
                            
                            group.transfers.forEach(transfer => {
                                transaction.add(
                                    SystemProgram.transfer({
                                        fromPubkey: new PublicKey(plan.sourceWallet.publicKey),
                                        toPubkey: new PublicKey(transfer.targetWallet.publicKey),
                                        lamports: Math.floor(transfer.amount * LAMPORTS_PER_SOL)
                                    })
                                );
                            });

                            const signature = await this._sendTransaction(transaction, plan.sourceWallet);
                            
                            await this._recordTransfers(
                                plan.sourceWallet,
                                group.transfers.map(t => t.targetWallet),
                                group.transfers.map(t => t.amount),
                                signature
                            );

                            return { signature, group };
                        })
                    );
                })
            );

            // 发送交易后更新所有相关钱包状态
            const allWallets = [...sourceWallets, ...targetWallets];
            await this._updateWalletsState(allWallets);

            return {
                success: true,
                transactions: results.flat()
            };
        } catch (error) {
            logger.error('多对多转账失败:', error);
            throw error;
        }
    }

    // 多对一转账（归集）
    async manyToOne(fromGroupType, fromAccountRange, toGroupType, toAccountNumber) {
        return this.walletService.manyToOne(fromGroupType, fromAccountRange, toGroupType, toAccountNumber);
    }

    // 辅助方法...
    async _getSourceWallets(groupType, accountRange) {
        const [start, end] = accountRange.split('-').map(Number);
        return await db.models.Wallet.findAll({  // 修改为使用 db.models
            where: {
                groupType,
                accountNumber: {
                    [db.Sequelize.Op.between]: [start, end]
                },
                status: 'active'
            },
            order: [['accountNumber', 'ASC']]
        });
    }

    async _getTargetWallets(groupType, accountRange) {
        const [start, end] = accountRange.split('-').map(Number);
        return await db.models.Wallet.findAll({  // 修改为使用 db.models
            where: {
                groupType,
                accountNumber: {
                    [db.Sequelize.Op.between]: [start, end]
                },
                status: 'active'
            },
            order: [['accountNumber', 'ASC']]
        });
    }

    _calculateDistribution(totalAmount, count, isFixedAmount = false) {
        if (isFixedAmount) {
            return new Array(count).fill(totalAmount / count);
        }

        const baseAmount = Math.floor((totalAmount * 0.999) / count); // 预留 0.1% 给最后一个
        const amounts = new Array(count - 1).fill(baseAmount);
        amounts.push(totalAmount - baseAmount * (count - 1));
        return amounts;
    }

    async _sendTransaction(transaction, wallet) {
        const signature = await super._sendTransaction(transaction, wallet);
        
        // 等待交易确认
        await this.connection.confirmTransaction(signature);
        
        // 获取并更新新余额
        const balance = await this.connection.getBalance(new PublicKey(wallet.publicKey));
        await this._updateWalletState(wallet, balance / LAMPORTS_PER_SOL);
        
        return signature;
    }

    async _recordTransfers(sourceWallet, targetWallets, amounts, signature) {
        await Promise.all(
            targetWallets.map((targetWallet, index) =>
                db.models.BalanceHistory.create({
                    groupType: sourceWallet.groupType,
                    accountNumber: sourceWallet.accountNumber,
                    publicKey: sourceWallet.publicKey,
                    targetGroupType: targetWallet.groupType,
                    targetAccountNumber: targetWallet.accountNumber,
                    targetPublicKey: targetWallet.publicKey,
                    amount: amounts[index],
                    transactionType: 'transfer_out',
                    transactionHash: signature,
                    metadata: {
                        timestamp: new Date().toISOString(),
                        type: 'batch_transfer'
                    }
                })
            )
        );
    }

    _getTargetIndicesForSource(sourceIndex, sourceCount, targetCount) {
        const targetsPerSource = Math.ceil(targetCount / sourceCount);
        const start = sourceIndex * targetsPerSource;
        const end = Math.min(start + targetsPerSource, targetCount);
        return Array.from({ length: end - start }, (_, i) => start + i);
    }

    async _calculateTotalBalance(wallets) {
        const balances = await Promise.all(
            wallets.map(async wallet => {
                const balance = await this.connection.getBalance(new PublicKey(wallet.publicKey));
                return balance / LAMPORTS_PER_SOL;
            })
        );
        return balances.reduce((sum, balance) => sum + balance, 0);
    }

    _splitIntoGroups(items, maxPerGroup) {
        const groups = [];
        for (let i = 0; i < items.length; i += maxPerGroup) {
            groups.push(items.slice(i, i + maxPerGroup));
        }
        return groups;
    }

    async _calculateWalletBalances(wallets) {
        return await Promise.all(
            wallets.map(async wallet => {
                const balance = await this.connection.getBalance(new PublicKey(wallet.publicKey));
                return balance / LAMPORTS_PER_SOL;
            })
        );
    }

    _createTransferPlans(sourceWallets, targetWallets, amounts, balances) {
        const plans = [];
        let targetIndex = 0;
        let remainingAmount = amounts.reduce((sum, a) => sum + a, 0);

        for (let i = 0; i < sourceWallets.length && remainingAmount > 0; i++) {
            const availableBalance = balances[i] - 0.001; // 预留手续费
            if (availableBalance <= 0) continue;

            const transfers = [];
            let usedBalance = 0;

            while (targetIndex < targetWallets.length && usedBalance < availableBalance) {
                const amount = Math.min(amounts[targetIndex], availableBalance - usedBalance);
                if (amount <= 0) break;

                transfers.push({
                    targetWallet: targetWallets[targetIndex],
                    amount
                });

                usedBalance += amount;
                remainingAmount -= amount;
                targetIndex++;
            }

            if (transfers.length > 0) {
                plans.push({
                    sourceWallet: sourceWallets[i],
                    transfers
                });
            }
        }

        return plans;
    }

    _splitTransferPlan(plan, maxTransfersPerTx) {
        const groups = [];
        for (let i = 0; i < plan.transfers.length; i += maxTransfersPerTx) {
            groups.push({
                sourceWallet: plan.sourceWallet,
                transfers: plan.transfers.slice(i, i + maxTransfersPerTx)
            });
        }
        return groups;
    }

    // 更新缓存和 WebSocket 订阅
    async _updateWalletState(wallet, newBalance) {
        try {
            // 更新 Redis 缓存
            if (this.redis) {
                await this.redis.setBalance(wallet.publicKey, newBalance);
            }

            // 更新 WebSocket 订阅中的最后已知余额
            const subscription = this.solanaService.subscriptions.get(wallet.publicKey);
            if (subscription) {
                subscription.wallet.lastKnownBalance = newBalance;
            }
        } catch (error) {
            logger.error('更新钱包状态失败:', error);
        }
    }

    // 批量更新钱包状态
    async _updateWalletsState(wallets) {
        try {
            // 批量获取最新余额
            const balances = await Promise.all(
                wallets.map(async wallet => {
                    const balance = await this.connection.getBalance(new PublicKey(wallet.publicKey));
                    return {
                        wallet,
                        balance: balance / LAMPORTS_PER_SOL
                    };
                })
            );

            // 批量更新 Redis 缓存
            if (this.redis) {
                const balanceMap = {};
                balances.forEach(({ wallet, balance }) => {
                    balanceMap[wallet.publicKey] = balance;
                });
                await this.redis.setBatchBalances(balanceMap);
            }

            // 更新 WebSocket 订阅状态
            balances.forEach(({ wallet, balance }) => {
                const subscription = this.solanaService.subscriptions.get(wallet.publicKey);
                if (subscription) {
                    subscription.wallet.lastKnownBalance = balance;
                }
            });
        } catch (error) {
            logger.error('批量更新钱包状态失败:', error);
        }
    }
} 