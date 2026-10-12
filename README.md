<p align="center"><img src="web/logo.svg" width="80" alt="GrafBridge"></p>
<h1 align="center">GrafBridge</h1>
<p align="center">Du titre à l’écran, en toute liberté.<br>Application Electron de conversion vMix GT → EBU OGraf.</p>

GrafBridge transforme les titres `.gtzip` en packages `.ograf.zip` autonomes. Une fenêtre desktop permet d’importer les titres, choisir les polices, convertir les animations, consulter les avertissements et tester le résultat. Les fichiers originaux sont lus sans modification. Le moteur de conversion et les ressources sont locaux ; aucun compte ni service cloud n’est requis.

## Installer

Les releases Windows fournissent un **installateur** et un **exécutable portable**, avec le moteur Python embarqué. Il n’est pas nécessaire d’installer Python ou Node.js pour les utiliser. Les exécutables ne sont pas signés.

Ouvrir GrafBridge, déposer des fichiers `.gtzip` ou cliquer sur **Choisir** pour sélectionner un dossier. Choisir un titre ou tout le lot, puis lancer la conversion. **Ouvrir les aperçus** affiche la galerie dans une fenêtre de l’application : commandes In / Next / Out, données JSON modifiables et téléchargement des ZIP.

Les conversions sont conservées dans le dossier de données de GrafBridge (`%APPDATA%/GrafBridge/build/` pour la distribution Windows). Chaque lot reçoit son propre dossier ; les conversions terminées sont retrouvées au redémarrage. L’application ne remplace pas les titres d’origine.

## Polices et formats

**Barlow** est fournie avec sa licence OFL. Pour une autre famille, fournir `Famille-Regular.ttf` et éventuellement `Famille-Bold.ttf` (ou `.otf`) dans le dossier des polices. Remplacer les espaces de la famille par des tirets dans le nom de fichier, par exemple `Example-Sans-Regular.ttf` pour « Example Sans ». Ajouter `Famille-LICENSE.txt` si disponible. Les droits sur les ressources originales doivent être conservés pour toute redistribution.

Nœuds pris en charge : Layer, Image, TextBlock, Rectangle. Animations : Fade, Hidden, None, ImageSequence, Reveal, Fly. Modes d’image : Normal, Stretch, Centered, TopRight. Les types et effets inconnus sont refusés explicitement. Les projets After Effects `.mogrt` ne sont pas convertis. Les adaptations de rendu sont décrites dans le `conversion.json` du package.

Les transferts acceptent 256 Mio par titre. Le profil de sortie limite chaque package à 32 Mio compressés, 128 Mio décompressés et 512 ressources. La galerie sert à vérifier le rendu ; elle ne mesure pas la cadence finale d’une sortie vidéo.

Un titre de démonstration original est fourni dans `examples/GrafBridge.gtzip`.

## Développer

Prérequis : Python 3.11 ou plus récent et Node.js 24.

```powershell
python -m venv .venv
& .venv/Scripts/python.exe -m pip install -r requirements.txt
npm ci
npm start
```

Sous Windows, `start.bat` prépare les dépendances et lance Electron. Sur Linux et macOS, remplacer le chemin Python par `.venv/bin/python`. Les distributions automatiques ciblent actuellement Windows x64 ; le lancement depuis les sources reste possible sur les autres systèmes.

Electron lance le moteur local sur un port aléatoire, conserve les résultats dans son dossier de données et arrête le moteur à la fermeture. Les sélecteurs de dossiers sont natifs ; les aperçus s’ouvrent dans une fenêtre isolée, sans accès Node.js. `npm run start:web` permet aussi de tester l’interface dans un navigateur pendant le développement.

```powershell
& .venv/Scripts/python.exe source/test-convert-vmix-gt.py
& .venv/Scripts/python.exe source/test-app.py
node --test source/build-paths.test.cjs
```

La CI exécute ces tests sur Windows et Linux. Les tests de jonctions sont ignorés si le volume Windows ne les prend pas en charge.

## Construire et publier une release

```powershell
& .venv/Scripts/python.exe -m pip install -r requirements-build.txt
& .venv/Scripts/python.exe scripts/build-backend.py
npm run dist:win
```

Les exécutables sont produits dans `build/releases/`. Le workflow **Release desktop** teste le code, embarque Python et Pillow, construit l’installateur et la version portable, teste le démarrage de l’application et calcule leurs empreintes SHA-256. Un lancement manuel produit les artefacts sans publication.

Pour publier : mettre à jour la version de `package.json` et du lockfile, committer, puis pousser un tag correspondant (par exemple `v0.1.0` pour `0.1.0`). Le workflow vérifie la concordance du tag et de la version avant de publier les exécutables dans GitHub Releases.

```sh
git tag v0.1.0
git push origin v0.1.0
```

## Outils avancés

```powershell
& .venv/Scripts/python.exe source/convert-vmix-gt.py 'D:/Titres' build/converted --fonts 'D:/Polices'
& .venv/Scripts/python.exe source/verify-packages.py build/converted
```

Les sorties et le cache CLI doivent être des sous-dossiers distincts de `build/`, hors du dossier source. `--title TITRE.gtzip` convertit un seul titre. `--workers` accepte 1 à 16. Le vérificateur contrôle les empreintes ZIP et toutes les ressources sans exécuter les graphismes.

Le contrôle officiel des schémas EBU nécessite Internet et les dépendances optionnelles :

```sh
npm ci --prefix schema-validation --ignore-scripts
node source/validate-manifests.cjs build/converted
```

L’adaptateur [OGraf Studio](docs/studio.md) ajoute des sources éditables pour un checkout externe de Studio 0.21.0. Il n’est pas requis par GrafBridge.
