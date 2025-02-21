export const ErrorCodes = {
    // 系统错误 (1xxx)
    SYSTEM: {
        UNKNOWN: 1000,
        CONFIG_ERROR: 1001,
        INITIALIZATION_FAILED: 1002
    },

    // 网络错误 (2xxx)
    NETWORK: {
        CONNECTION_ERROR: 2000,
        TIMEOUT: 2001,
        RATE_LIMIT: 2002,
        ALL_NODES_FAILED: 2003
    },

    // 交易错误 (3xxx)
    TRANSACTION: {
        SIMULATION_FAILED: 3000,
        INVALID_PARAMS: 3001,
        INSUFFICIENT_FUNDS: 3002,
        SIGNATURE_FAILED: 3003,
        HIGH_COMPUTE_UNITS: 3004,
        HIGH_FEE: 3005,
        BALANCE_CHECK_FAILED: 3003,
        NO_VALID_TRANSFERS: 3004,
        MANY_TO_ONE_FAILED: 3005,
        TRANSFER_FAILED: 3016
    },

    // 钱包错误 (4xxx)
    WALLET: {
        NOT_FOUND: 4000,
        INVALID_KEYPAIR: 4001,
        UNAUTHORIZED: 4002,
        BALANCE_EXISTS: 'WALLET_BALANCE_EXISTS'
    },

    TOKEN: {
        ACCOUNT_NOT_FOUND: 3001,
        INVALID_MINT: 3002,
        INVALID_OWNER: 3003,
        BALANCE_QUERY_FAILED: 3004,
        SUBSCRIPTION_FAILED: 3005,
        INVALID_AMOUNT: 3006
    }
};

export const ErrorMessages = {
    [ErrorCodes.SYSTEM.UNKNOWN]: '未知系统错误',
    [ErrorCodes.SYSTEM.CONFIG_ERROR]: '配置错误',
    [ErrorCodes.SYSTEM.INITIALIZATION_FAILED]: '初始化失败',

    [ErrorCodes.NETWORK.CONNECTION_ERROR]: '网络连接错误',
    [ErrorCodes.NETWORK.TIMEOUT]: '请求超时',
    [ErrorCodes.NETWORK.RATE_LIMIT]: 'RPC 节点限流',
    [ErrorCodes.NETWORK.ALL_NODES_FAILED]: '所有 RPC 节点都不可用',

    [ErrorCodes.TRANSACTION.SIMULATION_FAILED]: '交易模拟失败',
    [ErrorCodes.TRANSACTION.INVALID_PARAMS]: '无效的交易参数',
    [ErrorCodes.TRANSACTION.INSUFFICIENT_FUNDS]: '余额不足',
    [ErrorCodes.TRANSACTION.SIGNATURE_FAILED]: '签名失败',
    [ErrorCodes.TRANSACTION.HIGH_COMPUTE_UNITS]: '计算单元使用过高',
    [ErrorCodes.TRANSACTION.HIGH_FEE]: '交易费用过高',
    [ErrorCodes.TRANSACTION.BALANCE_CHECK_FAILED]: '余额检查失败',
    [ErrorCodes.TRANSACTION.NO_VALID_TRANSFERS]: '没有可用的转账',
    [ErrorCodes.TRANSACTION.MANY_TO_ONE_FAILED]: '多对一归集失败',

    [ErrorCodes.WALLET.NOT_FOUND]: '钱包未找到',
    [ErrorCodes.WALLET.INVALID_KEYPAIR]: '无效的密钥对',
    [ErrorCodes.WALLET.UNAUTHORIZED]: '未授权的钱包操作',
    [ErrorCodes.WALLET.BALANCE_EXISTS]: '钱包已有余额，无法导入',

    [ErrorCodes.TOKEN.ACCOUNT_NOT_FOUND]: '代币账户不存在',
    [ErrorCodes.TOKEN.INVALID_MINT]: '无效的代币地址',
    [ErrorCodes.TOKEN.INVALID_OWNER]: '无效的所有者地址',
    [ErrorCodes.TOKEN.BALANCE_QUERY_FAILED]: '获取代币余额失败',
    [ErrorCodes.TOKEN.SUBSCRIPTION_FAILED]: '代币余额订阅失败',
    [ErrorCodes.TOKEN.INVALID_AMOUNT]: '无效的代币数量'
}; 