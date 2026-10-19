"""CONTINUUM native desktop — local-first IDE with cloud project intelligence."""
from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

from PySide6.QtCore import Qt, QSettings, QTimer, QSize, QRect, QRegularExpression
from PySide6.QtGui import (
    QAction, QActionGroup, QColor, QFont, QKeySequence, QPainter, QPalette,
    QSyntaxHighlighter, QTextCharFormat, QTextCursor
)
from PySide6.QtWidgets import (
    QApplication, QComboBox, QDialog, QDialogButtonBox, QDockWidget,
    QFileDialog, QFormLayout, QFrame, QGridLayout, QHBoxLayout, QLabel,
    QLineEdit, QListWidget, QListWidgetItem, QMainWindow, QMessageBox,
    QPlainTextEdit, QPushButton, QScrollArea, QSizePolicy, QStackedWidget,
    QStatusBar, QStyle, QTabWidget, QToolBar, QToolButton, QTreeWidget,
    QTreeWidgetItem, QVBoxLayout, QWidget, QInputDialog, QTextEdit
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


class LineNumberArea(QWidget):
    """Gutter widget that paints line numbers for the source editor."""

    def __init__(self, editor: "CodeEditor"):
        super().__init__(editor)
        self.editor = editor
        self.setObjectName("lineNumberArea")

    def sizeHint(self):
        return QSize(self.editor.line_number_area_width(), 0)

    def paintEvent(self, event):
        self.editor.paint_line_numbers(event)


class CodeSyntaxHighlighter(QSyntaxHighlighter):
    """Small, fast syntax highlighter for common programming-language tokens."""

    KEYWORDS = (
        "and as assert async await break case class const continue def del elif else "
        "except export extends finally for from fun function global if import in is "
        "lambda let match nonlocal not or pass raise return static struct try type "
        "using var void while with yield public private protected interface enum "
        "implements package switch throw new this super self"
    )

    def __init__(self, document, theme="dark"):
        super().__init__(document)
        self.theme = theme
        self.rules = []
        self.set_theme(theme)

    def set_theme(self, theme):
        self.theme = theme
        palette = {
            "dark": {
                "keyword": "#c586c0", "string": "#ce9178", "comment": "#6a9955",
                "number": "#b5cea8", "function": "#dcdcaa", "type": "#4ec9b0",
                "constant": "#569cd6",
            },
            "light": {
                "keyword": "#7c3aed", "string": "#a31515", "comment": "#008000",
                "number": "#098658", "function": "#795e26", "type": "#267f99",
                "constant": "#0000ff",
            },
        }["dark" if theme == "dark" else "light"]

        def fmt(color, bold=False, italic=False):
            value = QTextCharFormat()
            value.setForeground(QColor(color))
            if bold:
                value.setFontWeight(QFont.Weight.Bold)
            if italic:
                value.setFontItalic(True)
            return value

        keyword_pattern = r"\b(?:" + "|".join(self.KEYWORDS.split()) + r")\b"
        self.rules = [
            (QRegularExpression(keyword_pattern), fmt(palette["keyword"], True)),
            (QRegularExpression(r"\b(?:true|false|null|None|True|False|undefined|self)\b"), fmt(palette["constant"])),
            (QRegularExpression(r"\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b"), fmt(palette["number"])),
            (QRegularExpression(r"\b[A-Za-z_]\w*(?=\s*\()"), fmt(palette["function"])),
            (QRegularExpression(r"\b[A-Z][A-Za-z0-9_]*\b"), fmt(palette["type"])),
            (QRegularExpression(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|"`[^`]*`'), fmt(palette["string"])),
            (QRegularExpression(r"#[^\n]*|//[^\n]*|/\*.*?\*/"), fmt(palette["comment"], italic=True)),
        ]
        self.rehighlight()

    def highlightBlock(self, text):
        for expression, text_format in self.rules:
            iterator = expression.globalMatch(text)
            while iterator.hasNext():
                match = iterator.next()
                self.setFormat(match.capturedStart(), match.capturedLength(), text_format)


class CodeEditor(QPlainTextEdit):
    """IDE-oriented editor with a line-number gutter and token highlighting."""

    def __init__(self, theme="dark", parent=None):
        super().__init__(parent)
        self.theme = theme
        self.line_number_area = LineNumberArea(self)
        self.highlighter = CodeSyntaxHighlighter(self.document(), theme)
        self.setObjectName("codeEditor")
        self.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        self.setFont(QFont("Cascadia Code" if sys.platform == "win32" else "DejaVu Sans Mono", 10))
        self.setTabStopDistance(self.fontMetrics().horizontalAdvance(" ") * 4)
        self.blockCountChanged.connect(self.update_line_number_area_width)
        self.updateRequest.connect(self.update_line_number_area)
        self.update_line_number_area_width(0)

    def line_number_area_width(self):
        digits = max(2, len(str(max(1, self.blockCount()))))
        return 13 + self.fontMetrics().horizontalAdvance("9") * digits

    def update_line_number_area_width(self, _count):
        self.setViewportMargins(self.line_number_area_width(), 0, 0, 0)

    def update_line_number_area(self, rect, dy):
        if dy:
            self.line_number_area.scroll(0, dy)
        else:
            self.line_number_area.update(0, rect.y(), self.line_number_area.width(), rect.height())
        if rect.contains(self.viewport().rect()):
            self.update_line_number_area_width(0)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        contents = self.contentsRect()
        self.line_number_area.setGeometry(QRect(
            contents.left(), contents.top(), self.line_number_area_width(), contents.height()
        ))

    def paint_line_numbers(self, event):
        painter = QPainter(self.line_number_area)
        dark = self.theme == "dark"
        painter.fillRect(event.rect(), QColor("#1e1e1e" if dark else "#f4f4f4"))
        painter.setPen(QColor("#858585" if dark else "#777777"))
        block = self.firstVisibleBlock()
        block_number = block.blockNumber()
        top = int(self.blockBoundingGeometry(block).translated(self.contentOffset()).top())
        height = int(self.blockBoundingRect(block).height())
        bottom = top + height
        while block.isValid() and top <= event.rect().bottom():
            if block.isVisible() and bottom >= event.rect().top():
                number_color = "#d4d4d4" if block_number == self.textCursor().blockNumber() and dark else (
                    "#333333" if block_number == self.textCursor().blockNumber() else "#858585" if dark else "#777777"
                )
                painter.setPen(QColor(number_color))
                painter.drawText(
                    0, top, self.line_number_area.width() - 7, self.fontMetrics().height(),
                    Qt.AlignmentFlag.AlignRight, str(block_number + 1)
                )
            block = block.next()
            block_number += 1
            top = bottom
            height = int(self.blockBoundingRect(block).height()) if block.isValid() else 0
            bottom = top + height

    def set_theme(self, theme):
        self.theme = theme
        self.highlighter.set_theme(theme)
        self.line_number_area.update()


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
        self.theme = str(self.settings.value("theme", "dark"))
        if self.theme not in {"dark", "light"}:
            self.theme = "dark"
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
        """Build the native IDE workbench: activity rail, explorer, editor, and cloud tools."""
        self.setWindowTitle("CONTINUUM — Engineering Workspace")
        self.resize(1540, 960)
        self.setMinimumSize(QSize(1120, 720))
        self.setUnifiedTitleAndToolBarOnMac(True)

        # Command actions and keyboard shortcuts.
        self.open_folder_action = QAction("Open Folder…", self)
        self.open_folder_action.setShortcut(QKeySequence("Ctrl+Shift+O"))
        self.open_folder_action.triggered.connect(self.choose_workspace)
        self.new_action = QAction("New File…", self)
        self.new_action.setShortcut(QKeySequence("Ctrl+N"))
        self.new_action.triggered.connect(self.new_file)
        self.save_action = QAction("Save", self)
        self.save_action.setShortcut(QKeySequence.StandardKey.Save)
        self.save_action.triggered.connect(self.save_current)
        self.close_tab_action = QAction("Close Editor Tab", self)
        self.close_tab_action.setShortcut(QKeySequence("Ctrl+W"))
        self.close_tab_action.triggered.connect(self.close_current_tab)
        self.exit_action = QAction("Exit", self)
        self.exit_action.setShortcut(QKeySequence("Alt+F4"))
        self.exit_action.triggered.connect(self.close)

        file_menu = self.menuBar().addMenu("&File")
        file_menu.addAction(self.open_folder_action)
        file_menu.addAction(self.new_action)
        file_menu.addAction(self.save_action)
        file_menu.addSeparator()
        file_menu.addAction(self.close_tab_action)
        file_menu.addSeparator()
        file_menu.addAction(self.exit_action)

        view_menu = self.menuBar().addMenu("&View")
        self.toggle_explorer_action = QAction("Show Explorer", self, checkable=True)
        self.toggle_explorer_action.setChecked(True)
        self.toggle_explorer_action.setShortcut(QKeySequence("Ctrl+B"))
        self.toggle_explorer_action.triggered.connect(self.toggle_explorer)
        view_menu.addAction(self.toggle_explorer_action)
        self.toggle_cloud_action = QAction("Show Cloud & Agents", self, checkable=True)
        self.toggle_cloud_action.setChecked(True)
        self.toggle_cloud_action.setShortcut(QKeySequence("Ctrl+Alt+B"))
        self.toggle_cloud_action.triggered.connect(self.toggle_cloud_panel)
        view_menu.addAction(self.toggle_cloud_action)
        view_menu.addSeparator()
        self.toggle_theme_action = QAction("Use Light Theme", self, checkable=True)
        self.toggle_theme_action.setChecked(self.theme == "light")
        self.toggle_theme_action.triggered.connect(
            lambda checked: self.apply_theme("light" if checked else "dark")
        )
        view_menu.addAction(self.toggle_theme_action)

        help_menu = self.menuBar().addMenu("&Help")
        about_action = QAction("About CONTINUUM", self)
        about_action.triggered.connect(
            lambda: QMessageBox.about(
                self, "About CONTINUUM",
                "CONTINUUM Engineering Workspace\n\n"
                "A local-first native IDE with optional shared cloud projects and AI agents.\n"
                "Your local files remain on this machine unless you explicitly send selected context to a cloud agent."
            )
        )
        help_menu.addAction(about_action)

        # A purpose-built top bar keeps common commands visible without a bulky toolbar.
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        topbar = QWidget()
        topbar.setObjectName("appHeader")
        topbar.setFixedHeight(58)
        top = QHBoxLayout(topbar)
        top.setContentsMargins(15, 0, 15, 0)
        top.setSpacing(9)

        brand_mark = QLabel("C")
        brand_mark.setObjectName("brandMark")
        brand_mark.setAlignment(Qt.AlignmentFlag.AlignCenter)
        brand_mark.setFixedSize(31, 31)
        top.addWidget(brand_mark)
        brand = QVBoxLayout()
        brand.setSpacing(1)
        brand_name = QLabel("CONTINUUM")
        brand_name.setObjectName("brandName")
        brand_subtitle = QLabel("ENGINEERING WORKSPACE")
        brand_subtitle.setObjectName("brandSubtitle")
        brand.addWidget(brand_name)
        brand.addWidget(brand_subtitle)
        top.addLayout(brand)
        top.addSpacing(15)
        divider = QFrame()
        divider.setObjectName("headerDivider")
        divider.setFrameShape(QFrame.Shape.VLine)
        top.addWidget(divider)
        self.project_label = QLabel("No folder opened")
        self.project_label.setObjectName("workspacePath")
        self.project_label.setMinimumWidth(120)
        self.project_label.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        self.project_label.setToolTip("Current local workspace")
        top.addWidget(self.project_label, 1)

        self.header_open_button = QPushButton("Open Folder")
        self.header_open_button.setObjectName("headerButton")
        self.header_open_button.clicked.connect(self.choose_workspace)
        top.addWidget(self.header_open_button)
        self.header_new_button = QPushButton("New File")
        self.header_new_button.setObjectName("headerButton")
        self.header_new_button.clicked.connect(self.new_file)
        top.addWidget(self.header_new_button)
        self.header_save_button = QPushButton("Save")
        self.header_save_button.setObjectName("headerButton")
        self.header_save_button.clicked.connect(self.save_current)
        top.addWidget(self.header_save_button)
        self.theme_button = QPushButton("☼  Light")
        self.theme_button.setObjectName("headerButton")
        self.theme_button.setToolTip("Switch between light and dark appearance")
        self.theme_button.clicked.connect(self.toggle_theme)
        top.addWidget(self.theme_button)

        self.cloud_badge = QLabel("LOCAL MODE")
        self.cloud_badge.setObjectName("cloudBadge")
        top.addWidget(self.cloud_badge)
        self.cloud_button = QPushButton("Connect Cloud")
        self.cloud_button.setObjectName("headerPrimary")
        self.cloud_button.clicked.connect(self.connect_cloud)
        top.addWidget(self.cloud_button)
        root.addWidget(topbar)

        # Main workbench: activity bar | explorer | editor | cloud tools.
        workbench = QWidget()
        workbench.setObjectName("workbench")
        columns = QHBoxLayout(workbench)
        columns.setContentsMargins(0, 0, 0, 0)
        columns.setSpacing(0)

        self.activity_bar = QWidget()
        self.activity_bar.setObjectName("activityBar")
        self.activity_bar.setFixedWidth(52)
        rail = QVBoxLayout(self.activity_bar)
        rail.setContentsMargins(6, 12, 6, 9)
        rail.setSpacing(8)

        def rail_button(glyph, tooltip, callback, active=False):
            button = QToolButton()
            button.setText(glyph)
            button.setToolTip(tooltip)
            button.setObjectName("activityButton")
            button.setCheckable(True)
            button.setChecked(active)
            button.setFixedSize(39, 39)
            button.clicked.connect(callback)
            rail.addWidget(button)
            return button

        self.explorer_rail_button = rail_button("▤", "Explorer (Ctrl+B)", self.toggle_explorer, True)
        self.cloud_rail_button = rail_button("✳", "Cloud projects and AI agents", self.toggle_cloud_panel, True)
        rail.addStretch(1)
        rail.addWidget(QLabel("LOCAL"))
        self.settings_rail_button = rail_button("⚙", "Appearance and about", self.show_preferences, False)
        columns.addWidget(self.activity_bar)

        # Explorer panel with an intentional first-run state.
        self.explorer_panel = QWidget()
        self.explorer_panel.setObjectName("explorerPanel")
        self.explorer_panel.setMinimumWidth(205)
        self.explorer_panel.setMaximumWidth(315)
        explorer_layout = QVBoxLayout(self.explorer_panel)
        explorer_layout.setContentsMargins(0, 0, 0, 0)
        explorer_layout.setSpacing(0)

        explorer_header = QWidget()
        explorer_header.setObjectName("panelHeader")
        explorer_header.setFixedHeight(44)
        eh = QHBoxLayout(explorer_header)
        eh.setContentsMargins(15, 0, 10, 0)
        eh.addWidget(self.section_label("EXPLORER"))
        eh.addStretch(1)
        self.explorer_refresh_button = QToolButton()
        self.explorer_refresh_button.setText("↻")
        self.explorer_refresh_button.setObjectName("iconButton")
        self.explorer_refresh_button.setToolTip("Refresh file tree")
        self.explorer_refresh_button.clicked.connect(self.refresh_tree)
        eh.addWidget(self.explorer_refresh_button)
        explorer_layout.addWidget(explorer_header)

        self.explorer_stack = QStackedWidget()
        self.workspace_tree = QTreeWidget()
        self.workspace_tree.setObjectName("workspaceTree")
        self.workspace_tree.setHeaderHidden(True)
        self.workspace_tree.setIndentation(15)
        self.workspace_tree.setAnimated(True)
        self.workspace_tree.setUniformRowHeights(True)
        self.workspace_tree.itemDoubleClicked.connect(self.tree_open_file)
        self.explorer_stack.addWidget(self.workspace_tree)

        self.explorer_empty = QWidget()
        empty_layout = QVBoxLayout(self.explorer_empty)
        empty_layout.setContentsMargins(19, 25, 19, 25)
        empty_layout.addStretch(1)
        empty_mark = QLabel("▤")
        empty_mark.setObjectName("emptyGlyph")
        empty_mark.setAlignment(Qt.AlignmentFlag.AlignCenter)
        empty_layout.addWidget(empty_mark)
        empty_title = QLabel("No folder open")
        empty_title.setObjectName("emptyTitle")
        empty_title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        empty_layout.addWidget(empty_title)
        empty_copy = QLabel("Open a local project folder to browse and edit files.")
        empty_copy.setObjectName("muted")
        empty_copy.setWordWrap(True)
        empty_copy.setAlignment(Qt.AlignmentFlag.AlignCenter)
        empty_layout.addWidget(empty_copy)
        open_empty = QPushButton("Open Folder")
        open_empty.setObjectName("panelPrimary")
        open_empty.clicked.connect(self.choose_workspace)
        empty_layout.addWidget(open_empty)
        empty_layout.addStretch(2)
        self.explorer_stack.addWidget(self.explorer_empty)
        self.explorer_stack.setCurrentWidget(self.explorer_empty)
        explorer_layout.addWidget(self.explorer_stack, 1)

        explorer_footer = QWidget()
        explorer_footer.setObjectName("panelFooter")
        ef = QHBoxLayout(explorer_footer)
        ef.setContentsMargins(10, 8, 10, 8)
        self.explorer_new_button = QPushButton("+  New File")
        self.explorer_new_button.setObjectName("panelButton")
        self.explorer_new_button.clicked.connect(self.new_file)
        ef.addWidget(self.explorer_new_button)
        explorer_layout.addWidget(explorer_footer)
        columns.addWidget(self.explorer_panel)

        # Editor group with clean tabs and useful first-run actions.
        self.editor_panel = QWidget()
        self.editor_panel.setObjectName("editorPanel")
        editor_layout = QVBoxLayout(self.editor_panel)
        editor_layout.setContentsMargins(0, 0, 0, 0)
        editor_layout.setSpacing(0)
        self.editor_tabs = QTabWidget()
        self.editor_tabs.setObjectName("editorTabs")
        self.editor_tabs.setTabsClosable(True)
        self.editor_tabs.setMovable(True)
        self.editor_tabs.setDocumentMode(True)
        self.editor_tabs.currentChanged.connect(self.update_editor_status)
        self.editor_tabs.tabCloseRequested.connect(self.close_editor_tab)

        self.welcome = QWidget()
        self.welcome.setObjectName("welcomeScreen")
        welcome_layout = QVBoxLayout(self.welcome)
        welcome_layout.setContentsMargins(28, 24, 28, 27)
        welcome_layout.addStretch(2)
        hero = QWidget()
        hero_layout = QVBoxLayout(hero)
        hero_layout.setContentsMargins(0, 0, 0, 0)
        hero_layout.setSpacing(8)
        welcome_eyebrow = QLabel("YOUR LOCAL ENGINEERING WORKSPACE")
        welcome_eyebrow.setObjectName("welcomeEyebrow")
        welcome_eyebrow.setAlignment(Qt.AlignmentFlag.AlignCenter)
        hero_layout.addWidget(welcome_eyebrow)
        mark = QLabel("C")
        mark.setObjectName("welcomeMark")
        mark.setAlignment(Qt.AlignmentFlag.AlignCenter)
        hero_layout.addWidget(mark, alignment=Qt.AlignmentFlag.AlignCenter)
        welcome_title = QLabel("Build locally. Think together.")
        welcome_title.setObjectName("welcomeTitle")
        welcome_title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        hero_layout.addWidget(welcome_title)
        welcome_copy = QLabel(
            "A focused desktop IDE for your real codebase. Edit and save files offline; "
            "connect the shared cloud workspace when you want to collaborate or use AI agents."
        )
        welcome_copy.setObjectName("welcomeCopy")
        welcome_copy.setAlignment(Qt.AlignmentFlag.AlignCenter)
        welcome_copy.setWordWrap(True)
        welcome_copy.setMaximumWidth(610)
        hero_layout.addWidget(welcome_copy, alignment=Qt.AlignmentFlag.AlignCenter)
        welcome_layout.addWidget(hero)
        welcome_layout.addSpacing(25)

        actions_grid = QGridLayout()
        actions_grid.setContentsMargins(0, 0, 0, 0)
        actions_grid.setHorizontalSpacing(10)
        actions_grid.setVerticalSpacing(10)

        def welcome_action(glyph, title, detail, callback, row, col):
            action = QPushButton(f"{glyph}   {title}\n{detail}")
            action.setObjectName("welcomeAction")
            action.setMinimumHeight(76)
            action.setMinimumWidth(190)
            action.setCursor(Qt.CursorShape.PointingHandCursor)
            action.clicked.connect(callback)
            actions_grid.addWidget(action, row, col)

        welcome_action("▤", "Open Folder", "Browse a local codebase", self.choose_workspace, 0, 0)
        welcome_action("+", "Create a File", "Start a new source file", self.new_file, 0, 1)
        welcome_action("✳", "Connect Cloud", "Shared projects and AI agents", self.connect_cloud, 0, 2)
        welcome_layout.addLayout(actions_grid)
        welcome_layout.addSpacing(19)
        welcome_hint = QLabel("TIP  ·  Use Ctrl+Shift+O to open a folder  •  Ctrl+N for a file  •  Ctrl+S to save")
        welcome_hint.setObjectName("welcomeHint")
        welcome_hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        welcome_hint.setWordWrap(True)
        welcome_layout.addWidget(welcome_hint)
        welcome_layout.addStretch(3)
        self.editor_tabs.addTab(self.welcome, "Welcome")
        editor_layout.addWidget(self.editor_tabs, 1)

        editor_footer = QWidget()
        editor_footer.setObjectName("editorFooter")
        footer_layout = QHBoxLayout(editor_footer)
        footer_layout.setContentsMargins(12, 5, 12, 5)
        self.editor_status = QLabel("Ready")
        self.editor_status.setObjectName("editorStatus")
        footer_layout.addWidget(self.editor_status, 1)
        self.encoding_status = QLabel("UTF-8")
        self.encoding_status.setObjectName("editorStatus")
        footer_layout.addWidget(self.encoding_status)
        self.language_status = QLabel("Plain Text")
        self.language_status.setObjectName("editorStatus")
        footer_layout.addWidget(self.language_status)
        editor_layout.addWidget(editor_footer)
        columns.addWidget(self.editor_panel, 1)

        # Cloud and agents tool window. It can be hidden without disturbing local editing.
        self.cloud_panel = QWidget()
        self.cloud_panel.setObjectName("cloudPanel")
        self.cloud_panel.setMinimumWidth(285)
        self.cloud_panel.setMaximumWidth(390)
        cloud_root = QVBoxLayout(self.cloud_panel)
        cloud_root.setContentsMargins(0, 0, 0, 0)
        cloud_root.setSpacing(0)
        cloud_header = QWidget()
        cloud_header.setObjectName("panelHeader")
        cloud_header.setFixedHeight(44)
        ch = QHBoxLayout(cloud_header)
        ch.setContentsMargins(15, 0, 10, 0)
        ch.addWidget(self.section_label("CLOUD WORKSPACE"))
        ch.addStretch(1)
        self.cloud_collapse_button = QToolButton()
        self.cloud_collapse_button.setObjectName("iconButton")
        self.cloud_collapse_button.setText("×")
        self.cloud_collapse_button.setToolTip("Hide cloud tools (Ctrl+Alt+B)")
        self.cloud_collapse_button.clicked.connect(self.toggle_cloud_panel)
        ch.addWidget(self.cloud_collapse_button)
        cloud_root.addWidget(cloud_header)

        cloud_scroll = QScrollArea()
        cloud_scroll.setObjectName("cloudScroll")
        cloud_scroll.setWidgetResizable(True)
        cloud_scroll.setFrameShape(QFrame.Shape.NoFrame)
        cloud_content = QWidget()
        cloud_content.setObjectName("cloudContent")
        right_layout = QVBoxLayout(cloud_content)
        right_layout.setContentsMargins(13, 12, 13, 15)
        right_layout.setSpacing(9)

        connection_head = QHBoxLayout()
        connection_head.addWidget(self.section_label("CONNECTION"))
        connection_head.addStretch(1)
        self.cloud_status_dot = QLabel("●")
        self.cloud_status_dot.setObjectName("statusDot")
        connection_head.addWidget(self.cloud_status_dot)
        right_layout.addLayout(connection_head)
        self.cloud_status = QLabel("Not connected")
        self.cloud_status.setObjectName("cloudStatus")
        self.cloud_status.setWordWrap(True)
        right_layout.addWidget(self.cloud_status)

        self.email = QLineEdit()
        self.email.setObjectName("cloudInput")
        self.email.setPlaceholderText("Workspace email")
        self.password = QLineEdit()
        self.password.setObjectName("cloudInput")
        self.password.setPlaceholderText("Password")
        self.password.setEchoMode(QLineEdit.EchoMode.Password)
        self.connect_button = QPushButton("Sign in")
        self.connect_button.setObjectName("panelPrimary")
        self.connect_button.clicked.connect(self.connect_cloud)
        self.sign_out_button = QPushButton("Sign out")
        self.sign_out_button.setObjectName("panelButton")
        self.sign_out_button.clicked.connect(self.sign_out_cloud)
        auth_row = QHBoxLayout()
        auth_row.setSpacing(7)
        auth_row.addWidget(self.connect_button, 1)
        auth_row.addWidget(self.sign_out_button, 1)
        right_layout.addWidget(self.email)
        right_layout.addWidget(self.password)
        right_layout.addLayout(auth_row)

        right_layout.addSpacing(8)
        right_layout.addWidget(self.section_label("SHARED PROJECT"))
        self.projects_combo = QComboBox()
        self.projects_combo.setObjectName("cloudInput")
        self.projects_combo.setMinimumHeight(34)
        self.projects_combo.currentIndexChanged.connect(self.project_changed)
        right_layout.addWidget(self.projects_combo)
        reload_projects = QPushButton("↻  Refresh projects")
        reload_projects.setObjectName("panelButton")
        reload_projects.clicked.connect(self.refresh_projects)
        right_layout.addWidget(reload_projects)

        right_layout.addSpacing(8)
        session_header = QHBoxLayout()
        session_header.addWidget(self.section_label("AGENT SESSIONS"))
        session_header.addStretch(1)
        self.session_count = QLabel("0")
        self.session_count.setObjectName("countBadge")
        session_header.addWidget(self.session_count)
        right_layout.addLayout(session_header)
        self.session_list = QListWidget()
        self.session_list.setObjectName("sessionList")
        self.session_list.setMinimumHeight(115)
        self.session_list.setMaximumHeight(190)
        self.session_list.currentItemChanged.connect(self.session_changed)
        right_layout.addWidget(self.session_list)

        right_layout.addSpacing(8)
        agent_form_heading = QLabel("NEW AGENT SESSION")
        agent_form_heading.setObjectName("subsectionTitle")
        right_layout.addWidget(agent_form_heading)
        self.session_title = QLineEdit()
        self.session_title.setObjectName("cloudInput")
        self.session_title.setPlaceholderText("Session title")
        self.goal = QPlainTextEdit()
        self.goal.setObjectName("goalInput")
        self.goal.setPlaceholderText("Goal and acceptance criteria…")
        self.goal.setMinimumHeight(72)
        self.goal.setMaximumHeight(106)
        self.role_combo = QComboBox()
        self.role_combo.setObjectName("cloudInput")
        self.role_combo.addItems(["Planner", "Coder", "Reviewer", "QA"])
        self.focus_paths = QLineEdit()
        self.focus_paths.setObjectName("cloudInput")
        self.focus_paths.setPlaceholderText("Focus paths (optional, comma separated)")
        right_layout.addWidget(self.session_title)
        right_layout.addWidget(self.role_combo)
        right_layout.addWidget(self.goal)
        right_layout.addWidget(self.focus_paths)

        self.create_session_button = QPushButton("Queue session")
        self.create_session_button.setObjectName("panelButton")
        self.create_session_button.clicked.connect(self.create_agent_session)
        self.run_button = QPushButton("Run agent step  →")
        self.run_button.setObjectName("panelPrimary")
        self.run_button.clicked.connect(self.run_agent_step)
        self.apply_button = QPushButton("Review & apply proposal")
        self.apply_button.setObjectName("panelButton")
        self.apply_button.clicked.connect(self.apply_agent_proposal)
        self.continue_button = QPushButton("Continue session")
        self.continue_button.setObjectName("panelButton")
        self.continue_button.clicked.connect(self.continue_agent_session)
        right_layout.addWidget(self.create_session_button)
        right_layout.addWidget(self.run_button)
        right_layout.addWidget(self.apply_button)
        right_layout.addWidget(self.continue_button)
        agent_note = QLabel("Agent edits are proposals. Review changes before writing them to your local files.")
        agent_note.setObjectName("muted")
        agent_note.setWordWrap(True)
        right_layout.addWidget(agent_note)
        right_layout.addStretch(1)
        cloud_scroll.setWidget(cloud_content)
        cloud_root.addWidget(cloud_scroll, 1)
        columns.addWidget(self.cloud_panel)

        root.addWidget(workbench, 1)

        # Status bar carries actionable editor/workspace state, not empty filler.
        status = QStatusBar()
        status.setObjectName("statusBar")
        status.setSizeGripEnabled(False)
        self.status_workspace = QLabel("●  LOCAL")
        self.status_workspace.setObjectName("statusBarStrong")
        status.addWidget(self.status_workspace)
        self.status_location = QLabel("No folder opened")
        self.status_location.setObjectName("statusBarText")
        status.addWidget(self.status_location, 1)
        self.status_cloud = QLabel("Cloud optional")
        self.status_cloud.setObjectName("statusBarText")
        status.addPermanentWidget(self.status_cloud)
        self.setStatusBar(status)
        self.statusBar().showMessage("Local-first workspace • Files stay on this PC unless you explicitly send context to a cloud agent.")

        # Make first-run proportions readable at typical laptop resolutions.
        self._explorer_visible = True
        self._cloud_visible = True
        self.apply_theme(self.theme)
        self.update_cloud_controls()

    def apply_theme(self, theme: str):
        """Apply and persist the selected native UI theme."""
        self.theme = "light" if theme == "light" else "dark"
        self.settings.setValue("theme", self.theme)
        self.setStyleSheet(STYLE_LIGHT if self.theme == "light" else STYLE_DARK)
        self.toggle_theme_action.setChecked(self.theme == "light")
        self.theme_button.setText("☾  Dark" if self.theme == "light" else "☼  Light")
        self.theme_button.setToolTip("Current theme: " + self.theme.title() + ". Click to switch.")
        for editor in self.open_editors.values():
            if isinstance(editor, CodeEditor):
                editor.set_theme(self.theme)
        self.status_workspace.setText("●  LOCAL")
        self.status_workspace.setProperty("theme", self.theme)

    def toggle_theme(self):
        self.apply_theme("light" if self.theme == "dark" else "dark")

    def toggle_explorer(self, checked=None):
        visible = not self.explorer_panel.isVisible() if checked is None else bool(checked)
        self.explorer_panel.setVisible(visible)
        self._explorer_visible = visible
        self.toggle_explorer_action.setChecked(visible)
        self.explorer_rail_button.setChecked(visible)

    def toggle_cloud_panel(self, checked=None):
        visible = not self.cloud_panel.isVisible() if checked is None else bool(checked)
        self.cloud_panel.setVisible(visible)
        self._cloud_visible = visible
        self.toggle_cloud_action.setChecked(visible)
        self.cloud_rail_button.setChecked(visible)

    def show_preferences(self):
        QMessageBox.information(
            self, "CONTINUUM Preferences",
            "Appearance is saved per Windows user. Use the top-bar theme button or View → Use Light Theme.\n\n"
            "Local file editing works offline; cloud sign-in and AI-agent runs need a network connection."
        )

    def close_current_tab(self):
        index = self.editor_tabs.currentIndex()
        if index >= 0:
            self.close_editor_tab(index)

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
        if state != "online":
            self.cloud_status_dot.setStyleSheet("")

    def choose_workspace(self):
        folder = QFileDialog.getExistingDirectory(self, "Open project folder", str(self.workspace or Path.home()))
        if folder:
            self.set_workspace(Path(folder))

    def set_workspace(self, folder: Path):
        self.workspace = folder.expanduser().resolve()
        self.settings.setValue("workspace", str(self.workspace))
        self.project_label.setText(self.workspace.name or str(self.workspace))
        self.project_label.setToolTip(str(self.workspace))
        self.status_location.setText(str(self.workspace))
        self.refresh_tree()
        self.statusBar().showMessage("Local project opened: " + str(self.workspace), 5000)

    def refresh_tree(self):
        self._building_tree = True
        self.workspace_tree.clear()
        if not self.workspace or not self.workspace.is_dir():
            self.explorer_stack.setCurrentWidget(self.explorer_empty)
            self._building_tree = False
            return
        self._populate_tree(self.workspace, self.workspace_tree.invisibleRootItem(), 0, [1600])
        self.workspace_tree.expandToDepth(1)
        self.explorer_stack.setCurrentWidget(self.workspace_tree)
        self.project_label.setText(self.workspace.name or str(self.workspace))
        self.project_label.setToolTip(str(self.workspace))
        self.status_location.setText(str(self.workspace))
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
        editor = CodeEditor(self.theme)
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
            self.editor_status.setText("Ready  ·  Open a folder or create a file")
            self.language_status.setText("Workspace")
            self.encoding_status.setText("UTF-8")
            return
        cursor = editor.textCursor()
        state = "Modified" if path in self.dirty else "Saved"
        self.editor_status.setText(
            f"Ln {cursor.blockNumber()+1}  ·  Col {cursor.positionInBlock()+1}  ·  {state}"
        )
        suffix = Path(path).suffix.lower()
        languages = {
            ".py": "Python", ".pyw": "Python", ".js": "JavaScript", ".jsx": "React JSX",
            ".ts": "TypeScript", ".tsx": "React TSX", ".json": "JSON", ".md": "Markdown",
            ".html": "HTML", ".css": "CSS", ".scss": "SCSS", ".sql": "SQL",
            ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML", ".sh": "Shell",
            ".bat": "Batch", ".ps1": "PowerShell", ".cpp": "C++", ".c": "C",
            ".h": "C/C++ Header", ".java": "Java", ".kt": "Kotlin", ".dart": "Dart",
            ".rs": "Rust", ".go": "Go", ".xml": "XML", ".txt": "Plain Text",
        }
        self.language_status.setText(languages.get(suffix, "Plain Text"))
        self.encoding_status.setText("UTF-8")

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
        self.cloud_status_dot.setStyleSheet("color: #27bba7;")
        self.status_cloud.setText("Cloud connected")
        self.refresh_projects()

    def sign_out_cloud(self):
        self.cloud.sign_out()
        self.cloud_projects.clear()
        self.sessions.clear()
        self.messages.clear()
        self.projects_combo.clear()
        self.session_list.clear()
        self.set_cloud_badge("LOCAL MODE", "neutral")
        self.cloud_status_dot.setStyleSheet("")
        self.status_cloud.setText("Cloud optional")
        self.session_count.setText("0")
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
            if hasattr(self, "session_count"):
                self.session_count.setText(str(len(self.sessions)))
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


STYLE_DARK = """
QMainWindow, QWidget { background: #1b1d22; color: #dce1e9; font-family: "Segoe UI"; font-size: 10pt; }
QMenuBar { background: #202329; color: #cfd5df; border-bottom: 1px solid #30343d; padding: 3px 6px; }
QMenuBar::item { padding: 6px 9px; background: transparent; border-radius: 4px; }
QMenuBar::item:selected { background: #30343d; color: #ffffff; }
QMenu { background: #262930; color: #e4e8ef; border: 1px solid #3b414c; padding: 5px; }
QMenu::item { padding: 7px 24px 7px 22px; border-radius: 3px; }
QMenu::item:selected { background: #33434a; color: #8ce9db; }
QMenu::separator { height: 1px; background: #3b414c; margin: 5px 8px; }
QWidget#appHeader { background: #202329; border-bottom: 1px solid #323741; }
QLabel#brandMark { background: #0e9f92; color: #ffffff; border-radius: 8px; font: 800 17pt "Segoe UI"; }
QLabel#brandName { color: #f2f4f8; font: 800 10pt "Segoe UI"; letter-spacing: 1.2px; }
QLabel#brandSubtitle { color: #7f8999; font: 600 6.5pt "Segoe UI"; letter-spacing: 1.05px; }
QFrame#headerDivider { color: #3a3f49; }
QLabel#workspacePath { color: #aab3c0; font-size: 9pt; padding-left: 7px; }
QPushButton#headerButton { background: #2b3039; color: #d7dde7; border: 1px solid #414753; border-radius: 5px; padding: 7px 11px; font-size: 9pt; }
QPushButton#headerButton:hover { background: #363d48; border-color: #566171; }
QPushButton#headerPrimary, QPushButton#panelPrimary { background: #087f75; color: #ffffff; border: 1px solid #0d9a8e; border-radius: 5px; padding: 8px 11px; font-weight: 650; }
QPushButton#headerPrimary:hover, QPushButton#panelPrimary:hover { background: #0a978a; }
QPushButton#headerPrimary:disabled, QPushButton#panelPrimary:disabled { background: #29383a; color: #75898a; border-color: #344549; }
QWidget#workbench { background: #181a1f; }
QWidget#activityBar { background: #202329; border-right: 1px solid #30343d; }
QWidget#activityBar QLabel { color: #697382; font: 600 6pt "Segoe UI"; padding: 3px 0; }
QToolButton#activityButton { background: transparent; border: 1px solid transparent; border-radius: 6px; color: #929baa; font: 16pt "Segoe UI Symbol"; }
QToolButton#activityButton:hover { background: #2b3039; color: #edf2f7; }
QToolButton#activityButton:checked { background: #2d383c; color: #71dfcf; border-left: 2px solid #18b5a4; }
QWidget#explorerPanel, QWidget#cloudPanel { background: #202329; border-right: 1px solid #30343d; }
QWidget#cloudPanel { border-left: 1px solid #30343d; border-right: none; }
QWidget#panelHeader { background: #202329; border-bottom: 1px solid #30343d; }
QLabel#sectionLabel { color: #a6afbc; font-size: 8pt; font-weight: 750; letter-spacing: 1.1px; }
QToolButton#iconButton { background: transparent; color: #9ba5b3; border: none; border-radius: 4px; font-size: 14pt; padding: 3px 6px; }
QToolButton#iconButton:hover { background: #343943; color: #ffffff; }
QStackedWidget { background: #202329; }
QTreeWidget#workspaceTree, QListWidget#sessionList { background: #202329; alternate-background-color: #23262d; color: #d0d6e0; border: none; outline: none; selection-background-color: #293c42; selection-color: #8ce9db; }
QTreeWidget#workspaceTree::item { padding: 5px 4px; border: none; height: 23px; }
QTreeWidget#workspaceTree::item:hover, QListWidget#sessionList::item:hover { background: #2a2e36; }
QTreeWidget#workspaceTree::item:selected, QListWidget#sessionList::item:selected { background: #293c42; color: #83e3d5; }
QTreeWidget#workspaceTree::branch { background: #202329; }
QListWidget#sessionList { border: 1px solid #363b45; border-radius: 5px; }
QListWidget#sessionList::item { padding: 9px 8px; border-bottom: 1px solid #30343d; }
QWidget#panelFooter { background: #202329; border-top: 1px solid #30343d; }
QPushButton#panelButton { background: #2b3039; color: #d0d6e0; border: 1px solid #404651; border-radius: 5px; padding: 8px 10px; text-align: center; }
QPushButton#panelButton:hover { background: #363c47; border-color: #515b6b; }
QPushButton#panelButton:disabled { color: #697484; background: #252930; border-color: #323741; }
QLabel#emptyGlyph { color: #53606f; font: 30pt "Segoe UI Symbol"; padding: 5px; }
QLabel#emptyTitle { color: #dfe4eb; font-size: 11pt; font-weight: 650; padding-top: 5px; }
QLabel#muted { color: #8792a2; font-size: 9pt; }
QWidget#editorPanel { background: #181a1f; }
QTabWidget#editorTabs::pane { border: none; background: #181a1f; }
QTabWidget#editorTabs QTabBar { background: #202329; }
QTabBar::tab { background: #202329; color: #8993a2; border: none; border-right: 1px solid #30343d; padding: 10px 15px; min-width: 68px; }
QTabBar::tab:selected { background: #181a1f; color: #f0f3f7; border-top: 2px solid #1fb6a6; padding-top: 8px; }
QTabBar::tab:hover:!selected { background: #292d34; color: #d6dce5; }
QTabBar::close-button { subcontrol-position: right; }
QWidget#welcomeScreen { background: #181a1f; }
QLabel#welcomeEyebrow { color: #61bcb2; font: 700 8pt "Segoe UI"; letter-spacing: 2px; padding-bottom: 7px; }
QLabel#welcomeMark { color: #6de0d0; font: 800 38pt "Segoe UI"; background: #21262c; border: 1px solid #276b65; border-radius: 18px; min-width: 74px; max-width: 74px; min-height: 74px; max-height: 74px; }
QLabel#welcomeTitle { color: #f0f2f6; font: 650 23pt "Segoe UI"; padding-top: 9px; }
QLabel#welcomeCopy { color: #9aa4b3; font-size: 10pt; line-height: 1.5; }
QPushButton#welcomeAction { background: #20242a; color: #e0e6ee; border: 1px solid #373d47; border-radius: 7px; padding: 15px; text-align: left; font-size: 10pt; line-height: 1.5; }
QPushButton#welcomeAction:hover { background: #282f35; border-color: #298b80; color: #f5f7fa; }
QLabel#welcomeHint { color: #778292; font-size: 8pt; padding: 7px; }
QWidget#editorFooter { background: #181a1f; border-top: 1px solid #30343d; }
QLabel#editorStatus { color: #818c9c; font-size: 8pt; padding: 0 5px; }
QWidget#lineNumberArea { background: #1e1e1e; }
QPlainTextEdit#codeEditor { background: #1e1e1e; color: #d4d4d4; selection-background-color: #264f78; border: none; padding: 7px 9px; font-size: 10pt; }
QLineEdit#cloudInput, QComboBox#cloudInput, QPlainTextEdit#goalInput { background: #191c22; color: #e1e6ee; border: 1px solid #3a404a; border-radius: 5px; padding: 8px 9px; selection-background-color: #245d63; }
QLineEdit#cloudInput:focus, QComboBox#cloudInput:focus, QPlainTextEdit#goalInput:focus { border: 1px solid #248e84; }
QComboBox#cloudInput::drop-down { border: none; width: 23px; }
QComboBox QAbstractItemView { background: #252930; color: #e0e5ed; selection-background-color: #293c42; border: 1px solid #414752; }
QLabel#cloudStatus { color: #a6b0bf; font-size: 9pt; line-height: 1.45; padding-bottom: 2px; }
QLabel#statusDot { color: #687789; font-size: 10pt; }
QLabel#subsectionTitle { color: #c0c7d1; font-size: 8pt; font-weight: 700; letter-spacing: .6px; padding-top: 3px; }
QLabel#countBadge { background: #303640; color: #a9b4c2; border-radius: 9px; padding: 3px 7px; font-size: 8pt; }
QScrollArea#cloudScroll, QWidget#cloudContent { background: #202329; border: none; }
QStatusBar#statusBar { background: #087f75; color: #e7fffb; border-top: 1px solid #13a99b; min-height: 22px; font-size: 8pt; }
QStatusBar#statusBar QLabel { color: #d8f5f1; padding: 2px 7px; }
QStatusBar#statusBar QLabel#statusBarStrong { font-weight: 750; }
QSplitter::handle { background: #30343d; width: 1px; }
QScrollBar:vertical { background: #202329; width: 10px; margin: 0; }
QScrollBar::handle:vertical { background: #414752; border-radius: 4px; min-height: 30px; }
QScrollBar::handle:vertical:hover { background: #596273; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
QToolTip { background: #292e36; color: #f1f4f8; border: 1px solid #454c59; padding: 5px; }
QMessageBox, QDialog { background: #202329; color: #e2e7ef; }
QLabel#cloudBadge { background: #292e36; border: 1px solid #424954; border-radius: 5px; color: #b7c1ce; padding: 6px 9px; font-size: 8pt; font-weight: 750; }
QLabel#cloudBadge[state="online"] { background: #163a35; border-color: #23796c; color: #8ae2d4; }
QLabel#cloudBadge[state="neutral"] { background: #292e36; color: #a2adbc; }
"""

STYLE_LIGHT = """
QMainWindow, QWidget { background: #f5f6f8; color: #232831; font-family: "Segoe UI"; font-size: 10pt; }
QMenuBar { background: #ffffff; color: #38404b; border-bottom: 1px solid #e2e5eb; padding: 3px 6px; }
QMenuBar::item { padding: 6px 9px; background: transparent; border-radius: 4px; }
QMenuBar::item:selected { background: #eef1f5; color: #121821; }
QMenu { background: #ffffff; color: #252c36; border: 1px solid #dce1e8; padding: 5px; }
QMenu::item { padding: 7px 24px 7px 22px; border-radius: 3px; }
QMenu::item:selected { background: #e2f4f0; color: #006f65; }
QMenu::separator { height: 1px; background: #e1e5eb; margin: 5px 8px; }
QWidget#appHeader { background: #ffffff; border-bottom: 1px solid #dfe3e9; }
QLabel#brandMark { background: #0c9387; color: #ffffff; border-radius: 8px; font: 800 17pt "Segoe UI"; }
QLabel#brandName { color: #202630; font: 800 10pt "Segoe UI"; letter-spacing: 1.2px; }
QLabel#brandSubtitle { color: #9299a5; font: 600 6.5pt "Segoe UI"; letter-spacing: 1.05px; }
QFrame#headerDivider { color: #d9dde4; }
QLabel#workspacePath { color: #6c7480; font-size: 9pt; padding-left: 7px; }
QPushButton#headerButton { background: #ffffff; color: #424b58; border: 1px solid #d9dee6; border-radius: 5px; padding: 7px 11px; font-size: 9pt; }
QPushButton#headerButton:hover { background: #f0f3f7; border-color: #b6beca; }
QPushButton#headerPrimary, QPushButton#panelPrimary { background: #087f75; color: #ffffff; border: 1px solid #0d9a8e; border-radius: 5px; padding: 8px 11px; font-weight: 650; }
QPushButton#headerPrimary:hover, QPushButton#panelPrimary:hover { background: #0a978a; }
QPushButton#headerPrimary:disabled, QPushButton#panelPrimary:disabled { background: #e0e8e7; color: #7e9592; border-color: #cadbd8; }
QWidget#workbench { background: #f5f6f8; }
QWidget#activityBar { background: #ffffff; border-right: 1px solid #dfe3e9; }
QWidget#activityBar QLabel { color: #9aa1ad; font: 600 6pt "Segoe UI"; padding: 3px 0; }
QToolButton#activityButton { background: transparent; border: 1px solid transparent; border-radius: 6px; color: #7a8492; font: 16pt "Segoe UI Symbol"; }
QToolButton#activityButton:hover { background: #f1f3f6; color: #2d3540; }
QToolButton#activityButton:checked { background: #e4f4f0; color: #087f75; border-left: 2px solid #0e9f92; }
QWidget#explorerPanel, QWidget#cloudPanel { background: #ffffff; border-right: 1px solid #dfe3e9; }
QWidget#cloudPanel { border-left: 1px solid #dfe3e9; border-right: none; }
QWidget#panelHeader { background: #ffffff; border-bottom: 1px solid #e7eaf0; }
QLabel#sectionLabel { color: #727b89; font-size: 8pt; font-weight: 750; letter-spacing: 1.1px; }
QToolButton#iconButton { background: transparent; color: #6f7988; border: none; border-radius: 4px; font-size: 14pt; padding: 3px 6px; }
QToolButton#iconButton:hover { background: #eef1f5; color: #202630; }
QStackedWidget { background: #ffffff; }
QTreeWidget#workspaceTree, QListWidget#sessionList { background: #ffffff; alternate-background-color: #f7f8fa; color: #343c48; border: none; outline: none; selection-background-color: #e2f4f0; selection-color: #006f65; }
QTreeWidget#workspaceTree::item { padding: 5px 4px; border: none; height: 23px; }
QTreeWidget#workspaceTree::item:hover, QListWidget#sessionList::item:hover { background: #f1f3f6; }
QTreeWidget#workspaceTree::item:selected, QListWidget#sessionList::item:selected { background: #e2f4f0; color: #006f65; }
QTreeWidget#workspaceTree::branch { background: #ffffff; }
QListWidget#sessionList { border: 1px solid #e2e6ec; border-radius: 5px; }
QListWidget#sessionList::item { padding: 9px 8px; border-bottom: 1px solid #edf0f4; }
QWidget#panelFooter { background: #ffffff; border-top: 1px solid #e7eaf0; }
QPushButton#panelButton { background: #f8f9fb; color: #46505e; border: 1px solid #dce1e8; border-radius: 5px; padding: 8px 10px; text-align: center; }
QPushButton#panelButton:hover { background: #edf1f5; border-color: #c3cad4; }
QPushButton#panelButton:disabled { color: #a5acb7; background: #f6f7f9; border-color: #e5e8ed; }
QLabel#emptyGlyph { color: #c1c9d3; font: 30pt "Segoe UI Symbol"; padding: 5px; }
QLabel#emptyTitle { color: #313946; font-size: 11pt; font-weight: 650; padding-top: 5px; }
QLabel#muted { color: #818b99; font-size: 9pt; }
QWidget#editorPanel { background: #ffffff; }
QTabWidget#editorTabs::pane { border: none; background: #ffffff; }
QTabWidget#editorTabs QTabBar { background: #f4f6f8; }
QTabBar::tab { background: #edf0f4; color: #737d8b; border: none; border-right: 1px solid #dfe3e9; padding: 10px 15px; min-width: 68px; }
QTabBar::tab:selected { background: #ffffff; color: #202630; border-top: 2px solid #0e9f92; padding-top: 8px; }
QTabBar::tab:hover:!selected { background: #e5e9ef; color: #424b58; }
QWidget#welcomeScreen { background: #ffffff; }
QLabel#welcomeEyebrow { color: #087f75; font: 700 8pt "Segoe UI"; letter-spacing: 2px; padding-bottom: 7px; }
QLabel#welcomeMark { color: #078a7e; font: 800 38pt "Segoe UI"; background: #f0f8f7; border: 1px solid #b8e3dc; border-radius: 18px; min-width: 74px; max-width: 74px; min-height: 74px; max-height: 74px; }
QLabel#welcomeTitle { color: #202630; font: 650 23pt "Segoe UI"; padding-top: 9px; }
QLabel#welcomeCopy { color: #6f7988; font-size: 10pt; line-height: 1.5; }
QPushButton#welcomeAction { background: #fafbfc; color: #37404c; border: 1px solid #dfe4eb; border-radius: 7px; padding: 15px; text-align: left; font-size: 10pt; line-height: 1.5; }
QPushButton#welcomeAction:hover { background: #f0f8f7; border-color: #78c8be; color: #152d2b; }
QLabel#welcomeHint { color: #929aa6; font-size: 8pt; padding: 7px; }
QWidget#editorFooter { background: #ffffff; border-top: 1px solid #e4e7ed; }
QLabel#editorStatus { color: #697585; font-size: 8pt; padding: 0 5px; }
QWidget#lineNumberArea { background: #f4f4f4; }
QPlainTextEdit#codeEditor { background: #ffffff; color: #24292f; selection-background-color: #add6ff; border: none; padding: 7px 9px; font-size: 10pt; }
QLineEdit#cloudInput, QComboBox#cloudInput, QPlainTextEdit#goalInput { background: #ffffff; color: #242a33; border: 1px solid #d8dee7; border-radius: 5px; padding: 8px 9px; selection-background-color: #cde9e5; }
QLineEdit#cloudInput:focus, QComboBox#cloudInput:focus, QPlainTextEdit#goalInput:focus { border: 1px solid #0e9f92; }
QComboBox#cloudInput::drop-down { border: none; width: 23px; }
QComboBox QAbstractItemView { background: #ffffff; color: #343c48; selection-background-color: #e2f4f0; border: 1px solid #dce1e8; }
QLabel#cloudStatus { color: #626d7c; font-size: 9pt; line-height: 1.45; padding-bottom: 2px; }
QLabel#statusDot { color: #8793a2; font-size: 10pt; }
QLabel#subsectionTitle { color: #697585; font-size: 8pt; font-weight: 700; letter-spacing: .6px; padding-top: 3px; }
QLabel#countBadge { background: #edf1f4; color: #6d7785; border-radius: 9px; padding: 3px 7px; font-size: 8pt; }
QScrollArea#cloudScroll, QWidget#cloudContent { background: #ffffff; border: none; }
QStatusBar#statusBar { background: #087f75; color: #ffffff; border-top: 1px solid #0d9a8e; min-height: 22px; font-size: 8pt; }
QStatusBar#statusBar QLabel { color: #effffb; padding: 2px 7px; }
QStatusBar#statusBar QLabel#statusBarStrong { font-weight: 750; }
QSplitter::handle { background: #dfe3e9; width: 1px; }
QScrollBar:vertical { background: #f2f4f7; width: 10px; margin: 0; }
QScrollBar::handle:vertical { background: #c5cbd4; border-radius: 4px; min-height: 30px; }
QScrollBar::handle:vertical:hover { background: #a9b2bf; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
QToolTip { background: #ffffff; color: #27303c; border: 1px solid #cfd5de; padding: 5px; }
QMessageBox, QDialog { background: #ffffff; color: #262d37; }
QLabel#cloudBadge { background: #f0f3f6; border: 1px solid #d8dee7; border-radius: 5px; color: #5d6877; padding: 6px 9px; font-size: 8pt; font-weight: 750; }
QLabel#cloudBadge[state="online"] { background: #e2f4ef; border-color: #aedfd4; color: #087568; }
QLabel#cloudBadge[state="neutral"] { background: #f0f3f6; color: #667181; }
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
