// Contrôle les manifestes du lot converti avec les schémas EBU.
const fs = require('node:fs/promises');
const path = require('node:path');
const { buildPath } = require('./build-paths.cjs');

const args = process.argv.slice(2);
const usage = 'Usage : node source/validate-manifests.cjs <lot OGRAF> [résultats sous build/]';

async function main() {
    if (args.length === 1 && args[0] === '--help') {
        console.log(usage);
        return;
    }
    if (args.length < 1 || args.length > 2) throw new Error(usage);
    const Ajv = require('../schema-validation/node_modules/ajv/dist/2020');
    const addFormats = require('../schema-validation/node_modules/ajv-formats');
    const root = path.resolve(args[0]);
    const destination = buildPath(args[1], 'validation/manifests');
    const schemaUrl = 'https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json';
    const schemas = {};
    const loadSchema = async url => {
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`${url} : HTTP ${response.status}`);
        return schemas[url] = await response.json();
    };
    const report = JSON.parse(await fs.readFile(path.join(root, 'conversion-report.json'), 'utf8'));
    if (!Array.isArray(report.templates) || !report.templates.length) throw new Error('Lot sans modèles à valider.');
    const ajv = new Ajv({ strict: false, allErrors: true, loadSchema });
    addFormats(ajv);
    const validate = await ajv.compileAsync(await loadSchema(schemaUrl));
    const templates = [];
    for (const item of report.templates) {
        if (typeof item.slug !== 'string' || !/^[a-z0-9-]+$/.test(item.slug)) throw new Error('Identifiant de modèle invalide.');
        const manifest = JSON.parse(await fs.readFile(path.join(root, 'sources', item.slug, `${item.slug}.ograf.json`), 'utf8'));
        if (!validate(manifest)) throw new Error(`${item.slug} : ${JSON.stringify(validate.errors)}`);
        templates.push({ package: item.package, valid: true });
    }
    const result = { schema: schemaUrl, checkedAt: new Date().toISOString(), valid: templates.length, total: report.templates.length, templates };
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, 'schema-validation.json'), JSON.stringify(result, null, 2) + '\n');
    await fs.writeFile(path.join(destination, 'ebu-schemas.json'), JSON.stringify(schemas, null, 2) + '\n');
    console.log(`${result.valid}/${result.total} manifestes conformes aux schémas EBU.`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
