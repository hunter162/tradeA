import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import axios from 'axios';

// 日志配置
const logger = {
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args)
};

export class JitoService {
    constructor(connection, config = {}) {
        this.connection = connection;
        this.config = {
            endpoints: [
                'https://mainnet.block-engine.jito.wtf:443/api/v1',
                'https://amsterdam.mainnet.block-engine.jito.wtf:443/api/v1',
                'https://frankfurt.mainnet.block-engine.jito.wtf:443/api/v1',
                'https://ny.mainnet.block-engine.jito.wtf:443/api/v1',
                'https://tokyo.mainnet.block-engine.jito.wtf:443/api/v1'
            ],
            uuid: null,
            tipAmount: 2_000_000, // 默认 0.002 SOL
            maxBundleSize: 5,
            retryAttempts: 3,
            retryDelayMs: 1000,
            ...config
        };
        this.bestEndpoint = null;
    }

    /**
     * 初始化服务并选择最佳端点
     */
    async initialize() {
        // 测试所有端点延迟并选择最快的
        const endpoints = this.config.endpoints;
        let bestLatency = Infinity;
        let bestEndpoint = endpoints[0];

        for (const endpoint of endpoints) {
            try {
                const start = Date.now();
                await axios.get(endpoint);
                const latency = Date.now() - start;
                
                if (latency < bestLatency) {
                    bestLatency = latency;
                    bestEndpoint = endpoint;
                }
            } catch (error) {
                logger.warn(`端点 ${endpoint} 不可用`);
            }
        }

        this.bestEndpoint = bestEndpoint;
        logger.info(`选择最佳端点: ${this.bestEndpoint}`);
    }

    /**
     * 获取 Jito 小费账户
     */
    async getTipAccount() {
        const response = await axios.get(`${this.bestEndpoint}/tip-accounts`);
        const tipAccounts = response.data;
        return tipAccounts[Math.floor(Math.random() * tipAccounts.length)];
    }

    /**
     * 为单个交易添加小费
     */
    async addTipToTransaction(transaction, options = {}) {
        // 获取tip账户，优先使用传入的，否则获取一个
        const tipAccount = options.tipAccount || await this.getTipAccount();

        // 设置tip金额，优先使用传入的tipAmount，否则使用config中的默认值
        let tipAmount;

       if (options.tipAmountSol !== undefined) {
            tipAmount = Math.floor(options.tipAmountSol * LAMPORTS_PER_SOL);
        }
        // 使用默认值
        else {
            tipAmount = this.config.tipAmount;
        }

        const tipPubkey = new PublicKey(tipAccount);

        // 检查交易是否设置了feePayer
        if (!transaction.feePayer) {
            throw new Error('Transaction feePayer is required');
        }

        // 创建小费指令
        const tipInstruction = SystemProgram.transfer({
            fromPubkey: transaction.feePayer,
            toPubkey: tipPubkey,
            lamports: tipAmount
        });

        // 添加小费指令到交易的开头
        const newTransaction = new Transaction();
        newTransaction.feePayer = transaction.feePayer;
        newTransaction.recentBlockhash = transaction.recentBlockhash;

        // 先添加小费指令
        newTransaction.add(tipInstruction);
        // 再添加原交易的所有指令
        transaction.instructions.forEach(ix => newTransaction.add(ix));

        return newTransaction;
    }
    /**
     * 批量发送交易
     */
    async sendBatchTransactions(transactions, options = {}) {
        const {
            tipAmount = this.config.tipAmount,
            maxBundleSize = this.config.maxBundleSize
        } = options;

        const bundleIds = [];
        
        // 获取最新区块哈希
        const { blockhash } = await this.connection.getLatestBlockhash();

        // 将交易分成批次处理
        for (let i = 0; i < transactions.length; i += maxBundleSize) {
            const batch = transactions.slice(i, i + maxBundleSize);
            
            // 为每个交易添加小费并更新区块哈希
            const txsWithTip = await Promise.all(batch.map(async tx => {
                tx.recentBlockhash = blockhash;
                return this.addTipToTransaction(tx, { tipAmount });
            }));

            const bundleId = await this.sendBundle(txsWithTip);
            bundleIds.push(bundleId);
            
            logger.info(`已处理 ${i + batch.length}/${transactions.length} 笔交易`);
        }

        return bundleIds;
    }

    /**
     * 发送单个 bundle
     */
    async sendBundle(transactions) {
        for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
            try {
                // 序列化交易
                const serializedTxs = transactions.map(tx => 
                    tx.serialize().toString('base64')
                );

                // 发送到 Jito
                const response = await axios.post(`${this.bestEndpoint}/bundle`, {
                    transactions: serializedTxs,
                    uuid: this.config.uuid
                });

                const bundleId = response?.data?.result;
                if (!bundleId) {
                    throw new Error('Missing bundle ID in response');
                }

                logger.info(`Bundle 发送成功, ID: ${bundleId}`);
                return bundleId;

            } catch (error) {
                logger.warn(`发送 bundle 失败，尝试 ${attempt}/${this.config.retryAttempts}`, error);

                if (attempt === this.config.retryAttempts) {
                    throw new Error(`Bundle 发送失败: ${error.message}`);
                }

                await new Promise(resolve => setTimeout(resolve, this.config.retryDelayMs * attempt));
            }
        }
    }

    /**
     * 监控 bundle 状态
     */
    async monitorBundle(bundleId) {
        for (let attempt = 0; attempt < this.config.retryAttempts; attempt++) {
            try {
                const response = await axios.get(`${this.bestEndpoint}/bundle/${bundleId}`);
                const status = response?.data?.status;

                switch (status) {
                    case 'Landed':
                        logger.info(`Bundle ${bundleId} 已确认`);
                        return true;
                    case 'Pending':
                        if (attempt === this.config.retryAttempts - 1) {
                            throw new Error('Bundle 处理超时');
                        }
                        await new Promise(resolve => setTimeout(resolve, this.config.retryDelayMs));
                        continue;
                    case 'Failed':
                        throw new Error('Bundle 处理失败');
                    default:
                        throw new Error(`未预期的状态: ${status}`);
                }
            } catch (error) {
                logger.error(`监控 bundle ${bundleId} 失败`, error);
                throw error;
            }
        }

        return false;
    }

    /**
     * 快速监控 bundle 状态
     */
    async monitorBundleFast(bundleId) {
        let attempts = 0;
        while (attempts < this.config.retryAttempts * 10) {
            try {
                const response = await axios.get(`${this.bestEndpoint}/bundle/${bundleId}`);
                const status = response?.data?.status;

                if (status === 'Landed') {
                    return true;
                } else if (status === 'Failed') {
                    throw new Error('Bundle 处理失败');
                }

                attempts++;
                await new Promise(resolve => setTimeout(resolve, 100)); // 快速轮询，100ms
            } catch (error) {
                logger.error(`监控 bundle ${bundleId} 失败`, error);
                throw error;
            }
        }

        throw new Error('Bundle 处理超时');
    }
}