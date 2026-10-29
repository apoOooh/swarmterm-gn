# Swarmterm GN: Unterlagen für die Sicherheitsprüfung im Unternehmen (v1.26.0)

Antworten auf die sechs Punkte der vorangegangenen Sicherheitsprüfung, für Swarmterm GN **1.26.0**. Jede Aussage
verweist auf die Datei in diesem Repository, die sie umsetzt oder dokumentiert. Englische Fassung:
[review-pack.en.md](review-pack.en.md).

**Geltungsbereich.** Swarmterm GN ist ein eigenständiges Projekt. Es entstand als Fork von
[duongducnguyen/swarmterm](https://github.com/duongducnguyen/swarmterm), basiert aber nicht mehr darauf und wird nicht
mehr damit abgeglichen; Website, Richtlinien und Releases des Ursprungsprojekts gelten nicht
([Entscheidungen](../decisions.md), [README](../../README.md#origin-and-status)). Es gibt keine Projekt-Website: Die
maßgeblichen Dokumente liegen in diesem Repository.

## Die Prüfpunkte

| Nr. | Befund | Stand in Swarmterm GN 1.26.0 | Nachweis |
|---|---|---|---|
| 1 | Datenschutzerklärung und Nutzungsbedingungen waren Platzhalter-Vorlagen. | **Behoben in v1.26.0.** Projektspezifische Datenschutzerklärung, Nutzungsbedingungen und Sicherheitsrichtlinie; jede gespeicherte Datei und jede Netzwerkverbindung ist mit ihrer Quelldatei aufgeführt. Sie sind in derselben Änderung anzupassen wie das Verhalten, das sie beschreiben. | [PRIVACY.md](../../PRIVACY.md), [TERMS.md](../../TERMS.md), [SECURITY.md](../../SECURITY.md), [Entscheidungen](../decisions.md) |
| 2 | Die Claude-Code-Vorlage schaltete Berechtigungsabfragen standardmäßig ab. | Agenten-Panes starten im bestätigenden Modus des Agenten (Claude Code `--permission-mode default`, Codex `-s workspace-write -a on-request`). **Neu in v1.26.0:** Bypass-Modi („Bypass permissions“, „YOLO“) erfordern eine Bestätigung im Dialog, tragen ein rotes Kennzeichen, werden standardmäßig nicht an gestartete Worker vererbt, lassen sich per Richtlinie `DisableBypassModes` sperren und sind in der Corp-Edition gesperrt. | [templates.ts](../../src/lib/templates.ts), [DangerousModeDialog.tsx](../../src/components/DangerousModeDialog.tsx), [launch-mode-safety.ts](../../src/lib/launch-mode-safety.ts), [Sicherheitsmodell](../security-model.md#launch-modes), [Administratorrichtlinie](../admin-policy.md) |
| 3 | Google-Analytics-Telemetrie in offiziellen Releases widersprach der Aussage „keine Telemetrie“. | **Behoben in v1.26.0.** Der Analytics-Code ist entfernt; die Anwendung sendet keine Telemetrie, Analysedaten, Absturzberichte oder Kennungen. Der Release-Workflow schlägt fehl, wenn `google-analytics` in der ausführbaren Datei einer der beiden Editionen vorkommt. | [release.yml](../../.github/workflows/release.yml), [PRIVACY.md](../../PRIVACY.md#summary), [Entscheidungen](../decisions.md) |
| 4 | Kindprozesse erben die Umgebung der Anwendung einschließlich Geheimnissen. | **Behoben in v1.26.0.** Panes und Befehlsroutinen erhalten keine Variablen, die nach Geheimnissen aussehen (`*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_PASSWORD`, `DATABASE_URL`, `AWS_*`, `ANTHROPIC_*`, `OPENAI_*` …); ein strenger Modus gibt nur Windows-Systemvariablen sowie `__PSLockdownPolicy`, Proxys ohne Zugangsdaten und CA-Bundle-Variablen weiter. Administratoren erzwingen den Filter mit `EnvPolicy` und geben Namen mit `EnvAllow` frei; in Corp lässt er sich nicht abschalten. | [terminal_env.rs](../../src-tauri/src/terminal_env.rs), [Sicherheitsmodell](../security-model.md#environment-filtering), [Administratorrichtlinie](../admin-policy.md) |
| 5 | Updates in der Anwendung umgehen die interne Softwareprüfung. | **Behoben in v1.26.0.** Das (deaktivierte) Updater-Plugin ist entfernt; die Anwendung sucht nie selbst nach Updates und lädt keine herunter. Neue Versionen kommen nur an, wenn die IT den Installer verteilt. Installation und Aktualisierung des optionalen Sprachbegleiters buzzkey sowie der Download von Sprachmodellen sind sperrbar (`DisableCompanion`, `DisableModelDownload`) und in der Corp-Edition nicht enthalten; der Release-Workflow schlägt fehl, wenn deren Endpunkte in der Corp-Datei vorkommen. | [Unternehmenseinsatz](../enterprise-deployment.md#updates), [Editionen](../editions.md), [release.yml](../../.github/workflows/release.yml) |
| 6 | Interne Richtlinien zur Softwareentwicklung (Abhängigkeitsprüfung, SBOM, Lizenzen, Sicherheitskontakt). | Die CI führt `cargo deny` (RustSec-Advisories, Lizenz-Positivliste, Quellen), `npm audit` und `npm audit signatures`, einen Gitleaks-Geheimnisscan, CodeQL, OpenSSF Scorecard und REUSE-Lizenzprüfung aus; Actions sind auf Commit-SHAs festgelegt. Jedes Release enthält CycloneDX-SBOMs, `SHA256SUMS.txt` und eine mit Sigstore signierte Build-Provenienz. Schwachstellen werden vertraulich über GitHub Security Advisories gemeldet, mit Reaktionszielen; bis der Maintainer die vertrauliche Meldung aktiviert (vor dieser erneuten Einreichung erforderlich, [Maintainer-Aufgaben](../maintainer-todos.md)), eröffnen Meldende ein GitHub-Issue, das nur nach einem vertraulichen Kontakt fragt, ohne Details. | [ci.yml](../../.github/workflows/ci.yml), [codeql.yml](../../.github/workflows/codeql.yml), [scorecard.yml](../../.github/workflows/scorecard.yml), [deny.toml](../../src-tauri/deny.toml), [REUSE.toml](../../REUSE.toml), [SECURITY.md](../../SECURITY.md), [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md) |

**Nicht vorhanden:** Die Installer sind **nicht mit Authenticode signiert** (Entscheidung vom 29.10.2026), daher kann
SmartScreen vor einem unbekannten Herausgeber warnen. Prüfsummen und signierte Build-Provenienz ersetzen die Signatur
als Herkunftsnachweis; Organisationen, die nur signierte Programme zulassen, müssen den Installer gegebenenfalls per
Hash freigeben (AppLocker/WDAC) oder den geprüften Installer intern mit einem eigenen Zertifikat signieren. Swarmterm GN ist ein ehrenamtliches Projekt
(GPL-3.0-only) ohne Supportvertrag oder SLA.

## So prüfen Sie einen Download

```powershell
# 1. Prüfsumme: muss mit der Zeile des Installers in SHA256SUMS.txt des Releases übereinstimmen.
Get-FileHash -Algorithm SHA256 .\Swarmterm.GN.Corp_1.26.0_x64-setup.exe
# 2. Build-Provenienz (GitHub CLI 2.49+): erstellt vom Release-Workflow von apoOooh/swarmterm-gn.
gh attestation verify .\Swarmterm.GN.Corp_1.26.0_x64-setup.exe --repo apoOooh/swarmterm-gn `
  --signer-workflow apoOooh/swarmterm-gn/.github/workflows/release.yml
```

Dasselbe funktioniert für `SHA256SUMS.txt` und jede SBOM. Einzelheiten:
[Unternehmenseinsatz](../enterprise-deployment.md#verify-a-download).

## Empfohlener Einsatz im Unternehmen

1. Verteilen Sie **Swarmterm GN Corp** (`Swarmterm.GN.Corp_<version>_x64-setup.exe`, Installation pro Computer
   unter Programme, erfordert Administratorrechte, unbeaufsichtigt mit `/S`). Bypass-Modi, War-Room-Execute durch Agenten, der buzzkey-Installer und Modell-Downloads
   sind gesperrt oder nicht enthalten, und der Umgebungsfilter ist immer aktiv; keine Einstellung und kein
   Registry-Wert hebt dies auf ([Editionen](../editions.md)).
2. Setzen Sie die **HKLM-Richtlinie** `HKLM\Software\Policies\SwarmtermGN` per Gruppenrichtlinie (ADMX in
   [docs/admin/](../admin/)) oder Intune für alles Weitere, was Ihre Regeln verlangen, zum Beispiel
   `EnvPolicy=strict`, `DisableMcp`, `DisableRoutineCommands`, `DisablePreviewBrowser`
   ([Administratorrichtlinie](../admin-policy.md)).
3. Deinstallieren Sie eine vorhandene Standard-Edition (beide lassen sich parallel installieren).

**Was die Corp-Sperren sind und was nicht.** Die Bypass-Sperre von Corp ist ein Schutz vor Versehen auf Basis der
Agenten-Flags, die sie erkennt, keine Sicherheitsgrenze: Swarmterm isoliert weder die Agenten noch die Shell, und ein
Benutzer kann ein Bypass-Flag in eine Shell-Pane tippen oder einen Agenten außerhalb von Swarmterm starten
([Sicherheitsmodell](../security-model.md)). Die eigentlichen Kontrollen, alle für den Einsatz im Unternehmen
erforderlich:

- die **HKLM-Richtlinie** (Schritt 2), die für beide Editionen gilt;
- die **verwalteten Einstellungen der Agenten selbst**: verwaltete Claude-Code-Einstellungen mit
  `"permissions": { "disableBypassPermissionsMode": "disable", "disableAutoMode": "disable" }`
  (entfernt Bypass- und Auto-Modus), verwaltete Codex-`requirements.toml`;
- **AppLocker- oder WDAC-Regeln**, die nur den Hash des Corp-Installers oder seinen Pfad unter Programme zulassen,
  damit Benutzer weder eine ausgetauschte Programmdatei noch die Standard-Edition ausführen können.
4. Verteilen Sie neue Versionen nach Prüfung über Ihre Softwareverteilung; beobachten Sie GitHub Releases auf
   Sicherheitskorrekturen.
