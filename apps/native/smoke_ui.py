"""Quick offscreen smoke test for the native Qt workbench (Windows packaging CI)."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Qt
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
    assert not window.cloud_panel.isHidden(), "Cloud panel must be available on first launch"
    assert window.terminal_dock is not None and window.terminal_process is not None
    assert hasattr(window, "quick_open_action")
    assert hasattr(window, "command_palette_action")
    assert hasattr(window, "search_workspace_action")
    assert hasattr(window, "replace_action")
    assert window.theme in {"dark", "light"}

    with tempfile.TemporaryDirectory(prefix="continuum-ui-smoke-") as tmp:
        # Resolve Windows TEMP's possible 8.3 path alias before constructing paths.
        root = Path(tmp).resolve()
        sample = root / "src" / "main.py"
        sample.parent.mkdir(parents=True)
        sample.write_text("def hello():\n    return 'CONTINUUM'\n", encoding="utf-8")

        window.set_workspace(root)
        window.explorer_filter.setText("main.py")
        items = window.workspace_tree.findItems(
            "main.py", Qt.MatchFlag.MatchExactly | Qt.MatchFlag.MatchRecursive, 0
        )
        assert items and not items[0].isHidden(), "Explorer filename filtering should retain matching files"
        window.explorer_filter.clear()
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
        window.toggle_terminal()
        assert not window.terminal_dock.isHidden(), "Terminal action should show its dock"
        window.toggle_terminal()
        assert window.terminal_dock.isHidden(), "Terminal action should hide its dock"

        window.terminal_input.setText("echo CONTINUUM_TERMINAL_SMOKE")
        window.run_terminal_command()
        assert window.terminal_process.waitForFinished(10000), "Terminal smoke command timed out"
        window.read_terminal_output()
        app.processEvents()
        assert "CONTINUUM_TERMINAL_SMOKE" in window.terminal_output.toPlainText(), "Terminal should show command output"

        window.dirty.clear()
        editor.document().setModified(False)
        window.close()

    print("Native Qt workbench smoke test passed.")


if __name__ == "__main__":
    main()
