#define MyAppName "CONTINUUM"
#define MyAppVersion "0.3.0"
#define MyAppPublisher "DMJ Group"
#define MyAppExeName "CONTINUUM.exe"

[Setup]
AppId={{7B9C5E32-3D85-46A0-A59A-41F8B4480DCA}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\CONTINUUM
DefaultGroupName=CONTINUUM
UninstallDisplayIcon={app}\{#MyAppExeName}
OutputDir=..\release
OutputBaseFilename=CONTINUUM-Setup-{#MyAppVersion}
LicenseFile=..\..\..\LICENSE
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "..\dist\CONTINUUM\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\CONTINUUM"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\CONTINUUM"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch CONTINUUM"; Flags: postinstall nowait skipifsilent
