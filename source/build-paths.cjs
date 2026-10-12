// Emplacements communs aux outils CommonJS et ESM, indépendants du cwd.
const fs = require('node:fs');
const path = require('node:path');

const BUILD_ROOT = path.resolve(__dirname, '../build');

function buildPath(value, fallback) {
    const target = path.resolve(value || path.join(BUILD_ROOT, fallback));
    const relative = path.relative(BUILD_ROOT, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`La sortie doit être un sous-dossier de ${BUILD_ROOT}`);
    }
    // Refuser aussi les jonctions/liens existants qui redirigent les écritures.
    let ancestor = target;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    if (fs.realpathSync(ancestor).toLowerCase() !== ancestor.toLowerCase()) {
        throw new Error(`La sortie ne doit pas traverser un lien symbolique : ${target}`);
    }
    return target;
}

async function temporaryBuildDirectory(prefix) {
    const directory = buildPath(undefined, 'tmp');
    await fs.promises.mkdir(directory, { recursive: true });
    return fs.promises.mkdtemp(path.join(directory, prefix));
}

module.exports = { BUILD_ROOT, buildPath, temporaryBuildDirectory };
