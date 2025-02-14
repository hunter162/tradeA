import dotenv from 'dotenv';
import { config } from '../config/index.js';

// 确保在配置开始时加载环境变量
dotenv.config();

// 验证 Solana 配置
const validateSolanaConfig = () => {
    const { solana } = config;
    
    // 检查 RPC 端点配置
    if (!solana.rpcEndpoints || !solana.rpcEndpoints.length) {
        throw new Error('Missing or invalid Solana RPC URLs');
    }

    // 验证每个 URL 格式
    solana.rpcEndpoints.forEach(url => {
        try {
            new URL(url);
        } catch (e) {
            throw new Error(`Invalid RPC URL: ${url}`);
        }
    });

    // 验证 WebSocket URL
    try {
        new URL(solana.wsEndpoint);
    } catch (e) {
        throw new Error(`Invalid WebSocket URL: ${solana.wsEndpoint}`);
    }

    return true;
};

// 验证所有配置
const validateConfig = () => {
    validateSolanaConfig();
    // ... 其他验证
};

validateConfig();

export { config }; 