const http = require('http');
const fs = require('fs');
const path = require('path');
const options = { headers: { authorization: 'Basic YWRtaW46YWRtaW4=' } };

const metatypeHints = JSON.parse(fs.readFileSync(path.join(__dirname, 'metatypeHints.json')));

function getJSON(url, callback) {
    http.get(url, options, res => {
        let rawData = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { rawData += chunk; });
        res.on('end', () => {
            callback(JSON.parse(rawData));
        });
    });
}

function writeJSON(filepath, data) {
    fs.writeFile(filepath, JSON.stringify(Object.values(data), null, 4) + '\n', err => {
        if (!err) {
            console.log(`Content written to ${filepath}`);
        } else {
            console.error(err);
        }
    });
}

function processNodeTypes(data) {
    let sortObjectKeys = (v, ...args) => {
        let keys = Object.keys(v);
        let tmp = Object.fromEntries(keys.sort().map(i => [i, v[i]]));
        keys.forEach(i => delete v[i]);
        for (let i of args) {
            if (i in tmp) {
                v[i] = tmp[i];
                delete tmp[i];
            }
        }
        Object.assign(v, tmp);
        return v;
    };
    let cleanObjectKeys = function clean(v, i) {
        let keepChildNS = ['rep:namedPropertyDefinitions', 'rep:namedChildNodeDefinitions', 'rep:residualChildNodeDefinitions'].includes(i);
        for (let j in v) {
            // recursively clean objects
            if (typeof v[j] === 'object' && !Array.isArray(v[j])) {
                clean(v[j], j);
            }
            // remove any type hints properties, the jcr:primaryType property,
            // as well as to trim xmlns from keys unless referring names of node types
            if (j[0] === ':' || j === 'jcr:primaryType') {
                delete v[j];
            } else if (!keepChildNS && j.includes(':')) {
                v[j.replace(/^.+:/, '')] = v[j];
                delete v[j];
            }
        }
    };
    let normalizePropertyDefinition = v => {
        delete v.availableQueryOperators;
        delete v.onParentVersion;
        for (let i of ['mandatory', 'multiple', 'protected', 'autoCreated', 'isFullTextSearchable', 'isQueryOrderable']) {
            if (!v[i]) {
                delete v[i];
            }
        }
        if (!v.valueConstraints?.length) {
            delete v.valueConstraints;
        }
        if (!v.defaultValues?.length) {
            delete v.defaultValues;
        } else if (v.defaultValues.length === 1 && (typeof v.defaultValues[0] === 'boolean' || typeof v.defaultValues[0] === 'number')) {
            v.defaultValues = v.defaultValues[0];
        }
        sortObjectKeys(v);
    };
    let normalizeChildNodeDefinition = v => {
        delete v.onParentVersion;
        delete v.availableQueryOperators;
        for (let i of ['autoCreated', 'mandatory', 'protected', 'sameNameSiblings']) {
            if (!v[i]) {
                delete v[i];
            }
        }
        sortObjectKeys(v);
    };

    delete data[':jcr:primaryType'];
    delete data['jcr:primaryType'];
    Object.keys(data).forEach(i => {
        cleanObjectKeys(data[i], i);
        sortObjectKeys(data[i], 'nodeTypeName');

        // delete duplicated information that can be compiled from remaining properties
        delete data[i].mandatoryChildNodes;
        delete data[i].mandatoryProperties;
        delete data[i].namedSingleValuedProperties;
        delete data[i].protectedChildNodes;
        delete data[i].protectedProperties;
        delete data[i].propertyDefinition;
        delete data[i].childNodeDefinition;
        delete data[i].primarySubtypes;
        delete data[i].mixinSubtypes;
        Object.keys(data[i]).filter(v => v.startsWith('childNodeDefinition[') || v.startsWith('propertyDefinition[')).forEach(j => delete data[i][j]);

        let { namedPropertyDefinitions, namedChildNodeDefinitions, residualPropertyDefinitions, residualChildNodeDefinitions, supertypes } = data[i];
        if (namedPropertyDefinitions) {
            for (let i in namedPropertyDefinitions) {
                let v = namedPropertyDefinitions[i][Object.keys(namedPropertyDefinitions[i])[0]];
                delete namedPropertyDefinitions[i];
                namedPropertyDefinitions[v.name || i] = v;
                v.requiredType = v.requiredType === 'WEAKREFERENCE' ? 'WeakReference' : v.requiredType[0] + v.requiredType.slice(1).toLowerCase();
                normalizePropertyDefinition(v);
            }
            sortObjectKeys(namedPropertyDefinitions);
        }
        if (namedChildNodeDefinitions) {
            for (let i in namedChildNodeDefinitions) {
                let v = namedChildNodeDefinitions[i] = namedChildNodeDefinitions[i][Object.keys(namedChildNodeDefinitions[i])[0]];
                normalizeChildNodeDefinition(v);
            }
            sortObjectKeys(namedChildNodeDefinitions);
        }
        if (residualPropertyDefinitions) {
            for (let i in residualPropertyDefinitions) {
                normalizePropertyDefinition(residualPropertyDefinitions[i]);
            }
        }
        if (residualChildNodeDefinitions) {
            for (let i in residualChildNodeDefinitions) {
                normalizePropertyDefinition(residualChildNodeDefinitions[i]);
            }
        }
        supertypes.sort();
    });
    sortObjectKeys(data);
    return data;
}

function processMetaTypes(bundles) {
    let schemas = bundles.flatMap(v => {
        return v.configs.map(({ attributes, ...props }) => {
            let schema = {
                ...props,
                bundleName: v.bundleName,
                attributes: {}
            };
            if (schema.name === `${schema.id}.name`) {
                schema.name = schema.id;
            }
            if (schema.description === `${schema.id}.description`) {
                schema.description = '';
            }
            for (let v of attributes) {
                schema.attributes[v.id] = v;
                if (v.name === `${schema.id}.${v.id}.name`) {
                    v.name = v.id;
                }
                if (v.description === `${schema.id}.${v.id}.description`) {
                    v.description = '';
                }
                if (!isNaN(+v.cardinality)) {
                    v.cardinality = +v.cardinality;
                }
                if (Array.isArray(v.default) && v.default.length === 1 && v.cardinality === 'required') {
                    v.default = v.type === 'String' ? v.default[0] : v.type === 'Boolean' ? v.default[0] === 'true' : +v.default[0];
                }
                v.hint = metatypeHints[schema.id]?.[v.id];
                delete v.id;
            }
            return schema;
        });
    });
    schemas.sort((a, b) => a.id.localeCompare(b.id));
    return schemas;
}

getJSON('http://localhost:4502/crx/server/crx.default/jcr:root/jcr:system/jcr:nodeTypes.json', data => {
    processNodeTypes(data);
    writeJSON(path.resolve(__dirname, '..', 'assets/data/nodetypes.json'), data);
});

getJSON('http://localhost:4502/system/console/status-metatype.json', data => {
    let schemas = processMetaTypes(data.bundles);
    writeJSON(path.resolve(__dirname, '..', 'assets/data/metatypes.json'), schemas);
});
