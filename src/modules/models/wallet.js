import { DataTypes } from 'sequelize';

export default (sequelize) => {
    const Wallet = sequelize.define('Wallet', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        groupType: {
            type: DataTypes.STRING,
            allowNull: false
        },
        accountNumber: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        publicKey: {
            type: DataTypes.STRING,
            allowNull: false,
            unique: true
        },
        privateKey: {
            type: DataTypes.STRING,
            allowNull: false
        }
    }, {
        indexes: [
            {
                unique: true,
                fields: ['groupType', 'accountNumber']
            }
        ]
    });

    Wallet.associate = (models) => {
        Wallet.belongsTo(models.Group, {
            foreignKey: 'groupType',
            targetKey: 'groupType'
        });
    };

    return Wallet;
}; 