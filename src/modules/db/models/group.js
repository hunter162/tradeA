import { DataTypes } from 'sequelize';

export default (sequelize) => {
    const Group = sequelize.define('Group', {
        groupType: {
            type: DataTypes.STRING,
            primaryKey: true,
            allowNull: false,
            field: 'group_type'
        },
        description: {
            type: DataTypes.STRING,
            allowNull: true
        },
        status: {
            type: DataTypes.STRING,
            allowNull: false,
            defaultValue: 'active'
        },
        metadata: {
            type: DataTypes.JSON,
            allowNull: true
        },
        createdAt: {
            type: DataTypes.DATE,
            allowNull: false,
            field: 'created_at'
        },
        updatedAt: {
            type: DataTypes.DATE,
            allowNull: false,
            field: 'updated_at'
        }
    }, {
        tableName: 'groups',
        timestamps: true,
        underscored: true,
        indexes: [
            {
                fields: ['status'],
                name: 'group_status_idx'
            }
        ]
    });

    Group.associate = (models) => {
        Group.hasMany(models.Wallet, {
            foreignKey: 'groupType',
            sourceKey: 'groupType'
        });
    };

    return Group;
}; 