# Editable OGraf Studio sources

This optional adapter requires an external Studio 0.21.0 checkout with its dependencies installed. GrafBridge's converter and desktop UI run independently of Studio.

```powershell
node --import 'D:/OGraf-Studio/node_modules/tsx/dist/loader.mjs' source/add-studio-source.mjs build/converted build/studio 'D:/OGraf-Studio'
```

The adapter verifies Studio version 0.21.0 and adds `.ogs` files without replacing the embedded GT rendering engine. Other Studio versions require separate validation. Editable sources retain Studio's rendering limitations, particularly for Normal, Stretch and TopRight image modes. Review generated warnings before re-exporting.
