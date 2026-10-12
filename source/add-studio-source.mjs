// Ajoute une source .ogs éditable sans remplacer le moteur de diffusion GT.
// Exécution avec le chargeur tsx d'une copie de Studio 0.21 : voir la documentation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { buildPath } from './build-paths.cjs';

const PACKAGE_VERSION = '1.0.3';
const FPS = 50;
const encode = value => JSON.stringify(value, null, 2) + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const color = value => /^#[0-9a-f]{8}$/i.test(value) ? `#${value.slice(3)}${value.slice(1, 3)}` : value;

export async function loadStudio(studioRoot) {
    const root = path.resolve(studioRoot);
    const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    if (metadata.version !== '0.21.0') throw new Error(`Studio ${metadata.version} : adaptateur vérifié avec 0.21.0 uniquement.`);
    const require = createRequire(path.join(root, 'package.json'));
    const module = file => import(pathToFileURL(path.join(root, file)).href);
    const model = await module('packages/scene-model/src/index.ts');
    const validation = await module('packages/validation/src/index.ts');
    const { importOgrafData } = await module('apps/editor/src/state/importOgraf.ts');
    const { compileDescriptor } = await module('packages/codegen/src/compileDescriptor.ts');
    // Le calcul de pose du moteur GT ne nécessite aucun DOM. Son rendu est
    // désactivé pendant l'échantillonnage ; aucun JavaScript tiers n'est exécuté.
    const previous = globalThis.HTMLElement;
    globalThis.HTMLElement = class { attachShadow() {} };
    let Graphic;
    try { ({ default: Graphic } = await import('./gt-runtime.mjs')); }
    finally { if (previous === undefined) delete globalThis.HTMLElement; else globalThis.HTMLElement = previous; }
    return { model, validation, importOgrafData, compileDescriptor, Graphic, JSZip: require('jszip'), version: metadata.version };
}

export function sampleScene(scene, Graphic) {
    const graphic = new Graphic();
    graphic.scene = scene;
    graphic.values = { ...scene.defaults };
    graphic.states = scene.nodes.map(() => ({ opacity: 1, dx: 0, dy: 0, reveal: null, frame: null }));
    graphic.render = () => {};
    const max = Math.max(0, ...scene.boards.filter(b => /^Page\d+$/.test(b.type)).map(b => Number(b.type.slice(4))));
    const types = ['TransitionIn', ...Array.from({ length: max }, (_, i) => `Page${i + 1}`), 'TransitionOut'];
    const samples = [];
    const boundaries = [0];
    const snapshot = () => {
        graphic.geometryCache = [new Map(), new Map()];
        return scene.nodes.map((node, i) => ({ ...graphic.geometry(i), mask: graphic.geometry(i, true),
            image: graphic.frameAt(node, graphic.states[i].frame ?? node.positionInSequence) }));
    };
    for (const type of types) {
        const animations = scene.boards.filter(b => b.type === type).flatMap(b => b.animations);
        const duration = Math.max(0, ...animations.filter(a => !['Hidden', 'None'].includes(a.type)).map(a => a.delay + a.duration));
        const frames = Math.max(1, Math.ceil(duration * FPS));
        if (!samples.length) { graphic.apply(animations, 0, false); samples.push(snapshot()); }
        for (let frame = 1; frame <= frames; frame++) {
            graphic.apply(animations, frame === frames ? Infinity : frame / FPS, type === 'TransitionOut');
            samples.push(snapshot());
        }
        boundaries.push(samples.length - 1);
    }
    return { samples, boundaries };
}

// Les valeurs linéaires intermédiaires n'ajoutent rien à une piste éditable.
function simplify(values) {
    return values.map((value, frame) => ({ value: Math.round(value * 1e6) / 1e6, frame })).filter((key, i, all) =>
        !i || i === all.length - 1 || Math.abs((key.value - all[i - 1].value) - (all[i + 1].value - key.value)) > 1e-5);
}

export function buildStudioProject(scene, manifest, files, studio) {
    const { model: m } = studio;
    const { samples, boundaries } = sampleScene(scene, studio.Graphic);
    const warnings = [];
    const assets = [];
    const assetByFile = new Map();
    const asset = file => {
        if (!file) return null;
        if (assetByFile.has(file)) return assetByFile.get(file);
        const bytes = files.get(file);
        if (!bytes) throw new Error(`Ressource Studio manquante : ${file}`);
        const ext = path.extname(file).slice(1);
        const mimeType = { webp: 'image/webp', png: 'image/png', otf: 'font/otf', ttf: 'font/ttf' }[ext];
        if (!mimeType) throw new Error(`Ressource non prise en charge : ${file}`);
        const font = scene.fonts.find(font => font.file === file);
        const item = m.createAsset({ id: `asset-${hash(bytes).slice(0, 24)}`, name: path.basename(file),
            kind: font ? 'font' : 'image', mimeType, byteSize: bytes.length, packagePath: file,
            dataUri: `data:${mimeType};base64,${bytes.toString('base64')}`,
            ...(font ? { fontFamily: font.family, fontWeight: String(font.weight), fontStyle: 'normal' } : {}) });
        if (font?.family === 'Barlow' && files.has('fonts/Barlow-OFL.txt')) {
            item.licenseText = files.get('fonts/Barlow-OFL.txt').toString('utf8');
        }
        const licenseFile = font && `fonts/${font.family.replaceAll(' ', '-')}-LICENSE.txt`;
        if (licenseFile && files.has(licenseFile)) item.licenseText = files.get(licenseFile).toString('utf8');
        const duplicate = assets.find(existing => existing.id === item.id);
        if (!duplicate) assets.push(item);
        const result = duplicate || item;
        assetByFile.set(file, result);
        return result;
    };
    scene.nodes.forEach(node => node.frames?.forEach(asset));
    scene.fonts.forEach(font => asset(font.file));
    const imageFields = new Set(scene.nodes.filter(n => n.type === 'Image' && n.field).map(n => n.field));
    const colorFields = new Set(scene.nodes.filter(n => n.type === 'Rectangle' && n.colorField).map(n => n.colorField));
    const fields = Object.entries(manifest.schema.properties).map(([key, definition], index) =>
        m.createFieldDefinition(definition.type === 'boolean' ? 'boolean' : colorFields.has(key) ? 'color' : imageFields.has(key) ? 'image-url' : 'text', {
            id: `field-${index}`, key, label: definition.title || key,
            defaultValue: definition.default, description: definition.description || '',
        }));
    const fieldByKey = new Map(fields.map(field => [field.key, field]));
    const bindings = (key, targetProperty, extra = {}) => key ? [{ fieldId: fieldByKey.get(key).id, targetProperty, ...extra }] : [];
    const layers = [];
    const maskLayers = new Map();
    const transform = (index, frame, mask = false) => {
        const g = mask ? samples[frame][index].mask : samples[frame][index];
        const node = scene.nodes[index];
        return { x: g.x, y: g.y, width: Math.max(1, node.size[0]), height: Math.max(1, node.size[1]),
            rotation: 0, opacity: Math.max(0, Math.min(1, g.opacity)), transformOriginX: 0, transformOriginY: 0 };
    };
    function animate(layer, poses) {
        layer.keyframes = [m.createLayerKeyframe(0, poses[0], { id: `${layer.id}-pose` })];
        for (const property of ['x', 'y', 'width', 'height', 'opacity']) {
            layer.animationTracks[property] = simplify(poses.map(p => p[property])).map(({ frame, value }) =>
                ({ id: `${layer.id}-${property}-${frame}`, frame, value, easing: 'linear' }));
        }
    }
    function newLayer(id, name, kind, element) {
        const layer = m.createLayerOfKind(kind);
        Object.assign(layer, { id, name, element: { ...layer.element, ...element } });
        return layer;
    }
    function clipLayer(index, prefix, nested = null, mask = false) {
        const geometry = samples.map(sample => mask ? sample[index].mask : sample[index]);
        if (!geometry.some(g => g.clip.some((v, i) => Math.abs(v - [0, 0, scene.width, scene.height][i]) > .001))) return nested;
        const clip = newLayer(`${prefix}-clip`, `${scene.nodes[index].name} · recadrage`, 'rectangle', { fill: '#ffffff' });
        clip.isMaskOnly = true;
        clip.mask = nested;
        animate(clip, geometry.map(g => ({ x: g.clip[0], y: g.clip[1], width: Math.max(1, g.clip[2]), height: Math.max(1, g.clip[3]),
            opacity: g.clip[2] > 0 && g.clip[3] > 0 ? 1 : 0, rotation: 0, transformOriginX: 0, transformOriginY: 0 })));
        layers.push(clip);
        return { sourceLayerId: clip.id, mode: 'alpha', inverted: false };
    }
    function maskFor(name) {
        if (!name) return null;
        const index = scene.nodes.findIndex(n => n.name === name);
        if (index < 0) throw new Error(`Masque GT absent : ${name}`);
        if (maskLayers.has(index)) return { sourceLayerId: maskLayers.get(index).id, mode: 'alpha', inverted: false };
        const node = scene.nodes[index];
        const image = asset(samples[boundaries[1]][index].image);
        const layer = newLayer(`mask-${index}`, `${node.name} · masque`, image ? 'image' : 'rectangle', image ? { src: `asset:${image.id}` } : { fill: '#ffffff' });
        maskLayers.set(index, layer);
        layer.isMaskOnly = true;
        animate(layer, samples.map((_, frame) => transform(index, frame, true)));
        layer.mask = clipLayer(index, layer.id, maskFor(node.mask), true);
        layers.push(layer);
        if ((node.frames?.length || 0) > 1) warnings.push({ type: 'masque-sequence', node: name,
            detail: "Studio ne prend pas les séquences comme sources de masque alpha : masque éditable fixé à l'image de la première étape." });
        return { sourceLayerId: layer.id, mode: 'alpha', inverted: false };
    }
    function textElement(node, fallback = false) {
        const size = Math.max(1, fallback ? node.textSize : node.fontSize);
        return { content: fallback ? scene.defaults[node.textField] || '' : node.text || '', color: fallback ? '#ffffff' : color(node.fill),
            fontFamily: fallback ? 'Barlow' : node.font, fontSize: size, minFontSize: 1,
            fontWeight: fallback || ['Bold', 'ExtraBold'].includes(node.weight) ? 700 : 400,
            textAlign: (fallback ? node.textAlign : node.align || 'Left').toLowerCase(),
            verticalAlign: fallback || node.vertical === 'Center' ? 'middle' : node.vertical === 'Bottom' ? 'bottom' : 'top',
            lineHeight: fallback ? 1.15 : node.lineSpacing, textTransform: fallback || node.uppercase ? 'uppercase' : 'none',
            autoFit: fallback || node.shrink ? 'shrink-to-fit' : 'fixed', overflowPolicy: 'clip' };
    }
    for (const [index, node] of scene.nodes.entries()) {
        if (node.type === 'Layer') continue; // positions et opacités des parents déjà calculées par GT
        let kind = node.type === 'TextBlock' ? 'text' : node.type === 'Rectangle' ? 'rectangle' : 'image';
        let element;
        const original = asset(samples[boundaries[1]][index].image);
        if (kind === 'text') element = textElement(node);
        else if (kind === 'rectangle') element = { fill: color(node.fill) };
        else if ((node.frames?.length || 0) > 1 && !node.field) {
            kind = 'image-sequence';
            element = { frames: samples.slice(0, boundaries[1] + 1).map(sample => `asset:${asset(sample[index].image).id}`), fps: FPS, loop: false };
            warnings.push({ type: 'sequence-sortie', node: node.name,
                detail: "Images d'entrée échantillonnées à 50 i/s ; lecture selon l'horloge de contenu Studio (démarrage au chargement). La sortie image par image GT est remplacée par un fondu. Contrôler les reprises et la synchronisation avant réexport." });
        } else {
            element = { src: original ? `asset:${original.id}` : null };
            if ((node.frames?.length || 0) > 1) warnings.push({ type: 'sequence-dynamique', node: node.name,
                detail: "La séquence liée à un champ image est importée comme image éditable de la première étape ; les images source restent dans les ressources." });
        }
        const layer = newLayer(`gt-${index}`, node.name, kind, element);
        layer.semantics.description = `Source vMix : ${node.name}`;
        const poses = samples.map((_, frame) => transform(index, frame));
        if (kind === 'image-sequence') {
            const from = boundaries.at(-2), to = boundaries.at(-1);
            for (let frame = from; frame <= to; frame++) poses[frame].opacity *= 1 - (frame - from) / (to - from);
        }
        animate(layer, poses);
        layer.mask = clipLayer(index, layer.id, maskFor(node.mask));
        layer.bindings = kind === 'text' ? bindings(node.field, 'content') : kind === 'image' ? bindings(node.field, 'src',
            original ? { valueMap: { '': original.dataUri } } : {}) : kind === 'rectangle' ? bindings(node.colorField, 'fill') : [];
        layers.push(layer);
        if (node.type === 'Image' && node.sizeMode && !['Fit', 'Centered'].includes(node.sizeMode)) {
            warnings.push({ type: 'ajustement-image', node: node.name,
                detail: `Le mode GT ${node.sizeMode} devient un ajustement proportionnel Studio ; contrôler les dimensions des images de remplacement.` });
        }
        if (node.textField) {
            const text = newLayer(`text-${index}`, `${node.name} · texte`, 'text', textElement(node, true));
            animate(text, samples.map((_, frame) => transform(index, frame)));
            text.bindings = bindings(node.textField, 'content');
            text.mask = layer.mask;
            layers.push(text);
            if (scene.defaults[node.textField]) layer.isVisible = false;
            warnings.push({ type: 'texte-image', node: node.name,
                detail: "Texte et image sont des calques séparés : masquer l'image dans Studio si un texte de remplacement est utilisé." });
        }
    }
    const visibility = fields.filter(field => field.type === 'boolean');
    if (visibility.length) warnings.push({ type: 'visibilite', fields: visibility.map(field => field.key),
        detail: 'Visibilités initiales conservées dans les pistes ; Studio ne lie pas les champs booléens à la visibilité des calques. Ajuster la visibilité et les pistes d’opacité avant réexport.' });
    if (scene.boards.some(board => board.type.startsWith('DataChange'))) warnings.push({ type: 'data-change',
        detail: 'Les storyboards GT DataChange ne sont pas importés dans la timeline Studio ; les champs restent éditables.' });
    const keyframes = boundaries.map((_, index) => m.createKeyframe({ id: `state-${index}`,
        name: !index ? 'Start' : index === boundaries.length - 1 ? 'End' : `Step ${index}`,
        role: !index ? 'start' : index === boundaries.length - 1 ? 'end' : 'step' }));
    const composition = m.createComposition({ id: 'gt-composition', name: scene.name, width: scene.width, height: scene.height,
        backgroundColor: 'transparent', frameRate: FPS, layers, assets, dataFields: fields, keyframes,
        transitions: keyframes.slice(1).map((key, index) => m.createTransition(keyframes[index].id, key.id,
            { id: `transition-${index}`, durationFrames: boundaries[index + 1] - boundaries[index], easing: 'linear' })) });
    const project = m.createProject({ id: manifest.id, name: manifest.name, version: PACKAGE_VERSION,
        description: `${manifest.description}. Source éditable adaptée à Studio ; voir STUDIO-IMPORT.md pour les écarts de rendu et d'animation.`,
        author: { name: '' }, supportsRealTime: true, supportsNonRealTime: false,
        thumbnailFrame: boundaries[1], mainCompositionId: composition.id, compositions: [composition] });
    const validation = studio.validation.validateProject(project);
    if (validation.errors.length) throw new Error(`${scene.name} : ${validation.errors.join('\n')}`);
    return { project, warnings, validationWarnings: validation.warnings, boundaries };
}

export async function addStudioSources(input, output, studioRoot) {
    input = path.resolve(input); output = buildPath(output, 'studio');
    if (input === output) throw new Error('Utiliser un dossier de préparation distinct pour préserver le lot original.');
    const studio = await loadStudio(studioRoot);
    const report = JSON.parse(await fs.readFile(path.join(input, 'conversion-report.json'), 'utf8'));
    const count = report.templates.length;
    const results = [];
    await fs.mkdir(path.join(output, 'studio'), { recursive: true });
    for (const item of report.templates) {
        const source = await fs.readFile(path.join(input, item.package));
        assert.equal(hash(source), item.sha256, `Archive source modifiée : ${item.package}`);
        const archive = await studio.JSZip.loadAsync(source);
        const files = new Map();
        for (const file of Object.values(archive.files)) if (!file.dir) files.set(file.name, await file.async('nodebuffer'));
        const manifestName = `${item.slug}.ograf.json`;
        const manifest = JSON.parse(files.get(manifestName));
        const scene = JSON.parse(files.get('scene.json'));
        const built = buildStudioProject(scene, manifest, files, studio);
        const projectName = `${item.slug}.ogs`;
        const notice = `# Source éditable OGraf Studio\n\nApplication : GrafBridge 0.1.0\n\nOuvrir ${projectName} avec File → Open dans Studio 0.21, ou importer ce ZIP avec File → Import OGraf.\nSe placer sur Step 1 pour examiner le graphisme affiché ; Start correspond à son entrée.\nLe lecteur graphic.mjs conserve le rendu GT de diffusion. Le projet Studio est une adaptation éditable ; son réexport utilise le moteur Studio.\nTextes, images, champs et polices sont embarqués. Le moteur de texte Studio peut modifier les retours à la ligne et les métriques.\n\n## Adaptations à contrôler avant réexport\n\n${built.warnings.map(w => `- ${w.node ? `${w.node} : ` : ''}${w.detail}`).join('\n')}\n\nConsulter les licences des polices avant redistribution.\n`;
        manifest.version = PACKAGE_VERSION;
        files.set(manifestName, Buffer.from(encode(manifest)));
        files.set(projectName, Buffer.from(encode(built.project)));
        files.set('STUDIO-IMPORT.md', Buffer.from(notice));
        const readme = files.get('README.md').toString('utf8').split('\n## Édition dans OGraf Studio\n')[0]
            .replace(/Version du package : \S+/, `Version du package : ${PACKAGE_VERSION}`).trimEnd();
        files.set('README.md', Buffer.from(`${readme}\n## Édition dans OGraf Studio\n\nSource éditable : ${projectName}. Voir STUDIO-IMPORT.md pour l'ouverture et les adaptations.\n`));
        const compiled = studio.compileDescriptor(built.project.compositions[0]);
        assert.equal(compiled.stepCount, manifest.stepCount);
        const zip = new studio.JSZip();
        for (const [name, bytes] of files) zip.file(name, bytes);
        const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        if (bytes.length > 32 * 1024 ** 2 || files.size > 512 || [...files.values()].reduce((sum, b) => sum + b.length, 0) > 128 * 1024 ** 2) {
            throw new Error(`Archive hors limites applicatives : ${item.package}`);
        }
        const imported = await studio.importOgrafData(item.package, bytes);
        assert.equal(imported.mode, 'embedded-project', imported.warnings.join('\n'));
        assert.deepEqual(studio.validation.validateProject(imported.project).errors, []);
        assert.ok(imported.project.compositions[0].layers.length);
        assert.deepEqual(imported.project, built.project);
        const destination = path.join(output, 'sources', item.slug);
        await fs.mkdir(destination, { recursive: true });
        for (const [name, data] of files) {
            const target = path.join(destination, name);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, data);
        }
        await fs.writeFile(path.join(output, 'studio', projectName), files.get(projectName));
        await fs.writeFile(path.join(output, item.package), bytes);
        Object.assign(item, { version: PACKAGE_VERSION, bytes: bytes.length, sha256: hash(bytes), files: files.size, studioProject: `studio/${projectName}` });
        results.push({ slug: item.slug, package: item.package, sha256: item.sha256, mode: imported.mode,
            layers: compiled.layers.length, fields: built.project.compositions[0].dataFields.length,
            assets: built.project.compositions[0].assets.length, warnings: built.warnings, validationWarnings: built.validationWarnings,
            importWarnings: imported.warnings, boundaries: built.boundaries });
        console.log(`${item.slug} : source .ogs importée, ${compiled.layers.length} calques, ${(bytes.length / 1048576).toFixed(2)} Mio`);
    }
    report.packageVersion = PACKAGE_VERSION;
    await fs.writeFile(path.join(output, 'conversion-report.json'), encode(report));
    await fs.writeFile(path.join(output, 'studio-import-report.json'), encode({ application: 'GrafBridge', applicationVersion: '0.1.0', packageVersion: PACKAGE_VERSION,
        studioVersion: studio.version, checkedAt: new Date().toISOString(), templates: results }));
    await fs.copyFile(path.join(input, 'index.html'), path.join(output, 'index.html'));
    const inputReadme = await fs.readFile(path.join(input, 'README.md'), 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return `# Lot OGraf\n\n${count} packages convertis ; voir conversion-report.json et sources/<modèle>/README.md.`;
    });
    const readme = inputReadme.split('\n## Édition dans OGraf Studio\n')[0]
        .replace(/version de package \*\*[^*]+\*\*/, `version de package **${PACKAGE_VERSION}**`)
        .trimEnd();
    await fs.writeFile(path.join(output, 'README.md'), `${readme}\n\n## Édition dans OGraf Studio\n\nLes ${count} projets autonomes sont dans studio/<modèle>.ogs. Utiliser File → Open et se placer sur Step 1 pour voir le graphisme affiché. Chaque ZIP contient aussi sa source .ogs, reconnue par File → Import OGraf dans Studio 0.21.\n\nLes calques, champs et polices sont éditables. Cette source adapte les scènes GT au moteur Studio : voir sources/<modèle>/STUDIO-IMPORT.md pour les limites des séquences, masques, visibilités et textes. Contrôler le résultat avant réexport. Le lecteur GT de diffusion contenu dans les ZIP reste inchangé.\n\nstudio-import-report.json décrit les conversions ; studio-validation-report.json contient les tests d'import et de réexport.\nDocumentation : README.md dans le dépôt GrafBridge.\n`);
    return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const [input, output, studioRoot] = process.argv.slice(2);
    if (!input || !output || !studioRoot) throw new Error('Arguments : <lot OGRAF> <préparation> <sources Studio 0.21 avec dépendances>.');
    await addStudioSources(input, output, studioRoot);
}
