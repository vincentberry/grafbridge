/* Lecteur SVG des scènes GT converties : préchargement local et décodage anticipé. */
const NS = 'http://www.w3.org/2000/svg';
const url = file => new URL(file, import.meta.url).href;
const clamp = value => Math.max(0, Math.min(1, value));
const ok = () => ({ statusCode: 200 });
const attributes = new WeakMap();
const DECODED_BUDGET = 128 * 1024 * 1024;
const attr = (node, key, value) => {
    const text = String(value);
    if (!attributes.has(node)) attributes.set(node, new Map());
    const previous = attributes.get(node);
    if (previous.get(key) !== text) { node.setAttribute(key, text); previous.set(key, text); }
};
const color = value => /^#[0-9a-f]{8}$/i.test(value) ? `#${value.slice(3)}${value.slice(1, 3)}` : value;
const dataColor = value => typeof value === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value.trim()) ? value.trim() : null;
const ease = (value, type) => type === 'CubicEasingIn' ? value ** 3 : type === 'CubicEasingOut' ? 1 - (1 - value) ** 3 : value;
const imageUrl = file => {
    const resolved = new URL(file, import.meta.url);
    if (!['http:', 'https:', 'data:', 'blob:'].includes(resolved.protocol) || (resolved.protocol === 'data:' && !file.startsWith('data:image/'))) throw new Error(`Invalid image source : ${file}`);
    return resolved.href;
};

export default class ConvertedGtGraphic extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this.loadedFonts = [];
        this.activeStep = -1;
        this.cancelAnimation = null;
        this.closed = false;
        this.idPrefix = `gt-${Math.random().toString(36).slice(2)}-`;
        this.assetUrls = new Map();
        this.decodedFrames = new Map();
        this.pendingFrames = new Map();
        this.decodeQueue = [];
        this.decodeWorkers = 0;
        this.decodedBytes = 0;
        this.externalSequences = new Map();
        this.imageSizes = new Map();
        this.liveTextRevision = 0;
        this.liveTextVersions = new Map();
    }

    make(tag, attrs = {}) {
        const node = this.ownerDocument.createElementNS(NS, tag);
        for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
        return node;
    }

    async load({ data = {}, renderCharacteristics = {} } = {}) {
        const response = await fetch(url('scene.json'));
        if (!response.ok) throw new Error('OGraf scene not found.');
        this.scene = await response.json();
        this.values = { ...this.scene.defaults, ...data };
        this.frameRate = Math.max(50, Math.min(120, renderCharacteristics.frameRate || 50));
        this.sequenceNodes = new Set(this.scene.boards.flatMap(board => board.animations).filter(animation => animation.type === 'ImageSequence').map(animation => animation.object));
        this.imageFields = new Set(this.scene.nodes.filter(node => node.type === 'Image' && node.field).map(node => node.field));
        const changeBoards = this.scene.boards.filter(board => board.type.startsWith('DataChange'));
        const animatedFields = new Set(changeBoards.map(board => board.field));
        const animatedNodes = new Set(changeBoards.flatMap(board => board.animations.map(animation => animation.object)));
        this.liveTextNodes = new Map();
        this.liveColorNodes = new Map();
        const canUpdateLive = (field, index) => {
            if (!field || animatedFields.has(field)) return false;
            for (let ancestor = index; ancestor !== null && ancestor !== undefined; ancestor = this.scene.nodes[ancestor].parent) {
                if (animatedNodes.has(ancestor)) return false;
            }
            return true;
        };
        this.scene.nodes.forEach((node, index) => {
            if (node.type === 'TextBlock' && canUpdateLive(node.field, index)) {
                if (!this.liveTextNodes.has(node.field)) this.liveTextNodes.set(node.field, []);
                this.liveTextNodes.get(node.field).push(index);
            }
            if (node.colorField && canUpdateLive(node.colorField, index)) {
                if (!this.liveColorNodes.has(node.colorField)) this.liveColorNodes.set(node.colorField, []);
                this.liveColorNodes.get(node.colorField).push(index);
            }
        });
        await Promise.all(this.scene.fonts.map(async font => {
            const face = new FontFace(font.family, `url("${url(font.file)}")`, { weight: String(font.weight) });
            await face.load();
            this.ownerDocument.fonts.add(face);
            this.loadedFonts.push(face);
        }));
        const style = this.ownerDocument.createElement('style');
        style.textContent = ':host{display:block;width:100%;height:100%;overflow:hidden;background:transparent}svg{display:block;width:100%;height:100%;overflow:hidden}';
        this.svg = this.make('svg', { viewBox: `0 0 ${this.scene.width} ${this.scene.height}`, 'aria-label': this.scene.name });
        this.defs = this.make('defs');
        this.svg.append(this.defs);
        this.shadowRoot.replaceChildren(style, this.svg);
        this.measure = this.ownerDocument.createElement('canvas').getContext('2d');
        this.byName = new Map(this.scene.nodes.map((node, index) => [node.name, index]));
        this.states = this.scene.nodes.map(() => ({ opacity: 1, dx: 0, dy: 0, reveal: null, frame: null }));
        this.views = this.scene.nodes.map((node, index) => node.type === 'Layer' ? null : this.createView(node, index));
        const maskNames = new Set(this.scene.nodes.map(n => n.mask).filter(Boolean));
        this.masks = new Map();
        for (const name of maskNames) {
            const index = this.byName.get(name);
            if (index === undefined) throw new Error(`Missing mask : ${name}`);
            const mask = this.make('mask', { id: this.idPrefix + 'mask-' + index, maskUnits: 'userSpaceOnUse', x: 0, y: 0,
                width: this.scene.width, height: this.scene.height, style: 'mask-type:alpha' });
            this.defs.append(mask);
            this.masks.set(index, this.createView(this.scene.nodes[index], index, mask));
        }
        this.svg.style.visibility = 'hidden';
        // Une URL blob stable par fichier évite tout accès réseau pendant les
        // animations, même lorsqu'une source navigateur désactive son cache HTTP.
        this.externalSequences = await this.prepareImages(this.values);
        await Promise.all(this.scene.nodes.map(node => this.decodeFrame(this.frameAt(node, node.positionInSequence))));
        this.render();
        this.dataset.loaded = 'true';
        return ok();
    }

    async cacheAssets(files) {
        const pending = [...new Set(files)].filter(file => !this.assetUrls.has(file));
        await Promise.all(Array.from({ length: Math.min(6, pending.length) }, async () => {
            while (pending.length && !this.closed) {
                const asset = pending.pop();
                const result = await fetch(url(asset));
                if (!result.ok) throw new Error(`Missing OGraf resource : ${asset}`);
                const blob = await result.blob();
                if (!this.closed) this.assetUrls.set(asset, URL.createObjectURL(blob));
            }
        }));
    }

    async prepareImages(data) {
        const sources = [...new Set([...this.sequenceNodes].map(index => data[this.scene.nodes[index].field]).filter(value => typeof value === 'string' && value.startsWith(location.origin + '/media/')))];
        const sequences = new Map();
        await Promise.all(sources.map(async source => {
            let frames = this.externalSequences.get(source);
            if (!frames) {
                const response = await fetch(source + '/sequence.json');
                if (response.status === 404) frames = [source]; // Lecteur autonome sans extension locale.
                else {
                    if (!response.ok) throw new Error('Local image sequence unavailable.');
                    ({ frames } = await response.json());
                    if (!Array.isArray(frames) || !frames.length || frames.length > 1000 || frames.some(frame => typeof frame !== 'string' || !frame.startsWith(location.origin + '/media/'))) throw new Error('Invalid local image sequence.');
                }
            }
            sequences.set(source, frames);
        }));
        // Les blobs sont chargés avant de changer les données affichées. La lecture
        // ne dépend alors plus d'une requête HTTP pour chaque image.
        // Une variable image remplace les images embarquées de ce nœud. Préparer
        // celles-ci seulement si elles seront effectivement utilisées ; un update
        // rétablissant la valeur vide les préparera avant de changer l'affichage.
        const embedded = this.scene.nodes.flatMap(node => typeof data[node.field] === 'string' && data[node.field] ? [] : node.frames || []);
        await this.cacheAssets([...embedded, ...[...sequences.values()].flat()]);
        await Promise.all(this.scene.nodes.flatMap((node, index) => node.type !== 'Image' ? [] : [
            this.decodeFrame(this.framesFor(node, data, sequences)[0]),
            this.decodeFrame(this.frameAt(node, this.states[index].frame ?? node.positionInSequence, data, sequences)),
        ]));
        return sequences;
    }

    framesFor(node, values = this.values, sequences = this.externalSequences) {
        if (node.type !== 'Image') return [];
        const value = node.field && values[node.field];
        return typeof value === 'string' && value ? sequences.get(value) || [value] : node.frames || [];
    }

    frameAt(node, position = 0, values = this.values, sequences = this.externalSequences) {
        const frames = this.framesFor(node, values, sequences);
        return frames[Math.round(clamp(position ?? 0) * Math.max(0, frames.length - 1))];
    }

    decodeFrame(file) {
        if (!file || this.closed) return Promise.resolve();
        const source = imageUrl(this.assetUrls.get(file) || file);
        if (this.decodedFrames.has(file)) {
            const image = this.decodedFrames.get(file);
            this.decodedFrames.delete(file); this.decodedFrames.set(file, image);
            return Promise.resolve();
        }
        if (this.pendingFrames.has(file)) return this.pendingFrames.get(file);
        const promise = new Promise((resolve, reject) => this.decodeQueue.push({ file, source, resolve, reject }));
        this.pendingFrames.set(file, promise);
        this.drainDecodes();
        return promise;
    }

    drainDecodes() {
        while (!this.closed && this.decodeWorkers < 3 && this.decodeQueue.length) {
            const { file, source, resolve, reject } = this.decodeQueue.shift();
            this.decodeWorkers++;
            const image = new Image(); image.src = source;
            image.decode().then(() => {
                if (this.closed) { image.src = ''; resolve(); return; }
                this.decodedFrames.set(file, image);
                this.imageSizes.set(file, [image.naturalWidth, image.naturalHeight]);
                this.decodedBytes += image.naturalWidth * image.naturalHeight * 4;
                // Fenêtre glissante : les longues séquences HD n'occupent pas
                // plusieurs gigaoctets de bitmaps lorsqu'elles sont préparées.
                while (this.decodedBytes > DECODED_BUDGET && this.decodedFrames.size > 1) {
                    const [oldFile, oldImage] = this.decodedFrames.entries().next().value;
                    this.decodedBytes -= oldImage.naturalWidth * oldImage.naturalHeight * 4;
                    this.decodedFrames.delete(oldFile); oldImage.src = '';
                }
                resolve();
            }, reject).finally(() => { this.pendingFrames.delete(file); this.decodeWorkers--; this.drainDecodes(); });
        }
    }

    primeFrames(animations, seconds, out) {
        const sequences = animations.filter(animation => animation.type === 'ImageSequence');
        const bytesPerFrame = sequences.reduce((total, animation) => {
            const node = this.scene.nodes[animation.object];
            const [width, height] = this.imageSizes.get(this.framesFor(node)[0]) || node.imageSize || node.size;
            return total + width * height * 4;
        }, 0);
        const ahead = Number.isFinite(seconds) ? Math.max(2, Math.min(12, Math.floor(DECODED_BUDGET / 2 / Math.max(1, bytesPerFrame)))) : 0;
        const files = new Set();
        for (const animation of sequences) {
            const node = this.scene.nodes[animation.object];
            for (let offset = 0; offset <= ahead; offset++) {
                const when = seconds + offset / this.frameRate;
                const progress = ease(animation.duration > 0 ? clamp((when - animation.delay) / animation.duration) : Number(when >= animation.delay), animation.easing);
                files.add(this.frameAt(node, out !== animation.reverse ? 1 - progress : progress));
            }
        }
        return Promise.all([...files].map(file => this.decodeFrame(file)));
    }

    createView(node, index, mask = null) {
        const prefix = this.idPrefix + (mask ? 'mask-view-' : 'view-') + index;
        const outer = this.make('g', { 'data-name': node.name });
        const clip = this.make('clipPath', { id: prefix + '-clip', clipPathUnits: 'userSpaceOnUse' });
        const clipRect = this.make('rect');
        clip.append(clipRect);
        this.defs.append(clip);
        const cropped = this.make('g', { 'clip-path': `url(#${prefix}-clip)` });
        const placed = this.make('g');
        cropped.append(placed);
        outer.append(cropped);
        if (node.mask) outer.setAttribute('mask', `url(#${this.idPrefix}mask-${this.byName.get(node.mask)})`);
        let content;
        if (node.type === 'Image') {
            content = this.make('image');
        } else if (node.type === 'Rectangle' || node.type === 'Layer') {
            content = this.make('rect', { width: node.size[0], height: node.size[1], fill: mask ? '#fff' : this.fillFor(node) });
        } else content = this.make('text', { fill: this.fillFor(node), style: 'white-space:pre' });
        placed.append(content);
        let text;
        if (node.textField) {
            text = this.make('text', { fill: '#fff', style: 'white-space:pre' });
            placed.append(text);
        }
        (mask || this.svg).append(outer);
        return { outer, placed, content, text, clipRect, mask: !!mask, lastText: null };
    }

    fillFor(node) {
        return dataColor(node.colorField && this.values?.[node.colorField]) || color(node.fill);
    }

    sizeFor(node) {
        // Compatibilité des anciennes scènes : Dimensions absent avait été
        // converti en [0, 0], alors que la zone GT vaut 100 x 100. Une taille
        // zéro explicitement déclarée dans une nouvelle scène reste respectée.
        if (node.type === 'Image' && node.size[0] === 0 && node.size[1] === 0 && node.dimensionsExplicit !== true) {
            return [100, 100];
        }
        return node.size;
    }

    geometry(index, ignoreOpacity = false) {
        const cache = this.geometryCache[ignoreOpacity ? 1 : 0];
        if (cache.has(index)) return cache.get(index);
        const node = this.scene.nodes[index], state = this.states[index];
        const parent = node.parent === null ? { x: 0, y: 0, opacity: 1, clip: [0, 0, this.scene.width, this.scene.height] } : this.geometry(node.parent, ignoreOpacity);
        const x = parent.x + node.position[0] + state.dx, y = parent.y + node.position[1] + state.dy;
        const visible = node.visibilityField ? this.values[node.visibilityField] !== false : node.visible;
        const opacity = parent.opacity * state.opacity * (ignoreOpacity ? 1 : node.opacity * (visible ? 1 : 0));
        let clip = [...parent.clip];
        const intersect = (left, top, width, height) => {
            const right = Math.min(clip[0] + clip[2], left + width), bottom = Math.min(clip[1] + clip[3], top + height);
            clip[0] = Math.max(clip[0], left); clip[1] = Math.max(clip[1], top);
            clip[2] = Math.max(0, right - clip[0]); clip[3] = Math.max(0, bottom - clip[1]);
        };
        const [width, height] = this.sizeFor(node);
        if (node.type === 'TextBlock' || node.type === 'Image') intersect(x, y, width, height);
        if (node.crop) intersect(x + node.crop[0] * width, y + node.crop[1] * height, node.crop[2] * width, node.crop[3] * height);
        if (state.reveal) {
            const { amount, direction, axis } = state.reveal, [w, h] = [width, height];
            if (direction === 'Bottom') intersect(x, y + h * (1 - amount), w, h * amount);
            else if (direction === 'Top') intersect(x, y, w, h * amount);
            else if (direction === 'Right') intersect(x + w * (1 - amount), y, w * amount, h);
            else if (direction === 'Center') intersect(x + w * (1 - amount) / 2, y + (axis === 'X' ? 0 : h * (1 - amount) / 2), w * amount, axis === 'X' ? h : h * amount);
            else intersect(x, y, w * amount, h);
        }
        const result = { x, y, opacity, clip }; cache.set(index, result); return result;
    }

    imageLayout(view, node, source) {
        const native = node.sizeMode === 'Normal' || node.sizeMode === 'TopRight';
        const size = this.sizeFor(node);
        // Une image de remplacement a ses propres dimensions ; les dimensions
        // du bitmap GT ne servent de repli que pour une ressource embarquée.
        const [width, height] = native ? this.imageSizes.get(source) || (node.frames?.includes(source) && node.imageSize) || size : size;
        attr(view.content, 'x', node.sizeMode === 'TopRight' ? size[0] - width : 0);
        attr(view.content, 'y', 0);
        attr(view.content, 'width', width);
        attr(view.content, 'height', height);
        // Fit reste l'alias Centered des archives générées avant ce correctif.
        attr(view.content, 'preserveAspectRatio', native || node.sizeMode === 'Stretch' ? 'none' : 'xMidYMid meet');
    }

    textLayout(view, node, value, fallback = false) {
        const string = String(value ?? '');
        if (view.lastText === string) return;
        view.lastText = string;
        const target = fallback ? view.text : view.content;
        const family = fallback ? 'Barlow' : node.font;
        const weight = fallback || ['Bold', 'ExtraBold'].includes(node.weight) ? 700 : 400;
        const align = fallback ? node.textAlign : node.align;
        const [width, height] = node.size;
        let size = fallback ? node.textSize : node.fontSize;
        const content = fallback || node.uppercase ? string.toLocaleUpperCase('fr-FR') : string;
        const wrap = !fallback && node.wrap;
        const linesAt = () => {
            this.measure.font = `${weight} ${size}px "${family}"`;
            const output = [];
            for (const paragraph of content.split(/\r?\n/)) {
                if (!wrap) { output.push(paragraph); continue; }
                let line = '';
                for (const word of paragraph.match(/\S+|\s+/g) || []) {
                    if (line && this.measure.measureText(line + word).width > width) { output.push(line.trimEnd()); line = ''; }
                    if (!line && !word.trim()) continue;
                    // GT coupe aussi les mots sans espaces dépassant la largeur.
                    for (const character of word) {
                        if (line && this.measure.measureText(line + character).width > width) { output.push(line); line = ''; }
                        line += character;
                    }
                }
                output.push(line);
            }
            return output;
        };
        let lines = linesAt();
        const spacing = fallback ? 1.15 : node.lineSpacing;
        if (fallback || node.shrink) {
            for (let attempt = 0; attempt < 4; attempt++) {
                const max = Math.max(...lines.map(line => this.measure.measureText(line).width), 1);
                const ratio = Math.min(1, width / max, height / (lines.length * size * spacing));
                if (ratio > 0.995) break;
                size *= ratio;
                lines = linesAt();
            }
        }
        attr(target, 'font-family', family); attr(target, 'font-size', size); attr(target, 'font-weight', weight);
        attr(target, 'text-anchor', align === 'Center' ? 'middle' : align === 'Right' ? 'end' : 'start');
        attr(target, 'dominant-baseline', 'central');
        const x = align === 'Center' ? width / 2 : align === 'Right' ? width : 0;
        const lineHeight = size * spacing;
        const top = fallback || node.vertical === 'Center' ? (height - (lines.length - 1) * lineHeight) / 2 : lineHeight / 2;
        target.replaceChildren(...lines.map((line, index) => {
            const span = this.make('tspan', { x, y: top + index * lineHeight });
            span.textContent = line;
            return span;
        }));
    }

    renderView(view, node, index) {
        if (!view) return;
        const g = this.geometry(index, view.mask);
        attr(view.outer, 'opacity', g.opacity);
        attr(view.placed, 'transform', `translate(${g.x} ${g.y})`);
        for (const [i, key] of ['x', 'y', 'width', 'height'].entries()) attr(view.clipRect, key, g.clip[i]);
        if (!view.mask && node.colorField) attr(view.content, 'fill', this.fillFor(node));
        if (node.type === 'Image') {
            const fallback = node.textField && String(this.values[node.textField] ?? '');
            attr(view.content, 'visibility', fallback ? 'hidden' : 'visible');
            if (view.text) {
                attr(view.text, 'visibility', fallback ? 'visible' : 'hidden');
                this.textLayout(view, node, fallback || '', true);
            }
            const position = this.states[index].frame ?? node.positionInSequence;
            const frame = this.frameAt(node, position);
            const source = frame;
            this.imageLayout(view, node, source);
            if (source) {
                // Jamais de chemin Windows ni d'URL exécutable dans un href.
                attr(view.content, 'href', imageUrl(this.assetUrls.get(source) || source));
            } else { view.content.removeAttribute('href'); attributes.get(view.content)?.delete('href'); }
        } else if (node.type === 'TextBlock') this.textLayout(view, node, node.field ? this.values[node.field] : node.text);
    }

    render() {
        this.geometryCache = [new Map(), new Map()];
        this.scene.nodes.forEach((node, index) => {
            this.renderView(this.views[index], node, index);
            this.renderView(this.masks.get(index), node, index);
        });
    }

    async releaseUnusedAssets() {
        await Promise.all([...this.pendingFrames.values()].map(promise => promise.catch(() => {})));
        const used = new Set([...this.scene.nodes.flatMap(node => [...(node.frames || []), ...this.framesFor(node)]), ...[...this.externalSequences.values()].flat()]);
        for (const file of new Set([...this.assetUrls.keys(), ...this.imageSizes.keys()])) {
            if (used.has(file)) continue;
            const image = this.decodedFrames.get(file);
            if (image) { this.decodedBytes -= image.naturalWidth * image.naturalHeight * 4; image.src = ''; this.decodedFrames.delete(file); }
            const asset = this.assetUrls.get(file);
            if (asset) URL.revokeObjectURL(asset);
            this.assetUrls.delete(file); this.imageSizes.delete(file);
        }
    }

    apply(animations, seconds, out) {
        // Fade et Fly peuvent viser le même objet : ne pas réinitialiser
        // l'opacité entre deux animations du même storyboard.
        for (const animation of animations) this.states[animation.object].opacity = 1;
        for (const animation of animations) {
            const { type, object, reverse, delay, duration, direction, centerAxis } = animation;
            const state = this.states[object], node = this.scene.nodes[object];
            if (type === 'Hidden') { state.opacity = 0; continue; }
            if (type === 'None') continue;
            const raw = duration > 0 ? clamp((seconds - delay) / duration) : Number(seconds >= delay);
            const progress = ease(raw, animation.easing);
            const amount = (out !== reverse) ? 1 - progress : progress;
            // Une nouvelle animation remplace l'état Hidden du storyboard précédent.
            if (type === 'Fade') state.opacity = amount;
            else if (type === 'ImageSequence') state.frame = amount;
            else if (type === 'Reveal') state.reveal = { amount, direction, axis: centerAxis };
            else if (type === 'Fly') {
                const distance = 1 - amount;
                const [width, height] = this.sizeFor(node);
                state.dx = direction === 'Right' ? width * distance : direction === 'Left' ? -width * distance : 0;
                state.dy = direction === 'Bottom' ? height * distance : direction === 'Top' ? -height * distance : 0;
            }
        }
        this.render();
    }

    async animate(boards, skipAnimation = false, ready = () => {}) {
        this.cancelAnimation?.();
        const animations = boards.flatMap(board => board.animations);
        const out = boards.some(board => board.type.endsWith('Out'));
        const duration = Math.max(0, ...animations.filter(a => !['Hidden', 'None'].includes(a.type)).map(a => a.delay + a.duration));
        if (skipAnimation || !duration || this.closed) { await this.primeFrames(animations, Infinity, out); this.apply(animations, Infinity, out); ready(); return; }
        await this.primeFrames(animations, 0, out);
        this.apply(animations, 0, out);
        ready();
        const start = performance.now();
        await new Promise((resolve, reject) => {
            let frame, timer, finished = false;
            const finish = error => {
                if (finished) return;
                finished = true; cancelAnimationFrame(frame); clearTimeout(timer);
                if (this.cancelAnimation === cancel) this.cancelAnimation = null;
                if (error) reject(error); else resolve();
            };
            const cancel = () => finish();
            this.cancelAnimation = cancel;
            const tick = now => {
                if (finished) return;
                try {
                    const seconds = (now - start) / 1000;
                    this.apply(animations, seconds, out);
                    void this.primeFrames(animations, seconds, out).catch(finish);
                    if (seconds >= duration || this.closed) finish();
                    else frame = requestAnimationFrame(tick);
                } catch (error) { finish(error); }
            };
            // Chromium suspend rAF sur une source masquée. Terminer sa pose
            // libère la file OGraf ; la lecture visible reste cadencée par rAF.
            timer = setTimeout(() => {
                if (finished) return;
                void this.primeFrames(animations, Infinity, out).then(() => {
                    if (finished) return;
                    try { this.apply(animations, Infinity, out); finish(); }
                    catch (error) { finish(error); }
                }, finish);
            }, Math.ceil(duration * 1000) + 50);
            frame = requestAnimationFrame(tick);
        });
    }

    async playAction({ goto, delta = 1, skipAnimation = false } = {}) {
        const max = Math.max(0, ...this.scene.boards.filter(b => /^Page\d+$/.test(b.type)).map(b => Number(b.type.slice(4))));
        // OGraf : goto est prioritaire, sinon delta est relatif à l'étape
        // courante (-1 avant In). Dépasser la dernière étape déclenche Out.
        const step = goto !== undefined ? goto : this.activeStep + delta;
        if ((goto === undefined && !Number.isInteger(delta)) || !Number.isInteger(step) || step < 0) {
            return { statusCode: 400, statusMessage: 'Étape OGraf invalide.', currentStep: this.activeStep < 0 ? undefined : this.activeStep };
        }
        if (step > max) {
            const result = await this.stopAction({ skipAnimation });
            return { ...result, currentStep: undefined };
        }
        const reveal = () => { this.svg.style.visibility = 'visible'; };
        if (step === 0 || this.activeStep < 0 || step <= this.activeStep || skipAnimation) {
            // Ne jamais exposer la pose finale stockée par load() ou Out pendant
            // la préparation de la première image de In (y compris après replay).
            this.svg.style.visibility = 'hidden';
            this.states.forEach(state => Object.assign(state, { opacity: 1, dx: 0, dy: 0, reveal: null, frame: null }));
            await this.animate(this.scene.boards.filter(b => b.type === 'TransitionIn'), step > 0 || skipAnimation, step === 0 ? reveal : undefined);
            for (let page = 1; page <= step; page++) await this.animate(this.scene.boards.filter(b => b.type === `Page${page}`), page !== step || skipAnimation, page === step ? reveal : undefined);
        } else {
            for (let page = this.activeStep + 1; page <= step; page++) await this.animate(this.scene.boards.filter(b => b.type === `Page${page}`), page !== step || skipAnimation);
        }
        this.activeStep = step;
        this.dataset.step = String(step);
        return { statusCode: 200, currentStep: step };
    }

    async updateAction({ data = {}, skipAnimation = false } = {}) {
        const revision = this.liveTextRevision;
        const changed = new Set(Object.keys(data).filter(key => this.values[key] !== data[key]));
        const relevant = type => this.scene.boards.filter(b => b.type === type && (!b.field || changed.has(b.field)));
        const animate = this.activeStep >= 0 && changed.size > 0;
        const imagesChanged = [...changed].some(field => this.imageFields.has(field));
        const sequences = imagesChanged ? await this.prepareImages({ ...this.values, ...data }) : this.externalSequences;
        if (animate) await this.animate(relevant('DataChangeOut'), skipAnimation);
        this.externalSequences = sequences;
        // Un relevé arrivé pendant DataChangeOut reste prioritaire au moment
        // où cette mise à jour, préparée auparavant, est appliquée.
        const update = Object.fromEntries(Object.entries(data).filter(([key]) => (this.liveTextVersions.get(key) || 0) <= revision));
        this.values = { ...this.values, ...update };
        this.render();
        if (animate) await this.animate(relevant('DataChangeIn'), skipAnimation);
        if (imagesChanged) await this.releaseUnusedAssets();
        return ok();
    }

    updateLiveText(data) {
        // Les textes et couleurs sans transition DataChange peuvent suivre le
        // direct pendant In/Out. Ne toucher ni aux images ni à la pose animée.
        const applied = {}, changedText = new Set(), changedColor = new Set();
        for (const [key, value] of Object.entries(data)) {
            const textNodes = this.liveTextNodes.get(key) || [];
            const colorNodes = dataColor(value) ? this.liveColorNodes.get(key) || [] : [];
            if ((textNodes.length && ['string', 'number', 'boolean'].includes(typeof value)) || colorNodes.length) {
                applied[key] = value;
                if (this.values[key] !== value) {
                    this.liveTextVersions.set(key, ++this.liveTextRevision);
                    textNodes.forEach(index => changedText.add(index));
                    colorNodes.forEach(index => changedColor.add(index));
                }
            }
        }
        Object.assign(this.values, applied);
        // Les relevés répétés ne rendent rien ; un texte ou une couleur modifié
        // ne recalcule ni les images ni la géométrie de toute la scène.
        for (const index of changedText) {
            const node = this.scene.nodes[index];
            this.textLayout(this.views[index], node, this.values[node.field]);
            const mask = this.masks.get(index);
            if (mask) this.textLayout(mask, node, this.values[node.field]);
        }
        for (const index of changedColor) {
            const node = this.scene.nodes[index], view = this.views[index];
            if (view) attr(view.content, 'fill', this.fillFor(node));
        }
        return applied;
    }

    async customAction() {
        // Aucun identifiant d'action personnalisée n'est déclaré par ces titres.
        return { statusCode: 404, statusMessage: 'Action personnalisée OGraf inconnue.' };
    }

    async stopAction({ skipAnimation = false } = {}) {
        await this.animate(this.scene.boards.filter(b => b.type === 'TransitionOut'), skipAnimation);
        this.svg.style.visibility = 'hidden';
        this.activeStep = -1;
        this.dataset.step = '-1';
        await Promise.all([...this.pendingFrames.values()].map(promise => promise.catch(() => {})));
        for (const image of this.decodedFrames.values()) image.src = '';
        this.decodedFrames.clear(); this.decodedBytes = 0;
        return ok();
    }

    async dispose() {
        this.closed = true;
        this.cancelAnimation?.();
        this.loadedFonts.forEach(face => this.ownerDocument.fonts.delete(face));
        this.loadedFonts = [];
        for (const entry of this.decodeQueue.splice(0)) entry.resolve();
        for (const image of this.decodedFrames.values()) image.src = '';
        this.decodedFrames.clear(); this.pendingFrames.clear(); this.decodedBytes = 0;
        for (const asset of this.assetUrls.values()) URL.revokeObjectURL(asset);
        this.assetUrls.clear();
        this.externalSequences.clear(); this.imageSizes.clear();
        this.shadowRoot.replaceChildren();
        return ok();
    }
}
