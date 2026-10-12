# Sources éditables pour OGraf Studio

Fonction avancée optionnelle : elle nécessite un checkout externe de Studio 0.21.0 avec ses dépendances installées. Le convertisseur et l’interface GrafBridge fonctionnent sans Studio.

```powershell
node --import 'D:/OGraf-Studio/node_modules/tsx/dist/loader.mjs' source/add-studio-source.mjs build/converted 'D:/OGraf-Studio'
```

L’adaptateur vérifie exactement la version 0.21.0 et ajoute les fichiers `.ogs` sans remplacer le moteur de diffusion GT. Son utilisation avec une autre version demande une nouvelle validation. Les sources éditables gardent les limites du moteur Studio, notamment pour les modes Normal, Stretch et TopRight ; consulter les avertissements générés.
