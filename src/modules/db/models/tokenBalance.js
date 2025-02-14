import { DataTypes } from 'sequelize';

export default (sequelize) => {
    const TokenBalance = sequelize.define('TokenBalance', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        owner: {
            type: DataTypes.STRING,
            allowNull: false
        },
        mint: {
            type: DataTypes.STRING,
            allowNull: false
        },
        balance: {
            type: DataTypes.STRING,
            allowNull: false,
            defaultValue: '0'
        }
    }, {
        tableName: 'token_balances',
        timestamps: true,
        underscored: true,
        indexes: [
            {
                unique: true,
                fields: ['owner', 'mint'],
                name: 'token_balance_owner_mint_idx'
            }
        ]
    });

    TokenBalance.associate = (models) => {
        TokenBalance.belongsTo(models.Token, {
            foreignKey: 'mint',
            targetKey: 'mint'
        });
    };

    return TokenBalance;
}; 