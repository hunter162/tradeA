import { DataTypes } from 'sequelize';
import { db } from '../db/index.js';

// Token 模型
export const Token = db.define('Token', {
    mint: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false
    },
    owner: {
        type: DataTypes.STRING,
        allowNull: false
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    symbol: {
        type: DataTypes.STRING,
        allowNull: false
    },
    metadata: {
        type: DataTypes.JSONB,
        allowNull: true
    },
    uri: {
        type: DataTypes.STRING,
        allowNull: true
    },
    createdAt: {
        type: DataTypes.DATE,
        allowNull: false
    },
    updatedAt: {
        type: DataTypes.DATE,
        allowNull: false
    }
});

// Token 余额模型
export const TokenBalance = db.define('TokenBalance', {
    owner: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false
    },
    mint: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false
    },
    balance: {
        type: DataTypes.STRING,  // 使用字符串存储 BigInt
        allowNull: false,
        defaultValue: '0'
    },
    updatedAt: {
        type: DataTypes.DATE,
        allowNull: false
    }
});

// 交易记录模型
export const Transaction = db.define('Transaction', {
    signature: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false
    },
    mint: {
        type: DataTypes.STRING,
        allowNull: false
    },
    owner: {
        type: DataTypes.STRING,
        allowNull: false
    },
    type: {
        type: DataTypes.STRING,  // 'create', 'buy', 'sell'
        allowNull: false
    },
    amount: {
        type: DataTypes.STRING,  // 使用字符串存储 BigInt
        allowNull: false
    },
    status: {
        type: DataTypes.STRING,  // 'success', 'failed'
        allowNull: false
    },
    timestamp: {
        type: DataTypes.DATE,
        allowNull: false
    },
    raw: {
        type: DataTypes.JSONB,
        allowNull: true
    }
});

// 设置关联关系
Token.hasMany(TokenBalance, { foreignKey: 'mint' });
TokenBalance.belongsTo(Token, { foreignKey: 'mint' });

Token.hasMany(Transaction, { foreignKey: 'mint' });
Transaction.belongsTo(Token, { foreignKey: 'mint' });

// 同步模型到数据库
await db.sync();

export default {
    Token,
    TokenBalance,
    Transaction
}; 