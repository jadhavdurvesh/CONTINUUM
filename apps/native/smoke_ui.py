"""Quick offscreen smoke test for the native Qt workbench (Windows packaging CI)."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from main import CodeEditor, ContinuumWindow


def main() -> None:
    app = QApplication.instance() or QApplication([])
    app.setApplicationName("CONTINUUM Smoke Test")
    app.setOrganizationName("DMJ")

    window = ContinuumWindow()
    assert window.windowTitle().startswith("CONTINUUM")
    assert window.editor_tabs.count() >= 1
    assert window.explorer_panel is not None
    assert window.cloud_panel is not None
    assert window.theme in {"dark", "light"}

    with tempfile.TemporaryDirectory(prefix="continuum-ui-smoke-") as tmp:
        # Resolve Windows TEMP's possible 8.3 path alias before constructing paths.
        root = Path(tmp).resolve()
        sample = root / "src" / "main.py"
        sample.parent.mkdir(parents=True)
        sample.write_text("def hello():\n    return 'CONTINUUM'\n", encoding="utf-8")

        window.set_workspace(root)
        window.open_file(sample)
        path, editor = window.current_editor()
        assert path == str(sample.resolve())
        assert isinstance(editor, CodeEditor)
        assert "def hello" in editor.toPlainText()

        window.apply_theme("light")
        assert editor.theme == "light"
        assert editor.highlighter.theme == "light"
        assert path not in window.dirty, "Theme switch must not dirty source files"
        assert not editor.document().isModified(), "Theme switch must preserve the saved document state"
        window.toggle_theme()
        assert editor.theme == "dark"
        assert editor.highlighter.theme == "dark"
        assert path not in window.dirty, "Switching back must not dirty source files"
        assert not editor.document().isModified(), "Theme switch must preserve the saved document state"

        window.toggle_explorer(False)
        assert window.explorer_panel.isHidden()
        window.toggle_explorer(True)
        assert not window.explorer_panel.isHidden()

        window.toggle_cloud_panel(False)
        assert window.cloud_panel.isHidden()
        window.toggle_cloud_panel(True)
        assert not window.cloud_panel.isHidden()

        window.dirty.clear()
        editor.document().setModified(False)
        window.close()

    print("Native Qt workbench smoke test passed.")


if __name__ == "__main__":
    main()
