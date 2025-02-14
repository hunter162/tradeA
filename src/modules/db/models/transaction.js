import { DataTypes } from 'sequelize';

export default (sequelize) => {
    const Transaction = sequelize.define('Transaction', {
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
            type: DataTypes.STRING,
            allowNull: false
        },
        amount: {
            type: DataTypes.STRING,
            allowNull: false
        },
        tokenAmount: {
            type: DataTypes.STRING,
            allowNull: true,
            field: 'token_amount',
            comment: '交易涉及的代币数量'
        },
        tokenDecimals: {
            type: DataTypes.INTEGER,
            allowNull: true,
            field: 'token_decimals',
            comment: '代币的小数位数'
        },
        status: {
            type: DataTypes.STRING,
            allowNull: false
        },
        pricePerToken: {
            type: DataTypes.STRING,
            allowNull: true,
            field: 'price_per_token',
            comment: '每个代币的价格(以 lamports 计)'
        },
        slippage: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: '滑点百分比'
        },
        raw: {
            type: DataTypes.JSON,
            allowNull: true
        },
        createdAt: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW
        },
        updatedAt: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW
        }
    }, {
        tableName: 'transactions',
        timestamps: true,
        underscored: true,
        indexes: [
            {
                fields: ['mint'],
                name: 'transaction_mint_idx'
            },
            {
                fields: ['owner'],
                name: 'transaction_owner_idx'
            },
            {
                fields: ['type'],
                name: 'transaction_type_idx'
            },
            {
                fields: ['status'],
                name: 'transaction_status_idx'
            },
            {
                fields: ['created_at'],
                name: 'transaction_created_at_idx'
            }
        ]
    });

    Transaction.associate = (models) => {
        Transaction.belongsTo(models.Token, {
            foreignKey: 'mint',
            targetKey: 'mint'
        });
    };

    return Transaction;
}; 