import { DataTypes } from 'sequelize';

export default (sequelize) => {
    const Token = sequelize.define('Token', {
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
        description: {
            type: DataTypes.TEXT,
            allowNull: true
        },
        image: {
            type: DataTypes.STRING,
            allowNull: true
        },
        external_url: {
            type: DataTypes.STRING,
            allowNull: true
        },
        creatorPublicKey: {
            type: DataTypes.STRING,
            allowNull: false,
            field: 'creator_public_key'
        },
        groupType: {
            type: DataTypes.STRING,
            allowNull: false,
            field: 'group_type'
        },
        accountNumber: {
            type: DataTypes.INTEGER,
            allowNull: false,
            field: 'account_number'
        },
        metadata: {
            type: DataTypes.JSON,
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
        },
        status: {
            type: DataTypes.STRING,
            defaultValue: 'active'
        }
    }, {
        tableName: 'tokens',
        timestamps: true,
        underscored: true,
        indexes: [
            {
                fields: ['owner'],
                name: 'token_owner_idx'
            },
            {
                fields: ['symbol'],
                name: 'token_symbol_idx'
            }
        ]
    });
    return Token;
}; 