// Contrôle autonome des ZIP et de toutes leurs ressources.
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildPath } from './build-paths.cjs';
try {
    const [source, output] = process.argv.slice(2);
    if (!source || source === '--help') {
        console.log('Usage : node source/check-final-imports.mjs <lot OGRAF> [résultats sous build/]');
        if (!source) process.exitCode = 1;
    } else {
        const destination = buildPath(output, 'validation/packages');
        const bytes = execFileSync(process.env.PYTHON || 'python',
            [fileURLToPath(new URL('./verify-packages.py', import.meta.url)), path.resolve(source)], { encoding: 'utf8' });
        const results = JSON.parse(bytes);
        await fs.mkdir(destination, { recursive: true });
        await fs.writeFile(path.join(destination, 'final-imports.json'), bytes);
        console.log(`${results.length} archives vérifiées : empreintes et ressources identiques.`);
    }
} catch (error) { console.error(error.stderr?.toString() || error.message); process.exitCode = 1; }
