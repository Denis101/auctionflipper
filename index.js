const express = require('express');
const xml = require('xml');
const mysql = require('mysql');

const pool = mysql.createPool({
    connectionLimit: 10,
    host: 'newswire.theunderminejournal.com',
    user: '',
    password: '',
    database: 'newsstand',
});

const QueryType = {
    EQUALS: 'equals',
    IN: 'in',
    LIKE: 'like',
};

const TBL_REALM_QUERY_MAPPING = {
    realmId: 'blizzId',
    region: 'region',
    realm: 'slug',
    house: 'house',
};

const TBL_ITEM_SUMMARY_QUERY_MAPPING = {
    house: {
        type: QueryType.IN,
        name: 'house',
    },
    id: 'item',
};

const houseCache = [];

const simpleHash = (str) => {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
        var character = str.charCodeAt(i);
        hash = ((hash<<5)-hash)+character;
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
}

const mapField = mapping => {
    if (typeof mapping === 'string' || mapping instanceof String) {
        return mapping + ' = ?';
    }

    if (!(typeof mapping === 'object') && !(mapping instanceof Object)) {
        throw Error('Bad field mapping');
    }

    switch (mapping.type) {
        case QueryType.IN:
            return mapping.name + ' IN(?)';
        case QueryType.LIKE:
            return mapping.name + ' LIKE ?';
        case QueryType.EQUALS:
        default:
            return mapping.name + ' = ?';
    }
};

const mapParam = (value, mapping) => {
    if (typeof mapping === 'string' || mapping instanceof String) {
        return value;
    }

    if (!(typeof mapping === 'object') && !(mapping instanceof Object)) {
        throw Error('Bad param mapping');
    }

    if (mapping.type !== QueryType.IN) {
        return value;
    }

    return [...new Set(value.filter(v => v != null))];
};

const buildQuery = (sql, data, mapping) => {
    const conditions = [];
    const params = [];

    Object.keys(data).map(k => ({
        field: mapping[k],
        value: data[k],
    })).forEach(m => {
        conditions.push(mapField(m.field));
        params.push(mapParam(m.value, m.field));
    });

    if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
    }

    return {
        sql,
        params,
    }
};

const asyncQuery = (sql, params) => {
    return new Promise((resolve, reject) => {
        pool.query(sql, params, 
            (error, results) => error ? reject(error) : resolve(results));
    });
};

const getHouses = async data => {
    const query = buildQuery('SELECT house FROM tblRealm', data, TBL_REALM_QUERY_MAPPING);
    const hash = simpleHash(query.sql.replace(/\s+/g, '') + ':' + query.params.join(','));

    if (houseCache[hash]) {
        console.log('Loading house from cache');
        return houseCache[hash];
    }
    
    console.log('Querying newswire for house');
    houseCache[hash] = await asyncQuery(query.sql, query.params);
    return houseCache[hash];
};

const send = (res, data, format) => {
    if (format === '.xml') {
        res.type('application/xml');
        return res.send(xml(data));
    }

    res.type('application/json');
    return res.send(data);
}

const priceToXml = result => {
    const prices = [];
    result.forEach(r => {
        prices.push({
            price: [{ 
                _attr: {
                    house: r.house,
                    lastseen: r.lastseen,
                    level: r.level,
                }
            },
            {quantity: r.quantity},
            {value: r.price}]
        })
    });

    return {
        item: [
            { _attr: { id: result[0].item }},
            ...prices,
        ],
    };
}

const app = module.exports = express();

app.get('/house(:format(.xml|.json))', async (req, res) => send(res, await getHouses(req.query), req.params.format));

app.get('/price/(:id)(:format(.xml|.json))', async (req, res) => {
    const houses = await getHouses(req.query);
    const query = buildQuery('SELECT * FROM tblItemSummary',
        { house: houses.map(h => h.house), id: req.params.id }, 
        TBL_ITEM_SUMMARY_QUERY_MAPPING);
    const result = await asyncQuery(query.sql, query.params);
    send(res, req.params.format === '.xml' ? priceToXml(result) : result, req.params.format);
});

app.get('/items(:format(.xml|.json))', async (req, res) => {
    send(res, await asyncQuery('SELECT * FROM tblDBCItem WHERE auctionable = ?', [1]), req.params.format);
});

app.get('/item/(:id)(:format(.xml|.json))', async (req, res) => {
    send(res, await asyncQuery('SELECT * FROM tblDBCItem WHERE id = ?', [req.params.id]), req.params.format);
});

if (!module.parent) {
    const port = process.env.PORT || 3000;
    app.listen(port);
    console.log('Listening on port ' + port);
}