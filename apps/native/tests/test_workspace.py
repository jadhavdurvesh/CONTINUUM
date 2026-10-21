import tempfile
import unittest
from pathlib import Path

from continuum.workspace import is_automation_path, WorkspaceError, safe_file_path, should_ignore_path, read_text_file


class WorkspaceSafetyTests(unittest.TestCase):
    def test_normal_relative_path_is_resolved_inside_workspace(self):
        with tempfile.TemporaryDirectory() as folder:
            # Windows may expose TEMP through a path alias; workspace helpers resolve it.
            root = Path(folder).resolve()
            (root / "src").mkdir()
            target = safe_file_path(root, "src/main.py")
            self.assertEqual(target, root / "src" / "main.py")

    def test_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(WorkspaceError):
                safe_file_path(folder, "../outside.txt")

    def test_absolute_path_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(WorkspaceError):
                safe_file_path(folder, str(Path(folder).parent / "outside.txt"))

    def test_credentials_are_never_opened_in_editor(self):
        with tempfile.TemporaryDirectory() as folder:
            for path in (".env", ".env.local", "secrets.pem", ".ssh/id_rsa", ".git/config", "node_modules/pkg/index.js"):
                with self.assertRaises(WorkspaceError):
                    safe_file_path(folder, path)

    def test_symlink_cannot_escape_workspace(self):
        with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryDirectory() as outside:
            root = Path(folder)
            (root / "escape").symlink_to(Path(outside), target_is_directory=True)
            with self.assertRaises(WorkspaceError):
                safe_file_path(root, "escape/secret.txt")

    def test_noise_directories_are_hidden(self):
        self.assertTrue(should_ignore_path(".git/config"))
        self.assertTrue(should_ignore_path("node_modules/leftpad/index.js"))
        self.assertFalse(should_ignore_path("src/main.py"))

    def test_text_reader_rejects_binary(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "image.bin"
            target.write_bytes(b"\x00\x01")
            with self.assertRaises(WorkspaceError):
                read_text_file(target)



class AutomationPathTests(unittest.TestCase):
    def test_ci_hook_and_editor_task_paths_are_flagged(self):
        for path in (".github/workflows/ci.yml", ".husky/pre-commit", ".vscode/tasks.json", "pkg/.githooks/x", ".gitmodules"):
            self.assertTrue(is_automation_path(path), path)
        self.assertFalse(is_automation_path("docs/github.md"))
        self.assertFalse(is_automation_path("src/main.py"))


if __name__ == "__main__":
    unittest.main()
