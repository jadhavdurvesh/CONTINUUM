"""CONTINUUM native desktop — local-first IDE with cloud project intelligence."""
from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

from PySide6.QtCore import Qt, QSettings, QTimer, QSize
from PySide6.QtGui import QAction, QFont, QKeySequence, QTextCursor
from PySide6.QtWidgets import (
    QApplication, QComboBox, QDialog, QDialogButtonBox, QFileDialog,
    QFormLayout, QFrame, QHBoxLayout, QLabel, QLineEdit, QListWidget,
    QListWidgetItem, QMainWindow, QMessageBox, QPlainTextEdit, QPushButton,
    QSplitter, QTabWidget, QToolBar, QTreeWidget, QTreeWidgetItem,
    QVBoxLayout, QWidget, QInputDialog, QStatusBar
)

from continuum.cloud import CloudClient, CloudError
from continuum.workspace import (
    MAX_TEXT_BYTES, WorkspaceError, read_text_file, safe_file_path, should_ignore_path
)

APP_VERSION = "0.2.0"
EDITOR_FONT = "Cascadia Code" if sys.platform == "win32" else "DejaVu Sans Mono"


def user_data_dir() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library/Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
    path = base / "CONTINUUM" / "backups"
    path.mkdir(parents=True, exist_ok=True)
    return path


class ContinueDialog(QDialog):
    def __init__(self, parent: QWidget):
        super().__init__(parent)
        self.setWindowTitle("Continue agent session")
        self.setMinimumWidth(450)
        layout = QVBoxLayout(self)
        layout.addWidget(QLabel("Add guidance or acceptance criteria for the next cloud agent step."))
        self.text = QPlainTextEdit()
        self.text.setPlaceholderText("Optional feedback, test results, or next instruction…")
        self.text.setMinimumHeight(110)
        layout.addWidget(self.text)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Cancel | QDialogButtonBox.StandardButton.Ok)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)


class ContinuumWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.settings = QSettings("DMJ", "CONTINUUM")
        self.cloud = CloudClient()
        self.workspace: Path | None = None
        self.open_editors: dict[str, QPlainTextEdit] = {}
        self.dirty: set[str] = set()
        self.cloud_projects: list[dict[str, Any]] = []
        self.sessions: list[dict[str, Any]] = []
        self.messages: list[dict[str, Any]] = []
        self.active_session: dict[str, Any] | None = None
        self._building_tree = False
        self._build_ui()
        restored = self.settings.value("workspace", "", type=str)
        if restored and Path(restored).is_dir():
            self.set_workspace(Path(restored))
        self.statusBar().showMessage("Offline-ready local workspace. Cloud features connect only when requested.")
        if self.cloud.configured:
            QTimer.singleShot(250, self.try_restore_cloud)
        else:
            self.set_cloud_badge("LOCAL MODE", "neutral")
            self.cloud_status.setText("Cloud features are not configured in this build. The local IDE works offline.")

    def _build_ui(self):
        self.setWindowTitle("CONTINUUM — Engineering Workspace")
        self.resize(1450, 900)
        self.setMinimumSize(QSize(1000, 640))
        self.setStyleSheet(STYLE)
        toolbar = QToolBar("Workspace")
        toolbar.setMovable(False)
        toolbar.setIconSize(QSize(16, 16))
        self.addToolBar(toolbar)

        open_action = QAction("Open folder", self)
        open_action.setShortcut(QKeySequence.StandardKey.Open)
        open_action.triggered.connect(self.choose_workspace)
        toolbar.addAction(open_action)
        self.new_action = QAction("New file", self)
        self.new_action.setShortcut(QKeySequence("Ctrl+N"))
        self.new_action.triggered.connect(self.new_file)
        toolbar.addAction(self.new_action)
        self.save_action = QAction("Save", self)
        self.save_action.setShortcut(QKeySequence.StandardKey.Save)
        self.save_action.triggered.connect(self.save_current)
        toolbar.addAction(self.save_action)
        toolbar.addSeparator()
        self.cloud_badge = QLabel(" LOCAL MODE ")
        self.cloud_badge.setObjectName("cloudBadge")
        toolbar.addWidget(self.cloud_badge)
        toolbar.addSeparator()
        self.project_label = QLabel("No folder open")
        toolbar.addWidget(self.project_label)
        toolbar.addSeparator()
        self.cloud_button = QPushButton("Connect Cloud")
        self.cloud_button.clicked.connect(self.connect_cloud)
        toolbar.addWidget(self.cloud_button)

        split = QSplitter(Qt.Orientation.Horizontal)
        split.setChildrenCollapsible(False)
        self.setCentralWidget(split)

        explorer = QWidget()
        explorer.setObjectName("sidePanel")
        explorer_layout = QVBoxLayout(explorer)
        explorer_layout.setContentsMargins(10, 12, 10, 12)
        header = QHBoxLayout()
        header.addWidget(self.section_label("PROJECT FILES"))
        refresh_tree = QPushButton("↻")
        refresh_tree.setToolTip("Refresh file explorer")
        refresh_tree.setFixedWidth(30)
        refresh_tree.clicked.connect(self.refresh_tree)
        header.addWidget(refresh_tree)
        explorer_layout.addLayout(header)
        self.workspace_tree = QTreeWidget()
        self.workspace_tree.setHeaderHidden(True)
        self.workspace_tree.setIndentation(17)
        self.workspace_tree.itemDoubleClicked.connect(self.tree_open_file)
        explorer_layout.addWidget(self.workspace_tree, 1)
        new_file = QPushButton("+  New file")
        new_file.clicked.connect(self.new_file)
        explorer_layout.addWidget(new_file)
        split.addWidget(explorer)

        center = QWidget()
        center_layout = QVBoxLayout(center)
        center_layout.setContentsMargins(8, 10, 8, 8)
        self.editor_tabs = QTabWidget()
        self.editor_tabs.setTabsClosable(True)
        self.editor_tabs.currentChanged.connect(self.update_editor_status)
        self.editor_tabs.tabCloseRequested.connect(self.close_editor_tab)
        self.welcome = QWidget()
        welcome_layout = QVBoxLayout(self.welcome)
        welcome_layout.setContentsMargins(34, 50, 34, 32)
        welcome_layout.addStretch(1)
        mark = QLabel("C")
        mark.setObjectName("welcomeMark")
        mark.setAlignment(Qt.AlignmentFlag.AlignCenter)
        welcome_layout.addWidget(mark, alignment=Qt.AlignmentFlag.AlignCenter)
        welcome_title = QLabel("Build locally. Think together.")
        welcome_title.setObjectName("welcomeTitle")
        welcome_title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        welcome_layout.addWidget(welcome_title)
        welcome_copy = QLabel("Your files stay on this machine. Open a project folder to work offline.\nCloud sign-in, shared project data and AI agents are available when connected.")
        welcome_copy.setObjectName("welcomeCopy")
        welcome_copy.setAlignment(Qt.AlignmentFlag.AlignCenter)
        welcome_copy.setWordWrap(True)
        welcome_layout.addWidget(welcome_copy)
        welcome_layout.addStretch(2)
        self.editor_tabs.addTab(self.welcome, "Welcome")
        center_layout.addWidget(self.editor_tabs, 1)
        self.editor_status = QLabel("No file open")
        self.editor_status.setObjectName("muted")
        center_layout.addWidget(self.editor_status)
        split.addWidget(center)

        right_scroll = QWidget()
        right_scroll.setObjectName("rightPanel")
        right_layout = QVBoxLayout(right_scroll)
        right_layout.setContentsMargins(12, 14, 12, 14)
        right_layout.setSpacing(9)
        right_layout.addWidget(self.section_label("CLOUD WORKSPACE"))

        self.cloud_status = QLabel("Not connected")
        self.cloud_status.setObjectName("muted")
        self.cloud_status.setWordWrap(True)
        right_layout.addWidget(self.cloud_status)
        self.email = QLineEdit()
        self.email.setPlaceholderText("Workspace email")
        self.password = QLineEdit()
        self.password.setPlaceholderText("Password")
        self.password.setEchoMode(QLineEdit.EchoMode.Password)
        self.connect_button = QPushButton("Sign in")
        self.connect_button.setObjectName("primaryButton")
        self.connect_button.clicked.connect(self.connect_cloud)
        self.sign_out_button = QPushButton("Sign out")
        self.sign_out_button.clicked.connect(self.sign_out_cloud)
        auth_row = QHBoxLayout()
        auth_row.addWidget(self.connect_button)
        auth_row.addWidget(self.sign_out_button)
        right_layout.addWidget(self.email)
        right_layout.addWidget(self.password)
        right_layout.addLayout(auth_row)

        right_layout.addWidget(self.section_label("SHARED PROJECT"))
        self.projects_combo = QComboBox()
        self.projects_combo.currentIndexChanged.connect(self.project_changed)
        right_layout.addWidget(self.projects_combo)
        project_row = QHBoxLayout()
        reload_projects = QPushButton("Refresh")
        reload_projects.clicked.connect(self.refresh_projects)
        project_row.addWidget(reload_projects)
        right_layout.addLayout(project_row)

        right_layout.addWidget(self.section_label("CLOUD AGENT SESSIONS"))
        self.session_list = QListWidget()
        self.session_list.setMinimumHeight(110)
        self.session_list.currentItemChanged.connect(self.session_changed)
        right_layout.addWidget(self.session_list, 1)
        self.session_title = QLineEdit()
        self.session_title.setPlaceholderText("Session title")
        self.goal = QPlainTextEdit()
        self.goal.setPlaceholderText("Goal and acceptance criteria…")
        self.goal.setMaximumHeight(100)
        self.role_combo = QComboBox()
        self.role_combo.addItems(["Planner", "Coder", "Reviewer", "QA"])
        self.focus_paths = QLineEdit()
        self.focus_paths.setPlaceholderText("Focus paths (optional, comma separated)")
        right_layout.addWidget(self.session_title)
        right_layout.addWidget(self.role_combo)
        right_layout.addWidget(self.goal)
        right_layout.addWidget(self.focus_paths)
        self.create_session_button = QPushButton("Queue session")
        self.create_session_button.clicked.connect(self.create_agent_session)
        right_layout.addWidget(self.create_session_button)
        self.run_button = QPushButton("Run cloud agent step")
        self.run_button.setObjectName("primaryButton")
        self.run_button.clicked.connect(self.run_agent_step)
        right_layout.addWidget(self.run_button)
        self.apply_button = QPushButton("Review and apply proposal")
        self.apply_button.clicked.connect(self.apply_agent_proposal)
        right_layout.addWidget(self.apply_button)
        self.continue_button = QPushButton("Continue session")
        self.continue_button.clicked.connect(self.continue_agent_session)
        right_layout.addWidget(self.continue_button)
        split.addWidget(right_scroll)
        split.setSizes([260, 780, 350])
        self.setStatusBar(QStatusBar())
        self.statusBar().showMessage("Local files are available without internet. AI is cloud-hosted.")

    @staticmethod
    def section_label(text: str) -> QLabel:
        label = QLabel(text)
        label.setObjectName("sectionLabel")
        return label

    def set_cloud_badge(self, text: str, state: str):
        self.cloud_badge.setText(" " + text + " ")
        self.cloud_badge.setProperty("state", state)
        self.cloud_badge.style().unpolish(self.cloud_badge)
        self.cloud_badge.style().polish(self.cloud_badge)

    def choose_workspace(self):
        folder = QFileDialog.getExistingDirectory(self, "Open project folder", str(self.workspace or Path.home()))
        if folder:
            self.set_workspace(Path(folder))

    def set_workspace(self, folder: Path):
        self.workspace = folder.resolve()
        self.settings.setValue("workspace", str(self.workspace))
        self.project_label.setText(str(self.workspace))
        self.refresh_tree()
        self.statusBar().showMessage("Local project opened: " + str(self.workspace))

    def refresh_tree(self):
        self._building_tree = True
        self.workspace_tree.clear()
        if not self.workspace or not self.workspace.is_dir():
            self._building_tree = False
            return
        self._populate_tree(self.workspace, self.workspace_tree.invisibleRootItem(), 0, [1600])
        self.workspace_tree.expandToDepth(1)
        self._building_tree = False

    def _populate_tree(self, folder: Path, parent: QTreeWidgetItem, depth: int, budget: list[int]):
        if depth > 7 or budget[0] <= 0:
            return
        try:
            items = sorted(folder.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower()))
        except OSError:
            return
        for path in items:
            if budget[0] <= 0:
                break
            rel = path.relative_to(self.workspace)
            if should_ignore_path(rel) or path.name.startswith(".git"):
                continue
            budget[0] -= 1
            try:
                if path.is_symlink():
                    continue
                if path.is_dir():
                    node = QTreeWidgetItem(parent, [path.name])
                    node.setData(0, Qt.ItemDataRole.UserRole, str(path))
                    self._populate_tree(path, node, depth + 1, budget)
                elif path.is_file() and path.stat().st_size <= MAX_TEXT_BYTES:
                    node = QTreeWidgetItem(parent, [path.name + ("  •" if str(path) in self.dirty else "")])
                    node.setData(0, Qt.ItemDataRole.UserRole, str(path))
                    node.setToolTip(0, str(path))
            except OSError:
                continue

    def tree_open_file(self, item: QTreeWidgetItem, _column: int):
        value = item.data(0, Qt.ItemDataRole.UserRole)
        if not value:
            return
        path = Path(value)
        if path.is_dir():
            item.setExpanded(not item.isExpanded())
            return
        self.open_file(path)

    def open_file(self, path: Path):
        try:
            absolute = safe_file_path(self.workspace or path.parent, path.relative_to(self.workspace or path.parent))
            content = read_text_file(absolute)
        except (OSError, ValueError, WorkspaceError) as error:
            QMessageBox.warning(self, "Cannot open file", str(error))
            return
        key = str(absolute)
        if key in self.open_editors:
            self.editor_tabs.setCurrentWidget(self.open_editors[key])
            return
        self._remove_welcome()
        editor = QPlainTextEdit()
        editor.setObjectName("codeEditor")
        editor.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        editor.setFont(QFont(EDITOR_FONT, 10))
        editor.setTabStopDistance(editor.fontMetrics().horizontalAdvance(" ") * 4)
        editor.setPlainText(content)
        editor.document().setModified(False)
        editor.textChanged.connect(lambda path_key=key, widget=editor: self.editor_changed(path_key, widget))
        index = self.editor_tabs.addTab(editor, absolute.name)
        self.editor_tabs.setTabToolTip(index, key)
        self.editor_tabs.setCurrentIndex(index)
        self.open_editors[key] = editor
        self.update_editor_status()

    def _remove_welcome(self):
        index = self.editor_tabs.indexOf(self.welcome)
        if index >= 0:
            self.editor_tabs.removeTab(index)

    def new_file(self):
        if not self.workspace:
            self.choose_workspace()
            if not self.workspace:
                return
        relative, ok = QInputDialog.getText(self, "New file", "Relative path (for example src/main.py):")
        if not ok:
            return
        try:
            target = safe_file_path(self.workspace, relative)
            if target.exists():
                QMessageBox.warning(self, "File exists", "Choose a path that does not already exist.")
                return
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("", encoding="utf-8")
            self.refresh_tree()
            self.open_file(target)
        except (OSError, ValueError, WorkspaceError) as error:
            QMessageBox.warning(self, "Cannot create file", str(error))

    def editor_changed(self, path_key: str, editor: QPlainTextEdit):
        if editor.document().isModified() or editor.toPlainText():
            self.dirty.add(path_key)
        else:
            self.dirty.discard(path_key)
        index = self.editor_tabs.indexOf(editor)
        if index >= 0:
            name = Path(path_key).name + (" •" if path_key in self.dirty else "")
            self.editor_tabs.setTabText(index, name)
        self.update_editor_status()

    def current_editor(self) -> tuple[str, QPlainTextEdit] | tuple[None, None]:
        widget = self.editor_tabs.currentWidget()
        if not isinstance(widget, QPlainTextEdit):
            return None, None
        for path, editor in self.open_editors.items():
            if editor is widget:
                return path, editor
        return None, None

    def save_current(self):
        path_key, editor = self.current_editor()
        if not path_key or editor is None or self.workspace is None:
            return
        try:
            path = safe_file_path(self.workspace, Path(path_key).relative_to(self.workspace))
            text = editor.toPlainText()
            data = text.encode("utf-8")
            if len(data) > MAX_TEXT_BYTES:
                raise WorkspaceError("The built-in editor saves files up to 2 MiB.")
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, temp_name = tempfile.mkstemp(prefix=".continuum-", dir=str(path.parent))
            try:
                with os.fdopen(fd, "wb") as handle:
                    handle.write(data)
                os.replace(temp_name, path)
            except Exception:
                try:
                    os.unlink(temp_name)
                except OSError:
                    pass
                raise
            editor.document().setModified(False)
            self.dirty.discard(path_key)
            self.editor_tabs.setTabText(self.editor_tabs.currentIndex(), path.name)
            self.refresh_tree()
            self.statusBar().showMessage("Saved " + str(path.relative_to(self.workspace)), 4000)
        except (OSError, ValueError, WorkspaceError) as error:
            QMessageBox.critical(self, "Save failed", str(error))

    def close_editor_tab(self, index: int):
        editor = self.editor_tabs.widget(index)
        if isinstance(editor, QPlainTextEdit):
            path = next((key for key, value in self.open_editors.items() if value is editor), None)
            if path and path in self.dirty:
                choice = QMessageBox.question(self, "Unsaved changes", "Save changes to " + Path(path).name + " before closing?", QMessageBox.StandardButton.Save | QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel)
                if choice == QMessageBox.StandardButton.Cancel:
                    return
                if choice == QMessageBox.StandardButton.Save:
                    self.editor_tabs.setCurrentIndex(index)
                    self.save_current()
                    if path in self.dirty:
                        return
                self.dirty.discard(path)
                self.open_editors.pop(path, None)
        self.editor_tabs.removeTab(index)
        if self.editor_tabs.count() == 0:
            self.editor_tabs.addTab(self.welcome, "Welcome")
        self.update_editor_status()

    def update_editor_status(self, *_args):
        path, editor = self.current_editor()
        if not path or editor is None:
            self.editor_status.setText("No file open")
        else:
            cursor = editor.textCursor()
            self.editor_status.setText(f"Ln {cursor.blockNumber()+1}  ·  Col {cursor.positionInBlock()+1}  ·  {'Modified' if path in self.dirty else 'Saved'}")

    def try_restore_cloud(self):
        try:
            if self.cloud.restore_session():
                self.email.setText(str((self.cloud.user or {}).get("email", "")))
                self._cloud_signed_in()
        except Exception as error:
            self.cloud_status.setText(str(error))

    def connect_cloud(self):
        if not self.cloud.configured:
            self.cloud_status.setText("This build has no embedded cloud endpoints. Continue using local files offline.")
            return
        if not self.cloud.signed_in:
            email = self.email.text().strip()
            password = self.password.text()
            if not email or not password:
                QMessageBox.information(self, "Sign in", "Enter your invited workspace email and password.")
                return
            try:
                self.cloud.sign_in(email, password)
                self.password.clear()
            except CloudError as error:
                QMessageBox.warning(self, "Cloud sign-in failed", str(error))
                return
        self._cloud_signed_in()

    def _cloud_signed_in(self):
        email = str((self.cloud.user or {}).get("email", "signed in"))
        self.cloud_status.setText("Signed in as " + email + ". Local files remain on this PC; agent sessions and history live in the cloud.")
        self.set_cloud_badge("CLOUD CONNECTED", "online")
        self.refresh_projects()

    def sign_out_cloud(self):
        self.cloud.sign_out()
        self.cloud_projects.clear()
        self.sessions.clear()
        self.messages.clear()
        self.projects_combo.clear()
        self.session_list.clear()
        self.set_cloud_badge("LOCAL MODE", "neutral")
        self.cloud_status.setText("Signed out. Local file editing continues to work.")
        self.update_cloud_controls()

    def refresh_projects(self):
        if not self.cloud.signed_in:
            return
        try:
            self.cloud_projects = self.cloud.projects()
            self.projects_combo.blockSignals(True)
            self.projects_combo.clear()
            for project in self.cloud_projects:
                self.projects_combo.addItem(str(project.get("name", "Project")), str(project.get("id", "")))
            self.projects_combo.blockSignals(False)
            if self.cloud_projects:
                self.refresh_sessions()
            else:
                self.cloud_status.setText("Signed in, but no projects are available to this account.")
            self.update_cloud_controls()
        except CloudError as error:
            self.cloud_status.setText(str(error))

    def project_changed(self, _index: int):
        if self.cloud.signed_in:
            self.refresh_sessions()

    def selected_project_id(self) -> str:
        return str(self.projects_combo.currentData() or "")

    def refresh_sessions(self, preserve_id: str | None = None):
        project_id = self.selected_project_id()
        if not project_id:
            self.session_list.clear()
            self.update_cloud_controls()
            return
        try:
            self.sessions = self.cloud.sessions(project_id)
            active_id = preserve_id or (self.active_session or {}).get("id")
            self.session_list.blockSignals(True)
            self.session_list.clear()
            for session in self.sessions:
                item = QListWidgetItem("●  " + str(session.get("title", "Untitled")) + "\n    " + str(session.get("current_agent", "planner")).upper() + " · " + str(session.get("status", "queued")))
                item.setData(Qt.ItemDataRole.UserRole, session.get("id"))
                self.session_list.addItem(item)
                if session.get("id") == active_id:
                    self.session_list.setCurrentItem(item)
            self.session_list.blockSignals(False)
            if self.session_list.currentItem():
                self.session_changed(self.session_list.currentItem(), None)
            else:
                self.active_session = None
                self.messages.clear()
            self.update_cloud_controls()
        except CloudError as error:
            self.cloud_status.setText(str(error))

    def session_changed(self, item: QListWidgetItem | None, _previous: QListWidgetItem | None):
        if not item:
            return
        session_id = str(item.data(Qt.ItemDataRole.UserRole) or "")
        project_id = self.selected_project_id()
        try:
            self.active_session = next((row for row in self.sessions if str(row.get("id")) == session_id), None)
            if self.active_session:
                self.messages = self.cloud.messages(project_id, session_id)
                self.cloud_status.setText(self.session_summary())
            self.update_cloud_controls()
        except CloudError as error:
            self.cloud_status.setText(str(error))

    def session_summary(self) -> str:
        if not self.active_session:
            return "No agent session selected."
        latest = next((m for m in reversed(self.messages) if m.get("role") == "assistant"), None)
        summary = ""
        if latest:
            try:
                proposal = json.loads(str(latest.get("content", "")))
                summary = str(proposal.get("summary", ""))[:350]
            except (ValueError, TypeError):
                summary = str(latest.get("content", ""))[:350]
        return str(self.active_session.get("title", "Agent session")) + " · " + str(self.active_session.get("status", "queued")) + (("\n" + summary) if summary else "")

    def update_cloud_controls(self):
        signed = self.cloud.signed_in
        project = bool(self.selected_project_id())
        session = bool(self.active_session)
        status = str((self.active_session or {}).get("status", ""))
        for button in (self.create_session_button,):
            button.setEnabled(signed and project)
        self.run_button.setEnabled(signed and project and session and status == "queued")
        self.apply_button.setEnabled(signed and project and session and status == "needs_review")
        self.continue_button.setEnabled(signed and project and session and status in {"needs_review", "failed", "completed"})
        self.sign_out_button.setEnabled(signed)
        self.connect_button.setEnabled(not signed and self.cloud.configured)
        self.email.setEnabled(not signed and self.cloud.configured)
        self.password.setEnabled(not signed and self.cloud.configured)
        self.projects_combo.setEnabled(signed)

    def create_agent_session(self):
        project_id = self.selected_project_id()
        title = self.session_title.text().strip()
        goal = self.goal.toPlainText().strip()
        roles = ["planner", "coder", "reviewer", "qa"]
        role = roles[self.role_combo.currentIndex()]
        focus = [item.strip() for item in self.focus_paths.text().split(",") if item.strip()][:12]
        if not project_id or len(title) < 2 or not goal:
            QMessageBox.information(self, "New cloud agent session", "Choose a shared project and enter a title and goal.")
            return
        try:
            session = self.cloud.create_session(project_id, title, goal, role, focus)
            self.session_title.clear()
            self.goal.clear()
            self.focus_paths.clear()
            self.refresh_sessions(str(session.get("id", "")))
            self.statusBar().showMessage("Agent session saved to cloud.", 5000)
        except CloudError as error:
            QMessageBox.warning(self, "Could not create session", str(error))

    def workspace_context(self, focus_paths: list[str]) -> list[dict[str, str]]:
        if not self.workspace:
            return []
        candidates: list[Path] = []
        if focus_paths:
            for relative in focus_paths:
                try:
                    candidates.append(safe_file_path(self.workspace, relative))
                except WorkspaceError:
                    continue
        else:
            # High-value project context first; then small source files.
            preferred = ["README.md", "pyproject.toml", "package.json", "Cargo.toml", "go.mod", "requirements.txt"]
            for name in preferred:
                path = self.workspace / name
                if path.is_file() and not should_ignore_path(path.relative_to(self.workspace)):
                    candidates.append(path)
            for folder, directories, filenames in os.walk(self.workspace):
                relative_folder = Path(folder).relative_to(self.workspace)
                directories[:] = [name for name in directories if not should_ignore_path(relative_folder / name)]
                for name in sorted(filenames):
                    path = Path(folder) / name
                    if path in candidates or should_ignore_path(path.relative_to(self.workspace)) or path.suffix.lower() not in {".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".toml", ".yaml", ".yml", ".css", ".html", ".sql", ".sh", ".c", ".h", ".cpp", ".java", ".kt", ".dart"}:
                        continue
                    try:
                        if path.stat().st_size <= 12000:
                            candidates.append(path)
                    except OSError:
                        continue
                    if len(candidates) >= 12:
                        break
                if len(candidates) >= 12:
                    break
        output = []
        total_chars = 0
        seen = set()
        for path in candidates:
            try:
                relative = str(path.relative_to(self.workspace)).replace("\\", "/")
                if relative in seen or should_ignore_path(relative):
                    continue
                content = read_text_file(path)[:12000]
                if total_chars + len(content) > 75000:
                    break
                output.append({"path": relative, "content": content})
                total_chars += len(content)
                seen.add(relative)
            except (OSError, ValueError, WorkspaceError):
                continue
        return output[:12]

    def run_agent_step(self):
        project_id = self.selected_project_id()
        session = self.active_session
        if not project_id or not session:
            return
        try:
            context = self.workspace_context(list(session.get("focus_paths") or []))
            result = self.cloud.run_step(project_id, str(session.get("id")), context)
            self.refresh_sessions(str(session.get("id")))
            self.statusBar().showMessage("Cloud agent step recorded. Review the proposal before applying.", 7000)
            proposal = result.get("proposal", {})
            QMessageBox.information(self, "Cloud agent step complete", str(proposal.get("summary", "Step completed."))[:1200] + "\n\nProvider: " + str(result.get("provider", "cloud")))
        except CloudError as error:
            QMessageBox.warning(self, "Agent step failed", str(error))
            self.refresh_sessions(str(session.get("id")))

    def apply_agent_proposal(self):
        session = self.active_session
        project_id = self.selected_project_id()
        if not session or not project_id or not self.workspace:
            QMessageBox.information(self, "Open a project folder", "Open a local workspace and select a cloud project before applying code proposals.")
            return
        if not self.messages:
            try:
                self.messages = self.cloud.messages(project_id, str(session.get("id")))
            except CloudError as error:
                QMessageBox.warning(self, "Could not load proposal", str(error))
                return
        latest = next((message for message in reversed(self.messages) if message.get("role") == "assistant"), None)
        if not latest:
            return
        try:
            proposal = json.loads(str(latest.get("content", "")))
            files = proposal.get("files", [])
            if not isinstance(files, list) or not files:
                QMessageBox.information(self, "No file changes", "The latest agent step did not propose source-file changes.")
                return
            answer = QMessageBox.question(
                self, "Review proposed changes",
                "Apply " + str(len(files)) + " proposed file(s) to\n" + str(self.workspace) +
                "?\n\nAll paths and cloud locks will be checked first. Existing files will be backed up. "
                "If any write fails, already changed files will be restored. This will not commit, push, or deploy."
            )
            if answer != QMessageBox.StandardButton.Yes:
                return

            backups = user_data_dir()
            prepared: list[tuple[str, Path, bytes, bytes | None]] = []
            seen: set[str] = set()

            # Preflight the whole proposal before touching any files.
            for item in files:
                if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not isinstance(item.get("content"), str):
                    raise WorkspaceError("A proposed change is malformed.")
                relative = item["path"].replace("\\", "/").strip()
                if not relative or relative in seen:
                    raise WorkspaceError("The proposal contains an empty or duplicate path: " + relative)
                seen.add(relative)
                target = safe_file_path(self.workspace, relative)
                self.cloud.assert_file_editable(project_id, relative)
                encoded = item["content"].encode("utf-8")
                if len(encoded) > MAX_TEXT_BYTES:
                    raise WorkspaceError("Proposed files are limited to 2 MiB each.")
                original: bytes | None = None
                if target.exists():
                    if not target.is_file():
                        raise WorkspaceError("A proposed file path already exists as a non-file: " + relative)
                    if target.stat().st_size > MAX_TEXT_BYTES:
                        raise WorkspaceError("Existing files larger than 2 MiB cannot be replaced by an agent proposal: " + relative)
                    original = target.read_bytes()
                prepared.append((relative, target, encoded, original))

            stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
            backup_root = backups / stamp
            # Persist backups for every existing file before the first replacement.
            for relative, _target, _encoded, original in prepared:
                if original is not None:
                    backup = backup_root / relative
                    backup.parent.mkdir(parents=True, exist_ok=True)
                    backup.write_bytes(original)

            applied: list[tuple[str, Path, bytes | None]] = []

            def atomic_write(target: Path, data: bytes) -> None:
                target.parent.mkdir(parents=True, exist_ok=True)
                fd, temp_name = tempfile.mkstemp(prefix=".continuum-agent-", dir=str(target.parent))
                try:
                    with os.fdopen(fd, "wb") as handle:
                        handle.write(data)
                    os.replace(temp_name, target)
                except Exception:
                    try:
                        os.unlink(temp_name)
                    except OSError:
                        pass
                    raise

            try:
                for relative, target, encoded, original in prepared:
                    atomic_write(target, encoded)
                    applied.append((relative, target, original))
            except Exception as apply_error:
                rollback_failures: list[str] = []
                for relative, target, original in reversed(applied):
                    try:
                        if original is None:
                            target.unlink(missing_ok=True)
                        else:
                            atomic_write(target, original)
                    except Exception as rollback_error:
                        rollback_failures.append(relative + ": " + str(rollback_error))
                if rollback_failures:
                    raise WorkspaceError(
                        "Applying the proposal failed and rollback was incomplete. "
                        "Recovery backups are in " + str(backup_root) + ". Failed paths: " +
                        "; ".join(rollback_failures)
                    ) from apply_error
                raise WorkspaceError(
                    "Applying the proposal failed; all earlier file changes were rolled back."
                ) from apply_error

            self.refresh_tree()
            for relative, _target, _encoded, _original in prepared:
                self.open_file(self.workspace / Path(relative))
            QMessageBox.information(
                self, "Proposal applied",
                "Updated " + str(len(prepared)) + " file(s).\n\nExisting-file backups are stored in:\n" +
                str(backup_root) + "\n\nReview the changes and run tests before committing."
            )
            self.statusBar().showMessage("Applied " + str(len(prepared)) + " reviewed file(s).", 7000)
            self.refresh_sessions(str(session.get("id")))
        except (CloudError, WorkspaceError, OSError, ValueError, KeyError, TypeError) as error:
            QMessageBox.critical(self, "Could not apply proposal", str(error))

    def continue_agent_session(self):
        session = self.active_session
        if not session:
            return
        dialog = ContinueDialog(self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        feedback = dialog.text.toPlainText().strip()
        try:
            self.cloud.continue_session(self.selected_project_id(), session, feedback)
            self.refresh_sessions(str(session.get("id")))
            self.statusBar().showMessage("Session re-queued with its previous context.", 5000)
        except CloudError as error:
            QMessageBox.warning(self, "Could not continue session", str(error))

    def closeEvent(self, event):
        unsaved = [Path(path).name for path in self.dirty]
        if unsaved:
            answer = QMessageBox.question(self, "Unsaved changes", "Save all modified files before quitting?\n\n" + "\n".join(unsaved), QMessageBox.StandardButton.Save | QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel)
            if answer == QMessageBox.StandardButton.Cancel:
                event.ignore()
                return
            if answer == QMessageBox.StandardButton.Save:
                for path in list(self.dirty):
                    editor = self.open_editors.get(path)
                    if editor and self.workspace:
                        self.editor_tabs.setCurrentWidget(editor)
                        self.save_current()
                if self.dirty:
                    event.ignore()
                    return
        super().closeEvent(event)


STYLE = """
QMainWindow { background: #10151e; color: #e7edf5; }
QToolBar { background: #151c27; border: none; border-bottom: 1px solid #293443; spacing: 8px; padding: 7px 10px; }
QToolBar QToolButton { background: #202a38; color: #dde7f1; border: 1px solid #344155; border-radius: 6px; padding: 7px 10px; }
QToolBar QToolButton:hover { background: #293648; }
QToolBar QLabel { color: #a7b6c9; padding: 0 7px; }
QLabel { color: #e2e9f2; }
QWidget#sidePanel, QWidget#rightPanel { background: #151c27; }
QWidget#rightPanel { max-width: 390px; }
QTreeWidget, QListWidget { background: #111720; color: #cdd7e4; border: 1px solid #2a3545; border-radius: 7px; outline: none; }
QTreeWidget::item, QListWidget::item { padding: 6px 4px; border-bottom: 1px solid #202a38; }
QTreeWidget::item:selected, QListWidget::item:selected { background: #21394a; color: #9de7d9; }
QPlainTextEdit { background: #0d1219; color: #dce6f2; selection-background-color: #28516a; border: 1px solid #263241; border-radius: 7px; padding: 12px; }
QLineEdit, QComboBox { background: #0f151e; color: #e4ebf3; border: 1px solid #334155; border-radius: 6px; padding: 8px; }
QComboBox QAbstractItemView { background: #17212d; color: #e4ebf3; selection-background-color: #28516a; }
QPushButton { background: #202b3a; color: #dbe6f2; border: 1px solid #3a485b; border-radius: 6px; padding: 8px 10px; }
QPushButton:hover { background: #2a394c; }
QPushButton:disabled { color: #617086; background: #19212c; border-color: #293443; }
QPushButton#primaryButton { background: #0c8d85; color: white; font-weight: 600; border: 1px solid #18a59a; }
QPushButton#primaryButton:hover { background: #10a095; }
QTabWidget::pane { border: 1px solid #293443; background: #0d1219; }
QTabBar::tab { background: #151c27; color: #95a6bc; padding: 9px 15px; border: 1px solid #293443; border-bottom: none; }
QTabBar::tab:selected { background: #0d1219; color: #e5edf5; }
QLabel#sectionLabel { color: #7f93ac; font-size: 10px; font-weight: 700; letter-spacing: 1px; padding: 5px 0; }
QLabel#muted { color: #8fa0b5; font-size: 11px; }
QLabel#welcomeMark { color: #0eb2a3; font-size: 42px; font-weight: 800; padding: 18px; border: 2px solid #0e897f; border-radius: 15px; min-width: 64px; max-width: 64px; }
QLabel#welcomeTitle { font-size: 24px; font-weight: 650; color: #eaf1fa; padding-top: 18px; }
QLabel#welcomeCopy { color: #90a0b5; font-size: 13px; line-height: 1.5; padding-top: 5px; }
QLabel#cloudBadge { background: #26303e; border: 1px solid #3a4657; border-radius: 11px; color: #aebbd0; font-size: 10px; font-weight: 700; padding: 5px; }
QLabel#cloudBadge[state="online"] { background: #143b3b; color: #89e8dc; border-color: #1c726b; }
QLabel#cloudBadge[state="neutral"] { background: #26303e; color: #9baac0; }
QStatusBar { background: #121923; color: #91a3b9; border-top: 1px solid #2a3545; }
QStatusBar::item { border: none; }
QSplitter::handle { background: #263241; width: 3px; }
QToolTip { background: #1d2938; color: #ecf2fa; border: 1px solid #43546a; padding: 4px; }
"""


def main():
    app = QApplication(sys.argv)
    app.setApplicationName("CONTINUUM")
    app.setOrganizationName("DMJ")
    window = ContinuumWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
