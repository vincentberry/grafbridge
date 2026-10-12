"""Recette de conversion isolée : modes GT et ressources non recadrées."""
import hashlib
import importlib.util
from io import BytesIO
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
import zipfile

from PIL import Image

spec = importlib.util.spec_from_file_location("convert_gt", Path(__file__).with_name("convert-vmix-gt.py"))
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)


class ImageSizeModesTest(unittest.TestCase):
    def test_custom_font_is_embedded_without_parent_project(self):
        font = converter.HERE.parent / 'fonts/Barlow-Regular.ttf'
        (self.root / 'Example-Sans-Regular.ttf').write_bytes(font.read_bytes())
        (self.root / 'Example-Sans-LICENSE.txt').write_text('Test fixture license')
        source = self.title([])
        with zipfile.ZipFile(source, 'a') as archive:
            archive.writestr('custom.xml', '<Composition Width="320" Height="180"><TextBlock Name="LABEL" FontFamily="Example Sans" Text="Bonjour" Dimensions="300,100,0" /></Composition>')
        # Build a fresh ZIP to avoid duplicate document entries.
        with zipfile.ZipFile(source) as archive:
            data = {name: archive.read(name) for name in archive.namelist()}
        data['document.xml'] = data.pop('custom.xml')
        with zipfile.ZipFile(source, 'w') as archive:
            for name, content in data.items():
                archive.writestr(name, content)
        converter.convert(source, self.root / 'output', self.root, None, self.cache, 1)
        with zipfile.ZipFile(self.root / 'output/test.ograf.zip') as archive:
            scene = json.loads(archive.read('scene.json'))
            self.assertEqual(scene['fonts'][0]['family'], 'Example Sans')
            self.assertEqual(archive.read('fonts/Example-Sans-Regular.ttf'), font.read_bytes())
            self.assertIn('fonts/Example-Sans-LICENSE.txt', archive.namelist())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cache = self.root / "cache"
        self.cache.mkdir()

    def title(self, modes, dimensions=' Dimensions="80,80,0"', storyboards='', layer=False):
        bitmap = BytesIO()
        Image.new("RGBA", (120, 60), "red").save(bitmap, "PNG")
        objects = "".join(
            f'<Image Name="IMAGE_{index}"{dimensions}{attribute}><Image.Bitmap><Bitmap Source="image.png" /></Image.Bitmap></Image>'
            for index, attribute in enumerate(modes)
        )
        if layer:
            objects = f'<Layer Name="PARENT"><Layer.Composition><Composition Width="320" Height="180">{objects}</Composition></Layer.Composition></Layer>'
        source = self.root / "TEST.gtzip"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("document.xml", f'<Composition Width="320" Height="180">{objects}{storyboards}</Composition>')
            archive.writestr("resources.xml", '<Resources><Resource filename="image.png"><Item guid="bitmap" /></Resource></Resources>')
            archive.writestr("bitmap", bitmap.getvalue())
            archive.writestr("thumbnail.png", bitmap.getvalue())
        return source

    def test_cli_build_and_import_preserve_source(self):
        source = self.title([''])
        original = source.read_bytes()
        converter.BUILD_ROOT.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="cli-test-", dir=converter.BUILD_ROOT) as directory:
            output = Path(directory) / "converted"
            cache = Path(directory) / "cache"
            result = subprocess.run([sys.executable, str(converter.HERE / "convert-vmix-gt.py"),
                                     str(self.root), str(output), "--fonts", str(self.root),
                                     "--cache", str(cache), "--workers", "1"],
                                    cwd=self.root, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            imported = subprocess.run(["node", str(converter.HERE / "check-final-imports.mjs"),
                                       str(output), str(Path(directory) / "imports")],
                                      cwd=self.root, capture_output=True, text=True)
            self.assertEqual(imported.returncode, 0, imported.stderr)
            self.assertEqual(source.read_bytes(), original)
            self.assertTrue((output / "index.html").is_file())

    def test_cli_rejects_external_output_before_writing(self):
        output = self.root / "outside"
        result = subprocess.run([sys.executable, str(converter.HERE / "convert-vmix-gt.py"),
                                 str(self.root), str(output), "--fonts", str(self.root)],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("subdirectory", result.stderr)
        self.assertFalse(output.exists())

    def rectangle_title(self):
        thumbnail = BytesIO()
        Image.new("RGBA", (32, 18), "white").save(thumbnail, "PNG")
        source = self.root / "RECTANGLES.gtzip"
        document = '''
            <Composition Width="320" Height="180">
                <Rectangle Name="T1_TRIIMG" Dimensions="10,42,0" DataFlags="None">
                    <Rectangle.Fill><Brush Color="#FF123456" /></Rectangle.Fill>
                </Rectangle>
                <Rectangle Name="MASK" Dimensions="10,42,0">
                    <Rectangle.Fill><Brush Color="#FFFFFFFF" /></Rectangle.Fill>
                </Rectangle>
                <Storyboard Type="DataChangeIn" DataName="T1_TRIIMG.Fill.Color">
                    <Storyboard.Animations><Fade Object="T1_TRIIMG" Duration="0.1" /></Storyboard.Animations>
                </Storyboard>
            </Composition>
        '''
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("document.xml", document)
            archive.writestr("resources.xml", "<Resources />")
            archive.writestr("thumbnail.png", thumbnail.getvalue())
        return source

    def test_default_and_explicit_modes(self):
        source = self.title(['', ' SizeMode="Normal"', ' SizeMode="Stretch"', ' SizeMode="Centered"', ' SizeMode="TopRight"'])
        original = hashlib.sha256(source.read_bytes()).digest()
        converter.convert(source, self.root / "output", self.root, None, self.cache, 1)
        with zipfile.ZipFile(self.root / "output/test.ograf.zip") as archive:
            manifest = json.loads(archive.read("test.ograf.json"))
            self.assertEqual(manifest["v_conversion"]["engine"], "grafbridge-gt-svg-1")
            scene = json.loads(archive.read("scene.json"))
            self.assertEqual([node["sizeMode"] for node in scene["nodes"]], ["Centered", "Normal", "Stretch", "Centered", "TopRight"])
            for node in scene["nodes"]:
                self.assertEqual(node["size"], [80, 80])
                self.assertTrue(node["dimensionsExplicit"])
                self.assertEqual(node["imageSize"], [120, 60])
                with Image.open(BytesIO(archive.read(node["frames"][0]))) as image:
                    self.assertEqual(image.size, (120, 60))
            self.assertEqual(archive.read("graphic.mjs"), converter.RUNTIME.read_bytes())
        self.assertEqual(hashlib.sha256(source.read_bytes()).digest(), original)

    def test_missing_dimensions_preserve_100_pixel_zone(self):
        source = self.title([''], dimensions='')
        original = source.read_bytes()
        converter.convert(source, self.root / "output", self.root, None, self.cache, 1)
        with zipfile.ZipFile(self.root / "output/test.ograf.zip") as archive:
            node = json.loads(archive.read("scene.json"))["nodes"][0]
            self.assertEqual(node["size"], [100, 100])
            self.assertEqual(node["imageSize"], [120, 60])
            self.assertFalse(node["dimensionsExplicit"])
        self.assertEqual(source.read_bytes(), original)

    def test_explicit_zero_dimensions_are_preserved(self):
        source = self.title([''], dimensions=' Dimensions="0,0,0"')
        converter.convert(source, self.root / "output", self.root, None, self.cache, 1)
        with zipfile.ZipFile(self.root / "output/test.ograf.zip") as archive:
            node = json.loads(archive.read("scene.json"))["nodes"][0]
            self.assertEqual(node["size"], [0, 0])
            self.assertTrue(node["dimensionsExplicit"])

    def test_unknown_mode_is_rejected(self):
        source = self.title([' SizeMode="Unknown"'])
        with self.assertRaisesRegex(ValueError, "IMAGE_0.*Unknown"):
            converter.convert(source, self.root / "output", self.root, None, self.cache, 1)
        self.assertFalse((self.root / "output/test.ograf.zip").exists())

    def test_explicit_rectangle_data_field_controls_fill_color(self):
        source = self.rectangle_title()
        converter.convert(source, self.root / "output", self.root, None, self.cache, 1)
        with zipfile.ZipFile(self.root / "output/rectangles.ograf.zip") as archive:
            manifest = json.loads(archive.read("rectangles.ograf.json"))
            scene = json.loads(archive.read("scene.json"))
            color = manifest["schema"]["properties"]["T1_TRIIMG"]
            self.assertEqual(color["type"], "string")
            self.assertEqual(color["format"], "color")
            self.assertEqual(color["default"], "#123456FF")
            self.assertRegex("#112233", color["pattern"])
            self.assertRegex("#11223380", color["pattern"])
            self.assertNotIn("MASK", manifest["schema"]["properties"])
            self.assertEqual(scene["defaults"]["T1_TRIIMG"], "#123456FF")
            self.assertEqual(scene["nodes"][0]["colorField"], "T1_TRIIMG")
            self.assertNotIn("colorField", scene["nodes"][1])
            self.assertEqual(scene["boards"][0]["field"], "T1_TRIIMG")


    def test_hidden_parent_is_restored_on_page_and_data_change(self):
        boards = '''
            <Storyboard><Storyboard.Animations><Hidden Object="PARENT" /></Storyboard.Animations></Storyboard>
            <Storyboard Type="Page1"><Storyboard.Animations><ImageSequence Object="IMAGE_0" /></Storyboard.Animations></Storyboard>
            <Storyboard Type="DataChangeIn" DataName="IMAGE_0.Source"><Storyboard.Animations><None Object="IMAGE_0" /></Storyboard.Animations></Storyboard>
            <Storyboard Type="Page2"><Storyboard.Animations><Hidden Object="PARENT" /></Storyboard.Animations></Storyboard>
            <Storyboard Type="Page3"><Storyboard.Animations><Fade Object="PARENT" Duration="0.5" /></Storyboard.Animations></Storyboard>
            <Storyboard Type="Page4"><Storyboard.Animations><None Object="PARENT" /></Storyboard.Animations></Storyboard>
        '''
        source = self.title([''], storyboards=boards, layer=True)
        original = source.read_bytes()
        converter.convert(source, self.root / "output", self.root, None, self.cache, 1)
        with zipfile.ZipFile(self.root / "output/test.ograf.zip") as archive:
            scene = json.loads(archive.read("scene.json"))
            converted = {board["type"]: board for board in scene["boards"]}
            for name in ['Page1', 'DataChangeIn']:
                self.assertEqual([(a["type"], a["object"]) for a in converted[name]["animations"]][-1], ('None', 0))
                self.assertEqual(converted[name]["animations"][-1]["duration"], 0)
            for name, kind in [('TransitionIn', 'Hidden'), ('Page2', 'Hidden'), ('Page3', 'Fade'), ('Page4', 'None')]:
                self.assertEqual([(a["type"], a["object"]) for a in converted[name]["animations"]], [(kind, 0)])
            self.assertEqual(json.loads(archive.read("conversion.json"))["hiddenStoryboardDefaults"]["restored"], 2)
            self.assertEqual(json.loads(archive.read("test.ograf.json"))["stepCount"], 5)
        self.assertEqual(source.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
