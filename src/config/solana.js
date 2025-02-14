import { config } from './index.js';

export const SOLANA_CONFIG = {
    // 使用配置的所有 RPC 节点
    mainnetEndpoints: config.solana.rpcEndpoints,

    connectionConfig: {
        commitment: 'confirmed',
        disableRetryOnRateLimit: true,  // 禁用自动重试
        confirmTransactionInitialTimeout: 60000,
        wsEndpoint: config.solana.wsEndpoint,
        // 添加请求限制配置
        httpHeaders: {
            'Cache-Control': 'max-age=5'  // 启用缓存
        },
        // 添加并发限制
        fetchMiddleware: async (url, options, fetch) => {
            await new Promise(resolve => setTimeout(resolve, 100)); // 请求间隔 100ms
            return fetch(url, options);
        }
    },

    // 修改重试策略
    retryConfig: {
        maxRetries: 3,
        baseDelay: 2000,  // 增加基础延迟
        maxDelay: 10000,  // 增加最大延迟
        shouldRetry: (error) => {
            return error.message.includes('429') || 
                   error.message.includes('timeout') ||
                   error.message.includes('failed to fetch');
        }
    }
}; 