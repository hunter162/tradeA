import WebSocket from 'ws';
import { PublicKey, Connection } from '@solana/web3.js';
import { logger } from '../utils/index.js';
import https from 'https';

export class WebSocketManager {
    constructor(endpoint) {
        // 优先使用环境变量中的 RPC 节点
        let httpEndpoint;
        try {
            const endpoints = process.env.SOLANA_RPC_ENDPOINTS 
                ? JSON.parse(process.env.SOLANA_RPC_ENDPOINTS)
                : [endpoint || 'https://api.mainnet-beta.solana.com'];

            httpEndpoint = endpoints[0];
        } catch (error) {
            logger.error('解析 RPC 节点失败:', {
                error: error.message,
                raw: process.env.SOLANA_RPC_ENDPOINTS
            });
            httpEndpoint = 'https://api.mainnet-beta.solana.com';
        }

        this.httpEndpoint = httpEndpoint;
        
        // 创建 HTTP 连接
        this.connection = new Connection(this.httpEndpoint, 'confirmed');
        
        // 获取 WebSocket endpoint
        this.wsEndpoint = this._getWsEndpoint(this.httpEndpoint);
        
        this.subscriptions = new Map();
        this.ws = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;

        // 配置参数
        this.WS_TIMEOUT = 30000;
        this.MAX_RETRIES = 3;
        this.RETRY_DELAY = 5000;
    }

    _getWsEndpoint(httpEndpoint) {
        try {
            const url = new URL(httpEndpoint);
            
            // 如果已经是 ws/wss，直接返回
            if (url.protocol === 'ws:' || url.protocol === 'wss:') {
                return httpEndpoint;
            }

            // 转换 http -> ws, https -> wss
            const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            url.protocol = wsProtocol;

            // 处理特殊域名
            if (url.hostname === 'mainnet.helius-rpc.com') {
                const apiKey = url.searchParams.get('api-key');
                return `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;
            }

            return url.toString();
        } catch (error) {
            logger.error('解析 WebSocket endpoint 失败:', {
                error: error.message,
                httpEndpoint
            });
            // 返回默认的 WebSocket endpoint
            return 'wss://api.mainnet-beta.solana.com';
        }
    }

    async connect() {
        try {
            const wsOptions = {
                handshakeTimeout: this.WS_TIMEOUT,
                rejectUnauthorized: false,
                headers: {
                    'Origin': 'https://solana.com',
                    'User-Agent': 'Mozilla/5.0'
                }
            };

            this.ws = new WebSocket(this.wsEndpoint, wsOptions);

            this.ws.on('open', () => {
                logger.info('WebSocket 连接成功:', {
                    endpoint: this.wsEndpoint.replace(/api-key=([^&]+)/, 'api-key=***')
                });
                this.isConnected = true;
                this.reconnectAttempts = 0;
            });

            this.ws.on('close', () => {
                logger.warn('WebSocket 连接关闭');
                this.isConnected = false;
                this.handleReconnect();
            });

            this.ws.on('error', (error) => {
                logger.error('WebSocket 错误:', error);
                this.handleReconnect();
            });

            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handleMessage(message);
                } catch (error) {
                    logger.error('处理 WebSocket 消息失败:', error);
                }
            });
        } catch (error) {
            logger.error('WebSocket 连接失败:', {
                error: error.message,
                endpoint: this.wsEndpoint.replace(/api-key=([^&]+)/, 'api-key=***')
            });
            throw error;
        }
    }

    async handleReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            logger.info(`尝试重新连接 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            setTimeout(() => this.connect(), 2000 * this.reconnectAttempts);
        } else {
            logger.error('WebSocket 重连失败次数过多');
        }
    }

    async subscribeToAccount(publicKey, callback) {
        try {
            const subscriptionId = await this.connection.onAccountChange(
                publicKey,
                callback,
                'confirmed'
            );

            this.subscriptions.set(publicKey.toString(), {
                id: subscriptionId,
                callback
            });

            logger.info('订阅账户变动:', {
                publicKey: publicKey.toString(),
                subscriptionId
            });

            return subscriptionId;
        } catch (error) {
            logger.error('订阅账户失败:', {
                error: error.message,
                publicKey: publicKey.toString()
            });
            throw error;
        }
    }

    async unsubscribeFromAccount(publicKey) {
        try {
            const subscription = this.subscriptions.get(publicKey.toString());
            if (subscription) {
                await this.connection.removeAccountChangeListener(subscription.id);
                this.subscriptions.delete(publicKey.toString());
                
                logger.info('取消账户订阅:', {
                    publicKey: publicKey.toString(),
                    subscriptionId: subscription.id
                });
            }
        } catch (error) {
            logger.error('取消订阅失败:', {
                error: error.message,
                publicKey: publicKey.toString()
            });
            throw error;
        }
    }

    async cleanup() {
        try {
            // 清理所有订阅
            for (const [publicKey, subscription] of this.subscriptions) {
                await this.unsubscribeFromAccount(publicKey);
            }

            // 关闭 WebSocket 连接
            if (this.ws) {
                this.ws.close();
                this.ws = null;
            }

            logger.info('WebSocket 管理器清理完成');
        } catch (error) {
            logger.error('清理 WebSocket 管理器失败:', error);
            throw error;
        }
    }

    handleMessage(message) {
        // 处理不同类型的 WebSocket 消息
        if (message.method === 'accountNotification') {
            const subscription = this.subscriptions.get(message.params.result.value.pubkey);
            if (subscription) {
                subscription.callback(message.params.result.value);
            }
        }
    }
} 